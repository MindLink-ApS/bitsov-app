//! MCP phase 1, slice 4: per-client keys and a single-use challenge.
//!
//! **Not wired.** Pure, in-memory state: nothing here opens a socket, pipe or
//! port, writes a file, reads the node, or touches a wallet or payment path.
//! It compiles only where its parent module does (`cfg(test)` or the
//! off-by-default `mcp-grant` feature).
//!
//! When the owner approves a client, the host makes an Ed25519 key for it and
//! keeps only the public half; the secret half goes to the client's shim once.
//! A session starts by proving that key: the host hands out a random
//! challenge, the shim signs [`message`] (version, client id, challenge), and
//! [`Identities::verify`] checks it. A challenge is used at most once, expires
//! after [`CHALLENGE_TTL_MS`], and a newer one replaces it, so a recorded
//! session cannot be replayed. Revoke drops the key and any open challenge.

use std::collections::HashMap;

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use zeroize::Zeroizing;

/// How long a challenge may be answered.
pub const CHALLENGE_TTL_MS: u64 = 30_000;
/// Domain separation for what a shim signs.
const DOMAIN: &[u8] = b"bitsov-mcp-session-v1";
/// Longest client id accepted (bytes).
pub const MAX_CLIENT_ID: usize = 64;

/// The bytes a shim signs to open a session: domain, client id, challenge.
/// The id's length is part of the message, so no two ids can collide.
pub fn message(client: &str, challenge: &[u8; 32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(DOMAIN.len() + 2 + client.len() + 32);
    out.extend_from_slice(DOMAIN);
    out.extend_from_slice(&(client.len() as u16).to_be_bytes());
    out.extend_from_slice(client.as_bytes());
    out.extend_from_slice(challenge);
    out
}

/// What the shim gets once, on approval: the secret half of its key.
pub struct Issued {
    pub secret: Zeroizing<[u8; 32]>,
}

/// Why a key could not be issued or a challenge not given.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentityError {
    /// Empty, too long, or not plain ASCII letters, digits, `-` and `_`.
    BadClientId,
    /// The system gave no randomness.
    NoRandomness,
    /// No key for this client (never issued, or revoked).
    UnknownClient,
}

struct Pending {
    challenge: [u8; 32],
    expires_ms: u64,
}

/// The host's per-client public keys and open challenges.
#[derive(Default)]
pub struct Identities {
    keys: HashMap<String, VerifyingKey>,
    pending: HashMap<String, Pending>,
}

fn plain_id(client: &str) -> bool {
    !client.is_empty() && client.len() <= MAX_CLIENT_ID
        && client.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn random32() -> Result<[u8; 32], IdentityError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| IdentityError::NoRandomness)?;
    Ok(bytes)
}

impl Identities {
    /// Makes a fresh key for `client` (replacing any earlier one, so an old
    /// shim key stops working) and returns its secret half, once.
    pub fn issue(&mut self, client: &str) -> Result<Issued, IdentityError> {
        if !plain_id(client) {
            return Err(IdentityError::BadClientId);
        }
        let secret = Zeroizing::new(random32()?);
        let key = SigningKey::from_bytes(&secret);
        self.keys.insert(client.to_owned(), key.verifying_key());
        self.pending.remove(client);
        Ok(Issued { secret })
    }

    /// A new challenge for `client`, valid until `now_ms + CHALLENGE_TTL_MS`.
    /// It replaces any challenge the client had not answered yet.
    pub fn challenge(&mut self, client: &str, now_ms: u64) -> Result<[u8; 32], IdentityError> {
        if !self.keys.contains_key(client) {
            return Err(IdentityError::UnknownClient);
        }
        let challenge = random32()?;
        self.pending.insert(client.to_owned(), Pending { challenge, expires_ms: now_ms.saturating_add(CHALLENGE_TTL_MS) });
        Ok(challenge)
    }

    /// True only for a signature by `client`'s current key over [`message`]
    /// for its open, unexpired challenge. The challenge is used up either way.
    pub fn verify(&mut self, client: &str, challenge: &[u8; 32], signature: &[u8], now_ms: u64) -> bool {
        let Some(pending) = self.pending.remove(client) else { return false };
        if pending.challenge != *challenge || now_ms >= pending.expires_ms {
            return false;
        }
        let (Some(key), Ok(signature)) = (self.keys.get(client), Signature::from_slice(signature)) else {
            return false;
        };
        key.verify_strict(&message(client, challenge), &signature).is_ok()
    }

    /// Drops the client's key and open challenge. True when it had a key.
    pub fn revoke(&mut self, client: &str) -> bool {
        self.pending.remove(client);
        self.keys.remove(client).is_some()
    }
}

