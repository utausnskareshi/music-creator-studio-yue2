//! Persistent application configuration (%APPDATA%\MusicCreatorStudioYuE2\config.json).

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

pub const APP_DIR_NAME: &str = "MusicCreatorStudioYuE2";
/// When setup creates it on the Windows drive, only the account that ran setup (and SYSTEM, Administrators) gets
/// access (setup.rs restricted_location): a new folder there would otherwise let every account change the tools the
/// app runs.
pub const DEFAULT_DATA_ROOT: &str = r"C:\MCSYuE2";
pub const DEFAULT_COMFY_PORT: u16 = 8199;
pub const DEFAULT_LLM_PORT: u16 = 8099;
/// Key under HKCU where `write_registry` records the data root and the song folder for the uninstaller.
const REGISTRY_KEY: &str = r"Software\MusicCreatorStudioYuE2";
/// The registry value of the song folders used before the current one (former_output_dirs).
const FORMER_OUTPUT_DIRS: &str = "FormerOutputDirs";

/// The trees of the data root the uninstaller's tools prompt removes as a whole (hooks.nsh McsDeleteDataRoot's
/// McsRMDirR and McsInRemovedTree; checked by uninstaller_knows_every_folder_it_removes_with_the_tools).
const REMOVED_TREES: [&str; 7] = ["runtime/ComfyUI_windows_portable", "runtime/bin", "runtime/ffmpeg", "runtime/llama", "runtime/.mcs_extracting", "cache/sep_work", "cache/align_stems"];
/// The longest FORMER_OUTPUT_DIRS value in UTF-16 units: the uninstaller reads it into an NSIS string (1024 characters
/// with its end), and a longer value would read as empty (no folder checked at all).
const FORMER_OUTPUT_DIRS_MAX_UNITS: usize = 1000;

/// The song folders used before the current one that the uninstaller must look at (FORMER_OUTPUT_DIRS, "|"-separated:
/// a Windows path holds no "|"): one inside a tree its tools prompt removes as a whole (REMOVED_TREES) may still hold
/// songs (the library keeps them where they were made), so that prompt refuses while something is there (hooks.nsh
/// McsFormerInDataRoot). `previous` (the OutputDir the registry holds) joins `list` when it is not `current` and may
/// lie in such a tree of any data root: the uninstaller compares with the data root of its own time, which may not be
/// the one the folder was used with (the data root changed later, or back). So a path holding a tree's folders joins,
/// and one with a "~" (an 8.3 alias: the uninstaller makes it long, or refuses that prompt while it cannot and the
/// folder holds something); `current` leaves the list (a folder used again).
/// The 16 most recent are kept, fewer when the value would be longer than the uninstaller can read.
pub(crate) fn former_output_dirs(list: &str, previous: &str, current: &str) -> String {
    let norm = |p: &str| p.replace('/', "\\").trim_end_matches('\\').to_ascii_lowercase();
    let same = |a: &str, b: &str| norm(a) == norm(b);
    let in_tree = |p: &str| {
        let folders: Vec<&str> = p.split(['\\', '/']).filter(|f| !f.is_empty()).collect();
        p.contains('~')
            || REMOVED_TREES.iter().any(|t| {
                let tree: Vec<&str> = t.split('/').collect();
                folders.windows(tree.len()).any(|w| w.iter().zip(&tree).all(|(a, b)| a.eq_ignore_ascii_case(b)))
            })
    };
    let mut dirs: Vec<&str> = list.split('|').filter(|d| !d.is_empty() && !same(d, current) && !same(d, previous)).collect();
    if !previous.is_empty() && !same(previous, current) && !previous.contains('|') && in_tree(previous) {
        dirs.push(previous);
    }
    let mut skip = dirs.len().saturating_sub(16);
    while skip < dirs.len() && dirs[skip..].join("|").encode_utf16().count() > FORMER_OUTPUT_DIRS_MAX_UNITS {
        skip += 1;
    }
    dirs[skip..].join("|")
}
/// Upper bound of YuE2GenerateMusic.max_duration in ComfyUI v0.37.0 (object_info max 900).
/// Must equal src/config/rules.ts DURATION_LIMIT_MAX (test `duration_bounds_match_config_rules_ts`).
pub const MAX_DURATION_CAP: u32 = 900;
/// Lower bound of the max_duration_limit setting (src/config/rules.ts DURATION_LIMIT_MIN).
pub const MIN_DURATION_LIMIT: u32 = 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    /// Where ComfyUI, models, ffmpeg and the LLM runtime live. Keep it short (about 80 characters at most,
    /// src/config/rules.ts DATA_ROOT_MAX_SAFE_LEN): the embedded Python and torch need MAX_PATH below it.
    pub data_root: PathBuf,
    /// Where generated songs are stored (user visible).
    pub output_dir: PathBuf,
    pub comfy_port: u16,
    pub llm_port: u16,
    /// "bf16" or "int8"
    pub precision: String,
    /// The user picked `precision` in Settings. Until then the setup wizard may choose it (INT8 below
    /// 20 GB VRAM), also when a first setup resumes after a restart. A config written before this field
    /// existed counts as explicit once setup was completed (a re-run keeps that install's choice).
    pub precision_explicit: bool,
    /// Call /free after every generation to release VRAM.
    pub free_vram_after_generation: bool,
    /// Default cap for max_duration (seconds). Advanced settings may raise up to `max_duration_limit`.
    pub default_max_duration: u32,
    pub max_duration_limit: u32,
    pub license_accepted: bool,
    pub setup_completed: bool,
    // (`autoStartComfy` of older versions is gone: generation and every tool start ComfyUI on demand.
    // serde ignores the key in an old config.json.)
    /// AI editing (LLM) settings.
    pub llm: crate::llm::LlmSettings,
    /// Launch ComfyUI with `--fp32-vae` (the official YuE2 runtime decodes in FP32). Opt-in: more VRAM,
    /// and a change needs a ComfyUI restart.
    pub vae_fp32: bool,
    /// VAE decode node: "auto" (plain when it fits next to the model, tiled otherwise), "plain"
    /// (VAEDecodeAudio, the official ComfyUI template) or "tiled" (VAEDecodeAudioTiled, like the official
    /// runtime's chunked decode). See workflow::plan_vae_decode.
    #[serde(default = "default_vae_decode")]
    pub vae_decode: String,
}

fn default_vae_decode() -> String {
    "auto".into()
}

pub const VAE_DECODE_MODES: [&str; 3] = ["auto", "plain", "tiled"];

impl Default for AppConfig {
    fn default() -> Self {
        let music = dirs::audio_dir()
            .or_else(|| dirs::home_dir().map(|h| h.join("Music")))
            .unwrap_or_else(|| PathBuf::from(DEFAULT_DATA_ROOT));
        Self {
            data_root: PathBuf::from(DEFAULT_DATA_ROOT),
            output_dir: music.join("Music Creator Studio YuE2"),
            comfy_port: DEFAULT_COMFY_PORT,
            llm_port: DEFAULT_LLM_PORT,
            precision: "bf16".into(),
            precision_explicit: false,
            free_vram_after_generation: false,
            default_max_duration: crate::workflow::OFFICIAL_DEFAULT_SECONDS,
            max_duration_limit: 900,
            license_accepted: false,
            setup_completed: false,
            llm: crate::llm::LlmSettings::defaults(),
            vae_fp32: false,
            vae_decode: default_vae_decode(),
        }
    }
}

/// Notices for the user from the start of this launch (an unusable config.json or secrets.json), shown once
/// by the frontend (take_startup_notices drains them, so a reload of the WebView does not show them again).
static STARTUP_NOTICES: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

pub fn push_startup_notice(text: String) {
    STARTUP_NOTICES.lock().unwrap_or_else(|e| e.into_inner()).push(text);
}

pub fn take_startup_notices() -> Vec<String> {
    std::mem::take(&mut *STARTUP_NOTICES.lock().unwrap_or_else(|e| e.into_inner()))
}

