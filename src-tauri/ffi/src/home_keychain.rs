//! Safe buffers for the node-scoped Swift Keychain bridge.

use std::ffi::{CString, NulError};
use zeroize::Zeroizing;

unsafe extern "C" {
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
