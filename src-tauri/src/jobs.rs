//! Generation job queue: one song at a time through ComfyUI, results copied into the library.

use crate::comfy::client::{self, HistoryWait, OutputFile, PromptFailure, WaitError, WaitLimits};
use crate::config::AppConfig;
use crate::db::{Db, Song};
use crate::workflow::{self, BuildOptions, GenerateParams};
use anyhow::{anyhow, bail, Context, Result};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

/// Budget of one generation once ComfyUI runs it (time spent pending behind other prompts does not
/// count, see client::HistoryWait). Longer than a tool's (tools.rs): a 900 s song takes minutes.
const GENERATE_TIMEOUT_SECS: u64 = 3600;
const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(1000);
const BYTES_PER_GIB: f64 = 1073741824.0;
/// VRAM llama-server holds besides its weights (context and KV cache), for the decode plan.
const LLM_CONTEXT_GIB: f64 = 1.0;
/// Error of a job whose song was deleted from the library while it ran (nothing is recorded or shown).
const SONG_DELETED: &str = "曲がライブラリから削除されたため生成を中止しました";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobUpdate {
    pub song: Song,
    pub prompt_id: Option<String>,
    /// Human readable stage, in Japanese.
    pub stage: String,
}

struct Queued {
    song_id: String,
    params: GenerateParams,
}

/// Queue, active slot and worker flag, always changed together under one lock: a job is always in
/// either the queue or the active slot (cancel finds it), and the worker's decision to stop is taken
/// in the same step that finds the queue empty (a job pushed after it starts a new worker).
#[derive(Default)]
struct JobState {
    queue: VecDeque<Queued>,
    /// (song_id, prompt_id). Set as soon as the job leaves the queue; the prompt id is generated
    /// by the app before POST /prompt, so a cancel can always target it.
    active: Option<(String, Option<String>)>,
    worker_running: bool,
}

/// What cancel() found for a song.
#[derive(Debug, PartialEq)]
enum CancelAction {
    /// It was waiting in the queue and was removed.
    RemovedQueued,
    /// It is the running job: the cancel flag is set, and its prompt (when queued already) is to be stopped.
    ActiveFlagged { prompt_id: Option<String> },
    /// Only queued jobs were to be cancelled (「待機中をすべてキャンセル」) and this one has started meanwhile.
    Started,
    NotFound,
}

#[derive(Default)]
pub struct JobManager {
    state: Mutex<JobState>,
    /// Cancel request for the active job. Set and reset only under the `state` lock; run_one polls it
    /// without the lock.
    cancel_active: AtomicBool,
    /// The active job's song folder was made (make_song_dir). Reset with `cancel_active`: a run that ends
    /// before has only the planned path in its row, which the worker clears (mark_ended).
    folder_made: AtomicBool,
}

pub type SharedJobs = Arc<JobManager>;

impl JobManager {
    pub fn submit(self: &Arc<Self>, app: AppHandle, params: GenerateParams) -> Result<Song> {
        let state = app.state::<crate::AppState>();
        let cfg = state.config.read().clone();
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Local::now();
        // `lyrics` is what the model sings (e.g. hiragana); `lyrics_display` is what the user wrote (kanji).
        let has_display = !params.lyrics_display.trim().is_empty() && params.lyrics_display != params.lyrics;
        let display_lyrics = if has_display { params.lyrics_display.clone() } else { params.lyrics.clone() };
        let sung_lyrics = if has_display { params.lyrics.clone() } else { String::new() };
        let title = requested_title(&params.title).unwrap_or_else(|| default_title(&display_lyrics, &params.style, &now));
        let folder = cfg.output_dir.join(now.format("%Y-%m-%d").to_string()).join(format!("{}_{}", now.format("%H%M%S"), &id[..8]));
        let song = Song {
            id: id.clone(),
            created_at: now.to_rfc3339(),
            title,
            style: params.style.clone(),
            lyrics: display_lyrics,
            lyrics_sung: sung_lyrics,
            mode: params.mode.clone(),
            seed: params.seed as i64,
            abc: params.abc.clone(),
            duration: 0.0,
            audio_path: String::new(),
            folder: folder.to_string_lossy().to_string(),
            params_json: serde_json::to_string(&params).unwrap_or_default(),
            status: "queued".into(),
            error: String::new(),
            parent_id: None,
            wall_seconds: 0.0,
            peak_vram_gib: 0.0,
            truncated_semantic: None,
            truncated_abc: None,
            effective_max_seconds: None,
        };
        state.db.lock().insert(&song)?;
        // Announced before it is queued: a worker that picks it up at once sends its later stages after this.
        emit_update(&app, &song, None, "待機中");
        if self.push(Queued { song_id: id, params }) {
            self.spawn_worker(app);
        }
        Ok(song)
    }

    /// `queued_only`: cancel it only while it waits in the queue (「待機中をすべてキャンセル」: a song that has just
    /// started is still listed as 待機中 until its first progress event, and is left running).
    pub fn cancel(&self, app: &AppHandle, song_id: &str, queued_only: bool) -> Result<()> {
        let state = app.state::<crate::AppState>();
        match self.cancel_action(song_id, queued_only) {
            CancelAction::RemovedQueued => {
                // Bind first: a guard in the `if let` scrutinee would live through the block, and the
                // second lock() below would deadlock (parking_lot::Mutex is not reentrant).
                let found = state.db.lock().get(song_id)?;
                if let Some(mut s) = found {
                    // Its job never runs: the song folder was never made.
                    mark_ended(&mut s, true, false, "");
                    state.db.lock().update(&s)?;
                    emit_update(app, &s, None, "キャンセル済み");
                }
                Ok(())
            }
            // Always recorded: run_one checks it between its steps (LLM stop, ComfyUI start, before
            // POST /prompt) and while polling.
            CancelAction::ActiveFlagged { prompt_id } => {
                if let Some(pid) = prompt_id {
                    let client = state.client();
                    tauri::async_runtime::spawn(async move { client.stop_prompt(&pid).await });
                }
                Ok(())
            }
            CancelAction::Started => bail!("この曲はすでに生成を開始しています（待機中の曲だけをキャンセルするため、そのまま続きます）"),
            CancelAction::NotFound => bail!("そのジョブは実行中でも待機中でもありません"),
        }
    }

    pub fn active_song_id(&self) -> Option<String> {
        self.state.lock().active.as_ref().map(|(s, _)| s.clone())
    }

    /// Jobs waiting behind the active one.
    pub fn queued_count(&self) -> usize {
        self.state.lock().queue.len()
    }

    /// Queue a job. True when no worker is running: the caller must start one.
    fn push(&self, job: Queued) -> bool {
        let mut st = self.state.lock();
        st.queue.push_back(job);
        !std::mem::replace(&mut st.worker_running, true)
    }

    /// The worker's next job, marked active with a fresh cancel flag. None when the queue is empty: the
    /// worker then stops, and that is recorded in the same locked step.
    fn next_job(&self) -> Option<Queued> {
        let mut st = self.state.lock();
        match st.queue.pop_front() {
            Some(j) => {
                self.cancel_active.store(false, Ordering::SeqCst);
                self.folder_made.store(false, Ordering::SeqCst);
                st.active = Some((j.song_id.clone(), None));
                Some(j)
            }
            None => {
                st.active = None;
                st.worker_running = false;
                None
            }
        }
    }

    /// Record the prompt id of the active job (the app's own before POST /prompt, the server's after).
    fn set_prompt_id(&self, song_id: &str, prompt_id: &str) {
        if let Some((sid, pid)) = self.state.lock().active.as_mut() {
            if sid == song_id {
                *pid = Some(prompt_id.to_string());
            }
        }
    }

    fn active_prompt_id(&self) -> Option<String> {
        self.state.lock().active.as_ref().and_then(|(_, p)| p.clone())
    }

    fn cancel_action(&self, song_id: &str, queued_only: bool) -> CancelAction {
        let mut st = self.state.lock();
        let before = st.queue.len();
        st.queue.retain(|j| j.song_id != song_id);
        if st.queue.len() != before {
            return CancelAction::RemovedQueued;
        }
        match &st.active {
            Some((sid, _)) if sid == song_id && queued_only => CancelAction::Started,
            Some((sid, pid)) if sid == song_id => {
                self.cancel_active.store(true, Ordering::SeqCst);
                CancelAction::ActiveFlagged { prompt_id: pid.clone() }
            }
            _ => CancelAction::NotFound,
        }
    }

