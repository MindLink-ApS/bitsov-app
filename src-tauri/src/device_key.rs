//! Secure Enclave device key (macOS).
//!
//! A P-256 signing key created inside the Secure Enclave through CryptoKit. The
//! private key never leaves the enclave; the app only keeps an opaque,
//! device-bound blob (`dataRepresentation`, ~570 bytes) and the 65-byte X9.63
//! public key. The blob is useless on any other Mac. No keychain item is used.
//!
//! The Swift side is `native/device_key.swift`, compiled by `build.rs` into a
//! static library. This module is the only place with `unsafe` for it; the lib
//! crate keeps `#![forbid(unsafe_code)]`, so the bridge lives in the binary crate.
//!
//! Other targets get a stub where [`available`] is false and every call returns
//! [`DeviceKeyError::Unavailable`].

// `Policy::NoPromptForTests` is constructed only by tests.
#![allow(dead_code)]

use std::fmt;

/// Upper bound for a key blob. Observed size is ~570 bytes.
const BLOB_CAP: usize = 4096;
/// Upper bound for a DER ECDSA P-256 signature (at most 72 bytes).
const SIG_CAP: usize = 128;
/// X9.63 uncompressed P-256 public key: 0x04 || X || Y.
pub const PUBLIC_KEY_LEN: usize = 65;

/// Who must approve each signature made with the key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Policy {
    /// Touch ID (current enrollment) for every signature. Production policy.
    /// The key becomes unusable if the enrolled fingerprints change.
    Biometry,
    /// No user presence: signs silently. For automated tests only; never use it
    /// for a real device key.
    NoPromptForTests,
}

impl Policy {
    fn code(self) -> i32 {
        match self {
            Policy::Biometry => 1,
            Policy::NoPromptForTests => 0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeviceKeyError {
    /// No Secure Enclave (or not macOS).
    Unavailable,
    /// The user dismissed the prompt, or authentication failed / is locked out.
    Cancelled,
    /// The blob is not a key for this device's enclave.
    Invalid,
    /// No Touch ID to ask: none on this Mac, no finger enrolled, or locked out.
    BiometryUnavailable,
    /// Any other bridge status code.
    Other(i32),
}

impl fmt::Display for DeviceKeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DeviceKeyError::Unavailable => f.write_str("Secure Enclave is not available"),
            DeviceKeyError::Cancelled => f.write_str("device key approval was cancelled"),
            DeviceKeyError::Invalid => f.write_str("device key is not valid on this device"),
            DeviceKeyError::BiometryUnavailable => f.write_str("Touch ID is not available (none, not enrolled, or locked out)"),
            DeviceKeyError::Other(code) => write!(f, "device key error (code {code})"),
        }
    }
}

impl std::error::Error for DeviceKeyError {}

// Status codes shared with native/device_key.swift.
const OK: i32 = 0;
const ERR_UNAVAILABLE: i32 = -1;
const ERR_CANCELLED: i32 = -2;
const ERR_INVALID_BLOB: i32 = -3;
const ERR_BIOMETRY_UNAVAILABLE: i32 = -7;

fn status_error(code: i32) -> DeviceKeyError {
    match code {
        ERR_UNAVAILABLE => DeviceKeyError::Unavailable,
        ERR_CANCELLED => DeviceKeyError::Cancelled,
        ERR_INVALID_BLOB => DeviceKeyError::Invalid,
        ERR_BIOMETRY_UNAVAILABLE => DeviceKeyError::BiometryUnavailable,
        other => DeviceKeyError::Other(other),
    }
}

#[cfg(target_os = "macos")]
mod ffi {
    extern "C" {
        pub fn bitsov_dk_available() -> i32;
        pub fn bitsov_dk_biometry() -> i32;
        pub fn bitsov_dk_public(blob: *const u8, blob_len: usize, out_pub: *mut u8) -> i32;
        pub fn bitsov_dk_create(
            policy: i32,
            out_blob: *mut u8,
            blob_cap: usize,
            out_blob_len: *mut usize,
            out_pub: *mut u8,
        ) -> i32;
        pub fn bitsov_dk_sign(
            blob: *const u8,
            blob_len: usize,
            msg: *const u8,
            msg_len: usize,
            reason: *const std::ffi::c_char,
            out_sig: *mut u8,
            sig_cap: usize,
            out_sig_len: *mut usize,
        ) -> i32;
    }
}

