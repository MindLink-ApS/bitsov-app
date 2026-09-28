//! K1 introductions (slice 1), host side: read and verify a scanned or pasted
//! door card before the renderer shows it.
//!
//! Format owner: genome `konsensus_core::introduction` (`introduction_v1`).
//! This is an independent reader of the same bytes, pinned to the genome's
//! test vector. Gate G1 keeps konsensus crates out of the app, so the format
//! is re-implemented rather than linked.
//!
//! **An introduction is never admission.** Reading one is local: no request,
//! no payment, no stored contact. The app never dials the card's endpoint
//! itself. On Continue, the node verifies the card again, pins its DNS and
//! dials it unprivileged. Every act after that is paid as for any stranger.

use base64_url as b64;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};

/// `/status` capability of a node that signs and opens introductions.
pub const CAPABILITY: &str = "introduction_v1";
const DOMAIN_V1: &[u8] = b"bitsov-introduction/v1\0";
const VERSION: u8 = 1;
pub const LINK_PREFIX: &str = "bitsov://introduce#";
const LIFETIME_SECS: u64 = 600;
const MAX_SKEW_SECS: u64 = 60;
/// K1: a card is at most 2 KiB however it arrives.
pub const MAX_ENCODED_LEN: usize = 2048;
const MAX_ENDPOINT_LEN: usize = 255;
const NETWORKS: [&str; 4] = ["bitcoin", "testnet", "signet", "regtest"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Reach {
    Public,
    Local,
}

/// The signed card, as the node's JSON names it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Card {
    pub v: u8,
    pub network: String,
    pub node_id: String,
    pub endpoint: String,
    pub reach: Reach,
    pub admission_msat: u64,
    pub message_msat: u64,
    pub price_epoch: u64,
    pub issued_at: u64,
    pub expires_at: u64,
    pub intro_id: String,
    pub sig: String,
}

/// What the renderer may show: a verified card, never the raw input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DoorCard {
    pub node_id: String,
    pub network: String,
    pub endpoint: String,
    pub reach: Reach,
    pub admission_msat: u64,
    pub message_msat: u64,
    pub issued_at: u64,
    pub expires_at: u64,
    /// The canonical link, for the QR and for Continue.
    pub link: String,
    /// K1 slice 2: the verified starter-bitcoin offer riding with this card.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub starter: Option<crate::sponsor::Starter>,
    /// The card with its offer (`<card>.<offer>`), for a funding request.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offer_link: Option<String>,
}

/// The card's node key, refused unless it is a canonically encoded point of
/// full order. A small-order (weak) key validates forged signatures under a
/// lax check, and a non-canonical encoding gives one node two ids.
fn node_key(hex_key: &str) -> Result<VerifyingKey, String> {
    let bytes = decode_fixed::<32>(hex_key).ok_or("the card's node key is malformed")?;
    let key = VerifyingKey::from_bytes(&bytes).map_err(|_| "the card's node key is not a valid key".to_string())?;
    if key.is_weak() {
        return Err("The card's node key is a weak (small-order) key. Do not use this introduction.".into());
    }
    if key.to_edwards().compress().to_bytes() != bytes {
        return Err("The card's node key is not canonically encoded. Do not use this introduction.".into());
    }
    Ok(key)
}

/// Strict Ed25519 over a digest by a raw key: full order, canonical, no
/// small-order R or non-canonical S. Shared with the sponsor offer.
pub(crate) fn verify_strict_raw(key: &[u8; 32], digest: &[u8; 32], sig: &[u8; 64]) -> Result<(), String> {
    node_key(&hex::encode(key))?
        .verify_strict(digest, &Signature::from_bytes(sig))
        .map_err(|_| "The signature does not match. Do not use this.".to_string())
}

fn decode_fixed<const N: usize>(s: &str) -> Option<[u8; N]> {
    if s.len() != N * 2 || s.bytes().any(|b| b.is_ascii_uppercase()) {
        return None;
    }
    hex::decode(s).ok()?.try_into().ok()
}