    /// The active job is done (its outcome recorded).
    fn finish(&self) {
        self.state.lock().active = None;
    }

    fn queue_is_empty(&self) -> bool {
        self.state.lock().queue.is_empty()
    }

    fn check_cancel(&self) -> Result<()> {
        if self.cancel_active.load(Ordering::SeqCst) {
            bail!("cancelled");
        }
        Ok(())
    }

    /// Make the active job's song folder, and note that it exists: only then does the row of a run that ends
    /// without a result keep its path.
    fn make_song_dir(&self, dir: &Path) -> Result<()> {
        create_song_dir(dir)?;
        self.folder_made.store(true, Ordering::SeqCst);
        Ok(())
    }

    /// Run queued jobs until the queue is empty (started by submit when push() says so).
    fn spawn_worker(self: &Arc<Self>, app: AppHandle) {
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(job) = me.next_job() {
                let result = me.run_one(&app, &job).await;
                let state = app.state::<crate::AppState>();
                let prompt_id = me.active_prompt_id();
                if let Some(pid) = &prompt_id {
                    state.last_progress.lock().retain(|(p, _), _| p != pid);
                }
                if let Err(e) = result {
                    let found = state.db.lock().get(&job.song_id);
                    match found {
                        Ok(Some(mut s)) => {
                            let cancelled = me.cancel_active.load(Ordering::SeqCst);
                            mark_ended(&mut s, cancelled, me.folder_made.load(Ordering::SeqCst), &format!("{e:#}"));
                            let _ = state.db.lock().update(&s);
                            write_failure(&app, &s, &format!("{e:#}"), &job.params, prompt_id.as_deref());
                            emit_update(&app, &s, None, if cancelled { "キャンセル済み" } else { "エラー" });
                        }
                        // Deleted from the library meanwhile: nothing to record.
                        Ok(None) => log::info!("job for deleted song {} ended: {e:#}", job.song_id),
                        Err(de) => log::warn!("job for song {} failed ({e:#}) and its row could not be read: {de:#}", job.song_id),
                    }
                }
                me.finish();
            }
            // The queue is empty: a VAE-precision restart put off during the generations can run now.
            crate::retry_deferred_restart(&app);
        });
    }

    async fn run_one(&self, app: &AppHandle, job: &Queued) -> Result<()> {
        let state = app.state::<crate::AppState>();
        let cfg: AppConfig = state.config.read().clone();
        let found = start_song(&state.db.lock(), &job.song_id)?;
        let mut song = found.ok_or_else(|| anyhow!("曲がライブラリから削除されたため生成できません"))?;
        // Shown as started at once (生成中 in the library and the progress panel): until its first stage below the
        // pages would still list it as 待機中.
        emit_update(app, &song, None, "準備中");
        // The save folder the song folder goes in (<楽曲の保存先>\<date>\<time>_<id>): one that cannot be made
        // (an unplugged drive) or written (no permission, コントロールされたフォルダー アクセス) fails here,
        // before the LLM stop and the ComfyUI start. The song folder itself is made only before the workflow
        // is written (make_song_dir), so a run that ends earlier leaves none behind, nor its planned path in the row.
        if let Some(save_folder) = Path::new(&song.folder).ancestors().nth(2) {
            check_save_folder(save_folder)?;
        }

        // Free the LLM's VRAM before generating when configured. A local AI request in flight (an AI edit,
        // a lyrics draft) is waited for first, up to LLM_WAIT_LIMIT, instead of being cut off; a cancel of
        // this job ends the wait.
        if cfg.llm.unload_before_generation {
            let ours = state.llama.lock().is_some();
            if ours && state.llm_in_flight.load(Ordering::SeqCst) > 0 {
                refresh_title(&state, &mut song);
                emit_update(app, &song, None, "AI の応答を待っています");
                let idle = wait_while(|| state.llm_in_flight.load(Ordering::SeqCst) > 0, || self.cancel_active.load(Ordering::SeqCst), LLM_WAIT_LIMIT, LLM_WAIT_STEP).await?;
                if !idle {
                    log::warn!("local LLM request still running after {} s; stopping llama-server for the generation anyway", LLM_WAIT_LIMIT.as_secs());
                }
            }
            let lp = state.llama.lock().take();
            if let Some(mut p) = lp {
                tokio::task::spawn_blocking(move || p.stop()).await.ok();
            }
        }
        self.check_cancel()?;
        // Make sure ComfyUI is up (auto start). ensure_comfy_running always runs: it also refreshes
        // the node checks and the WS relay for a server that was already running.
        if !state.client().is_alive().await || crate::comfy_restart_pending(&state) {
            refresh_title(&state, &mut song);
            emit_update(app, &song, None, "ComfyUI を起動中");
        }
        // A restart is not aborted midway (it holds comfy_restarting); a cancel while ComfyUI starts ends
        // the wait for it within a second (the worker records the job as cancelled).
        crate::restart_comfy_if_stale(app, true).await?;
        crate::ensure_comfy_running_cancellable(app, &|| self.cancel_active.load(Ordering::SeqCst)).await?;
        // Made after the start, from the config as it is now (not a port from before a restart).
        let client = state.client();
        self.check_cancel()?;
        if let Some(m) = crate::missing_yue2_nodes_message(&state.runtime.read().missing_nodes) {
            bail!("{m}");
        }
        // The file ComfyUI would load: fail with a hint instead of "Value not in list". Checked once the
        // server is up, so a checkpoint only ComfyUI's own model paths can find is confirmed by its listing.
        if let Some(m) = crate::tools::checkpoint_unavailable(&client, &cfg).await {
            bail!("{m}");
        }
        let use_wav = state.has_wav_saver.load(Ordering::Relaxed);
        let status_input = state.runtime.read().status_input.clone();
        // Decode node: plain (official template) when the whole decode fits next to the loaded model,
        // tiled otherwise (see workflow::plan_vae_decode); the VRAM figures come from the live server.
        let (vram_total, vram_free) = client
            .system_stats()
            .await
            .ok()
            .and_then(|s| s.devices.first().map(|d| (d.vram_total, d.vram_free)))
            .unwrap_or((0, 0));
        let fp32 = crate::comfy_vae_fp32(&state).unwrap_or(cfg.vae_fp32);
        let model_gib = workflow::model_resident_gib(&cfg.precision);
        let external_gib = external_llm_gib(&state, &cfg);
        let free_gib = planning_free_gib(gib(vram_total), gib(vram_free), external_gib, model_gib);
        let vae_decode = workflow::plan_vae_decode(&cfg.vae_decode, job.params.max_duration, gib(vram_total), free_gib, model_gib, fp32);
        log::info!(
            "vae decode plan: {vae_decode:?} (setting {}, budget {} s, VRAM {:.1}/{:.1} GiB free, llama {external_gib:.1} GiB, fp32 {fp32})",
            cfg.vae_decode,
            job.params.max_duration,
            gib(vram_free),
            gib(vram_total)
        );
        let prompt = workflow::build_generate(
            &job.params,
            &BuildOptions {
                checkpoint: cfg.checkpoint_file(),
                filename_prefix: &format!("mcs/{}", &job.song_id[..8]),
                use_wav_saver: use_wav,
                status_input: status_input.as_deref(),
                vae_decode,
            },
        );
        self.make_song_dir(Path::new(&song.folder))?;
        write_song_file(&PathBuf::from(&song.folder).join("workflow_api.json"), serde_json::to_vec_pretty(&prompt)?)?;

        let prompt_id = uuid::Uuid::new_v4().to_string();
        self.set_prompt_id(&job.song_id, &prompt_id);
        self.check_cancel()?;
        // Follow the id the server reports (a server that ignores client ids makes its own).
        let queued_id = client.queue_prompt(&prompt, crate::comfy::ws::client_id(), &prompt_id).await?;
        let prompt_id = if queued_id != prompt_id {
            log::warn!("ComfyUI assigned prompt id {queued_id} instead of {prompt_id}");
            self.set_prompt_id(&job.song_id, &queued_id);
            queued_id
        } else {
            prompt_id
        };
        if !store(&state, &mut song)? {
            client.stop_prompt(&prompt_id).await;
            return Err(discard_deleted(&cfg, &song));
        }
        emit_update(app, &song, Some(&prompt_id), "生成中");

        // Poll history until done; sample VRAM meanwhile.
        let mut peak: u64 = 0;
        let mut wait = HistoryWait::new(&client, &prompt_id, WaitLimits { run_secs: GENERATE_TIMEOUT_SECS, wait_secs: client::QUEUE_WAIT_LIMIT_SECS });
        let entry: Value = loop {
            tokio::time::sleep(POLL_INTERVAL).await;
            if let Ok(st) = client.system_stats().await {
                if let Some(d) = st.devices.first() {
                    peak = peak.max(d.vram_total.saturating_sub(d.vram_free));
                }
            }
            match wait.poll(self.cancel_active.load(Ordering::SeqCst)).await {
                Ok(Some(h)) => break h,
                Ok(None) => {}
                Err(WaitError::Cancelled) => bail!("cancelled"),
                Err(e) => bail!("{}", e.message("生成", GENERATE_TIMEOUT_SECS)),
            }
        };
        // Time ComfyUI spent executing it (its own timestamps), else our clock without the queue wait.
        let wall = client::execution_seconds(&entry).unwrap_or_else(|| wait.run_seconds());
        let progress = crate::comfy::ws::take_progress(&mut state.last_progress.lock(), &prompt_id);
        if let Some(f) = client::history_failure(&entry) {
            if self.cancel_active.load(Ordering::SeqCst) {
                bail!("cancelled");
            }
            bail!("{}", failure_message(&f));
        }
        // A cancel that lost the race with completion still counts as cancelled.
        self.check_cancel()?;
        let outputs = entry.get("outputs").cloned().unwrap_or(Value::Null);
        let out = parse_generate_outputs(&outputs, &progress, job.params.max_duration);
        // A cached planner node sends no progress: a plan already found truncated this session is recognised
        // by its text (shared with plan_score), otherwise the flag stays unknown.
        let truncated_abc = if workflow::plans_abc(&job.params) { workflow::plan_truncation(progress.get(workflow::NODE_ABC).copied(), &out.abc) } else { None };
        let Some(first) = out.files.first() else { bail!("出力音声が見つかりません") };
        // ComfyUI's copy of the output, when it is our own server's (removed once the library has it).
        let own_output = if crate::comfy_vae_fp32(&state).is_some() { client::own_output_path(&crate::comfy_output_dir_in_use(&state), first) } else { None };
        // The song may have been deleted from the library while it was generating.
        if !song_exists(&state, &song.id)? {
            if let Some(p) = &own_output {
                let _ = std::fs::remove_file(p);
            }
            return Err(discard_deleted(&cfg, &song));
        }
        let ext = std::path::Path::new(&first.filename).extension().and_then(|e| e.to_str()).unwrap_or("wav");
        let audio_path = PathBuf::from(&song.folder).join(format!("song.{ext}"));
        refresh_title(&state, &mut song);
        emit_update(app, &song, Some(&prompt_id), "出力を保存中");
        client.download_view(first, &audio_path).await?;
        if let Some(p) = &own_output {
            let _ = std::fs::remove_file(p);
        }
        let final_abc = if !out.abc.is_empty() { out.abc.clone() } else { job.params.abc.clone() };
        if !final_abc.is_empty() {
            write_song_file(&PathBuf::from(&song.folder).join("score.abc"), &final_abc)?;
        }
        // Instrumental render: the untouched source score (plan) next to the converted one.
        if !job.params.source_abc.is_empty() {
            write_song_file(&PathBuf::from(&song.folder).join("score_source.abc"), &job.params.source_abc)?;
        }
        write_song_file(&PathBuf::from(&song.folder).join("lyrics.txt"), &song.lyrics)?;
        if !song.lyrics_sung.is_empty() {
            write_song_file(&PathBuf::from(&song.folder).join("lyrics_sung.txt"), &song.lyrics_sung)?;
        }
        let (comfyui_version, app_version) = versions(app);
        refresh_title(&state, &mut song);
        let meta = serde_json::json!({
            "id": song.id, "title": song.title, "style": job.params.style, "mode": job.params.mode, "seed": job.params.seed,
            "lyrics": song.lyrics, "lyrics_sung": song.lyrics_sung,
            "seconds": out.seconds, "info": out.info, "wall_seconds": wall, "peak_vram_gib": gib(peak),
            "checkpoint": cfg.checkpoint_file(), "prompt_id": prompt_id, "params": job.params,
            "truncated": { "abc": truncated_abc, "semantic": out.truncated_semantic },
            "score_source": if job.params.source_abc.is_empty() { None } else { Some("score_source.abc") },
            "instrumental_transfer": job.params.instrumental_transfer,
            "effective_max_seconds": out.effective_max_seconds,
            "vae_fp32": crate::comfy_vae_fp32(&state),
            "vae_decode": vae_decode,
            "comfyui_version": comfyui_version, "app_version": app_version,
            "workflow": "workflow_api.json",
        });
        write_song_file(&PathBuf::from(&song.folder).join("song.json"), serde_json::to_vec_pretty(&meta)?)?;

        song.abc = final_abc;
        song.duration = out.duration;
        song.audio_path = audio_path.to_string_lossy().to_string();
        song.status = "done".into();
        song.wall_seconds = wall;
        song.peak_vram_gib = gib(peak);
        song.truncated_semantic = out.truncated_semantic;
        song.truncated_abc = truncated_abc;
        song.effective_max_seconds = out.effective_max_seconds;
        if !store(&state, &mut song)? {
            return Err(discard_deleted(&cfg, &song));
        }
        emit_update(app, &song, Some(&prompt_id), "完了");

        if cfg.free_vram_after_generation && self.queue_is_empty() {
            let _ = client.free(true).await;
        }
        Ok(())
    }
}

