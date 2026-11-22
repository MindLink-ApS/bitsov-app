//! App-owned disclosure acknowledgement, kept beside the pairing record.
use serde::{Deserialize, Serialize};
#[cfg(not(windows))]
use std::io::{ErrorKind, Write};
use std::path::Path;

const FILE: &str = "trust-v1.json";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Acknowledgement {
    node_id: String,
    remote: bool,
}

/// Windows: read through one verified handle; any other state is refused.
#[cfg(windows)]
fn load(store: &Path) -> Result<Option<Acknowledgement>, String> {
    match crate::private_fs::read_optional(&store.join(FILE), 4096) {
        Ok(Some(bytes)) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| "Could not read trust acknowledgement.".into()),
        Ok(None) => Ok(None),
        Err(_) => Err("Could not read trust acknowledgement.".into()),
    }
}

#[cfg(not(windows))]
fn load(store: &Path) -> Result<Option<Acknowledgement>, String> {
    match std::fs::read(store.join(FILE)) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| "Could not read trust acknowledgement.".into()),
        Err(e) if e.kind() == ErrorKind::NotFound && crate::pairing::key::nothing_at(&store.join(FILE)) => Ok(None),
        Err(_) => Err("Could not read trust acknowledgement.".into()),
    }
}

pub fn acknowledged(store: &Path, node_id: &str, remote: bool) -> Result<bool, String> {
    Ok(load(store)?
        .is_some_and(|ack| ack.remote == remote && ack.node_id.eq_ignore_ascii_case(node_id)))
}

/// Legacy webview flags may seed an absent record, but never replace a durable
/// acknowledgement for another trust boundary. Callers serialize writes.
pub fn acknowledge(
    store: &Path,
    node_id: &str,
    remote: bool,
    legacy: bool,
) -> Result<bool, String> {
    if legacy {
        if let Some(ack) = load(store)? {
            return Ok(ack.remote == remote && ack.node_id.eq_ignore_ascii_case(node_id));
        }
    }
    let ack = Acknowledgement {
        node_id: node_id.to_ascii_lowercase(),
        remote,
    };
    #[cfg(windows)]
    let save = || -> Result<(), Box<dyn std::error::Error>> {
        crate::pairing::key::restrict_dir(store)?;
        crate::private_fs::write_replacing_verified(
            &store.join(format!("{FILE}.tmp")),
            &store.join(FILE),
            &serde_json::to_vec(&ack)?,
            |error| error,
            |_| Ok(()),
        )?;
        Ok(())
    };
    #[cfg(not(windows))]
    let save = || -> Result<(), Box<dyn std::error::Error>> {
        crate::pairing::key::restrict_dir(store)?;
        let mut tmp = tempfile::NamedTempFile::new_in(store)?;
        tmp.write_all(&serde_json::to_vec(&ack)?)?;
        tmp.as_file().sync_all()?;
        tmp.persist(store.join(FILE))?;
        Ok(())
    };
    save().map_err(|_| "Could not save trust acknowledgement.".to_string())?;
    Ok(true)
}

#[cfg(all(test, windows))]
mod windows_store_tests {
    use super::*;
    use crate::private_fs::fixtures::*;

