//! K1 slice 2, host side: the starter-bitcoin offer that may ride with an
//! introduction (`bitsov://introduce#<card>.<offer>`), and the shapes of the
//! sponsor kit routes.
//!
//! Format owner: genome `konsensus_core::sponsor` (`sponsor_kit_v1`), read
//! here independently (Gate G1) and pinned to the genome's offer vector.
//!
//! The gift is never admission: it lands as the newcomer's ordinary balance,
//! its invoice is funding-only on the newcomer's node, and every message
//! still pays. Reading an offer is local and moves nothing.

use serde::{Deserialize, Serialize};

use crate::introduction::{self as intro, base64_url as b64, Card, DoorCard};

/// `/status` capability of a node that runs sponsor kits.
pub const CAPABILITY: &str = "sponsor_kit_v1";
const OFFER_DOMAIN_V1: &[u8] = b"bitsov-sponsor-offer/v1\0";
const VERSION: u8 = 1;
/// Per-kit ceiling, gift plus fees (spec: 50,000 sats).
pub const MAX_KIT_MSAT: u64 = 50_000_000;
const OFFER_LIFETIME_SECS: u64 = 600;
pub const REQUEST_LINK_PREFIX: &str = "bitsov://sponsor-request#";

/// What the door card may say about starter bitcoin, once verified.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Starter {
    pub gift_msat: u64,
    pub expires_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Offer {
    pub network: String,
    pub intro_id: [u8; 16],
    pub sponsor: [u8; 32],
    pub gift_msat: u64,
    pub expires_at: u64,
    pub sig: [u8; 64],
}

impl Offer {
    fn body(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(96);
        out.push(VERSION);
        out.push(self.network.len() as u8);
        out.extend_from_slice(self.network.as_bytes());
        out.extend_from_slice(&self.intro_id);
        out.extend_from_slice(&self.sponsor);
        out.extend_from_slice(&self.gift_msat.to_be_bytes());
        out.extend_from_slice(&self.expires_at.to_be_bytes());
        out
    }

    pub fn signing_digest(&self) -> [u8; 32] {
        let mut signed = OFFER_DOMAIN_V1.to_vec();
        signed.extend_from_slice(&self.body());
        *blake3::hash(&signed).as_bytes()
    }

    pub fn encode(&self) -> String {
        let mut bytes = self.body();
        bytes.extend_from_slice(&self.sig);
        b64::encode(&bytes)
    }

    pub fn decode(text: &str) -> Result<Self, String> {
        let bad = || "The starter-bitcoin offer is not readable.".to_string();
        let bytes = b64::decode(text.trim()).ok_or_else(bad)?;
        let mut at = 0usize;
        let mut take = |n: usize| -> Result<&[u8], String> {
            let s = bytes.get(at..at + n).ok_or_else(bad)?;
            at += n;
            Ok(s)
        };
        if take(1)?[0] != VERSION {
            return Err("This starter-bitcoin offer uses a version this app cannot read.".into());
        }
        let n = take(1)?[0] as usize;
        let network = String::from_utf8(take(n)?.to_vec()).map_err(|_| bad())?;
        let intro_id: [u8; 16] = take(16)?.try_into().map_err(|_| bad())?;
        let sponsor: [u8; 32] = take(32)?.try_into().map_err(|_| bad())?;
        let gift_msat = u64::from_be_bytes(take(8)?.try_into().map_err(|_| bad())?);
        let expires_at = u64::from_be_bytes(take(8)?.try_into().map_err(|_| bad())?);
        let sig: [u8; 64] = take(64)?.try_into().map_err(|_| bad())?;
        if at != bytes.len() {
            return Err(bad());
        }
        Ok(Self { network, intro_id, sponsor, gift_msat, expires_at, sig })
    }

    /// Signed by the card's own key, for this card's introduction only, on
    /// its network, within the kit ceiling and its ten-minute life.
    pub fn verify(&self, now_unix: u64, card: &Card) -> Result<(), String> {
        if hex::encode(self.sponsor) != card.node_id || hex::encode(self.intro_id) != card.intro_id {
            return Err("The starter-bitcoin offer does not belong to this introduction.".into());
        }
        if self.network != card.network {
            return Err("The starter-bitcoin offer is for another Bitcoin network.".into());
        }
        if self.gift_msat == 0 || self.gift_msat > MAX_KIT_MSAT {
            return Err("The starter-bitcoin offer is outside the allowed amount.".into());
        }
        if self.expires_at <= now_unix {
            return Err("The starter-bitcoin offer has expired.".into());
        }
        if self.expires_at > now_unix.saturating_add(OFFER_LIFETIME_SECS + 60) {
            return Err("The starter-bitcoin offer claims to live too long.".into());
        }
        intro::verify_strict_raw(&self.sponsor, &self.signing_digest(), &self.sig)
    }
}