/// How long a generation that unloads the local LLM waits for AI requests in flight, and how often it looks.
const LLM_WAIT_LIMIT: std::time::Duration = std::time::Duration::from_secs(180);
const LLM_WAIT_STEP: std::time::Duration = std::time::Duration::from_millis(500);

/// Wait while `busy()`, checking every `step`: Ok(true) once it is not, Ok(false) when `limit` passed
/// first, Err("cancelled") as soon as `cancelled()` (the job's cancel, checked before each sleep).
async fn wait_while(busy: impl Fn() -> bool, cancelled: impl Fn() -> bool, limit: std::time::Duration, step: std::time::Duration) -> Result<bool> {
    let started = std::time::Instant::now();
    while busy() {
        if cancelled() {
            bail!("cancelled");
        }
        if started.elapsed() >= limit {
            return Ok(false);
        }
        tokio::time::sleep(step).await;
    }
    Ok(true)
}

fn gib(bytes: u64) -> f64 {
    bytes as f64 / BYTES_PER_GIB
}

/// Take the title from the library: the user may rename the song while it generates.
fn refresh_title(state: &crate::AppState, song: &mut Song) {
    let found = state.db.lock().get(&song.id);
    if let Ok(Some(cur)) = found {
        song.title = cur.title;
    }
}

/// Write the job's columns (Db::update leaves the title alone) and take the current title, under one
/// lock. False when the song is no longer in the library.
fn store(state: &crate::AppState, song: &mut Song) -> Result<bool> {
    let db = state.db.lock();
    let Some(cur) = db.get(&song.id)? else { return Ok(false) };
    song.title = cur.title;
    db.update(song)?;
    Ok(true)
}

/// The job's song as it leaves the queue, recorded as running at once (not only after POST /prompt): a
/// library refresh during the LLM wait or the ComfyUI start would otherwise list it as 待機中 again, and
/// 「待機中をすべてキャンセル」 would cancel it. None when it was deleted from the library meanwhile.
fn start_song(db: &Db, song_id: &str) -> Result<Option<Song>> {
    let Some(mut song) = db.get(song_id)? else { return Ok(None) };
    song.status = "running".into();
    db.update(&song)?;
    Ok(Some(song))
}