/// What a shim does with its secret: sign the session message. For tests and
/// for the shim; the host never holds a client's secret after issuing it.
pub fn sign(secret: &[u8; 32], client: &str, challenge: &[u8; 32]) -> [u8; 64] {
    SigningKey::from_bytes(secret).sign(&message(client, challenge)).to_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paired(ids: &mut Identities, client: &str) -> Issued {
        ids.issue(client).expect("issued")
    }

    #[test]
    fn a_shim_with_its_key_opens_a_session() {
        let mut ids = Identities::default();
        let issued = paired(&mut ids, "desk");
        let challenge = ids.challenge("desk", 1_000).unwrap();
        let signature = sign(&issued.secret, "desk", &challenge);
        assert!(ids.verify("desk", &challenge, &signature, 1_500));
    }

    #[test]
    fn a_recorded_session_cannot_be_replayed() {
        let mut ids = Identities::default();
        let issued = paired(&mut ids, "desk");
        let challenge = ids.challenge("desk", 0).unwrap();
        let signature = sign(&issued.secret, "desk", &challenge);
        assert!(ids.verify("desk", &challenge, &signature, 1));
        // The same answer again, even within the time limit.
        assert!(!ids.verify("desk", &challenge, &signature, 2));
        // A fresh challenge needs a fresh signature.
        let next = ids.challenge("desk", 3).unwrap();
        assert_ne!(next, challenge);
        assert!(!ids.verify("desk", &next, &signature, 4));
    }

    #[test]
    fn a_late_answer_or_an_old_challenge_is_refused_and_used_up() {
        let mut ids = Identities::default();
        let issued = paired(&mut ids, "desk");
        let challenge = ids.challenge("desk", 0).unwrap();
        let signature = sign(&issued.secret, "desk", &challenge);
        assert!(!ids.verify("desk", &challenge, &signature, CHALLENGE_TTL_MS));
        assert!(!ids.verify("desk", &challenge, &signature, 1), "a refused try uses the challenge up");

        let old = ids.challenge("desk", 0).unwrap();
        let newer = ids.challenge("desk", 1).unwrap();
        assert!(!ids.verify("desk", &old, &sign(&issued.secret, "desk", &old), 2), "a newer challenge replaces it");
        let _ = newer;
    }

    #[test]
    fn a_wrong_key_another_client_or_a_bad_signature_is_refused() {
        let mut ids = Identities::default();
        let desk = paired(&mut ids, "desk");
        let notes = paired(&mut ids, "notes");
        let challenge = ids.challenge("desk", 0).unwrap();
        assert!(!ids.verify("desk", &challenge, &sign(&notes.secret, "desk", &challenge), 1), "another client's key");

        let challenge = ids.challenge("desk", 0).unwrap();
        assert!(!ids.verify("desk", &challenge, &sign(&desk.secret, "notes", &challenge), 1), "signed for another client id");

        let challenge = ids.challenge("desk", 0).unwrap();
        assert!(!ids.verify("desk", &challenge, &[0u8; 64], 1));
        let challenge = ids.challenge("desk", 0).unwrap();
        assert!(!ids.verify("desk", &challenge, &[1u8; 10], 1), "a short signature");

        // The notes client's challenge cannot be answered on desk's behalf.
        let notes_challenge = ids.challenge("notes", 0).unwrap();
        assert!(!ids.verify("desk", &notes_challenge, &sign(&desk.secret, "desk", &notes_challenge), 1));
    }

    #[test]
    fn revoke_and_reissue_end_the_old_key() {
        let mut ids = Identities::default();
        let first = paired(&mut ids, "desk");
        let open = ids.challenge("desk", 0).unwrap();
        assert!(ids.revoke("desk"));
        assert!(!ids.revoke("desk"));
        assert!(!ids.verify("desk", &open, &sign(&first.secret, "desk", &open), 1), "an open challenge dies with the key");
        assert_eq!(ids.challenge("desk", 0), Err(IdentityError::UnknownClient));

        let second = paired(&mut ids, "desk");
        assert_ne!(*first.secret, *second.secret);
        let challenge = ids.challenge("desk", 0).unwrap();
        assert!(!ids.verify("desk", &challenge, &sign(&first.secret, "desk", &challenge), 1), "the old shim key no longer works");
        let challenge = ids.challenge("desk", 0).unwrap();
        assert!(ids.verify("desk", &challenge, &sign(&second.secret, "desk", &challenge), 1));
    }

    #[test]
    fn only_plain_client_ids_get_a_key_and_unknown_ones_no_challenge() {
        let mut ids = Identities::default();
        for bad in ["", "a b", "désk", "../x", "a\u{202e}b", &"x".repeat(MAX_CLIENT_ID + 1)] {
            assert_eq!(ids.issue(bad).err(), Some(IdentityError::BadClientId), "{bad:?}");
        }
        assert!(ids.issue(&"x".repeat(MAX_CLIENT_ID)).is_ok());
        assert_eq!(ids.challenge("stranger", 0), Err(IdentityError::UnknownClient));
        assert!(!ids.verify("stranger", &[0u8; 32], &[0u8; 64], 0));
    }

    #[test]
    fn the_signed_message_binds_the_client_id_unambiguously() {
        let c = [9u8; 32];
        assert_ne!(message("ab", &c), message("a", &c));
        assert!(message("desk", &c).starts_with(DOMAIN));
        assert!(message("desk", &c).ends_with(&c));
    }
}
