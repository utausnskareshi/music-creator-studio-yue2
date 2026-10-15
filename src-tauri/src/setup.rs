//! First-run setup: download ComfyUI portable, model weights, ffmpeg, llama.cpp; extract; install
//! the bundled node pack; write extra_model_paths.yaml. Everything lives under the data root, in folders
//! and files the uninstaller knows (it removes only those, never the whole data root).

use crate::config::AppConfig;
use anyhow::{anyhow, bail, Context, Result};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::future::Future;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// The pinned ComfyUI release as a literal, so `concat!` can build the component strings from it.
macro_rules! comfyui_version {
    () => {
        "0.37.0"
    };
}

pub const COMFYUI_VERSION: &str = comfyui_version!();

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// Single file copied to `dest` (relative to data root, including file name).
    File,
    /// .7z archive extracted into `dest` directory using 7zr.exe.
    SevenZip,
    /// .zip archive extracted into `dest` directory (top-level folder stripped when `strip_root`).
    Zip,
    /// pip packages installed into ComfyUI's embedded Python. `url` holds the space-separated requirement list.
    Pip,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Component {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub url: &'static str,
    pub kind: Kind,
    pub dest: &'static str,
    /// Expected size in bytes (0 = unknown).
    pub size: u64,
    pub sha256: Option<&'static str>,
    pub required: bool,
    /// A file whose existence marks the component as installed (relative to data root).
    pub marker: &'static str,
    pub strip_root: bool,
}

pub fn components() -> Vec<Component> {
    vec![
        Component {
            id: "sevenzip",
            name: "7-Zip 展開ツール (7zr.exe)",
            description: "ComfyUI 本体の .7z を展開するための単体実行ファイル（LGPL）",
            // Versioned GitHub release asset (same bytes as 7-zip.org's 7zr.exe 26.03); size and sha256
            // from the release asset digest.
            url: "https://github.com/ip7z/7zip/releases/download/26.03/7zr.exe",
            kind: Kind::File,
            dest: "runtime/bin/7zr.exe",
            size: 602_624,
            sha256: Some("ad4c82fadcbdf93c03b4fc440f300509c7d60c5c2f4d183e35d9d70d6957037d"),
            required: true,
            marker: "runtime/bin/7zr.exe",
            strip_root: false,
        },
        Component {
            id: "comfyui",
            name: concat!("ComfyUI v", comfyui_version!(), " (Windows portable, NVIDIA)"),
            description: "Python 3.13 と PyTorch CUDA 13.0 を同梱。展開後 約 4.2GB",
            url: concat!("https://github.com/Comfy-Org/ComfyUI/releases/download/v", comfyui_version!(), "/ComfyUI_windows_portable_nvidia.7z"),
            kind: Kind::SevenZip,
            dest: "runtime",
            size: 1_925_204_508,
            // GitHub release asset digest of ComfyUI_windows_portable_nvidia.7z (v0.37.0).
            sha256: Some("7805f634fab51f63a238aaf0cfe2a9833bb7c86ddfc8400a60919f44460d7d65"),
            required: true,
            marker: "runtime/ComfyUI_windows_portable/ComfyUI/main.py",
            strip_root: false,
        },
        Component {
            id: "yue2_bf16",
            name: "YuE2-3B BF16 チェックポイント",
            description: "24GB VRAM 向けの標準精度モデル（7.8GB）",
            // Pinned to a commit together with the LFS sha256, so a re-upload or rename on `main` cannot break installs.
            url: "https://huggingface.co/Comfy-Org/YuE2/resolve/2f76ca75e6ee094169de899cc7fc99d6887e2196/checkpoints/yue2_3b_bf16.safetensors",
            kind: Kind::File,
            dest: "models/checkpoints/yue2_3b_bf16.safetensors",
            size: 7_799_983_228,
            sha256: Some("33765adbf9813c9a50318218760b2fd819a319862460a04884607581961c6fee"),
            required: true,
            marker: "models/checkpoints/yue2_3b_bf16.safetensors",
            strip_root: false,
        },
        Component {
            id: "yue2_int8",
            name: "YuE2-3B INT8 チェックポイント（省 VRAM）",
            description: "8〜16GB VRAM 向け（4.0GB）。24GB 機では任意",
            // Pinned to a commit together with the LFS sha256, so a re-upload or rename on `main` cannot break installs.
            url: "https://huggingface.co/Comfy-Org/YuE2/resolve/2f76ca75e6ee094169de899cc7fc99d6887e2196/checkpoints/yue2_3b_int8_convrot.safetensors",
            kind: Kind::File,
            dest: "models/checkpoints/yue2_3b_int8_convrot.safetensors",
            size: 3_960_938_800,
            sha256: Some("96fe199377309001ed8cd26a944baeee8cc31a20ba7c36d1d3c0a7e1f4149db6"),
            required: false,
            marker: "models/checkpoints/yue2_3b_int8_convrot.safetensors",
            strip_root: false,
        },
        Component {
            id: "sheetsage2",
            name: "SheetSage2 音声エンコーダ（カバー / 耳コピ用）",
            description: "既存音源をABC譜面に転写するモデル（1.4GB）",
            // Pinned to a commit together with the LFS sha256, so a re-upload or rename on `main` cannot break installs.
            url: "https://huggingface.co/Comfy-Org/YuE2/resolve/2f76ca75e6ee094169de899cc7fc99d6887e2196/audio_encoders/sheetsage2_bf16.safetensors",
            kind: Kind::File,
            dest: "models/audio_encoders/sheetsage2_bf16.safetensors",
            size: 1_386_868_122,
            sha256: Some("5fd960ce3df281e3f3a889d174584d88f96247711480cf96377b12d7e8b6adc5"),
            required: true,
            marker: "models/audio_encoders/sheetsage2_bf16.safetensors",
            strip_root: false,
        },
        Component {
            id: "ffmpeg",
            name: "ffmpeg 9.0（BtbN win64 GPL ビルド）",
            description: "MP3 / M4A / OGG / Opus / FLAC 変換とラウドネス正規化に使用",
            // BtbN keeps the month-end autobuilds long term (daily ones are pruned, "latest" moves).
            // size / sha256 from the release asset digest (also listed in that release's checksums.sha256).
            url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-31-13-27/ffmpeg-n9.0.1-11-ge47273f4d9-win64-gpl-9.0.zip",
            kind: Kind::Zip,
            dest: "runtime/ffmpeg",
            size: 169_202_846,
            sha256: Some("ec9db2cda1f5894ab95446076ad8bf49379db4b53c02e778ad3b49adf91fec83"),
            required: true,
            marker: "runtime/ffmpeg/bin/ffmpeg.exe",
            strip_root: true,
        },
        Component {
            id: "llama_server",
            name: "llama.cpp b11206（CUDA 13.4 Windows ビルド）",
            description: "AI 編集アシスタント用のローカル LLM サーバー",
            url: "https://github.com/ggml-org/llama.cpp/releases/download/b11206/llama-b11206-bin-win-cuda-13.4-x64.zip",
            kind: Kind::Zip,
            dest: "runtime/llama",
            size: 152_343_617,
            sha256: Some("1d775af6af5d034c602f780a3f0dabc9223ad740c0b8ed63fe2d21eeb67f0b86"),
            required: false,
            marker: "runtime/llama/llama-server.exe",
            strip_root: false,
        },
        Component {
            id: "llama_cudart",
            name: "CUDA ランタイム DLL（llama.cpp 用）",
            description: "cudart / cublas 13.4",
            url: "https://github.com/ggml-org/llama.cpp/releases/download/b11206/cudart-llama-bin-win-cuda-13.4-x64.zip",
            kind: Kind::Zip,
            dest: "runtime/llama",
            size: 423_535_356,
            sha256: Some("738f8c251ac22b70c3ae6f83a10cf222725df0395246a2cf58f32bdb85fbe668"),
            required: false,
            marker: "runtime/llama/cudart64_13.dll",
            strip_root: false,
        },
        Component {
            id: "audio_separator",
            name: "audio-separator（ボーカル分離ライブラリ）",
            description: "ComfyUI の Python に pip で導入します（BS-Roformer / MelBand-Roformer / Demucs）",
            // Top-level versions pinned to the tested set; pip -c keeps everything ComfyUI ships as it is.
            url: "audio-separator==0.47.0 onnxruntime==1.30.0 audioread==3.1.0",
            kind: Kind::Pip,
            dest: "",
            size: 0,
            sha256: None,
            required: false,
            marker: "runtime/ComfyUI_windows_portable/python_embeded/Lib/site-packages/audio_separator/__init__.py",
            strip_root: false,
        },
        Component {
            id: "bs_roformer",
            name: "BS-Roformer ボーカル分離モデル（Viperx 1297）",
            description: "最高品質クラスの分離モデル（640MB）。設定ファイルは初回使用時に自動取得",
            url: "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/model_bs_roformer_ep_317_sdr_12.9755.ckpt",
            kind: Kind::File,
            dest: "models/separation/model_bs_roformer_ep_317_sdr_12.9755.ckpt",
            size: 639_331_213,
            // No upstream digest to pin (the GitHub release asset's digest is null): checked by size only.
            sha256: None,
            required: false,
            marker: "models/separation/model_bs_roformer_ep_317_sdr_12.9755.ckpt",
            strip_root: false,
        },
        Component {
            id: "lyrics_align_pip",
            name: "同期歌詞アライメント用ライブラリ（pykakasi / pypinyin）",
            description: "日本語・中国語歌詞をローマ字化して MMS 強制アライメントに渡します（pip）",
            url: "pykakasi==2.3.0 pypinyin==0.55.0",
            kind: Kind::Pip,
            dest: "",
            size: 0,
            sha256: None,
            required: false,
            marker: "runtime/ComfyUI_windows_portable/python_embeded/Lib/site-packages/pykakasi/__init__.py",
            strip_root: false,
        },
        Component {
            id: "uroman_pip",
            name: "多言語ローマ字化（uroman）",
            description: "日本語・中国語以外の歌詞（韓国語・ロシア語など）を同期歌詞の整列に使えるようにします（pip、MIT 形式のライセンス）",
            // Pinned release (MMS_FA was trained on uroman's romanization). pip fetches the wheel itself; the
            // size is that of the wheel on PyPI, shown for information only.
            url: "uroman==1.3.1.1",
            kind: Kind::Pip,
            dest: "",
            size: 930_684,
            sha256: None,
            required: false,
            marker: "runtime/ComfyUI_windows_portable/python_embeded/Lib/site-packages/uroman/__init__.py",
            strip_root: false,
        },
        Component {
            id: "mms_fa",
            name: "MMS 強制アライメントモデル（Meta, 1.26GB）",
            description: "同期歌詞のタイミング検出に使用（torchaudio MMS_FA、CC-BY-NC 4.0）",
            url: "https://dl.fbaipublicfiles.com/mms/torchaudio/ctc_alignment_mling_uroman/model.pt",
            kind: Kind::File,
            dest: "models/torch/hub/checkpoints/model.pt",
            size: 1_262_047_414,
            // No upstream digest to pin (dl.fbaipublicfiles.com publishes none): checked by size only.
            sha256: None,
            required: false,
            marker: "models/torch/hub/checkpoints/model.pt",
            strip_root: false,
        },
        Component {
            id: "qwen3_14b",
            name: "Qwen3-14B Q4_K_M（GGUF、9.0GB）",
            description: "AI 編集アシスタントの既定モデル（日本語対応）",
            // Pinned to a commit together with the LFS sha256, so a re-upload on `main` cannot break installs.
            url: "https://huggingface.co/Qwen/Qwen3-14B-GGUF/resolve/530227a7d994db8eca5ab5ced2fb692b614357fd/Qwen3-14B-Q4_K_M.gguf",
            kind: Kind::File,
            dest: "models/llm/Qwen3-14B-Q4_K_M.gguf",
            size: 9_001_752_960,
            sha256: Some("500a8806e85ee9c83f3ae08420295592451379b4f8cf2d0f41c15dffeb6b81f0"),
            required: false,
            marker: "models/llm/Qwen3-14B-Q4_K_M.gguf",
            strip_root: false,
        },
    ]
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentStatus {
    #[serde(flatten)]
    pub component: Component,
    pub installed: bool,
    pub installed_bytes: u64,
}

/// Present while an archive component is being extracted or a pip component installed (removed only after
/// success). The installed marker of such a component is one of the files being written (a file inside the
/// archive, the package's `__init__.py`), so an interrupted run (power loss, the app closed, disk full, a
/// cancelled 7zr, pip killed with the app) would otherwise count as installed and never be repaired.
/// Installs made before the flag existed have none and stay installed.
fn extracting_flag(cfg: &AppConfig, id: &str) -> PathBuf {
    cfg.runtime_dir().join(".mcs_extracting").join(id)
}

pub fn status(cfg: &AppConfig) -> Vec<ComponentStatus> {
    components()
        .into_iter()
        .map(|c| {
            let marker = cfg.data_root.join(c.marker);
            let meta = std::fs::metadata(&marker).ok();
            let installed = match (&meta, c.kind) {
                (Some(m), Kind::File) => c.size == 0 || m.len() == c.size,
                (Some(_), Kind::Pip | Kind::SevenZip | Kind::Zip) => !extracting_flag(cfg, c.id).exists(),
                (None, _) => false,
            };
            ComponentStatus {
                installed_bytes: meta.map(|m| m.len()).unwrap_or(0),
                component: c,
                installed,
            }
        })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub id: String,
    /// download | verify | extract | done | error | cancelled
    pub phase: String,
    pub downloaded: u64,
    pub total: u64,
    pub bytes_per_sec: f64,
    pub message: String,
}

/// Where progress goes: the `setup://progress` event in the app (install), a recorder in the tests.
type Report<'a> = &'a (dyn Fn(Progress) + Send + Sync);

fn emit_message(report: Report<'_>, c: &Component, phase: &str, message: &str) {
    report(Progress { id: c.id.into(), phase: phase.into(), downloaded: 0, total: c.size, bytes_per_sec: 0.0, message: message.into() });
}

/// Error of a setup the user stopped with 中断. The downloaded `.part` files stay, so a new start resumes.
pub const CANCELLED_MSG: &str = "ユーザーが中断しました（再開できます）";

/// `e` (or an error it wraps) is the CANCELLED_MSG error of a 中断.
fn is_cancelled(e: &anyhow::Error) -> bool {
    e.chain().any(|c| c.to_string() == CANCELLED_MSG)
}

/// reqwest takes a proxy only from the environment (HTTPS_PROXY / ALL_PROXY, read once per run), never from the
/// Windows proxy settings.
pub(crate) const PROXY_HINT: &str = "プロキシ経由でしか接続できないネットワークでは、環境変数 HTTPS_PROXY を設定してからアプリを起動し直してください";

/// `e` or an error it wraps is a failed TLS certificate check (rustls: "invalid peer certificate: UnknownIssuer"),
/// typically antivirus HTTPS scanning or a TLS-inspecting proxy whose root is not trusted. reqwest's own text
/// ("error sending request for url ...") does not say so.
pub(crate) fn is_certificate_error(e: &(dyn std::error::Error + 'static)) -> bool {
    std::iter::successors(Some(e), |e| e.source()).any(|e| e.to_string().to_ascii_lowercase().contains("certificate"))
}

/// Message for a download that got no response at all, after the retries.
fn connect_failure_message(e: &(dyn std::error::Error + 'static)) -> String {
    if is_certificate_error(e) {
        "ダウンロード先の証明書を検証できません（ウイルス対策ソフトの HTTPS スキャンや社内プロキシを確認してください）".into()
    } else {
        format!("ダウンロードの接続に失敗しました（ネットワーク接続を確認してください。{PROXY_HINT}）")
    }
}

/// How often a wait (request, stream read, retry sleep, child process) looks at the cancel flag.
const CANCEL_POLL: Duration = Duration::from_millis(250);
/// Consecutive failed attempts without new bytes (stream breaks, retryable HTTP statuses, short bodies).
const MAX_FAILURES: u32 = 20;
/// Consecutive connection failures (no response at all, e.g. offline); reset by any response.
const MAX_CONNECT_FAILURES: u32 = 8;
/// Restarts from byte 0 after an HTTP 416 on a stale `.part`.
const MAX_RESTARTS: u32 = 5;
/// Free space kept on top of the estimate of a run that downloads (the extraction factors are rough).
const DISK_MARGIN_BYTES: u64 = 1 << 30;

/// Await `fut`, but give up with CANCELLED_MSG as soon as `cancel` is set (checked every CANCEL_POLL),
/// so neither a stalled connection nor a retry wait delays 中断.
async fn or_cancel<T>(cancel: &AtomicBool, fut: impl Future<Output = T>) -> Result<T> {
    tokio::pin!(fut);
    loop {
        if cancel.load(Ordering::Relaxed) {
            bail!(CANCELLED_MSG);
        }
        tokio::select! {
            v = &mut fut => return Ok(v),
            _ = tokio::time::sleep(CANCEL_POLL) => {}
        }
    }
}

async fn sleep_or_cancel(cancel: &AtomicBool, d: Duration) -> Result<()> {
    or_cancel(cancel, tokio::time::sleep(d)).await
}

/// Wait before retry `n` (1-based): 3, 6, 12, then 15 s.
fn backoff(n: u32) -> Duration {
    Duration::from_secs((3u64 << n.saturating_sub(1).min(3)).min(15))
}

/// Statuses a CDN returns for a passing problem; every other 4xx/5xx fails at once.
fn is_retryable_status(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 408 | 425 | 429 | 500 | 502 | 503 | 504)
}

/// A `Retry-After` in seconds (the HTTP-date form is ignored), capped at 60 s.
fn retry_after_secs(value: Option<&str>) -> Option<Duration> {
    let secs: u64 = value?.trim().parse().ok()?;
    Some(Duration::from_secs(secs.min(60)))
}

/// Install the given component ids in order. Already installed ones are skipped. `cancel` stops the run
/// between chunks, during retries and verification, and kills a 7zr extraction (the extraction flag keeps
/// such a component "not installed"); a pip run is left to finish. A failed optional component is recorded
/// and the rest still runs; a failed required component, or a cancel, ends the run at once.
pub async fn install(app: AppHandle, cfg: AppConfig, ids: Vec<String>, cancel: Arc<AtomicBool>) -> Result<()> {
    let report = |p: Progress| {
        let _ = app.emit("setup://progress", p);
    };
    let failed = install_components(&report, &cfg, &ids, &cancel).await?;
    finalize(&app, &cfg)?;
    if !failed.is_empty() {
        bail!("一部の任意コンポーネントを導入できませんでした（もう一度実行するか、チェックを外してください）:\n{}", failed.join("\n"));
    }
    Ok(())
}

/// The downloads, extractions and pip runs of `install`; returns the optional components that failed.
async fn install_components(report: Report<'_>, cfg: &AppConfig, ids: &[String], cancel: &Arc<AtomicBool>) -> Result<Vec<String>> {
    let all = components();
    let installed: HashSet<&'static str> = status(cfg).into_iter().filter(|s| s.installed).map(|s| s.component.id).collect();
    let mut order: Vec<Component> = Vec::new();
    for c in &all {
        if ids.iter().any(|i| i == c.id) && !installed.contains(c.id) {
            order.push(c.clone());
        }
    }
    // 7zr must come first if comfyui is requested.
    if order.iter().any(|c| c.kind == Kind::SevenZip) && !cfg.sevenzip_exe().is_file() && !order.iter().any(|c| c.id == "sevenzip") {
        order.insert(0, all.iter().find(|c| c.id == "sevenzip").unwrap().clone());
    }
    check_disk_space(cfg, &order)?;
    prepare_data_root(cfg)?;
    std::fs::create_dir_all(cfg.cache_dir()).with_context(|| format!("フォルダ {} を作成できません", cfg.cache_dir().display()))?;
    // No overall timeout: it would cut off the multi-GB transfers. read_timeout is per read (idle time).
    let client = reqwest::Client::builder()
        .user_agent(concat!("MusicCreatorStudioYuE2/", env!("CARGO_PKG_VERSION"), " (+https://github.com/utausnskareshi/music-creator-studio-yue2)"))
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(60))
        .build()?;

    let mut failed: Vec<String> = Vec::new();
    for c in order {
        if cancel.load(Ordering::Relaxed) {
            bail!(CANCELLED_MSG);
        }
        match install_one(report, cfg, &client, &c, cancel).await {
            Ok(()) => report(Progress { id: c.id.into(), phase: "done".into(), downloaded: c.size, total: c.size, bytes_per_sec: 0.0, message: "完了".into() }),
            // Only the cancel itself is neutral: a real failure after 中断 (pip, a checksum, a full disk) is
            // still shown as an error; the check at the top of the loop then ends the run.
            Err(e) if is_cancelled(&e) => {
                emit_message(report, &c, "cancelled", "中断しました。もう一度「ダウンロード開始」を押すと続きから再開します");
                bail!(CANCELLED_MSG);
            }
            Err(e) => {
                emit_message(report, &c, "error", &format!("{e:#}"));
                // Later steps depend on the required ones (7zr before ComfyUI, ComfyUI before pip).
                if c.required {
                    return Err(e);
                }
                failed.push(format!("{}: {e:#}", c.name));
            }
        }
    }
    Ok(failed)
}

/// Rough disk space a run still needs: what is left to download, plus the extracted size of archives
/// (ComfyUI's 1.9 GB .7z unpacks to about 4.2 GB) and the installed size of pip components (pip_footprint).
/// `existing` gives the bytes already on disk for a component's download (.part or finished file).
fn estimate_needed_bytes(order: &[Component], existing: impl Fn(&Component) -> u64) -> u64 {
    order
        .iter()
        .map(|c| {
            let rest = c.size.saturating_sub(existing(c));
            match c.kind {
                Kind::File => rest,
                Kind::SevenZip => rest + c.size * 23 / 10,
                Kind::Zip => rest + c.size * 3,
                Kind::Pip => pip_footprint(c),
            }
        })
        .sum()
}

/// Rough space a pip component takes in ComfyUI's site-packages (pip unpacks in %TEMP% and keeps no cache,
/// --no-cache-dir): the romanization packages are a few MB; audio-separator brings onnxruntime and other
/// dependencies. An unknown pip component gets the large estimate.
fn pip_footprint(c: &Component) -> u64 {
    match c.id {
        "lyrics_align_pip" | "uroman_pip" => 64 << 20,
        _ => 1 << 30,
    }
}

/// What `check_disk_space` asks for: the estimate plus DISK_MARGIN_BYTES when the run downloads or extracts
/// something (the margin covers the rough extraction factors; a pip-only run's estimate is its own margin).
/// 0 when nothing is left to do.
fn required_bytes(order: &[Component], existing: impl Fn(&Component) -> u64) -> u64 {
    let need = estimate_needed_bytes(order, existing);
    if need == 0 {
        return 0;
    }
    if order.iter().any(|c| c.kind != Kind::Pip) {
        need + DISK_MARGIN_BYTES
    } else {
        need
    }
}

/// Where a component's download lands (the final file, or the archive in cache/).
fn download_path(cfg: &AppConfig, c: &Component) -> PathBuf {
    match c.kind {
        Kind::File => cfg.data_root.join(c.dest),
        _ => cfg.cache_dir().join(c.url.rsplit('/').next().unwrap_or("download.bin")),
    }
}

fn part_path(path: &Path) -> PathBuf {
    path.with_extension(format!("{}.part", path.extension().and_then(|e| e.to_str()).unwrap_or("bin")))
}

/// `<name>.part.src` next to a `.part`: what it is being downloaded from (part_source).
fn part_source_path(part: &Path) -> PathBuf {
    let mut name = part.as_os_str().to_os_string();
    name.push(".src");
    PathBuf::from(name)
}

/// Identifies the file a `.part` belongs to: the pinned SHA256, or the URL and size when there is none.
/// The download names do not change between releases (ComfyUI_windows_portable_nvidia.7z, the checkpoint's
/// dest), so without it a `.part` left by an older app version would be resumed against the newly pinned
/// file and fail the hash only at the end.
fn part_source(c: &Component) -> String {
    match c.sha256 {
        Some(h) => format!("sha256 {h}"),
        None => format!("{} {}", c.url, c.size),
    }
}

/// The `.part` was started for `c` by this version (an older version wrote no `.part.src`).
fn part_matches_source(part: &Path, c: &Component) -> bool {
    std::fs::read_to_string(part_source_path(part)).is_ok_and(|s| s == part_source(c))
}

/// Fail before downloading when the data root's drive clearly lacks the space. Skipped when the free space
/// cannot be read (GetDiskFreeSpaceExW failed), so a query problem never blocks the setup.
fn check_disk_space(cfg: &AppConfig, order: &[Component]) -> Result<()> {
    let Some(free) = free_disk_bytes(&cfg.data_root) else { return Ok(()) };
    let need = space_needed(cfg, order);
    if need == 0 {
        return Ok(());
    }
    if free < need {
        let gib = |b: u64| b as f64 / 1024.0 / 1024.0 / 1024.0;
        bail!(
            "ディスクの空き容量が不足しています（必要 約 {:.1} GB、空き {:.1} GB）。{} のドライブの空きを増やすか、ダウンロードする項目を減らすか、データルートを変更してください",
            gib(need),
            gib(free),
            cfg.data_root.display()
        );
    }
    Ok(())
}

/// The free space check_disk_space asks for: required_bytes of what `order` still has to download and unpack.
/// A `.part` counts as done whether download_resumable resumes it or deletes it first (one started for another
/// file, or by an older version that wrote no `.part.src`): deleting it frees as many bytes as it holds, so either
/// way the run needs only the rest on top of it. The same goes for a file of another size under the final name
/// (the previous pin's model after an update), which download_resumable deletes before it starts.
fn space_needed(cfg: &AppConfig, order: &[Component]) -> u64 {
    required_bytes(order, |c| {
        if c.kind == Kind::Pip {
            return 0;
        }
        let path = download_path(cfg, c);
        let done = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        if c.size > 0 && done == c.size {
            return done;
        }
        done + std::fs::metadata(part_path(&path)).map(|m| m.len()).unwrap_or(0)
    })
}

/// Run blocking work that cannot be interrupted safely (pip), telling the user once that 中断 will apply
/// when it ends.
async fn run_blocking_noting_cancel<T: Send + 'static>(report: Report<'_>, c: &Component, cancel: &AtomicBool, f: impl FnOnce() -> T + Send + 'static) -> Result<T> {
    let mut handle = tokio::task::spawn_blocking(f);
    let mut noticed = false;
    loop {
        tokio::select! {
            r = &mut handle => return Ok(r?),
            _ = tokio::time::sleep(CANCEL_POLL) => {
                if !noticed && cancel.load(Ordering::Relaxed) {
                    noticed = true;
                    emit_message(report, c, "extract", "中断を受け付けました。現在のステップ（pip でのインストール）が終わり次第中断します");
                }
            }
        }
    }
}

