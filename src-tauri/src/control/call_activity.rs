//! While a call is live, ask the system to treat this process as a
//! latency-critical, user-initiated activity. On macOS an idle-looking app is
//! otherwise subject to App Nap and timer coalescing, which wakes its threads
//! late and in bunches; for call audio that arrives as bursts the receiver has
//! to buffer through. Other platforms have nothing to ask for: the driver
//! there does nothing, and only the counting below runs.
//!
//! Each open media session holds the activity for its call. The system
//! activity begins when the first hold is taken and ends when the last one is
//! released, so a session replaced by a new one for the same call never ends
//! it early. A hold releases once: by an explicit `release`, or when it is
//! dropped, which also covers a media task that ends by panic. Quitting ends
//! the activity for good. A crashed process loses its activity with it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// What the system is asked to do. `begin` and `end` are called alternately,
/// one at a time, starting with `begin`.
pub trait ActivityDriver: Send + Sync {
    fn begin(&self);
    fn end(&self);
}

/// The live calls and how many holds each has.
pub struct CallActivity {
    driver: Box<dyn ActivityDriver>,
    state: Mutex<Holds>,
}

#[derive(Default)]
struct Holds {
    calls: HashMap<String, usize>,
    /// The process is quitting: no new activity begins.
    closed: bool,
}

impl CallActivity {
    pub fn new(driver: Box<dyn ActivityDriver>) -> Arc<Self> {
        Arc::new(Self { driver, state: Mutex::new(Holds::default()) })
    }

    /// The process-wide instance, with this platform's driver.
    pub fn system() -> &'static Arc<CallActivity> {
        static SYSTEM: OnceLock<Arc<CallActivity>> = OnceLock::new();
        SYSTEM.get_or_init(|| CallActivity::new(Box::new(SystemDriver)))
    }

    /// Hold the activity for `call_id` until the returned hold is released.
    ///
    /// After `shutdown`, this returns a no-op hold: nothing begins, and
    /// releasing or dropping it does nothing.
    pub fn hold(self: &Arc<Self>, call_id: &str) -> CallHold {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return CallHold { activity: None, call_id: String::new(), released: AtomicBool::new(true) };
        }
        let first = state.calls.is_empty();
        *state.calls.entry(call_id.to_string()).or_insert(0) += 1;
        // Under the lock: the driver sees begin and end strictly alternating.
        if first {
            self.driver.begin();
        }
        CallHold { activity: Some(self.clone()), call_id: call_id.to_string(), released: AtomicBool::new(false) }
    }

    /// End the activity and take no new holds. Holds still out release as no-ops.
    pub fn shutdown(&self) {
        let mut state = self.state.lock().unwrap();
        state.closed = true;
        if !state.calls.is_empty() {
            state.calls.clear();
            self.driver.end();
        }
    }

    /// Whether the system activity is held right now.
    pub fn is_active(&self) -> bool {
        !self.state.lock().unwrap().calls.is_empty()
    }

    /// How many holds `call_id` has.
    pub fn holds(&self, call_id: &str) -> usize {
        self.state.lock().unwrap().calls.get(call_id).copied().unwrap_or(0)
    }

    fn release(&self, call_id: &str) {
        let mut state = self.state.lock().unwrap();
        let Some(count) = state.calls.get_mut(call_id) else { return };
        *count -= 1;
        if *count == 0 {
            state.calls.remove(call_id);
            if state.calls.is_empty() {
                self.driver.end();
            }
        }
    }
}

/// One media session's hold on the activity for its call.
pub struct CallHold {
    activity: Option<Arc<CallActivity>>,
    call_id: String,
    released: AtomicBool,
}

impl CallHold {
    /// Give the hold back. A second call does nothing.
    pub fn release(&self) {
        if self.released.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Some(activity) = &self.activity {
            activity.release(&self.call_id);
        }
    }
}

impl Drop for CallHold {
    fn drop(&mut self) {
        self.release();
    }
}

/// Releases a shared hold when dropped, however many others still share it:
/// the media task's own guard, so a task that ends any way lets go.
pub struct ReleaseOnDrop(pub Arc<CallHold>);

impl Drop for ReleaseOnDrop {
    fn drop(&mut self) {
        self.0.release();
    }
}

struct SystemDriver;

#[cfg(all(target_os = "macos", not(feature = "mobile")))]
impl ActivityDriver for SystemDriver {
    fn begin(&self) {
        bitsov_ffi::call_activity::begin();
    }
    fn end(&self) {
        bitsov_ffi::call_activity::end();
    }
}