/// A `<file name>.bad-*` backup next to `p` holding exactly `bytes` (a broken file already kept).
pub fn existing_backup(p: &Path, bytes: &[u8]) -> Option<PathBuf> {
    let prefix = format!("{}.bad-", p.file_name()?.to_string_lossy());
    std::fs::read_dir(p.parent()?).ok()?.flatten().find_map(|e| {
        let same_name = e.file_name().to_string_lossy().starts_with(&prefix);
        let same_len = e.metadata().map(|m| m.is_file() && m.len() == bytes.len() as u64).unwrap_or(false);
        (same_name && same_len && std::fs::read(e.path()).ok().as_deref() == Some(bytes)).then(|| e.path())
    })
}

pub fn app_data_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(APP_DIR_NAME)
}

pub fn config_path() -> PathBuf {
    app_data_dir().join("config.json")
}

pub fn log_dir() -> PathBuf {
    app_data_dir().join("logs")
}

impl AppConfig {
    /// Loads config.json. When it could not be used, the notice for the user goes to the startup notices
    /// (take_startup_notices), so the setup wizard that opens does not come as a surprise.
    pub fn load() -> Self {
        let (cfg, notice) = Self::load_from(&config_path(), registry_locations);
        if let Some(n) = notice {
            push_startup_notice(n);
        }
        cfg
    }

    /// `load` for a given file, with the notice for the user when the file could not be used (None for a
    /// missing file and for a successful load). A file that cannot be parsed is kept as
    /// `config.json.bad-<unix seconds>` (once: a backup with the same content is not made again, e.g. on every
    /// launch until the wizard saves) and the defaults are used, with the data root and song folder recovered
    /// from the uninstaller's registry record (`recover`) when those folders still exist, so the setup wizard
    /// finds the existing install.
    fn load_from(p: &Path, recover: impl FnOnce() -> (Option<PathBuf>, Option<PathBuf>)) -> (Self, Option<String>) {
        let bytes = match std::fs::read(p) {
            Ok(b) => b,
            Err(e) => {
                if e.kind() == std::io::ErrorKind::NotFound {
                    return (Self::default(), None);
                }
                log::warn!("config.json unreadable ({e}), using defaults");
                return (Self::default(), Some(format!("設定ファイル（{}）を読み込めなかったため、初期値で起動しました（{e}）。", p.display())));
            }
        };
        match Self::from_json(&bytes) {
            Ok(cfg) => (cfg.repair().normalize().reset_setup_if_install_gone(), None),
            Err(e) => {
                let mut notice = String::from("設定ファイルを読み込めなかったため、初期値で起動しました。");
                match existing_backup(p, &bytes) {
                    Some(kept) => {
                        log::warn!("config.json unreadable ({e}); already kept as {}, using defaults", kept.display());
                        notice.push_str(&format!("元のファイルは {} に保存してあります。", kept.display()));
                    }
                    None => {
                        let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                        let mut name = p.file_name().unwrap_or_default().to_os_string();
                        name.push(format!(".bad-{secs}"));
                        let backup = p.with_file_name(name);
                        match std::fs::copy(p, &backup) {
                            Ok(_) => {
                                log::warn!("config.json unreadable ({e}); kept as {}, using defaults", backup.display());
                                notice.push_str(&format!("元のファイルは {} に保存してあります。", backup.display()));
                            }
                            Err(ce) => {
                                log::warn!("config.json unreadable ({e}), using defaults (backup failed: {ce})");
                                notice.push_str("（元のファイルの退避に失敗しました）");
                            }
                        }
                    }
                }
                let mut cfg = Self::default();
                let (data_root, output_dir) = recover();
                if let Some(d) = data_root.filter(|d| d.is_absolute() && d.is_dir()) {
                    log::warn!("data root recovered from the registry: {}", d.display());
                    notice.push_str(&format!("既存のインストール先 {} をそのまま使います。", d.display()));
                    cfg.data_root = d;
                }
                if let Some(o) = output_dir.filter(|o| o.is_absolute() && o.is_dir()) {
                    cfg.output_dir = o;
                }
                (cfg, Some(notice))
            }
        }
    }

    /// Parse config.json (missing fields take their defaults; see `precision_explicit` for its migration).
    pub fn from_json(bytes: &[u8]) -> serde_json::Result<Self> {
        let raw: serde_json::Value = serde_json::from_slice(bytes)?;
        let mut cfg: Self = serde_json::from_value(raw.clone())?;
        if raw.get("precisionExplicit").is_none() && cfg.setup_completed {
            cfg.precision_explicit = true;
        }
        Ok(cfg)
    }

    /// Clamp values the UI or an old config may carry out of range:
    /// max_duration_limit to 60..=900 (the node maximum) and default_max_duration to 8..=limit.
    /// Values `validate` rejects (paths, ports) are left alone: a save reports them instead.
    pub fn normalize(mut self) -> Self {
        self.max_duration_limit = self.max_duration_limit.clamp(MIN_DURATION_LIMIT, MAX_DURATION_CAP);
        self.default_max_duration = self.default_max_duration.clamp(8, self.max_duration_limit);
        if !VAE_DECODE_MODES.contains(&self.vae_decode.as_str()) {
            self.vae_decode = default_vae_decode();
        }
        self
    }

    /// On load only: fix what an older version or a hand edit may have stored, so the app starts with
    /// usable values and the next save passes `validate`. Paths are trimmed and unquoted; an empty or
    /// relative path, port 0 and equal ports fall back to the defaults (logged). Absolute paths are never
    /// replaced, even ones `validate` rejects: that would silently move an existing install or library.
    fn repair(mut self) -> Self {
        let defaults = Self::default();
        for (field, default, name) in [(&mut self.data_root, defaults.data_root, "data root"), (&mut self.output_dir, defaults.output_dir, "output dir")] {
            let cleaned = clean_location(field);
            if cleaned.as_os_str().is_empty() || !cleaned.is_absolute() {
                log::warn!("config: {name} {:?} is not an absolute path, using the default {}", field, default.display());
                *field = default;
            } else {
                *field = cleaned;
            }
        }
        if self.comfy_port == 0 {
            log::warn!("config: ComfyUI port 0, using {DEFAULT_COMFY_PORT}");
            self.comfy_port = DEFAULT_COMFY_PORT;
        }
        if self.llm_port == 0 {
            log::warn!("config: LLM port 0, using {DEFAULT_LLM_PORT}");
            self.llm_port = DEFAULT_LLM_PORT;
        }
        if self.llm_port == self.comfy_port {
            self.llm_port = if self.comfy_port == DEFAULT_LLM_PORT { DEFAULT_COMFY_PORT } else { DEFAULT_LLM_PORT };
            log::warn!("config: ComfyUI and LLM shared port {}, LLM moved to {}", self.comfy_port, self.llm_port);
        }
        self
    }

    /// On load only: a completed setup whose runtime folder (ComfyUI, ffmpeg, the LLM runtime) is gone goes
    /// back to the setup wizard. The uninstaller removes the downloaded tools and models on request but keeps
    /// config.json unless 「アプリケーションデータを削除する」 is ticked, so without this a reinstall would open
    /// the main screen with nothing to generate with. The license acceptance is kept. Skipped while the data
    /// root's parent is unreachable (a disconnected external or network drive is not a removed install).
    fn reset_setup_if_install_gone(mut self) -> Self {
        let reachable = self.data_root.parent().is_some_and(|p| p.is_dir());
        if self.setup_completed && reachable && !self.runtime_dir().exists() {
            log::warn!("config: setup was completed but {} is missing, opening the setup wizard again", self.runtime_dir().display());
            self.setup_completed = false;
        }
        self
    }

    /// Reject values that would break the app or the uninstaller (Japanese messages for the UI).
    pub fn validate(&self) -> Result<()> {
        if let Some(e) = location_error(&self.data_root, "データルート", true) {
            bail!(e);
        }
        if let Some(e) = location_error(&self.output_dir, "楽曲の保存先", false) {
            bail!(e);
        }
        if self.comfy_port == 0 {
            bail!("ComfyUI ポートは 1〜65535 で指定してください");
        }
        if self.llm_port == 0 {
            bail!("LLM ポートは 1〜65535 で指定してください");
        }
        if self.comfy_port == self.llm_port {
            bail!("ComfyUI ポートと LLM ポートは別の番号にしてください");
        }
        Ok(())
    }

