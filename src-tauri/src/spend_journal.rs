//! Durable ambiguity fence, not a payment authority. On a node with
//! `message_operations_v1` a 1:1 send also carries the node's idempotency key
//! (`operation_id`), written here before the first POST and reused by every
//! retry of that send. A lost reply without it remains unknown. Absence from a
//! paged history is never proof that a payment did not happen.
//!
//! Call parents use a durable identity/peer/call index, repaired from pending
//! snapshots and imported once from pre-index H1 records before authentication.
//! The read-only listing returns at most 100 newest rows plus skipped/has_more.
//! Hourly maintenance archives terminal records older than 30 days; open calls,
//! uncertain outcomes, damaged files and pending records remain retained.

use std::fs::File;
#[cfg(unix)]
use std::fs::OpenOptions;
#[cfg(unix)]
use std::io::Write;
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use crate::act::ActionError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pending {
    /// Durable per-send identity. Separate from the deterministic operation fingerprint.
    #[serde(default)]
    pub id: String,
    /// The accounting row needed if an in-flight retry is refused and rolled back.
    #[serde(default)]
    pub rollback_charge_id: Option<String>,
    pub node_id: String,
    pub request_hash: String,
    pub max_msat: u64,
    pub target: Option<Target>,
    pub over_budget: bool,
    /// Conservative charge awaiting durable accounting; `paid` holds the evidence.
    #[serde(default)]
    pub accounting_msat: Option<u64>,
    /// Payment evidence saved atomically with the conservative accounting amount.
    #[serde(default)]
    pub paid: Option<crate::budget::Paid>,
    /// Paid, not delivered (502 `payment_settled_send_incomplete`). A delivery
    /// retry updates this same record in place; nothing else passes the fence,
    /// and reconciliation never removes it (see [`Undelivered`]).
    #[serde(default)]
    pub undelivered: Option<Undelivered>,
    /// Budget-book reservation `accounting_msat` settles. `None`: `request_hash`.
    #[serde(default)]
    pub charge_id: Option<String>,
    /// This request reserved principal in the app book. Older direct-payment
    /// journals predate daily accounting and deserialize as unbudgeted.
    #[serde(default)]
    pub budgeted: bool,
    /// New journals reserve principal plus routing allowance. Old ones stay readable.
    #[serde(default)]
    pub all_in: bool,
    /// The node's idempotency key for this send (UUIDv4), saved before the
    /// first POST. A retry, a restart or an unknown outcome reuses it and asks
    /// `GET /messages/operations/{id}`; it is never replaced by a fresh one.
    #[serde(default)]
    pub operation_id: Option<String>,
    /// [`operation`] of the send `operation_id` names.
    #[serde(default)]
    pub op: Option<String>,
    /// Its recipient node, for a paid, undelivered record built on reconcile.
    #[serde(default)]
    pub peer: Option<String>,
    /// The node reported this operation holds no payment (never recorded,
    /// `prepared` or `released`). Nothing is owed and nothing is fenced: a
    /// resend of this very message reuses `operation_id`, anything else
    /// replaces the record.
    #[serde(default)]
    pub resumable: bool,
    /// Initial ledger snapshot repairs a crash between the two atomic files.
    #[serde(default)]
    pub operation_record: Option<OperationRecord>,
}

impl Pending {
    /// The book entry this record's accounting belongs to.
    pub fn charge_id(&self) -> &str {
        self.charge_id.as_deref().unwrap_or(&self.request_hash)
    }
}

/// A settled payment whose message did not go. No plaintext is kept.
///
/// It stays until the message is delivered by a retry of this same operation
/// or the owner stops retrying it. Accounting it never removes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Undelivered {
    pub peer: String,
    /// Settled for this message so far, across retries.
    pub paid_msat: u64,
    /// The node said a retry re-sends its paid proof rather than paying again.
    pub retry: bool,
    /// The operation: [`operation`] of the compose body. Only a retry of this
    /// very message to this very contact may reuse the record.
    #[serde(default)]
    pub op: String,
    /// The admission the first attempt settled, msat.
    #[serde(default)]
    pub admission_msat: u64,
    /// A retry was dispatched and its outcome is not known yet.
    #[serde(default)]
    pub in_flight: bool,
    /// Retries dispatched so far; each has its own book reservation.
    #[serde(default)]
    pub attempts: u32,
    /// The operation's settled payment hash, when the node named it. A retry
    /// reply carrying the same hash paid nothing new.
    #[serde(default)]
    pub payment_hash: Option<String>,
}

/// The identity of a compose, without its caps: recipient, kind and a hash of
/// the plaintext. The plaintext itself is never saved.
pub fn operation(body: &serde_json::Value) -> String {
    let op = serde_json::json!({
        "recipient": body["recipient"], "is_room": body["is_room"],
        "kind": body["kind"], "plaintext": body["plaintext"],
    });
    blake3::hash(op.to_string().as_bytes()).to_hex().to_string()
}

/// Durable host history. Never used as a spending authority in H1.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OperationState { Dispatching, Paid, Unpaid, PaidUndelivered, FailedPaid, Unknown, Settled, Closed }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperationRecord {
    pub op_id: String,
    pub node_id: String,
    pub kind: String,
    pub peer: String,
    pub call_id: Option<String>,
    pub parent_op: Option<String>,
    pub request_hash: String,
    pub cap_msat: u64,
    pub state: OperationState,
    pub paid_msat: Option<u64>,
    pub message_id: Option<String>,
    pub payment_hash: Option<String>,
    pub created_ms: u64,
    pub settled_ms: Option<u64>,
}

/// Renderer projection deliberately omits local identity, request and payment hashes.
#[derive(Debug, Serialize)]
pub struct OpView {
    pub op_id: String,
    pub kind: String,
    pub peer: String,
    pub call_id: Option<String>,
    pub state: OperationState,
    pub cap_msat: u64,
    pub paid_msat: Option<u64>,
    pub message_id: Option<String>,
}

impl From<OperationRecord> for OpView {
    fn from(record: OperationRecord) -> Self {
        Self { op_id: record.op_id, kind: record.kind, peer: record.peer, call_id: record.call_id,
            state: record.state, cap_msat: record.cap_msat, paid_msat: record.paid_msat, message_id: record.message_id }
    }
}

pub fn timestamp_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default()
        .as_millis().min(u64::MAX as u128) as u64
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Target {
    Payment { hash: String },
    Message { id: String, peer: String },
}

/// What `GET /messages/operations/{id}` says happened to the money and the message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// `acked`: the recipient's node stored it.
    Accepted,
    /// `sent`: paid and handed to the recipient's node, not yet accepted.
    Sent,
    /// `paid` / `rejected_retryable`: paid, not handed over. Its node resends;
    /// a retry with the same id pays nothing.
    Paid,
    /// `prepared` / `released`: no payment is held for it.
    NothingPaid,
    /// `failed_paid`: paid, and refused for good.
    FailedPaid,
    /// `paying` / `payment_unknown`, or anything unrecognised: unresolved.
    PaymentUnknown,
}

/// Fail closed: a state this app does not know is an unresolved payment.
pub fn outcome(state: &str) -> Outcome {
    match state {
        "acked" => Outcome::Accepted,
        "sent" => Outcome::Sent,
        "paid" | "rejected_retryable" => Outcome::Paid,
        "prepared" | "released" => Outcome::NothingPaid,
        "failed_paid" => Outcome::FailedPaid,
        _ => Outcome::PaymentUnknown,
    }
}

/// A fresh RFC 4122 version-4 id, the only form the node accepts.
pub fn new_operation_id() -> Result<String, ActionError> {
    let mut b = [0u8; 16];
    getrandom::getrandom(&mut b).map_err(unknown)?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex::encode(b);
    Ok(format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..]))
}

