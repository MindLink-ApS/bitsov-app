//! Text-only safety contracts: never launch Tauri, a node, or Keychain UI.
use std::{fs, path::Path};
fn read(path: &str) -> String {
    fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(path)).unwrap()
}
fn ordered(source: &str, markers: &[&str]) {
    let mut tail = source;
    for marker in markers {
        tail = &tail[tail.find(marker).unwrap_or_else(|| panic!("missing {marker}")) + marker.len()..];
    }
}
#[test]
fn mac_remember_requires_204_then_opt_in_and_preserves_biometric_wrapping() {
    let unlock = read("src/home_unlock.rs");
    let shared = unlock.split("async fn unlock_with(").nth(1).unwrap();
    ordered(shared, &["connection.unlock(&body).await", "result.map_err(|e| e.to_string())?", "Some(RememberOffer {"]);
    assert!(!shared.contains("save_password("));
    let remember = unlock.split("pub async fn remember(").nth(1).unwrap().split("async fn unlock_with(").next().unwrap();
    ordered(remember, &[".take()", "if !remember", "REMEMBER_WINDOW", "Some(offer.node.as_str())", "if !record.registered", "home_keychain::save_password(&offer.node, offer.password.as_bytes())"]);
    let transport = read("src/remote_access.rs");
    assert!(transport.contains("unlock_status(status, 204)"));
    let swift = read("native/device_key.swift");
    let store = swift.split("public func bitsov_home_store").nth(1).unwrap().split("public func bitsov_home_read").next().unwrap();
    ordered(store, &["if secret == 1", "wrapPassword", "wrappedService(name)", "storeItem"]);
}
#[test]
fn unlock_commands_are_write_only_and_capability_is_host_reported() {
    let app = read("src/app.rs");
    for name in ["node_unlock_password", "node_unlock_remember"] {
        for tail in app.split(&format!("async fn {name}(" )).skip(1) {
            let signature = tail.split('{').next().unwrap();
            assert!(signature.contains("Result<(), String>"));
        }
    }
    let handlers = app.split("generate_handler![").nth(1).unwrap().split(']').next().unwrap();
    for line in handlers.lines().map(str::trim).filter(|l| l.contains("password")) {
        assert_eq!(line, "node_unlock_password,");
    }
    assert!(app.contains("typed_unlock_supported: bool"));
    assert!(read("src/home_unlock.rs").contains("password: zeroize::Zeroizing<String>"));
    assert!(!handlers.contains("device_key_delegate"));
}

#[test]
fn remember_rechecks_expiry_after_waiting_for_a_blocking_worker() {
    let unlock = read("src/home_unlock.rs");
    let remember = unlock.split("pub async fn remember(").nth(1).unwrap().split("pub fn remember_available(").next().unwrap();
    ordered(remember, &["spawn_blocking(move ||", "offer.offered.elapsed() >= REMEMBER_WINDOW", "home_keychain::save_password("]);
}

#[test]
fn authenticated_recovery_resets_locked_view_and_invalid_signing_keys_require_setup() {
    let app = read("src/app.rs");
    let auth = app.split("async fn finish_auth(").nth(1).unwrap().split("\nasync fn ").next().unwrap();
    ordered(auth, &["home_unlock::remember_binding", "home_unlock_state.lock().unwrap() = \"ready\"", "home_locked.store(false"]);
    let unlock = read("src/home_unlock.rs");
    ordered(&unlock, &["let signature =", "forget_invalid_signing_key(&ctx.store, &e)", "home_unlock_state.lock().unwrap() = \"not-enrolled\""]);
}
