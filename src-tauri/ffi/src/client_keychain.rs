//! Bounded, zeroizing bridge for the local client identity. Never logs contents.
use std::{ffi::CString, path::Path};
use zeroize::Zeroizing;

unsafe extern "C" {
    #[cfg(target_os = "ios")]
    fn bitsov_app_is_backgrounded() -> i32;
    fn bitsov_exclude_app_backup(path: *const std::ffi::c_char) -> i32;
    fn bitsov_client_key_read(path: *const std::ffi::c_char, output: *mut u8) -> i32;
    fn bitsov_client_key_add(path: *const std::ffi::c_char, seed: *const u8) -> i32;
    fn bitsov_client_key_delete(path: *const std::ffi::c_char) -> i32;
}

fn path_string(path: &Path) -> Result<CString, String> {
    CString::new(path.to_str().ok_or("invalid client storage path")?)
        .map_err(|_| "invalid client storage path".into())
}
fn error(status: i32) -> String {
    format!("client Keychain storage unavailable ({status}); unlock this device and try again")
}

pub fn read(path: &Path) -> Result<Option<Zeroizing<[u8; 32]>>, String> {
    let path = path_string(path)?;
    let mut seed = Zeroizing::new([0; 32]);
    // SAFETY: the Swift bridge writes exactly 32 bytes on success, retains no
    // pointers, and the path and output buffer remain live throughout the call.
    match unsafe { bitsov_client_key_read(path.as_ptr(), seed.as_mut_ptr()) } {
        0 => Ok(Some(seed)),
        -25300 => Ok(None), // errSecItemNotFound only; locked is never missing.
        status => Err(error(status)),
    }
}

pub fn add(path: &Path, seed: &[u8; 32]) -> Result<(), String> {
    let path = path_string(path)?;
    // SAFETY: both buffers outlive the synchronous call; Swift copies exactly
    // 32 bytes and retains neither pointer. Existing items are never replaced.
    match unsafe { bitsov_client_key_add(path.as_ptr(), seed.as_ptr()) } {
        0 => Ok(()),
        status => Err(error(status)),
    }
}

pub fn exclude_from_backup(path: &Path) -> Result<(), String> {
    let path = path_string(path)?;
    // SAFETY: path remains live for this synchronous call; Swift retains no pointer.
    match unsafe { bitsov_exclude_app_backup(path.as_ptr()) } {
        0 => Ok(()),
        status => Err(format!("cannot exclude device-specific app storage from backups ({status})")),
    }
}

/// Remove only this profile's client identity, without reading it or prompting.
/// Call only after establishing that no app data or pairing state survives.
pub fn delete(path: &Path) -> Result<(), String> {
    let path = path_string(path)?;
    // SAFETY: the path outlives the synchronous call; Swift retains no pointer.
    // The bridge treats an already absent item as success for crash recovery.
    match unsafe { bitsov_client_key_delete(path.as_ptr()) } {
        0 => Ok(()),
        status => Err(error(status)),
    }
}

/// Capture launch lifecycle state without reading identity or Keychain data.
/// Used on the setup thread to distinguish background launch from initial focus.
#[cfg(target_os = "ios")]
pub fn app_is_backgrounded() -> bool {
    // SAFETY: no pointers cross the boundary. Swift checks main-thread access
    // before querying UIKit and otherwise conservatively returns false.
    unsafe { bitsov_app_is_backgrounded() == 1 }
}

unsafe extern "C" {
    fn bitsov_device_blob_read(path: *const std::ffi::c_char, output: *mut u8, capacity: usize, length: *mut usize) -> i32;
    fn bitsov_device_blob_add(path: *const std::ffi::c_char, bytes: *const u8, length: usize) -> i32;
    fn bitsov_device_blob_delete(path: *const std::ffi::c_char) -> i32;
}

pub fn read_blob(path: &Path) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
    let path = path_string(path)?;
    let mut bytes = Zeroizing::new(vec![0; 4096]);
    let mut length = 0;
    // SAFETY: buffers remain live, Swift bounds all writes and retains no pointers.
    match unsafe { bitsov_device_blob_read(path.as_ptr(), bytes.as_mut_ptr(), bytes.len(), &mut length) } {
        0 if (1..=bytes.len()).contains(&length) => { bytes.truncate(length); Ok(Some(bytes)) }
        -25300 => Ok(None),
        status => Err(error(status)),
    }
}

pub fn add_blob(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > 4096 { return Err("invalid device key size".into()); }
    let path = path_string(path)?;
    // SAFETY: the path and bounded slice outlive the synchronous call.
    match unsafe { bitsov_device_blob_add(path.as_ptr(), bytes.as_ptr(), bytes.len()) } {
        0 => Ok(()), status => Err(error(status)),
    }
}

pub fn delete_blob(path: &Path) -> Result<(), String> {
    let path = path_string(path)?;
    // SAFETY: Swift retains no pointer to this live path.
    match unsafe { bitsov_device_blob_delete(path.as_ptr()) } {
        0 => Ok(()), status => Err(error(status)),
    }
}
