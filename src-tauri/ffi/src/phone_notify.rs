//! iOS: post a phone alert with the system default sound through the
//! statically linked Swift bridge (`native/phone_notify.swift`).
use std::ffi::{c_char, CString};

extern "C" {
    fn bitsov_phone_notify(title: *const c_char, body: *const c_char) -> bool;
}

/// Blocking (up to 5 s): call it off the main thread.
pub fn notify(title: &str, body: &str) -> Result<(), String> {
    let title = CString::new(title).map_err(|_| "Alert text cannot contain NUL.".to_string())?;
    let body = CString::new(body).map_err(|_| "Alert text cannot contain NUL.".to_string())?;
    // SAFETY: both pointers are valid NUL-terminated strings for the whole
    // call; Swift copies them into Strings and keeps no pointer.
    if unsafe { bitsov_phone_notify(title.as_ptr(), body.as_ptr()) } {
        Ok(())
    } else {
        Err("The phone did not accept the alert.".into())
    }
}
