//! Diagnostic bundle: logs, config (no secrets), system / component info and recent failed jobs,
//! zipped so the user can attach it to a bug report. Failed jobs include their lyrics, style and score,
//! and paths name the Windows user: the settings page and USER_GUIDE tell the user to check before
//! posting it publicly.

use crate::config::{app_data_dir, log_dir, AppConfig};
use crate::setup::{run_controlled, Exit};
use anyhow::{Context, Result};
use serde_json::json;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use zip::write::SimpleFileOptions;

/// A probe that hangs (nvidia-smi after a driver crash, a broken WMI) is killed after this long.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
/// pip starts the embedded Python and imports its metadata for every package.
const PIP_TIMEOUT: Duration = Duration::from_secs(60);
/// Output kept per probe (pip freeze is a few KB; the cap only guards against a runaway tool).
const PROBE_OUTPUT_CAP: usize = 1024 * 1024;

fn add_file(zip: &mut zip::ZipWriter<std::fs::File>, name: &str, path: &Path, max_bytes: u64) -> Result<bool> {
    if !path.is_file() {
        return Ok(false);
    }
    let mut f = std::fs::File::open(path)?;
    let len = f.metadata()?.len();
    let mut data = Vec::new();
    if len > max_bytes {
        // Keep the tail of large logs; only that part is read.
        let skipped = len - max_bytes;
        f.seek(SeekFrom::Start(skipped))?;
        data.extend_from_slice(format!("[... {skipped} bytes truncated ...]\n").as_bytes());
        f.take(max_bytes).read_to_end(&mut data)?;
    } else {
        f.read_to_end(&mut data)?;
    }
    zip.start_file(name, SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated))?;
    zip.write_all(&data)?;
    Ok(true)
}

fn add_text(zip: &mut zip::ZipWriter<std::fs::File>, name: &str, text: &str) -> Result<()> {
    zip.start_file(name, SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated))?;
    zip.write_all(text.as_bytes())?;
    Ok(())
}

/// The whole output of a probe (stdout, then stderr under a header), or a note why there is none.
fn run(exe: &str, args: &[&str], timeout: Duration) -> String {
    match run_controlled(Path::new(exe), args, &[], Some(timeout), None, PROBE_OUTPUT_CAP) {
        Ok(out) => {
            let mut text = String::from_utf8_lossy(&out.stdout).to_string();
            if !out.stderr.is_empty() {
                text.push_str("\n--- stderr ---\n");
                text.push_str(&String::from_utf8_lossy(&out.stderr));
            }
            if out.truncated {
                text.push_str("\n[truncated]\n");
            }
            match out.exit {
                Exit::TimedOut => text.push_str(&format!("\n(timed out after {} s)\n", timeout.as_secs())),
                Exit::Finished(false) => text.push_str("\n(exited with an error)\n"),
                _ => {}
            }
            text
        }
        Err(e) => format!("(failed: {e:#})"),
    }
}

/// Where the bundle goes: `dest` when its folder exists or can be created, otherwise the same name in
/// `fallback` (the log folder). The song folder may be on a drive that is unplugged or a share that is offline,
/// often just what the user wants to report; the logs do not depend on it.
fn bundle_destination(dest: &Path, fallback: &Path) -> Result<PathBuf> {
    let Some(dir) = dest.parent() else { return Ok(dest.to_path_buf()) };
    let Err(e) = std::fs::create_dir_all(dir) else { return Ok(dest.to_path_buf()) };
    log::warn!("diagnostic bundle: cannot create {} ({e}); writing it to {}", dir.display(), fallback.display());
    std::fs::create_dir_all(fallback)
        .with_context(|| format!("診断バンドルの保存先 {} を作成できません（{e}）。ログフォルダ {} にも作成できませんでした", dir.display(), fallback.display()))?;
    Ok(fallback.join(dest.file_name().unwrap_or_default()))
}

