//! Durable ambiguity fence, not a payment authority or a node idempotency key.
//! A lost reply without a node-issued ID remains unknown. Absence from a paged
//! history is never proof that a payment did not happen.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use crate::act::ActionError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pending {
    pub node_id: String,
    pub request_hash: String,
    pub max_msat: u64,
    pub target: Option<Target>,
    pub over_budget: bool,
    /// Reported aggregate paid amount awaiting durable local accounting.
    #[serde(default)]
    pub accounting_msat: Option<u64>,
    /// Paid, not delivered (502 `payment_settled_send_incomplete`). The only
    /// record a delivery retry may replace; nothing else passes the fence.
    #[serde(default)]
    pub undelivered: Option<Undelivered>,
}

/// A settled payment whose message did not go. No plaintext is kept.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Undelivered {
    pub peer: String,
    /// Settled for this message so far, across retries.
    pub paid_msat: u64,
    /// The node said a retry on this connection pays no second admission.
    pub retry: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Target {
    Payment { hash: String },
    Message { id: String, peer: String },
}

pub fn unknown(detail: impl std::fmt::Display) -> ActionError {
    ActionError::new("spend_unknown", format!("Outcome unknown; another spend is blocked until reconciled. {detail}"))
}

/// The OS lock also serializes two app processes. A crash releases the lock,
/// but leaves the pending record. No approval, token, invoice or plaintext is saved.
pub struct Journal {
    _lock: File,
    dir: PathBuf,
}

impl Drop for Journal {
    fn drop(&mut self) {
        // Closing alone leaves flock held when a subprocess inherited the fd.
        let _ = self._lock.unlock();
    }
}

impl Journal {
    pub fn open(dir: &Path) -> Result<Self, ActionError> {
        std::fs::create_dir_all(dir).map_err(unknown)?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)] {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let lock = options.open(dir.join("spend.lock")).map_err(unknown)?;
        lock.try_lock().map_err(|_| unknown("An action is still running."))?;
        Ok(Self { _lock: lock, dir: dir.to_path_buf() })
    }

    pub fn pending(&self) -> Result<Option<Pending>, ActionError> {
        match std::fs::read(self.dir.join("spend-pending.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(unknown),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(unknown(e)),
        }
    }

    pub fn begin(&self, node_id: &str, path: &str, body: &serde_json::Value, max_msat: u64) -> Result<Pending, ActionError> {
        if self.pending()?.is_some() { return Err(unknown("Check the previous action first.")); }
        let pending = Pending {
            node_id: node_id.to_string(),
            request_hash: blake3::hash(format!("{path}\n{body}").as_bytes()).to_hex().to_string(),
            max_msat, target: None, over_budget: false, accounting_msat: None, undelivered: None,
        };
        self.save(&pending)?;
        Ok(pending)
    }

    pub fn save(&self, pending: &Pending) -> Result<(), ActionError> {
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)] {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let mut file = options.open(self.dir.join("spend-pending.next")).map_err(unknown)?;
        file.write_all(&serde_json::to_vec(pending).map_err(unknown)?).map_err(unknown)?;
        file.sync_all().map_err(unknown)?;
        std::fs::rename(self.dir.join("spend-pending.next"), self.dir.join("spend-pending.json")).map_err(unknown)?;
        self.sync_dir()
    }

    pub fn clear(&self) -> Result<(), ActionError> {
        std::fs::remove_file(self.dir.join("spend-pending.json")).map_err(unknown)?;
        self.sync_dir()
    }

    fn sync_dir(&self) -> Result<(), ActionError> {
        #[cfg(unix)] File::open(&self.dir).and_then(|f| f.sync_all()).map_err(unknown)?;
        Ok(())
    }
}

/// Only an exact node-issued reference can settle an ambiguous result. Never
/// correlate by amount, timestamp, plaintext, or a guessed absence.
pub fn terminal(pending: &Pending, rows: &[serde_json::Value]) -> Option<&'static str> {
    if pending.over_budget { return None; }
    let target = pending.target.as_ref()?;
    rows.iter().find_map(|row| {
        let amount = row.get("amount_msat").or_else(|| row.get("payment_amount_msat"))?.as_u64()?;
        if amount > pending.max_msat { return None; }
        match target {
            Target::Payment { hash } if row["payment_hash"].as_str() == Some(hash.as_str())
                && row["direction"].as_str() == Some("outgoing") => {
                match row["status"].as_str()? {
                    "settled" | "success" | "succeeded" => Some("settled"),
                    "failed" => Some("failed"),
                    _ => None,
                }
            }
            Target::Message { id, peer } if row["id"].as_str() == Some(id.as_str())
                && row["sender"].as_str() == Some(pending.node_id.as_str())
                && row["recipient"].as_str() == Some(peer.as_str()) => Some("settled"),
            _ => None,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn dropping_guard_unlocks_even_if_a_child_inherited_the_descriptor() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        let inherited = journal._lock.try_clone().unwrap();
        drop(journal);
        assert!(Journal::open(dir.path()).is_ok());
        drop(inherited);
    }

    #[test]
    fn restart_and_concurrency_do_not_allow_redispatch() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        journal.begin("node", "/messages/compose", &json!({"plaintext":"PRIVATE"}), 2000).unwrap();
        assert!(Journal::open(dir.path()).is_err());
        drop(journal);
        let next = Journal::open(dir.path()).unwrap();
        assert!(next.begin("node", "/messages/compose", &json!({}), 2000).is_err());
        let disk = std::fs::read_to_string(dir.path().join("spend-pending.json")).unwrap();
        assert!(!disk.contains("PRIVATE") && !disk.contains("token"));
    }

    #[test]
    fn reconciliation_needs_exact_terminal_outgoing_evidence() {
        let p = Pending { node_id:"node".into(), request_hash:"hash".into(), max_msat:2000,
            target:Some(Target::Payment { hash:"abc".into() }), over_budget:false, accounting_msat: None, undelivered: None };
        assert_eq!(terminal(&p, &[]), None);
        assert_eq!(terminal(&p, &[json!({"payment_hash":"other", "amount_msat":2000, "direction":"outgoing", "status":"settled"})]), None);
        for status in ["pending", "inflight", "expired", "unknown"] {
            assert_eq!(terminal(&p, &[json!({"payment_hash":"abc", "amount_msat":2000, "direction":"outgoing", "status":status})]), None);
        }
        assert_eq!(terminal(&p, &[json!({"payment_hash":"abc", "amount_msat":2000, "direction":"incoming", "status":"settled"})]), None);
        assert_eq!(terminal(&p, &[json!({"payment_hash":"abc", "amount_msat":999000, "direction":"outgoing", "status":"settled"})]), None);
        for status in ["settled", "failed"] {
            assert_eq!(terminal(&p, &[json!({"payment_hash":"abc", "amount_msat":2000, "direction":"outgoing", "status":status})]), Some(status));
        }
    }

    #[test]
    fn message_reconciliation_rejects_other_sender_and_recipient() {
        let p = Pending { node_id:"node".into(), request_hash:"hash".into(), max_msat:2000,
            target:Some(Target::Message { id:"abc".into(), peer:"peer".into() }), over_budget:false, accounting_msat: None, undelivered: None };
        let mut row = json!({"id":"abc", "sender":"other", "recipient":"peer", "payment_amount_msat":2000});
        assert_eq!(terminal(&p, &[row.clone()]), None);
        row["sender"] = json!("node");
        assert_eq!(terminal(&p, &[row.clone()]), Some("settled"));
        row["recipient"] = json!("other");
        assert_eq!(terminal(&p, &[row]), None);
    }
}