/// `bitsov://introduce#<card>.<offer>` → (card text, offer text).
pub fn split(text: &str) -> (String, Option<String>) {
    let text = text.trim();
    if text.starts_with('{') {
        return (text.to_string(), None);
    }
    match text.rsplit_once('.') {
        Some((card, offer)) if !offer.contains('#') && !offer.is_empty() => (card.to_string(), Some(offer.to_string())),
        _ => (text.to_string(), None),
    }
}

/// Read a card and, if present, its offer. Both are verified; an offer that
/// fails is refused outright rather than silently dropped, since it claims
/// to come from the introduced node.
pub fn read(text: &str, now_unix: u64) -> Result<(Card, Option<Offer>), String> {
    if text.len() > intro::MAX_ENCODED_LEN {
        return Err("That is too long to be an introduction (2 KiB at most).".into());
    }
    let (card_text, offer_text) = split(text);
    let card = intro::read(&card_text, now_unix)?;
    let offer = match offer_text {
        Some(t) => {
            let offer = Offer::decode(&t)?;
            offer.verify(now_unix, &card)?;
            Some(offer)
        }
        None => None,
    };
    Ok((card, offer))
}

/// The door card for a card and its (verified) offer.
pub fn door(card: &Card, offer: Option<&Offer>) -> Result<DoorCard, String> {
    let mut door = card.door()?;
    if let Some(o) = offer {
        door.starter = Some(Starter { gift_msat: o.gift_msat, expires_at: o.expires_at });
        door.offer_link = Some(format!("{}.{}", door.link, o.encode()));
    }
    Ok(door)
}

// ---- node route shapes -----------------------------------------------------------

/// `GET /sponsor`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SponsorStatus {
    pub enabled: bool,
    pub gift_msat: u64,
    pub fee_msat: u64,
    pub purse_msat: u64,
    pub purse_used_msat: u64,
    pub kits_per_day: u32,
    pub kits_today: u32,
    #[serde(default)]
    pub kits: Vec<serde_json::Value>,
}

/// `POST /sponsor/candidate`: the request frozen for the owner's review.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Candidate {
    pub intro_id: String,
    pub newcomer: String,
    pub payment_hash: String,
    pub gift_msat: u64,
    pub fee_max_msat: u64,
    pub code: String,
    pub expires_at: u64,
}

impl Candidate {
    /// Refuse a node answer that could not be what the owner reviews.
    pub fn check(&self) -> Result<(), String> {
        let hex_len = |s: &str, n: usize| s.len() == n && s.bytes().all(|b| b.is_ascii_hexdigit());
        if !hex_len(&self.intro_id, 32) || !hex_len(&self.newcomer, 64) || !hex_len(&self.payment_hash, 64) || self.code.len() != 6
            || !self.code.bytes().all(|b| b.is_ascii_digit())
            || self.gift_msat == 0 || self.gift_msat.saturating_add(self.fee_max_msat) > MAX_KIT_MSAT
        {
            return Err("The node's answer about this request is malformed.".into());
        }
        Ok(())
    }
}

/// A command for the independent owner to run in the node terminal.
/// No credential is read, stored or sent by the app.
#[derive(Debug, Clone, Serialize)]
pub struct OwnerApproval {
    pub owner_command: String,
}

pub fn owner_approval(base: &str, candidate: &Candidate, code: &str, now: u64) -> Result<OwnerApproval, String> {
    candidate.check()?;
    if candidate.expires_at <= now {
        return Err("This gift request expired. Make a new offer.".into());
    }
    if code != candidate.code {
        return Err("The code does not match this request. Nothing was paid.".into());
    }
    let request = serde_json::json!({
        "intro_id": candidate.intro_id, "newcomer": candidate.newcomer,
        "payment_hash": candidate.payment_hash, "gift_msat": candidate.gift_msat,
        "fee_max_msat": candidate.fee_max_msat, "code": code,
    });
    let quote = |s: &str| format!("'{}'", s.replace('\'', "'\"'\"'"));
    let body = quote(&request.to_string());
    let url = quote(&format!("{base}/sponsor/approve"));
    // Same owner command card contract as first contact: the owner supplies
    // the credential in their terminal; stdin keeps it out of curl's argv.
    Ok(OwnerApproval { owner_command: format!(
        "(set +x; printf 'Authorization: Bearer %s\\n' \"${{BITSOV_OWNER_TOKEN:?Set an independent node owner credential in this terminal}}\" | curl --fail --silent --show-error --max-time 20 --proto '=http' --header @- --header 'Content-Type: application/json' --data {body} {url})"
    ) })
}

/// `POST /sponsor/request`: what the newcomer shows the sponsor.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FundingAsk {
    pub request: String,
    pub code: String,
    pub sponsor: String,
    pub amount_msat: u64,
    pub payment_hash: String,
    pub expires_at: u64,
}

