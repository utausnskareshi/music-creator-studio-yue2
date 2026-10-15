//! Keeps Windows from idle sleep while the app works on something the user waits for (a generation running
//! or queued, a tool run, an export, the setup). GPU, network and disk work do not reset the idle timer, so
//! an unattended setup or song queue would otherwise stop at the sleep timeout until someone wakes the PC.
//! Only the system is kept awake (ES_SYSTEM_REQUIRED), never the display.
//!
//! SetThreadExecutionState belongs to the calling thread (tokio tasks move between threads), so one
//! dedicated thread polls the app's state and sets or clears the request; it ends with the process, which
//! clears the request too.

use std::time::Duration;

/// How often the keeper re-checks the app's state (far below any idle-sleep timeout).
const POLL: Duration = Duration::from_secs(5);

/// The request the keeper thread holds.
#[derive(Default)]
struct Keeper {
    held: bool,
}

impl Keeper {
    /// Bring the request in line with `busy`; `set` is called only on a change.
    fn update(&mut self, busy: bool, set: impl FnOnce(bool)) {
        if busy != self.held {
            set(busy);
            self.held = busy;
        }
    }
}

/// Start the keeper thread: `busy()` says whether the app works right now.
pub fn keep_awake_while(busy: impl Fn() -> bool + Send + 'static) {
    let spawned = std::thread::Builder::new().name("keep-awake".into()).spawn(move || {
        let mut keeper = Keeper::default();
        loop {
            keeper.update(busy(), set_system_required);
            std::thread::sleep(POLL);
        }
    });
    if let Err(e) = spawned {
        log::warn!("keep-awake thread not started (Windows may sleep during long work): {e}");
    }
}

/// Ask Windows to stay awake (`on`) or allow idle sleep again, for the calling thread.
#[cfg(windows)]
fn set_system_required(on: bool) {
    use windows_sys::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED};
    let flags = if on { ES_CONTINUOUS | ES_SYSTEM_REQUIRED } else { ES_CONTINUOUS };
    if unsafe { SetThreadExecutionState(flags) } == 0 {
        log::warn!("SetThreadExecutionState({flags:#x}) failed");
    } else if on {
        log::info!("keeping the system awake while the app works");
    } else {
        log::info!("the system may sleep again (the app is idle)");
    }
}

#[cfg(not(windows))]
fn set_system_required(_on: bool) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_request_follows_the_work_and_changes_only_on_a_change() {
        let mut k = Keeper::default();
        let mut calls = Vec::new();
        for busy in [false, true, true, true, false, false, true] {
            k.update(busy, |on| calls.push(on));
        }
        // Idle at start: nothing to clear. Then set once, cleared once, set again.
        assert_eq!(calls, vec![true, false, true]);
        assert!(k.held);
    }

    /// The real call on this (test) thread: set, then cleared again before the thread ends.
    #[cfg(windows)]
    #[test]
    fn execution_state_can_be_set_and_cleared() {
        use windows_sys::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED};
        set_system_required(true);
        // The previous state is returned: the request set above is in effect.
        let prev = unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) };
        assert_eq!(prev & (ES_CONTINUOUS | ES_SYSTEM_REQUIRED), ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
        set_system_required(false);
        let prev = unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
        assert_eq!(prev & ES_SYSTEM_REQUIRED, 0, "cleared");
    }
}