/// A job that ended without a result, as its row records it: cancelled (no error text) or error. Without
/// `folder_made` (a job cancelled while queued, or a run that ended before make_song_dir: the save folder check,
/// the wait for the local AI, the ComfyUI start, a missing node or checkpoint, a cancel) the row holds only the
/// planned path, which is cleared: deleting the song while its drive is unplugged would otherwise report a folder
/// that never existed as kept. Not decided from the path, since on such a drive a folder that was made looks missing too.
fn mark_ended(song: &mut Song, cancelled: bool, folder_made: bool, error: &str) {
    song.status = if cancelled { "cancelled" } else { "error" }.into();
    song.error = if cancelled { String::new() } else { error.to_string() };
    if !folder_made {
        song.folder.clear();
    }
}

/// Make a folder of the song's (or the save folder it goes in); a failure names it and what to check, since
/// the OS error alone has no path (e.g. 「指定されたパスが見つかりません。」 for an unplugged drive).
fn create_song_dir(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir).map_err(|e| {
        let hint = save_folder_hint(&e);
        anyhow::Error::new(e).context(format!("曲の保存先フォルダ {} を作成できません{hint}", dir.display()))
    })
}

/// Make the save folder and try what a job does in it, a folder with a file in it (both removed again):
/// create_dir_all is Ok for any folder that exists, also one this app cannot write to (no permission, or
/// Windows' コントロールされたフォルダー アクセス, which protects ミュージック by default), and that would fail
/// only at the song folder. A folder where only subfolders may be made (like a drive root) passes, as a job's would.
fn check_save_folder(dir: &Path) -> Result<()> {
    create_song_dir(dir)?;
    let probe = dir.join(format!(".mcs_write_check_{}", uuid::Uuid::new_v4().simple()));
    let tried = std::fs::create_dir(&probe).and_then(|()| {
        let file = probe.join("check.txt");
        let written = std::fs::write(&file, b"MCS");
        let _ = std::fs::remove_file(&file);
        if let Err(e) = std::fs::remove_dir(&probe) {
            log::warn!("write check folder {} not removed: {e}", probe.display());
        }
        written
    });
    tried.map_err(|e| {
        let hint = save_folder_hint(&e);
        anyhow::Error::new(e).context(format!("曲の保存先フォルダ {} に書き込めません{hint}", dir.display()))
    })
}

/// What to check when the save folder (or a folder in it) cannot be made or written: a refusal is about
/// permissions, anything else about the path itself.
fn save_folder_hint(e: &std::io::Error) -> &'static str {
    if e.kind() == std::io::ErrorKind::PermissionDenied {
        "（フォルダへの書き込み権限と、Windows セキュリティの「コントロールされたフォルダー アクセス」でこのアプリが許可されているかを確認するか、設定の「楽曲の保存先」を変更してください）"
    } else {
        "（設定の「楽曲の保存先」のドライブやフォルダを確認してください）"
    }
}

/// Write one of the song folder's files; a failure names the file.
fn write_song_file(path: &Path, data: impl AsRef<[u8]>) -> Result<()> {
    std::fs::write(path, data).with_context(|| format!("{} を書き込めません", path.display()))
}

fn song_exists(state: &crate::AppState, id: &str) -> Result<bool> {
    let found = state.db.lock().get(id)?;
    Ok(found.is_some())
}

/// The song was deleted from the library while it was generating: remove the folder this run created
/// (only inside the output folder, like delete_song) and end without a failure record. The folder is
/// always discarded, also when the delete kept files (delete_files=false): it belongs to a take that never
/// reached the library. Defence only: delete_song refuses the active song and dequeues queued ones.
fn discard_deleted(cfg: &AppConfig, song: &Song) -> anyhow::Error {
    discard_folder(&cfg.output_dir, &song.folder, &song.id);
    anyhow!(SONG_DELETED)
}

/// The folder part of discard_deleted, through delete_song's own check (remove_song_folder: canonical
/// containment, never the output folder itself, the song folder layout outside it; an emptied date folder
/// goes too).
fn discard_folder(output_dir: &Path, folder: &str, song_id: &str) {
    if folder.is_empty() {
        return;
    }
    match crate::remove_song_folder(Path::new(folder), song_id, output_dir) {
        Ok(Some(kept)) => log::warn!("folder of deleted song {song_id} kept: {kept}"),
        Err(e) => log::warn!("folder of deleted song {song_id} not removed: {e}"),
        Ok(None) => {}
    }
}

/// VRAM our llama-server keeps through the generation (unload_before_generation off): its GGUF file
/// plus the context. 0 when it is stopped before generating, not running or not on the GPU.
fn external_llm_gib(state: &crate::AppState, cfg: &AppConfig) -> f64 {
    if cfg.llm.unload_before_generation || cfg.llm.gpu_layers == 0 {
        return 0.0;
    }
    let model = {
        let mut lp = state.llama.lock();
        lp.as_mut().and_then(|p| if p.alive() { Some(p.model.clone()) } else { None })
    };
    let Some(model) = model else { return 0.0 };
    let bytes = std::fs::metadata(cfg.models_dir().join("llm").join(model)).map(|m| m.len()).unwrap_or(0);
    gib(bytes) + LLM_CONTEXT_GIB
}

/// Free VRAM to plan the decode with when `external_gib` is held outside ComfyUI. /system_stats already
/// counts it as used, but plan_vae_decode takes the larger of what is in use and the checkpoint: with
/// the checkpoint not loaded yet, it would come on top of the external memory unnoticed. So no more than
/// total - external - checkpoint counts as free (unchanged when the checkpoint is already loaded).
fn planning_free_gib(total: f64, free: f64, external_gib: f64, model_gib: f64) -> f64 {
    if external_gib <= 0.0 || total <= 0.0 {
        return free;
    }
    free.min((total - external_gib - model_gib).max(0.0))
}

/// What run_one takes from a generation's outputs (the ABC truncation flag is left to the caller: it
/// depends on the session's set of truncated plans).
// status_json / music_budget are read by the E2E parse (e2e/jobs_e2e.rs) only.
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone)]
pub(crate) struct GenOutputs {
    pub abc: String,
    pub seconds: f64,
    pub info: Option<String>,
    pub duration: f64,
    pub status_json: Option<String>,
    pub music_budget: Option<u64>,
    pub effective_max_seconds: Option<f64>,
    pub truncated_semantic: Option<bool>,
    pub files: Vec<OutputFile>,
}

pub(crate) fn parse_generate_outputs(outputs: &Value, progress: &HashMap<String, (u64, u64)>, max_duration: f64) -> GenOutputs {
    // ABC / seconds / info
    let abc = client::text_output(outputs, workflow::NODE_ABC_PREVIEW).unwrap_or_default();
    let seconds: f64 = client::text_output(outputs, workflow::NODE_SECONDS_PREVIEW).and_then(|s| s.trim().parse().ok()).unwrap_or(0.0);
    let info = client::text_output(outputs, workflow::NODE_INFO);
    let duration = if seconds > 0.0 { seconds } else { info.as_deref().and_then(|i| serde_json::from_str::<Value>(i).ok()).and_then(|v| v.get("seconds").and_then(|s| s.as_f64())).unwrap_or(0.0) };
    // Truncation (the official runtime reports it on every run; ComfyUI only in the conditioning).
    let status_json = client::text_output(outputs, workflow::NODE_STATUS);
    // Budget actually used by YuE2GenerateMusic (ComfyUI lowers it for long prompts); unknown when cached.
    let music_budget = progress.get(workflow::NODE_MUSIC).map(|(_, m)| *m);
    let effective_max_seconds = music_budget.map(|m| m as f64 / workflow::LATENT_FRAMES_PER_SECOND);
    let truncated_semantic = workflow::semantic_truncated(status_json.as_deref(), duration, max_duration, music_budget);
    let files = client::audio_outputs(outputs, workflow::NODE_SAVE);
    GenOutputs { abc, seconds, info, duration, status_json, music_budget, effective_max_seconds, truncated_semantic, files }
}

/// (ComfyUI version reported by the server, app version).
fn versions(app: &AppHandle) -> (Option<String>, String) {
    let state = app.state::<crate::AppState>();
    let comfy = state.runtime.read().comfyui_version.clone();
    (comfy, app.package_info().version.to_string())
}

