//! Exercise the production Rust wrapper against a mock of the native plugin ABI.
//! No hardware, Keychain access, authentication UI, or real key material.
#![cfg(target_os = "macos")]

use bitsov_ffi::device_key::{self as key, DeviceKeyError as Error, Policy};
use std::{cell::RefCell, ffi::{c_char, CStr}};

#[derive(Clone)]
struct Native {
    hardware: i32,
    biometry: i32,
    status: i32,
    public_prefix: u8,
    blob_len: usize,
    signature: Vec<u8>,
    signature_len: usize,
    calls: usize,
    policy: i32,
    input: Vec<u8>,
    message: Vec<u8>,
    reason: String,
    finish: i32,
}

impl Default for Native {
    fn default() -> Self {
        Self {
            hardware: 1, biometry: 0, status: 0, public_prefix: 4, blob_len: 32,
            // DER sequence containing two integer scalars. Synthetic, not a key.
            signature: vec![0x30, 6, 2, 1, 1, 2, 1, 1], signature_len: 8,
            calls: 0, policy: -1, input: vec![], message: vec![],
            reason: String::new(), finish: -1,
        }
    }
}

thread_local! { static NATIVE: RefCell<Native> = RefCell::new(Native::default()); }
fn configure(update: impl FnOnce(&mut Native)) { NATIVE.with(|n| update(&mut n.borrow_mut())); }
fn reset() { configure(|n| *n = Native::default()); }

#[no_mangle]
extern "C" fn bitsov_dk_available() -> i32 { NATIVE.with(|n| n.borrow().hardware) }
#[no_mangle]
extern "C" fn bitsov_dk_biometry() -> i32 { NATIVE.with(|n| n.borrow().biometry) }

#[no_mangle]
unsafe extern "C" fn bitsov_dk_create(policy: i32, blob: *mut u8, capacity: usize,
    length: *mut usize, public: *mut u8) -> i32 {
    NATIVE.with(|n| {
        let mut n = n.borrow_mut();
        n.calls += 1;
        n.policy = policy;
        // SAFETY: production wrapper supplies live buffers of these capacities.
        // Even malformed reported lengths never write beyond the actual buffer.
        unsafe {
            blob.write_bytes(0xA5, n.blob_len.min(capacity));
            *length = n.blob_len;
            public.write_bytes(0, 65);
            *public = n.public_prefix;
        }
        n.status
    })
}

#[no_mangle]
unsafe extern "C" fn bitsov_dk_public(blob: *const u8, length: usize, public: *mut u8) -> i32 {
    NATIVE.with(|n| {
        let mut n = n.borrow_mut();
        n.calls += 1;
        // SAFETY: the wrapper owns the input slice and 65-byte output buffer.
        unsafe {
            n.input = std::slice::from_raw_parts(blob, length).to_vec();
            public.write_bytes(0, 65);
            *public = n.public_prefix;
        }
        n.status
    })
}

#[no_mangle]
unsafe extern "C" fn bitsov_dk_sign(blob: *const u8, blob_len: usize,
    message: *const u8, message_len: usize, reason: *const c_char,
    signature: *mut u8, capacity: usize, length: *mut usize) -> i32 {
    NATIVE.with(|n| {
        let mut n = n.borrow_mut();
        n.calls += 1;
        // SAFETY: all pointers come from the wrapper's live slices/CString.
        unsafe {
            n.input = std::slice::from_raw_parts(blob, blob_len).to_vec();
            n.message = std::slice::from_raw_parts(message, message_len).to_vec();
            n.reason = CStr::from_ptr(reason).to_str().unwrap().into();
            std::ptr::copy_nonoverlapping(n.signature.as_ptr(), signature, n.signature.len().min(capacity));
            *length = n.signature_len;
        }
        n.status
    })
}

#[no_mangle]
unsafe extern "C" fn bitsov_dk_sign_setup(blob: *const u8, blob_len: usize,
    message: *const u8, message_len: usize, reason: *const c_char, finish: i32,
    signature: *mut u8, capacity: usize, length: *mut usize) -> i32 {
    configure(|n| n.finish = finish);
    // SAFETY: same ABI buffers as the ordinary signing mock.
    unsafe { bitsov_dk_sign(blob, blob_len, message, message_len, reason, signature, capacity, length) }
}

