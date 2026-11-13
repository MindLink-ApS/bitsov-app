//! Safe wrapper for the Apple Secure Enclave Swift bridge.

use std::fmt;

/// Upper bound for a key blob. Observed size is about 570 bytes.
#[cfg(any(target_os = "macos", target_os = "ios"))]
const BLOB_CAP: usize = 4096;
/// Upper bound for a DER ECDSA P-256 signature (at most 72 bytes).
#[cfg(any(target_os = "macos", target_os = "ios"))]
const SIG_CAP: usize = 72;
/// X9.63 uncompressed P-256 public key: 0x04 || X || Y.
pub const PUBLIC_KEY_LEN: usize = 65;

/// Who must approve each signature made with the key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Policy {
    /// Touch ID (current enrollment) for every signature. Production policy.
    Biometry,
    /// No user presence: signs silently. For automated tests only.
    NoPromptForTests,
}

impl Policy {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    fn code(self) -> i32 {
        match self {
            Policy::Biometry => 1,
            Policy::NoPromptForTests => 0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeviceKeyError {
    Unavailable,
    Cancelled,
    Invalid,
    BiometryUnavailable,
    Other(i32),
}

impl fmt::Display for DeviceKeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DeviceKeyError::Unavailable => f.write_str("Secure Enclave is not available"),
            DeviceKeyError::Cancelled => f.write_str("device key approval was cancelled"),
            DeviceKeyError::Invalid => f.write_str("device key is not valid on this device"),
            DeviceKeyError::BiometryUnavailable => {
                f.write_str("Touch ID is not available (none, not enrolled, or locked out)")
            }
            DeviceKeyError::Other(code) => write!(f, "device key error (code {code})"),
        }
    }
}

impl std::error::Error for DeviceKeyError {}

