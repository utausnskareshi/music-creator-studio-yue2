mod comfy;
mod config;
mod db;
mod diagnostics;
mod export;
mod jobs;
mod llm;
mod power;
mod protocol;
mod setup;
mod tools;
mod win_job;
mod workflow;

// End-to-end harness against a real ComfyUI (ignored tests; see e2e/mod.rs).
#[cfg(test)]
mod e2e;

use anyhow::{anyhow, bail, Result};
use comfy::{ComfyClient, ComfyProcess};
use config::AppConfig;
use db::{Db, Song};
use jobs::SharedJobs;
use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use workflow::GenerateParams;

// ---------------------------------------------------------------- logging

/// Where log lines go besides stderr. logs/app.log is opened (and rotated) only in `.setup()`, after the
/// single-instance gate: a second launch that is turned away must not rotate or write the running
/// instance's log. Lines logged before that are kept (up to LOG_PENDING_MAX) and written first.
struct LogSink {
    file: Option<std::fs::File>,
    pending: Vec<u8>,
}

static LOG_SINK: Mutex<LogSink> = Mutex::new(LogSink { file: None, pending: Vec::new() });
const LOG_PENDING_MAX: usize = 1024 * 1024;

/// Writes log lines to stderr and to the log sink.
struct TeeWriter;
impl std::io::Write for TeeWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let _ = std::io::stderr().write_all(buf);
        let mut sink = LOG_SINK.lock();
        match sink.file.as_mut() {
            Some(f) => f.write(buf),
            None => {
                if sink.pending.len() + buf.len() <= LOG_PENDING_MAX {
                    sink.pending.extend_from_slice(buf);
                }
                Ok(buf.len())
            }
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        match LOG_SINK.lock().file.as_mut() {
            Some(f) => f.flush(),
            None => Ok(()),
        }
    }
}

/// Open logs/app.log (rotated to app.1.log when above 5 MB if `rotate`) and write the pending lines.
fn open_app_log(rotate: bool) {
    use std::io::Write;
    let mut sink = LOG_SINK.lock();
    if sink.file.is_some() {
        return;
    }
    let _ = std::fs::create_dir_all(config::log_dir());
    let log_path = config::log_dir().join("app.log");
    if rotate && std::fs::metadata(&log_path).map(|m| m.len() > 5 * 1024 * 1024).unwrap_or(false) {
        let _ = std::fs::rename(&log_path, config::log_dir().join("app.1.log"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&log_path) {
        let pending = std::mem::take(&mut sink.pending);
        let _ = f.write_all(&pending);
        sink.file = Some(f);
    }
}

// ---------------------------------------------------------------- state

pub struct AppState {
    pub config: RwLock<AppConfig>,
    pub comfy: Mutex<Option<ComfyProcess>>,
    /// The running WS relay: (port, its own stop token). A new relay gets a new token, so a retired
    /// one can never resume after a quick stop/start or a port change.
    pub ws_relay: Mutex<Option<(u16, Arc<AtomicBool>)>>,
    pub db: Mutex<Db>,
    pub jobs: SharedJobs,
    pub setup_cancel: Arc<AtomicBool>,
    pub setup_running: AtomicBool,
    pub has_wav_saver: AtomicBool,
    pub llama: Mutex<Option<llm::LlamaProcess>>,
    /// Latest WebSocket progress per (prompt_id, node), filled by the relay (truncation detection).
    pub last_progress: Mutex<comfy::ws::ProgressMap>,
    /// What the running ComfyUI offers, refreshed by after_up().
    pub runtime: RwLock<RuntimeInfo>,
    /// Unix seconds of the last prune of stale staged inputs (comfy_input/mcs_uploads); 0 = never.
    /// Pruned at most once per UPLOAD_CLEANUP_INTERVAL while nothing is queued.
    pub uploads_cleaned_at: AtomicU64,
    /// Tool runs (transcribe / separate / align / plan) between their start and their last ComfyUI
    /// request: restart_comfy_if_stale leaves ComfyUI alone while this is non-zero.
    pub tools_in_flight: AtomicUsize,
    /// export_audio runs (ffmpeg writing <name>.mcs-tmp.<8 hex>.<ext> next to the destination): the close guard holds
    /// the window for them, since quitting kills ffmpeg and leaves that partial file behind (until the next export
    /// to that name removes it).
    pub exports_in_flight: AtomicUsize,
    /// The names those runs export to: a second export to one of them is refused (export::ExportDests).
    pub export_dests: Arc<export::ExportDests>,
    /// Set while restart_comfy_if_stale stops and respawns our ComfyUI; ensure_comfy_running waits.
    pub comfy_restarting: AtomicBool,
    /// Canonical paths of files handed out by `file_url` (user-picked sources, export results, songs
    /// saved under an earlier output folder): mcs:// serves these besides output_dir / data_root.
    pub served: Mutex<ServedFiles>,
    /// Serializes save_config (config.json write + in-memory update), which runs off the UI thread.
    pub config_save: tokio::sync::Mutex<()>,
    /// Local-LLM requests (ensure + chat) in flight. A generation that unloads the LLM can wait for
    /// them instead of cutting a request off (jobs::run_one).
    pub llm_in_flight: AtomicUsize,
    /// app_exit was called: the close guard lets the window go.
    pub exit_confirmed: AtomicBool,
    /// When the close guard last held the window back. A second close within FORCE_CLOSE_WINDOW goes
    /// through without the dialog (the fail-safe when the frontend cannot answer: setup screen without
    /// the dialog, a hung WebView, a listener not registered yet).
    pub close_blocked_at: Mutex<Option<std::time::Instant>>,
    /// Serializes start_comfy's node-pack refresh and spawn, and the take in comfy_stop / a restart / exit,
    /// without holding `comfy` meanwhile (client() and effective_comfy_port() lock it on every request).
    pub comfy_spawn: Mutex<()>,
    /// Cancel flags of tool runs by ComfyUI prompt_id (set by cancel_tool, checked by tools::run_prompt).
    pub tool_cancels: Mutex<ToolCancels>,
    /// LLM requests (llm_edit / llm_complete) that can be cancelled, by the request id the page sent (llm_cancel).
    pub llm_cancels: LlmCancels,
}

/// Files handed out by `file_url` / `audio_peaks` (canonical paths). Bounded: past SERVED_MAX the entry
/// registered longest ago is dropped, so a file in use (registered again on every file_url) stays.
#[derive(Default)]
pub struct ServedFiles {
    set: HashSet<PathBuf>,
    order: VecDeque<PathBuf>,
}

const SERVED_MAX: usize = 4096;

impl ServedFiles {
    pub fn contains(&self, p: &Path) -> bool {
        self.set.contains(p)
    }

    /// Record `p` as the newest entry (a known one moves to the back).
    fn insert(&mut self, p: PathBuf) {
        if self.set.contains(&p) {
            if let Some(i) = self.order.iter().position(|x| x == &p) {
                self.order.remove(i);
            }
        } else {
            self.set.insert(p.clone());
        }
        self.order.push_back(p);
        while self.order.len() > SERVED_MAX {
            if let Some(old) = self.order.pop_front() {
                self.set.remove(&old);
            }
        }
    }
}

/// Cancel flags of tool runs (transcribe / separate / align / plan), keyed by the prompt_id a run reports
/// in its "tool://progress" events. tools::run_prompt registers its prompt before queueing it, checks the
/// flag while it polls and forgets it at the end; cancel_tool sets it. A cancel for an id no run holds
/// (the prompt just ended, or it came before the run registered) is kept set, so a run that registers
/// that id later starts out cancelled.
/// An entry a run still holds (its CancelRegistration keeps the flag's Arc) stays however long the run
/// takes: a tool prompt may wait up to QUEUE_WAIT_LIMIT_SECS and then run up to TOOL_TIMEOUT_SECS.
/// TOOL_CANCEL_TTL only bounds orphaned entries, i.e. cancels for an id no run holds.
#[derive(Default)]
pub struct ToolCancels {
    flags: HashMap<String, (Arc<AtomicBool>, std::time::Instant)>,
}

const TOOL_CANCEL_TTL: std::time::Duration = std::time::Duration::from_secs(3600);

impl ToolCancels {
    /// The flag of `prompt_id`, created unset when none exists (a cancel that came first stays set).
    pub fn register(&mut self, prompt_id: &str, now: std::time::Instant) -> Arc<AtomicBool> {
        self.prune(now);
        self.flags.entry(prompt_id.to_string()).or_insert_with(|| (Arc::new(AtomicBool::new(false)), now)).0.clone()
    }

    pub fn is_cancelled(&self, prompt_id: &str) -> bool {
        self.flags.get(prompt_id).is_some_and(|(f, _)| f.load(Ordering::SeqCst))
    }

    /// Set the flag of `prompt_id`. Returns true when a run had registered it.
    pub fn cancel(&mut self, prompt_id: &str, now: std::time::Instant) -> bool {
        self.prune(now);
        match self.flags.get(prompt_id) {
            Some((f, _)) => {
                f.store(true, Ordering::SeqCst);
                true
            }
            None => {
                self.flags.insert(prompt_id.to_string(), (Arc::new(AtomicBool::new(true)), now));
                false
            }
        }
    }

    pub fn forget(&mut self, prompt_id: &str) {
        self.flags.remove(prompt_id);
    }

    fn prune(&mut self, now: std::time::Instant) {
        // strong_count > 1: a run holds the flag (CancelRegistration::drop always forgets it).
        self.flags.retain(|_, (f, at)| Arc::strong_count(f) > 1 || now.saturating_duration_since(*at) < TOOL_CANCEL_TTL);
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.flags.len()
    }
}

/// Native YuE2 nodes the generation graph needs (ComfyUI v0.35.0+). Missing ones block generation.
pub const REQUIRED_YUE2_NODES: [&str; 3] = ["YuE2GenerateABC", "YuE2GenerateMusic", "EmptyYuE2LatentAudio"];

#[derive(Debug, Clone, Default)]
pub struct RuntimeInfo {
    pub comfyui_version: Option<String>,
    /// Checked nodes (REQUIRED_YUE2_NODES, MCS_SaveAudioWav, MCS_YuE2Status) the server lacks.
    pub missing_nodes: Vec<String>,
    /// CONDITIONING input name of MCS_YuE2Status, when the installed node pack has it.
    pub status_input: Option<String>,
}

impl AppState {
    /// Port the app talks to ComfyUI on: our own running process keeps its port until it is restarted
    /// with a changed config (restart_comfy_if_stale), so a port change saved while it works does not
    /// move running jobs, tools or the WS relay away from it. Otherwise the configured port.
    pub fn effective_comfy_port(&self) -> u16 {
        let own = {
            let mut g = self.comfy.lock();
            g.as_mut().and_then(|p| if p.alive() { Some(p.port) } else { None })
        };
        own.unwrap_or_else(|| self.config.read().comfy_port)
    }

    pub fn client(&self) -> ComfyClient {
        ComfyClient::new(format!("http://127.0.0.1:{}", self.effective_comfy_port()))
    }

    /// A generation is running or about to run (the worker keeps the job active from the moment it
    /// leaves the queue).
    pub fn generation_busy(&self) -> bool {
        self.jobs.active_song_id().is_some()
    }

    /// Register a tool run's prompt for cancel_tool (tools::run_prompt, before queueing it).
    pub fn register_tool_cancel(&self, prompt_id: &str) -> Arc<AtomicBool> {
        self.tool_cancels.lock().register(prompt_id, std::time::Instant::now())
    }

    /// Drop a finished tool prompt's cancel flag.
    pub fn forget_tool_cancel(&self, prompt_id: &str) {
        self.tool_cancels.lock().forget(prompt_id);
    }

    /// Take our ComfyUI process out of the state (stop / restart / exit), after a spawn in progress.
    fn take_comfy(&self) -> Option<ComfyProcess> {
        let _spawning = self.comfy_spawn.lock();
        self.comfy.lock().take()
    }

    /// Stop the current WS relay (it ends at its next message or idle tick).
    fn retire_ws_relay(&self) {
        if let Some((_, token)) = self.ws_relay.lock().take() {
            token.store(false, Ordering::SeqCst);
        }
    }
}

/// Counts one local-LLM request in AppState::llm_in_flight while it lives.
struct LlmInFlight<'a>(&'a AppState);

impl<'a> LlmInFlight<'a> {
    fn new(state: &'a AppState) -> Self {
        state.llm_in_flight.fetch_add(1, Ordering::SeqCst);
        Self(state)
    }
}

impl Drop for LlmInFlight<'_> {
    fn drop(&mut self) {
        self.0.llm_in_flight.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Counts one run in an AppState counter (exports_in_flight) while it lives.
struct Counted<'a>(&'a AtomicUsize);

impl<'a> Counted<'a> {
    fn new(counter: &'a AtomicUsize) -> Self {
        counter.fetch_add(1, Ordering::SeqCst);
        Self(counter)
    }
}

impl Drop for Counted<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// The error that blocks generation when a native YuE2 node is missing (None = all present).
pub fn missing_yue2_nodes_message(missing: &[String]) -> Option<String> {
    let req: Vec<&str> = missing.iter().map(|s| s.as_str()).filter(|n| REQUIRED_YUE2_NODES.contains(n)).collect();
    if req.is_empty() {
        return None;
    }
    Some(format!(
        "ComfyUI に YuE2 ノード（{}）が見つかりません。動作確認済みの ComfyUI v{} を使うか、設定画面の「セットアップをやり直す」を押して保存し、ComfyUI を導入し直してください。",
        req.join(", "),
        setup::COMFYUI_VERSION
    ))
}

/// Name of the first required CONDITIONING input in an /object_info entry.
fn conditioning_input_name(info: &serde_json::Value) -> Option<String> {
    let req = info.pointer("/input/required")?.as_object()?;
    let order: Vec<String> = info
        .pointer("/input_order/required")
        .and_then(|o| o.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_else(|| req.keys().cloned().collect());
    order.into_iter().find(|k| req.get(k).and_then(|v| v.get(0)).and_then(|t| t.as_str()) == Some("CONDITIONING"))
}

type CmdResult<T> = std::result::Result<T, String>;
fn err<E: std::fmt::Display>(e: E) -> String {
    format!("{e}")
}

// ---------------------------------------------------------------- config

#[tauri::command]
fn get_config(state: State<AppState>) -> AppConfig {
    state.config.read().clone()
}

/// Notices from this launch's start (an unusable config.json / secrets.json), each returned once.
#[tauri::command]
fn take_startup_notices() -> Vec<String> {
    config::take_startup_notices()
}

/// Runs off the UI thread (config.save() also writes the uninstaller's registry record, through the registry
/// API in config.rs write_registry). Saves are
/// serialized, so config.json and the in-memory config always end up with the same, last value.
#[tauri::command]
async fn save_config(app: AppHandle, state: State<'_, AppState>, config: AppConfig) -> CmdResult<AppConfig> {
    let guard = state.config_save.lock().await;
    // 「セットアップをやり直す」 swaps the whole app for the wizard: the pages running a generation or a
    // tool would unmount and lose its result. The page checks this too; this closes its polling window.
    if state.config.read().setup_completed && !config.setup_completed && app_busy(&state) {
        return Err(SETUP_RERUN_BUSY.into());
    }
    let config = config.normalize();
    if location_change_refused(state.setup_running.load(Ordering::SeqCst), &state.config.read(), &config) {
        return Err(SETUP_RUNNING_LOCATIONS.into());
    }
    let to_save = config.clone();
    tokio::task::spawn_blocking(move || to_save.save()).await.map_err(err)?.map_err(|e| format!("{e:#}"))?;
    *state.config.write() = config.clone();
    drop(guard);
    // Changed ComfyUI launch settings (VAE FP32, port, data root) need a ComfyUI restart: done now if
    // our own ComfyUI is idle, otherwise when the running generation / tool runs end
    // (retry_deferred_restart), at the latest before the next generation (comfy_status reports
    // restartRequired meanwhile). Changed local-LLM settings are applied by the next LLM request
    // (ensure_llama_running), so an AI edit in flight is not cut off here.
    tauri::async_runtime::spawn(async move {
        if let Err(e) = restart_comfy_if_stale(&app, false).await {
            log::warn!("ComfyUI restart after config change failed: {e:#}");
        }
    });
    Ok(config)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppPaths {
    config_path: String,
    log_dir: String,
    comfy_log: String,
    app_version: String,
}

#[tauri::command]
fn app_paths(app: AppHandle) -> AppPaths {
    AppPaths {
        config_path: config::config_path().to_string_lossy().to_string(),
        log_dir: config::log_dir().to_string_lossy().to_string(),
        comfy_log: config::log_dir().join("comfyui.log").to_string_lossy().to_string(),
        app_version: app.package_info().version.to_string(),
    }
}

// ---------------------------------------------------------------- setup

/// Runs nvidia-smi and the disk-space query off the UI thread (a plain sync command would block the
/// window while the driver answers). The frontend still receives a SystemCheck on success.
#[tauri::command]
async fn system_check(state: State<'_, AppState>) -> CmdResult<setup::SystemCheck> {
    let cfg = state.config.read().clone();
    tokio::task::spawn_blocking(move || setup::system_check(&cfg)).await.map_err(err)
}

/// The data root's part of system_check, without nvidia-smi (the wizard's checks of the data root alone). Off the UI
/// thread: the data root may be on a sleeping or offline drive.
#[tauri::command(async)]
fn data_root_check(state: State<AppState>) -> setup::DataRootCheck {
    let cfg = state.config.read().clone();
    setup::data_root_check(&cfg)
}

/// Off the UI thread: it reads the markers under the data root, which may be on a sleeping or offline drive.
#[tauri::command(async)]
fn setup_status(state: State<AppState>) -> Vec<setup::ComponentStatus> {
    setup::status(&state.config.read())
}

/// Refusal of a second setup_install while one runs (also what a wizard reloaded meanwhile gets).
const SETUP_ALREADY_RUNNING: &str = "セットアップは既に実行中です（画面を再読み込みしても続いています）。完了するまでお待ちください";

/// setup://finished, sent when a setup_install run ends: a wizard reloaded meanwhile lost the run's own invoke
/// and learns the end from this. `error` is None on success (otherwise the same text the invoke fails with).
#[derive(Clone, Serialize)]
struct SetupFinished {
    error: Option<String>,
}

/// The run keeps going when the page is reloaded (F5, the context menu): the wizard then starts over while it
/// runs, so its folders stay put (save_config) and the setup cannot be finished meanwhile (setup_finalize).
#[tauri::command]
async fn setup_install(app: AppHandle, state: State<'_, AppState>, ids: Vec<String>) -> CmdResult<()> {
    if state.setup_running.swap(true, Ordering::SeqCst) {
        return Err(SETUP_ALREADY_RUNNING.into());
    }
    state.setup_cancel.store(false, Ordering::Relaxed);
    // Under save_config's lock: a save in progress lands before the run takes its copy, and a later one sees
    // setup_running.
    let cfg = {
        let _saving = state.config_save.lock().await;
        state.config.read().clone()
    };
    let cancel = state.setup_cancel.clone();
    let result = setup::install(app.clone(), cfg, ids, cancel).await.map_err(|e| format!("{e:#}"));
    state.setup_running.store(false, Ordering::SeqCst);
    // After the flag is down: a wizard that hears this may start or finish the setup at once.
    let _ = app.emit("setup://finished", SetupFinished { error: result.as_ref().err().cloned() });
    result
}

/// Refusal of a setup re-run while the app works (save_config; the same text as SettingsPage).
const SETUP_RERUN_BUSY: &str = "生成・ツールの実行中はセットアップをやり直せません。完了してから実行してください。";
/// Refusal of a save that moves the data root or the song folder while setup_install runs.
const SETUP_RUNNING_LOCATIONS: &str = "セットアップ（ダウンロード・展開）の実行中は保存先を変更できません。完了してから変更してください。";
/// Refusal of setup_finalize while setup_install runs.
const SETUP_STILL_RUNNING: &str = "セットアップ（ダウンロード・展開）がまだ実行中です。完了するまでお待ちください。";

/// A save would move the data root or the song folder while setup_install installs into (and finalizes) the ones
/// it started with: they would part ways (an orphaned install, a second download).
fn location_change_refused(setup_running: bool, cur: &AppConfig, new: &AppConfig) -> bool {
    setup_running && (cur.data_root != new.data_root || cur.output_dir != new.output_dir)
}

/// setup_finalize waits for a running setup_install (it would mark the setup complete under it).
fn setup_finalize_allowed(setup_running: bool) -> CmdResult<()> {
    if setup_running {
        return Err(SETUP_STILL_RUNNING.into());
    }
    Ok(())
}

/// A generation is running or queued, or a tool run is in flight.
fn app_busy(state: &AppState) -> bool {
    state.generation_busy() || state.tools_in_flight.load(Ordering::SeqCst) > 0 || state.jobs.queued_count() > 0
}

/// Work the user waits for runs: a generation (running or queued), a tool run, an export or the setup.
/// Windows is kept from idle sleep meanwhile (power.rs).
fn keep_awake_needed(state: &AppState) -> bool {
    app_busy(state) || state.exports_in_flight.load(Ordering::SeqCst) > 0 || state.setup_running.load(Ordering::SeqCst)
}

#[tauri::command]
fn setup_cancel(state: State<AppState>) {
    state.setup_cancel.store(true, Ordering::Relaxed);
}

/// Copies the node pack and writes the model paths: off the UI thread. Not while setup_install runs.
#[tauri::command]
async fn setup_finalize(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    setup_finalize_allowed(state.setup_running.load(Ordering::SeqCst))?;
    let cfg = state.config.read().clone();
    tokio::task::spawn_blocking(move || setup::finalize(&app, &cfg)).await.map_err(err)?.map_err(|e| format!("{e:#}"))
}

// ---------------------------------------------------------------- comfy

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ComfyStatus {
    process_running: bool,
    alive: bool,
    /// Port the app talks to (our process keeps its port until it restarts with a changed config).
    port: u16,
    comfyui_version: Option<String>,
    pytorch_version: Option<String>,
    gpu_name: Option<String>,
    vram_total: u64,
    vram_used: u64,
    has_wav_saver: bool,
    queue_running: usize,
    queue_pending: usize,
    active_song_id: Option<String>,
    /// Tool runs (transcribe / separate / align / plan) from their start (including the ComfyUI start and
    /// the input staging) to their last step (saving the outputs); independent of `alive`.
    tools_in_flight: usize,
    /// The version this app was tested with (setup::COMFYUI_VERSION).
    expected_comfyui_version: String,
    /// The server answers with another ComfyUI version (warning only).
    version_mismatch: bool,
    /// Checked nodes the server lacks (see RuntimeInfo).
    missing_nodes: Vec<String>,
    has_status_node: bool,
    /// Our ComfyUI process runs with --fp32-vae.
    vae_fp32_active: bool,
    /// Our ComfyUI process was started with other launch settings (VAE precision, port, data root)
    /// than the config asks for; it restarts once idle.
    restart_required: bool,
}

#[tauri::command]
async fn comfy_status(state: State<'_, AppState>) -> CmdResult<ComfyStatus> {
    let proc_fp32 = comfy_vae_fp32(&state);
    let process_running = proc_fp32.is_some();
    let restart_required = comfy_restart_pending(&state);
    let port = state.effective_comfy_port();
    let client = state.client();
    let stats = client.system_stats().await.ok();
    // A server that does not answer /system_stats is not asked for its queue (each call would wait
    // for its own timeout).
    let (qr, qp) = if stats.is_some() { client.queue_state().await.unwrap_or((0, 0)) } else { (0, 0) };
    let dev = stats.as_ref().and_then(|s| s.devices.first().cloned());
    let version = stats.as_ref().and_then(|s| s.system.get("comfyui_version")).and_then(|v| v.as_str()).map(|s| s.to_string());
    let rt = state.runtime.read().clone();
    Ok(ComfyStatus {
        process_running,
        alive: stats.is_some(),
        port,
        version_mismatch: version.as_deref().map(|v| v.trim_start_matches('v') != setup::COMFYUI_VERSION).unwrap_or(false),
        expected_comfyui_version: setup::COMFYUI_VERSION.to_string(),
        missing_nodes: if stats.is_some() { rt.missing_nodes.clone() } else { Vec::new() },
        has_status_node: rt.status_input.is_some(),
        vae_fp32_active: proc_fp32.unwrap_or(false),
        restart_required,
        comfyui_version: version,
        pytorch_version: stats.as_ref().and_then(|s| s.system.get("pytorch_version")).and_then(|v| v.as_str()).map(|s| s.to_string()),
        gpu_name: dev.as_ref().map(|d| d.name.clone()),
        vram_total: dev.as_ref().map(|d| d.vram_total).unwrap_or(0),
        vram_used: dev.as_ref().map(|d| d.vram_total.saturating_sub(d.vram_free)).unwrap_or(0),
        has_wav_saver: state.has_wav_saver.load(Ordering::Relaxed),
        queue_running: qr,
        queue_pending: qp,
        active_song_id: state.jobs.active_song_id(),
        tools_in_flight: state.tools_in_flight.load(Ordering::SeqCst),
    })
}

/// Error of ensure_comfy_running_cancellable when its caller was cancelled while waiting.
pub const COMFY_WAIT_CANCELLED: &str = "キャンセルしました";

/// Start ComfyUI (if not already reachable) and wait until it answers. While a restart for changed
/// launch settings is in progress it first waits for that: the old process may still hold the port.
pub async fn ensure_comfy_running(app: &AppHandle) -> Result<()> {
    ensure_comfy_running_cancellable(app, &|| false).await
}

/// ensure_comfy_running for a caller that can be cancelled while it waits (the job worker passes its
/// cancel flag, so a cancel during 「ComfyUI を起動中」 ends the job within a second instead of after
/// the up-to-240 s start). When `cancelled()` turns true the caller stops waiting with
/// COMFY_WAIT_CANCELLED. The ComfyUI process is NOT stopped (a tool run or the next job may wait on the
/// same start), and a restart in progress (comfy_restarting) is not aborted: only the wait for it ends.
pub async fn ensure_comfy_running_cancellable(app: &AppHandle, cancelled: &(dyn Fn() -> bool + Send + Sync)) -> Result<()> {
    let state = app.state::<AppState>();
    while state.comfy_restarting.load(Ordering::SeqCst) {
        if cancelled() {
            bail!(COMFY_WAIT_CANCELLED);
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    if cancelled() {
        bail!(COMFY_WAIT_CANCELLED);
    }
    start_comfy(app, cancelled).await
}

async fn start_comfy(app: &AppHandle, cancelled: &(dyn Fn() -> bool + Send + Sync)) -> Result<()> {
    let state = app.state::<AppState>();
    // Our own process (even one started with an older config) is talked to on its own port.
    let client = state.client();
    if client.is_alive().await {
        after_up(app).await;
        return Ok(());
    }
    {
        // comfy_spawn (not `comfy`) is held across the refresh and the spawn: client() keeps working.
        let _spawning = state.comfy_spawn.lock();
        let running = state.comfy.lock().as_mut().map(|p| p.alive()).unwrap_or(false);
        if !running {
            let cfg = state.config.read().clone();
            // Refresh the bundled node pack before every start (cheap) so updates propagate. A failed
            // refresh keeps the installed copy, which usually still works: log it for the diagnosis.
            if let Err(e) = setup::install_node_pack(app, &cfg) {
                log::warn!("node pack refresh failed, starting ComfyUI with the installed custom_nodes/mcs_yue2_nodes: {e:#}");
            }
            let spawned = ComfyProcess::spawn(&cfg)?;
            *state.comfy.lock() = Some(spawned);
        }
    }
    // Re-read: a process spawned just now listens on the configured port.
    let client = state.client();
    let started = std::time::Instant::now();
    loop {
        if client.is_alive().await {
            break;
        }
        let dead_log = {
            let mut g = state.comfy.lock();
            match g.as_mut() {
                Some(p) => if p.alive() { None } else { Some(p.log_path.clone()) },
                None => Some(config::log_dir().join("comfyui.log")),
            }
        };
        if let Some(log) = dead_log {
            return Err(anyhow!("ComfyUI プロセスが終了しました。ログを確認してください: {}", log.display()));
        }
        if started.elapsed().as_secs() > 240 {
            return Err(anyhow!("ComfyUI が 240 秒以内に応答しませんでした"));
        }
        if cancelled() {
            // The process keeps starting; the next ensure_comfy_running waits for it again.
            bail!(COMFY_WAIT_CANCELLED);
        }
        tokio::time::sleep(std::time::Duration::from_millis(750)).await;
    }
    after_up(app).await;
    Ok(())
}

/// Refresh what the running server offers (runs on every ensure_comfy_running, so an already
/// running server — e.g. an orphan left by a crash — is probed too), make sure a WS relay listens on
/// the port in use, and prune stale staged inputs / leftover outputs at most once per
/// UPLOAD_CLEANUP_INTERVAL.
#[derive(Debug, PartialEq, Eq)]
enum RelayAction {
    Keep,
    /// Retire the old relay (if any) and start a new one with a fresh token.
    Replace,
}

/// The WS relay for `port`: `current` is the running relay's (port, token still live). Only a live relay on
/// the same port is kept.
fn relay_action(current: Option<(u16, bool)>, port: u16) -> RelayAction {
    match current {
        Some((p, true)) if p == port => RelayAction::Keep,
        _ => RelayAction::Replace,
    }
}

async fn after_up(app: &AppHandle) {
    let state = app.state::<AppState>();
    let client = state.client();
    let wav = client.has_node("MCS_SaveAudioWav").await;
    state.has_wav_saver.store(wav, Ordering::Relaxed);
    let version = client.system_stats().await.ok().and_then(|s| s.system.get("comfyui_version").and_then(|v| v.as_str()).map(|s| s.to_string()));
    let mut missing: Vec<String> = Vec::new();
    for n in REQUIRED_YUE2_NODES {
        if !client.has_node(n).await {
            missing.push(n.to_string());
        }
    }
    if !wav {
        missing.push("MCS_SaveAudioWav".into());
    }
    let status_input = client.object_info("MCS_YuE2Status").await.ok().and_then(|i| conditioning_input_name(&i));
    if status_input.is_none() {
        missing.push("MCS_YuE2Status".into());
    }
    if let Some(v) = version.as_deref() {
        if v.trim_start_matches('v') != setup::COMFYUI_VERSION {
            log::warn!("ComfyUI {v} is running; this app is tested with v{}", setup::COMFYUI_VERSION);
        }
    }
    *state.runtime.write() = RuntimeInfo { comfyui_version: version, missing_nodes: missing, status_input };
    // One relay per port in use: a missing or retired relay, or one on another port, is replaced.
    let port = state.effective_comfy_port();
    let new_token = {
        let mut relay = state.ws_relay.lock();
        match relay_action(relay.as_ref().map(|(p, token)| (*p, token.load(Ordering::SeqCst))), port) {
            RelayAction::Keep => None,
            RelayAction::Replace => {
                if let Some((_, old)) = relay.take() {
                    old.store(false, Ordering::SeqCst);
                }
                let token = Arc::new(AtomicBool::new(true));
                *relay = Some((port, token.clone()));
                Some(token)
            }
        }
    };
    if let Some(token) = new_token {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move { comfy::ws::relay(handle, port, token).await });
    }
    // Periodic prune of staged inputs (each distinct content is a full copy, so a long session piles them
    // up). Only while nothing is queued; a copy in use always has a fresh mtime (stage_local refreshes it,
    // also when it reuses a copy), so a tool staging right now keeps its input. The caller's own tool run
    // counts in tools_in_flight (ensure_comfy runs before it stages), hence `<= 1`.
    // The same pass removes outputs ComfyUI wrote for our generations and separations
    // (comfy_output/mcs, comfy_output/mcs_sep) that were copied into the library long ago: a backstop
    // for copies not removed right after their download (older builds, crashes, failed downloads).
    let now = unix_now();
    let last = state.uploads_cleaned_at.load(Ordering::SeqCst);
    if now.saturating_sub(last) >= UPLOAD_CLEANUP_INTERVAL.as_secs()
        && state.tools_in_flight.load(Ordering::SeqCst) <= 1
        && matches!(client.queue_ids().await, Ok(ids) if ids.is_empty())
        && state.uploads_cleaned_at.compare_exchange(last, now, Ordering::SeqCst, Ordering::SeqCst).is_ok()
    {
        let (dir, out, songs) = (comfy_input_dir_in_use(&state), comfy_output_dir_in_use(&state), state.config.read().output_dir.clone());
        let (removed, outputs) = tokio::task::spawn_blocking(move || prune_comfy_folders(&dir, &out, &songs, UPLOAD_MAX_AGE, OUTPUT_MAX_AGE)).await.unwrap_or((0, 0));
        if removed > 0 {
            log::info!("removed {removed} staged input(s) older than {} h", UPLOAD_MAX_AGE.as_secs() / 3600);
        }
        if outputs > 0 {
            log::info!("removed {outputs} ComfyUI output file(s) older than {} h", OUTPUT_MAX_AGE.as_secs() / 3600);
        }
    }
}

/// How often staged inputs are pruned, and the age at which a staged copy is removed.
const UPLOAD_CLEANUP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(3600);
const UPLOAD_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(6 * 3600);
/// Age at which a leftover generation / separation output in comfy_output is removed.
const OUTPUT_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(24 * 3600);

/// The periodic prune of staged inputs (comfy_input/mcs_uploads) and leftover outputs (cleanup_comfy_outputs).
/// The song folder (楽曲の保存先) is never entered when it is one of these folders or a folder in them: the
/// diagnostic bundles and exports at its top are the user's (the uninstaller keeps such a folder too). Those in
/// comfy_output and mcs_uploads stay after the song folder moved elsewhere as well: only our own output names
/// (cleanup_comfy_outputs) and staged copies (comfy::client::cleanup_uploads) are pruned there.
fn prune_comfy_folders(comfy_input: &Path, comfy_output: &Path, song_folder: &Path, upload_age: std::time::Duration, output_age: std::time::Duration) -> (usize, usize) {
    // Resolved once (letter case, `..`, links): on an offline network share each look can take the connect timeout,
    // and this pass runs before generations and tool runs. One that cannot be resolved (missing, unreachable) is none
    // of the comfy folders, which are on this PC.
    let song_folder = if song_folder.is_absolute() { std::fs::canonicalize(song_folder).ok() } else { None };
    let song_folder = song_folder.as_deref();
    let uploads = if is_resolved_folder(&comfy_input.join(comfy::client::UPLOAD_SUBFOLDER), song_folder) { 0 } else { comfy::client::cleanup_uploads(comfy_input, upload_age) };
    (uploads, cleanup_comfy_outputs(comfy_output, song_folder, output_age))
}

/// `dir` resolves to `resolved` (a canonical path; None matches nothing).
fn is_resolved_folder(dir: &Path, resolved: Option<&Path>) -> bool {
    resolved.is_some_and(|r| std::fs::canonicalize(dir).is_ok_and(|d| d == r))
}

/// A name ComfyUI's save nodes give our graphs' outputs: `<prefix>_<counter, 5+ digits>_.flac` / `.wav`, the prefix
/// being an 8-hex id (generation "mcs/<song id8>", separation "mcs_sep/<run id8>_vocals" / "_instrumental";
/// jobs::run_one, tools::separation_prefix). Anything else in those folders is someone else's: an export or a
/// diagnostic bundle saved there while the folder was (or was in) the song folder, whatever it is now. The
/// uninstaller holds a copy of this rule (hooks.nsh McsIsOutputName; checked by the_uninstallers_name_rules_are_the_apps
/// with tools/uninstall_name_cases.txt): change both together.
fn is_comfy_output_name(name: &str) -> bool {
    let Some(base) = name.strip_suffix("_.flac").or_else(|| name.strip_suffix("_.wav")) else { return false };
    let Some((head, counter)) = base.rsplit_once('_') else { return false };
    let id = head.strip_suffix("_vocals").or_else(|| head.strip_suffix("_instrumental")).unwrap_or(head);
    counter.len() >= 5 && counter.bytes().all(|b| b.is_ascii_digit()) && id.len() == 8 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Remove our outputs (is_comfy_output_name) older than `max_age` under the sub-folders our workflows write to
/// (comfy::client::OUTPUT_SUBFOLDERS: comfy_output/mcs and comfy_output/mcs_sep, one level of sub-folders
/// deep; the same list the per-run delete uses). Other files, files directly in comfy_output and other
/// sub-folders are never touched, nor is the song folder (`song_folder`, resolved) when it is one of the folders walked.
fn cleanup_comfy_outputs(output_dir: &Path, song_folder: Option<&Path>, max_age: std::time::Duration) -> usize {
    fn walk(dir: &Path, depth: u32, song_folder: Option<&Path>, now: std::time::SystemTime, max_age: std::time::Duration, removed: &mut usize) {
        if is_resolved_folder(dir, song_folder) {
            return;
        }
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let Ok(meta) = e.metadata() else { continue };
            if meta.is_dir() {
                if depth > 0 {
                    walk(&e.path(), depth - 1, song_folder, now, max_age, removed);
                }
                continue;
            }
            let ours = meta.is_file() && is_comfy_output_name(&e.file_name().to_string_lossy());
            let old = ours && meta.modified().ok().and_then(|t| now.duration_since(t).ok()).is_some_and(|age| age > max_age);
            if old && std::fs::remove_file(e.path()).is_ok() {
                *removed += 1;
            }
        }
    }
    let now = std::time::SystemTime::now();
    let mut removed = 0;
    for sub in comfy::client::OUTPUT_SUBFOLDERS {
        walk(&output_dir.join(sub), 1, song_folder, now, max_age, &mut removed);
    }
    removed
}

fn unix_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// `--fp32-vae` of the ComfyUI process this app owns (None when it runs a server it did not start).
pub fn comfy_vae_fp32(state: &AppState) -> Option<bool> {
    state.comfy.lock().as_mut().and_then(|p| if p.alive() { Some(p.vae_fp32) } else { None })
}

/// Input folder of the running ComfyUI: ours keeps the one it was launched with until it is restarted
/// (a data-root change saved while it is busy is a deferred restart); otherwise the configured one.
/// Files staged for LoadAudio must go here, not to a newly configured folder the server does not read.
pub fn comfy_input_dir_in_use(state: &AppState) -> PathBuf {
    let own = state.comfy.lock().as_mut().and_then(|p| if p.alive() { p.input_dir() } else { None });
    own.unwrap_or_else(|| state.config.read().comfy_input_dir())
}

/// Output folder of the running ComfyUI (see comfy_input_dir_in_use).
pub fn comfy_output_dir_in_use(state: &AppState) -> PathBuf {
    let own = state.comfy.lock().as_mut().and_then(|p| if p.alive() { p.output_dir() } else { None });
    own.unwrap_or_else(|| state.config.read().comfy_output_dir())
}

/// Our ComfyUI runs with other launch settings (VAE precision, port, data root) than the config asks for.
pub fn comfy_restart_pending(state: &AppState) -> bool {
    let cfg = state.config.read().clone();
    let mut g = state.comfy.lock();
    g.as_mut().is_some_and(|p| p.alive() && !p.matches(&cfg))
}

/// Restart our own ComfyUI when it was launched with other settings than the config asks for (VAE
/// precision, port, data root). Only when it is idle: nothing queued in ComfyUI, no tool run in flight
/// and (unless called by the job about to run) no active generation. Returns true when it restarted.
pub async fn restart_comfy_if_stale(app: &AppHandle, from_job: bool) -> Result<bool> {
    let state = app.state::<AppState>();
    if !comfy_restart_pending(&state) || (!from_job && state.generation_busy()) {
        return Ok(false);
    }
    let Some(_claim) = claim_restart(&state.comfy_restarting, &state.tools_in_flight) else { return Ok(false) };
    restart_claimed(app).await
}

/// Holds comfy_restarting for one restart of our ComfyUI; released when dropped.
struct RestartClaim<'a>(&'a AtomicBool);

impl Drop for RestartClaim<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Claim the restart first, then check for tool runs (both SeqCst): a tool run counts itself
/// (tools::InFlight) before it asks for ComfyUI, and ensure_comfy_running waits while a claim is held. So
/// either the tool sees the claim and waits, or this sees the tool and backs off. None when another restart
/// holds the claim or a tool run is in flight (then the claim taken here is released again).
fn claim_restart<'a>(restarting: &'a AtomicBool, tools_in_flight: &AtomicUsize) -> Option<RestartClaim<'a>> {
    restarting.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).ok()?;
    let claim = RestartClaim(restarting);
    if tools_in_flight.load(Ordering::SeqCst) > 0 {
        return None;
    }
    Some(claim)
}

