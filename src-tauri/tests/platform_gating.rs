//! Unsupported platforms must refuse storage that requires Unix protections.
#![cfg(not(unix))]

use bitsov_app::{budget, pairing::ClientKey, spend_journal::Journal};

#[test]
fn unsupported_platform_refuses_private_storage_before_creating_files() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("private");
    let error = budget::save(&dir, &budget::Book::new("node")).unwrap_err();
    assert!(error.message.contains("not supported on this platform"));
    let error = Journal::open(&dir).err().expect("journal must refuse");
    assert!(error.message.contains("not supported on this platform"));
    let error = ClientKey::load_or_create(&dir).unwrap_err();
    assert!(error.to_string().contains("not supported on this platform"));
    assert!(!dir.exists(), "refusal must precede filesystem mutations");
}
