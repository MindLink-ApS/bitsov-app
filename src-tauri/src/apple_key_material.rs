//! Durable migration of device-key blobs into owner-presence-protected Keychain storage.
use std::path::Path;
use zeroize::Zeroizing;

type Result<T> = std::result::Result<T, String>;
trait Store {
    fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>>;
    fn add(&self, bytes: &[u8]) -> Result<()>;
}

const LEGACY: &str = "device-key.blob";
const MARKER: &str = "device-key.keychain";
const TEMPORARY: &str = "device-key.blob.tmp";
static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn exists(path: &Path) -> Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

fn publish(directory: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let path = directory.join(MARKER);
    let digest = blake3::hash(bytes).to_hex().to_string();
    if exists(&path)? {
        if !std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?.is_file()
            || std::fs::read_to_string(&path).map_err(|e| e.to_string())? != digest {
            return Err("device Keychain marker does not match its key".into());
        }
    } else {
        let mut file = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
        file.write_all(digest.as_bytes()).and_then(|_| file.as_file().sync_all()).map_err(|e| e.to_string())?;
        file.persist_noclobber(&path).map_err(|e| e.to_string())?;
    }
    std::fs::File::open(directory).and_then(|f| f.sync_all()).map_err(|e| e.to_string())
}

#[cfg(test)]
fn load(directory: &Path, store: &dyn Store) -> Result<Option<Zeroizing<Vec<u8>>>> {
    load_selected(directory, store, true)
}

fn load_selected(directory: &Path, store: &dyn Store, entitled: bool) -> Result<Option<Zeroizing<Vec<u8>>>> {
    use std::{io::Read, os::unix::fs::{MetadataExt, OpenOptionsExt}};
    let _lock = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let saved = if entitled { store.read()? } else { None };
    if saved.is_none() && exists(&directory.join(MARKER))? {
        return Err("device Keychain identity is missing; restore access on the original device".into());
    }
    let path = directory.join(LEGACY);
    let temporary = directory.join(TEMPORARY);
    // An interrupted old writer cannot authorize creation of a new identity.
    if saved.is_none() && !exists(&path)? && exists(&temporary)? {
        return Err("an interrupted device key write requires recovery".into());
    }
    let old = if exists(&path)? {
        let mut file = std::fs::OpenOptions::new().read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(&path).map_err(|e| e.to_string())?;
        let meta = file.metadata().map_err(|e| e.to_string())?;
        if !meta.is_file() || meta.nlink() != 1 || meta.mode() & 0o077 != 0 || !(1..=4096).contains(&meta.len()) {
            return Err("invalid legacy device key file".into());
        }
        let mut bytes = Zeroizing::new(Vec::new());
        (&mut file).take(4097).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        if bytes.len() > 4096 { return Err("oversized device key".into()); }
        Some((file, bytes))
    } else { None };
    let bytes = match saved {
        Some(bytes) => bytes,
        None => match &old {
            Some((_, bytes)) => {
                // CryptoKit dataRepresentation is already enclave-wrapped. An
                // unentitled Mac keeps this file and never probes the Keychain.
                if !entitled { return Ok(Some(bytes.clone())); }
                store.add(bytes)?;
                let verified = store.read()?.ok_or("device Keychain write did not persist")?;
                if verified.as_slice() != bytes.as_slice() { return Err("device Keychain verification failed".into()); }
                verified
            }
            None => return Ok(None),
        }
    };
    if let Some((_, old_bytes)) = &old {
        if old_bytes.as_slice() != bytes.as_slice() { return Err("legacy and Keychain device keys differ".into()); }
    }
    publish(directory, &bytes)?;
    if let Some((file, _)) = old {
        let opened = file.metadata().map_err(|e| e.to_string())?;
        let current = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if !current.is_file() || current.ino() != opened.ino() || current.dev() != opened.dev() || opened.nlink() != 1 {
            return Err("legacy device key changed during migration".into());
        }
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        std::fs::File::open(directory).and_then(|f| f.sync_all()).map_err(|e| e.to_string())?;
    }
    if exists(&temporary)? {
        let file = std::fs::OpenOptions::new().read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(&temporary).map_err(|e| e.to_string())?;
        let opened = file.metadata().map_err(|e| e.to_string())?;
        let current = std::fs::symlink_metadata(&temporary).map_err(|e| e.to_string())?;
        if !current.is_file() || current.ino() != opened.ino() || current.dev() != opened.dev()
            || opened.nlink() != 1 || opened.mode() & 0o077 != 0 {
            return Err("cannot safely retire temporary device key material".into());
        }
        std::fs::remove_file(&temporary).map_err(|e| e.to_string())?;
        std::fs::File::open(directory).and_then(|f| f.sync_all()).map_err(|e| e.to_string())?;
    }
    Ok(Some(bytes))
}