    #[test]
    fn the_acknowledgement_round_trips_and_tampering_is_refused() {
        if elevated() {
            return;
        }
        let root = temp_root("trust");
        let store = root.join("app-client");
        assert!(!acknowledged(&store, "abcd", true).unwrap());
        acknowledge(&store, "ABCD", true, false).unwrap();
        acknowledge(&store, "ABCD", true, false).unwrap();
        assert!(acknowledged(&store, "abcd", true).unwrap());
        let path = store.join(FILE);
        let bytes = std::fs::read(&path).unwrap();
        grant_everyone_read(&path);
        assert!(acknowledged(&store, "abcd", true).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        // A plainly created file inherits its access list: refused.
        let plain = root.join("plain");
        crate::pairing::key::restrict_dir(&plain).unwrap();
        std::fs::write(plain.join(FILE), b"{\"node_id\":\"abcd\",\"remote\":true}").unwrap();
        assert!(acknowledged(&plain, "abcd", true).is_err());
        // Reparse point as the store folder.
        let link = root.join("link");
        junction(&link, &store);
        assert!(acknowledge(&link, "abcd", true, false).is_err());
        assert!(acknowledge(&foreign_owned_dir(), "abcd", true, false).is_err());
    }

    #[test]
    fn a_tampered_acknowledgement_is_never_overwritten() {
        if elevated() {
            return;
        }
        // Extra access entry on the existing acknowledgement.
        let store = temp_root("trust-overwrite-acl").join("app-client");
        acknowledge(&store, "aaaa", true, false).unwrap();
        let path = store.join(FILE);
        let bytes = std::fs::read(&path).unwrap();
        grant_everyone_read(&path);
        assert!(acknowledge(&store, "bbbb", true, false).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert!(crate::pairing::key::nothing_at(&store.join(format!("{FILE}.tmp"))));

        // An ordinary file that inherits its access list.
        let store = temp_root("trust-overwrite-plain").join("app-client");
        acknowledge(&store, "aaaa", true, false).unwrap();
        let path = store.join(FILE);
        let planted = store.join("planted");
        std::fs::write(&planted, b"planted").unwrap();
        std::fs::rename(&planted, &path).unwrap();
        assert!(acknowledge(&store, "bbbb", true, false).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"planted");

        // A second name for another file (hard link).
        let store = temp_root("trust-overwrite-link").join("app-client");
        acknowledge(&store, "aaaa", true, false).unwrap();
        let path = store.join(FILE);
        let bytes = std::fs::read(&path).unwrap();
        let alias = store.join("alias");
        std::fs::hard_link(&path, &alias).unwrap();
        assert!(acknowledge(&store, "bbbb", true, false).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert_eq!(std::fs::read(&alias).unwrap(), bytes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reinstall_preserves_acknowledgement_beside_existing_pairing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("pairing.json"), "existing pairing").unwrap();
        acknowledge(dir.path(), "ABCD", true, false).unwrap();
        // No renderer or process state is needed to reopen the durable record.
        assert!(acknowledged(dir.path(), "abcd", true).unwrap());
        assert_eq!(
            std::fs::read_to_string(dir.path().join("pairing.json")).unwrap(),
            "existing pairing"
        );
    }

    #[test]
    fn new_node_or_mode_requires_acknowledgement() {
        let dir = tempfile::tempdir().unwrap();
        acknowledge(dir.path(), "abcd", true, false).unwrap();
        assert!(!acknowledged(dir.path(), "cdef", true).unwrap());
        assert!(!acknowledged(dir.path(), "abcd", false).unwrap());
        assert!(!acknowledge(dir.path(), "cdef", true, true).unwrap());
        acknowledge(dir.path(), "cdef", true, false).unwrap();
        assert!(acknowledged(dir.path(), "cdef", true).unwrap());
        assert!(!acknowledged(dir.path(), "abcd", true).unwrap());
    }

    #[test]
    fn fresh_install_and_pairing_alone_do_not_imply_consent() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!acknowledged(dir.path(), "abcd", true).unwrap());
        std::fs::write(dir.path().join("pairing.json"), "existing pairing").unwrap();
        assert!(!acknowledged(dir.path(), "abcd", true).unwrap());
    }

    #[test]
    fn migration_is_idempotent_and_does_not_override_another_node() {
        let dir = tempfile::tempdir().unwrap();
        assert!(acknowledge(dir.path(), "ABCD", true, true).unwrap());
        assert!(acknowledge(dir.path(), "abcd", true, true).unwrap());
        assert!(!acknowledge(dir.path(), "cdef", true, true).unwrap());
        assert!(acknowledged(dir.path(), "abcd", true).unwrap());
    }

    #[test]
    fn invalid_record_and_failed_write_never_report_acceptance() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(FILE), "broken").unwrap();
        assert!(acknowledged(dir.path(), "abcd", true).is_err());
        assert!(acknowledge(dir.path(), "abcd", true, true).is_err());
        assert!(acknowledge(&dir.path().join(FILE), "abcd", true, false).is_err());
    }
}