#[cfg(not(all(target_os = "macos", not(feature = "mobile"))))]
impl ActivityDriver for SystemDriver {
    fn begin(&self) {}
    fn end(&self) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Recorder(Mutex<Vec<&'static str>>);

    struct Driver(Arc<Recorder>);
    impl ActivityDriver for Driver {
        fn begin(&self) {
            self.0 .0.lock().unwrap().push("begin");
        }
        fn end(&self) {
            self.0 .0.lock().unwrap().push("end");
        }
    }

    fn activity() -> (Arc<CallActivity>, Arc<Recorder>) {
        let recorder = Arc::new(Recorder::default());
        (CallActivity::new(Box::new(Driver(recorder.clone()))), recorder)
    }

    fn calls(recorder: &Recorder) -> Vec<&'static str> {
        recorder.0.lock().unwrap().clone()
    }

    #[test]
    fn one_call_begins_once_and_ends_once() {
        let (activity, recorder) = activity();
        assert!(calls(&recorder).is_empty(), "idle asks the system for nothing");
        let hold = activity.hold("call-a");
        assert!(activity.is_active());
        assert_eq!(activity.holds("call-a"), 1);
        hold.release();
        assert_eq!(calls(&recorder), ["begin", "end"]);
        assert!(!activity.is_active());
    }

    #[test]
    fn end_is_idempotent_and_drop_after_release_does_nothing() {
        let (activity, recorder) = activity();
        let hold = activity.hold("call-a");
        hold.release();
        hold.release();
        drop(hold);
        assert_eq!(calls(&recorder), ["begin", "end"]);
        assert_eq!(activity.holds("call-a"), 0);
    }

    #[test]
    fn dropping_a_hold_ends_the_activity() {
        let (activity, recorder) = activity();
        {
            let _hold = activity.hold("call-a");
        }
        assert_eq!(calls(&recorder), ["begin", "end"]);
    }

    #[test]
    fn holds_are_counted_per_call() {
        let (activity, recorder) = activity();
        // A session replaced by a new one for the same call: the old hold
        // ends after the new one began, and must not end the activity.
        let old = activity.hold("call-a");
        let new = activity.hold("call-a");
        assert_eq!(activity.holds("call-a"), 2);
        old.release();
        old.release();
        assert_eq!(activity.holds("call-a"), 1, "a repeated release counts once");
        assert!(activity.is_active());
        let other = activity.hold("call-b");
        new.release();
        assert!(activity.is_active(), "another call still holds it");
        other.release();
        assert_eq!(calls(&recorder), ["begin", "end"]);
        // A later call begins again.
        let again = activity.hold("call-c");
        drop(again);
        assert_eq!(calls(&recorder), ["begin", "end", "begin", "end"]);
    }

    #[test]
    fn a_panicking_media_task_still_releases() {
        let (activity, recorder) = activity();
        let hold = activity.hold("call-a");
        let result = std::thread::spawn(move || {
            let _hold = hold;
            panic!("media task failed");
        })
        .join();
        assert!(result.is_err());
        assert_eq!(calls(&recorder), ["begin", "end"]);
        assert!(!activity.is_active());
    }

    #[test]
    fn a_shared_hold_is_released_by_whichever_owner_lets_go_first() {
        let (activity, recorder) = activity();
        // The session slot and the media task share one hold.
        let hold = Arc::new(activity.hold("call-a"));
        let in_slot = hold.clone();
        drop(ReleaseOnDrop(hold));
        assert!(!activity.is_active(), "the task ending releases it while the slot still has it");
        in_slot.release();
        drop(in_slot);
        assert_eq!(calls(&recorder), ["begin", "end"]);
    }

    #[test]
    fn shutdown_ends_once_and_refuses_new_holds() {
        let (activity, recorder) = activity();
        let a = activity.hold("call-a");
        let b = activity.hold("call-a");
        activity.shutdown();
        activity.shutdown();
        a.release();
        drop(b);
        let late = activity.hold("call-b");
        assert!(!activity.is_active());
        drop(late);
        assert_eq!(calls(&recorder), ["begin", "end"]);
    }

    #[test]
    fn shutdown_while_idle_asks_nothing() {
        let (activity, recorder) = activity();
        activity.shutdown();
        assert!(calls(&recorder).is_empty());
    }
}