/// True when this Mac has a usable Secure Enclave. Keys can be created; see
/// [`available`] for whether the owner can approve with them.
#[cfg(target_os = "macos")]
pub fn enclave_available() -> bool {
    // SAFETY: no arguments; the Swift function only reads SecureEnclave.isAvailable.
    unsafe { ffi::bitsov_dk_available() == 1 }
}

/// True when this Mac can approve with a device key now: a Secure Enclave and
/// Touch ID with an enrolled finger, not locked out. Never prompts.
#[cfg(target_os = "macos")]
pub fn available() -> bool {
    // SAFETY: no arguments; the Swift function only asks LAContext whether
    // biometric authentication can be evaluated, which never prompts.
    enclave_available() && unsafe { ffi::bitsov_dk_biometry() == OK }
}

/// Create a new enclave key. Never prompts, even for [`Policy::Biometry`].
///
/// Returns the device-bound blob to store and the X9.63 public key.
#[cfg(target_os = "macos")]
pub fn create(policy: Policy) -> Result<(Vec<u8>, [u8; PUBLIC_KEY_LEN]), DeviceKeyError> {
    let mut blob = vec![0u8; BLOB_CAP];
    let mut blob_len: usize = 0;
    let mut public = [0u8; PUBLIC_KEY_LEN];
    // SAFETY: `blob` is a live, writable buffer of exactly `BLOB_CAP` bytes and the
    // Swift side writes at most `blob_cap` bytes into it. `public` is exactly 65
    // writable bytes, which is what the Swift side writes. `blob_len` is a valid
    // `usize` out-pointer. None of the pointers are retained after the call.
    let status = unsafe {
        ffi::bitsov_dk_create(
            policy.code(),
            blob.as_mut_ptr(),
            BLOB_CAP,
            &mut blob_len,
            public.as_mut_ptr(),
        )
    };
    if status != OK {
        return Err(status_error(status));
    }
    if blob_len == 0 || blob_len > BLOB_CAP || public[0] != 0x04 {
        return Err(DeviceKeyError::Other(status));
    }
    blob.truncate(blob_len);
    Ok((blob, public))
}

/// Sign `message` (ECDSA P-256 over SHA-256) with the key in `blob`; returns the
/// DER signature.
///
/// BLOCKING: for a [`Policy::Biometry`] key this shows the system Touch ID sheet
/// (`reason` is its text) and waits for the user. Call it from
/// `tokio::task::spawn_blocking` / `tauri::async_runtime::spawn_blocking`, never
/// on an async executor thread or the main thread.
#[cfg(target_os = "macos")]
pub fn sign(blob: &[u8], message: &[u8], reason: &str) -> Result<Vec<u8>, DeviceKeyError> {
    if blob.is_empty() || blob.len() > BLOB_CAP {
        return Err(DeviceKeyError::Invalid);
    }
    let reason = std::ffi::CString::new(reason).map_err(|_| DeviceKeyError::Other(-5))?;
    let mut sig = vec![0u8; SIG_CAP];
    let mut sig_len: usize = 0;
    // SAFETY: `blob` and `message` are live slices passed with their exact lengths
    // and only read. `reason` is a NUL-terminated C string that outlives the call.
    // `sig` is a writable buffer of exactly `SIG_CAP` bytes and the Swift side
    // writes at most `sig_cap` bytes. `sig_len` is a valid `usize` out-pointer.
    // The call is synchronous and retains no pointer.
    let status = unsafe {
        ffi::bitsov_dk_sign(
            blob.as_ptr(),
            blob.len(),
            message.as_ptr(),
            message.len(),
            reason.as_ptr(),
            sig.as_mut_ptr(),
            SIG_CAP,
            &mut sig_len,
        )
    };
    if status != OK {
        return Err(status_error(status));
    }
    if sig_len == 0 || sig_len > SIG_CAP {
        return Err(DeviceKeyError::Other(status));
    }
    sig.truncate(sig_len);
    Ok(sig)
}

/// The public key of the key in `blob`. Never prompts.
#[cfg(target_os = "macos")]
pub fn public_key(blob: &[u8]) -> Result<[u8; PUBLIC_KEY_LEN], DeviceKeyError> {
    if blob.is_empty() || blob.len() > BLOB_CAP {
        return Err(DeviceKeyError::Invalid);
    }
    let mut public = [0u8; PUBLIC_KEY_LEN];
    // SAFETY: `blob` is a live slice passed with its exact length and only
    // read; `public` is exactly 65 writable bytes, what the Swift side writes.
    // Nothing is retained after the call.
    let status = unsafe { ffi::bitsov_dk_public(blob.as_ptr(), blob.len(), public.as_mut_ptr()) };
    if status != OK {
        return Err(status_error(status));
    }
    Ok(public)
}

