//! LLM backends for agentic editing: local llama.cpp (`llama-server`, OpenAI-compatible API),
//! Anthropic Messages API, and any OpenAI-compatible endpoint. Structured JSON output is requested
//! everywhere and validated by the caller.

use crate::config::{app_data_dir, log_dir, AppConfig};
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LlmSettings {
    /// "local" | "anthropic" | "openai"
    pub provider: String,
    /// GGUF file name under models/llm (local)
    pub local_model: String,
    pub context_size: u32,
    pub gpu_layers: i32,
    /// Enable Qwen3 "thinking" (slower, better edits)
    pub thinking: bool,
    /// Cap the thinking per request (`thinking_budget`): Qwen3 otherwise counts syllables or re-checks bars
    /// until the whole output budget is spent and the reply is cut off with no answer at all. Off lets the
    /// thinking run as long as the model wants (sometimes better, fails at the length limit sometimes).
    pub limit_thinking: bool,
    pub anthropic_model: String,
    pub openai_base_url: String,
    pub openai_model: String,
    /// Sent to the local llama-server and to OpenAI-compatible models that accept it. Never sent to
    /// Anthropic (current Claude models reject sampling parameters) nor to OpenAI reasoning models.
    pub temperature: f64,
    /// Stop llama-server before YuE2 generation to free VRAM (24 GB can host both, but safer).
    pub unload_before_generation: bool,
}

impl Default for LlmSettings {
    fn default() -> Self {
        Self::defaults()
    }
}

impl LlmSettings {
    pub fn defaults() -> Self {
        Self {
            provider: "local".into(),
            local_model: "Qwen3-14B-Q4_K_M.gguf".into(),
            context_size: 16384,
            gpu_layers: 99,
            thinking: true,
            limit_thinking: true,
            anthropic_model: "claude-sonnet-5".into(),
            openai_base_url: "https://api.openai.com/v1".into(),
            openai_model: "gpt-5-mini".into(),
            temperature: 0.3,
            unload_before_generation: true,
        }
    }

    /// Thinking tokens the local server may spend on a request before it is made to answer (None: no cap —
    /// thinking off, or the cap switched off). The draft of lyrics gets a short planning budget: its answer
    /// is written out anyway, and a long think only re-counts syllables. A score edit needs real thinking;
    /// the budget stops only runaway loops and keeps half the output budget for the full score.
    pub fn thinking_budget(&self, purpose: ThinkingPurpose) -> Option<u32> {
        if !self.thinking || !self.limit_thinking {
            return None;
        }
        Some(match purpose {
            ThinkingPurpose::Draft => DRAFT_THINKING_BUDGET,
            ThinkingPurpose::Edit => EDIT_THINKING_BUDGET,
        })
    }
}

/// What a request is for: the thinking budget and the output budget differ (`LlmSettings::thinking_budget`,
/// `local_max_tokens`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThinkingPurpose {
    /// The AI draft of lyrics, style and chips (llm_complete).
    Draft,
    /// A score / style / lyrics edit (llm_edit).
    Edit,
}

/// Which try of a request this is. A local draft whose reply ran to the length limit (the answer looping, as
/// Qwen3 does at a low temperature: the same chorus over and over inside the JSON) is sent once more
/// (`chat_retrying`) with thinking off, a warmer temperature and a presence penalty, so it does not fall into
/// the same loop again. An edit keeps its one try (its thinking matters, and a second long score would take
/// minutes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Attempt {
    First,
    Retry,
}

/// Whether the local server thinks on this try: the settings say so, and a retry switches it off.
fn local_thinking(settings: &LlmSettings, purpose: ThinkingPurpose, attempt: Attempt) -> bool {
    settings.thinking && !(purpose == ThinkingPurpose::Draft && attempt == Attempt::Retry)
}

/// Thinking tokens for a draft (Qwen3-14B plans the song within a few hundred tokens, then counts morae).
pub const DRAFT_THINKING_BUDGET: u32 = 1024;
/// Thinking tokens for an edit (a real edit thinks for 1000–2000 tokens; more is a loop).
pub const EDIT_THINKING_BUDGET: u32 = 4096;
/// Tokens a draft's answer needs at most (a long song is about 1,000 tokens of JSON; 3x headroom, so a
/// looping reply fails in a minute instead of two and a half).
const DRAFT_ANSWER_TOKENS: u32 = 3072;
/// Sampling the Qwen3 model card recommends for the local model (top_k 20, min_p 0; top_p 0.95 with thinking,
/// 0.8 without), sent with a draft; llama-server's own defaults (top_k 40, min_p 0.05) apply to an edit as before.
const DRAFT_TOP_K: u32 = 20;
const DRAFT_MIN_P: f64 = 0.0;
const DRAFT_TOP_P_THINKING: f64 = 0.95;
const DRAFT_TOP_P_DIRECT: f64 = 0.8;
/// A draft's retry: at least this temperature (the model card's 0.7 for the non-thinking mode; a lower one
/// decodes close to greedily, which "can lead to endless repetitions") and this presence penalty (the model
/// card's remedy for endless repetitions, 0 to 2).
const RETRY_MIN_TEMPERATURE: f64 = 0.7;
const RETRY_PRESENCE_PENALTY: f64 = 1.0;
/// What llama-server appends to the thinking when the budget is exhausted, before it forces the
/// end-of-thinking tag: the text the Qwen team uses for Qwen3's thinking budget (a leading blank line, as the
/// server inserts it right after the last thinking token), then what the answer is to be (`thinking_budget_message`):
/// a draft cut while it counts syllables is told to write the JSON as planned and count no more (otherwise
/// the counting may go on inside the answer until max_tokens).
const THINKING_BUDGET_MESSAGE: &str = "\n\nConsidering the limited time by the user, I have to give the solution based on the thinking directly now.";

/// The full budget message of a request (see `THINKING_BUDGET_MESSAGE`).
fn thinking_budget_message(purpose: ThinkingPurpose) -> String {
    let next = match purpose {
        ThinkingPurpose::Draft => "I will now write the final JSON with the lyrics as planned so far, keeping the requested structure and line lengths, without counting syllables again.",
        ThinkingPurpose::Edit => "I will now write the final JSON with the complete result as planned so far.",
    };
    format!("{THINKING_BUDGET_MESSAGE} {next}\n")
}

/// API keys live in a separate file (%APPDATA%\MusicCreatorStudioYuE2\secrets.json), never in config.json.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Secrets {
    pub anthropic_api_key: String,
    pub openai_api_key: String,
    /// Fingerprint of the OpenAI key the origin below was recorded for ("" = not bound yet).
    pub openai_key_fingerprint: String,
    /// scheme://host[:port] the OpenAI key was first used with. The key is only sent there: after a
    /// Base URL change it has to be entered again (a newly saved key binds to its first origin).
    pub openai_key_origin: String,
}

impl Secrets {
    pub fn path() -> PathBuf {
        app_data_dir().join("secrets.json")
    }
    /// An unreadable (corrupt) file is moved aside to secrets.json.bad-<unix seconds> (like config.json),
    /// so a later save does not silently overwrite what might still be recovered by hand.
    pub fn load() -> Self {
        Self::load_from(&Self::path())
    }
    fn load_from(path: &Path) -> Self {
        let Ok(bytes) = std::fs::read(path) else { return Self::default() };
        match serde_json::from_slice(&bytes) {
            Ok(s) => s,
            Err(e) => {
                let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                let mut name = path.file_name().unwrap_or_default().to_os_string();
                name.push(format!(".bad-{secs}"));
                let bad = path.with_file_name(name);
                log::warn!("{} unreadable ({e}); moved to {}", path.display(), bad.display());
                match std::fs::rename(path, &bad) {
                    Ok(()) => crate::config::push_startup_notice(format!(
                        "保存済みの API キーを読み込めなかったため、API キーは未設定の状態です。設定画面で入れ直してください（元のファイルは {} に保存してあります）。",
                        bad.display()
                    )),
                    Err(re) => log::warn!("moving {} aside failed: {re}", path.display()),
                }
                Self::default()
            }
        }
    }
    /// Written to a temporary file, flushed and renamed over secrets.json: a crash mid-write never
    /// leaves a truncated file (which would lose both keys).
    pub fn save(&self) -> Result<()> {
        self.save_to(&Self::path())
    }
    fn save_to(&self, path: &Path) -> Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).with_context(|| format!("{} を作成できません", dir.display()))?;
        }
        crate::config::write_atomic(path, &serde_json::to_vec_pretty(self)?).with_context(|| format!("{} を書き込めません", path.display()))
    }

    /// Origin the stored OpenAI key is bound to (None: no key, or not used since it was saved).
    pub fn openai_key_bound_origin(&self) -> Option<&str> {
        let bound = !self.openai_api_key.is_empty() && !self.openai_key_origin.is_empty() && self.openai_key_fingerprint == key_fingerprint(&self.openai_api_key);
        bound.then_some(self.openai_key_origin.as_str())
    }

    /// Check (and on first use record) the origin the OpenAI key may be sent to. Returns true when
    /// the binding changed and the secrets should be saved.
    fn bind_openai_origin(&mut self, base_url: &str) -> Result<bool> {
        let origin = url_origin(base_url)?;
        let fp = key_fingerprint(&self.openai_api_key);
        if self.openai_key_fingerprint != fp || self.openai_key_origin.is_empty() {
            self.openai_key_fingerprint = fp;
            self.openai_key_origin = origin;
            return Ok(true);
        }
        if self.openai_key_origin != origin {
            bail!(
                "保存されている OpenAI 互換 API のキーは {} 用です。Base URL を {} に変更した場合は、設定画面でその接続先のキーを入れ直してください（キーは別の接続先には送信しません）",
                self.openai_key_origin,
                origin
            );
        }
        Ok(false)
    }
}

/// A binding made by a first use of the OpenAI key, with the requests sent under it (the first one and
/// any that overlap it or follow) that have not failed to connect.
struct FirstUse {
    id: u64,
    path: PathBuf,
    fingerprint: String,
    origin: String,
    requests: u32,
}

struct OpenAiBindings {
    next_id: u64,
    first_uses: Vec<FirstUse>,
}

/// Serializes the read-modify-write of the OpenAI key's binding (two pages may send at the same time) and
/// counts the requests of each first use.
static OPENAI_BINDING: parking_lot::Mutex<OpenAiBindings> = parking_lot::Mutex::new(OpenAiBindings { next_id: 0, first_uses: Vec::new() });

/// Check the origin the OpenAI key of `secrets` (the snapshot the request started from) may be sent to,
/// and on its first use bind it before the key is sent: a request that is cancelled or times out after
/// the key went out still binds it. The binding is checked and recorded on secrets.json as it is now, so
/// a request that started before another one bound the key is refused too; a key saved meanwhile is not
/// overwritten, and a key replaced meanwhile is not bound. Returns the first use this request counts in
/// (its connect failure goes to release_openai_origin): the one this call made, or the one whose binding
/// it relies on.
fn claim_openai_origin(path: &Path, secrets: &Secrets, base_url: &str) -> Result<Option<u64>> {
    secrets.clone().bind_openai_origin(base_url)?;
    let mut bindings = OPENAI_BINDING.lock();
    let mut current = Secrets::load_from(path);
    if current.openai_api_key != secrets.openai_api_key {
        return Ok(None);
    }
    if current.bind_openai_origin(base_url)? {
        if let Err(e) = current.save_to(path) {
            log::warn!("recording the OpenAI key origin failed: {e:#}");
        }
        bindings.next_id += 1;
        let id = bindings.next_id;
        bindings.first_uses.retain(|f| f.path != path);
        bindings.first_uses.push(FirstUse { id, path: path.to_path_buf(), fingerprint: current.openai_key_fingerprint, origin: current.openai_key_origin, requests: 1 });
        return Ok(Some(id));
    }
    let first_use = bindings.first_uses.iter_mut().find(|f| f.path == path && f.fingerprint == current.openai_key_fingerprint && f.origin == current.openai_key_origin);
    Ok(first_use.map(|f| {
        f.requests = f.requests.saturating_add(1);
        f.id
    }))
}

/// A request of first use `id` reached no server. When none of its requests may have reached one (a Base
/// URL typo), the binding is undone: a typo does not bind the key. A request that overlapped the first one
/// and did send the key keeps it, and so does a key replaced or bound again meanwhile.
fn release_openai_origin(id: u64) {
    let mut bindings = OPENAI_BINDING.lock();
    let Some(i) = bindings.first_uses.iter().position(|f| f.id == id) else { return };
    let f = &mut bindings.first_uses[i];
    f.requests = f.requests.saturating_sub(1);
    if f.requests > 0 {
        return;
    }
    let f = bindings.first_uses.swap_remove(i);
    let mut current = Secrets::load_from(&f.path);
    if current.openai_key_fingerprint != f.fingerprint || current.openai_key_bound_origin() != Some(f.origin.as_str()) {
        return;
    }
    current.openai_key_fingerprint.clear();
    current.openai_key_origin.clear();
    if let Err(e) = current.save_to(&f.path) {
        log::warn!("releasing the OpenAI key origin failed: {e:#}");
    }
}

