//! Device-bound pairing storage, independent of the migratable login Keychain.

use super::{Sealer, CLIENT_SEED_PURPOSE};
use std::sync::Arc;
use zeroize::Zeroizing;

struct MacSealer;

impl Sealer for MacSealer {
    fn seal(&self, purpose: &str, plaintext: &[u8]) -> Result<Vec<u8>, String> {
        bitsov_ffi::pairing_sealer::seal(purpose, plaintext)
    }

    fn open(&self, purpose: &str, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
        bitsov_ffi::pairing_sealer::open(purpose, sealed)
    }

    fn allows_plaintext_fallback(&self) -> bool {
        true
    }
}

/// Probe both directions before installing; unavailability must not abort setup.
/// An existing sealed identity is still refused by the loader without a sealer.
pub fn install_macos() {
    let sealer = MacSealer;
    let result = (|| {
        let probe = b"BitSov protected storage availability";
        let sealed = sealer.seal(CLIENT_SEED_PURPOSE, probe)?;
        if sealer.open(CLIENT_SEED_PURPOSE, &sealed)?.as_slice() != probe {
            return Err("Secure Enclave storage failed verification".to_string());
        }
        super::install(Arc::new(sealer))
    })();
    if let Err(error) = result {
        eprintln!("[pairing] Secure Enclave sealing unavailable; keeping legacy plaintext storage where present: {error}");
    }
}