/// A restart put off because ComfyUI was busy (save_config during a generation or a tool run) is tried
/// again when the last tool run or the last queued generation has finished, instead of waiting for the
/// next generation. restart_comfy_if_stale re-checks that nothing uses ComfyUI.
pub fn retry_deferred_restart(app: &AppHandle) {
    if !comfy_restart_pending(&app.state::<AppState>()) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = restart_comfy_if_stale(&app, false).await {
            log::warn!("deferred ComfyUI restart failed: {e:#}");
        }
    });
}

/// The restart itself, under the claim (claim_restart already found no tool run).
async fn restart_claimed(app: &AppHandle) -> Result<bool> {
    let state = app.state::<AppState>();
    // While our process lives, client() talks to ITS port (not a newly configured one), so the idle
    // check and the wait for the port to be released below ask the right server.
    let old = state.client();
    let (running, pending) = old.queue_state().await.unwrap_or((1, 0));
    if running + pending > 0 {
        return Ok(false);
    }
    let cfg = state.config.read().clone();
    let proc = state.take_comfy();
    if let Some(p) = &proc {
        log::info!("restarting ComfyUI for changed launch settings (port {} -> {}, fp32_vae {} -> {})", p.port, cfg.comfy_port, p.vae_fp32, cfg.vae_fp32);
    }
    // The relay of the old process ends; after_up starts one for the new process.
    state.retire_ws_relay();
    if let Some(mut p) = proc {
        tokio::task::spawn_blocking(move || p.stop()).await.ok();
    }
    // Don't spawn while something still answers on the old port (a new process on the same port
    // would fail to bind).
    let stopped = std::time::Instant::now();
    while old.is_alive().await && stopped.elapsed().as_secs() < 15 {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    start_comfy(app, &|| false).await?;
    Ok(true)
}

#[tauri::command]
async fn comfy_start(app: AppHandle) -> CmdResult<()> {
    ensure_comfy_running(&app).await.map_err(|e| format!("{e:#}"))
}

/// Stops our own ComfyUI. Refused while a generation or a tool run uses it (the worker would start it
/// again right away and the job would end as an error), and for a server this app did not start
/// (nothing it could stop).
#[tauri::command]
async fn comfy_stop(state: State<'_, AppState>) -> CmdResult<()> {
    if state.generation_busy() || state.tools_in_flight.load(Ordering::SeqCst) > 0 {
        return Err("生成・ツールの実行中は停止できません。先にキャンセルしてください。".into());
    }
    let proc = state.take_comfy();
    match proc {
        Some(mut p) => {
            state.retire_ws_relay();
            tokio::task::spawn_blocking(move || p.stop()).await.map_err(err)?;
            Ok(())
        }
        None if state.client().is_alive().await => Err(
            "このアプリが起動していない ComfyUI のため停止できません（前回の異常終了で残ったプロセスか、別のアプリの ComfyUI です）。タスク マネージャーで終了するか、設定でポートを変更してください".into(),
        ),
        None => Ok(()),
    }
}

#[tauri::command]
async fn comfy_free_vram(state: State<'_, AppState>) -> CmdResult<()> {
    state.client().free(true).await.map_err(err)
}

// ---------------------------------------------------------------- generation / library

#[tauri::command]
fn generate(app: AppHandle, state: State<AppState>, params: GenerateParams) -> CmdResult<Song> {
    if params.mode == "off" && !params.abc.trim().is_empty() {
        return Err("Off モードでは譜面を指定できません".into());
    }
    let limit = state.config.read().max_duration_limit.min(config::MAX_DURATION_CAP) as f64;
    if params.max_duration < 8.0 || params.max_duration > limit {
        return Err(format!("曲長は 8〜{limit} 秒の範囲で指定してください"));
    }
    // Seeds pass through JavaScript numbers: above 2^53-1 they would silently change.
    if params.seed > MAX_SAFE_SEED {
        return Err(format!("シード値は 0 以上 {MAX_SAFE_SEED} 以下の整数で指定してください"));
    }
    state.jobs.submit(app, params).map_err(|e| format!("{e:#}"))
}

/// Number.MAX_SAFE_INTEGER: the largest seed the UI can send without rounding.
pub const MAX_SAFE_SEED: u64 = (1u64 << 53) - 1;

#[tauri::command]
fn cancel_job(app: AppHandle, state: State<AppState>, song_id: String, queued_only: Option<bool>) -> CmdResult<()> {
    state.jobs.cancel(&app, &song_id, queued_only.unwrap_or(false)).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn list_songs(state: State<AppState>, limit: Option<usize>) -> CmdResult<Vec<Song>> {
    state.db.lock().list(limit.unwrap_or(500)).map_err(err)
}

#[tauri::command]
fn rename_song(state: State<AppState>, id: String, title: String) -> CmdResult<()> {
    state.db.lock().set_title(&id, &title).map_err(err)
}

/// A song folder delete_song left on disk, and why: the library words its notice by case.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeptFolder {
    pub path: String,
    /// Its drive or network share cannot be reached now (else it was not confirmed as this song's folder).
    pub unreachable: bool,
}

impl KeptFolder {
    fn new(folder: &Path, unreachable: bool) -> Self {
        KeptFolder { path: folder.to_string_lossy().to_string(), unreachable }
    }
}

impl std::fmt::Display for KeptFolder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.path)?;
        if self.unreachable {
            f.write_str(" (drive or share not reachable)")?;
        }
        Ok(())
    }
}

