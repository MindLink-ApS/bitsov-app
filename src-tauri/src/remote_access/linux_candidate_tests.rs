use super::*;

#[test]
fn absent_provider_refuses_descriptor_io_before_writing() {
    let (_dir, path, descriptor, _) = sealed_fixture(71);
    assert!(persist_linux_candidate(&path, &descriptor, None).is_err());
    assert!(!path.exists());
    assert!(load_linux_candidate(&path, None).is_err());
    assert!(!path.exists());
}

#[test]
fn refusal_preserves_an_existing_descriptor() {
    let (_dir, path, descriptor, _) = sealed_fixture(73);
    persist_with(&path, &descriptor, None).unwrap();
    let original = std::fs::read(&path).unwrap();
    assert!(load_linux_candidate(&path, None).is_err());
    assert!(persist_linux_candidate(&path, &descriptor, None).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), original);
}

#[test]
fn descriptor_candidate_never_uses_a_permissive_fallback() {
    struct Failure;
    impl Sealer for Failure {
        fn seal(&self, _: &str, _: &[u8]) -> Result<Vec<u8>, String> { Err("seal failed".into()) }
        fn open(&self, _: &str, _: &[u8]) -> Result<zeroize::Zeroizing<Vec<u8>>, String> { Err("open failed".into()) }
        fn allows_plaintext_fallback(&self) -> bool { true }
    }
    let (_dir, path, descriptor, _) = sealed_fixture(75);
    persist_with(&path, &descriptor, None).unwrap();
    let original = std::fs::read(&path).unwrap();
    assert!(load_linux_candidate(&path, Some(&Failure)).is_err());
    assert!(persist_linux_candidate(&path, &descriptor, Some(&Failure)).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), original);
}

#[test]
fn unreadable_existing_protected_code_blocks_a_subsequent_write() {
    use crate::at_rest::test_sealer::MemorySealer;
    struct LostItem;
    impl Sealer for LostItem {
        fn seal(&self, purpose: &str, bytes: &[u8]) -> Result<Vec<u8>, String> { MemorySealer.seal(purpose, bytes) }
        fn open(&self, _: &str, _: &[u8]) -> Result<zeroize::Zeroizing<Vec<u8>>, String> { Err("item unavailable".into()) }
    }
    let (_dir, path, mut descriptor, _) = sealed_fixture(77);
    persist_with(&path, &descriptor, Some(&MemorySealer)).unwrap();
    let original = std::fs::read(&path).unwrap();
    descriptor.code = None;
    assert!(persist_linux_candidate(&path, &descriptor, Some(&LostItem)).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), original);
}
