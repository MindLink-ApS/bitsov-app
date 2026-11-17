//! Device-bound pairing storage, independent of the migratable login Keychain.

use super::Sealer;
use std::sync::Arc;
use zeroize::Zeroizing;

pub(super) struct MacSealer {
    /// Non-prompting Secure Enclave probe; replaceable in tests.
    #[allow(dead_code)]
    enclave: fn() -> bool,
}

impl MacSealer {
    pub(super) fn with_probe(enclave: fn() -> bool) -> Self {
        Self { enclave }
    }
}

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
    let sealer = MacSealer::with_probe(bitsov_ffi::device_key::enclave_available);
    if let Err(error) = super::install(Arc::new(sealer)) {
        eprintln!("[pairing] protected storage unavailable: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mac_sealer_reports_missing_enclave_without_native_call() {
        assert!(!MacSealer::with_probe(|| false).hardware_available());
        assert!(MacSealer::with_probe(|| true).hardware_available());
    }
}
