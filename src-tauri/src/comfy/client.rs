//! Thin HTTP client for the ComfyUI server API.

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

/// Subfolder of ComfyUI's input directory that holds the audio files our tool graphs load.
pub const UPLOAD_SUBFOLDER: &str = "mcs_uploads";
/// ComfyUI's own upload cap (--max-upload-size default) for a server this app did not start.
pub const COMFY_DEFAULT_UPLOAD_MB: u64 = 100;
/// Output subfolders of our graphs (generation "mcs/<id8>", separation "mcs_sep/<uuid8>_...").
pub const OUTPUT_SUBFOLDERS: [&str; 2] = ["mcs", "mcs_sep"];
/// Longest a prompt may wait behind other prompts before it is given up (an external ComfyUI whose
/// queue is full of another client's work).
pub const QUEUE_WAIT_LIMIT_SECS: u64 = 3 * 3600;
/// How often a waiting prompt's place in ComfyUI's queue is looked up (/queue copies every queued
/// workflow, so not on every poll): while it is pending, and once it runs (only to notice it vanished).
const PENDING_CHECK_INTERVAL: Duration = Duration::from_secs(5);
const RUNNING_CHECK_INTERVAL: Duration = Duration::from_secs(30);
/// Longest wait for ComfyUI's answer to /free (it answers at once unless the server hangs).
const FREE_TIMEOUT: Duration = Duration::from_secs(10);
const MIB: u64 = 1024 * 1024;

#[derive(Clone)]
pub struct ComfyClient {
    pub base: String,
    http: reqwest::Client,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceStats {
    pub name: String,
    #[serde(default)]
    pub vram_total: u64,
    #[serde(default)]
    pub vram_free: u64,
    #[serde(default)]
    pub torch_vram_total: u64,
    #[serde(default)]
    pub torch_vram_free: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemStats {
    pub system: Value,
    #[serde(default)]
    pub devices: Vec<DeviceStats>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputFile {
    pub filename: String,
    #[serde(default)]
    pub subfolder: String,
    #[serde(rename = "type", default)]
    pub kind: String,
}

impl ComfyClient {
    /// `base` is the loopback address of ComfyUI. Never through a proxy: reqwest would otherwise follow
    /// HTTP_PROXY / ALL_PROXY, which has no implicit loopback exception (NO_PROXY=localhost does not cover
    /// 127.0.0.1), and a remote proxy cannot reach this PC's ComfyUI. Plain HTTP, so the Windows
    /// certificate store is not read for every client either.
    pub fn new(base: String) -> Self {
        let http = reqwest::Client::builder()
            .no_proxy()
            .tls_built_in_native_certs(false)
            .timeout(Duration::from_secs(600))
            .build()
            .expect("reqwest client");
        Self { base, http }
    }

    pub async fn system_stats(&self) -> Result<SystemStats> {
        let r = self
            .http
            .get(format!("{}/system_stats", self.base))
            .timeout(Duration::from_secs(3))
            .send()
            .await?
            .error_for_status()?;
        Ok(r.json().await?)
    }

    pub async fn is_alive(&self) -> bool {
        self.system_stats().await.is_ok()
    }

    pub async fn object_info(&self, class: &str) -> Result<Value> {
        let r = self.http.get(format!("{}/object_info/{class}", self.base)).send().await?.error_for_status()?;
        let v: Value = r.json().await?;
        v.get(class).cloned().ok_or_else(|| anyhow!("node {class} not found"))
    }

    pub async fn has_node(&self, class: &str) -> bool {
        self.object_info(class).await.is_ok()
    }

    /// POST /prompt with a client-generated `prompt_id` (canonical lowercase UUID, accepted by
    /// server.py since the id must be known before submission so a cancel can target it).
    ///
    /// ComfyUI queues a prompt as long as ONE output node validates and drops the others, reporting
    /// them only in `node_errors` of the HTTP 200 reply. Our graphs have no optional outputs, so a
    /// non-empty `node_errors` means the song/tool output would be missing: the prompt is removed
    /// again (targeted) and the call fails with a readable message.
    pub async fn queue_prompt(&self, prompt: &Value, client_id: &str, prompt_id: &str) -> Result<String> {
        let body = serde_json::json!({ "prompt": prompt, "client_id": client_id, "prompt_id": prompt_id });
        let r = self
            .http
            .post(format!("{}/prompt", self.base))
            .json(&body)
            .send()
            .await
            .context("ComfyUI へのジョブ送信に失敗しました（ComfyUI が停止した可能性があります）")?;
        let status = r.status();
        let v: Value = r.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            bail!("ComfyUI がワークフローを拒否しました: {}", format_rejection(&v));
        }
        let pid = v.get("prompt_id").and_then(|p| p.as_str()).map(|s| s.to_string()).ok_or_else(|| anyhow!("ComfyUI の応答に prompt_id がありません"))?;
        if has_node_errors(&v) {
            self.stop_prompt(&pid).await;
            bail!("ComfyUI がワークフローの一部を拒否しました: {}", format_rejection(&v));
        }
        Ok(pid)
    }

    /// Stop one prompt only: drop it if still pending, interrupt it if running (never a global
    /// interrupt). Errors are ignored: the prompt may already be gone.
    pub async fn stop_prompt(&self, prompt_id: &str) {
        let _ = self.delete_pending(&[prompt_id.to_string()]).await;
        let _ = self.interrupt(Some(prompt_id)).await;
    }

    /// GET /history/{id} -> the entry (None until it exists)
    pub async fn history(&self, prompt_id: &str) -> Result<Option<Value>> {
        let r = self.http.get(format!("{}/history/{prompt_id}", self.base)).send().await?.error_for_status()?;
        let v: Value = r.json().await?;
        Ok(v.get(prompt_id).cloned())
    }

    /// Download an output file to `dest` (streamed into a temporary file next to it, then renamed
    /// over it: a failed download leaves an existing `dest` untouched). Returns the byte count.
    pub async fn download_view(&self, f: &OutputFile, dest: &Path) -> Result<u64> {
        let (tmp, n) = self.download_view_to_temp(f, dest).await?;
        commit_download(&tmp, dest).await?;
        Ok(n)
    }

    /// Stream an output file into a unique `<dest>.<uuid>.part` next to `dest` and return that path
    /// and the byte count. The caller renames it onto `dest` (commit_download) or removes it; when this
    /// fails, nothing is left behind.
    pub async fn download_view_to_temp(&self, f: &OutputFile, dest: &Path) -> Result<(PathBuf, u64)> {
        const FETCH: &str = "ComfyUI から出力ファイルを取得できませんでした";
        let r = self
            .http
            .get(format!("{}/view", self.base))
            .query(&[("filename", f.filename.as_str()), ("subfolder", f.subfolder.as_str()), ("type", if f.kind.is_empty() { "output" } else { f.kind.as_str() })])
            .send()
            .await
            .context(FETCH)?
            .error_for_status()
            .context(FETCH)?;
        if let Some(p) = dest.parent() {
            tokio::fs::create_dir_all(p).await.with_context(|| format!("出力フォルダを作成できませんでした: {}", p.display()))?;
        }
        let tmp = part_path(dest);
        match stream_to_file(r, &tmp).await {
            Ok(n) => Ok((tmp, n)),
            Err(e) => {
                let _ = tokio::fs::remove_file(&tmp).await;
                Err(e)
            }
        }
    }

    /// True when ComfyUI can see `input/<subfolder>/<name>` (HEAD /view: no body is transferred).
    pub async fn input_visible(&self, subfolder: &str, name: &str) -> bool {
        match self
            .http
            .head(format!("{}/view", self.base))
            .query(&[("filename", name), ("subfolder", subfolder), ("type", "input")])
            .timeout(Duration::from_secs(10))
            .send()
            .await
        {
            Ok(r) => r.status().is_success(),
            Err(_) => false,
        }
    }

    /// HTTP fallback: upload a local file into ComfyUI's input dir (ComfyUI has no /upload/audio;
    /// /upload/image accepts any file). The name is content-addressed, so overwrite=true is safe.
    /// Returns the LoadAudio value (`subfolder/name`). `own_server`: the server is the ComfyUI this
    /// app started (its upload cap is process::MAX_UPLOAD_MB; another server's is unknown).
    pub async fn upload_input(&self, path: &Path, name: &str, own_server: bool) -> Result<String> {
        // Streamed from the file (up to MAX_UPLOAD_MB): no in-memory copy of the audio.
        let size = tokio::fs::metadata(path).await.with_context(|| format!("音声ファイルを読み取れませんでした: {}", path.display()))?.len();
        let file = tokio::fs::File::open(path).await.with_context(|| format!("音声ファイルを開けませんでした: {}", path.display()))?;
        let part = reqwest::multipart::Part::stream_with_length(reqwest::Body::from(file), size).file_name(name.to_string());
        let form = reqwest::multipart::Form::new()
            .part("image", part)
            .text("type", "input")
            .text("subfolder", UPLOAD_SUBFOLDER)
            .text("overwrite", "true");
        let r = match self.http.post(format!("{}/upload/image", self.base)).multipart(form).send().await {
            Ok(r) => r,
            Err(e) => {
                if e.is_timeout() {
                    return Err(anyhow!(e).context(format!("ComfyUI へのアップロードがタイムアウトしました（{} MB）", size / MIB)));
                }
                // aiohttp may reset the connection instead of answering 413 when the body is over the
                // cap. A server that is unreachable or gone is not that.
                if reset_means_too_large(size, own_server, e.is_connect()) && self.is_alive().await {
                    bail!("{}（{e}）", too_large_message(size, own_server));
                }
                return Err(anyhow!(e).context("ComfyUI へのアップロードに失敗しました"));
            }
        };
        if r.status() == reqwest::StatusCode::PAYLOAD_TOO_LARGE {
            bail!("{}", too_large_message(size, own_server));
        }
        let v: Value = r
            .error_for_status()
            .context("ComfyUI へのアップロードに失敗しました")?
            .json()
            .await
            .context("ComfyUI のアップロード応答を読み取れませんでした")?;
        Ok(load_value_from_upload(&v, name))
    }

    /// POST /interrupt. With a prompt id ComfyUI stops only that prompt, and only if it is running;
    /// without one it stops whatever is executing (global interrupt).
    pub async fn interrupt(&self, prompt_id: Option<&str>) -> Result<()> {
        let body = match prompt_id {
            Some(id) => serde_json::json!({ "prompt_id": id }),
            None => serde_json::json!({}),
        };
        self.http.post(format!("{}/interrupt", self.base)).json(&body).send().await?;
        Ok(())
    }

    /// POST /queue {"delete": ids}: remove prompts that are still pending (no-op for others).
    pub async fn delete_pending(&self, ids: &[String]) -> Result<()> {
        self.http.post(format!("{}/queue", self.base)).json(&serde_json::json!({ "delete": ids })).send().await?;
        Ok(())
    }

    /// POST /free (ComfyUI only sets a flag for its worker and answers at once). The messages are for
    /// 「VRAM を解放」 on the settings page; the other callers (after a generation, before llama-server
    /// starts) ignore a failure.
    pub async fn free(&self, unload_models: bool) -> Result<()> {
        self.free_within(unload_models, FREE_TIMEOUT).await
    }

    async fn free_within(&self, unload_models: bool, timeout: Duration) -> Result<()> {
        let r = self
            .http
            .post(format!("{}/free", self.base))
            .json(&serde_json::json!({ "unload_models": unload_models, "free_memory": true }))
            .timeout(timeout)
            .send()
            .await
            .map_err(|e| {
                let msg = if e.is_connect() {
                    "ComfyUI に接続できません（停止しています）".to_string()
                } else if e.is_timeout() {
                    format!("ComfyUI が {} 秒以内に応答しませんでした", timeout.as_secs())
                } else {
                    "ComfyUI への送信に失敗しました".to_string()
                };
                anyhow::Error::new(e).context(msg)
            })?;
        if !r.status().is_success() {
            bail!("ComfyUI がエラーを返しました（HTTP {}）", r.status());
        }
        Ok(())
    }

    pub async fn queue_state(&self) -> Result<(usize, usize)> {
        let v = self.queue_raw().await?;
        let running = v.get("queue_running").and_then(|q| q.as_array()).map(|a| a.len()).unwrap_or(0);
        let pending = v.get("queue_pending").and_then(|q| q.as_array()).map(|a| a.len()).unwrap_or(0);
        Ok((running, pending))
    }

    /// Prompt ids that are running or pending.
    pub async fn queue_ids(&self) -> Result<Vec<String>> {
        Ok(queue_ids_of(&self.queue_raw().await?))
    }

    /// Where one prompt is in ComfyUI's queue.
    pub async fn prompt_state(&self, prompt_id: &str) -> Result<QueuedState> {
        Ok(prompt_state_of(&self.queue_raw().await?, prompt_id))
    }

    /// GET /queue with a short timeout of its own (like system_stats): the status bar polls it, and a
    /// server that accepts connections but no longer answers must not hold each poll for minutes.
    async fn queue_raw(&self) -> Result<Value> {
        let r = self.http.get(format!("{}/queue", self.base)).timeout(Duration::from_secs(5)).send().await?.error_for_status()?;
        Ok(r.json().await?)
    }
}

/// Stream a response body into `path` (created or truncated), flushed to disk. Returns the byte count.
async fn stream_to_file(r: reqwest::Response, path: &Path) -> Result<u64> {
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;
    let write_err = || format!("出力ファイルを保存できませんでした: {}", path.display());
    let mut file = tokio::fs::File::create(path).await.with_context(write_err)?;
    let mut body = r.bytes_stream();
    let mut n: u64 = 0;
    while let Some(chunk) = body.next().await {
        let chunk = chunk.context("ComfyUI からの出力ファイルの受信が途中で途切れました")?;
        file.write_all(&chunk).await.with_context(write_err)?;
        n += chunk.len() as u64;
    }
    file.flush().await.with_context(write_err)?;
    file.sync_all().await.with_context(write_err)?;
    Ok(n)
}

/// Unique temporary sibling of `dest` for a download in progress.
fn part_path(dest: &Path) -> PathBuf {
    let name = dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "download".into());
    dest.with_file_name(format!("{name}.{}.part", uuid::Uuid::new_v4().simple()))
}

/// Move a finished download (download_view_to_temp) onto `dest`, replacing it. On failure (e.g. `dest`
/// is open in a player that locks it) the temporary file is removed and `dest` is left as it was.
pub async fn commit_download(tmp: &Path, dest: &Path) -> Result<()> {
    if let Err(e) = tokio::fs::rename(tmp, dest).await {
        let _ = tokio::fs::remove_file(tmp).await;
        return Err(anyhow!(e).context(format!("出力ファイルを保存できませんでした（他のアプリで開かれている可能性があります）: {}", dest.display())));
    }
    Ok(())
}

/// Move several finished downloads (tmp, dest) onto their destinations, all or nothing: every existing
/// destination is first renamed aside to a unique `<name>.<uuid>.mcs-bak` (on Windows this needs delete
/// access, so it also finds a destination locked by another app before anything is replaced), then the
/// downloads are moved in. On any failure the moved-in files are removed, the originals renamed back and the
/// remaining temporary files removed; the error names the destination that failed. The backups go once
/// everything is in place. Unique names: a file of the user's next to dest (e.g. vocals.wav.bak) is never
/// taken for a backup and removed.
pub async fn commit_downloads(pairs: &[(PathBuf, PathBuf)]) -> Result<()> {
    let backup_of = |dest: &Path| {
        let mut n = dest.file_name().unwrap_or_default().to_os_string();
        n.push(format!(".{}.mcs-bak", uuid::Uuid::new_v4().simple()));
        dest.with_file_name(n)
    };
    let remove_tmps = |from: usize| async move {
        for (tmp, _) in &pairs[from..] {
            let _ = tokio::fs::remove_file(tmp).await;
        }
    };
    let failed = |dest: &Path, e: std::io::Error| anyhow!(e).context(format!("出力ファイルを保存できませんでした（他のアプリで開かれている可能性があります）: {}", dest.display()));
    // Phase 1: set the current files aside.
    let mut backed: Vec<(PathBuf, PathBuf)> = Vec::new();
    for (_, dest) in pairs {
        if tokio::fs::metadata(dest).await.is_err() {
            continue;
        }
        let bak = backup_of(dest);
        if let Err(e) = tokio::fs::rename(dest, &bak).await {
            for (d, b) in backed.iter().rev() {
                let _ = tokio::fs::rename(b, d).await;
            }
            remove_tmps(0).await;
            return Err(failed(dest, e));
        }
        backed.push((dest.clone(), bak));
    }
    // Phase 2: move the downloads in.
    for (i, (tmp, dest)) in pairs.iter().enumerate() {
        if let Err(e) = tokio::fs::rename(tmp, dest).await {
            for (_, d) in &pairs[..i] {
                let _ = tokio::fs::remove_file(d).await;
            }
            for (d, b) in backed.iter().rev() {
                let _ = tokio::fs::rename(b, d).await;
            }
            remove_tmps(i).await;
            return Err(failed(dest, e));
        }
    }
    for (_, b) in &backed {
        let _ = tokio::fs::remove_file(b).await;
    }
    Ok(())
}

/// The file behind an output of our own graphs in the output directory of the ComfyUI this app started
/// (None for anything else: another folder or type, a name that could leave the folder, or a file that is
/// not there, e.g. because the data folder changed since ComfyUI was started). Used to delete ComfyUI's
/// copy once the app has its own.
pub fn own_output_path(output_dir: &Path, f: &OutputFile) -> Option<PathBuf> {
    if !(f.kind.is_empty() || f.kind == "output") {
        return None;
    }
    let sub = f.subfolder.replace('\\', "/");
    let parts: Vec<&str> = sub.split('/').collect();
    if !OUTPUT_SUBFOLDERS.contains(&parts[0]) || parts.iter().any(|c| c.is_empty() || *c == "." || *c == ".." || c.contains(':')) {
        return None;
    }
    let name = f.filename.as_str();
    if name.is_empty() || name.contains(['/', '\\', ':']) || name.contains("..") {
        return None;
    }
    let p = parts.iter().fold(output_dir.to_path_buf(), |p, c| p.join(c)).join(name);
    p.is_file().then_some(p)
}

/// Whether a failed upload of `size` bytes (not a connect error; a timeout is handled before) is taken
/// for aiohttp resetting a body over the server's cap.
fn reset_means_too_large(size: u64, own_server: bool, is_connect: bool) -> bool {
    let cap_mb = if own_server { super::process::MAX_UPLOAD_MB as u64 } else { COMFY_DEFAULT_UPLOAD_MB };
    size > cap_mb * MIB && !is_connect
}

/// Where a prompt is in ComfyUI's queue (`/queue`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueuedState {
    Running,
    Pending,
    /// In neither list: finished (its history entry exists) or removed without one.
    Absent,
}

