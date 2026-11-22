use super::*;
use crate::at_rest::linux::identity_fixture::sealer;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use std::os::unix::fs::PermissionsExt;

fn write(dir: &Path, name: &str, bytes: &[u8]) {
    create_new_protected(&dir.join(name)).unwrap().write_all(bytes).unwrap();
}

fn entries(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut files: Vec<_> = std::fs::read_dir(dir).unwrap().map(|entry| {
        let entry = entry.unwrap();
        (entry.file_name().into_string().unwrap(), std::fs::read(entry.path()).unwrap())
    }).collect();
    files.sort();
    files
}

fn protected(bytes: &[u8]) {
    assert_eq!(bytes.len(), 100);
    assert_eq!(&bytes[..8], b"BSLSS002");
}

fn no_seed(bytes: &[u8], seed: &[u8; 32]) {
    assert!(!bytes.windows(32).any(|window| window == seed));
    for text in [hex::encode(seed), hex::encode_upper(seed)] {
        assert!(!bytes.windows(64).any(|window| window == text.as_bytes()));
    }
}

fn record(seed: &[u8]) -> Vec<u8> {
    sealer().seal(at_rest::CLIENT_SEED_PURPOSE, seed).unwrap()
}

#[test]
fn fresh_creation_writes_only_a_protected_record_at_the_existing_path() {
    let dir = tempfile::tempdir().unwrap();
    let store = dir.path().join("pairing");
    let key = load(&store, Some(&sealer())).unwrap();
    let files = entries(&store);
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].0, KEY_FILE);
    protected(&files[0].1);
    key.with_seed(|seed| no_seed(&files[0].1, seed));
    assert_eq!(std::fs::metadata(&store).unwrap().permissions().mode() & 0o777, 0o700);
    assert_eq!(std::fs::metadata(store.join(KEY_FILE)).unwrap().permissions().mode() & 0o777, 0o600);
}

#[test]
fn repeated_load_preserves_bytes_identity_and_signatures() {
    let dir = tempfile::tempdir().unwrap();
    let first = load(dir.path(), Some(&sealer())).unwrap();
    let bytes = entries(dir.path());
    protected(&std::fs::read(dir.path().join(KEY_FILE)).unwrap());
    let again = load(dir.path(), Some(&sealer())).unwrap();
    assert_eq!(entries(dir.path()), bytes);
    assert_eq!(first.public_hex(), again.public_hex());
    let public: [u8; 32] = hex::decode(first.public_hex()).unwrap().try_into().unwrap();
    VerifyingKey::from_bytes(&public).unwrap().verify(
        b"record reload", &Signature::from_bytes(&again.sign_bytes(b"record reload")),
    ).unwrap();
}

#[test]
fn independently_prepared_v2_record_reopens_without_rewrite() {
    let dir = tempfile::tempdir().unwrap();
    let bytes = record(&[17; 32]);
    write(dir.path(), KEY_FILE, &bytes);
    let key = load(dir.path(), Some(&sealer())).unwrap();
    assert_eq!(key.public_hex(), ClientKey::from_seed([17; 32]).public_hex());
    assert_eq!(entries(dir.path()), vec![(KEY_FILE.into(), bytes)]);
}

#[test]
fn mode_0644_refuses_with_the_existing_0600_diagnostic() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), KEY_FILE, &record(&[17; 32]));
    let path = dir.path().join(KEY_FILE);
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    let before = entries(dir.path());
    assert!(load(dir.path(), Some(&sealer())).unwrap_err().to_string().contains("0600"));
    assert_eq!(entries(dir.path()), before);
    assert_eq!(std::fs::metadata(path).unwrap().permissions().mode() & 0o777, 0o644);
}

#[test]
fn truncated_trailing_unknown_and_oversized_records_are_preserved() {
    let bytes = record(&[17; 32]);
    let mut cases: Vec<Vec<u8>> = (0..100).map(|length| bytes[..length].to_vec()).collect();
    let mut trailing = bytes.clone();
    trailing.push(0);
    cases.push(trailing);
    let mut future = bytes;
    future[..8].copy_from_slice(b"BSLSS003");
    cases.push(future);
    cases.push(vec![0; 16385]);
    for (index, bytes) in cases.into_iter().enumerate() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), KEY_FILE, &bytes);
        let before = entries(dir.path());
        assert!(load(dir.path(), Some(&sealer())).is_err(), "case {index}");
        assert_eq!(entries(dir.path()), before, "case {index}");
    }
}

