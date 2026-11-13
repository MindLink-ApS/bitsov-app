//! Headless contracts for storage selection and protected signing boundaries.
use std::{fs, path::Path};
fn read(path: &str) -> String {
    fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(path)).unwrap()
}
#[test]
fn mac_storage_selection_checks_runtime_entitlements_before_keychain_migration() {
    let swift = read("native/client_keychain.swift");
    assert!(swift.contains("SecTaskCopyValueForEntitlement"));
    assert!(swift.contains("com.apple.application-identifier"));
    let key = read("src/pairing/key/keychain.rs");
    assert!(key.contains("load_selected(dir, &NativeStore(dir, context), at_rest::installed(),"));
    assert!(key.contains("bitsov_ffi::client_keychain::data_protection_available()"));
}
#[test]
fn polling_uses_only_public_metadata_and_signing_reads_on_blocking_pool() {
    let app = read("src/app.rs");
    let status = app.split("async fn do_device_key_status_local(").nth(1).unwrap().split("\n///").next().unwrap();
    assert!(!status.contains("local_key("));
    assert!(!status.contains("read_blob("));
    assert!(status.contains("local_device_record("));
    let signing = app.split("async fn device_sign(").nth(1).unwrap().split("\n///").next().unwrap();
    assert!(signing.contains("spawn_blocking(move ||"));
    assert!(signing.contains("sign_stored"));
    let swift = read("native/client_keychain.swift");
    let sign = swift.split("public func bitsov_device_blob_sign(").nth(1).unwrap();
    assert!(swift.contains("context: Unmanaged<LAContext>.fromOpaque(handle).takeUnretainedValue()"));
    assert!(sign.contains("signMessage("));
    assert!(sign.contains("sigCap, outSigLen, context)"));
}
#[test]
fn built_bundle_smoke_runs_before_artifact_upload_without_starting_tauri() {
    let workflow = read("../.github/workflows/mac-package.yml");
    let smoke = workflow.find("--keychain-smoke-test").expect("built app smoke test");
    assert!(workflow[..smoke].contains("Package, sign ad-hoc and verify"));
    assert!(workflow[smoke..].contains("actions/upload-artifact"));
    let main = read("src/main.rs");
    assert!(main.find("--keychain-smoke-test").unwrap() < main.find("bitsov_app::run()").unwrap());
}
