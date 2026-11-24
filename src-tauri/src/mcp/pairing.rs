//! MCP phase 1, slice 5: pairing requests the owner approves in the app.
//!
//! **Not wired.** Pure, in-memory state: nothing here opens a socket, pipe or
//! port, writes a file, reads the node, or touches a wallet or payment path.
//! It compiles only where its parent module does (`cfg(test)` or the
//! off-by-default `mcp-grant` feature).
//!
//! A client's shim asks to pair with a declared name and a random nonce. The
//! host answers with its own nonce and a new client id, and both sides show
//! the same six-word [`code`], derived from both nonces and the name, so the
//! owner can see the request in the app is the one their client made. A
//! request expires after [`REQUEST_TTL_MS`]; at most [`MAX_PENDING`] wait at
//! once. Approval issues the client's key (slice 4) and adds it, with the
//! topics the owner chose, to the registry (slice 2). Denial drops it.

use std::collections::HashMap;

use super::identity::{Identities, Issued};
use super::session::{Registry, MAX_CLIENT_NAME};
use crate::ai::Topic;

/// How long a pairing request waits for the owner.
pub const REQUEST_TTL_MS: u64 = 5 * 60_000;
/// Requests waiting at once; more are refused until one is settled or expires.
pub const MAX_PENDING: usize = 4;

/// The six words both sides show (shared with the shim, which computes them
/// itself from both nonces and the cleaned name).
pub use bitsov_mcp_wire::pair_code as code;

/// One request as the app shows it to the owner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shown {
    pub id: String,
    pub name: String,
    pub code: [&'static str; 6],
}

/// What the shim gets back on a request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Asked {
    pub id: String,
    pub host_nonce: [u8; 32],
    pub code: [&'static str; 6],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairError {
    /// Too many requests waiting.
    Busy,
    /// No such request: never made, settled, or expired.
    Unknown,
    /// The name is empty once cleaned.
    BadName,
    /// The system gave no randomness, or a key could not be issued.
    Failed,
}

struct Pending {
    name: String,
    code: [&'static str; 6],
    expires_ms: u64,
}

/// Requests waiting for the owner.
#[derive(Default)]
pub struct Pairing {
    pending: HashMap<String, Pending>,
}

use bitsov_mcp_wire::clean_name;
const _: () = assert!(bitsov_mcp_wire::MAX_CLIENT_NAME == MAX_CLIENT_NAME);

impl Pairing {
    fn prune(&mut self, now_ms: u64) {
        self.pending.retain(|_, request| now_ms < request.expires_ms);
    }

    /// A shim asks to pair. The name is cleaned (control and bidi characters
    /// dropped, capped) before it is shown or hashed.
    pub fn request(&mut self, name: &str, shim_nonce: &[u8; 32], now_ms: u64) -> Result<Asked, PairError> {
        self.prune(now_ms);
        let name = clean_name(name);
        if name.is_empty() {
            return Err(PairError::BadName);
        }
        if self.pending.len() >= MAX_PENDING {
            return Err(PairError::Busy);
        }
        let mut host_nonce = [0u8; 32];
        let mut raw_id = [0u8; 8];
        getrandom::fill(&mut host_nonce).map_err(|_| PairError::Failed)?;
        getrandom::fill(&mut raw_id).map_err(|_| PairError::Failed)?;
        let id = format!("mcp-{}", raw_id.iter().map(|b| format!("{b:02x}")).collect::<String>());
        let code = code(shim_nonce, &host_nonce, &name);
        self.pending.insert(id.clone(), Pending { name, code, expires_ms: now_ms.saturating_add(REQUEST_TTL_MS) });
        Ok(Asked { id, host_nonce, code })
    }

    /// The requests waiting for the owner, sorted by id.
    pub fn waiting(&mut self, now_ms: u64) -> Vec<Shown> {
        self.prune(now_ms);
        let mut shown: Vec<Shown> = self.pending.iter()
            .map(|(id, request)| Shown { id: id.clone(), name: request.name.clone(), code: request.code })
            .collect();
        shown.sort_by(|a, b| a.id.cmp(&b.id));
        shown
    }

    /// The owner approves `id` with the topics they chose: the client gets
    /// its key and its place in the registry, and the request is gone.
    pub fn approve(
        &mut self,
        id: &str,
        allowed: &[Topic],
        now_ms: u64,
        registry: &mut Registry,
        identities: &mut Identities,
    ) -> Result<Issued, PairError> {
        self.prune(now_ms);
        if !self.pending.contains_key(id) {
            return Err(PairError::Unknown);
        }
        // Issue first: a failed issue leaves the request waiting, so the owner can try again.
        let issued = identities.issue(id).map_err(|_| PairError::Failed)?;
        let request = self.pending.remove(id).ok_or(PairError::Unknown)?;
        registry.add(id, &request.name, allowed);
        Ok(issued)
    }

