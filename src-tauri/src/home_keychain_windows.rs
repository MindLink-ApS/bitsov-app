//! Windows storage for the two public home-node records (box pin and unlock
//! binding), as owner-only files on the private-file layer under
//! `app-client/home-node-store-v1/<blake3(node)>/`. Secrets, device blobs and
//! every other item still require protected device storage.
//!
//! Reads go through one verified handle. A replacement first verifies the
//! existing record; a record in any other state is refused and left as is.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use zeroize::Zeroizing;

static PAIRING_STORE: OnceLock<PathBuf> = OnceLock::new();
const MAX_RECORD_BYTES: u64 = 16384;
const REFUSED: &str = "Home-node unlock requires protected device storage.";

/// Set once at startup to the private pairing folder (`app-client`).
pub fn set_pairing_store(store: &Path) -> Result<(), String> {
    PAIRING_STORE
        .set(store.to_path_buf())
        .map_err(|_| "Home-node storage was set up twice.".into())
}

fn pairing_store() -> Result<&'static Path, String> {
    PAIRING_STORE
        .get()
        .map(PathBuf::as_path)
        .ok_or_else(|| REFUSED.into())
}

/// Called after the node id was validated by the caller.
pub fn store(
    node: &str,
    suffix: &str,
    bytes: &[u8],
    secret: bool,
    device_blob: Option<&[u8]>,
) -> Result<(), String> {
    store_in(pairing_store()?, node, suffix, bytes, secret, device_blob)
}

pub fn read(
    node: &str,
    suffix: &str,
    secret: bool,
    device_blob: Option<&[u8]>,
) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
    read_in(pairing_store()?, node, suffix, secret, device_blob)
}

/// The record's folder and file, or the usual refusal for anything that is
/// not one of the two public records.
fn record(
    store: &Path,
    node: &str,
    suffix: &str,
    secret: bool,
    device_blob: Option<&[u8]>,
) -> Result<(PathBuf, PathBuf), String> {
    if secret || device_blob.is_some() || !matches!(suffix, "box-transport" | "unlock-binding") {
        return Err(REFUSED.into());
    }
    let dir = store
        .join("home-node-store-v1")
        .join(blake3::hash(node.as_bytes()).to_hex().as_str());
    let file = dir.join(format!("{suffix}.json"));
    Ok((dir, file))
}

fn store_in(
    store: &Path,
    node: &str,
    suffix: &str,
    bytes: &[u8],
    secret: bool,
    device_blob: Option<&[u8]>,
) -> Result<(), String> {
    let (dir, file) = record(store, node, suffix, secret, device_blob)?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_RECORD_BYTES {
        return Err("Invalid home-node item.".into());
    }
    let refused = |_| "Could not save the home-node item in private storage.".to_string();
    // Each level gets its own protected descriptor; none is inherited.
    for level in [
        store.to_path_buf(),
        store.join("home-node-store-v1"),
        dir.clone(),
    ] {
        crate::private_fs::ensure_dir(&level).map_err(refused)?;
    }
    crate::private_fs::write_replacing_verified(
        &dir.join(format!("{suffix}.json.tmp")),
        &file,
        bytes,
        refused,
        |_| Ok(()),
    )
}

