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

unsafe extern "C" {
    fn bitsov_client_data_protection_available() -> i32;
    fn bitsov_auth_context_create(reason: *const std::ffi::c_char, setup_finish: i32) -> *mut std::ffi::c_void;
    fn bitsov_auth_context_release(context: *mut std::ffi::c_void);
    fn bitsov_device_blob_sign(blob: *const u8, count: usize, expected: *const u8,
        message: *const u8, message_len: usize, reason: *const std::ffi::c_char,
        signature: *mut u8, capacity: usize, length: *mut usize, context: *mut std::ffi::c_void, setup: i32) -> i32;
}

pub fn data_protection_available() -> bool {
    // SAFETY: no pointers; inspects only the current process's entitlements.
    unsafe { bitsov_client_data_protection_available() == 1 }
}

/// Scoped to one blocking signing operation; never shared or cached across polls.
pub struct AuthenticationContext(std::ptr::NonNull<std::ffi::c_void>);
impl AuthenticationContext {
    pub fn new_for_operation(reason: &str, setup_finish: bool) -> Result<Self, String> {
        let reason = CString::new(reason).map_err(|_| "invalid signing reason")?;
        // SAFETY: Swift copies the string and returns an owned, opaque context.
        let pointer = unsafe { bitsov_auth_context_create(reason.as_ptr(), i32::from(setup_finish)) };
        std::ptr::NonNull::new(pointer).map(Self).ok_or_else(|| "cannot create authentication context".into())
    }
    pub fn sign(&self, blob: &[u8], expected: &[u8; 65], message: &[u8], reason: &str, setup: Option<bool>) -> Result<Vec<u8>, crate::device_key::DeviceKeyError> {
        use crate::device_key::{DeviceKeyError, status_error};
        if blob.is_empty() || blob.len() > 4096 { return Err(DeviceKeyError::Invalid); }
        let reason = CString::new(reason).map_err(|_| DeviceKeyError::Other(-5))?;
        let mut signature = vec![0; 72];
        let mut length = 0;
        // SAFETY: all slices have checked lengths, the expected public key is
        // exactly 65 bytes, and the owned context stays live for this call.
        let status = unsafe { bitsov_device_blob_sign(blob.as_ptr(), blob.len(), expected.as_ptr(),
            message.as_ptr(), message.len(), reason.as_ptr(), signature.as_mut_ptr(), signature.len(),
            &mut length, self.0.as_ptr(), setup.map(i32::from).unwrap_or(-1)) };
        if status != 0 { return Err(status_error(status)); }
        if !(2..=72).contains(&length) || signature[0] != 0x30 || usize::from(signature[1]) != length - 2 {
            return Err(DeviceKeyError::Other(-6));
        }
        signature.truncate(length);
        Ok(signature)
    }
}
impl Drop for AuthenticationContext {
    fn drop(&mut self) {
        // SAFETY: releases exactly the context owned by this wrapper, once.
        unsafe { bitsov_auth_context_release(self.0.as_ptr()) }
    }
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
    fn bitsov_device_blob_read(path: *const std::ffi::c_char, output: *mut u8, capacity: usize, length: *mut usize, context: *mut std::ffi::c_void) -> i32;
    fn bitsov_device_blob_add(path: *const std::ffi::c_char, bytes: *const u8, length: usize) -> i32;
    fn bitsov_device_blob_delete(path: *const std::ffi::c_char) -> i32;
}

pub fn read_blob(path: &Path, context: &AuthenticationContext) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
    let path = path_string(path)?;
    let mut bytes = Zeroizing::new(vec![0; 4096]);
    let mut length = 0;
    // SAFETY: buffers remain live, Swift bounds all writes and retains no pointers.
    match unsafe { bitsov_device_blob_read(path.as_ptr(), bytes.as_mut_ptr(), bytes.len(), &mut length, context.0.as_ptr()) } {
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
        0 | -25300 => Ok(()), status => Err(error(status)),
    }
}

/// Real Keychain add/read/delete from the packaged process, without UI.
#[cfg(target_os = "macos")]
pub fn smoke_test() -> Result<&'static str, String> {
    unsafe extern "C" { fn bitsov_mac_keychain_smoke() -> i32; }
    let path = if data_protection_available() { "data-protection-keychain" } else { "enclave-sealed-file" };
    // SAFETY: no pointers; the native probe uses a unique public marker and
    // deletes its exact service/account before returning.
    match unsafe { bitsov_mac_keychain_smoke() } {
        0 => Ok(path),
        status => Err(format!("Keychain smoke failed: path={path} status={status}")),
    }
}

/// Lookup public attributes only, with authentication UI disabled.
pub fn blob_metadata(path: &Path) -> Result<(bool, Option<[u8; 65]>), String> {
    unsafe extern "C" {
        fn bitsov_device_blob_metadata(path: *const std::ffi::c_char, public: *mut u8, length: *mut usize) -> i32;
    }
    let path = path_string(path)?;
    let mut public = [0; 65];
    let mut length = 0;
    // SAFETY: Swift copies at most 65 bytes, retains no pointers, and only
    // requests attributes. Both output buffers stay live throughout the call.
    match unsafe { bitsov_device_blob_metadata(path.as_ptr(), public.as_mut_ptr(), &mut length) } {
        0 if length == 0 => Ok((true, None)),
        0 if length == 65 && public[0] == 4 => Ok((true, Some(public))),
        -25300 => Ok((false, None)),
        status => Err(error(status)),
    }
}

#[cfg(all(test, target_os = "macos", feature = "native-test-keys"))]
mod tests {
    use super::*;
    use crate::device_key::{create, DeviceKeyError, Policy};
    use ring::signature::{UnparsedPublicKey, ECDSA_P256_SHA256_ASN1};

    #[test]
    fn scoped_signing_context_verifies_identity_and_preserves_one_use_setup_authorization() {
        let _guard = crate::device_key::SETUP_TEST_LOCK.lock().unwrap();
        let (blob, public) = create(Policy::NoPromptForTests).unwrap();
        let context = AuthenticationContext::new_for_operation("Test signing", false).unwrap();
        let signature = context.sign(&blob, &public, b"message", "Test signing", None).unwrap();
        UnparsedPublicKey::new(&ECDSA_P256_SHA256_ASN1, public).verify(b"message", &signature).unwrap();
        assert_eq!(context.sign(&blob, &[4; 65], b"message", "Test signing", None), Err(DeviceKeyError::Invalid));
        let register = b"bitsov-device-register-v2\nnode:node\nclient:client\npublic_key:04ab\nsas_digest:55";
        context.sign(&blob, &public, register, "Test setup", Some(false)).unwrap();
        drop(context);
        let context = AuthenticationContext::new_for_operation("Test first unlock", true).unwrap();
        let unlock = b"bitsov-node-unlock-v1\nnode:node\nclient:client\nepoch:0\nkey:key\nchallenge:nonce\nbox_transport:box";
        let signature = context.sign(&blob, &public, unlock, "Test first unlock", Some(true)).unwrap();
        UnparsedPublicKey::new(&ECDSA_P256_SHA256_ASN1, public).verify(unlock, &signature).unwrap();
        assert!(context.sign(&blob, &public, unlock, "Test first unlock", Some(true)).is_err());
    }
}