    /// Validate, then write config.json atomically (a crash mid-write keeps the previous file).
    pub fn save(&self) -> Result<()> {
        self.validate()?;
        let p = config_path();
        std::fs::create_dir_all(p.parent().unwrap()).context("create config dir")?;
        let json = serde_json::to_vec_pretty(self)?;
        write_atomic(&p, &json).map_err(|e| anyhow!("設定ファイル（{}）を保存できません: {e}", p.display()))?;
        self.write_registry();
        Ok(())
    }

    /// Record the data/output locations for the uninstaller (HKCU\Software\MusicCreatorStudioYuE2), through
    /// the registry API: Unicode both ways, and not blocked by the policy that disables reg.exe on managed PCs.
    /// Skipped while both paths equal the ones this process already wrote (the first save of a session always
    /// writes, which also repairs a missing record). A failed write is logged and retried on the next save.
    fn write_registry(&self) {
        static WRITTEN: std::sync::Mutex<Option<(PathBuf, PathBuf)>> = std::sync::Mutex::new(None);
        let current = (self.data_root.clone(), self.output_dir.clone());
        let mut written = WRITTEN.lock().unwrap_or_else(|e| e.into_inner());
        if written.as_ref() == Some(&current) {
            return;
        }
        #[allow(unused_mut)]
        let mut ok = true;
        #[cfg(windows)]
        {
            // The song folder used until now joins the former ones (before OutputDir is overwritten): songs made there
            // stay in the library, and the uninstaller must not delete them with the tools.
            let read = |name: &str| registry::get_string(REGISTRY_KEY, name).map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            let (list, previous) = (read(FORMER_OUTPUT_DIRS), read("OutputDir"));
            let former = former_output_dirs(&list, &previous, &self.output_dir.to_string_lossy());
            let mut former_ok = true;
            if former != list {
                if let Err(e) = registry::set_string(REGISTRY_KEY, FORMER_OUTPUT_DIRS, std::ffi::OsStr::new(&former)) {
                    (ok, former_ok) = (false, false);
                    log::warn!("registry record {FORMER_OUTPUT_DIRS} not written: {e}");
                }
            }
            for (name, value) in [("DataRoot", &self.data_root), ("OutputDir", &self.output_dir)] {
                // kept until the list is written (the next save tries again, still knowing the folder used until now)
                if name == "OutputDir" && !former_ok {
                    continue;
                }
                if let Err(e) = registry::set_string(REGISTRY_KEY, name, value.as_os_str()) {
                    ok = false;
                    log::warn!("registry record {name} not written: {e}");
                }
            }
        }
        if ok {
            *written = Some(current);
        }
    }

    // ---- derived paths ----
    pub fn runtime_dir(&self) -> PathBuf {
        self.data_root.join("runtime")
    }
    pub fn comfy_root(&self) -> PathBuf {
        self.runtime_dir().join("ComfyUI_windows_portable")
    }
    pub fn comfy_python(&self) -> PathBuf {
        self.comfy_root().join("python_embeded").join("python.exe")
    }
    pub fn comfy_main(&self) -> PathBuf {
        self.comfy_root().join("ComfyUI").join("main.py")
    }
    pub fn comfy_custom_nodes(&self) -> PathBuf {
        self.comfy_root().join("ComfyUI").join("custom_nodes")
    }
    pub fn models_dir(&self) -> PathBuf {
        self.data_root.join("models")
    }
    pub fn cache_dir(&self) -> PathBuf {
        self.data_root.join("cache")
    }
    pub fn comfy_output_dir(&self) -> PathBuf {
        self.data_root.join("comfy_output")
    }
    pub fn comfy_input_dir(&self) -> PathBuf {
        self.data_root.join("comfy_input")
    }
    pub fn extra_model_paths(&self) -> PathBuf {
        self.data_root.join("extra_model_paths.yaml")
    }
    pub fn ffmpeg_exe(&self) -> Option<PathBuf> {
        find_file(&self.runtime_dir().join("ffmpeg"), "ffmpeg.exe", 3)
    }
    pub fn llama_server_exe(&self) -> PathBuf {
        self.runtime_dir().join("llama").join("llama-server.exe")
    }
    pub fn sevenzip_exe(&self) -> PathBuf {
        self.runtime_dir().join("bin").join("7zr.exe")
    }
    pub fn checkpoint_file(&self) -> &'static str {
        if self.precision == "int8" {
            "yue2_3b_int8_convrot.safetensors"
        } else {
            "yue2_3b_bf16.safetensors"
        }
    }
    /// Where the selected checkpoint must be (the `mcs` base_path in extra_model_paths.yaml).
    pub fn checkpoint_path(&self) -> PathBuf {
        self.models_dir().join("checkpoints").join(self.checkpoint_file())
    }
    pub fn comfy_base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.comfy_port)
    }
}

/// Breadth-limited search for a file name below `dir`.
pub fn find_file(dir: &Path, name: &str, depth: usize) -> Option<PathBuf> {
    if depth == 0 || !dir.is_dir() {
        return None;
    }
    let direct = dir.join(name);
    if direct.is_file() {
        return Some(direct);
    }
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let p = entry.path();
        if p.is_dir() {
            if let Some(f) = find_file(&p, name, depth - 1) {
                return Some(f);
            }
        }
    }
    None
}

/// Why `p` cannot be used as the data root (`data_root`) or the song folder, or None. Same rules as
/// src/config/rules.ts locationError, which the wizard and the settings page check before saving.
pub fn location_error(p: &Path, label: &str, data_root: bool) -> Option<String> {
    let s = p.to_string_lossy();
    if s.trim().is_empty() {
        return Some(format!("{label}を指定してください"));
    }
    if s.chars().any(|c| c.is_control()) {
        return Some(format!("{label}に制御文字が含まれています"));
    }
    if s.chars().any(|c| matches!(c, '<' | '>' | '"' | '|' | '?' | '*')) {
        return Some(format!("{label}に使えない文字（< > \" | ? *）が含まれています"));
    }
    if s.char_indices().any(|(i, c)| c == ':' && i != 1) {
        return Some(format!("{label}の「:」はドライブ名（例: C:）の直後にだけ使えます"));
    }
    if data_root && s.contains(';') {
        return Some(format!("{label}に「;」は使えません（同梱の ffmpeg を見つけられなくなります）"));
    }
    if !p.is_absolute() {
        return Some(format!("{label}には絶対パス（例: C:\\MCSYuE2）を指定してください"));
    }
    for c in p.components() {
        match c {
            Component::CurDir | Component::ParentDir => return Some(format!("{label}に「.」「..」は使えません")),
            Component::Normal(n) => {
                let n = n.to_string_lossy();
                if n.ends_with(' ') || n.ends_with('.') {
                    return Some(format!("{label}のフォルダ名の末尾に空白やピリオドは使えません（「{n}」）"));
                }
            }
            _ => {}
        }
    }
    if p.parent().is_none() {
        return Some(format!("{label}にドライブ直下（例: D:\\）は指定できません。フォルダを作って指定してください"));
    }
    None
}

/// Trim and remove one pair of surrounding double quotes (Explorer's 「パスのコピー」 adds them).
fn clean_location(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    let t = s.trim();
    let t = t.strip_prefix('"').and_then(|x| x.strip_suffix('"')).unwrap_or(t).trim();
    PathBuf::from(t)
}

/// Write `bytes` to `<path>.tmp`, flush it to disk and rename it over `path`, so a crash or power loss
/// leaves either the old or the new file, never a truncated one. The temporary file is removed on failure.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".tmp");
    let tmp = path.with_file_name(name);
    let result = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// DataRoot / OutputDir as recorded by `write_registry` (None when missing or unreadable).
fn registry_locations() -> (Option<PathBuf>, Option<PathBuf>) {
    #[cfg(windows)]
    {
        let query = |name: &str| registry::get_string(REGISTRY_KEY, name).filter(|v| !v.is_empty()).map(PathBuf::from);
        (query("DataRoot"), query("OutputDir"))
    }
    #[cfg(not(windows))]
    {
        (None, None)
    }
}