/// Record a failed or cancelled run next to workflow_api.json (the error is otherwise only in SQLite).
fn write_failure(app: &AppHandle, song: &Song, error: &str, params: &GenerateParams, prompt_id: Option<&str>) {
    // A job that failed or was cancelled before run_one created the folder (checkpoint missing,
    // ComfyUI start failure...; its row has no folder then, see mark_ended) has nothing to sit next to: log it
    // instead of leaving an empty folder behind on every retry. The error itself is in SQLite either way.
    if song.folder.is_empty() || !std::path::Path::new(&song.folder).is_dir() {
        log::warn!("song {} {} before its folder existed: {error}", song.id, song.status);
        return;
    }
    let (comfyui_version, app_version) = versions(app);
    let v = failure_record(&song.status, error, params, prompt_id, comfyui_version.as_deref(), &app_version, &chrono::Local::now().to_rfc3339());
    let folder = PathBuf::from(&song.folder);
    let written = std::fs::write(folder.join("failure.json"), serde_json::to_vec_pretty(&v).unwrap_or_default());
    if let Err(e) = written {
        log::warn!("failure.json for {} not written: {e}", song.id);
    }
}

fn failure_record(status: &str, error: &str, params: &GenerateParams, prompt_id: Option<&str>, comfyui_version: Option<&str>, app_version: &str, timestamp: &str) -> Value {
    serde_json::json!({
        "status": status,
        "error": error,
        "params": params,
        "prompt_id": prompt_id,
        "versions": { "app": app_version, "comfyui": comfyui_version },
        "timestamp": timestamp,
    })
}

/// The song error for a failed history entry. An interrupt the app asked for never gets here (run_one
/// checks its cancel flag first), so an interrupt here came from outside (ComfyUI's own UI, another client).
fn failure_message(f: &PromptFailure) -> String {
    match f {
        PromptFailure::Interrupted => "生成が外部から中断されました（ComfyUI 側での中断）".into(),
        PromptFailure::Error(m) => m.clone(),
        PromptFailure::Unknown => "ComfyUI でエラーが発生しました".into(),
    }
}

/// failure_message of an entry (None = success).
#[cfg(test)]
fn extract_error(entry: &Value) -> Option<String> {
    client::history_failure(entry).map(|f| failure_message(&f))
}

/// Longest automatic title, in characters.
const TITLE_CHARS: usize = 24;
/// Longest title taken from GenerateParams::title (the AI draft's or the user's own).
const REQUESTED_TITLE_CHARS: usize = 60;

/// The title the caller chose (None when empty: the automatic one is used). One line, at most
/// REQUESTED_TITLE_CHARS characters, control characters as spaces.
fn requested_title(title: &str) -> Option<String> {
    let one_line: String = title.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let t: String = one_line.trim().chars().take(REQUESTED_TITLE_CHARS).collect();
    let t = t.trim_end();
    (!t.is_empty()).then(|| t.to_string())
}

/// Automatic title: the first lyric line that is not a tag; for an instrumental (tags only) the main
/// style words after "インスト: "; otherwise the style or the date. Cut at a word boundary (a line that
/// is nothing but separators after cutting is skipped).
fn default_title(lyrics: &str, style: &str, now: &chrono::DateTime<chrono::Local>) -> String {
    let date = || now.format("%Y-%m-%d %H:%M").to_string();
    if let Some(t) = lyrics.lines().map(|l| l.trim()).filter(|l| !l.is_empty() && !l.starts_with('[')).map(|l| clip_title(l, TITLE_CHARS)).find(|t| !t.is_empty()) {
        return t;
    }
    let style = style.trim();
    let instrumental = style.get(..12).is_some_and(|p| p.eq_ignore_ascii_case("instrumental")) && !style[12..].starts_with(|c: char| c.is_ascii_alphanumeric());
    if instrumental {
        // instrumentalStyle(): "Instrumental, <style terms>, no vocals, no singing, ..." (the negatives say nothing).
        let terms: Vec<String> = style
            .split(',')
            .enumerate()
            .map(|(i, t)| {
                let t = t.trim().trim_end_matches('.').trim();
                if i == 0 { t[12..].trim().to_string() } else { t.to_string() }
            })
            .filter(|t| !t.is_empty() && !t.eq_ignore_ascii_case("instrumental") && !t.to_ascii_lowercase().starts_with("no "))
            .take(2)
            .collect();
        let t = clip_title(&terms.join(", "), TITLE_CHARS);
        return if t.is_empty() { format!("インスト {}", date()) } else { format!("インスト: {t}") };
    }
    let s = clip_title(style, TITLE_CHARS);
    if s.is_empty() { date() } else { s }
}

/// `s` cut to at most `max` characters; a longer text is cut at the last space or comma in the second half
/// of the kept part (Japanese text without separators is cut at `max`).
fn clip_title(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        return s.to_string();
    }
    let kept: String = s.chars().take(max).collect();
    let is_sep = |c: char| c == ' ' || c == ',' || c == '、' || c == '，' || c == '　';
    if s.chars().nth(max).is_some_and(is_sep) {
        // The cut falls on a word boundary already.
        return kept.trim_end_matches(is_sep).to_string();
    }
    let cut = kept.char_indices().rfind(|&(_, c)| is_sep(c)).map(|(i, _)| i).filter(|&i| kept[..i].chars().count() >= max / 2);
    let out = match cut {
        Some(i) => &kept[..i],
        None => kept.as_str(),
    };
    out.trim_end_matches(is_sep).to_string()
}

