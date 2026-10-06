//! Safe wrapper for the legacy launcher-password Keychain item.

use std::ffi::c_void;
use zeroize::{Zeroize, Zeroizing};

const SERVICE: &[u8] = b"tech.mindlink.bitsov.local-owner.seed-password.v1";

#[link(name = "Security", kind = "framework")]
unsafe extern "C" {
    fn SecKeychainFindGenericPassword(
        keychain: *const c_void,
        service_len: u32,
        service: *const u8,
        account_len: u32,
        account: *const u8,
        len: *mut u32,
        data: *mut *mut c_void,
        item: *mut *mut c_void,
    ) -> i32;
    fn SecKeychainAddGenericPassword(
        keychain: *const c_void,
        service_len: u32,
        service: *const u8,
        account_len: u32,
        account: *const u8,
        len: u32,
        data: *const u8,
        item: *mut *mut c_void,
    ) -> i32;
    fn SecKeychainItemDelete(item: *const c_void) -> i32;
    fn CFRelease(item: *const c_void);
    fn SecKeychainItemFreeContent(attrs: *mut c_void, data: *mut c_void) -> i32;
}

pub fn read(account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
    let mut len = 0;
    let mut ptr = std::ptr::null_mut();
    // SAFETY: all input slices outlive the synchronous call. `len` and `ptr`
    // are valid out-pointers, and no item handle is requested.
    let status = unsafe {
        SecKeychainFindGenericPassword(
            std::ptr::null(),
            SERVICE.len() as u32,
            SERVICE.as_ptr(),
            account.len() as u32,
            account.as_ptr(),
            &mut len,
            &mut ptr,
            std::ptr::null_mut(),
        )
    };
    if status == -25300 {
        return Ok(None);
    }
    if status != 0 {
        return Err(format!(
            "Keychain refused access to this app's seed password ({status})."
        ));
    }
    let password = if ptr.is_null() || len != 44 {
        None
    } else {
        // SAFETY: Security returned a readable `len`-byte allocation on success.
        Some(Zeroizing::new(
            unsafe { std::slice::from_raw_parts(ptr.cast::<u8>(), len as usize) }.to_vec(),
        ))
    };
    if !ptr.is_null() {
        // SAFETY: the allocation is writable for its reported length and must
        // be released exactly once with SecKeychainItemFreeContent.
        unsafe {
            std::slice::from_raw_parts_mut(ptr.cast::<u8>(), len as usize).zeroize();
            SecKeychainItemFreeContent(std::ptr::null_mut(), ptr);
        }
    }
    password
        .map(Some)
        .ok_or_else(|| "This app's Keychain seed password is invalid; it was not replaced.".into())
}

pub fn remove(account: &str) -> Result<(), String> {
    let mut item = std::ptr::null_mut();
    // SAFETY: all input slices outlive the synchronous exact-item query and
    // `item` is a valid out-pointer.
    let status = unsafe {
        SecKeychainFindGenericPassword(
            std::ptr::null(),
            SERVICE.len() as u32,
            SERVICE.as_ptr(),
            account.len() as u32,
            account.as_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut item,
        )
    };
    if status == -25300 {
        return Ok(());
    }
    if status != 0 || item.is_null() {
        return Err("Cannot retire the legacy launcher password.".into());
    }
    // SAFETY: the query returned one owned item reference. Delete it, then
    // release that reference exactly once.
    let status = unsafe {
        let status = SecKeychainItemDelete(item);
        CFRelease(item);
        status
    };
    if status == 0 {
        Ok(())
    } else {
        Err("Cannot retire the legacy launcher password.".into())
    }
}

pub fn add(account: &str, password: &[u8]) -> Result<(), String> {
    // SAFETY: the account and password slices outlive the synchronous call.
    // No item handle is requested and Security copies the inputs.
    let status = unsafe {
        SecKeychainAddGenericPassword(
            std::ptr::null(),
            SERVICE.len() as u32,
            SERVICE.as_ptr(),
            account.len() as u32,
            account.as_ptr(),
            password.len() as u32,
            password.as_ptr(),
            std::ptr::null_mut(),
        )
    };
    if status == 0 {
        Ok(())
    } else {
        Err(format!(
            "Keychain could not store this app's seed password ({status}); the node was not started."
        ))
    }
}
