//! Minimal safe wrapper around the existing statically linked Swift bridge.
//! The app dispatches these calls to Tauri's UIKit main thread.
extern "C" {
    fn bitsov_call_audio_set_live(live: bool) -> bool;
    fn bitsov_call_audio_terminate();
}

pub fn set_live(live: bool) -> Result<(), String> {
    // SAFETY: primitive value only; Swift retains no Rust memory. Main-thread
    // precondition is checked by Swift (and provided by the caller's dispatcher).
    if unsafe { bitsov_call_audio_set_live(live) } {
        Ok(())
    } else {
        Err("Could not update the iPhone call audio session.".into())
    }
}

pub fn terminate() {
    // SAFETY: no arguments or retained memory; called on the UIKit run loop.
    unsafe { bitsov_call_audio_terminate() }
}
