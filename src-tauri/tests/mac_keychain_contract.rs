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

fn setup_signing_contract(swift: &str) {
    let setup = swift_fn(swift, "bitsov_dk_sign_setup");
    for marker in [
        "finish == 0 || finish == 1",
        "[\"node:\", \"client:\", \"public_key:\", \"sas_digest:\"]",
        "[\"node:\", \"client:\", \"epoch:\", \"key:\", \"challenge:\", \"box_transport:\"]",
        "finish == 0 ? \"bitsov-device-register-v2\" : \"bitsov-node-unlock-v1\"",
        "guard fields.count == names.count + 1, fields[0] == domain,",
        "zip(fields.dropFirst(), names).allSatisfy({ $0.0.hasPrefix($0.1) && $0.0.count > $0.1.count }) else { return errBadArgument }",
        "setupApprovalLock.lock()\n        let previous = setupApproval\n        setupApproval = nil\n        setupApprovalLock.unlock()",
        "if finish == 1 {\n            guard let prior = previous else { return errCancelled }",
        "guard prior.blob == blobData, prior.node == fields[1], prior.client == fields[2],",
        "ProcessInfo.processInfo.systemUptime < prior.deadline else {\n                prior.context.invalidate()\n                return errCancelled",
        "context = prior.context",
        "context.interactionNotAllowed = true",
        "previous?.context.invalidate()",
        "context = Unmanaged<LAContext>.fromOpaque(handle).takeUnretainedValue()",
        "signMessage(blob, blobLen, msg, msgLen, reason, outSig, sigCap, outSigLen, context)",
        "if finish == 0 && status == okStatus {",
        "setupApproval = SetupApproval(blob: blobData, node: fields[1], client: fields[2],",
        "context: context, deadline: ProcessInfo.processInfo.systemUptime + 120)",
        "} else { context.invalidate() }",
    ] {
        assert!(setup.contains(marker), "setup signing lost {marker}");
    }
    assert_eq!(setup.matches("setupApproval = SetupApproval(").count(), 1);
    let sign = swift_fn(swift, "signMessage");
    assert!(sign.contains("_ context: LAContext = LAContext()"));
    assert!(sign.contains("dataRepresentation: blobData, authenticationContext: context"));
    let ordinary = swift_fn(swift, "bitsov_dk_sign");
    assert!(ordinary.contains("signMessage(blob, blobLen, msg, msgLen, reason, outSig, sigCap, outSigLen)"));
    assert!(!ordinary.contains("setupApproval"));
    let create = swift_fn(swift, "createKey");
    assert!(create.contains("case 1: flags = [.privateKeyUsage, .biometryCurrentSet]"));
    assert!(create.contains("nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, flags, &cfError"));
    assert!(create.contains("SecureEnclave.P256.Signing.PrivateKey(accessControl: access)"));
    assert!(!create.contains(".biometryAny"));
    assert!(!create.contains(".userPresence"));
}

#[test]
fn setup_signing_is_bound_biometric_expiring_and_single_use() {
    setup_signing_contract(&read("native/device_key.swift"));
}

#[test]
fn setup_signing_pins_detect_security_mutations_in_the_relevant_slice() {
    let swift = read("native/device_key.swift");
    for (function, from, to) in [
        ("bitsov_dk_sign_setup", "setupApproval = nil", "// setupApproval = nil"),
        ("bitsov_dk_sign_setup", "context.interactionNotAllowed = true", "context.interactionNotAllowed = false"),
        ("bitsov_dk_sign_setup", "systemUptime + 120", "systemUptime + 1200"),
        ("bitsov_dk_sign_setup", "prior.blob == blobData, ", ""),
        ("bitsov_dk_sign_setup", "prior.node == fields[1], ", ""),
        ("bitsov_dk_sign_setup", "prior.client == fields[2],", "true,"),
        ("bitsov_dk_sign_setup", "if finish == 0 && status == okStatus", "if status == okStatus"),
        ("bitsov_dk_sign_setup", "fields[0] == domain", "true"),
        ("signMessage", "authenticationContext: context", "authenticationContext: LAContext()"),
        ("createKey", ".biometryCurrentSet", ".biometryAny"),
        ("createKey", "kSecAttrAccessibleWhenUnlockedThisDeviceOnly", "kSecAttrAccessibleAfterFirstUnlock"),
    ] {
        let slice = swift_fn(&swift, function);
        assert!(slice.contains(from));
        let mutated = swift.replacen(slice, &slice.replacen(from, to, 1), 1);
        assert!(std::panic::catch_unwind(|| setup_signing_contract(&mutated)).is_err(),
            "undetected {function} mutation: {from}");
    }
}