/// Remove a song from the library (and its folder when `delete_files`). The song being generated is
/// refused (its job would write the folder again); a queued one is taken out of the queue first.
/// Returns the folder that was kept because it could not be confirmed as this song's folder or its drive
/// cannot be reached (None when it was deleted, was already gone, was never made because the song was deleted
/// before it started, or files were not to be deleted). A song whose job ended before its folder was made has no
/// folder in its row (jobs.rs mark_ended), so nothing is reported for it either.
#[tauri::command]
async fn delete_song(app: AppHandle, state: State<'_, AppState>, id: String, delete_files: bool) -> CmdResult<Option<KeptFolder>> {
    const RUNNING: &str = "生成中の曲は削除できません。先にキャンセルしてください";
    if state.jobs.active_song_id().as_deref() == Some(id.as_str()) {
        return Err(RUNNING.into());
    }
    let song = state.db.lock().get(&id).map_err(err)?;
    let Some(s) = song else { return Ok(None) };
    let mut never_started = false;
    if matches!(s.status.as_str(), "queued" | "running") {
        // Still waiting: drop it from the queue so the worker never starts it (not-found is fine).
        let dequeued = state.jobs.cancel(&app, &id, false).is_ok();
        // The worker took it in the meantime: cancel() flagged it, but its folder is still being written.
        if state.jobs.active_song_id().as_deref() == Some(id.as_str()) {
            return Err(format!("{RUNNING}（キャンセルを要求しました）"));
        }
        // Taken out of the queue here (cancel() succeeded and it is not the active job): its folder was never made.
        never_started = dequeued && s.status == "queued";
    }
    let kept = if delete_files && !s.folder.is_empty() {
        let out_dir = state.config.read().output_dir.clone();
        let (folder, sid) = (PathBuf::from(&s.folder), s.id.clone());
        tokio::task::spawn_blocking(move || remove_deleted_song_folder(&folder, &sid, &out_dir, never_started)).await.map_err(err)?.map_err(err)?
    } else {
        None
    };
    state.db.lock().delete(&id).map_err(err)?;
    Ok(kept)
}

/// remove_song_folder for delete_song. `never_started`: this delete took the song out of the queue, so its job never
/// made the folder (the row only holds the planned path). A missing folder is then nothing to report, also on a
/// drive that cannot be reached now, where a folder never made looks the same as one kept there. One that exists
/// after all (the worker took the song just before) is deleted as usual.
fn remove_deleted_song_folder(folder: &Path, song_id: &str, output_dir: &Path, never_started: bool) -> std::io::Result<Option<KeptFolder>> {
    if never_started && !folder.exists() {
        return Ok(None);
    }
    remove_song_folder(folder, song_id, output_dir)
}

/// The song folder or something in it is held open without delete sharing (ERROR_SHARING_VIOLATION): a player, a
/// terminal or app whose current directory it is, or the app's own 書き出し (ffmpeg reading song.wav).
const SONG_FOLDER_IN_USE: &str = "曲フォルダかその中のファイルが使用中のため削除できませんでした（プレイヤーやターミナルで開いている、書き出し中など）。閉じるか完了してから、もう一度削除してください";

/// Delete a song folder when it is this app's folder for this song: strictly inside the current
/// output folder, or (for songs saved before the output folder was changed) laid out the way jobs.rs
/// creates it — `<YYYY-MM-DD>\<HHMMSS>_<first 8 chars of the id>` holding song.json or
/// workflow_api.json. An emptied date folder is removed too. Ok(Some(kept)) = kept (not confirmed, or on a
/// drive / network share that cannot be reached now). A file in it held open by another app stops the
/// delete before anything is removed.
fn remove_song_folder(folder: &Path, song_id: &str, output_dir: &Path) -> std::io::Result<Option<KeptFolder>> {
    if !folder.exists() {
        // An unplugged drive or an offline share looks the same as a deleted folder: only a folder whose drive
        // (or share) answers is gone; the other one is kept.
        if !folder.ancestors().last().is_some_and(|root| root.is_dir()) {
            return Ok(Some(KeptFolder::new(folder, true)));
        }
        return Ok(None);
    }
    let owned = folder.is_dir() && (path_strictly_under(output_dir, folder) || is_song_folder_layout(folder, song_id));
    if !owned {
        return Ok(Some(KeptFolder::new(folder, false)));
    }
    // remove_dir_all would stop at such a file or folder with the folder half emptied (lyrics, score, song.json gone).
    // Checked entry by entry before; one opened in between still stops remove_dir_all as before.
    if let Some((locked, in_use)) = first_locked_file(folder) {
        let msg = if in_use { SONG_FOLDER_IN_USE } else { "曲フォルダかその中のファイルにアクセスできないため削除できませんでした（他のアプリが使用中か、削除する権限がありません）" };
        return Err(std::io::Error::other(format!("{msg}: {}", locked.display())));
    }
    std::fs::remove_dir_all(folder)?;
    if let Some(parent) = folder.parent() {
        if parent.file_name().and_then(|n| n.to_str()).is_some_and(is_date_folder_name) {
            let _ = std::fs::remove_dir(parent); // fails harmlessly while other songs remain
        }
    }
    Ok(None)
}

/// The first entry of `dir` (`dir` itself, its folders and files) that cannot be opened for deletion, and whether
/// another app holds it open without delete sharing (a player or the export's ffmpeg on a file; a terminal or app
/// whose current directory a folder is; else access was denied: no delete right, or a delete still pending).
/// remove_dir_all needs the same access to each of them. A reader that shares delete access does not count.
/// Symbolic links and junctions are not followed.
#[cfg(windows)]
fn first_locked_file(dir: &Path) -> Option<(PathBuf, bool)> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION};
    use windows_sys::Win32::Storage::FileSystem::{DELETE, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE};
    let locked = |p: &Path| {
        // BACKUP_SEMANTICS opens a folder too; OPEN_REPARSE_POINT opens a link itself, not its target.
        let open = std::fs::OpenOptions::new()
            .access_mode(DELETE)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(p);
        match open.err().and_then(|err| err.raw_os_error()) {
            Some(c) if c == ERROR_SHARING_VIOLATION as i32 => Some((p.to_path_buf(), true)),
            Some(c) if c == ERROR_ACCESS_DENIED as i32 => Some((p.to_path_buf(), false)),
            _ => None,
        }
    };
    if let Some(f) = locked(dir) {
        return Some(f);
    }
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let Ok(kind) = e.file_type() else { continue };
        let p = e.path();
        let found = if kind.is_dir() {
            first_locked_file(&p)
        } else if kind.is_file() {
            locked(&p)
        } else {
            None
        };
        if found.is_some() {
            return found;
        }
    }
    None
}

#[cfg(not(windows))]
fn first_locked_file(_dir: &Path) -> Option<(PathBuf, bool)> {
    None
}

fn is_date_folder_name(n: &str) -> bool {
    n.len() == 10 && chrono::NaiveDate::parse_from_str(n, "%Y-%m-%d").is_ok()
}

/// `HHMMSS_<8 chars>` (jobs.rs song folders).
fn is_song_folder_name(n: &str) -> bool {
    let b = n.as_bytes();
    n.len() == 15 && b[..6].iter().all(|c| c.is_ascii_digit()) && b[6] == b'_' && b[7..].iter().all(|c| c.is_ascii_alphanumeric() || *c == b'-')
}

/// The folder has the layout jobs.rs gives a song folder, for this song id when one is given.
fn is_song_folder_layout(folder: &Path, song_id: &str) -> bool {
    let Some(name) = folder.file_name().and_then(|n| n.to_str()) else { return false };
    let id_ok = song_id.is_empty() || song_id.get(..8).is_some_and(|p| name.ends_with(&format!("_{p}")));
    let date_ok = folder.parent().and_then(|p| p.file_name()).and_then(|n| n.to_str()).is_some_and(is_date_folder_name);
    is_song_folder_name(name) && id_ok && date_ok && (folder.join("song.json").is_file() || folder.join("workflow_api.json").is_file())
}

/// `path` resolves (canonically, so `..`, letter case and `\\?\` do not matter) to an existing entry
/// under one of `roots`. Empty or relative roots are ignored; a path that cannot be resolved is not
/// under any root.
pub fn path_under_roots(roots: &[PathBuf], path: &Path) -> bool {
    let Ok(target) = std::fs::canonicalize(path) else { return false };
    roots
        .iter()
        .filter(|r| !r.as_os_str().is_empty() && r.is_absolute())
        .filter_map(|r| std::fs::canonicalize(r).ok())
        .any(|r| target.starts_with(&r))
}

/// Like path_under_roots for one root, but the root itself does not count.
fn path_strictly_under(root: &Path, path: &Path) -> bool {
    match (std::fs::canonicalize(root), std::fs::canonicalize(path)) {
        (Ok(r), Ok(t)) => root.is_absolute() && t != r && t.starts_with(&r),
        _ => false,
    }
}

fn has_extension(p: &Path, exts: &[&str]) -> bool {
    p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).is_some_and(|e| exts.contains(&e.as_str()))
}

/// Media types mcs:// serves for a file handed out by file_url.
const SERVABLE_EXTENSIONS: [&str; 12] = ["wav", "flac", "mp3", "m4a", "ogg", "oga", "opus", "aac", "png", "jpg", "jpeg", "webp"];

/// Record an existing audio / image file for mcs:// (canonical path). Other paths are not recorded.
fn register_served(state: &AppState, p: &Path) {
    if !p.is_absolute() || !has_extension(p, &SERVABLE_EXTENSIONS) {
        return;
    }
    let Ok(canon) = std::fs::canonicalize(p) else { return };
    if !std::fs::metadata(&canon).map(|m| m.is_file()).unwrap_or(false) {
        return;
    }
    state.served.lock().insert(canon);
}

#[tauri::command]
fn estimate_duration(lyrics: String) -> f64 {
    workflow::estimate_seconds(&lyrics)
}

/// The mcs:// URL of a local file. Audio and image files the UI asks for are registered, so the player
/// can load user-picked sources, export results and songs saved under an earlier output folder. Off the
/// UI thread: registering resolves the path on disk (a sleeping or offline drive would freeze the window).
#[tauri::command(async)]
fn file_url(state: State<AppState>, path: String) -> String {
    let p = PathBuf::from(&path);
    register_served(&state, &p);
    // Built from the path as given: the canonical form carries a \\?\ prefix.
    protocol::file_url(&p)
}

/// song.json of a library song (Export page). JSON files only, under the output folder / data root, or
/// in a song folder laid out by jobs.rs (a song saved before the output folder was changed). Off the UI
/// thread, like file_url.
#[tauri::command(async)]
fn read_text_file(state: State<AppState>, path: String) -> CmdResult<String> {
    let p = PathBuf::from(&path);
    if !text_file_allowed(&state, &p) {
        return Err("許可されていないパスです".into());
    }
    std::fs::read_to_string(&p).map_err(err)
}

fn text_file_allowed(state: &AppState, p: &Path) -> bool {
    if !p.is_absolute() || !has_extension(p, &["json"]) {
        return false;
    }
    let roots = {
        let cfg = state.config.read();
        vec![cfg.output_dir.clone(), cfg.data_root.clone()]
    };
    path_under_roots(&roots, p) || is_song_json(p)
}

/// `<YYYY-MM-DD>\<HHMMSS>_<id8>\song.json` (resolved, so `..` cannot fake the layout).
fn is_song_json(p: &Path) -> bool {
    let Ok(c) = std::fs::canonicalize(p) else { return false };
    c.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.eq_ignore_ascii_case("song.json")) && c.parent().is_some_and(|f| is_song_folder_layout(f, ""))
}

/// Largest file read_binary_file returns. The bytes travel as a JSON number array, so this is meant
/// for small user-chosen files (MIDI / ABC import), not a general binary channel.
const MAX_BINARY_READ: u64 = 8 * 1024 * 1024;

fn user_file_path(path: &str) -> CmdResult<PathBuf> {
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err("ファイルの場所（絶対パス）を指定してください".into());
    }
    Ok(p)
}

/// Read a user-chosen MIDI / ABC / text file (open dialog) as bytes.
#[tauri::command(async)]
fn read_binary_file(path: String) -> CmdResult<Vec<u8>> {
    let p = user_file_path(&path)?;
    if !has_extension(&p, &["mid", "midi", "abc", "txt"]) {
        return Err("読み込めるのは MIDI（.mid / .midi）と ABC（.abc / .txt）のファイルだけです".into());
    }
    let meta = std::fs::metadata(&p).map_err(err)?;
    if meta.len() > MAX_BINARY_READ {
        return Err("ファイルが大きすぎます (8MB 上限)".into());
    }
    std::fs::read(&p).map_err(err)
}

/// `p` itself when its extension is one of `exts`, otherwise `p` with `.{ext}` appended (a name typed
/// as "score.txt" in the MIDI save dialog becomes "score.txt.mid"): the write commands only ever create
/// files of their own type, without refusing a name the user typed.
fn with_required_extension(p: PathBuf, exts: &[&str], ext: &str) -> PathBuf {
    if has_extension(&p, exts) {
        return p;
    }
    let mut s = p.into_os_string();
    s.push(".");
    s.push(ext);
    PathBuf::from(s)
}

/// Write a MIDI file to a user-chosen path (save dialog). Returns the path written (see
/// with_required_extension).
#[tauri::command(async)]
fn write_binary_file(path: String, data: Vec<u8>) -> CmdResult<String> {
    let p = with_required_extension(user_file_path(&path)?, &["mid", "midi"], "mid");
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(err)?;
    }
    std::fs::write(&p, data).map_err(err)?;
    Ok(p.to_string_lossy().to_string())
}

/// Write an ABC score to a user-chosen path (save dialog). Returns the path written.
#[tauri::command(async)]
fn write_text_file(path: String, text: String) -> CmdResult<String> {
    let p = with_required_extension(user_file_path(&path)?, &["abc"], "abc");
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(err)?;
    }
    std::fs::write(&p, text).map_err(err)?;
    Ok(p.to_string_lossy().to_string())
}

#[derive(Debug, PartialEq)]
enum RevealTarget {
    /// Open its folder with the file selected.
    File(PathBuf),
    /// Open this folder (the path itself, or its nearest existing parent).
    Dir(PathBuf),
}

/// What reveal_path shows for `path`: only absolute local paths (URLs, `shell:` and other handlers
/// are refused); a missing file or folder falls back to its nearest existing parent folder (e.g. the
/// log folder before comfyui.log exists).
fn reveal_target(path: &str) -> CmdResult<RevealTarget> {
    let p = PathBuf::from(path.trim());
    if !p.is_absolute() {
        return Err(format!("フォルダを開けません（ファイルの場所ではありません）: {path}"));
    }
    if p.is_file() {
        return Ok(RevealTarget::File(p));
    }
    if p.is_dir() {
        return Ok(RevealTarget::Dir(p));
    }
    p.ancestors().skip(1).find(|a| a.is_dir()).map(|a| RevealTarget::Dir(a.to_path_buf())).ok_or_else(|| format!("フォルダが見つかりません: {path}"))
}

#[tauri::command]
async fn reveal_path(path: String) -> CmdResult<()> {
    tokio::task::spawn_blocking(move || match reveal_target(&path)? {
        // SHOpenFolderAndSelectItems: no Explorer command-line parsing (spaces, commas, quotes).
        RevealTarget::File(p) => tauri_plugin_opener::reveal_item_in_dir(&p).map_err(|e| format!("フォルダを開けませんでした: {e}")),
        // ShellExecuteW as well: `explorer <dir>` would split a folder name at a comma.
        RevealTarget::Dir(p) => tauri_plugin_opener::open_path(&p, None::<&str>).map_err(|e| format!("フォルダを開けませんでした: {e}")),
    })
    .await
    .map_err(err)?
}

// ---------------------------------------------------------------- tools (cover / separation)

/// Cancel a tool run (transcribe / separate / align / plan) by the prompt_id its "tool://progress"
/// events carry: the flag makes tools::run_prompt end with 「キャンセルしました」 (its final event is
/// stage キャンセル without an error); the prompt itself is dropped from ComfyUI's queue or interrupted
/// right away. Only this prompt is interrupted, never a generation.
#[tauri::command]
async fn cancel_tool(state: State<'_, AppState>, prompt_id: String) -> CmdResult<()> {
    let id = prompt_id.trim().to_string();
    if id.is_empty() {
        return Err("キャンセルする処理が指定されていません".into());
    }
    let known = state.tool_cancels.lock().cancel(&id, std::time::Instant::now());
    log::info!("tool run {id} cancelled (registered: {known})");
    let client = state.client();
    if let Err(e) = client.delete_pending(std::slice::from_ref(&id)).await {
        log::info!("dropping the cancelled tool prompt from the queue failed: {e:#}");
    }
    if let Err(e) = client.interrupt(Some(&id)).await {
        log::info!("interrupting the cancelled tool prompt failed: {e:#}");
    }
    state.last_progress.lock().retain(|(p, _), _| p != &id);
    Ok(())
}

/// Transcribe `path` into an ABC score. Like every tool command (separate_audio, align_lyrics,
/// plan_score), it takes an optional `run_id` that all of the run's tool://progress events carry
/// (tools::Run), so a page can tell its own run from another page's run of the same tool.
#[tauri::command]
async fn transcribe_audio(app: AppHandle, path: String, mode: String, run_id: Option<String>) -> CmdResult<String> {
    let m = if mode == "full" { "full" } else { "melody" };
    tools::transcribe(&app, &PathBuf::from(path), m, run_id.as_deref()).await.map_err(|e| format!("{e:#}"))
}

/// Folder-name part taken from a source file name: Windows-forbidden characters and control
/// characters become '_', surrounding spaces and trailing dots are removed (Win32 would strip them
/// from the created folder but not from the paths written into it), at most 60 characters (Unicode is
/// kept), "audio" when nothing is left.
fn separation_folder_name(stem: &str) -> String {
    let replaced: String = stem.chars().map(|c| if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') { '_' } else { c }).collect();
    let capped: String = replaced.trim().chars().take(60).collect();
    let cleaned = capped.trim_start().trim_end_matches([' ', '.']).to_string();
    if cleaned.is_empty() {
        "audio".into()
    } else {
        cleaned
    }
}

/// Where separate_audio saves the stems. A library song: <song folder>\separated, or
/// <song folder>\separated\align for `align` (automatic lyric timing: the stems only serve the alignment
/// and must not replace the ones the user made on the separation page). Another file: a new
/// <output_dir>\separated\<timestamp>_<name>, or for `align` the one reusable folder `align_dir` (each
/// automatic timing of a file outside the library replaces the previous one's stems instead of adding a
/// folder per run).
fn separation_out_dir(song_folder: Option<&str>, src: &Path, output_dir: &Path, align_dir: &Path, align: bool, now: &chrono::DateTime<chrono::Local>) -> PathBuf {
    match song_folder.filter(|f| !f.is_empty()) {
        Some(folder) if align => PathBuf::from(folder).join("separated").join("align"),
        Some(folder) => PathBuf::from(folder).join("separated"),
        None if align => align_dir.to_path_buf(),
        None => {
            let stem = separation_folder_name(&src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default());
            output_dir.join("separated").join(format!("{}_{}", now.format("%Y%m%d_%H%M%S"), stem))
        }
    }
}

/// Separate `path` into vocals / instrumental (see separation_out_dir for the folder). `purpose`
/// "align" marks a separation made only for automatic lyric timing (optional; anything else is a
/// normal separation). A missing source ends like every other failure, with a 失敗 tool event. A library
/// song deleted while it is separated gets no stems (separation_song_deleted), and its run ends with a neutral
/// 中止 tool event (no error text; the call still returns why).
#[tauri::command]
async fn separate_audio(app: AppHandle, state: State<'_, AppState>, path: String, model: String, song_id: Option<String>, purpose: Option<String>, run_id: Option<String>) -> CmdResult<tools::SeparationResult> {
    let src = PathBuf::from(&path);
    let song_folder = song_id.as_deref().and_then(|id| state.db.lock().get(id).ok().flatten()).map(|s| s.folder);
    let align = purpose.as_deref() == Some("align");
    let (output_dir, align_dir) = {
        let cfg = state.config.read();
        (cfg.output_dir.clone(), cfg.cache_dir().join("align_stems"))
    };
    let out_dir = separation_out_dir(song_folder.as_deref(), &src, &output_dir, &align_dir, align, &chrono::Local::now());
    let song_gone = || separation_song_deleted(song_id.as_deref(), song_folder.as_deref(), |id| state.db.lock().get(id).map(|s| s.is_some()));
    tools::separate(&app, &src, &model, &out_dir, run_id.as_deref(), &song_gone).await.map_err(|e| format!("{e:#}"))
}

/// Whether the library song a separation saves into was deleted meanwhile: its row is gone, and the stems
/// would bring its folder back with nothing in the library pointing at it. Only the row counts (`row_exists`):
/// a song whose folder is missing or on a drive that cannot be reached now is still in the library, and
/// creating the stems' folder then fails with a message naming it. delete_song drops the row right after the
/// folder, so a delete during the run is still seen once the stems are downloaded (tools::save_stems).
fn separation_song_deleted(song_id: Option<&str>, song_folder: Option<&str>, row_exists: impl FnOnce(&str) -> Result<bool>) -> bool {
    match (song_id, song_folder) {
        (Some(id), Some(folder)) if !folder.is_empty() => matches!(row_exists(id), Ok(false)),
        _ => false,
    }
}

#[tauri::command]
async fn align_lyrics(app: AppHandle, path: String, lyrics: String, language: String, run_id: Option<String>) -> CmdResult<Vec<tools::AlignedLine>> {
    let lang = match language.as_str() { "ja" | "en" | "zh" => language.clone(), _ => "other".into() };
    tools::align_lyrics(&app, &PathBuf::from(path), &lyrics, &lang, run_id.as_deref()).await.map_err(|e| format!("{e:#}"))
}

/// ABC plan only (no audio), for the instrumental one-button flow. The caller's `seed` is used and is
/// required (the argument stays optional for compatibility; none is an error); `abc_temperature`
/// defaults to the official planner default 0.7. A plan that used the whole token budget fails at once
/// (tools::plan_score), there is no retry with other seeds.
#[tauri::command]
async fn plan_score(app: AppHandle, style: String, lyrics: String, mode: String, seed: Option<u64>, abc_temperature: Option<f64>, run_id: Option<String>) -> CmdResult<String> {
    if seed.is_some_and(|s| s > MAX_SAFE_SEED) {
        return Err(format!("シード値は 0 以上 {MAX_SAFE_SEED} 以下の整数で指定してください"));
    }
    let t = abc_temperature.filter(|t| t.is_finite()).map(|t| t.clamp(0.0, 5.0));
    tools::plan_score(&app, &style, &lyrics, &mode, seed, t.unwrap_or(0.7), run_id.as_deref()).await.map_err(|e| format!("{e:#}"))
}

/// Zip logs, config (no secrets), system info and recent failed jobs for bug reports.
#[tauri::command]
/// Always written into the song folder under a fixed name pattern: the webview cannot pick the path. When the
/// song folder is unavailable (unplugged drive) it goes to the log folder; the returned path says where.
async fn create_diagnostic_bundle(app: AppHandle, state: State<'_, AppState>) -> CmdResult<String> {
    let cfg = state.config.read().clone();
    let version = app.package_info().version.to_string();
    let failed = bundle_failed_jobs(state.db.lock().list(200).map_err(err)?);
    let path = cfg.output_dir.join(format!("mcs-diagnostics-{}.zip", chrono::Local::now().format("%Y%m%d-%H%M%S")));
    let out = tokio::task::spawn_blocking(move || diagnostics::create_bundle(&cfg, &path, &version, failed)).await.map_err(err)?.map_err(|e| format!("{e:#}"))?;
    Ok(out.to_string_lossy().to_string())
}

/// The failed jobs a diagnostic bundle carries, as (song folder, error): the newest 3 error rows of `songs` (newest
/// first, as Db::list gives them). A run that failed before its song folder was made (the ComfyUI start, a missing node
/// or checkpoint, a save folder that cannot be written: what a bug report needs most) has no folder in its row (jobs.rs
/// mark_ended) and still counts; diagnostics::write_zip adds only its error.txt then.
fn bundle_failed_jobs(songs: Vec<Song>) -> Vec<(String, String)> {
    songs.into_iter().filter(|s| s.status == "error").take(3).map(|s| (s.folder, s.error)).collect()
}

#[tauri::command]
/// Must list the node pack's SEPARATION_MODELS (comfy-nodes/mcs_yue2_nodes/nodes.py) in the same order; the
/// first one is the node's default (test `separation_models_match_node_pack`).
fn separation_models() -> Vec<&'static str> {
    vec![
        "model_bs_roformer_ep_317_sdr_12.9755.ckpt",
        "model_bs_roformer_ep_368_sdr_12.9628.ckpt",
        "vocals_mel_band_roformer.ckpt",
        "melband_roformer_big_beta4.ckpt",
        "htdemucs_ft.yaml",
    ]
}