/// Build the bundle at `dest` (a .zip path; in the log folder when its folder is unavailable, see
/// bundle_destination, or cannot take the zip, see write_bundle). Returns the path.
pub fn create_bundle(cfg: &AppConfig, dest: &Path, app_version: &str, failed_jobs: Vec<(String, String)>) -> Result<PathBuf> {
    // Before the probes, so an unusable folder is not reported only after their wait.
    let dest = bundle_destination(dest, &log_dir())?;
    let dest = dest.as_path();
    // Probes first: they can take a while, and a failure here leaves no file at all.
    let os = run("cmd", &["/c", "ver"], PROBE_TIMEOUT);
    let gpu = run("nvidia-smi", &["--query-gpu=name,driver_version,memory.total,memory.used", "--format=csv"], PROBE_TIMEOUT);
    let cpu = run(
        "powershell",
        &["-NoProfile", "-Command", "(Get-CimInstance Win32_Processor).Name; 'RAM_GB=' + [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB,1)"],
        PROBE_TIMEOUT,
    );
    let comfy_version = std::fs::read_to_string(cfg.comfy_root().join("ComfyUI").join("comfyui_version.py")).unwrap_or_else(|_| "(not installed)".into());
    let components: Vec<serde_json::Value> = crate::setup::status(cfg)
        .into_iter()
        .map(|c| json!({ "id": c.component.id, "installed": c.installed, "bytes": c.installed_bytes, "expected": c.component.size }))
        .collect();
    let info = json!({
        "app_version": app_version,
        "generated_at": chrono::Local::now().to_rfc3339(),
        "os": os.trim(),
        "cpu_ram": cpu.trim(),
        "gpu": gpu.trim(),
        "comfyui_version": comfy_version.trim(),
        "data_root": cfg.data_root,
        "output_dir": cfg.output_dir,
        "free_disk_gib": crate::setup::free_disk_gib(&cfg.data_root),
        "components": components,
    });
    // Python environment of ComfyUI (versions of the packages we depend on). `-s` like the launcher,
    // so the list shows only what ComfyUI can import (not the user site-packages).
    let python = cfg.comfy_python();
    let pip = python
        .is_file()
        .then(|| run(&python.to_string_lossy(), &["-s", "-m", "pip", "list", "--format=freeze", "--disable-pip-version-check"], PIP_TIMEOUT));

    write_bundle(dest, &log_dir(), |part| write_zip(part, cfg, &info, pip.as_deref(), &failed_jobs))
}

/// Write the bundle at `dest` with `write` (given `<dest>.part`, renamed at the end, so a failure never leaves a broken
/// zip under the final name). When that fails outside `fallback` (the song folder exists but cannot take it: its drive
/// is full, a read-only share, Controlled Folder Access), it is written once more under the same name in `fallback`
/// (the log folder), from the same probe results. Returns the path written.
fn write_bundle(dest: &Path, fallback: &Path, write: impl Fn(&Path) -> Result<()>) -> Result<PathBuf> {
    let first = match write_renamed(dest, &write) {
        Ok(()) => return Ok(dest.to_path_buf()),
        Err(e) => e,
    };
    let dir = dest.parent().unwrap_or(Path::new(""));
    if dir == fallback {
        return Err(first);
    }
    log::warn!("diagnostic bundle: writing it to {} failed ({first:#}); writing it to {}", dir.display(), fallback.display());
    let retry = fallback.join(dest.file_name().unwrap_or_default());
    match std::fs::create_dir_all(fallback).map_err(anyhow::Error::from).and_then(|()| write_renamed(&retry, &write)) {
        Ok(()) => Ok(retry),
        Err(e) => Err(anyhow::anyhow!("診断バンドルを {} に作成できません（{first:#}）。ログフォルダ {} にも作成できませんでした（{e:#}）", dir.display(), fallback.display())),
    }
}

/// `write` to `<dest>.part`, then rename it to `dest`; the .part is removed when either fails.
fn write_renamed(dest: &Path, write: &impl Fn(&Path) -> Result<()>) -> Result<()> {
    let mut part_name = dest.file_name().unwrap_or_default().to_os_string();
    part_name.push(".part");
    let part = dest.with_file_name(part_name);
    let result = write(&part).and_then(|()| std::fs::rename(&part, dest).with_context(|| format!("{} を作成できません", dest.display())));
    if result.is_err() {
        let _ = std::fs::remove_file(&part);
    }
    result
}

/// A failed job's song folder when its row has one (an absolute path). A run that ended before make_song_dir has an
/// empty folder (jobs.rs mark_ended): joining file names to "" or a relative path would read the process working
/// directory (the install folder when the app starts from its shortcut), so such a job gets only its error.txt.
fn failed_job_dir(folder: &str) -> Option<PathBuf> {
    let dir = PathBuf::from(folder);
    dir.is_absolute().then_some(dir)
}