#[test]
fn availability_requires_hardware_and_enrolled_biometrics() {
    reset();
    assert!(key::available());
    configure(|n| n.hardware = 0);
    assert!(!key::available());
    assert!(!key::enclave_available());
    configure(|n| { n.hardware = 1; n.biometry = -7; });
    assert!(key::enclave_available());
    assert!(!key::available());
}

#[test]
fn native_roundtrip_preserves_policy_message_and_wire_encodings() {
    reset();
    let (blob, public) = key::create(Policy::Biometry).unwrap();
    assert_eq!(blob.len(), 32);
    assert_eq!(public.len(), 65);
    assert_eq!(public[0], 4);
    assert_eq!(key::public_key(&blob).unwrap(), public);
    let message = b"bitsov-device-register-v2\nnode:test\nclient:test\npublic_key:04ab\nsas_digest:55";
    assert_eq!(key::sign(&blob, message, "Approve device").unwrap(), [0x30, 6, 2, 1, 1, 2, 1, 1]);
    NATIVE.with(|n| {
        let n = n.borrow();
        assert_eq!(n.policy, 1);
        assert!(n.input == blob);
        assert_eq!(n.message, message);
        assert_eq!(n.reason, "Approve device");
    });
    for finish in [false, true] {
        key::sign_setup(&blob, message, "Approve setup", finish).unwrap();
        NATIVE.with(|n| assert_eq!(n.borrow().finish, i32::from(finish)));
    }
}

#[test]
fn native_refusals_never_return_partial_output_or_retry() {
    for (status, expected) in [(-1, Error::Unavailable), (-2, Error::Cancelled),
        (-3, Error::Invalid), (-7, Error::BiometryUnavailable), (-6, Error::Other(-6))] {
        reset();
        configure(|n| n.status = status);
        assert_eq!(key::create(Policy::Biometry).unwrap_err(), expected);
        assert_eq!(key::public_key(&[1]).unwrap_err(), expected);
        assert_eq!(key::sign(&[1], b"message", "Approve").unwrap_err(), expected);
        assert_eq!(key::sign_setup(&[1], b"message", "Approve", false).unwrap_err(), expected);
        NATIVE.with(|n| assert_eq!(n.borrow().calls, 4));
    }
}

#[test]
fn malformed_native_public_keys_and_blob_lengths_are_rejected() {
    for prefix in [0, 2, 3] {
        reset();
        configure(|n| n.public_prefix = prefix);
        assert!(key::create(Policy::Biometry).is_err());
        assert!(key::public_key(&[1]).is_err());
    }
    for length in [0, 4097] {
        reset();
        configure(|n| n.blob_len = length);
        assert!(key::create(Policy::Biometry).is_err());
    }
}

#[test]
fn malformed_native_signatures_are_rejected_in_both_signing_flows() {
    for (prefix, length) in [(0x30, 0), (0x30, 73), (0x30, 129), (0x04, 64)] {
        reset();
        configure(|n| { n.signature[0] = prefix; n.signature_len = length; });
        assert!(key::sign(&[1], b"message", "Approve").is_err());
        assert!(key::sign_setup(&[1], b"message", "Approve", true).is_err());
    }
}

#[test]
fn maximum_length_p256_der_signature_is_accepted_in_both_flows() {
    reset();
    // Each 32-byte scalar needs a leading zero to keep the ASN.1 INTEGER positive.
    let mut signature = vec![0x30, 70, 2, 33, 0, 0x80];
    signature.extend_from_slice(&[0; 31]);
    signature.extend_from_slice(&[2, 33, 0, 0x80]);
    signature.extend_from_slice(&[0; 31]);
    assert_eq!(signature.len(), 72);
    configure(|n| { n.signature = signature.clone(); n.signature_len = 72; });
    assert_eq!(key::sign(&[1], b"message", "Approve").unwrap(), signature);
    assert_eq!(key::sign_setup(&[1], b"message", "Approve", true).unwrap(), signature);
}

#[test]
fn invalid_inputs_never_reach_native_signing() {
    reset();
    for blob in [vec![], vec![1; 4097]] {
        assert_eq!(key::public_key(&blob), Err(Error::Invalid));
        assert_eq!(key::sign(&blob, b"m", "Approve"), Err(Error::Invalid));
        assert_eq!(key::sign_setup(&blob, b"m", "Approve", false), Err(Error::Invalid));
    }
    assert!(key::sign(&[1], b"m", "bad\0reason").is_err());
    assert!(key::sign_setup(&[1], b"m", "bad\0reason", false).is_err());
    NATIVE.with(|n| assert_eq!(n.borrow().calls, 0));
}
