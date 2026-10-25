//! Exercise protected reads and signing through the production FFI wrappers.
//! Native refusals are injected without hardware access or authentication UI.
#![cfg(all(target_os = "macos", not(feature = "mobile")))]

use bitsov_ffi::{client_keychain::{self, AuthenticationContext}, device_key::DeviceKeyError};
use std::{cell::Cell, ffi::{c_char, c_void}};

thread_local! { static STATUS: Cell<i32> = const { Cell::new(0) }; }

#[no_mangle]
extern "C" fn bitsov_auth_context_create(_: *const c_char, _: i32) -> *mut c_void {
    std::ptr::NonNull::<u8>::dangling().as_ptr().cast()
}
#[no_mangle]
extern "C" fn bitsov_auth_context_release(_: *mut c_void) {}
#[no_mangle]
extern "C" fn bitsov_device_blob_read(_: *const c_char, _: *mut u8, _: usize,
    _: *mut usize, _: *mut c_void) -> i32 { STATUS.get() }
#[no_mangle]
extern "C" fn bitsov_device_blob_sign(_: *const u8, _: usize, _: *const u8,
    _: *const u8, _: usize, _: *const c_char, _: *mut u8, _: usize,
    _: *mut usize, _: *mut c_void, _: i32) -> i32 { STATUS.get() }

#[test]
fn cancelled_protected_reads_keep_the_cancellation_type() {
    let context = AuthenticationContext::new_for_operation("Test read", false).unwrap();
    for status in [-128, -25293, -2] {
        STATUS.set(status);
        let error = client_keychain::read_blob(std::path::Path::new("/test/app-client"), &context).unwrap_err();
        assert_eq!(error, DeviceKeyError::Cancelled, "status {status}");
    }
}

#[test]
fn cancelled_signatures_keep_the_cancellation_type_in_every_flow() {
    let context = AuthenticationContext::new_for_operation("Test sign", false).unwrap();
    for status in [-128, -25293, -2] {
        STATUS.set(status);
        for setup in [None, Some(false), Some(true)] {
            assert_eq!(context.sign(&[1], &[4; 65], b"message", "Test sign", setup),
                Err(DeviceKeyError::Cancelled), "status {status}");
        }
    }
}
