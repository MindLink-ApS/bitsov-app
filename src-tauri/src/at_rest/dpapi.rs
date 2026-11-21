//! Framing for the Windows current-user DPAPI sealer.
//!
//! `frame = "bitsov-sealed-v1\0" ‖ u32be(len) ‖ profile ‖ u32be(len) ‖ purpose`.
//! The protected plaintext is `frame ‖ u32be(len) ‖ payload`, and `frame` is
//! also passed as DPAPI entropy, so a blob opens only for its own profile and
//! purpose. The stored envelope is strict JSON:
//! `{"v":1,"backend":"dpapi-current-user","ciphertext":<base64url>}`.
//!
//! The OS call sits behind [`Protect`] so the framing is tested everywhere.

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use super::Sealer;

const MAGIC: &[u8] = b"bitsov-sealed-v1\0";
const BACKEND: &str = "dpapi-current-user";
const VERSION: u8 = 1;
/// Largest stored envelope; matches the client key file limit.
pub(crate) const MAX_ENVELOPE: usize = 16384;
/// Largest payload a caller may seal.
pub(crate) const MAX_PAYLOAD: usize = 4096;
const MAX_LABEL: usize = 256;

/// The OS protection primitive: current user only, never machine scope.
pub(crate) trait Protect: Send + Sync {
    fn protect(&self, plaintext: &[u8], entropy: &[u8]) -> Result<Vec<u8>, String>;
    fn unprotect(&self, protected: &[u8], entropy: &[u8]) -> Result<Zeroizing<Vec<u8>>, String>;
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    v: u8,
    backend: String,
    ciphertext: String,
}

fn corrupt() -> String {
    "the protected data is corrupt".into()
}

fn label_ok(label: &str) -> bool {
    !label.is_empty() && label.len() <= MAX_LABEL && !label.contains('\0')
}

fn push_prefixed(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(bytes);
}

/// A sealer bound to one app profile. Never permits plaintext fallback.
pub(crate) struct DpapiSealer<P> {
    profile: String,
    protect: P,
}

impl<P: Protect> DpapiSealer<P> {
    pub(crate) fn new(profile: &str, protect: P) -> Result<Self, String> {
        if !label_ok(profile) {
            return Err("invalid protected storage profile".into());
        }
        Ok(Self {
            profile: profile.into(),
            protect,
        })
    }

    fn frame(&self, purpose: &str) -> Result<Vec<u8>, String> {
        if !label_ok(purpose) {
            return Err("invalid protected storage purpose".into());
        }
        let mut frame = MAGIC.to_vec();
        push_prefixed(&mut frame, self.profile.as_bytes());
        push_prefixed(&mut frame, purpose.as_bytes());
        Ok(frame)
    }
}

impl<P: Protect> Sealer for DpapiSealer<P> {
    fn seal(&self, purpose: &str, plaintext: &[u8]) -> Result<Vec<u8>, String> {
        if plaintext.is_empty() || plaintext.len() > MAX_PAYLOAD {
            return Err("invalid protected storage input".into());
        }
        let frame = self.frame(purpose)?;
        let mut framed = Zeroizing::new(frame.clone());
        push_prefixed(&mut framed, plaintext);
        let protected = self.protect.protect(&framed, &frame)?;
        let envelope = serde_json::to_vec(&Envelope {
            v: VERSION,
            backend: BACKEND.into(),
            ciphertext: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(protected),
        })
        .map_err(|_| "cannot encode protected data".to_string())?;
        if envelope.len() > MAX_ENVELOPE {
            return Err("protected data is oversized".into());
        }
        Ok(envelope)
    }