// ---------------------------------------------------------------- llm

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LlmStatus {
    provider: String,
    process_running: bool,
    alive: bool,
    port: u16,
    model: Option<String>,
    has_anthropic_key: bool,
    has_openai_key: bool,
    local_models: Vec<String>,
    /// A llama-server answers on the port but this app did not start it (it cannot stop it).
    external: bool,
    /// Our llama-server runs with other settings than the config; the next AI request restarts it.
    restart_required: bool,
    /// Origin (scheme://host:port) the stored OpenAI key is sent to; None until its first use. A Base
    /// URL with another origin is refused until the key is entered again.
    openai_key_origin: Option<String>,
}

#[tauri::command]
async fn llm_status(state: State<'_, AppState>) -> CmdResult<LlmStatus> {
    let cfg = state.config.read().clone();
    let (running, model, stale) = {
        let mut g = state.llama.lock();
        match g.as_mut() {
            Some(p) => {
                let alive = p.alive();
                (alive, Some(p.model.clone()), alive && !p.matches(&cfg))
            }
            None => (false, None, false),
        }
    };
    let alive = llm::llama_health(cfg.llm_port).await;
    let secrets = llm::Secrets::load();
    let mut local_models: Vec<String> = std::fs::read_dir(cfg.models_dir().join("llm"))
        .map(|rd| rd.flatten().filter_map(|e| e.file_name().to_str().map(|s| s.to_string())).filter(|n| n.to_lowercase().ends_with(".gguf")).collect())
        .unwrap_or_default();
    local_models.sort();
    Ok(LlmStatus {
        provider: cfg.llm.provider.clone(),
        process_running: running,
        alive,
        port: cfg.llm_port,
        model,
        has_anthropic_key: !secrets.anthropic_api_key.is_empty(),
        has_openai_key: !secrets.openai_api_key.is_empty(),
        local_models,
        external: alive && !running,
        restart_required: stale,
        openai_key_origin: secrets.openai_key_bound_origin().map(|s| s.to_string()),
    })
}

/// Start llama-server (local provider) and wait for /health. Our server started with other settings
/// (model, GPU layers, context size, port) is restarted first. While a generation runs with
/// "unload before generation" on, no server is started (it would take the VRAM the setting frees).
pub async fn ensure_llama_running(app: &AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    let cfg = state.config.read().clone();
    // Every caller (chat requests and llm_start) counts itself in llm_in_flight: a stale server on the same
    // port that serves another request right now keeps serving it, and the next request that finds it idle
    // restarts it (restartRequired stays reported). On another port it has to be replaced now.
    let in_flight = state.llm_in_flight.load(Ordering::SeqCst);
    let stale = {
        let mut g = state.llama.lock();
        let is_stale = g.as_mut().map(|p| llama_restart_needed(p.alive(), p.matches(&cfg), in_flight, p.port, cfg.llm_port)).unwrap_or(false);
        if is_stale {
            g.take()
        } else {
            None
        }
    };
    if let Some(mut p) = stale {
        let old_port = p.port;
        log::info!(
            "llama-server settings changed (model {} ngl {} ctx {} port {}; wanted {}); restarting",
            p.launch.model_path.display(),
            p.launch.gpu_layers,
            p.launch.context_size,
            p.port,
            llm::LlamaLaunch::from_cfg(&cfg).model_path.display()
        );
        tokio::task::spawn_blocking(move || p.stop()).await.ok();
        let stopped = std::time::Instant::now();
        while llm::llama_health(old_port).await && stopped.elapsed().as_secs() < 10 {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
    }
    if llm::llama_health(cfg.llm_port).await {
        return Ok(());
    }
    let llama_alive = state.llama.lock().as_mut().map(|p| p.alive()).unwrap_or(false);
    let blocked_by_generation = || cfg.llm.unload_before_generation && state.generation_busy();
    if !llama_alive {
        // Checked early too, so the /free below is skipped.
        if blocked_by_generation() {
            bail!(LLAMA_BLOCKED_BY_GENERATION);
        }
        free_comfy_for_llm(app).await;
    }
    {
        // Checked again under the lock that stores the process: jobs::run_one marks its job active before it
        // locks `llama` to decide whether to wait, so either the job sees this server (and waits for the
        // requests in flight before stopping it), or this spawn sees the job and is refused.
        let mut g = state.llama.lock();
        let running = g.as_mut().map(|p| p.alive()).unwrap_or(false);
        if !running {
            if blocked_by_generation() {
                bail!(LLAMA_BLOCKED_BY_GENERATION);
            }
            *g = Some(llm::LlamaProcess::spawn(&cfg, &cfg.llm)?);
        }
    }
    let started = std::time::Instant::now();
    loop {
        if llm::llama_health(cfg.llm_port).await {
            return Ok(());
        }
        let dead = state.llama.lock().as_mut().map(|p| !p.alive()).unwrap_or(true);
        if dead {
            // A generation that started meanwhile took the server (unload before generation).
            if blocked_by_generation() {
                bail!(LLAMA_BLOCKED_BY_GENERATION);
            }
            return Err(anyhow!("llama-server が終了しました。ログを確認してください: {}", config::log_dir().join("llama-server.log").display()));
        }
        if started.elapsed().as_secs() > 180 {
            return Err(anyhow!("llama-server が 180 秒以内に応答しませんでした"));
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
}

/// Refusal of a local-LLM start while a generation runs with 「曲の生成前に LLM を停止」 on.
const LLAMA_BLOCKED_BY_GENERATION: &str =
    "曲の生成中はローカル LLM を起動できません。生成の完了後にもう一度お試しいただくか、設定の「曲の生成前に LLM を停止して VRAM を解放する」を無効にしてください";

/// Our llama-server has to be replaced now: it runs with other launch settings, unless another request
/// (`in_flight` counts the caller too) is served by it on the port the config still asks for.
fn llama_restart_needed(alive: bool, matches: bool, in_flight: usize, running_port: u16, wanted_port: u16) -> bool {
    alive && !matches && !(in_flight > 1 && running_port == wanted_port)
}

/// VRAM below which a GPU counts as small: YuE2 BF16 and the local LLM do not both fit. The same
/// threshold as BF16_MIN_VRAM_MIB in src/config/rules.ts (the wizard's INT8 default); keep them equal.
const SMALL_VRAM_MIB: u64 = 20000;

/// On GPUs below SMALL_VRAM_MIB, ask an idle ComfyUI to unload its resident YuE2 models before
/// llama-server allocates VRAM (-ngl 99). /free only sets a flag for ComfyUI's worker, so wait (up to
/// 3 s) until free VRAM stops rising. No-op while anything is queued or a generation is active.
async fn free_comfy_for_llm(app: &AppHandle) {
    let state = app.state::<AppState>();
    let client = state.client();
    let Ok(stats) = client.system_stats().await else { return };
    let Some(dev) = stats.devices.first() else { return };
    if dev.vram_total == 0 || dev.vram_total >= SMALL_VRAM_MIB * 1024 * 1024 {
        return;
    }
    if state.generation_busy() || !matches!(client.queue_state().await, Ok((0, 0))) {
        return;
    }
    if client.free(true).await.is_err() {
        return;
    }
    let mut last = dev.vram_free;
    let started = std::time::Instant::now();
    while started.elapsed() < std::time::Duration::from_secs(3) {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let Some(free) = client.system_stats().await.ok().and_then(|s| s.devices.first().map(|d| d.vram_free)) else { break };
        if free > last {
            last = free;
        } else if free == last && free > dev.vram_free {
            break; // rose and settled
        }
    }
    log::info!("ComfyUI /free before llama-server: free VRAM {} -> {} MiB", dev.vram_free / 1048576, last / 1048576);
}

#[tauri::command]
async fn llm_start(app: AppHandle) -> CmdResult<()> {
    // Counts like a chat request: a request already served by a stale server is not cut off, and a
    // generation that unloads the LLM waits for this start instead of taking the server mid-start.
    let state = app.state::<AppState>();
    let _in_flight = LlmInFlight::new(&state);
    // Under an id of its own (no page cancels it): a page reload ends it like a chat request (cancel_all_llm_requests),
    // so a start the reloaded page no longer waits for does not hold llm_stop back. A server already spawned keeps
    // starting (llm_status shows it); one ended before its spawn is not started at all.
    let id = format!("llm_start-{}", uuid::Uuid::new_v4().simple());
    cancellable_llm(&state.llm_cancels, Some(id), async { ensure_llama_running(&app).await.map_err(|e| format!("{e:#}")) }).await
}

/// Refusal of llm_stop while a local-LLM request waits for its answer.
const LLM_STOP_BUSY: &str = "AI の応答を待っている依頼があります。完了するかキャンセルしてから停止してください";

/// llm_stop is refused while local-LLM requests (`in_flight`: chat requests and starts) are in flight: stopping
/// would cut them off with a generic send error, also another page's (a 作曲 draft while AI 編集 offers the button).
/// Requests a reloaded page left behind do not count long: its load ends them (cancel_all_llm_requests).
fn llm_stop_allowed(in_flight: usize) -> CmdResult<()> {
    if in_flight > 0 {
        return Err(LLM_STOP_BUSY.into());
    }
    Ok(())
}

/// Stops our own llama-server (not while a request is in flight, see llm_stop_allowed); a server this app
/// did not start is reported instead of silently staying up.
#[tauri::command]
async fn llm_stop(state: State<'_, AppState>) -> CmdResult<()> {
    let p = {
        let mut g = state.llama.lock();
        llm_stop_allowed(state.llm_in_flight.load(Ordering::SeqCst))?;
        g.take()
    };
    if let Some(mut p) = p {
        tokio::task::spawn_blocking(move || p.stop()).await.map_err(err)?;
        return Ok(());
    }
    let port = state.config.read().llm_port;
    if llm::llama_health(port).await {
        return Err(format!(
            "このアプリが起動していない llama-server のため停止できません（ポート {port}。前回の異常終了で残ったプロセスか、別のアプリのサーバーです）。タスク マネージャーで終了するか、設定で LLM ポートを変更してください"
        ));
    }
    Ok(())
}

#[tauri::command]
fn save_secrets(anthropic_api_key: Option<String>, openai_api_key: Option<String>) -> CmdResult<()> {
    let mut s = llm::Secrets::load();
    if let Some(k) = anthropic_api_key {
        s.anthropic_api_key = k.trim().to_string();
    }
    if let Some(k) = openai_api_key {
        s.openai_api_key = k.trim().to_string();
        // A key entered (again) binds to the Base URL of its first request.
        s.openai_key_fingerprint.clear();
        s.openai_key_origin.clear();
    }
    s.save().map_err(|e| format!("{e:#}"))
}

/// Some reqwest error in the chain matches `pred` (the error type survives anyhow context).
fn reqwest_error_is(e: &anyhow::Error, pred: impl Fn(&reqwest::Error) -> bool) -> bool {
    e.chain().any(|c| c.downcast_ref::<reqwest::Error>().is_some_and(&pred))
}

/// The connection to the server failed or was cut (not a timeout: a slow reply is not a lost server).
fn connection_lost(r: &reqwest::Error) -> bool {
    (r.is_connect() || r.is_request() || r.is_body()) && !r.is_timeout()
}

/// Our llama-server process exists but has exited.
fn our_llama_died(state: &AppState) -> bool {
    state.llama.lock().as_mut().is_some_and(|p| !p.alive())
}

/// Message for a local request whose server was stopped by a generation starting meanwhile.
const LLM_STOPPED_FOR_GENERATION: &str = "曲の生成を始めるためローカル LLM を停止しました。生成の完了後にもう一度お試しください";

/// What to do after a failed local chat request.
#[derive(Debug, PartialEq, Eq)]
enum LocalChatFailure {
    /// A generation stopped the server (unload before generation): tell the user, restart nothing.
    StoppedForGeneration,
    /// Unreachable after the health check, or cut because our server died: restart it and send once more.
    RestartAndRetry,
    Fail,
}

/// `connect`: the connection could not be made; `lost`: `connection_lost` (made or cut, not a timeout).
/// `our_server_died` is only asked when it decides (it takes the llama lock). The order matters: a connect
/// error during a generation that unloads the LLM must not restart the server.
fn classify_local_chat_error(unload_before_gen: bool, generation_busy: bool, connect: bool, lost: bool, our_server_died: impl FnOnce() -> bool) -> LocalChatFailure {
    if unload_before_gen && generation_busy && lost {
        LocalChatFailure::StoppedForGeneration
    } else if connect || (lost && our_server_died()) {
        LocalChatFailure::RestartAndRetry
    } else {
        LocalChatFailure::Fail
    }
}

/// One chat request on the configured provider. For the local provider llama-server is started
/// first and the request counts in llm_in_flight. When the local server could not be reached (it
/// died or was replaced after the health check) it is restarted and the request sent once more;
/// when a generation stopped it (unload before generation), the user is told so and nothing restarts.
async fn chat_with_local_recovery(app: &AppHandle, cfg: &AppConfig, messages: Vec<llm::ChatMessage>, schema: Option<serde_json::Value>, purpose: llm::ThinkingPurpose) -> CmdResult<llm::ChatResult> {
    let state = app.state::<AppState>();
    let secrets = llm::Secrets::load();
    // a draft's second try (llm::chat_retrying) is announced to the page, which is still waiting
    let on_retry = || {
        let _ = app.emit("llm://retry", LlmRetry { purpose: if purpose == llm::ThinkingPurpose::Draft { "draft" } else { "edit" } });
    };
    if cfg.llm.provider != "local" {
        return llm::chat_retrying(cfg, &cfg.llm, &secrets, messages, schema, purpose, on_retry).await.map_err(|e| format!("{e:#}"));
    }
    let _in_flight = LlmInFlight::new(&state);
    ensure_llama_running(app).await.map_err(|e| format!("{e:#}"))?;
    let e = match llm::chat_retrying(cfg, &cfg.llm, &secrets, messages.clone(), schema.clone(), purpose, on_retry).await {
        Ok(r) => return Ok(r),
        Err(e) => e,
    };
    let connect = reqwest_error_is(&e, |r| r.is_connect());
    let lost = reqwest_error_is(&e, connection_lost);
    match classify_local_chat_error(cfg.llm.unload_before_generation, state.generation_busy(), connect, lost, || our_llama_died(&state)) {
        LocalChatFailure::StoppedForGeneration => {
            log::info!("local LLM request ended by a generation: {e:#}");
            Err(LLM_STOPPED_FOR_GENERATION.into())
        }
        // Unreachable after the health check, or the connection was cut because our server died
        // mid-request (outside a generation, e.g. it crashed): start it again and send once more.
        LocalChatFailure::RestartAndRetry => {
            log::warn!("llama-server unreachable after the health check, restarting: {e:#}");
            let lp = state.llama.lock().take();
            if let Some(mut p) = lp {
                tokio::task::spawn_blocking(move || p.stop()).await.ok();
            }
            ensure_llama_running(app).await.map_err(|e| format!("{e:#}"))?;
            llm::chat_retrying(cfg, &cfg.llm, &secrets, messages, schema, purpose, on_retry).await.map_err(|e| format!("{e:#}"))
        }
        LocalChatFailure::Fail => Err(format!("{e:#}")),
    }
}

/// Payload of "llm://retry": a request is being sent once more (a local draft whose first reply ran to the
/// length limit, without thinking this time).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LlmRetry {
    purpose: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EditReply {
    abc: String,
    style: String,
    lyrics: String,
    explanation: String,
    raw: String,
    prompt_tokens: u64,
    completion_tokens: u64,
    seconds: f64,
    provider: String,
}

/// One agentic-editing turn: context (current score/style/lyrics) + chat history + instruction -> structured edit.
/// The arguments are named fields of the invoke payload (src/api.ts llmEdit), hence no request struct.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn llm_edit(
    app: AppHandle,
    state: State<'_, AppState>,
    abc: String,
    style: String,
    lyrics: String,
    history: Vec<llm::ChatMessage>,
    instruction: String,
    sung_lyrics: Option<String>,
    request_id: Option<String>,
) -> CmdResult<EditReply> {
    let cfg = state.config.read().clone();
    let messages = llm::edit_messages(&abc, &style, &lyrics, sung_lyrics.as_deref(), history, instruction);
    let r = cancellable_llm(&state.llm_cancels, request_id, chat_with_local_recovery(&app, &cfg, messages, Some(llm::edit_schema()), llm::ThinkingPurpose::Edit)).await?;
    let [abc, style, lyrics, explanation] = llm::parse_edit_reply(&r.content)?;
    Ok(EditReply { abc, style, lyrics, explanation, raw: r.content, prompt_tokens: r.prompt_tokens, completion_tokens: r.completion_tokens, seconds: r.seconds, provider: r.provider })
}

/// Generic structured completion (system + user prompt, optional JSON schema) on the configured provider.
/// Used by the songwriting assistant (a draft: short thinking budget); the frontend owns the prompts and parsing.
#[tauri::command]
async fn llm_complete(app: AppHandle, state: State<'_, AppState>, system: String, user: String, schema: Option<serde_json::Value>, request_id: Option<String>) -> CmdResult<llm::ChatResult> {
    let cfg = state.config.read().clone();
    let messages = vec![llm::ChatMessage { role: "system".into(), content: system }, llm::ChatMessage { role: "user".into(), content: user }];
    cancellable_llm(&state.llm_cancels, request_id, chat_with_local_recovery(&app, &cfg, messages, schema, llm::ThinkingPurpose::Draft)).await
}

/// Removes a request's cancel handle when the request ends (any way).
type LlmCancels = Mutex<HashMap<String, Arc<tokio::sync::Notify>>>;

struct LlmCancelEntry<'a>(&'a LlmCancels, String);

impl Drop for LlmCancelEntry<'_> {
    fn drop(&mut self) {
        self.0.lock().remove(&self.1);
    }
}

/// Run an LLM request until it ends or llm_cancel(request_id) fires: the request (the wait for the local server, the
/// HTTP call, the retry) is dropped then, which closes its connection (llama-server abandons the task and frees
/// its slot), and the caller gets COMFY_WAIT_CANCELLED (the text the pages treat as a cancel). The local server
/// itself keeps running or starting, for the next request. Without an id the request cannot be cancelled.
async fn cancellable_llm<T>(cancels: &LlmCancels, request_id: Option<String>, work: impl std::future::Future<Output = CmdResult<T>>) -> CmdResult<T> {
    let Some(id) = request_id.filter(|s| !s.is_empty()) else { return work.await };
    // a cancel that came first left its handle (with the permit stored): the request ends at once
    let notify = cancels.lock().entry(id.clone()).or_insert_with(|| Arc::new(tokio::sync::Notify::new())).clone();
    let _entry = LlmCancelEntry(cancels, id);
    tokio::select! {
        r = work => r,
        _ = notify.notified() => Err(COMFY_WAIT_CANCELLED.into()),
    }
}

/// Cancel the LLM request `request_id` (llm_edit / llm_complete). A cloud provider may still bill a request that
/// was already sent.
#[tauri::command]
fn llm_cancel(state: State<AppState>, request_id: String) {
    cancel_llm_request(&state.llm_cancels, request_id);
}

fn cancel_llm_request(cancels: &LlmCancels, request_id: String) {
    let mut m = cancels.lock();
    // A cancel for a request that already ended leaves a handle nobody holds: such leftovers are dropped here.
    if m.len() > 64 {
        m.retain(|_, n| Arc::strong_count(n) > 1);
    }
    m.entry(request_id).or_insert_with(|| Arc::new(tokio::sync::Notify::new())).notify_one();
}

/// The page was (re)loaded (F5, 再読み込み): every LLM request in flight belongs to the page that is gone, the only
/// one that knew their ids. Left alone they would run on (up to the chat timeout, minutes) with nothing able to
/// cancel them, and llm_stop would be refused until they end. They end as cancelled; the server keeps running.
fn cancel_all_llm_requests(cancels: &LlmCancels) {
    for n in cancels.lock().values() {
        n.notify_one();
    }
}

// ---------------------------------------------------------------- export

#[tauri::command]
async fn export_audio(state: State<'_, AppState>, request: export::ExportRequest) -> CmdResult<export::ExportResult> {
    let cfg = state.config.read().clone();
    // Counted until ffmpeg is done: the close guard asks before quitting mid-export.
    let _export = Counted::new(&state.exports_in_flight);
    let dests = state.export_dests.clone();
    tokio::task::spawn_blocking(move || export::run_export(&cfg, &request, &dests)).await.map_err(err)?.map_err(|e| format!("{e:#}"))
}

