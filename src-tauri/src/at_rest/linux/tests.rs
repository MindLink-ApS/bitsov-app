use super::*;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct MemoryKeyring {
    key: Mutex<Option<Zeroizing<Vec<u8>>>>,
    failure: Mutex<Option<ProviderError>>,
}

impl Keyring for Arc<MemoryKeyring> {
    fn key(&self, create: bool) -> Result<Zeroizing<Vec<u8>>, ProviderError> {
        if let Some(error) = *self.failure.lock().unwrap() { return Err(error); }
        let mut key = self.key.lock().unwrap();
        if key.is_none() && create { *key = Some(Zeroizing::new(vec![29; 32])); }
        key.clone().ok_or(ProviderError::Unavailable)
    }
}

fn fixture() -> (LinuxSealer, Arc<MemoryKeyring>) {
    let backend = Arc::new(MemoryKeyring::default());
    let key_id = *blake3::hash(&backend.key(true).unwrap()).as_bytes();
    (LinuxSealer { backend: Box::new(backend.clone()), profile: "test.profile".into(), key_id }, backend)
}

#[test]
fn envelopes_reopen_after_a_new_provider_instance() {
    let (sealer, backend) = fixture();
    let sealed = sealer.seal("identity", &[23; 32]).unwrap();
    assert!(!sealed.windows(32).any(|part| part == [23; 32]));
    let restarted = LinuxSealer { backend: Box::new(backend), profile: "test.profile".into(), key_id: sealer.key_id };
    assert_eq!(restarted.open("identity", &sealed).unwrap().as_slice(), &[23; 32]);
    assert!(!restarted.allows_plaintext_fallback());
}

#[test]
fn unavailable_locked_and_failed_providers_refuse_seal_and_open() {
    let (sealer, backend) = fixture();
    let sealed = sealer.seal("identity", &[23; 32]).unwrap();
    let original = backend.key.lock().unwrap().clone();
    for (state, message) in [
        (ProviderError::Unavailable, "unavailable"),
        (ProviderError::Locked, "locked"),
        (ProviderError::Failed, "failed"),
    ] {
        *backend.failure.lock().unwrap() = Some(state);
        assert!(sealer.seal("identity", &[24; 32]).unwrap_err().contains(message));
        assert!(sealer.open("identity", &sealed).unwrap_err().contains(message));
        assert_eq!(*backend.key.lock().unwrap(), original);
        assert!(!sealer.allows_plaintext_fallback());
    }
}

#[test]
fn purpose_and_profile_are_authenticated_independently() {
    let (mut sealer, _) = fixture();
    let sealed = sealer.seal("identity", &[23; 32]).unwrap();
    assert!(sealer.open("code", &sealed).is_err());
    sealer.profile = "other.profile".into();
    assert!(sealer.open("identity", &sealed).is_err());
}

#[test]
fn every_truncation_and_tampered_byte_refuses() {
    let (sealer, _) = fixture();
    let sealed = sealer.seal("identity", &[23; 32]).unwrap();
    for length in 0..sealed.len() { assert!(sealer.open("identity", &sealed[..length]).is_err()); }
    for index in 0..sealed.len() {
        let mut changed = sealed.clone();
        changed[index] ^= 1;
        assert!(sealer.open("identity", &changed).is_err(), "offset {index}");
    }
    let mut trailing = sealed;
    trailing.push(0);
    assert!(sealer.open("identity", &trailing).is_err());
}

#[test]
fn missing_or_changed_wrapping_item_never_creates_a_replacement() {
    let (sealer, backend) = fixture();
    let sealed = sealer.seal("identity", &[23; 32]).unwrap();
    *backend.key.lock().unwrap() = None;
    assert!(sealer.open("identity", &sealed).is_err());
    assert!(backend.key.lock().unwrap().is_none());
    *backend.key.lock().unwrap() = Some(Zeroizing::new(vec![31; 32]));
    assert!(sealer.open("identity", &sealed).is_err());
    assert_eq!(backend.key.lock().unwrap().as_ref().unwrap().as_slice(), &[31; 32]);
}