impl Card {
    fn canonical_bytes(&self) -> Result<Vec<u8>, String> {
        let key = decode_fixed::<32>(&self.node_id).ok_or("the card's node key is malformed")?;
        let id = decode_fixed::<16>(&self.intro_id).ok_or("the card's id is malformed")?;
        if self.network.len() > 255 || self.endpoint.len() > MAX_ENDPOINT_LEN {
            return Err("the card's endpoint is too long".into());
        }
        let mut out = Vec::with_capacity(DOMAIN_V1.len() + 128 + self.endpoint.len());
        out.extend_from_slice(DOMAIN_V1);
        out.push(self.v);
        out.push(self.network.len() as u8);
        out.extend_from_slice(self.network.as_bytes());
        out.extend_from_slice(&key);
        out.push(self.endpoint.len() as u8);
        out.extend_from_slice(self.endpoint.as_bytes());
        out.push(match self.reach {
            Reach::Public => 0,
            Reach::Local => 1,
        });
        for n in [self.admission_msat, self.message_msat, self.price_epoch, self.issued_at, self.expires_at] {
            out.extend_from_slice(&n.to_be_bytes());
        }
        out.extend_from_slice(&id);
        Ok(out)
    }

    /// Everything but the reader's network: version, known network,
    /// endpoint shape and reach, lifetime, expiry and the node-key signature.
    pub fn verify(&self, now_unix: u64) -> Result<(), String> {
        if self.v != VERSION {
            return Err(format!("This introduction uses version {}, which this app cannot read.", self.v));
        }
        if !NETWORKS.contains(&self.network.as_str()) {
            return Err("This introduction names an unknown Bitcoin network.".into());
        }
        let literal = reach_of(&self.endpoint)?;
        if self.reach == Reach::Public && literal == Reach::Local {
            return Err("This introduction calls a private address public.".into());
        }
        if self.expires_at <= self.issued_at || self.expires_at - self.issued_at > LIFETIME_SECS {
            return Err("This introduction claims to live longer than ten minutes.".into());
        }
        if self.issued_at > now_unix.saturating_add(MAX_SKEW_SECS) {
            return Err("This introduction is dated in the future. Check your clock.".into());
        }
        if self.expires_at <= now_unix {
            return Err("This introduction has expired. Ask for a fresh one.".into());
        }
        let key = node_key(&self.node_id)?;
        let sig = decode_fixed::<64>(&self.sig).ok_or("the card's signature is malformed")?;
        // Strict: no small-order R, non-canonical S or cofactored equation
        // (the genome's #89 check), so a weak key cannot "sign" anything.
        key.verify_strict(blake3::hash(&self.canonical_bytes()?).as_bytes(), &Signature::from_bytes(&sig))
            .map_err(|_| "The signature does not match this node's key. Do not use this introduction.".to_string())
    }

    /// The 32-byte digest the node key signs. Public so tests and fixtures
    /// can sign cards; the app itself never holds a node key.
    pub fn signing_digest(&self) -> Result<[u8; 32], String> {
        Ok(*blake3::hash(&self.canonical_bytes()?).as_bytes())
    }

    pub fn to_link(&self) -> Result<String, String> {
        let mut bytes = self.canonical_bytes()?;
        bytes.drain(..DOMAIN_V1.len());
        bytes.extend_from_slice(&decode_fixed::<64>(&self.sig).ok_or("the card's signature is malformed")?);
        Ok(format!("{LINK_PREFIX}{}", b64::encode(&bytes)))
    }