#[test]
fn each_damaged_byte_and_wrong_purpose_refuse_without_replacement() {
    let bytes = record(&[17; 32]);
    let mut cases = vec![sealer().seal("another-purpose", &[17; 32]).unwrap()];
    for index in 0..100 {
        let mut damaged = bytes.clone();
        damaged[index] ^= 1;
        cases.push(damaged);
    }
    for (index, bytes) in cases.into_iter().enumerate() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), KEY_FILE, &bytes);
        let before = entries(dir.path());
        assert!(load(dir.path(), Some(&sealer())).is_err(), "case {index}");
        assert_eq!(entries(dir.path()), before, "case {index}");
    }
}

#[test]
fn authenticated_payloads_of_the_wrong_seed_length_refuse() {
    for length in [0, 31, 33, 8192] {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), KEY_FILE, &record(&vec![17; length]));
        let before = entries(dir.path());
        assert!(load(dir.path(), Some(&sealer())).is_err(), "length {length}");
        assert_eq!(entries(dir.path()), before);
    }
}

#[test]
fn malformed_and_unbounded_legacy_inputs_refuse() {
    for bytes in [vec![255; 64], b"gg".repeat(32), b"17".repeat(31), b"17".repeat(33),
        [b" ".repeat(4096), b"17".repeat(32)].concat()] {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), KEY_FILE, &bytes);
        let before = entries(dir.path());
        assert!(load(dir.path(), Some(&sealer())).is_err());
        assert_eq!(entries(dir.path()), before);
    }
}

#[test]
fn legacy_migration_preserves_identity_and_seed_derivation() {
    for bytes in [b"ab".repeat(32), b"AB".repeat(32),
        [b" \n\t".to_vec(), b"Ab".repeat(32), b"\r\n ".to_vec()].concat()] {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), KEY_FILE, &bytes);
        let key = load(dir.path(), Some(&sealer())).unwrap();
        let expected = ClientKey::from_seed([0xab; 32]);
        assert_eq!(key.public_hex(), expected.public_hex());
        assert_eq!(key.with_seed(|seed| blake3::derive_key("record derivation", seed)),
            blake3::derive_key("record derivation", &[0xab; 32]));
        let files = entries(dir.path());
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].0, KEY_FILE);
        protected(&files[0].1);
        no_seed(&files[0].1, &[0xab; 32]);
    }
}

#[test]
fn migration_keeps_legacy_until_verified_publication_and_durability() {
    let dir = tempfile::tempdir().unwrap();
    let legacy = b"17".repeat(32);
    write(dir.path(), KEY_FILE, &legacy);
    let mut phases = Vec::new();
    let key = load_with(dir.path(), Some(&sealer()), &mut |phase| {
        phases.push(phase);
        let current = std::fs::read(dir.path().join(KEY_FILE)).unwrap();
        match phase {
            Phase::TempSynced | Phase::Verified => assert_eq!(current, legacy),
            _ => protected(&current),
        }
        for (name, bytes) in entries(dir.path()) {
            if name != KEY_FILE { protected(&bytes); no_seed(&bytes, &[0x17; 32]); }
        }
        Ok(())
    }).unwrap();
    assert_eq!(key.public_hex(), ClientKey::from_seed([0x17; 32]).public_hex());
    assert_eq!(phases, vec![Phase::TempSynced, Phase::Verified, Phase::Published, Phase::Durable, Phase::Complete]);
    assert_eq!(entries(dir.path()).len(), 1);
}

struct Failure { stage: &'static str }
impl Sealer for Failure {
    fn seal(&self, purpose: &str, bytes: &[u8]) -> Result<Vec<u8>, String> {
        if self.stage == "seal" { Err("unavailable".into()) }
        else { sealer().seal(purpose, bytes) }
    }
    fn open(&self, purpose: &str, bytes: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
        match self.stage {
            "open" => Err("locked".into()),
            "mismatch" => Ok(Zeroizing::new(vec![99; 32])),
            _ => sealer().open(purpose, bytes),
        }
    }
    fn allows_plaintext_fallback(&self) -> bool { true }
}

#[test]
fn failed_protection_or_readback_never_authorizes_legacy_use() {
    for stage in ["seal", "open", "mismatch"] {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), KEY_FILE, &b"17".repeat(32));
        let before = entries(dir.path());
        assert!(load(dir.path(), Some(&Failure { stage })).is_err(), "{stage}");
        assert_eq!(entries(dir.path()), before, "{stage}");
    }
}