fn write_zip(path: &Path, cfg: &AppConfig, info: &serde_json::Value, pip: Option<&str>, failed_jobs: &[(String, String)]) -> Result<()> {
    let file = std::fs::File::create(path).with_context(|| format!("{} を作成できません", path.display()))?;
    let mut zip = zip::ZipWriter::new(file);
    let logs = log_dir();
    for name in ["app.log", "app.1.log", "comfyui.log", "comfyui.1.log", "llama-server.log", "llama-server.1.log"] {
        add_file(&mut zip, &format!("logs/{name}"), &logs.join(name), 4 * 1024 * 1024)?;
    }
    // Config without secrets (secrets.json is never included).
    add_file(&mut zip, "config.json", &app_data_dir().join("config.json"), 1024 * 1024)?;
    add_file(&mut zip, "extra_model_paths.yaml", &cfg.extra_model_paths(), 64 * 1024)?;
    add_text(&mut zip, "system_info.json", &serde_json::to_string_pretty(info)?)?;
    if let Some(pip) = pip {
        add_text(&mut zip, "comfyui_pip_freeze.txt", pip)?;
    }
    // Recent failed jobs: their workflow + metadata (no audio).
    for (i, (folder, error)) in failed_jobs.iter().enumerate() {
        add_text(&mut zip, &format!("failed_jobs/{i}/error.txt"), error)?;
        // failure.json: the failed run's params, prompt id and versions at the time (jobs::write_failure).
        if let Some(dir) = failed_job_dir(folder) {
            for name in ["workflow_api.json", "failure.json", "song.json", "lyrics.txt", "score.abc"] {
                add_file(&mut zip, &format!("failed_jobs/{i}/{name}"), &dir.join(name), 512 * 1024)?;
            }
        }
    }
    zip.finish()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A failed job whose run ended before its song folder was made has an empty folder (jobs.rs mark_ended): only its
    /// error.txt goes in the bundle. An empty or relative path would resolve against the process working directory
    /// (the install folder when the app starts from its shortcut), whose files are not the job's.
    #[test]
    fn a_failed_job_without_a_song_folder_reads_no_files() {
        assert_eq!(failed_job_dir(""), None);
        assert_eq!(failed_job_dir("song.json"), None);
        assert_eq!(failed_job_dir(r"songs\a"), None);
        assert_eq!(failed_job_dir(r"D:\songs\a"), Some(PathBuf::from(r"D:\songs\a")));
        assert_eq!(failed_job_dir(r"\\nas\share\a"), Some(PathBuf::from(r"\\nas\share\a")));
        // write_zip reads a failed job's files only through it
        let src = include_str!("diagnostics.rs");
        let body = &src[src.find("fn write_zip(").unwrap()..src.find("#[cfg(test)]").unwrap()];
        assert!(body.contains("if let Some(dir) = failed_job_dir(folder)"), "write_zip must skip the files of a job without a folder");
        assert!(!body.contains("PathBuf::from(folder)"));
    }

    #[test]
    fn large_files_keep_only_their_tail() {
        let d = std::env::temp_dir().join(format!("mcs_diag_test_{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&d).unwrap();
        let log = d.join("big.log");
        std::fs::write(&log, b"0123456789abcdef").unwrap();
        let zip_path = d.join("t.zip");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&zip_path).unwrap());
        assert!(add_file(&mut zip, "big.log", &log, 6).unwrap());
        assert!(add_file(&mut zip, "small.log", &log, 1024).unwrap());
        assert!(!add_file(&mut zip, "missing.log", &d.join("missing.log"), 6).unwrap());
        zip.finish().unwrap();
        let mut archive = zip::ZipArchive::new(std::fs::File::open(&zip_path).unwrap()).unwrap();
        let mut read = |name: &str| {
            let mut s = String::new();
            archive.by_name(name).unwrap().read_to_string(&mut s).unwrap();
            s
        };
        assert_eq!(read("big.log"), "[... 10 bytes truncated ...]\nabcdef");
        assert_eq!(read("small.log"), "0123456789abcdef");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The song folder cannot be created (its drive unplugged, a file in the way): the bundle goes to the log
    /// folder instead; when that fails too, the error names both folders.
    #[test]
    fn the_bundle_falls_back_when_the_song_folder_is_unavailable() {
        let d = std::env::temp_dir().join(format!("mcs_diag_dest_{}", uuid::Uuid::new_v4().simple()));
        let logs = d.join("logs");
        let dest = d.join("songs").join("mcs-diagnostics-1.zip");
        assert_eq!(bundle_destination(&dest, &logs).unwrap(), dest);
        assert!(d.join("songs").is_dir());
        // A file where the folder should be: create_dir_all fails like on a missing drive.
        std::fs::write(d.join("blocked"), b"x").unwrap();
        let dest = d.join("blocked").join("mcs-diagnostics-2.zip");
        assert_eq!(bundle_destination(&dest, &logs).unwrap(), logs.join("mcs-diagnostics-2.zip"));
        assert!(logs.is_dir());
        let e = format!("{:#}", bundle_destination(&dest, &d.join("blocked").join("logs")).unwrap_err());
        assert!(e.contains(&d.join("blocked").display().to_string()) && e.contains("logs"), "{e}");
        #[cfg(windows)]
        {
            let free = ('D'..='Z').rev().map(|c| PathBuf::from(format!("{c}:\\"))).find(|r| !r.exists()).expect("a free drive letter");
            let away = free.join("Music").join("mcs-diagnostics-3.zip");
            assert_eq!(bundle_destination(&away, &logs).unwrap(), logs.join("mcs-diagnostics-3.zip"));
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The song folder exists but cannot take the zip (a full drive, a read-only share, Controlled Folder Access): the
    /// bundle is written to the log folder instead, without a .part left behind; when that fails too, the error names
    /// both folders. A bundle already in the log folder is not tried there twice.
    #[test]
    fn a_bundle_the_song_folder_cannot_take_goes_to_the_log_folder() {
        let d = std::env::temp_dir().join(format!("mcs_diag_write_{}", uuid::Uuid::new_v4().simple()));
        let (songs, logs) = (d.join("songs"), d.join("logs"));
        std::fs::create_dir_all(&songs).unwrap();
        let tries = std::cell::Cell::new(0);
        let write = |p: &Path| {
            tries.set(tries.get() + 1);
            std::fs::write(p, b"zip").with_context(|| format!("{} を作成できません", p.display()))
        };
        assert_eq!(write_bundle(&songs.join("a.zip"), &logs, write).unwrap(), songs.join("a.zip"));
        assert!(songs.join("a.zip").is_file() && !songs.join("a.zip.part").exists());
        // A folder where the .part goes: creating it fails like in a protected folder.
        std::fs::create_dir_all(songs.join("b.zip.part")).unwrap();
        assert_eq!(write_bundle(&songs.join("b.zip"), &logs, write).unwrap(), logs.join("b.zip"));
        assert!(logs.join("b.zip").is_file() && !logs.join("b.zip.part").exists());
        // A folder under the final name: the rename fails; the .part written in the song folder is removed.
        std::fs::create_dir_all(songs.join("c.zip")).unwrap();
        assert_eq!(write_bundle(&songs.join("c.zip"), &logs, write).unwrap(), logs.join("c.zip"));
        assert!(!songs.join("c.zip.part").exists());
        // Neither folder takes it.
        std::fs::create_dir_all(songs.join("e.zip.part")).unwrap();
        std::fs::create_dir_all(logs.join("e.zip.part")).unwrap();
        let e = format!("{:#}", write_bundle(&songs.join("e.zip"), &logs, write).unwrap_err());
        assert!(e.contains(&songs.display().to_string()) && e.contains(&logs.display().to_string()) && e.contains("ログフォルダ"), "{e}");
        tries.set(0);
        assert!(write_bundle(&logs.join("e.zip"), &logs, write).is_err());
        assert_eq!(tries.get(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[cfg(windows)]
    #[test]
    fn probe_output_is_complete_and_bounded() {
        let long = run("cmd", &["/c", "for /L %i in (1,1,400) do @echo line %i"], PROBE_TIMEOUT);
        // Longer than run_hidden's 2000-character tail, and the first line is still there.
        assert!(long.len() > 2000 && long.starts_with("line 1\r\n") && long.contains("line 400"));
        let hung = run("cmd", &["/c", "ping -n 30 127.0.0.1 >nul"], Duration::from_millis(300));
        assert!(hung.contains("timed out"));
    }
}