    fn from_link_bytes(b: &[u8]) -> Result<Self, String> {
        let mut at = 0usize;
        let mut take = |n: usize| -> Result<&[u8], String> {
            let s = b.get(at..at + n).ok_or("This introduction is cut short.")?;
            at += n;
            Ok(s)
        };
        let text = |s: &[u8]| String::from_utf8(s.to_vec()).map_err(|_| "This introduction is not readable.".to_string());
        let num = |s: &[u8]| u64::from_be_bytes(s.try_into().expect("8 bytes"));
        let v = take(1)?[0];
        let n = take(1)?[0] as usize;
        let network = text(take(n)?)?;
        let node_id = hex::encode(take(32)?);
        let n = take(1)?[0] as usize;
        let endpoint = text(take(n)?)?;
        let reach = match take(1)?[0] {
            0 => Reach::Public,
            1 => Reach::Local,
            _ => return Err("This introduction is not readable.".into()),
        };
        let admission_msat = num(take(8)?);
        let message_msat = num(take(8)?);
        let price_epoch = num(take(8)?);
        let issued_at = num(take(8)?);
        let expires_at = num(take(8)?);
        let intro_id = hex::encode(take(16)?);
        let sig = hex::encode(take(64)?);
        if at != b.len() {
            return Err("This introduction has extra data.".into());
        }
        Ok(Self { v, network, node_id, endpoint, reach, admission_msat, message_msat, price_epoch, issued_at, expires_at, intro_id, sig })
    }

    pub fn door(&self) -> Result<DoorCard, String> {
        Ok(DoorCard {
            node_id: self.node_id.clone(),
            network: self.network.clone(),
            endpoint: self.endpoint.clone(),
            reach: self.reach,
            admission_msat: self.admission_msat,
            message_msat: self.message_msat,
            issued_at: self.issued_at,
            expires_at: self.expires_at,
            link: self.to_link()?,
            starter: None,
            offer_link: None,
        })
    }
}

/// A scanned link, its bare fragment, or pasted JSON. Bounded before any
/// decoding. Does not verify.
pub fn parse(text: &str) -> Result<Card, String> {
    // Bound the raw input, surrounding whitespace included, before any work.
    if text.len() > MAX_ENCODED_LEN {
        return Err("That is too long to be an introduction (2 KiB at most).".into());
    }
    let text = text.trim();
    if text.is_empty() {
        return Err("Paste an introduction first.".into());
    }
    if text.starts_with('{') {
        return serde_json::from_str(text).map_err(|_| "That is not an introduction.".to_string());
    }
    let payload = match text.split_once('#') {
        Some((prefix, frag)) if format!("{prefix}#") == LINK_PREFIX => frag,
        Some(_) => return Err("That is not a bitsov://introduce link.".into()),
        None => text,
    };
    let bytes = b64::decode(payload).ok_or("That is not an introduction.")?;
    Card::from_link_bytes(&bytes)
}

/// Parse and verify in one step.
pub fn read(text: &str, now_unix: u64) -> Result<Card, String> {
    let card = parse(text)?;
    card.verify(now_unix)?;
    Ok(card)
}

/// `host:port` with no scheme, credentials, path or query; the host is an
/// IPv4 literal, a bracketed IPv6 literal or a DNS name.
fn split_endpoint(endpoint: &str) -> Result<(String, u16), String> {
    let bad = || format!("“{endpoint}” is not a node address (host:port).");
    if endpoint.is_empty() || endpoint.len() > MAX_ENDPOINT_LEN || endpoint.contains(|c: char| c.is_whitespace() || "/@?#\\".contains(c)) {
        return Err(bad());
    }
    let (host, port) = endpoint.rsplit_once(':').ok_or_else(bad)?;
    // Digits only: `u16::from_str` would also take "+9000".
    if port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) {
        return Err(bad());
    }
    let port: u16 = port.parse().map_err(|_| bad())?;
    if port == 0 {
        return Err(bad());
    }
    if let Some(v6) = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        v6.parse::<std::net::Ipv6Addr>().map_err(|_| bad())?;
        return Ok((v6.to_string(), port));
    }
    if host.parse::<std::net::Ipv4Addr>().is_err() {
        let dns = host.len() <= 253
            && host.split('.').all(|l| {
                !l.is_empty() && l.len() <= 63 && !l.starts_with('-') && !l.ends_with('-') && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            });
        if !dns {
            return Err(bad());
        }
        // A name whose last label is numeric ("127.1", "2130706433",
        // "0x7f.1") is an IPv4 address in disguise to many resolvers, and a
        // single-label name resolves through search domains to who knows
        // where. Either would pass as "public" here, so refuse both.
        let last = host.rsplit('.').next().unwrap_or(host);
        let numeric = last.bytes().all(|b| b.is_ascii_digit())
            || (last.len() > 2 && last[..2].eq_ignore_ascii_case("0x") && last[2..].bytes().all(|b| b.is_ascii_hexdigit()));
        if numeric || (!host.contains('.') && !host.eq_ignore_ascii_case("localhost")) {
            return Err(bad());
        }
    }
    Ok((host.to_ascii_lowercase(), port))
}

