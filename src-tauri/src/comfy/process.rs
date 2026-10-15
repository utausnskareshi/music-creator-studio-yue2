//! Spawn / stop the ComfyUI portable server as a hidden child process.
//!
//! stdout/stderr are redirected to a log file handle (never a pipe): if a pipe reader disappears,
//! tqdm's stderr flush inside ComfyUI raises `[Errno 22]` and every later job fails (seen in P0).

use crate::config::{log_dir, AppConfig};
use anyhow::{bail, Context, Result};
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

/// `--max-upload-size` in MB. The default 100 MB rejects a 32-bit float stereo 48 kHz WAV longer than
/// about 273 s (HTTP 413); 2048 MB covers 900 s songs and high-resolution user files on the HTTP
/// fallback path (inputs are normally staged straight into the input directory, see client::stage_input).
pub const MAX_UPLOAD_MB: u32 = 2048;

pub struct ComfyProcess {
    child: Child,
    /// comfyui.log, named in the "process exited" error.
    pub log_path: PathBuf,
    /// Port this process listens on (the config may already name another one).
    pub port: u16,
    /// Whether this process was launched with `--fp32-vae` (a config change needs a restart).
    pub vae_fp32: bool,
    /// launch_args() it was started with: port, data root (models, input/output folders) and VAE
    /// precision. A config with other launch_args needs a restart (see `matches`).
    pub args: Vec<OsString>,
}

/// Command-line arguments for ComfyUI's main.py (after `python -s`).
pub fn launch_args(cfg: &AppConfig) -> Vec<OsString> {
    let mut a: Vec<OsString> = vec![
        cfg.comfy_main().into(),
        "--windows-standalone-build".into(),
        "--listen".into(),
        "127.0.0.1".into(),
        "--port".into(),
        cfg.comfy_port.to_string().into(),
        "--disable-auto-launch".into(),
        "--extra-model-paths-config".into(),
        cfg.extra_model_paths().into(),
        "--output-directory".into(),
        cfg.comfy_output_dir().into(),
        "--input-directory".into(),
        cfg.comfy_input_dir().into(),
        "--max-upload-size".into(),
        MAX_UPLOAD_MB.to_string().into(),
    ];
    if cfg.vae_fp32 {
        a.push("--fp32-vae".into());
    }
    a
}

impl ComfyProcess {
    pub fn spawn(cfg: &AppConfig) -> Result<Self> {
        let python = cfg.comfy_python();
        if !python.is_file() {
            bail!("ComfyUI の Python が見つかりません: {}", python.display());
        }
        std::fs::create_dir_all(log_dir())?;
        std::fs::create_dir_all(cfg.comfy_output_dir())?;
        std::fs::create_dir_all(cfg.comfy_input_dir())?;
        let log_path = log_dir().join("comfyui.log");
        // Rotate when the log gets large.
        if std::fs::metadata(&log_path).map(|m| m.len() > 20 * 1024 * 1024).unwrap_or(false) {
            let _ = std::fs::rename(&log_path, log_dir().join("comfyui.1.log"));
        }
        let out = std::fs::OpenOptions::new().create(true).append(true).open(&log_path)?;
        let err = out.try_clone()?;

        // audio-separator (and other tools) expect ffmpeg on PATH: prepend the bundled build.
        let mut path_env = std::env::var_os("PATH").unwrap_or_default();
        if let Some(ff) = cfg.ffmpeg_exe().and_then(|p| p.parent().map(|d| d.to_path_buf())) {
            let mut joined = ff.into_os_string();
            joined.push(";");
            joined.push(&path_env);
            path_env = joined;
        }
        let args = launch_args(cfg);
        let mut cmd = Command::new(&python);
        cmd.arg("-s")
            .args(&args)
            .current_dir(cfg.comfy_root())
            .env("PYTHONUTF8", "1")
            .env("PYTHONIOENCODING", "utf-8")
            .env("HF_HUB_DISABLE_SYMLINKS", "1")
            .env("HF_HUB_OFFLINE", "1")
            .env("MCS_SEPARATION_MODELS_DIR", cfg.models_dir().join("separation"))
            // MCS_AlignLyrics passes <MCS_TORCH_HOME>\hub\checkpoints (where setup puts the MMS_FA weights) to
            // torch.hub as model_dir; TORCH_HOME is set only so other torch.hub users share models/torch.
            .env("MCS_TORCH_HOME", cfg.models_dir().join("torch"))
            .env("TORCH_HOME", cfg.models_dir().join("torch"))
            // MCS_VocalSeparate's mcs_sep_* work folders: in the data root's cache (removed by the uninstaller)
            // instead of %TEMP%, where a run killed with ComfyUI would leave its folder. The node creates it.
            .env("MCS_TEMP_DIR", cfg.cache_dir().join("sep_work"))
            .env("MCS_FFMPEG_DIR", cfg.ffmpeg_exe().and_then(|p| p.parent().map(|d| d.to_path_buf())).unwrap_or_default())
            .env("PATH", &path_env)
            .stdin(Stdio::null())
            .stdout(Stdio::from(out))
            .stderr(Stdio::from(err));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let child = cmd.spawn().context("ComfyUI の起動に失敗")?;
        // Tie it to the app's lifetime: a crash or kill of the app must not leave ComfyUI holding VRAM.
        crate::win_job::assign_or_warn(&child, "ComfyUI");
        log::info!("ComfyUI spawned pid={} port={} fp32_vae={}", child.id(), cfg.comfy_port, cfg.vae_fp32);
        Ok(Self { child, log_path, port: cfg.comfy_port, vae_fp32: cfg.vae_fp32, args })
    }

