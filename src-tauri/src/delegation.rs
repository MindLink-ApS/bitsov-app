//! Strict, host-side validation of the node #301 signing contract.
use serde::Deserialize;

// Node #301: pairing/device.rs::op_bytes, ticket.rs::TTL and
// pairing.rs::ELEVATION_TTL_SECS. See tests/fixtures/node301-protocol.md.
pub const OP_ID_BYTES: usize = 12;
pub const TICKET_TTL_SECS: i64 = 300;
pub const ENROLLMENT_TTL_SECS: i64 = 900;
pub const CLOCK_SKEW_SECS: i64 = 30;

/// Local sanity check only; the node remains authoritative for expiry.
pub fn valid_expiry(expires_at: i64, now: i64, ttl: i64) -> bool {
    expires_at > 0
        && expires_at > now.saturating_sub(CLOCK_SKEW_SECS)
        && expires_at <= now.saturating_add(ttl).saturating_add(CLOCK_SKEW_SECS)
}

pub fn expiry_deadline(expires_at: i64) -> i64 {
    expires_at.saturating_add(CLOCK_SKEW_SECS)
}

pub fn canonical_hex(value: &str, bytes: usize) -> bool {
    value.len() == bytes * 2
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn ticket_message(node: &str, nonce: &str) -> Result<String, &'static str> {
    if !canonical_hex(node, 16) || !canonical_hex(nonce, 32) {
        return Err("Invalid ticket challenge. Nothing was signed.");
    }
    Ok(format!("bitsov-ticket-v1\nnode:{node}\nnonce:{nonce}"))
}

#[derive(Clone, Deserialize, PartialEq, Eq)]
pub struct PendingDevice {
    pub op_id: String,
    pub client_id: String,
    pub name: String,
    pub public_key: String,
    pub expires_at: i64,
    pub sas_version: u8,
    pub box_nonce: String,
    pub sas_words: [String; 4],
    pub delegation_message: Option<String>,
}
impl PendingDevice {
    /// Parse all fields in order and bind the exact bytes to the reviewed view.
    /// The full digest must produce the displayed words; v1 never falls back.
    pub fn validate(&self, node: &str, owner_client: &str, now: i64) -> Result<&str, &'static str> {
        let bad = "Invalid device comparison. Nothing was signed; start again.";
        if !canonical_hex(node, 16)
            || !canonical_hex(&self.op_id, OP_ID_BYTES)
            || !canonical_hex(&self.public_key, 65)
            || !self.public_key.starts_with("04")
            || !canonical_hex(&self.box_nonce, 16)
            || self.sas_version != 1
            || self.client_id.is_empty()
            || self.client_id == owner_client
            || !valid_expiry(self.expires_at, now, ENROLLMENT_TTL_SECS)
        {
            return Err(bad);
        }
        let message = self
            .delegation_message
            .as_deref()
            .ok_or("The new device has not confirmed its comparison words yet.")?;
        let fields: Vec<_> = message.split('\n').collect();
        if fields.len() != 8
            || fields[0] != "bitsov-owner-delegation-v2"
            || fields[1] != format!("node:{node}")
            || fields[4] != format!("device_key:{}", self.public_key)
            || fields[5] != format!("op_id:{}", self.op_id)
        {
            return Err(bad);
        }
        let public = fields[2].strip_prefix("client_pubkey:").ok_or(bad)?;
        let epoch = fields[3].strip_prefix("epoch:").ok_or(bad)?;
        let nonce = fields[6].strip_prefix("nonce:").ok_or(bad)?;
        let digest = fields[7].strip_prefix("sas_digest:").ok_or(bad)?;
        if !canonical_hex(public, 32)
            || !canonical_hex(nonce, 16)
            || !canonical_hex(digest, 32)
            || epoch
                .parse::<u64>()
                .ok()
                .filter(|n| n.to_string() == epoch)
                .is_none()
        {
            return Err(bad);
        }
        let bytes: [u8; 32] = hex::decode(digest)
            .map_err(|_| bad)?
            .try_into()
            .map_err(|_| bad)?;
        if crate::sas::words(&blake3::Hash::from(bytes))
            != self.sas_words.each_ref().map(String::as_str)
        {
            return Err(bad);
        }
        Ok(message)
    }
}