/// Same classification as the genome: never-dialable ranges (link-local and
/// cloud metadata included) are refused; loopback/private/CGNAT/ULA literals
/// are local; everything else, DNS names included, is public.
fn reach_of(endpoint: &str) -> Result<Reach, String> {
    use std::net::IpAddr;
    let (host, _) = split_endpoint(endpoint)?;
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
        return Ok(Reach::Local);
    }
    let Ok(ip) = host.parse::<IpAddr>() else { return Ok(Reach::Public) };
    ip_reach(ip).ok_or_else(|| format!("{ip} is never a node address."))
}

/// Classify an address as the genome does (`konsensus_core::introduction::
/// ip_reach`): `None` for never-dialable ranges, else public or local.
pub fn ip_reach(ip: std::net::IpAddr) -> Option<Reach> {
    use std::net::IpAddr;
    let never = || None;
    let ip = match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
        v4 => v4,
    };
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, c, _] = v4.octets();
            if v4.is_unspecified() || v4.is_multicast() || v4.is_broadcast() || v4.is_link_local() || v4.is_documentation()
                || a == 0 || a >= 240 || (a == 192 && b == 0 && c == 0) || (a == 198 && (b == 18 || b == 19))
            {
                never()
            } else if v4.is_loopback() || v4.is_private() || (a == 100 && (64..128).contains(&b)) {
                Some(Reach::Local)
            } else {
                Some(Reach::Public)
            }
        }
        IpAddr::V6(v6) => {
            let s = v6.segments();
            if v6.is_unspecified() || v6.is_multicast() || (s[0] & 0xffc0) == 0xfe80 || (s[0] == 0x2001 && s[1] == 0x0db8) {
                never()
            } else if v6.is_loopback() || (s[0] & 0xfe00) == 0xfc00 {
                Some(Reach::Local)
            } else if (s[0] & 0xe000) != 0x2000 || s[0] == 0x2002 || (s[0] == 0x2001 && s[1] <= 0x01ff) || s[0] == 0x3fff {
                // Outside global unicast, 6to4, Teredo/benchmarking and
                // documentation: fail closed so an embedded IPv4 (NAT64,
                // IPv4-compatible, 6to4) cannot slip past the local rules.
                never()
            } else {
                Some(Reach::Public)
            }
        }
    }
}

/// May a card with `reach` lead to a connection to `ip`? Public cards only
/// reach public addresses; nothing reaches the never-dialable ranges.
pub fn dial_allowed(reach: Reach, ip: std::net::IpAddr) -> bool {
    match (reach, ip_reach(ip)) {
        (_, None) => false,
        (Reach::Public, Some(r)) => r == Reach::Public,
        (Reach::Local, Some(_)) => true,
    }
}

/// base64url without padding. Small and in-tree, as for the QR encoder.
pub(crate) mod base64_url {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