/// scheme://host[:port] of a Base URL (Japanese error for an invalid one).
fn url_origin(base_url: &str) -> Result<String> {
    let url = reqwest::Url::parse(base_url.trim()).map_err(|e| anyhow!("OpenAI 互換 API の Base URL が正しくありません（{base_url}）: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        bail!("OpenAI 互換 API の Base URL は http:// または https:// で始めてください（{base_url}）");
    }
    Ok(url.origin().ascii_serialization())
}

/// Short, non-reversible id of a key (the key itself is never written next to its binding).
fn key_fingerprint(key: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(&Sha256::digest(key.as_bytes())[..8])
}

// ---------------------------------------------------------------- local llama-server process

/// The API key the app's llama-server requires, so a web page in the user's browser cannot use the server
/// while it runs. It is passed to llama-server via LLAMA_API_KEY (not --api-key-file: llama.cpp opens
/// that path in the ANSI code page, so a profile folder with a Japanese name made the server exit at
/// start). Created once and reused, so a server left by a crashed run still accepts the app's requests.
pub fn llama_api_key_path() -> PathBuf {
    app_data_dir().join("llama_api_key.txt")
}

fn read_llama_api_key() -> Option<String> {
    std::fs::read_to_string(llama_api_key_path()).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// The key the requests send (read_llama_api_key), created on first use.
fn ensure_llama_api_key() -> Result<String> {
    if let Some(key) = read_llama_api_key() {
        return Ok(key);
    }
    let p = llama_api_key_path();
    let dir = app_data_dir();
    std::fs::create_dir_all(&dir).with_context(|| format!("{} を作成できません", dir.display()))?;
    let key = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    std::fs::write(&p, &key).with_context(|| format!("{} を書き込めません", p.display()))?;
    Ok(key)
}

/// Environment variable llama-server reads its API key from (llama-server --help: `--api-key KEY (env: LLAMA_API_KEY)`).
const LLAMA_API_KEY_ENV: &str = "LLAMA_API_KEY";

/// What a llama-server was launched with: a config that asks for anything else needs a restart. The
/// executable and the model are full paths, so a changed data root restarts a server started from the
/// old root (it would keep the old folder's files locked and serve a model the new install lacks).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LlamaLaunch {
    pub exe: PathBuf,
    pub model_path: PathBuf,
    pub port: u16,
    pub gpu_layers: i32,
    pub context_size: u32,
}

impl LlamaLaunch {
    pub fn from_cfg(cfg: &AppConfig) -> Self {
        Self::with_settings(cfg, &cfg.llm)
    }

    fn with_settings(cfg: &AppConfig, settings: &LlmSettings) -> Self {
        Self {
            exe: cfg.llama_server_exe(),
            model_path: cfg.models_dir().join("llm").join(&settings.local_model),
            port: cfg.llm_port,
            gpu_layers: settings.gpu_layers,
            context_size: settings.context_size,
        }
    }

    /// Command-line arguments (the API key goes through the environment, never a path or the command line).
    fn args(&self) -> Vec<std::ffi::OsString> {
        let mut a: Vec<std::ffi::OsString> = vec!["-m".into(), self.model_path.clone().into_os_string()];
        for s in ["-ngl", &self.gpu_layers.to_string(), "-c", &self.context_size.to_string(), "--host", "127.0.0.1", "--port", &self.port.to_string()] {
            a.push(s.into());
        }
        for s in ["-fa", "on", "--jinja", "--no-webui"] {
            a.push(s.into());
        }
        a
    }
}

/// `local_model` must be a plain .gguf file name inside models/llm (no path, no other file type).
pub fn validate_local_model(name: &str) -> Result<()> {
    let ok = !name.trim().is_empty() && Path::new(name).file_name().and_then(|n| n.to_str()) == Some(name) && name.to_ascii_lowercase().ends_with(".gguf");
    if !ok {
        bail!("ローカル LLM のモデルには models\\llm フォルダ内の .gguf ファイル名を指定してください（{name}）");
    }
    Ok(())
}

pub struct LlamaProcess {
    child: Child,
    /// Launch settings: a config that differs needs a restart (see `matches`).
    pub launch: LlamaLaunch,
    pub port: u16,
    /// The model's file name (shown by llm_status and the restart log).
    pub model: String,
}

impl LlamaProcess {
    pub fn spawn(cfg: &AppConfig, settings: &LlmSettings) -> Result<Self> {
        let launch = LlamaLaunch::with_settings(cfg, settings);
        let exe = launch.exe.clone();
        if !exe.is_file() {
            bail!("llama-server.exe が見つかりません（セットアップで llama.cpp を導入してください）");
        }
        validate_local_model(&settings.local_model)?;
        let model = launch.model_path.clone();
        if !model.is_file() {
            bail!("LLM モデルが見つかりません: {}", model.display());
        }
        let key = ensure_llama_api_key()?;
        std::fs::create_dir_all(log_dir())?;
        let log_path = log_dir().join("llama-server.log");
        // Rotate when the log gets large (like comfyui.log).
        if std::fs::metadata(&log_path).map(|m| m.len() > 20 * 1024 * 1024).unwrap_or(false) {
            let _ = std::fs::rename(&log_path, log_dir().join("llama-server.1.log"));
        }
        let log = std::fs::OpenOptions::new().create(true).append(true).open(&log_path)?;
        let err = log.try_clone()?;
        let mut cmd = Command::new(&exe);
        // The key through the environment also overrides a LLAMA_API_KEY the user may have set globally.
        cmd.args(launch.args())
            .env(LLAMA_API_KEY_ENV, &key)
            .current_dir(exe.parent().unwrap())
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(err));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let child = cmd.spawn().context("llama-server の起動に失敗")?;
        // Tie it to the app's lifetime: a crash or kill of the app must not leave ~10 GB of VRAM taken.
        crate::win_job::assign_or_warn(&child, "llama-server");
        log::info!("llama-server spawned pid={} port={} model={} ngl={} ctx={}", child.id(), cfg.llm_port, settings.local_model, settings.gpu_layers, settings.context_size);
        Ok(Self { child, port: launch.port, model: settings.local_model.clone(), launch })
    }

    /// Launched with the executable, model, port, GPU layers and context size `cfg` asks for.
    pub fn matches(&self, cfg: &AppConfig) -> bool {
        self.launch == LlamaLaunch::from_cfg(cfg)
    }

    pub fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub fn stop(&mut self) {
        let pid = self.child.id();
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).creation_flags(0x0800_0000).output();
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        log::info!("llama-server stopped pid={pid}");
    }
}

impl Drop for LlamaProcess {
    fn drop(&mut self) {
        if self.alive() {
            self.stop();
        }
    }
}

/// Client for a server on this PC. No proxy: reqwest follows HTTP_PROXY / ALL_PROXY, and NO_PROXY rarely
/// lists 127.0.0.1, so a corporate proxy would get (and refuse) the app's requests to its own llama-server.
/// Plain HTTP does not read the Windows certificate store either (rustls-tls-native-roots reads it for every
/// client built, and llama_health builds one per probe), as in ComfyClient::new; an https:// Base URL on this
/// PC keeps it (a certificate made with mkcert or the like is trusted only through that store).
fn loopback_client(timeout: Duration, https: bool) -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder().no_proxy().tls_built_in_native_certs(https).timeout(timeout).build()?)
}

/// An https:// URL (a Base URL that cannot be parsed is not).
fn is_https_url(url: &str) -> bool {
    reqwest::Url::parse(url.trim()).is_ok_and(|u| u.scheme() == "https")
}

/// localhost, 127.0.0.0/8 or ::1 (a Base URL that cannot be parsed is not).
fn is_loopback_url(url: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(url.trim()) else { return false };
    url.host_str().is_some_and(|h| h.eq_ignore_ascii_case("localhost") || h.trim_start_matches('[').trim_end_matches(']').parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback()))
}

/// /health is public on llama-server even with an API key.
pub async fn llama_health(port: u16) -> bool {
    let Ok(client) = loopback_client(Duration::from_secs(2), false) else { return false };
    match client.get(format!("http://127.0.0.1:{port}/health")).send().await {
        Ok(r) => r.status().is_success() && r.text().await.map(|t| t.contains("ok")).unwrap_or(false),
        Err(_) => false,
    }
}

// ---------------------------------------------------------------- chat completion

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatResult {
    pub content: String,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    /// Of the whole request, retry included.
    pub seconds: f64,
    pub provider: String,
    /// 1, or 2 when the reply came from a draft's retry (`chat_retrying`).
    pub attempts: u32,
}

/// The JSON schema every provider is asked to follow for score edits.
pub fn edit_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "abc": { "type": "string", "description": "The complete edited ABC score in the YuE2 dialect, or an empty string if the score is unchanged." },
            "style": { "type": "string", "description": "The complete style prompt (English) after edits, or an empty string if unchanged." },
            "lyrics": { "type": "string", "description": "The complete lyrics after edits (with [Section] tags), or an empty string if unchanged." },
            "explanation": { "type": "string", "description": "Short explanation in Japanese of what was changed and why." }
        },
        "required": ["abc", "style", "lyrics", "explanation"],
        "additionalProperties": false
    })
}

/// Output budget of one Anthropic reply. Sonnet 5 and later think adaptively, and thinking counts
/// against max_tokens; 16000 still fits a full two-voice score without streaming.
const ANTHROPIC_MAX_TOKENS: u64 = 16000;
/// max_completion_tokens on api.openai.com (includes the hidden reasoning tokens of gpt-5 / o-series).
const OPENAI_MAX_COMPLETION_TOKENS: u64 = 16000;
/// max_tokens for llama-server and other OpenAI-compatible servers (Qwen3 thinking tokens included).
const LOCAL_MAX_TOKENS: u64 = 8192;

/// max_tokens of a local request: an edit keeps the full budget (the answer is a whole score); a draft gets
/// its thinking budget plus the answer's share, the whole budget when the thinking is uncapped, and the
/// answer's share alone on its retry (no thinking then).
fn local_max_tokens(purpose: ThinkingPurpose, settings: &LlmSettings, attempt: Attempt) -> u64 {
    if !local_thinking(settings, purpose, attempt) {
        return match purpose {
            ThinkingPurpose::Edit => LOCAL_MAX_TOKENS,
            ThinkingPurpose::Draft => u64::from(DRAFT_ANSWER_TOKENS),
        };
    }
    match (purpose, settings.thinking_budget(purpose)) {
        (ThinkingPurpose::Edit, _) => LOCAL_MAX_TOKENS,
        (ThinkingPurpose::Draft, Some(budget)) => u64::from(budget + DRAFT_ANSWER_TOKENS),
        (ThinkingPurpose::Draft, None) => LOCAL_MAX_TOKENS,
    }
}

/// Keywords Anthropic structured outputs rejects (their SDKs strip them client side). minItems is
/// only supported with 0 or 1 and handled separately.
const ANTHROPIC_UNSUPPORTED: [&str; 9] = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "maxItems", "uniqueItems"];

/// Copy of a JSON schema Anthropic accepts: the unsupported constraints are removed and written into
/// the node's description instead (e.g. 「1〜3 個」「40〜220」), as the official SDKs do. Enums,
/// required, additionalProperties and minItems 0/1 are kept. The local and OpenAI paths keep the full
/// schema (llama.cpp grammars and OpenAI strict mode enforce it).
pub fn anthropic_schema(v: &Value) -> Value {
    let Value::Object(m) = v else {
        return match v {
            Value::Array(a) => Value::Array(a.iter().map(anthropic_schema).collect()),
            other => other.clone(),
        };
    };
    let mut out = Map::new();
    let mut removed: Map<String, Value> = Map::new();
    for (k, val) in m {
        match k.as_str() {
            k2 if ANTHROPIC_UNSUPPORTED.contains(&k2) => {
                removed.insert(k.clone(), val.clone());
            }
            "minItems" if val.as_u64().is_none_or(|n| n > 1) => {
                removed.insert(k.clone(), val.clone());
            }
            // Maps of name -> schema: recurse into the values, the keys are property names.
            "properties" | "$defs" | "definitions" | "patternProperties" => {
                let inner = val.as_object().map(|o| Value::Object(o.iter().map(|(n, s)| (n.clone(), anthropic_schema(s))).collect())).unwrap_or_else(|| val.clone());
                out.insert(k.clone(), inner);
            }
            "items" | "additionalProperties" | "not" | "contains" | "anyOf" | "allOf" | "oneOf" | "prefixItems" => {
                out.insert(k.clone(), anthropic_schema(val));
            }
            _ => {
                out.insert(k.clone(), val.clone());
            }
        }
    }
    if let Some(note) = constraint_note(&removed, m) {
        let desc = out.get("description").and_then(|d| d.as_str()).map(|d| format!("{d}（{note}）")).unwrap_or(note);
        out.insert("description".into(), Value::String(desc));
    }
    Value::Object(out)
}

/// Japanese text for removed schema constraints (None when nothing was removed). A kept minItems (0/1)
/// is named next to a removed maxItems so the note reads as one range.
fn constraint_note(r: &Map<String, Value>, original: &Map<String, Value>) -> Option<String> {
    let num = |k: &str| r.get(k).map(|v| v.to_string());
    let mut parts: Vec<String> = Vec::new();
    let range = |lo: Option<String>, hi: Option<String>, unit: &str| -> Option<String> {
        match (lo, hi) {
            (Some(a), Some(b)) => Some(format!("{a}〜{b}{unit}")),
            (Some(a), None) => Some(format!("{a}{unit}以上")),
            (None, Some(b)) => Some(format!("{b}{unit}以下")),
            (None, None) => None,
        }
    };
    let min_items = num("minItems").or_else(|| if r.contains_key("maxItems") { original.get("minItems").filter(|v| v.as_u64() != Some(0)).map(|v| v.to_string()) } else { None });
    parts.extend(range(min_items, num("maxItems"), " 個"));
    parts.extend(range(num("minimum"), num("maximum"), ""));
    if let Some(a) = num("exclusiveMinimum") {
        parts.push(format!("{a} より大きい"));
    }
    if let Some(b) = num("exclusiveMaximum") {
        parts.push(format!("{b} 未満"));
    }
    parts.extend(range(num("minLength"), num("maxLength"), " 文字"));
    if let Some(k) = num("multipleOf") {
        parts.push(format!("{k} の倍数"));
    }
    if r.get("uniqueItems").and_then(|v| v.as_bool()) == Some(true) {
        parts.push("重複なし".into());
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("、"))
    }
}

/// Anthropic Messages body. No temperature: Sonnet 5, Opus 4.7+ and Fable reject sampling
/// parameters, and older models are fine on their default with schema-constrained output.
pub fn anthropic_body(settings: &LlmSettings, messages: &[ChatMessage], schema: Option<&Value>) -> Value {
    let system: Vec<String> = messages.iter().filter(|m| m.role == "system").map(|m| m.content.clone()).collect();
    let msgs: Vec<Value> = messages.iter().filter(|m| m.role != "system").map(|m| json!({ "role": m.role, "content": m.content })).collect();
    let mut body = json!({
        "model": settings.anthropic_model,
        "max_tokens": ANTHROPIC_MAX_TOKENS,
        "system": system.join("\n\n"),
        "messages": msgs,
    });
    if let Some(s) = schema {
        body["output_config"] = json!({ "format": { "type": "json_schema", "schema": anthropic_schema(s) } });
    }
    body
}