async fn install_one(report: Report<'_>, cfg: &AppConfig, client: &reqwest::Client, c: &Component, cancel: &Arc<AtomicBool>) -> Result<()> {
    if c.kind == Kind::Pip {
        emit_message(report, c, "extract", "pip でインストール中（数分かかります）");
        let python = cfg.comfy_python();
        if !python.is_file() {
            bail!("ComfyUI が未導入のため pip パッケージを入れられません");
        }
        // Closing the app ends pip with it (job object): until pip succeeds, a package whose marker
        // (`__init__.py`) is already written counts as not installed and is installed again next time.
        let flag = extracting_flag(cfg, c.id);
        if let Some(p) = flag.parent() {
            std::fs::create_dir_all(p)?;
        }
        std::fs::write(&flag, c.url.as_bytes())?;
        let constraints_file = cfg.cache_dir().join(format!("pip-constraints-{}.txt", c.id));
        let py = python.clone();
        let requirements = c.url;
        // Not killed on cancel: pip is not transactional, and a half-done run can break the embedded Python.
        let (ok, out) = run_blocking_noting_cancel(report, c, cancel, move || -> Result<(bool, String)> {
            let constraints = write_pip_constraints(&py, requirements, &constraints_file);
            let owned = pip_install_args(requirements, constraints.as_deref());
            let refs: Vec<&str> = owned.iter().map(|s| s.as_str()).collect();
            let r = run_hidden_env(&py, &refs, PYTHON_UTF8_ENV);
            let _ = std::fs::remove_file(&constraints_file);
            r
        })
        .await??;
        if !ok {
            bail!("pip install に失敗しました: {out}");
        }
        std::fs::remove_file(&flag).with_context(|| format!("{} を削除できません", flag.display()))?;
        return Ok(());
    }
    let archive_path = download_path(cfg, c);
    if let Some(parent) = archive_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Verifies the SHA256 before the final name appears (download_resumable).
    download_resumable(report, client, c, &archive_path, cancel).await?;

    match c.kind {
        Kind::File | Kind::Pip => {}
        Kind::SevenZip | Kind::Zip => {
            let flag = extracting_flag(cfg, c.id);
            if let Some(p) = flag.parent() {
                std::fs::create_dir_all(p)?;
            }
            std::fs::write(&flag, archive_path.to_string_lossy().as_bytes())?;
            let dest = cfg.data_root.join(c.dest);
            std::fs::create_dir_all(&dest)?;
            let archive = archive_path.clone();
            let cc = cancel.clone();
            if c.kind == Kind::SevenZip {
                emit_message(report, c, "extract", "展開中（数分かかります）");
                let seven = cfg.sevenzip_exe();
                let out = tokio::task::spawn_blocking(move || {
                    let o = format!("-o{}", dest.display());
                    let a = archive.display().to_string();
                    run_controlled(&seven, &["x", "-y", "-sccUTF-8", &o, &a], &[], None, Some(&cc), OUTPUT_CAP)
                })
                .await??;
                match out.exit {
                    Exit::Finished(true) => {}
                    Exit::Cancelled => bail!(CANCELLED_MSG),
                    _ => bail!("7zr の展開に失敗しました: {}", out.tail_text()),
                }
            } else {
                emit_message(report, c, "extract", "展開中");
                let strip = c.strip_root;
                tokio::task::spawn_blocking(move || extract_zip(&archive, &dest, strip, Some(&cc))).await??;
            }
            // Flag first: if the app stops in between, the component counts as installed and only the
            // cached archive is left over (the other order would force a new download).
            std::fs::remove_file(&flag).with_context(|| format!("{} を削除できません", flag.display()))?;
            let _ = std::fs::remove_file(&archive_path);
        }
    }
    Ok(())
}

/// ComfyUI's launcher runs the embedded Python in UTF-8 mode too; without it a piped pip writes the ANSI
/// code page (cp932) and its error text arrives garbled.
const PYTHON_UTF8_ENV: &[(&str, &str)] = &[("PYTHONUTF8", "1"), ("PYTHONIOENCODING", "utf-8")];

/// argv for installing `requirements` (space separated) into ComfyUI's embedded Python.
/// `-s` ignores the user site-packages like the portable's own update scripts
/// (update/update.py, update_comfyui_and_python_dependencies.bat): ComfyUI is launched with `-s`,
/// so a package that pip finds only in %APPDATA%\Python would be "already satisfied" yet unimportable.
/// `--no-cache-dir`: the wheels are never used again and pip's cache (%LOCALAPPDATA%\pip) is outside the
/// data root. `--only-binary=:all:`: user PCs have no compiler. `-c` pins what the Python already has.
fn pip_install_args(requirements: &str, constraints: Option<&Path>) -> Vec<String> {
    let mut args: Vec<String> = ["-s", "-m", "pip", "install", "--no-cache-dir", "--only-binary=:all:", "--no-warn-script-location"].iter().map(|s| s.to_string()).collect();
    if let Some(c) = constraints {
        args.push("-c".into());
        args.push(c.to_string_lossy().to_string());
    }
    args.extend(requirements.split_whitespace().map(|s| s.to_string()));
    args
}

/// pip's normalised project name (PEP 503).
fn pip_name(s: &str) -> String {
    s.trim().to_ascii_lowercase().replace(['_', '.'], "-")
}

/// Project names requested by a requirement list ("audio-separator==0.47.0 onnxruntime==1.30.0").
fn requested_names(requirements: &str) -> HashSet<String> {
    requirements
        .split_whitespace()
        .map(|r| pip_name(r.split(|ch: char| "=<>!~[;@ ".contains(ch)).next().unwrap_or("")))
        .filter(|n| !n.is_empty())
        .collect()
}

