//! Execute the Swift error policy without hardware access or an app runtime.
#[test]
#[cfg(target_os = "macos")]
fn pairing_errors_distinguish_invalid_envelopes_from_temporary_failures_without_ui() {
    use std::{fs, path::Path, process::Command};
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("pairing_errors.swift");
    let binary = dir.path().join("pairing_errors");
    fs::write(
        &source,
        format!(
            "{}\n{}\n{}",
            fs::read_to_string(root.join("native/device_key.swift")).unwrap(),
            fs::read_to_string(root.join("native/client_keychain.swift")).unwrap(),
            fs::read_to_string(root.join("native/pairing_error_tests.swift")).unwrap()
        ),
    )
    .unwrap();
    let compiled = Command::new("xcrun")
        .args([
            "swiftc",
            "-parse-as-library",
            "-swift-version",
            "5",
            "-module-cache-path",
        ])
        .arg(dir.path().join("module-cache"))
        .arg(&source)
        .arg("-o")
        .arg(&binary)
        .output()
        .unwrap();
    assert!(
        compiled.status.success(),
        "{}",
        String::from_utf8_lossy(&compiled.stderr)
    );
    let result = Command::new(binary).output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}
