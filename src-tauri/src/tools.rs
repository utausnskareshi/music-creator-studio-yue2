//! Non-song ComfyUI jobs: audio -> ABC transcription (SheetSage2) and vocal separation.

use crate::comfy::client::{self, audio_outputs, text_output, HistoryWait, PromptFailure, WaitLimits};
use crate::workflow;
use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

/// The official planner seed (instrumental.py --seed default); the E2E harness plans with it.
#[cfg(test)]
pub const PLAN_DEFAULT_SEED: u64 = 831001;

/// Budget of one tool prompt once ComfyUI runs it (time spent pending behind a generation does not
/// count, see client::HistoryWait). Transcription, separation, alignment and planning take minutes; a
/// song generation has its own, longer budget (jobs.rs).
const TOOL_TIMEOUT_SECS: u64 = 1800;
const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(800);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolProgress {
    pub tool: String,
    pub stage: String,
    pub prompt_id: Option<String>,
    pub done: bool,
    pub error: Option<String>,
    /// The caller's run id (the command's optional `run_id`), on every event of that run: a page tells its
    /// own run from another page's run of the same tool (several pages stay mounted and may run one each).
    pub run_id: Option<String>,
}

/// A tool run as its progress events name it: the tool and the caller's run id.
#[derive(Debug, Clone, Copy)]
pub struct Run<'a> {
    pub tool: &'a str,
    pub id: Option<&'a str>,
}

impl<'a> Run<'a> {
    pub fn new(tool: &'a str, id: Option<&'a str>) -> Self {
        Self { tool, id: id.filter(|s| !s.is_empty()) }
    }

    fn progress(&self, stage: &str, prompt_id: Option<&str>, done: bool, error: Option<String>) -> ToolProgress {
        ToolProgress { tool: self.tool.into(), stage: stage.into(), prompt_id: prompt_id.map(|s| s.to_string()), done, error, run_id: self.id.map(|s| s.to_string()) }
    }
}

/// Counts a tool run in AppState::tools_in_flight for its whole lifetime (restart_comfy_if_stale
/// must not stop ComfyUI between staging and the last download). When the last tool run ends, a
/// VAE-precision restart that was put off meanwhile is tried again (crate::retry_deferred_restart).
struct InFlight<'a>(&'a AppHandle);

impl<'a> InFlight<'a> {
    fn new(app: &'a AppHandle) -> Self {
        app.state::<crate::AppState>().tools_in_flight.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Self(app)
    }
}

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        let before = self.0.state::<crate::AppState>().tools_in_flight.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        if before == 1 {
            crate::retry_deferred_restart(self.0);
        }
    }
}

fn emit(app: &AppHandle, run: Run<'_>, stage: &str, prompt_id: Option<&str>, done: bool, error: Option<String>) {
    let _ = app.emit("tool://progress", run.progress(stage, prompt_id, done, error));
}

/// The one final event of a tool run: 完了, 失敗 with the same text the call returns, キャンセル (no error
/// text) for a run stopped by cancel_tool (the call returns crate::COMFY_WAIT_CANCELLED), or 中止 (no error
/// text) for a separation whose library song was deleted meanwhile (the call returns SEPARATION_SONG_DELETED).
/// Every tool runs its steps in one block and passes the result through here, so no error path can leave the
/// page waiting for a `done` event.
fn finish<T>(app: &AppHandle, run: Run<'_>, r: Result<T>) -> Result<T> {
    let (stage, error) = final_event(&r);
    emit(app, run, stage, None, true, error);
    r
}

/// Stage and error text of the final "tool://progress" event for a run's result.
fn final_event<T>(r: &Result<T>) -> (&'static str, Option<String>) {
    match r {
        Ok(_) => ("完了", None),
        Err(e) if is_cancelled(e) => (TOOL_CANCELLED_STAGE, None),
        Err(e) if format!("{e:#}") == SEPARATION_SONG_DELETED => (TOOL_ABORTED_STAGE, None),
        Err(e) => ("失敗", Some(format!("{e:#}"))),
    }
}

/// Final stage of a cancelled run (src/api.ts TOOL_CANCELLED_STAGE matches it).
pub(crate) const TOOL_CANCELLED_STAGE: &str = "キャンセル";
/// Final stage of a separation whose library song was deleted meanwhile (SEPARATION_SONG_DELETED): stopped by the
/// user's own delete, so neutral like a cancel (no error text). The pages show the call's error as a notice.
const TOOL_ABORTED_STAGE: &str = "中止";
/// Stage after the prompt left ComfyUI (src/components/toolRun.ts AFTER_PROMPT_STAGES: too late to cancel).
const SAVING_OUTPUT_STAGE: &str = "出力を保存中";

