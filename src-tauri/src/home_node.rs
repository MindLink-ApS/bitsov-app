//! Wire contract for the seed-independent home-node transport and unlock proof.

use crate::remote_access::RemoteError;
use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BoxPin {
    pub node_id: String,
    pub endpoint: String,
    pub public_key: String,
    pub signature: String,
}

fn invalid() -> RemoteError {
    RemoteError::Invalid("box transport proof is invalid".into())
}

impl BoxPin {
    pub fn verify(
        node: &str,
        endpoint: &str,
        key: &str,
        signature: &str,
    ) -> Result<Self, RemoteError> {
        let node_bytes: [u8; 32] = hex::decode(node)
            .map_err(|_| invalid())?
            .try_into()
            .map_err(|_| invalid())?;
        let key_bytes: [u8; 32] = hex::decode(key)
            .map_err(|_| invalid())?
            .try_into()
            .map_err(|_| invalid())?;
        if hex::encode(node_bytes) != node || hex::encode(key_bytes) != key || key_bytes == [0; 32]
        {
            return Err(invalid());
        }
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(signature)
            .map_err(|_| invalid())?;
        if base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&bytes) != signature {
            return Err(invalid());
        }
        let signature_bytes: [u8; 64] = bytes.try_into().map_err(|_| invalid())?;
        VerifyingKey::from_bytes(&node_bytes)
            .map_err(|_| invalid())?
            .verify_strict(
                format!("bitsov-box-transport-v1:{node}:{key}").as_bytes(),
                &Signature::from_bytes(&signature_bytes),
            )
            .map_err(|_| invalid())?;
        Ok(Self {
            node_id: node.into(),
            endpoint: endpoint.into(),
            public_key: key.into(),
            signature: signature.into(),
        })
    }
    pub fn matches(&self, remote: &[u8]) -> bool {
        hex::encode(remote) == self.public_key
    }
}

/// Production implementation uses macOS Keychain. Tests use an isolated memory store.
/// Implementations must key records by node_id, and never invent a missing pin.
pub trait BoxPinStore: Send + Sync {
    fn read(&self, node_id: &str) -> Result<Option<BoxPin>, RemoteError>;
    fn save(&self, pin: &BoxPin) -> Result<(), RemoteError>;
}