#[cfg(any(target_os = "macos", target_os = "ios"))]
const OK: i32 = 0;
#[cfg(any(target_os = "macos", target_os = "ios"))]
const ERR_UNAVAILABLE: i32 = -1;
#[cfg(any(target_os = "macos", target_os = "ios"))]
const ERR_CANCELLED: i32 = -2;
#[cfg(any(target_os = "macos", target_os = "ios"))]
const ERR_INVALID_BLOB: i32 = -3;
// A malformed bridge response does not mean the stored enclave key is invalid.
#[cfg(any(target_os = "macos", target_os = "ios"))]
const ERR_TRANSPORT: i32 = -6;
#[cfg(any(target_os = "macos", target_os = "ios"))]
const ERR_BIOMETRY_UNAVAILABLE: i32 = -7;

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub(crate) fn status_error(code: i32) -> DeviceKeyError {
    match code {
        ERR_UNAVAILABLE => DeviceKeyError::Unavailable,
        // Security.framework returns these directly from protected reads.
        ERR_CANCELLED | -128 | -25293 => DeviceKeyError::Cancelled,
        ERR_INVALID_BLOB => DeviceKeyError::Invalid,
        ERR_BIOMETRY_UNAVAILABLE => DeviceKeyError::BiometryUnavailable,
        other => DeviceKeyError::Other(other),
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod ffi {
    unsafe extern "C" {
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
        pub fn bitsov_dk_sign_setup(
            blob: *const u8,
            blob_len: usize,
            msg: *const u8,
            msg_len: usize,
            reason: *const std::ffi::c_char,
            finish: i32,
            out_sig: *mut u8,
            sig_cap: usize,
            out_sig_len: *mut usize,
            context: *mut std::ffi::c_void,
        ) -> i32;
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn enclave_available() -> bool {
    // SAFETY: no arguments; the Swift function only reads enclave availability.
    unsafe { ffi::bitsov_dk_available() == 1 }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn available() -> bool {
    // SAFETY: no arguments; the Swift function only checks whether biometric
    // authentication can be evaluated and never prompts.
    enclave_available() && unsafe { ffi::bitsov_dk_biometry() == OK }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn create(policy: Policy) -> Result<(Vec<u8>, [u8; PUBLIC_KEY_LEN]), DeviceKeyError> {
    // Ordinary Apple builds never accept a non-biometric signing key.
    #[cfg(not(all(target_os = "macos", feature = "native-test-keys", debug_assertions)))]
    if policy != Policy::Biometry { return Err(DeviceKeyError::Unavailable); }
    let mut blob = vec![0u8; BLOB_CAP];
    let mut blob_len = 0;
    let mut public = [0u8; PUBLIC_KEY_LEN];
    // SAFETY: all output buffers are live and passed with their exact capacities.
    // The synchronous Swift function retains no pointers.
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
        return Err(DeviceKeyError::Other(ERR_TRANSPORT));
    }
    blob.truncate(blob_len);
    Ok((blob, public))
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn sign(blob: &[u8], message: &[u8], reason: &str) -> Result<Vec<u8>, DeviceKeyError> {
    if blob.is_empty() || blob.len() > BLOB_CAP {
        return Err(DeviceKeyError::Invalid);
    }
    let reason = std::ffi::CString::new(reason).map_err(|_| DeviceKeyError::Other(-5))?;
    let mut signature = vec![0u8; SIG_CAP];
    let mut signature_len = 0;
    // SAFETY: input slices and the C string outlive the synchronous call. The
    // output buffer is live and passed with its exact capacity.
    let status = unsafe {
        ffi::bitsov_dk_sign(
            blob.as_ptr(),
            blob.len(),
            message.as_ptr(),
            message.len(),
            reason.as_ptr(),
            signature.as_mut_ptr(),
            SIG_CAP,
            &mut signature_len,
        )
    };
    if status != OK {
        return Err(status_error(status));
    }
    if signature_len < 2 || signature_len > SIG_CAP || signature[0] != 0x30
        || usize::from(signature[1]) != signature_len - 2 {
        return Err(DeviceKeyError::Other(ERR_TRANSPORT));
    }
    signature.truncate(signature_len);
    Ok(signature)
}

/// One SAS approval followed by one matching first-unlock signature.
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn sign_setup(blob: &[u8], message: &[u8], reason: &str, finish: bool) -> Result<Vec<u8>, DeviceKeyError> {
    if blob.is_empty() || blob.len() > BLOB_CAP {
        return Err(DeviceKeyError::Invalid);
    }
    let reason = std::ffi::CString::new(reason).map_err(|_| DeviceKeyError::Other(-5))?;
    let mut signature = vec![0u8; SIG_CAP];
    let mut signature_len = 0;
    // SAFETY: input slices and the C string outlive the synchronous call. The
    // output buffer is live and passed with its exact capacity.
    let status = unsafe {
        ffi::bitsov_dk_sign_setup(
            blob.as_ptr(),
            blob.len(),
            message.as_ptr(),
            message.len(),
            reason.as_ptr(),
            i32::from(finish),
            signature.as_mut_ptr(),
            SIG_CAP,
            &mut signature_len,
            std::ptr::null_mut(),
        )
    };
    if status != OK {
        return Err(status_error(status));
    }
    if signature_len < 2 || signature_len > SIG_CAP || signature[0] != 0x30
        || usize::from(signature[1]) != signature_len - 2 {
        return Err(DeviceKeyError::Other(ERR_TRANSPORT));
    }
    signature.truncate(signature_len);
    Ok(signature)
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub fn sign_setup(_: &[u8], _: &[u8], _: &str, _: bool) -> Result<Vec<u8>, DeviceKeyError> {
    Err(DeviceKeyError::Unavailable)
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn public_key(blob: &[u8]) -> Result<[u8; PUBLIC_KEY_LEN], DeviceKeyError> {
    if blob.is_empty() || blob.len() > BLOB_CAP {
        return Err(DeviceKeyError::Invalid);
    }
    let mut public = [0u8; PUBLIC_KEY_LEN];
    // SAFETY: the input and output buffers are live for the synchronous call.
    let status = unsafe { ffi::bitsov_dk_public(blob.as_ptr(), blob.len(), public.as_mut_ptr()) };
    if status != OK {
        return Err(status_error(status));
    }
    if public[0] != 0x04 {
        return Err(DeviceKeyError::Other(ERR_TRANSPORT));
    }
    Ok(public)
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub fn public_key(_blob: &[u8]) -> Result<[u8; PUBLIC_KEY_LEN], DeviceKeyError> {
    Err(DeviceKeyError::Unavailable)
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub fn available() -> bool {
    false
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub fn enclave_available() -> bool {
    false
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub fn create(_policy: Policy) -> Result<(Vec<u8>, [u8; PUBLIC_KEY_LEN]), DeviceKeyError> {
    Err(DeviceKeyError::Unavailable)
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub fn sign(_blob: &[u8], _message: &[u8], _reason: &str) -> Result<Vec<u8>, DeviceKeyError> {
    Err(DeviceKeyError::Unavailable)
}

#[cfg(all(test, target_os = "macos", feature = "native-test-keys"))]
pub(crate) static SETUP_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(all(test, target_os = "macos", feature = "native-test-keys"))]
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
        assert!(
            !blob.is_empty() && blob.len() <= BLOB_CAP,
            "blob len {}",
            blob.len()
        );
        assert_eq!(public.len(), PUBLIC_KEY_LEN);
        assert_eq!(public[0], 0x04);
    }

    #[test]
    fn setup_authorization_is_one_use_and_bound_to_key_node_and_client() {
        let _guard = SETUP_TEST_LOCK.lock().unwrap();
        let (blob, public) = create(Policy::NoPromptForTests).unwrap();
        let register = b"bitsov-device-register-v2\nnode:fp\nclient:client\npublic_key:04ab\nsas_digest:55";
        let unlock = b"bitsov-node-unlock-v1\nnode:fp\nclient:client\nepoch:0\nkey:key\nchallenge:nonce\nbox_transport:box";
        assert!(sign_setup(&blob, unlock, "Test first unlock", true).is_err());
        assert!(sign_setup(&blob, b"arbitrary message", "Test setup", false).is_err());
        let signature = sign_setup(&blob, register, "Test setup", false).unwrap();
        assert!(verify(&public, register, &signature));
        let wrong = b"bitsov-node-unlock-v1\nnode:other\nclient:client\nepoch:0\nkey:key\nchallenge:nonce\nbox_transport:box";
        assert!(sign_setup(&blob, wrong, "Test first unlock", true).is_err());
        sign_setup(&blob, register, "Test setup", false).unwrap();
        let signature = sign_setup(&blob, unlock, "Test first unlock", true).unwrap();
        assert!(verify(&public, unlock, &signature));
        assert!(sign_setup(&blob, unlock, "Test first unlock", true).is_err());
        sign_setup(&blob, register, "Test setup", false).unwrap();
        let (other_blob, _) = create(Policy::NoPromptForTests).unwrap();
        assert!(sign_setup(&other_blob, unlock, "Test first unlock", true).is_err());
    }

    #[test]
    fn signature_verifies_and_tamper_fails() {
        let (blob, public) = create(Policy::NoPromptForTests).expect("create");
        let message = b"bitsov device key test message";
        let der = sign(&blob, message, "BitSov test").expect("sign");
        assert_eq!(der[0], 0x30);
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
    fn public_key_reads_back_without_signing() {
        let (blob, public) = create(Policy::NoPromptForTests).unwrap();
        assert_eq!(public_key(&blob).unwrap(), public);
        assert_eq!(public_key(&[7u8; 64]).unwrap_err(), DeviceKeyError::Invalid);
    }

    #[test]
    fn garbage_blob_is_invalid() {
        assert_eq!(
            sign(&[0xAB; 64], b"m", "BitSov test"),
            Err(DeviceKeyError::Invalid)
        );
        assert_eq!(sign(&[], b"m", "BitSov test"), Err(DeviceKeyError::Invalid));
        assert_eq!(
            sign(&vec![0u8; BLOB_CAP + 1], b"m", "BitSov test"),
            Err(DeviceKeyError::Invalid)
        );
    }

    #[test]
    #[ignore = "needs Touch ID enrolled"]
    fn biometry_key_creates_without_prompt() {
        let (blob, public) = create(Policy::Biometry).expect("create biometry key");
        assert!(!blob.is_empty());
        assert_eq!(public[0], 0x04);
    }
}