/// ffprobe (or ffmpeg) runs off the UI thread; the config is cloned so no lock is held meanwhile.
#[tauri::command]
async fn audio_duration(state: State<'_, AppState>, path: String) -> CmdResult<Option<f64>> {
    let cfg = state.config.read().clone();
    let p = PathBuf::from(path);
    tokio::task::spawn_blocking(move || export::probe_duration(&cfg, &p)).await.map_err(err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioPeaks {
    /// One channel (the largest absolute sample over all channels per bucket, 0..1), the form
    /// WaveSurfer's load(url, peaks, duration) takes.
    peaks: Vec<Vec<f32>>,
    /// Seconds.
    duration: f64,
}

/// Waveform overview of a local audio file, so the player need not fetch and decode the whole file.
/// The same paths as mcs:// are allowed (an audio file the UI asks for is registered like file_url).
#[tauri::command]
async fn audio_peaks(state: State<'_, AppState>, path: String, buckets: Option<usize>) -> CmdResult<AudioPeaks> {
    let p = PathBuf::from(&path);
    register_served(&state, &p);
    if !p.is_absolute() || !protocol::allowed(&state, &p) {
        return Err("許可されていないパスです".into());
    }
    let n = buckets.unwrap_or(2000).clamp(64, 16384);
    let cfg = state.config.read().clone();
    let (peaks, duration) = tokio::task::spawn_blocking(move || peaks::compute(&cfg, &p, n)).await.map_err(err)?.map_err(|e| format!("{e:#}"))?;
    Ok(AudioPeaks { peaks: vec![peaks], duration })
}

/// Waveform peaks: WAV files are read in chunks, other formats are decoded by the bundled ffmpeg into
/// a mono f32 stream; neither is held in memory as a whole.
mod peaks {
    use crate::config::AppConfig;
    use anyhow::{anyhow, bail, Context, Result};
    use std::io::{Read, Seek, SeekFrom};
    use std::path::Path;

    /// Sample format of a WAV data chunk.
    #[derive(Debug, Clone, Copy, PartialEq)]
    pub struct WavFormat {
        pub float: bool,
        pub channels: u16,
        pub sample_rate: u32,
        pub bits: u16,
    }

    /// More channels than any real mix uses: a header claiming more is damaged or crafted (the frame
    /// size would get absurd), so it goes to ffmpeg, which fails cleanly.
    pub const MAX_WAV_CHANNELS: u16 = 64;
    /// Read buffer of wav_peaks, in bytes (whole frames, at least one).
    const READ_BYTES: usize = 4 * 1024 * 1024;

    /// (format, data offset, data length) of a RIFF/WAVE file.
    pub fn wav_layout<R: Read + Seek>(r: &mut R, file_len: u64) -> Result<(WavFormat, u64, u64)> {
        let mut head = [0u8; 12];
        r.read_exact(&mut head)?;
        if &head[0..4] != b"RIFF" || &head[8..12] != b"WAVE" {
            bail!("WAV ファイルではありません");
        }
        let mut fmt: Option<WavFormat> = None;
        let mut pos = 12u64;
        loop {
            let mut ch = [0u8; 8];
            if r.read_exact(&mut ch).is_err() {
                bail!("WAV の data チャンクが見つかりません");
            }
            let size = u32::from_le_bytes([ch[4], ch[5], ch[6], ch[7]]) as u64;
            let body = pos + 8;
            match &ch[0..4] {
                b"fmt " => {
                    let mut f = vec![0u8; size.min(64) as usize];
                    r.read_exact(&mut f)?;
                    if f.len() < 16 {
                        bail!("WAV の fmt チャンクが不正です");
                    }
                    let tag = u16::from_le_bytes([f[0], f[1]]);
                    // WAVE_FORMAT_EXTENSIBLE: the sub-format GUID starts with the real tag.
                    let tag = if tag == 0xFFFE && f.len() >= 26 { u16::from_le_bytes([f[24], f[25]]) } else { tag };
                    let format = WavFormat { float: tag == 3, channels: u16::from_le_bytes([f[2], f[3]]), sample_rate: u32::from_le_bytes([f[4], f[5], f[6], f[7]]), bits: u16::from_le_bytes([f[14], f[15]]) };
                    if !(tag == 1 || tag == 3) || format.channels == 0 || format.channels > MAX_WAV_CHANNELS || format.sample_rate == 0 || !matches!((format.float, format.bits), (false, 8 | 16 | 24 | 32) | (true, 32 | 64)) {
                        bail!("対応していない WAV 形式です");
                    }
                    fmt = Some(format);
                }
                b"data" => {
                    let fmt = fmt.ok_or_else(|| anyhow!("WAV の fmt チャンクが data の前にありません"))?;
                    // Streaming writers leave 0 or 0xFFFFFFFF: the data then runs to the end of the file.
                    let avail = file_len.saturating_sub(body);
                    let len = if size == 0 || size == 0xFFFF_FFFF { avail } else { size.min(avail) };
                    return Ok((fmt, body, len));
                }
                _ => {}
            }
            pos = body + size + (size & 1);
            r.seek(SeekFrom::Start(pos))?;
        }
    }

    /// Absolute value of one sample (0..1).
    fn sample(fmt: &WavFormat, b: &[u8]) -> f32 {
        match (fmt.float, fmt.bits) {
            (true, 32) => f32::from_le_bytes([b[0], b[1], b[2], b[3]]).abs(),
            (true, 64) => f64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]).abs() as f32,
            (false, 8) => ((b[0] as f32 - 128.0) / 128.0).abs(),
            (false, 16) => (i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0).abs(),
            (false, 24) => ((i32::from_le_bytes([0, b[0], b[1], b[2]]) >> 8) as f32 / 8388608.0).abs(),
            _ => (i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f32 / 2147483648.0).abs(),
        }
    }

    /// Peaks of a WAV stream: max |sample| over all channels per bucket (`n` buckets or fewer frames).
    pub fn wav_peaks<R: Read + Seek>(r: &mut R, file_len: u64, n: usize) -> Result<(Vec<f32>, f64)> {
        let (fmt, offset, len) = wav_layout(r, file_len)?;
        let bps = (fmt.bits / 8) as usize;
        let frame = bps * fmt.channels as usize;
        let frames = len / frame as u64;
        let duration = frames as f64 / fmt.sample_rate as f64;
        let buckets = (n as u64).min(frames.max(1)) as usize;
        let mut peaks = vec![0f32; buckets];
        if frames == 0 {
            return Ok((peaks, duration));
        }
        r.seek(SeekFrom::Start(offset))?;
        let chunk_frames = (READ_BYTES / frame).max(1);
        let mut buf = vec![0u8; chunk_frames * frame];
        let mut done: u64 = 0;
        while done < frames {
            let want = ((frames - done) as usize).min(chunk_frames);
            let bytes = &mut buf[..want * frame];
            r.read_exact(bytes).context("WAV の読み込みに失敗しました")?;
            for (i, f) in bytes.chunks_exact(frame).enumerate() {
                let idx = (((done + i as u64) as u128 * buckets as u128) / frames as u128) as usize;
                let m = f.chunks_exact(bps).map(|s| sample(&fmt, s)).fold(0f32, f32::max);
                if m > peaks[idx] {
                    peaks[idx] = m.min(1.0);
                }
            }
            done += want as u64;
        }
        Ok((peaks, duration))
    }

    /// Reduce a fine peak series to `n` buckets (max per bucket).
    pub fn downsample(fine: &[f32], n: usize) -> Vec<f32> {
        if fine.is_empty() {
            return vec![0.0];
        }
        let buckets = n.min(fine.len()).max(1);
        let mut out = vec![0f32; buckets];
        for (i, v) in fine.iter().enumerate() {
            let idx = i * buckets / fine.len();
            if *v > out[idx] {
                out[idx] = *v;
            }
        }
        out
    }

    /// Decode any format with ffmpeg to mono 8 kHz f32 and collect peaks per 10 ms.
    fn ffmpeg_peaks(cfg: &AppConfig, src: &Path, n: usize) -> Result<(Vec<f32>, f64)> {
        const RATE: usize = 8000;
        const STEP: usize = RATE / 100;
        let ffmpeg = cfg.ffmpeg_exe().ok_or_else(|| anyhow!("ffmpeg が見つかりません（セットアップで導入してください）"))?;
        let mut cmd = std::process::Command::new(ffmpeg);
        cmd.args(["-v", "error", "-nostdin", "-i"]).arg(src).args(["-vn", "-ac", "1", "-ar", "8000", "-f", "f32le", "-"]).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let mut child = cmd.spawn().context("ffmpeg の起動に失敗しました")?;
        let mut out = child.stdout.take().ok_or_else(|| anyhow!("ffmpeg の出力を読めません"))?;
        let mut fine: Vec<f32> = Vec::new();
        let (mut cur, mut in_step, mut samples) = (0f32, 0usize, 0u64);
        let mut buf = vec![0u8; 64 * 1024];
        let mut carry: Vec<u8> = Vec::new();
        loop {
            let k = out.read(&mut buf)?;
            if k == 0 {
                break;
            }
            carry.extend_from_slice(&buf[..k]);
            let whole = carry.len() / 4 * 4;
            for s in carry[..whole].chunks_exact(4) {
                cur = cur.max(f32::from_le_bytes([s[0], s[1], s[2], s[3]]).abs().min(1.0));
                in_step += 1;
                samples += 1;
                if in_step == STEP {
                    fine.push(cur);
                    cur = 0.0;
                    in_step = 0;
                }
            }
            carry.drain(..whole);
        }
        if in_step > 0 {
            fine.push(cur);
        }
        let status = child.wait()?;
        if !status.success() && samples == 0 {
            bail!("音声をデコードできませんでした");
        }
        Ok((downsample(&fine, n), samples as f64 / RATE as f64))
    }

    pub fn compute(cfg: &AppConfig, src: &Path, n: usize) -> Result<(Vec<f32>, f64)> {
        let is_wav = src.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("wav"));
        if is_wav {
            let mut f = std::io::BufReader::new(std::fs::File::open(src).context("音声ファイルを開けません")?);
            let len = std::fs::metadata(src)?.len();
            match wav_peaks(&mut f, len, n) {
                Ok(r) => return Ok(r),
                Err(e) => log::info!("WAV peaks fell back to ffmpeg for {}: {e:#}", src.display()),
            }
        }
        ffmpeg_peaks(cfg, src, n)
    }
}

// ---------------------------------------------------------------- app lifecycle

/// What still runs when the window is asked to close (empty = nothing, close right away).
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
struct CloseRequest {
    generating: bool,
    /// Title of the song being generated (None when none is, or its row could not be read).
    active_title: Option<String>,
    /// Songs waiting in the queue (they are not generated after an exit).
    queued: usize,
    tools: usize,
    /// export_audio runs.
    exports: usize,
    setup: bool,
    /// Japanese summary for the confirm dialog.
    message: String,
    /// Japanese note for the dialog: closing again right away quits without asking (close_is_repeated).
    hint: String,
}

/// A second close request within this time after one was held back quits without the dialog.
const FORCE_CLOSE_WINDOW: std::time::Duration = std::time::Duration::from_secs(10);

/// The close guard held the window back less than FORCE_CLOSE_WINDOW ago: this close goes through.
fn close_is_repeated(last_blocked: Option<std::time::Instant>, now: std::time::Instant) -> bool {
    last_blocked.is_some_and(|t| now.saturating_duration_since(t) <= FORCE_CLOSE_WINDOW)
}

fn close_request(state: &AppState) -> Option<CloseRequest> {
    let active = state.jobs.active_song_id();
    let active_title = active.and_then(|id| state.db.lock().get(&id).ok().flatten()).map(|s| s.title).filter(|t| !t.trim().is_empty());
    let generating = state.generation_busy();
    let queued = state.jobs.queued_count();
    let tools = state.tools_in_flight.load(Ordering::SeqCst);
    let exports = state.exports_in_flight.load(Ordering::SeqCst);
    let setup = state.setup_running.load(Ordering::SeqCst);
    close_request_for(generating, active_title, queued, tools, exports, setup)
}

fn close_request_for(generating: bool, active_title: Option<String>, queued: usize, tools: usize, exports: usize, setup: bool) -> Option<CloseRequest> {
    let mut what: Vec<&str> = Vec::new();
    // Songs still queued count as generation work too (the worker takes the next one at once).
    if generating || queued > 0 {
        what.push("曲の生成");
    }
    if tools > 0 {
        what.push("音声の処理（転写・分離・歌詞の整列・譜面の計画）");
    }
    if exports > 0 {
        what.push("書き出し");
    }
    if setup {
        what.push("セットアップ");
    }
    if what.is_empty() {
        return None;
    }
    let queued_note = if queued > 0 { "（待機中の曲も生成されません）" } else { "" };
    Some(CloseRequest {
        generating,
        active_title: if generating { active_title } else { None },
        queued,
        tools,
        exports,
        setup,
        message: format!("{}が実行中です。終了すると中断されます{queued_note}。終了しますか？", what.join("・")),
        hint: format!("{} 秒以内にもう一度ウィンドウを閉じると、確認せずに終了します。", FORCE_CLOSE_WINDOW.as_secs()),
    })
}

/// Quit after the user confirmed closing during work (the "app://close-requested" dialog). A running
/// setup is asked to stop first; RunEvent::Exit stops ComfyUI and llama-server as on a normal exit.
#[tauri::command]
fn app_exit(app: AppHandle, state: State<AppState>) {
    confirm_exit(&state);
    app.exit(0);
}

/// Quitting is confirmed (app_exit, or a repeated close): a running setup is asked to stop and the
/// close guard lets the window go.
fn confirm_exit(state: &AppState) {
    if state.setup_running.load(Ordering::SeqCst) {
        state.setup_cancel.store(true, Ordering::SeqCst);
    }
    state.exit_confirmed.store(true, Ordering::SeqCst);
}

/// The library DB could not be opened before any window exists: log it, tell the user in a message
/// box, and for a corrupt file offer to move it aside (only when they choose so). Returns the DB to run
/// with, or None to quit.
fn db_open_failed(e: &anyhow::Error) -> Option<Db> {
    let dir = config::app_data_dir();
    let path = dir.join("library.db");
    log::error!("library db open failed ({}): {e:#}", path.display());
    open_app_log(false);
    let log = config::log_dir().join("app.log");
    if db_error_is_corruption(e) {
        let text = format!(
            "ライブラリ（曲の一覧）のデータベースを開けませんでした。ファイルが壊れている可能性があります。\n\n{}\n{e:#}\n\n[はい] を押すと、このファイルを「library.db.corrupt-日時」に退避して空のライブラリで起動します（曲のフォルダはそのまま残ります）。[いいえ] を押すと終了します。\n\nログ: {}",
            path.display(),
            log.display()
        );
        if message_box(&text, true) {
            let moved = move_db_aside(&dir, &chrono::Local::now().format("%Y%m%d-%H%M%S").to_string());
            log::warn!("moved the library db aside: {moved:?}");
            match Db::open() {
                Ok(db) => return Some(db),
                Err(e2) => {
                    log::error!("library db open failed again: {e2:#}");
                    message_box(&format!("新しいライブラリも作成できませんでした。\n\n{}\n{e2:#}\n\nログ: {}", path.display(), log.display()), false);
                }
            }
        }
        return None;
    }
    message_box(
        &format!(
            "ライブラリ（曲の一覧）のデータベースを開けませんでした。\n\n{}\n{e:#}\n\nこのアプリがほかに起動していないか、フォルダーへの書き込み権限とディスクの空き容量を確認してから、もう一度起動してください。\n\nログ: {}",
            path.display(),
            log.display()
        ),
        false,
    );
    None
}

/// SQLite reports the file itself as broken (not a transient lock, permission or disk problem).
fn db_error_is_corruption(e: &anyhow::Error) -> bool {
    e.chain().any(|c| c.downcast_ref::<rusqlite::Error>().and_then(|r| r.sqlite_error_code()).is_some_and(|code| matches!(code, rusqlite::ErrorCode::NotADatabase | rusqlite::ErrorCode::DatabaseCorrupt)))
}

/// Rename library.db and its -wal / -shm files to *.corrupt-<ts>. Returns the new paths.
fn move_db_aside(dir: &Path, ts: &str) -> Vec<PathBuf> {
    let mut moved = Vec::new();
    for name in ["library.db", "library.db-wal", "library.db-shm"] {
        let from = dir.join(name);
        if from.exists() {
            let to = dir.join(format!("{name}.corrupt-{ts}"));
            if std::fs::rename(&from, &to).is_ok() {
                moved.push(to);
            }
        }
    }
    moved
}

/// tauri.conf.json's identifier: tauri-plugin-single-instance names its mutex `<identifier>-sim`.
const APP_IDENTIFIER: &str = "com.utausnskareshi.musiccreatorstudioyue2";

/// The single-instance mutex exists but cannot be opened the way the plugin creates it (MUTEX_ALL_ACCESS): an
/// instance started with other rights runs, typically 「管理者として実行」 seen from a normal launch. The plugin
/// takes that error for "no other instance" and would let this launch run its crash recovery over the running
/// instance's queue (run() stops it instead). A missing mutex, or one opened fully, is left to the plugin.
#[cfg(windows)]
fn single_instance_mutex_inaccessible(name: &str) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ACCESS_DENIED};
    use windows_sys::Win32::System::Threading::{OpenMutexW, MUTEX_ALL_ACCESS};
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let h = unsafe { OpenMutexW(MUTEX_ALL_ACCESS, 0, wide.as_ptr()) };
    if !h.is_null() {
        unsafe { CloseHandle(h) };
        return false;
    }
    unsafe { GetLastError() == ERROR_ACCESS_DENIED }
}