pub fn prompt_state_of(v: &Value, prompt_id: &str) -> QueuedState {
    let listed = |k: &str| v.get(k).and_then(|q| q.as_array()).is_some_and(|a| a.iter().any(|item| item.get(1).and_then(|id| id.as_str()) == Some(prompt_id)));
    if listed("queue_running") {
        QueuedState::Running
    } else if listed("queue_pending") {
        QueuedState::Pending
    } else {
        QueuedState::Absent
    }
}

/// Why a finished history entry is not a success.
#[derive(Debug, Clone, PartialEq)]
pub enum PromptFailure {
    /// execution_interrupted: stopped by /interrupt (the app's own cancel, or someone else's).
    Interrupted,
    /// execution_error: `{node_type}: {exception_message}`.
    Error(String),
    Unknown,
}

/// None when the entry's status is "success".
pub fn history_failure(entry: &Value) -> Option<PromptFailure> {
    if entry.pointer("/status/status_str").and_then(|s| s.as_str()) == Some("success") {
        return None;
    }
    let msgs = entry.pointer("/status/messages").and_then(|m| m.as_array()).cloned().unwrap_or_default();
    for m in &msgs {
        match m.get(0).and_then(|k| k.as_str()) {
            Some("execution_error") => {
                let d = m.get(1).cloned().unwrap_or(Value::Null);
                let node_type = d.get("node_type").and_then(|x| x.as_str()).unwrap_or("");
                let msg = d.get("exception_message").and_then(|x| x.as_str()).unwrap_or("");
                return Some(PromptFailure::Error(format!("{node_type}: {msg}")));
            }
            Some("execution_interrupted") => return Some(PromptFailure::Interrupted),
            _ => {}
        }
    }
    Some(PromptFailure::Unknown)
}

/// Seconds the prompt actually executed, from the millisecond timestamps ComfyUI stores with the
/// execution_start and final status messages of a history entry (None when they are missing).
pub fn execution_seconds(entry: &Value) -> Option<f64> {
    let msgs = entry.pointer("/status/messages")?.as_array()?;
    let at = |kinds: &[&str]| msgs.iter().filter(|m| m.get(0).and_then(|k| k.as_str()).is_some_and(|k| kinds.contains(&k))).find_map(|m| m.pointer("/1/timestamp").and_then(|t| t.as_f64()));
    let start = at(&["execution_start"])?;
    let end = at(&["execution_success", "execution_error", "execution_interrupted"])?;
    (end >= start).then(|| (end - start) / 1000.0)
}

