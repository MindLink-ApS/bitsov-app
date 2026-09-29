//! FrontDoorCard v1, host side: read and verify a scanned or pasted doorstep
//! card before the renderer shows it.
//!
//! Format owner: genome `konsensus_core::front_door` (`front_door_v1`). Gate G1
//! keeps konsensus crates out of the app, so the format is re-implemented
//! rather than linked. Reading one is local: no request, no payment, no
//! stored contact. Knock asks the node to dial unprivileged, then uses the
//! existing first-contact quote path.

use base64::{engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD}, Engine as _};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};

use crate::introduction::Reach;

/// `/status` capability of a node that publishes front-door cards.
pub const CAPABILITY: &str = "front_door_v1";
const DOMAIN_V1: &[u8] = b"bitsov-front-door/v1\0";
const VERSION: u8 = 1;
pub const LINK_PREFIX: &str = "bitsov://front-door#";
const LIFETIME_SECS: u64 = 7 * 24 * 3600;
const MAX_SKEW_SECS: u64 = 60;
pub const MAX_CARD_BYTES: usize = 16 * 1024;
const MAX_ENDPOINT_LEN: usize = 255;
const MAX_DISPLAY_NAME: usize = 48;
const MAX_TAGLINE: usize = 80;
const MAX_ABOUT: usize = 280;
const MAX_AVATAR_INLINE: usize = 8 * 1024;
const MAX_MEDIA: usize = 12;
const MAX_THUMB_INLINE: usize = 4 * 1024;
const MAX_MEDIA_TITLE: usize = 64;
const MAX_LINKS: usize = 5;
const MAX_SITE_TITLES: usize = 20;
const NETWORKS: [&str; 4] = ["bitcoin", "testnet", "signet", "regtest"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProfileKind {
    Person,
    Company,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Avatar {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inline_b64: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FrontDoorPrices {
    pub admission_msat: u64,
    pub message_msat: u64,
    #[serde(default)]
    pub page_msat: u64,
    #[serde(default)]
    pub price_epoch: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FrontDoorProfile {
    pub kind: ProfileKind,
    pub display_name: String,
    #[serde(default)]
    pub tagline: String,
    #[serde(default)]
    pub about: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<Avatar>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FrontDoorCv {
    pub path: String,
    pub hash: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FrontDoorMedia {
    pub hash: String,
    pub size: u64,
    pub mime: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumb_b64: Option<String>,
    #[serde(default)]
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct FrontDoorSite {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index_path: Option<String>,
    #[serde(default)]
    pub page_count: u32,
    #[serde(default)]
    pub titles: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FrontDoorLink {
    pub label: String,
    pub url: String,
}

/// Signed card as the node's JSON names it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Card {
    pub v: u8,
    pub network: String,
    pub node_id: String,
    pub endpoint: String,
    pub reach: Reach,
    pub seq: u64,
    pub issued_at: u64,
    pub expires_at: u64,
    pub prices: FrontDoorPrices,
    pub profile: FrontDoorProfile,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cv: Option<FrontDoorCv>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub media: Vec<FrontDoorMedia>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub site: Option<FrontDoorSite>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub links: Vec<FrontDoorLink>,
    pub sig: String,
}

/// What the renderer may show after local verify.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FrontDoor {
    pub node_id: String,
    pub network: String,
    pub endpoint: String,
    pub reach: Reach,
    pub seq: u64,
    pub issued_at: u64,
    pub expires_at: u64,
    pub prices: FrontDoorPrices,
    pub profile: FrontDoorProfile,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cv: Option<FrontDoorCv>,
    pub media: Vec<FrontDoorMedia>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site: Option<FrontDoorSite>,
    pub links: Vec<FrontDoorLink>,
    /// `bitsov://front-door#…`
    pub link: String,
    /// Soft: true when the signature and shape check, even if expired.
    pub verified: bool,
    /// Soft: true when `expires_at` is still ahead of now.
    pub fresh: bool,
}

fn decode_fixed<const N: usize>(s: &str) -> Option<[u8; N]> {
    if s.len() != N * 2 || s.bytes().any(|b| b.is_ascii_uppercase()) {
        return None;
    }
    hex::decode(s).ok()?.try_into().ok()
}

fn node_key(hex_key: &str) -> Result<VerifyingKey, String> {
    let bytes = decode_fixed::<32>(hex_key).ok_or("the card's node key is malformed")?;
    let key = VerifyingKey::from_bytes(&bytes)
        .map_err(|_| "the card's node key is not a valid key".to_string())?;
    if key.is_weak() {
        return Err("The card's node key is a weak (small-order) key. Do not use this front door.".into());
    }
    if key.to_edwards().compress().to_bytes() != bytes {
        return Err("The card's node key is not canonically encoded. Do not use this front door.".into());
    }
    Ok(key)
}

fn reach_of(endpoint: &str) -> Result<Reach, String> {
    crate::introduction::reach_of(endpoint)
}

impl Card {
    fn canonical_json(&self) -> Result<Vec<u8>, String> {
        #[derive(Serialize)]
        struct Body<'a> {
            v: u8,
            network: &'a str,
            node_id: &'a str,
            endpoint: &'a str,
            reach: Reach,
            seq: u64,
            issued_at: u64,
            expires_at: u64,
            prices: &'a FrontDoorPrices,
            profile: &'a FrontDoorProfile,
            #[serde(skip_serializing_if = "Option::is_none")]
            cv: &'a Option<FrontDoorCv>,
            #[serde(skip_serializing_if = "Vec::is_empty")]
            media: &'a Vec<FrontDoorMedia>,
            #[serde(skip_serializing_if = "Option::is_none")]
            site: &'a Option<FrontDoorSite>,
            #[serde(skip_serializing_if = "Vec::is_empty")]
            links: &'a Vec<FrontDoorLink>,
        }
        serde_json::to_vec(&Body {
            v: self.v,
            network: &self.network,
            node_id: &self.node_id,
            endpoint: &self.endpoint,
            reach: self.reach,
            seq: self.seq,
            issued_at: self.issued_at,
            expires_at: self.expires_at,
            prices: &self.prices,
            profile: &self.profile,
            cv: &self.cv,
            media: &self.media,
            site: &self.site,
            links: &self.links,
        })
        .map_err(|e| e.to_string())
    }

    fn digest(&self) -> Result<[u8; 32], String> {
        let mut buf = Vec::with_capacity(DOMAIN_V1.len() + 256);
        buf.extend_from_slice(DOMAIN_V1);
        buf.extend_from_slice(&self.canonical_json()?);
        Ok(*blake3::hash(&buf).as_bytes())
    }

    fn check_shape(&self) -> Result<(), String> {
        if self.v != VERSION {
            return Err(format!(
                "This front door uses version {}, which this app cannot read.",
                self.v
            ));
        }
        if !NETWORKS.contains(&self.network.as_str()) {
            return Err("This front door names an unknown Bitcoin network.".into());
        }
        if self.endpoint.is_empty() || self.endpoint.len() > MAX_ENDPOINT_LEN {
            return Err("This front door's endpoint is not usable.".into());
        }
        let literal = reach_of(&self.endpoint)?;
        if self.reach == Reach::Public && literal == Reach::Local {
            return Err("This front door calls a private address public.".into());
        }
        if self.expires_at <= self.issued_at || self.expires_at - self.issued_at > LIFETIME_SECS {
            return Err("This front door claims to live longer than seven days.".into());
        }
        if self.profile.display_name.is_empty() || self.profile.display_name.len() > MAX_DISPLAY_NAME {
            return Err("This front door's display name is not usable.".into());
        }
        if self.profile.tagline.len() > MAX_TAGLINE {
            return Err("This front door's tagline is too long.".into());
        }
        if self.profile.about.len() > MAX_ABOUT {
            return Err("This front door's about text is too long.".into());
        }
        if let Some(av) = &self.profile.avatar {
            if let Some(b64) = &av.inline_b64 {
                let raw = STANDARD
                    .decode(b64)
                    .map_err(|_| "This front door's avatar is not readable.".to_string())?;
                if raw.len() > MAX_AVATAR_INLINE {
                    return Err("This front door's avatar is too large.".into());
                }
            }
        }
        if self.media.len() > MAX_MEDIA {
            return Err("This front door lists too many media items.".into());
        }
        for m in &self.media {
            if m.title.len() > MAX_MEDIA_TITLE {
                return Err("A media title on this front door is too long.".into());
            }
            if let Some(t) = &m.thumb_b64 {
                let raw = STANDARD
                    .decode(t)
                    .map_err(|_| "A media thumbnail on this front door is not readable.".to_string())?;
                if raw.len() > MAX_THUMB_INLINE {
                    return Err("A media thumbnail on this front door is too large.".into());
                }
            }
        }
        if self.links.len() > MAX_LINKS {
            return Err("This front door lists too many links.".into());
        }
        if let Some(site) = &self.site {
            if site.titles.len() > MAX_SITE_TITLES {
                return Err("This front door's site list is too long.".into());
            }
        }
        let encoded = serde_json::to_vec(self).map_err(|e| e.to_string())?;
        if encoded.len() > MAX_CARD_BYTES {
            return Err(format!(
                "This front door is too large ({} bytes, max {MAX_CARD_BYTES}).",
                encoded.len()
            ));
        }
        Ok(())
    }

    /// Crypto and shape. Expiry is reported separately so a stale card can still render.
    pub fn verify_signature(&self) -> Result<(), String> {
        self.check_shape()?;
        let key = node_key(&self.node_id)?;
        let sig = decode_fixed::<64>(&self.sig).ok_or("the card's signature is malformed")?;
        key.verify_strict(&self.digest()?, &Signature::from_bytes(&sig))
            .map_err(|_| "The signature does not match this node's key. Do not use this front door.".to_string())
    }

    pub fn to_link(&self) -> Result<String, String> {
        let json = serde_json::to_vec(self).map_err(|e| e.to_string())?;
        if json.len() > MAX_CARD_BYTES {
            return Err(format!(
                "This front door is too large ({} bytes, max {MAX_CARD_BYTES}).",
                json.len()
            ));
        }
        Ok(format!("{LINK_PREFIX}{}", URL_SAFE_NO_PAD.encode(json)))
    }

    pub fn view(&self, now_unix: u64) -> Result<FrontDoor, String> {
        self.verify_signature()?;
        if self.issued_at > now_unix.saturating_add(MAX_SKEW_SECS) {
            return Err("This front door is dated in the future. Check your clock.".into());
        }
        let fresh = self.expires_at > now_unix;
        Ok(FrontDoor {
            node_id: self.node_id.clone(),
            network: self.network.clone(),
            endpoint: self.endpoint.clone(),
            reach: self.reach,
            seq: self.seq,
            issued_at: self.issued_at,
            expires_at: self.expires_at,
            prices: self.prices.clone(),
            profile: self.profile.clone(),
            cv: self.cv.clone(),
            media: self.media.clone(),
            site: self.site.clone(),
            links: self.links.clone(),
            link: self.to_link()?,
            verified: true,
            fresh,
        })
    }
}

/// A scanned link, bare fragment, or pasted JSON. Bounded before any decoding.
pub fn parse(text: &str) -> Result<Card, String> {
    if text.len() > MAX_CARD_BYTES * 2 {
        return Err("That is too long to be a front-door card (16 KiB at most).".into());
    }
    let text = text.trim();
    if text.is_empty() {
        return Err("Paste a front-door link first.".into());
    }
    if text.starts_with('{') {
        return serde_json::from_str(text).map_err(|_| "That is not a front-door card.".to_string());
    }
    let payload = match text.split_once('#') {
        Some((prefix, frag)) if format!("{prefix}#") == LINK_PREFIX => frag,
        Some(_) => return Err("That is not a bitsov://front-door link.".into()),
        None => text,
    };
    let bytes = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| "That is not a front-door card.".to_string())?;
    if bytes.len() > MAX_CARD_BYTES {
        return Err(format!(
            "This front door is too large ({} bytes, max {MAX_CARD_BYTES}).",
            bytes.len()
        ));
    }
    serde_json::from_slice(&bytes).map_err(|_| "That is not a front-door card.".to_string())
}

/// Parse and verify signature; expired cards still return a view with `fresh = false`.
pub fn read(text: &str, now_unix: u64) -> Result<FrontDoor, String> {
    let card = parse(text)?;
    card.view(now_unix)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn sign_card(key: &SigningKey, mut card: Card) -> Card {
        card.node_id = hex::encode(key.verifying_key().to_bytes());
        card.sig = String::new();
        card.check_shape().unwrap();
        card.sig = hex::encode(key.sign(&card.digest().unwrap()).to_bytes());
        card
    }

    fn sample(key: &SigningKey, issued: u64) -> Card {
        sign_card(
            key,
            Card {
                v: 1,
                network: "regtest".into(),
                node_id: String::new(),
                endpoint: "node.example.org:9000".into(),
                reach: Reach::Public,
                seq: 1,
                issued_at: issued,
                expires_at: issued + LIFETIME_SECS,
                prices: FrontDoorPrices {
                    admission_msat: 100_000,
                    message_msat: 10_000,
                    page_msat: 1_000,
                    price_epoch: 0,
                },
                profile: FrontDoorProfile {
                    kind: ProfileKind::Person,
                    display_name: "Maya".into(),
                    tagline: "Build in the open".into(),
                    about: "Pilot peer.".into(),
                    avatar: None,
                },
                cv: None,
                media: vec![],
                site: None,
                links: vec![],
                sig: String::new(),
            },
        )
    }

    #[test]
    fn issue_verify_and_link_round_trip() {
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let now = 1_700_000_000u64;
        let card = sample(&key, now);
        let view = card.view(now + 10).unwrap();
        assert!(view.fresh);
        assert_eq!(view.profile.display_name, "Maya");
        let parsed = parse(&view.link).unwrap();
        assert_eq!(parsed.seq, 1);
        parsed.view(now + 10).unwrap();
    }

    #[test]
    fn forged_signature_refused() {
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let mut card = sample(&key, 1_700_000_000);
        card.sig = "00".repeat(64);
        assert!(card.verify_signature().is_err());
    }

    #[test]
    fn expired_card_still_views_as_stale() {
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let now = 1_700_000_000u64;
        let card = sample(&key, now);
        let view = card.view(now + LIFETIME_SECS + 1).unwrap();
        assert!(!view.fresh);
        assert!(view.verified);
    }

    #[test]
    fn json_paste_parses() {
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let card = sample(&key, 1_700_000_000);
        let json = serde_json::to_string(&card).unwrap();
        let view = read(&json, 1_700_000_010).unwrap();
        assert_eq!(view.profile.display_name, "Maya");
    }
}
