//! Windows storage for the client identity, on the private-file layer.
//!
//! Only a sealed identity is ever stored. Without an installed sealer, or with
//! a plaintext key file present (Windows never writes one), nothing is
//! created or changed. The sealed file is read through one verified handle
//! and written as a new private scratch file that is reopened through the
//! same handle before it is published by handle, never replacing an existing
//! sealed key.

use std::path::Path;

use zeroize::Zeroizing;

use super::{nothing_at, ClientKey, KEY_FILE, MAX_SEALED_KEY_BYTES};
use crate::at_rest::{self, Sealer};
use crate::pairing::PairError;

/// Where plaintext storage is never allowed and no sealer is installed.
pub(crate) const NO_PROTECTED_STORAGE: &str =
    "protected storage is unavailable on this device; nothing was saved";

/// `ClientKey::load_or_create` on Windows.
pub(super) fn load_or_create(dir: &Path) -> Result<ClientKey, PairError> {
    let sealer =
        at_rest::installed().ok_or_else(|| PairError::Local(NO_PROTECTED_STORAGE.into()))?;
    if !nothing_at(&dir.join(KEY_FILE)) {
        return Err(PairError::Local(
            "an unexpected client key file is present; nothing was changed".into(),
        ));
    }
    ClientKey::load_or_create_sealed(dir, sealer)
}

/// Create `dir` as a private folder (protected descriptor, current user
/// only), or verify an existing one. A folder in any other state is refused.
pub(crate) fn restrict_dir(dir: &Path) -> Result<(), PairError> {
    crate::private_fs::ensure_dir(dir)
        .map_err(|e| PairError::Local(format!("cannot create {}: {e}", dir.display())))
}

pub(super) fn sealed_seed(
    path: &Path,
    sealer: &dyn Sealer,
) -> Result<Zeroizing<[u8; 32]>, PairError> {
    let ciphertext = crate::private_fs::read(path, MAX_SEALED_KEY_BYTES)
        .map_err(|e| PairError::Local(format!("cannot read the protected client key: {e}")))?;
    open_seed(&ciphertext, sealer)
}

fn open_seed(ciphertext: &[u8], sealer: &dyn Sealer) -> Result<Zeroizing<[u8; 32]>, PairError> {
    let opened = sealer
        .open(at_rest::CLIENT_SEED_PURPOSE, ciphertext)
        .map_err(|e| {
            PairError::Local(format!(
                "this device cannot open its protected client key: {e}"
            ))
        })?;
    let seed: [u8; 32] = opened
        .as_slice()
        .try_into()
        .map_err(|_| PairError::Local("the protected client key is corrupt".into()))?;
    Ok(Zeroizing::new(seed))
}

/// Seal, write a new private scratch file, reopen it through the same
/// handle, and publish it by handle without replacing an existing sealed key.
pub(super) fn write_verified_seed(
    path: &Path,
    seed: &[u8; 32],
    sealer: &dyn Sealer,
) -> Result<(), PairError> {
    let ciphertext = sealer
        .seal(at_rest::CLIENT_SEED_PURPOSE, seed)
        .map_err(|e| PairError::Local(format!("cannot protect the client key: {e}")))?;
    crate::private_fs::write_checked(
        &path.with_extension("sealed.tmp"),
        path,
        &ciphertext,
        false,
        |e| PairError::Local(format!("cannot write the protected client key: {e}")),
        |readback| {
            if *open_seed(readback, sealer)? != *seed {
                return Err(PairError::Local(
                    "the protected client key does not reopen to the same key".into(),
                ));
            }
            Ok(())
        },
    )
}

#[cfg(test)]
mod tests {
    use super::super::SEALED_KEY_FILE;
    use super::*;
    use crate::at_rest::test_sealer::MemorySealer;
    use crate::private_fs::fixtures::*;

    fn names(dir: &Path) -> Vec<std::ffi::OsString> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect()
    }

    #[test]
    fn no_sealer_is_an_error_and_writes_nothing() {
        assert!(
            at_rest::installed().is_none(),
            "tests never install a global sealer"
        );
        let dir = temp_root("no-sealer").join("app-client");
        let error = ClientKey::load_or_create(&dir).unwrap_err();
        assert!(error.to_string().contains(NO_PROTECTED_STORAGE), "{error}");
        assert!(nothing_at(&dir), "no folder or file is created");
    }

    #[test]
    fn the_sealed_identity_round_trips_on_private_storage() {
        if elevated() {
            return;
        }
        let store = temp_root("client-key").join("app-client");
        let key = ClientKey::load_or_create_sealed(&store, &MemorySealer).unwrap();
        let again = ClientKey::load_or_create_sealed(&store, &MemorySealer).unwrap();
        assert_eq!(again.public_hex(), key.public_hex());
        assert_eq!(names(&store), [SEALED_KEY_FILE]);
    }

    #[test]
    fn a_tampered_sealed_identity_is_refused_and_left_unchanged() {
        if elevated() {
            return;
        }
        let root = temp_root("client-key-tampered");
        let store = root.join("app-client");
        ClientKey::load_or_create_sealed(&store, &MemorySealer).unwrap();
        let sealed = store.join(SEALED_KEY_FILE);
        let bytes = std::fs::read(&sealed).unwrap();
        // Extra access entry.
        grant_everyone_read(&sealed);
        assert!(ClientKey::load_or_create_sealed(&store, &MemorySealer).is_err());
        assert_eq!(std::fs::read(&sealed).unwrap(), bytes);
        // Reparse point: the store folder is a junction to a real store.
        let link = root.join("link");
        junction(&link, &store);
        assert!(ClientKey::load_or_create_sealed(&link, &MemorySealer).is_err());
        assert_eq!(std::fs::read(&sealed).unwrap(), bytes);
        // Wrong owner: a system folder is never accepted as the store.
        let foreign = foreign_owned_dir();
        assert!(ClientKey::load_or_create_sealed(&foreign, &MemorySealer).is_err());
        assert!(nothing_at(&foreign.join(SEALED_KEY_FILE)));
    }

    #[test]
    fn a_planted_plaintext_key_or_leftover_scratch_is_refused() {
        if elevated() {
            return;
        }
        let store = temp_root("client-key-planted").join("app-client");
        restrict_dir(&store).unwrap();
        std::fs::write(store.join(KEY_FILE), "11".repeat(32)).unwrap();
        assert!(ClientKey::load_or_create_sealed(&store, &MemorySealer).is_err());
        assert!(nothing_at(&store.join(SEALED_KEY_FILE)));
        assert_eq!(
            std::fs::read_to_string(store.join(KEY_FILE)).unwrap(),
            "11".repeat(32)
        );

        let clean = temp_root("client-key-scratch").join("app-client");
        restrict_dir(&clean).unwrap();
        let scratch = clean.join(SEALED_KEY_FILE).with_extension("sealed.tmp");
        std::fs::write(&scratch, b"leftover").unwrap();
        assert!(ClientKey::load_or_create_sealed(&clean, &MemorySealer).is_err());
        assert_eq!(std::fs::read(&scratch).unwrap(), b"leftover");
        assert!(nothing_at(&clean.join(SEALED_KEY_FILE)));
    }
}