pub fn unknown(detail: impl std::fmt::Display) -> ActionError {
    ActionError::new("spend_unknown", format!("Outcome unknown; another spend is blocked until reconciled. {detail}"))
}

/// Read the atomic journal snapshot for conservative ledger retention only.
/// Spending and reconciliation still require the Journal's exclusive OS lock.
pub fn read_pending(dir: &Path) -> Result<Option<Pending>, ActionError> {
    match std::fs::read(dir.join("spend-pending.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(unknown),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(unknown(e)),
    }
}

/// The OS lock also serializes two app processes. A crash releases the lock,
/// but leaves the pending record. No approval, token, invoice or plaintext is saved.
pub struct Journal {
    _lock: File,
    // Maintenance holds this while compacting a bounded batch of candidates.
    // Journal sessions keep active and resumable snapshots safe from compaction.
    _history_lock: File,
    dir: PathBuf,
}

impl Drop for Journal {
    fn drop(&mut self) {
        // Closing alone leaves flock held when a subprocess inherited the fd.
        let _ = self._history_lock.unlock();
        let _ = self._lock.unlock();
    }
}

impl Journal {
    #[cfg(not(unix))]
    pub fn open(_dir: &Path) -> Result<Self, ActionError> {
        Err(unknown("private spend journal storage is not supported on this platform"))
    }

    #[cfg(unix)]
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
        let history_lock = history_lock(dir)?;
        history_lock.lock().map_err(unknown)?;
        Ok(Self { _lock: lock, _history_lock: history_lock, dir: dir.to_path_buf() })
    }

    pub fn pending(&self) -> Result<Option<Pending>, ActionError> {
        let mut pending = read_pending(&self.dir)?;
        let operation_id = pending.as_ref().and_then(|p| p.operation_id.clone());
        let repair = (|| {
            if let Some(p) = pending.as_mut().filter(|p| p.id.is_empty()) {
                // Migrate under the journal lock before exposing a dismissal identity.
                p.id = fresh_id()?;
                self.save(p)?;
            }
            if let Some(p) = &pending { self.ensure_operation(p)?; }
            Ok(())
        })();
        // The snapshot already names the dispatched operation, even when its
        // ledger/index cannot be read or repaired. Preserve it on every failure.
        repair.map_err(|e: ActionError| e.for_operation(operation_id.as_deref()))?;
        Ok(pending)
    }

    pub fn begin(&self, node_id: &str, path: &str, body: &serde_json::Value, max_msat: u64) -> Result<Pending, ActionError> {
        self.begin_operation(node_id, path, body, max_msat, None)
    }

    /// `operation`: the node idempotency key and its fingerprint, durable
    /// before the caller posts. Only a record that holds no payment
    /// ([`Pending::resumable`]) may be replaced.
    pub fn begin_operation(&self, node_id: &str, path: &str, body: &serde_json::Value, max_msat: u64, operation: Option<(String, String)>) -> Result<Pending, ActionError> {
        if self.pending()?.is_some_and(|p| !p.resumable) { return Err(unknown("Check the previous action first.")); }
        let (operation_id, op) = operation.map_or((None, None), |(id, op)| (Some(id), Some(op)));
        let mut pending = Pending {
            id: fresh_id()?, rollback_charge_id: None,
            node_id: node_id.to_string(),
            request_hash: blake3::hash(format!("{path}\n{body}").as_bytes()).to_hex().to_string(),
            max_msat, target: None, over_budget: false, accounting_msat: None, paid: None, undelivered: None, charge_id: None, budgeted: false, all_in: false,
            peer: operation_id.as_ref().and(body["recipient"].as_str()).map(str::to_string),
            operation_id, op, resumable: false, operation_record: None,
        };
        if let Some(id) = &pending.operation_id {
            let signal_kind = body["kind"].as_u64().unwrap_or(0);
            let payload = if (400..=403).contains(&signal_kind) {
                body["plaintext"].as_str().and_then(|p| serde_json::from_str::<serde_json::Value>(p).ok())
            } else { None };
            // Persist only protocol identifiers, never arbitrary caller-supplied strings.
            let valid_call_id = |id: &str| id.len() == 32 && id.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase());
            let call_id = payload.as_ref().and_then(|p| p["call_id"].as_str())
                .filter(|id| valid_call_id(id)).map(str::to_string);
            let recovery = payload.as_ref().and_then(|p| p["sdp"].as_str())
                .and_then(|s| s.lines().find_map(|l| l.strip_prefix("a=x-bitsov-restart-of:")))
                .filter(|id| valid_call_id(id));
            let kind = match signal_kind {
                400 if recovery.is_some() => "call_recovery",
                400 => "call_offer", 401 => "call_answer", 402 => "call_ice", 403 => "call_hangup",
                _ if body["plaintext"].as_str().is_some_and(crate::act::is_room_chat) => "room_leg",
                _ => "message",
            };
            let parent_call = if signal_kind == 403 { call_id.as_deref() } else { recovery };
            let parent_op = if let Some(call) = parent_call {
                self.call_parent(node_id, pending.peer.as_deref().unwrap_or_default(), call)?
            } else { None };
            let mut record = self.live_operation(id)?.unwrap_or(OperationRecord {
                op_id: id.clone(), node_id: node_id.into(), kind: kind.into(), peer: pending.peer.clone().unwrap_or_default(),
                call_id, parent_op, request_hash: pending.request_hash.clone(), cap_msat: max_msat,
                state: OperationState::Dispatching, paid_msat: None, message_id: None, payment_hash: None,
                created_ms: timestamp_ms(), settled_ms: None,
            });
            record.state = OperationState::Dispatching;
            record.cap_msat = max_msat;
            record.settled_ms = None;
            pending.operation_record = Some(record);
        }
        self.save(&pending)?;
        if let Some(record) = &pending.operation_record { self.write_operation(record)?; }
        Ok(pending)
    }

    #[cfg(not(unix))]
    pub fn save(&self, _pending: &Pending) -> Result<(), ActionError> {
        Err(unknown("private spend journal storage is not supported on this platform"))
    }

    #[cfg(unix)]
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
        self.sync_dir()?;
        self.ensure_operation(pending)
    }

    pub fn clear(&self) -> Result<(), ActionError> {
        std::fs::remove_file(self.dir.join("spend-pending.json")).map_err(unknown)?;
        self.sync_dir()
    }

    fn operation_path(&self, id: &str) -> Result<PathBuf, ActionError> {
        // IDs are host minted. Reject unsafe legacy/corrupt journal paths as well.
        if id.len() != 36 || !id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-') {
            return Err(unknown("Invalid operation id in the spend journal."));
        }
        Ok(self.dir.join("ops").join(format!("{id}.json")))
    }

    // Fresh IDs and the protected pending slot never need archived history.
    // Keep repair and dispatch independent of unrelated archive size/damage.
    fn live_operation(&self, id: &str) -> Result<Option<OperationRecord>, ActionError> {
        read_operation(&self.operation_path(id)?, Some(id))
    }

    pub fn operation_record(&self, id: &str) -> Result<Option<OperationRecord>, ActionError> {
        match self.live_operation(id)? {
            Some(record) => Ok(Some(record)),
            None => archived_operation(&self.dir, id),
        }
    }

    fn call_parent(&self, node_id: &str, peer: &str, call: &str) -> Result<Option<String>, ActionError> {
        let index = call_index_path(&self.dir, node_id, peer, call);
        let entry: CallIndex = match std::fs::read(index) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| damaged_record())?,
            // Incoming calls and legacy nodes may have no local offer. Losing
            // both the mapping and identifiable parent metadata is indistinguishable
            // from that case; absence alone must not invent an admission fence.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(damaged_record()),
        };
        let record = self.operation_record(&entry.op_id)?.ok_or_else(damaged_record)?;
        if record.node_id != node_id || record.peer != peer || record.call_id.as_deref() != Some(call)
            || !matches!(record.kind.as_str(), "call_offer" | "call_recovery") {
            return Err(damaged_record());
        }
        Ok(Some(record.op_id))
    }

    fn ensure_operation(&self, pending: &Pending) -> Result<(), ActionError> {
        if let Some(id) = &pending.operation_id {
            if self.live_operation(id)?.is_none() {
                // Older pending journals have no kind/call metadata. Do not guess it.
                let record = pending.operation_record.clone().unwrap_or(OperationRecord {
                    op_id: id.clone(), node_id: pending.node_id.clone(), kind: "legacy".into(),
                    peer: pending.peer.clone().unwrap_or_default(), call_id: None, parent_op: None,
                    request_hash: pending.request_hash.clone(), cap_msat: pending.max_msat,
                    state: if pending.resumable { OperationState::Unpaid } else { OperationState::Unknown },
                    paid_msat: pending.undelivered.as_ref().map(|u| u.paid_msat), message_id: None,
                    payment_hash: pending.undelivered.as_ref().and_then(|u| u.payment_hash.clone()),
                    created_ms: timestamp_ms(), settled_ms: None,
                });
                self.write_operation(&record)?;
            }
            if let Some(mut record) = self.live_operation(id)? {
                if let Some(parent) = &record.parent_op {
                    self.operation_record(parent)?.ok_or_else(damaged_record)?;
                }
                // Also repairs a crash after the operation rename but before its index.
                write_call_index(&self.dir, &record)?;
                // The slot is written first. Repair a crash before the matching
                // history update, before any shortcut or resumable replacement.
                // Completed history wins over older pending snapshots.
                if !matches!(record.state, OperationState::Settled | OperationState::Closed | OperationState::FailedPaid) {
                    let mut changed = false;
                    if let Some(u) = pending.undelivered.as_ref().filter(|u| !u.in_flight) {
                        if record.state != OperationState::PaidUndelivered || record.paid_msat != Some(u.paid_msat) {
                            record.state = OperationState::PaidUndelivered;
                            record.paid_msat = Some(u.paid_msat);
                            record.payment_hash = u.payment_hash.clone().or(record.payment_hash);
                            record.settled_ms = None;
                            changed = true;
                        }
                    } else if pending.resumable && record.state != OperationState::Unpaid {
                        record.state = OperationState::Unpaid;
                        record.paid_msat = Some(0);
                        record.settled_ms = Some(timestamp_ms());
                        changed = true;
                    }
                    if changed { self.write_operation(&record)?; }
                }
            }
        }
        Ok(())
    }

    #[cfg(unix)]
    fn write_operation(&self, record: &OperationRecord) -> Result<(), ActionError> {
        use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
        let path = self.operation_path(&record.op_id)?;
        let dir = self.dir.join("ops");
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir).map_err(unknown)?;
        self.sync_dir()?;
        let next = path.with_extension("next");
        let mut file = OpenOptions::new().write(true).create(true).truncate(true)
            .mode(0o600).custom_flags(libc::O_NOFOLLOW).open(&next).map_err(unknown)?;
        file.write_all(&serde_json::to_vec(record).map_err(unknown)?).map_err(unknown)?;
        file.sync_all().map_err(unknown)?;
        std::fs::rename(next, &path).map_err(unknown)?;
        File::open(dir).and_then(|f| f.sync_all()).map_err(unknown)?;
        write_call_index(&self.dir, record)
    }

    #[cfg(not(unix))]
    fn write_operation(&self, _record: &OperationRecord) -> Result<(), ActionError> {
        Err(unknown("private spend journal storage is not supported on this platform"))
    }

    /// Commit history before releasing/replacing the pending slot. Evidence is
    /// whole-operation principal, never a retry's incremental budget charge.
    pub fn record_outcome(&self, pending: &Pending, state: OperationState, evidence: Option<&serde_json::Value>) -> Result<(), ActionError> {
        let Some(id) = &pending.operation_id else { return Ok(()) };
        self.ensure_operation(pending)?;
        let mut record = self.operation_record(id)?.ok_or_else(|| unknown("Missing operation record."))?;
        record.state = state;
        if record.state == OperationState::Dispatching { record.cap_msat = pending.max_msat; }
        if let Some(value) = evidence {
            if let Some(amount) = value["amount_msat"].as_u64() {
                if let Some(whole) = amount.checked_add(value["readmission_msat"].as_u64().unwrap_or(0)) {
                    record.paid_msat = Some(record.paid_msat.unwrap_or(0).max(whole));
                }
            }
            if let Some(id) = value["message_id"].as_str().filter(|s| !s.is_empty()) { record.message_id = Some(id.into()); }
            if let Some(hash) = value["payment_hash"].as_str() { record.payment_hash = Some(hash.into()); }
        }
        if record.state == OperationState::Unpaid && record.paid_msat.is_none() { record.paid_msat = Some(0); }
        record.settled_ms = if matches!(record.state, OperationState::Settled | OperationState::Closed | OperationState::Unpaid | OperationState::FailedPaid) {
            Some(timestamp_ms())
        } else { None };
        self.write_operation(&record)
    }

    fn sync_dir(&self) -> Result<(), ActionError> {
        #[cfg(unix)] File::open(&self.dir).and_then(|f| f.sync_all()).map_err(unknown)?;
        Ok(())
    }
}