/// A blocking error box (no window exists yet). `yes_no`: returns true for [はい].
fn message_box(text: &str, yes_no: bool) -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, IDYES, MB_ICONERROR, MB_OK, MB_YESNO};
        let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
        let (t, c) = (wide(text), wide("Music Creator Studio YuE2"));
        let r = unsafe { MessageBoxW(std::ptr::null_mut(), t.as_ptr(), c.as_ptr(), MB_ICONERROR | if yes_no { MB_YESNO } else { MB_OK }) };
        r == IDYES
    }
    #[cfg(not(windows))]
    {
        eprintln!("{text}");
        false
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Log to stderr and to logs/app.log (opened in setup, see LogSink).
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).target(env_logger::Target::Pipe(Box::new(TeeWriter))).init();
    // panic = "abort" in release and no console: without this a panic leaves no trace anywhere.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!("panic: {info}\n{}", std::backtrace::Backtrace::force_capture());
        open_app_log(false);
        default_hook(info);
    }));

    // The single-instance plugin cannot see an instance started with other rights (elevated): stop before
    // anything is loaded or recovered.
    #[cfg(windows)]
    if single_instance_mutex_inaccessible(&format!("{APP_IDENTIFIER}-sim")) {
        log::warn!("another instance runs with other rights (elevated?): not starting a second one");
        message_box(
            "Music Creator Studio YuE2 は既に起動しています（管理者として実行中の可能性があります）。起動中のウィンドウを使うか、閉じてからもう一度起動してください。",
            false,
        );
        return;
    }

    let config = AppConfig::load();
    // A broken secrets.json is moved aside on its first load: done now, so its notice is shown at startup.
    let _ = llm::Secrets::load();
    // Opening is side-effect free (idempotent migrations); the crash recovery runs in setup, after the
    // single-instance gate.
    let db = match Db::open() {
        Ok(db) => db,
        Err(e) => match db_open_failed(&e) {
            Some(db) => db,
            None => return,
        },
    };

    let mut builder = tauri::Builder::default();
    // First plugin: a second launch focuses the running window and exits before it touches anything.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }));
    }
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            config: RwLock::new(config),
            comfy: Mutex::new(None),
            ws_relay: Mutex::new(None),
            db: Mutex::new(db),
            jobs: Arc::new(jobs::JobManager::default()),
            setup_cancel: Arc::new(AtomicBool::new(false)),
            setup_running: AtomicBool::new(false),
            has_wav_saver: AtomicBool::new(false),
            llama: Mutex::new(None),
            last_progress: Mutex::new(Default::default()),
            runtime: RwLock::new(RuntimeInfo::default()),
            uploads_cleaned_at: AtomicU64::new(0),
            tools_in_flight: AtomicUsize::new(0),
            exports_in_flight: AtomicUsize::new(0),
            export_dests: Arc::default(),
            comfy_restarting: AtomicBool::new(false),
            served: Mutex::new(ServedFiles::default()),
            config_save: tokio::sync::Mutex::new(()),
            llm_in_flight: AtomicUsize::new(0),
            exit_confirmed: AtomicBool::new(false),
            close_blocked_at: Mutex::new(None),
            comfy_spawn: Mutex::new(()),
            tool_cancels: Mutex::new(ToolCancels::default()),
            llm_cancels: Mutex::new(HashMap::new()),
        })
        .register_asynchronous_uri_scheme_protocol("mcs", protocol::handle)
        .invoke_handler(tauri::generate_handler![
            get_config,
            take_startup_notices,
            save_config,
            app_paths,
            system_check,
            data_root_check,
            setup_status,
            setup_install,
            setup_cancel,
            setup_finalize,
            comfy_status,
            comfy_start,
            comfy_stop,
            comfy_free_vram,
            generate,
            cancel_job,
            list_songs,
            rename_song,
            delete_song,
            estimate_duration,
            file_url,
            read_text_file,
            read_binary_file,
            write_binary_file,
            write_text_file,
            reveal_path,
            transcribe_audio,
            separate_audio,
            separation_models,
            align_lyrics,
            export_audio,
            audio_duration,
            audio_peaks,
            llm_status,
            llm_start,
            llm_stop,
            save_secrets,
            llm_edit,
            plan_score,
            create_diagnostic_bundle,
            llm_complete,
            llm_cancel,
            app_exit,
            cancel_tool,
        ])
        .on_page_load(|webview, payload| {
            // A reload (F5, 再読み込み) leaves the old page's LLM requests without anyone to cancel them: end them.
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                cancel_all_llm_requests(&webview.state::<AppState>().llm_cancels);
            }
        })
        .on_window_event(|window, event| {
            // Closing during a generation, a tool run, an export or setup would silently throw the work away: keep
            // the window and let the frontend confirm (it calls app_exit on yes). Fail-safe: a second
            // close within FORCE_CLOSE_WINDOW goes through, so the window can always be closed even when
            // no dialog answers (setup screen, hung WebView). The last window closing ends the app, and
            // RunEvent::Exit stops ComfyUI and llama-server as usual.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                if state.exit_confirmed.load(Ordering::SeqCst) {
                    return;
                }
                if let Some(req) = close_request(&state) {
                    let now = std::time::Instant::now();
                    let repeated = {
                        let mut last = state.close_blocked_at.lock();
                        let repeated = close_is_repeated(*last, now);
                        if !repeated {
                            *last = Some(now);
                        }
                        repeated
                    };
                    if repeated {
                        log::warn!("window closed again while work runs (generating {}, tools {}, exports {}, setup {}): quitting without the dialog", req.generating, req.tools, req.exports, req.setup);
                        confirm_exit(&state);
                        return;
                    }
                    api.prevent_close();
                    let _ = window.emit("app://close-requested", req);
                }
            }
        })
        .setup(|app| {
            // Past the single-instance gate: this is the only instance.
            open_app_log(true);
            // Jobs left queued/running by a previous run (crash, forced exit) are marked interrupted.
            let recovered = app.state::<AppState>().db.lock().recover();
            if let Err(e) = recovered {
                log::warn!("marking interrupted jobs failed: {e:#}");
            }
            // No idle sleep while a generation, a tool run, an export or the setup runs.
            let handle = app.handle().clone();
            power::keep_awake_while(move || keep_awake_needed(&handle.state::<AppState>()));
            // Developer self-test: MCS_AUTOTEST=1 submits one generation with default params at startup.
            if std::env::var("MCS_AUTOTEST").ok().as_deref() == Some("1") {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(4)).await;
                    let params = GenerateParams {
                        title: String::new(),
                        style: "Japanese, J-pop, bright female vocal, piano, acoustic guitar, light drums, hopeful, 120 BPM".into(),
                        lyrics: std::env::var("MCS_AUTOTEST_LYRICS").unwrap_or_else(|_| "[Verse]
夕暮れの坂道を
ゆっくり歩いて帰る

[Chorus]
明日の空に向かって
小さな声で歌おう
".into()),
                        lyrics_display: String::new(),
                        mode: std::env::var("MCS_AUTOTEST_MODE").unwrap_or_else(|_| "full".into()),
                        abc: String::new(), seed: 831001, max_duration: 60.0,
                        abc_temperature: 0.7, abc_top_p: 0.9, abc_top_k: 30, abc_repetition_penalty: 1.005,
                        temperature: 1.0, top_p: 0.95, top_k: 100, repetition_penalty: 1.2, cfg_scale: 1.0, steps: 32,
                        source_abc: String::new(), instrumental_transfer: None, plan: None,
                    };
                    let state = handle.state::<AppState>();
                    match state.jobs.submit(handle.clone(), params) {
                        Ok(song) => log::info!("AUTOTEST submitted song {}", song.id),
                        Err(e) => log::error!("AUTOTEST submit failed: {e:#}"),
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let state = app.state::<AppState>();
                state.retire_ws_relay();
                let proc = state.take_comfy();
                if let Some(mut p) = proc {
                    p.stop();
                }
                let lp = state.llama.lock().take();
                if let Some(mut p) = lp {
                    p.stop();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn separation_models_match_node_pack() {
        // The UI offers these names; MCS_VocalSeparate's combo rejects anything else ("Value not in list").
        let nodes = include_str!("../../comfy-nodes/mcs_yue2_nodes/nodes.py");
        let start = nodes.find("SEPARATION_MODELS = [").expect("SEPARATION_MODELS in nodes.py");
        let block = &nodes[start..];
        let block = &block[block.find('[').unwrap() + 1..block.find(']').unwrap()];
        let names: Vec<&str> = block.split(',').map(|s| s.trim().trim_matches('"')).filter(|s| !s.is_empty()).collect();
        assert_eq!(names, separation_models());
    }

    #[test]
    fn small_vram_threshold_matches_the_wizard_rule() {
        let rules = include_str!("../../src/config/rules.ts");
        assert!(rules.contains(&format!("export const BF16_MIN_VRAM_MIB = {SMALL_VRAM_MIB};")), "SMALL_VRAM_MIB differs from BF16_MIN_VRAM_MIB in src/config/rules.ts");
    }

    #[test]
    fn missing_yue2_nodes_block_only_for_native_nodes() {
        assert_eq!(missing_yue2_nodes_message(&[]), None);
        assert_eq!(missing_yue2_nodes_message(&["MCS_YuE2Status".into(), "MCS_SaveAudioWav".into()]), None);
        let m = missing_yue2_nodes_message(&["YuE2GenerateMusic".into(), "MCS_YuE2Status".into()]).unwrap();
        assert!(m.contains("YuE2GenerateMusic") && !m.contains("MCS_YuE2Status"));
        assert!(m.contains(setup::COMFYUI_VERSION));
        // Names the real Settings control.
        assert!(m.contains("「セットアップをやり直す」") && !m.contains("設定 > セットアップ"));
    }

    #[test]
    fn status_node_input_is_found_by_type() {
        let info = json!({ "input": { "required": { "conditioning": ["CONDITIONING", {}] } }, "input_order": { "required": ["conditioning"] } });
        assert_eq!(conditioning_input_name(&info).as_deref(), Some("conditioning"));
        let info = json!({ "input": { "required": { "label": ["STRING", {}], "cond": ["CONDITIONING"] } } });
        assert_eq!(conditioning_input_name(&info).as_deref(), Some("cond"));
        assert_eq!(conditioning_input_name(&json!({ "input": { "required": { "audio": ["AUDIO"] } } })), None);
        assert_eq!(conditioning_input_name(&json!({})), None);
    }

    #[test]
    fn max_safe_seed_is_js_safe_integer() {
        assert_eq!(MAX_SAFE_SEED, 9007199254740991);
    }

    /// A fresh directory under the system temp folder, removed on drop.
    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("mcs-lib-{}", uuid::Uuid::new_v4().simple()));
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn path_under_roots_resolves_dotdot_case_and_missing_targets() {
        let t = TempDir::new();
        let root = t.0.join("root");
        let other = t.0.join("root-other");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(root.join("sub").join("a.json"), "{}").unwrap();
        std::fs::write(other.join("b.json"), "{}").unwrap();
        let roots = vec![root.clone()];
        assert!(path_under_roots(&roots, &root.join("sub").join("a.json")));
        // `..` climbing out of the root is resolved first.
        assert!(!path_under_roots(&roots, &root.join("..").join("root-other").join("b.json")));
        // A sibling sharing the name prefix is not inside.
        assert!(!path_under_roots(&roots, &other.join("b.json")));
        // Missing targets are never inside; empty / relative roots are ignored.
        assert!(!path_under_roots(&roots, &root.join("missing.json")));
        assert!(!path_under_roots(&[PathBuf::new(), PathBuf::from("rel")], &root.join("sub").join("a.json")));
        #[cfg(windows)]
        {
            // Letter case and the \\?\ prefix do not matter on Windows.
            let upper = PathBuf::from(root.to_string_lossy().to_uppercase()).join("SUB").join("A.JSON");
            assert!(path_under_roots(&roots, &upper));
            let verbatim = std::fs::canonicalize(&root).unwrap().join("sub").join("a.json");
            assert!(path_under_roots(&roots, &verbatim));
        }
        assert!(path_strictly_under(&root, &root.join("sub")));
        assert!(!path_strictly_under(&root, &root));
    }

    fn make_song_folder(base: &Path, id: &str) -> PathBuf {
        let f = base.join("2026-09-30").join(format!("101500_{}", &id[..8]));
        std::fs::create_dir_all(&f).unwrap();
        std::fs::write(f.join("song.json"), format!("{{\"id\":\"{id}\"}}")).unwrap();
        f
    }

    #[test]
    fn song_folders_are_deleted_only_when_they_are_the_songs_own() {
        let t = TempDir::new();
        let id = "0123abcd-0000-4000-8000-000000000000";
        let out = t.0.join("out");
        let old_out = t.0.join("old-out");
        // Under the current output folder: deleted, and the emptied date folder with it.
        let f = make_song_folder(&out, id);
        assert_eq!(remove_song_folder(&f, id, &out).unwrap(), None);
        assert!(!f.exists() && !out.join("2026-09-30").exists());
        // Under an earlier output folder: recognised by its layout and id.
        let f = make_song_folder(&old_out, id);
        let keep = make_song_folder(&old_out, "ffffeeee-0000-4000-8000-000000000000");
        assert_eq!(remove_song_folder(&f, id, &out).unwrap(), None);
        assert!(!f.exists() && keep.exists() && old_out.join("2026-09-30").exists(), "a date folder with other songs stays");
        // A foreign folder outside the output folder is kept and reported as not confirmed.
        let foreign = t.0.join("Documents");
        std::fs::create_dir_all(&foreign).unwrap();
        assert_eq!(remove_song_folder(&foreign, id, &out).unwrap(), Some(KeptFolder { path: foreign.to_string_lossy().to_string(), unreachable: false }));
        assert!(foreign.exists());
        // Another song's folder is not this song's.
        assert!(remove_song_folder(&keep, id, &out).unwrap().is_some_and(|k| !k.unreachable) && keep.exists());
        // The output folder itself is never deleted; a missing folder is nothing to do.
        std::fs::create_dir_all(&out).unwrap();
        assert!(remove_song_folder(&out, id, &out).unwrap().is_some_and(|k| !k.unreachable) && out.exists());
        assert_eq!(remove_song_folder(&t.0.join("gone"), id, &out).unwrap(), None);
        #[cfg(windows)]
        {
            // A folder on a drive that is not there (an unplugged USB disk, an offline network share) only looks
            // missing: it is kept and reported as unreachable (not as outside the output folder), whether it is
            // under the output folder or under an earlier one, not taken as already deleted.
            let free = ('D'..='Z').rev().map(|c| PathBuf::from(format!("{c}:\\"))).find(|r| !r.exists()).expect("a free drive letter");
            let away = free.join("Songs").join("2026-09-30").join("101500_0123abcd");
            let unreachable = Some(KeptFolder { path: away.to_string_lossy().to_string(), unreachable: true });
            assert_eq!(remove_song_folder(&away, id, &away.join("..").join("..")).unwrap(), unreachable);
            assert_eq!(remove_song_folder(&away, id, &out).unwrap(), unreachable);
        }
    }

    /// A queued song taken out of the queue by its delete never had a folder (its job never started): nothing is
    /// reported as kept, also when the drive of its planned folder is unplugged (the user would be told to delete,
    /// once it is back, a folder that never existed). A song that ran may have a folder there: still reported.
    #[test]
    fn a_song_deleted_before_it_started_reports_no_folder() {
        let t = TempDir::new();
        let id = "0123abcd-0000-4000-8000-000000000000";
        let out = t.0.join("out");
        // The worker took it in the meantime and made the folder after all: deleted as usual.
        let f = make_song_folder(&out, id);
        assert_eq!(remove_deleted_song_folder(&f, id, &out, true).unwrap(), None);
        assert!(!f.exists());
        #[cfg(windows)]
        {
            let free = ('D'..='Z').rev().map(|c| PathBuf::from(format!("{c}:\\"))).find(|r| !r.exists()).expect("a free drive letter");
            let away = free.join("Songs").join("2026-09-30").join("101500_0123abcd");
            assert_eq!(remove_deleted_song_folder(&away, id, &out, true).unwrap(), None);
            assert!(remove_deleted_song_folder(&away, id, &out, false).unwrap().is_some_and(|k| k.unreachable));
        }
        // delete_song tells it whether this delete took the song out of the queue.
        let lib = include_str!("lib.rs");
        let body = &lib[lib.find("async fn delete_song(").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        assert!(body.contains("remove_deleted_song_folder(&folder, &sid, &out_dir, never_started)"), "{body}");
    }

    /// The library reads the kept folder's path and reason by these names (api.ts KeptFolder).
    #[test]
    fn a_kept_folder_reaches_the_ui_with_its_reason() {
        let kept = KeptFolder { path: r"E:\Songs\2026-10-01\123456_abcdefgh".into(), unreachable: true };
        assert_eq!(serde_json::to_value(&kept).unwrap(), json!({ "path": r"E:\Songs\2026-10-01\123456_abcdefgh", "unreachable": true }));
        assert_eq!(kept.to_string(), r"E:\Songs\2026-10-01\123456_abcdefgh (drive or share not reachable)");
        assert_eq!(KeptFolder { unreachable: false, ..kept }.to_string(), r"E:\Songs\2026-10-01\123456_abcdefgh");
    }

    /// A file of the song open without delete sharing (VLC, Windows Media Player, but also the ffmpeg of the app's own
    /// 書き出し reading song.wav) stops the delete before anything is removed, with a message naming it that does not
    /// send the user looking only for a player; deleting again once it is closed works.
    #[cfg(windows)]
    #[test]
    fn a_song_folder_with_a_file_open_elsewhere_is_left_whole() {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;
        let t = TempDir::new();
        let id = "0123abcd-0000-4000-8000-000000000000";
        let out = t.0.join("out");
        let f = make_song_folder(&out, id);
        std::fs::create_dir_all(f.join("separated")).unwrap();
        let files = ["lyrics.txt", "score.abc", "song.json", "song.wav", "separated/vocals.wav", "workflow_api.json"];
        for n in files {
            std::fs::write(f.join(n), b"x").unwrap();
        }
        let held = std::fs::OpenOptions::new().read(true).share_mode(FILE_SHARE_READ).open(f.join("song.wav")).unwrap();
        let e = remove_song_folder(&f, id, &out).unwrap_err().to_string();
        assert!(e.contains(SONG_FOLDER_IN_USE) && e.contains("書き出し中") && e.ends_with("song.wav"), "{e}");
        for n in files {
            assert!(f.join(n).is_file(), "{n} must stay");
        }
        drop(held);
        // A reader that shares delete access (the app's own mcs:// reads) does not hold the delete back.
        let shared = std::fs::File::open(f.join("separated").join("vocals.wav")).unwrap();
        assert_eq!(remove_song_folder(&f, id, &out).unwrap(), None);
        drop(shared);
        assert!(!f.exists());
    }

    /// A file that cannot be opened for deletion for another reason than another app's open handle (access denied:
    /// no delete right, or a delete still pending) also stops the delete, but is not called opened elsewhere.
    #[cfg(windows)]
    #[test]
    fn a_song_folder_file_without_delete_access_is_not_called_open_elsewhere() {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_DELETE_ON_CLOSE, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE};
        let t = TempDir::new();
        let id = "0123abcd-0000-4000-8000-000000000000";
        let out = t.0.join("out");
        let f = make_song_folder(&out, id);
        let wav = f.join("song.wav");
        std::fs::write(&wav, b"x").unwrap();
        // Delete pending: marked for deletion by a closed delete-on-close handle while another handle keeps it.
        let share = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
        let keeper = std::fs::OpenOptions::new().read(true).share_mode(share).open(&wav).unwrap();
        drop(std::fs::OpenOptions::new().read(true).share_mode(share).custom_flags(FILE_FLAG_DELETE_ON_CLOSE).open(&wav).unwrap());
        if !std::fs::read_dir(&f).unwrap().flatten().any(|e| e.file_name() == "song.wav") {
            // POSIX delete semantics took the name away at once: nothing is pending to check here.
            return;
        }
        let e = remove_song_folder(&f, id, &out).unwrap_err().to_string();
        assert!(e.contains("アクセスできない") && !e.contains(SONG_FOLDER_IN_USE) && e.contains("song.wav"), "{e}");
        assert!(f.join("song.json").is_file(), "nothing is removed");
        drop(keeper);
        assert_eq!(remove_song_folder(&f, id, &out).unwrap(), None);
    }

    /// A process whose current directory is the song folder or a folder in it (a terminal opened there, a player
    /// started from Explorer in it) holds that folder without delete sharing: remove_dir_all would empty the whole
    /// tree and only then fail on the folder, leaving the song listed without its audio. The delete stops before
    /// anything is removed, naming the folder; once it is let go, deleting again works.
    #[cfg(windows)]
    #[test]
    fn a_song_folder_held_as_a_current_directory_is_left_whole() {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_READ, FILE_SHARE_WRITE};
        let t = TempDir::new();
        let id = "0123abcd-0000-4000-8000-000000000000";
        let out = t.0.join("out");
        let f = make_song_folder(&out, id);
        std::fs::create_dir_all(f.join("separated")).unwrap();
        let files = ["lyrics.txt", "score.abc", "song.json", "song.wav", "separated/vocals.wav", "workflow_api.json"];
        for n in files {
            std::fs::write(f.join(n), b"x").unwrap();
        }
        for dir in [f.clone(), f.join("separated")] {
            // The handle a current directory is: the folder opened without FILE_SHARE_DELETE.
            let held = std::fs::OpenOptions::new().read(true).share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE).custom_flags(FILE_FLAG_BACKUP_SEMANTICS).open(&dir).unwrap();
            let e = remove_song_folder(&f, id, &out).unwrap_err().to_string();
            assert!(e.contains(SONG_FOLDER_IN_USE) && e.ends_with(&dir.display().to_string()), "{e}");
            for n in files {
                assert!(f.join(n).is_file(), "{n} must stay while {} is held", dir.display());
            }
            drop(held);
        }
        assert_eq!(remove_song_folder(&f, id, &out).unwrap(), None);
        assert!(!f.exists());
    }

    #[test]
    fn song_json_layout_is_recognised() {
        let t = TempDir::new();
        let f = make_song_folder(&t.0.join("old"), "0123abcd-0000-4000-8000-000000000000");
        assert!(is_song_json(&f.join("song.json")));
        assert!(!is_song_json(&f.join("missing.json")));
        std::fs::write(t.0.join("song.json"), "{}").unwrap();
        assert!(!is_song_json(&t.0.join("song.json")));
        let odd = t.0.join("2026-09-30").join("notes");
        std::fs::create_dir_all(&odd).unwrap();
        std::fs::write(odd.join("song.json"), "{}").unwrap();
        assert!(!is_song_json(&odd.join("song.json")));
        assert!(is_song_folder_name("101500_0123abcd") && !is_song_folder_name("1015_0123abcd") && !is_song_folder_name("101500-0123abcd"));
        assert!(is_date_folder_name("2026-09-30") && !is_date_folder_name("2026-13-01") && !is_date_folder_name("20260930"));
    }

    #[test]
    fn reveal_accepts_only_local_paths_and_falls_back_to_a_parent() {
        let t = TempDir::new();
        let file = t.0.join("a b, c.wav");
        std::fs::write(&file, b"x").unwrap();
        assert_eq!(reveal_target(&file.to_string_lossy()), Ok(RevealTarget::File(file.clone())));
        assert_eq!(reveal_target(&t.0.to_string_lossy()), Ok(RevealTarget::Dir(t.0.clone())));
        let missing = t.0.join("logs").join("comfyui.log");
        assert_eq!(reveal_target(&missing.to_string_lossy()), Ok(RevealTarget::Dir(t.0.clone())));
        for bad in ["https://example.com", "shell:startup", "ms-settings:", "relative\\x", ""] {
            assert!(reveal_target(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn separation_folder_names_are_safe() {
        assert_eq!(separation_folder_name("My Song "), "My Song");
        assert_eq!(separation_folder_name("Demo (feat. X) ."), "Demo (feat. X)");
        assert_eq!(separation_folder_name("a:b*c?\"d<e>f|g"), "a_b_c__d_e_f_g");
        assert_eq!(separation_folder_name("夜明けのうた"), "夜明けのうた");
        assert_eq!(separation_folder_name("  ..  "), "audio");
        assert_eq!(separation_folder_name(""), "audio");
        assert_eq!(separation_folder_name("tab\there"), "tab_here");
        let long = "あ".repeat(100);
        assert_eq!(separation_folder_name(&long).chars().count(), 60);
        // Cutting at 60 characters must not leave a trailing space or dot.
        let edge = format!("{}. x", "a".repeat(58));
        assert_eq!(separation_folder_name(&edge), "a".repeat(58));
    }

    #[test]
    fn separation_folders_by_purpose() {
        use chrono::TimeZone;
        let now = chrono::Local.with_ymd_and_hms(2026, 9, 30, 14, 5, 9).unwrap();
        let (out, align_dir) = (PathBuf::from(r"C:\out"), PathBuf::from(r"D:\data\cache\align_stems"));
        let src = PathBuf::from(r"C:\music\My Song.wav");
        let song = r"C:\out\2026-09-30\140509_abcdef12";
        assert_eq!(separation_out_dir(Some(song), &src, &out, &align_dir, false, &now), PathBuf::from(song).join("separated"));
        // Automatic lyric timing keeps the separation page's stems of the song.
        assert_eq!(separation_out_dir(Some(song), &src, &out, &align_dir, true, &now), PathBuf::from(song).join("separated").join("align"));
        assert_eq!(separation_out_dir(None, &src, &out, &align_dir, false, &now), out.join("separated").join("20260930_140509_My Song"));
        // A file outside the library: one reusable folder instead of a new one per run.
        assert_eq!(separation_out_dir(None, &src, &out, &align_dir, true, &now), align_dir);
        // A song row without a folder counts as a file outside the library.
        assert_eq!(separation_out_dir(Some(""), &src, &out, &align_dir, false, &now), out.join("separated").join("20260930_140509_My Song"));
    }

    /// Only a library row that is gone stops a separation as 「曲がライブラリから削除された」: a song whose folder is
    /// missing or on an unplugged drive is still in the library (creating the stems' folder reports that path).
    #[test]
    fn a_separation_counts_its_song_as_deleted_only_when_the_row_is_gone() {
        let t = TempDir::new();
        let away = t.0.join("2026-09-30").join("140509_abcdef12"); // never created
        let folder = away.to_str().unwrap();
        let id = "abcdef12-0000-4000-8000-000000000000";
        assert!(!separation_song_deleted(Some(id), Some(folder), |_| Ok(true)), "a missing folder of a song still in the library");
        assert!(separation_song_deleted(Some(id), Some(folder), |_| Ok(false)));
        // A database that cannot be read now does not throw the stems away.
        assert!(!separation_song_deleted(Some(id), Some(folder), |_| Err(anyhow!("database is locked"))));
        // A file outside the library (no song, or a row without a folder) has nothing to lose.
        assert!(!separation_song_deleted(None, None, |_| Ok(false)));
        assert!(!separation_song_deleted(Some(id), Some(""), |_| Ok(false)));
    }

    /// Commands that touch the disk run off the UI thread: a plain sync command runs inline on the WebView's
    /// thread, so a sleeping or offline drive (USB HDD, NAS) would freeze the whole window until it answers.
    #[test]
    fn file_system_commands_run_off_the_ui_thread() {
        let src = include_str!("lib.rs");
        for name in [
            "save_config",
            "system_check",
            "data_root_check",
            "setup_status",
            "setup_finalize",
            "delete_song",
            "file_url",
            "read_text_file",
            "read_binary_file",
            "write_binary_file",
            "write_text_file",
            "reveal_path",
            "create_diagnostic_bundle",
            "export_audio",
            "audio_duration",
            "audio_peaks",
        ] {
            let at = src.find(&format!("fn {name}(")).unwrap_or_else(|| panic!("command {name} not found"));
            let before = src[..at].trim_end();
            assert!(before.ends_with("async") || before.ends_with("#[tauri::command(async)]"), "{name} must be `async fn` or `#[tauri::command(async)]`");
        }
    }

    #[test]
    fn file_extensions_are_checked_case_insensitively() {
        assert!(has_extension(Path::new(r"C:\a\score.MID"), &["mid", "midi"]));
        assert!(!has_extension(Path::new(r"C:\a\score.mid.exe"), &["mid"]));
        assert!(!has_extension(Path::new(r"C:\a\noext"), &["mid"]));
        assert!(user_file_path("relative.mid").is_err());
        assert!(read_binary_file(r"C:\Windows\win.ini".into()).is_err(), "only MIDI / ABC / text");
        // Relative paths are refused; other extensions get .mid / .abc appended (see
        // write_commands_append_their_own_extension), so nothing but MIDI / ABC files is written.
        assert!(write_binary_file("a.mid".into(), vec![]).is_err());
        assert!(write_text_file("a.abc".into(), String::new()).is_err());
        let t = TempDir::new();
        let written = write_binary_file(t.0.join("a.exe").to_string_lossy().to_string(), vec![1, 2]).unwrap();
        assert!(written.ends_with("a.exe.mid") && !t.0.join("a.exe").exists());
        let written = write_text_file(t.0.join("a.bat").to_string_lossy().to_string(), "X:1".into()).unwrap();
        assert_eq!(std::fs::read_to_string(&written).unwrap(), "X:1");
        assert!(written.ends_with("a.bat.abc") && !t.0.join("a.bat").exists());
    }

    #[test]
    fn old_comfy_outputs_are_pruned_only_in_our_subfolders() {
        let t = TempDir::new();
        let out = t.0.join("comfy_output");
        for d in ["mcs", "mcs_sep/sub", "other"] {
            std::fs::create_dir_all(out.join(d)).unwrap();
        }
        for f in ["mcs/0123abcd_00001_.flac", "mcs_sep/sub/0123abcd_vocals_00001_.wav", "other/0123abcd_00001_.flac", "0123abcd_00001_.flac"] {
            std::fs::write(out.join(f), b"x").unwrap();
        }
        // Nothing is old yet.
        assert_eq!(cleanup_comfy_outputs(&out, None, std::time::Duration::from_secs(3600)), 0);
        // Everything is "old" with a zero age: only our sub-folders are emptied, folders stay.
        std::thread::sleep(std::time::Duration::from_millis(20));
        assert_eq!(cleanup_comfy_outputs(&out, None, std::time::Duration::ZERO), 2);
        assert!(out.join("other/0123abcd_00001_.flac").exists() && out.join("0123abcd_00001_.flac").exists() && out.join("mcs_sep/sub").is_dir());
    }

    /// The uninstaller's tools prompt deletes only the app's own files in comfy_input\mcs_uploads, comfy_output\mcs and
    /// mcs_sep, with its own copy of the name rules (hooks.nsh McsIsStagedName, McsIsOutputName). Its harness
    /// (tools/nsis_hooks_test.ps1) checks them with the names of tools/uninstall_name_cases.txt; the app's rules give
    /// every one of those names the same verdict, so the two cannot drift apart (a shipped uninstaller cannot be fixed).
    #[test]
    fn the_uninstallers_name_rules_are_the_apps() {
        let cases = include_str!("../../tools/uninstall_name_cases.txt");
        let uuid = "0123456789abcdef0123456789abcdef";
        let mut checked = 0;
        for line in cases.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')) {
            // columns separated by any run of spaces; the name is the rest of the line
            let (folder, rest) = line.split_once(char::is_whitespace).unwrap();
            let (verdict, name) = rest.trim_start().split_once(char::is_whitespace).unwrap();
            assert!(verdict == "gone" || verdict == "kept", "{line}");
            let mut name = name.trim().replace("{uuid}", uuid);
            while let Some(at) = name.find("{a*") {
                let end = at + name[at..].find('}').unwrap();
                let n: usize = name[at + 3..end].parse().unwrap();
                name.replace_range(at..=end, &"a".repeat(n));
            }
            let ours = match folder {
                "uploads" => comfy::client::is_staged_upload_name(&name),
                "mcs" | "mcs_sep" => is_comfy_output_name(&name),
                other => panic!("unknown folder {other} in {line}"),
            };
            assert_eq!(ours, verdict == "gone", "{folder} {name}: the uninstaller says {verdict}");
            checked += 1;
        }
        assert!(checked >= 40, "{checked}");
    }

    /// The song folder (楽曲の保存先) was comfy_output\mcs earlier and is elsewhere now: what the user saved at the top of
    /// the old folder and next to its song folders (exports, diagnostic bundles) stays. Only the files ComfyUI saved
    /// for our graphs (<8 hex>_<counter>_.flac / .wav, with _vocals / _instrumental for separations) are pruned.
    #[test]
    fn the_prune_removes_only_our_outputs_from_an_earlier_song_folder() {
        let t = TempDir::new();
        let (input, out) = (t.0.join("comfy_input"), t.0.join("comfy_output"));
        let ours = ["mcs/0123abcd_00001_.flac", "mcs/89abcdef_00002_.wav", "mcs/2026-10-01/0123abcd_00001_.flac", "mcs_sep/0123abcd_vocals_00001_.wav", "mcs_sep/0123abcd_instrumental_100000_.wav"];
        let users = [
            "mcs/My Song.mp3",
            "mcs/mcs-diagnostics-20261001-120000.zip",
            "mcs/2026-10-01/export.flac",
            "mcs/2026-10-01/120000_0123abcd/0123abcd_00001_.flac",
            "mcs/0123abcd_00001_.mp3",
            "mcs/0123abcd.flac",
            "mcs/0123abc_00001_.flac",
            "mcs/0123abcd_0001_.flac",
            "mcs/x0123abcd_00001_.wav",
            "mcs/0123abcd_chorus_00001_.wav",
            "mcs_sep/vocals.wav",
        ];
        for f in ours.iter().chain(&users) {
            let p = out.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, b"x").unwrap();
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
        let removed = prune_comfy_folders(&input, &out, &t.0.join("elsewhere"), std::time::Duration::ZERO, std::time::Duration::ZERO);
        assert_eq!(removed, (0, ours.len()));
        let gone = |f: &&str| !out.join(f).exists();
        assert!(ours.iter().all(gone), "{:?}", ours.iter().filter(|f| !gone(f)).collect::<Vec<_>>());
        assert!(!users.iter().any(gone), "{:?}", users.iter().filter(|f| gone(f)).collect::<Vec<_>>());
        // The ids our graphs' prefixes carry: the song id's first 8 characters (jobs::run_one) and a run's 8 hex
        // (tools::separation_prefix).
        let (song, run) = (&uuid::Uuid::new_v4().to_string()[..8], &uuid::Uuid::new_v4().simple().to_string()[..8]);
        for n in [format!("{song}_00001_.flac"), format!("{song}_00002_.wav"), format!("{run}_vocals_00001_.wav"), format!("{run}_instrumental_00001_.wav")] {
            assert!(is_comfy_output_name(&n), "{n}");
        }
    }

    /// A song folder (楽曲の保存先) set to a folder the prune walks (comfy_output\mcs, a folder in it, or
    /// comfy_input\mcs_uploads) is never entered: the diagnostic bundles and exports at its top and the files next to
    /// its song folders are the user's. The app's own files outside it are still pruned, also when the song folder
    /// contains the whole data root (the app's folders in it hold no songs). The user's files in comfy_output are never
    /// pruned, wherever the song folder is (the_prune_removes_only_our_outputs_from_an_earlier_song_folder), nor those in
/// mcs_uploads (comfy::client::tests::the_uploads_prune_removes_only_staged_copies).
    #[test]
    fn the_prune_never_enters_the_song_folder() {
        let t = TempDir::new();
        let (input, out) = (t.0.join("comfy_input"), t.0.join("comfy_output"));
        let files = [
            "comfy_input/mcs_uploads/0123456789abcdef_staged.wav",
            "comfy_output/mcs/0123abcd_00001_.flac",
            "comfy_output/mcs/2026-10-01/89abcdef_00001_.flac",
            "comfy_output/mcs_sep/0123abcd_vocals_00001_.wav",
            "comfy_output/mcs/mcs-diagnostics-1.zip",
            "comfy_output/mcs/2026-10-01/export.mp3",
        ];
        let users = ["comfy_output/mcs/mcs-diagnostics-1.zip", "comfy_output/mcs/2026-10-01/export.mp3"];
        let fresh = || {
            for f in files {
                let p = t.0.join(f);
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                std::fs::write(p, b"x").unwrap();
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        };
        let prune = |song: &Path| prune_comfy_folders(&input, &out, song, std::time::Duration::ZERO, std::time::Duration::ZERO);
        let left = || files.iter().filter(|f| t.0.join(f).exists()).copied().collect::<Vec<_>>();
        fresh();
        assert_eq!(prune(&out.join("mcs")), (1, 1));
        assert_eq!(left(), ["comfy_output/mcs/0123abcd_00001_.flac", "comfy_output/mcs/2026-10-01/89abcdef_00001_.flac", users[0], users[1]]);
        fresh();
        assert_eq!(prune(&out.join("mcs").join("2026-10-01")), (1, 2));
        assert_eq!(left(), ["comfy_output/mcs/2026-10-01/89abcdef_00001_.flac", users[0], users[1]]);
        fresh();
        assert_eq!(prune(&input.join("mcs_uploads")), (0, 3));
        assert_eq!(left(), ["comfy_input/mcs_uploads/0123456789abcdef_staged.wav", users[0], users[1]]);
        fresh();
        assert_eq!(prune(&t.0), (1, 3));
        assert_eq!(left(), users);
        // The song folder is resolved (once): written another way, it is still the same folder.
        fresh();
        assert_eq!(prune(&out.join("mcs_sep").join("..").join("mcs")), (1, 1));
        #[cfg(windows)]
        {
            fresh();
            assert_eq!(prune(&out.join("MCS")), (1, 1));
        }
        // One that cannot be resolved (missing, or on a drive or share that does not answer) is none of the app's
        // folders: everything of ours that is old is pruned.
        fresh();
        assert_eq!(prune(&t.0.join("gone").join("mcs")), (1, 3));
        assert_eq!(left(), users);
    }

    #[test]
    fn a_second_close_within_the_window_goes_through() {
        let t0 = std::time::Instant::now();
        assert!(!close_is_repeated(None, t0), "the first close is held back");
        assert!(close_is_repeated(Some(t0), t0 + std::time::Duration::from_secs(3)));
        assert!(close_is_repeated(Some(t0), t0 + FORCE_CLOSE_WINDOW));
        assert!(!close_is_repeated(Some(t0), t0 + FORCE_CLOSE_WINDOW + std::time::Duration::from_millis(1)));
        assert!(close_request_for(true, None, 0, 0, 0, false).unwrap().hint.contains("もう一度"));
    }

    #[tokio::test]
    async fn llm_requests_can_be_cancelled() {
        let cancels: LlmCancels = Mutex::new(HashMap::new());
        // a request that would never end is cancelled by its id and leaves no handle behind
        let pending = cancellable_llm(&cancels, Some("r1".into()), std::future::pending::<CmdResult<u32>>());
        let cancel = async {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            cancel_llm_request(&cancels, "r1".into());
        };
        let (r, ()) = tokio::join!(pending, cancel);
        assert_eq!(r, Err(COMFY_WAIT_CANCELLED.to_string()));
        assert!(cancels.lock().is_empty());
        // a cancel that arrives before the request registers still ends it
        cancel_llm_request(&cancels, "r2".into());
        let r = cancellable_llm(&cancels, Some("r2".into()), std::future::pending::<CmdResult<u32>>()).await;
        assert_eq!(r, Err(COMFY_WAIT_CANCELLED.to_string()));
        // other requests and requests without an id run to their end
        assert_eq!(cancellable_llm(&cancels, Some("r3".into()), async { Ok(7) }).await, Ok(7));
        assert_eq!(cancellable_llm(&cancels, None, async { Ok(8) }).await, Ok(8));
        assert!(cancels.lock().is_empty());
    }

    /// After a reload (F5, 再読み込み) the requests of the page that is gone run on with nobody knowing their ids, and
    /// llm_stop is refused until they end (minutes). The page load ends them all, a server start included (it runs
    /// under an id of its own), so 停止 works again at once.
    #[tokio::test]
    async fn a_page_load_ends_the_llm_requests_the_old_page_left() {
        let cancels: LlmCancels = Mutex::new(HashMap::new());
        let in_flight = AtomicUsize::new(0);
        let (c, n) = (&cancels, &in_flight);
        let request = move |id: &str| {
            cancellable_llm(c, Some(id.to_string()), async move {
                let _counted = Counted::new(n);
                std::future::pending::<CmdResult<u32>>().await
            })
        };
        let reload = async {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            assert_eq!(llm_stop_allowed(in_flight.load(Ordering::SeqCst)), Err(LLM_STOP_BUSY.to_string()));
            cancel_all_llm_requests(&cancels);
        };
        let all = async { tokio::join!(request("run-1-x"), request("llm_start-y"), reload) };
        let (edit, start, ()) = tokio::time::timeout(std::time::Duration::from_secs(5), all).await.expect("the page load ends them");
        let cancelled = Err(COMFY_WAIT_CANCELLED.to_string());
        assert_eq!((edit, start), (cancelled.clone(), cancelled));
        assert_eq!(llm_stop_allowed(in_flight.load(Ordering::SeqCst)), Ok(()));
        assert!(cancels.lock().is_empty());
        // Wired: the builder runs it when a page starts loading, and llm_start runs as a cancellable request.
        fn body<'a>(src: &'a str, from: &str, to: &str) -> &'a str {
            let rest = &src[src.find(from).unwrap_or_else(|| panic!("{from}"))..];
            &rest[..rest.find(to).unwrap()]
        }
        let lib = include_str!("lib.rs");
        let hook = body(lib, ".on_page_load(", "\n        })\n");
        assert!(hook.contains("PageLoadEvent::Started") && hook.contains("cancel_all_llm_requests("), "{hook}");
        assert!(body(lib, "async fn llm_start(", "\n}\n").contains("cancellable_llm(&state.llm_cancels"));
    }

    #[test]
    fn llama_restart_decision() {
        // Not running, or running with the wanted settings: nothing to do.
        assert!(!llama_restart_needed(false, false, 1, 8081, 8081));
        assert!(!llama_restart_needed(true, true, 1, 8081, 8081));
        // Stale and only this caller in flight: restart.
        assert!(llama_restart_needed(true, false, 1, 8081, 8081));
        // Another request is served by it on the wanted port: keep it for now.
        assert!(!llama_restart_needed(true, false, 2, 8081, 8081));
        // On another port it is replaced even then.
        assert!(llama_restart_needed(true, false, 2, 8081, 8082));
    }

    /// After a WebView reload the wizard starts over while setup_install still runs on the folders it started
    /// with: they cannot be moved under it, and the setup cannot be finished before it ends.
    #[test]
    fn setup_locations_stay_put_while_setup_runs() {
        let cur = AppConfig::default();
        let mut moved = cur.clone();
        moved.data_root = PathBuf::from(r"E:\MCS");
        assert!(!location_change_refused(false, &cur, &moved));
        assert!(location_change_refused(true, &cur, &moved));
        let mut songs = cur.clone();
        songs.output_dir = PathBuf::from(r"E:\Songs");
        assert!(location_change_refused(true, &cur, &songs));
        // Other settings (the license acceptance of step 2) still save.
        let mut license = cur.clone();
        license.license_accepted = true;
        assert!(!location_change_refused(true, &cur, &license));
        assert_eq!(setup_finalize_allowed(false), Ok(()));
        assert_eq!(setup_finalize_allowed(true), Err(SETUP_STILL_RUNNING.to_string()));
    }

    /// A wizard reloaded during setup_install learns the run's end from setup://finished. It is sent only once
    /// setup_running is down: the wizard may call setup_finalize or setup_install at once, which the flag refuses.
    #[test]
    fn setup_finished_is_sent_once_the_run_lets_go() {
        let lib = include_str!("lib.rs");
        let body = &lib[lib.find("async fn setup_install(").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        let down = body.find("setup_running.store(false").expect("the flag is lowered");
        let sent = body.find("\"setup://finished\"").expect("the end is announced");
        assert!(down < sent, "setup://finished before setup_running is down");
        assert_eq!(serde_json::to_value(SetupFinished { error: None }).unwrap(), serde_json::json!({ "error": null }));
        assert_eq!(serde_json::to_value(SetupFinished { error: Some("x".into()) }).unwrap(), serde_json::json!({ "error": "x" }));
    }

    /// The window fits common Windows scaling: 1920x1080 at 150 % leaves a 1280x672 logical work area. The
    /// default 1440x900 is shrunk to the work area (preventOverflow), and the minimum plus the title bar fits
    /// it, so nothing (the toasts, the sidebar status) stays under the taskbar.
    #[test]
    fn the_window_fits_a_small_work_area() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let w = &conf["app"]["windows"][0];
        assert_eq!(w["preventOverflow"], json!(true));
        const TITLE_BAR: f64 = 40.0;
        assert!(w["minHeight"].as_f64().unwrap() + TITLE_BAR <= 672.0, "minHeight {}", w["minHeight"]);
        assert!(w["minWidth"].as_f64().unwrap() + 16.0 <= 1280.0, "minWidth {}", w["minWidth"]);
    }

    #[test]
    fn a_restart_claim_and_tool_runs_exclude_each_other() {
        let (restarting, tools) = (AtomicBool::new(false), AtomicUsize::new(0));
        // A tool run that counted itself first: no restart, and no claim left behind.
        tools.fetch_add(1, Ordering::SeqCst);
        assert!(claim_restart(&restarting, &tools).is_none());
        assert!(!restarting.load(Ordering::SeqCst));
        tools.fetch_sub(1, Ordering::SeqCst);
        // Claimed first: a tool run starting now finds the claim (ensure_comfy_running waits on it).
        let claim = claim_restart(&restarting, &tools).expect("idle");
        assert!(restarting.load(Ordering::SeqCst));
        // A second claimant backs off without releasing the first one's claim.
        assert!(claim_restart(&restarting, &tools).is_none());
        assert!(restarting.load(Ordering::SeqCst));
        drop(claim);
        assert!(!restarting.load(Ordering::SeqCst), "released when the restart ends");
    }

    /// The order that keeps a deferred restart from stopping ComfyUI under a tool run or a job (claim_restart):
    /// the claim comes before the look at tool runs; tools count themselves before they ask for ComfyUI, which
    /// waits out a claim before it starts anything; a job claims before its own start; a restart outside a job
    /// never claims during a generation. Each of these can be broken by a refactor that still compiles.
    #[test]
    fn restart_claim_protocol_order_is_kept() {
        fn body<'a>(src: &'a str, sig: &str) -> &'a str {
            let rest = &src[src.find(sig).unwrap_or_else(|| panic!("{sig}"))..];
            &rest[..rest.find("\n}\n").unwrap()]
        }
        fn before(text: &str, a: &str, b: &str) {
            let i = text.find(a).unwrap_or_else(|| panic!("`{a}` missing"));
            let j = text.find(b).unwrap_or_else(|| panic!("`{b}` missing"));
            assert!(i < j, "`{a}` must come before `{b}`");
        }
        let lib = include_str!("lib.rs");
        before(body(lib, "fn claim_restart<"), "compare_exchange", "tools_in_flight.load");
        let restart = body(lib, "pub async fn restart_comfy_if_stale(");
        before(restart, "generation_busy()", "claim_restart(");
        before(restart, "claim_restart(", "restart_claimed(");
        assert!(body(lib, "async fn save_config(").contains("restart_comfy_if_stale(&app, false)"));
        before(body(lib, "pub async fn ensure_comfy_running_cancellable("), "while state.comfy_restarting.load", "start_comfy(");
        let tools = include_str!("tools.rs");
        for f in ["pub async fn transcribe(", "pub async fn separate(", "pub async fn align_lyrics(", "pub async fn plan_score("] {
            before(body(tools, f), "InFlight::new(app)", "ensure_comfy(app");
        }
        before(include_str!("jobs.rs"), "restart_comfy_if_stale(app, true)", "ensure_comfy_running_cancellable(app");
    }

    /// Songs a crash, a forced exit or a power loss left queued or running are marked interrupted at startup
    /// (Db::recover, tested in db.rs). Without the call a leftover 'running' row keeps 削除 disabled and its キャンセル
    /// fails for good. Pinned here, since a refactor that drops or moves it still compiles: it runs once, in setup
    /// (past the single-instance gate, so a second launch never marks the first one's jobs), before anything can
    /// queue a job; and it covers the in-progress statuses jobs.rs writes.
    #[test]
    fn startup_marks_the_jobs_a_previous_run_left_as_interrupted() {
        let lib = include_str!("lib.rs");
        let code = &lib[..lib.find("#[cfg(test)]\nmod tests").unwrap()];
        assert_eq!(code.matches(".recover()").count(), 1, "Db::recover is called once, at startup");
        let run = &code[code.find("pub fn run()").unwrap()..];
        let at = |s: &str| run.find(s).unwrap_or_else(|| panic!("`{s}` missing in run()"));
        let recover = at("app.state::<AppState>().db.lock().recover()");
        assert!(at("tauri_plugin_single_instance::init") < at(".setup(|app|"), "the single-instance gate comes first");
        assert!(at(".setup(|app|") < recover && recover < at("jobs.submit(") && recover < at(".build(tauri::generate_context!())"));
        let db = include_str!("db.rs");
        let sql = &db[db.find("pub fn recover(").unwrap()..];
        assert!(sql[..sql.find("Ok(())").unwrap()].contains("WHERE status IN ('queued','running')"));
        let jobs = include_str!("jobs.rs");
        assert!(jobs.contains("status: \"queued\".into()") && jobs.contains("song.status = \"running\".into()"), "jobs.rs writes another in-progress status: add it to Db::recover");
    }

    /// 「待機中をすべてキャンセル」 sends queuedOnly: a song that has just left the queue is still listed as 待機中 until
    /// 準備中 arrives, and is left running (its dialog says 生成中の曲はそのまま続きます). cancel_job hands the flag on,
    /// JobManager::cancel gives it to cancel_action and refuses a started song instead of flagging it, and delete_song
    /// cancels as before (a song the worker has just taken is flagged, and its delete refused as running). Pinned here,
    /// since only cancel_action is tested and passing `false` instead still compiles (an unused argument is a warning).
    #[test]
    fn cancel_job_hands_queued_only_to_the_job_manager() {
        fn body<'a>(src: &'a str, sig: &str, end: &str) -> &'a str {
            let rest = &src[src.find(sig).unwrap_or_else(|| panic!("{sig}"))..];
            &rest[..rest.find(end).unwrap()]
        }
        let lib = include_str!("lib.rs");
        let cancel_job = body(lib, "fn cancel_job(", "\n}\n");
        assert!(cancel_job.contains("state.jobs.cancel(&app, &song_id, queued_only.unwrap_or(false))"), "{cancel_job}");
        let delete_song = body(lib, "async fn delete_song(", "\n}\n");
        assert!(delete_song.contains("state.jobs.cancel(&app, &id, false)"), "{delete_song}");
        let cancel = body(include_str!("jobs.rs"), "pub fn cancel(", "\n    }\n");
        assert!(cancel.contains("match self.cancel_action(song_id, queued_only) {"), "{cancel}");
        assert!(cancel.contains("CancelAction::Started => bail!("), "{cancel}");
    }

    /// Every command's arguments, camelCased as Tauri expects them, are exactly the keys src/api.ts sends. A key
    /// missing for an Option argument is no error, it silently becomes None: a renamed run_id / request_id /
    /// purpose would cut a page off its own progress events, its cancel, or its own stem folder.
    #[test]
    fn command_arguments_match_the_invoke_keys() {
        /// Index of the bracket closing the one already open at the start of `s`.
        fn closing(s: &str, open: char, close: char) -> usize {
            let mut depth = 1;
            for (i, c) in s.char_indices() {
                if c == open {
                    depth += 1;
                } else if c == close {
                    depth -= 1;
                    if depth == 0 {
                        return i;
                    }
                }
            }
            panic!("unbalanced {open}{close}");
        }
        /// `s` split at the commas outside brackets (generics, calls, objects).
        fn split_top(s: &str) -> Vec<&str> {
            let (mut out, mut depth, mut from) = (Vec::new(), 0i32, 0);
            for (i, c) in s.char_indices() {
                match c {
                    '(' | '<' | '{' | '[' => depth += 1,
                    ')' | '>' | '}' | ']' => depth -= 1,
                    ',' if depth == 0 => {
                        out.push(s[from..i].trim());
                        from = i + 1;
                    }
                    _ => {}
                }
            }
            out.push(s[from..].trim());
            out.into_iter().filter(|p| !p.is_empty()).collect()
        }
        fn camel(snake: &str) -> String {
            let mut parts = snake.split('_');
            let mut out = parts.next().unwrap_or_default().to_string();
            for p in parts {
                let mut cs = p.chars();
                if let Some(c) = cs.next() {
                    out.extend(c.to_uppercase());
                    out.push_str(cs.as_str());
                }
            }
            out
        }
        let lib = include_str!("lib.rs");
        let api = include_str!("../../src/api.ts");
        let start = lib.find("generate_handler![").unwrap() + "generate_handler![".len();
        let commands: Vec<&str> = split_top(&lib[start..start + lib[start..].find(']').unwrap()]);
        assert!(commands.len() > 40, "{commands:?}");
        for cmd in commands {
            let at = lib.find(&format!("fn {cmd}(")).unwrap_or_else(|| panic!("fn {cmd} in lib.rs"));
            let params = &lib[at + cmd.len() + 4..];
            let mut rust: Vec<String> = split_top(&params[..closing(params, '(', ')')])
                .into_iter()
                .filter_map(|p| p.split_once(':'))
                .filter(|(_, ty)| !["AppHandle", "State<"].iter().any(|t| ty.trim().starts_with(t)))
                .map(|(name, _)| camel(name.trim()))
                .collect();
            let call = format!("(\"{cmd}\"");
            let hits: Vec<usize> = api.match_indices(&call).map(|(i, _)| i).collect();
            assert_eq!(hits.len(), 1, "one invoke of {cmd} in src/api.ts");
            let rest = &api[hits[0] + call.len()..];
            let mut ts: Vec<String> = if rest.trim_start().starts_with(',') {
                let obj = &rest[rest.find('{').unwrap() + 1..];
                split_top(&obj[..closing(obj, '{', '}')]).into_iter().map(|e| e.split(':').next().unwrap().trim().to_string()).collect()
            } else {
                Vec::new()
            };
            rust.sort();
            ts.sort();
            assert_eq!(rust, ts, "{cmd}: arguments in lib.rs vs invoke keys in src/api.ts");
        }
    }

    /// The page loads and talks to nothing but the app itself: no remote origin in any CSP directive, no
    /// 'unsafe-eval', 'unsafe-inline' for styles only, no asset protocol or global Tauri object, no devtools.
    /// The main window gets exactly these permissions (adding one is a deliberate change of this list).
    #[test]
    fn csp_and_capabilities_stay_locked_down() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let csp = conf["app"]["security"]["csp"].as_str().expect("a CSP string");
        let local = ["'self'", "data:", "blob:", "ipc:", "http://ipc.localhost", "mcs:", "http://mcs.localhost"];
        let mut directives: HashMap<&str, Vec<&str>> = HashMap::new();
        for d in csp.split(';').map(str::trim).filter(|d| !d.is_empty()) {
            let mut parts = d.split_whitespace();
            let name = parts.next().unwrap();
            let sources: Vec<&str> = parts.collect();
            for s in &sources {
                assert!(local.contains(s) || (*s == "'unsafe-inline'" && name == "style-src"), "{name} allows {s}");
            }
            directives.insert(name, sources);
        }
        // Scripts fall back to default-src: only the app's own files.
        assert_eq!(directives.get("default-src"), Some(&vec!["'self'"]));
        assert!(directives.get("script-src").is_none_or(|s| s == &vec!["'self'"]));
        let security = &conf["app"]["security"];
        assert!(security.get("assetProtocol").is_none_or(|a| a["enable"] != json!(true)));
        assert!(security.get("dangerousDisableAssetCspModification").is_none());
        assert_ne!(conf["app"]["withGlobalTauri"], json!(true));
        assert_ne!(conf["app"]["windows"][0]["devtools"], json!(true));

        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        let files: Vec<String> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        assert_eq!(files, vec!["default.json".to_string()], "one capability file");
        let cap: serde_json::Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert_eq!(cap["windows"], json!(["main"]));
        assert!(cap.get("remote").is_none(), "no remote page gets the IPC");
        let mut perms: Vec<&str> = cap["permissions"].as_array().unwrap().iter().map(|p| p.as_str().expect("a plain permission name")).collect();
        perms.sort_unstable();
        assert_eq!(perms, vec!["core:default", "core:event:default", "core:window:default", "dialog:default", "opener:default"]);
    }

    /// The single-instance plugin's mutex is `<identifier>-sim`; the gate in run() must name the same one.
    #[test]
    fn app_identifier_matches_the_config() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"].as_str(), Some(APP_IDENTIFIER));
    }

    /// The release workflow gates on the uninstaller's file functions: tools/nsis_hooks_test.ps1 runs after the
    /// installer build (whose NSIS bundle downloads makensis, the harness's default) and a failing harness fails the job.
    #[test]
    fn the_release_workflow_runs_the_uninstaller_hooks_test() {
        let wf = include_str!("../../.github/workflows/release.yml");
        let build = wf.find("uses: tauri-apps/tauri-action@").expect("the installer build");
        let at = wf.find("- name: Uninstaller hooks test").expect("the NSIS harness step");
        assert!(build < at, "the harness needs the makensis the build downloads");
        let step = &wf[at..];
        let step = &step[..step[1..].find("\n      - ").map_or(step.len(), |i| i + 1)];
        assert!(step.contains("pwsh -NoProfile -ExecutionPolicy Bypass -File tools/nsis_hooks_test.ps1\n"), "{step}");
        assert!(step.contains("if ($LASTEXITCODE -ne 0) {") && step.contains("exit $LASTEXITCODE }"), "{step}");
        assert!(!step.contains("continue-on-error") && !step.contains("if:"), "{step}");
    }

    /// A diagnostic bundle carries the newest 3 failed runs, those that failed before their song folder was made (no
    /// folder in their row) included; cancelled and finished songs are not failures.
    #[test]
    fn the_bundle_keeps_failures_that_never_made_their_folder() {
        let song = |id: &str, status: &str, folder: &str| {
            let mut s = db::test_song(id, status);
            s.folder = folder.into();
            s.error = if status == "error" { format!("{id} failed") } else { String::new() };
            s
        };
        let songs = vec![
            song("done", "done", r"D:\Music\2026-10-07\120000_done"),
            song("start", "error", ""),
            song("cancelled", "cancelled", ""),
            song("made", "error", r"D:\Music\2026-10-07\110000_made"),
            song("checkpoint", "error", ""),
            song("older", "error", r"D:\Music\2026-10-06\100000_older"),
        ];
        let failed = bundle_failed_jobs(songs);
        let expected = [("", "start failed"), (r"D:\Music\2026-10-07\110000_made", "made failed"), ("", "checkpoint failed")];
        assert_eq!(failed, expected.map(|(f, e)| (f.to_string(), e.to_string())));
    }

    /// An instance this process cannot open the plugin's mutex of (an elevated one, seen from a normal launch) is
    /// recognised; a missing mutex or one it can open fully is left to the plugin.
    #[cfg(windows)]
    #[test]
    fn a_running_instance_with_other_rights_is_recognised() {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::Security::{InitializeAcl, InitializeSecurityDescriptor, SetSecurityDescriptorDacl, ACL, ACL_REVISION, SECURITY_ATTRIBUTES, SECURITY_DESCRIPTOR};
        use windows_sys::Win32::System::Threading::CreateMutexW;
        let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
        let base = format!("mcs-test-{}", uuid::Uuid::new_v4().simple());
        assert!(!single_instance_mutex_inaccessible(&format!("{base}-none")));
        let same = wide(&format!("{base}-same"));
        let open = unsafe { CreateMutexW(std::ptr::null(), 0, same.as_ptr()) };
        assert!(!open.is_null());
        assert!(!single_instance_mutex_inaccessible(&format!("{base}-same")));
        // An empty DACL grants nothing (an elevated instance's mutex grants a normal process no MUTEX_ALL_ACCESS).
        let locked = unsafe {
            let mut acl: ACL = std::mem::zeroed();
            assert_ne!(InitializeAcl(&mut acl, std::mem::size_of::<ACL>() as u32, ACL_REVISION), 0);
            let mut sd: SECURITY_DESCRIPTOR = std::mem::zeroed();
            let psd = &mut sd as *mut SECURITY_DESCRIPTOR as *mut std::ffi::c_void;
            assert_ne!(InitializeSecurityDescriptor(psd, 1), 0);
            assert_ne!(SetSecurityDescriptorDacl(psd, 1, &acl, 0), 0);
            let sa = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: psd, bInheritHandle: 0 };
            CreateMutexW(&sa, 0, wide(&format!("{base}-locked")).as_ptr())
        };
        assert!(!locked.is_null());
        assert!(single_instance_mutex_inaccessible(&format!("{base}-locked")));
        unsafe {
            CloseHandle(open);
            CloseHandle(locked);
        }
    }

    #[test]
    fn llm_stop_waits_for_requests_in_flight() {
        assert_eq!(llm_stop_allowed(0), Ok(()));
        // Another page's request (a 作曲 draft while AI 編集 offers the stop button) is not cut off.
        assert_eq!(llm_stop_allowed(1), Err(LLM_STOP_BUSY.to_string()));
        assert!(LLM_STOP_BUSY.contains("キャンセル"));
    }

    #[test]
    fn local_chat_errors_are_classified_in_order() {
        use LocalChatFailure::*;
        let never = || -> bool { panic!("the llama lock must not be taken") };
        // A generation that unloads the LLM cut the connection: no restart, even for a connect error.
        assert_eq!(classify_local_chat_error(true, true, true, true, never), StoppedForGeneration);
        assert_eq!(classify_local_chat_error(true, true, false, true, never), StoppedForGeneration);
        // Unreachable after the health check: restart and retry.
        assert_eq!(classify_local_chat_error(false, true, true, true, never), RestartAndRetry);
        assert_eq!(classify_local_chat_error(true, false, true, true, never), RestartAndRetry);
        // Cut: only when our server died.
        assert_eq!(classify_local_chat_error(false, false, false, true, || true), RestartAndRetry);
        assert_eq!(classify_local_chat_error(false, false, false, true, || false), Fail);
        // A read timeout (neither connect nor lost) is never retried.
        assert_eq!(classify_local_chat_error(true, true, false, false, never), Fail);
    }

    #[test]
    fn ws_relay_is_kept_only_when_live_on_the_same_port() {
        assert_eq!(relay_action(None, 8199), RelayAction::Replace);
        assert_eq!(relay_action(Some((8199, true)), 8199), RelayAction::Keep);
        assert_eq!(relay_action(Some((8199, false)), 8199), RelayAction::Replace, "a retired relay");
        assert_eq!(relay_action(Some((8188, true)), 8199), RelayAction::Replace, "another port");
    }

    #[test]
    fn tool_cancel_flags() {
        let t0 = std::time::Instant::now();
        let mut c = ToolCancels::default();
        let flag = c.register("p1", t0);
        assert!(!flag.load(Ordering::SeqCst) && !c.is_cancelled("p1"));
        assert!(c.cancel("p1", t0), "a registered run");
        assert!(flag.load(Ordering::SeqCst) && c.is_cancelled("p1"));
        c.forget("p1");
        assert!(!c.is_cancelled("p1"));
        // A cancel for a prompt that already ended (between plan attempts) is still seen, and a run that
        // registers the id afterwards gets the set flag.
        assert!(!c.cancel("p2", t0));
        assert!(c.is_cancelled("p2") && c.register("p2", t0).load(Ordering::SeqCst));
        // Old entries go on the next register / cancel.
        c.register("p3", t0);
        c.register("p4", t0 + TOOL_CANCEL_TTL);
        assert_eq!(c.len(), 1);
        assert!(!c.is_cancelled("p2"));
        // A run still holding its flag keeps it past the TTL (a prompt queued behind a long generation),
        // so a late cancel reaches that run's own flag.
        let held = c.register("p5", t0);
        c.register("p6", t0 + TOOL_CANCEL_TTL + std::time::Duration::from_secs(1));
        assert!(c.cancel("p5", t0 + TOOL_CANCEL_TTL + std::time::Duration::from_secs(2)));
        assert!(held.load(Ordering::SeqCst));
    }

    #[test]
    fn served_files_evict_the_oldest_registration() {
        let mut s = ServedFiles::default();
        for i in 0..SERVED_MAX {
            s.insert(PathBuf::from(format!("C:/a/{i}.wav")));
        }
        // The first file is registered again (a player asking file_url again): it becomes the newest.
        s.insert(PathBuf::from("C:/a/0.wav"));
        s.insert(PathBuf::from("C:/a/new.wav"));
        assert!(s.contains(Path::new("C:/a/0.wav")) && s.contains(Path::new("C:/a/new.wav")));
        assert!(!s.contains(Path::new("C:/a/1.wav")), "the oldest registration is dropped");
        assert_eq!((s.set.len(), s.order.len()), (SERVED_MAX, SERVED_MAX));
    }

    #[test]
    fn write_commands_append_their_own_extension() {
        let p = |s: &str| PathBuf::from(s);
        assert_eq!(with_required_extension(p("C:/x/a.mid"), &["mid", "midi"], "mid"), p("C:/x/a.mid"));
        assert_eq!(with_required_extension(p("C:/x/a.MIDI"), &["mid", "midi"], "mid"), p("C:/x/a.MIDI"));
        assert_eq!(with_required_extension(p("C:/x/score.txt"), &["mid", "midi"], "mid"), p("C:/x/score.txt.mid"));
        assert_eq!(with_required_extension(p("C:/x/曲"), &["abc"], "abc"), p("C:/x/曲.abc"));
    }

    #[test]
    fn close_guard_lists_what_runs() {
        assert_eq!(close_request_for(false, None, 0, 0, 0, false), None);
        let r = close_request_for(true, Some("夜明けのうた".into()), 0, 0, 0, false).unwrap();
        assert!(r.generating && r.message.starts_with("曲の生成が実行中です") && !r.message.contains("待機中"));
        let r = close_request_for(false, None, 0, 2, 0, true).unwrap();
        assert_eq!((r.tools, r.setup), (2, true));
        // Same words as the tool line of src/api.ts closeRequestLines.
        assert!(r.message.contains("音声の処理（転写・分離・歌詞の整列・譜面の計画）") && r.message.contains("・セットアップ"));
        // Queued songs are named in the message; the payload is camelCase for src/api.ts CloseRequest.
        let r = close_request_for(true, Some("夜明けのうた".into()), 2, 0, 0, false).unwrap();
        assert!(r.message.contains("（待機中の曲も生成されません）"));
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!((v["activeTitle"].as_str(), v["queued"].as_u64(), v["generating"].as_bool()), (Some("夜明けのうた"), Some(2), Some(true)));
        for key in ["tools", "exports", "setup", "message", "hint"] {
            assert!(v.get(key).is_some(), "{key}");
        }
        // Between two jobs (queue not empty, nothing active yet) it still counts as generating work.
        let r = close_request_for(false, Some("x".into()), 1, 0, 0, false).unwrap();
        assert!(r.message.starts_with("曲の生成") && r.active_title.is_none());
        // An export (ffmpeg writing <name>.mcs-tmp.<8 hex>.<ext> next to the destination) is held back too.
        let r = close_request_for(false, None, 0, 0, 1, false).unwrap();
        assert_eq!(r.exports, 1);
        assert!(r.message.starts_with("書き出しが実行中です"), "{}", r.message);
        let r = close_request_for(false, None, 0, 1, 2, true).unwrap();
        assert!(r.message.contains("譜面の計画）・書き出し・セットアップ"), "{}", r.message);
    }

    #[test]
    fn corrupt_db_files_are_recognised_and_moved_aside() {
        let t = TempDir::new();
        let p = t.0.join("library.db");
        std::fs::write(&p, vec![0x42u8; 4096]).unwrap();
        let e: anyhow::Error = rusqlite::Connection::open(&p).and_then(|c| c.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS t (x)")).map_err(anyhow::Error::from).unwrap_err();
        assert!(db_error_is_corruption(&e), "{e:#}");
        assert!(!db_error_is_corruption(&anyhow!("disk full")));
        std::fs::write(t.0.join("library.db-wal"), b"w").unwrap();
        let moved = move_db_aside(&t.0, "20260930-101500");
        assert_eq!(moved.len(), 2);
        assert!(!p.exists() && t.0.join("library.db.corrupt-20260930-101500").is_file() && t.0.join("library.db-wal.corrupt-20260930-101500").is_file());
    }

    fn wav(tag: u16, channels: u16, bits: u16, rate: u32, data: &[u8], extensible: bool) -> Vec<u8> {
        let mut fmt = Vec::new();
        let block = (channels as u32 * bits as u32 / 8) as u16;
        fmt.extend_from_slice(&(if extensible { 0xFFFEu16 } else { tag }).to_le_bytes());
        fmt.extend_from_slice(&channels.to_le_bytes());
        fmt.extend_from_slice(&rate.to_le_bytes());
        fmt.extend_from_slice(&(rate * block as u32).to_le_bytes());
        fmt.extend_from_slice(&block.to_le_bytes());
        fmt.extend_from_slice(&bits.to_le_bytes());
        if extensible {
            fmt.extend_from_slice(&22u16.to_le_bytes());
            fmt.extend_from_slice(&bits.to_le_bytes());
            fmt.extend_from_slice(&0u32.to_le_bytes());
            fmt.extend_from_slice(&tag.to_le_bytes());
            fmt.extend_from_slice(&[0u8; 14]);
        }
        let mut v = b"RIFF\0\0\0\0WAVE".to_vec();
        // An unrelated chunk with an odd size (padded) before fmt.
        v.extend_from_slice(b"LIST\x03\0\0\0abc\0");
        v.extend_from_slice(b"fmt ");
        v.extend_from_slice(&(fmt.len() as u32).to_le_bytes());
        v.extend_from_slice(&fmt);
        v.extend_from_slice(b"data");
        v.extend_from_slice(&(data.len() as u32).to_le_bytes());
        v.extend_from_slice(data);
        v
    }

    #[test]
    fn wav_peaks_cover_pcm_float_and_extensible() {
        use std::io::Cursor;
        // 16-bit stereo, 4 frames: peaks per 2 buckets take the louder channel.
        let frames: [(i16, i16); 4] = [(16384, 0), (0, -32768), (100, 100), (-8192, 0)];
        let data: Vec<u8> = frames.iter().flat_map(|(l, r)| l.to_le_bytes().into_iter().chain(r.to_le_bytes())).collect();
        let bytes = wav(1, 2, 16, 4, &data, false);
        let (p, d) = peaks::wav_peaks(&mut Cursor::new(bytes.clone()), bytes.len() as u64, 2).unwrap();
        assert_eq!(d, 1.0);
        assert_eq!(p, vec![1.0, 0.25]);
        // 32-bit float, extensible header.
        let data: Vec<u8> = [0.5f32, -0.75, 0.1].iter().flat_map(|s| s.to_le_bytes()).collect();
        let bytes = wav(3, 1, 32, 3, &data, true);
        let (p, d) = peaks::wav_peaks(&mut Cursor::new(bytes.clone()), bytes.len() as u64, 10).unwrap();
        assert_eq!(d, 1.0);
        assert_eq!(p, vec![0.5, 0.75, 0.1], "never more buckets than frames");
        // 24-bit mono.
        let data: Vec<u8> = [-4194304i32, 8388607].iter().flat_map(|s| s.to_le_bytes()[..3].to_vec()).collect();
        let bytes = wav(1, 1, 24, 2, &data, false);
        let (p, _) = peaks::wav_peaks(&mut Cursor::new(bytes.clone()), bytes.len() as u64, 2).unwrap();
        assert!((p[0] - 0.5).abs() < 1e-6 && (p[1] - 1.0).abs() < 1e-6);
        assert!(peaks::wav_peaks(&mut Cursor::new(b"RIFF\0\0\0\0AVI ".to_vec()), 12, 2).is_err());
        assert_eq!(peaks::downsample(&[0.1, 0.9, 0.3, 0.2], 2), vec![0.9, 0.3]);
        assert_eq!(peaks::downsample(&[], 5), vec![0.0]);
    }

    #[test]
    fn wav_peaks_refuse_absurd_channel_counts_and_read_in_bounded_chunks() {
        use std::io::Cursor;
        // A damaged header claiming 65535 channels of 64-bit float (a 34 GB frame buffer before the
        // fix) is refused, so compute() falls back to ffmpeg instead of aborting on the allocation.
        let bytes = wav(3, u16::MAX, 64, 44100, &[0u8; 64], false);
        let e = peaks::wav_peaks(&mut Cursor::new(bytes.clone()), bytes.len() as u64, 16).unwrap_err();
        assert!(format!("{e:#}").contains("対応していない"), "{e:#}");
        let bytes = wav(1, peaks::MAX_WAV_CHANNELS + 1, 16, 44100, &[0u8; 260], false);
        assert!(peaks::wav_peaks(&mut Cursor::new(bytes.clone()), bytes.len() as u64, 16).is_err());
        // The largest accepted frame (64 channels x f64 = 512 bytes) still reads, across several chunks.
        let ch = peaks::MAX_WAV_CHANNELS as usize;
        let frames = 20_000usize;
        let mut data = vec![0u8; frames * ch * 8];
        let loud = frames - 1;
        data[(loud * ch + ch - 1) * 8..(loud * ch + ch) * 8].copy_from_slice(&0.5f64.to_le_bytes());
        let bytes = wav(3, ch as u16, 64, 1000, &data, false);
        let (p, d) = peaks::wav_peaks(&mut Cursor::new(bytes.clone()), bytes.len() as u64, 4).unwrap();
        assert_eq!(d, 20.0);
        assert_eq!(p, vec![0.0, 0.0, 0.0, 0.5]);
    }
}
