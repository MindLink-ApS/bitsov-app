//! Safe interface to the iOS scene URL bridge. No logging or persistence.
use std::sync::OnceLock;

static RECEIVE: OnceLock<fn(&str)> = OnceLock::new();
extern "C" {
    fn bitsov_pairing_link_install(receive: extern "C" fn(*const u8, usize));
}

extern "C" fn receive(bytes: *const u8, length: usize) {
    if bytes.is_null() || length > 1_048_576 { return; }
    // SAFETY: Swift lends a valid UTF-8 buffer for this synchronous callback.
    // No pointer escapes; the inbox copies the string before returning.
    let bytes = unsafe { std::slice::from_raw_parts(bytes, length) };
    if let (Ok(link), Some(callback)) = (std::str::from_utf8(bytes), RECEIVE.get()) {
        callback(link);
    }
}

/// Call once on the main thread before creating the Tauri event loop.
pub fn install(callback: fn(&str)) {
    if RECEIVE.set(callback).is_ok() {
        // SAFETY: the callback has C ABI and static lifetime. Swift stores only
        // that function pointer; all URL buffers remain owned by Swift.
        unsafe { bitsov_pairing_link_install(receive); }
    }
}