/// Maximum response size; listing is read-only and never takes either money lock.
pub const OP_LIST_LIMIT: usize = 100;
const RETENTION_MS: u64 = 30 * 24 * 60 * 60 * 1000;

#[derive(Debug, Serialize)]
pub struct OpList {
    pub operations: Vec<OpView>,
    pub skipped: usize,
    pub has_more: bool,
}

fn damaged_record() -> ActionError {
    // Do not log parser errors: they can contain bytes from a damaged record.
    eprintln!("spend ledger: required operation record or call index is missing, unreadable, or invalid");
    unknown("Required operation record or call index is missing, unreadable, or invalid.")
}

fn read_operation(path: &Path, expected_id: Option<&str>) -> Result<Option<OperationRecord>, ActionError> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let record: OperationRecord = serde_json::from_slice(&bytes).map_err(|_| damaged_record())?;
            if expected_id.is_some_and(|id| id != record.op_id) { return Err(damaged_record()); }
            Ok(Some(record))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(damaged_record()),
    }
}

// A stream, not a Vec: both listing and maintenance have bounded working sets.
fn history_entries(dir: &Path) -> Result<impl Iterator<Item = std::io::Result<std::fs::DirEntry>>, ActionError> {
    match std::fs::read_dir(dir.join("ops")) {
        Ok(entries) => Ok(Some(entries).into_iter().flatten()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None.into_iter().flatten()),
        Err(e) => Err(unknown(e)),
    }
}

pub fn list_operations(dir: &Path, node_id: &str, peer: Option<&str>, limit: usize) -> Result<OpList, ActionError> {
    let limit = limit.clamp(1, OP_LIST_LIMIT);
    let mut rows = std::collections::BTreeMap::new();
    let mut skipped = 0;
    let mut matched = 0;
    for entry in history_entries(dir)? {
        let path = match entry { Ok(e) => e.path(), Err(_) => { skipped += 1; continue; } };
        if path.extension().is_none_or(|e| e != "json") { continue; }
        let record = match read_operation(&path, path.file_stem().and_then(|s| s.to_str())) {
            Ok(Some(record)) => record,
            _ => { skipped += 1; continue; }
        };
        if record.node_id != node_id || peer.is_some_and(|p| p != record.peer) { continue; }
        matched += 1;
        rows.insert((record.created_ms, record.op_id.clone()), record);
        if rows.len() > limit { rows.pop_first(); }
    }
    Ok(OpList { operations: rows.into_values().rev().map(Into::into).collect(), skipped, has_more: matched > limit })
}

