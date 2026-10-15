//! One Windows Job Object for the processes this app spawns (ComfyUI, llama-server and the console
//! tools of setup::run_controlled: 7zr, pip, ffmpeg, probes), created with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
//! Its handle is never closed: the kernel closes it when the app process ends in any way (normal exit,
//! panic=abort, a Task Manager kill, the uninstaller), and that ends every process in the job,
//! grandchildren included (python workers, ffmpeg, CUDA helpers).
//!
//! Only spawned children are assigned. The app's own process stays outside the job: programs it
//! opens through the opener plugin or explorer (browser, media player) must outlive it.
//! The normal stop paths (taskkill /T in ComfyProcess::stop / LlamaProcess::stop) are unchanged.

use std::process::Child;

#[cfg(windows)]
mod imp {
    use std::os::windows::io::AsRawHandle;
    use std::sync::OnceLock;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// The job handle as an integer (HANDLE is a raw pointer, which is not Sync); 0 = creation failed.
    static JOB: OnceLock<usize> = OnceLock::new();

    fn job() -> Result<usize, String> {
        let h = *JOB.get_or_init(|| unsafe {
            let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if h.is_null() {
                log::warn!("CreateJobObjectW failed: {}", std::io::Error::last_os_error());
                return 0;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                h,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                // A job without the kill-on-close limit would not help: leave it unused.
                log::warn!("SetInformationJobObject failed: {}", std::io::Error::last_os_error());
                return 0;
            }
            h as usize
        });
        if h == 0 {
            Err("ジョブオブジェクトを作成できませんでした".into())
        } else {
            Ok(h)
        }
    }

    pub fn assign(child: &super::Child) -> Result<(), String> {
        let job = job()?;
        let ok = unsafe { AssignProcessToJobObject(job as *mut core::ffi::c_void, child.as_raw_handle()) };
        if ok == 0 {
            return Err(format!("{}", std::io::Error::last_os_error()));
        }
        Ok(())
    }
}

/// Put `child` into the app's kill-on-close job. A failure only costs the crash cleanup, so the
/// caller logs it and keeps the process running.
pub fn assign(child: &Child) -> Result<(), String> {
    #[cfg(windows)]
    {
        imp::assign(child)
    }
    #[cfg(not(windows))]
    {
        let _ = child;
        Ok(())
    }
}

/// `assign` with the warning the spawn sites log on failure.
pub fn assign_or_warn(child: &Child, what: &str) {
    if let Err(e) = assign(child) {
        log::warn!("{what} (pid {}) is not tied to the app's job object and may outlive a crash: {e}", child.id());
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    #[test]
    fn spawned_child_joins_the_job() {
        let mut child = Command::new("cmd")
            .args(["/C", "ping -n 30 127.0.0.1 >NUL"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x0800_0000)
            .spawn()
            .expect("spawn cmd");
        let r = assign(&child);
        let _ = child.kill();
        let _ = child.wait();
        assert_eq!(r, Ok(()));
        // The job is created once and reused.
        let mut second = Command::new("cmd").args(["/C", "exit 0"]).creation_flags(0x0800_0000).spawn().expect("spawn cmd");
        let _ = assign(&second);
        let _ = second.wait();
    }
}
