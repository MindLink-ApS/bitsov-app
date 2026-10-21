//! Safe buffers for the node-scoped Swift Keychain bridge.

use std::ffi::{CString, NulError};
use zeroize::Zeroizing;

unsafe extern "C" {
    #[cfg(target_os = "macos")]
    fn bitsov_item_add(service: *const std::ffi::c_char, account: *const std::ffi::c_char,
        bytes: *const u8, count: usize) -> i32;
    #[cfg(target_os = "macos")]
    fn bitsov_item_read(service: *const std::ffi::c_char, account: *const std::ffi::c_char,
        output: *mut u8, capacity: usize, length: *mut usize) -> i32;
    #[cfg(target_os = "macos")]
    fn bitsov_item_delete(service: *const std::ffi::c_char, account: *const std::ffi::c_char) -> i32;
    fn bitsov_home_store(
        service: *const std::ffi::c_char,
        bytes: *const u8,
        count: usize,
        secret: i32,
    ) -> i32;
    fn bitsov_home_read(
        service: *const std::ffi::c_char,
        output: *mut u8,
        capacity: usize,
        length: *mut usize,
    ) -> i32;
}

pub fn store(service: &str, bytes: &[u8], secret: bool) -> Result<i32, NulError> {
    let service = CString::new(service)?;
    // SAFETY: both input buffers are live for the synchronous call and the
    // Swift bridge retains neither pointer.
    Ok(unsafe {
        bitsov_home_store(
            service.as_ptr(),
            bytes.as_ptr(),
            bytes.len(),
            i32::from(secret),
        )
    })
}

/// Return the native status, reported output length, and zeroizing output
/// buffer. The caller validates status and length before truncating the buffer.
pub fn read(service: &str, capacity: usize) -> Result<(i32, usize, Zeroizing<Vec<u8>>), NulError> {
    let service = CString::new(service)?;
    let mut bytes = Zeroizing::new(vec![0; capacity]);
    let mut length = 0;
    // SAFETY: output is a live writable buffer of `capacity` bytes. The Swift
    // bridge enforces the capacity and retains no pointers.
    let status = unsafe {
        bitsov_home_read(
            service.as_ptr(),
            bytes.as_mut_ptr(),
            bytes.len(),
            &mut length,
        )
    };
    Ok((status, length, bytes))
}

/// Add-only: an existing launcher password must never be overwritten.
#[cfg(target_os = "macos")]
pub fn add_item(service: &str, account: &str, bytes: &[u8]) -> Result<i32, NulError> {
    let service = CString::new(service)?;
    let account = CString::new(account)?;
    // SAFETY: all buffers remain live for this synchronous call; Swift retains none.
    Ok(unsafe { bitsov_item_add(service.as_ptr(), account.as_ptr(), bytes.as_ptr(), bytes.len()) })
}

#[cfg(target_os = "macos")]
pub fn read_item(service: &str, account: &str, capacity: usize)
    -> Result<(i32, usize, Zeroizing<Vec<u8>>), NulError>
{
    let service = CString::new(service)?;
    let account = CString::new(account)?;
    let mut bytes = Zeroizing::new(vec![0; capacity]);
    let mut length = 0;
    // SAFETY: output has capacity bytes, length is writable, inputs remain live.
    let status = unsafe { bitsov_item_read(service.as_ptr(), account.as_ptr(),
        bytes.as_mut_ptr(), bytes.len(), &mut length) };
    Ok((status, length, bytes))
}

#[cfg(target_os = "macos")]
pub fn delete_items(service: &str, account: &str) -> Result<i32, NulError> {
    let service = CString::new(service)?;
    let account = CString::new(account)?;
    // SAFETY: both exact-item identifiers remain live for the synchronous call.
    Ok(unsafe { bitsov_item_delete(service.as_ptr(), account.as_ptr()) })
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    // Invalid names return before any Security API or UI can be reached.
    #[test]
    fn rejects_truncated_service_and_account_names_before_native_calls() {
        assert!(store("bad\0service", b"secret", false).is_err());
        assert!(read("bad\0service", 16).is_err());
        assert!(add_item("service", "bad\0account", b"secret").is_err());
        assert!(read_item("service", "bad\0account", 16).is_err());
        assert!(delete_items("service", "bad\0account").is_err());
    }
}
