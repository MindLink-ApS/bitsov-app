//! Phase 1 read broker.
//!
//! The assistant is an untrusted client and never talks to the node. This module
//! is not invoked by any Tauri command and is not exposed to the renderer.
#![forbid(unsafe_code)]

pub mod broker;
