//! The app-held Ed25519 client key.
//!
//! Entitled Apple apps store the seed in the non-synchronizing, ThisDeviceOnly
//! Keychain. Ad-hoc Macs keep the existing enclave-sealed file, without plaintext
//! fallback. Only entitled apps migrate those files into the Keychain.
//!
//! Android (Keystore) installs an [`at_rest::Sealer`].
//! A legacy [`KEY_FILE`] is sealed, read back and verified, then wiped and
//! deleted. Once [`SEALED_KEY_FILE`] exists it is authoritative, even when
//! the sealer is unavailable. Apple platforms migrate existing files into
//! user-presence-protected Keychain items before returning the seed.

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
const MAX_SEALED_KEY_BYTES: u64 = 16384;
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
    /// Generate a memory-only identity for a short-lived client session.
    /// Persistent clients must use `load_or_create` and platform-protected storage.
    pub fn generate_ephemeral() -> Result<Self, PairError> {
        let mut seed = Zeroizing::new([0; 32]);
        getrandom::getrandom(&mut seed[..]).map_err(|e| PairError::Local(format!("no randomness for the client key: {e}")))?;
        Ok(Self::from_seed(*seed))
    }

    /// Load the key from `dir`, generating it on first run.
    ///
    /// Refuses a key file readable or writable by group or others rather than
    /// silently tightening it: a loosened mode means something else touched it.
    pub fn load_or_create(dir: &Path) -> Result<Self, PairError> {
        #[cfg(all(not(test), any(target_os = "ios", all(target_os = "macos", not(feature = "mobile")))))]
        { return keychain::load_native(dir); }
        #[cfg(all(target_os = "macos", feature = "mobile", not(test)))]
        { return Err(PairError::Local("client Keychain storage is unavailable in the host mobile check".into())); }
        #[cfg(not(all(not(test), any(target_os = "ios", target_os = "macos"))))]
        match at_rest::installed() {
            Some(sealer) => Self::load_or_create_sealed(dir, sealer),
            None => Self::load_or_create_plain(dir),
        }
    }

    fn load_or_create_plain(dir: &Path) -> Result<Self, PairError> {
        if sealed_file_exists(dir)? {
            return Err(PairError::Local(
                "this device cannot open its protected client key: protected storage is temporarily unavailable. \
                 Restore access on the original device and try again.".into(),
            ));
        }
        restrict_dir(dir)?;
        let path = dir.join(KEY_FILE);
        match create_new_protected(&path) {
            Ok(mut file) => {
                let mut seed = [0u8; 32];
                getrandom::getrandom(&mut seed).map_err(|e| {
                    PairError::Local(format!("no randomness for the client key: {e}"))
                })?;
                let written = file
                    .write_all(hex::encode(seed).as_bytes())
                    .and_then(|()| file.sync_all());
                if let Err(e) = written {
                    let _ = std::fs::remove_file(&path);
                    return Err(PairError::Local(format!(
                        "cannot write the client key: {e}"
                    )));
                }
                Ok(Self::from_seed(seed))
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Self::load(&path),
            Err(e) => Err(PairError::Local(format!(
                "cannot create the client key: {e}"
            ))),
        }
    }

    fn load(path: &Path) -> Result<Self, PairError> {
        Ok(Self::from_seed(*plain_seed(path)?))
    }

    /// Migrate a plain key only after a durable, verified sealed copy exists.
    /// A sealer may permit legacy fallback before migration, never afterwards.
    pub(crate) fn load_or_create_sealed(
        dir: &Path,
        sealer: &dyn Sealer,
    ) -> Result<Self, PairError> {
        let _sealed_key = SEALED_KEY_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        restrict_dir(dir)?;
        let sealed = dir.join(SEALED_KEY_FILE);
        let plain = dir.join(KEY_FILE);
        let seed = if sealed_file_exists(dir)? {
            sealed_seed(&sealed, sealer)?
        } else {
            let seed = if plain.exists() {
                plain_seed(&plain)?
            } else {
                let mut seed = Zeroizing::new([0u8; 32]);
                getrandom::getrandom(&mut seed[..]).map_err(|e| {
                    PairError::Local(format!("no randomness for the client key: {e}"))
                })?;
                seed
            };
            if let Err(error) = write_verified_seed(&sealed, &seed, sealer) {
                if !sealer.allows_plaintext_fallback() {
                    return Err(error);
                }
                eprintln!("[pairing] could not seal the client identity; retaining existing storage: {error}");
                // A published file (including a racing writer's) is always
                // authoritative. Never downgrade or replace it on an error.
                return if sealed_file_exists(dir)? {
                    sealed_seed(&sealed, sealer).map(|seed| Self::from_seed(*seed))
                } else {
                    Self::load_or_create_plain(dir)
                };
            }
            seed
        };
        if plain.exists() {
            match plain_seed(&plain) {
                Ok(plain_seed) if *plain_seed == *seed => {}
                Ok(_) => {
                    eprintln!("[pairing] plaintext and sealed client identities differ; retaining both files and using the sealed identity");
                    return Ok(Self::from_seed(*seed));
                }
                Err(_) => {
                    eprintln!("[pairing] cannot verify the leftover plaintext identity; retaining both files and using the sealed identity");
                    return Ok(Self::from_seed(*seed));
                }
            }
            // Also covers retry after publication succeeded but directory sync
            // failed (or the process exited before it reached that sync).
            if let Err(error) = std::fs::File::open(dir).and_then(|file| file.sync_all()) {
                eprintln!(
                    "[pairing] retaining plaintext until the sealed identity is durable: {error}"
                );
                return Ok(Self::from_seed(*seed));
            }
            if let Err(error) = discard(&plain) {
                eprintln!(
                    "[pairing] sealed identity loaded, but plaintext cleanup failed: {error}"
                );
            }
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

/// Metadata errors and dangling symlinks must not masquerade as a fresh store.
fn sealed_file_exists(dir: &Path) -> Result<bool, PairError> {
    match std::fs::symlink_metadata(dir.join(SEALED_KEY_FILE)) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(PairError::Local(format!(
            "cannot inspect the protected client key: {e}"
        ))),
    }
}

fn write_verified_seed(path: &Path, seed: &[u8; 32], sealer: &dyn Sealer) -> Result<(), PairError> {
    let ciphertext = sealer
        .seal(at_rest::CLIENT_SEED_PURPOSE, seed)
        .map_err(|e| PairError::Local(format!("cannot protect the client key: {e}")))?;
    let dir = path.parent().expect("client key has a directory");
    let io_error = |e| PairError::Local(format!("cannot write the protected client key: {e}"));
    // NamedTempFile is owner-only. Its RAII cleanup removes failed attempts.
    let mut temp = tempfile::NamedTempFile::new_in(dir).map_err(io_error)?;
    temp.write_all(&ciphertext)
        .and_then(|()| temp.as_file().sync_all())
        .map_err(io_error)?;
    let reopened = sealed_seed(temp.path(), sealer)?;
    if *reopened != *seed {
        return Err(PairError::Local(
            "the protected client key does not reopen to the same key".into(),
        ));
    }
    temp.persist_noclobber(path)
        .map_err(|e| io_error(e.error))?;
    // Make the sealed directory entry durable before wiping the old identity.
    std::fs::File::open(dir)
        .and_then(|file| file.sync_all())
        .map_err(io_error)
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
        return Err(PairError::Local(
            "the protected client key is oversized".into(),
        ));
    }
    let ciphertext = std::fs::read(path)
        .map_err(|e| PairError::Local(format!("cannot read the protected client key: {e}")))?;
    let seed = sealer
        .open(at_rest::CLIENT_SEED_PURPOSE, &ciphertext)
        .map_err(|e| {
            PairError::Local(format!(
                "this device cannot open its protected client key: {e}"
            ))
        })?;
    let seed: [u8; 32] = seed
        .as_slice()
        .try_into()
        .map_err(|_| PairError::Local("the protected client key is corrupt".into()))?;
    Ok(Zeroizing::new(seed))
}

/// Atomically replace `path` with an owner-only file holding `bytes`.
#[cfg(test)]
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
    Err(PairError::Local(
        "private pairing storage is not supported on this platform".into(),
    ))
}