#[cfg(all(not(test), any(target_os = "ios", all(target_os = "macos", not(feature = "mobile")))))]
struct Native<'a>(&'a Path, &'a bitsov_ffi::client_keychain::AuthenticationContext);
#[cfg(all(not(test), any(target_os = "ios", all(target_os = "macos", not(feature = "mobile")))))]
impl Store for Native<'_> {
    fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>> { bitsov_ffi::client_keychain::read_blob(self.0, self.1) }
    fn add(&self, bytes: &[u8]) -> Result<()> { bitsov_ffi::client_keychain::add_blob(self.0, bytes) }
}

#[cfg(not(test))]
pub(crate) fn read_for_signing(directory: &Path, context: &bitsov_ffi::client_keychain::AuthenticationContext) -> Result<Option<Zeroizing<Vec<u8>>>> {
    load_selected(directory, &Native(directory, context), bitsov_ffi::client_keychain::data_protection_available())
}
#[cfg(not(test))]
pub(crate) fn save(directory: &Path, bytes: &[u8]) -> Result<()> {
    let _lock = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    // Public recovery metadata is durable before publishing protected material.
    let public = bitsov_ffi::device_key::public_key(bytes).map_err(|e| e.to_string())?;
    use std::io::Write;
    let mut metadata = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
    metadata.write_all(hex::encode(public).as_bytes()).and_then(|_| metadata.as_file().sync_all()).map_err(|e| e.to_string())?;
    metadata.persist(directory.join("device-key.public")).map_err(|e| e.to_string())?;
    std::fs::File::open(directory).and_then(|f| f.sync_all()).map_err(|e| e.to_string())?;
    if !bitsov_ffi::client_keychain::data_protection_available() {
        if exists(&directory.join(MARKER))? { return Err("this device key requires its original Keychain entitlement".into()); }
        use std::io::Write;
        let mut file = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
        file.write_all(bytes).and_then(|_| file.as_file().sync_all()).map_err(|e| e.to_string())?;
        file.persist_noclobber(directory.join(LEGACY)).map_err(|e| e.to_string())?;
        return std::fs::File::open(directory).and_then(|f| f.sync_all()).map_err(|e| e.to_string());
    }
    // Creation writes without reading the protected item. The first actual
    // signature reads it with the operation's authentication context.
    if !exists(&directory.join(MARKER))? {
        // A prior forget may have removed local metadata while a transient
        // deletion failed. Retry exact deletion before publishing a new key.
        if !exists(&directory.join("device-key.json"))? {
            bitsov_ffi::client_keychain::delete_blob(directory)?;
        }
    }
    bitsov_ffi::client_keychain::add_blob(directory, bytes)?;
    publish(directory, bytes)
}
#[cfg(not(test))]
pub(crate) fn delete(directory: &Path) -> Result<()> {
    let _lock = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let deletion = if bitsov_ffi::client_keychain::data_protection_available() {
        bitsov_ffi::client_keychain::delete_blob(directory)
    } else { Ok(()) };
    for name in [LEGACY, MARKER, TEMPORARY, "device-key.public"] {
        let path = directory.join(name);
        if exists(&path)? { std::fs::remove_file(path).map_err(|e| e.to_string())?; }
    }
    deletion
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, os::unix::fs::OpenOptionsExt, io::Write};

    #[derive(Default)]
    struct Memory {
        data: RefCell<Option<Zeroizing<Vec<u8>>>>,
        read_error: bool,
        write_error: bool,
        corrupt: bool,
    }
    impl Store for Memory {
        fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>> {
            if self.read_error { return Err("denied".into()); }
            Ok(self.data.borrow().clone())
        }
        fn add(&self, bytes: &[u8]) -> Result<()> {
            if self.write_error { return Err("denied".into()); }
            *self.data.borrow_mut() = Some(Zeroizing::new(if self.corrupt { vec![9] } else { bytes.to_vec() }));
            Ok(())
        }
    }
    fn legacy(dir: &Path) {
        let mut f = std::fs::OpenOptions::new().create_new(true).write(true).mode(0o600)
            .open(dir.join("device-key.blob")).unwrap();
        f.write_all(b"synthetic-device-blob").unwrap();
    }
    #[test]
    fn unentitled_device_blob_stays_enclave_wrapped_on_disk_until_entitled_signing() {
        let dir = tempfile::tempdir().unwrap();
        legacy(dir.path());
        let unavailable = Memory { read_error: true, write_error: true, ..Default::default() };
        for _ in 0..2 {
            assert_eq!(load_selected(dir.path(), &unavailable, false).unwrap().unwrap().as_slice(), b"synthetic-device-blob");
            assert!(dir.path().join(LEGACY).is_file());
            assert!(!dir.path().join(MARKER).exists());
        }
        let entitled = Memory::default();
        assert_eq!(load_selected(dir.path(), &entitled, true).unwrap().unwrap().as_slice(), b"synthetic-device-blob");
        assert!(!dir.path().join(LEGACY).exists());
        assert!(load_selected(dir.path(), &unavailable, false).is_err());
    }
    #[test]
    fn migration_verifies_preserves_and_removes_legacy_material() {
        let dir = tempfile::tempdir().unwrap();
        legacy(dir.path());
        let store = Memory::default();
        assert_eq!(load(dir.path(), &store).unwrap().unwrap().as_slice(), b"synthetic-device-blob");
        assert!(!dir.path().join("device-key.blob").exists());
        assert!(dir.path().join("device-key.keychain").is_file());
        assert_eq!(load(dir.path(), &store).unwrap().unwrap().as_slice(), b"synthetic-device-blob");
    }
    #[test]
    fn migration_retires_leftover_temporary_device_material() {
        let dir = tempfile::tempdir().unwrap();
        legacy(dir.path());
        std::fs::copy(dir.path().join("device-key.blob"), dir.path().join("device-key.blob.tmp")).unwrap();
        assert!(load(dir.path(), &Memory::default()).unwrap().is_some());
        assert!(!dir.path().join("device-key.blob.tmp").exists());
    }
    #[test]
    fn interrupted_temporary_write_is_not_treated_as_a_new_identity() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("device-key.blob.tmp"), b"partial").unwrap();
        assert!(load(dir.path(), &Memory::default()).is_err());
    }
    #[test]
    fn denial_write_or_verification_failure_keeps_legacy_and_returns_no_key() {
        for store in [Memory { read_error: true, ..Default::default() },
            Memory { write_error: true, ..Default::default() },
            Memory { corrupt: true, ..Default::default() }] {
            let dir = tempfile::tempdir().unwrap();
            legacy(dir.path());
            assert!(load(dir.path(), &store).is_err());
            assert_eq!(std::fs::read(dir.path().join("device-key.blob")).unwrap(), b"synthetic-device-blob");
        }
    }
    #[test]
    fn missing_protected_item_with_marker_never_creates_replacement() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("device-key.keychain"), b"marker").unwrap();
        assert!(load(dir.path(), &Memory::default()).is_err());
    }
    #[test]
    fn cleanup_failure_returns_no_key_and_retry_finishes_same_identity() {
        let dir = tempfile::tempdir().unwrap();
        legacy(dir.path());
        std::fs::create_dir(dir.path().join("device-key.keychain")).unwrap();
        let store = Memory::default();
        assert!(load(dir.path(), &store).is_err());
        assert!(dir.path().join("device-key.blob").is_file());
        std::fs::remove_dir(dir.path().join("device-key.keychain")).unwrap();
        assert_eq!(load(dir.path(), &store).unwrap().unwrap().as_slice(), b"synthetic-device-blob");
    }
}
