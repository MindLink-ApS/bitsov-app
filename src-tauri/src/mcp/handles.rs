//! Masked handles for the people an MCP client can see (the phone-book view).
//!
//! **Not wired** beyond the read path. An MCP client that reads `channels`
//! sees who the node has a channel with as a handle such as
//! `contact-k7m2q9xd`, and that channel's state, never the peer's key, a
//! channel id or any amount (owner GO, 26 Nov).
//!
//! A handle is a keyed BLAKE3 hash of the peer key, cut to 40 bits:
//! - **keyed** with 32 random bytes that never leave this computer, sealed in
//!   their own file under [`HANDLES_PURPOSE`], so a client cannot test guesses;
//! - **per client**: the client id and its approval time are hashed in, so two
//!   apps see different handles for one peer and cannot compare notes, and an
//!   app removed and paired again starts over;
//! - **stable** across reads and restarts while the key and the client stay.
//!
//! [`Handles::resolve`] maps a handle back to a peer on this computer, for the
//! later write path. Nothing calls it yet. Compiles only where its parent does.

use zeroize::Zeroizing;

use super::store::{FileIo, StoreError};
use crate::at_rest::Sealer;

/// The sealer purpose for the handle key.
pub const HANDLES_PURPOSE: &str = "mcp-handles-v1";
/// The key file's name, beside the clients file.
pub const FILE_NAME: &str = "mcp-handles.sealed";
/// Largest sealed key file read.
const MAX_FILE_BYTES: usize = 4096;
const DOMAIN: &[u8] = b"bitsov-mcp-handle-v1";
const PREFIX: &str = "contact-";
const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

/// The host-only key every handle is made with.
pub struct HandleKey(Zeroizing<[u8; 32]>);

impl std::fmt::Debug for HandleKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("HandleKey(..)")
    }
}

impl HandleKey {
    #[cfg(test)]
    pub(crate) fn from_bytes(bytes: [u8; 32]) -> Self {
        HandleKey(Zeroizing::new(bytes))
    }
}

/// Load the key, or make and save one when there is none. A file that is
/// there but does not open is an error, never replaced: handles would change
/// for every client. The caller then serves no channel read.
pub fn load_or_create(io: &dyn FileIo, sealer: Option<&dyn Sealer>) -> Result<HandleKey, StoreError> {
    let sealer = sealer.ok_or(StoreError::NoSealer)?;
    if let Some(sealed) = io.read(MAX_FILE_BYTES + 1).map_err(|error| StoreError::Io(error.to_string()))? {
        if sealed.len() > MAX_FILE_BYTES {
            return Err(StoreError::Unreadable);
        }
        let plain = sealer.open(HANDLES_PURPOSE, &sealed).map_err(|_| StoreError::Unreadable)?;
        let bytes: [u8; 32] = plain.as_slice().try_into().map_err(|_| StoreError::Unreadable)?;
        return Ok(HandleKey(Zeroizing::new(bytes)));
    }
    let mut bytes = Zeroizing::new([0u8; 32]);
    getrandom::fill(bytes.as_mut()).map_err(|_| StoreError::Io("no randomness".into()))?;
    let sealed = sealer.seal(HANDLES_PURPOSE, bytes.as_ref()).map_err(StoreError::Io)?;
    io.write(&sealed).map_err(|error| StoreError::Io(error.to_string()))?;
    Ok(HandleKey(bytes))
}

/// The handles one client sees.
#[derive(Clone)]
pub struct Handles {
    key: std::sync::Arc<HandleKey>,
    client: String,
    created_ms: u64,
}

impl std::fmt::Debug for Handles {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Handles").field("client", &self.client).finish_non_exhaustive()
    }
}

impl Handles {
    pub fn new(key: std::sync::Arc<HandleKey>, client: &str, created_ms: u64) -> Self {
        Handles { key, client: client.to_owned(), created_ms }
    }

    /// This client's handle for `peer` (the peer's key as the node gives it).
    pub fn handle(&self, peer: &str) -> String {
        let mut hasher = blake3::Hasher::new_keyed(&self.key.0);
        hasher.update(DOMAIN);
        for part in [self.client.as_bytes(), &self.created_ms.to_be_bytes(), peer.to_ascii_lowercase().as_bytes()] {
            hasher.update(&(part.len() as u64).to_be_bytes());
            hasher.update(part);
        }
        let digest = hasher.finalize();
        let bits = digest.as_bytes()[..5].iter().fold(0u64, |acc, byte| (acc << 8) | u64::from(*byte));
        let mut out = String::with_capacity(PREFIX.len() + 8);
        out.push_str(PREFIX);
        for index in (0..8).rev() {
            out.push(ALPHABET[((bits >> (index * 5)) & 31) as usize] as char);
        }
        out
    }

    /// The one peer among `peers` whose handle is `handle`. No match, or two
    /// peers with the same handle, is `None`: an intent is then refused.
    pub fn resolve<'a>(&self, handle: &str, peers: impl IntoIterator<Item = &'a str>) -> Option<&'a str> {
        pick(handle, peers, |peer| self.handle(peer))
    }
}

