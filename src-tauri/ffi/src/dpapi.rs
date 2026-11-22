//! Current-user DPAPI with no UI and no machine scope.
//!
//! `protect`/`unprotect` refuse an elevated process first, like every other
//! private-storage entry point. Unprotected output is zeroized before the OS
//! buffer is freed.

use std::ffi::c_void;

use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_LOCAL_MACHINE, CRYPTPROTECT_UI_FORBIDDEN,
    CRYPT_INTEGER_BLOB,
};
use zeroize::{Zeroize, Zeroizing};

use crate::private_policy::DPAPI_FLAGS;

const _: () = assert!(DPAPI_FLAGS == CRYPTPROTECT_UI_FORBIDDEN);
const _: () = assert!(DPAPI_FLAGS & CRYPTPROTECT_LOCAL_MACHINE == 0);

/// Largest plaintext accepted, matching the other platform sealers.
pub const MAX_PLAIN: usize = 8192;
/// Largest protected blob accepted.
pub const MAX_PROTECTED: usize = 16384;
const MAX_ENTROPY: usize = 1024;

/// DPAPI output owned by us; optionally wiped, then `LocalFree`d.
struct Output {
    blob: CRYPT_INTEGER_BLOB,
    secret: bool,
}

impl Output {
    fn bytes(&self) -> &[u8] {
        if self.blob.pbData.is_null() {
            return &[];
        }
        // SAFETY: DPAPI returned `cbData` initialised bytes at `pbData`.
        unsafe { std::slice::from_raw_parts(self.blob.pbData, self.blob.cbData as usize) }
    }
}

impl Drop for Output {
    fn drop(&mut self) {
        if self.blob.pbData.is_null() {
            return;
        }
        if self.secret {
            // SAFETY: the buffer is ours until LocalFree below.
            unsafe { std::slice::from_raw_parts_mut(self.blob.pbData, self.blob.cbData as usize) }
                .zeroize();
        }
        // SAFETY: DPAPI allocates output with LocalAlloc and hands it to us.
        unsafe { LocalFree(self.blob.pbData as *mut c_void) };
    }
}

fn blob(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
    // DPAPI only reads its input blobs.
    CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    }
}

fn gate() -> Result<(), String> {
    crate::win_private::elevation_gate().map_err(|error| error.to_string())
}

/// Protect `plaintext` for the current user, bound to `entropy`.
pub fn protect(plaintext: &[u8], entropy: &[u8]) -> Result<Vec<u8>, String> {
    gate()?;
    if plaintext.is_empty()
        || plaintext.len() > MAX_PLAIN
        || entropy.is_empty()
        || entropy.len() > MAX_ENTROPY
    {
        return Err("invalid protected storage input".into());
    }
    let input = blob(plaintext);
    let extra = blob(entropy);
    let mut output = Output {
        blob: CRYPT_INTEGER_BLOB::default(),
        secret: false,
    };
    // SAFETY: input blobs borrow live slices; the output blob is ours.
    let ok = unsafe {
        CryptProtectData(
            &input,
            std::ptr::null(),
            &extra,
            std::ptr::null(),
            std::ptr::null(),
            DPAPI_FLAGS,
            &mut output.blob,
        )
    };
    if ok == 0 {
        return Err(format!(
            "Windows protected storage is unavailable ({})",
            std::io::Error::last_os_error()
        ));
    }
    let bytes = output.bytes();
    if bytes.is_empty() || bytes.len() > MAX_PROTECTED {
        return Err("invalid protected storage output length".into());
    }
    Ok(bytes.to_vec())
}

/// Open a blob from [`protect`] with the same `entropy`.
pub fn unprotect(protected: &[u8], entropy: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
    gate()?;
    if protected.is_empty()
        || protected.len() > MAX_PROTECTED
        || entropy.is_empty()
        || entropy.len() > MAX_ENTROPY
    {
        return Err("invalid protected storage input".into());
    }
    let input = blob(protected);
    let extra = blob(entropy);
    let mut output = Output {
        blob: CRYPT_INTEGER_BLOB::default(),
        secret: true,
    };
    // SAFETY: as in `protect`; no description string is requested.
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            &extra,
            std::ptr::null(),
            std::ptr::null(),
            DPAPI_FLAGS,
            &mut output.blob,
        )
    };
    if ok == 0 {
        return Err("this account cannot open the protected data".into());
    }
    let bytes = output.bytes();
    if bytes.is_empty() || bytes.len() > MAX_PLAIN {
        return Err("invalid protected storage output length".into());
    }
    Ok(Zeroizing::new(bytes.to_vec()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn elevated() -> bool {
        crate::win_private::elevation_gate().is_err()
    }

    #[test]
    fn round_trips_and_rejects_wrong_entropy_and_tampering() {
        if elevated() {
            assert!(protect(b"secret", b"entropy").is_err());
            return;
        }
        let sealed = protect(b"secret seed", b"frame-a").unwrap();
        assert!(!sealed.windows(11).any(|w| w == b"secret seed"));
        assert_eq!(
            unprotect(&sealed, b"frame-a").unwrap().as_slice(),
            b"secret seed"
        );
        assert!(unprotect(&sealed, b"frame-b").is_err());
        let mut flipped = sealed.clone();
        let last = flipped.len() - 1;
        flipped[last] ^= 1;
        assert!(unprotect(&flipped, b"frame-a").is_err());
    }

    #[test]
    fn invalid_inputs_are_refused_before_the_os_call() {
        assert!(protect(b"", b"e").is_err());
        assert!(protect(b"x", b"").is_err());
        assert!(protect(&[1; MAX_PLAIN + 1], b"e").is_err());
        assert!(unprotect(&[1; MAX_PROTECTED + 1], b"e").is_err());
        assert!(unprotect(b"not a blob", b"e").is_err());
    }
}
