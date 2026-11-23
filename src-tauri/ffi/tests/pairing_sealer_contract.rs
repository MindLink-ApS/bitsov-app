//! Exercise the production pairing sealer wrapper against a mock of the native
//! ABI. No hardware, Keychain access, authentication UI, or real key material.
#![cfg(all(target_os = "macos", not(feature = "mobile")))]

use bitsov_ffi::pairing_sealer::{self as sealer, StorageError};
use std::{cell::Cell, ffi::c_char};

thread_local! { static STATUS: Cell<i32> = const { Cell::new(0) }; }

/// Writes a recognizable sentinel and a length even when it refuses, so the
/// tests prove the wrapper never returns bytes from a refused call.
#[no_mangle]
unsafe extern "C" fn bitsov_pairing_crypt(_: i32, _: *const c_char, _: *const u8, _: usize,
    output: *mut u8, capacity: usize, length: *mut usize) -> i32 {
    // SAFETY: the wrapper supplies a live output buffer of `capacity` bytes.
    unsafe {
        output.write_bytes(0xAA, capacity.min(8));
        *length = 8;
    }
    STATUS.get()
}

#[test]
fn pairing_crypt_unavailable_maps_to_typed_error() {
    STATUS.set(-1);
    assert_eq!(sealer::try_seal("client-ed25519-seed-v1", &[7; 32]).unwrap_err(),
        StorageError::SecureStorageUnavailable);
    assert_eq!(sealer::try_open("client-ed25519-seed-v1", b"{}").unwrap_err(),
        StorageError::SecureStorageUnavailable);
    let text = sealer::seal("client-ed25519-seed-v1", &[7; 32]).unwrap_err();
    assert_eq!(text, bitsov_ffi::keychain_status::NO_SECURE_ENCLAVE);
    assert!(!text.contains("try again") && !text.contains("temporarily"), "{text}");
}

#[test]
fn other_native_refusals_keep_their_meaning() {
    STATUS.set(-3);
    let invalid = sealer::try_open("client-ed25519-seed-v1", b"{}").unwrap_err();
    assert!(matches!(&invalid, StorageError::Failed(m) if m.contains("pair again")), "{invalid}");
    STATUS.set(-6);
    let other = sealer::try_seal("client-ed25519-seed-v1", &[7; 32]).unwrap_err();
    assert!(matches!(&other, StorageError::Failed(m) if m.contains("try again")), "{other}");
    STATUS.set(0);
    assert_eq!(sealer::try_seal("client-ed25519-seed-v1", &[7; 32]).unwrap(), [0xAA; 8]);
}