#[derive(Serialize, Deserialize)]
struct CallIndex { op_id: String, created_ms: u64 }

fn call_index_path(dir: &Path, node_id: &str, peer: &str, call: &str) -> PathBuf {
    let key = serde_json::to_vec(&(node_id, peer, call)).expect("string tuple serializes");
    dir.join("call-index").join(format!("{}.json", blake3::hash(&key).to_hex()))
}

#[cfg(unix)]
fn history_lock(dir: &Path) -> Result<File, ActionError> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::create_dir_all(dir).map_err(unknown)?;
    OpenOptions::new().read(true).write(true).create(true).truncate(false)
        .mode(0o600).custom_flags(libc::O_NOFOLLOW).open(dir.join("history.lock")).map_err(unknown)
}

#[cfg(not(unix))]
fn history_lock(_dir: &Path) -> Result<File, ActionError> {
    Err(unknown("private spend journal storage is not supported on this platform"))
}

#[cfg(unix)]
fn write_call_index(dir: &Path, record: &OperationRecord) -> Result<(), ActionError> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    if !matches!(record.kind.as_str(), "call_offer" | "call_recovery") { return Ok(()); }
    let Some(call) = record.call_id.as_deref() else { return Ok(()) };
    if terminal_record(record) {
        reclaim_call_index(dir, record)?;
        return sync_call_indexes(dir);
    }
    let path = call_index_path(dir, &record.node_id, &record.peer, call);
    match std::fs::read(&path) {
        Ok(bytes) => {
            let old: CallIndex = serde_json::from_slice(&bytes).map_err(|_| damaged_record())?;
            if (old.created_ms, &old.op_id) >= (record.created_ms, &record.op_id) { return Ok(()); }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(damaged_record()),
    }
    let parent = path.parent().expect("index directory");
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(parent).map_err(unknown)?;
    let next = path.with_extension("next");
    let mut file = OpenOptions::new().write(true).create(true).truncate(true)
        .mode(0o600).custom_flags(libc::O_NOFOLLOW).open(&next).map_err(unknown)?;
    let index = CallIndex { op_id: record.op_id.clone(), created_ms: record.created_ms };
    file.write_all(&serde_json::to_vec(&index).map_err(unknown)?).map_err(unknown)?;
    file.sync_all().map_err(unknown)?;
    std::fs::rename(next, &path).map_err(unknown)?;
    File::open(parent).and_then(|f| f.sync_all()).map_err(unknown)?;
    File::open(dir).and_then(|f| f.sync_all()).map_err(unknown)
}

#[cfg(not(unix))]
fn write_call_index(_dir: &Path, _record: &OperationRecord) -> Result<(), ActionError> {
    Err(unknown("private spend journal storage is not supported on this platform"))
}

/// One-time upgrade of pre-index H1 history, before authenticating/enabling money
/// actions. Never invoked with NodeState::money or spend.lock held. Writers and
/// migration serialize only a single index update at a time.
pub fn initialize_history(dir: &Path) -> Result<(), ActionError> {
    let marker = dir.join("call-index-v1");
    if marker.exists() { return Ok(()); }
    for entry in history_entries(dir)? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if path.extension().is_none_or(|e| e != "json") { continue; }
        let Ok(Some(record)) = read_operation(&path, path.file_stem().and_then(|s| s.to_str())) else { continue };
        if !matches!(record.kind.as_str(), "call_offer" | "call_recovery") { continue; }
        let Some(call) = record.call_id.as_deref() else { continue };
        let lock = history_lock(dir)?;
        lock.lock().map_err(unknown)?;
        // Preserve a damaged existing mapping as a fail-closed marker for just
        // this call. It must not stop migration/authentication for other calls.
        let damaged = match std::fs::read(call_index_path(dir, &record.node_id, &record.peer, call)) {
            Ok(bytes) => serde_json::from_slice::<CallIndex>(&bytes).is_err(),
            Err(e) => e.kind() != std::io::ErrorKind::NotFound,
        };
        if damaged {
            let _ = damaged_record();
            let _ = lock.unlock();
            continue;
        }
        let result = write_call_index(dir, &record);
        let _ = lock.unlock();
        result?;
    }
    std::fs::create_dir_all(dir).map_err(unknown)?;
    File::create(marker).and_then(|f| f.sync_all()).map_err(unknown)?;
    File::open(dir).and_then(|f| f.sync_all()).map_err(unknown)
}

fn terminal_record(record: &OperationRecord) -> bool {
    match record.state {
        OperationState::Unpaid | OperationState::FailedPaid | OperationState::Closed => true,
        // H1 records successful admissions as settled, but they remain open
        // until a later slice explicitly closes them. Refused admissions do not.
        OperationState::Settled => !matches!(record.kind.as_str(), "call_offer" | "call_recovery"),
        _ => false,
    }
}

fn expired_terminal(record: &OperationRecord, now: u64) -> bool {
    terminal_record(record) && record.settled_ms.is_some_and(|t| now.saturating_sub(t) > RETENTION_MS)
}

fn reclaim_call_index(dir: &Path, record: &OperationRecord) -> Result<(), ActionError> {
    if !matches!(record.kind.as_str(), "call_offer" | "call_recovery") { return Ok(()); }
    let Some(call) = record.call_id.as_deref() else { return Ok(()) };
    let path = call_index_path(dir, &record.node_id, &record.peer, call);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(damaged_record()),
    };
    let index: CallIndex = serde_json::from_slice(&bytes).map_err(|_| damaged_record())?;
    // A late terminal outcome must not erase a newer admission's mapping.
    if index.op_id == record.op_id {
        std::fs::remove_file(&path).map_err(unknown)?;
    }
    Ok(())
}

// A prior process may have unlinked an index but died before syncing it. Even
// an already-absent entry requires a directory sync before live history goes.
fn sync_call_indexes(dir: &Path) -> Result<(), ActionError> {
    match File::open(dir.join("call-index")) {
        Ok(directory) => directory.sync_all().map_err(unknown),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(unknown(e)),
    }
}

fn archived_operation(dir: &Path, id: &str) -> Result<Option<OperationRecord>, ActionError> {
    use std::io::BufRead;
    let entries = match std::fs::read_dir(dir.join("ops-archive")) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(damaged_record()),
    };
    for entry in entries {
        let path = entry.map_err(|_| damaged_record())?.path();
        if path.extension().is_none_or(|e| e != "jsonl") { continue; }
        let file = File::open(path).map_err(|_| damaged_record())?;
        for line in std::io::BufReader::new(file).lines() {
            let line = line.map_err(|_| damaged_record())?;
            let record: OperationRecord = serde_json::from_str(&line).map_err(|_| damaged_record())?;
            if record.op_id == id { return Ok(Some(record)); }
        }
    }
    Ok(None)
}