/// The error run_prompt returns for a run stopped by cancel_tool.
fn is_cancelled(e: &anyhow::Error) -> bool {
    format!("{e:#}") == crate::COMFY_WAIT_CANCELLED
}

/// Keeps a tool prompt's cancel flag registered (AppState::register_tool_cancel) while run_prompt
/// waits for it, and forgets it on every exit.
struct CancelRegistration<'a> {
    state: &'a crate::AppState,
    ids: Vec<String>,
}

impl<'a> CancelRegistration<'a> {
    fn new(state: &'a crate::AppState, prompt_id: &str) -> (Self, Arc<AtomicBool>) {
        let flag = state.register_tool_cancel(prompt_id);
        (Self { state, ids: vec![prompt_id.to_string()] }, flag)
    }

    /// The server reported another id than the one we generated: cancel_tool targets that one (the
    /// progress events carry it). Returns its flag.
    fn also(&mut self, prompt_id: &str) -> Arc<AtomicBool> {
        self.ids.push(prompt_id.to_string());
        self.state.register_tool_cancel(prompt_id)
    }
}

impl Drop for CancelRegistration<'_> {
    fn drop(&mut self) {
        for id in &self.ids {
            self.state.forget_tool_cancel(id);
        }
    }
}

/// Make sure ComfyUI is up. ensure_comfy_running runs every time (it also refreshes the node
/// checks and the WS relay for a server that was already running); the status is shown only
/// when it actually has to start.
async fn ensure_comfy(app: &AppHandle, run: Run<'_>) -> Result<()> {
    let client = app.state::<crate::AppState>().client();
    if !client.is_alive().await {
        emit(app, run, "ComfyUI を起動中", None, false, None);
    }
    crate::ensure_comfy_running(app).await
}

/// Stage a local audio file for LoadAudio (see client::stage_input), in the input folder the running
/// ComfyUI reads (after a data-root change saved while it was busy, still the old one until it restarts).
async fn stage(app: &AppHandle, path: &Path) -> Result<String> {
    let state = app.state::<crate::AppState>();
    let input_dir = crate::comfy_input_dir_in_use(&state);
    let own_server = crate::comfy_vae_fp32(&state).is_some();
    client::stage_input(&state.client(), &input_dir, path, own_server).await
}

/// Outputs of a finished prompt plus the last progress per node.
struct PromptResult {
    prompt_id: String,
    outputs: Value,
    progress: std::collections::HashMap<String, (u64, u64)>,
}

/// What a tool reports for a finished history entry (None = success). A run cancelled through
/// cancel_tool never gets here (run_prompt reports it first), so an interrupt came from outside the app.
fn failure_message(entry: &Value) -> Option<String> {
    client::history_failure(entry).map(|f| match f {
        PromptFailure::Interrupted => "処理が中断されました（ComfyUI 側での中断）".into(),
        PromptFailure::Error(m) => m,
        PromptFailure::Unknown => "ComfyUI でエラーが発生しました".into(),
    })
}

/// Queue a prompt and wait for its history entry (polling). Returns the outputs object.
/// cancel_tool(prompt_id) stops it: a pending prompt is dropped from the queue, a running one is
/// interrupted, and the run ends with crate::COMFY_WAIT_CANCELLED — also when the prompt finished or
/// failed in the meantime (a cancel that lost the race with the end still counts as cancelled).
async fn run_prompt(app: &AppHandle, run: Run<'_>, prompt: &Value) -> Result<PromptResult> {
    let state = app.state::<crate::AppState>();
    let client = state.client();
    let prompt_id = uuid::Uuid::new_v4().to_string();
    // Registered before the prompt is queued, so no cancel can come too early.
    let (mut registration, mut cancel) = CancelRegistration::new(&state, &prompt_id);
    let queued_id = client.queue_prompt(prompt, crate::comfy::ws::client_id(), &prompt_id).await?;
    if queued_id != prompt_id {
        cancel = registration.also(&queued_id);
    }
    let prompt_id = queued_id;
    emit(app, run, "処理中", Some(&prompt_id), false, None);
    let cancelled = || cancel.load(Ordering::SeqCst);
    let mut wait = HistoryWait::new(&client, &prompt_id, WaitLimits { run_secs: TOOL_TIMEOUT_SECS, wait_secs: client::QUEUE_WAIT_LIMIT_SECS });
    let waited = loop {
        tokio::time::sleep(POLL_INTERVAL).await;
        match wait.poll(cancelled()).await {
            Ok(Some(h)) => break Ok(h),
            Ok(None) => {}
            Err(e) => break Err(e),
        }
    };
    if cancelled() {
        // Both idempotent (cancel_tool already asked once): nothing of the run may stay queued or running.
        client.stop_prompt(&prompt_id).await;
        state.last_progress.lock().retain(|(p, _), _| p != &prompt_id);
        bail!("{}", crate::COMFY_WAIT_CANCELLED);
    }
    let entry = match waited {
        Ok(h) => h,
        Err(e) => {
            state.last_progress.lock().retain(|(p, _), _| p != &prompt_id);
            bail!("{}", e.message("処理", TOOL_TIMEOUT_SECS));
        }
    };
    let progress = crate::comfy::ws::take_progress(&mut state.last_progress.lock(), &prompt_id);
    if let Some(msg) = failure_message(&entry) {
        bail!("{msg}");
    }
    Ok(PromptResult { prompt_id, outputs: entry.get("outputs").cloned().unwrap_or(Value::Null), progress })
}