#[cfg(not(unix))]
pub(crate) fn create_new_protected(_path: &Path) -> std::io::Result<std::fs::File> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "private pairing storage is not supported on this platform",
    ))
}

#[cfg(not(unix))]
pub(crate) fn check_owner_only(_path: &Path, _what: &str) -> Result<(), PairError> {
    Err(PairError::Local(
        "owner-only file checks are not supported on this platform".into(),
    ))
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
    fn a_sealed_seed_wins_but_preserves_a_different_plain_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("pairing");
        let sealed = ClientKey::load_or_create_sealed(&store, &MemorySealer).unwrap();
        let ciphertext = std::fs::read(store.join(SEALED_KEY_FILE)).unwrap();
        let mut leftover = create_new_protected(&store.join(KEY_FILE)).unwrap();
        leftover.write_all("11".repeat(32).as_bytes()).unwrap();
        drop(leftover);

        let loaded = ClientKey::load_or_create_sealed(&store, &MemorySealer).unwrap();
        assert_eq!(loaded.public_hex(), sealed.public_hex());
        assert_eq!(std::fs::read_to_string(store.join(KEY_FILE)).unwrap(), "11".repeat(32));
        assert_eq!(std::fs::read(store.join(SEALED_KEY_FILE)).unwrap(), ciphertext);
    }

    #[test]
    fn a_seed_sealed_for_another_purpose_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("pairing");
        restrict_dir(&store).unwrap();
        let wrong = MemorySealer
            .seal("pairing-code-v1:node", &[7u8; 32])
            .unwrap();
        write_replacing(&store.join(SEALED_KEY_FILE), &wrong).unwrap();
        let error = ClientKey::load_or_create_sealed(&store, &MemorySealer).unwrap_err();
        assert!(error
            .to_string()
            .contains("cannot open its protected client key"));
        assert!(
            store.join(SEALED_KEY_FILE).exists(),
            "a refused key is never deleted"
        );
    }

    struct Unavailable;

    impl Sealer for Unavailable {
        fn allows_plaintext_fallback(&self) -> bool {
            true
        }
        fn seal(&self, _: &str, _: &[u8]) -> Result<Vec<u8>, String> {
            Err("Secure Enclave unavailable".into())
        }

        fn open(&self, _: &str, _: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
            Err("Secure Enclave temporarily unavailable; try again".into())
        }
    }

    #[test]
    fn an_unavailable_sealer_preserves_the_plain_identity() {
        let dir = tempfile::tempdir().unwrap();
        let original = ClientKey::load_or_create_plain(dir.path()).unwrap();
        let bytes = std::fs::read(dir.path().join(KEY_FILE)).unwrap();
        let loaded = ClientKey::load_or_create_sealed(dir.path(), &Unavailable).unwrap();
        assert_eq!(loaded.public_hex(), original.public_hex());
        assert_eq!(std::fs::read(dir.path().join(KEY_FILE)).unwrap(), bytes);
        assert!(!dir.path().join(SEALED_KEY_FILE).exists());
    }

    #[test]
    fn an_unavailable_sealer_on_first_run_uses_the_plain_store() {
        let dir = tempfile::tempdir().unwrap();
        let key = ClientKey::load_or_create_sealed(dir.path(), &Unavailable).unwrap();
        let loaded = ClientKey::load_or_create_plain(dir.path()).unwrap();
        assert_eq!(loaded.public_hex(), key.public_hex());
        assert!(!dir.path().join(SEALED_KEY_FILE).exists());
    }

    #[test]
    fn no_installed_sealer_must_not_replace_a_sealed_identity() {
        let dir = tempfile::tempdir().unwrap();
        ClientKey::load_or_create_sealed(dir.path(), &MemorySealer).unwrap();
        let bytes = std::fs::read(dir.path().join(SEALED_KEY_FILE)).unwrap();
        let error = ClientKey::load_or_create_plain(dir.path()).unwrap_err();
        assert!(error.to_string().contains("try again"));
        assert!(!error.to_string().to_lowercase().contains("clear"));
        assert!(!dir.path().join(KEY_FILE).exists());
        assert_eq!(
            std::fs::read(dir.path().join(SEALED_KEY_FILE)).unwrap(),
            bytes
        );
    }

    #[test]
    fn a_temporary_open_failure_preserves_both_files_without_plaintext_fallback() {
        let dir = tempfile::tempdir().unwrap();
        ClientKey::load_or_create_sealed(dir.path(), &MemorySealer).unwrap();
        let sealed = std::fs::read(dir.path().join(SEALED_KEY_FILE)).unwrap();
        for leftover in [false, true] {
            if leftover {
                create_new_protected(&dir.path().join(KEY_FILE))
                    .unwrap()
                    .write_all("11".repeat(32).as_bytes())
                    .unwrap();
            }
            let error = ClientKey::load_or_create_sealed(dir.path(), &Unavailable).unwrap_err();
            assert!(error
                .to_string()
                .contains("cannot open its protected client key"));
            assert!(error.to_string().contains("try again"));
            assert!(!error.to_string().to_lowercase().contains("clear"));
            assert_eq!(
                std::fs::read(dir.path().join(SEALED_KEY_FILE)).unwrap(),
                sealed
            );
            assert_eq!(dir.path().join(KEY_FILE).exists(), leftover);
            if leftover {
                assert_eq!(
                    std::fs::read_to_string(dir.path().join(KEY_FILE)).unwrap(),
                    "11".repeat(32)
                );
            }
        }
    }

    #[test]
    fn a_crash_after_the_sealed_write_resumes_without_changing_identity() {
        let dir = tempfile::tempdir().unwrap();
        let original = ClientKey::load_or_create_plain(dir.path()).unwrap();
        let plain = std::fs::read(dir.path().join(KEY_FILE)).unwrap();
        // Reproduce the on-disk state at the crash boundary: the verified
        // sealed copy is committed, but the old plaintext has not been wiped.
        original.with_seed(|seed| {
            write_verified_seed(&dir.path().join(SEALED_KEY_FILE), seed, &MemorySealer).unwrap();
        });
        assert_eq!(std::fs::read(dir.path().join(KEY_FILE)).unwrap(), plain);
        let sealed = std::fs::read(dir.path().join(SEALED_KEY_FILE)).unwrap();
        let loaded = ClientKey::load_or_create_sealed(dir.path(), &MemorySealer).unwrap();
        assert_eq!(loaded.public_hex(), original.public_hex());
        assert!(!dir.path().join(KEY_FILE).exists());
        assert_eq!(
            std::fs::read(dir.path().join(SEALED_KEY_FILE)).unwrap(),
            sealed
        );
    }

    struct FailedReadback;

    impl Sealer for FailedReadback {
        fn allows_plaintext_fallback(&self) -> bool {
            true
        }
        fn seal(&self, purpose: &str, seed: &[u8]) -> Result<Vec<u8>, String> {
            MemorySealer.seal(purpose, seed)
        }

        fn open(&self, _: &str, _: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
            Err("readback unavailable".into())
        }
    }

    #[test]
    fn a_failed_readback_keeps_the_original_plaintext_and_allows_retry() {
        let dir = tempfile::tempdir().unwrap();
        let original = ClientKey::load_or_create_plain(dir.path()).unwrap();
        let bytes = std::fs::read(dir.path().join(KEY_FILE)).unwrap();
        let loaded = ClientKey::load_or_create_sealed(dir.path(), &FailedReadback).unwrap();
        assert_eq!(loaded.public_hex(), original.public_hex());
        assert_eq!(std::fs::read(dir.path().join(KEY_FILE)).unwrap(), bytes);
        assert!(!dir.path().join(SEALED_KEY_FILE).exists());
        let retry = ClientKey::load_or_create_sealed(dir.path(), &MemorySealer).unwrap();
        assert_eq!(retry.public_hex(), original.public_hex());
        assert!(!dir.path().join(KEY_FILE).exists());
    }
}

#[cfg(any(target_os = "ios", all(target_os = "macos", not(feature = "mobile")), all(test, unix)))]
#[path = "key/keychain.rs"]
mod keychain;

#[cfg(all(not(test), target_os = "macos", not(feature = "mobile")))]
pub(crate) fn storage_smoke_test() -> Result<&'static str, String> { keychain::smoke_test() }
