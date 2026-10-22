//! Safe, blocking bridge; call only from a worker, never the UIKit main thread.
use std::sync::mpsc::{self, Sender};
extern "C" {
    fn bitsov_phone_recovery_open(tailscale: bool, context: usize, complete: extern "C" fn(usize, bool));
}
extern "C" fn complete(context: usize, opened: bool) {
    // SAFETY: open lends one boxed Sender to Swift, which invokes this callback
    // exactly once, including its store fallback. Reclaim only here, even if
    // the receiver timed out or the calling task was cancelled.
    let sender = unsafe { Box::from_raw(context as *mut Sender<bool>) };
    let _ = sender.send(opened);
}
pub fn open(tailscale: bool) -> Result<(), String> {
    let (sender, receiver) = mpsc::channel();
    let context = Box::into_raw(Box::new(sender)) as usize;
    // SAFETY: Swift dispatches onto main and retains only this owned context
    // and a static C callback. No borrowed memory crosses the async boundary.
    unsafe { bitsov_phone_recovery_open(tailscale, context, complete); }
    match receiver.recv_timeout(std::time::Duration::from_secs(15)) {
        Ok(true) => Ok(()),
        _ => Err("Could not open the app. Open it from your home screen.".into()),
    }
}
