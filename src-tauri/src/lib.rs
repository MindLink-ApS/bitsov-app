//! Library surface and Tauri entry point for the BitSov app.

#![forbid(unsafe_code)]

// Keep existing absolute paths (`bitsov_app::…`) valid now that the former
// binary implementation is compiled as part of this library.
extern crate self as bitsov_app;

pub mod act;
pub mod format;
pub mod budget;
pub mod grant;
pub mod introduction;
pub mod front_door;
pub mod porch;
pub mod sponsor;
pub mod starter;
pub mod ai;
pub mod spend_journal;
pub mod control;
pub mod jarvis;
pub mod at_rest;
#[cfg(any(target_os = "ios", all(target_os = "macos", not(feature = "mobile")), all(test, unix)))]
mod apple_key_material;
pub mod pairing;
mod trust;
mod profile;
#[cfg(any(target_os = "ios", all(test, unix)))]
mod ios_install;
pub mod remote_access;
pub mod sas;
pub mod delegation;
pub mod second_device;

pub mod connection_retry;

pub mod home_node;

mod app;
mod phone_recovery;

#[cfg(any(target_os = "android", test))]
mod android_network;

#[cfg(target_os = "android")]
mod pairing_link_mobile;

#[cfg(any(target_os = "ios", test))]
mod pairing_link_ios;

/// Start the desktop shell or mobile client.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    app::entry();
}

/// Headless packaging check; call before initializing the application runtime.
#[cfg(all(target_os = "macos", not(feature = "mobile")))]
pub fn mac_keychain_smoke_test() -> Result<&'static str, String> {
    bitsov_ffi::client_keychain::smoke_test()
}
