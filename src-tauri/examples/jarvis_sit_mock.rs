//! Mock-only SIT reader over the Jarvis 50-question fixture.
//!
//! Drives the in-process mock broker. No network, no node sidecar, no wallet,
//! no Tauri window.
//!
//! ```text
//! cargo run --example jarvis_sit_mock --features sit-mock
//! ```

fn main() {
    bitsov_app::jarvis::sit_mock::run();
}
