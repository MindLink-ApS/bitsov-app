//! Phase 1 read broker, and the Seatbelt profile for the local model.
//!
//! The assistant is an untrusted client and never talks to the node. This module
//! is not invoked by any Tauri command and is not exposed to the renderer.
//! The macOS spawn path lives in the app binary's `model_launch` module:
//! `posix_spawn` is unsafe, and this module forbids unsafe code.
#![forbid(unsafe_code)]

pub mod assistant_source;
pub mod broker;
pub mod sandbox;

/// Mock-only SIT reader over the 50-question fixture. Compiles for `cargo test`
/// and for `cargo run --example jarvis_sit_mock --features sit-mock`. The default
/// app binary does not link `mock-node`.
#[cfg(any(test, feature = "sit-mock"))]
pub mod sit_mock;

/// Host-side live-or-mock choice for the assistant window's rows. Needs the
/// fixture answering in `sit_mock`, so it has the same gate.
#[cfg(any(test, feature = "sit-mock"))]
pub mod assistant_feed;