    /// The owner says no. True when the request was waiting.
    pub fn deny(&mut self, id: &str, now_ms: u64) -> bool {
        self.prune(now_ms);
        self.pending.remove(id).is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::identity::{sign, IdentityError};

    const SHIM: [u8; 32] = [3u8; 32];

    #[test]
    fn both_sides_compute_the_same_six_words_and_any_change_alters_them() {
        let host = [5u8; 32];
        let words = code(&SHIM, &host, "Desk assistant");
        assert_eq!(words, code(&SHIM, &host, "Desk assistant"));
        assert!(words.iter().all(|w| bip39::Language::English.word_list().contains(w)));
        assert_ne!(words, code(&[4u8; 32], &host, "Desk assistant"), "another shim nonce");
        assert_ne!(words, code(&SHIM, &[6u8; 32], "Desk assistant"), "another host nonce");
        assert_ne!(words, code(&SHIM, &host, "Desk assistant 2"), "another name");
    }

    #[test]
    fn the_owner_sees_the_request_and_approval_pairs_the_client() {
        let (mut pairing, mut registry, mut identities) = (Pairing::default(), Registry::default(), Identities::default());
        let asked = pairing.request("Desk assistant", &SHIM, 0).unwrap();
        assert_eq!(asked.code, code(&SHIM, &asked.host_nonce, "Desk assistant"), "the shim can compute the same code");
        assert_eq!(pairing.waiting(1), vec![Shown { id: asked.id.clone(), name: "Desk assistant".into(), code: asked.code }]);

        let issued = pairing.approve(&asked.id, &[Topic::Node, Topic::Inbox], 2, &mut registry, &mut identities).unwrap();
        let client = registry.active(&asked.id).expect("in the registry");
        assert_eq!(client.name, "Desk assistant");
        assert_eq!(client.allowed, [Topic::Node, Topic::Inbox]);
        // The issued key opens a session.
        let challenge = identities.challenge(&asked.id, 3).unwrap();
        assert!(identities.verify(&asked.id, &challenge, &sign(&issued.secret, &asked.id, &challenge), 4));
        // Settled: no longer waiting, and cannot be approved twice.
        assert!(pairing.waiting(5).is_empty());
        assert_eq!(pairing.approve(&asked.id, &[], 6, &mut registry, &mut identities).err(), Some(PairError::Unknown));
    }

    #[test]
    fn a_failed_approval_leaves_the_request_waiting() {
        let (mut pairing, mut registry, mut identities) = (Pairing::default(), Registry::default(), Identities::default());
        // A request whose id the identity store refuses makes the key issue fail.
        pairing.pending.insert("not a plain id".into(), Pending { name: "Desk".into(), code: code(&SHIM, &[1u8; 32], "Desk"), expires_ms: REQUEST_TTL_MS });
        assert_eq!(pairing.approve("not a plain id", &[Topic::Node], 0, &mut registry, &mut identities).err(), Some(PairError::Failed));
        assert_eq!(pairing.waiting(0).len(), 1, "still waiting for the owner");
        assert!(registry.active("not a plain id").is_none(), "nothing was added");
    }

    #[test]
    fn a_denied_or_expired_request_never_pairs() {
        let (mut pairing, mut registry, mut identities) = (Pairing::default(), Registry::default(), Identities::default());
        let denied = pairing.request("Notes app", &SHIM, 0).unwrap();
        assert!(pairing.deny(&denied.id, 1));
        assert!(!pairing.deny(&denied.id, 1));
        assert_eq!(pairing.approve(&denied.id, &[Topic::Node], 2, &mut registry, &mut identities).err(), Some(PairError::Unknown));

        let late = pairing.request("Notes app", &SHIM, 0).unwrap();
        assert_eq!(pairing.approve(&late.id, &[Topic::Node], REQUEST_TTL_MS, &mut registry, &mut identities).err(), Some(PairError::Unknown));
        assert!(registry.active(&denied.id).is_none() && registry.active(&late.id).is_none());
        assert_eq!(identities.challenge(&late.id, 0), Err(IdentityError::UnknownClient), "no key was issued");
    }

    #[test]
    fn at_most_four_wait_and_expired_ones_make_room() {
        let mut pairing = Pairing::default();
        for i in 0..MAX_PENDING as u64 {
            pairing.request("Client", &SHIM, i).unwrap();
        }
        assert_eq!(pairing.request("One more", &SHIM, 10).err(), Some(PairError::Busy));
        assert_eq!(pairing.request("One more", &SHIM, REQUEST_TTL_MS).map(|a| a.id.len()).ok(), Some("mcp-".len() + 16), "the first expired");
    }

    #[test]
    fn names_are_cleaned_before_they_are_shown_and_ids_are_fresh_and_plain() {
        let mut pairing = Pairing::default();
        assert_eq!(pairing.request(" \u{202e}\u{0007} ", &SHIM, 0).err(), Some(PairError::BadName));
        let a = pairing.request("Evil\u{202e}name\n", &SHIM, 0).unwrap();
        let b = pairing.request("Evil\u{202e}name\n", &SHIM, 0).unwrap();
        assert_ne!(a.id, b.id);
        assert_ne!(a.code, b.code, "a fresh host nonce each time");
        let shown = pairing.waiting(0);
        assert!(shown.iter().all(|s| s.name == "Evilname"));
        assert!(a.id.starts_with("mcp-") && a.id[4..].bytes().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(a.code, code(&SHIM, &a.host_nonce, "Evilname"), "the code covers the cleaned name");
    }
}
