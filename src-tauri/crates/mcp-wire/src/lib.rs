//! The wire format of the BitSov MCP endpoint (ADR H3953 A1 §1.4), in one
//! place for both sides: the host in the app and the `bitsov-mcp` shim. If
//! these bytes differed between the two, a session or a pairing code would
//! silently fail to match.
//!
//! - One frame is one line of JSON, at most [`MAX_FRAME_BYTES`] before the
//!   newline ([`read_frame`]).
//! - A session is opened by signing [`session_message`] ([`sign`]).
//! - A pairing shows the same six words on both sides ([`pair_code`]), over
//!   the name as the host cleans it ([`clean_name`]).
//!
//! Nothing here opens a connection, reads a file or touches the node.

#![forbid(unsafe_code)]

use std::io::BufRead;

use ed25519_dalek::{Signer, SigningKey};

/// Longest frame, in bytes, before its newline.
pub const MAX_FRAME_BYTES: usize = 64 * 1024;
/// Longest client name, in characters, after cleaning.
pub const MAX_CLIENT_NAME: usize = 64;
/// The socket's file name inside the endpoint directory (macOS).
pub const SOCKET_NAME: &str = "mcp.sock";

const SESSION_DOMAIN: &[u8] = b"bitsov-mcp-session-v1";
const PAIR_DOMAIN: &[u8] = b"bitsov-mcp-pair-v1";

/// The bytes a shim signs to open a session: domain, client id, challenge.
/// The id's length is part of the message, so no two ids can collide.
pub fn session_message(client: &str, challenge: &[u8; 32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(SESSION_DOMAIN.len() + 2 + client.len() + 32);
    out.extend_from_slice(SESSION_DOMAIN);
    out.extend_from_slice(&(client.len() as u16).to_be_bytes());
    out.extend_from_slice(client.as_bytes());
    out.extend_from_slice(challenge);
    out
}

/// What a shim does with its secret: sign the session message.
pub fn sign(secret: &[u8; 32], client: &str, challenge: &[u8; 32]) -> [u8; 64] {
    SigningKey::from_bytes(secret).sign(&session_message(client, challenge)).to_bytes()
}

/// A declared client name as the host keeps it: control and bidi characters
/// dropped, at most [`MAX_CLIENT_NAME`] characters, trimmed.
pub fn clean_name(name: &str) -> String {
    name.chars()
        .filter(|c| !c.is_control() && !matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'))
        .take(MAX_CLIENT_NAME)
        .collect::<String>()
        .trim()
        .to_owned()
}

/// The six words both sides show: 66 bits of a hash over the domain, both
/// nonces and the cleaned name, as BIP-39 English words.
pub fn pair_code(shim_nonce: &[u8; 32], host_nonce: &[u8; 32], name: &str) -> [&'static str; 6] {
    let mut hasher = blake3::Hasher::new();
    hasher.update(PAIR_DOMAIN);
    hasher.update(shim_nonce);
    hasher.update(host_nonce);
    hasher.update(&(name.len() as u64).to_be_bytes());
    hasher.update(name.as_bytes());
    let digest = hasher.finalize();
    let bits = u128::from_be_bytes(digest.as_bytes()[..16].try_into().expect("16 bytes"));
    let list = bip39::Language::English.word_list();
    std::array::from_fn(|i| list[((bits >> (128 - 11 * (i + 1))) & 2047) as usize])
}

/// Read one frame: bytes up to a newline, without it. `None` at end of
/// stream. A line longer than `max` is an error, read no further than
/// `max + 1` bytes.
pub fn read_frame(reader: &mut impl BufRead, max: usize) -> std::io::Result<Option<Vec<u8>>> {
    let mut buf = Vec::new();
    let read = std::io::Read::take(&mut *reader, max as u64 + 1).read_until(b'\n', &mut buf)?;
    if read == 0 {
        return Ok(None);
    }
    if buf.last() == Some(&b'\n') {
        buf.pop();
    } else if buf.len() > max {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "frame too large"));
    }
    Ok(Some(buf))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    #[test]
    fn a_signature_verifies_only_for_its_client_and_challenge() {
        let secret = [7u8; 32];
        let public: VerifyingKey = SigningKey::from_bytes(&secret).verifying_key();
        let signature = Signature::from_bytes(&sign(&secret, "mcp-01", &[1u8; 32]));
        assert!(public.verify(&session_message("mcp-01", &[1u8; 32]), &signature).is_ok());
        assert!(public.verify(&session_message("mcp-02", &[1u8; 32]), &signature).is_err());
        assert!(public.verify(&session_message("mcp-01", &[2u8; 32]), &signature).is_err());
        // The length prefix keeps "ab"+challenge apart from "a"+"b…".
        assert_ne!(session_message("ab", &[0u8; 32])[..23], session_message("a", &[b'b'; 32])[..23]);
    }

    #[test]
    fn the_pair_code_is_six_words_and_depends_on_every_input() {
        let words = pair_code(&[1u8; 32], &[2u8; 32], "Desk");
        assert_eq!(words, pair_code(&[1u8; 32], &[2u8; 32], "Desk"));
        assert_ne!(words, pair_code(&[3u8; 32], &[2u8; 32], "Desk"));
        assert_ne!(words, pair_code(&[1u8; 32], &[3u8; 32], "Desk"));
        assert_ne!(words, pair_code(&[1u8; 32], &[2u8; 32], "Desk2"));
    }

    #[test]
    fn names_are_cleaned_and_capped() {
        assert_eq!(clean_name("  Desk\u{202e}\n assistant "), "Desk assistant");
        assert_eq!(clean_name(&"x".repeat(100)).chars().count(), MAX_CLIENT_NAME);
        assert_eq!(clean_name("\u{2066}\t"), "");
    }

    #[test]
    fn frames_are_lines_up_to_the_cap() {
        let mut input = std::io::Cursor::new(b"{\"a\":1}\n{\"b\":2}".to_vec());
        assert_eq!(read_frame(&mut input, 64).unwrap(), Some(br#"{"a":1}"#.to_vec()));
        assert_eq!(read_frame(&mut input, 64).unwrap(), Some(br#"{"b":2}"#.to_vec()));
        assert_eq!(read_frame(&mut input, 64).unwrap(), None);
        let mut exact = vec![b'y'; MAX_FRAME_BYTES];
        exact.push(b'\n');
        assert_eq!(read_frame(&mut std::io::Cursor::new(exact), MAX_FRAME_BYTES).unwrap().map(|f| f.len()), Some(MAX_FRAME_BYTES));
        assert!(read_frame(&mut std::io::Cursor::new(vec![b'x'; 200]), 64).is_err());
    }
}