#[test]
fn bounded_envelopes_and_invalid_key_lengths_refuse() {
    let (sealer, backend) = fixture();
    *backend.key.lock().unwrap() = None;
    assert!(sealer.seal("identity", &[0; 8193]).is_err());
    assert!(backend.key.lock().unwrap().is_none());
    for length in [0, 31, 33] {
        *backend.key.lock().unwrap() = Some(Zeroizing::new(vec![1; length]));
        assert!(sealer.seal("identity", &[23; 32]).is_err());
    }
    assert!(sealer.open("identity", &[0; 8300]).is_err());
}

#[test]
fn repeated_publication_attempts_reuse_the_wrapping_item() {
    let (sealer, backend) = fixture();
    let first = sealer.seal("identity", &[23; 32]).unwrap();
    let retained = backend.key.lock().unwrap().clone();
    for _ in 0..16 {
        let abandoned = sealer.seal("identity", &[24; 32]).unwrap();
        assert_ne!(abandoned, first);
        assert_eq!(*backend.key.lock().unwrap(), retained);
    }
    assert_eq!(sealer.open("identity", &first).unwrap().as_slice(), &[23; 32]);
}

#[test]
fn failed_provider_preserves_legacy_and_existing_protected_identity() {
    use crate::pairing::key::{ClientKey, KEY_FILE, SEALED_KEY_FILE};
    use std::io::Write;
    let (sealer, backend) = fixture();
    let dir = tempfile::tempdir().unwrap();
    let plain = dir.path().join(KEY_FILE);
    crate::pairing::key::create_new_protected(&plain).unwrap()
        .write_all("17".repeat(32).as_bytes()).unwrap();
    let legacy = std::fs::read(&plain).unwrap();
    *backend.failure.lock().unwrap() = Some(ProviderError::Locked);
    assert!(ClientKey::load_linux_candidate(dir.path(), Some(&sealer)).is_err());
    assert_eq!(std::fs::read(&plain).unwrap(), legacy);
    assert!(!dir.path().join(SEALED_KEY_FILE).exists());
    *backend.failure.lock().unwrap() = None;
    let identity = ClientKey::load_linux_candidate(dir.path(), Some(&sealer)).unwrap();
    assert!(!plain.exists());
    let protected = std::fs::read(dir.path().join(SEALED_KEY_FILE)).unwrap();
    *backend.failure.lock().unwrap() = Some(ProviderError::Unavailable);
    assert!(ClientKey::load_linux_candidate(dir.path(), Some(&sealer)).is_err());
    assert_eq!(std::fs::read(dir.path().join(SEALED_KEY_FILE)).unwrap(), protected);
    assert!(!plain.exists());
    *backend.failure.lock().unwrap() = None;
    let reopened = ClientKey::load_linux_candidate(dir.path(), Some(&sealer)).unwrap();
    assert_eq!(reopened.public_hex(), identity.public_hex());
}

