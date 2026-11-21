//! Safe wrappers around the desktop native interfaces used by `bitsov-app`.

#![deny(unsafe_op_in_unsafe_fn)]

pub mod device_key;
/// Owner-only storage rules shared by the Windows private-file layer.
pub mod private_policy;
/// Verified-handle private files on Windows (protected descriptors, no inheritance).
#[cfg(windows)]
pub mod win_private;
/// Current-user DPAPI for the Windows at-rest sealer.
#[cfg(windows)]
pub mod dpapi;

/// Platform-neutral so every target can classify the Apple bridge's result.
pub mod keychain_status {
    /// The Swift bridge's status when the device has no passcode: user-presence
    /// Keychain items (and Face ID / Touch ID) are then unavailable.
    pub const PASSCODE_NOT_SET: i32 = -77_001;
    /// Fixed host text for that state; the app maps it to its own error kind.
    pub const PASSCODE_REQUIRED: &str = "This device has no passcode, so Face ID and protected storage are off. Turn on a passcode in Settings, then try again.";
}
#[cfg(any(target_os = "ios", all(target_os = "macos", not(feature = "mobile"))))]
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

/// Latency-critical activity while a call is live. The Swift bridge is built
/// only on a macOS desktop build.
#[cfg(all(target_os = "macos", not(feature = "mobile")))]
pub mod call_activity;
