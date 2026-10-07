//! The app-held Ed25519 client key.
//!
//! Desktop: stored as a hex seed in a `0600` file inside a `0700` directory
//! under the app data dir. No OS keychain in this step: any process running as
//! the same OS user can read this file. That is the documented limit of the
//! tier (docs/ONBOARDING_PAIRING.md) — less exposure, not solved local security.
//!
//! Android installs an [`at_rest::Sealer`]: the seed is then kept only as
//! Keystore ciphertext in [`SEALED_KEY_FILE`], and a plain [`KEY_FILE`] left
//! by an older build is sealed once, verified, and deleted.

use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

use ed25519_dalek::{Signer, SigningKey};
use zeroize::Zeroizing;

use super::PairError;
use crate::at_rest::{self, Sealer};

/// File name of the client key inside the pairing store directory.
pub const KEY_FILE: &str = "client-ed25519.key";
/// The seed sealed by the installed [`at_rest::Sealer`]. Never plaintext.
pub const SEALED_KEY_FILE: &str = "client-ed25519.sealed";
const MAX_SEALED_KEY_BYTES: u64 = 1024;
static SEALED_KEY_LOCK: Mutex<()> = Mutex::new(());

/// The client signing key. `Debug` never prints key material.
pub struct ClientKey {
    signing: SigningKey,
    public_hex: String,
}

impl std::fmt::Debug for ClientKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClientKey")
            .field("public_hex", &self.public_hex)
            .finish_non_exhaustive()
    }
}

impl ClientKey {
    /// Load the key from `dir`, generating it on first run.
    ///
    /// Refuses a key file readable or writable by group or others rather than
    /// silently tightening it: a loosened mode means something else touched it.
    pub fn load_or_create(dir: &Path) -> Result<Self, PairError> {
        match at_rest::installed() {
            Some(sealer) => Self::load_or_create_sealed(dir, sealer),
            None => Self::load_or_create_plain(dir),
        }
    }