#[cfg(not(target_os = "macos"))]
pub fn public_key(_blob: &[u8]) -> Result<[u8; PUBLIC_KEY_LEN], DeviceKeyError> {
    Err(DeviceKeyError::Unavailable)
}

#[cfg(not(target_os = "macos"))]
pub fn available() -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
pub fn enclave_available() -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
pub fn create(_policy: Policy) -> Result<(Vec<u8>, [u8; PUBLIC_KEY_LEN]), DeviceKeyError> {
    Err(DeviceKeyError::Unavailable)
}

#[cfg(not(target_os = "macos"))]
pub fn sign(_blob: &[u8], _message: &[u8], _reason: &str) -> Result<Vec<u8>, DeviceKeyError> {
    Err(DeviceKeyError::Unavailable)
}

// These tests use ONLY Policy::NoPromptForTests for signing: a Biometry
// signature would pop Touch ID on the owner's screen.
#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use ring::signature::{UnparsedPublicKey, ECDSA_P256_SHA256_ASN1};

    fn verify(public: &[u8], message: &[u8], der: &[u8]) -> bool {
        UnparsedPublicKey::new(&ECDSA_P256_SHA256_ASN1, public)
            .verify(message, der)
            .is_ok()
    }

    #[test]
    fn enclave_is_available() {
        assert!(enclave_available());
    }

    #[test]
    fn create_returns_blob_and_uncompressed_public_key() {
        let (blob, public) = create(Policy::NoPromptForTests).expect("create");
        assert!(!blob.is_empty() && blob.len() <= BLOB_CAP, "blob len {}", blob.len());
        assert_eq!(public.len(), 65);
        assert_eq!(public[0], 0x04);
    }

    #[test]
    fn signature_verifies_and_tamper_fails() {
        let (blob, public) = create(Policy::NoPromptForTests).expect("create");
        let message = b"bitsov device key test message";
        let der = sign(&blob, message, "BitSov test").expect("sign");
        assert_eq!(der[0], 0x30, "DER SEQUENCE");
        assert!(der.len() <= 72, "DER len {}", der.len());
        assert!(verify(&public, message, &der));
        assert!(!verify(&public, b"bitsov device key test messagE", &der));
        let mut bad = der.clone();
        let last = bad.len() - 1;
        bad[last] ^= 0x01;
        assert!(!verify(&public, message, &bad));
    }

    #[test]
    fn empty_message_signs() {
        let (blob, public) = create(Policy::NoPromptForTests).expect("create");
        let der = sign(&blob, b"", "BitSov test").expect("sign");
        assert!(verify(&public, b"", &der));
    }

    #[test]
    fn the_public_key_reads_back_from_the_blob_without_signing() {
        let (blob, public) = create(Policy::NoPromptForTests).unwrap();
        assert_eq!(public_key(&blob).unwrap(), public);
        assert_eq!(public_key(&[7u8; 64]).unwrap_err(), DeviceKeyError::Invalid);
    }

    #[test]
    fn garbage_blob_is_invalid() {
        assert_eq!(sign(&[0xAB; 64], b"m", "BitSov test"), Err(DeviceKeyError::Invalid));
        assert_eq!(sign(&[], b"m", "BitSov test"), Err(DeviceKeyError::Invalid));
        assert_eq!(
            sign(&vec![0u8; BLOB_CAP + 1], b"m", "BitSov test"),
            Err(DeviceKeyError::Invalid)
        );
    }

    /// Creation with the production policy does not prompt; this proves the
    /// biometry access control is accepted. Do NOT sign with this key here.
    /// Ignored by default: a Mac with no enrolled finger cannot create it.
    /// Run with `cargo test device_key -- --ignored`.
    #[test]
    #[ignore = "needs Touch ID enrolled"]
    fn biometry_key_creates_without_prompt() {
        let (blob, public) = create(Policy::Biometry).expect("create biometry key");
        assert!(!blob.is_empty());
        assert_eq!(public[0], 0x04);
    }
}