/// Transcribe a local audio file into a YuE2 ABC score with SheetSage2.
pub async fn transcribe(app: &AppHandle, path: &Path, mode: &str, run_id: Option<&str>) -> Result<String> {
    let run = Run::new("transcribe", run_id);
    let _in_flight = InFlight::new(app);
    let r = async {
        ensure_comfy(app, run).await?;
        emit(app, run, "音源を準備中", None, false, None);
        let name = stage(app, path).await?;
        let r = run_prompt(app, run, &workflow::build_transcribe(&name, mode)).await?;
        let abc = text_output(&r.outputs, workflow::NODE_ABC_PREVIEW).unwrap_or_default();
        if abc.trim().is_empty() {
            bail!("転写結果が空でした");
        }
        Ok(abc)
    }
    .await;
    finish(app, run, r)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeparationResult {
    pub vocals_path: String,
    pub instrumental_path: String,
    pub folder: String,
}

/// Neutral, unique output prefix for a separation run. The source stem is not used: ComfyUI's
/// /view refuses any filename containing "..", so a stem like "demo..final" would fail only at download.
fn separation_prefix() -> String {
    format!("mcs_sep/{}", &uuid::Uuid::new_v4().simple().to_string()[..8])
}

/// Error of a separation whose library song was deleted while it ran: nothing is saved (the stems would
/// bring back the deleted song folder, with no library row that could ever remove it again). The run's final event
/// is the neutral 中止 (TOOL_ABORTED_STAGE), not 失敗.
const SEPARATION_SONG_DELETED: &str = "曲がライブラリから削除されたため、分離結果は保存しませんでした";

/// Separate a local audio file into vocals / instrumental (saved into `out_dir`). `song_gone` tells whether the
/// library song `out_dir` belongs to was deleted meanwhile (always false for a file outside the library).
pub async fn separate(app: &AppHandle, path: &Path, model: &str, out_dir: &Path, run_id: Option<&str>, song_gone: &(dyn Fn() -> bool + Send + Sync)) -> Result<SeparationResult> {
    let run = Run::new("separate", run_id);
    let state = app.state::<crate::AppState>();
    let _in_flight = InFlight::new(app);
    let r = async {
        if !path.is_file() {
            bail!("音声ファイルが見つかりません");
        }
        ensure_comfy(app, run).await?;
        if !state.has_wav_saver.load(std::sync::atomic::Ordering::Relaxed) {
            bail!("ボーカル分離には同梱ノードパック（MCS YuE2 Nodes）が必要です。ComfyUI を再起動してください。");
        }
        if song_gone() {
            bail!(SEPARATION_SONG_DELETED);
        }
        // Before the GPU run: a folder that cannot be created fails now, not after the separation.
        std::fs::create_dir_all(out_dir).with_context(|| format!("出力フォルダを作成できませんでした: {}", out_dir.display()))?;
        emit(app, run, "音源を準備中", None, false, None);
        let name = stage(app, path).await?;
        let r = run_prompt(app, run, &workflow::build_separate(&name, model, &separation_prefix())).await?;
        emit(app, run, SAVING_OUTPUT_STAGE, None, false, None);
        save_stems(&state, &r.outputs, out_dir, song_gone).await
    }
    .await;
    finish(app, run, r)
}

/// Download both stems into `out_dir`. They land as temporary files first and replace vocals.wav /
/// instrumental.wav only once both downloads succeeded, and then as a pair, all or nothing
/// (commit_downloads: one stem locked by another app keeps both old ones), so a failed re-separation does
/// not leave a new vocal stem next to an old instrumental one. ComfyUI's copies are removed afterwards
/// (our own server). A library song deleted during the run gets nothing: the download would create its
/// folder again (checked before, and after in case the delete came while the stems were saved).
async fn save_stems(state: &crate::AppState, outputs: &Value, out_dir: &Path, song_gone: &(dyn Fn() -> bool + Send + Sync)) -> Result<SeparationResult> {
    let v = audio_outputs(outputs, workflow::NODE_SEP_VOCALS);
    let i = audio_outputs(outputs, workflow::NODE_SEP_INST);
    let (Some(vf), Some(inf)) = (v.first(), i.first()) else {
        bail!("分離結果のファイルが見つかりません");
    };
    if song_gone() {
        remove_comfy_copies(state, &[vf, inf]);
        bail!(SEPARATION_SONG_DELETED);
    }
    let client = state.client();
    let vocals: PathBuf = out_dir.join("vocals.wav");
    let inst: PathBuf = out_dir.join("instrumental.wav");
    let saved = async {
        let (tv, _) = client.download_view_to_temp(vf, &vocals).await?;
        let ti = match client.download_view_to_temp(inf, &inst).await {
            Ok((t, _)) => t,
            Err(e) => {
                let _ = tokio::fs::remove_file(&tv).await;
                return Err(e);
            }
        };
        client::commit_downloads(&[(tv, vocals.clone()), (ti, inst.clone())]).await
    }
    .await;
    if song_gone() {
        discard_stems(out_dir);
        remove_comfy_copies(state, &[vf, inf]);
        bail!(SEPARATION_SONG_DELETED);
    }
    saved?;
    remove_comfy_copies(state, &[vf, inf]);
    Ok(SeparationResult { vocals_path: vocals.to_string_lossy().to_string(), instrumental_path: inst.to_string_lossy().to_string(), folder: out_dir.to_string_lossy().to_string() })
}

/// Remove ComfyUI's copies of our outputs (our own server only).
fn remove_comfy_copies(state: &crate::AppState, files: &[&client::OutputFile]) {
    if crate::comfy_vae_fp32(state).is_some() {
        let dir = crate::comfy_output_dir_in_use(state);
        for f in files {
            if let Some(p) = client::own_output_path(&dir, f) {
                let _ = std::fs::remove_file(p);
            }
        }
    }
}

/// Take out the stems saved into `out_dir` for a song deleted meanwhile, and the folders the download created
/// for them (separated, align, the song folder, its date folder) as long as they are empty.
fn discard_stems(out_dir: &Path) {
    for name in ["vocals.wav", "instrumental.wav"] {
        let _ = std::fs::remove_file(out_dir.join(name));
    }
    for dir in out_dir.ancestors().take(4) {
        let ours = dir.file_name().and_then(|n| n.to_str()).is_some_and(|n| matches!(n, "separated" | "align") || crate::is_song_folder_name(n) || crate::is_date_folder_name(n));
        if !ours || std::fs::remove_dir(dir).is_err() {
            break;
        }
    }
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignedWord {
    pub text: String,
    pub start: f64,
    pub end: f64,
    #[serde(default)]
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignedLine {
    pub index: usize,
    pub line: String,
    pub start: f64,
    pub end: f64,
    #[serde(default)]
    pub words: Vec<AlignedWord>,
}

/// MCS_AlignLyrics's result. The node always returns its JSON text (a genuine "[]" when nothing could
/// be aligned), so a missing output or a text that does not parse is an error, not an empty alignment.
pub(crate) fn parse_alignment(outputs: &Value) -> Result<Vec<AlignedLine>> {
    let text = text_output(outputs, workflow::NODE_ALIGN).ok_or_else(|| anyhow!("MCS_AlignLyrics の出力がありません"))?;
    serde_json::from_str(&text).with_context(|| format!("整列結果を読み取れませんでした: {}", text.chars().take(200).collect::<String>()))
}

/// Forced-align lyric lines to an audio file (ideally the separated vocals).
pub async fn align_lyrics(app: &AppHandle, path: &Path, lyrics: &str, language: &str, run_id: Option<&str>) -> Result<Vec<AlignedLine>> {
    let run = Run::new("align", run_id);
    let state = app.state::<crate::AppState>();
    let _in_flight = InFlight::new(app);
    let r = async {
        ensure_comfy(app, run).await?;
        if !state.client().has_node("MCS_AlignLyrics").await {
            bail!("同梱ノードパックに MCS_AlignLyrics がありません。ComfyUI を再起動してください。");
        }
        emit(app, run, "音源を準備中", None, false, None);
        let name = stage(app, path).await?;
        let r = run_prompt(app, run, &workflow::build_align(&name, lyrics, language)).await?;
        parse_alignment(&r.outputs)
    }
    .await;
    finish(app, run, r)
}

/// Error when the selected precision's checkpoint is not installed (None = present). Looks in
/// <data_root>/models/checkpoints (where setup downloads it) and ComfyUI's own models/checkpoints.
pub fn checkpoint_missing_message(cfg: &crate::config::AppConfig) -> Option<String> {
    let own = cfg.comfy_root().join("ComfyUI").join("models").join("checkpoints").join(cfg.checkpoint_file());
    if cfg.checkpoint_path().is_file() || own.is_file() {
        return None;
    }
    let label = if cfg.precision == "int8" { "INT8" } else { "BF16" };
    Some(format!(
        "選択中のモデル精度 ({label}) のチェックポイント {} が未導入です。設定画面の「セットアップをやり直す」で該当モデルをダウンロードするか、設定でモデル精度を切り替えてください。",
        cfg.checkpoint_file()
    ))
}

/// ckpt_name choices of CheckpointLoaderSimple from /object_info (legacy `[[names], {..}]` or
/// `["COMBO", {"options": [names]}]`).
fn ckpt_options(info: &Value) -> Vec<String> {
    let Some(spec) = info.pointer("/input/required/ckpt_name") else { return Vec::new() };
    let list = match spec.get(0) {
        Some(Value::Array(a)) => Some(a),
        _ => spec.pointer("/1/options").and_then(|o| o.as_array()),
    };
    list.map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()).unwrap_or_default()
}

/// The pre-submit checkpoint hint: the file check above, but a running ComfyUI that lists the
/// checkpoint (extra model paths, a server the app did not start) has the final say. Call it after
/// ComfyUI was started: with the server down a file only ComfyUI can find is reported missing.
pub async fn checkpoint_unavailable(client: &client::ComfyClient, cfg: &crate::config::AppConfig) -> Option<String> {
    let m = checkpoint_missing_message(cfg)?;
    match client.object_info("CheckpointLoaderSimple").await {
        Ok(info) if ckpt_options(&info).iter().any(|n| n == cfg.checkpoint_file()) => None,
        _ => Some(m),
    }
}

/// Whether a finished plan was cut off (workflow::plan_truncation_in; unknown counts as complete).
/// `progress` is the planner node's last progress (None when the node was cached); `known` holds the
/// digests of plans already found truncated.
#[cfg(test)]
fn plan_truncated(progress: Option<(u64, u64)>, abc: &str, known: &mut std::collections::HashSet<[u8; 32]>) -> bool {
    workflow::plan_truncation_in(progress, abc, known).unwrap_or(false)
}

/// Plan only: ask YuE2 for an ABC score (no audio) — used by the one-button instrumental flow.
/// Planned with the caller's `seed` (the render reuses it, so the plan can be reproduced); a plan that
/// used the whole token budget is refused like the official planner does (instrumental.py). The
/// command takes an optional seed for compatibility; none is an error.
pub async fn plan_score(app: &AppHandle, style: &str, lyrics: &str, mode: &str, seed: Option<u64>, abc_temperature: f64, run_id: Option<&str>) -> Result<String> {
    let run = Run::new("plan", run_id);
    let state = app.state::<crate::AppState>();
    let _in_flight = InFlight::new(app);
    let cfg = state.config.read().clone();
    let r = async {
        let Some(seed) = seed else { bail!("譜面の計画にはシードの指定が必要です") };
        ensure_comfy(app, run).await?;
        // After the start: a checkpoint only the running server can find (its own extra_model_paths.yaml)
        // is confirmed by its object_info instead of being reported missing while ComfyUI is still down.
        if let Some(m) = checkpoint_unavailable(&state.client(), &cfg).await {
            bail!("{m}");
        }
        if let Some(m) = crate::missing_yue2_nodes_message(&state.runtime.read().missing_nodes) {
            bail!("{m}");
        }
        let prompt = workflow::build_plan(cfg.checkpoint_file(), style, lyrics, mode, seed, abc_temperature);
        let r = run_prompt(app, run, &prompt).await?;
        let abc = text_output(&r.outputs, workflow::NODE_ABC_PREVIEW).unwrap_or_default();
        let mut progress = r.progress.get(workflow::NODE_ABC).copied();
        if progress.is_some_and(|(v, m)| v < m) {
            // The final progress event travels WS -> relay separately from /history: look once more.
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            let late = crate::comfy::ws::take_progress(&mut state.last_progress.lock(), &r.prompt_id);
            if let Some(p) = late.get(workflow::NODE_ABC) {
                progress = Some(*p);
            }
        }
        // Shared with generate jobs: a truncated plan cached by a job (same planner inputs) is refused too.
        if workflow::plan_truncation(progress, &abc).unwrap_or(false) {
            log::warn!("plan with seed {seed} reached the ABC token budget");
            bail!("譜面が上限トークンで打ち切られました。シードを変えて再試行してください");
        }
        if abc.trim().is_empty() {
            bail!("譜面の計画結果が空でした");
        }
        Ok(abc)
    }
    .await;
    finish(app, run, r)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The frontend tells a cancel from a failure (and a too-late cancel) only by these exact strings.
    #[test]
    fn cancel_strings_match_the_frontend() {
        let api = include_str!("../../src/api.ts");
        let expected = format!("export const TOOL_CANCELLED_ERROR = \"{}\";", crate::COMFY_WAIT_CANCELLED);
        assert!(api.contains(&expected), "src/api.ts must contain `{expected}`");
        let expected = format!("export const TOOL_CANCELLED_STAGE = \"{TOOL_CANCELLED_STAGE}\";");
        assert!(api.contains(&expected), "src/api.ts must contain `{expected}`");
        let run = include_str!("../../src/components/toolRun.ts");
        let expected = format!("new Set([\"{SAVING_OUTPUT_STAGE}\"])");
        assert!(run.contains(&expected), "src/components/toolRun.ts AFTER_PROMPT_STAGES must be `{expected}`");
    }

    #[test]
    fn progress_events_carry_the_run_id() {
        let run = Run::new("separate", Some("run-7"));
        let v = serde_json::to_value(run.progress("処理中", Some("p1"), false, None)).unwrap();
        assert_eq!(v, json!({ "tool": "separate", "stage": "処理中", "promptId": "p1", "done": false, "error": null, "runId": "run-7" }));
        // the final event names the run too (the page ends its own run with it)
        let v = serde_json::to_value(run.progress("完了", None, true, None)).unwrap();
        assert_eq!(v["runId"], json!("run-7"));
        // no id (an older caller) or an empty one: null
        assert_eq!(serde_json::to_value(Run::new("align", None).progress("完了", None, true, None)).unwrap()["runId"], json!(null));
        assert_eq!(Run::new("plan", Some("")).id, None);
    }

    /// Stems saved for a song deleted meanwhile go again, with the folders the download created for them (up to
    /// the date folder), as long as those are empty; nothing else is touched.
    #[test]
    fn stems_of_a_deleted_song_are_taken_out_with_their_empty_folders() {
        let base = std::env::temp_dir().join(format!("mcs_stems_{}", uuid::Uuid::new_v4().simple()));
        let out = base.join("out");
        let song = out.join("2026-09-30").join("101500_0123abcd");
        let write_stems = |dir: &Path| {
            std::fs::create_dir_all(dir).unwrap();
            for n in ["vocals.wav", "instrumental.wav"] {
                std::fs::write(dir.join(n), b"x").unwrap();
            }
        };
        // The folder chain the download created again: all of it goes, the output folder stays.
        let align = song.join("separated").join("align");
        write_stems(&align);
        discard_stems(&align);
        assert!(!out.join("2026-09-30").exists() && out.is_dir());
        // Another song in the date folder, and a file someone put into the song folder, stay.
        write_stems(&song.join("separated"));
        std::fs::write(song.join("notes.txt"), b"x").unwrap();
        let other = out.join("2026-09-30").join("101500_ffffeeee");
        std::fs::create_dir_all(&other).unwrap();
        discard_stems(&song.join("separated"));
        assert!(!song.join("separated").exists() && song.join("notes.txt").is_file() && other.is_dir());
        // Only the stem files themselves are removed from a folder that holds more.
        let elsewhere = base.join("separated");
        write_stems(&elsewhere);
        std::fs::write(elsewhere.join("keep.wav"), b"x").unwrap();
        discard_stems(&elsewhere);
        assert!(elsewhere.join("keep.wav").is_file() && !elsewhere.join("vocals.wav").exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Where a separation looks for its deleted library song (needs a ComfyUI run, so pinned in the source): before
    /// it creates the stem folder, before the download would create the song folder again, and after the commit
    /// for a delete that came during the download, which then takes the stems out again.
    #[test]
    fn a_separation_checks_for_its_deleted_song_around_the_stem_folder() {
        fn body<'a>(src: &'a str, sig: &str) -> &'a str {
            let rest = &src[src.find(sig).unwrap_or_else(|| panic!("{sig}"))..];
            &rest[..rest.find("\n}\n").unwrap()]
        }
        fn before(text: &str, a: &str, b: &str) {
            let i = text.find(a).unwrap_or_else(|| panic!("`{a}` missing"));
            let j = text.find(b).unwrap_or_else(|| panic!("`{b}` missing"));
            assert!(i < j, "`{a}` must come before `{b}`");
        }
        let src = include_str!("tools.rs");
        before(body(src, "pub async fn separate("), "if song_gone()", "create_dir_all(out_dir)");
        let save = body(src, "async fn save_stems(");
        before(save, "if song_gone()", "download_view_to_temp(");
        let after_commit = &save[save.find("commit_downloads(").expect("commit_downloads")..];
        before(after_commit, "if song_gone()", "discard_stems(out_dir)");
        before(after_commit, "discard_stems(out_dir)", "saved?");
    }

    #[test]
    fn separation_prefix_is_neutral() {
        let a = separation_prefix();
        let b = separation_prefix();
        assert!(a.starts_with("mcs_sep/") && a.len() == "mcs_sep/".len() + 8);
        assert_ne!(a, b);
        assert!(!a.contains(".."));
    }

    #[test]
    fn checkpoint_check_names_the_precision() {
        let cfg = crate::config::AppConfig {
            data_root: std::env::temp_dir().join(format!("mcs_ckpt_test_{}", uuid::Uuid::new_v4().simple())),
            precision: "int8".into(),
            ..Default::default()
        };
        let m = checkpoint_missing_message(&cfg).unwrap();
        assert!(m.contains("INT8") && m.contains("yue2_3b_int8_convrot.safetensors"));
        let p = cfg.checkpoint_path();
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, b"x").unwrap();
        assert_eq!(checkpoint_missing_message(&cfg), None);
        std::fs::remove_file(&p).unwrap();
        // ComfyUI's own models/checkpoints counts too.
        let own = cfg.comfy_root().join("ComfyUI").join("models").join("checkpoints").join(cfg.checkpoint_file());
        std::fs::create_dir_all(own.parent().unwrap()).unwrap();
        std::fs::write(&own, b"x").unwrap();
        assert_eq!(checkpoint_missing_message(&cfg), None);
        let _ = std::fs::remove_dir_all(&cfg.data_root);
    }

    /// One-shot HTTP server answering every request with `body` (JSON).
    async fn serve_json(body: String) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = [0u8; 4096];
                let _ = sock.read(&mut buf).await;
                let resp = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
                let _ = sock.write_all(resp.as_bytes()).await;
            }
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn checkpoint_listed_by_the_running_server_is_available() {
        let cfg = crate::config::AppConfig { data_root: std::env::temp_dir().join(format!("mcs_ckpt_srv_{}", uuid::Uuid::new_v4().simple())), ..Default::default() };
        // The file is in none of the app's folders, but ComfyUI finds it through its own model paths.
        assert!(checkpoint_missing_message(&cfg).is_some());
        let body = json!({ "CheckpointLoaderSimple": { "input": { "required": { "ckpt_name": [[cfg.checkpoint_file()], {}] } } } }).to_string();
        let base = serve_json(body).await;
        assert_eq!(checkpoint_unavailable(&client::ComfyClient::new(base), &cfg).await, None);
        // A server that does not list it (or no server at all) keeps the hint.
        let other = serve_json(json!({ "CheckpointLoaderSimple": { "input": { "required": { "ckpt_name": [["other.safetensors"], {}] } } } }).to_string()).await;
        assert!(checkpoint_unavailable(&client::ComfyClient::new(other), &cfg).await.is_some());
        // A port known to be closed (a fixed one such as 9 may have a service that never answers).
        let dead = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap()
        };
        assert!(checkpoint_unavailable(&client::ComfyClient::new(format!("http://{dead}")), &cfg).await.is_some());
    }

    #[test]
    fn ckpt_options_reads_both_combo_shapes() {
        let legacy = json!({ "input": { "required": { "ckpt_name": [["a.safetensors", "b.safetensors"], { "tooltip": "x" }] } } });
        assert_eq!(ckpt_options(&legacy), vec!["a.safetensors", "b.safetensors"]);
        let combo = json!({ "input": { "required": { "ckpt_name": ["COMBO", { "options": ["c.safetensors"] }] } } });
        assert_eq!(ckpt_options(&combo), vec!["c.safetensors"]);
        assert!(ckpt_options(&json!({})).is_empty());
    }

    #[test]
    fn cached_copy_of_a_truncated_plan_is_refused() {
        let mut known = std::collections::HashSet::new();
        // Fresh run that used the whole budget: refused and remembered.
        assert!(plan_truncated(Some((8192, 8192)), "X:1\nK:C\nCDE", &mut known));
        // Same graph again: ComfyUI serves it from the cache (no progress) -> still refused.
        assert!(plan_truncated(None, "X:1\nK:C\nCDE", &mut known));
        // A cached plan that was never seen truncated, or a fresh complete one, passes.
        assert!(!plan_truncated(None, "X:1\nK:G\nGAB", &mut known));
        assert!(!plan_truncated(Some((750, 8192)), "X:1\nK:D\nDEF", &mut known));
    }

    #[test]
    fn a_cancelled_run_ends_with_a_neutral_final_event() {
        assert_eq!(final_event(&Ok::<(), anyhow::Error>(())), ("完了", None));
        assert_eq!(final_event::<()>(&Err(anyhow!("{}", crate::COMFY_WAIT_CANCELLED))), ("キャンセル", None));
        assert_eq!(final_event::<()>(&Err(anyhow!("CUDA out of memory"))), ("失敗", Some("CUDA out of memory".to_string())));
        // A cancel wrapped in context is an ordinary failure (only run_prompt's own error counts).
        assert_eq!(final_event::<()>(&Err(anyhow!("{}", crate::COMFY_WAIT_CANCELLED).context("x"))).0, "失敗");
    }

    #[test]
    fn a_separation_of_a_deleted_song_ends_neutral() {
        // The user's own delete stopped it: 中止 without an error text, like a cancel (the call still returns the
        // reason; SeparatePage / ExportPage show it as a notice, not as a failure).
        assert_eq!(final_event::<()>(&Err(anyhow!(SEPARATION_SONG_DELETED))), ("中止", None));
        assert_ne!(TOOL_ABORTED_STAGE, TOOL_CANCELLED_STAGE);
        // Only the error separate() itself returns counts.
        assert_eq!(final_event::<()>(&Err(anyhow!(SEPARATION_SONG_DELETED).context("x"))).0, "失敗");
    }

    #[test]
    fn tool_failures_are_japanese() {
        let e = json!({ "status": { "status_str": "error", "messages": [["execution_interrupted", {}]] } });
        assert_eq!(failure_message(&e).as_deref(), Some("処理が中断されました（ComfyUI 側での中断）"));
        let e = json!({ "status": { "status_str": "error", "messages": [["execution_error", { "node_type": "MCS_VocalSeparate", "exception_message": "CUDA out of memory" }]] } });
        assert_eq!(failure_message(&e).as_deref(), Some("MCS_VocalSeparate: CUDA out of memory"));
        assert_eq!(failure_message(&json!({ "status": { "status_str": "error" } })).as_deref(), Some("ComfyUI でエラーが発生しました"));
        assert_eq!(failure_message(&json!({ "status": { "status_str": "success" } })), None);
    }

    #[test]
    fn alignment_result_errors_are_not_empty_alignments() {
        let ok = json!({ "align": { "text": ["[{\"index\":0,\"line\":\"la\",\"start\":0.5,\"end\":1.5,\"words\":[{\"text\":\"la\",\"start\":0.5,\"end\":1.5,\"score\":-0.2}]}]"] } });
        let lines = parse_alignment(&ok).unwrap();
        assert_eq!((lines.len(), lines[0].words.len(), lines[0].end), (1, 1, 1.5));
        // A genuine empty result stays empty (ExportPage explains it).
        assert!(parse_alignment(&json!({ "align": { "text": ["[]"] } })).unwrap().is_empty());
        // No output, or a text that is not the expected JSON (NaN, another schema): an error with an excerpt.
        assert!(format!("{:#}", parse_alignment(&json!({})).unwrap_err()).contains("MCS_AlignLyrics の出力がありません"));
        let bad = parse_alignment(&json!({ "align": { "text": ["[{\"index\":0,\"line\":\"la\",\"start\":NaN,\"end\":1}]"] } })).unwrap_err();
        assert!(format!("{bad:#}").contains("整列結果を読み取れませんでした: [{\"index\":0"));
    }
}

#[cfg(test)]
#[path = "e2e/tools_e2e.rs"]
pub(crate) mod e2e_tools;
