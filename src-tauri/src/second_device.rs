//! Node N-2DEV wire contract. No authority or signing key lives here.
use crate::delegation::canonical_hex;
use serde::Deserialize;

pub const CAPABILITY: &str = "second_device_enrollment_v1";
pub const TTL: i64 = 300;

#[derive(Clone, Deserialize, PartialEq, Eq)]
pub struct Pending {
    pub op_id: String,
    pub client_id: String,
    pub name: String,
    pub public_key: String,
    pub box_nonce: String,
    pub node: String,
    pub approver_client: String,
    pub approver_epoch: u64,
    pub approver_key: String,
    pub nonce: String,
    pub client_pubkey: String,
    pub epoch: u64,
    pub device_key: String,
    pub device_name: String,
    pub noise_handshake_hash: String,
    pub noise_client_static: String,
    pub box_transport_pubkey: String,
    pub ticket_id: String,
    pub issuer: String,
    pub sas_version: u8,
    pub sas_digest: String,
    pub sas_words: [String; 4],
    pub expires_at: i64,
    pub approval_message: Option<String>,
    pub reject_message: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Pending {
        serde_json::from_str(include_str!("../tests/fixtures/node356-pending.json")).unwrap()
    }
    #[test]
    fn node_approval_bytes_words_and_context_are_verified_before_signing() {
        let p = fixture();
        assert!(p.validate(&p.node, "owner", 7, &p.approver_key, 1000).is_ok());
        for field in ["op_id", "name", "public_key", "box_nonce", "node", "approver_client", "approver_key", "nonce", "client_pubkey", "device_key", "device_name", "noise_handshake_hash", "noise_client_static", "box_transport_pubkey", "ticket_id", "issuer", "sas_digest", "approval_message", "reject_message"] {
            let mut v: serde_json::Value = serde_json::from_str(include_str!("../tests/fixtures/node356-pending.json")).unwrap();
            v[field] = "tampered".into();
            let changed: Pending = serde_json::from_value(v).unwrap();
            assert!(changed.validate(&p.node, "owner", 7, &p.approver_key, 1000).is_err(), "{field}");
        }
        let mut wrong = p.clone();
        wrong.sas_words.swap(0, 1);
        assert!(wrong.validate(&p.node, "owner", 7, &p.approver_key, 1000).is_err());
        assert!(p.validate(&p.node, "non-owner", 7, &p.approver_key, 1000).is_err());
        assert!(p.validate(&p.node, "owner", 8, &p.approver_key, 1000).is_err());
        assert!(p.validate(&p.node, "owner", 7, &p.approver_key, 1300).is_err());
        assert!(p.validate(&p.node, "owner", 7, &p.approver_key, 999).is_err());
    }
    #[test]
    fn approval_is_bound_to_current_qr_or_console() {
        let mut p = fixture();
        assert!(p.can_approve(None));
        p.issuer = p.approver_key.clone();
        assert!(!p.can_approve(None));
        assert!(!p.can_approve(Some(&"00".repeat(16))));
        assert!(p.can_approve(Some(&p.ticket_id)));
    }
}

pub fn ticket_commitment(code: &str) -> [u8; 32] {
    let mut h = blake3::Hasher::new();
    h.update(b"bitsov-second-device-ticket-v1");
    h.update(code.as_bytes());
    *h.finalize().as_bytes()
}
pub fn ticket_id(code: &str) -> String {
    let mut h = blake3::Hasher::new();
    h.update(b"bitsov-ticket-id-v1");
    h.update(code.as_bytes());
    hex::encode(&h.finalize().as_bytes()[..16])
}
pub fn ticket_message(node: &str, nonce: &str) -> Result<String, &'static str> {
    crate::delegation::ticket_message(node, nonce)?;
    Ok(format!("bitsov-ticket-v2\nnode:{node}\nnonce:{nonce}\npurpose:second_device"))
}
impl Pending {
    pub fn can_approve(&self, ticket: Option<&str>) -> bool {
        self.issuer == "console" || ticket == Some(self.ticket_id.as_str())
    }
    pub fn message(&self, reject: bool) -> String {
        let domain = if reject { "bitsov-second-device-reject-v1" } else { "bitsov-second-device-approval-v1" };
        format!("{domain}\nnode:{}\napprover_client:{}\napprover_epoch:{}\napprover_key:{}\nop_id:{}\nnonce:{}\nclient_pubkey:{}\nepoch:{}\ndevice_key:{}\ndevice_name:{}\nnoise_handshake_hash:{}\nnoise_client_static:{}\nbox_transport_pubkey:{}\nticket_id:{}\nissuer:{}\nsas_version:2\nsas_digest:{}\nsas_words:{}\nexpires_at:{}", self.node, self.approver_client, self.approver_epoch, self.approver_key, self.op_id, self.nonce, self.client_pubkey, self.epoch, self.device_key, self.device_name, self.noise_handshake_hash, self.noise_client_static, self.box_transport_pubkey, self.ticket_id, self.issuer, self.sas_digest, self.sas_words.join(" "), self.expires_at)
    }
    pub fn validate(&self, node: &str, client: &str, epoch: u64, key: &str, now: i64) -> Result<(), &'static str> {
        let bad = "Invalid second-device comparison. Nothing was signed; start again.";
        if self.node != node || self.approver_client != client || self.approver_epoch != epoch
            || self.approver_key != key || self.client_id.is_empty() || self.client_id == client
            || self.sas_version != 2 || self.expires_at <= now || self.expires_at > now.saturating_add(TTL)
            || self.device_name != self.name || self.name.is_empty() || self.name.chars().count() > 64
            || self.name.trim() != self.name || self.name.chars().any(|c| c.is_control() || matches!(c, '\u{00AD}' | '\u{061C}' | '\u{180E}' | '\u{200B}'..='\u{200F}' | '\u{2028}'..='\u{202E}' | '\u{2060}'..='\u{2069}' | '\u{FEFF}'))
            || self.public_key != self.device_key || !self.device_key.starts_with("04")
            || !(self.issuer == "console" || canonical_hex(&self.issuer, 16)) {
            return Err(bad);
        }
        for (value, bytes) in [(&self.node,16),(&self.approver_key,16),(&self.op_id,12),(&self.nonce,16),(&self.box_nonce,16),(&self.client_pubkey,32),(&self.device_key,65),(&self.noise_handshake_hash,32),(&self.noise_client_static,32),(&self.box_transport_pubkey,32),(&self.ticket_id,16),(&self.sas_digest,32)] {
            if !canonical_hex(value, bytes) { return Err(bad); }
        }
        let digest: [u8;32] = hex::decode(&self.sas_digest).map_err(|_| bad)?.try_into().map_err(|_| bad)?;
        if crate::sas::words(&blake3::Hash::from(digest)) != self.sas_words.each_ref().map(String::as_str)
            || self.approval_message.as_deref() != Some(self.message(false).as_str())
            || self.reject_message.as_deref() != Some(self.message(true).as_str()) {
            return Err(bad);
        }
        Ok(())
    }
}