/// Constraints that keep every installed package at its version (from `pip list --format=freeze`; plain
/// `pip freeze` writes `name @ file:///...` references of the portable's build machine), except the
/// packages being installed. pip then cannot up- or downgrade numpy, torch or anything else ComfyUI ships;
/// a conflict fails loudly (ResolutionImpossible) instead.
fn pip_constraints(freeze: &str, requirements: &str) -> String {
    let requested = requested_names(requirements);
    let mut out = String::new();
    for line in freeze.lines().map(str::trim) {
        let Some((name, version)) = line.split_once("==") else { continue };
        if name.is_empty() || version.trim().is_empty() || name.contains(' ') || requested.contains(&pip_name(name)) {
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// Write the constraints file for `requirements`; None (install without constraints) when pip list fails.
fn write_pip_constraints(python: &Path, requirements: &str, file: &Path) -> Option<PathBuf> {
    let listed = run_controlled(python, &["-s", "-m", "pip", "list", "--format=freeze", "--disable-pip-version-check"], PYTHON_UTF8_ENV, Some(Duration::from_secs(120)), None, OUTPUT_CAP);
    let text = match listed {
        Ok(out) if out.exit == Exit::Finished(true) => String::from_utf8_lossy(&out.stdout).to_string(),
        Ok(out) => {
            log::warn!("pip list failed ({:?}), installing without constraints: {}", out.exit, out.tail_text());
            return None;
        }
        Err(e) => {
            log::warn!("pip list failed, installing without constraints: {e:#}");
            return None;
        }
    };
    if let Some(p) = file.parent() {
        std::fs::create_dir_all(p).ok()?;
    }
    std::fs::write(file, pip_constraints(&text, requirements)).ok()?;
    Some(file.to_path_buf())
}

/// What to do with a leftover `.part` file before sending the first request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PartState {
    /// Resume from the current length (0 = fresh start).
    Resume,
    /// Already holds the whole expected file (e.g. the final rename failed last time).
    Complete,
    /// Larger than the expected file: stale or wrong, start over.
    Discard,
}

fn classify_part(part_len: u64, expected_size: u64) -> PartState {
    if expected_size > 0 && part_len == expected_size {
        PartState::Complete
    } else if expected_size > 0 && part_len > expected_size {
        PartState::Discard
    } else {
        PartState::Resume
    }
}

/// Complete length from a 416 response's `Content-Range: bytes */N` (RFC 9110 §14.4).
fn unsatisfied_range_total(content_range: &str) -> Option<u64> {
    let rest = content_range.trim().strip_prefix("bytes")?.trim_start();
    rest.strip_prefix("*/")?.trim().parse().ok()
}

/// What an HTTP 416 on a resumed request means for the `.part`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UnsatisfiedRange {
    /// The server's file is exactly the `.part`: rename it.
    Finish,
    /// Stale `.part` or unknown server length: start over from byte 0.
    Restart,
    /// The server reports a definite length that differs from the pinned size: re-downloading
    /// cannot help (it would only fetch the same wrong file again), so fail.
    SizeMismatch(u64),
}

fn on_unsatisfied_range(part_len: u64, expected_size: u64, complete_len: Option<u64>) -> UnsatisfiedRange {
    match complete_len {
        Some(n) if expected_size > 0 && n != expected_size => UnsatisfiedRange::SizeMismatch(n),
        Some(n) if n == part_len => UnsatisfiedRange::Finish,
        _ => UnsatisfiedRange::Restart,
    }
}

/// The server's complete length when it is known and differs from the pinned size (0 = not pinned).
fn server_size_mismatch(expected_size: u64, server_len: Option<u64>) -> Option<u64> {
    server_len.filter(|&n| expected_size > 0 && n != expected_size)
}

fn size_mismatch_error(c: &Component, server_len: u64) -> anyhow::Error {
    anyhow!(
        "配布元のファイルサイズ（{server_len} バイト）が想定（{} バイト）と異なります。配布元が更新された可能性があります。アプリの更新が必要な場合があります ({})",
        c.size,
        c.url
    )
}

/// Check `file` against the pinned SHA256 (no-op without one). A mismatch deletes the file; a cancel or an
/// I/O error keeps it (a `.part` is checked again on the next run).
async fn verify_sha256(report: Report<'_>, c: &Component, file: &Path, cancel: &Arc<AtomicBool>) -> Result<()> {
    let Some(expected) = c.sha256 else { return Ok(()) };
    report(Progress { id: c.id.into(), phase: "verify".into(), downloaded: 0, total: c.size, bytes_per_sec: 0.0, message: "SHA256 を検証中".into() });
    let path = file.to_path_buf();
    let cc = cancel.clone();
    let actual = tokio::task::spawn_blocking(move || sha256_file_cancellable(&path, Some(&cc))).await??;
    if actual != expected {
        let _ = std::fs::remove_file(file);
        bail!("SHA256 が一致しません（期待 {expected}、実際 {actual}）。ファイルを削除しました。再度実行してください。");
    }
    Ok(())
}

/// Verify a complete `.part`, then move it to its final name and report completion. The final name thus
/// only ever holds a verified file (status() counts a File component as installed by its size alone).
async fn finish_part(report: Report<'_>, c: &Component, part: &Path, path: &Path, len: u64, message: &str, cancel: &Arc<AtomicBool>) -> Result<()> {
    verify_sha256(report, c, part, cancel).await?;
    std::fs::rename(part, path)
        .with_context(|| format!("{} の名前変更に失敗しました（ウイルス対策ソフト等が使用中の可能性があります。再度実行してください）", part.display()))?;
    let _ = std::fs::remove_file(part_source_path(part));
    report(Progress { id: c.id.into(), phase: "download".into(), downloaded: len, total: len, bytes_per_sec: 0.0, message: message.into() });
    Ok(())
}

/// Download with HTTP Range resume into `path` (writes to `path.part`, verifies it, renames when complete).
async fn download_resumable(report: Report<'_>, client: &reqwest::Client, c: &Component, path: &Path, cancel: &Arc<AtomicBool>) -> Result<()> {
    if path.is_file() {
        let len = std::fs::metadata(path)?.len();
        if c.size == 0 || len == c.size {
            // Under its final name already: a finished archive in cache/, a file an older version renamed
            // before verifying, or one placed by hand.
            verify_sha256(report, c, path, cancel).await?;
            report(Progress { id: c.id.into(), phase: "download".into(), downloaded: len, total: len, bytes_per_sec: 0.0, message: "既にダウンロード済み".into() });
            return Ok(());
        }
        std::fs::remove_file(path)?;
    }
    let part = part_path(path);
    if part.exists() && !part_matches_source(&part, c) {
        log::warn!("download {}: the .part was started for another file (or by an older version), restarting", c.id);
        std::fs::remove_file(&part)?;
    }
    // Written before the first byte, so every .part this version leaves has one.
    let source_file = part_source_path(&part);
    std::fs::write(&source_file, part_source(c)).with_context(|| format!("{} に書き込めません", source_file.display()))?;
    let mut downloaded = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    match classify_part(downloaded, c.size) {
        PartState::Complete => return finish_part(report, c, &part, path, downloaded, "既にダウンロード済み", cancel).await,
        PartState::Discard => {
            log::warn!("download {}: .part is larger than expected ({downloaded} > {}), restarting", c.id, c.size);
            std::fs::remove_file(&part)?;
            downloaded = 0;
        }
        PartState::Resume => {}
    }
    let mut failures = 0u32;
    let mut connect_failures = 0u32;
    let mut restarts = 0u32;
    loop {
        if cancel.load(Ordering::Relaxed) {
            bail!(CANCELLED_MSG);
        }
        let attempt_start = downloaded;
        let mut req = client.get(c.url);
        if downloaded > 0 {
            req = req.header("Range", format!("bytes={downloaded}-"));
        }
        let resp = match or_cancel(cancel, req.send()).await? {
            Ok(r) => r,
            Err(e) => {
                connect_failures += 1;
                if connect_failures >= MAX_CONNECT_FAILURES {
                    let msg = connect_failure_message(&e);
                    return Err(anyhow!(e)).context(msg);
                }
                log::warn!("download {} connection attempt {connect_failures} failed: {e}", c.id);
                sleep_or_cancel(cancel, backoff(connect_failures)).await?;
                continue;
            }
        };
        connect_failures = 0;
        let status = resp.status();
        if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE && downloaded > 0 {
            // The range starts at or past EOF: the .part is either already complete (stream error after
            // the last byte, or a crash / locked file before the rename) or stale.
            let complete_len = resp.headers().get(reqwest::header::CONTENT_RANGE).and_then(|v| v.to_str().ok()).and_then(unsatisfied_range_total);
            match on_unsatisfied_range(downloaded, c.size, complete_len) {
                UnsatisfiedRange::Finish => return finish_part(report, c, &part, path, downloaded, "", cancel).await,
                UnsatisfiedRange::SizeMismatch(n) => {
                    let _ = std::fs::remove_file(&part);
                    return Err(size_mismatch_error(c, n));
                }
                UnsatisfiedRange::Restart => {}
            }
            log::warn!("download {}: HTTP 416 with a {downloaded}-byte .part (server length {complete_len:?}), restarting", c.id);
            let _ = std::fs::remove_file(&part);
            downloaded = 0;
            restarts += 1;
            if restarts > MAX_RESTARTS {
                bail!("HTTP {status} ({})", c.url);
            }
            continue;
        }
        if downloaded > 0 && status == reqwest::StatusCode::OK {
            // Server ignored Range: start over.
            downloaded = 0;
            let _ = std::fs::remove_file(&part);
        } else if is_retryable_status(status) {
            failures += 1;
            if failures >= MAX_FAILURES {
                bail!("HTTP {status} ({})", c.url);
            }
            let wait = retry_after_secs(resp.headers().get(reqwest::header::RETRY_AFTER).and_then(|v| v.to_str().ok())).unwrap_or_else(|| backoff(failures));
            log::warn!("download {}: HTTP {status}, retry {failures} in {wait:?}", c.id);
            drop(resp);
            sleep_or_cancel(cancel, wait).await?;
            continue;
        } else if !(status.is_success() || status == reqwest::StatusCode::PARTIAL_CONTENT) {
            bail!("HTTP {status} ({})", c.url);
        }
        // A 200 (or 206) whose length already disagrees with the pinned size would only produce the
        // wrong file, possibly after many full re-downloads: fail before transferring anything.
        // A resumed .part is then a prefix of a different file as well, so it goes too.
        if let Some(n) = server_size_mismatch(c.size, resp.content_length().map(|l| l + downloaded)) {
            let _ = std::fs::remove_file(&part);
            return Err(size_mismatch_error(c, n));
        }
        let total = if c.size > 0 {
            c.size
        } else {
            resp.content_length().map(|l| l + downloaded).unwrap_or(0)
        };
        let mut file = std::fs::OpenOptions::new().create(true).append(true).open(&part)?;
        let mut stream = resp.bytes_stream();
        let mut last_emit = std::time::Instant::now();
        let mut window_start = downloaded;
        let mut window_t = std::time::Instant::now();
        let mut failed = false;
        // read_timeout turns a stalled transfer into a stream error (resumed below); or_cancel keeps 中断
        // responsive while waiting for the next chunk.
        while let Some(chunk) = or_cancel(cancel, stream.next()).await? {
            match chunk {
                Ok(bytes) => {
                    file.write_all(&bytes).with_context(|| format!("{} に書き込めません（ディスクの空き容量を確認してください）", part.display()))?;
                    downloaded += bytes.len() as u64;
                }
                Err(e) => {
                    log::warn!("download {} stream error: {e}", c.id);
                    failed = true;
                    break;
                }
            }
            if last_emit.elapsed().as_millis() > 400 {
                let dt = window_t.elapsed().as_secs_f64().max(0.001);
                let bps = (downloaded - window_start) as f64 / dt;
                report(Progress { id: c.id.into(), phase: "download".into(), downloaded, total, bytes_per_sec: bps, message: String::new() });
                last_emit = std::time::Instant::now();
                window_start = downloaded;
                window_t = std::time::Instant::now();
            }
        }
        file.flush()?;
        drop(file);
        // A long download on a flaky line is never given up while every attempt makes progress.
        if downloaded > attempt_start {
            failures = 0;
        }
        if failed || (total > 0 && downloaded < total) {
            failures += 1;
            if failures >= MAX_FAILURES {
                if failed {
                    bail!("ダウンロードが繰り返し中断しました");
                }
                bail!("ダウンロードが途中で終了しました ({downloaded}/{total})");
            }
            sleep_or_cancel(cancel, backoff(failures)).await?;
            continue;
        }
        return finish_part(report, c, &part, path, downloaded, "", cancel).await;
    }
}

/// SHA256 of a file; `cancel` is checked between the 8 MiB reads (a 9 GB file takes tens of seconds).
fn sha256_file_cancellable(path: &Path, cancel: Option<&AtomicBool>) -> Result<String> {
    let mut f = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 8 * 1024 * 1024];
    loop {
        if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
            bail!(CANCELLED_MSG);
        }
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Extract a zip into `dest`. Each entry is written to `<name>.part` and renamed, so no file is left
/// truncated under its real name; `cancel` stops between entries (the extraction flag marks the rest).
fn extract_zip(archive: &Path, dest: &Path, strip_root: bool, cancel: Option<&AtomicBool>) -> Result<()> {
    let file = std::fs::File::open(archive)?;
    let mut zip = zip::ZipArchive::new(file)?;
    std::fs::create_dir_all(dest)?;
    for i in 0..zip.len() {
        if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
            bail!(CANCELLED_MSG);
        }
        let mut entry = zip.by_index(i)?;
        let Some(enclosed) = entry.enclosed_name() else { continue };
        let rel: PathBuf = if strip_root {
            let mut comps = enclosed.components();
            comps.next();
            comps.as_path().to_path_buf()
        } else {
            enclosed.to_path_buf()
        };
        if rel.as_os_str().is_empty() {
            continue;
        }
        let out = dest.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out)?;
        } else {
            if let Some(p) = out.parent() {
                std::fs::create_dir_all(p)?;
            }
            let mut name = out.file_name().unwrap_or_default().to_os_string();
            name.push(".part");
            let tmp = out.with_file_name(name);
            let mut f = std::fs::File::create(&tmp).with_context(|| format!("{} を作成できません", tmp.display()))?;
            std::io::copy(&mut entry, &mut f).with_context(|| format!("{} を展開できません（ディスクの空き容量を確認してください）", out.display()))?;
            drop(f);
            std::fs::rename(&tmp, &out).with_context(|| format!("{} を置き換えられません（使用中の可能性があります）", out.display()))?;
        }
    }
    Ok(())
}

/// Most of a child's output kept in memory per stream (the rest is read and dropped, except its last
/// TAIL_KEEP bytes for `tail_text`).
pub(crate) const OUTPUT_CAP: usize = 4 * 1024 * 1024;
/// End of a stream kept past the cap, and what `tail_text` decodes per stream: at least 2000 characters
/// even for 4-byte UTF-8.
const TAIL_KEEP: usize = 16 * 1024;
/// How long `run_controlled` waits for a killed child to end.
const KILL_WAIT: Duration = Duration::from_secs(5);

/// How a child started by `run_controlled` ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Exit {
    /// Exited on its own; `true` for a success status.
    Finished(bool),
    /// Killed after the timeout.
    TimedOut,
    /// Killed because the cancel flag was set.
    Cancelled,
}

pub(crate) struct Captured {
    pub exit: Exit,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    /// A stream was longer than the cap (the start is kept in `stdout` / `stderr`).
    pub truncated: bool,
    /// The last bytes of each stream beyond the cap (at most TAIL_KEEP; empty when not truncated).
    pub stdout_tail: Vec<u8>,
    pub stderr_tail: Vec<u8>,
}

impl Captured {
    /// The last 2000 characters of the whole output, stdout then stderr (error messages). Uses the real end
    /// of a stream that was longer than the cap.
    pub fn tail_text(&self) -> String {
        let end = |head: &[u8], tail: &[u8]| -> String {
            let from_head = TAIL_KEEP.saturating_sub(tail.len()).min(head.len());
            let mut bytes = head[head.len() - from_head..].to_vec();
            bytes.extend_from_slice(tail);
            String::from_utf8_lossy(&bytes).to_string()
        };
        let mut text = end(&self.stdout, &self.stdout_tail);
        text.push_str(&end(&self.stderr, &self.stderr_tail));
        let n = text.chars().count();
        text.chars().skip(n.saturating_sub(2000)).collect()
    }
}

/// Read `r` to the end: the first `cap` bytes, whether there was more, and the last TAIL_KEEP bytes of what
/// followed the cap.
fn read_capped(mut r: impl Read, cap: usize) -> (Vec<u8>, bool, Vec<u8>) {
    let mut kept = Vec::new();
    let mut tail = Vec::new();
    let mut truncated = false;
    let mut buf = [0u8; 64 * 1024];
    loop {
        match r.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let take = n.min(cap.saturating_sub(kept.len()));
                kept.extend_from_slice(&buf[..take]);
                if take < n {
                    truncated = true;
                    tail.extend_from_slice(&buf[take..n]);
                    if tail.len() > 2 * TAIL_KEEP {
                        tail.drain(..tail.len() - TAIL_KEEP);
                    }
                }
            }
        }
    }
    if tail.len() > TAIL_KEEP {
        tail.drain(..tail.len() - TAIL_KEEP);
    }
    (kept, truncated, tail)
}