/// Append an immutable JSONL segment, never rewrite an existing archive. A
/// bounded segment makes the append atomic without copying a growing monthly
/// file or risking a torn trailing line. Only typed, secret-free ledger fields
/// are serialized. The caller holds history.lock until live files are removed.
#[cfg(unix)]
fn archive_records(dir: &Path, records: &[OperationRecord]) -> Result<(), ActionError> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    let archive = dir.join("ops-archive");
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&archive).map_err(unknown)?;
    let path = archive.join(format!("{}-{}.jsonl", timestamp_ms(), new_operation_id()?));
    let next = path.with_extension("next");
    let mut file = OpenOptions::new().write(true).create_new(true)
        .mode(0o600).custom_flags(libc::O_NOFOLLOW).open(&next).map_err(unknown)?;
    for record in records {
        file.write_all(&serde_json::to_vec(record).map_err(unknown)?).map_err(unknown)?;
        file.write_all(b"\n").map_err(unknown)?;
    }
    file.sync_all().map_err(unknown)?;
    std::fs::rename(next, path).map_err(unknown)?;
    File::open(&archive).and_then(|f| f.sync_all()).map_err(unknown)?;
    File::open(dir).and_then(|f| f.sync_all()).map_err(unknown)
}

#[cfg(not(unix))]
fn archive_records(_dir: &Path, _records: &[OperationRecord]) -> Result<(), ActionError> {
    Err(unknown("private spend journal storage is not supported on this platform"))
}

/// Background compaction. Enumeration/initial reads run without money locks.
/// Publish and fsync an append-only archive segment before unlinking live files.
/// A crash can leave duplicates, never a record absent from both stores. A
/// separate lock protects each bounded batch; active journals are skipped.
/// Open, unknown, damaged and pending records stay live. No money path calls this.
pub fn compact_operations(dir: &Path, now: u64) -> Result<usize, ActionError> {
    const BATCH_SIZE: usize = 256;
    let mut candidates = Vec::with_capacity(BATCH_SIZE);
    let mut compacted = 0;
    for entry in history_entries(dir)? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if path.extension().is_none_or(|e| e != "json") { continue; }
        let id = path.file_stem().and_then(|s| s.to_str());
        let Ok(Some(record)) = read_operation(&path, id) else { continue };
        if !expired_terminal(&record, now) { continue; }
        candidates.push(path);
        if candidates.len() == BATCH_SIZE {
            compacted += compact_batch(dir, now, &candidates)?;
            candidates.clear();
        }
    }
    compacted += compact_batch(dir, now, &candidates)?;
    Ok(compacted)
}

fn compact_batch(dir: &Path, now: u64, candidates: &[PathBuf]) -> Result<usize, ActionError> {
    if candidates.is_empty() { return Ok(0); }
    let lock = history_lock(dir)?;
    if lock.try_lock().is_err() { return Ok(0); }
    let result = (|| {
        let pending = read_pending(dir)?;
        let mut records = Vec::new();
        for path in candidates {
            let id = path.file_stem().and_then(|s| s.to_str());
            let Some(record) = read_operation(path, id)? else { continue };
            if !expired_terminal(&record, now) { continue; }
            if pending.as_ref().is_some_and(|p| p.operation_id.as_deref() == Some(record.op_id.as_str())
                || p.operation_record.as_ref().and_then(|r| r.parent_op.as_deref()) == Some(record.op_id.as_str())) { continue; }
            records.push(record);
        }
        if records.is_empty() { return Ok(0); }
        archive_records(dir, &records)?;
        // Reclaim and sync indexes first, so a crash cannot strand an index
        // without a live candidate for the next sweep. Sync once per batch.
        for record in &records { reclaim_call_index(dir, record)?; }
        sync_call_indexes(dir)?;
        for record in &records {
            std::fs::remove_file(dir.join("ops").join(format!("{}.json", record.op_id))).map_err(unknown)?;
        }
        File::open(dir.join("ops")).and_then(|f| f.sync_all()).map_err(unknown)?;
        Ok(records.len())
    })();
    let _ = lock.unlock();
    result
}

