//! Direct Keychain storage and crash-safe legacy migration.
use super::*;

const MARKER: &str = "client-ed25519.keychain";

trait KeyStore {
    fn read(&self) -> Result<Option<Zeroizing<[u8; 32]>>, PairError>;
    fn add(&self, seed: &[u8; 32]) -> Result<(), PairError>;
}

#[cfg(all(not(test), any(target_os = "ios", all(target_os = "macos", not(feature = "mobile")))))]
struct NativeStore<'a>(&'a Path);
#[cfg(all(not(test), any(target_os = "ios", all(target_os = "macos", not(feature = "mobile")))))]
impl KeyStore for NativeStore<'_> {
    fn read(&self) -> Result<Option<Zeroizing<[u8; 32]>>, PairError> {
        bitsov_ffi::client_keychain::read(self.0).map_err(PairError::Local)
    }
    fn add(&self, seed: &[u8; 32]) -> Result<(), PairError> {
        bitsov_ffi::client_keychain::add(self.0, seed).map_err(PairError::Local)
    }
}
#[cfg(all(not(test), any(target_os = "ios", all(target_os = "macos", not(feature = "mobile")))))]
pub(super) fn load_native(dir: &Path) -> Result<ClientKey, PairError> {
    load_selected(dir, &NativeStore(dir), at_rest::installed(),
        bitsov_ffi::client_keychain::data_protection_available())
}

// Backend selection is based on the running process's validated entitlement,
// never on the result of an authenticated read or write.
fn load_selected(dir: &Path, store: &dyn KeyStore, sealer: Option<&dyn Sealer>, entitled: bool) -> Result<ClientKey, PairError> {
    if entitled { return load_or_create_with_sealer(dir, store, sealer); }
    match std::fs::symlink_metadata(dir.join(MARKER)) {
        Ok(_) => return Err(failure("this identity requires the original app's Keychain entitlement")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
        Err(_) => return Err(failure("cannot inspect client Keychain marker")),
    }
    struct Strict<'a>(&'a dyn Sealer);
    impl Sealer for Strict<'_> {
        fn seal(&self, purpose: &str, bytes: &[u8]) -> Result<Vec<u8>, String> { self.0.seal(purpose, bytes) }
        fn open(&self, purpose: &str, bytes: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> { self.0.open(purpose, bytes) }
    }
    let sealer = sealer.ok_or_else(|| failure("Secure Enclave storage is unavailable; try again"))?;
    ClientKey::load_or_create_sealed(dir, &Strict(sealer))
}

fn failure(message: &str) -> PairError { PairError::Local(message.into()) }

// Retain the opened inode until cleanup; never follow links or wipe a different
// file after a rename. Failure leaves the old identity recoverable for a retry.
#[cfg(unix)]
fn legacy(dir: &Path, recovery_seed: Option<&[u8; 32]>) -> Result<Option<(std::fs::File, Zeroizing<[u8; 32]>)>, PairError> {
    use std::io::Read;
    use std::os::unix::fs::{OpenOptionsExt, MetadataExt};
    let mut file = match std::fs::OpenOptions::new().read(true).write(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(dir.join(KEY_FILE)) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(failure("cannot safely open the legacy client key")),
    };
    let meta = file.metadata().map_err(|_| failure("cannot inspect the legacy client key"))?;
    if !meta.is_file() || meta.nlink() != 1 || meta.mode() & 0o077 != 0 || meta.len() != 64 {
        return Err(failure("legacy client key is not an owner-only, single-link 64-byte file"));
    }
    let mut text = Zeroizing::new([0u8; 64]);
    file.read_exact(&mut text[..]).map_err(|_| failure("cannot read the legacy client key"))?;
    // A previous verified migration may have stopped during the overwrite.
    // Only accept bytes from that identity's original encoding or wipe zeros.
    if let Some(seed) = recovery_seed {
        let original = Zeroizing::new(hex::encode(seed));
        if text.contains(&0) && text.iter().zip(original.bytes()).all(|(a, b)| *a == 0 || *a == b) {
            return Ok(Some((file, Zeroizing::new(*seed))));
        }
    }
    let mut seed = Zeroizing::new([0; 32]);
    hex::decode_to_slice(&text[..], &mut seed[..]).map_err(|_| failure("legacy client key is corrupt"))?;
    Ok(Some((file, seed)))
}