#[test]
fn publication_faults_preserve_the_same_recoverable_identity() {
    for stop in [Phase::TempSynced, Phase::Verified, Phase::Published, Phase::Durable] {
        let dir = tempfile::tempdir().unwrap();
        let legacy = b"17".repeat(32);
        write(dir.path(), KEY_FILE, &legacy);
        let error = load_with(dir.path(), Some(&sealer()), &mut |phase| {
            if phase == stop { Err(PairError::Local("publication interrupted".into())) } else { Ok(()) }
        });
        assert!(error.is_err(), "{stop:?}");
        if matches!(stop, Phase::TempSynced | Phase::Verified) {
            assert_eq!(entries(dir.path()), vec![(KEY_FILE.into(), legacy)]);
        } else {
            protected(&std::fs::read(dir.path().join(KEY_FILE)).unwrap());
        }
        let key = load(dir.path(), Some(&sealer())).unwrap();
        assert_eq!(key.public_hex(), ClientKey::from_seed([0x17; 32]).public_hex());
        assert_eq!(entries(dir.path()).len(), 1);
    }
}

#[test]
fn absent_protection_creates_no_store() {
    let dir = tempfile::tempdir().unwrap();
    let store = dir.path().join("pairing");
    assert!(load(&store, None).is_err());
    assert!(!store.exists());
}

#[test]
fn existing_protected_records_never_fall_back_or_reseal() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), KEY_FILE, &record(&[17; 32]));
    let before = entries(dir.path());
    let key = load(dir.path(), Some(&Failure { stage: "seal" })).unwrap();
    assert_eq!(key.public_hex(), ClientKey::from_seed([17; 32]).public_hex());
    assert_eq!(entries(dir.path()), before);
    for provider in [None, Some(&Failure { stage: "open" } as &dyn Sealer)] {
        assert!(load(dir.path(), provider).is_err());
        assert_eq!(entries(dir.path()), before);
    }
}

#[test]
fn separate_record_moves_without_resealing_after_verified_durable_publication() {
    let dir = tempfile::tempdir().unwrap();
    let bytes = record(&[17; 32]);
    write(dir.path(), SEALED_KEY_FILE, &bytes);
    let mut phases = Vec::new();
    let key = load_with(dir.path(), Some(&Failure { stage: "seal" }), &mut |phase| {
        phases.push(phase);
        if matches!(phase, Phase::TempSynced | Phase::Verified) {
            assert!(!dir.path().join(KEY_FILE).exists());
        } else {
            assert_eq!(std::fs::read(dir.path().join(KEY_FILE)).unwrap(), bytes);
        }
        if phase != Phase::Complete {
            assert_eq!(std::fs::read(dir.path().join(SEALED_KEY_FILE)).unwrap(), bytes);
        }
        Ok(())
    }).unwrap();
    assert_eq!(key.public_hex(), ClientKey::from_seed([17; 32]).public_hex());
    assert_eq!(phases, vec![Phase::TempSynced, Phase::Verified, Phase::Published, Phase::Durable, Phase::BeforeCleanup, Phase::Complete]);
    assert_eq!(entries(dir.path()), vec![(KEY_FILE.into(), bytes)]);
}

#[test]
fn matching_transition_records_complete_and_cleanup_retries_keep_bytes() {
    for protected_primary in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let secondary = record(&[17; 32]);
        let primary = if protected_primary { record(&[17; 32]) } else { b"11".repeat(32) };
        write(dir.path(), KEY_FILE, &primary);
        write(dir.path(), SEALED_KEY_FILE, &secondary);
        let error = load_with(dir.path(), Some(&sealer()), &mut |phase| {
            if phase == Phase::BeforeCleanup { Err(PairError::Local("cleanup interrupted".into())) } else { Ok(()) }
        });
        assert!(error.is_err());
        let retained = std::fs::read(dir.path().join(KEY_FILE)).unwrap();
        assert_eq!(retained, if protected_primary { primary } else { secondary.clone() });
        assert_eq!(std::fs::read(dir.path().join(SEALED_KEY_FILE)).unwrap(), secondary);
        let key = load(dir.path(), Some(&Failure { stage: "seal" })).unwrap();
        assert_eq!(key.public_hex(), ClientKey::from_seed([17; 32]).public_hex());
        assert_eq!(entries(dir.path()), vec![(KEY_FILE.into(), retained)]);
    }
}

#[test]
fn conflicting_and_unknown_records_preserve_both_originals() {
    for primary in [b"11".repeat(32), record(&[17; 32]), b"unknown".to_vec()] {
        for secondary in [record(&[18; 32]), b"unknown".to_vec()] {
            let dir = tempfile::tempdir().unwrap();
            write(dir.path(), KEY_FILE, &primary);
            write(dir.path(), SEALED_KEY_FILE, &secondary);
            let before = entries(dir.path());
            assert!(load(dir.path(), Some(&sealer())).is_err());
            assert_eq!(entries(dir.path()), before);
        }
    }
}