/// The single peer whose handle (by `handle_of`) is `handle`. The same peer
/// listed twice (two channels, any case) is one match; two different peers
/// with one handle is none.
fn pick<'a>(handle: &str, peers: impl IntoIterator<Item = &'a str>, handle_of: impl Fn(&str) -> String) -> Option<&'a str> {
    let mut found: Option<&'a str> = None;
    for peer in peers {
        if handle_of(peer) == handle {
            match found {
                Some(other) if !other.eq_ignore_ascii_case(peer) => return None,
                Some(_) => {}
                None => found = Some(peer),
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::store::testing::{MemFile, TagSealer};
    use std::sync::Arc;

    const PEER_A: &str = "02abababababababababababababababababababababababababababababababab";
    const PEER_B: &str = "03cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";

    fn handles(key: [u8; 32], client: &str, created_ms: u64) -> Handles {
        Handles::new(Arc::new(HandleKey::from_bytes(key)), client, created_ms)
    }

    #[test]
    fn a_handle_is_stable_per_client_and_never_shows_the_peer_key() {
        let desk = handles([1; 32], "mcp-01", 10);
        let a = desk.handle(PEER_A);
        assert_eq!(a, desk.handle(PEER_A), "stable across reads");
        assert_eq!(a, desk.handle(&PEER_A.to_ascii_uppercase()), "the key's case does not matter");
        assert_eq!(a.len(), "contact-".len() + 8);
        assert!(a.starts_with("contact-") && a["contact-".len()..].bytes().all(|b| ALPHABET.contains(&b)));
        assert_ne!(a, desk.handle(PEER_B));
        for peer in [PEER_A, PEER_B] {
            let handle = desk.handle(peer);
            for window in peer.as_bytes().windows(8) {
                assert!(!handle.contains(std::str::from_utf8(window).unwrap()), "{handle} shows part of {peer}");
            }
        }
        // Another app, the same app paired again, or another key: other handles.
        assert_ne!(a, handles([1; 32], "mcp-02", 10).handle(PEER_A));
        assert_ne!(a, handles([1; 32], "mcp-01", 11).handle(PEER_A));
        assert_ne!(a, handles([2; 32], "mcp-01", 10).handle(PEER_A));
    }

    #[test]
    fn a_handle_maps_back_to_its_peer_only_on_a_single_match() {
        let desk = handles([1; 32], "mcp-01", 10);
        let a = desk.handle(PEER_A);
        assert_eq!(desk.resolve(&a, [PEER_B, PEER_A]), Some(PEER_A));
        assert_eq!(desk.resolve("contact-aaaaaaaa", [PEER_A, PEER_B]), None);
        assert_eq!(desk.resolve(&a, [PEER_B]), None, "a peer no longer known is not found");
        // The same peer twice (two channels) is one match; a collision is refused.
        assert_eq!(desk.resolve(&a, [PEER_A, PEER_A]), Some(PEER_A));
        let upper = PEER_A.to_ascii_uppercase();
        assert_eq!(desk.resolve(&a, [PEER_A, upper.as_str()]), Some(PEER_A));
        // A forced collision: two different peers with one handle is refused.
        let same = |_: &str| "contact-aaaaaaaa".to_owned();
        assert_eq!(pick("contact-aaaaaaaa", [PEER_A, PEER_B], same), None);
        assert_eq!(pick("contact-aaaaaaaa", [PEER_A], same), Some(PEER_A));
    }

    #[test]
    fn the_key_is_made_once_sealed_and_a_damaged_file_is_never_replaced() {
        let (file, sealer) = (MemFile::default(), TagSealer);
        assert_eq!(load_or_create(&file, None).unwrap_err(), StoreError::NoSealer);
        let first = load_or_create(&file, Some(&sealer)).unwrap();
        let sealed = file.bytes.borrow().clone().unwrap();
        assert!(sealer.open(HANDLES_PURPOSE, &sealed).is_ok(), "sealed under its own purpose");
        assert!(sealer.open(super::super::store::CLIENTS_PURPOSE, &sealed).is_err());
        let again = load_or_create(&file, Some(&sealer)).unwrap();
        assert_eq!(*first.0, *again.0, "a restart reads the same key");
        assert_eq!(*file.bytes.borrow(), Some(sealed.clone()), "not rewritten");
        // A restart gives the same handles.
        let h1 = Handles::new(Arc::new(first), "mcp-01", 1).handle(PEER_A);
        let h2 = Handles::new(Arc::new(again), "mcp-01", 1).handle(PEER_A);
        assert_eq!(h1, h2);

        let mut bad = sealed.clone();
        bad[40] ^= 1;
        *file.bytes.borrow_mut() = Some(bad.clone());
        assert_eq!(load_or_create(&file, Some(&sealer)).unwrap_err(), StoreError::Unreadable);
        assert_eq!(*file.bytes.borrow(), Some(bad), "a damaged key file is left as it is");
        *file.bytes.borrow_mut() = Some(sealer.seal(HANDLES_PURPOSE, &[7; 31]).unwrap());
        assert_eq!(load_or_create(&file, Some(&sealer)).unwrap_err(), StoreError::Unreadable, "not 32 bytes");
        let failing = MemFile { fail_write: true, ..MemFile::default() };
        assert!(matches!(load_or_create(&failing, Some(&sealer)), Err(StoreError::Io(_))));
    }
}