    /// Launched with the settings `cfg` asks for (port, data root, VAE precision).
    pub fn matches(&self, cfg: &AppConfig) -> bool {
        self.args == launch_args(cfg)
    }

    /// `--input-directory` this process was launched with (it keeps it until restarted).
    pub fn input_dir(&self) -> Option<PathBuf> {
        arg_after(&self.args, "--input-directory")
    }

    /// `--output-directory` this process was launched with.
    pub fn output_dir(&self) -> Option<PathBuf> {
        arg_after(&self.args, "--output-directory")
    }

    /// True if the process has not exited.
    pub fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// Kill the whole process tree (python may spawn workers).
    pub fn stop(&mut self) {
        let pid = self.child.id();
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(0x0800_0000)
                .output();
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        log::info!("ComfyUI stopped pid={pid}");
    }
}

/// The value following `flag` in launch arguments.
fn arg_after(args: &[OsString], flag: &str) -> Option<PathBuf> {
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).map(PathBuf::from)
}

impl Drop for ComfyProcess {
    fn drop(&mut self) {
        if self.alive() {
            self.stop();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strs(cfg: &AppConfig) -> Vec<String> {
        launch_args(cfg).iter().map(|a| a.to_string_lossy().to_string()).collect()
    }

    #[test]
    fn launch_args_raise_upload_limit_and_gate_fp32_vae() {
        let mut cfg = AppConfig::default();
        let a = strs(&cfg);
        let i = a.iter().position(|x| x == "--max-upload-size").expect("--max-upload-size");
        assert_eq!(a[i + 1], "2048");
        assert!(!a.iter().any(|x| x == "--fp32-vae"));
        assert!(a.iter().any(|x| x == "--input-directory"));
        cfg.vae_fp32 = true;
        assert!(strs(&cfg).iter().any(|x| x == "--fp32-vae"));
    }

    #[test]
    fn launch_args_change_with_port_data_root_and_precision() {
        let base = AppConfig::default();
        let mut port = base.clone();
        port.comfy_port = 8200;
        let mut root = base.clone();
        root.data_root = PathBuf::from(r"D:\Other");
        let mut fp32 = base.clone();
        fp32.vae_fp32 = true;
        for other in [&port, &root, &fp32] {
            assert_ne!(launch_args(&base), launch_args(other));
        }
        // Settings ComfyUI does not see (LLM, durations) need no restart.
        let mut llm = base.clone();
        llm.llm.gpu_layers = 10;
        llm.default_max_duration = 120;
        assert_eq!(launch_args(&base), launch_args(&llm));
    }

    #[test]
    fn launch_args_listen_on_loopback_only() {
        // ComfyUI's API has no authentication. `--listen` without a value means every interface
        // (argparse const "0.0.0.0,::"), so the flag and its loopback value must stay together.
        for vae_fp32 in [false, true] {
            let a = strs(&AppConfig { vae_fp32, ..AppConfig::default() });
            assert_eq!(a.iter().filter(|x| x.starts_with("--listen")).count(), 1, "{a:?}");
            assert!(a.windows(2).any(|w| w == ["--listen", "127.0.0.1"]), "{a:?}");
            assert!(!a.iter().any(|x| x.contains("0.0.0.0") || x == "::"), "{a:?}");
        }
    }

    #[test]
    fn launch_args_name_the_input_and_output_folders() {
        let cfg = AppConfig { data_root: PathBuf::from("D:/Root"), ..AppConfig::default() };
        let a = launch_args(&cfg);
        assert_eq!(arg_after(&a, "--input-directory"), Some(cfg.comfy_input_dir()));
        assert_eq!(arg_after(&a, "--output-directory"), Some(cfg.comfy_output_dir()));
        assert_eq!(arg_after(&a, "--nope"), None);
    }
}
