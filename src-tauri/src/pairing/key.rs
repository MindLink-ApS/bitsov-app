//! The app-held Ed25519 client key.
//!
//! Stored as a hex seed in a `0600` file inside a `0700` directory under the
//! app data dir. No OS keychain in this step: any process running as the same
//! OS user can read this file. That is the documented limit of the tier
//! (docs/ONBOARDING_PAIRING.md) — less exposure, not solved local security.

use std::io::Write;
use std::path::Path;

use ed25519_dalek::{Signer, SigningKey};

use super::PairError;

/// File name of the client key inside the pairing store directory.
pub const KEY_FILE: &str = "client-ed25519.key";

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
        check_owner_only(path, "client key file")?;
        let text = std::fs::read_to_string(path)
            .map_err(|e| PairError::Local(format!("cannot read the client key: {e}")))?;
        let seed: [u8; 32] = hex::decode(text.trim())
            .ok()
            .and_then(|bytes| bytes.try_into().ok())
            .ok_or_else(|| PairError::Local("the client key file is corrupt".into()))?;
        Ok(Self::from_seed(seed))
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
