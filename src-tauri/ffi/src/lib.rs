//! Safe wrappers around the desktop native interfaces used by `bitsov-app`.

#![deny(unsafe_op_in_unsafe_fn)]

pub mod device_key;
#[cfg(target_os = "ios")]
pub mod client_keychain;
#[cfg(target_os = "ios")]
pub mod pairing_link;
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub mod home_keychain;
#[cfg(target_os = "macos")]
pub mod model_launch;
#[cfg(target_os = "macos")]
pub mod owner_password;
#[cfg(any(target_os = "ios", all(target_os = "macos", not(feature = "mobile"))))]
pub mod pairing_sealer;

#[cfg(unix)]
pub fn effective_uid() -> u32 {
    // SAFETY: getuid takes no arguments and has no failure case.
    unsafe { libc::getuid() as u32 }
}

#[cfg(target_os = "ios")]
pub mod phone_recovery;

#[cfg(target_os = "ios")]
pub mod call_audio;