    fn load_or_create_plain(dir: &Path) -> Result<Self, PairError> {
        restrict_dir(dir)?;
        let path = dir.join(KEY_FILE);
        match create_new_protected(&path) {
            Ok(mut file) => {
                let mut seed = [0u8; 32];
                getrandom::getrandom(&mut seed)
                    .map_err(|e| PairError::Local(format!("no randomness for the client key: {e}")))?;
                let written = file
                    .write_all(hex::encode(seed).as_bytes())
                    .and_then(|()| file.sync_all());
                if let Err(e) = written {
                    let _ = std::fs::remove_file(&path);
                    return Err(PairError::Local(format!("cannot write the client key: {e}")));
                }
                Ok(Self::from_seed(seed))
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Self::load(&path),
            Err(e) => Err(PairError::Local(format!("cannot create the client key: {e}"))),
        }
    }

    fn load(path: &Path) -> Result<Self, PairError> {
        Ok(Self::from_seed(*plain_seed(path)?))
    }

    /// The seed exists on disk only as `sealer` ciphertext. A plain key file is
    /// migrated once: sealed, reopened and compared, then wiped and deleted.
    /// Once a sealed file exists it is authoritative.
    pub(crate) fn load_or_create_sealed(dir: &Path, sealer: &dyn Sealer) -> Result<Self, PairError> {
        let _sealed_key = SEALED_KEY_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        restrict_dir(dir)?;
        let sealed = dir.join(SEALED_KEY_FILE);
        let plain = dir.join(KEY_FILE);
        let written = if sealed.exists() {
            None
        } else {
            let seed = if plain.exists() {
                plain_seed(&plain)?
            } else {
                let mut seed = Zeroizing::new([0u8; 32]);
                getrandom::getrandom(&mut seed[..])
                    .map_err(|e| PairError::Local(format!("no randomness for the client key: {e}")))?;
                seed
            };
            let ciphertext = sealer
                .seal(at_rest::CLIENT_SEED_PURPOSE, &seed[..])
                .map_err(|e| PairError::Local(format!("cannot protect the client key: {e}")))?;
            write_replacing(&sealed, &ciphertext)
                .map_err(|e| PairError::Local(format!("cannot write the protected client key: {e}")))?;
            Some(seed)
        };
        let seed = sealed_seed(&sealed, sealer)?;
        if written.is_some_and(|written| *written != *seed) {
            return Err(PairError::Local(
                "the protected client key does not reopen to the same key".into(),
            ));
        }
        if plain.exists() {
            discard(&plain)?;
        }
        Ok(Self::from_seed(*seed))
    }

    fn from_seed(seed: [u8; 32]) -> Self {
        let signing = SigningKey::from_bytes(&seed);
        let public_hex = hex::encode(signing.verifying_key().as_bytes());
        Self {
            signing,
            public_hex,
        }
    }

    /// Lowercase hex of the 32-byte public key, as the node expects it.
    pub fn public_hex(&self) -> &str {
        &self.public_hex
    }

    /// Hex Ed25519 signature over `message`.
    pub(crate) fn sign_hex(&self, message: &[u8]) -> String {
        hex::encode(self.signing.sign(message).to_bytes())
    }

    /// Raw signature bytes for protocols with their own canonical encoding.
    pub(crate) fn sign_bytes(&self, message: &[u8]) -> [u8; 64] {
        self.signing.sign(message).to_bytes()
    }

    /// Borrow a short-lived copy of the Ed25519 seed for domain-separated key
    /// derivation. The copy is cleared before returning.
    pub(crate) fn with_seed<R>(&self, f: impl FnOnce(&[u8; 32]) -> R) -> R {
        let mut seed = self.signing.to_bytes();
        let result = f(&seed);
        seed.fill(0);
        result
    }
}

fn plain_seed(path: &Path) -> Result<Zeroizing<[u8; 32]>, PairError> {
    check_owner_only(path, "client key file")?;
    let text = Zeroizing::new(
        std::fs::read_to_string(path)
            .map_err(|e| PairError::Local(format!("cannot read the client key: {e}")))?,
    );
    let corrupt = || PairError::Local("the client key file is corrupt".into());
    let bytes = Zeroizing::new(hex::decode(text.trim()).map_err(|_| corrupt())?);
    let seed: [u8; 32] = bytes.as_slice().try_into().map_err(|_| corrupt())?;
    Ok(Zeroizing::new(seed))
}

fn sealed_seed(path: &Path, sealer: &dyn Sealer) -> Result<Zeroizing<[u8; 32]>, PairError> {
    check_owner_only(path, "protected client key file")?;
    let length = std::fs::metadata(path)
        .map_err(|e| PairError::Local(format!("cannot read the protected client key: {e}")))?
        .len();
    if length > MAX_SEALED_KEY_BYTES {
        return Err(PairError::Local("the protected client key is oversized".into()));
    }
    let ciphertext = std::fs::read(path)
        .map_err(|e| PairError::Local(format!("cannot read the protected client key: {e}")))?;
    let seed = sealer.open(at_rest::CLIENT_SEED_PURPOSE, &ciphertext).map_err(|e| {
        PairError::Local(format!(
            "this device cannot open its protected client key ({e}). \
             Clear BitSov's storage, then pair again."
        ))
    })?;
    let seed: [u8; 32] = seed
        .as_slice()
        .try_into()
        .map_err(|_| PairError::Local("the protected client key is corrupt".into()))?;
    Ok(Zeroizing::new(seed))
}

/// Atomically replace `path` with an owner-only file holding `bytes`.
fn write_replacing(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("sealed.tmp");
    let _ = std::fs::remove_file(&tmp);
    let mut file = create_new_protected(&tmp)?;
    let written = file
        .write_all(bytes)
        .and_then(|()| file.sync_all())
        .and_then(|()| std::fs::rename(&tmp, path));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

/// Overwrite, then delete, a migrated plaintext key file. Flash storage may
/// still keep old blocks; the overwrite only narrows what remains readable.
fn discard(path: &Path) -> Result<(), PairError> {
    if let Ok(mut file) = std::fs::OpenOptions::new().write(true).open(path) {
        if let Ok(length) = file.metadata().map(|metadata| metadata.len()) {
            let zeros = vec![0u8; length.min(4096) as usize];
            let _ = file.write_all(&zeros).and_then(|()| file.sync_all());
        }
    }
    std::fs::remove_file(path)
        .map_err(|e| PairError::Local(format!("cannot delete the old client key file: {e}")))
}

/// Create `dir` if needed and restrict it to the owner (`0700`).
#[cfg(unix)]
pub(crate) fn restrict_dir(dir: &Path) -> Result<(), PairError> {
    std::fs::create_dir_all(dir)
        .map_err(|e| PairError::Local(format!("cannot create {}: {e}", dir.display())))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| PairError::Local(format!("cannot restrict {}: {e}", dir.display())))?;
    }
    Ok(())
}

