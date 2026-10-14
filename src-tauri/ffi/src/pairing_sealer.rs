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

fn crypt(sealing: bool, purpose: &str, input: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
    let limit = if sealing { MAX_PLAIN } else { MAX_SEALED };
    if input.is_empty() || input.len() > limit || purpose.is_empty() || purpose.len() > 256 {
        return Err("invalid protected storage input".into());
    }
    let purpose = CString::new(purpose).map_err(|_| "invalid protected storage purpose")?;
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
        return Err(match status {
            -1 => "Secure Enclave is unavailable".into(),
            -3 => "protected blob is invalid or belongs to another Mac".into(),
            code => format!("Secure Enclave storage failed ({code})"),
        });
    }
    if length == 0 || length > output.len() {
        return Err("invalid protected storage output length".into());
    }
    output.truncate(length);
    Ok(output)
}

pub fn seal(purpose: &str, plaintext: &[u8]) -> Result<Vec<u8>, String> {
    crypt(true, purpose, plaintext).map(|bytes| bytes.to_vec())
}

pub fn open(purpose: &str, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
    crypt(false, purpose, sealed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enclave_envelope_round_trips_and_rejects_wrong_purpose_and_tampering_without_ui() {
        let purpose = "client-ed25519-seed-v1";
        let plain = [42; 32];
        if !crate::device_key::enclave_available() {
            assert_eq!(seal(purpose, &plain).unwrap_err(), "Secure Enclave is unavailable");
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
    fn invalid_inputs_are_rejected_before_native_access() {
        assert!(seal("purpose\0suffix", &[1; 32]).is_err());
        assert!(seal("purpose", &[1; MAX_PLAIN + 1]).is_err());
        assert!(open("purpose", &[1; MAX_SEALED + 1]).is_err());
        assert!(open("", b"blob").is_err());
    }
}
