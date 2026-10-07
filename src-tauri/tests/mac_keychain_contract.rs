//! Source-only contracts. No native calls, application runtime, or windows.
use std::{fs, path::Path};

fn read(path: &str) -> String {
    fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(path)).unwrap()
}

#[test]
fn writes_retry_only_missing_entitlement_and_reads_search_both_stores() {
    let swift = read("native/device_key.swift");
    assert!(swift.contains("status == errSecMissingEntitlement // -34018, and no other write error"));
    assert!(swift.contains("status == errSecItemNotFound || missingEntitlement(status)"));
    assert!(swift.contains("let status = operation(true)"));
    assert!(swift.contains("return missingEntitlement(status) ? operation(false) : status"));
    assert!(swift.contains("kSecAttrAccessibleWhenUnlockedThisDeviceOnly"));
    assert!(swift.contains("kSecUseKeychain"));
    assert!(swift.contains("kSecMatchSearchList"));

}

#[test]
fn remembered_password_is_wrapped_and_never_plaintext_in_legacy_keychain() {
    let swift = read("native/device_key.swift");
    for marker in [
        "SecureEnclave.P256.KeyAgreement.PrivateKey",
        "[.privateKeyUsage, .biometryCurrentSet]",
        "P256.KeyAgreement.PrivateKey()",
        "sharedSecretFromKeyAgreement",
        "hkdfDerivedSymmetricKey",
        "SHA256.self",
        "bitsov.home-seed-password.wrap.v1",
        "AES.GCM.seal",
        "AES.GCM.open",
        "authenticating: Data(node.utf8)",
        "authenticationContext: context",
        "wrapped-v1",
    ] {
        assert!(swift.contains(marker), "missing {marker}");
    }
    assert!(swift.contains("// Old signed builds: biometric DP item only, never legacy plaintext."));
    assert!(swift.contains("if status != errSecItemNotFound { return status }"));
    assert!(swift.contains("defer { plaintext.resetBytes(in: 0..<plaintext.count) }"));
    let unlock = read("src/home_unlock.rs");
    assert!(unlock.contains("*state.home_unlock_state.lock().unwrap() = \"no-password\""));
    assert!(read("ffi/src/home_keychain.rs").contains("Zeroizing::new(vec![0; capacity])"));
}

#[test]
fn launcher_password_uses_the_same_policy_and_preserves_its_item_identity() {
    let owner = read("ffi/src/owner_password.rs");
    assert!(owner.contains("tech.mindlink.bitsov.local-owner.seed-password.v1"));
    assert!(!owner.contains("SecKeychainAddGenericPassword"));
    assert!(!owner.contains("unsafe extern"));
    assert!(owner.contains("home_keychain::add_item(SERVICE, account, password)"));
    assert!(owner.contains("home_keychain::read_item(SERVICE, account, 44)"));
    assert!(owner.contains("home_keychain::delete_items(SERVICE, account)"));
    let swift = read("native/device_key.swift");
    assert!(swift.contains("data, replace: false)"));
    let ffi = read("ffi/src/home_keychain.rs");
    for marker in ["bitsov_item_add", "bitsov_item_read", "bitsov_item_delete", "CString::new(account)?"] {
        assert!(ffi.contains(marker));
    }
}