/// The text of a PreviewAny-style output (`ui.text`), lines joined.
pub fn text_output(outputs: &Value, node: &str) -> Option<String> {
    outputs.get(node)?.get("text")?.as_array().map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join("\n"))
}

/// The files of an audio save node's output (`ui.audio`).
pub fn audio_outputs(outputs: &Value, node: &str) -> Vec<OutputFile> {
    outputs.get(node).and_then(|o| o.get("audio")).and_then(|a| serde_json::from_value(a.clone()).ok()).unwrap_or_default()
}

/// Limits for waiting on a prompt (HistoryWait).
#[derive(Debug, Clone, Copy)]
pub struct WaitLimits {
    /// Once it runs.
    pub run_secs: u64,
    /// From queueing, while it is still pending behind other prompts.
    pub wait_secs: u64,
}

/// Why waiting for a prompt's history entry ended without one.
#[derive(Debug, Clone, PartialEq)]
pub enum WaitError {
    /// The caller asked to cancel and the prompt left ComfyUI's queue.
    Cancelled,
    /// It ran longer than WaitLimits::run_secs (it was stopped).
    RunTimeout,
    /// It stayed pending longer than WaitLimits::wait_secs (it was removed).
    WaitTimeout,
    /// ComfyUI stopped answering.
    Lost(String),
    /// It left the queue without a history entry (cleared in ComfyUI's own UI or by another client).
    Vanished,
}

impl WaitError {
    /// Message for the user; `what` names the work ("生成", "処理").
    pub fn message(&self, what: &str, run_secs: u64) -> String {
        match self {
            WaitError::Cancelled => format!("{what}が取り消されました"),
            WaitError::RunTimeout => format!("{what}が {} 分以内に終わりませんでした", run_secs / 60),
            WaitError::WaitTimeout => format!("ComfyUI で他の処理の完了待ちが長すぎます（{} 時間）。ComfyUI の待ち行列を確認してください", QUEUE_WAIT_LIMIT_SECS / 3600),
            WaitError::Lost(e) => format!("ComfyUI との接続が失われました: {e}"),
            WaitError::Vanished => "ComfyUI の待ち行列からこの処理が削除されました（ComfyUI の画面や別のアプリから取り消された可能性があります）".into(),
        }
    }
}

/// Like Instant::now(), but advancing only while the PC is awake. std's Instant (QueryPerformanceCounter
/// on Windows) keeps counting through sleep and hibernation, so a PC that slept in the middle of a run
/// would wake to a run timeout, and the prompt ComfyUI resumes would be stopped. HistoryWait uses this.
pub fn awake_now() -> Instant {
    #[cfg(windows)]
    {
        static BASE: std::sync::OnceLock<(Instant, u64)> = std::sync::OnceLock::new();
        let (at, ticks) = *BASE.get_or_init(|| (Instant::now(), unbiased_interrupt_time()));
        awake_instant(at, ticks, unbiased_interrupt_time())
    }
    #[cfg(not(windows))]
    {
        Instant::now()
    }
}

/// `base` plus the time between two unbiased interrupt time readings (100 ns units, sleep left out).
#[cfg(any(windows, test))]
fn awake_instant(base: Instant, base_ticks: u64, ticks: u64) -> Instant {
    base + Duration::from_nanos(ticks.saturating_sub(base_ticks).saturating_mul(100))
}

#[cfg(windows)]
fn unbiased_interrupt_time() -> u64 {
    use windows_sys::Win32::System::WindowsProgramming::QueryUnbiasedInterruptTime;
    let mut t = 0u64;
    unsafe { QueryUnbiasedInterruptTime(&mut t) };
    t
}

/// The clocks of a prompt being waited for (no I/O; HistoryWait feeds it awake_now()). The run clock
/// restarts while the prompt is seen pending, so time spent behind other prompts counts only against the
/// separate wait limit, not against the run limit or the measured run time.
#[derive(Debug, Clone)]
pub struct PromptClock {
    queued: Instant,
    started: Instant,
    running: bool,
    last_check: Option<Instant>,
}

impl PromptClock {
    pub fn new(now: Instant) -> Self {
        Self { queued: now, started: now, running: false, last_check: None }
    }

    /// Whether the queue should be looked up now.
    pub fn queue_check_due(&self, now: Instant) -> bool {
        let every = if self.running { RUNNING_CHECK_INTERVAL } else { PENDING_CHECK_INTERVAL };
        self.last_check.is_none_or(|t| now.saturating_duration_since(t) >= every)
    }

    /// Record a /queue answer. False when the prompt is in neither list.
    pub fn observe(&mut self, st: QueuedState, now: Instant) -> bool {
        self.last_check = Some(now);
        match st {
            QueuedState::Pending => {
                self.started = now;
                true
            }
            QueuedState::Running => {
                self.running = true;
                true
            }
            QueuedState::Absent => false,
        }
    }

    /// The limit the prompt is over, if any.
    pub fn over_limit(&self, now: Instant, limits: WaitLimits) -> Option<WaitError> {
        if !self.running && now.saturating_duration_since(self.queued).as_secs() > limits.wait_secs {
            return Some(WaitError::WaitTimeout);
        }
        (now.saturating_duration_since(self.started).as_secs() > limits.run_secs).then_some(WaitError::RunTimeout)
    }

    /// Seconds since the prompt was last seen pending (since queueing when it never was).
    pub fn run_seconds(&self, now: Instant) -> f64 {
        now.saturating_duration_since(self.started).as_secs_f64()
    }
}

/// Wait for a queued prompt's /history entry, one `poll` at a time (the caller sleeps between polls and
/// does its own sampling). Every poll checks the cancel request and the limits, also when /history
/// fails while the server still answers; now and then it looks the prompt up in the queue, to keep the
/// run clock off while it is pending and to notice a prompt that was removed without a history entry.
pub struct HistoryWait<'a> {
    client: &'a ComfyClient,
    prompt_id: String,
    limits: WaitLimits,
    clock: PromptClock,
}

impl<'a> HistoryWait<'a> {
    pub fn new(client: &'a ComfyClient, prompt_id: &str, limits: WaitLimits) -> Self {
        Self { client, prompt_id: prompt_id.to_string(), limits, clock: PromptClock::new(awake_now()) }
    }

    /// Seconds the prompt has been running (queue wait and time asleep excluded, see PromptClock).
    pub fn run_seconds(&self) -> f64 {
        self.clock.run_seconds(awake_now())
    }

    /// One poll: Ok(Some(entry)) once the history entry exists, Ok(None) to keep waiting.
    /// `cancel`: the caller wants the prompt stopped; it is stopped (targeted) while it is still queued
    /// and the wait ends with Cancelled once it left the queue without finishing.
    pub async fn poll(&mut self, cancel: bool) -> Result<Option<Value>, WaitError> {
        let id = self.prompt_id.clone();
        let history_ok = match self.client.history(&id).await {
            Ok(Some(h)) => return Ok(Some(h)),
            Ok(None) => true,
            Err(e) => {
                if !self.client.is_alive().await {
                    return Err(WaitError::Lost(format!("{e}")));
                }
                false
            }
        };
        if cancel {
            // A deleted pending prompt never gets a history entry: end once it left the queue.
            match self.client.prompt_state(&id).await {
                Ok(QueuedState::Absent) => {
                    return match self.client.history(&id).await {
                        Ok(Some(h)) => Ok(Some(h)),
                        _ => Err(WaitError::Cancelled),
                    };
                }
                Ok(_) => self.client.stop_prompt(&id).await,
                Err(_) => {}
            }
        }
        let now = awake_now();
        if let Some(e) = self.clock.over_limit(now, self.limits) {
            self.client.stop_prompt(&id).await;
            return Err(e);
        }
        if history_ok && !cancel && self.clock.queue_check_due(now) {
            // Queue first, then history again: ComfyUI writes the history entry in the same locked step
            // that takes the prompt off the running list, so a prompt that just finished is never taken
            // for a vanished one.
            if let Ok(st) = self.client.prompt_state(&id).await {
                if !self.clock.observe(st, now) {
                    return match self.client.history(&id).await {
                        Ok(Some(h)) => Ok(Some(h)),
                        Ok(None) => Err(WaitError::Vanished),
                        Err(_) => Ok(None), // unknown: the next poll decides
                    };
                }
            }
        }
        Ok(None)
    }
}

/// Queue items are `[number, prompt_id, prompt, extra_data, outputs_to_execute, ...]`.
pub fn queue_ids_of(v: &Value) -> Vec<String> {
    ["queue_running", "queue_pending"]
        .iter()
        .filter_map(|k| v.get(*k).and_then(|q| q.as_array()))
        .flatten()
        .filter_map(|item| item.get(1).and_then(|id| id.as_str()).map(|s| s.to_string()))
        .collect()
}

fn has_node_errors(v: &Value) -> bool {
    v.get("node_errors").and_then(|n| n.as_object()).map(|o| !o.is_empty()).unwrap_or(false)
}

/// Readable text for a /prompt rejection: error.message, error.details, then one line per node
/// (`{class_type} ({id}): {message} - {details}`). Falls back to the raw JSON.
pub fn format_rejection(v: &Value) -> String {
    let mut lines: Vec<String> = Vec::new();
    let s = |x: Option<&Value>| x.and_then(|m| m.as_str()).map(|m| m.trim().to_string()).filter(|m| !m.is_empty());
    if let Some(m) = s(v.pointer("/error/message")) {
        lines.push(m);
    }
    if let Some(d) = s(v.pointer("/error/details")) {
        if !lines.contains(&d) {
            lines.push(d);
        }
    }
    if let Some(nodes) = v.get("node_errors").and_then(|n| n.as_object()) {
        let mut ids: Vec<&String> = nodes.keys().collect();
        ids.sort();
        for id in ids {
            let n = &nodes[id];
            let class = n.get("class_type").and_then(|c| c.as_str()).unwrap_or("?");
            let errs = n.get("errors").and_then(|e| e.as_array()).cloned().unwrap_or_default();
            if errs.is_empty() {
                lines.push(format!("{class} ({id})"));
            }
            for e in errs {
                let msg = s(e.get("message")).unwrap_or_default();
                match s(e.get("details")) {
                    Some(d) => lines.push(format!("{class} ({id}): {msg} - {d}")),
                    None => lines.push(format!("{class} ({id}): {msg}")),
                }
            }
        }
    }
    if lines.is_empty() {
        return if v.is_null() { "prompt rejected".into() } else { v.to_string() };
    }
    lines.join("\n")
}

fn too_large_message(size: u64, own_server: bool) -> String {
    let mb = size / MIB;
    if own_server {
        format!("音声ファイルが大きすぎて ComfyUI にアップロードできません（{mb} MB / 上限 {} MB）", super::process::MAX_UPLOAD_MB)
    } else {
        format!("音声ファイル（{mb} MB）が ComfyUI のアップロード上限（--max-upload-size、既定 {COMFY_DEFAULT_UPLOAD_MB} MB）を超えています。ComfyUI をこのアプリから起動するか、上限を広げて起動してください")
    }
}