    pub fn encode(bytes: &[u8]) -> String {
        let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
        for chunk in bytes.chunks(3) {
            let n = chunk.iter().enumerate().fold(0u32, |acc, (i, b)| acc | (u32::from(*b) << (16 - 8 * i)));
            for i in 0..=chunk.len() {
                out.push(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize] as char);
            }
        }
        out
    }

    pub fn decode(text: &str) -> Option<Vec<u8>> {
        if text.len() % 4 == 1 {
            return None;
        }
        let mut out = Vec::with_capacity(text.len() * 3 / 4);
        for chunk in text.as_bytes().chunks(4) {
            let mut n = 0u32;
            for (i, c) in chunk.iter().enumerate() {
                let v = ALPHABET.iter().position(|a| a == c)? as u32;
                n |= v << (18 - 6 * i);
            }
            let bytes = n.to_be_bytes();
            let len = chunk.len() - 1;
            // Non-canonical trailing bits would give two encodings of one card.
            if len < 3 && (n & (0xff_ffff >> (8 * len))) != 0 {
                return None;
            }
            out.extend_from_slice(&bytes[1..1 + len]);
        }
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The genome's fixed vector (`konsensus_core::introduction` tests):
    /// Ed25519 key `[7; 32]`, regtest, `node.example.org:9000`, 100 000 /
    /// 10 000 msat, epoch 440, issued 1 790 000 000, id `[0xab; 16]`.
    const VECTOR_LINK: &str = "bitsov://introduce#AQdyZWd0ZXN06kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iwVbm9kZS5leGFtcGxlLm9yZzo5MDAwAAAAAAAAAYagAAAAAAAAJxAAAAAAAAABuAAAAABqsTuAAAAAAGqxPdirq6urq6urq6urq6urq6ur3BK7GVreWdgZElEoTou2cd8Nk2q0QYa7Jmb-SZsV3kdG52gStclWtLnYqDxfBSO0RMBFywM4DdLClJDK9TGmAA";
    const NOW: u64 = 1_790_000_000;

    fn vector() -> Card {
        parse(VECTOR_LINK).unwrap()
    }

    #[test]
    fn reads_the_genome_vector() {
        let c = vector();
        assert_eq!(c.node_id, "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c");
        assert_eq!(c.sig, "dc12bb195ade59d8191251284e8bb671df0d936ab44186bb2666fe499b15de4746e76812b5c956b4b9d8a83c5f0523b444c045cb03380dd2c29490caf531a600");
        assert_eq!((c.network.as_str(), c.endpoint.as_str(), c.reach), ("regtest", "node.example.org:9000", Reach::Public));
        assert_eq!((c.admission_msat, c.message_msat, c.price_epoch), (100_000, 10_000, 440));
        assert_eq!((c.issued_at, c.expires_at, c.intro_id.as_str()), (NOW, NOW + 600, "abababababababababababababababab"));
        assert!(c.verify(NOW).is_ok());
        assert_eq!(c.to_link().unwrap(), VECTOR_LINK, "the link round-trips byte for byte");
        // The node's JSON form of the same card verifies too.
        let json = serde_json::to_string(&c).unwrap();
        assert_eq!(read(&json, NOW).unwrap(), c);
        assert_eq!(read(VECTOR_LINK.strip_prefix(LINK_PREFIX).unwrap(), NOW).unwrap(), c);
    }

    #[test]
    fn every_field_is_signed() {
        let c = vector();
        let tamper: Vec<fn(&mut Card)> = vec![
            |c| c.network = "signet".into(),
            |c| c.endpoint = "evil.example.org:9000".into(),
            |c| c.reach = Reach::Local,
            |c| c.admission_msat = 1,
            |c| c.message_msat = 1,
            |c| c.price_epoch = 441,
            |c| c.issued_at -= 1,
            |c| c.expires_at -= 1,
            |c| c.intro_id = "ac".repeat(16),
            |c| c.node_id = "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22d".into(),
            |c| c.sig = "00".repeat(64),
        ];
        for (i, t) in tamper.iter().enumerate() {
            let mut bad = c.clone();
            t(&mut bad);
            assert!(bad.verify(NOW).is_err(), "tamper {i} verified");
        }
    }

    #[test]
    fn expiry_version_and_lifetime() {
        let c = vector();
        assert!(c.verify(NOW + 599).is_ok());
        assert!(c.verify(NOW + 600).unwrap_err().contains("expired"));
        assert!(c.verify(NOW - 61).unwrap_err().contains("future"));
        let mut v2 = c.clone();
        v2.v = 2;
        assert!(v2.verify(NOW).unwrap_err().contains("version 2"));
    }

    #[test]
    fn parse_is_bounded_and_strict() {
        assert!(parse(&"A".repeat(MAX_ENCODED_LEN + 1)).unwrap_err().contains("2 KiB"));
        assert!(parse("").is_err());
        assert!(parse("https://evil.example/#AQdy").is_err());
        assert!(parse(&VECTOR_LINK[..VECTOR_LINK.len() - 4]).is_err(), "truncated");
        assert!(parse(&format!("{VECTOR_LINK}AA")).is_err(), "trailing bytes");
        let mut json = serde_json::to_value(vector()).unwrap();
        json["grant"] = "admin".into();
        assert!(parse(&json.to_string()).is_err(), "unknown fields refused");
    }

    #[test]
    fn endpoint_policy_matches_the_genome() {
        for bad in ["http://a.example:1", "u@a.example:1", "a.example", "a.example:0", "a.example:1/x", "0.0.0.0:1", "169.254.169.254:80", "[fe80::1]:1", "224.0.0.1:1", ""] {
            assert!(reach_of(bad).is_err(), "{bad}");
        }
        for (ok, r) in [("a.example:1", Reach::Public), ("8.8.8.8:1", Reach::Public), ("127.0.0.1:1", Reach::Local), ("10.0.0.2:1", Reach::Local), ("[fd00::1]:1", Reach::Local), ("localhost:1", Reach::Local)] {
            assert_eq!(reach_of(ok).unwrap(), r, "{ok}");
        }
    }

    /// A card "signed" by the identity point: R = identity, S = 0. The group
    /// equation [S]B = R + [k]A holds for every message, so a lax verifier
    /// accepts it. Strict verification must not.
    fn forged_by_identity_key(endpoint: &str, admission_msat: u64) -> Card {
        let mut identity = [0u8; 32];
        identity[0] = 1;
        let mut sig = [0u8; 64];
        sig[0] = 1;
        Card {
            node_id: hex::encode(identity),
            endpoint: endpoint.into(),
            admission_msat,
            sig: hex::encode(sig),
            ..vector()
        }
    }

    #[test]
    fn weak_key_forgery_is_rejected_where_a_lax_check_accepts_it() {
        use ed25519_dalek::Verifier;
        for (endpoint, price) in [("node.example.org:9000", 100_000), ("evil.example.org:9001", 1)] {
            let forged = forged_by_identity_key(endpoint, price);
            // The forgery is real: the lax (cofactorless, weak-key) check passes it.
            let key = VerifyingKey::from_bytes(&decode_fixed::<32>(&forged.node_id).unwrap()).unwrap();
            let digest = forged.signing_digest().unwrap();
            assert!(key.verify(&digest, &Signature::from_bytes(&decode_fixed::<64>(&forged.sig).unwrap())).is_ok());
            // The app refuses it, from JSON and through the link.
            assert!(forged.verify(NOW).unwrap_err().contains("weak"), "{endpoint}");
            let link = forged.to_link().unwrap();
            assert!(read(&link, NOW).unwrap_err().contains("weak"));
        }
    }

    #[test]
    fn every_small_order_key_is_refused() {
        // The eight small-order points (orders 1, 2, 4 and 8) plus a
        // non-canonical encoding of the identity (y = p + 1).
        for key in [
            "0100000000000000000000000000000000000000000000000000000000000000",
            "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
            "0000000000000000000000000000000000000000000000000000000000000000",
            "0000000000000000000000000000000000000000000000000000000000000080",
            "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
            "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
            "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
            "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
            "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
        ] {
            let card = Card { node_id: key.into(), ..vector() };
            assert!(card.verify(NOW).is_err(), "{key} accepted");
        }
    }

    #[test]
    fn noncanonical_signatures_are_rejected() {
        let c = vector();
        // S + L: the same group element, but a non-canonical scalar.
        let order = hex::decode("edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010").unwrap();
        let mut sig = decode_fixed::<64>(&c.sig).unwrap();
        let mut carry = 0u16;
        for (s, l) in sig[32..].iter_mut().zip(order) {
            let sum = u16::from(*s) + u16::from(l) + carry;
            *s = sum as u8;
            carry = sum >> 8;
        }
        assert!(Card { sig: hex::encode(sig), ..c.clone() }.verify(NOW).is_err(), "S + L accepted");
        // R replaced by a non-canonical encoding of the identity (y = p + 1).
        let mut sig = decode_fixed::<64>(&c.sig).unwrap();
        sig[..32].fill(0xff);
        sig[0] = 0xee;
        sig[31] = 0x7f;
        assert!(Card { sig: hex::encode(sig), ..c.clone() }.verify(NOW).is_err(), "non-canonical R accepted");
        assert!(c.verify(NOW).is_ok(), "the genuine vector still verifies strictly");
    }

    #[test]
    fn tampered_links_are_rejected() {
        let frag = VECTOR_LINK.strip_prefix(LINK_PREFIX).unwrap().as_bytes().to_vec();
        // Flip each byte of the payload (keeping it valid base64url): every
        // variant either fails to parse or fails the signature.
        for i in 0..frag.len() {
            let mut t = frag.clone();
            t[i] = if t[i] == b'A' { b'B' } else { b'A' };
            let text = format!("{LINK_PREFIX}{}", String::from_utf8(t).unwrap());
            assert!(read(&text, NOW).is_err(), "byte {i} flipped still verified");
        }
        let padded = format!("{}{VECTOR_LINK}", " ".repeat(MAX_ENCODED_LEN));
        assert!(parse(&padded).unwrap_err().contains("2 KiB"), "whitespace counts toward the bound");
    }

    #[test]
    fn endpoint_input_validation() {
        for bad in [
            "a.example:+9000", "a.example:-1", "a.example:65536", "a.example:", "a.example:9000 ",
            "127.1:9000", "2130706433:9000", "0x7f.1:9000", "a.0x7f:9000", "10.0.0.010:9000",
            "node:9000", "a.example.:9000", "nöde.example:9000", "a\u{0}b.example:9000", "[::1%lo0]:9000",
        ] {
            assert!(reach_of(bad).is_err(), "{bad} accepted");
        }
        assert!(reach_of("a.example:65535").is_ok());
        assert!(reach_of("localhost:9000").is_ok());
        for ip in ["::127.0.0.1", "64:ff9b::a9fe:a9fe", "64:ff9b::7f00:1", "2002:7f00:1::1", "2001::1", "3fff::1", "fec0::1"] {
            let ip: std::net::IpAddr = ip.parse().unwrap();
            assert!(!dial_allowed(Reach::Public, ip) && !dial_allowed(Reach::Local, ip), "{ip}");
        }
        assert!(dial_allowed(Reach::Public, "2606:4700::1".parse().unwrap()));
        assert!(dial_allowed(Reach::Local, "192.168.1.2".parse().unwrap()));
        assert!(!dial_allowed(Reach::Public, "192.168.1.2".parse().unwrap()));
        assert!(!dial_allowed(Reach::Local, "169.254.169.254".parse().unwrap()));
    }

    #[test]
    fn base64url_round_trips_and_rejects_noncanonical() {
        for n in 0..40usize {
            let bytes: Vec<u8> = (0..n as u8).map(|b| b.wrapping_mul(37)).collect();
            assert_eq!(base64_url::decode(&base64_url::encode(&bytes)).unwrap(), bytes);
        }
        assert!(base64_url::decode("AB").is_none(), "non-zero trailing bits");
        assert!(base64_url::decode("A").is_none());
        assert!(base64_url::decode("A+==").is_none());
    }
}
