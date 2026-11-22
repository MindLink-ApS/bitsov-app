//! Current-user DPAPI sealer for Windows. Fails closed: no plaintext
//! fallback, no machine scope, and an install failure is an error.

use super::dpapi::{DpapiSealer, Protect};
use std::sync::Arc;
use zeroize::Zeroizing;

struct CurrentUser;

impl Protect for CurrentUser {
    fn protect(&self, plaintext: &[u8], entropy: &[u8]) -> Result<Vec<u8>, String> {
        bitsov_ffi::dpapi::protect(plaintext, entropy)
    }

    fn unprotect(&self, protected: &[u8], entropy: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
        bitsov_ffi::dpapi::unprotect(protected, entropy)
    }
}

/// Refuse an elevated process, then install the sealer for `profile` (the
/// app identifier). Callers must treat an error as fatal.
pub fn install_windows(profile: &str) -> Result<(), String> {
    bitsov_ffi::win_private::elevation_gate().map_err(|error| error.to_string())?;
    super::install(Arc::new(DpapiSealer::new(profile, CurrentUser)?))
}
