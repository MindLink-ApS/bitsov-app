use std::{collections::BTreeSet, fs, path::PathBuf};

fn project_file(path: &str) -> String {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    fs::read_to_string(root.join(path)).unwrap_or_else(|error| panic!("{path}: {error}"))
}

#[test]
fn android_device_keys_are_hardware_backed_p256_and_biometric_per_signature() {
    let source =
        project_file("gen/android/app/src/main/java/tech/mindlink/bitsov/DeviceKeyPlugin.kt");

    for required in [
        "AndroidKeyStore",
        "ECGenParameterSpec(\"secp256r1\")",
        "setUserAuthenticationRequired(true)",
        "setUserAuthenticationParameters(",
        "KeyProperties.AUTH_BIOMETRIC_STRONG",
        "setInvalidatedByBiometricEnrollment(true)",
        "setIsStrongBoxBacked(true)",
        "SECURITY_LEVEL_STRONGBOX",
        "SECURITY_LEVEL_TRUSTED_ENVIRONMENT",
        "isInsideSecureHardware",
        "BiometricPrompt.CryptoObject",
        "SHA256withECDSA",
    ] {
        assert!(
            source.contains(required),
            "missing Android key invariant: {required}"
        );
    }
    assert!(
        !source.contains(".encoded"),
        "the Android private key must never be exported"
    );
}

#[test]
fn android_home_password_is_hardware_encrypted_and_biometric_bound() {
    let source =
        project_file("gen/android/app/src/main/java/tech/mindlink/bitsov/DeviceKeyPlugin.kt");
    for required in [
        "HOME_KEY_ALIAS_PREFIX",
        "KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT",
        "KeyProperties.BLOCK_MODE_GCM",
        "KeyProperties.ENCRYPTION_PADDING_NONE",
        "setUserAuthenticationRequired(true)",
        "setInvalidatedByBiometricEnrollment(true)",
        "KeyProperties.AUTH_BIOMETRIC_STRONG",
        "BiometricPrompt.CryptoObject(cipher)",
        "cipher.updateAAD(item.toByteArray(Charsets.UTF_8))",
        "args.secret != (args.suffix == \"seed-password\")",
        "args.suffix != \"seed-password\"",
        "verifiedDeviceKey(deviceAlias)",
        "fun storeHomeItem",
        "fun readHomeItem",
    ] {
        assert!(
            source.contains(required),
            "missing Android home-unlock storage invariant: {required}"
        );
    }
    for forbidden in ["android.util.Log", "Log.", "println(", "printStackTrace"] {
        assert!(
            !source.contains(forbidden),
            "home unlock secrets must never reach Android logs: {forbidden}"
        );
    }
}

#[test]
fn android_home_unlock_reuses_shared_flow_and_has_no_password_ipc() {
    let keychain = project_file("src/home_keychain.rs");
    let unlock = project_file("src/home_unlock.rs");
    let app = project_file("src/app.rs");

    assert!(keychain.contains("#[cfg(target_os = \"android\")]"));
    assert!(keychain.contains("store_home_item"));
    assert!(keychain.contains("read_home_item"));
    assert!(unlock.contains("LockedConnection::connect"));
    assert!(unlock.contains("challenge.message"));
    assert!(unlock.contains("home_keychain::password(&node, Some(&blob))"));
    assert!(
        !app.contains("seed_password: String"),
        "a seed password must not be accepted from renderer IPC"
    );
}

#[test]
fn android_manifest_adds_only_camera_and_biometric_permissions() {
    let manifest = project_file("gen/android/app/src/main/AndroidManifest.xml");
    assert!(
        manifest.contains("android:allowBackup=\"false\""),
        "device-bound home-node records must not enter Android backup"
    );
    let declared: BTreeSet<_> = manifest
        .lines()
        .filter(|line| line.contains("<uses-permission "))
        .filter_map(|line| line.split("android:name=\"").nth(1))
        .filter_map(|tail| tail.split('"').next())
        .collect();

    assert_eq!(
        declared,
        BTreeSet::from([
            "android.permission.ACCESS_NETWORK_STATE",
            "android.permission.CAMERA",
            "android.permission.INTERNET",
            "android.permission.USE_BIOMETRIC",
            "android.permission.VIBRATE",
        ])
    );
    for removed in [
        "android.permission.ACCESS_NETWORK_STATE",
        "android.permission.VIBRATE",
    ] {
        assert!(
            manifest.contains(&format!("android:name=\"{removed}\" tools:node=\"remove\"")),
            "remove the scanner dependency's unused {removed} permission during manifest merge"
        );
    }
}

#[test]
fn android_plugins_are_registered_without_enabling_them_on_desktop() {
    let app = project_file("src/app.rs");
    let cargo = project_file("Cargo.toml");
    let mobile_capability = project_file("mobile-capabilities/default.json");

    assert!(app.contains("#[cfg(target_os = \"android\")]"));
    assert!(app.contains(".plugin(device_key::init())"));
    assert!(app.contains(".plugin(tauri_plugin_barcode_scanner::init())"));
    assert!(cargo.contains("tauri-plugin-barcode-scanner"));
    assert!(mobile_capability.contains("\"barcode-scanner:allow-scan\""));
    assert!(mobile_capability.contains("\"barcode-scanner:allow-check-permissions\""));
    assert!(mobile_capability.contains("\"barcode-scanner:allow-request-permissions\""));
}