/// Run a console program without a window. stdout and stderr are read on their own threads, so a full
/// pipe never blocks the child. The child is killed when `timeout` passes or `cancel` is set.
pub(crate) fn run_controlled(exe: &Path, args: &[&str], envs: &[(&str, &str)], timeout: Option<Duration>, cancel: Option<&AtomicBool>, cap: usize) -> Result<Captured> {
    use std::process::Stdio;
    let mut cmd = std::process::Command::new(exe);
    cmd.args(args).envs(envs.iter().copied()).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().with_context(|| format!("{} を起動できません", exe.display()))?;
    // Tied to the app's lifetime like the servers: closing the app during setup (app_exit) or a crash
    // also ends 7zr, pip (and what it runs) and ffmpeg instead of leaving them behind.
    crate::win_job::assign_or_warn(&child, &exe.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
    let reader =|r: Option<Box<dyn Read + Send>>| {
        let (tx, rx) = std::sync::mpsc::channel();
        if let Some(r) = r {
            std::thread::spawn(move || {
                let _ = tx.send(read_capped(r, cap));
            });
        } else {
            let _ = tx.send((Vec::new(), false, Vec::new()));
        }
        rx
    };
    let out_rx = reader(child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    let err_rx = reader(child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    let started = std::time::Instant::now();
    let exit = loop {
        if let Some(st) = child.try_wait()? {
            break Exit::Finished(st.success());
        }
        let stop = if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
            Some(Exit::Cancelled)
        } else if timeout.is_some_and(|t| started.elapsed() >= t) {
            Some(Exit::TimedOut)
        } else {
            None
        };
        if let Some(stop) = stop {
            let _ = child.kill();
            // TerminateProcess only starts the termination: a child stuck in a driver call (nvidia-smi on a
            // hung GPU) may not end for a long time. Wait a little, then leave it to the job object.
            let killed = std::time::Instant::now();
            while killed.elapsed() < KILL_WAIT && matches!(child.try_wait(), Ok(None)) {
                std::thread::sleep(Duration::from_millis(50));
            }
            break stop;
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    // A grandchild that inherited a pipe could keep it open: do not wait for the readers forever.
    let collect = |rx: std::sync::mpsc::Receiver<(Vec<u8>, bool, Vec<u8>)>| rx.recv_timeout(Duration::from_secs(5)).unwrap_or_default();
    let (stdout, t1, stdout_tail) = collect(out_rx);
    let (stderr, t2, stderr_tail) = collect(err_rx);
    Ok(Captured { exit, stdout, stderr, truncated: t1 || t2, stdout_tail, stderr_tail })
}

/// Run a console program without a window; returns (success, combined output tail).
pub fn run_hidden(exe: &Path, args: &[&str]) -> Result<(bool, String)> {
    run_hidden_env(exe, args, &[])
}

/// `run_hidden` with extra environment variables.
pub fn run_hidden_env(exe: &Path, args: &[&str], envs: &[(&str, &str)]) -> Result<(bool, String)> {
    let out = run_controlled(exe, args, envs, None, None, OUTPUT_CAP)?;
    Ok((out.exit == Exit::Finished(true), out.tail_text()))
}

/// Steps that need no download: node pack, extra_model_paths.yaml, folders.
pub fn finalize(app: &AppHandle, cfg: &AppConfig) -> Result<()> {
    prepare_folders(cfg)?;
    install_node_pack(app, cfg)?;
    Ok(())
}

/// The folders and extra_model_paths.yaml of `finalize`. The song folder is created only when it can be: the
/// setup does not need it and a job creates it when it saves a song, so an unplugged drive or a folder this
/// account cannot create does not keep the setup from finishing.
fn prepare_folders(cfg: &AppConfig) -> Result<()> {
    prepare_data_root(cfg)?;
    for dir in [
        cfg.models_dir().join("checkpoints"),
        cfg.models_dir().join("audio_encoders"),
        cfg.models_dir().join("loras"),
        cfg.models_dir().join("llm"),
        cfg.comfy_output_dir(),
        cfg.comfy_input_dir(),
    ] {
        std::fs::create_dir_all(&dir).with_context(|| format!("フォルダ {} を作成できません", dir.display()))?;
    }
    if let Err(e) = std::fs::create_dir_all(&cfg.output_dir) {
        log::warn!("song folder {} not created now (a job creates it when it saves a song): {e}", cfg.output_dir.display());
    }
    std::fs::write(cfg.extra_model_paths(), extra_model_paths_yaml(&cfg.models_dir()))
        .with_context(|| format!("{} を書き込めません", cfg.extra_model_paths().display()))?;
    Ok(())
}

/// Create the data root when it does not exist yet. A folder created directly below the root of the Windows drive
/// (the default C:\MCSYuE2, see restricted_location) gets permissions of its own, inherited by everything below it:
/// full control for this user, SYSTEM and Administrators, nothing inherited from the drive. It would otherwise
/// inherit "Authenticated Users: Modify" from C:\, and the app runs python.exe, the custom nodes, llama-server and
/// ffmpeg from it, so any other account on the PC could change what runs as this user. Any other new folder, and an
/// existing one (a previous install, a folder the user picked such as D:\AI), keeps what it has. Failing to set the
/// permissions is only logged. An existing folder this account cannot use fails with data_root_access_error's
/// message (instead of a bare access-denied on a folder below it).
fn prepare_data_root(cfg: &AppConfig) -> Result<()> {
    let root = &cfg.data_root;
    if root.is_dir() {
        if let Some(e) = data_root_access_error(root) {
            bail!(e);
        }
        return Ok(());
    }
    let context = || format!("フォルダ {} を作成できません", root.display());
    if let Some(parent) = root.parent() {
        std::fs::create_dir_all(parent).with_context(context)?;
    }
    match std::fs::create_dir(root) {
        Ok(()) => {
            restrict_new_data_root(root);
            Ok(())
        }
        // Created by someone else meanwhile: left alone like any existing folder.
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && root.is_dir() => Ok(()),
        Err(e) => Err(anyhow!(e)).with_context(context),
    }
}

/// The permissions step of prepare_data_root: only at a restricted_location. A restriction that leaves this user
/// unable to work in the folder anyway (a share reached through a link) is undone.
fn restrict_new_data_root(root: &Path) {
    if !restricted_location(root) {
        log::info!("data root {}: not directly below the root of the Windows drive, permissions left as inherited", root.display());
        return;
    }
    restrict(root);
}

/// restrict_to_user, undone by keep_usable when it leaves this user unable to work in `root`.
fn restrict(root: &Path) {
    if let Err(e) = restrict_to_user(root) {
        log::warn!("data root {}: permissions not restricted: {e:#}", root.display());
    }
    keep_usable(root);
}

/// Whether setup restricts a data root it creates at `root`: a folder directly below the root of the Windows drive,
/// like the default C:\MCSYuE2. There any account may create folders and change what is in them, and no folder
/// between it and the drive's root could be swapped. Left as inherited:
/// - a folder on another drive: a second disk or a USB disk (which reports DRIVE_FIXED as well) can reach another
///   Windows installation or PC, whose account has another SID and would be locked out of the tens of GB;
/// - a nested folder (C:\AI\MCSYuE2): its parent folders keep what the drive grants, so another account could
///   rename one and put its own tree in its place; restricting the folder itself would protect nothing;
/// - a network share, a mapped or removable drive (on_local_fixed_drive).
fn restricted_location(root: &Path) -> bool {
    let system_drive = std::env::var("SystemDrive").unwrap_or_default();
    directly_below_drive_root(root, &system_drive) && on_local_fixed_drive(root)
}

/// `p` is a folder directly below the root of `drive` ("C:"; the letter compared without case): C:\X or \\?\C:\X.
fn directly_below_drive_root(p: &Path, drive: &str) -> bool {
    use std::path::{Component, Prefix};
    let mut parts = p.components();
    let letter = match parts.next() {
        Some(Component::Prefix(pre)) => match pre.kind() {
            Prefix::Disk(l) | Prefix::VerbatimDisk(l) => l,
            _ => return false,
        },
        _ => return false,
    };
    let below_root = matches!((parts.next(), parts.next(), parts.next()), (Some(Component::RootDir), Some(Component::Normal(_)), None));
    below_root && drive.len() == 2 && drive.as_bytes()[0].eq_ignore_ascii_case(&letter) && drive.as_bytes()[1] == b':'
}

/// The message for an existing data root this account cannot use, or None (also for one that does not exist): it
/// cannot list the folder or create a folder in it. For example a data root restricted by the setup of another
/// Windows account, or of this one before Windows was reinstalled (a new SID), which lists nothing to it; or a folder
/// it can list but not write, such as a read-only share or C:\Program Files. Without it the setup fails on a
/// folder below it with a bare access-denied. Where the folder cannot even be read (a restricted data root), every
/// component also looks not installed (status cannot read the markers) and Windows tells no free space for it; a
/// folder that can be read but not written (a read-only share, コントロールされたフォルダー アクセス) shows both as
/// they are. The write probe is an empty folder, removed at once.
fn data_root_access_error(root: &Path) -> Option<String> {
    data_root_denial(root).map(|denial| data_root_denied_message(root, denial))
}

/// What an existing data root refuses this account (data_root_access_error).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Denial {
    /// Even the list of what is in it: what setup's restriction leaves every other account (and this one after
    /// Windows was reinstalled, and an administrator whose program does not run as administrator).
    List,
    /// It can be listed but no folder can be created in it (a read-only share, コントロールされたフォルダー アクセス,
    /// a folder of Windows such as C:\Program Files).
    Create,
}

/// data_root_access_error's check: None when the folder is usable or does not exist.
fn data_root_denial(root: &Path) -> Option<Denial> {
    let denied = |e: &std::io::Error| e.kind() == std::io::ErrorKind::PermissionDenied;
    match std::fs::read_dir(root) {
        Err(e) => denied(&e).then_some(Denial::List),
        Ok(_) => {
            let probe = access_probe(root);
            match std::fs::create_dir(&probe) {
                Ok(()) => {
                    let _ = std::fs::remove_dir(&probe);
                    None
                }
                Err(e) => denied(&e).then_some(Denial::Create),
            }
        }
    }
}

/// data_root_access_error's message: the likely cause and the ways out. Another account (or this one before Windows
/// was reinstalled) is named only for a folder that looks like one setup restricted (looks_restricted_by_setup):
/// there an administrator may grant this account access (Administrators keep full control of a restricted data
/// root), with a command on a line of its own that works in the Command Prompt and in PowerShell (an unquoted (OI)
/// would be a subexpression there). Its path has no trailing separator (the validators accept C:\MCSYuE2\ and
/// C:/MCSYuE2/): icacls would read the `\"` before the closing quote as an escaped quote. A path either shell would
/// expand gets no command, only the request to an administrator (as when the SID is unknown). Any other folder,
/// including one Windows made there (System Volume Information, C:\PerfLogs), was not locked by setup: its own
/// permissions (as for C:\Program Files or C:\Windows, where full control would let this account change what Windows
/// and other programs run), a share's rights (the server checks its own accounts, not this PC's SID) or
/// コントロールされたフォルダー アクセス (which ignores permissions) refuse it, so no grant is offered.
fn data_root_denied_message(root: &Path, denial: Denial) -> String {
    let r = root.display();
    let other_folder = "セットアップの「保存場所」または設定画面で、別のフォルダをデータルートに指定してください。";
    if !looks_restricted_by_setup(root, denial) {
        return format!(
            "データルート {r} にアクセスできません。フォルダへの読み取り・書き込みの権限（ネットワーク上のフォルダでは共有のアクセス権も）と、Windows セキュリティの「コントロールされたフォルダー アクセス」でこのアプリが許可されているかを確認するか、{other_folder}"
        );
    }
    // The folder as Windows names it, without a trailing separator or `/`: C:\MCSYuE2 for C:/MCSYuE2/. Never just the
    // drive: a restricted_location is a folder below the drive's root, not the root itself.
    let command_path = root.components().collect::<PathBuf>().display().to_string();
    // Only for a path both shells take as it is between double quotes. PowerShell expands `$` and the backtick there
    // (`$(…)` runs as a subexpression) and also ends the string at a typographic double quote; the Command Prompt
    // expands %…% (and !…! with delayed expansion). Run as administrator, the grant would go to another folder
    // (for C:\$MCS: to C:\ itself, inherited by the whole drive) or the name would run as commands.
    let literal = !command_path.contains(['$', '`', '%', '!', '\u{201C}', '\u{201D}', '\u{201E}']);
    let grant = match current_user_sid() {
        Some(sid) if literal => format!("このフォルダを使い続ける場合は、管理者として実行したコマンドプロンプトまたは PowerShell で次のコマンドを実行してから、もう一度お試しください（管理者権限が必要です。管理者権限がない場合は、別のフォルダを指定してください）:\nicacls \"{command_path}\" /grant \"*{sid}:(OI)(CI)F\""),
        _ => "このフォルダを使い続ける場合は、管理者にこのアカウントへのアクセス権の追加を依頼してください。".into(),
    };
    format!(
        "データルート {r} にこのアカウントではアクセスできません。別の Windows アカウントや、再インストールする前の Windows でセットアップしたフォルダの可能性があります（既定の C:\\MCSYuE2 のように Windows のドライブ直下にセットアップが作成したデータルートは、作成したアカウントだけが使えます）。{other_folder}{grant}"
    )
}

/// Whether an existing data root this account cannot use (`denial`) looks like one setup restricted: a folder where
/// setup restricts a new one (restricted_location) that lists nothing to this account, as setup's restriction leaves
/// every account but the one that made it (and this one after Windows was reinstalled, and an administrator whose
/// program does not run as administrator), and that Windows did not make (made_by_windows). Not so a folder this
/// account can list but not write there (C:\Program Files, C:\Windows, C:\Users, which the validators accept), nor
/// one Windows made that lists nothing either (System Volume Information, Recovery, the link Documents and
/// Settings, C:\PerfLogs).
fn looks_restricted_by_setup(root: &Path, denial: Denial) -> bool {
    denial == Denial::List && restricted_location(root) && !made_by_windows(root)
}

/// Whether the folder `p` looks like one Windows made: hidden or a system folder (System Volume Information,
/// Recovery, the link Documents and Settings), or C:\PerfLogs, which Windows makes without either attribute. A
/// folder whose attributes cannot be read is taken for one as well, so no grant is offered for it: those of a data
/// root setup restricted are always read (folder_attributes). One that does not exist is not.
#[cfg(windows)]
fn made_by_windows(p: &Path) -> bool {
    use windows_sys::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_SYSTEM};
    if p.file_name().is_some_and(|n| n.eq_ignore_ascii_case("PerfLogs")) {
        return true;
    }
    match folder_attributes(p) {
        Ok(a) => a & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM) != 0,
        Err(e) => e.kind() != std::io::ErrorKind::NotFound,
    }
}

#[cfg(not(windows))]
fn made_by_windows(_p: &Path) -> bool {
    false
}

/// The attributes of the folder `p` itself (not what a link leads to). For a folder this account cannot open, std
/// reads them through the folder above it (FindFirstFileExW), so also for a data root setup restricted to another
/// account, directly below the drive's root that any account can list. That call fails on a path ending in a
/// separator (C:\Recovery\, which the validators accept), so they are read for the path without one.
#[cfg(windows)]
fn folder_attributes(p: &Path) -> std::io::Result<u32> {
    use std::os::windows::fs::MetadataExt;
    let folder: PathBuf = p.components().collect();
    std::fs::symlink_metadata(folder).map(|m| m.file_attributes())
}

/// Put `root`'s permissions back to what it inherits (icacls /reset) when this user cannot create a folder in
/// it, so a failed restriction never locks the user out of the data root.
fn keep_usable(root: &Path) {
    if can_create_in(root) {
        return;
    }
    log::warn!("data root {}: not usable with the restricted permissions, resetting them", root.display());
    match reset_permissions(root) {
        Err(e) => log::warn!("data root {}: permissions not reset: {e:#}", root.display()),
        Ok(()) if !can_create_in(root) => log::warn!("data root {}: still not usable after the reset", root.display()),
        Ok(()) => {}
    }
}

/// Whether this user can create (and remove) a folder in `dir`.
fn can_create_in(dir: &Path) -> bool {
    let probe = access_probe(dir);
    (std::fs::create_dir(&probe).is_ok() || probe.is_dir()) && std::fs::remove_dir(&probe).is_ok()
}

/// A probe folder in `dir` with a name of its own: the system check (also from 設定) may probe the data root while
/// setup checks the restriction it has just made, and with one name either could remove the other's probe (setup
/// would then take the restriction for unusable and undo it).
fn access_probe(dir: &Path) -> PathBuf {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    dir.join(format!(".mcs_access_check_{}_{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)))
}

/// Whether `p` is on a local fixed drive (C:\…, \\?\C:\…); not a UNC path, a mapped network drive, a
/// removable or optical drive. UNC paths are rejected without asking Windows, which could wait on the network.
#[cfg(windows)]
fn on_local_fixed_drive(p: &Path) -> bool {
    use std::path::{Component, Prefix};
    use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;
    const DRIVE_FIXED: u32 = 3; // windows_sys::Win32::System::WindowsProgramming, a feature not enabled
    let letter = match p.components().next() {
        Some(Component::Prefix(pre)) => match pre.kind() {
            Prefix::Disk(l) | Prefix::VerbatimDisk(l) => l,
            _ => return false,
        },
        _ => return false,
    };
    let root: Vec<u16> = format!("{}:\\", letter as char).encode_utf16().chain(std::iter::once(0)).collect();
    unsafe { GetDriveTypeW(root.as_ptr()) == DRIVE_FIXED }
}

#[cfg(not(windows))]
fn on_local_fixed_drive(_p: &Path) -> bool {
    false
}

/// Replace the explicit entries of `dir` with what it inherits from its parent.
#[cfg(windows)]
fn reset_permissions(dir: &Path) -> Result<()> {
    let path = dir.to_string_lossy();
    let out = run_controlled(Path::new("icacls"), &[path.as_ref(), "/reset"], &[], Some(Duration::from_secs(30)), None, OUTPUT_CAP)?;
    if out.exit != Exit::Finished(true) {
        bail!("icacls /reset {:?}: {}", out.exit, out.tail_text());
    }
    Ok(())
}

#[cfg(not(windows))]
fn reset_permissions(_dir: &Path) -> Result<()> {
    Ok(())
}

/// Replace the permissions of the new folder `dir` (see prepare_data_root) with icacls.
#[cfg(windows)]
fn restrict_to_user(dir: &Path) -> Result<()> {
    let sid = current_user_sid().context("the user's SID is not available")?;
    let path = dir.to_string_lossy();
    let user = format!("*{sid}:(OI)(CI)F");
    // /inheritance:r drops what the drive grants; S-1-5-18 = SYSTEM, S-1-5-32-544 = Administrators.
    let args = [path.as_ref(), "/inheritance:r", "/grant:r", user.as_str(), "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"];
    let out = run_controlled(Path::new("icacls"), &args, &[], Some(Duration::from_secs(30)), None, OUTPUT_CAP)?;
    if out.exit != Exit::Finished(true) {
        bail!("icacls {:?}: {}", out.exit, out.tail_text());
    }
    Ok(())
}

#[cfg(not(windows))]
fn restrict_to_user(_dir: &Path) -> Result<()> {
    Ok(())
}

/// The SID of the account this process runs as ("S-1-5-21-…"), for icacls.
#[cfg(windows)]
fn current_user_sid() -> Option<String> {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{GetSidIdentifierAuthority, GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, IsValidSid, TokenUser, TOKEN_QUERY, TOKEN_USER};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return None;
        }
        let mut len = 0u32;
        GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut len);
        // u64 words keep the TOKEN_USER at the start of the buffer aligned.
        let mut buf = vec![0u64; (len as usize).div_ceil(8)];
        let ok = len > 0 && GetTokenInformation(token, TokenUser, buf.as_mut_ptr().cast(), len, &mut len) != 0;
        CloseHandle(token);
        if !ok {
            return None;
        }
        let sid = (*(buf.as_ptr() as *const TOKEN_USER)).User.Sid;
        if IsValidSid(sid) == 0 {
            return None;
        }
        // The string form of ConvertSidToStringSidW: S-1-<authority>-<sub authorities>.
        let authority = (*GetSidIdentifierAuthority(sid)).Value.iter().fold(0u64, |acc, &b| (acc << 8) | b as u64);
        let mut s = if authority < 1 << 32 { format!("S-1-{authority}") } else { format!("S-1-0x{authority:012X}") };
        for i in 0..u32::from(*GetSidSubAuthorityCount(sid)) {
            s.push_str(&format!("-{}", *GetSidSubAuthority(sid, i)));
        }
        Some(s)
    }
}

#[cfg(not(windows))]
fn current_user_sid() -> Option<String> {
    None
}

/// extra_model_paths.yaml for ComfyUI. `base_path` is a single-quoted YAML scalar (`'` doubled), so a
/// folder name containing " #" (a YAML comment) or other YAML syntax is read verbatim by
/// utils/extra_config.py (`yaml.safe_load`). ComfyUI still applies os.path.expandvars to the value.
fn extra_model_paths_yaml(models_dir: &Path) -> String {
    let p = models_dir.to_string_lossy().replace('\\', "/").replace('\'', "''");
    format!("mcs:\n  base_path: '{p}'\n  checkpoints: checkpoints\n  audio_encoders: audio_encoders\n  loras: loras\n")
}

/// Copy the bundled `comfy-nodes/mcs_yue2_nodes` into ComfyUI/custom_nodes (overwrite).
pub fn install_node_pack(app: &AppHandle, cfg: &AppConfig) -> Result<()> {
    if !cfg.comfy_custom_nodes().is_dir() {
        return Ok(()); // ComfyUI not installed yet
    }
    let src = resource_dir(app)?.join("comfy-nodes").join("mcs_yue2_nodes");
    if !src.is_dir() {
        bail!("同梱のノードパックが見つかりません（アプリを再インストールしてください）: {}", src.display());
    }
    let dst = cfg.comfy_custom_nodes().join("mcs_yue2_nodes");
    copy_dir(&src, &dst).context("ノードパックをコピーできません（ComfyUI やウイルス対策ソフトが使用中の可能性があります）")?;
    Ok(())
}

/// Resource dir: in dev, the repo root (`../` from src-tauri); in release, Tauri's resource dir.
pub fn resource_dir(app: &AppHandle) -> Result<PathBuf> {
    let r = app.path().resource_dir().context("アプリのリソースフォルダを取得できません")?;
    if r.join("comfy-nodes").is_dir() {
        return Ok(r);
    }
    // Older bundles map `../` resource paths to `_up_/`.
    if r.join("_up_").join("comfy-nodes").is_dir() {
        return Ok(r.join("_up_"));
    }
    // dev: target/debug -> repo root
    let mut p = std::env::current_exe()?;
    for _ in 0..5 {
        p.pop();
        if p.join("comfy-nodes").is_dir() {
            return Ok(p);
        }
    }
    Ok(r)
}