/// The official OpenAI endpoint (Chat Completions there wants max_completion_tokens).
fn is_official_openai(base_url: &str) -> bool {
    reqwest::Url::parse(base_url.trim()).ok().and_then(|u| u.host_str().map(|h| h.eq_ignore_ascii_case("api.openai.com"))).unwrap_or(false)
}

/// OpenAI reasoning models (gpt-5 family except the chat variants, o1 / o3 / o4): only the default
/// temperature is accepted.
fn is_reasoning_model(model: &str) -> bool {
    let m = model.trim().to_ascii_lowercase();
    (m.starts_with("gpt-5") && !m.starts_with("gpt-5-chat")) || ["o1", "o3", "o4"].iter().any(|p| m == *p || m.starts_with(&format!("{p}-")))
}

/// Chat Completions body. Other compatible hosts get max_tokens + temperature as before; api.openai.com
/// gets max_completion_tokens, and temperature only for non-reasoning models. The local llama-server also
/// gets the thinking switch and, with the cap on, the thinking budget: `reasoning_budget_tokens` /
/// `reasoning_budget_message` are llama.cpp's per-request fields (tools/server, b11206); when the budget is
/// used up the server appends the message, forces the end-of-thinking tag and the schema grammar takes over,
/// so the reply still ends in a complete JSON answer. A local draft also gets the model card's sampling, and
/// its retry (`Attempt::Retry`) thinks not, samples warmer and penalizes presence (see `Attempt`).
#[allow(clippy::too_many_arguments)]
pub fn openai_body(provider: &str, settings: &LlmSettings, base_url: &str, model: &str, messages: &[ChatMessage], schema: Option<&Value>, purpose: ThinkingPurpose, attempt: Attempt) -> Value {
    let mut body = json!({
        "model": model,
        "messages": messages.iter().map(|m| json!({ "role": m.role, "content": m.content })).collect::<Vec<_>>(),
    });
    let retry = provider == "local" && purpose == ThinkingPurpose::Draft && attempt == Attempt::Retry;
    let temperature = if retry { settings.temperature.max(RETRY_MIN_TEMPERATURE) } else { settings.temperature };
    if provider == "openai" && is_official_openai(base_url) {
        body["max_completion_tokens"] = json!(OPENAI_MAX_COMPLETION_TOKENS);
        if !is_reasoning_model(model) {
            body["temperature"] = json!(temperature);
        }
    } else {
        body["max_tokens"] = json!(if provider == "local" { local_max_tokens(purpose, settings, attempt) } else { LOCAL_MAX_TOKENS });
        body["temperature"] = json!(temperature);
    }
    if let Some(s) = schema {
        body["response_format"] = json!({ "type": "json_schema", "json_schema": { "name": "edit", "schema": s, "strict": true } });
    }
    if provider == "local" {
        let thinking = local_thinking(settings, purpose, attempt);
        body["chat_template_kwargs"] = json!({ "enable_thinking": thinking });
        if let Some(budget) = settings.thinking_budget(purpose).filter(|_| thinking) {
            body["reasoning_budget_tokens"] = json!(budget);
            body["reasoning_budget_message"] = json!(thinking_budget_message(purpose));
        }
        if purpose == ThinkingPurpose::Draft {
            body["top_k"] = json!(DRAFT_TOP_K);
            body["min_p"] = json!(DRAFT_MIN_P);
            body["top_p"] = json!(if thinking { DRAFT_TOP_P_THINKING } else { DRAFT_TOP_P_DIRECT });
        }
        if retry {
            body["presence_penalty"] = json!(RETRY_PRESENCE_PENALTY);
        }
    }
    body
}

/// What shrinks either request chat() serves (the AI draft of lyrics and the AI edit alike).
const SHRINK_HINT: &str = "依頼する内容（曲の長さや編集の範囲）を小さくしてください";
/// With the thinking cap switched off: where to switch it back on, or thinking off (the settings page's
/// checkboxes; they apply after 「LLM 設定を保存」).
const THINKING_CAP_HINT: &str = "設定画面の「AI 編集（LLM）」で「思考の長さを自動で制限する」をオンにするか「思考モード」をオフにして「LLM 設定を保存」を押すか、依頼する内容（曲の長さや編集の範囲）を小さくしてください";
/// A local request that does not fit the context (n_ctx): a larger context, or a cloud provider.
const CONTEXT_HINT: &str = "設定画面の「AI 編集（LLM）」でコンテキスト長を増やして「LLM 設定を保存」を押すか、プロバイダを「Anthropic API（Claude）」か「OpenAI 互換 API」に切り替えてください";

/// Text of a successful Anthropic reply; a reply cut off at max_tokens or a refusal is an error with
/// its own message instead of a JSON-parse failure later.
fn anthropic_content(v: &Value) -> Result<String> {
    match v.get("stop_reason").and_then(|s| s.as_str()) {
        Some("max_tokens") => bail!("LLM の応答が出力上限（{ANTHROPIC_MAX_TOKENS} トークン）で途切れました。依頼する内容（曲の長さや編集の範囲）を小さくするか、出力上限の大きいモデルを選んでください"),
        Some("refusal") => bail!("LLM が応答を拒否しました（refusal）。指示の内容を変えてもう一度お試しください"),
        _ => {}
    }
    Ok(v.get("content").and_then(|c| c.as_array()).map(|a| a.iter().filter_map(|b| b.get("text").and_then(|t| t.as_str())).collect::<Vec<_>>().join("")).unwrap_or_default())
}

/// A reply that ended with finish_reason "length" (the error `openai_content` returns for it, so
/// `chat_retrying` can tell it from the other failures). `at_limit`: all of max_tokens was spent (a looping
/// or endless answer), not the context left after the prompt.
#[derive(Debug)]
pub struct LengthCut {
    pub message: String,
    pub at_limit: bool,
}

impl std::fmt::Display for LengthCut {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for LengthCut {}

/// Text of a successful Chat Completions reply (finish_reason checked first). The message for a reply cut
/// off at the length limit names what the user can change: with uncapped local thinking, the thinking
/// settings; with the cap on (the thinking took at most its budget), only the request itself; after a
/// draft's retry, that both tries were cut. llama-server also ends a reply with "length" when the context
/// (n_ctx) fills up before max_tokens: then the context left after the prompt is what cut it (with uncapped
/// thinking, the thinking settings are still named first: a larger context only lets the thinking run on to
/// max_tokens).
fn openai_content(v: &Value, provider: &str, settings: &LlmSettings, purpose: ThinkingPurpose, attempt: Attempt) -> Result<String> {
    let thinking = provider == "local" && local_thinking(settings, purpose, attempt);
    let capped = settings.thinking_budget(purpose).filter(|_| thinking);
    let usage = |k: &str| v.pointer(&format!("/usage/{k}")).and_then(|x| x.as_u64()).unwrap_or(0);
    let (prompt, completion) = (usage("prompt_tokens"), usage("completion_tokens"));
    let limit = local_max_tokens(purpose, settings, attempt);
    let context_full = provider == "local" && completion > 0 && completion < limit;
    let retried = provider == "local" && purpose == ThinkingPurpose::Draft && attempt == Attempt::Retry;
    let length_msg = || match (thinking, capped) {
        (true, None) if context_full => format!("LLM の応答がローカル LLM のコンテキストの残り（{completion} トークン、思考を含む。入力が {prompt} トークンを使用）で途切れました。{THINKING_CAP_HINT}。それでも途切れる場合は、{CONTEXT_HINT}"),
        _ if context_full => format!("LLM の応答がローカル LLM のコンテキストの残り（{completion} トークン。入力が {prompt} トークンを使用）で途切れました。{CONTEXT_HINT}"),
        _ if retried => format!("LLM の応答が 2 回とも長さ上限で途切れました（1 回目は {} トークン、2 回目は思考なしで {limit} トークン）。{SHRINK_HINT}。もう一度試すと成功することもあります", local_max_tokens(purpose, settings, Attempt::First)),
        (true, None) => format!("LLM の応答が長さ上限（{LOCAL_MAX_TOKENS} トークン、思考を含む）で途切れました。{THINKING_CAP_HINT}"),
        (true, Some(budget)) => format!("LLM の応答が長さ上限（{limit} トークン。思考は {budget} トークンで打ち切り済み）で途切れました。{SHRINK_HINT}"),
        (false, _) if provider == "local" => format!("LLM の応答が長さ上限（{limit} トークン）で途切れました。{SHRINK_HINT}"),
        (false, _) => format!("LLM の応答が長さ上限で途切れました。{SHRINK_HINT}。または出力上限の大きいモデルを選んでください"),
    };
    match v.pointer("/choices/0/finish_reason").and_then(|s| s.as_str()) {
        Some("length") => return Err(anyhow::Error::new(LengthCut { message: length_msg(), at_limit: !context_full })),
        Some("content_filter") => bail!("LLM の応答がコンテンツフィルターで止められました。指示の内容を変えてもう一度お試しください"),
        _ => {}
    }
    // OpenAI structured outputs: a refusal comes with finish_reason "stop", no content and its reason here.
    let refusal = v.pointer("/choices/0/message/refusal").and_then(|r| r.as_str()).unwrap_or("").trim();
    if !refusal.is_empty() {
        bail!("LLM が応答を拒否しました（{refusal}）。指示の内容を変えてもう一度お試しください");
    }
    let content = v.pointer("/choices/0/message/content").and_then(|c| c.as_str()).unwrap_or("");
    if content.trim().is_empty() {
        let reasoning = v.pointer("/choices/0/message/reasoning_content").and_then(|c| c.as_str()).unwrap_or("");
        if !reasoning.trim().is_empty() {
            bail!("LLM が思考だけを出力し、応答本文がありませんでした。{}", if thinking && capped.is_none() { THINKING_CAP_HINT } else { "もう一度お試しください" });
        }
        bail!("LLM の応答に本文（content）がありません。もう一度お試しください");
    }
    Ok(strip_think(content))
}

/// The request carries replies of earlier turns: llm_edit (lib.rs) opens every conversation with one
/// acknowledgement of the current state, so more than one assistant message is a conversation going on.
fn has_earlier_turns(messages: &[ChatMessage]) -> bool {
    messages.iter().filter(|m| m.role == "assistant").count() > 1
}

/// Japanese message for a failed local llama-server request (None: use the generic API error). A prompt
/// longer than the context is the conversation's length only when it has earlier turns (a reset helps);
/// otherwise the score and lyrics (or the draft request) alone do not fit.
fn local_http_error(status: reqwest::StatusCode, v: &Value, port: u16, earlier_turns: bool, purpose: ThinkingPurpose) -> Option<String> {
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Some(format!("ポート {port} で別の llama-server が動作しています（このアプリの API キーを受け付けません）。そのプロセスを終了するか、設定で LLM ポートを変更してください"));
    }
    let err = v.get("error");
    let kind = err.and_then(|e| e.get("type")).and_then(|t| t.as_str()).unwrap_or("");
    let msg = err.and_then(|e| e.get("message")).and_then(|m| m.as_str()).unwrap_or("");
    if kind == "exceed_context_size_error" || msg.contains("exceeds the available context size") {
        let n_ctx = err.and_then(|e| e.get("n_ctx")).and_then(|n| n.as_u64()).map(|n| format!("{n} トークン")).unwrap_or_else(|| "上限".into());
        return Some(match (earlier_turns, purpose) {
            (true, _) => format!("会話が長くなり、ローカル LLM のコンテキスト（{n_ctx}）を超えました。会話をリセットするか、設定でコンテキスト長を増やしてください"),
            (false, ThinkingPurpose::Edit) => format!("譜面と歌詞が長く、ローカル LLM のコンテキスト（{n_ctx}）に収まりません。{CONTEXT_HINT}"),
            (false, ThinkingPurpose::Draft) => format!("依頼する内容が長く、ローカル LLM のコンテキスト（{n_ctx}）に収まりません。{CONTEXT_HINT}"),
        });
    }
    None
}

/// Japanese context for a request that never got an answer; the reqwest error stays in the chain
/// (lib.rs decides on the connect retry by its type) and is shown after the message. A failed certificate
/// check and, for an https endpoint, the proxy are named: reqwest's own text says neither. A connect that
/// timed out (a firewall that drops the connection attempt) is a failed connection, not a slow answer.
fn send_error(e: reqwest::Error, target: &str) -> anyhow::Error {
    let msg = if crate::setup::is_certificate_error(&e) {
        format!("LLM サーバーの証明書を検証できません（{target}）。ウイルス対策ソフトの HTTPS スキャンや社内プロキシを確認してください")
    } else if e.is_connect() && !target.trim().to_ascii_lowercase().starts_with("http://") && !is_loopback_url(target) {
        // api.anthropic.com or an https:// Base URL off this PC (chat_client uses no proxy on this PC, and the
        // plain-HTTP LAN hosts need none).
        format!("LLM サーバーに接続できません（{target}）。{}", crate::setup::PROXY_HINT)
    } else if e.is_connect() {
        format!("LLM サーバーに接続できません（{target}）")
    } else if e.is_timeout() {
        format!("LLM の応答がタイムアウトしました（{target}）")
    } else {
        format!("LLM への送信に失敗しました（{target}）")
    };
    anyhow::Error::new(e).context(msg)
}

/// The request failed before any of it was written (no connection, no TLS session, a proxy tunnel refused),
/// so the key did not reach the server. A connect that timed out counts too (Windows gives up after about 21 s
/// on a host that drops the connection attempt); the request's own timeout (CHAT_TIMEOUT) is no connect error.
fn reached_no_server(e: &reqwest::Error) -> bool {
    e.is_connect()
}

/// Timeout of one chat request (a long local edit with thinking takes minutes).
const CHAT_TIMEOUT: Duration = Duration::from_secs(600);
const ANTHROPIC_MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages";

