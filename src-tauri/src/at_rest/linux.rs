//! Explicit Linux storage preparation. Startup does not install this provider.
use super::Sealer;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, CHACHA20_POLY1305};
use zeroize::Zeroizing;

const HEADER: &[u8; 8] = b"BSLSS002";
const PREFIX_LEN: usize = 8 + 32 + 12;
const MAX_PLAINTEXT: usize = 8192;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProviderError { Unavailable, Locked, Failed }

impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Unavailable => "Secret Service is unavailable",
            Self::Locked => "Secret Service is locked",
            Self::Failed => "Secret Service operation failed",
        })
    }
}

trait Keyring: Send + Sync {
    fn key(&self, create: bool) -> Result<Zeroizing<Vec<u8>>, ProviderError>;
}

pub(crate) struct LinuxSealer {
    backend: Box<dyn Keyring>,
    profile: String,
    key_id: [u8; 32],
}

fn failed<T>(_: T) -> String { ProviderError::Failed.to_string() }

impl LinuxSealer {
    /// Construct without connecting, unlocking, or installing a provider.
    #[cfg(unix)]
    pub(crate) fn new(profile: &str, key_id: [u8; 32]) -> Result<Self, String> {
        if profile.is_empty() || profile.len() > 256 || profile.contains('\0') {
            return Err(failed(()));
        }
        Ok(Self { backend: Box::new(secret_service::ServiceKeyring::new(profile)), profile: profile.into(), key_id })
    }

    fn aad(&self, purpose: &str, header: &[u8]) -> Result<Vec<u8>, String> {
        let mut aad = b"bitsov-linux-sealed-v2\0".to_vec();
        for value in [&self.profile, purpose] {
            aad.extend_from_slice(&u32::try_from(value.len()).map_err(failed)?.to_be_bytes());
            aad.extend_from_slice(value.as_bytes());
        }
        aad.extend_from_slice(header);
        Ok(aad)
    }
}

impl Sealer for LinuxSealer {
    fn seal(&self, purpose: &str, plaintext: &[u8]) -> Result<Vec<u8>, String> {
        if plaintext.len() > MAX_PLAINTEXT { return Err(failed(())); }
        let wrapping_key = self.backend.key(false).map_err(|error| error.to_string())?;
        if blake3::hash(&wrapping_key).as_bytes() != &self.key_id { return Err(failed(())); }
        let key = LessSafeKey::new(UnboundKey::new(&CHACHA20_POLY1305, &wrapping_key).map_err(failed)?);
        let mut nonce = [0; 12];
        getrandom::getrandom(&mut nonce).map_err(failed)?;
        let mut sealed = Vec::with_capacity(PREFIX_LEN + plaintext.len() + 16);
        sealed.extend_from_slice(HEADER);
        sealed.extend_from_slice(&self.key_id);
        sealed.extend_from_slice(&nonce);
        let aad = self.aad(purpose, &sealed)?;
        let mut body = Zeroizing::new(plaintext.to_vec());
        key.seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::from(aad), &mut *body)
            .map_err(failed)?;
        sealed.extend_from_slice(&body);
        Ok(sealed)
    }

    fn open(&self, purpose: &str, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
        if sealed.len() < PREFIX_LEN + 16 || sealed.len() > PREFIX_LEN + MAX_PLAINTEXT + 16
            || &sealed[..8] != HEADER { return Err(failed(())); }
        let wrapping_key = self.backend.key(false).map_err(|error| error.to_string())?;
        if blake3::hash(&wrapping_key).as_bytes() != &self.key_id || self.key_id != sealed[8..40] { return Err(failed(())); }
        let key = LessSafeKey::new(UnboundKey::new(&CHACHA20_POLY1305, &wrapping_key).map_err(failed)?);
        let nonce: [u8; 12] = sealed[40..PREFIX_LEN].try_into().map_err(failed)?;
        let aad = self.aad(purpose, &sealed[..PREFIX_LEN])?;
        let mut body = Zeroizing::new(sealed[PREFIX_LEN..].to_vec());
        let length = key.open_in_place(Nonce::assume_unique_for_key(nonce), Aad::from(aad), &mut body)
            .map_err(failed)?.len();
        body.truncate(length);
        Ok(body)
    }
}

pub(crate) struct RequiredSealer<'a>(&'a dyn Sealer);
impl Sealer for RequiredSealer<'_> {
    fn seal(&self, purpose: &str, plaintext: &[u8]) -> Result<Vec<u8>, String> { self.0.seal(purpose, plaintext) }
    fn open(&self, purpose: &str, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> { self.0.open(purpose, sealed) }
}

pub(crate) fn required(sealer: Option<&dyn Sealer>) -> Result<RequiredSealer<'_>, String> {
    sealer.map(RequiredSealer).ok_or_else(|| ProviderError::Unavailable.to_string())
}

#[cfg(unix)]
mod secret_service;
#[cfg(test)]
mod tests;

#[cfg(test)]
pub(crate) mod identity_fixture;