#[test]
fn failed_verification_never_discards_the_legacy_identity() {
    use crate::pairing::key::{ClientKey, KEY_FILE, SEALED_KEY_FILE};
    use std::io::Write;
    struct OpenFailure;
    impl Sealer for OpenFailure {
        fn seal(&self, _: &str, _: &[u8]) -> Result<Vec<u8>, String> { Ok(vec![7; 64]) }
        fn open(&self, _: &str, _: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> { Err("open failed".into()) }
    }
    let dir = tempfile::tempdir().unwrap();
    let plain = dir.path().join(KEY_FILE);
    crate::pairing::key::create_new_protected(&plain).unwrap()
        .write_all("17".repeat(32).as_bytes()).unwrap();
    let original = std::fs::read(&plain).unwrap();
    assert!(ClientKey::load_linux_candidate(dir.path(), Some(&OpenFailure)).is_err());
    assert_eq!(std::fs::read(&plain).unwrap(), original);
    assert!(!dir.path().join(SEALED_KEY_FILE).exists());
}

#[test]
fn absent_provider_refuses_before_creating_a_store() {
    use crate::pairing::key::ClientKey;
    let dir = tempfile::tempdir().unwrap();
    let fresh = dir.path().join("fresh");
    assert!(ClientKey::load_linux_candidate(&fresh, None).is_err());
    assert!(!fresh.exists());
}

#[test]
fn permissive_provider_cannot_allow_candidate_plaintext_fallback() {
    use crate::pairing::key::{ClientKey, KEY_FILE, SEALED_KEY_FILE};
    struct PermissiveFailure;
    impl Sealer for PermissiveFailure {
        fn seal(&self, _: &str, _: &[u8]) -> Result<Vec<u8>, String> { Err("seal failed".into()) }
        fn open(&self, _: &str, _: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> { Err("open failed".into()) }
        fn allows_plaintext_fallback(&self) -> bool { true }
    }
    let dir = tempfile::tempdir().unwrap();
    assert!(ClientKey::load_linux_candidate(dir.path(), Some(&PermissiveFailure)).is_err());
    assert!(!dir.path().join(KEY_FILE).exists());
    assert!(!dir.path().join(SEALED_KEY_FILE).exists());
}

#[test]
fn residual_plain_identity_refuses_without_replacing_either_file() {
    use crate::pairing::key::{ClientKey, KEY_FILE, SEALED_KEY_FILE};
    use std::io::Write;
    let (sealer, _) = fixture();
    let dir = tempfile::tempdir().unwrap();
    ClientKey::load_linux_candidate(dir.path(), Some(&sealer)).unwrap();
    let protected = std::fs::read(dir.path().join(SEALED_KEY_FILE)).unwrap();
    let plain = dir.path().join(KEY_FILE);
    crate::pairing::key::create_new_protected(&plain).unwrap()
        .write_all("39".repeat(32).as_bytes()).unwrap();
    let original = std::fs::read(&plain).unwrap();
    assert!(ClientKey::load_linux_candidate(dir.path(), Some(&sealer)).is_err());
    assert_eq!(std::fs::read(&plain).unwrap(), original);
    assert_eq!(std::fs::read(dir.path().join(SEALED_KEY_FILE)).unwrap(), protected);
}

#[test]
fn corrupt_protected_identity_is_never_replaced() {
    use crate::pairing::key::{ClientKey, KEY_FILE, SEALED_KEY_FILE};
    use std::io::Write;
    let (sealer, _) = fixture();
    let dir = tempfile::tempdir().unwrap();
    let protected = dir.path().join(SEALED_KEY_FILE);
    crate::pairing::key::create_new_protected(&protected).unwrap()
        .write_all(b"truncated").unwrap();
    assert!(ClientKey::load_linux_candidate(dir.path(), Some(&sealer)).is_err());
    assert_eq!(std::fs::read(&protected).unwrap(), b"truncated");
    assert!(!dir.path().join(KEY_FILE).exists());
}

#[test]
fn lost_or_changed_item_never_authorizes_another_seal() {
    let (sealer, backend) = fixture();
    sealer.seal("identity", &[23; 32]).unwrap();
    *backend.key.lock().unwrap() = None;
    assert!(sealer.seal("code", b"new code").is_err());
    assert!(backend.key.lock().unwrap().is_none());
    *backend.key.lock().unwrap() = Some(Zeroizing::new(vec![31; 32]));
    assert!(sealer.seal("code", b"new code").is_err());
    assert_eq!(backend.key.lock().unwrap().as_ref().unwrap().as_slice(), &[31; 32]);
}

#[test]
fn native_provider_construction_does_not_allow_plaintext_fallback() {
    let sealer = LinuxSealer::new("test.profile", [7; 32]).unwrap();
    assert!(!sealer.allows_plaintext_fallback());
    assert!(LinuxSealer::new("", [7; 32]).is_err());
    assert!(LinuxSealer::new("invalid\0profile", [7; 32]).is_err());
}
