//! Safe, bounded buffers for the prompt-free Secure Enclave storage bridge.

use std::ffi::CString;
use zeroize::Zeroizing;

const MAX_PLAIN: usize = 4096;
const MAX_SEALED: usize = 16384;

unsafe extern "C" {
    fn bitsov_pairing_crypt(
        sealing: i32,
        purpose: *const std::ffi::c_char,
        input: *const u8,
        input_len: usize,
        output: *mut u8,
        capacity: usize,
        length: *mut usize,
    ) -> i32;
}

/// Why protected storage refused. Only the fixed text crosses to callers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StorageError {
    /// This device has no Secure Enclave. Permanent; retrying cannot help.
    SecureStorageUnavailable,
    Failed(String),
}

impl std::fmt::Display for StorageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SecureStorageUnavailable => f.write_str(crate::keychain_status::NO_SECURE_ENCLAVE),
            Self::Failed(message) => f.write_str(message),
        }
    }
}

fn storage_error(status: i32) -> StorageError {
    StorageError::Failed(match status {
        -3 => "protected blob is invalid or belongs to another Mac; clear <app data dir>/app-client/ and pair again".into(),
        code => format!("Secure Enclave or Keychain storage is temporarily unavailable ({code}); try again"),
    })
}

fn crypt(sealing: bool, purpose: &str, input: &[u8]) -> Result<Zeroizing<Vec<u8>>, StorageError> {
    let invalid = |message: &str| StorageError::Failed(message.into());
    let limit = if sealing { MAX_PLAIN } else { MAX_SEALED };
    if input.is_empty() || input.len() > limit || purpose.is_empty() || purpose.len() > 256 {
        return Err(invalid("invalid protected storage input"));
    }
    let purpose = CString::new(purpose).map_err(|_| invalid("invalid protected storage purpose"))?;
    let mut output = Zeroizing::new(vec![0; if sealing { MAX_SEALED } else { MAX_PLAIN }]);
    let mut length = 0;
    // SAFETY: all buffers are live for this synchronous call; Swift checks
    // capacity before copying and retains none of the supplied pointers.
    let status = unsafe {
        bitsov_pairing_crypt(
            i32::from(sealing),
            purpose.as_ptr(),
            input.as_ptr(),
            input.len(),
            output.as_mut_ptr(),
            output.len(),
            &mut length,
        )
    };
    if status != 0 {
        return Err(storage_error(status));
    }
    if length == 0 || length > output.len() {
        return Err(invalid("invalid protected storage output length"));
    }
    output.truncate(length);
    Ok(output)
}

pub fn try_seal(purpose: &str, plaintext: &[u8]) -> Result<Vec<u8>, StorageError> {
    crypt(true, purpose, plaintext).map(|bytes| bytes.to_vec())
}

pub fn try_open(purpose: &str, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, StorageError> {
    crypt(false, purpose, sealed)
}

pub fn seal(purpose: &str, plaintext: &[u8]) -> Result<Vec<u8>, String> {
    try_seal(purpose, plaintext).map_err(|error| error.to_string())
}

pub fn open(purpose: &str, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
    try_open(purpose, sealed).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enclave_envelope_round_trips_and_rejects_wrong_purpose_and_tampering_without_ui() {
        let purpose = "client-ed25519-seed-v1";
        let plain = [42; 32];
        if !crate::device_key::enclave_available() {
            assert!(seal(purpose, &plain).unwrap_err().contains("try again"));
            return;
        }
        let sealed = seal(purpose, &plain).expect("prompt-free enclave seal");
        assert_eq!(open(purpose, &sealed).unwrap().as_slice(), plain);
        assert!(open("pairing-code-v1:other", &sealed).is_err());
        // Alter authenticated ciphertext while keeping the JSON/base64 valid.
        let mut tampered = String::from_utf8(sealed).unwrap();
        let marker = "\"ciphertext\":\"";
        let position = tampered.find(marker).unwrap() + marker.len();
        let replacement = if &tampered[position..position + 1] == "A" {
            "B"
        } else {
            "A"
        };
        tampered.replace_range(position..position + 1, replacement);
        assert!(open(purpose, tampered.as_bytes()).is_err());
        assert!(open(purpose, b"foreign or corrupt envelope").is_err());
    }

    #[test]
    fn only_invalid_blobs_recommend_clearing_the_pairing_folder() {
        let invalid = storage_error(-3).to_string();
        assert!(invalid.contains("<app data dir>/app-client/"));
        assert!(invalid.contains("pair again"));
        for status in [-2, -6, -25308, -25291, -50] {
            let temporary = storage_error(status).to_string();
            assert!(temporary.contains("try again"), "{temporary}");
            assert!(!temporary.to_lowercase().contains("clear"), "{temporary}");
            assert!(!temporary.contains("another Mac"), "{temporary}");
        }
    }

    #[test]
    fn no_enclave_status_is_permanent_not_try_again() {
        let missing = storage_error(-1);
        assert_eq!(missing, StorageError::SecureStorageUnavailable);
        let text = missing.to_string();
        assert!(text.contains("Secure Enclave"), "{text}");
        for word in ["temporarily", "try again", "clear", "delete"] {
            assert!(!text.to_lowercase().contains(word), "{text}");
        }
        assert!(matches!(storage_error(-3), StorageError::Failed(_)));
        assert!(storage_error(-6).to_string().contains("try again"));
    }

    #[test]
    fn invalid_inputs_are_rejected_before_native_access() {
        assert!(seal("purpose\0suffix", &[1; 32]).is_err());
        assert!(seal("purpose", &[1; MAX_PLAIN + 1]).is_err());
        assert!(open("purpose", &[1; MAX_SEALED + 1]).is_err());
        assert!(open("", b"blob").is_err());
    }
}