fn copy_dir(src: &Path, dst: &Path) -> Result<()> {
    std::fs::create_dir_all(dst).with_context(|| format!("{} を作成できません", dst.display()))?;
    for entry in std::fs::read_dir(src).with_context(|| format!("{} を読み込めません", src.display()))? {
        let entry = entry?;
        let p = entry.path();
        let name = entry.file_name();
        if name == "__pycache__" {
            continue;
        }
        let target = dst.join(&name);
        if p.is_dir() {
            copy_dir(&p, &target)?;
        } else {
            std::fs::copy(&p, &target).with_context(|| format!("{} を {} にコピーできません", p.display(), target.display()))?;
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemCheck {
    pub gpu_name: Option<String>,
    pub driver_version: Option<String>,
    pub vram_mib: Option<u64>,
    pub driver_ok: bool,
    /// Free space on the data root's drive; None when Windows tells none (e.g. for a data root this account
    /// cannot read).
    pub free_disk_gib: Option<f64>,
    pub data_root_exists: bool,
    /// The data root exists but this account cannot use it (data_root_access_error's message, which the setup
    /// would fail with). Where it cannot even be read, free_disk_gib is None and every component looks not
    /// installed; a folder that can be read but not written shows both as they are.
    pub data_root_error: Option<String>,
    /// nvidia-smi was killed for not answering (the GPU fields are then empty though a GPU may be there).
    pub gpu_probe_timed_out: bool,
}

/// nvidia-smi that has not answered by then is killed (a hung driver, e.g. after a TDR, can keep it waiting
/// for good); the check then reports no GPU, like a missing nvidia-smi, instead of never returning.
const GPU_PROBE_TIMEOUT: Duration = Duration::from_secs(15);

/// The data root's fields of SystemCheck alone, without nvidia-smi: what the wizard checks again after 保存場所, on
/// entering the download step and when a setup run ends (a hung driver would keep each of those waiting for the
/// GPU probe's timeout, and leave another nvidia-smi stuck in it).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataRootCheck {
    pub free_disk_gib: Option<f64>,
    pub data_root_exists: bool,
    pub data_root_error: Option<String>,
}

/// Free disk space on the data root's drive and whether this account can use the data root (as SystemCheck).
pub fn data_root_check(cfg: &AppConfig) -> DataRootCheck {
    DataRootCheck { free_disk_gib: free_disk_bytes(&cfg.data_root).map(gib), data_root_exists: cfg.data_root.is_dir(), data_root_error: data_root_access_error(&cfg.data_root) }
}

/// GPU/driver via nvidia-smi, free disk space on the data root's drive and whether this account can use the data root.
pub fn system_check(cfg: &AppConfig) -> SystemCheck {
    system_check_with(cfg, Path::new("nvidia-smi"), GPU_PROBE_TIMEOUT)
}

fn system_check_with(cfg: &AppConfig, nvidia_smi: &Path, timeout: Duration) -> SystemCheck {
    let mut sc = SystemCheck { gpu_name: None, driver_version: None, vram_mib: None, driver_ok: false, free_disk_gib: None, data_root_exists: false, data_root_error: None, gpu_probe_timed_out: false };
    let probe = run_controlled(nvidia_smi, &["--query-gpu=name,driver_version,memory.total", "--format=csv,noheader,nounits"], &[], Some(timeout), None, OUTPUT_CAP);
    if let Ok(out) = probe {
        if out.exit == Exit::TimedOut {
            log::warn!("nvidia-smi did not answer within {} s", timeout.as_secs());
            sc.gpu_probe_timed_out = true;
        }
        if out.exit == Exit::Finished(true) {
            let out = out.tail_text();
            if let Some(line) = out.lines().find(|l| l.contains(',')) {
                let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
                if parts.len() >= 3 {
                    sc.gpu_name = Some(parts[0].to_string());
                    sc.driver_version = Some(parts[1].to_string());
                    sc.vram_mib = parts[2].parse().ok();
                    // PyTorch cu130 needs >= 580.88 on Windows.
                    sc.driver_ok = parts[1].split('.').next().and_then(|m| m.parse::<u32>().ok()).map(|m| m >= 581 || (m == 580 && parts[1] >= "580.88")).unwrap_or(false);
                }
            }
        }
    }
    let root = data_root_check(cfg);
    SystemCheck { free_disk_gib: root.free_disk_gib, data_root_exists: root.data_root_exists, data_root_error: root.data_root_error, ..sc }
}

/// Free space (GiB) on the drive of `path` (its nearest existing ancestor); 0.0 when unknown.
pub(crate) fn free_disk_gib(path: &Path) -> f64 {
    free_disk_bytes(path).map(gib).unwrap_or(0.0)
}

fn gib(bytes: u64) -> f64 {
    bytes as f64 / 1024.0 / 1024.0 / 1024.0
}

/// Bytes available to the user on the drive of `path` (its nearest existing ancestor); None when unknown.
fn free_disk_bytes(path: &Path) -> Option<u64> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
        let mut probe = path.to_path_buf();
        while !probe.is_dir() {
            if !probe.pop() {
                break;
            }
        }
        let wide: Vec<u16> = probe.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let mut free_to_caller: u64 = 0;
        let mut total: u64 = 0;
        let mut free: u64 = 0;
        let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut free_to_caller, &mut total, &mut free) };
        if ok != 0 {
            return Some(free_to_caller);
        }
    }
    let _ = path;
    None
}

/// For the tests that need a folder's permissions to refuse this account (here and in jobs.rs), the same on a
/// developer's PC and on GitHub's runners. There a new folder in %TEMP% inherits nothing and gets entries of its own
/// for this user and Administrators, which "icacls /inheritance:r" keeps, and the job runs as an administrator whose
/// backup and restore privileges may let it list and create folders whatever their permissions say.
#[cfg(all(test, windows))]
pub(crate) mod acl_for_tests {
    use std::path::{Path, PathBuf};

    /// Give `dir` exactly the entries `grants` ("*SID:(flags)" for icacls): none of the entries it had, nothing
    /// inherited from the folder above.
    pub(crate) fn set_permissions(dir: &Path, grants: &[&str]) {
        let path = dir.to_string_lossy().into_owned();
        icacls(&[path.as_str(), "/reset"]);
        icacls(&[&[path.as_str(), "/inheritance:r", "/grant:r"], grants].concat());
    }

    fn icacls(args: &[&str]) {
        let out = std::process::Command::new("icacls").args(args).output().unwrap();
        assert!(out.status.success(), "icacls {args:?}: {}", String::from_utf8_lossy(&out.stdout));
    }