#[cfg(unix)]
fn wipe(dir: &Path, mut file: std::fs::File) -> Result<(), PairError> {
    use std::io::{Seek, SeekFrom};
    use std::os::unix::fs::MetadataExt;
    let path = dir.join(KEY_FILE);
    let current = std::fs::symlink_metadata(&path).map_err(|_| failure("cannot inspect legacy cleanup path"))?;
    let opened = file.metadata().map_err(|_| failure("cannot inspect legacy cleanup file"))?;
    if !current.is_file() || current.ino() != opened.ino() || current.dev() != opened.dev() || opened.nlink() != 1 {
        return Err(failure("legacy client key changed during migration"));
    }
    file.seek(SeekFrom::Start(0)).and_then(|_| file.write_all(&[0; 64]))
        .and_then(|_| file.sync_all()).map_err(|_| failure("cannot wipe the legacy client key"))?;
    std::fs::remove_file(&path).map_err(|_| failure("cannot remove the legacy client key"))?;
    std::fs::File::open(dir).and_then(|f| f.sync_all())
        .map_err(|_| failure("cannot sync client key cleanup"))
}

#[cfg(all(test, unix))]
fn load_or_create(dir: &Path, store: &dyn KeyStore) -> Result<ClientKey, PairError> {
    load_or_create_with_sealer(dir, store, None)
}