/// The local llama-server (or an OpenAI-compatible server on this PC) never goes through a proxy; cloud
/// and LAN endpoints keep the proxy settings.
fn chat_client(base_url: &str) -> Result<reqwest::Client> {
    if is_loopback_url(base_url) {
        return loopback_client(CHAT_TIMEOUT, is_https_url(base_url));
    }
    Ok(reqwest::Client::builder().timeout(CHAT_TIMEOUT).build()?)
}

/// One request to the configured provider: a draft on the local server once more without thinking when its
/// reply ran to the length limit (see `Attempt`; `on_retry` is called before that second try, so the page
/// can say so). An edit, a cloud provider, and a reply the context cut (not max_tokens) get no second try.
pub async fn chat_retrying(cfg: &AppConfig, settings: &LlmSettings, secrets: &Secrets, messages: Vec<ChatMessage>, schema: Option<Value>, purpose: ThinkingPurpose, mut on_retry: impl FnMut()) -> Result<ChatResult> {
    chat_retrying_using(&Secrets::path(), cfg, settings, secrets, messages, schema, purpose, &mut on_retry).await
}

#[allow(clippy::too_many_arguments)]
async fn chat_retrying_using(secrets_path: &Path, cfg: &AppConfig, settings: &LlmSettings, secrets: &Secrets, messages: Vec<ChatMessage>, schema: Option<Value>, purpose: ThinkingPurpose, on_retry: &mut impl FnMut()) -> Result<ChatResult> {
    let t0 = std::time::Instant::now();
    let retry_wanted = |e: &anyhow::Error| settings.provider == "local" && purpose == ThinkingPurpose::Draft && e.downcast_ref::<LengthCut>().is_some_and(|c| c.at_limit);
    match chat_using(secrets_path, cfg, settings, secrets, messages.clone(), schema.clone(), purpose, Attempt::First).await {
        Err(e) if retry_wanted(&e) => {
            log::warn!("local draft reply ran to the length limit, sent once more without thinking: {e:#}");
            on_retry();
            let mut r = chat_using(secrets_path, cfg, settings, secrets, messages, schema, purpose, Attempt::Retry).await?;
            r.attempts = 2;
            r.seconds = t0.elapsed().as_secs_f64();
            Ok(r)
        }
        r => r,
    }
}

/// chat() with the secrets.json the OpenAI key's origin is bound in (the tests use a temporary one).
#[allow(clippy::too_many_arguments)]
async fn chat_using(secrets_path: &Path, cfg: &AppConfig, settings: &LlmSettings, secrets: &Secrets, messages: Vec<ChatMessage>, schema: Option<Value>, purpose: ThinkingPurpose, attempt: Attempt) -> Result<ChatResult> {
    let t0 = std::time::Instant::now();
    match settings.provider.as_str() {
        "anthropic" => {
            if secrets.anthropic_api_key.is_empty() {
                bail!("Anthropic API キーが設定されていません");
            }
            let body = anthropic_body(settings, &messages, schema.as_ref());
            let r = chat_client(ANTHROPIC_MESSAGES_URL)?
                .post(ANTHROPIC_MESSAGES_URL)
                .header("x-api-key", &secrets.anthropic_api_key)
                .header("anthropic-version", "2023-06-01")
                .header("content-type", "application/json")
                .json(&body)
                .send()
                .await
                .map_err(|e| send_error(e, "api.anthropic.com"))?;
            let status = r.status();
            let v: Value = r.json().await.unwrap_or(Value::Null);
            if !status.is_success() {
                bail!("Anthropic API エラー {status}: {}", v.pointer("/error/message").and_then(|m| m.as_str()).unwrap_or(""));
            }
            let content = anthropic_content(&v)?;
            Ok(ChatResult {
                content,
                prompt_tokens: v.pointer("/usage/input_tokens").and_then(|x| x.as_u64()).unwrap_or(0),
                completion_tokens: v.pointer("/usage/output_tokens").and_then(|x| x.as_u64()).unwrap_or(0),
                seconds: t0.elapsed().as_secs_f64(),
                provider: "anthropic".into(),
                attempts: 1,
            })
        }
        provider => {
            // OpenAI-compatible: local llama-server or a cloud endpoint.
            let mut first_openai_use = None;
            let (base, key, model) = if provider == "openai" {
                if secrets.openai_api_key.is_empty() {
                    bail!("OpenAI 互換 API のキーが設定されていません");
                }
                let base = settings.openai_base_url.trim().trim_end_matches('/').to_string();
                // Refused for another origin; a first use binds the key before it is sent (released below
                // when none of its requests reached a server).
                first_openai_use = claim_openai_origin(secrets_path, secrets, &base)?;
                (base, secrets.openai_api_key.clone(), settings.openai_model.clone())
            } else {
                // The app's llama-server requires its key; a server started elsewhere ignores it.
                (format!("http://127.0.0.1:{}/v1", cfg.llm_port), read_llama_api_key().unwrap_or_default(), "local".to_string())
            };
            let body = openai_body(provider, settings, &base, &model, &messages, schema.as_ref(), purpose, attempt);
            let mut req = chat_client(&base)?.post(format!("{base}/chat/completions")).json(&body);
            if !key.is_empty() {
                req = req.bearer_auth(&key);
            }
            let r = match req.send().await {
                Ok(r) => r,
                Err(e) => {
                    // No connection (a Base URL typo, a host that is down, a connect that timed out): the key
                    // was not sent. The request's own timeout may have fired after it went out: kept bound.
                    if let Some(id) = first_openai_use.filter(|_| reached_no_server(&e)) {
                        release_openai_origin(id);
                    }
                    return Err(send_error(e, &base));
                }
            };
            let status = r.status();
            let v: Value = r.json().await.unwrap_or(Value::Null);
            if !status.is_success() {
                if provider == "local" {
                    if let Some(m) = local_http_error(status, &v, cfg.llm_port, has_earlier_turns(&messages), purpose) {
                        bail!("{m}");
                    }
                }
                bail!("LLM API エラー {status}: {}", v.pointer("/error/message").and_then(|m| m.as_str()).or_else(|| v.get("error").and_then(|e| e.as_str())).unwrap_or(""));
            }
            let content = openai_content(&v, provider, settings, purpose, attempt)?;
            Ok(ChatResult {
                content,
                prompt_tokens: v.pointer("/usage/prompt_tokens").and_then(|x| x.as_u64()).unwrap_or(0),
                completion_tokens: v.pointer("/usage/completion_tokens").and_then(|x| x.as_u64()).unwrap_or(0),
                seconds: t0.elapsed().as_secs_f64(),
                provider: provider.into(),
                attempts: 1,
            })
        }
    }
}

/// Remove `<think>...</think>` blocks some models emit even with structured output. An unclosed
/// `<think>` (the reply ended while thinking) drops everything after it.
fn strip_think(s: &str) -> String {
    let mut out = s.to_string();
    while let Some(start) = out.find("<think>") {
        if let Some(end) = out[start..].find("</think>") {
            out.replace_range(start..start + end + 8, "");
        } else {
            out.truncate(start);
            break;
        }
    }
    out.trim().to_string()
}