    /// A new folder in %TEMP% that passes on full control for this user, SYSTEM and Administrators to everything made
    /// in it, like a folder of the user's own, whatever %TEMP% passes on. This process can be refused by permissions
    /// from then on (without_backup_privileges).
    pub(crate) fn owned_temp_dir(tag: &str) -> PathBuf {
        without_backup_privileges();
        let d = std::env::temp_dir().join(format!("mcs_acl_test_{tag}_{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&d).unwrap();
        let user = format!("*{}:(OI)(CI)F", super::current_user_sid().expect("the user's SID"));
        set_permissions(&d, &[user.as_str(), "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"]);
        d
    }

    /// Remove the backup and restore privileges from this process (once; nothing when it has none). An administrator's
    /// program may have them enabled (GitHub's runners): listing and creating folders (FindFirstFileExW,
    /// CreateDirectoryW, which open them for backup) then pass any folder's permissions.
    pub(crate) fn without_backup_privileges() {
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, LUID};
        use windows_sys::Win32::Security::{AdjustTokenPrivileges, LookupPrivilegeValueW, LUID_AND_ATTRIBUTES, SE_PRIVILEGE_REMOVED, TOKEN_ADJUST_PRIVILEGES, TOKEN_PRIVILEGES};
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES, &mut token) == 0 {
                return;
            }
            for name in ["SeBackupPrivilege", "SeRestorePrivilege"] {
                let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
                let mut luid = LUID { LowPart: 0, HighPart: 0 };
                if LookupPrivilegeValueW(std::ptr::null(), wide.as_ptr(), &mut luid) != 0 {
                    let state = TOKEN_PRIVILEGES { PrivilegeCount: 1, Privileges: [LUID_AND_ATTRIBUTES { Luid: luid, Attributes: SE_PRIVILEGE_REMOVED }] };
                    AdjustTokenPrivileges(token, 0, &state, 0, std::ptr::null_mut(), std::ptr::null_mut());
                }
            }
            CloseHandle(token);
        });
    }

    /// Whether this process runs as administrator (elevated).
    pub(crate) fn elevated() -> bool {
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
        use windows_sys::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return false;
            }
            let mut e = TOKEN_ELEVATION { TokenIsElevated: 0 };
            let mut len = 0u32;
            let ok = GetTokenInformation(token, TokenElevation, (&mut e as *mut TOKEN_ELEVATION).cast(), std::mem::size_of::<TOKEN_ELEVATION>() as u32, &mut len) != 0;
            CloseHandle(token);
            ok && e.TokenIsElevated != 0
        }
    }

    /// Whether a test that needs `dir` (which grants this account nothing) to refuse this account must be skipped:
    /// only where it can list it all the same as an elevated program (an administrator with privileges this process
    /// could not remove); anywhere else that is a failure.
    pub(crate) fn not_refused_as_administrator(dir: &Path) -> bool {
        if std::fs::read_dir(dir).is_err() {
            return false;
        }
        assert!(elevated(), "{} grants this account nothing, yet it can list it", dir.display());
        println!("SKIPPED (this elevated program can list {} although it grants this account nothing)", dir.display());
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    use acl_for_tests::{not_refused_as_administrator, owned_temp_dir, set_permissions};

    #[test]
    fn pip_runs_without_user_site() {
        let args = pip_install_args("audio-separator==0.47.0 onnxruntime  audioread", None);
        assert_eq!(args, ["-s", "-m", "pip", "install", "--no-cache-dir", "--only-binary=:all:", "--no-warn-script-location", "audio-separator==0.47.0", "onnxruntime", "audioread"]);
        let args = pip_install_args("uroman==1.3.1.1", Some(Path::new(r"C:\MCSYuE2\cache\c.txt")));
        assert_eq!(args[7..], ["-c", r"C:\MCSYuE2\cache\c.txt", "uroman==1.3.1.1"]);
    }

    #[test]
    fn pip_top_level_packages_are_pinned() {
        for c in components().into_iter().filter(|c| c.kind == Kind::Pip) {
            for req in c.url.split_whitespace() {
                assert!(req.contains("=="), "{}: {req} is not pinned", c.id);
            }
        }
    }

    #[test]
    fn pip_constraints_keep_installed_versions_except_requested() {
        let freeze = "numpy==2.5.2\ntorch==2.13.0+cu130\nonnxruntime==1.30.0\naudio_separator==0.46.0\nPyYAML==6.0.3\n\nWARNING: junk\naiohttp @ file:///D:/a/x.whl\n";
        let c = pip_constraints(freeze, "audio-separator==0.47.0 onnxruntime==1.30.0 audioread==3.1.0");
        assert_eq!(c, "numpy==2.5.2\ntorch==2.13.0+cu130\nPyYAML==6.0.3\n");
        assert_eq!(requested_names("Foo.Bar[extra]>=1 baz_qux"), HashSet::from(["foo-bar".to_string(), "baz-qux".to_string()]));
    }

    #[test]
    fn retry_policy() {
        let secs: Vec<u64> = (1..=6).map(|n| backoff(n).as_secs()).collect();
        assert_eq!(secs, [3, 6, 12, 15, 15, 15]);
        for s in [408, 425, 429, 500, 502, 503, 504] {
            assert!(is_retryable_status(reqwest::StatusCode::from_u16(s).unwrap()), "{s}");
        }
        for s in [400, 401, 403, 404, 410, 416, 501] {
            assert!(!is_retryable_status(reqwest::StatusCode::from_u16(s).unwrap()), "{s}");
        }
        assert_eq!(retry_after_secs(Some(" 7 ")), Some(Duration::from_secs(7)));
        assert_eq!(retry_after_secs(Some("3600")), Some(Duration::from_secs(60)));
        assert_eq!(retry_after_secs(Some("Wed, 21 Oct 2026 07:28:00 GMT")), None);
        assert_eq!(retry_after_secs(None), None);
    }

    #[test]
    fn disk_estimate_counts_what_is_left() {
        let by_id = |id: &str| components().into_iter().find(|c| c.id == id).unwrap();
        let order = [by_id("yue2_bf16"), by_id("comfyui"), by_id("ffmpeg"), by_id("uroman_pip")];
        let (bf16, comfy, ffmpeg) = (order[0].size, order[1].size, order[2].size);
        let none = estimate_needed_bytes(&order, |_| 0);
        assert_eq!(none, bf16 + comfy + comfy * 23 / 10 + ffmpeg + ffmpeg * 3 + (64 << 20));
        // A half-downloaded checkpoint only needs the rest; a finished archive still needs its extraction.
        let some = estimate_needed_bytes(&order, |c| if c.id == "yue2_bf16" { bf16 / 2 } else if c.id == "comfyui" { comfy } else { 0 });
        assert_eq!(some, bf16 - bf16 / 2 + comfy * 23 / 10 + ffmpeg + ffmpeg * 3 + (64 << 20));
        assert_eq!(estimate_needed_bytes(&[], |_| 0), 0);
        // A run that downloads keeps the margin on top.
        assert_eq!(required_bytes(&order, |_| 0), none + DISK_MARGIN_BYTES);
        assert_eq!(required_bytes(&[], |_| 0), 0);
    }

    #[test]
    fn a_part_of_another_file_counts_as_the_space_it_frees() {
        // download_resumable deletes such a .part (left by an older version, or by a changed pin) before it writes,
        // so the run needs only the rest on top of it, exactly as when the .part is resumed.
        let d = temp_dir("disk_stale");
        let cfg = AppConfig { data_root: d.clone(), ..Default::default() };
        let body = payload(1000);
        let c = test_component("http://127.0.0.1:9/files/download.bin", Kind::File, Some(&body));
        let order = [c.clone()];
        let path = download_path(&cfg, &c);
        leave_part(&path, &c, &body[..600]);
        let resumed = space_needed(&cfg, &order);
        std::fs::remove_file(part_source_path(&part_path(&path))).unwrap();
        let stale = space_needed(&cfg, &order);
        // The previous pin's file (another size) under the final name is deleted before the download as well.
        std::fs::remove_file(part_path(&path)).unwrap();
        std::fs::write(&path, [0u8; 700]).unwrap();
        let replaced = space_needed(&cfg, &order);
        let _ = std::fs::remove_dir_all(&d);
        assert_eq!(resumed, 400 + DISK_MARGIN_BYTES);
        assert_eq!(stale, resumed);
        assert_eq!(replaced, 300 + DISK_MARGIN_BYTES);
    }

    #[test]
    fn pip_only_runs_need_little_space() {
        // A ~1 MB wheel (uroman) or the romanization packages must not ask for gigabytes of free space.
        let by_id = |id: &str| components().into_iter().find(|c| c.id == id).unwrap();
        assert!(required_bytes(&[by_id("uroman_pip")], |_| 0) <= 100 << 20);
        assert!(required_bytes(&[by_id("lyrics_align_pip"), by_id("uroman_pip")], |_| 0) <= 200 << 20);
        // audio-separator brings onnxruntime and the rest of its dependencies.
        assert_eq!(required_bytes(&[by_id("audio_separator")], |_| 0), 1 << 30);
        // Every pip component has an estimate (an unknown one gets the large one).
        let mut other = by_id("audio_separator");
        other.id = "some_future_pip";
        assert_eq!(pip_footprint(&other), 1 << 30);
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mcs_setup_test_{tag}_{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn interrupted_extraction_is_not_installed() {
        let cfg = AppConfig { data_root: temp_dir("status"), ..Default::default() };
        let comfy = |cfg: &AppConfig| status(cfg).into_iter().find(|s| s.component.id == "comfyui").unwrap().installed;
        let marker = cfg.data_root.join("runtime/ComfyUI_windows_portable/ComfyUI/main.py");
        std::fs::create_dir_all(marker.parent().unwrap()).unwrap();
        std::fs::write(&marker, b"").unwrap();
        // An install from before the flag existed: marker only.
        assert!(comfy(&cfg));
        let flag = extracting_flag(&cfg, "comfyui");
        std::fs::create_dir_all(flag.parent().unwrap()).unwrap();
        std::fs::write(&flag, b"").unwrap();
        assert!(!comfy(&cfg));
        std::fs::remove_file(&flag).unwrap();
        assert!(comfy(&cfg));
        let _ = std::fs::remove_dir_all(&cfg.data_root);
    }

    #[test]
    fn interrupted_pip_run_is_not_installed() {
        // pip writes the marker (`__init__.py`) before the rest of the package; closing the app kills pip.
        let cfg = AppConfig { data_root: temp_dir("pip_status"), ..Default::default() };
        let uroman = |cfg: &AppConfig| status(cfg).into_iter().find(|s| s.component.id == "uroman_pip").unwrap().installed;
        let c = components().into_iter().find(|c| c.id == "uroman_pip").unwrap();
        let marker = cfg.data_root.join(c.marker);
        std::fs::create_dir_all(marker.parent().unwrap()).unwrap();
        std::fs::write(&marker, b"").unwrap();
        // Installed before the flag existed (or a finished run): marker only.
        assert!(uroman(&cfg));
        let flag = extracting_flag(&cfg, "uroman_pip");
        std::fs::create_dir_all(flag.parent().unwrap()).unwrap();
        std::fs::write(&flag, b"").unwrap();
        assert!(!uroman(&cfg));
        std::fs::remove_file(&flag).unwrap();
        assert!(uroman(&cfg));
        let _ = std::fs::remove_dir_all(&cfg.data_root);
    }

    #[test]
    fn finishing_does_not_need_the_song_folder() {
        // The song folder on an unplugged drive, or one this account cannot create: the setup still finishes.
        let d = temp_dir("finalize");
        std::fs::write(d.join("not_a_folder"), b"x").unwrap();
        let cfg = AppConfig { data_root: d.join("MCSYuE2"), output_dir: d.join("not_a_folder").join("songs"), ..Default::default() };
        prepare_folders(&cfg).unwrap();
        assert!(cfg.models_dir().join("checkpoints").is_dir() && cfg.comfy_output_dir().is_dir());
        assert!(cfg.extra_model_paths().is_file());
        assert!(!cfg.output_dir.exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn an_unusable_data_root_is_named_in_the_error() {
        let d = temp_dir("bad_root");
        std::fs::write(d.join("not_a_folder"), b"x").unwrap();
        let cfg = AppConfig { data_root: d.join("not_a_folder").join("MCSYuE2"), ..Default::default() };
        let cancel = Arc::new(AtomicBool::new(false));
        let e = install_components(&|_| {}, &cfg, &[], &cancel).await.unwrap_err();
        assert!(format!("{e:#}").contains(&cfg.data_root.display().to_string()), "{e:#}");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// icacls's entries for `p` ("NAME:(flags)" lines; account names are not translated, the summary is).
    #[cfg(windows)]
    fn acl_entries(p: &Path) -> Vec<String> {
        let out = run_controlled(Path::new("icacls"), &[p.to_string_lossy().as_ref()], &[], Some(Duration::from_secs(30)), None, OUTPUT_CAP).unwrap();
        assert_eq!(out.exit, Exit::Finished(true));
        let text = String::from_utf8_lossy(&out.stdout).replace(p.to_string_lossy().as_ref(), "");
        text.lines().map(str::trim).filter(|l| l.contains(":(")).map(String::from).collect()
    }

    /// An access probe (access_probe) is left in `dir`.
    fn probe_left(dir: &Path) -> bool {
        std::fs::read_dir(dir).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().starts_with(".mcs_access_check"))
    }

    #[test]
    fn every_access_probe_has_a_name_of_its_own() {
        // The system check and setup's check of a new restriction may probe the same folder at once: neither may
        // remove the other's probe (setup would undo its restriction). Both leave nothing behind.
        let d = temp_dir("probe");
        let (a, b) = (access_probe(&d), access_probe(&d));
        assert_ne!(a, b);
        assert!(a.parent() == Some(d.as_path()) && b.parent() == Some(d.as_path()));
        std::fs::create_dir(&a).unwrap();
        let checked = (can_create_in(&d), data_root_access_error(&d));
        let other_kept = a.is_dir();
        std::fs::remove_dir(&a).unwrap();
        let left = probe_left(&d);
        std::fs::remove_dir_all(&d).unwrap();
        assert_eq!(checked, (true, None));
        assert!(other_kept && !left);
    }

    #[cfg(windows)]
    #[test]
    fn a_restricted_data_root_has_permissions_of_its_own() {
        let sid = current_user_sid().expect("the user's SID");
        assert!(sid.starts_with("S-1-5-") && sid.split('-').count() > 3, "{sid}");
        let d = owned_temp_dir("acl");
        let root = d.join("MCSYuE2");
        std::fs::create_dir(&root).unwrap();
        restrict(&root);
        // Only explicit entries (this user, SYSTEM, Administrators), nothing inherited from above.
        let entries = acl_entries(&root);
        assert_eq!(entries.len(), 3, "{entries:?}");
        assert!(entries.iter().all(|e| !e.contains("(I)") && e.ends_with("(OI)(CI)(F)")), "{entries:?}");
        // What setup creates below inherits exactly those, and this user can work in it.
        let cache = root.join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(cache.join("x.txt"), b"x").unwrap();
        let child = acl_entries(&cache);
        assert_eq!(child.len(), 3, "{child:?}");
        assert!(child.iter().all(|e| e.contains("(I)")), "{child:?}");
        // The access check left nothing behind.
        assert!(!probe_left(&root));
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn only_a_new_folder_directly_below_the_windows_drive_is_restricted() {
        // The default C:\MCSYuE2: below C:\ every account may create and change folders.
        assert!(directly_below_drive_root(Path::new(r"C:\MCSYuE2"), "C:"));
        assert!(directly_below_drive_root(Path::new(r"c:\MCSYuE2\"), "C:"));
        assert!(directly_below_drive_root(Path::new(r"\\?\C:\MCSYuE2"), "c:"));
        // Another drive (a second disk, or a USB disk, which also reports DRIVE_FIXED) can reach another Windows
        // installation or PC, where the account's SID differs and a restricted folder would be locked.
        assert!(!directly_below_drive_root(Path::new(r"D:\MCSYuE2"), "C:"));
        // A nested folder could be swapped through its parent folders, which keep what the drive grants.
        assert!(!directly_below_drive_root(Path::new(r"C:\AI\MCSYuE2"), "C:"));
        assert!(!directly_below_drive_root(Path::new(r"C:\"), "C:"));
        assert!(!directly_below_drive_root(Path::new("C:MCSYuE2"), "C:"));
        assert!(!directly_below_drive_root(Path::new(r"\\nas\share\MCSYuE2"), "C:"));
        assert!(!directly_below_drive_root(Path::new(r"C:\MCSYuE2"), ""));
        let system_drive = std::env::var("SystemDrive").unwrap();
        assert!(restricted_location(Path::new(&format!(r"{system_drive}\MCSYuE2"))));
        assert!(!restricted_location(&std::env::temp_dir().join("MCSYuE2")));
    }

    #[cfg(windows)]
    #[test]
    fn a_new_nested_data_root_keeps_what_it_inherits() {
        // Created with its parent folder: not locked to this account's SID (nor is the parent).
        let d = owned_temp_dir("nested");
        let mut cfg = AppConfig { data_root: d.join("AI").join("MCSYuE2"), ..Default::default() };
        prepare_data_root(&cfg).unwrap();
        let root = acl_entries(&cfg.data_root);
        // An existing folder (a previous install, the user's own D:\AI) keeps its permissions.
        let existing = d.join("existing");
        std::fs::create_dir_all(&existing).unwrap();
        let before = acl_entries(&existing);
        cfg.data_root = existing.clone();
        prepare_data_root(&cfg).unwrap();
        let after = acl_entries(&existing);
        let left = probe_left(&existing);
        std::fs::remove_dir_all(&d).unwrap();
        assert!(!root.is_empty() && root.iter().all(|e| e.contains("(I)")), "{root:?}");
        assert_eq!(after, before);
        assert!(!left);
    }

    /// Lock this user out of `dir` the way setup's restriction does for any other account (only SYSTEM is left).
    #[cfg(windows)]
    fn lock_out(dir: &Path) {
        set_permissions(dir, &["*S-1-5-18:(OI)(CI)F"]);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_data_root_this_account_cannot_use_is_explained() {
        // An existing folder this account cannot use: the setup says so and how to get out, instead of failing on a
        // folder below it. (A nested folder, which setup never restricts: no other account is blamed.)
        let d = owned_temp_dir("denied");
        let root = d.join("MCSYuE2");
        std::fs::create_dir_all(root.join("cache")).unwrap();
        lock_out(&root);
        if not_refused_as_administrator(&root) {
            let _ = reset_permissions(&root);
            let _ = std::fs::remove_dir_all(&d);
            return;
        }
        let cfg = AppConfig { data_root: root.clone(), ..Default::default() };
        let prepared = prepare_data_root(&cfg).map_err(|e| format!("{e:#}"));
        let installed = install_components(&|_| {}, &cfg, &[], &Arc::new(AtomicBool::new(false))).await.map_err(|e| format!("{e:#}"));
        // Clean up before asserting, so a failure does not leave a folder this user cannot delete.
        let _ = reset_permissions(&root);
        let usable = data_root_access_error(&root);
        let missing = data_root_access_error(&d.join("missing"));
        let _ = std::fs::remove_dir_all(&d);
        let e = prepared.unwrap_err();
        assert!(e.contains(&root.display().to_string()) && e.contains("アクセスできません") && e.contains("別のフォルダ"), "{e}");
        assert!(e.contains("コントロールされたフォルダー アクセス") && !e.contains("icacls"), "{e}");
        assert_eq!(installed.unwrap_err(), e);
        assert_eq!((usable, missing), (None, None));
    }

    #[cfg(windows)]
    #[test]
    fn only_a_data_root_setup_restricts_is_said_to_belong_to_another_account() {
        // Directly below the Windows drive (the default C:\MCSYuE2) and not even listed: what setup's restriction
        // leaves every account but the one that made it, so another account (or this one before Windows was
        // reinstalled) is the likely cause, and a grant the way back. (The folders need not exist: one that does not
        // is not taken for one Windows made, as one whose attributes cannot be read would be.)
        let sid = current_user_sid().expect("the user's SID");
        let system_drive = std::env::var("SystemDrive").unwrap();
        // On a line of its own (to copy), and the same line works in the Command Prompt and in PowerShell, where an
        // unquoted (OI) would be a subexpression. A trailing separator (the validators accept C:\MCSYuE2\ and
        // C:/MCSYuE2/) is left out of it: icacls would read `\"` as an escaped quote and get the rest of the line as
        // the folder's name; `/` is given as `\`. Spaces, parentheses, `&` and Japanese are taken as they are between
        // double quotes in both shells.
        for (restricted, folder) in [
            (format!(r"{system_drive}\MCSYuE2"), "MCSYuE2"),
            (format!(r"{system_drive}\MCSYuE2\"), "MCSYuE2"),
            (format!(r"{system_drive}\MCSYuE2\\"), "MCSYuE2"),
            (format!("{system_drive}/MCSYuE2/"), "MCSYuE2"),
            (format!(r"{system_drive}\MCS YuE2 (1) & 音楽"), "MCS YuE2 (1) & 音楽"),
        ] {
            let restricted = PathBuf::from(restricted);
            assert!(restricted_location(&restricted), "{}", restricted.display());
            let m = data_root_denied_message(&restricted, Denial::List);
            assert!(m.contains(&restricted.display().to_string()) && m.contains("別の Windows アカウント") && m.contains("別のフォルダ"), "{m}");
            let command = format!(r#"icacls "{system_drive}\{folder}" /grant "*{sid}:(OI)(CI)F""#);
            assert!(m.lines().any(|l| l == command) && !m.contains(r#"\""#), "{m}");
            // Without administrator rights only another folder is left.
            assert!(m.contains("PowerShell") && m.contains("管理者権限がない場合"), "{m}");
        }
        // A name either shell would expand between the quotes gets no command, only the request to an administrator.
        // Run as administrator, PowerShell would grant for C:\$MCS on C:\ itself (inherited by the whole drive), run
        // $(…) or what follows a typographic quote, and the Command Prompt would grant on the folder %TEMP% names.
        for folder in ["$MCS", "a$(calc)b", "a`tb", "a\u{201D};calc;\u{201C}b", "a\u{201E}b", "%TEMP%", "a!PATH!b"] {
            let restricted = PathBuf::from(format!(r"{system_drive}\{folder}"));
            assert!(restricted_location(&restricted), "{}", restricted.display());
            let m = data_root_denied_message(&restricted, Denial::List);
            assert!(m.contains(&restricted.display().to_string()) && m.contains("別の Windows アカウント") && m.contains("別のフォルダ"), "{m}");
            assert!(m.contains("管理者にこのアカウントへのアクセス権の追加を依頼してください") && !m.contains("icacls") && !m.contains(&sid), "{m}");
        }
        // Listed but not written, even directly below the Windows drive: not a folder setup restricted (it lists
        // nothing to another account). Folders of Windows are such (the validators accept them): a grant of full
        // control on C:\Program Files or C:\Windows would let this account change what Windows and other programs run.
        for listed in ["MCSYuE2", "Program Files", "Program Files (x86)", "Windows", "Users"] {
            let listed = PathBuf::from(format!(r"{system_drive}\{listed}"));
            assert!(restricted_location(&listed), "{}", listed.display());
            assert_not_another_account(&listed, &data_root_denied_message(&listed, Denial::Create));
        }
        // Anywhere else setup locked nothing: a read-only share, コントロールされたフォルダー アクセス or the folder's
        // own permissions, which a grant for this PC's SID would not change (a share checks the server's accounts).
        for elsewhere in [std::env::temp_dir().join("MCSYuE2"), PathBuf::from(format!(r"{system_drive}\AI\MCSYuE2")), PathBuf::from(r"\\nas\tools\MCSYuE2")] {
            for denial in [Denial::List, Denial::Create] {
                assert_not_another_account(&elsewhere, &data_root_denied_message(&elsewhere, denial));
            }
        }
    }

    /// `m` is data_root_denied_message's message for a folder setup did not restrict: no other account is blamed and
    /// no grant offered, only the folder's own permissions, a share's rights and コントロールされたフォルダー アクセス.
    #[cfg(windows)]
    fn assert_not_another_account(root: &Path, m: &str) {
        assert!(m.contains(&root.display().to_string()) && m.contains("アクセスできません") && m.contains("別のフォルダ"), "{m}");
        assert!(m.contains("共有のアクセス権") && m.contains("コントロールされたフォルダー アクセス"), "{m}");
        assert!(!m.contains("icacls") && !m.contains("別の Windows アカウント") && !m.contains("管理者に"), "{m}");
    }

    #[cfg(windows)]
    #[test]
    fn a_folder_of_windows_is_not_said_to_belong_to_another_account() {
        use windows_sys::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_SYSTEM};
        // System Volume Information (on every NTFS drive) lists nothing even to an administrator, like a data root
        // setup restricted to another account, but Windows made it (hidden and system, as Recovery and the link
        // Documents and Settings; C:\PerfLogs has neither attribute): no other account is blamed and no grant
        // offered for it (a grant of full control would weaken what Windows keeps there).
        acl_for_tests::without_backup_privileges();
        let system_drive = std::env::var("SystemDrive").unwrap();
        for (name, always) in [("System Volume Information", true), ("Recovery", false), ("Documents and Settings", false), ("PerfLogs", false)] {
            if !always && std::fs::symlink_metadata(format!(r"{system_drive}\{name}")).is_err() {
                continue;
            }
            // Also with a trailing separator (the validators accept one): the attributes are read all the same.
            for folder in [format!(r"{system_drive}\{name}"), format!(r"{system_drive}\{name}\"), format!("{system_drive}/{name}/")] {
                let folder = PathBuf::from(folder);
                assert!(restricted_location(&folder) && made_by_windows(&folder), "{}", folder.display());
                if name != "PerfLogs" {
                    let hidden = folder_attributes(&folder).map(|a| a & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM) != 0);
                    assert!(hidden.as_ref().is_ok_and(|h| *h), "{}: {hidden:?}", folder.display());
                }
                // Lists nothing to this account, like a data root setup restricted to another one. (Only System Volume
                // Information does so to a program that runs as administrator as well, unless that program has
                // privileges it could not drop, as on GitHub's runners.)
                let denial = data_root_denial(&folder);
                if always && denial.is_none() && acl_for_tests::elevated() {
                    println!("SKIPPED ({} is listed to this elevated program)", folder.display());
                } else {
                    assert!(denial == Some(Denial::List) || (!always && denial.is_none()), "{}: {denial:?}", folder.display());
                }
                if denial.is_some() {
                    assert_not_another_account(&folder, &data_root_access_error(&folder).unwrap());
                }
                assert_not_another_account(&folder, &data_root_denied_message(&folder, Denial::List));
            }
        }
        // A folder whose attributes cannot be read (here a name too long for NTFS) is not taken for one setup
        // restricted either; one that does not exist (a message for a folder removed meanwhile) is not Windows'.
        let unreadable = PathBuf::from(format!(r"{system_drive}\{}", "a".repeat(300)));
        assert!(folder_attributes(&unreadable).is_err_and(|e| e.kind() != std::io::ErrorKind::NotFound));
        assert!(restricted_location(&unreadable) && made_by_windows(&unreadable));
        assert_not_another_account(&unreadable, &data_root_denied_message(&unreadable, Denial::List));
        let missing = PathBuf::from(format!(r"{system_drive}\MCSYuE2-{}-missing", std::process::id()));
        assert!(!made_by_windows(&missing));
    }

    #[cfg(windows)]
    #[test]
    fn the_system_check_explains_a_data_root_this_account_cannot_use() {
        // Locked out (a data root restricted to another account): Windows tells no free space for it and every
        // component looks not installed. The check says why.
        let d = owned_temp_dir("check_denied");
        let root = d.join("MCSYuE2");
        // Can be read but not written (a read-only share, コントロールされたフォルダー アクセス): its free space and
        // what is installed in it are known, only the setup cannot use it.
        let read_only = d.join("ReadOnly");
        // ComfyUI is installed in both.
        let comfyui = components().into_iter().find(|c| c.id == "comfyui").unwrap();
        for dir in [&root, &read_only] {
            let marker = dir.join(comfyui.marker);
            std::fs::create_dir_all(marker.parent().unwrap()).unwrap();
            std::fs::write(&marker, b"").unwrap();
        }
        let sid = current_user_sid().expect("the user's SID");
        let path = read_only.to_string_lossy().into_owned();
        let deny = format!("*{sid}:(AD)");
        let denied = run_controlled(Path::new("icacls"), &[path.as_str(), "/deny", deny.as_str()], &[], Some(Duration::from_secs(30)), None, OUTPUT_CAP).unwrap();
        lock_out(&root);
        if not_refused_as_administrator(&root) {
            let _ = reset_permissions(&root);
            let _ = reset_permissions(&read_only);
            let _ = std::fs::remove_dir_all(&d);
            return;
        }
        let no_smi = d.join("no-nvidia-smi.exe");
        let cfg = AppConfig { data_root: root.clone(), ..Default::default() };
        let locked = system_check_with(&cfg, &no_smi, Duration::from_secs(1));
        let locked_status = status(&cfg);
        let read_only_cfg = AppConfig { data_root: read_only.clone(), ..Default::default() };
        let readable = system_check_with(&read_only_cfg, &no_smi, Duration::from_secs(1));
        let readable_status = status(&read_only_cfg);
        // The wizard's check of the data root alone (no nvidia-smi) tells the same.
        let roots = [data_root_check(&cfg), data_root_check(&read_only_cfg)];
        // Only the folder that lists nothing is the kind setup's restriction leaves another account.
        let denials = (data_root_denial(&root), data_root_denial(&read_only));
        // Clean up before asserting, so a failure does not leave a folder this user cannot delete.
        let _ = reset_permissions(&root);
        let _ = reset_permissions(&read_only);
        let usable = system_check_with(&cfg, &no_smi, Duration::from_secs(1));
        let usable_status = status(&cfg);
        let missing_cfg = AppConfig { data_root: d.join("missing"), ..Default::default() };
        let missing = system_check_with(&missing_cfg, &no_smi, Duration::from_secs(1));
        let more_roots = [data_root_check(&cfg), data_root_check(&missing_cfg)];
        let _ = std::fs::remove_dir_all(&d);
        let same = |sc: &SystemCheck, r: &DataRootCheck| sc.data_root_error == r.data_root_error && sc.data_root_exists == r.data_root_exists && sc.free_disk_gib.is_some() == r.free_disk_gib.is_some();
        assert!(same(&locked, &roots[0]) && same(&readable, &roots[1]), "{roots:?}");
        assert!(same(&usable, &more_roots[0]) && same(&missing, &more_roots[1]), "{more_roots:?}");
        let comfyui_installed = |s: &[ComponentStatus]| s.iter().any(|c| c.component.id == "comfyui" && c.installed);
        assert_eq!(denied.exit, Exit::Finished(true));
        assert_eq!(denials, (Some(Denial::List), Some(Denial::Create)));
        assert_eq!(locked.data_root_error, Some(data_root_denied_message(&root, Denial::List)));
        assert!(locked.data_root_exists && locked.free_disk_gib.is_none() && locked_status.iter().all(|c| !c.installed));
        assert_eq!(readable.data_root_error, Some(data_root_denied_message(&read_only, Denial::Create)));
        assert!(readable.free_disk_gib.is_some_and(|g| g > 0.0) && comfyui_installed(&readable_status));
        assert_eq!((usable.data_root_error, missing.data_root_error), (None, None));
        assert!(usable.data_root_exists && !missing.data_root_exists && comfyui_installed(&usable_status));
        assert!(usable.free_disk_gib.is_some_and(|g| g > 0.0) && missing.free_disk_gib.is_some_and(|g| g > 0.0));
    }

    #[cfg(windows)]
    #[test]
    fn a_data_root_on_a_share_is_not_restricted() {
        // A share (UNC or a mapped drive) checks the server's accounts, not this PC's SID: restricting the folder
        // would shut the user out of it. UNC paths are told apart without asking Windows (no network wait).
        assert!(!on_local_fixed_drive(Path::new(r"\\nas\share\MCSYuE2")));
        assert!(!on_local_fixed_drive(Path::new(r"\\?\UNC\nas\share\MCSYuE2")));
        assert!(!on_local_fixed_drive(Path::new(r"\\.\pipe\MCSYuE2")));
        assert!(!on_local_fixed_drive(Path::new("MCSYuE2")));
        let windows = std::env::var("SystemRoot").unwrap(); // C:\Windows, on a local fixed drive
        assert!(on_local_fixed_drive(Path::new(&windows)));
        assert!(on_local_fixed_drive(Path::new(&format!(r"\\?\{windows}"))));
    }

    #[cfg(windows)]
    #[test]
    fn a_restriction_that_locks_the_user_out_is_undone() {
        // A share reached through a link looks like a local drive. If what icacls leaves does not let this user
        // work in the data root (here: only SYSTEM may), its permissions go back to what it inherits.
        let d = owned_temp_dir("lockout");
        let root = d.join("MCSYuE2");
        std::fs::create_dir(&root).unwrap();
        lock_out(&root);
        if not_refused_as_administrator(&root) {
            let _ = reset_permissions(&root);
            let _ = std::fs::remove_dir_all(&d);
            return;
        }
        let locked_out = !can_create_in(&root);
        keep_usable(&root);
        let usable = can_create_in(&root);
        let entries = acl_entries(&root);
        // Clean up before asserting, so a failure does not leave a folder this user cannot delete.
        let _ = reset_permissions(&root);
        let _ = std::fs::remove_dir_all(&d);
        assert!(locked_out, "the test's ACL did not lock this user out");
        assert!(usable, "{entries:?}");
        assert!(!entries.is_empty() && entries.iter().all(|e| e.contains("(I)")), "{entries:?}");
    }

    #[cfg(windows)]
    #[test]
    fn a_hung_gpu_probe_does_not_block_the_system_check() {
        // nvidia-smi stuck in a hung driver: the wizard's check must still come back (no GPU found).
        let d = temp_dir("smi");
        let smi = d.join("nvidia-smi-hangs.cmd");
        std::fs::write(&smi, "@echo off\r\n:loop\r\ngoto loop\r\n").unwrap();
        let cfg = AppConfig { data_root: d.clone(), ..Default::default() };
        let (tx, rx) = std::sync::mpsc::channel();
        let smi2 = smi.clone();
        std::thread::spawn(move || {
            let _ = tx.send(system_check_with(&cfg, &smi2, Duration::from_secs(1)));
        });
        let sc = rx.recv_timeout(Duration::from_secs(20)).expect("system_check returned");
        assert!(sc.gpu_name.is_none() && sc.vram_mib.is_none() && !sc.driver_ok && sc.gpu_probe_timed_out);
        assert!(sc.data_root_exists && sc.free_disk_gib.is_some_and(|g| g > 0.0) && sc.data_root_error.is_none());
        assert_eq!(GPU_PROBE_TIMEOUT, Duration::from_secs(15));
        // A missing nvidia-smi is no GPU, not a hung one.
        let cfg = AppConfig { data_root: d.clone(), ..Default::default() };
        assert!(!system_check_with(&cfg, &d.join("no-nvidia-smi.exe"), Duration::from_secs(1)).gpu_probe_timed_out);
        let _ = std::fs::remove_dir_all(&d);
    }

    fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let mut z = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        for (name, data) in entries {
            z.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            z.write_all(data).unwrap();
        }
        z.finish().unwrap();
    }

    #[test]
    fn zip_extraction_strips_root_and_leaves_no_part_files() {
        let d = temp_dir("zip");
        let archive = d.join("a.zip");
        write_zip(&archive, &[("ffmpeg-x/bin/ffmpeg.exe", b"exe"), ("ffmpeg-x/LICENSE.txt", b"gpl")]);
        let dest = d.join("out");
        extract_zip(&archive, &dest, true, None).unwrap();
        assert_eq!(std::fs::read(dest.join("bin/ffmpeg.exe")).unwrap(), b"exe");
        assert_eq!(std::fs::read(dest.join("LICENSE.txt")).unwrap(), b"gpl");
        assert!(!dest.join("bin/ffmpeg.exe.part").exists());
        // Cancelled: nothing more is written.
        let cancel = AtomicBool::new(true);
        let dest2 = d.join("out2");
        let e = extract_zip(&archive, &dest2, true, Some(&cancel)).unwrap_err();
        assert_eq!(e.to_string(), CANCELLED_MSG);
        assert!(!dest2.join("bin").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn sha256_checks_cancel() {
        let d = temp_dir("sha");
        let f = d.join("x.bin");
        std::fs::write(&f, b"abc").unwrap();
        assert_eq!(sha256_file_cancellable(&f, None).unwrap(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        let cancel = AtomicBool::new(true);
        assert_eq!(sha256_file_cancellable(&f, Some(&cancel)).unwrap_err().to_string(), CANCELLED_MSG);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[cfg(windows)]
    #[test]
    fn controlled_run_captures_times_out_and_cancels() {
        let cmd = Path::new("cmd");
        let out = run_controlled(cmd, &["/c", "echo hello& echo oops 1>&2"], &[], Some(Duration::from_secs(20)), None, OUTPUT_CAP).unwrap();
        assert_eq!(out.exit, Exit::Finished(true));
        assert!(String::from_utf8_lossy(&out.stdout).contains("hello"));
        assert!(String::from_utf8_lossy(&out.stderr).contains("oops"));
        assert!(!out.truncated);
        // Environment variables reach the child.
        let (ok, text) = run_hidden_env(cmd, &["/c", "echo %MCS_TEST_VAR%"], &[("MCS_TEST_VAR", "x42")]).unwrap();
        assert!(ok && text.contains("x42"));
        // A hanging child is killed at the timeout, and on cancel.
        let t = std::time::Instant::now();
        let out = run_controlled(cmd, &["/c", "ping -n 30 127.0.0.1 >nul"], &[], Some(Duration::from_millis(500)), None, OUTPUT_CAP).unwrap();
        assert_eq!(out.exit, Exit::TimedOut);
        assert!(t.elapsed() < Duration::from_secs(15));
        let cancel = AtomicBool::new(true);
        let out = run_controlled(cmd, &["/c", "ping -n 30 127.0.0.1 >nul"], &[], None, Some(&cancel), OUTPUT_CAP).unwrap();
        assert_eq!(out.exit, Exit::Cancelled);
        // The cap keeps the start of a long output.
        let out = run_controlled(cmd, &["/c", "echo 0123456789"], &[], None, None, 4).unwrap();
        assert_eq!(out.stdout, b"0123");
        assert!(out.truncated);
        // ...and the real end for error messages.
        assert!(out.tail_text().trim_end().ends_with("0123456789"), "{:?}", out.tail_text());
    }

    #[test]
    fn capped_read_keeps_the_start_and_the_real_end() {
        let data: Vec<u8> = (0..200_000u32).flat_map(|i| format!("line {i}\n").into_bytes()).collect();
        let (head, truncated, tail) = read_capped(std::io::Cursor::new(&data), 1000);
        assert_eq!(head, &data[..1000]);
        assert!(truncated);
        assert_eq!(tail, &data[data.len() - TAIL_KEEP..]);
        let out = Captured { exit: Exit::Finished(false), stdout: head, stderr: b"error: boom\n".to_vec(), truncated, stdout_tail: tail, stderr_tail: Vec::new() };
        let t = out.tail_text();
        assert_eq!(t.chars().count(), 2000);
        assert!(t.ends_with("line 199999\nerror: boom\n"));
        // Short output: unchanged, nothing kept twice.
        let (head, truncated, tail) = read_capped(std::io::Cursor::new(b"abc"), 1000);
        assert_eq!((head.as_slice(), truncated, tail.len()), (&b"abc"[..], false, 0));
        let out = Captured { exit: Exit::Finished(true), stdout: head, stderr: b"x".to_vec(), truncated, stdout_tail: tail, stderr_tail: Vec::new() };
        assert_eq!(out.tail_text(), "abcx");
    }

    #[tokio::test]
    async fn or_cancel_stops_waiting() {
        let cancel = AtomicBool::new(false);
        assert_eq!(or_cancel(&cancel, async { 5 }).await.unwrap(), 5);
        cancel.store(true, Ordering::Relaxed);
        let t = std::time::Instant::now();
        let e = sleep_or_cancel(&cancel, Duration::from_secs(30)).await.unwrap_err();
        assert_eq!(e.to_string(), CANCELLED_MSG);
        assert!(t.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn pip_components_are_optional_and_pinned_by_marker() {
        let uroman = components().into_iter().find(|c| c.id == "uroman_pip").expect("uroman_pip component");
        assert_eq!(uroman.kind, Kind::Pip);
        assert_eq!(uroman.url, "uroman==1.3.1.1", "uroman must stay pinned (MMS_FA's romanization)");
        assert_eq!(pip_install_args(uroman.url, None).last().map(String::as_str), Some("uroman==1.3.1.1"));
        for c in components().into_iter().filter(|c| c.kind == Kind::Pip) {
            assert!(!c.required && c.dest.is_empty() && c.sha256.is_none(), "{}", c.id);
            // The marker is the package's __init__.py inside ComfyUI's embedded Python.
            assert!(c.marker.starts_with("runtime/ComfyUI_windows_portable/python_embeded/Lib/site-packages/"), "{}", c.id);
            assert!(c.marker.ends_with("/__init__.py"), "{}", c.id);
        }
    }

    #[test]
    fn part_classification() {
        assert_eq!(classify_part(0, 100), PartState::Resume);
        assert_eq!(classify_part(40, 100), PartState::Resume);
        assert_eq!(classify_part(100, 100), PartState::Complete);
        assert_eq!(classify_part(101, 100), PartState::Discard);
        // Unknown size: only the server can tell (416 handling).
        assert_eq!(classify_part(0, 0), PartState::Resume);
        assert_eq!(classify_part(5000, 0), PartState::Resume);
    }

    #[test]
    fn content_range_of_416() {
        assert_eq!(unsatisfied_range_total("bytes */602624"), Some(602624));
        assert_eq!(unsatisfied_range_total(" bytes */9001752960 "), Some(9_001_752_960));
        assert_eq!(unsatisfied_range_total("bytes 0-99/100"), None);
        assert_eq!(unsatisfied_range_total("bytes */*"), None);
        assert_eq!(unsatisfied_range_total(""), None);
    }

    #[test]
    fn unsatisfied_range_decision() {
        use UnsatisfiedRange::*;
        // .part already holds the whole (pinned) file.
        assert_eq!(on_unsatisfied_range(100, 100, Some(100)), Finish);
        assert_eq!(on_unsatisfied_range(5000, 0, Some(5000)), Finish);
        // Upstream file shorter / longer than the pinned size: fail at once instead of re-downloading.
        assert_eq!(on_unsatisfied_range(90, 100, Some(90)), SizeMismatch(90));
        assert_eq!(on_unsatisfied_range(40, 100, Some(120)), SizeMismatch(120));
        // Stale .part or no usable Content-Range: start over.
        assert_eq!(on_unsatisfied_range(40, 100, Some(100)), Restart);
        assert_eq!(on_unsatisfied_range(40, 100, None), Restart);
        assert_eq!(on_unsatisfied_range(40, 0, Some(30)), Restart);
        assert_eq!(on_unsatisfied_range(40, 0, None), Restart);
    }

    #[test]
    fn server_length_against_pinned_size() {
        assert_eq!(server_size_mismatch(100, Some(100)), None);
        assert_eq!(server_size_mismatch(100, Some(90)), Some(90));
        assert_eq!(server_size_mismatch(100, None), None);
        // Unpinned components accept whatever the server sends.
        assert_eq!(server_size_mismatch(0, Some(90)), None);
    }

    /// One reply of `serve`.
    #[derive(Clone)]
    enum Reply {
        /// A file server: 206 with the rest for `Range: bytes=N-`, else 200 with the whole body.
        File(Vec<u8>),
        /// Exactly this: a status, extra headers, the announced Content-Length and the bytes really sent; then
        /// the connection is closed, or held open without sending more (`stall`).
        Raw { status: &'static str, headers: Vec<String>, length: usize, body: Vec<u8>, stall: bool },
        /// 200 without a Content-Length: the body ends when the connection closes, so a cut is no error to the client.
        CloseDelimited(Vec<u8>),
    }

    /// Answers the n-th connection with `replies[n]` (the last one repeats). Returns the URL and the request
    /// heads received.
    async fn serve(replies: Vec<Reply>) -> (String, Arc<std::sync::Mutex<Vec<String>>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let heads = seen.clone();
        tokio::spawn(async move {
            let mut n = 0;
            while let Ok((mut sock, _)) = listener.accept().await {
                let reply = replies[n.min(replies.len() - 1)].clone();
                n += 1;
                let heads = heads.clone();
                tokio::spawn(async move {
                    let mut head = Vec::new();
                    let mut buf = [0u8; 1024];
                    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                        match sock.read(&mut buf).await {
                            Ok(0) | Err(_) => return,
                            Ok(k) => head.extend_from_slice(&buf[..k]),
                        }
                    }
                    let head = String::from_utf8_lossy(&head).to_ascii_lowercase();
                    heads.lock().unwrap().push(head.clone());
                    let (status, headers, length, body, stall) = match reply {
                        Reply::File(body) => {
                            let from = head.lines().find_map(|l| l.strip_prefix("range: bytes=")?.trim_end_matches('-').parse::<usize>().ok());
                            match from {
                                Some(f) => ("206 Partial Content", vec![format!("Content-Range: bytes {f}-{}/{}", body.len() - 1, body.len())], Some(body.len() - f), body[f..].to_vec(), false),
                                None => ("200 OK", Vec::new(), Some(body.len()), body, false),
                            }
                        }
                        Reply::Raw { status, headers, length, body, stall } => (status, headers, Some(length), body, stall),
                        Reply::CloseDelimited(body) => ("200 OK", Vec::new(), None, body, false),
                    };
                    let mut out = format!("HTTP/1.1 {status}\r\nConnection: close\r\n");
                    if let Some(length) = length {
                        out.push_str(&format!("Content-Length: {length}\r\n"));
                    }
                    for h in headers {
                        out.push_str(&format!("{h}\r\n"));
                    }
                    out.push_str("\r\n");
                    let _ = sock.write_all(out.as_bytes()).await;
                    let _ = sock.write_all(&body).await;
                    let _ = sock.flush().await;
                    if stall {
                        tokio::time::sleep(Duration::from_secs(60)).await;
                    }
                });
            }
        });
        (format!("http://{addr}/files/download.bin"), seen)
    }

    fn leak(s: String) -> &'static str {
        Box::leak(s.into_boxed_str())
    }

    /// A downloadable component for `serve`'s URL; `pin` = the bytes whose size and SHA256 are pinned.
    fn test_component(url: &str, kind: Kind, pin: Option<&[u8]>) -> Component {
        Component {
            id: "test_download",
            name: "test",
            description: "",
            url: leak(url.to_string()),
            kind,
            dest: "dl/file.bin",
            size: pin.map(|b| b.len() as u64).unwrap_or(0),
            sha256: pin.map(|b| leak(hex::encode(Sha256::digest(b)))),
            required: false,
            marker: "dl/file.bin",
            strip_root: false,
        }
    }

    fn test_client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().read_timeout(Duration::from_secs(20)).build().unwrap()
    }

    fn payload(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i * 7 % 251) as u8).collect()
    }

    /// The test's `.part`, as a run of this version leaves it (with its `.part.src`).
    fn leave_part(path: &Path, c: &Component, bytes: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(part_path(path), bytes).unwrap();
        std::fs::write(part_source_path(&part_path(path)), part_source(c)).unwrap();
    }

    fn range_of(head: &str) -> Option<&str> {
        head.lines().find_map(|l| l.strip_prefix("range: "))
    }

    #[tokio::test]
    async fn download_resumes_a_part_and_renames_only_a_verified_file() {
        let body = payload(1000);
        let (url, seen) = serve(vec![Reply::File(body.clone())]).await;
        let c = test_component(&url, Kind::File, Some(&body));
        let d = temp_dir("dl_resume");
        let path = d.join("file.bin");
        leave_part(&path, &c, &body[..400]);
        let cancel = Arc::new(AtomicBool::new(false));
        download_resumable(&|_| {}, &test_client(), &c, &path, &cancel).await.unwrap();
        assert_eq!(range_of(&seen.lock().unwrap()[0]), Some("bytes=400-"));
        assert_eq!(std::fs::read(&path).unwrap(), body);
        assert!(!part_path(&path).exists() && !part_source_path(&part_path(&path)).exists());
        // A second run finds the finished file and downloads nothing.
        download_resumable(&|_| {}, &test_client(), &c, &path, &cancel).await.unwrap();
        assert_eq!(seen.lock().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn a_reply_that_ignores_range_restarts_the_part() {
        let body = payload(1000);
        let ignores_range = Reply::Raw { status: "200 OK", headers: Vec::new(), length: body.len(), body: body.clone(), stall: false };
        let (url, seen) = serve(vec![ignores_range]).await;
        let c = test_component(&url, Kind::File, Some(&body));
        let d = temp_dir("dl_200");
        let path = d.join("file.bin");
        leave_part(&path, &c, &[0xEE; 400]);
        download_resumable(&|_| {}, &test_client(), &c, &path, &Arc::new(AtomicBool::new(false))).await.unwrap();
        assert_eq!(range_of(&seen.lock().unwrap()[0]), Some("bytes=400-"));
        // The 200 body replaced the .part instead of being appended to it.
        assert_eq!(std::fs::read(&path).unwrap(), body);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn a_part_of_another_file_is_not_resumed() {
        // An older version left a .part of the file it pinned under the same name (no .part.src, or another).
        let body = payload(1000);
        let (url, seen) = serve(vec![Reply::File(body.clone())]).await;
        let c = test_component(&url, Kind::File, Some(&body));
        let d = temp_dir("dl_stale");
        let path = d.join("file.bin");
        let cancel = Arc::new(AtomicBool::new(false));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(part_path(&path), [0xAB; 400]).unwrap();
        download_resumable(&|_| {}, &test_client(), &c, &path, &cancel).await.unwrap();
        assert_eq!(range_of(&seen.lock().unwrap()[0]), None);
        assert_eq!(std::fs::read(&path).unwrap(), body);
        // Another pinned file of the same size and name: the whole old .part, which would count as complete.
        std::fs::remove_file(&path).unwrap();
        std::fs::write(part_path(&path), [0xCD; 1000]).unwrap();
        std::fs::write(part_source_path(&part_path(&path)), "sha256 0000").unwrap();
        download_resumable(&|_| {}, &test_client(), &c, &path, &cancel).await.unwrap();
        assert_eq!(range_of(&seen.lock().unwrap()[1]), None);
        assert_eq!(std::fs::read(&path).unwrap(), body);
        // Unhashed components are told apart by URL and size.
        let mut unhashed = c.clone();
        unhashed.sha256 = None;
        assert_ne!(part_source(&unhashed), part_source(&c));
        assert!(part_source(&unhashed).contains(&url) && part_source(&unhashed).ends_with(" 1000"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn a_cut_transfer_resumes_and_a_short_body_never_gets_the_final_name() {
        // Unhashed (like BS-Roformer, MMS_FA): only the length protects the final name.
        let body = payload(1000);
        let cut = Reply::Raw { status: "200 OK", headers: Vec::new(), length: body.len(), body: body[..300].to_vec(), stall: false };
        let (url, seen) = serve(vec![cut, Reply::File(body.clone())]).await;
        let mut c = test_component(&url, Kind::File, Some(&body));
        c.sha256 = None;
        let d = temp_dir("dl_cut");
        let path = d.join("file.bin");
        std::fs::create_dir_all(&d).unwrap();
        let progress = std::sync::Mutex::new(Vec::new());
        let report = |p: Progress| progress.lock().unwrap().push((p.phase, p.downloaded, p.total));
        download_resumable(&report, &test_client(), &c, &path, &Arc::new(AtomicBool::new(false))).await.unwrap();
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert_eq!((range_of(&seen[0]), range_of(&seen[1])), (None, Some("bytes=300-")));
        assert_eq!(std::fs::read(&path).unwrap(), body);
        assert_eq!(progress.lock().unwrap().last(), Some(&("download".to_string(), 1000, 1000)));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn range_not_satisfiable_finishes_or_fails_by_the_server_length() {
        let body = payload(1000);
        let d = temp_dir("dl_416");
        let path = d.join("file.bin");
        let cancel = Arc::new(AtomicBool::new(false));
        // Unknown size, .part already complete: the 416's length says so, nothing is downloaded again.
        let complete = Reply::Raw { status: "416 Range Not Satisfiable", headers: vec!["Content-Range: bytes */1000".into()], length: 0, body: Vec::new(), stall: false };
        let (url, seen) = serve(vec![complete]).await;
        let c = test_component(&url, Kind::File, None);
        leave_part(&path, &c, &body);
        download_resumable(&|_| {}, &test_client(), &c, &path, &cancel).await.unwrap();
        assert_eq!(seen.lock().unwrap().len(), 1);
        assert_eq!(std::fs::read(&path).unwrap(), body);
        // Pinned size, but the server's file has another length: fail, and the .part goes.
        std::fs::remove_file(&path).unwrap();
        let other = Reply::Raw { status: "416 Range Not Satisfiable", headers: vec!["Content-Range: bytes */1200".into()], length: 0, body: Vec::new(), stall: false };
        let (url, _) = serve(vec![other]).await;
        let c = test_component(&url, Kind::File, Some(&body));
        leave_part(&path, &c, &body[..400]);
        let e = download_resumable(&|_| {}, &test_client(), &c, &path, &cancel).await.unwrap_err();
        assert!(e.to_string().contains("1200"), "{e}");
        assert!(!part_path(&path).exists() && !path.exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn range_not_satisfiable_on_a_stale_part_restarts_from_zero() {
        // A 416 whose length is the pinned size but not the .part's: the stale bytes go and the file is fetched whole,
        // instead of being appended to them.
        let body = payload(1000);
        let refused = Reply::Raw { status: "416 Range Not Satisfiable", headers: vec!["Content-Range: bytes */1000".into()], length: 0, body: Vec::new(), stall: false };
        let (url, seen) = serve(vec![refused, Reply::File(body.clone())]).await;
        let c = test_component(&url, Kind::File, Some(&body));
        let d = temp_dir("dl_416_restart");
        let path = d.join("file.bin");
        leave_part(&path, &c, &[0xEE; 400]);
        download_resumable(&|_| {}, &test_client(), &c, &path, &Arc::new(AtomicBool::new(false))).await.unwrap();
        let heads = seen.lock().unwrap().clone();
        assert_eq!(heads.len(), 2);
        assert_eq!((range_of(&heads[0]), range_of(&heads[1])), (Some("bytes=400-"), None));
        assert_eq!(std::fs::read(&path).unwrap(), body);
        assert!(!part_path(&path).exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn a_body_that_ends_early_without_an_error_is_resumed() {
        // A reply without a Content-Length that is cut short ends like a complete one (no stream error): only the
        // length check keeps the short file from its final name (unhashed, like BS-Roformer and MMS_FA).
        let body = payload(1000);
        let (url, seen) = serve(vec![Reply::CloseDelimited(body[..300].to_vec()), Reply::File(body.clone())]).await;
        let mut c = test_component(&url, Kind::File, Some(&body));
        c.sha256 = None;
        let d = temp_dir("dl_short");
        let path = d.join("file.bin");
        std::fs::create_dir_all(&d).unwrap();
        download_resumable(&|_| {}, &test_client(), &c, &path, &Arc::new(AtomicBool::new(false))).await.unwrap();
        let heads = seen.lock().unwrap().clone();
        assert_eq!(heads.len(), 2);
        assert_eq!((range_of(&heads[0]), range_of(&heads[1])), (None, Some("bytes=300-")));
        assert_eq!(std::fs::read(&path).unwrap(), body);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn a_length_that_disagrees_with_the_pin_fails_before_downloading() {
        let body = payload(1000);
        let wrong = Reply::Raw { status: "200 OK", headers: Vec::new(), length: 900, body: payload(900), stall: false };
        let (url, _) = serve(vec![wrong]).await;
        let c = test_component(&url, Kind::File, Some(&body));
        let d = temp_dir("dl_len");
        let path = d.join("file.bin");
        std::fs::create_dir_all(&d).unwrap();
        let e = download_resumable(&|_| {}, &test_client(), &c, &path, &Arc::new(AtomicBool::new(false))).await.unwrap_err();
        assert!(e.to_string().contains("900"), "{e}");
        assert!(!part_path(&path).exists() && !path.exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn a_hash_mismatch_deletes_the_part_and_never_renames() {
        let body = payload(1000);
        let (url, _) = serve(vec![Reply::File(body.clone())]).await;
        let mut c = test_component(&url, Kind::File, Some(&body));
        c.sha256 = Some(leak("0".repeat(64)));
        let d = temp_dir("dl_hash");
        let path = d.join("file.bin");
        std::fs::create_dir_all(&d).unwrap();
        let e = download_resumable(&|_| {}, &test_client(), &c, &path, &Arc::new(AtomicBool::new(false))).await.unwrap_err();
        assert!(e.to_string().contains("SHA256"), "{e}");
        assert!(!part_path(&path).exists() && !path.exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn a_server_that_keeps_failing_is_given_up_after_max_failures() {
        // "Retry-After: 0" skips the backoff waits, so the 20 attempts take no time.
        let busy = Reply::Raw { status: "503 Service Unavailable", headers: vec!["Retry-After: 0".into()], length: 0, body: Vec::new(), stall: false };
        let (url, seen) = serve(vec![busy]).await;
        let c = test_component(&url, Kind::File, Some(&payload(1000)));
        let d = temp_dir("dl_busy");
        let path = d.join("file.bin");
        std::fs::create_dir_all(&d).unwrap();
        let (client, cancel) = (test_client(), Arc::new(AtomicBool::new(false)));
        let run = download_resumable(&|_| {}, &client, &c, &path, &cancel);
        let e = tokio::time::timeout(Duration::from_secs(60), run).await.expect("the download gave up").unwrap_err();
        assert!(e.to_string().contains("503"), "{e}");
        assert_eq!(seen.lock().unwrap().len(), MAX_FAILURES as usize);
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn cancel_while_waiting_for_data_keeps_the_part() {
        let body = payload(1000);
        let stalls = Reply::Raw { status: "200 OK", headers: Vec::new(), length: body.len(), body: body[..300].to_vec(), stall: true };
        let (url, _) = serve(vec![stalls]).await;
        let c = test_component(&url, Kind::File, Some(&body));
        let d = temp_dir("dl_cancel");
        let path = d.join("file.bin");
        std::fs::create_dir_all(&d).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let part = part_path(&path);
        let (cc, watched) = (cancel.clone(), part.clone());
        tokio::spawn(async move {
            while std::fs::metadata(&watched).map(|m| m.len()).unwrap_or(0) < 300 {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            cc.store(true, Ordering::Relaxed);
        });
        let t = std::time::Instant::now();
        let e = download_resumable(&|_| {}, &test_client(), &c, &path, &cancel).await.unwrap_err();
        assert_eq!(e.to_string(), CANCELLED_MSG);
        assert!(t.elapsed() < Duration::from_secs(10));
        // The next run resumes from here.
        assert_eq!(std::fs::read(&part).unwrap(), &body[..300]);
        assert!(part_matches_source(&part, &c) && !path.exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn an_archive_counts_as_installed_only_after_its_extraction() {
        let d = temp_dir("dl_zip");
        let zip_path = d.join("src.zip");
        write_zip(&zip_path, &[("tool-x/bin/tool.exe", b"exe"), ("tool-x/LICENSE.txt", b"license")]);
        let zip = std::fs::read(&zip_path).unwrap();
        let (url, _) = serve(vec![Reply::File(zip.clone())]).await;
        let mut c = test_component(&url, Kind::Zip, Some(&zip));
        (c.id, c.dest, c.marker, c.strip_root) = ("test_zip", "runtime/tool", "runtime/tool/bin/tool.exe", true);
        let cfg = AppConfig { data_root: d.join("root"), ..Default::default() };
        let cancel = Arc::new(AtomicBool::new(false));
        install_one(&|_| {}, &cfg, &test_client(), &c, &cancel).await.unwrap();
        assert_eq!(std::fs::read(cfg.data_root.join(c.marker)).unwrap(), b"exe");
        assert!(!extracting_flag(&cfg, c.id).exists());
        assert!(!download_path(&cfg, &c).exists(), "the archive is removed once extracted");
        // An archive that cannot be extracted (here: not a zip at all) leaves the flag: not installed.
        let junk = b"this is not a zip".to_vec();
        let (url, _) = serve(vec![Reply::File(junk.clone())]).await;
        let mut bad = test_component(&url, Kind::Zip, Some(&junk));
        (bad.id, bad.dest) = ("test_zip_bad", "runtime/bad");
        assert!(install_one(&|_| {}, &cfg, &test_client(), &bad, &cancel).await.is_err());
        assert!(extracting_flag(&cfg, bad.id).exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn yaml_base_path_is_single_quoted() {
        let y = extra_model_paths_yaml(Path::new(r"D:\My Music #1\it's\models"));
        assert_eq!(y, "mcs:\n  base_path: 'D:/My Music #1/it''s/models'\n  checkpoints: checkpoints\n  audio_encoders: audio_encoders\n  loras: loras\n");
        let y = extra_model_paths_yaml(Path::new(r"C:\MCSYuE2\models"));
        assert!(y.contains("  base_path: 'C:/MCSYuE2/models'\n"));
    }

    #[test]
    fn tested_comfyui_version_matches_setup_rs() {
        // The frontend's version warning / missing-node hint name the same pinned release.
        let rules = include_str!("../../src/config/rules.ts");
        assert!(rules.contains(&format!("export const TESTED_COMFYUI_VERSION = \"{COMFYUI_VERSION}\";")));
    }

    #[test]
    fn components_are_pinned() {
        for c in components() {
            if let Some(h) = c.sha256 {
                assert_eq!(h.len(), 64, "{}", c.id);
                assert!(h.chars().all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase()), "{}", c.id);
                assert!(c.size > 0, "{} has a hash but no size", c.id);
            }
            if c.kind != Kind::Pip {
                assert!(!c.url.contains("/latest/") && !c.url.contains("/resolve/main/"), "{} uses a moving URL", c.id);
            }
            // Every Hugging Face download names a 40-hex commit (a branch such as /resolve/v1/ can move too).
            if let Some(rest) = c.url.split("huggingface.co/").nth(1).and_then(|r| r.split("/resolve/").nth(1)) {
                let rev = rest.split('/').next().unwrap_or("");
                assert!(rev.len() == 40 && rev.chars().all(|ch| ch.is_ascii_hexdigit()), "{} is not pinned to a commit", c.id);
            }
        }
        let comfy = components().into_iter().find(|c| c.id == "comfyui").unwrap();
        assert!(comfy.url.contains(&format!("/v{COMFYUI_VERSION}/")));
        assert!(comfy.name.contains(&format!("v{COMFYUI_VERSION}")));
        for id in ["sevenzip", "comfyui", "ffmpeg", "qwen3_14b", "yue2_bf16", "yue2_int8", "sheetsage2"] {
            assert!(components().iter().any(|c| c.id == id && c.sha256.is_some()), "{id} not hash-pinned");
        }
    }

    #[test]
    fn sheetsage2_download_is_the_file_the_transcription_graph_loads() {
        // Component strings are &'static literals; this keeps them on workflow::SHEETSAGE2_FILE.
        let file = crate::workflow::SHEETSAGE2_FILE;
        let c = components().into_iter().find(|c| c.id == "sheetsage2").unwrap();
        assert!(c.url.ends_with(&format!("/audio_encoders/{file}")), "{}", c.url);
        assert_eq!(c.dest, format!("models/audio_encoders/{file}"));
        assert_eq!(c.marker, c.dest);
        // The uninstaller removes the downloaded copy by the same name.
        assert!(include_str!("../windows/hooks.nsh").contains(&format!("models\\audio_encoders\\{file}*")));
    }

    /// reqwest's error for a TLS failure: its own text, then hyper's, then the io::Error carrying rustls's.
    #[derive(Debug)]
    struct Wrapped(&'static str, Box<dyn std::error::Error + Send + Sync>);
    impl std::fmt::Display for Wrapped {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.0)
        }
    }
    impl std::error::Error for Wrapped {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            Some(self.1.as_ref())
        }
    }

    #[tokio::test]
    async fn download_connect_failures_name_the_certificate_or_the_proxy() {
        let tls = |inner: &str| {
            let io = std::io::Error::new(std::io::ErrorKind::InvalidData, inner.to_string());
            Wrapped("error sending request for url (https://huggingface.co/x)", Box::new(Wrapped("client error (Connect)", Box::new(io))))
        };
        assert!(is_certificate_error(&tls("invalid peer certificate: UnknownIssuer")));
        assert!(is_certificate_error(&tls("invalid peer certificate: Expired")));
        assert!(!is_certificate_error(&tls("received corrupt message of type InvalidContentType")));
        let m = connect_failure_message(&tls("invalid peer certificate: UnknownIssuer"));
        assert!(m.contains("証明書を検証できません") && m.contains("HTTPS スキャン") && m.contains("社内プロキシ"), "{m}");
        // A real connect failure (nothing listens on the port) is no certificate error and names the proxy variable.
        let dead = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap(); // closed once dropped
        let e = test_client().get(format!("http://{dead}/x")).send().await.unwrap_err();
        assert!(e.is_connect() && !is_certificate_error(&e), "{e:?}");
        let m = connect_failure_message(&e);
        assert!(m.starts_with("ダウンロードの接続に失敗しました") && m.contains("HTTPS_PROXY"), "{m}");
    }
}