#[cfg(unix)]
fn load_or_create_with_sealer(dir: &Path, store: &dyn KeyStore, sealer: Option<&dyn Sealer>) -> Result<ClientKey, PairError> {
    let _lock = SEALED_KEY_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    restrict_dir(dir)?;
    let sealed = sealed_file_exists(dir)?;
    let marker = dir.join(MARKER);
    let marked = match std::fs::symlink_metadata(&marker) {
        Ok(m) if m.is_file() => true,
        Ok(_) => return Err(failure("invalid client Keychain marker")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => return Err(failure("cannot inspect client Keychain marker")),
    };
    // Read first: locked, missing entitlement, and other errors must not create
    // a replacement identity or write plaintext, even before migration.
    let saved = store.read()?;
    if marked && saved.is_none() { return Err(failure("client Keychain identity is missing; restore access on the original device")); }
    if marked {
        let public = std::fs::read_to_string(&marker).map_err(|_| failure("cannot read client Keychain marker"))?;
        let saved_key = ClientKey::from_seed(**saved.as_ref().expect("marked key checked above"));
        if public != saved_key.public_hex() { return Err(failure("client Keychain identity does not match the saved public identity")); }
    }
    let sealed_seed = if sealed {
        Some(super::sealed_seed(&dir.join(SEALED_KEY_FILE), sealer.ok_or_else(||
            failure("protected client key requires its original storage provider"))?)?)
    } else { None };
    let old = legacy(dir, if marked { saved.as_deref() } else { None })?;
    let seed = match saved {
        Some(seed) => seed,
        None => {
            let seed = match (&sealed_seed, &old) {
                (Some(seed), _) => seed.clone(),
                (None, Some((_, seed))) => seed.clone(),
                (None, None) => {
                    let mut seed = Zeroizing::new([0; 32]);
                    getrandom::getrandom(&mut seed[..]).map_err(|_| failure("no randomness for client key"))?;
                    seed
                }
            };
            store.add(&seed)?;
            let verified = store.read()?.ok_or_else(|| failure("client Keychain write did not persist"))?;
            if *seed != *verified { return Err(failure("client Keychain verification failed")); }
            seed
        }
    };
    if old.as_ref().is_some_and(|(_, old_seed)| **old_seed != *seed) {
        return Err(failure("legacy and Keychain client identities differ; neither was replaced"));
    }
    if sealed_seed.as_ref().is_some_and(|old| **old != *seed) {
        return Err(failure("sealed and Keychain client identities differ; neither was replaced"));
    }
    let key = ClientKey::from_seed(*seed);
    if !marked {
        let mut temp = tempfile::NamedTempFile::new_in(dir).map_err(|_| failure("cannot create client Keychain marker"))?;
        temp.write_all(key.public_hex().as_bytes()).and_then(|_| temp.as_file().sync_all())
            .map_err(|_| failure("cannot write client Keychain marker"))?;
        temp.persist_noclobber(&marker).map_err(|_| failure("cannot publish client Keychain marker"))?;
    }
    std::fs::File::open(dir).and_then(|f| f.sync_all()).map_err(|_| failure("cannot sync client Keychain marker"))?;
    if let Some((file, _)) = old { wipe(dir, file)?; }
    if sealed {
        std::fs::remove_file(dir.join(SEALED_KEY_FILE)).map_err(|_| failure("cannot remove migrated sealed client key"))?;
        std::fs::File::open(dir).and_then(|f| f.sync_all()).map_err(|_| failure("cannot sync sealed client key cleanup"))?;
    }
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct MemoryStore {
        seed: RefCell<Option<Zeroizing<[u8; 32]>>>,
        read_error: bool,
        write_error: bool,
        corrupt_write: bool,
    }
    impl KeyStore for MemoryStore {
        fn read(&self) -> Result<Option<Zeroizing<[u8; 32]>>, PairError> {
            if self.read_error { return Err(PairError::Local("locked".into())); }
            Ok(self.seed.borrow().clone())
        }
        fn add(&self, seed: &[u8; 32]) -> Result<(), PairError> {
            if self.write_error { return Err(PairError::Local("unavailable".into())); }
            let mut item = self.seed.borrow_mut();
            if item.is_some() { return Err(PairError::Local("duplicate".into())); }
            *item = Some(Zeroizing::new(if self.corrupt_write { [9; 32] } else { *seed }));
            Ok(())
        }
    }
    #[test]
    fn unentitled_mac_creates_and_reloads_only_enclave_sealed_identity() {
        let dir = tempfile::tempdir().unwrap();
        let sealer = crate::at_rest::test_sealer::MemorySealer;
        let unavailable = MemoryStore { read_error: true, write_error: true, ..Default::default() };
        let first = load_selected(dir.path(), &unavailable, Some(&sealer), false).unwrap();
        let again = load_selected(dir.path(), &unavailable, Some(&sealer), false).unwrap();
        assert_eq!(first.public_hex(), again.public_hex());
        assert!(dir.path().join(SEALED_KEY_FILE).is_file());
        assert!(!dir.path().join(KEY_FILE).exists());
        let store = MemoryStore::default();
        let migrated = load_selected(dir.path(), &store, Some(&sealer), true).unwrap();
        assert_eq!(first.public_hex(), migrated.public_hex());
        assert!(!dir.path().join(SEALED_KEY_FILE).exists());
        assert!(load_selected(dir.path(), &unavailable, Some(&sealer), false).is_err());
    }
    #[test]
    fn unentitled_mac_never_falls_back_to_plaintext_or_replaces_a_sealed_identity() {
        struct Failing;
        impl Sealer for Failing {
            fn seal(&self, _: &str, _: &[u8]) -> Result<Vec<u8>, String> { Err("unavailable".into()) }
            fn open(&self, _: &str, _: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> { Err("unavailable".into()) }
            fn allows_plaintext_fallback(&self) -> bool { true }
        }
        let dir = tempfile::tempdir().unwrap();
        let store = MemoryStore::default();
        assert!(load_selected(dir.path(), &store, None, false).is_err());
        assert!(load_selected(dir.path(), &store, Some(&Failing), false).is_err());
        assert!(!dir.path().join(KEY_FILE).exists());
        let sealer = crate::at_rest::test_sealer::MemorySealer;
        let original = ClientKey::load_or_create_sealed(dir.path(), &sealer).unwrap();
        assert!(load_selected(dir.path(), &store, Some(&Failing), false).is_err());
        assert_eq!(load_selected(dir.path(), &store, Some(&sealer), false).unwrap().public_hex(), original.public_hex());
    }
    #[test]
    fn sealed_migration_preserves_identity_and_removes_old_envelope() {
        let dir = tempfile::tempdir().unwrap();
        let sealer = crate::at_rest::test_sealer::MemorySealer;
        let original = ClientKey::load_or_create_sealed(dir.path(), &sealer).unwrap();
        let store = MemoryStore::default();
        let key = load_or_create_with_sealer(dir.path(), &store, Some(&sealer)).unwrap();
        assert_eq!(key.public_hex(), original.public_hex());
        assert!(!dir.path().join(SEALED_KEY_FILE).exists());
        assert_eq!(load_or_create(dir.path(), &store).unwrap().public_hex(), key.public_hex());
    }
    #[test]
    fn failed_sealed_migration_preserves_envelope_and_identity() {
        let dir = tempfile::tempdir().unwrap();
        let sealer = crate::at_rest::test_sealer::MemorySealer;
        ClientKey::load_or_create_sealed(dir.path(), &sealer).unwrap();
        let before = std::fs::read(dir.path().join(SEALED_KEY_FILE)).unwrap();
        for store in [MemoryStore { read_error: true, ..Default::default() },
            MemoryStore { write_error: true, ..Default::default() },
            MemoryStore { corrupt_write: true, ..Default::default() }] {
            assert!(load_or_create_with_sealer(dir.path(), &store, Some(&sealer)).is_err());
            assert_eq!(std::fs::read(dir.path().join(SEALED_KEY_FILE)).unwrap(), before);
            assert!(!dir.path().join(KEY_FILE).exists());
        }
    }
    #[test]
    fn creates_and_reloads_without_plaintext_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = MemoryStore::default();
        let first = load_or_create(dir.path(), &store).unwrap();
        let next = load_or_create(dir.path(), &store).unwrap();
        assert_eq!(first.public_hex(), next.public_hex());
        assert!(!dir.path().join(KEY_FILE).exists());
        assert!(!dir.path().join(SEALED_KEY_FILE).exists());
    }
    #[test]
    fn migration_preserves_identity_and_wipes_open_legacy_inode() {
        use std::io::{Read, Seek, SeekFrom};
        let dir = tempfile::tempdir().unwrap();
        let original = ClientKey::load_or_create_plain(dir.path()).unwrap();
        let mut old = std::fs::File::open(dir.path().join(KEY_FILE)).unwrap();
        let store = MemoryStore::default();
        let migrated = load_or_create(dir.path(), &store).unwrap();
        assert_eq!(original.public_hex(), migrated.public_hex());
        assert!(!dir.path().join(KEY_FILE).exists());
        old.seek(SeekFrom::Start(0)).unwrap();
        let mut bytes = Zeroizing::new(Vec::new());
        old.read_to_end(&mut bytes).unwrap();
        assert!(bytes.len() == 64 && bytes.iter().all(|b| *b == 0));
        assert_eq!(load_or_create(dir.path(), &store).unwrap().public_hex(), original.public_hex());
    }
    #[test]
    fn failed_read_write_or_verification_never_deletes_legacy_key() {
        for store in [MemoryStore { read_error: true, ..Default::default() },
            MemoryStore { write_error: true, ..Default::default() },
            MemoryStore { corrupt_write: true, ..Default::default() }] {
            let dir = tempfile::tempdir().unwrap();
            let original = ClientKey::load_or_create_plain(dir.path()).unwrap();
            assert!(load_or_create(dir.path(), &store).is_err());
            assert_eq!(ClientKey::load(&dir.path().join(KEY_FILE)).unwrap().public_hex(), original.public_hex());
        }
    }
    #[test]
    fn missing_migrated_key_never_generates_another_identity() {
        let dir = tempfile::tempdir().unwrap();
        let store = MemoryStore::default();
        load_or_create(dir.path(), &store).unwrap();
        *store.seed.borrow_mut() = None;
        assert!(load_or_create(dir.path(), &store).is_err());
        assert!(store.seed.borrow().is_none());
    }
    #[test]
    fn retry_after_keychain_write_cleans_matching_legacy_file() {
        let dir = tempfile::tempdir().unwrap();
        let original = ClientKey::load_or_create_plain(dir.path()).unwrap();
        let store = MemoryStore::default();
        original.with_seed(|seed| store.add(seed)).unwrap();
        assert_eq!(load_or_create(dir.path(), &store).unwrap().public_hex(), original.public_hex());
        assert!(!dir.path().join(KEY_FILE).exists());
    }
    #[test]
    fn conflicting_identity_is_retained_and_refused() {
        let dir = tempfile::tempdir().unwrap();
        let original = ClientKey::load_or_create_plain(dir.path()).unwrap();
        let store = MemoryStore::default();
        store.add(&[9; 32]).unwrap();
        assert!(load_or_create(dir.path(), &store).is_err());
        assert_eq!(ClientKey::load(&dir.path().join(KEY_FILE)).unwrap().public_hex(), original.public_hex());
    }
    #[test]
    fn fresh_install_recovers_from_orphaned_keychain_and_conflicting_legacy_file() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("app-client");
        let legacy_key = ClientKey::load_or_create_plain(&dir).unwrap();
        let store = MemoryStore::default();
        store.add(&[9; 32]).unwrap();
        let orphan_public = ClientKey::from_seed([9; 32]).public_hex().to_owned();
        crate::ios_install::prepare(root.path(), || {
            *store.seed.borrow_mut() = None;
            Ok(())
        }).unwrap();
        crate::ios_install::complete(root.path()).unwrap();
        let fresh = load_or_create(&dir, &store).unwrap();
        assert_ne!(fresh.public_hex(), legacy_key.public_hex());
        assert_ne!(fresh.public_hex(), orphan_public);
        assert!(!dir.join(KEY_FILE).exists());
        crate::ios_install::prepare(root.path(), || panic!("must keep new identity")).unwrap();
        assert_eq!(load_or_create(&dir, &store).unwrap().public_hex(), fresh.public_hex());
    }
    #[test]
    fn resumes_cleanup_after_wipe_before_unlink() {
        for wiped_bytes in [17, 64] {
            let dir = tempfile::tempdir().unwrap();
            let store = MemoryStore::default();
            let original = load_or_create(dir.path(), &store).unwrap();
            let mut file = create_new_protected(&dir.path().join(KEY_FILE)).unwrap();
            let mut interrupted = original.with_seed(|seed| Zeroizing::new(hex::encode(seed).into_bytes()));
            interrupted[..wiped_bytes].fill(0);
            file.write_all(&interrupted).unwrap();
            file.sync_all().unwrap();
            assert_eq!(load_or_create(dir.path(), &store).unwrap().public_hex(), original.public_hex());
            assert!(!dir.path().join(KEY_FILE).exists());
        }
    }

    #[cfg(unix)]
    #[test]
    fn migration_refuses_symlinks_and_hardlinks() {
        let dir = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        ClientKey::load_or_create_plain(other.path()).unwrap();
        let source = other.path().join(KEY_FILE);
        let destination = dir.path().join(KEY_FILE);
        std::os::unix::fs::symlink(&source, &destination).unwrap();
        assert!(load_or_create(dir.path(), &MemoryStore::default()).is_err());
        std::fs::remove_file(&destination).unwrap();
        std::fs::hard_link(&source, &destination).unwrap();
        assert!(load_or_create(dir.path(), &MemoryStore::default()).is_err());
        assert!(ClientKey::load(&source).is_ok());
    }
}
