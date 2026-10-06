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
pub mod ai;
pub mod spend_journal;
pub mod control;
pub mod jarvis;
pub mod at_rest;
pub mod pairing;
pub mod remote_access;

pub mod connection_retry;

pub mod home_node;

mod app;

/// Start the desktop shell or mobile client.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    app::entry();
}