/// LoadAudio value from an /upload/image reply: `subfolder/name`, or just `name`.
pub fn load_value_from_upload(v: &Value, fallback_name: &str) -> String {
    let name = v.get("name").and_then(|n| n.as_str()).unwrap_or(fallback_name);
    match v.get("subfolder").and_then(|s| s.as_str()).filter(|s| !s.is_empty()) {
        Some(sub) => format!("{}/{name}", sub.trim_end_matches(['/', '\\'])),
        None => name.to_string(),
    }
}

/// File-name-safe, ASCII-only version of a basename: other characters become '_', '..' cannot
/// survive (ComfyUI's /view rejects it), and the stem is capped at 40 characters.
pub fn sanitize_basename(name: &str) -> String {
    let p = Path::new(name);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("");
    let clean = |t: &str| -> String {
        let mut out = String::new();
        for c in t.chars() {
            let c = if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' };
            if !(c == '_' && out.ends_with('_')) {
                out.push(c);
            }
        }
        out.trim_matches('_').to_string()
    };
    let mut stem: String = clean(stem).chars().take(40).collect();
    if stem.is_empty() {
        stem = "audio".into();
    }
    let ext: String = clean(ext).chars().take(8).collect();
    if ext.is_empty() {
        stem
    } else {
        format!("{stem}.{}", ext.to_ascii_lowercase())
    }
}

/// Content-addressed staging name: `<sha256 first 16 hex>_<sanitized basename>`.
pub fn staged_name(sha256_hex: &str, basename: &str) -> String {
    format!("{}_{}", &sha256_hex[..16.min(sha256_hex.len())], sanitize_basename(basename))
}

pub fn file_sha256(path: &Path) -> Result<String> {
    let mut f = std::fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}

/// Copy `src` into `<input_dir>/mcs_uploads/<staged_name>` (skipped when that content is already
/// there). Returns the file name inside the subfolder.
///
/// A copy, not a hard link: the app later rewrites some sources in place (e.g. vocals.wav on
/// re-separation), which would silently change the content behind a content-addressed name.
/// The copy's mtime is set to now (also when an existing copy is reused) so the periodic cleanup
/// ages files by staging time; std::fs::copy keeps the source's read-only attribute and mtime on
/// Windows, so the attribute is cleared first (otherwise the mtime cannot be written).
pub fn stage_local(input_dir: &Path, src: &Path) -> Result<String> {
    let base = src.file_name().and_then(|n| n.to_str()).unwrap_or("audio.wav");
    let name = staged_name(&file_sha256(src)?, base);
    let dir = input_dir.join(UPLOAD_SUBFOLDER);
    std::fs::create_dir_all(&dir)?;
    let dest = dir.join(&name);
    let src_len = std::fs::metadata(src)?.len();
    let reusable = std::fs::metadata(&dest).map(|m| m.is_file() && m.len() == src_len).unwrap_or(false);
    if !reusable {
        let tmp: PathBuf = dir.join(format!("{name}.{}.part", uuid::Uuid::new_v4().simple()));
        if let Err(e) = std::fs::copy(src, &tmp) {
            let _ = std::fs::remove_file(&tmp); // a copy that failed part-way (disk full) leaves no .part behind
            return Err(anyhow!(e).context(format!("copy {} -> {}", src.display(), tmp.display())));
        }
        clear_readonly(&tmp);
        if let Err(e) = std::fs::rename(&tmp, &dest) {
            // Another stage of the same content may have won the race; that file is identical.
            let _ = std::fs::remove_file(&tmp);
            if !dest.is_file() {
                return Err(anyhow!(e).context(format!("rename to {}", dest.display())));
            }
        }
    }
    clear_readonly(&dest); // copies staged before this fix may still be read-only
    if let Ok(f) = std::fs::OpenOptions::new().write(true).open(&dest) {
        let _ = f.set_modified(SystemTime::now());
    }
    Ok(name)
}

fn clear_readonly(path: &Path) {
    if let Ok(m) = std::fs::metadata(path) {
        let mut perm = m.permissions();
        if perm.readonly() {
            #[allow(clippy::permissions_set_readonly_false)]
            perm.set_readonly(false);
            let _ = std::fs::set_permissions(path, perm);
        }
    }
}

/// Make a local audio file loadable by LoadAudio and return the LoadAudio value
/// (`mcs_uploads/<name>`). The file is staged straight into the input directory the app passes to
/// ComfyUI (no size limit, no in-memory copy, unique per content so queued prompts never load
/// another song's audio); when ComfyUI does not see it there (a server started with another input
/// directory) it falls back to the HTTP upload under the same name. The upload is also tried when the
/// copy fails; if that fails too, the copy's error (e.g. a full disk) leads the message for the app's
/// own ComfyUI, whose upload writes to the same folder. Another server reads its own input folder, so
/// there its upload error (e.g. its upload cap) leads and the copy's error follows. `own_server`: see
/// upload_input.
pub async fn stage_input(client: &ComfyClient, input_dir: &Path, path: &Path, own_server: bool) -> Result<String> {
    let (dir, src) = (input_dir.to_path_buf(), path.to_path_buf());
    let local = tokio::task::spawn_blocking(move || stage_local(&dir, &src)).await.map_err(|e| anyhow!("{e}"))?;
    match local {
        Ok(name) => {
            if client.input_visible(UPLOAD_SUBFOLDER, &name).await {
                return Ok(format!("{UPLOAD_SUBFOLDER}/{name}"));
            }
            log::warn!("staged input {name} is not visible to ComfyUI; falling back to HTTP upload");
            client.upload_input(path, &name, own_server).await
        }
        Err(e) => {
            log::warn!("staging {} failed ({e:#}); falling back to HTTP upload", path.display());
            let base = path.file_name().and_then(|n| n.to_str()).unwrap_or("audio.wav").to_string();
            let p = path.to_path_buf();
            let hash = tokio::task::spawn_blocking(move || file_sha256(&p)).await.map_err(|e| anyhow!("{e}"))??;
            client.upload_input(path, &staged_name(&hash, &base), own_server).await.map_err(|u| {
                let folder = input_dir.join(UPLOAD_SUBFOLDER);
                if own_server {
                    anyhow!("音声ファイルを ComfyUI の入力フォルダ（{}）にコピーできませんでした: {e:#}（HTTP アップロードも失敗: {u:#}）", folder.display())
                } else {
                    anyhow!("{u:#}（{} へのコピーも失敗: {e:#}）", folder.display())
                }
            })
        }
    }
}

/// A name stage_local writes in mcs_uploads (the HTTP upload uses the same names): a staged copy
/// `<16 lowercase hex>_<sanitize_basename>` (a stem of [A-Za-z0-9_-], 1 to 40 characters, then an optional
/// lowercase `.<ext>` of up to 8), or the `<staged copy>.<32 hex>.part` an interrupted copy left behind.
/// The uninstaller holds a copy of this rule (hooks.nsh McsIsStagedName; checked by lib.rs
/// the_uninstallers_name_rules_are_the_apps with tools/uninstall_name_cases.txt): change both together.
pub(crate) fn is_staged_upload_name(name: &str) -> bool {
    let lower_hex = |t: &str, len: usize| t.len() == len && t.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    let word = |t: &str, max: usize| (1..=max).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    let staged = |n: &str| {
        let Some((hash, base)) = n.split_once('_') else { return false };
        let (stem, ext) = base.split_once('.').map_or((base, None), |(s, e)| (s, Some(e)));
        lower_hex(hash, 16) && word(stem, 40) && ext.is_none_or(|e| word(e, 8) && !e.bytes().any(|b| b.is_ascii_uppercase()))
    };
    match name.strip_suffix(".part").and_then(|n| n.rsplit_once('.')) {
        Some((copy, uuid)) => lower_hex(uuid, 32) && staged(copy),
        None => staged(name),
    }
}