fn read_in(
    store: &Path,
    node: &str,
    suffix: &str,
    secret: bool,
    device_blob: Option<&[u8]>,
) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
    let (_, file) = record(store, node, suffix, secret, device_blob)?;
    crate::private_fs::read_optional(&file, MAX_RECORD_BYTES)
        .map_err(|_| "Could not read the home-node item from private storage.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::private_fs::fixtures::*;

    const NODE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn app_client(name: &str) -> PathBuf {
        temp_root(name).join("app-client")
    }

    #[test]
    fn public_records_round_trip_and_secrets_stay_refused() {
        if elevated() {
            return;
        }
        let store = app_client("home-round-trip");
        for suffix in ["box-transport", "unlock-binding"] {
            assert!(read_in(&store, NODE, suffix, false, None)
                .unwrap()
                .is_none());
            store_in(&store, NODE, suffix, b"{\"v\":1}", false, None).unwrap();
            store_in(&store, NODE, suffix, b"{\"v\":2}", false, None).unwrap();
            let read = read_in(&store, NODE, suffix, false, None).unwrap().unwrap();
            assert_eq!(read.as_slice(), b"{\"v\":2}");
        }
        for (suffix, secret, blob) in [
            ("seed-password", true, None),
            ("box-transport", true, None),
            ("unlock-binding", false, Some(&b"blob"[..])),
            ("other", false, None),
        ] {
            assert!(store_in(&store, NODE, suffix, b"x", secret, blob).is_err());
            assert!(read_in(&store, NODE, suffix, secret, blob).is_err());
        }
    }

    #[test]
    fn tampered_records_are_refused_for_reading_and_left_unchanged() {
        if elevated() {
            return;
        }
        let store = app_client("home-read-tampered");
        store_in(&store, NODE, "unlock-binding", b"{}", false, None).unwrap();
        let (_, file) = record(&store, NODE, "unlock-binding", false, None).unwrap();
        grant_everyone_read(&file);
        assert!(read_in(&store, NODE, "unlock-binding", false, None).is_err());
        assert_eq!(std::fs::read(&file).unwrap(), b"{}");
    }

    #[test]
    fn a_tampered_destination_is_never_overwritten() {
        if elevated() {
            return;
        }
        // Extra access entry on the existing record.
        let store = app_client("home-overwrite-acl");
        store_in(&store, NODE, "box-transport", b"{\"old\":1}", false, None).unwrap();
        let (dir, file) = record(&store, NODE, "box-transport", false, None).unwrap();
        grant_everyone_read(&file);
        assert!(store_in(&store, NODE, "box-transport", b"{\"new\":1}", false, None).is_err());
        assert_eq!(std::fs::read(&file).unwrap(), b"{\"old\":1}");
        assert!(crate::pairing::key::nothing_at(
            &dir.join("box-transport.json.tmp")
        ));

        // An ordinary file that inherits its access list.
        let store = app_client("home-overwrite-plain");
        store_in(&store, NODE, "unlock-binding", b"{}", false, None).unwrap();
        let (dir, file) = record(&store, NODE, "unlock-binding", false, None).unwrap();
        let planted = dir.join("planted");
        std::fs::write(&planted, b"planted").unwrap();
        std::fs::rename(&planted, &file).unwrap();
        assert!(store_in(&store, NODE, "unlock-binding", b"{\"new\":1}", false, None).is_err());
        assert_eq!(std::fs::read(&file).unwrap(), b"planted");

        // A second name for another file (hard link).
        let store = app_client("home-overwrite-link");
        store_in(&store, NODE, "box-transport", b"{}", false, None).unwrap();
        store_in(
            &store,
            NODE,
            "unlock-binding",
            b"{\"canary\":1}",
            false,
            None,
        )
        .unwrap();
        let (_, pin) = record(&store, NODE, "box-transport", false, None).unwrap();
        let (_, canary) = record(&store, NODE, "unlock-binding", false, None).unwrap();
        std::fs::rename(&canary, &pin).unwrap();
        std::fs::hard_link(&pin, &canary).unwrap();
        assert!(store_in(&store, NODE, "box-transport", b"{\"new\":1}", false, None).is_err());
        assert_eq!(std::fs::read(&pin).unwrap(), b"{\"canary\":1}");
        assert_eq!(std::fs::read(&canary).unwrap(), b"{\"canary\":1}");

        // A leftover scratch file blocks a save instead of being reused.
        let store = app_client("home-overwrite-scratch");
        store_in(&store, NODE, "unlock-binding", b"{}", false, None).unwrap();
        let (dir, file) = record(&store, NODE, "unlock-binding", false, None).unwrap();
        std::fs::write(dir.join("unlock-binding.json.tmp"), b"leftover").unwrap();
        assert!(store_in(&store, NODE, "unlock-binding", b"{\"new\":1}", false, None).is_err());
        assert_eq!(
            std::fs::read(dir.join("unlock-binding.json.tmp")).unwrap(),
            b"leftover"
        );
        assert_eq!(std::fs::read(&file).unwrap(), b"{}");
    }

    #[test]
    fn junctions_and_foreign_owners_are_refused() {
        if elevated() {
            return;
        }
        let root = temp_root("home-junction");
        let store = root.join("app-client");
        store_in(&store, NODE, "box-transport", b"{}", false, None).unwrap();
        let link = root.join("link");
        junction(&link, &store);
        assert!(store_in(&link, NODE, "box-transport", b"{\"x\":1}", false, None).is_err());
        let (_, file) = record(&store, NODE, "box-transport", false, None).unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"{}");
        assert!(store_in(
            &foreign_owned_dir(),
            NODE,
            "box-transport",
            b"{}",
            false,
            None
        )
        .is_err());
    }
}
