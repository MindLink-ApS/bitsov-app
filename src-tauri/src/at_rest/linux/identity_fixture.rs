use super::*;

struct FixedKeyring;

impl Keyring for FixedKeyring {
    fn key(&self, create: bool) -> Result<Zeroizing<Vec<u8>>, ProviderError> {
        assert!(!create);
        Ok(Zeroizing::new(vec![29; 32]))
    }
}

pub(crate) fn sealer() -> LinuxSealer {
    LinuxSealer {
        backend: Box::new(FixedKeyring),
        profile: "test.profile".into(),
        key_id: *blake3::hash(&[29; 32]).as_bytes(),
    }
}
