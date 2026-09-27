//! Library surface for the BitSov app crate.
//!
//! The desktop binary lives in `main.rs`. Phase 1 Jarvis code is compiled here
//! so a mock-only example can drive the broker without opening a Tauri window.

#![forbid(unsafe_code)]

pub mod act;
pub mod ai;
pub mod spend_journal;
pub mod control;
pub mod jarvis;
pub mod pairing;