/// REG_SZ values under HKEY_CURRENT_USER (wide-character API, so any path round-trips).
#[cfg(windows)]
mod registry {
    use std::ffi::{OsStr, OsString};
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegGetValueW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE, REG_OPTION_NON_VOLATILE, REG_SZ, RRF_RT_REG_SZ,
    };

    fn wide(s: &OsStr) -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
    }

    /// Create `subkey` if needed and set `name` to `value`.
    pub fn set_string(subkey: &str, name: &str, value: &OsStr) -> std::io::Result<()> {
        let (key, name, data) = (wide(OsStr::new(subkey)), wide(OsStr::new(name)), wide(value));
        let mut h: HKEY = std::ptr::null_mut();
        let rc = unsafe {
            RegCreateKeyExW(HKEY_CURRENT_USER, key.as_ptr(), 0, std::ptr::null(), REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, std::ptr::null(), &mut h, std::ptr::null_mut())
        };
        if rc != 0 {
            return Err(std::io::Error::from_raw_os_error(rc as i32));
        }
        // The size includes the terminating NUL.
        let rc = unsafe { RegSetValueExW(h, name.as_ptr(), 0, REG_SZ, data.as_ptr().cast(), (data.len() * 2) as u32) };
        unsafe { RegCloseKey(h) };
        if rc != 0 {
            return Err(std::io::Error::from_raw_os_error(rc as i32));
        }
        Ok(())
    }

    /// The REG_SZ value `name` of `subkey`; None when the key or value is missing or not a string.
    pub fn get_string(subkey: &str, name: &str) -> Option<OsString> {
        let (key, name) = (wide(OsStr::new(subkey)), wide(OsStr::new(name)));
        let mut size = 0u32;
        let rc = unsafe { RegGetValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), std::ptr::null_mut(), &mut size) };
        if rc != 0 {
            return None;
        }
        let mut buf = vec![0u16; size as usize / 2 + 1];
        let mut size = (buf.len() * 2) as u32;
        let rc = unsafe { RegGetValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buf.as_mut_ptr().cast(), &mut size) };
        if rc != 0 {
            return None;
        }
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(OsString::from_wide(&buf[..len]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn precision_explicit_migrates_completed_old_configs() {
        // Written before the field existed: a completed install keeps its choice on a re-run...
        let old = AppConfig::from_json(br#"{"precision":"bf16","licenseAccepted":true,"setupCompleted":true}"#).unwrap();
        assert!(old.precision_explicit);
        // ...an interrupted first setup does not (the wizard may still pick INT8).
        let interrupted = AppConfig::from_json(br#"{"precision":"bf16","licenseAccepted":true,"setupCompleted":false}"#).unwrap();
        assert!(!interrupted.precision_explicit);
        // Written by this version: the stored value wins.
        let new = AppConfig::from_json(br#"{"precision":"bf16","setupCompleted":true,"precisionExplicit":false}"#).unwrap();
        assert!(!new.precision_explicit);
        let back = serde_json::to_value(&new).unwrap();
        assert_eq!(back["precisionExplicit"], serde_json::json!(false));
    }

    #[test]
    fn duration_bounds_match_config_rules_ts() {
        // The UI clamps with the same numbers (settings page, compose/cover/edit budgets, library).
        let rules = include_str!("../../src/config/rules.ts");
        assert!(rules.contains(&format!("export const DURATION_LIMIT_MAX = {MAX_DURATION_CAP};")));
        assert!(rules.contains(&format!("export const DURATION_LIMIT_MIN = {MIN_DURATION_LIMIT};")));
        // the settings page marks the default local-LLM context size
        let ctx = crate::llm::LlmSettings::defaults().context_size;
        assert!(rules.contains(&format!("export const LLM_CONTEXT_SIZE_DEFAULT = {ctx};")));
    }

    #[test]
    fn normalize_clamps_duration_limits() {
        let c = AppConfig { max_duration_limit: 5000, default_max_duration: 4000, ..AppConfig::default() };
        let c = c.normalize();
        assert_eq!(c.max_duration_limit, 900);
        assert_eq!(c.default_max_duration, 900);

        let c = AppConfig { max_duration_limit: 10, default_max_duration: 1, ..AppConfig::default() };
        let c = c.normalize();
        assert_eq!(c.max_duration_limit, 60);
        assert_eq!(c.default_max_duration, 8);

        let c = AppConfig::default().normalize();
        assert_eq!((c.max_duration_limit, c.default_max_duration), (900, 360));
    }

    #[test]
    fn vae_decode_defaults_to_auto_and_normalizes() {
        let c: AppConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(c.vae_decode, "auto");
        let c: AppConfig = serde_json::from_str(r#"{"vaeDecode":"tiled"}"#).unwrap();
        assert_eq!(c.normalize().vae_decode, "tiled");
        let c: AppConfig = serde_json::from_str(r#"{"vaeDecode":"bogus"}"#).unwrap();
        assert_eq!(c.normalize().vae_decode, "auto");
    }

    #[test]
    fn vae_fp32_defaults_off_for_old_configs() {
        let c: AppConfig = serde_json::from_str(r#"{"precision":"int8"}"#).unwrap();
        assert!(!c.vae_fp32);
        assert_eq!(c.checkpoint_file(), "yue2_3b_int8_convrot.safetensors");
        let c: AppConfig = serde_json::from_str(r#"{"vaeFp32":true}"#).unwrap();
        assert!(c.vae_fp32);
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mcs_config_test_{tag}_{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn old_auto_start_comfy_key_is_ignored() {
        let c = AppConfig::from_json(br#"{"autoStartComfy":false,"comfyPort":8188}"#).unwrap();
        assert_eq!(c.comfy_port, 8188);
        let back = serde_json::to_value(&c).unwrap();
        assert!(back.get("autoStartComfy").is_none());
    }

    #[cfg(windows)]
    #[test]
    fn locations_are_validated() {
        let ok = |p: &str, data: bool| location_error(Path::new(p), "X", data);
        assert_eq!(ok(r"C:\MCSYuE2", true), None);
        assert_eq!(ok(r"D:\My Music #1\it's", true), None);
        assert_eq!(ok(r"C:\Users\山田\Music\Music Creator Studio YuE2", false), None);
        assert_eq!(ok(r"\\server\share\mcs", true), None);
        for bad in ["", "   ", "MCSYuE2", r"C:MCSYuE2", r"\MCSYuE2", r#""C:\MCSYuE2""#, r"C:\a|b", r"C:\a?b", r"C:\a:b", r"C:\MCS \x", r"C:\MCS.", r"C:\a\..\b", "C:\\a\u{7}b", r"C:\", r"D:\", r"\\server\share"] {
            assert!(ok(bad, false).is_some(), "{bad:?} should be rejected");
        }
        // ';' breaks the PATH entry for the bundled ffmpeg: data root only.
        assert!(ok(r"C:\a;b", true).is_some());
        assert_eq!(ok(r"C:\a;b", false), None);
    }

    #[cfg(windows)]
    #[test]
    fn validate_rejects_ports_and_paths() {
        let c = AppConfig { output_dir: PathBuf::from(r"C:\Users\x\Music\Music Creator Studio YuE2"), ..AppConfig::default() };
        assert!(c.validate().is_ok());
        let msg = |c: &AppConfig| c.validate().unwrap_err().to_string();
        let mut z = c.clone();
        z.comfy_port = 0;
        assert!(msg(&z).contains("ComfyUI ポート"));
        let mut z = c.clone();
        z.llm_port = 0;
        assert!(msg(&z).contains("LLM ポート"));
        let mut z = c.clone();
        z.llm_port = z.comfy_port;
        assert!(msg(&z).contains("別の番号"));
        let mut z = c.clone();
        z.data_root = PathBuf::new();
        assert!(msg(&z).starts_with("データルート"));
        let mut z = c.clone();
        z.output_dir = PathBuf::from("songs");
        assert!(msg(&z).starts_with("楽曲の保存先"));
    }

    #[cfg(windows)]
    #[test]
    fn repair_fixes_only_what_load_can_fix() {
        let raw = br#"{"dataRoot":"  \"D:\\MCS\"  ","outputDir":"","comfyPort":0,"llmPort":8099}"#;
        let c = AppConfig::from_json(raw).unwrap().repair();
        assert_eq!(c.data_root, PathBuf::from(r"D:\MCS"));
        assert_eq!(c.output_dir, AppConfig::default().output_dir);
        assert_eq!((c.comfy_port, c.llm_port), (DEFAULT_COMFY_PORT, DEFAULT_LLM_PORT));
        // Equal ports: the LLM moves, also when ComfyUI took the LLM default.
        let c = AppConfig::from_json(br#"{"comfyPort":8188,"llmPort":8188}"#).unwrap().repair();
        assert_eq!((c.comfy_port, c.llm_port), (8188, DEFAULT_LLM_PORT));
        let c = AppConfig::from_json(br#"{"comfyPort":8099,"llmPort":8099}"#).unwrap().repair();
        assert_eq!((c.comfy_port, c.llm_port), (8099, DEFAULT_COMFY_PORT));
        // A relative path goes back to the default; an absolute one (even a drive root) is kept.
        let c = AppConfig::from_json(br#"{"dataRoot":"MCS","outputDir":"D:\\"}"#).unwrap().repair();
        assert_eq!(c.data_root, PathBuf::from(DEFAULT_DATA_ROOT));
        assert_eq!(c.output_dir, PathBuf::from(r"D:\"));
    }

    #[test]
    fn write_atomic_replaces_and_cleans_up() {
        let d = temp_dir("atomic");
        let p = d.join("config.json");
        std::fs::write(&p, b"old").unwrap();
        write_atomic(&p, b"new").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"new");
        assert!(!d.join("config.json.tmp").exists());
        // A failed rename (target is a directory) keeps the target and removes the temporary file.
        let dir_target = d.join("sub");
        std::fs::create_dir_all(dir_target.join("x")).unwrap();
        assert!(write_atomic(&dir_target, b"x").is_err());
        assert!(!d.join("sub.tmp").exists());
        assert!(dir_target.is_dir());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn unreadable_config_is_kept_and_locations_recovered() {
        let d = temp_dir("bad");
        let p = d.join("config.json");
        // One field of the wrong type fails the whole document.
        std::fs::write(&p, br#"{"setupCompleted":true,"comfyPort":70000}"#).unwrap();
        let root = d.join("root");
        std::fs::create_dir_all(&root).unwrap();
        let root2 = root.clone();
        let root3 = root.clone();
        let (c, notice) = AppConfig::load_from(&p, move || (Some(root2), Some(PathBuf::from(r"Z:\gone\songs"))));
        assert!(!c.setup_completed);
        assert_eq!(c.data_root, root);
        // A recorded folder that no longer exists is not used.
        assert_eq!(c.output_dir, AppConfig::default().output_dir);
        let backups = || -> Vec<PathBuf> {
            std::fs::read_dir(&d).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with("config.json.bad-")).map(|e| e.path()).collect()
        };
        let first = backups();
        assert_eq!(first.len(), 1);
        assert_eq!(std::fs::read(&first[0]).unwrap(), std::fs::read(&p).unwrap());
        let first_name = first[0].file_name().unwrap().to_string_lossy().to_string();
        // The user is told, with the backup's name and the install folder in use.
        let notice = notice.expect("a notice for the broken file");
        assert!(notice.contains(&first_name), "{notice}");
        assert!(notice.contains(&root.display().to_string()), "{notice}");
        // Loading the same broken file again (the wizard closed without saving) makes no second copy.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let (_, again) = AppConfig::load_from(&p, move || (Some(root3), None));
        assert_eq!(backups().len(), 1);
        assert!(again.unwrap().contains(&first_name));
        // Other broken content is kept as well.
        std::fs::write(&p, b"{not json").unwrap();
        let _ = AppConfig::load_from(&p, || (None, None));
        assert_eq!(backups().len(), 2);
        // A readable file is loaded (and repaired) without touching the registry record, and without a notice.
        std::fs::create_dir_all(root.join("runtime")).unwrap();
        std::fs::write(&p, serde_json::to_vec(&serde_json::json!({"setupCompleted":true,"comfyPort":0,"dataRoot":root})).unwrap()).unwrap();
        let (c, notice) = AppConfig::load_from(&p, || panic!("registry must not be read"));
        assert!(c.setup_completed && notice.is_none());
        assert_eq!(c.comfy_port, DEFAULT_COMFY_PORT);
        // A missing file gives the defaults, without a notice.
        let (c, notice) = AppConfig::load_from(&d.join("missing.json"), || panic!("registry must not be read"));
        assert!(!c.setup_completed && notice.is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn completed_setup_without_runtime_reopens_the_wizard() {
        let d = temp_dir("gone");
        let p = d.join("config.json");
        let root = d.join("MCSYuE2");
        let write = |root: &Path| std::fs::write(&p, serde_json::to_vec(&serde_json::json!({"setupCompleted":true,"licenseAccepted":true,"dataRoot":root})).unwrap()).unwrap();
        let load = || AppConfig::load_from(&p, || panic!("registry must not be read")).0;
        // Installed: stays completed.
        std::fs::create_dir_all(root.join("runtime")).unwrap();
        write(&root);
        assert!(load().setup_completed);
        // The uninstaller removed the tools (and the then empty data root): wizard again, license kept.
        std::fs::remove_dir_all(&root).unwrap();
        let c = load();
        assert!(!c.setup_completed);
        assert!(c.license_accepted);
        // Only the models or other data left: still no runtime.
        std::fs::create_dir_all(root.join("models")).unwrap();
        assert!(!load().setup_completed);
        // Data root on a folder or drive that is not reachable: left alone.
        write(&d.join("offline").join("MCSYuE2"));
        assert!(load().setup_completed);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// NSIS `Delete` wildcard match (`*` any run, `?` one character, case-insensitive like the file system).
    fn nsis_wildcard(pattern: &str, name: &str) -> bool {
        fn m(p: &[char], n: &[char]) -> bool {
            match p.split_first() {
                None => n.is_empty(),
                Some(('*', rest)) => (0..=n.len()).any(|i| m(rest, &n[i..])),
                Some((c, rest)) => n.split_first().is_some_and(|(d, nr)| (*c == '?' || c.eq_ignore_ascii_case(d)) && m(rest, nr)),
            }
        }
        m(&pattern.chars().collect::<Vec<_>>(), &name.chars().collect::<Vec<_>>())
    }

    #[test]
    fn uninstaller_deletes_every_separation_model() {
        let hooks = include_str!("../windows/hooks.nsh");
        let patterns: Vec<&str> = hooks
            .lines()
            .filter_map(|l| l.trim().strip_prefix(r#"Delete "$R0\models\separation\"#)?.strip_suffix('"'))
            .collect();
        let nodes = include_str!("../../comfy-nodes/mcs_yue2_nodes/nodes.py");
        let block = &nodes[nodes.find("SEPARATION_MODELS = [").expect("SEPARATION_MODELS in nodes.py")..];
        let block = &block[block.find('[').unwrap() + 1..block.find(']').unwrap()];
        let models: Vec<&str> = block.split(',').map(|s| s.trim().trim_matches('"')).filter(|s| !s.is_empty()).collect();
        assert!(models.len() >= 5, "{models:?}");
        // What audio-separator 0.47.0 downloads with them (download_checks.json and its own models.json).
        let companions = [
            "model_bs_roformer_ep_317_sdr_12.9755.yaml",
            "model_bs_roformer_ep_368_sdr_12.9628.yaml",
            "vocals_mel_band_roformer.yaml",
            "config_melbandroformer_big_beta4.yaml",
            "f7e0c4bc-ba3fe64a.th",
            "d12395a8-e57c48e6.th",
            "92cfc3b6-ef3bcb9c.th",
            "04573f0d-f3cf25b2.th",
            "download_checks.json",
            // Fetched only for hash-identified models (not the app's YAML-config ones), deleted all the same.
            "mdx_model_data.json",
            "vr_model_data.json",
        ];
        // The node pack downloads each file into <name><_PART_SUFFIX> first; a ComfyUI killed mid-download
        // (taskkill /F on quit) leaves that file behind.
        let part_suffix = nodes.lines().find_map(|l| l.strip_prefix("_PART_SUFFIX = \"")?.split_once('"').map(|(s, _)| s)).expect("_PART_SUFFIX in nodes.py");
        assert_eq!(part_suffix, ".mcs_part");
        for f in models.iter().chain(companions.iter()) {
            assert!(patterns.iter().any(|p| nsis_wildcard(p, f)), "hooks.nsh McsDeleteDataRoot does not delete models\\separation\\{f}");
            let part = format!("{f}{part_suffix}");
            assert!(patterns.iter().any(|p| nsis_wildcard(p, &part)), "hooks.nsh McsDeleteDataRoot does not delete models\\separation\\{part}");
        }
        // The patterns stay specific to the app's files (a user's own file in the folder is kept).
        assert!(!patterns.iter().any(|p| nsis_wildcard(p, "my_model.ckpt") || nsis_wildcard(p, "notes.txt")));
        assert!(nsis_wildcard("a*.th*", "abc.th.part") && !nsis_wildcard("a?.th", "abc.th"));
    }

    #[test]
    fn uninstaller_deletes_every_download_archive() {
        let hooks = include_str!("../windows/hooks.nsh");
        let patterns: Vec<&str> = hooks.lines().filter_map(|l| l.trim().strip_prefix(r#"Delete "$R0\cache\"#)?.strip_suffix('"')).collect();
        let archives: Vec<String> = crate::setup::components()
            .into_iter()
            .filter(|c| matches!(c.kind, crate::setup::Kind::SevenZip | crate::setup::Kind::Zip))
            .map(|c| c.url.rsplit('/').next().unwrap().to_string())
            .collect();
        assert!(archives.len() >= 4, "{archives:?}");
        for a in &archives {
            for name in [a.clone(), format!("{a}.part"), format!("{a}.part.src")] {
                assert!(patterns.iter().any(|p| nsis_wildcard(p, &name)), "hooks.nsh McsDeleteDataRoot does not delete cache\\{name}");
            }
        }
        // Another tool's download in the same cache folder stays.
        assert!(!patterns.iter().any(|p| nsis_wildcard(p, "other.zip") || nsis_wildcard(p, "model.safetensors")));
    }

    #[test]
    fn uninstaller_deletes_every_downloaded_file() {
        // A single-file component, its interrupted download (.part) and the download's source note (.part.src).
        let hooks = include_str!("../windows/hooks.nsh");
        let lines: Vec<&str> = hooks.lines().map(str::trim).collect();
        let files: Vec<String> = crate::setup::components().into_iter().filter(|c| c.kind == crate::setup::Kind::File).map(|c| c.dest.replace('/', "\\")).collect();
        assert!(files.len() >= 7, "{files:?}");
        for f in &files {
            // Inside a folder removed as a whole (runtime\bin), or matched by a Delete pattern of its folder.
            let in_removed_folder = lines.iter().filter_map(|l| l.strip_prefix(r#"!insertmacro McsRMDirR "${UN}" "$R0\"#)?.strip_suffix('"')).any(|d| f.starts_with(&format!("{d}\\")));
            let (dir, name) = f.rsplit_once('\\').unwrap();
            let prefix = format!(r#"Delete "$R0\{dir}\"#);
            let patterns: Vec<&str> = lines.iter().filter_map(|l| l.strip_prefix(prefix.as_str())?.strip_suffix('"')).collect();
            for n in [name.to_string(), format!("{name}.part"), format!("{name}.part.src")] {
                assert!(in_removed_folder || patterns.iter().any(|p| nsis_wildcard(p, &n)), "hooks.nsh McsDeleteDataRoot does not delete {dir}\\{n}");
            }
        }
    }

    /// The settings page tells the user that a shared user folder is not cleaned by the uninstaller
    /// (isShellFolder in src/config/rules.ts); hooks.nsh McsIsShellPath must cover at least the same folders.
    #[test]
    fn uninstaller_protects_every_shell_folder() {
        let rules = include_str!("../../src/config/rules.ts");
        let start = rules.find("function isShellFolder").expect("isShellFolder in rules.ts");
        let body = &rules[start..];
        let alt = &body[body.find(r"\\(").expect("the folder alternation") + 3..];
        let alt = &alt[..alt.find(")").unwrap()];
        let names: Vec<&str> = alt.split('|').map(|n| n.trim_end_matches(r"[^\\]*")).collect();
        assert!(names.contains(&"Documents") && names.contains(&"OneDrive"), "{names:?}");
        let hooks = include_str!("../windows/hooks.nsh");
        let f = &hooks[hooks.find("Function ${UN}McsIsShellPath").expect("McsIsShellPath")..];
        let f = &f[..f.find("FunctionEnd").unwrap()];
        for n in names {
            assert!(f.contains(&format!("== \"{n}\"")), "hooks.nsh McsIsShellPath does not protect a profile's {n} folder");
        }
        assert!(hooks.contains(r#"StrCpy $R1 $R2 8"#), "OneDrive* is compared by its first 8 characters");
    }

    /// A song folder used before the current one may still hold songs (the library keeps them there). When it lies
    /// inside one of the data root's folders the tools prompt deletes, the uninstaller refuses that prompt as it does
    /// for the current song folder: it reads the former ones from FormerOutputDirs.
    #[test]
    fn the_song_folders_used_before_are_recorded_for_the_uninstaller() {
        let root = r"C:\MCSYuE2";
        let output = r"C:\MCSYuE2\runtime\ComfyUI_windows_portable\ComfyUI\output";
        // the folder used until now joins the list when another one is saved, when it may lie in a tree the
        // uninstaller removes as a whole (REMOVED_TREES) of a data root: of any one, the uninstaller's may be another
        assert_eq!(former_output_dirs("", output, r"D:\Songs"), output);
        assert_eq!(former_output_dirs("", r"C:/MCSYuE2/cache/sep_work/songs/", r"D:\Songs"), r"C:/MCSYuE2/cache/sep_work/songs/");
        for inside in [r"E:\Other\runtime\bin", r"\\server\share\MCS\RUNTIME\LLAMA\songs", r"D:\runtime\\ffmpeg\x", r"C:\MCSYuE2\runtime\COMFYU~1\ComfyUI\output"] {
            assert_eq!(former_output_dirs("", inside, r"F:\New"), inside, "{inside}");
        }
        // elsewhere it cannot go with the tools: not recorded (the list stays short)
        for elsewhere in [r"D:\Songs", r"C:\MCSYuE2\songs", r"C:\MCSYuE2\runtime", r"C:\MCSYuE2\comfy_output\mcs", r"C:\MCSYuE2\runtime\ComfyUI_windows_portable2", r"C:\MCSYuE2\myruntime\bin", r"C:\MCSYuE2\runtime\binaries", r"C:\MCSYuE2\llama\runtime"] {
            assert_eq!(former_output_dirs("", elsewhere, r"F:\New"), "", "{elsewhere}");
        }
        // the data root may change before the song folder, or with it (Settings and setup save both), and back: the
        // folder is recorded all the same (registry values after each save: DataRoot, OutputDir)
        for saves in [
            vec![(root, output), (r"D:\MCSYuE2", output), (r"D:\MCSYuE2", r"D:\Songs"), (root, r"D:\Songs")],
            vec![(root, output), (r"D:\MCSYuE2", output), (root, r"D:\Songs")],
        ] {
            let (mut list, mut previous) = (String::new(), "");
            for &(_data_root, song_folder) in &saves {
                list = former_output_dirs(&list, previous, song_folder);
                previous = song_folder;
            }
            assert_eq!(list, output, "{saves:?}");
        }
        // nothing changes while the same folder is saved again (also written differently)
        assert_eq!(former_output_dirs(output, output, &output.to_lowercase()), "");
        assert_eq!(former_output_dirs(output, r"D:\Songs", r"D:\Songs\"), output);
        assert_eq!(former_output_dirs("", "", r"D:\Songs"), "");
        // a folder used again leaves the list (it is the current one), and no folder is listed twice
        let ffmpeg = r"C:\MCSYuE2\runtime\ffmpeg\songs";
        assert_eq!(former_output_dirs(&format!("{output}|{ffmpeg}"), r"D:\Songs", output), ffmpeg);
        assert_eq!(former_output_dirs(&format!("{output}|{ffmpeg}"), &output.to_uppercase(), r"F:\New"), format!("{ffmpeg}|{}", output.to_uppercase()));
        // the 16 most recent are kept, and the value stays short enough for the uninstaller to read it whole (NSIS
        // strings hold 1024 characters: a longer value would read as empty and the check would be skipped)
        let many: Vec<String> = (0..20).map(|i| format!(r"{root}\runtime\llama\S{i}")).collect();
        let kept = former_output_dirs(&many.join("|"), output, r"F:\New");
        assert_eq!(kept.split('|').count(), 16);
        assert!(kept.ends_with(&format!(r"S19|{output}")) && !kept.contains(r"\S4|"), "{kept}");
        let long: Vec<String> = (0..16).map(|i| format!(r"{root}\runtime\llama\{}{i}", "x".repeat(120))).collect();
        let kept = former_output_dirs(&long.join("|"), output, r"F:\New");
        assert!(kept.encode_utf16().count() <= FORMER_OUTPUT_DIRS_MAX_UNITS, "{}", kept.len());
        assert!(kept.ends_with(output), "the newest are kept: {kept}");
        let wide = format!(r"{root}\runtime\llama\{}", "曲".repeat(FORMER_OUTPUT_DIRS_MAX_UNITS));
        assert_eq!(former_output_dirs("", &wide, r"F:\New"), "", "one folder longer than the value can hold is not recorded");
        // the app writes the list before OutputDir, and the uninstaller reads it and checks each folder
        let src = include_str!("config.rs");
        let write = &src[src.find("fn write_registry(").unwrap()..src.find("// ---- derived paths ----").unwrap()];
        assert!(write.contains("former_output_dirs(&list, &previous, &self.output_dir.to_string_lossy())"), "{write}");
        assert!(write.find("registry::set_string(REGISTRY_KEY, FORMER_OUTPUT_DIRS,").unwrap() < write.find(r#"("OutputDir", &self.output_dir)"#).unwrap());
        assert!(write.contains(r#"if name == "OutputDir" && !former_ok {"#), "OutputDir waits for the list");
        let hooks = include_str!("../windows/hooks.nsh");
        assert!(hooks.contains(&format!(r#"ReadRegStr $5 HKCU "Software\MusicCreatorStudioYuE2" "{FORMER_OUTPUT_DIRS}""#)), "hooks.nsh reads {FORMER_OUTPUT_DIRS}");
        // (into $5, which McsToolsChoice gives McsFormerInDataRoot: uninstall_hook_has_a_message_for_every_tools_choice)
        assert!(hooks.contains("Push $5\r\n          Push $2\r\n          Call ${UN}McsFormerInDataRoot"));
    }

    /// The uninstall hook decides about the tools and models in McsToolsChoice, which nsis_hooks_test.ps1 checks choice
    /// by choice (a song folder inside the folders the tools prompt deletes in, one or a former one that cannot be
    /// compared with them because its 8.3 names cannot be made long ...). The hook only shows a message for each choice
    /// and offers the prompt for "ask"; each recorded path is cleaned once, and what that cleaning gave decides.
    #[test]
    fn uninstall_hook_has_a_message_for_every_tools_choice() {
        let hooks = include_str!("../windows/hooks.nsh");
        let hook = &hooks[hooks.find("!macro NSIS_HOOK_POSTUNINSTALL").expect("the uninstall hook")..];
        assert_eq!(hook.matches("Call un.McsToolsChoice").count(), 1);
        for choice in ["root", "inside", "unknown", "former", "former?", "ask"] {
            assert_eq!(hook.matches(&format!("${{If}} $4 == \"{choice}\"")).count() + hook.matches(&format!("${{ElseIf}} $4 == \"{choice}\"")).count(), 1, "{choice}");
        }
        let ask = hook.find("$4 == \"ask\"").unwrap();
        assert!(hook[ask..].find("Call un.McsDeleteDataRoot").unwrap() < hook[ask..].find("${EndIf}").unwrap(), "only \"ask\" deletes");
        assert_eq!(hook.matches("Call un.McsDeleteDataRoot").count(), 1);
        // both prompts default to No, also in a silent uninstall (/SD IDNO), and No skips the delete; they delete in
        // the cleaned folders ($2 the data root, $3 the song folder)
        let hook = hook.replace("\r\n", "\n");
        for (prompt, folder, delete, skip) in [("ダウンロードしたツールとモデル（$2）を削除しますか？", "$2", "McsDeleteDataRoot", "mcs_skip_data"), ("生成した楽曲（$3）も削除しますか？", "$3", "McsDeleteOutput", "mcs_skip_output")] {
            let at = hook.find(prompt).unwrap_or_else(|| panic!("{prompt}"));
            let line = &hook[hook[..at].rfind('\n').unwrap()..at + hook[at..].find('\n').unwrap()];
            assert!(line.contains("MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \""), "{line}");
            assert!(line.ends_with(&format!("/SD IDNO IDNO {skip}")), "{line}");
            let after: Vec<&str> = hook[at..].lines().skip(1).take(3).map(str::trim).collect();
            assert_eq!(after, [format!("Push {folder}"), format!("Call un.{delete}"), format!("{skip}:")]);
            assert_eq!(hook.matches(&format!("Call un.{delete}")).count(), 1, "{delete} only after its prompt");
        }
        // the songs prompt only for a song folder that is there and was cleaned ("" when it must not be touched)
        let song = hook.find("生成した楽曲（$3）も削除しますか？").unwrap();
        let before: Vec<&str> = hook[..song].lines().rev().take(5).map(str::trim).collect();
        assert!(before[0].starts_with("MessageBox MB_YESNO"), "{before:?}");
        assert_eq!(before[1], "${Else}");
        assert!(before[2].starts_with("MessageBox MB_OK|MB_ICONINFORMATION \"楽曲の保存先（$1）は、"), "{before:?}");
        assert_eq!(before[3..], ["${If} $3 == \"\"", "${If} $7 = 1"]);
        // settings, the library, API keys and the WebView data only with Tauri's "delete app data" checkbox
        let data = hook.find("${If} $DeleteAppDataCheckboxState = 1\n").expect("the app data block");
        let block: Vec<&str> = hook[data..].lines().skip(1).take(4).map(str::trim).collect();
        assert_eq!(
            block,
            [
                r#"!insertmacro McsRMDirR "un." "$APPDATA\MusicCreatorStudioYuE2""#,
                r#"!insertmacro McsRMDirR "un." "$LOCALAPPDATA\com.utausnskareshi.musiccreatorstudioyue2""#,
                r#"DeleteRegKey HKCU "Software\MusicCreatorStudioYuE2""#,
                "${EndIf}",
            ]
        );
        assert_eq!(hook.matches("!insertmacro McsRMDirR \"un.\"").count(), 2);
        assert_eq!(hook.matches("DeleteRegKey").count(), 1);
        // (the folders themselves, whatever instruction would name them, and the delete functions by name; NSIS reads
        // names and variables in any letter case, and Tauri's template defines the identifier as ${BUNDLEID}. Comment
        // lines are left out, so lines must be makensis's: it also ends one at a lone CR, a VT or a FF, reads one only up
        // to a NUL, goes on after a closing "\", and a block comment can end on a ';' line)
        let all = hooks.replace("\r\n", "\n");
        assert!(!all.chars().any(|c| c.is_control() && c != '\n' && c != '\t'), "makensis ends or cuts a line at a lone CR, a VT, a FF or a NUL");
        assert!(!all.lines().any(|l| l.trim_end().ends_with('\\')), "a line ending in \\ goes on in the next");
        assert!(!all.contains("/*"), "a block comment can end on a ';' line");
        let code = hook.lines().filter(|l| !l.trim_start().starts_with(';')).collect::<Vec<_>>().join("\n").to_ascii_lowercase();
        assert_eq!(code.matches(r"$appdata\musiccreatorstudioyue2").count(), 1);
        assert_eq!(code.matches(r"$localappdata\com.utausnskareshi.musiccreatorstudioyue2").count(), 1);
        assert_eq!(code.matches("mcsdeleteoutput").count(), 1);
        assert_eq!(code.matches("mcsdeletedataroot").count(), 1);
        assert_eq!(code.matches("mcsrmdirr").count(), 2);
        for other in ["${bundleid}", "${productname}", r"$profile\appdata", "$localappdata\\${", "$appdata\\${"] {
            assert!(!code.contains(other), "the hook names {other}");
        }
        for f in ["McsCleanPath", "McsOutputInDataRoot", "McsFormerInDataRoot"] {
            assert!(!hook.contains(&format!("Call un.{f}")), "the hook decides with {f} itself");
        }
        let f = &hooks[hooks.find("Function ${UN}McsToolsChoice").expect("McsToolsChoice")..];
        let f = f[..f.find("FunctionEnd").unwrap()].replace("\r\n", "\n");
        assert!(f.contains("Call ${UN}McsCleanPath\n      Pop $3\n      StrCpy $R0 $McsCleanUnsure"), "{f}");
        assert!(f.contains("Call ${UN}McsFormerInDataRoot"));
    }

    #[test]
    fn uninstaller_knows_every_folder_it_removes_with_the_tools() {
        // A song folder inside one of these would go with the tools prompt, so the uninstaller checks it first
        // (McsOutputInDataRoot); its list must be exactly McsDeleteDataRoot's recursive deletes together with the
        // folders it deletes the app's own files in (McsDeleteOwnFiles: comfy_input\mcs_uploads, comfy_output\mcs and
        // mcs_sep, which may have been the song folder once).
        let hooks = include_str!("../windows/hooks.nsh");
        let body = |name: &str| -> &str {
            let f = &hooks[hooks.find(&format!("Function ${{UN}}{name}")).unwrap_or_else(|| panic!("{name} in hooks.nsh"))..];
            &f[..f.find("FunctionEnd").unwrap()]
        };
        let delete = body("McsDeleteDataRoot");
        let mut removed: Vec<&str> = delete.lines().filter_map(|l| l.trim().strip_prefix(r#"!insertmacro McsRMDirR "${UN}" "$R0\"#)?.strip_suffix('"')).collect();
        let deleted_in: Vec<&str> =
            delete.lines().filter_map(|l| l.trim().strip_prefix(r#"!insertmacro McsDeleteOwnFiles "${UN}" "$R0\"#)?.split_once('"').map(|(d, _)| d)).collect();
        assert!(deleted_in.len() >= 3, "{deleted_in:?}");
        let inside = |name: &str| -> Vec<&str> {
            let mut l: Vec<&str> = body(name).lines().filter_map(|l| l.trim().strip_prefix(r#"!insertmacro McsIfInside ""#)?.strip_suffix('"')).collect();
            l.sort_unstable();
            l
        };
        // the trees it removes as a whole: a former song folder there is checked too (McsInRemovedTree), and the app
        // records one only where it may lie in them (REMOVED_TREES, former_output_dirs)
        let mut trees: Vec<&str> = removed.clone();
        trees.sort_unstable();
        assert_eq!(inside("McsInRemovedTree"), trees);
        let mut app: Vec<String> = REMOVED_TREES.iter().map(|t| t.replace('/', "\\")).collect();
        app.sort_unstable();
        assert_eq!(app, trees);
        let checked = inside("McsOutputInDataRoot");
        removed.extend(deleted_in);
        removed.sort_unstable();
        assert!(removed.len() >= 10, "{removed:?}");
        assert_eq!(checked, removed);
    }

    #[test]
    fn uninstaller_unlinks_every_folder_it_deletes_through() {
        // A junction at a folder between the data root and what McsDeleteDataRoot deletes (runtime, cache,
        // models\checkpoints ...) would take the delete into the link's target: each such folder is unlinked first.
        // So is a folder McsDeleteOwnFiles deletes in, which lists what is behind a link at the folder itself.
        let hooks = include_str!("../windows/hooks.nsh");
        let f = &hooks[hooks.find("Function ${UN}McsDeleteDataRoot").expect("McsDeleteDataRoot in hooks.nsh")..];
        let f = &f[..f.find("FunctionEnd").unwrap()];
        let lines: Vec<&str> = f.lines().map(str::trim).collect();
        let unlinked: Vec<&str> = lines.iter().filter_map(|l| l.strip_prefix(r#"!insertmacro McsUnlink "${UN}" "$R0\"#)?.strip_suffix('"')).collect();
        let deleted: Vec<&str> = lines
            .iter()
            .filter_map(|l| l.strip_prefix(r#"!insertmacro McsRMDirR "${UN}" "$R0\"#).or_else(|| l.strip_prefix(r#"Delete "$R0\"#))?.strip_suffix('"'))
            .collect();
        assert!(deleted.len() >= 30, "{deleted:?}");
        let deleted_in: Vec<&str> = lines.iter().filter_map(|l| l.strip_prefix(r#"!insertmacro McsDeleteOwnFiles "${UN}" "$R0\"#)?.split_once('"').map(|(d, _)| d)).collect();
        assert!(deleted_in.len() >= 3, "{deleted_in:?}");
        for d in &deleted {
            let parts: Vec<&str> = d.split('\\').collect();
            for i in 1..parts.len() {
                let folder = parts[..i].join("\\");
                assert!(unlinked.contains(&folder.as_str()), "hooks.nsh McsDeleteDataRoot deletes {d} without unlinking {folder} first");
            }
        }
        for d in &deleted_in {
            let parts: Vec<&str> = d.split('\\').collect();
            for i in 1..=parts.len() {
                let folder = parts[..i].join("\\");
                assert!(unlinked.contains(&folder.as_str()), "hooks.nsh McsDeleteDataRoot deletes in {d} without unlinking {folder} first");
            }
        }
        // Every link goes before anything is deleted, and nothing is deleted while one stays: the skip comes after
        // the last unlink and before the first delete, and its label after the last delete.
        let deletes = |l: &str| ["!insertmacro McsRMDirR", "!insertmacro McsDeleteOwnFiles", "Delete ", "RMDir "].iter().any(|p| l.starts_with(p));
        let last_unlink = lines.iter().rposition(|l| l.starts_with("!insertmacro McsUnlink")).expect("McsUnlink in McsDeleteDataRoot");
        let skip = lines.iter().position(|l| *l == "Goto mcs_delete_data_done").expect("the skip in McsDeleteDataRoot");
        let first_delete = lines.iter().position(|l| deletes(l)).expect("a delete in McsDeleteDataRoot");
        let last_delete = lines.iter().rposition(|l| deletes(l)).unwrap();
        let label = lines.iter().position(|l| *l == "mcs_delete_data_done:").expect("the skip's label in McsDeleteDataRoot");
        assert!(last_unlink < skip && skip < first_delete && last_delete < label, "{lines:#?}");
    }

    #[test]
    fn uninstaller_never_deletes_recursively_through_links() {
        // NSIS's RMDir /r follows junctions and empties their targets; McsRMDirR is the only recursive delete.
        let hooks = include_str!("../windows/hooks.nsh");
        let code: Vec<&str> = hooks.lines().filter(|l| !l.trim_start().starts_with(';')).collect();
        assert!(!code.iter().any(|l| l.contains("RMDir /r")), "use McsRMDirR");
        assert!(code.iter().any(|l| l.contains("rd /s /q")));
    }

    #[cfg(windows)]
    #[test]
    fn registry_record_keeps_any_path() {
        // A key of its own: the app's real record (REGISTRY_KEY) is never touched by the tests.
        let key = format!(r"Software\MusicCreatorStudioYuE2-test-{}", uuid::Uuid::new_v4().simple());
        assert_eq!(registry::get_string(&key, "DataRoot"), None);
        // reg.exe printed such a path in the console code page (cp932), so it was never recovered.
        let japanese = std::ffi::OsString::from(r"D:\音楽生成\MCS データ");
        registry::set_string(&key, "DataRoot", &japanese).unwrap();
        registry::set_string(&key, "OutputDir", std::ffi::OsStr::new(r"E:\Songs")).unwrap();
        assert_eq!(registry::get_string(&key, "DataRoot"), Some(japanese.clone()));
        assert_eq!(registry::get_string(&key, "OutputDir").as_deref(), Some(std::ffi::OsStr::new(r"E:\Songs")));
        assert_eq!(registry::get_string(&key, "Missing"), None);
        // Overwritten in place (a moved data root).
        registry::set_string(&key, "DataRoot", std::ffi::OsStr::new(r"C:\MCSYuE2")).unwrap();
        assert_eq!(registry::get_string(&key, "DataRoot").as_deref(), Some(std::ffi::OsStr::new(r"C:\MCSYuE2")));
        let wide: Vec<u16> = key.encode_utf16().chain(std::iter::once(0)).collect();
        let rc = unsafe { windows_sys::Win32::System::Registry::RegDeleteTreeW(windows_sys::Win32::System::Registry::HKEY_CURRENT_USER, wide.as_ptr()) };
        assert_eq!(rc, 0);
        assert_eq!(registry::get_string(&key, "OutputDir"), None);
    }
}