pub fn emit_update(app: &AppHandle, song: &Song, prompt_id: Option<&str>, stage: &str) {
    let _ = app.emit("job://update", JobUpdate { song: song.clone(), prompt_id: prompt_id.map(|s| s.to_string()), stage: stage.to_string() });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> GenerateParams {
        serde_json::from_value(serde_json::json!({ "style": "s", "lyrics": "l", "mode": "full", "seed": 7, "maxDuration": 90.0 })).unwrap()
    }

    fn job(id: &str) -> Queued {
        Queued { song_id: id.into(), params: params() }
    }

    fn queued_ids(m: &JobManager) -> Vec<String> {
        m.state.lock().queue.iter().map(|j| j.song_id.clone()).collect()
    }

    #[test]
    fn deleted_songs_folder_is_discarded_only_when_it_is_its_own() {
        let root = std::env::temp_dir().join(format!("mcs-discard-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let out = root.join("out");
        let id = "abcdef1234567890";
        // The song folder as submit() creates it, before anything but the workflow was written.
        let date = out.join("2026-09-30");
        let song = date.join("101500_abcdef12");
        std::fs::create_dir_all(&song).unwrap();
        std::fs::write(song.join("workflow_api.json"), b"{}").unwrap();
        discard_folder(&out, &song.to_string_lossy(), id);
        assert!(!song.exists() && !date.exists(), "the song folder and its emptied date folder go");
        assert!(out.is_dir());
        // The output folder itself is never removed.
        std::fs::write(out.join("keep.txt"), b"x").unwrap();
        discard_folder(&out, &out.to_string_lossy(), id);
        assert!(out.join("keep.txt").is_file());
        // `..` out of the output folder into a folder without the song layout: kept.
        let elsewhere = root.join("elsewhere").join("2026-09-30").join("x");
        std::fs::create_dir_all(&elsewhere).unwrap();
        discard_folder(&out, &out.join("..").join("elsewhere").join("2026-09-30").join("x").to_string_lossy(), id);
        assert!(elsewhere.is_dir());
        // No folder recorded: nothing happens, and the error is still the deleted-song one.
        discard_folder(&out, "", id);
        assert_eq!(SONG_DELETED.to_string(), anyhow!(SONG_DELETED).to_string());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn failure_record_has_the_documented_fields() {
        let p = params();
        let v = failure_record("error", "boom", &p, Some("pid"), Some("0.37.0"), "0.1.0", "2026-09-28T10:00:00+09:00");
        assert_eq!(v["status"], "error");
        assert_eq!(v["error"], "boom");
        assert_eq!(v["prompt_id"], "pid");
        assert_eq!(v["params"]["seed"], 7);
        assert_eq!(v["versions"]["comfyui"], "0.37.0");
        assert_eq!(v["versions"]["app"], "0.1.0");
        assert_eq!(v["timestamp"], "2026-09-28T10:00:00+09:00");
        let v = failure_record("cancelled", "cancelled", &p, None, None, "0.1.0", "t");
        assert!(v["prompt_id"].is_null() && v["versions"]["comfyui"].is_null());
    }

    #[test]
    fn external_interrupt_is_reported_in_japanese() {
        let e = serde_json::json!({ "status": { "status_str": "error", "messages": [["execution_start", {}], ["execution_interrupted", {}]] } });
        assert_eq!(extract_error(&e).as_deref(), Some("生成が外部から中断されました（ComfyUI 側での中断）"));
        let e = serde_json::json!({ "status": { "messages": [["execution_error", { "node_type": "KSampler", "exception_message": "oom" }]] } });
        assert_eq!(extract_error(&e).as_deref(), Some("KSampler: oom"));
        assert_eq!(extract_error(&serde_json::json!({ "status": { "status_str": "success" } })), None);
    }

    #[test]
    fn worker_starts_once_and_restarts_after_it_stopped() {
        let m = JobManager::default();
        assert!(m.push(job("a")), "no worker yet: start one");
        assert!(!m.push(job("b")), "worker running: no second one");
        assert_eq!(m.next_job().unwrap().song_id, "a");
        assert_eq!(m.active_song_id().as_deref(), Some("a"));
        m.finish();
        assert!(!m.push(job("c")), "the worker is still looping");
        assert_eq!(m.next_job().unwrap().song_id, "b");
        m.finish();
        assert_eq!(m.next_job().unwrap().song_id, "c");
        m.finish();
        // The worker finds the queue empty and stops in that same step...
        assert!(m.next_job().is_none());
        assert!(m.active_song_id().is_none());
        // ...so a job submitted right after starts a new worker (the lost wake-up).
        assert!(m.push(job("d")));
        assert_eq!(m.next_job().unwrap().song_id, "d");
    }

    #[test]
    fn cancel_a_queued_job_keeps_the_order_of_the_others() {
        let m = JobManager::default();
        for id in ["a", "b", "c", "d"] {
            m.push(job(id));
        }
        assert_eq!(m.next_job().unwrap().song_id, "a");
        assert_eq!(m.cancel_action("c", false), CancelAction::RemovedQueued);
        assert_eq!(queued_ids(&m), vec!["b", "d"]);
        assert_eq!(m.queued_count(), 2, "the active job is not counted as queued");
        assert!(!m.cancel_active.load(Ordering::SeqCst), "the running job is not affected");
        assert_eq!(m.cancel_action("c", false), CancelAction::NotFound);
        assert_eq!(m.cancel_action("zz", false), CancelAction::NotFound);
    }

    /// 「待機中をすべてキャンセル」 (queued_only) cancels only songs still in the queue. One that has just left it is
    /// listed as 待機中 until its first progress event: its id must not cancel the running job.
    #[test]
    fn cancelling_the_queue_leaves_a_job_that_has_just_started() {
        let m = JobManager::default();
        m.push(job("a"));
        m.push(job("b"));
        assert_eq!(m.next_job().unwrap().song_id, "a");
        assert_eq!(m.cancel_action("a", true), CancelAction::Started);
        assert!(!m.cancel_active.load(Ordering::SeqCst), "the running job goes on");
        assert!(m.check_cancel().is_ok());
        assert_eq!(m.cancel_action("b", true), CancelAction::RemovedQueued);
        assert_eq!(m.cancel_action("b", true), CancelAction::NotFound);
        // the job's own キャンセル still stops it
        assert_eq!(m.cancel_action("a", false), CancelAction::ActiveFlagged { prompt_id: None });
    }

    /// A job is shown as started at once: until its first stage (the LLM wait, the ComfyUI start, 生成中) the pages
    /// would list it as 待機中 (and 「待機中をすべてキャンセル」 would count it).
    #[test]
    fn a_started_job_is_announced_before_its_first_step() {
        let src = include_str!("jobs.rs");
        let run_one = &src[src.find("async fn run_one(").unwrap()..];
        let started = run_one.find("let mut song = found.ok_or_else(").expect("start_song");
        let announced = run_one.find("emit_update(app, &song, None, \"準備中\");").expect("準備中");
        assert!(started < announced && announced < run_one.find("check_save_folder(").unwrap());
    }

    #[test]
    fn cancel_the_active_job_before_and_after_its_prompt_id() {
        let m = JobManager::default();
        m.push(job("a"));
        m.push(job("b"));
        m.next_job();
        // Before POST /prompt: only the flag (run_one checks it between its steps).
        assert_eq!(m.cancel_action("a", false), CancelAction::ActiveFlagged { prompt_id: None });
        assert!(m.cancel_active.load(Ordering::SeqCst));
        assert!(m.check_cancel().is_err());
        // The app's id, then the one the server assigned: the cancel targets the latest.
        m.set_prompt_id("a", "client-id");
        m.set_prompt_id("a", "server-id");
        m.set_prompt_id("other", "x");
        assert_eq!(m.cancel_action("a", false), CancelAction::ActiveFlagged { prompt_id: Some("server-id".into()) });
        assert_eq!(m.active_prompt_id().as_deref(), Some("server-id"));
        m.finish();
        // The next job starts without the previous job's cancel request.
        assert_eq!(m.next_job().unwrap().song_id, "b");
        assert!(!m.cancel_active.load(Ordering::SeqCst));
        assert!(m.check_cancel().is_ok());
        assert_eq!(m.active_prompt_id(), None);
        m.finish();
        assert_eq!(m.cancel_action("a", false), CancelAction::NotFound, "a finished job cannot be cancelled");
    }

    #[test]
    fn a_started_job_reads_as_running_in_the_library() {
        let db = Db::open_in_memory().unwrap();
        let m = JobManager::default();
        for id in ["a", "b"] {
            // As submit() records them.
            db.insert(&crate::db::test_song(id, "queued")).unwrap();
            m.push(job(id));
        }
        assert_eq!(m.next_job().unwrap().song_id, "a");
        assert_eq!(start_song(&db, "a").unwrap().unwrap().status, "running");
        // From start_song on, the library lists only b as waiting, so 「待機中をすべてキャンセル」 (the songs
        // listed as queued) leaves the running one alone. That run_one calls it before the waits for the local
        // AI and the ComfyUI start is pinned by run_one_starts_the_song_and_checks_the_save_folder_before_the_waits.
        let waiting: Vec<String> = db.list(10).unwrap().into_iter().filter(|s| s.status == "queued").map(|s| s.id).collect();
        assert_eq!(waiting, vec!["b"]);
        // Interrupted by a crash from here on: recovered at the next start like a waiting one.
        db.recover().unwrap();
        assert_eq!(db.get("a").unwrap().unwrap().status, "error");
        // Deleted from the library before the worker reached it: nothing to start.
        db.delete("b").unwrap();
        assert!(start_song(&db, "b").unwrap().is_none());
    }

    #[test]
    fn a_job_that_never_made_its_folder_keeps_no_planned_path() {
        let root = std::env::temp_dir().join(format!("mcs-folder-made-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&root).unwrap();
        // Like a save folder on an unplugged drive: a file where a folder should be.
        std::fs::write(root.join("blocker"), b"x").unwrap();
        let db = Db::open_in_memory().unwrap();
        let m = JobManager::default();
        let planned = |id: &str| {
            let save = if id == "blocked" { root.join("blocker") } else { root.clone() };
            save.join("2026-10-07").join(format!("101500_{id}"))
        };
        for id in ["early", "queued", "blocked", "made", "next"] {
            // As submit() records them: the planned folder, not made yet.
            let mut s = crate::db::test_song(id, "queued");
            s.folder = planned(id).to_string_lossy().into_owned();
            db.insert(&s).unwrap();
            m.push(job(id));
        }
        // The end of a job as the worker records it (or cancel() for a dequeued one), read back from the library.
        let ended = |id: &str, cancelled: bool, folder_made: bool| {
            let mut s = db.get(id).unwrap().unwrap();
            mark_ended(&mut s, cancelled, folder_made, "boom");
            db.update(&s).unwrap();
            db.get(id).unwrap().unwrap()
        };

        // A run that failed before its song folder (the save folder check, the ComfyUI start, a missing checkpoint...).
        assert_eq!(m.next_job().unwrap().song_id, "early");
        assert!(!m.folder_made.load(Ordering::SeqCst));
        let s = ended("early", false, m.folder_made.load(Ordering::SeqCst));
        assert_eq!((s.status.as_str(), s.error.as_str(), s.folder.as_str()), ("error", "boom", ""));
        // Cancelled while queued (CancelAction::RemovedQueued): its job never runs.
        assert_eq!(m.cancel_action("queued", false), CancelAction::RemovedQueued);
        let s = ended("queued", true, false);
        assert_eq!((s.status.as_str(), s.error.as_str(), s.folder.as_str()), ("cancelled", "", ""));
        m.finish();

        // The song folder itself could not be made.
        assert_eq!(m.next_job().unwrap().song_id, "blocked");
        assert!(m.make_song_dir(&planned("blocked")).is_err());
        assert!(!m.folder_made.load(Ordering::SeqCst));
        assert_eq!(ended("blocked", false, m.folder_made.load(Ordering::SeqCst)).folder, "");
        m.finish();

        // A run that failed (or was cancelled) after its folder was made keeps it: the folder holds its files.
        assert_eq!(m.next_job().unwrap().song_id, "made");
        m.make_song_dir(&planned("made")).unwrap();
        assert!(planned("made").is_dir() && m.folder_made.load(Ordering::SeqCst));
        let s = ended("made", true, m.folder_made.load(Ordering::SeqCst));
        assert_eq!((s.status.as_str(), s.folder), ("cancelled", planned("made").to_string_lossy().into_owned()));
        m.finish();

        // The next job does not take over the previous one's folder.
        assert_eq!(m.next_job().unwrap().song_id, "next");
        assert!(!m.folder_made.load(Ordering::SeqCst));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Where the above happens (it needs an AppHandle, so it is pinned in the source): cancel() of a queued job and the
    /// worker record the end through mark_ended, the worker with the run's own flag, and run_one makes the song folder
    /// only through make_song_dir, which sets that flag.
    #[test]
    fn ended_jobs_clear_the_planned_folder_where_they_are_recorded() {
        fn method<'a>(src: &'a str, sig: &str) -> &'a str {
            let rest = &src[src.find(sig).unwrap_or_else(|| panic!("{sig}"))..];
            &rest[..rest.find("\n    }\n").unwrap()]
        }
        let src = include_str!("jobs.rs");
        let cancel = method(src, "pub fn cancel(");
        let removed = &cancel[cancel.find("CancelAction::RemovedQueued =>").unwrap()..cancel.find("CancelAction::ActiveFlagged").unwrap()];
        assert!(removed.contains("mark_ended(&mut s, true, false, \"\");"), "{removed}");
        assert!(method(src, "fn spawn_worker(").contains("mark_ended(&mut s, cancelled, me.folder_made.load(Ordering::SeqCst), "));
        let run_one = method(src, "async fn run_one(");
        assert!(!run_one.contains("create_song_dir("), "run_one makes the song folder through make_song_dir");
        let made = run_one.find("self.make_song_dir(Path::new(&song.folder))?;").expect("make_song_dir");
        assert!(made < run_one.find("\"workflow_api.json\"").unwrap());
    }

    #[test]
    fn song_folder_failures_name_the_path() {
        let root = std::env::temp_dir().join(format!("mcs-songdir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        // A file where a folder should be (like an unplugged drive or a blocked folder): the OS error alone
        // has no path in it.
        let blocker = root.join("blocker");
        std::fs::write(&blocker, b"x").unwrap();
        let dir = blocker.join("2026-10-07").join("101500_abcdef12");
        let e = format!("{:#}", create_song_dir(&dir).unwrap_err());
        assert!(e.contains(&dir.display().to_string()) && e.contains("「楽曲の保存先」"), "{e}");
        let file = dir.join("workflow_api.json");
        let e = format!("{:#}", write_song_file(&file, b"{}").unwrap_err());
        assert!(e.contains(&file.display().to_string()), "{e}");
        // An existing folder is fine (the save folder is made or confirmed before every job).
        create_song_dir(&root).unwrap();
        write_song_file(&root.join("lyrics.txt"), "歌詞").unwrap();
        assert_eq!(std::fs::read_to_string(root.join("lyrics.txt")).unwrap(), "歌詞");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The order run_one's early steps depend on (it needs a ComfyUI run, so it is pinned in the source): the song
    /// is recorded as running (a library refresh must not list it as 待機中) and the save folder is checked (a
    /// folder that cannot be made or written fails at once), both before the wait for the local AI, the LLM stop
    /// and the ComfyUI start.
    #[test]
    fn run_one_starts_the_song_and_checks_the_save_folder_before_the_waits() {
        fn body<'a>(src: &'a str, sig: &str) -> &'a str {
            let rest = &src[src.find(sig).unwrap_or_else(|| panic!("{sig}"))..];
            &rest[..rest.find("\n}\n").unwrap()]
        }
        fn before(text: &str, a: &str, b: &str) {
            let i = text.find(a).unwrap_or_else(|| panic!("`{a}` missing"));
            let j = text.find(b).unwrap_or_else(|| panic!("`{b}` missing"));
            assert!(i < j, "`{a}` must come before `{b}`");
        }
        // run_one is indented in the impl: the body runs to the impl's end, and each needle's first match is in run_one.
        let run_one = body(include_str!("jobs.rs"), "async fn run_one(");
        for wait in ["AI の応答を待っています", "state.llama.lock().take()", "ComfyUI を起動中", "restart_comfy_if_stale(", "ensure_comfy_running_cancellable("] {
            before(run_one, "start_song(", wait);
            before(run_one, "check_save_folder(", wait);
        }
    }

    #[test]
    fn the_save_folder_check_leaves_nothing_behind() {
        let root = std::env::temp_dir().join(format!("mcs-savecheck-{}", uuid::Uuid::new_v4().simple()));
        let save = root.join("save");
        // Made when missing, and tried with a file that is removed again.
        check_save_folder(&save).unwrap();
        check_save_folder(&save).unwrap();
        assert_eq!(std::fs::read_dir(&save).unwrap().count(), 0);
        // One that cannot be made names the path and the setting.
        std::fs::write(root.join("blocker"), b"x").unwrap();
        let e = format!("{:#}", check_save_folder(&root.join("blocker")).unwrap_err());
        assert!(e.contains(&root.join("blocker").display().to_string()) && e.contains("のドライブやフォルダを確認"), "{e}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn the_save_folder_check_follows_the_folders_permissions() {
        fn icacls(args: &[&str]) {
            assert!(std::process::Command::new("icacls").args(args).output().unwrap().status.success(), "icacls {args:?}");
        }
        /// `f` on an existing save folder with only `grants` (icacls), then the folder is reset and removed before
        /// anything is asserted (a failure must not leave a folder this user cannot delete). Also the number of
        /// write check folders left in it.
        fn with_grants<T>(grants: &[&str], f: impl FnOnce(&Path) -> T) -> (T, usize) {
            let root = crate::setup::acl_for_tests::owned_temp_dir("savecheck");
            let save = root.join("save");
            std::fs::create_dir_all(&save).unwrap();
            let path = save.to_string_lossy().into_owned();
            crate::setup::acl_for_tests::set_permissions(&save, grants);
            let out = f(&save);
            icacls(&[&path, "/reset", "/T"]);
            let left = std::fs::read_dir(&save).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().starts_with(".mcs_write_check")).count();
            let _ = std::fs::remove_dir_all(&root);
            (out, left)
        }
        // The folder exists but this user cannot make anything in it (only SYSTEM may), like a ミュージック folder under
        // コントロールされたフォルダー アクセス or with a deny-write permission: create_dir_all alone is Ok.
        let ((path, made, checked, song_dir), left) = with_grants(&["*S-1-5-18:(OI)(CI)F"], |save| {
            if crate::setup::acl_for_tests::not_refused_as_administrator(save) {
                return (String::new(), Ok(()), Ok(()), Err(anyhow::anyhow!("skipped")));
            }
            (save.display().to_string(), create_song_dir(save), check_save_folder(save), create_song_dir(&save.join("2026-10-07")))
        });
        if path.is_empty() {
            return;
        }
        assert!(made.is_ok());
        let e = format!("{:#}", checked.unwrap_err());
        assert!(e.contains(&path) && e.contains("書き込み権限") && e.contains("コントロールされたフォルダー アクセス"), "{e}");
        // The song folder's own failure gives the same hint (a folder that became unwritable meanwhile).
        let e = format!("{:#}", song_dir.unwrap_err());
        assert!(e.contains(&path) && e.contains("コントロールされたフォルダー アクセス"), "{e}");
        assert_eq!(left, 0);

        // Folders may be made in it but no files (like a drive root such as C:\): the job's own steps work, so the check passes.
        let whoami = std::process::Command::new("whoami").args(["/user", "/fo", "csv", "/nh"]).output().unwrap();
        let sid = String::from_utf8_lossy(&whoami.stdout).trim().rsplit(',').next().unwrap().trim_matches('"').to_string();
        assert!(sid.starts_with("S-1-"), "{sid}");
        let user = format!("*{sid}:(RX,AD)");
        let ((checked, file_in_it, job), left) = with_grants(&[user.as_str(), "*S-1-3-0:(OI)(CI)(IO)F", "*S-1-5-18:(OI)(CI)F"], |save| {
            let song = save.join("2026-10-07").join("101500_abcdef12");
            let job = create_song_dir(&song).and_then(|()| write_song_file(&song.join("workflow_api.json"), b"{}"));
            (check_save_folder(save), std::fs::write(save.join("x.txt"), b"x"), job)
        });
        assert!(file_in_it.is_err(), "the test's permissions allowed a file in the folder itself");
        job.unwrap();
        checked.unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn decode_plan_counts_a_kept_llm_before_the_checkpoint_loads() {
        let tiled = |t: u32| workflow::VaeDecode::Tiled { tile_size: t, overlap: 64 };
        let plan = |free: f64, external: f64| workflow::plan_vae_decode("auto", 240.0, 24.0, planning_free_gib(24.0, free, external, 9.0), 9.0, false);
        // llama-server (10 GB) kept, checkpoint not loaded yet: the decode must fit next to both.
        assert_eq!(plan(13.5, 10.0), tiled(1024));
        // No external memory: as before.
        assert_eq!(plan(13.5, 0.0), workflow::VaeDecode::Plain);
        // Checkpoint already loaded next to llama-server: what is in use already covers both.
        assert_eq!(plan(4.5, 10.0), plan(4.5, 0.0));
        assert_eq!(planning_free_gib(24.0, 4.5, 10.0, 9.0), 4.5);
        assert_eq!(planning_free_gib(0.0, 0.0, 10.0, 9.0), 0.0, "unknown card stays unknown");
        assert_eq!(planning_free_gib(12.0, 11.0, 10.0, 5.5), 0.0);
    }

    #[test]
    fn generate_outputs_are_parsed_like_run_one() {
        let outputs = serde_json::json!({
            "abc_preview": { "text": ["X:1\nK:C\nCDE"] },
            "seconds_preview": { "text": ["79.96"] },
            "info": { "text": ["{\"seconds\": 79.96}"] },
            "mcs_status": { "text": ["{\"frames\": 1999, \"truncated\": false}"] },
            "save": { "audio": [{ "filename": "0473_00001_.wav", "subfolder": "mcs", "type": "output" }] }
        });
        let progress: HashMap<String, (u64, u64)> = [("music".to_string(), (1999, 2250))].into();
        let o = parse_generate_outputs(&outputs, &progress, 90.0);
        assert_eq!(o.abc, "X:1\nK:C\nCDE");
        assert_eq!((o.seconds, o.duration), (79.96, 79.96));
        assert_eq!((o.music_budget, o.effective_max_seconds), (Some(2250), Some(90.0)));
        assert_eq!(o.truncated_semantic, Some(false));
        assert_eq!(o.files[0].filename, "0473_00001_.wav");
        // Without the seconds preview the audio info gives the duration; nothing at all -> 0 / unknown.
        let o = parse_generate_outputs(&serde_json::json!({ "info": { "text": ["{\"seconds\": 12.0}"] } }), &HashMap::new(), 90.0);
        assert_eq!((o.seconds, o.duration, o.files.len()), (0.0, 12.0, 0));
        let o = parse_generate_outputs(&Value::Null, &HashMap::new(), 90.0);
        assert_eq!((o.duration, o.truncated_semantic, o.effective_max_seconds), (0.0, None, None));
    }

    #[test]
    fn titles_from_lyrics_style_or_date() {
        let now = chrono::Local::now();
        // First lyric line, not a tag.
        assert_eq!(default_title("[Verse]\n\n夜空に光る星を見て\n次", "pop", &now), "夜空に光る星を見て");
        // Long English line: cut at a word boundary, not mid-word.
        assert_eq!(default_title("Morning light across the window pane", "pop", &now), "Morning light across the");
        assert_eq!(default_title("Morning light across thewindow pane", "pop", &now), "Morning light across");
        // Long Japanese line without spaces: cut at the limit.
        assert_eq!(default_title(&"あ".repeat(30), "", &now).chars().count(), TITLE_CHARS);
        // Instrumental render (tags only): the main style words, without the negatives.
        let ins = "Instrumental, J-pop, piano, strings, no vocals, no singing, no choir, no spoken words.";
        assert_eq!(default_title("[Intro]\n[Verse]\n", ins, &now), "インスト: J-pop, piano");
        assert_eq!(default_title("", "Instrumental jazz trio, no vocals, no singing, no choir, no spoken words.", &now), "インスト: jazz trio");
        assert!(default_title("", "Instrumental, no vocals, no singing.", &now).starts_with("インスト 20"));
        // Other tag-only requests: the style, cut at a comma.
        assert_eq!(default_title("[Verse]", "Japanese, J-pop, bright female vocal", &now), "Japanese, J-pop, bright");
        assert!(default_title("", "", &now).starts_with("20"));
        // A long line of separators only is cut to nothing: the next lyric line (or the style) names it.
        assert_eq!(default_title(&format!("{}\n夜空", "、".repeat(30)), "pop", &now), "夜空");
        assert_eq!(default_title(&",".repeat(30), "pop", &now), "pop");
    }

    #[test]
    fn clip_title_keeps_short_texts() {
        assert_eq!(clip_title("  short  ", 24), "short");
        assert_eq!(clip_title("abcdefghij klmnopqrstuvwxyz", 24), "abcdefghij klmnopqrstuvw", "no separator in the second half: hard cut");
        assert_eq!(clip_title("a, b, c, d, e, f, g, h, i, j", 10), "a, b, c, d");
    }

    #[test]
    fn requested_title_wins_when_given() {
        assert_eq!(requested_title(""), None);
        assert_eq!(requested_title(" \n\t "), None);
        assert_eq!(requested_title("  夜明けのうた  ").as_deref(), Some("夜明けのうた"));
        assert_eq!(requested_title("一行目\n二行目").as_deref(), Some("一行目 二行目"));
        assert_eq!(requested_title(&"あ".repeat(80)).map(|t| t.chars().count()), Some(REQUESTED_TITLE_CHARS));
        // Params saved before the field existed have no title (the automatic one is used).
        assert!(params().title.is_empty());
        let with: GenerateParams = serde_json::from_value(serde_json::json!({ "title": "朝の歌", "style": "s", "lyrics": "l", "mode": "full", "seed": 7, "maxDuration": 90.0 })).unwrap();
        assert_eq!(with.title, "朝の歌");
        // An empty title is not written into params_json / song.json.
        assert!(serde_json::to_value(params()).unwrap().get("title").is_none());
    }

    #[test]
    fn requested_title_limit_matches_rules_ts() {
        // The UI fits the instrumental mark 「（インスト）」 into the same limit (src/abc/instrumental.ts).
        let rules = include_str!("../../src/config/rules.ts");
        assert!(rules.contains(&format!("export const REQUESTED_TITLE_MAX_CHARS = {REQUESTED_TITLE_CHARS};")));
    }

    #[test]
    fn wait_for_llm_ends_when_idle_cancelled_or_at_the_limit() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap();
        let step = std::time::Duration::from_millis(5);
        let limit = std::time::Duration::from_millis(60);
        rt.block_on(async {
            // Nothing in flight: no wait.
            assert!(wait_while(|| false, || false, limit, step).await.unwrap());
            // Becomes idle after a few checks.
            let n = std::sync::atomic::AtomicUsize::new(3);
            assert!(wait_while(|| n.fetch_sub(1, Ordering::SeqCst) > 1, || false, limit, step).await.unwrap());
            // Still busy at the limit: false (the caller goes on anyway).
            assert!(!wait_while(|| true, || false, limit, step).await.unwrap());
            // A cancel ends the wait with an error.
            assert!(wait_while(|| true, || true, limit, step).await.is_err());
        });
    }
}

#[cfg(test)]
#[path = "e2e/jobs_e2e.rs"]
mod e2e_jobs;
