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

/// The body of one top-level Swift function, from its `func NAME(` line to the
/// first column-0 closing brace, so a marker elsewhere in the file can't satisfy it.
fn swift_fn<'a>(swift: &'a str, name: &str) -> &'a str {
    let start = swift
        .find(&format!("func {name}("))
        .unwrap_or_else(|| panic!("missing func {name}"));
    let end = swift[start..]
        .find("\n}\n")
        .unwrap_or_else(|| panic!("unterminated func {name}"));
    &swift[start..start + end]
}

#[test]
fn remember_key_store_and_read_are_pinned_inside_their_own_functions() {
    let swift = read("native/device_key.swift");
    let key = swift_fn(&swift, "passwordAgreementKey");
    assert!(key.contains("[.privateKeyUsage, .biometryCurrentSet], &error)"));
    assert!(!key.contains("biometryAny"));
    assert!(!key.contains(".userPresence"));
    let store = swift_fn(&swift, "bitsov_home_store");
    assert!(store.contains("return storeItem(destination, \"BitSov\", envelope)"));
    assert!(!store.contains("storeItem(destination, \"BitSov\", plaintext)"));
    let read_fn = swift_fn(&swift, "bitsov_home_read");
    assert!(read_fn.contains("let legacy = readItem(name, \"BitSov\", true, &data)"));
}

/// The body of one top-level Rust function, from `fn NAME(` to the first
/// column-0 closing brace.
fn rust_fn<'a>(source: &'a str, name: &str) -> &'a str {
    let start = source
        .find(&format!("fn {name}("))
        .unwrap_or_else(|| panic!("missing fn {name}"));
    let end = source[start..]
        .find("\n}\n")
        .unwrap_or_else(|| panic!("unterminated fn {name}"));
    &source[start..start + end]
}

#[test]
fn remembered_password_existence_query_never_reads_or_prompts() {
    let swift = read("native/device_key.swift");
    let exists = swift_fn(&swift, "itemExists");
    for marker in [
        "context.interactionNotAllowed = true",
        "query[kSecUseAuthenticationContext] = context",
        "query[kSecUseAuthenticationUI] = kSecUseAuthenticationUIFail",
        "SecItemCopyMatching(query as CFDictionary, nil)",
    ] {
        assert!(exists.contains(marker), "itemExists lost {marker}");
    }
    for forbidden in ["kSecReturnData", "kSecReturnAttributes", "kSecReturnRef", "localizedReason"] {
        assert!(!exists.contains(forbidden), "itemExists must not use {forbidden}");
    }
    let home = swift_fn(&swift, "bitsov_home_exists");
    // Same search order as bitsov_home_read: wrapped item in both stores, then
    // the old biometric DP item only, never legacy plaintext.
    assert!(home.contains("guard passwordNode(name) != nil else { return errBadArgument }"));
    assert!(home.contains("readWithFallback { itemExists(wrappedService(name), \"BitSov\", $0) }"));
    assert!(home.contains("let legacy = itemExists(name, \"BitSov\", true)"));
    for forbidden in ["readItem(", "unwrapPassword", "copyOutput", "LAContext()", "output"] {
        assert!(!home.contains(forbidden), "bitsov_home_exists must not use {forbidden}");
    }

    // No output buffer crosses the FFI boundary.
    let ffi = read("ffi/src/home_keychain.rs");
    assert!(ffi.contains("fn bitsov_home_exists(service: *const std::ffi::c_char) -> i32;"));
    let ffi_exists = rust_fn(&ffi, "exists");
    assert!(!ffi_exists.contains("capacity") && !ffi_exists.contains("Zeroizing"));

    let keychain = read("src/home_keychain.rs");
    let remembered = rust_fn(&keychain, "password_remembered");
    for marker in [
        "service(node, \"seed-password\").ok()?",
        "bitsov_ffi::home_keychain::exists(&name).ok()?",
        "0 => Some(true)",
        "-25300 => Some(false)",
        "_ => None",
        "super::device_key::has_home_item(node, \"seed-password\").ok()",
    ] {
        assert!(remembered.contains(marker), "password_remembered lost {marker}");
    }
    for forbidden in ["read(", "password(", "read_home_item"] {
        assert!(!remembered.contains(forbidden), "password_remembered must not call {forbidden}");
    }

    let unlock = read("src/home_unlock.rs");
    let status = rust_fn(&unlock, "password_remembered");
    assert!(status.contains("home_keychain::password_remembered(&node)"));
    assert!(!status.contains("home_keychain::password("));
    assert!(!status.contains("device_sign"));
    let app = read("src/app.rs");
    assert!(app.contains("home_unlock::password_remembered(state.inner(), status.unlock_state).await"));
}