    fn open(&self, purpose: &str, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
        if sealed.len() > MAX_ENVELOPE {
            return Err("protected data is oversized".into());
        }
        let frame = self.frame(purpose)?;
        let envelope: Envelope = serde_json::from_slice(sealed).map_err(|_| corrupt())?;
        if envelope.v != VERSION || envelope.backend != BACKEND {
            return Err("protected data uses an unsupported format".into());
        }
        let protected = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(envelope.ciphertext.as_bytes())
            .map_err(|_| corrupt())?;
        let framed = self.protect.unprotect(&protected, &frame)?;
        let body = framed.strip_prefix(frame.as_slice()).ok_or_else(corrupt)?;
        let (length, payload) = body.split_first_chunk::<4>().ok_or_else(corrupt)?;
        if u32::from_be_bytes(*length) as usize != payload.len() || payload.is_empty() {
            return Err(corrupt());
        }
        Ok(Zeroizing::new(payload.to_vec()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reversible stand-in for DPAPI that enforces entropy. Not encryption.
    struct FakeProtect;

    impl Protect for FakeProtect {
        fn protect(&self, plaintext: &[u8], entropy: &[u8]) -> Result<Vec<u8>, String> {
            let mut out = Vec::new();
            push_prefixed(&mut out, entropy);
            out.extend(plaintext.iter().map(|b| b ^ 0x5a));
            Ok(out)
        }

        fn unprotect(
            &self,
            protected: &[u8],
            entropy: &[u8],
        ) -> Result<Zeroizing<Vec<u8>>, String> {
            let mut expected = Vec::new();
            push_prefixed(&mut expected, entropy);
            let body = protected
                .strip_prefix(expected.as_slice())
                .ok_or("wrong entropy")?;
            Ok(Zeroizing::new(body.iter().map(|b| b ^ 0x5a).collect()))
        }
    }

    /// Returns a chosen inner plaintext, to test the strict inner checks.
    struct Returns(Vec<u8>);

    impl Protect for Returns {
        fn protect(&self, _: &[u8], _: &[u8]) -> Result<Vec<u8>, String> {
            Ok(b"blob".to_vec())
        }
        fn unprotect(&self, _: &[u8], _: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
            Ok(Zeroizing::new(self.0.clone()))
        }
    }

    struct Fails;

    impl Protect for Fails {
        fn protect(&self, _: &[u8], _: &[u8]) -> Result<Vec<u8>, String> {
            Err("protect failed".into())
        }
        fn unprotect(&self, _: &[u8], _: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
            Err("unprotect failed".into())
        }
    }

    const PROFILE: &str = "tech.example.profile";
    const PURPOSE: &str = "client-ed25519-seed-v1";

    fn sealer() -> DpapiSealer<FakeProtect> {
        DpapiSealer::new(PROFILE, FakeProtect).unwrap()
    }

    fn envelope(ciphertext: &[u8]) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "v": 1, "backend": BACKEND,
            "ciphertext": base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(ciphertext),
        }))
        .unwrap()
    }

    #[test]
    fn round_trips_without_plaintext_in_the_envelope() {
        let secret = [0x42u8; 32];
        let sealed = sealer().seal(PURPOSE, &secret).unwrap();
        assert!(!sealed.windows(32).any(|w| w == secret));
        assert!(!String::from_utf8_lossy(&sealed).contains(&hex::encode(secret)));
        let value: serde_json::Value = serde_json::from_slice(&sealed).unwrap();
        assert_eq!(value["v"], 1);
        assert_eq!(value["backend"], "dpapi-current-user");
        assert_eq!(value.as_object().unwrap().len(), 3);
        assert_eq!(sealer().open(PURPOSE, &sealed).unwrap().as_slice(), secret);
    }

    #[test]
    fn the_frame_is_exact_and_used_as_entropy() {
        let frame = sealer().frame("p").unwrap();
        let mut expected = b"bitsov-sealed-v1\0".to_vec();
        expected.extend_from_slice(&(PROFILE.len() as u32).to_be_bytes());
        expected.extend_from_slice(PROFILE.as_bytes());
        expected.extend_from_slice(&[0, 0, 0, 1, b'p']);
        assert_eq!(frame, expected);
    }

    #[test]
    fn wrong_purpose_or_profile_is_refused() {
        let sealed = sealer().seal(PURPOSE, b"payload").unwrap();
        assert!(sealer().open("pairing-code-v1:node", &sealed).is_err());
        let other = DpapiSealer::new("tech.example.other", FakeProtect).unwrap();
        assert!(other.open(PURPOSE, &sealed).is_err());
    }

    #[test]
    fn malformed_envelopes_are_refused() {
        let sealed = sealer().seal(PURPOSE, b"payload").unwrap();
        let mut value: serde_json::Value = serde_json::from_slice(&sealed).unwrap();
        for (field, bad) in [
            ("v", serde_json::json!(2)),
            ("backend", serde_json::json!("dpapi-local-machine")),
        ] {
            let mut changed = value.clone();
            changed[field] = bad;
            assert!(
                sealer()
                    .open(PURPOSE, &serde_json::to_vec(&changed).unwrap())
                    .is_err(),
                "{field}"
            );
        }
        value["extra"] = serde_json::json!(true);
        assert!(sealer()
            .open(PURPOSE, &serde_json::to_vec(&value).unwrap())
            .is_err());
        for bad in [
            &b""[..],
            b"{}",
            b"not json",
            b"{\"v\":1,\"backend\":\"dpapi-current-user\",\"ciphertext\":\"!!\"}",
        ] {
            assert!(sealer().open(PURPOSE, bad).is_err());
        }
        let mut oversized = sealed.clone();
        oversized.resize(MAX_ENVELOPE + 1, b' ');
        assert!(sealer().open(PURPOSE, &oversized).is_err());
    }

    #[test]
    fn inner_framing_is_strict() {
        let frame = sealer().frame(PURPOSE).unwrap();
        let framed = |length: u32, payload: &[u8]| {
            let mut inner = frame.clone();
            inner.extend_from_slice(&length.to_be_bytes());
            inner.extend_from_slice(payload);
            inner
        };
        let good = framed(3, b"abc");
        let ok = DpapiSealer::new(PROFILE, Returns(good.clone())).unwrap();
        assert_eq!(
            ok.open(PURPOSE, &envelope(b"x")).unwrap().as_slice(),
            b"abc"
        );
        let cases = [
            framed(4, b"abc"),                // length too long
            framed(2, b"abc"),                // trailing bytes
            framed(0, b""),                   // empty payload
            good[..good.len() - 1].to_vec(),  // truncated
            good[..frame.len() + 2].to_vec(), // truncated length
            b"bitsov-sealed-v1\0other".to_vec(),
        ];
        for inner in cases {
            let sealer = DpapiSealer::new(PROFILE, Returns(inner.clone())).unwrap();
            assert!(sealer.open(PURPOSE, &envelope(b"x")).is_err(), "{inner:?}");
        }
    }

    #[test]
    fn os_failures_and_bad_inputs_are_errors() {
        let failing = DpapiSealer::new(PROFILE, Fails).unwrap();
        assert_eq!(failing.seal(PURPOSE, b"x").unwrap_err(), "protect failed");
        assert_eq!(
            failing.open(PURPOSE, &envelope(b"x")).unwrap_err(),
            "unprotect failed"
        );
        assert!(sealer().seal(PURPOSE, b"").is_err());
        assert!(sealer().seal(PURPOSE, &[1; MAX_PAYLOAD + 1]).is_err());
        assert!(sealer().seal("", b"x").is_err());
        assert!(sealer().seal("a\0b", b"x").is_err());
        for profile in ["", "a\0b"] {
            assert!(DpapiSealer::new(profile, FakeProtect).is_err());
        }
    }

    #[test]
    fn never_falls_back_to_plaintext() {
        assert!(!sealer().allows_plaintext_fallback());
    }
}
