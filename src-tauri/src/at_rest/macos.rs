//! Device-bound pairing storage, independent of the migratable login Keychain.

use super::Sealer;
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


}

/// Install without prompting; each operation reports any storage failure.
/// Entitled apps use the Keychain; ad-hoc apps keep enclave-sealed seeds.
pub fn install_macos() {
    if let Err(error) = super::install(Arc::new(MacSealer)) {
        eprintln!("[pairing] protected storage unavailable: {error}");
    }
}
