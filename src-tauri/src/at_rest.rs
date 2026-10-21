//! Hardware-wrapped storage for the secrets the app keeps on disk.
//!
//! macOS installs a Secure Enclave sealer when available; otherwise existing
//! owner-only plaintext stores remain usable. Android installs an Android
//! Keystore sealer at startup, before any pairing file is
//! read, so the Ed25519 client seed and a pending one-time pairing code are
//! written only as ciphertext under a non-exportable key. Public pins (node
//! id, transport keys and their signatures) stay readable: their integrity
//! comes from the node's signature, not from secrecy.
//! iOS installs the same enclave-wrapping primitive without plaintext fallback
//! for descriptor codes; its Ed25519 client seed lives directly in Keychain.

use std::sync::{Arc, OnceLock};

use zeroize::Zeroizing;

/// Authenticated encryption bound to `purpose` (its associated data).
pub trait Sealer: Send + Sync {
    fn seal(&self, purpose: &str, plaintext: &[u8]) -> Result<Vec<u8>, String>;
    fn open(&self, purpose: &str, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, String>;

    /// Permit legacy plaintext storage if a new seal cannot be committed.
    /// Never applies to an already sealed identity. Android remains strict.
    fn allows_plaintext_fallback(&self) -> bool {
        false
    }
}

#[cfg(all(target_os = "macos", not(feature = "mobile")))]
mod macos;
#[cfg(all(target_os = "macos", not(feature = "mobile")))]
pub use macos::install_macos;

/// The client Ed25519 seed (`pairing::key`).
pub const CLIENT_SEED_PURPOSE: &str = "client-ed25519-seed-v1";

/// A remote descriptor's one-time pairing code, bound to its node identity.
pub fn pairing_code_purpose(node_id: &str) -> String {
    format!("pairing-code-v1:{node_id}")
}

static SEALER: OnceLock<Arc<dyn Sealer>> = OnceLock::new();

/// Install the platform sealer once, before the first pairing file is read.
pub fn install(sealer: Arc<dyn Sealer>) -> Result<(), String> {
    SEALER
        .set(sealer)
        .map_err(|_| "protected secret storage was installed twice".to_string())
}

pub(crate) fn installed() -> Option<&'static dyn Sealer> {
    SEALER.get().map(|sealer| sealer.as_ref())
}

#[cfg(test)]
pub(crate) mod test_sealer {
    use super::Sealer;
    use zeroize::Zeroizing;

    /// Reversible, purpose-bound stand-in for the Keystore. Not encryption.
    pub struct MemorySealer;

    impl Sealer for MemorySealer {
        fn seal(&self, purpose: &str, plaintext: &[u8]) -> Result<Vec<u8>, String> {
            let mut sealed = format!("sealed:{purpose}:").into_bytes();
            sealed.extend(plaintext.iter().map(|byte| byte ^ 0xa5));
            Ok(sealed)
        }

        fn open(&self, purpose: &str, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
            let prefix = format!("sealed:{purpose}:");
            let body = sealed
                .strip_prefix(prefix.as_bytes())
                .ok_or("sealed for another purpose")?;
            Ok(Zeroizing::new(
                body.iter().map(|byte| byte ^ 0xa5).collect(),
            ))
        }
    }
}

#[cfg(target_os = "ios")]
pub fn install_ios() -> Result<(), String> {
    struct IosSealer;
    impl Sealer for IosSealer {
        fn seal(&self, purpose: &str, plaintext: &[u8]) -> Result<Vec<u8>, String> {
            bitsov_ffi::pairing_sealer::seal(purpose, plaintext)
        }
        fn open(&self, purpose: &str, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
            bitsov_ffi::pairing_sealer::open(purpose, sealed)
        }
    }
    install(Arc::new(IosSealer))
}
