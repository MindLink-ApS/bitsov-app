//! Execute the Swift production lifecycle with an injected audio driver, and
//! parse both shipping plists. No device, microphone, or signing required.
#[cfg(target_os = "macos")]
#[test]
fn ios_call_audio_lifecycle_and_background_plists() {
    let output = std::process::Command::new("bash")
        .arg("scripts/test-ios-call-audio.sh")
        .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()
        .expect("run host Swift audio tests");
    assert!(output.status.success(), "{}\n{}",
        String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
}
