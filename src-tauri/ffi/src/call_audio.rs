//! Minimal safe wrapper around the existing statically linked Swift bridge.
//! The app dispatches these calls to Tauri's UIKit main thread.
extern "C" {
    fn bitsov_call_audio_set_live(live: bool) -> bool;
    fn bitsov_call_audio_terminate();
    fn bitsov_call_audio_set_speaker(on: bool) -> i32;
    fn bitsov_call_audio_route() -> i32;
}

/// Speaker on or off for the Live call; see `CallAudioOutput` in call_audio.swift.
/// Returns the resulting output code (0 inactive, 1 earpiece, 2 speaker, 3 external).
pub fn set_speaker(on: bool) -> Result<i32, String> {
    // SAFETY: primitive value only, called on the UIKit main thread (checked by Swift).
    match unsafe { bitsov_call_audio_set_speaker(on) } {
        code @ 0..=3 => Ok(code),
        _ => Err("Could not change the iPhone call audio route.".into()),
    }
}

/// The current output code while Live, otherwise 0. Main thread only.
pub fn route() -> i32 {
    // SAFETY: no arguments or retained memory; called on the UIKit main thread.
    unsafe { bitsov_call_audio_route() }
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