fn fresh_id() -> Result<String, ActionError> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(unknown)?;
    Ok(hex::encode(bytes))
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

    fn history_fixture(dir: &Path, id: usize, state: OperationState, kind: &str) -> OperationRecord {
        let record = OperationRecord {
            op_id: format!("00000000-0000-4000-8000-{id:012x}"), node_id: "node".into(),
            kind: kind.into(), peer: "peer".into(), call_id: Some("0123456789abcdef0123456789abcdef".into()),
            parent_op: None, request_hash: "hash".into(), cap_msat: 2000, state,
            paid_msat: Some(2000), message_id: None, payment_hash: None,
            created_ms: id as u64, settled_ms: Some(100),
        };
        std::fs::create_dir_all(dir.join("ops")).unwrap();
        std::fs::write(dir.join("ops").join(format!("{}.json", record.op_id)), serde_json::to_vec(&record).unwrap()).unwrap();
        record
    }

    #[test]
    fn ledger_listing_caps_newest_rows_and_counts_damaged_files() {
        let dir = tempfile::tempdir().unwrap();
        for id in 0..125 { history_fixture(dir.path(), id, OperationState::Settled, "message"); }
        std::fs::write(dir.path().join("ops/corrupt.json"), "PRIVATE malformed").unwrap();
        std::fs::create_dir(dir.path().join("ops/unreadable.json")).unwrap();
        std::fs::write(dir.path().join("ops/partial.next"), "partial").unwrap();
        // Even with an active money journal the listing succeeds; it takes no locks.
        let _journal = Journal::open(dir.path()).unwrap();
        let page = list_operations(dir.path(), "node", Some("peer"), usize::MAX).unwrap();
        assert_eq!(page.operations.len(), 100);
        assert_eq!(page.skipped, 2);
        assert!(page.has_more);
        assert!(page.operations[0].op_id.ends_with("00000000007c"));
        assert!(page.operations[99].op_id.ends_with("000000000019"));
        assert!(list_operations(dir.path(), "other", None, 100).unwrap().operations.is_empty());
        assert!(list_operations(dir.path(), "node", Some("other"), 100).unwrap().operations.is_empty());
    }

    #[test]
    fn ledger_retention_keeps_open_unknown_recent_and_pending_records() {
        let dir = tempfile::tempdir().unwrap();
        for (id, state) in [OperationState::Settled, OperationState::Closed, OperationState::FailedPaid,
            OperationState::Unpaid, OperationState::Unknown, OperationState::Dispatching,
            OperationState::Paid, OperationState::PaidUndelivered].into_iter().enumerate() {
            history_fixture(dir.path(), id, state, "message");
        }
        history_fixture(dir.path(), 8, OperationState::Settled, "call_offer");
        history_fixture(dir.path(), 9, OperationState::Settled, "call_recovery");
        let recent = history_fixture(dir.path(), 10, OperationState::Settled, "message");
        let mut recent = recent;
        recent.settled_ms = Some(RETENTION_MS);
        std::fs::write(dir.path().join(format!("ops/{}.json", recent.op_id)), serde_json::to_vec(&recent).unwrap()).unwrap();
        std::fs::write(dir.path().join("ops/corrupt.json"), "PRIVATE malformed").unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        let body = json!({"recipient":"peer", "kind":1, "plaintext":"secret"});
        let id = new_operation_id().unwrap();
        let mut pending = journal.begin_operation("node", "/messages/compose", &body, 2000,
            Some((id.clone(), operation(&body)))).unwrap();
        journal.record_outcome(&pending, OperationState::Unpaid, None).unwrap();
        pending.resumable = true;
        journal.save(&pending).unwrap();
        let mut old = journal.operation_record(&id).unwrap().unwrap();
        old.settled_ms = Some(100);
        journal.write_operation(&old).unwrap();
        assert_eq!(compact_operations(dir.path(), RETENTION_MS + 101).unwrap(), 0, "active journal is never disturbed");
        drop(journal);
        assert_eq!(compact_operations(dir.path(), RETENTION_MS + 101).unwrap(), 4);
        let page = list_operations(dir.path(), "node", None, 100).unwrap();
        assert_eq!(page.operations.len(), 8);
        assert_eq!(page.skipped, 1);
        assert!(dir.path().join(format!("ops/{id}.json")).exists(), "resumable pending survives");
        assert_eq!(compact_operations(dir.path(), RETENTION_MS + 101).unwrap(), 0);
        let journal = Journal::open(dir.path()).unwrap();
        for id in 0..4 {
            let id = format!("00000000-0000-4000-8000-{id:012x}");
            let archived = journal.operation_record(&id).unwrap().expect("terminal history is never deleted");
            assert_eq!(archived.cap_msat, 2000);
            assert_eq!(archived.settled_ms, Some(100));
            assert!(!dir.path().join(format!("ops/{id}.json")).exists());
        }
    }

    #[test]
    fn ledger_retention_compacts_ten_thousand_refused_admissions_and_their_indexes() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("call-index")).unwrap();
        for id in 0..10_000 {
            let mut record = history_fixture(dir.path(), id, if id % 2 == 0 {
                OperationState::Unpaid
            } else { OperationState::FailedPaid }, if id % 3 == 0 { "call_recovery" } else { "call_offer" });
            record.call_id = Some(format!("{id:032x}"));
            std::fs::write(dir.path().join(format!("ops/{}.json", record.op_id)), serde_json::to_vec(&record).unwrap()).unwrap();
            // Model indexes created at dispatch, before the terminal outcome.
            std::fs::write(call_index_path(dir.path(), "node", "peer", record.call_id.as_deref().unwrap()),
                serde_json::to_vec(&CallIndex { op_id: record.op_id, created_ms: record.created_ms }).unwrap()).unwrap();
        }
        assert_eq!(compact_operations(dir.path(), RETENTION_MS + 101).unwrap(), 10_000);
        assert_eq!(std::fs::read_dir(dir.path().join("ops")).unwrap().count(), 0);
        assert_eq!(std::fs::read_dir(dir.path().join("call-index")).unwrap().count(), 0);
        let segments: Vec<_> = std::fs::read_dir(dir.path().join("ops-archive")).unwrap()
            .map(|entry| entry.unwrap().path()).collect();
        assert!(segments.len() <= 40, "archive batches avoid one file per refusal");
        assert_eq!(segments.iter().map(|path| std::fs::read_to_string(path).unwrap().lines().count()).sum::<usize>(), 10_000);
        let journal = Journal::open(dir.path()).unwrap();
        for id in [0, 5000, 9999] {
            assert!(journal.operation_record(&format!("00000000-0000-4000-8000-{id:012x}")).unwrap().is_some());
        }
    }

    #[test]
    fn ledger_fresh_dispatch_and_pending_repair_do_not_scan_archives() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("ops-archive")).unwrap();
        std::fs::write(dir.path().join("ops-archive/unrelated.jsonl"), "PRIVATE corrupt archive").unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        let body = json!({"recipient":"peer", "kind":1, "plaintext":"secret"});
        let id = new_operation_id().unwrap();
        let p = journal.begin_operation("node", "/messages/compose", &body, 2000,
            Some((id.clone(), operation(&body)))).expect("fresh dispatch never scans archives");
        std::fs::remove_file(dir.path().join(format!("ops/{id}.json"))).unwrap();
        assert_eq!(journal.pending().unwrap().unwrap().operation_id, p.operation_id);
        assert_eq!(journal.operation_record(&id).unwrap().unwrap().state, OperationState::Dispatching);
    }

    #[test]
    fn ledger_archive_failure_keeps_live_history() {
        let dir = tempfile::tempdir().unwrap();
        let record = history_fixture(dir.path(), 1, OperationState::Settled, "message");
        // Publishing the archive fails before any live-file removal.
        std::fs::write(dir.path().join("ops-archive"), "not a directory").unwrap();
        assert!(compact_operations(dir.path(), RETENTION_MS + 101).is_err());
        let journal = Journal::open(dir.path()).unwrap();
        assert_eq!(journal.operation_record(&record.op_id).unwrap().unwrap().state, OperationState::Settled);
        assert!(dir.path().join(format!("ops/{}.json", record.op_id)).exists());
    }

    #[test]
    fn ledger_archive_publish_crash_preserves_history_and_retry_is_safe() {
        const CHILD_DIR: &str = "BITSOV_TEST_ARCHIVE_CRASH_DIR";
        if let Some(dir) = std::env::var_os(CHILD_DIR) {
            let dir = PathBuf::from(dir);
            let record = read_operation(&dir.join("ops/00000000-0000-4000-8000-000000000001.json"), None).unwrap().unwrap();
            let _lock = Journal::open(&dir).unwrap();
            archive_records(&dir, &[record]).unwrap();
            // Process death exactly after durable archive publication, before
            // any live-file unlink; no destructors or explicit lock release.
            std::process::exit(73);
        }
        let dir = tempfile::tempdir().unwrap();
        let record = history_fixture(dir.path(), 1, OperationState::Closed, "call_recovery");
        let path = dir.path().join(format!("ops/{}.json", record.op_id));
        let mut raw = serde_json::to_value(&record).unwrap();
        for key in ["invoice", "preimage", "token"] { raw[key] = json!("PRIVATE"); }
        std::fs::write(&path, serde_json::to_vec(&raw).unwrap()).unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "spend_journal::tests::ledger_archive_publish_crash_preserves_history_and_retry_is_safe"])
            .env(CHILD_DIR, dir.path()).status().unwrap();
        assert_eq!(status.code(), Some(73));
        assert!(path.exists(), "crash leaves both copies");
        let archived = archived_operation(dir.path(), &record.op_id).unwrap().unwrap();
        assert_eq!(serde_json::to_value(&archived).unwrap(), serde_json::to_value(&record).unwrap());
        let archive = std::fs::read_dir(dir.path().join("ops-archive")).unwrap().next().unwrap().unwrap().path();
        let original = std::fs::read(&archive).unwrap();
        assert!(!String::from_utf8_lossy(&original).contains("PRIVATE"));
        assert_eq!(original.last(), Some(&b'\n'));
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&archive).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // A crash before publication leaves only an ignored incomplete .next.
        std::fs::write(dir.path().join("ops-archive/interrupted.next"), "{partial").unwrap();
        assert_eq!(compact_operations(dir.path(), RETENTION_MS + 101).unwrap(), 1);
        assert!(!path.exists());
        assert_eq!(std::fs::read(archive).unwrap(), original, "archive segments are append-only");
        let journal = Journal::open(dir.path()).unwrap();
        assert_eq!(serde_json::to_value(journal.operation_record(&record.op_id).unwrap().unwrap()).unwrap(),
            serde_json::to_value(&record).unwrap());
    }

    #[test]
    fn ledger_terminal_admission_reclaims_only_its_own_index() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        let mut older = history_fixture(dir.path(), 1, OperationState::Dispatching, "call_offer");
        journal.write_operation(&older).unwrap();
        let call = older.call_id.clone().unwrap();
        older.state = OperationState::Unpaid;
        journal.write_operation(&older).unwrap();
        assert_eq!(journal.call_parent("node", "peer", &call).unwrap(), None);
        let mut newer = history_fixture(dir.path(), 2, OperationState::PaidUndelivered, "call_recovery");
        journal.write_operation(&newer).unwrap();
        journal.write_operation(&older).unwrap();
        assert_eq!(journal.call_parent("node", "peer", &call).unwrap(), Some(newer.op_id.clone()));
        newer.state = OperationState::FailedPaid;
        journal.write_operation(&newer).unwrap();
        assert_eq!(journal.call_parent("node", "peer", &call).unwrap(), None);
        drop(journal);
        initialize_history(dir.path()).unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        assert_eq!(journal.call_parent("node", "peer", &call).unwrap(), None, "migration never resurrects a terminal admission index");
    }

    #[test]
    fn ledger_migration_keeps_an_unrelated_damaged_index_local_to_its_call() {
        let dir = tempfile::tempdir().unwrap();
        let record = history_fixture(dir.path(), 1, OperationState::Settled, "call_offer");
        let call = record.call_id.as_deref().unwrap();
        let index = call_index_path(dir.path(), "node", "peer", call);
        std::fs::create_dir_all(index.parent().unwrap()).unwrap();
        std::fs::write(&index, "PRIVATE broken index").unwrap();
        initialize_history(dir.path()).unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        assert!(journal.call_parent("node", "peer", call).is_err());
        assert_eq!(journal.call_parent("node", "other", call).unwrap(), None);
        let body = json!({"recipient":"other", "kind":1, "plaintext":"secret"});
        assert!(journal.begin_operation("node", "/messages/compose", &body, 2000,
            Some((new_operation_id().unwrap(), operation(&body)))).is_ok());
    }

    #[test]
    fn ledger_migrates_call_index_once_and_repairs_interrupted_index_write() {
        let dir = tempfile::tempdir().unwrap();
        let older = history_fixture(dir.path(), 1, OperationState::Settled, "call_offer");
        let newer = history_fixture(dir.path(), 2, OperationState::Settled, "call_recovery");
        std::fs::write(dir.path().join("ops/corrupt.json"), "broken").unwrap();
        initialize_history(dir.path()).unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        let call = newer.call_id.as_deref().unwrap();
        assert_eq!(journal.call_parent("node", "peer", call).unwrap(), Some(newer.op_id));
        assert_eq!(journal.call_parent("other", "peer", call).unwrap(), None);
        assert_eq!(journal.call_parent("node", "other", call).unwrap(), None);
        // Late evidence for an old operation must not replace the latest index.
        journal.write_operation(&older).unwrap();
        assert_ne!(journal.call_parent("node", "peer", call).unwrap(), Some(older.op_id));
        let body = json!({"recipient":"peer", "kind":400, "plaintext":r#"{"call_id":"1123456789abcdef0123456789abcdef"}"#});
        let p = journal.begin_operation("node", "/messages/compose", &body, 2000,
            Some((new_operation_id().unwrap(), operation(&body)))).unwrap();
        let call = "1123456789abcdef0123456789abcdef";
        std::fs::remove_file(call_index_path(dir.path(), "node", "peer", call)).unwrap();
        drop(journal);
        let journal = Journal::open(dir.path()).unwrap();
        journal.pending().unwrap();
        assert_eq!(journal.call_parent("node", "peer", call).unwrap(), p.operation_id);
    }

    #[cfg(unix)]
    #[test]
    fn ledger_parent_lookup_does_not_enumerate_history() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        let body = json!({"recipient":"peer", "kind":400, "plaintext":r#"{"call_id":"0123456789abcdef0123456789abcdef"}"#});
        let parent = journal.begin_operation("node", "/messages/compose", &body, 2000,
            Some((new_operation_id().unwrap(), operation(&body)))).unwrap();
        journal.record_outcome(&parent, OperationState::Settled, None).unwrap();
        journal.clear().unwrap();
        let ops = dir.path().join("ops");
        // Write/search permissions permit named files; read_dir is forbidden.
        std::fs::set_permissions(&ops, std::fs::Permissions::from_mode(0o300)).unwrap();
        let result = journal.call_parent("node", "peer", "0123456789abcdef0123456789abcdef");
        std::fs::set_permissions(&ops, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(result.unwrap(), parent.operation_id);
    }

    #[test]
    fn ledger_survives_slot_clear_and_restart_without_plaintext() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        let body = json!({"recipient": "peer", "kind": 400,
            "plaintext": r#"{"call_id":"0123456789abcdef0123456789abcdef","sdp":"PRIVATE"}"#});
        let id = new_operation_id().unwrap();
        let p = journal.begin_operation("node", "/messages/compose", &body, 2000,
            Some((id.clone(), operation(&body)))).unwrap();
        let file = dir.path().join("ops").join(format!("{id}.json"));
        assert!(file.exists(), "operation must exist before dispatch");
        let record: serde_json::Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!(record["state"], "dispatching");
        assert_eq!(record["call_id"], "0123456789abcdef0123456789abcdef");
        assert_eq!(record["kind"], "call_offer");
        assert!(!record.to_string().contains("PRIVATE"));
        drop(journal);
        let journal = Journal::open(dir.path()).unwrap();
        assert_eq!(journal.pending().unwrap().unwrap().operation_id, p.operation_id);
        journal.clear().unwrap();
        assert!(file.exists(), "clearing the single slot must never delete history");
    }

    #[test]
    fn ledger_recovers_interrupted_initial_write_and_ignores_partial_next_file() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        let body = json!({"recipient": "peer", "kind": 1, "plaintext": "PRIVATE"});
        let id = new_operation_id().unwrap();
        journal.begin_operation("node", "/messages/compose", &body, 2000,
            Some((id.clone(), operation(&body)))).unwrap();
        // Reproduce the on-disk boundary after the first slot rename but before
        // the first operation rename; only the complete pending snapshot exists.
        std::fs::remove_file(dir.path().join("ops").join(format!("{id}.json"))).unwrap();
        assert!(read_pending(dir.path()).unwrap().is_some());
        drop(journal);
        let journal = Journal::open(dir.path()).unwrap();
        journal.pending().unwrap().unwrap();
        let initial = journal.operation_record(&id).unwrap().unwrap();
        assert_eq!(initial.state, OperationState::Dispatching);
        assert_eq!(initial.kind, "message");
        std::fs::write(dir.path().join("ops").join(format!("{id}.next")), "{broken").unwrap();
        drop(journal);
        let journal = Journal::open(dir.path()).unwrap();
        assert_eq!(list_operations(dir.path(), "node", None, 100).unwrap().operations.len(), 1);
        assert_eq!(journal.operation_record(&id).unwrap().unwrap().state, OperationState::Dispatching);
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(dir.path().join("ops").join(format!("{id}.json"))).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn ledger_reuses_identity_and_retains_replaced_unpaid_records() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        let body = json!({"recipient": "peer", "kind": 1, "plaintext": "PRIVATE"});
        let id = new_operation_id().unwrap();
        let mut first = journal.begin_operation("node", "/messages/compose", &body, 2000,
            Some((id.clone(), operation(&body)))).unwrap();
        journal.record_outcome(&first, OperationState::Unpaid, None).unwrap();
        first.resumable = true;
        journal.save(&first).unwrap();
        let created = journal.operation_record(&id).unwrap().unwrap().created_ms;
        let mut resumed = journal.begin_operation("node", "/messages/compose", &body, 3000,
            Some((id.clone(), operation(&body)))).unwrap();
        assert_eq!(list_operations(dir.path(), "node", None, 100).unwrap().operations.len(), 1);
        assert_eq!(journal.operation_record(&id).unwrap().unwrap().created_ms, created);
        journal.record_outcome(&resumed, OperationState::Unpaid, None).unwrap();
        resumed.resumable = true;
        journal.save(&resumed).unwrap();
        journal.begin_operation("node", "/messages/compose", &body, 2000,
            Some((new_operation_id().unwrap(), operation(&body)))).unwrap();
        assert_eq!(list_operations(dir.path(), "node", None, 100).unwrap().operations.len(), 2);
        assert_eq!(journal.operation_record(&id).unwrap().unwrap().state, OperationState::Unpaid);
    }

    #[test]
    fn ledger_never_extracts_chat_content_or_invalid_call_ids_as_metadata() {
        for (kind, payload) in [(1, r#"{"call_id":"PRIVATE CHAT CONTENT"}"#),
            (1, r#"{"call_id":"0123456789abcdef0123456789abcdef"}"#),
            (400, r#"{"call_id":"PRIVATE SIGNAL CONTENT"}"#)] {
            let dir = tempfile::tempdir().unwrap();
            let journal = Journal::open(dir.path()).unwrap();
            let body = json!({"recipient":"peer", "kind":kind, "plaintext":payload});
            let id = new_operation_id().unwrap();
            journal.begin_operation("node", "/messages/compose", &body, 2000,
                Some((id.clone(), operation(&body)))).unwrap();
            let record = journal.operation_record(&id).unwrap().unwrap();
            assert_eq!(record.call_id, None);
            assert!(!serde_json::to_string(&record).unwrap().contains("PRIVATE"));
        }
    }

    #[test]
    fn ledger_repairs_known_pending_evidence_after_interrupted_transition() {
        for undelivered in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let journal = Journal::open(dir.path()).unwrap();
            let body = json!({"recipient":"peer", "kind":1, "plaintext":"secret"});
            let id = new_operation_id().unwrap();
            let mut p = journal.begin_operation("node", "/messages/compose", &body, 2000,
                Some((id.clone(), operation(&body)))).unwrap();
            if undelivered {
                p.undelivered = Some(Undelivered { peer: "peer".into(), paid_msat: 1000, retry: true,
                    op: operation(&body), admission_msat: 1000, in_flight: false, attempts: 0, payment_hash: Some("hash".into()) });
            } else { p.resumable = true; }
            // Crash after the pending snapshot's rename, before the ledger transition.
            std::fs::write(dir.path().join("spend-pending.json"), serde_json::to_vec(&p).unwrap()).unwrap();
            drop(journal);
            let journal = Journal::open(dir.path()).unwrap();
            journal.pending().unwrap();
            let record = journal.operation_record(&id).unwrap().unwrap();
            assert_eq!(record.state, if undelivered { OperationState::PaidUndelivered } else { OperationState::Unpaid });
            assert_eq!(record.paid_msat, Some(if undelivered { 1000 } else { 0 }));
            journal.clear().unwrap();
            assert_eq!(list_operations(dir.path(), "node", None, 100).unwrap().operations.len(), 1);
        }
    }

    #[test]
    fn legacy_identity_is_migrated_once_without_changing_accounting_or_operation() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        let original = journal.begin("node", "/messages/compose", &json!({"plaintext": "secret"}), 14000).unwrap();
        let mut legacy = serde_json::to_value(&original).unwrap();
        legacy.as_object_mut().unwrap().remove("id");
        legacy.as_object_mut().unwrap().remove("rollback_charge_id");
        std::fs::write(dir.path().join("spend-pending.json"), legacy.to_string()).unwrap();
        let migrated = journal.pending().unwrap().unwrap();
        assert!(!migrated.id.is_empty());
        assert_ne!(migrated.id, original.request_hash);
        assert_eq!(migrated.request_hash, original.request_hash);
        assert_eq!(migrated.charge_id(), original.charge_id());
        drop(journal);
        let reopened = Journal::open(dir.path()).unwrap().pending().unwrap().unwrap();
        assert_eq!(reopened.id, migrated.id);
        assert!(!std::fs::read_to_string(dir.path().join("spend-pending.json")).unwrap().contains("secret"));
    }

    #[test]
    fn operation_id_is_durable_before_dispatch_and_survives_restart() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        let body = json!({"recipient": "peer", "is_room": false, "kind": 1, "plaintext": "PRIVATE"});
        let id = new_operation_id().unwrap();
        let begun = journal.begin_operation("node", "/messages/compose", &body, 2000, Some((id.clone(), operation(&body)))).unwrap();
        drop(journal);
        // A crash here, after the POST and before any reply: the id is on disk.
        let reopened = Journal::open(dir.path()).unwrap().pending().unwrap().unwrap();
        assert_eq!(reopened.operation_id.as_deref(), Some(id.as_str()));
        assert_eq!(reopened.op, Some(operation(&body)));
        assert_eq!(reopened.peer.as_deref(), Some("peer"));
        assert_eq!(reopened.id, begun.id);
        assert!(!reopened.resumable);
        assert!(!std::fs::read_to_string(dir.path().join("spend-pending.json")).unwrap().contains("PRIVATE"));
    }

    #[test]
    fn only_a_record_holding_no_payment_may_be_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        let body = json!({"recipient": "peer", "plaintext": "a"});
        let mut first = journal.begin_operation("node", "/messages/compose", &body, 2000, Some((new_operation_id().unwrap(), operation(&body)))).unwrap();
        assert!(journal.begin("node", "/payments/pay", &json!({}), 1000).is_err(), "unknown outcome fences");
        first.resumable = true;
        journal.save(&first).unwrap();
        let next = journal.begin("node", "/payments/pay", &json!({}), 1000).unwrap();
        assert_eq!(next.operation_id, None);
        assert_ne!(next.id, first.id);
    }

    #[test]
    fn operation_ids_are_fresh_uuid_v4() {
        let a = new_operation_id().unwrap();
        let b = new_operation_id().unwrap();
        assert_ne!(a, b);
        for id in [a, b] {
            assert_eq!(id.len(), 36);
            assert_eq!(&id[14..15], "4");
            assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"), "{id}");
        }
    }

    #[test]
    fn unknown_operation_states_fail_closed() {
        assert_eq!(outcome("acked"), Outcome::Accepted);
        assert_eq!(outcome("sent"), Outcome::Sent);
        assert_eq!(outcome("paid"), Outcome::Paid);
        assert_eq!(outcome("rejected_retryable"), Outcome::Paid);
        assert_eq!(outcome("prepared"), Outcome::NothingPaid);
        assert_eq!(outcome("released"), Outcome::NothingPaid);
        assert_eq!(outcome("failed_paid"), Outcome::FailedPaid);
        for s in ["paying", "payment_unknown", "stalled", "", "ACKED"] {
            assert_eq!(outcome(s), Outcome::PaymentUnknown, "{s}");
        }
    }

    #[test]
    fn pre_operation_journals_still_read() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("spend-pending.json"), r#"{"id":"x","node_id":"n","request_hash":"h","max_msat":1,"target":null,"over_budget":false,
            "undelivered":{"peer":"p","paid_msat":1,"retry":true}}"#).unwrap();
        let p = Journal::open(dir.path()).unwrap().pending().unwrap().unwrap();
        assert_eq!((p.operation_id, p.op, p.resumable), (None, None, false));
        assert_eq!(p.undelivered.unwrap().payment_hash, None);
    }

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
        let p = Pending { id: "attempt".into(), rollback_charge_id: None, node_id:"node".into(), request_hash:"hash".into(), max_msat:2000,
            target:Some(Target::Payment { hash:"abc".into() }), over_budget:false, accounting_msat: None, paid: None, undelivered: None, charge_id: None, budgeted: false, all_in: false, operation_id: None, op: None, peer: None, resumable: false, operation_record: None };
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
        let p = Pending { id: "attempt".into(), rollback_charge_id: None, node_id:"node".into(), request_hash:"hash".into(), max_msat:2000,
            target:Some(Target::Message { id:"abc".into(), peer:"peer".into() }), over_budget:false, accounting_msat: None, paid: None, undelivered: None, charge_id: None, budgeted: false, all_in: false, operation_id: None, op: None, peer: None, resumable: false, operation_record: None };
        let mut row = json!({"id":"abc", "sender":"other", "recipient":"peer", "payment_amount_msat":2000});
        assert_eq!(terminal(&p, &[row.clone()]), None);
        row["sender"] = json!("node");
        assert_eq!(terminal(&p, &[row.clone()]), Some("settled"));
        row["recipient"] = json!("other");
        assert_eq!(terminal(&p, &[row]), None);
    }
}