pub fn identity_fingerprint(node: &str) -> String {
    let digest = blake3::keyed_hash(
        blake3::hash(b"bitsov-identity-fingerprint-v1").as_bytes(),
        node.as_bytes(),
    );
    hex::encode(&digest.as_bytes()[..16])
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UnlockBinding {
    pub client_id: String,
    pub epoch: u64,
    pub fingerprint: String,
}
impl UnlockBinding {
    /// Called only on a token delivered by the identity-pinned unlocked session.
    /// This does not authenticate an arbitrary JWT and must never be exposed as IPC.
    pub fn from_session(node: &str, client: &str, token: &str) -> Result<Self, String> {
        #[derive(Deserialize)]
        struct Claims {
            cid: String,
            epc: u64,
            idf: String,
        }
        let parse = || -> Option<Claims> {
            let parts: Vec<_> = token.split('.').collect();
            if parts.len() != 3 {
                return None;
            }
            let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(parts[1])
                .ok()?;
            serde_json::from_slice(&bytes).ok()
        };
        let claims = parse().ok_or("The node did not provide an unlock binding.")?;
        if claims.cid != client || claims.idf != identity_fingerprint(node) {
            return Err("The unlock binding does not match this node and client.".into());
        }
        Ok(Self {
            client_id: claims.cid,
            epoch: claims.epc,
            fingerprint: claims.idf,
        })
    }
}

#[derive(Deserialize)]
pub struct LockStatus {
    #[serde(default)]
    pub attempts_left: Option<u32>,
    pub state: String,
    pub node_id: String,
    pub fingerprint: String,
}

#[derive(Deserialize)]
pub struct UnlockChallenge {
    pub challenge: String,
    pub expires_at: i64,
    pub key_ids: Vec<String>,
}
impl UnlockChallenge {
    pub fn message(
        &self,
        binding: &UnlockBinding,
        key: &str,
        box_key: &str,
        _now: i64,
    ) -> Result<String, String> {
        // Expiry is the node's job: it issued the challenge, consumes it on first use
        // and enforces its own 120 s TTL. A Pi has no RTC, so after a power cut its
        // clock can be far from the Mac's; comparing clocks here would reject every
        // challenge without adding safety.
        if self.challenge.len() != 64
            || !self
                .challenge
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || !self.key_ids.iter().any(|id| id == key)
        {
            return Err("The unlock challenge expired or this device is not enrolled.".into());
        }
        Ok(format!("bitsov-node-unlock-v1\nnode:{}\nclient:{}\nepoch:{}\nkey:{key}\nchallenge:{}\nbox_transport:{box_key}", binding.fingerprint, binding.client_id, binding.epoch, self.challenge))
    }
}

#[derive(Serialize)]
pub struct UnlockBody {
    pub challenge: String,
    pub key_id: String,
    pub signature: String,
    pub password: zeroize::Zeroizing<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> serde_json::Value {
        serde_json::from_str(include_str!("../tests/fixtures/home-node.json")).unwrap()
    }
    #[test]
    fn refreshed_token_updates_unlock_epoch_and_rejects_other_bindings() {
        let f = fixture();
        let node = f["node_id"].as_str().unwrap();
        let claims = |epoch: u64, cid: &str, idf: &str| {
            format!(
                "header.{}.signature",
                base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
                    serde_json::to_vec(&serde_json::json!({"cid":cid,"epc":epoch,"idf":idf}))
                        .unwrap()
                )
            )
        };
        let fingerprint = identity_fingerprint(node);
        let first = UnlockBinding::from_session(node, "client", &claims(1, "client", &fingerprint))
            .unwrap();
        let refreshed =
            UnlockBinding::from_session(node, "client", &claims(2, "client", &fingerprint))
                .unwrap();
        let challenge = UnlockChallenge {
            challenge: "aa".repeat(32),
            expires_at: 100,
            key_ids: vec!["key".into()],
        };
        assert!(challenge
            .message(&first, "key", "box", 1)
            .unwrap()
            .contains("\nepoch:1\n"));
        assert!(challenge
            .message(&refreshed, "key", "box", 1)
            .unwrap()
            .contains("\nepoch:2\n"));
        assert!(
            UnlockBinding::from_session(node, "client", &claims(2, "other", &fingerprint)).is_err()
        );
        assert!(
            UnlockBinding::from_session(node, "client", &claims(2, "client", "other")).is_err()
        );
        assert!(UnlockBinding::from_session(node, "client", "malformed").is_err());
    }
    #[test]
    fn signed_box_fixture_rejects_tampering_and_other_identities() {
        let f = fixture();
        let node = f["node_id"].as_str().unwrap();
        let key = f["auth"]["box_transport_pubkey"].as_str().unwrap();
        let sig = f["auth"]["box_transport_signature"].as_str().unwrap();
        assert!(BoxPin::verify(node, "node.example:4242", key, sig).is_ok());
        assert!(BoxPin::verify(node, "node.example:4242", &"ab".repeat(32), sig).is_err());
        assert!(BoxPin::verify(&"ab".repeat(32), "node.example:4242", key, sig).is_err());
        assert!(BoxPin::verify(node, "node.example:4242", key, &format!("{sig}=")).is_err());
    }
    #[test]
    fn unlock_signature_binds_every_field_and_rejects_unknown_keys() {
        let binding = UnlockBinding {
            client_id: "client".into(),
            epoch: 7,
            fingerprint: "fp".into(),
        };
        let c = UnlockChallenge {
            challenge: "aa".repeat(32),
            expires_at: 120,
            key_ids: vec!["key".into()],
        };
        assert_eq!(c.message(&binding, "key", "box", 1).unwrap(), format!("bitsov-node-unlock-v1\nnode:fp\nclient:client\nepoch:7\nkey:key\nchallenge:{}\nbox_transport:box", "aa".repeat(32)));
        assert!(c.message(&binding, "other", "box", 1).is_err());
        // Box clock skew (RTC-less Pi after a power cut) must not block unlock.
        assert!(c.message(&binding, "key", "box", 120).is_ok());
        assert!(c.message(&binding, "key", "box", -100_000).is_ok());
        let mut invalid = c;
        invalid.challenge = "bad\nchallenge".into();
        assert!(invalid.message(&binding, "key", "box", 1).is_err());
    }
}