/// Open a new file at `0600`. Fails with `AlreadyExists` if it is there.
#[cfg(unix)]
pub(crate) fn create_new_protected(path: &Path) -> std::io::Result<std::fs::File> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)
}

/// Refuse a file that group or others can read or write.
#[cfg(unix)]
pub(crate) fn check_owner_only(path: &Path, what: &str) -> Result<(), PairError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(path)
            .map_err(|e| PairError::Local(format!("cannot stat the {what}: {e}")))?
            .permissions()
            .mode()
            & 0o777;
        if mode & 0o077 != 0 {
            return Err(PairError::Local(format!(
                "the {what} has mode {mode:04o}; expected 0600 — refusing to use it"
            )));
        }
    }
    Ok(())
}

// Refuse before creating directories or files: skipping Unix modes would expose keys.
#[cfg(not(unix))]
pub(crate) fn restrict_dir(_dir: &Path) -> Result<(), PairError> {
    Err(PairError::Local("private pairing storage is not supported on this platform".into()))
}

#[cfg(not(unix))]
pub(crate) fn create_new_protected(_path: &Path) -> std::io::Result<std::fs::File> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported,
        "private pairing storage is not supported on this platform"))
}

#[cfg(not(unix))]
pub(crate) fn check_owner_only(_path: &Path, _what: &str) -> Result<(), PairError> {
    Err(PairError::Local("owner-only file checks are not supported on this platform".into()))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::at_rest::test_sealer::MemorySealer;

    fn contains_seed(bytes: &[u8], key: &ClientKey) -> bool {
        key.with_seed(|seed| {
            bytes.windows(32).any(|window| window == &seed[..])
                || String::from_utf8_lossy(bytes).contains(&hex::encode(seed))
        })
    }

    #[test]
    fn a_sealed_store_never_writes_the_seed_in_plain() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("pairing");
        let key = ClientKey::load_or_create_sealed(&store, &MemorySealer).unwrap();
        assert!(!store.join(KEY_FILE).exists());
        let sealed = std::fs::read(store.join(SEALED_KEY_FILE)).unwrap();
        assert!(!contains_seed(&sealed, &key));
        let names: Vec<_> = std::fs::read_dir(&store)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, [SEALED_KEY_FILE]);
        let again = ClientKey::load_or_create_sealed(&store, &MemorySealer).unwrap();
        assert_eq!(again.public_hex(), key.public_hex());
    }

    #[test]
    fn a_plain_seed_is_migrated_once_then_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("pairing");
        let plain = ClientKey::load_or_create_plain(&store).unwrap();
        assert!(store.join(KEY_FILE).exists());

        let migrated = ClientKey::load_or_create_sealed(&store, &MemorySealer).unwrap();
        assert_eq!(migrated.public_hex(), plain.public_hex());
        assert!(!store.join(KEY_FILE).exists());
        let sealed = std::fs::read(store.join(SEALED_KEY_FILE)).unwrap();
        assert!(!contains_seed(&sealed, &plain));

        let reloaded = ClientKey::load_or_create_sealed(&store, &MemorySealer).unwrap();
        assert_eq!(reloaded.public_hex(), plain.public_hex());
        assert_eq!(std::fs::read(store.join(SEALED_KEY_FILE)).unwrap(), sealed);
    }

    #[test]
    fn a_sealed_seed_wins_over_a_leftover_plain_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("pairing");
        let sealed = ClientKey::load_or_create_sealed(&store, &MemorySealer).unwrap();
        let mut leftover = create_new_protected(&store.join(KEY_FILE)).unwrap();
        leftover.write_all("11".repeat(32).as_bytes()).unwrap();
        drop(leftover);

        let loaded = ClientKey::load_or_create_sealed(&store, &MemorySealer).unwrap();
        assert_eq!(loaded.public_hex(), sealed.public_hex());
        assert!(!store.join(KEY_FILE).exists());
    }

    #[test]
    fn a_seed_sealed_for_another_purpose_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("pairing");
        restrict_dir(&store).unwrap();
        let wrong = MemorySealer.seal("pairing-code-v1:node", &[7u8; 32]).unwrap();
        write_replacing(&store.join(SEALED_KEY_FILE), &wrong).unwrap();
        let error = ClientKey::load_or_create_sealed(&store, &MemorySealer).unwrap_err();
        assert!(error.to_string().contains("cannot open its protected client key"));
        assert!(store.join(SEALED_KEY_FILE).exists(), "a refused key is never deleted");
    }
}
