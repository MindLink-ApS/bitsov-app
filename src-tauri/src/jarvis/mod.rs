//! Phase 1 read broker.
//!
//! The assistant is an untrusted client and never talks to the node. This module
//! is not invoked by any Tauri command and is not exposed to the renderer.
#![forbid(unsafe_code)]

pub mod broker;

/// Mock-only SIT reader over the 50-question fixture. Compiles for `cargo test`
/// and for `cargo run --example jarvis_sit_mock --features sit-mock`. The default
/// app binary does not link `mock-node`.
#[cfg(any(test, feature = "sit-mock"))]
pub mod sit_mock;