/// `GET /sponsor/request/:hash`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FundingStatus {
    pub payment_hash: String,
    pub state: String,
    pub amount_msat: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::Signer;

    const NOW: u64 = 1_790_000_000;

    /// Build a real card + offer pair signed by one key.
    fn signed(key_seed: u8, gift_msat: u64) -> (Card, Offer) {
        let key = ed25519_dalek::SigningKey::from_bytes(&[key_seed; 32]);
        let mut card = Card {
            v: 1,
            network: "regtest".into(),
            node_id: hex::encode(key.verifying_key().to_bytes()),
            endpoint: "node.example.org:9000".into(),
            reach: intro::Reach::Public,
            admission_msat: 1000,
            message_msat: 1000,
            price_epoch: 0,
            issued_at: NOW,
            expires_at: NOW + 600,
            intro_id: "ab".repeat(16),
            sig: String::new(),
        };
        card.sig = hex::encode(key.sign(&card.signing_digest().unwrap()).to_bytes());
        let mut offer = Offer {
            network: "regtest".into(),
            intro_id: [0xab; 16],
            sponsor: key.verifying_key().to_bytes(),
            gift_msat,
            expires_at: NOW + 600,
            sig: [0; 64],
        };
        offer.sig = key.sign(&offer.signing_digest()).to_bytes();
        (card, offer)
    }

    #[test]
    fn a_card_with_its_offer_reads_as_a_door_with_starter_bitcoin() {
        let (card, offer) = signed(3, 20_000_000);
        let link = format!("{}.{}", card.to_link().unwrap(), offer.encode());
        let (read_card, read_offer) = read(&link, NOW).unwrap();
        assert_eq!(read_card, card);
        assert_eq!(read_offer.as_ref(), Some(&offer));
        let door = door(&read_card, read_offer.as_ref()).unwrap();
        assert_eq!(door.starter, Some(Starter { gift_msat: 20_000_000, expires_at: NOW + 600 }));
        assert_eq!(door.offer_link.as_deref(), Some(link.as_str()));
        // Without an offer the card still reads, with no starter.
        let (plain, none) = read(&card.to_link().unwrap(), NOW).unwrap();
        assert!(none.is_none() && door_of(&plain).starter.is_none());
    }

    fn door_of(card: &Card) -> DoorCard {
        door(card, None).unwrap()
    }

    /// The genome's fixed offer vector (`konsensus_core::sponsor` tests): key
    /// `[3; 32]`, regtest, intro id `[9; 16]`, 20,000,000 msat, expires
    /// 1,790,000,600. Decoded, re-encoded and verified byte for byte.
    #[test]
    fn reads_the_genome_offer_vector() {
        const VECTOR: &str = "AQdyZWd0ZXN0CQkJCQkJCQkJCQkJCQkJCe1JKMYo0cLG6ukDOJBZlWEpWSc6XGP5NjbBRhSshzfRAAAAAAExLQAAAAAAarE92I-FHpnHFK0Ny6W-SruDW5v3I8TMFACVAQb8HMKeYUS6U3hb8K1hLRCD783dgdDkieTVeybMhR3dKClLr-7pDQ4";
        let o = Offer::decode(VECTOR).unwrap();
        assert_eq!(o.encode(), VECTOR);
        assert_eq!((o.network.as_str(), o.intro_id, o.gift_msat, o.expires_at), ("regtest", [9; 16], 20_000_000, NOW + 600));
        let key = ed25519_dalek::SigningKey::from_bytes(&[3; 32]);
        assert_eq!(o.sponsor, key.verifying_key().to_bytes());
        intro::verify_strict_raw(&o.sponsor, &o.signing_digest(), &o.sig).expect("genome signature verifies here");
    }

    #[test]
    fn an_offer_from_another_key_or_card_is_refused() {
        let (card, _) = signed(3, 20_000_000);
        let (_, stranger) = signed(4, 20_000_000);
        let link = format!("{}.{}", card.to_link().unwrap(), stranger.encode());
        assert!(read(&link, NOW).unwrap_err().contains("does not belong"));
        let (card2, mut offer) = signed(3, 20_000_000);
        offer.gift_msat = 50_000_001;
        let key = ed25519_dalek::SigningKey::from_bytes(&[3; 32]);
        offer.sig = key.sign(&offer.signing_digest()).to_bytes();
        let link = format!("{}.{}", card2.to_link().unwrap(), offer.encode());
        assert!(read(&link, NOW).unwrap_err().contains("allowed amount"));
    }

    #[test]
    fn a_tampered_or_expired_offer_is_refused() {
        let (card, mut offer) = signed(3, 20_000_000);
        offer.gift_msat += 1;
        let link = format!("{}.{}", card.to_link().unwrap(), offer.encode());
        assert!(read(&link, NOW).is_err(), "tampered amount");
        let (card, offer) = signed(3, 20_000_000);
        let link = format!("{}.{}", card.to_link().unwrap(), offer.encode());
        assert!(read(&link, NOW + 600).is_err(), "expired");
    }

    #[test]
    fn a_weak_key_offer_is_refused() {
        let (card, mut offer) = signed(3, 20_000_000);
        offer.sponsor = [0; 32];
        offer.sponsor[0] = 1;
        assert!(offer.verify(NOW, &card).is_err());
    }
}