/// System prompt with the YuE2 ABC dialect contract (from the official editing references:
/// YuE-main docs/editing.md, skills/yue2-music/references/abc-editing.md and editing-workflows.md,
/// scripts/abc_tools.py).
pub fn edit_system_prompt() -> String {
    r#"You are a music editing assistant inside "Music Creator Studio YuE2". The user works with the YuE2 music generation model. You edit three things on request: the ABC score, the English style prompt, and the lyrics. Reply ONLY with the JSON object requested (fields abc, style, lyrics, explanation). Put the complete new value in a field when it changes and an empty string when it does not. `explanation` is a short Japanese explanation.

YuE2 ABC dialect (strict — otherwise generation degrades or breaks):
- Headers in this order: X:1, T: (left empty), M:<num>/<den>, L:1/<power of two>, Q:1/4=<bpm>, then two voice declarations
  V: Vocal clef=treble name="Vocal Melody" snm="Vocal"
  V: Ins clef=treble name="Ins Melody" snm="Inst."
  then K:<key>.
- Keep the source's X:, V: lines, L:, M: and K: exactly as they are unless the user asks to change them. L: is often 1/32 but not always: never rewrite it; if it really must change, rescale every duration so the rhythm stays the same.
- K: must be a standard major or minor key (C, G, F#, Bb, Am, C#m, ...). M: must be an explicit fraction such as 4/4, 3/4 or 6/8 (never C or C|).
- Body = sections introduced by comment lines like "% intro", "% verse", "% pre-chorus", "% chorus", "% bridge", "% interlude", "% instrumental", "% outro". Comments start with "% "; never write "%%" directives. Inside a section, blocks alternate "V: Vocal" then "V: Ins", each block holding 1–4 bars of that voice (after expanding Z rests), separated by "|", and each music line ends with "|". Both voices must cover the same bars.
- Bar length: every bar of each voice totals exactly (M numerator / M denominator) × (L denominator) units — 4/4 at L:1/32 = 32, 3/4 and 6/8 at L:1/32 = 24, 4/4 at L:1/16 = 16.
- Each voice is MONOPHONIC. Notes: letter A–G (octave 4) or a–g (octave 5), octave marks ' and , ; accidentals ^ _ = before the letter. An accidental applies to that letter in EVERY octave until the barline (after ^F, both F and f are sharp in that bar); cancel it with an explicit =. Durations are integer multiples of L (1,2,3,4,6,8,12,16,24,32,48); any other length is written as tied pieces (10 units = C8-C2, or z8z2 for a rest). Rests are z<n>.
- Whole-bar rests are Z, Z2, Z3 or Z4 only (1–4 resting bars). Where a chord symbol sits in a resting stretch of the Vocal part, write ordinary rests with the chord at its onset ("Am7"z32), never "Am7"Z; Z is fine in Ins.
- Ties use "-" at the end of a note (e.g. c8-|c8). A tie joins only two notes of the same pitch; never tie into or out of a rest, and never leave a tie open at the end of the score.
- Chord symbols are quoted strings placed only in the Vocal voice, before the note/rest they start on, e.g. "Am7"z16 or "F"c4. A chord change inside a held note splits the note with a tie at the change point, e.g. "C"E16-"Am7"E16 (no new attack). Allowed qualities: major (none), m, dim, aug, 7, maj7, m7, dim7, m7b5, sus4, sus2, 6, m6, 7sus4, m(maj7); slash bass allowed (e.g. G/B). No 9ths/13ths/alt, no tuplets, no grace notes, no chord stacks [CEG], no repeats, no slurs, no w: lyric lines.
- Keep the total number of bars unless the user asks to lengthen/shorten. Keep vocal notes inside a singable range (roughly G3–G5 for a female voice, C3–C5 for a male voice) unless told otherwise.
- When the user asks about mood, groove, instruments or tempo feel, edit the style prompt (comma-separated English descriptors, e.g. "Japanese, city pop, warm female vocal, Rhodes piano, slap bass, 104 BPM").
- Tempo lives in two places that must always agree: Q:1/4=<n> in the score and "<n> BPM" in the style (when the style names a BPM). If you change one, change the other in the same reply and return BOTH complete fields (the full score and the full style). Never change only one of them.
- When asked to reharmonize, keep the melody notes unchanged unless told otherwise and change only the quoted chord symbols, keeping one chord per marked position.
- Score form and lyrics stay in step: when a sung section (one whose Vocal part has notes) is added, removed, duplicated or reordered, return the complete lyrics with the matching [Section] block added, removed, duplicated or reordered the same way. Instrumental sections (only rests in V: Vocal) need no lyric block.
- When rewriting lyrics (or the Vocal melody), keep each section's sung syllables close to the number of Vocal notes of that section (count tied notes once) and follow its phrasing and phrase lengths; matching only the total count is not enough.
- Never invent lyrics in a language the user did not use. Lyrics use [Verse]/[Chorus]/[Bridge]... tags on their own lines. The `lyrics` field is always the display text as the user writes it (kanji and kana for Japanese); a [SUNG LYRICS] block in the context is a read-only hiragana reading for counting syllables (morae) — never return that hiragana-only text as `lyrics`.

CRITICAL: when the score changes, `abc` must contain the ENTIRE score from "X:1" to the last bar of the last section — every section and every bar of BOTH voices, including the unchanged ones. Never return only the edited section, an excerpt, or "..." placeholders. A partial score is rejected. If the score is unchanged, return an empty string for `abc`.
"#.to_string()
}

/// The per-turn context block (current style / lyrics / optional sung reading / score).
pub fn edit_context(style: &str, lyrics: &str, sung_lyrics: Option<&str>, abc: &str) -> String {
    let mut s = format!("現在の状態:\n\n[STYLE]\n{style}\n\n[LYRICS]\n{lyrics}\n\n");
    if let Some(sung) = sung_lyrics.map(|t| t.trim()).filter(|t| !t.is_empty()) {
        s.push_str(&format!("[SUNG LYRICS (hiragana, read-only reference)]\n{sung}\n\n"));
    }
    s.push_str(&format!("[ABC]\n{}\n", if abc.trim().is_empty() { "(譜面なし)" } else { abc }));
    s
}

/// What the assistant "said" after the current state: every edit conversation opens the same way.
const EDIT_STATE_ACK: &str = "{\"abc\":\"\",\"style\":\"\",\"lyrics\":\"\",\"explanation\":\"現在の状態を確認しました。編集の指示をどうぞ。\"}";

/// The messages of one edit turn (llm_edit): the system prompt, the current state, its acknowledgement, the
/// earlier turns (user and assistant messages only) and the instruction.
pub fn edit_messages(abc: &str, style: &str, lyrics: &str, sung_lyrics: Option<&str>, history: Vec<ChatMessage>, instruction: String) -> Vec<ChatMessage> {
    let mut messages = vec![
        ChatMessage { role: "system".into(), content: edit_system_prompt() },
        ChatMessage { role: "user".into(), content: edit_context(style, lyrics, sung_lyrics, abc) },
        ChatMessage { role: "assistant".into(), content: EDIT_STATE_ACK.into() },
    ];
    messages.extend(history.into_iter().filter(|m| m.role == "user" || m.role == "assistant"));
    messages.push(ChatMessage { role: "user".into(), content: instruction });
    messages
}

/// The fields of an edit reply: abc, style, lyrics, explanation ("" when a field is missing or not text). Some
/// models wrap the JSON in code fences; any other text is an error naming the start of the reply.
pub fn parse_edit_reply(content: &str) -> std::result::Result<[String; 4], String> {
    let parsed: Value = serde_json::from_str(content)
        .or_else(|_| {
            let t = content.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
            serde_json::from_str(t)
        })
        .map_err(|e| format!("LLM の応答を JSON として解釈できません: {e}\n{}", content.chars().take(500).collect::<String>()))?;
    let g = |k: &str| parsed.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    Ok([g("abc"), g("style"), g("lyrics"), g("explanation")])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_context_size_matches_rules_ts() {
        // The settings page marks this value 「（既定）」 (src/config/rules.ts llmContextSizeLabel).
        let rules = include_str!("../../src/config/rules.ts");
        let n = LlmSettings::defaults().context_size;
        assert!(rules.contains(&format!("export const LLM_CONTEXT_SIZE_DEFAULT = {n};")), "LLM_CONTEXT_SIZE_DEFAULT in rules.ts must be {n}");
    }

    #[test]
    fn edit_prompt_keeps_the_contract_and_adds_official_rules() {
        let p = edit_system_prompt();
        for needle in [
            "ENTIRE score from \"X:1\"",
            "L:1/<power of two>",
            "Keep the source's X:, V: lines, L:, M: and K:",
            "(M numerator / M denominator) × (L denominator)",
            "Z, Z2, Z3 or Z4 only",
            "(\"Am7\"z32), never \"Am7\"Z",
            "in EVERY octave until the barline",
            "explicit =",
            "same pitch; never tie into or out of a rest",
            "\"C\"E16-\"Am7\"E16",
            "standard major or minor key",
            "T: (left empty)",
            "never write \"%%\"",
            "% pre-chorus",
            "% interlude",
            "% instrumental",
            "Never change only one of them",
            "matching [Section] block",
            "Instrumental sections",
            "sung syllables close to the number of Vocal notes",
            "display text",
            "otherwise generation degrades or breaks",
        ] {
            assert!(p.contains(needle), "missing: {needle}");
        }
        assert!(!p.contains("the model rejects anything else"));
        assert!(!p.contains("and/or Q: tempo"));
        // Stays small next to the 16k local context (roughly 4 chars per token).
        assert!(p.len() < 9000, "prompt is {} bytes", p.len());
    }

    #[test]
    fn edit_context_includes_sung_lyrics_only_when_given() {
        let c = edit_context("pop", "[Verse]\n空", None, "");
        assert!(c.contains("[LYRICS]\n[Verse]\n空") && c.contains("(譜面なし)") && !c.contains("SUNG LYRICS"));
        let c = edit_context("pop", "[Verse]\n空", Some("[Verse]\nそら"), "X:1");
        assert!(c.contains("[SUNG LYRICS (hiragana, read-only reference)]\n[Verse]\nそら"));
        assert!(c.ends_with("[ABC]\nX:1\n"));
        assert!(!edit_context("pop", "l", Some("  "), "X:1").contains("SUNG"));
    }

    fn msgs() -> Vec<ChatMessage> {
        vec![ChatMessage { role: "system".into(), content: "sys".into() }, ChatMessage { role: "user".into(), content: "hi".into() }]
    }

    #[test]
    fn anthropic_body_sends_no_sampling_parameters() {
        let s = LlmSettings::defaults();
        let b = anthropic_body(&s, &msgs(), Some(&edit_schema()));
        assert!(b.get("temperature").is_none() && b.get("top_p").is_none());
        assert_eq!(b["max_tokens"], 16000);
        assert_eq!(b["system"], "sys");
        assert_eq!(b["messages"].as_array().unwrap().len(), 1);
        assert_eq!(b["output_config"]["format"]["type"], "json_schema");
        // edit_schema has nothing to strip.
        assert_eq!(b["output_config"]["format"]["schema"], edit_schema());
        assert!(anthropic_body(&s, &msgs(), None).get("output_config").is_none());
    }

    #[test]
    fn openai_body_depends_on_host_and_model() {
        let s = LlmSettings::defaults();
        let edit = ThinkingPurpose::Edit;
        // api.openai.com + reasoning model: max_completion_tokens, no temperature, no max_tokens.
        let b = openai_body("openai", &s, "https://api.openai.com/v1", "gpt-5-mini", &msgs(), None, edit, Attempt::First);
        assert_eq!(b["max_completion_tokens"], 16000);
        assert!(b.get("temperature").is_none() && b.get("max_tokens").is_none());
        // api.openai.com + a sampling model keeps temperature.
        let b = openai_body("openai", &s, "https://api.openai.com/v1", "gpt-4.1", &msgs(), None, edit, Attempt::First);
        assert_eq!(b["temperature"], 0.3);
        assert!(b.get("max_tokens").is_none());
        // Another compatible host: unchanged body, no llama.cpp-only fields (a draft too).
        for p in [edit, ThinkingPurpose::Draft] {
            let b = openai_body("openai", &s, "http://192.168.1.5:1234/v1", "gpt-5-mini", &msgs(), None, p, Attempt::First);
            assert_eq!(b["max_tokens"], 8192);
            assert_eq!(b["temperature"], 0.3);
            assert!(b.get("reasoning_budget_tokens").is_none() && b.get("chat_template_kwargs").is_none());
        }
        // Local llama-server: max_tokens, temperature, thinking switch, schema, and the edit's thinking budget.
        let b = openai_body("local", &s, "http://127.0.0.1:8099/v1", "local", &msgs(), Some(&edit_schema()), edit, Attempt::First);
        assert_eq!(b["max_tokens"], 8192);
        assert_eq!(b["temperature"], 0.3);
        assert_eq!(b["chat_template_kwargs"]["enable_thinking"], true);
        assert_eq!(b["response_format"]["json_schema"]["strict"], true);
        assert_eq!(b["reasoning_budget_tokens"], 4096);
        assert_eq!(b["reasoning_budget_message"], thinking_budget_message(edit));
        // An edit samples as llama-server does by default (no draft sampling), on either attempt.
        for k in ["top_k", "top_p", "min_p", "presence_penalty"] {
            assert!(b.get(k).is_none(), "{k}");
        }
        assert_eq!(openai_body("local", &s, "http://127.0.0.1:8099/v1", "local", &msgs(), Some(&edit_schema()), edit, Attempt::Retry), b);
    }

    #[test]
    fn local_thinking_budget_follows_purpose_and_settings() {
        let s = LlmSettings::defaults();
        let draft = ThinkingPurpose::Draft;
        // Default (thinking on, cap on): a draft thinks for at most 1024 tokens and answers within 3072 more.
        assert_eq!(s.thinking_budget(draft), Some(1024));
        assert_eq!(s.thinking_budget(ThinkingPurpose::Edit), Some(4096));
        let b = openai_body("local", &s, "http://127.0.0.1:8099/v1", "local", &msgs(), None, draft, Attempt::First);
        assert_eq!(b["reasoning_budget_tokens"], 1024);
        assert_eq!(b["max_tokens"], 1024 + 3072);
        // The budget message: the Qwen team's sentence, then what to write now (a blank line first, as the
        // server inserts it right after the last thinking token).
        let m = thinking_budget_message(draft);
        assert_eq!(b["reasoning_budget_message"], m);
        assert!(m.starts_with("\n\nConsidering the limited time by the user, I have to give the solution based on the thinking directly now. I will now write the final JSON") && m.ends_with(".\n"), "{m}");
        assert!(m.contains("without counting syllables again"), "{m}");
        let e = thinking_budget_message(ThinkingPurpose::Edit);
        assert!(e.starts_with(THINKING_BUDGET_MESSAGE) && e.contains("complete result") && !e.contains("syllables") && e.ends_with(".\n"), "{e}");
        // Cap off: the thinking runs as it likes, the whole output budget is available (and may run out).
        let uncapped = LlmSettings { limit_thinking: false, ..s.clone() };
        assert_eq!(uncapped.thinking_budget(draft), None);
        let b = openai_body("local", &uncapped, "http://127.0.0.1:8099/v1", "local", &msgs(), None, draft, Attempt::First);
        assert!(b.get("reasoning_budget_tokens").is_none() && b.get("reasoning_budget_message").is_none());
        assert_eq!(b["max_tokens"], 8192);
        assert_eq!(b["chat_template_kwargs"]["enable_thinking"], true);
        // Thinking off: no budget fields (nothing to cap); a draft's answer alone needs 3072 at most.
        let off = LlmSettings { thinking: false, ..s.clone() };
        assert_eq!(off.thinking_budget(draft), None);
        let b = openai_body("local", &off, "http://127.0.0.1:8099/v1", "local", &msgs(), None, draft, Attempt::First);
        assert!(b.get("reasoning_budget_tokens").is_none());
        assert_eq!(b["max_tokens"], 3072);
        assert_eq!(b["chat_template_kwargs"]["enable_thinking"], false);
        assert_eq!(openai_body("local", &off, "http://127.0.0.1:8099/v1", "local", &msgs(), None, ThinkingPurpose::Edit, Attempt::First)["max_tokens"], 8192);
        // An old config.json without the switch keeps the cap on.
        let old: LlmSettings = serde_json::from_str(r#"{"provider":"local","thinking":true}"#).unwrap();
        assert!(old.limit_thinking);
        assert_eq!(serde_json::to_value(&s).unwrap()["limitThinking"], true);
    }

    #[test]
    fn reasoning_models_are_recognised() {
        for m in ["gpt-5", "gpt-5-mini", "GPT-5.1", "o1", "o3-mini", "o4-mini"] {
            assert!(is_reasoning_model(m), "{m}");
        }
        for m in ["gpt-5-chat-latest", "gpt-4.1", "gpt-4o", "o10", "omni"] {
            assert!(!is_reasoning_model(m), "{m}");
        }
    }

    #[test]
    fn anthropic_schema_strips_unsupported_constraints() {
        let song = json!({
            "type": "object",
            "properties": {
                "selections": {
                    "type": "object",
                    "properties": {
                        "genres": { "type": "array", "items": { "type": "string", "enum": ["pop", "rock"] }, "minItems": 1, "maxItems": 3 },
                        "voice": { "type": "array", "items": { "type": "string", "enum": ["airy"] }, "maxItems": 3 },
                        "moods": { "type": "array", "items": { "type": "string" }, "minItems": 2 },
                        "bpm": { "type": "integer", "minimum": 40, "maximum": 220, "description": "テンポ" },
                        "name": { "type": "string", "maxLength": 20 }
                    },
                    "required": ["genres", "bpm"],
                    "additionalProperties": false
                },
                "alt": { "anyOf": [{ "type": "integer", "exclusiveMinimum": 0 }, { "type": "null" }] }
            },
            "required": ["selections"],
            "additionalProperties": false
        });
        let s = anthropic_schema(&song);
        let text = s.to_string();
        for k in ["\"maxItems\"", "\"minimum\"", "\"maximum\"", "\"maxLength\"", "\"exclusiveMinimum\""] {
            assert!(!text.contains(k), "{k} left in {text}");
        }
        let sel = &s["properties"]["selections"];
        assert_eq!(sel["properties"]["genres"]["minItems"], 1, "minItems 1 is supported");
        assert_eq!(sel["properties"]["genres"]["items"]["enum"], json!(["pop", "rock"]));
        assert_eq!(sel["properties"]["genres"]["description"], "1〜3 個");
        assert_eq!(sel["properties"]["voice"]["description"], "3 個以下");
        assert!(sel["properties"]["moods"].get("minItems").is_none());
        assert_eq!(sel["properties"]["moods"]["description"], "2 個以上");
        assert_eq!(sel["properties"]["bpm"]["description"], "テンポ（40〜220）");
        assert_eq!(sel["properties"]["name"]["description"], "20 文字以下");
        assert_eq!(sel["required"], json!(["genres", "bpm"]));
        assert_eq!(sel["additionalProperties"], false);
        assert_eq!(s["properties"]["alt"]["anyOf"][0]["description"], "0 より大きい");
        // A property literally named like a keyword is a name, not a constraint.
        let named = anthropic_schema(&json!({ "type": "object", "properties": { "maximum": { "type": "string" } } }));
        assert_eq!(named["properties"]["maximum"]["type"], "string");
    }

    #[test]
    fn truncation_and_refusal_are_reported() {
        let e = anthropic_content(&json!({ "stop_reason": "max_tokens", "content": [{ "type": "text", "text": "{\"abc\":" }] })).unwrap_err();
        assert!(e.to_string().contains("出力上限"));
        assert!(anthropic_content(&json!({ "stop_reason": "refusal", "content": [] })).unwrap_err().to_string().contains("拒否"));
        assert_eq!(anthropic_content(&json!({ "stop_reason": "end_turn", "content": [{ "text": "a" }, { "text": "b" }] })).unwrap(), "ab");

        let local = LlmSettings::defaults();
        let draft = ThinkingPurpose::Draft;
        let cut = json!({ "choices": [{ "finish_reason": "length", "message": { "content": "{\"a" } }] });
        // Default (capped thinking): the thinking cannot have eaten the budget, so only the request is named.
        let e = openai_content(&cut, "local", &local, draft, Attempt::First).unwrap_err().to_string();
        assert!(e.contains("4096 トークン") && e.contains("思考は 1024 トークンで打ち切り済み") && e.contains("曲の長さや編集の範囲"), "{e}");
        assert!(!e.contains("思考モード"), "{e}");
        let e = openai_content(&cut, "local", &local, ThinkingPurpose::Edit, Attempt::First).unwrap_err().to_string();
        assert!(e.contains("8192 トークン") && e.contains("4096 トークンで打ち切り済み"), "{e}");
        // Cap off: the thinking may be the reason, the settings are named.
        let uncapped = LlmSettings { limit_thinking: false, ..local.clone() };
        let e = openai_content(&cut, "local", &uncapped, draft, Attempt::First).unwrap_err().to_string();
        assert!(e.contains("8192 トークン、思考を含む") && e.contains("思考の長さを自動で制限する") && e.contains("思考モード"), "{e}");
        // Thinking off: the draft's own limit.
        let off = LlmSettings { thinking: false, ..local.clone() };
        let e = openai_content(&cut, "local", &off, draft, Attempt::First).unwrap_err().to_string();
        assert!(e.contains("3072 トークン") && !e.contains("思考"), "{e}");
        // llama-server stopped by a full context before max_tokens: what was left of the context is named.
        let full = json!({ "choices": [{ "finish_reason": "length", "message": { "content": "{\"a" } }], "usage": { "prompt_tokens": 14000, "completion_tokens": 2384 } });
        let e = openai_content(&full, "local", &local, ThinkingPurpose::Edit, Attempt::First).unwrap_err().to_string();
        assert!(e.contains("コンテキストの残り（2384 トークン") && e.contains("14000 トークン") && e.contains("コンテキスト長を増やして") && !e.contains("8192"), "{e}");
        // All of max_tokens used: the output cap cut it, as before; a cloud reply never names the local context.
        let spent = json!({ "choices": [{ "finish_reason": "length", "message": { "content": "{\"a" } }], "usage": { "prompt_tokens": 3000, "completion_tokens": 8192 } });
        let e = openai_content(&spent, "local", &local, ThinkingPurpose::Edit, Attempt::First).unwrap_err().to_string();
        assert!(e.contains("8192 トークン") && !e.contains("コンテキスト"), "{e}");
        let e = openai_content(&full, "openai", &local, ThinkingPurpose::Edit, Attempt::First).unwrap_err().to_string();
        assert!(e.contains("長さ上限") && !e.contains("コンテキスト"), "{e}");
        // Cap off and the context full: the uncapped thinking is the likely cause, so the thinking settings
        // come first and the context after them.
        let e = openai_content(&full, "local", &uncapped, ThinkingPurpose::Edit, Attempt::First).unwrap_err().to_string();
        assert!(e.contains("コンテキストの残り（2384 トークン、思考を含む") && e.contains("14000 トークン") && e.contains("思考の長さを自動で制限する") && e.contains("思考モード"), "{e}");
        assert!(e.find("思考の長さを自動で制限する") < e.find("コンテキスト長を増やして") && !e.contains("8192"), "{e}");
        let e = openai_content(&json!({ "choices": [{ "finish_reason": "length", "message": { "content": "" } }] }), "openai", &local, draft, Attempt::First).unwrap_err();
        assert!(e.to_string().contains("長さ上限") && !e.to_string().contains("思考") && e.to_string().contains("出力上限の大きいモデル"));
        let e = openai_content(&json!({ "choices": [{ "finish_reason": "content_filter", "message": { "content": null } }] }), "openai", &local, draft, Attempt::First).unwrap_err();
        assert!(e.to_string().contains("コンテンツフィルター"));
        let only = json!({ "choices": [{ "finish_reason": "stop", "message": { "content": "", "reasoning_content": "hmm" } }] });
        let e = openai_content(&only, "local", &local, draft, Attempt::First).unwrap_err().to_string();
        assert!(e.contains("思考だけ") && e.contains("もう一度") && !e.contains("思考モード"), "{e}");
        let e = openai_content(&only, "local", &uncapped, draft, Attempt::First).unwrap_err().to_string();
        assert!(e.contains("思考だけ") && e.contains("思考の長さを自動で制限する"), "{e}");
        assert!(openai_content(&json!({ "choices": [] }), "local", &local, draft, Attempt::First).unwrap_err().to_string().contains("content"));
        assert_eq!(openai_content(&json!({ "choices": [{ "finish_reason": "stop", "message": { "content": "<think>x</think> {}" } }] }), "local", &local, draft, Attempt::First).unwrap(), "{}");
        // OpenAI structured outputs: a refusal has no content but its own field (finish_reason "stop"); the user
        // is told the request was refused and why, not to try the same request again.
        let refused = json!({ "choices": [{ "finish_reason": "stop", "message": { "role": "assistant", "content": null, "refusal": "I'm sorry, I cannot assist with that request." } }] });
        let e = openai_content(&refused, "openai", &local, draft, Attempt::First).unwrap_err().to_string();
        assert!(e.contains("拒否") && e.contains("I'm sorry, I cannot assist with that request.") && !e.contains("本文"), "{e}");
        // An empty or null refusal field (some compatible servers always send one) is no refusal.
        for r in [Value::Null, json!(""), json!("  ")] {
            let ok = json!({ "choices": [{ "finish_reason": "stop", "message": { "content": "{}", "refusal": r } }] });
            assert_eq!(openai_content(&ok, "openai", &local, draft, Attempt::First).unwrap(), "{}");
        }
    }

    #[test]
    fn loopback_requests_never_go_through_a_proxy() {
        // reqwest lists the proxies a client may use in its Debug output. A default client has the system
        // (environment) matcher, so HTTP_PROXY / ALL_PROXY would get the app's own requests to 127.0.0.1.
        let proxied = |c: reqwest::Client| format!("{c:?}").contains("proxies");
        assert!(proxied(reqwest::Client::new()), "the checks below rely on reqwest listing its proxies");
        assert!(!proxied(loopback_client(Duration::from_secs(2), false).unwrap()), "llama_health");
        for base in ["http://127.0.0.1:8099/v1", "http://localhost:1234/v1", "http://LOCALHOST:1234/v1", "http://[::1]:8000/v1", "http://127.0.0.2:8000/v1"] {
            assert!(!proxied(chat_client(base).unwrap()), "{base}");
        }
        // Cloud and LAN endpoints keep the proxy settings.
        for base in [ANTHROPIC_MESSAGES_URL, "https://api.openai.com/v1", "http://192.168.1.5:1234/v1", "http://localhost.example.com/v1", "not a url"] {
            assert!(proxied(chat_client(base).unwrap()), "{base}");
        }
    }

    #[test]
    fn plain_http_loopback_clients_skip_the_windows_certificate_store() {
        // reqwest does not show its root store in Debug: the builder calls are pinned in the source instead.
        let src = include_str!("llm.rs");
        let body = |head: &str| {
            let s = &src[src.find(head).unwrap_or_else(|| panic!("{head}"))..];
            s[..s.find("\n}\n").unwrap()].to_string()
        };
        assert!(body("fn loopback_client(").contains(".no_proxy().tls_built_in_native_certs(https)"));
        assert!(body("pub async fn llama_health(").contains("loopback_client(Duration::from_secs(2), false)"));
        assert!(body("fn chat_client(").contains("loopback_client(CHAT_TIMEOUT, is_https_url(base_url))"));
        // Only an https:// Base URL on this PC keeps the store (a certificate trusted only through it).
        for (url, https) in [("http://127.0.0.1:8099/v1", false), ("http://localhost:1234/v1", false), ("https://localhost:8443/v1", true), (" HTTPS://[::1]:8443/v1 ", true), ("not a url", false)] {
            assert_eq!(is_https_url(url), https, "{url}");
        }
        assert!(loopback_client(Duration::from_secs(2), true).is_ok());
    }

    #[tokio::test]
    async fn connect_failures_name_the_proxy_only_for_https_endpoints() {
        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap(); // closed once dropped
        let refused = || async move { loopback_client(Duration::from_secs(5), false).unwrap().get(format!("http://{closed}/v1")).send().await.unwrap_err() };
        let e = refused().await;
        assert!(e.is_connect() && !crate::setup::is_certificate_error(&e), "{e:?}");
        let m = send_error(e, "api.anthropic.com").to_string();
        assert!(m.contains("接続できません（api.anthropic.com）") && m.contains("HTTPS_PROXY"), "{m}");
        let m = send_error(refused().await, "https://example.com/v1").to_string();
        assert!(m.contains("HTTPS_PROXY"), "{m}");
        // The local server and a plain-HTTP host on the LAN are reached without a proxy.
        let m = send_error(refused().await, &format!("http://{closed}/v1")).to_string();
        assert_eq!(m, format!("LLM サーバーに接続できません（http://{closed}/v1）"));
        // So is an https:// server on this PC: chat_client never uses a proxy there.
        let (a, b, c) = tokio::join!(refused(), refused(), refused()); // a refused connect takes seconds on Windows
        for (e, local) in [(a, "https://localhost:8443/v1"), (b, "https://127.0.0.1:8443/v1"), (c, "https://[::1]:8443/v1")] {
            assert_eq!(send_error(e, local).to_string(), format!("LLM サーバーに接続できません（{local}）"));
        }
        // The reqwest error stays in the chain (lib.rs retries the local server by its type).
        assert!(send_error(refused().await, "api.anthropic.com").chain().any(|c| c.downcast_ref::<reqwest::Error>().is_some_and(|r| r.is_connect())));
    }

    #[tokio::test]
    async fn a_timed_out_connect_is_a_connect_failure_not_a_slow_answer() {
        // A server that accepts connections and never answers. A TLS handshake with it never ends, so the
        // connect times out (like Windows giving up on a host that drops the connection attempt); a plain-HTTP
        // request goes out and gets no reply until the request's own timeout (like CHAT_TIMEOUT).
        let silent = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = silent.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((s, _)) = silent.accept().await {
                held.push(s);
            }
        });
        let short = Duration::from_millis(300);
        let connect = reqwest::Client::builder().no_proxy().connect_timeout(short).build().unwrap().get(format!("https://{addr}/v1")).send().await.unwrap_err();
        assert!(connect.is_connect() && connect.is_timeout(), "{connect:?}");
        let answer = reqwest::Client::builder().no_proxy().timeout(short).build().unwrap().get(format!("http://{addr}/v1")).send().await.unwrap_err();
        assert!(answer.is_timeout() && !answer.is_connect(), "{answer:?}");
        // A timed-out connect never sent the request (a first use's binding is released); a request that
        // went out before its timeout may have delivered the key.
        assert!(reached_no_server(&connect), "a connect timeout keeps the binding");
        assert!(!reached_no_server(&answer));
        // The message names the connection (and for an https endpoint the proxy), not a slow answer.
        let m = send_error(connect, "api.anthropic.com").to_string();
        assert!(m.contains("接続できません（api.anthropic.com）") && m.contains("HTTPS_PROXY") && !m.contains("タイムアウト"), "{m}");
        assert_eq!(send_error(answer, "api.anthropic.com").to_string(), "LLM の応答がタイムアウトしました（api.anthropic.com）");
        server.abort();
    }

    #[test]
    fn a_failed_first_use_keeps_a_binding_an_overlapping_request_relied_on() {
        let dir = std::env::temp_dir().join(format!("mcs-overlap-{}", uuid::Uuid::new_v4().simple()));
        let path = dir.join("secrets.json");
        let base = "http://localhost:1234/v1";
        let secrets = Secrets { openai_api_key: "sk-a".into(), ..Default::default() };
        secrets.save_to(&path).unwrap();
        let bound = || Secrets::load_from(&path).openai_key_bound_origin().map(str::to_string);
        // R1 binds the new key; R2 starts before R1's connect fails. R1 reaches no server, R2 does and sends
        // the key: the binding stays.
        let r1 = claim_openai_origin(&path, &secrets, base).unwrap();
        assert!(r1.is_some());
        assert_eq!(claim_openai_origin(&path, &secrets, base).unwrap(), r1, "R2 counts in R1's first use");
        release_openai_origin(r1.unwrap());
        assert_eq!(bound().as_deref(), Some("http://localhost:1234"), "the key went to R2's server");

        // A new key whose two overlapping requests both reach no server (a typo): released after the last one.
        let fresh = Secrets { openai_api_key: "sk-b".into(), ..Default::default() };
        fresh.save_to(&path).unwrap();
        let first = claim_openai_origin(&path, &fresh, base).unwrap().unwrap();
        assert_eq!(claim_openai_origin(&path, &fresh, base).unwrap(), Some(first));
        release_openai_origin(first);
        assert!(bound().is_some(), "the other request may still reach the server");
        release_openai_origin(first);
        assert_eq!(Secrets::load_from(&path), fresh, "neither request reached a server");

        // The key saved again meanwhile (the binding cleared) and bound by a newer first use: an older first
        // use's connect failure leaves the newer binding alone.
        let old = claim_openai_origin(&path, &fresh, base).unwrap().unwrap();
        fresh.save_to(&path).unwrap();
        let newer = claim_openai_origin(&path, &fresh, base).unwrap().unwrap();
        assert_ne!(old, newer);
        release_openai_origin(old);
        assert_eq!(bound().as_deref(), Some("http://localhost:1234"));
        release_openai_origin(newer);
        assert_eq!(Secrets::load_from(&path), fresh);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A server on 127.0.0.1 that counts the connections it gets and closes them at once (a request sent
    /// there fails fast instead of waiting for an answer).
    async fn counting_server() -> (u16, std::sync::Arc<std::sync::atomic::AtomicUsize>, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let h = hits.clone();
        let server = tokio::spawn(async move {
            while let Ok((s, _)) = listener.accept().await {
                h.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                drop(s);
            }
        });
        (port, hits, server)
    }

    /// An OpenAI-compatible request to 127.0.0.1:<port>, with the origin bindings kept in `secrets_path`.
    async fn openai_chat(secrets_path: &Path, port: u16, secrets: &Secrets) -> Result<ChatResult> {
        let settings = LlmSettings { provider: "openai".into(), openai_base_url: format!("http://127.0.0.1:{port}/v1"), ..LlmSettings::defaults() };
        chat_using(secrets_path, &AppConfig::default(), &settings, secrets, msgs(), Some(edit_schema()), ThinkingPurpose::Edit, Attempt::First).await
    }

    #[tokio::test]
    async fn chat_refuses_a_key_bound_elsewhere_before_connecting() {
        // The stored key belongs to api.openai.com; the Base URL now points at another host.
        let (port, hits, server) = counting_server().await;
        let path = std::env::temp_dir().join(format!("mcs-bound-{}", uuid::Uuid::new_v4().simple())).join("secrets.json");
        let secrets = Secrets { openai_api_key: "sk-a".into(), openai_key_fingerprint: key_fingerprint("sk-a"), openai_key_origin: "https://api.openai.com".into(), ..Default::default() };
        let r = tokio::time::timeout(Duration::from_secs(30), openai_chat(&path, port, &secrets)).await.expect("refused without waiting for a server");
        let e = format!("{:#}", r.unwrap_err());
        assert!(e.contains("https://api.openai.com 用です") && e.contains(&format!("http://127.0.0.1:{port}")) && e.contains("入れ直して"), "{e}");
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 0, "the key was sent to the other host");
        assert!(!path.exists(), "a refused request changes no binding");
        server.abort();
    }

    #[tokio::test]
    async fn a_first_use_binds_the_key_before_it_is_sent() {
        use tokio::io::AsyncReadExt;
        let dir = std::env::temp_dir().join(format!("mcs-claim-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("secrets.json");
        Secrets { openai_api_key: "sk-a".into(), ..Default::default() }.save_to(&path).unwrap();
        // The snapshot a request that overlaps the first one started from (the key not bound yet).
        let started = Secrets::load_from(&path);

        // Host A gets the request with the key and works on it (a non-streaming reply answers only at the
        // end); the user presses キャンセル meanwhile, which drops the request.
        let a = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let a_port = a.local_addr().unwrap().port();
        let (head_tx, head_rx) = tokio::sync::oneshot::channel::<String>();
        let slow = tokio::spawn(async move {
            let (mut s, _) = a.accept().await.unwrap();
            let (mut head, mut chunk) = (Vec::new(), [0u8; 4096]);
            while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                match s.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => head.extend_from_slice(&chunk[..n]),
                }
            }
            let _ = head_tx.send(String::from_utf8_lossy(&head).to_ascii_lowercase());
            tokio::time::sleep(Duration::from_secs(120)).await;
            drop(s);
        });
        tokio::select! {
            r = openai_chat(&path, a_port, &started) => panic!("host A never answers: {r:?}"),
            head = head_rx => assert!(head.unwrap().contains("authorization: bearer sk-a"), "the key went to A"),
        }
        slow.abort();
        let a_origin = format!("http://127.0.0.1:{a_port}");
        assert_eq!(Secrets::load_from(&path).openai_key_bound_origin(), Some(a_origin.as_str()), "a cancelled first use binds the key");

        // Base URL changed to B: neither a new request nor one that started before the binding sends the key there.
        let (b_port, hits, server) = counting_server().await;
        for snapshot in [Secrets::load_from(&path), started] {
            let e = format!("{:#}", openai_chat(&path, b_port, &snapshot).await.unwrap_err());
            assert!(e.contains(&format!("{a_origin} 用です")), "{e}");
        }
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 0, "the key was sent to B");
        server.abort();

        // A Base URL nothing listens on (a typo) reaches no server and does not bind a new key.
        let fresh = Secrets { openai_api_key: "sk-b".into(), ..Default::default() };
        fresh.save_to(&path).unwrap();
        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let e = format!("{:#}", openai_chat(&path, closed, &fresh).await.unwrap_err());
        assert!(e.contains("接続できません"), "{e}");
        assert_eq!(Secrets::load_from(&path), fresh, "a connect failure leaves the key unbound");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn local_errors_are_explained() {
        let port = 8099;
        let (edit, draft) = (ThinkingPurpose::Edit, ThinkingPurpose::Draft);
        let m = local_http_error(reqwest::StatusCode::UNAUTHORIZED, &Value::Null, port, false, edit).unwrap();
        assert!(m.contains("別の llama-server") && m.contains("8099"));
        let v = json!({ "error": { "code": 400, "message": "the request exceeds the available context size, try increasing it", "type": "exceed_context_size_error", "n_prompt_tokens": 17000, "n_ctx": 16384 } });
        // A conversation with earlier turns: a reset makes room.
        let m = local_http_error(reqwest::StatusCode::BAD_REQUEST, &v, port, true, edit).unwrap();
        assert!(m.contains("会話をリセット") && m.contains("16384"), "{m}");
        // The first request of a conversation (or a draft): the score and lyrics alone do not fit, a reset
        // would not help; a larger context or a cloud provider does.
        let m = local_http_error(reqwest::StatusCode::BAD_REQUEST, &v, port, false, edit).unwrap();
        assert!(m.contains("譜面と歌詞") && m.contains("16384") && m.contains("コンテキスト長") && m.contains("Anthropic API") && !m.contains("会話"), "{m}");
        let m = local_http_error(reqwest::StatusCode::BAD_REQUEST, &v, port, false, draft).unwrap();
        assert!(m.contains("依頼する内容") && m.contains("コンテキスト長") && !m.contains("会話") && !m.contains("譜面"), "{m}");
        assert!(local_http_error(reqwest::StatusCode::BAD_REQUEST, &json!({ "error": { "message": "other" } }), port, false, edit).is_none());
        // llm_edit's first request: system, the current state, its acknowledgement, the instruction.
        let turn = |role: &str| ChatMessage { role: role.into(), content: "x".into() };
        let first = vec![turn("system"), turn("user"), turn("assistant"), turn("user")];
        assert!(!has_earlier_turns(&first) && !has_earlier_turns(&msgs()));
        let later = [first.clone(), vec![turn("assistant"), turn("user")]].concat();
        assert!(has_earlier_turns(&later));
    }

    #[test]
    fn strip_think_drops_closed_and_unclosed_blocks() {
        assert_eq!(strip_think("<think>a</think>{\"x\":1}"), "{\"x\":1}");
        assert_eq!(strip_think("{} <think>still thinking"), "{}");
        assert_eq!(strip_think("<think>only"), "");
        assert_eq!(strip_think("  plain  "), "plain");
        // Two separate blocks both go; the text between them stays.
        assert_eq!(strip_think("<think>a</think>x<think>b</think>y"), "xy");
        assert_eq!(strip_think("<think>a</think>{\"x\":1}<think>b</think>"), "{\"x\":1}");
        // Nested blocks (Qwen3 does not nest them) end at the first </think>: pinned as the current behaviour.
        assert_eq!(strip_think("<think>a<think>b</think>c</think>{}"), "c</think>{}");
    }

    #[test]
    fn llama_launch_follows_the_config() {
        let base = AppConfig::default();
        let l = LlamaLaunch::from_cfg(&base);
        assert_eq!(l, LlamaLaunch::from_cfg(&base.clone()));
        let changed = |f: &dyn Fn(&mut AppConfig)| {
            let mut c = base.clone();
            f(&mut c);
            LlamaLaunch::from_cfg(&c)
        };
        assert_ne!(changed(&|c| c.data_root = PathBuf::from(r"D:\Other")), l, "a new data root restarts the old root's server");
        assert_ne!(changed(&|c| c.llm_port += 1), l);
        assert_ne!(changed(&|c| c.llm.local_model = "other.gguf".into()), l);
        assert_ne!(changed(&|c| c.llm.gpu_layers = 10), l);
        assert_ne!(changed(&|c| c.llm.context_size = 4096), l);
        // Settings that are not the LLM's keep the server.
        assert_eq!(changed(&|c| c.vae_fp32 = !c.vae_fp32), l);
        assert_eq!(changed(&|c| c.comfy_port += 1), l);
    }

    #[test]
    fn llama_key_never_goes_on_the_command_line() {
        let cfg = AppConfig { data_root: PathBuf::from(r"C:\Users\山田\AppData\Local\MCS"), ..AppConfig::default() };
        let args = LlamaLaunch::from_cfg(&cfg).args();
        let text: Vec<String> = args.iter().map(|a| a.to_string_lossy().to_string()).collect();
        assert!(!text.iter().any(|a| a == "--api-key-file" || a == "--api-key"), "{text:?}");
        let app_dir = app_data_dir().to_string_lossy().to_string();
        assert!(!text.iter().any(|a| a.starts_with(&app_dir)), "{text:?}");
        assert!(text.windows(2).any(|w| w[0] == "--port" && w[1] == cfg.llm_port.to_string()));
        // Bound to loopback only: the server holds the app's key but must not be reachable from the LAN.
        assert!(text.windows(2).any(|w| w == ["--host", "127.0.0.1"]), "{text:?}");
        assert_eq!(text.iter().filter(|a| a.starts_with("--host")).count(), 1, "{text:?}");
        assert_eq!(text[1], cfg.models_dir().join("llm").join(&cfg.llm.local_model).to_string_lossy());
        assert_eq!(LLAMA_API_KEY_ENV, "LLAMA_API_KEY");
    }

    #[test]
    fn local_model_must_be_a_gguf_file_name() {
        assert!(validate_local_model("Qwen3-14B-Q4_K_M.gguf").is_ok());
        assert!(validate_local_model("model.GGUF").is_ok());
        for bad in ["", "..\\x.gguf", "C:\\models\\x.gguf", "sub/x.gguf", "x.bin"] {
            assert!(validate_local_model(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn openai_key_is_bound_to_its_first_origin() {
        let mut s = Secrets { openai_api_key: "sk-a".into(), ..Default::default() };
        assert_eq!(s.openai_key_bound_origin(), None);
        assert!(s.bind_openai_origin("https://api.openai.com/v1").unwrap(), "first use binds");
        assert_eq!(s.openai_key_origin, "https://api.openai.com");
        assert_eq!(s.openai_key_bound_origin(), Some("https://api.openai.com"));
        assert!(!s.bind_openai_origin("https://api.openai.com/v1/").unwrap());
        let e = s.bind_openai_origin("http://192.168.1.5:1234/v1").unwrap_err().to_string();
        assert!(e.contains("https://api.openai.com") && e.contains("入れ直して"), "{e}");
        // A new key (entered again for the new endpoint) binds to its own first origin.
        s.openai_api_key = "sk-b".into();
        assert!(s.bind_openai_origin("http://192.168.1.5:1234/v1").unwrap());
        assert_eq!(s.openai_key_origin, "http://192.168.1.5:1234");
        assert!(s.bind_openai_origin("not a url").is_err());
        assert!(!key_fingerprint("sk-b").contains("sk-b"));
    }

    #[test]
    fn secrets_save_is_atomic_and_a_corrupt_file_is_moved_aside() {
        let dir = std::env::temp_dir().join(format!("mcs-secrets-{}", uuid::Uuid::new_v4().simple()));
        let p = dir.join("secrets.json");
        let s = Secrets { anthropic_api_key: "a".into(), openai_api_key: "o".into(), ..Default::default() };
        s.save_to(&p).unwrap();
        assert!(!dir.join("secrets.json.tmp").exists());
        assert_eq!(Secrets::load_from(&p), s);
        std::fs::write(&p, b"{ truncated").unwrap();
        assert_eq!(Secrets::load_from(&p), Secrets::default());
        let backups = std::fs::read_dir(&dir).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with("secrets.json.bad-")).count();
        assert!(!p.exists() && backups == 1);
        // Old files without the binding fields still load.
        std::fs::write(&p, br#"{"anthropicApiKey":"k","openaiApiKey":""}"#).unwrap();
        assert_eq!(Secrets::load_from(&p).anthropic_api_key, "k");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_local_draft_samples_as_the_model_card_says_and_its_retry_thinks_not() {
        let s = LlmSettings::defaults();
        let draft = ThinkingPurpose::Draft;
        let body = |settings: &LlmSettings, attempt: Attempt| openai_body("local", settings, "http://127.0.0.1:8099/v1", "local", &msgs(), None, draft, attempt);
        // First try, thinking on: the model card's thinking-mode sampling next to the user's temperature.
        let b = body(&s, Attempt::First);
        assert_eq!((b["top_k"].as_u64(), b["min_p"].as_f64(), b["top_p"].as_f64()), (Some(20), Some(0.0), Some(0.95)));
        assert_eq!(b["temperature"], 0.3);
        assert!(b.get("presence_penalty").is_none());
        assert_eq!((b["chat_template_kwargs"]["enable_thinking"].as_bool(), b["reasoning_budget_tokens"].as_u64(), b["max_tokens"].as_u64()), (Some(true), Some(1024), Some(4096)));
        // The retry: no thinking (nor its budget), the answer's share of tokens, the non-thinking sampling, a
        // temperature of at least 0.7 and a presence penalty against the loop of the first reply.
        let r = body(&s, Attempt::Retry);
        assert_eq!(r["chat_template_kwargs"]["enable_thinking"], false);
        assert!(r.get("reasoning_budget_tokens").is_none() && r.get("reasoning_budget_message").is_none());
        assert_eq!((r["max_tokens"].as_u64(), r["temperature"].as_f64(), r["presence_penalty"].as_f64()), (Some(3072), Some(0.7), Some(1.0)));
        assert_eq!((r["top_k"].as_u64(), r["min_p"].as_f64(), r["top_p"].as_f64()), (Some(20), Some(0.0), Some(0.8)));
        assert_eq!(r["messages"], b["messages"]);
        // A warmer setting is kept on the retry.
        let warm = LlmSettings { temperature: 1.2, ..s.clone() };
        assert_eq!(body(&warm, Attempt::Retry)["temperature"], 1.2);
        // Thinking off from the start: the non-thinking sampling, no penalty, and the retry differs only by it.
        let off = LlmSettings { thinking: false, ..s.clone() };
        let b = body(&off, Attempt::First);
        assert_eq!((b["top_p"].as_f64(), b["max_tokens"].as_u64()), (Some(0.8), Some(3072)));
        assert!(b.get("presence_penalty").is_none());
        let r = body(&off, Attempt::Retry);
        assert_eq!((r["temperature"].as_f64(), r["presence_penalty"].as_f64()), (Some(0.7), Some(1.0)));
        // Cloud endpoints: no llama.cpp sampling, and a retry changes nothing there (they get no second try).
        for host in ["https://api.openai.com/v1", "http://192.168.1.5:1234/v1"] {
            let first = openai_body("openai", &s, host, "gpt-4.1", &msgs(), None, draft, Attempt::First);
            for k in ["top_k", "top_p", "min_p", "presence_penalty", "chat_template_kwargs"] {
                assert!(first.get(k).is_none(), "{host} {k}");
            }
            assert_eq!(openai_body("openai", &s, host, "gpt-4.1", &msgs(), None, draft, Attempt::Retry), first);
        }
    }

    #[test]
    fn a_length_cut_is_a_typed_error_and_names_both_tries_after_the_retry() {
        let local = LlmSettings::defaults();
        let draft = ThinkingPurpose::Draft;
        let cut = json!({ "choices": [{ "finish_reason": "length", "message": { "content": "{\"a" } }], "usage": { "prompt_tokens": 749, "completion_tokens": 4096 } });
        let e = openai_content(&cut, "local", &local, draft, Attempt::First).unwrap_err();
        let c = e.downcast_ref::<LengthCut>().expect("a LengthCut");
        assert!(c.at_limit);
        assert_eq!(format!("{e:#}"), c.message, "the message alone, no source chain");
        assert!(c.message.contains("4096 トークン") && c.message.contains("思考は 1024 トークンで打ち切り済み"), "{}", c.message);
        // Cut by the context left after the prompt: not at the limit (a retry would not help).
        let full = json!({ "choices": [{ "finish_reason": "length", "message": { "content": "{\"a" } }], "usage": { "prompt_tokens": 14000, "completion_tokens": 2000 } });
        let e = openai_content(&full, "local", &local, draft, Attempt::First).unwrap_err();
        assert!(!e.downcast_ref::<LengthCut>().unwrap().at_limit);
        // After the retry (thinking off, 3072 tokens): both tries named, the request to shrink, and that luck plays a part.
        let cut2 = json!({ "choices": [{ "finish_reason": "length", "message": { "content": "{\"a" } }], "usage": { "prompt_tokens": 749, "completion_tokens": 3072 } });
        let e = openai_content(&cut2, "local", &local, draft, Attempt::Retry).unwrap_err().to_string();
        assert!(e.contains("2 回とも") && e.contains("1 回目は 4096 トークン") && e.contains("2 回目は思考なしで 3072 トークン") && e.contains("曲の長さや編集の範囲") && e.contains("もう一度試す"), "{e}");
        assert!(!e.contains("打ち切り済み"), "{e}");
        // The retry's reply cut by the context: the context message, as on the first try.
        let full2 = json!({ "choices": [{ "finish_reason": "length", "message": { "content": "{\"a" } }], "usage": { "prompt_tokens": 14000, "completion_tokens": 2000 } });
        let e = openai_content(&full2, "local", &local, draft, Attempt::Retry).unwrap_err().to_string();
        assert!(e.contains("コンテキストの残り（2000 トークン") && !e.contains("2 回とも"), "{e}");
        // An edit's cut and a cloud reply's cut are typed too (chat_retrying leaves them alone by purpose / provider).
        assert!(openai_content(&cut, "local", &local, ThinkingPurpose::Edit, Attempt::First).unwrap_err().downcast_ref::<LengthCut>().is_some());
        assert!(openai_content(&cut, "openai", &local, draft, Attempt::First).unwrap_err().downcast_ref::<LengthCut>().is_some());
        // A good reply after the retry is just the content.
        let ok = json!({ "choices": [{ "finish_reason": "stop", "message": { "content": "{\"title\":\"t\"}" } }] });
        assert_eq!(openai_content(&ok, "local", &local, draft, Attempt::Retry).unwrap(), "{\"title\":\"t\"}");
    }

    #[test]
    fn a_schema_keeps_the_order_of_its_properties() {
        // The page's order (title, lyrics, ... explanation last) is what llama.cpp's grammar makes the model
        // write in; it survives the IPC's JSON parse and the request body.
        let schema: Value = serde_json::from_str(r#"{"type":"object","properties":{"title":{"type":"string"},"lyrics":{"type":"string"},"style":{"type":"string"},"selections":{"type":"object","properties":{"language":{"type":"string"},"genres":{"type":"array"},"bpm":{"type":"integer"}}},"explanation":{"type":"string"}}}"#).unwrap();
        let keys = |v: &Value| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
        assert_eq!(keys(&schema["properties"]), ["title", "lyrics", "style", "selections", "explanation"]);
        let b = openai_body("local", &LlmSettings::defaults(), "http://127.0.0.1:8099/v1", "local", &msgs(), Some(&schema), ThinkingPurpose::Draft, Attempt::First);
        let sent = &b["response_format"]["json_schema"]["schema"];
        assert_eq!(keys(&sent["properties"]), ["title", "lyrics", "style", "selections", "explanation"]);
        assert_eq!(keys(&sent["properties"]["selections"]["properties"]), ["language", "genres", "bpm"]);
        assert!(serde_json::to_string(&b).unwrap().find("\"title\"").unwrap() < serde_json::to_string(&b).unwrap().find("\"explanation\"").unwrap());
        // The edit schema: the score first, the explanation last, as its prompt lists them.
        assert_eq!(keys(&edit_schema()["properties"]), ["abc", "style", "lyrics", "explanation"]);
    }

    /// An OpenAI-compatible server on 127.0.0.1 that answers one request after another with the given
    /// replies (500 once they run out) and keeps every request body it got.
    async fn json_server(replies: Vec<Value>) -> (u16, std::sync::Arc<std::sync::Mutex<Vec<Value>>>, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let bodies = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = bodies.clone();
        let server = tokio::spawn(async move {
            let mut replies = replies.into_iter();
            while let Ok((mut s, _)) = listener.accept().await {
                let (mut buf, mut chunk) = (Vec::new(), [0u8; 8192]);
                let head_len = loop {
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break i + 4;
                    }
                    match s.read(&mut chunk).await {
                        Ok(0) | Err(_) => break usize::MAX,
                        Ok(n) => buf.extend_from_slice(&chunk[..n]),
                    }
                };
                if head_len == usize::MAX {
                    continue;
                }
                let head = String::from_utf8_lossy(&buf[..head_len]).to_ascii_lowercase();
                let length: usize = head.lines().find_map(|l| l.strip_prefix("content-length:")).and_then(|v| v.trim().parse().ok()).unwrap_or(0);
                while buf.len() < head_len + length {
                    match s.read(&mut chunk).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => buf.extend_from_slice(&chunk[..n]),
                    }
                }
                seen.lock().unwrap().push(serde_json::from_slice(&buf[head_len..head_len + length]).unwrap_or(Value::Null));
                let (status, reply) = match replies.next() {
                    Some(r) => ("200 OK", r.to_string()),
                    None => ("500 Internal Server Error", json!({ "error": { "message": "no reply left" } }).to_string()),
                };
                let _ = s.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}", reply.len()).as_bytes()).await;
                let _ = s.shutdown().await;
            }
        });
        (port, bodies, server)
    }

    #[tokio::test]
    async fn a_local_draft_cut_at_the_limit_is_sent_once_more_without_thinking() {
        let cut = |spent: u64| json!({ "choices": [{ "finish_reason": "length", "message": { "content": "{\"title\":\"a" } }], "usage": { "prompt_tokens": 749, "completion_tokens": spent } });
        let ok = json!({ "choices": [{ "finish_reason": "stop", "message": { "content": "{\"title\":\"t\",\"lyrics\":\"l\"}" } }], "usage": { "prompt_tokens": 749, "completion_tokens": 900 } });
        let schema = || Some(serde_json::from_str::<Value>(r#"{"type":"object","properties":{"title":{"type":"string"},"lyrics":{"type":"string"}},"required":["title","lyrics"]}"#).unwrap());
        let settings = LlmSettings::defaults();
        let secrets = Secrets::default();
        let dir = std::env::temp_dir().join(format!("mcs-retry-{}", uuid::Uuid::new_v4().simple()));
        let path = dir.join("secrets.json");
        let run = |port: u16, purpose: ThinkingPurpose, retries: std::sync::Arc<std::sync::atomic::AtomicUsize>| {
            let (settings, secrets, path) = (settings.clone(), secrets.clone(), path.clone());
            async move {
                let cfg = AppConfig { llm_port: port, ..Default::default() };
                chat_retrying_using(&path, &cfg, &settings, &secrets, msgs(), schema(), purpose, &mut || {
                    retries.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                })
                .await
            }
        };
        let counter = || std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));

        // The first reply ran to max_tokens: the draft is sent again without thinking and answered.
        let (port, bodies, server) = json_server(vec![cut(4096), ok]).await;
        let retries = counter();
        let r = run(port, ThinkingPurpose::Draft, retries.clone()).await.unwrap();
        assert_eq!((r.content.as_str(), r.attempts, r.completion_tokens), ("{\"title\":\"t\",\"lyrics\":\"l\"}", 2, 900));
        assert_eq!(retries.load(std::sync::atomic::Ordering::SeqCst), 1);
        let sent = bodies.lock().unwrap().clone();
        assert_eq!(sent.len(), 2);
        assert_eq!((sent[0]["chat_template_kwargs"]["enable_thinking"].as_bool(), sent[0]["reasoning_budget_tokens"].as_u64(), sent[0]["max_tokens"].as_u64()), (Some(true), Some(1024), Some(4096)));
        assert!(sent[0].get("presence_penalty").is_none());
        assert_eq!((sent[1]["chat_template_kwargs"]["enable_thinking"].as_bool(), sent[1]["max_tokens"].as_u64(), sent[1]["presence_penalty"].as_f64(), sent[1]["temperature"].as_f64()), (Some(false), Some(3072), Some(1.0), Some(0.7)));
        assert!(sent[1].get("reasoning_budget_tokens").is_none());
        assert_eq!(sent[1]["messages"], sent[0]["messages"]);
        for b in &sent {
            assert_eq!(b["response_format"]["json_schema"]["schema"]["properties"].as_object().unwrap().keys().collect::<Vec<_>>(), ["title", "lyrics"]);
        }
        server.abort();

        // Both tries cut: one retry only, and the error names both.
        let (port, bodies, server) = json_server(vec![cut(4096), cut(3072)]).await;
        let retries = counter();
        let e = format!("{:#}", run(port, ThinkingPurpose::Draft, retries.clone()).await.unwrap_err());
        assert!(e.contains("2 回とも") && e.contains("思考なしで 3072 トークン"), "{e}");
        assert_eq!((bodies.lock().unwrap().len(), retries.load(std::sync::atomic::Ordering::SeqCst)), (2, 1));
        server.abort();

        // Cut by the context left after the prompt (not max_tokens): no second try.
        let (port, bodies, server) = json_server(vec![cut(2000), ok_reply()]).await;
        let retries = counter();
        let e = format!("{:#}", run(port, ThinkingPurpose::Draft, retries.clone()).await.unwrap_err());
        assert!(e.contains("コンテキストの残り（2000 トークン"), "{e}");
        assert_eq!((bodies.lock().unwrap().len(), retries.load(std::sync::atomic::Ordering::SeqCst)), (1, 0));
        server.abort();

        // An edit gets its one try.
        let (port, bodies, server) = json_server(vec![cut(8192), ok_reply()]).await;
        let retries = counter();
        let e = format!("{:#}", run(port, ThinkingPurpose::Edit, retries.clone()).await.unwrap_err());
        assert!(e.contains("8192 トークン") && !e.contains("2 回とも"), "{e}");
        assert_eq!((bodies.lock().unwrap().len(), retries.load(std::sync::atomic::Ordering::SeqCst)), (1, 0));
        server.abort();

        // A good first reply: one request, attempts 1.
        let (port, bodies, server) = json_server(vec![ok_reply()]).await;
        let retries = counter();
        let r = run(port, ThinkingPurpose::Draft, retries.clone()).await.unwrap();
        assert_eq!((r.attempts, bodies.lock().unwrap().len(), retries.load(std::sync::atomic::Ordering::SeqCst)), (1, 1, 0));
        server.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_edit_turn_has_its_fixed_opening_and_only_user_and_assistant_history() {
        let turn = |role: &str, c: &str| ChatMessage { role: role.into(), content: c.into() };
        let history = vec![turn("user", "テンポを上げて"), turn("system", "dropped"), turn("assistant", "{\"abc\":\"\"}"), turn("tool", "dropped")];
        let m = edit_messages("X:1", "pop, 100 BPM", "[Verse]\n空", Some("[Verse]\nそら"), history, "サビを変えて".into());
        let roles: Vec<&str> = m.iter().map(|x| x.role.as_str()).collect();
        assert_eq!(roles, ["system", "user", "assistant", "user", "assistant", "user"]);
        assert_eq!(m[0].content, edit_system_prompt());
        assert_eq!(m[1].content, edit_context("pop, 100 BPM", "[Verse]\n空", Some("[Verse]\nそら"), "X:1"));
        assert_eq!(m[2].content, EDIT_STATE_ACK);
        assert_eq!((m[3].content.as_str(), m[5].content.as_str()), ("テンポを上げて", "サビを変えて"));
        // the acknowledgement is a reply in the schema's order, and a first turn has no earlier turns
        assert_eq!(serde_json::from_str::<Value>(EDIT_STATE_ACK).unwrap().as_object().unwrap().keys().collect::<Vec<_>>(), ["abc", "style", "lyrics", "explanation"]);
        assert!(!has_earlier_turns(&edit_messages("", "", "", None, vec![], "x".into())));
    }

    #[test]
    fn an_edit_reply_is_read_with_or_without_code_fences() {
        let r = parse_edit_reply(r#"{"abc":"X:1","style":"pop","lyrics":"","explanation":"説明"}"#).unwrap();
        assert_eq!(r, ["X:1".to_string(), "pop".into(), String::new(), "説明".into()]);
        let fenced = "```json\n{\"abc\":\"\",\"style\":\"rock\",\"explanation\":\"x\"}\n```";
        assert_eq!(parse_edit_reply(fenced).unwrap(), [String::new(), "rock".into(), String::new(), "x".into()]);
        // a field that is not text reads as empty
        assert_eq!(parse_edit_reply(r#"{"abc":5,"style":null}"#).unwrap()[0], "");
        let e = parse_edit_reply("ここに説明だけ").unwrap_err();
        assert!(e.starts_with("LLM の応答を JSON として解釈できません") && e.ends_with("ここに説明だけ"), "{e}");
    }

    fn ok_reply() -> Value {
        json!({ "choices": [{ "finish_reason": "stop", "message": { "content": "{\"title\":\"t\",\"lyrics\":\"l\"}" } }], "usage": { "prompt_tokens": 749, "completion_tokens": 900 } })
    }
}
