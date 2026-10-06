//! Safe wrappers around the desktop native interfaces used by `bitsov-app`.

#![deny(unsafe_op_in_unsafe_fn)]

pub mod device_key;
#[cfg(target_os = "macos")]
pub mod home_keychain;
#[cfg(target_os = "macos")]
pub mod model_launch;
#[cfg(target_os = "macos")]
pub mod owner_password;

#[cfg(unix)]
pub fn effective_uid() -> u32 {
    // SAFETY: getuid takes no arguments and has no failure case.
    unsafe { libc::getuid() as u32 }
}