/// Delete staged inputs (is_staged_upload_name) older than `max_age` at the top of mcs_uploads (callers make
/// sure no prompt is queued). Anything else there is someone else's: an export or a diagnostic bundle saved
/// while the folder was the song folder (楽曲の保存先), whatever it is now.
pub fn cleanup_uploads(input_dir: &Path, max_age: Duration) -> usize {
    let dir = input_dir.join(UPLOAD_SUBFOLDER);
    let Ok(rd) = std::fs::read_dir(&dir) else { return 0 };
    let now = SystemTime::now();
    let mut removed = 0;
    for e in rd.flatten() {
        if !is_staged_upload_name(&e.file_name().to_string_lossy()) {
            continue;
        }
        let p = e.path();
        let old = e
            .metadata()
            .ok()
            .filter(|m| m.is_file())
            .and_then(|m| m.modified().ok())
            .and_then(|t| now.duration_since(t).ok())
            .map(|age| age > max_age)
            .unwrap_or(false);
        if old && std::fs::remove_file(&p).is_ok() {
            removed += 1;
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn too_large_names_our_cap_only_for_our_server() {
        let own = too_large_message(300 * 1024 * 1024, true);
        assert!(own.contains("300 MB") && own.contains(&format!("{} MB", super::super::process::MAX_UPLOAD_MB)));
        let other = too_large_message(300 * 1024 * 1024, false);
        assert!(other.contains("300 MB") && other.contains("--max-upload-size") && !other.contains("2048"));
    }

    #[test]
    fn rejection_message_lists_details_and_nodes() {
        let v = json!({
            "error": { "type": "prompt_outputs_failed_validation", "message": "Prompt outputs failed validation",
                       "details": "Value not in list: ckpt_name: 'x.safetensors' not in [...]" },
            "node_errors": {
                "loader": { "class_type": "CheckpointLoaderSimple", "dependent_outputs": ["save"],
                            "errors": [{ "type": "value_not_in_list", "message": "Value not in list", "details": "ckpt_name: 'x.safetensors' not in [...]" }] },
                "sampler": { "class_type": "KSampler", "errors": [{ "message": "Value bigger than max", "details": "" }] }
            }
        });
        let m = format_rejection(&v);
        let lines: Vec<&str> = m.lines().collect();
        assert_eq!(lines[0], "Prompt outputs failed validation");
        assert!(lines[1].starts_with("Value not in list: ckpt_name"));
        assert_eq!(lines[2], "CheckpointLoaderSimple (loader): Value not in list - ckpt_name: 'x.safetensors' not in [...]");
        assert_eq!(lines[3], "KSampler (sampler): Value bigger than max");
    }

    #[test]
    fn rejection_message_for_partial_200_and_fallbacks() {
        // HTTP 200 with node_errors (some outputs valid): no top-level error object.
        let v = json!({ "prompt_id": "p", "number": 3, "node_errors": { "save": { "class_type": "MCS_SaveAudioWav", "errors": [{ "message": "Required input is missing", "details": "audio" }] } } });
        assert!(has_node_errors(&v));
        assert_eq!(format_rejection(&v), "MCS_SaveAudioWav (save): Required input is missing - audio");
        assert!(!has_node_errors(&json!({ "prompt_id": "p", "node_errors": {} })));
        assert_eq!(format_rejection(&Value::Null), "prompt rejected");
        let raw = json!({ "weird": 1 });
        assert_eq!(format_rejection(&raw), raw.to_string());
        // missing_node_type: message only, node_errors empty
        let v = json!({ "error": { "type": "missing_node_type", "message": "Node 'X' not found", "details": "Node ID '#a'" }, "node_errors": {} });
        assert_eq!(format_rejection(&v), "Node 'X' not found\nNode ID '#a'");
    }

    #[test]
    fn reset_heuristic_uses_the_cap_of_the_server() {
        // Our own server accepts up to MAX_UPLOAD_MB: a 150 MB reset is not "too large" there.
        assert!(!reset_means_too_large(150 * MIB, true, false));
        assert!(reset_means_too_large((super::super::process::MAX_UPLOAD_MB as u64 + 1) * MIB, true, false));
        // Another server: ComfyUI's default cap.
        assert!(reset_means_too_large(150 * MIB, false, false));
        assert!(!reset_means_too_large(50 * MIB, false, false));
        // An unreachable server is never that.
        assert!(!reset_means_too_large(150 * MIB, false, true));
        assert!(too_large_message(150 * MIB, false).contains(&format!("既定 {COMFY_DEFAULT_UPLOAD_MB} MB")));
    }

    #[test]
    fn prompt_state_reads_running_and_pending() {
        let v = json!({ "queue_running": [[1, "a", {}, {}, []]], "queue_pending": [[2, "b", {}, {}, []]] });
        assert_eq!(prompt_state_of(&v, "a"), QueuedState::Running);
        assert_eq!(prompt_state_of(&v, "b"), QueuedState::Pending);
        assert_eq!(prompt_state_of(&v, "c"), QueuedState::Absent);
        assert_eq!(prompt_state_of(&json!({}), "a"), QueuedState::Absent);
    }

    #[test]
    fn history_failure_kinds() {
        assert_eq!(history_failure(&json!({ "status": { "status_str": "success", "messages": [] } })), None);
        let e = json!({ "status": { "status_str": "error", "messages": [["execution_start", {}], ["execution_interrupted", {}]] } });
        assert_eq!(history_failure(&e), Some(PromptFailure::Interrupted));
        let e = json!({ "status": { "status_str": "error", "messages": [["execution_error", { "node_type": "KSampler", "exception_message": "oom" }]] } });
        assert_eq!(history_failure(&e), Some(PromptFailure::Error("KSampler: oom".into())));
        assert_eq!(history_failure(&json!({ "status": { "status_str": "error" } })), Some(PromptFailure::Unknown));
        assert_eq!(history_failure(&json!({})), Some(PromptFailure::Unknown));
    }

    #[test]
    fn execution_seconds_from_history_timestamps() {
        let e = json!({ "status": { "messages": [
            ["execution_start", { "prompt_id": "p", "timestamp": 1_000_000u64 }],
            ["execution_cached", { "nodes": [], "timestamp": 1_000_010u64 }],
            ["execution_success", { "prompt_id": "p", "timestamp": 1_095_500u64 }]
        ] } });
        assert_eq!(execution_seconds(&e), Some(95.5));
        let e = json!({ "status": { "messages": [["execution_start", { "timestamp": 1000 }], ["execution_error", { "timestamp": 3000 }]] } });
        assert_eq!(execution_seconds(&e), Some(2.0));
        assert_eq!(execution_seconds(&json!({ "status": { "messages": [["execution_start", {}]] } })), None);
        assert_eq!(execution_seconds(&json!({})), None);
    }

    #[test]
    fn outputs_are_read_by_node() {
        let o = json!({ "abc_preview": { "text": ["X:1", "K:C"] }, "save": { "audio": [{ "filename": "a.wav", "subfolder": "mcs", "type": "output" }] } });
        assert_eq!(text_output(&o, "abc_preview").as_deref(), Some("X:1\nK:C"));
        assert_eq!(text_output(&o, "save"), None);
        let f = audio_outputs(&o, "save");
        assert_eq!((f.len(), f[0].filename.as_str(), f[0].subfolder.as_str()), (1, "a.wav", "mcs"));
        assert!(audio_outputs(&o, "nope").is_empty());
    }

    #[test]
    fn own_output_path_only_for_our_files() {
        let root = std::env::temp_dir().join(format!("mcs_own_out_{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(root.join("mcs")).unwrap();
        std::fs::create_dir_all(root.join("mcs_sep")).unwrap();
        std::fs::write(root.join("mcs").join("0473_00001_.wav"), b"x").unwrap();
        std::fs::write(root.join("mcs_sep").join("ab_vocals_00001_.wav"), b"x").unwrap();
        std::fs::write(root.join("user.wav"), b"x").unwrap();
        let f = |name: &str, sub: &str, kind: &str| OutputFile { filename: name.into(), subfolder: sub.into(), kind: kind.into() };
        assert_eq!(own_output_path(&root, &f("0473_00001_.wav", "mcs", "output")), Some(root.join("mcs").join("0473_00001_.wav")));
        assert_eq!(own_output_path(&root, &f("ab_vocals_00001_.wav", "mcs_sep", "")), Some(root.join("mcs_sep").join("ab_vocals_00001_.wav")));
        // Not ours: the root of the output folder, another type, escapes, missing files.
        assert_eq!(own_output_path(&root, &f("user.wav", "", "output")), None);
        assert_eq!(own_output_path(&root, &f("0473_00001_.wav", "mcs", "temp")), None);
        assert_eq!(own_output_path(&root, &f("../user.wav", "mcs", "output")), None);
        assert_eq!(own_output_path(&root, &f("user.wav", "mcs/..", "output")), None);
        assert_eq!(own_output_path(&root, &f("x.wav", "mcs", "output")), None);
        assert_eq!(own_output_path(&root, &f("0473_00001_.wav", "mcsx", "output")), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn prompt_clock_excludes_the_queue_wait() {
        let t0 = Instant::now();
        let at = |s: u64| t0 + Duration::from_secs(s);
        let limits = WaitLimits { run_secs: 1800, wait_secs: 3 * 3600 };
        let mut c = PromptClock::new(t0);
        assert!(c.queue_check_due(t0));
        // Pending behind a long generation for 40 minutes: no run timeout, the run clock restarts.
        assert!(c.observe(QueuedState::Pending, at(2400)));
        assert!(!c.queue_check_due(at(2402)));
        assert!(c.queue_check_due(at(2405)));
        assert_eq!(c.over_limit(at(2401), limits), None);
        assert!(c.observe(QueuedState::Running, at(2405)));
        assert!((c.run_seconds(at(2500)) - 100.0).abs() < 1e-9);
        // Once running, the queue is looked up rarely, and the run limit counts from the start.
        assert!(!c.queue_check_due(at(2420)));
        assert!(c.queue_check_due(at(2435)));
        assert_eq!(c.over_limit(at(2400 + 1800), limits), None);
        assert_eq!(c.over_limit(at(2400 + 1801), limits), Some(WaitError::RunTimeout));
        assert!(!c.observe(QueuedState::Absent, at(2500)));
        // Still pending after the wait limit: given up as a queue wait, not as a run timeout.
        let mut c = PromptClock::new(t0);
        c.observe(QueuedState::Pending, at(3 * 3600 + 1));
        assert_eq!(c.over_limit(at(3 * 3600 + 1), limits), Some(WaitError::WaitTimeout));
        // Never looked up (queue errors): the run limit counts from queueing, as before.
        let c = PromptClock::new(t0);
        assert_eq!(c.over_limit(at(1801), limits), Some(WaitError::RunTimeout));
        assert!(WaitError::RunTimeout.message("処理", 1800).contains("30 分以内"));
    }

    #[test]
    fn prompt_clock_on_awake_time_survives_a_sleep() {
        let t0 = Instant::now();
        let limits = WaitLimits { run_secs: 3600, wait_secs: 3 * 3600 };
        let mut c = PromptClock::new(awake_instant(t0, 0, 0));
        c.observe(QueuedState::Running, awake_instant(t0, 0, 0));
        // 10 minutes of work, 3 hours asleep, then the first poll after waking: the unbiased interrupt
        // time (100 ns ticks) advanced by the 10 minutes awake only, so the run goes on.
        let woke = awake_instant(t0, 0, 600 * 10_000_000);
        assert_eq!(c.over_limit(woke, limits), None);
        assert!((c.run_seconds(woke) - 600.0).abs() < 1e-6);
        // On std's Instant, which counts the sleep, the same poll stopped the run.
        assert_eq!(c.over_limit(t0 + Duration::from_secs(600 + 3 * 3600), limits), Some(WaitError::RunTimeout));
        // While the PC is awake, awake_now keeps pace with Instant.
        let (a, i) = (awake_now(), Instant::now());
        std::thread::sleep(Duration::from_millis(300));
        let (da, di) = (awake_now().saturating_duration_since(a), i.elapsed());
        assert!(da + Duration::from_millis(100) >= di && da <= di + Duration::from_millis(100), "{da:?} vs {di:?}");
    }

    #[test]
    fn history_wait_reads_the_awake_clock() {
        // A test process does not sleep, so awake_now() and Instant::now() agree there and no poll test
        // can tell them apart: the clock HistoryWait feeds its PromptClock is pinned in the source.
        let src = include_str!("client.rs");
        let imp = &src[src.find("impl<'a> HistoryWait<'a> {").expect("impl HistoryWait")..];
        let imp = &imp[..imp.find("\n}\n").unwrap() + 3];
        let body = |sig: &str| {
            let s = &imp[imp.find(sig).unwrap_or_else(|| panic!("{sig}"))..];
            s[..s.find("\n    }\n").unwrap()].to_string()
        };
        assert!(body("pub fn new(").contains("PromptClock::new(awake_now())"));
        assert!(body("pub fn run_seconds(").contains("self.clock.run_seconds(awake_now())"));
        let poll = body("pub async fn poll(");
        assert!(poll.contains("let now = awake_now();"));
        for call in ["self.clock.over_limit(now,", "self.clock.queue_check_due(now)", "self.clock.observe(st, now)"] {
            assert!(poll.contains(call), "{call}");
        }
        assert!(!imp.contains("Instant::now()"));
    }

    /// Answers every request with `status` and `body` (a tiny stand-in for ComfyUI's /view).
    async fn serve_bytes(status: &'static str, body: Vec<u8>) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = [0u8; 4096];
                let _ = sock.read(&mut buf).await;
                let head = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                let _ = sock.write_all(head.as_bytes()).await;
                let _ = sock.write_all(&body).await;
            }
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn downloads_are_committed_all_or_nothing() {
        let d = std::env::temp_dir().join(format!("mcs-commit-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&d).unwrap();
        let (v, i) = (d.join("vocals.wav"), d.join("instrumental.wav"));
        let (tv, ti) = (d.join("v.part"), d.join("i.part"));
        let names = || {
            let mut n: Vec<String> = std::fs::read_dir(&d).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
            n.sort();
            n
        };
        // First separation: nothing to replace.
        std::fs::write(&tv, b"v1").unwrap();
        std::fs::write(&ti, b"i1").unwrap();
        commit_downloads(&[(tv.clone(), v.clone()), (ti.clone(), i.clone())]).await.unwrap();
        // Again: both replaced, no .bak or .part left.
        std::fs::write(&tv, b"v2").unwrap();
        std::fs::write(&ti, b"i2").unwrap();
        commit_downloads(&[(tv.clone(), v.clone()), (ti.clone(), i.clone())]).await.unwrap();
        assert_eq!((std::fs::read(&v).unwrap(), std::fs::read(&i).unwrap()), (b"v2".to_vec(), b"i2".to_vec()));
        assert_eq!(names(), ["instrumental.wav", "vocals.wav"]);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // instrumental.wav open in a player that does not share delete access: nothing is replaced.
            let lock = std::fs::OpenOptions::new().read(true).share_mode(1 /* FILE_SHARE_READ */).open(&i).unwrap();
            std::fs::write(&tv, b"v3").unwrap();
            std::fs::write(&ti, b"i3").unwrap();
            let e = commit_downloads(&[(tv.clone(), v.clone()), (ti.clone(), i.clone())]).await.unwrap_err();
            assert!(format!("{e:#}").contains("instrumental.wav"), "{e:#}");
            drop(lock);
            assert_eq!((std::fs::read(&v).unwrap(), std::fs::read(&i).unwrap()), (b"v2".to_vec(), b"i2".to_vec()));
            assert_eq!(names(), ["instrumental.wav", "vocals.wav"]);
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn download_replaces_dest_atomically() {
        let root = std::env::temp_dir().join(format!("mcs_dl_{}", uuid::Uuid::new_v4().simple()));
        let dest = root.join("sub").join("song.wav");
        let f = OutputFile { filename: "a.wav".into(), subfolder: "mcs".into(), kind: "output".into() };
        let ok = ComfyClient::new(serve_bytes("200 OK", vec![7u8; 300_000]).await);
        assert_eq!(ok.download_view(&f, &dest).await.unwrap(), 300_000);
        assert_eq!(std::fs::read(&dest).unwrap(), vec![7u8; 300_000]);
        // A failed download keeps the previous file and leaves no .part behind.
        let bad = ComfyClient::new(serve_bytes("404 Not Found", b"missing".to_vec()).await);
        let e = bad.download_view(&f, &dest).await.unwrap_err();
        assert!(format!("{e:#}").contains("出力ファイルを取得できませんでした"));
        assert_eq!(std::fs::read(&dest).unwrap().len(), 300_000);
        let parts = || std::fs::read_dir(dest.parent().unwrap()).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".part")).count();
        assert_eq!(parts(), 0);
        // Temp + commit: nothing changes until the commit.
        let (tmp, n) = ok.download_view_to_temp(&f, &dest).await.unwrap();
        assert_eq!((n, parts()), (300_000, 1));
        std::fs::write(&dest, b"old").unwrap();
        commit_download(&tmp, &dest).await.unwrap();
        assert_eq!((std::fs::read(&dest).unwrap().len(), parts()), (300_000, 0));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A scripted stand-in for ComfyUI: each "METHOD /path" answers from its own list of (status, body)
    /// replies, one per request (the last one repeats; other routes get 404). Returns the base URL and
    /// the log of requests ("METHOD /path", without the query).
    async fn serve_script(routes: Vec<(String, Vec<(&'static str, String)>)>) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        let (base, log, _) = serve_script_recording(routes).await;
        (base, log)
    }

    /// Requests a scripted server received: (request target with its query, body).
    type Received = std::sync::Arc<std::sync::Mutex<Vec<(String, Vec<u8>)>>>;

    /// serve_script that also records each request's target and body.
    async fn serve_script_recording(routes: Vec<(String, Vec<(&'static str, String)>)>) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>, Received) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let log = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let seen = log.clone();
        let received: Received = Default::default();
        let got = received.clone();
        let mut routes: std::collections::HashMap<String, std::collections::VecDeque<(&'static str, String)>> =
            routes.into_iter().map(|(k, v)| (k, v.into())).collect();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                // Read the head, then the body (Content-Length), before answering.
                let mut req = Vec::new();
                let mut buf = [0u8; 4096];
                let head_end = loop {
                    let Ok(n) = sock.read(&mut buf).await else { break None };
                    if n == 0 {
                        break None;
                    }
                    req.extend_from_slice(&buf[..n]);
                    if let Some(i) = req.windows(4).position(|w| w == b"\r\n\r\n") {
                        break Some(i + 4);
                    }
                };
                let Some(head_end) = head_end else { continue };
                let head = String::from_utf8_lossy(&req[..head_end]).to_string();
                let len = head
                    .lines()
                    .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                    .unwrap_or(0);
                while req.len() < head_end + len {
                    match sock.read(&mut buf).await {
                        Ok(n) if n > 0 => req.extend_from_slice(&buf[..n]),
                        _ => break,
                    }
                }
                let mut first = head.lines().next().unwrap_or("").split(' ');
                let (method, target) = (first.next().unwrap_or(""), first.next().unwrap_or(""));
                let key = format!("{method} {}", target.split('?').next().unwrap_or(""));
                seen.lock().unwrap().push(key.clone());
                got.lock().unwrap().push((target.to_string(), req[head_end.min(req.len())..].to_vec()));
                let (status, body) = match routes.get_mut(&key) {
                    Some(q) if q.len() > 1 => q.pop_front().unwrap(),
                    Some(q) if !q.is_empty() => q[0].clone(),
                    _ => ("404 Not Found", String::new()),
                };
                let resp = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = sock.write_all(resp.as_bytes()).await;
            }
        });
        (format!("http://{addr}"), log, received)
    }

    const PID: &str = "3f2b8c1e-0000-4000-8000-000000000001";
    const LIMITS: WaitLimits = WaitLimits { run_secs: 1800, wait_secs: 3 * 3600 };

    fn queue_body(running: &[&str], pending: &[&str]) -> String {
        let items = |ids: &[&str]| ids.iter().enumerate().map(|(i, id)| json!([i, id, {}, {}, []])).collect::<Vec<_>>();
        json!({ "queue_running": items(running), "queue_pending": items(pending) }).to_string()
    }

    fn history_body() -> String {
        json!({ PID: { "status": { "status_str": "success", "completed": true }, "outputs": {} } }).to_string()
    }

    fn requests(log: &std::sync::Mutex<Vec<String>>, key: &str) -> usize {
        log.lock().unwrap().iter().filter(|k| *k == key).count()
    }

    #[tokio::test]
    async fn history_wait_does_not_take_a_just_finished_prompt_for_a_vanished_one() {
        // Not in history yet, then gone from the queue: the second history lookup finds the entry.
        let (base, log) = serve_script(vec![
            (format!("GET /history/{PID}"), vec![("200 OK", "{}".into()), ("200 OK", history_body())]),
            ("GET /queue".into(), vec![("200 OK", queue_body(&[], &[]))]),
        ])
        .await;
        let c = ComfyClient::new(base);
        let mut w = HistoryWait::new(&c, PID, LIMITS);
        let entry = w.poll(false).await.unwrap().expect("the entry, not a vanished prompt");
        assert!(entry.get("outputs").is_some());
        let log = log.lock().unwrap().clone();
        assert_eq!(log, vec![format!("GET /history/{PID}"), "GET /queue".into(), format!("GET /history/{PID}")]);
    }

    #[tokio::test]
    async fn history_wait_reports_a_prompt_removed_without_history() {
        let (base, _log) = serve_script(vec![
            (format!("GET /history/{PID}"), vec![("200 OK", "{}".into())]),
            ("GET /queue".into(), vec![("200 OK", queue_body(&[], &[]))]),
        ])
        .await;
        let c = ComfyClient::new(base);
        let mut w = HistoryWait::new(&c, PID, LIMITS);
        assert_eq!(w.poll(false).await, Err(WaitError::Vanished));
    }

    #[tokio::test]
    async fn history_wait_keeps_waiting_while_queued_and_looks_up_the_queue_rarely() {
        let (base, log) = serve_script(vec![
            (format!("GET /history/{PID}"), vec![("200 OK", "{}".into())]),
            ("GET /queue".into(), vec![("200 OK", queue_body(&["other"], &[PID]))]),
        ])
        .await;
        let c = ComfyClient::new(base);
        let mut w = HistoryWait::new(&c, PID, LIMITS);
        assert_eq!(w.poll(false).await, Ok(None));
        assert_eq!(w.poll(false).await, Ok(None));
        // The second poll came within PENDING_CHECK_INTERVAL: history only.
        assert_eq!(requests(&log, "GET /queue"), 1);
        assert_eq!(requests(&log, &format!("GET /history/{PID}")), 2);
        assert!(!w.clock.running);
    }

    #[tokio::test]
    async fn history_wait_cancel_stops_the_prompt_then_ends_once_it_left_the_queue() {
        let (base, log) = serve_script(vec![
            (format!("GET /history/{PID}"), vec![("200 OK", "{}".into())]),
            ("GET /queue".into(), vec![("200 OK", queue_body(&[], &[PID])), ("200 OK", queue_body(&[], &[]))]),
            ("POST /queue".into(), vec![("200 OK", "{}".into())]),
            ("POST /interrupt".into(), vec![("200 OK", "{}".into())]),
        ])
        .await;
        let c = ComfyClient::new(base);
        let mut w = HistoryWait::new(&c, PID, LIMITS);
        // Still pending: stopped (targeted), keep waiting for it to leave the queue.
        assert_eq!(w.poll(true).await, Ok(None));
        assert_eq!((requests(&log, "POST /queue"), requests(&log, "POST /interrupt")), (1, 1));
        // Gone and no history entry: cancelled (not vanished), and not stopped again.
        assert_eq!(w.poll(true).await, Err(WaitError::Cancelled));
        assert_eq!(requests(&log, "POST /queue"), 1);
    }

    #[tokio::test]
    async fn history_wait_cancel_that_finished_anyway_returns_the_entry() {
        let (base, _log) = serve_script(vec![
            (format!("GET /history/{PID}"), vec![("200 OK", "{}".into()), ("200 OK", history_body())]),
            ("GET /queue".into(), vec![("200 OK", queue_body(&[], &[]))]),
        ])
        .await;
        let c = ComfyClient::new(base);
        let mut w = HistoryWait::new(&c, PID, LIMITS);
        assert!(w.poll(true).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn history_wait_applies_the_limits_while_history_fails() {
        // /history answers 500 but the server is alive: the limits still apply (not Lost).
        let (base, log) = serve_script(vec![
            (format!("GET /history/{PID}"), vec![("500 Internal Server Error", "{}".into())]),
            ("GET /system_stats".into(), vec![("200 OK", json!({ "system": {}, "devices": [] }).to_string())]),
            ("POST /queue".into(), vec![("200 OK", "{}".into())]),
            ("POST /interrupt".into(), vec![("200 OK", "{}".into())]),
        ])
        .await;
        let ago = |s: u64| awake_now().checked_sub(Duration::from_secs(s)).unwrap();
        let tiny = WaitLimits { run_secs: 1, wait_secs: 1 };
        let c = ComfyClient::new(base);
        // Within the limits: keep waiting, and no queue lookup on a failed history poll.
        let mut w = HistoryWait::new(&c, PID, LIMITS);
        assert_eq!(w.poll(false).await, Ok(None));
        assert_eq!((requests(&log, "GET /system_stats"), requests(&log, "GET /queue")), (1, 0));
        // Never seen running and queued too long ago: a queue-wait timeout, and the prompt is stopped.
        let mut w = HistoryWait::new(&c, PID, tiny);
        w.clock = PromptClock::new(ago(10));
        assert_eq!(w.poll(false).await, Err(WaitError::WaitTimeout));
        assert_eq!((requests(&log, "POST /queue"), requests(&log, "POST /interrupt")), (1, 1));
        // Seen running for too long: a run timeout.
        let mut w = HistoryWait::new(&c, PID, tiny);
        w.clock = PromptClock::new(ago(10));
        w.clock.running = true;
        assert_eq!(w.poll(false).await, Err(WaitError::RunTimeout));
        // /history fails and the server does not answer either: the connection is lost.
        let (base, _log) = serve_script(vec![(format!("GET /history/{PID}"), vec![("500 Internal Server Error", "{}".into())])]).await;
        let c = ComfyClient::new(base);
        let mut w = HistoryWait::new(&c, PID, LIMITS);
        assert!(matches!(w.poll(false).await, Err(WaitError::Lost(_))));
    }

    #[test]
    fn queue_ids_read_index_one() {
        let v = json!({ "queue_running": [[1, "a", {}, {}, []]], "queue_pending": [[2, "b", {}, {}, []], [3, "c"]] });
        assert_eq!(queue_ids_of(&v), vec!["a", "b", "c"]);
        assert!(queue_ids_of(&json!({})).is_empty());
    }

    #[test]
    fn upload_reply_builds_subfolder_path() {
        assert_eq!(load_value_from_upload(&json!({ "name": "n.wav", "subfolder": "mcs_uploads", "type": "input" }), "x"), "mcs_uploads/n.wav");
        assert_eq!(load_value_from_upload(&json!({ "name": "n.wav", "subfolder": "" }), "x"), "n.wav");
        assert_eq!(load_value_from_upload(&json!({}), "x.wav"), "x.wav");
    }

    #[test]
    fn sanitize_removes_dotdot_and_non_ascii() {
        assert_eq!(sanitize_basename("demo..final.wav"), "demo_final.wav");
        assert_eq!(sanitize_basename("Yesterday....WAV"), "Yesterday.wav");
        assert_eq!(sanitize_basename("夜の歌.flac"), "audio.flac");
        assert_eq!(sanitize_basename("my song (live).mp3"), "my_song_live.mp3");
        assert_eq!(sanitize_basename("noext"), "noext");
        assert_eq!(sanitize_basename(&format!("{}.wav", "a".repeat(80))).len(), 44);
        let n = staged_name("0123456789abcdef0123", "song.wav");
        assert_eq!(n, "0123456789abcdef_song.wav");
        assert!(!n.contains(".."));
    }

    #[test]
    fn stage_local_is_content_addressed_and_idempotent() {
        let root = std::env::temp_dir().join(format!("mcs_stage_test_{}", uuid::Uuid::new_v4().simple()));
        let src_dir = root.join("a");
        let src_dir2 = root.join("b");
        std::fs::create_dir_all(&src_dir).unwrap();
        std::fs::create_dir_all(&src_dir2).unwrap();
        let input = root.join("input");
        let a = src_dir.join("song.wav");
        let b = src_dir2.join("song.wav");
        std::fs::write(&a, b"AAAA").unwrap();
        std::fs::write(&b, b"BBBB").unwrap();
        let na = stage_local(&input, &a).unwrap();
        let nb = stage_local(&input, &b).unwrap();
        assert_ne!(na, nb, "same basename, different content -> different names");
        assert_eq!(stage_local(&input, &a).unwrap(), na);
        assert_eq!(std::fs::read(input.join(UPLOAD_SUBFOLDER).join(&na)).unwrap(), b"AAAA");
        assert_eq!(std::fs::read(input.join(UPLOAD_SUBFOLDER).join(&nb)).unwrap(), b"BBBB");
        // Fresh files survive the cleanup; with a zero age everything goes.
        assert_eq!(cleanup_uploads(&input, Duration::from_secs(24 * 3600)), 0);
        assert!(std::fs::read_dir(input.join(UPLOAD_SUBFOLDER)).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().ends_with(".part")));
        std::thread::sleep(Duration::from_millis(20));
        assert_eq!(cleanup_uploads(&input, Duration::from_millis(1)), 2);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The song folder (楽曲の保存先) was comfy_input\mcs_uploads earlier and is elsewhere now: the exports and
    /// diagnostic bundles saved there stay. Only what stage_local writes (a staged copy, a .part an interrupted copy
    /// left) is pruned, and only at the top of the folder.
    #[test]
    fn the_uploads_prune_removes_only_staged_copies() {
        let (root, src) = source_file("my song.wav", b"SONG");
        let input = root.join("input");
        let dir = input.join(UPLOAD_SUBFOLDER);
        let staged = stage_local(&input, &src).unwrap();
        let hash = file_sha256(&src).unwrap();
        let ours = [
            staged.clone(),
            format!("{staged}.{}.part", uuid::Uuid::new_v4().simple()),
            staged_name(&hash, "夜の歌.flac"),
            staged_name(&hash, "noext"),
            staged_name(&hash, &format!("{}_b.wav", "a".repeat(39))), // the stem cut at 40 ends with '_'
            format!("{}.{}.part", staged_name(&hash, "Take 2.WAV"), uuid::Uuid::new_v4().simple()),
        ];
        let users = [
            "My Song.mp3",
            "mcs-diagnostics-20261001-120000.zip",
            "export.flac",
            "export.mcs-tmp.0123abcd.flac",
            "0123456789ABCDEF_take.wav",
            "0123456789abcde_song.wav",
            "0123456789abcdef_",
            "0123456789abcdef_my song.wav",
            "0123456789abcdef_song.wav.part",
            "0123456789abcdef_song.wav.0123.part",
            "0123456789abcdef_song.wav.bak",
            "0123456789abcdef_song.WAV",
            "2026-10-01/0123456789abcdef_song.wav",
        ];
        for f in ours.iter().map(String::as_str).chain(users) {
            let p = dir.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            if !p.exists() {
                std::fs::write(p, b"x").unwrap();
            }
        }
        assert_eq!(cleanup_uploads(&input, Duration::from_secs(6 * 3600)), 0, "nothing is old yet");
        std::thread::sleep(Duration::from_millis(20));
        assert_eq!(cleanup_uploads(&input, Duration::from_millis(1)), ours.len());
        let gone = |f: &str| !dir.join(f).exists();
        assert!(ours.iter().all(|f| gone(f)), "{:?}", ours.iter().filter(|f| !gone(f)).collect::<Vec<_>>());
        assert!(!users.iter().any(|f| gone(f)), "{:?}", users.iter().filter(|f| gone(f)).collect::<Vec<_>>());
        // Every name staged_name can give (and its .part) is one the prune knows.
        let long = format!("{}.abcdefg-hij", "x".repeat(100));
        for base in ["", ".wav", "a.b.c.WAV", "夜の歌", "__.mp3", "x.part", "song.abcdefg_h", long.as_str()] {
            let n = staged_name(&hash, base);
            assert!(is_staged_upload_name(&n), "{n}");
            assert!(is_staged_upload_name(&format!("{n}.{}.part", uuid::Uuid::new_v4().simple())), "{n}");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn staged_copy_of_a_read_only_old_source_is_aged_by_staging_time() {
        let root = std::env::temp_dir().join(format!("mcs_stage_ro_{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&root).unwrap();
        let src = root.join("old.wav");
        std::fs::write(&src, b"OLD").unwrap();
        let old = SystemTime::now() - Duration::from_secs(400 * 24 * 3600);
        std::fs::OpenOptions::new().write(true).open(&src).unwrap().set_modified(old).unwrap();
        let mut perm = std::fs::metadata(&src).unwrap().permissions();
        perm.set_readonly(true);
        std::fs::set_permissions(&src, perm).unwrap();
        let input = root.join("input");
        let name = stage_local(&input, &src).unwrap();
        let dest = input.join(UPLOAD_SUBFOLDER).join(&name);
        let m = std::fs::metadata(&dest).unwrap();
        assert!(!m.permissions().readonly(), "the staged copy must be writable");
        let age = SystemTime::now().duration_since(m.modified().unwrap()).unwrap_or_default();
        assert!(age < Duration::from_secs(3600), "mtime is the staging time, not the source's ({age:?})");
        assert_eq!(cleanup_uploads(&input, Duration::from_secs(6 * 3600)), 0);
        let mut perm = std::fs::metadata(&src).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perm.set_readonly(false);
        std::fs::set_permissions(&src, perm).unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A temporary folder with one source audio file `name` in it.
    fn source_file(name: &str, data: &[u8]) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("mcs_stage_in_{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&root).unwrap();
        let src = root.join(name);
        std::fs::write(&src, data).unwrap();
        (root, src)
    }

    /// The query of a recorded request target, as (key, value) pairs in order.
    fn query_of(target: &str) -> Vec<(String, String)> {
        reqwest::Url::parse(&format!("http://x{target}")).unwrap().query_pairs().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    /// The value of one text field of a multipart/form-data body.
    fn form_field(body: &str, name: &str) -> Option<String> {
        let head = format!("name=\"{name}\"\r\n\r\n");
        let start = body.find(&head)? + head.len();
        Some(body[start..].split("\r\n").next()?.to_string())
    }

    #[tokio::test]
    async fn stage_input_uses_the_staged_copy_comfyui_can_see() {
        let (root, src) = source_file("my song.wav", b"AUDIO-1");
        let input = root.join("input");
        let (base, log, received) = serve_script_recording(vec![("HEAD /view".into(), vec![("200 OK", String::new())])]).await;
        let value = stage_input(&ComfyClient::new(base), &input, &src, true).await.unwrap();
        let name = staged_name(&file_sha256(&src).unwrap(), "my song.wav");
        assert_eq!(value, format!("{UPLOAD_SUBFOLDER}/{name}"));
        assert_eq!(std::fs::read(input.join(UPLOAD_SUBFOLDER).join(&name)).unwrap(), b"AUDIO-1");
        // One HEAD for exactly that file in the input folder, and no upload.
        assert_eq!(*log.lock().unwrap(), vec!["HEAD /view".to_string()]);
        let target = received.lock().unwrap()[0].0.clone();
        let q = query_of(&target);
        assert_eq!(q, [("filename".into(), name.clone()), ("subfolder".into(), UPLOAD_SUBFOLDER.into()), ("type".into(), "input".into())]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn stage_input_uploads_what_comfyui_cannot_see() {
        // Another server with its own input folder: HEAD /view answers 404, so the file is uploaded under
        // the same content-addressed name, and the LoadAudio value comes from the server's reply.
        let (root, src) = source_file("take.wav", b"AUDIO-2");
        let input = root.join("input");
        let reply = json!({ "name": "renamed.wav", "subfolder": UPLOAD_SUBFOLDER, "type": "input" }).to_string();
        let (base, log, received) = serve_script_recording(vec![("POST /upload/image".into(), vec![("200 OK", reply)])]).await;
        let value = stage_input(&ComfyClient::new(base), &input, &src, false).await.unwrap();
        assert_eq!(value, format!("{UPLOAD_SUBFOLDER}/renamed.wav"));
        assert_eq!(*log.lock().unwrap(), vec!["HEAD /view".to_string(), "POST /upload/image".into()]);
        let name = staged_name(&file_sha256(&src).unwrap(), "take.wav");
        let body = String::from_utf8_lossy(&received.lock().unwrap()[1].1).to_string();
        assert!(body.contains(&format!("name=\"image\"; filename=\"{name}\"")), "{body}");
        assert!(body.contains("AUDIO-2"), "{body}");
        assert_eq!(form_field(&body, "type").as_deref(), Some("input"));
        assert_eq!(form_field(&body, "subfolder").as_deref(), Some(UPLOAD_SUBFOLDER));
        assert_eq!(form_field(&body, "overwrite").as_deref(), Some("true"));
        // Over the server's upload cap (HTTP 413): the "too large" message for that server.
        let (base, _log) = serve_script(vec![("POST /upload/image".into(), vec![("413 Request Entity Too Large", String::new())])]).await;
        let e = stage_input(&ComfyClient::new(base), &input, &src, false).await.unwrap_err();
        assert_eq!(e.to_string(), too_large_message(std::fs::metadata(&src).unwrap().len(), false));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn stage_input_names_the_staging_failure_when_the_upload_fails_too() {
        let (root, src) = source_file("song.wav", b"AUDIO-3");
        // The input folder cannot be created (a file is in the way), as when the data drive is full or
        // not writable: the HTTP fallback is still tried.
        let input = root.join("input");
        std::fs::write(&input, b"not a folder").unwrap();
        let (base, log) = serve_script(vec![("POST /upload/image".into(), vec![("500 Internal Server Error", "{}".into())])]).await;
        let e = stage_input(&ComfyClient::new(base), &input, &src, true).await.unwrap_err();
        let m = format!("{e:#}");
        assert!(m.starts_with("音声ファイルを ComfyUI の入力フォルダ"), "{m}");
        assert!(m.contains(&input.join(UPLOAD_SUBFOLDER).display().to_string()) && m.contains("os error"), "{m}");
        assert!(m.contains("HTTP アップロードも失敗") && m.contains("500"), "{m}");
        assert_eq!(requests(&log, "POST /upload/image"), 1);
        // A server this app did not start reads its own input folder, not this one: its answer (here its
        // upload cap) leads, and the copy error only follows.
        let (base, _log) = serve_script(vec![("POST /upload/image".into(), vec![("413 Request Entity Too Large", String::new())])]).await;
        let e = stage_input(&ComfyClient::new(base), &input, &src, false).await.unwrap_err();
        let m = format!("{e:#}");
        assert!(m.starts_with(&too_large_message(std::fs::metadata(&src).unwrap().len(), false)), "{m}");
        assert!(m.contains(&input.join(UPLOAD_SUBFOLDER).display().to_string()) && m.contains("os error"), "{m}");
        assert!(!m.contains("ComfyUI の入力フォルダ"), "{m}");
        // The fallback alone succeeding is still a success.
        let reply = json!({ "name": "n.wav", "subfolder": UPLOAD_SUBFOLDER }).to_string();
        let (base, _log) = serve_script(vec![("POST /upload/image".into(), vec![("200 OK", reply)])]).await;
        assert_eq!(stage_input(&ComfyClient::new(base), &input, &src, true).await.unwrap(), format!("{UPLOAD_SUBFOLDER}/n.wav"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn commit_keeps_the_users_own_bak_files() {
        let d = std::env::temp_dir().join(format!("mcs-commit-bak-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&d).unwrap();
        let (v, tv, mine) = (d.join("vocals.wav"), d.join("v.part"), d.join("vocals.wav.bak"));
        let names = || {
            let mut n: Vec<String> = std::fs::read_dir(&d).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
            n.sort();
            n
        };
        std::fs::write(&v, b"v1").unwrap();
        std::fs::write(&mine, b"mine").unwrap();
        std::fs::write(&tv, b"v2").unwrap();
        commit_downloads(&[(tv.clone(), v.clone())]).await.unwrap();
        assert_eq!(std::fs::read(&v).unwrap(), b"v2");
        assert_eq!(std::fs::read(&mine).unwrap(), b"mine", "a file the app did not create is never removed");
        assert_eq!(names(), ["vocals.wav", "vocals.wav.bak"]);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // A failed commit (vocals.wav locked) keeps it too.
            let lock = std::fs::OpenOptions::new().read(true).share_mode(1 /* FILE_SHARE_READ */).open(&v).unwrap();
            std::fs::write(&tv, b"v3").unwrap();
            assert!(commit_downloads(&[(tv.clone(), v.clone())]).await.is_err());
            drop(lock);
            assert_eq!((std::fs::read(&v).unwrap(), std::fs::read(&mine).unwrap()), (b"v2".to_vec(), b"mine".to_vec()));
            assert_eq!(names(), ["vocals.wav", "vocals.wav.bak"]);
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn https_trusts_the_windows_certificate_store_and_the_built_in_roots() {
        // Setup downloads and cloud LLM calls must accept a root that antivirus HTTPS scanning or corporate
        // TLS inspection put into the Windows store (rustls-tls-native-roots), and keep the webpki roots
        // ("rustls-tls") for a fresh Windows whose store is filled only on demand.
        let toml = include_str!("../../Cargo.toml");
        let line = toml.lines().find(|l| l.starts_with("reqwest ")).expect("reqwest dependency");
        assert!(line.contains("\"rustls-tls\"") && line.contains("\"rustls-tls-native-roots\""), "{line}");
        // A default client reads the store, which must not fail here.
        reqwest::Client::builder().build().unwrap();
    }

    /// The test binary itself, running only test `name` with `env` set: proxy variables are process-wide,
    /// so a test that sets them must not share the process with the others.
    fn run_test_in_child(name: &str, env: &[(&str, &str)]) -> std::process::Output {
        let mut cmd = std::process::Command::new(std::env::current_exe().unwrap());
        cmd.args(["--exact", name, "--nocapture", "--test-threads=1"]).env("MCS_TEST_CHILD", name);
        for k in ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"] {
            cmd.env_remove(k);
        }
        cmd.envs(env.iter().copied()).output().unwrap()
    }

    #[tokio::test]
    async fn comfy_client_ignores_the_proxy_variables() {
        const NAME: &str = "comfy::client::tests::comfy_client_ignores_the_proxy_variables";
        if std::env::var("MCS_TEST_CHILD").as_deref() == Ok(NAME) {
            // In the child: HTTP_PROXY / ALL_PROXY name a port nothing listens on.
            let (base, _log) = serve_script(vec![("GET /system_stats".into(), vec![("200 OK", json!({ "system": {}, "devices": [] }).to_string())])]).await;
            assert!(reqwest::Client::new().get(format!("{base}/system_stats")).send().await.is_err(), "the proxy variables are not in effect");
            ComfyClient::new(base).system_stats().await.expect("ComfyClient must reach the loopback server directly");
            return;
        }
        let dead = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap(); // closed once dropped
        let proxy = format!("http://{dead}");
        let out = run_test_in_child(NAME, &[("HTTP_PROXY", &proxy), ("ALL_PROXY", &proxy), ("NO_PROXY", "localhost")]);
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(out.status.success() && stdout.contains("1 passed"), "{stdout}\n{}", String::from_utf8_lossy(&out.stderr));
    }

    #[tokio::test]
    async fn free_explains_a_stopped_hung_or_failing_comfyui() {
        let (base, log) = serve_script(vec![("POST /free".into(), vec![("200 OK", "{}".into())])]).await;
        ComfyClient::new(base).free(true).await.unwrap();
        assert_eq!(requests(&log, "POST /free"), 1);
        // 「VRAM を解放」 shows the outermost message: a stopped ComfyUI is named, not reqwest's text.
        let dead = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap(); // closed once dropped
        let e = ComfyClient::new(format!("http://{dead}")).free(true).await.unwrap_err();
        assert_eq!(e.to_string(), "ComfyUI に接続できません（停止しています）");
        // An error status is a failure, not 「VRAM を解放しました」.
        let (base, _log) = serve_script(vec![("POST /free".into(), vec![("500 Internal Server Error", "{}".into())])]).await;
        let e = ComfyClient::new(base).free(true).await.unwrap_err().to_string();
        assert!(e.contains("HTTP 500"), "{e}");
        // A server that takes the connection but never answers is given up (10 s in the app).
        let silent = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = silent.local_addr().unwrap();
        let hold = tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((s, _)) = silent.accept().await {
                held.push(s);
            }
        });
        let t0 = Instant::now();
        let e = ComfyClient::new(format!("http://{addr}")).free_within(true, Duration::from_millis(300)).await.unwrap_err().to_string();
        assert!(e.contains("応答しませんでした") && t0.elapsed() < Duration::from_secs(5), "{e}");
        hold.abort();
        assert_eq!(FREE_TIMEOUT, Duration::from_secs(10));
    }
}
