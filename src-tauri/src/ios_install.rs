//! iOS install lifetime, independent of the Keychain's longer lifetime.
use std::path::Path;
use std::{fs, io};

const MARKER: &str = ".ios-setup-complete";
const CLIENT_DIR: &str = "app-client";

// An upgrade may predate our marker. Protect *any* surviving app data, including
// corrupt, unknown or incomplete pairing records. Only the legacy key by itself
// is an orphan: it is not proof of a completed install or an existing pairing.
fn fresh(root: &Path) -> io::Result<bool> {
    if !fs::symlink_metadata(root)?.is_dir() {
        return Err(io::Error::other("invalid app data directory"));
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if entry.file_name() != CLIENT_DIR || !entry.file_type()?.is_dir() {
            return Ok(false);
        }
        for child in fs::read_dir(entry.path())? {
            let child = child?;
            if child.file_name() != crate::pairing::KEY_FILE || !child.file_type()?.is_file() {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

/// Run synchronously at startup, before any command or background pairing task.
/// Failure must abort setup. No completion marker is written here, so deletion
/// and unlink can safely repeat after a crash or any later setup failure.
pub(crate) fn prepare(root: &Path, delete_identity: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|_| "cannot create app data directory")?;
    if !fresh(root).map_err(|_| "cannot inspect app data for fresh-install cleanup")? {
        return Ok(());
    }
    delete_identity()?;
    // Unlink without reading, decoding or overwriting key material. In
    // particular a malformed/partly wiped legacy file must not block recovery.
    let client = root.join(CLIENT_DIR);
    match fs::remove_file(client.join(crate::pairing::KEY_FILE)) {
        Ok(()) => (),
        Err(e) if e.kind() == io::ErrorKind::NotFound => (),
        Err(_) => return Err("cannot remove orphaned legacy client key; retry setup".into()),
    }
    // Also sync on retry after an unlink whose directory sync was interrupted.
    match fs::File::open(&client) {
        Ok(dir) => dir.sync_all().map_err(|_| "cannot sync fresh-install legacy cleanup")?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => (),
        Err(_) => return Err("cannot open fresh-install client directory".into()),
    }
    Ok(())
}

/// Publish only after successful synchronous setup, before enabling pairing.
/// The parent is excluded from backups by the iOS startup caller.
pub(crate) fn complete(root: &Path) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    let marker = root.join(MARKER);
    match fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&marker) {
        Ok(file) => file.sync_all().map_err(|_| "cannot sync iOS setup marker")?,
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            if !fs::symlink_metadata(&marker).map_err(|_| "cannot inspect iOS setup marker")?.is_file() {
                return Err("invalid iOS setup marker".into());
            }
        }
        Err(_) => return Err("cannot create iOS setup marker".into()),
    }
    fs::File::open(root).and_then(|f| f.sync_all())
        .map_err(|_| "cannot sync iOS setup directory".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::fs;

    #[test]
    fn absent_or_empty_app_directory_clears_surviving_identity() {
        for exists in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().join("app-data");
            if exists { fs::create_dir(&root).unwrap(); }
            let deleted = Cell::new(false);
            prepare(&root, || { deleted.set(true); Ok(()) }).unwrap();
            assert!(deleted.get());
            complete(&root).unwrap();
            prepare(&root, || panic!("even unpaired completed installs keep their identity")).unwrap();
        }
    }

    #[test]
    fn fresh_install_deletes_identity_and_legacy_before_marking_setup() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("app-client");
        fs::create_dir(&store).unwrap();
        // Deliberately not a valid seed: fresh-install cleanup must not read it.
        let legacy = store.join(crate::pairing::KEY_FILE);
        fs::write(&legacy, b"interrupted legacy artifact").unwrap();
        let deleted = Cell::new(false);
        prepare(dir.path(), || { deleted.set(true); Ok(()) }).unwrap();
        assert!(deleted.get());
        assert!(!legacy.exists());
        assert!(!dir.path().join(MARKER).exists());
        complete(dir.path()).unwrap();
        assert!(dir.path().join(MARKER).is_file());
        prepare(dir.path(), || panic!("completed install must retain identity")).unwrap();
    }

    #[test]
    fn existing_or_unrecognized_data_keeps_identity_even_without_setup_marker() {
        for path in ["app-client/pairing.json", "app-client/client-ed25519.keychain",
            "app-client/client-ed25519.sealed", "remote-access/descriptor.json",
            "device-key.json", "unknown-future-state", MARKER] {
            let dir = tempfile::tempdir().unwrap();
            let state = dir.path().join(path);
            fs::create_dir_all(state.parent().unwrap()).unwrap();
            fs::write(&state, b"state need not be valid to protect it").unwrap();
            let store = dir.path().join("app-client");
            fs::create_dir_all(&store).unwrap();
            let legacy = store.join(crate::pairing::KEY_FILE);
            fs::write(&legacy, b"legacy artifact").unwrap();
            prepare(dir.path(), || panic!("existing data must retain identity")).unwrap();
            assert!(legacy.exists());
            assert!(state.exists());
            complete(dir.path()).unwrap();
        }
    }

    #[test]
    fn cleanup_error_leaves_legacy_and_no_completion_marker() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("app-client");
        fs::create_dir(&store).unwrap();
        let legacy = store.join(crate::pairing::KEY_FILE);
        fs::write(&legacy, b"artifact").unwrap();
        assert!(prepare(dir.path(), || Err("locked".into())).is_err());
        assert!(legacy.exists());
        assert!(!dir.path().join(MARKER).exists());
    }

    #[test]
    fn retries_after_crash_at_each_cleanup_boundary() {
        // Keychain deleted, legacy removed, cleanup finished but setup failed.
        for boundary in 0..3 {
            let dir = tempfile::tempdir().unwrap();
            let store = dir.path().join("app-client");
            fs::create_dir(&store).unwrap();
            let legacy = store.join(crate::pairing::KEY_FILE);
            fs::write(&legacy, b"artifact").unwrap();
            let keychain_present = Cell::new(true);
            let delete = || { keychain_present.set(false); Ok(()) };
            if boundary == 0 {
                assert!(prepare(dir.path(), || {
                    delete()?;
                    Err("interrupted after deletion".into())
                }).is_err());
            } else if boundary == 1 {
                delete().unwrap();
                fs::remove_file(&legacy).unwrap();
            } else {
                prepare(dir.path(), delete).unwrap();
            }
            assert!(!dir.path().join(MARKER).exists());
            prepare(dir.path(), delete).unwrap();
            assert!(!keychain_present.get());
            assert!(!legacy.exists());
            complete(dir.path()).unwrap();
            // A newly created identity on this install must now survive restart.
            keychain_present.set(true);
            prepare(dir.path(), delete).unwrap();
            assert!(keychain_present.get());
        }
    }

    #[test]
    fn linked_or_unreadable_layout_is_never_treated_as_fresh() {
        let dir = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(other.path(), dir.path().join("app-client")).unwrap();
        prepare(dir.path(), || panic!("must not clean through a link")).unwrap();
        let invalid = dir.path().join("not-a-directory");
        fs::write(&invalid, b"invalid").unwrap();
        assert!(prepare(&invalid, || panic!("must not clean uninspectable data")).is_err());
    }

    #[test]
    fn pairing_data_after_interrupted_setup_always_prevents_cleanup() {
        let dir = tempfile::tempdir().unwrap();
        prepare(dir.path(), || Ok(())).unwrap();
        let store = dir.path().join("app-client");
        fs::create_dir(&store).unwrap();
        fs::write(store.join(crate::pairing::RECORD_FILE), b"interrupted pairing").unwrap();
        assert!(!dir.path().join(MARKER).exists());
        prepare(dir.path(), || panic!("pairing state wins even without completion marker")).unwrap();
    }
}
