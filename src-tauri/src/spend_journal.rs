//! Durable ambiguity fence, not a payment authority. On a node with
//! `message_operations_v1` a 1:1 send also carries the node's idempotency key
//! (`operation_id`), written here before the first POST and reused by every
//! retry of that send. A lost reply without it remains unknown. Absence from a
//! paged history is never proof that a payment did not happen.
//!
//! Call parents use a durable identity/peer/call index, repaired from pending
//! snapshots and imported once from pre-index H1 records before authentication.
//! The read-only listing returns at most 100 newest rows plus skipped/has_more.
//! Operation records stay as per-op files and are never deleted.
//! TODO: Bounded storage belongs in a separate PR.

use std::fs::File;
#[cfg(unix)]
use std::fs::OpenOptions;
#[cfg(unix)]
use std::io::Write;
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use crate::act::{ActionError, OperationContext::Active};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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
    /// Partial payment evidence is accounted, but the operation is unresolved.
    /// Keep its original bound while checking for later message settlement;
    /// accounting, dismissal and delivery retry must not release this fence.
    #[serde(default)]
    pub evidence_reservation_msat: Option<u64>,
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
    /// `GET /messages/operations/{id}`. A confirmed abandonment clears it so
    /// the next send must mint a fresh id.
    #[serde(default)]
    pub operation_id: Option<String>,
    /// Unix milliseconds, saved immediately before each money POST. Older
    /// records start a conservative waiting window on their first reconciliation.
    #[serde(default)]
    pub dispatched_at: Option<u64>,
    /// [`operation`] of the send `operation_id` names.
    #[serde(default)]
    pub op: Option<String>,
    /// Its recipient node, for a paid, undelivered record built on reconcile.
    #[serde(default)]
    pub peer: Option<String>,
    /// No payment evidence, with abandonment confirmed or the legacy grace
    /// window elapsed. A resend reuses `operation_id` only when the node did
    /// not abandon it; otherwise the next send creates a new operation.
    #[serde(default)]
    pub resumable: bool,
    /// This exact POST was refused by the node before any dispatch/payment.
    /// Unlike a legacy grace release, this is durable non-dispatch proof.
    #[serde(default)]
    pub non_dispatch_proven: bool,
    /// Admission-only prepared: only an exact same-id compose may continue.
    /// Unlike `resumable`, this never permits replacing or dismissing the slot.
    #[serde(default)]
    pub admission_resume: bool,
    /// Original compose fee cap, preserving omission for first-contact sends.
    #[serde(default)]
    pub compose_fee_msat: Option<u64>,
    /// The node whose status, read for this very send, showed that a payment it
    /// reports failed is really over (the host's `final_failure_node`). Today's
    /// status cannot say what wrote a row, so a later `released` proves this
    /// payment failed only with this set. Older records have none: they stay fenced.
    #[serde(default)]
    pub failure_final_on: Option<String>,
    /// Initial ledger snapshot repairs a crash between the two atomic files.
    #[serde(default)]
    pub operation_record: Option<OperationRecord>,
    /// A direct payment's idempotency key and the exact request it names,
    /// saved before the first POST. Recovery repeats that request unchanged:
    /// the node answers from its record and never pays one key twice.
    #[serde(default)]
    pub direct: Option<DirectRequest>,
    /// Saved by a cleanup that has proven this attempt unpaid, just before it
    /// releases the attempt's reservation. If that release, or the clear after
    /// it, then fails, reconciliation carries out exactly this decision: it
    /// asks no node and decides nothing itself. Written only in that case.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unpaid_release: Option<UnpaidRelease>,
}

/// A cleanup's saved decision: release the reservation, record the outcome,
/// then put back `restore` (the record from before the attempt) or clear.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UnpaidRelease {
    pub outcome: OperationState,
    #[serde(default)]
    pub restore: Option<Box<Pending>>,
}

/// `POST /payments/pay` or `/payments/keysend` under a client `request_id`
/// (node capability `direct_payment_operations_v1`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DirectRequest {
    pub request_id: String,
    pub path: String,
    /// The body as sent, `request_id` included: the node binds the key to it.
    pub body: serde_json::Value,
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
pub enum OperationState { Dispatching, AdmissionResumable, Paid, Unpaid, PaidUndelivered, FailedPaid, Unknown, Settled, Closed }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub hangup_cap_msat: Option<u64>,
    /// Call lifecycle is independent of its payment outcome. Reconciliation
    /// must never reopen an admission that the host already observed ending.
    #[serde(default)]
    pub call_closed: bool,
    #[serde(default)]
    pub call_answered: bool,
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
    /// `prepared` / `released`: candidate only; the caller must check payment
    /// evidence and confirm abandonment or wait out the legacy grace window.
    /// A payment the wallet failed for good has its own proof, in the host's
    /// `reports_failed_payment`.
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
    getrandom::fill(&mut b).map_err(unknown)?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex::encode(b);
    Ok(format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..]))
}

pub fn unknown(detail: impl std::fmt::Display) -> ActionError {
    ActionError::new("spend_unknown", format!("Outcome unknown; another spend is blocked until reconciled. {detail}"))
}

/// Read the atomic journal snapshot for accounting evidence. Spending and
/// reconciliation still require the Journal's exclusive OS lock.
pub fn read_pending(dir: &Path) -> Result<Option<Pending>, ActionError> {
    match read_file(dir, &dir.join("spend-pending.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(unknown),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && absent(&dir.join("spend-pending.json")) => Ok(None),
        Err(e) => Err(unknown(e)),
    }
}

/// The OS lock also serializes two app processes. A crash releases the lock,
/// but leaves the pending record. No approval, token, invoice or plaintext is saved.
pub struct Journal {
    _lock: LockFile,
    // Serialize call-index updates with the one-time history migration.
    _history_lock: LockFile,
    dir: PathBuf,
}

impl Drop for Journal {
    fn drop(&mut self) {
        // Closing alone leaves flock held when a subprocess inherited the fd.
        let _ = lock_handle(&self._history_lock).unlock();
        let _ = lock_handle(&self._lock).unlock();
    }
}

/// A lock file. On Windows it stays the verified private handle it was opened as.
#[cfg(not(windows))]
type LockFile = File;
#[cfg(windows)]
type LockFile = bitsov_ffi::win_private::VerifiedFile;

#[cfg(not(windows))]
fn lock_handle(lock: &LockFile) -> &File { lock }
#[cfg(windows)]
fn lock_handle(lock: &LockFile) -> &File { lock.as_file() }

impl Journal {
    #[cfg(not(any(unix, windows)))]
    pub fn open(_dir: &Path) -> Result<Self, ActionError> {
        Err(unknown("private spend journal storage is not supported on this platform"))
    }

    /// Windows: the folder and both lock files are verified private objects
    /// (owner-only, protected access list, no link or reparse point). The
    /// spend lock is taken without waiting, then the history lock, and both
    /// are held until the journal is dropped. Lock files are never replaced.
    #[cfg(windows)]
    pub fn open(dir: &Path) -> Result<Self, ActionError> {
        crate::private_fs::ensure_dir(dir).map_err(|_| storage_refused())?;
        let lock = crate::private_fs::open_lock(&dir.join("spend.lock")).map_err(|_| storage_refused())?;
        lock.as_file().try_lock().map_err(|_| unknown("An action is still running."))?;
        let history_lock = history_lock(dir)?;
        history_lock.as_file().lock().map_err(unknown)?;
        Ok(Self { _lock: lock, _history_lock: history_lock, dir: dir.to_path_buf() })
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
        let repair = logical_write(|| {
            if let Some(p) = pending.as_mut().filter(|p| p.id.is_empty()) {
                // Migrate under the journal lock before exposing a dismissal identity.
                p.id = fresh_id()?;
                self.save(p)?;
            }
            if let Some(p) = &pending { self.ensure_operation(p)?; }
            Ok(())
        });
        // The snapshot already names the dispatched operation, even when its
        // ledger/index cannot be read or repaired. Preserve it on every failure.
        crate::act::with_op(Active(operation_id.as_deref()), repair)?;
        Ok(pending)
    }

    pub fn begin(&self, node_id: &str, path: &str, body: &serde_json::Value, max_msat: u64) -> Result<Pending, ActionError> {
        self.begin_operation(node_id, path, body, max_msat, None)
    }

    /// `operation`: the node idempotency key and its fingerprint, durable
    /// before the caller posts. Only a record that holds no payment
    /// ([`Pending::resumable`]) may be replaced.
    pub fn begin_operation(&self, node_id: &str, path: &str, body: &serde_json::Value, max_msat: u64, operation: Option<(String, String)>) -> Result<Pending, ActionError> {
        let operation_id = operation.as_ref().map(|(id, _)| id.clone());
        logical_write(|| crate::act::with_op(Active(operation_id.as_deref()), (|| {
        if self.pending()?.is_some_and(|p| !p.resumable) { return Err(unknown("Check the previous action first.")); }
        let (operation_id, op) = operation.map_or((None, None), |(id, op)| (Some(id), Some(op)));
        let mut pending = Pending {
            id: fresh_id()?, rollback_charge_id: None,
            node_id: node_id.to_string(),
            request_hash: blake3::hash(format!("{path}\n{body}").as_bytes()).to_hex().to_string(),
            max_msat, target: None, over_budget: false, accounting_msat: None, evidence_reservation_msat: None, paid: None, undelivered: None, charge_id: None, budgeted: false, all_in: false,
            peer: operation_id.as_ref().and(body["recipient"].as_str()).map(str::to_string),
            operation_id, dispatched_at: None, op, resumable: false, non_dispatch_proven: false, admission_resume: false, compose_fee_msat: body["max_routing_fee_msat"].as_u64(), failure_final_on: None, operation_record: None,
            direct: None, unpaid_release: None,
        };
        if let Some(id) = &pending.operation_id {
            let signal_kind = body["kind"].as_u64().unwrap_or(0);
            let payload = if (400..=404).contains(&signal_kind) {
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
                404 => "call_block",
                _ if body["plaintext"].as_str().is_some_and(crate::act::is_room_chat) => "room_leg",
                _ => "message",
            };
            let parent_call = if signal_kind == 403 { call_id.as_deref() } else { recovery };
            let parent_op = if let Some(call) = parent_call {
                body["host_admission_op"].as_str().map(str::to_string)
                    .or(self.call_parent(node_id, pending.peer.as_deref().unwrap_or_default(), call)?)
            } else { None };
            let mut record = self.operation_record(id)?.unwrap_or(OperationRecord {
                op_id: id.clone(), node_id: node_id.into(), kind: kind.into(), peer: pending.peer.clone().unwrap_or_default(),
                call_id, parent_op, request_hash: pending.request_hash.clone(), cap_msat: max_msat,
                state: OperationState::Dispatching, paid_msat: None, message_id: None, payment_hash: None,
                created_ms: timestamp_ms(), settled_ms: None, reason: None,
                hangup_cap_msat: body["host_hangup_cap_msat"].as_u64(),
                call_closed: false, call_answered: false,
            });
            // A released operation may be dispatched again with the same id.
            // Give each call attempt a strictly ordered local generation, even
            // within one clock tick or after the wall clock moves backwards.
            if matches!(record.kind.as_str(), "call_offer" | "call_recovery") {
                let previous = record.call_id.as_deref().map(|call|
                    read_call_admission(&self.dir, node_id, &record.peer, call)).transpose()?.flatten();
                record.created_ms = timestamp_ms().max(previous.map_or(0, |r| r.created_ms.saturating_add(1)));
            }
            record.call_closed = false;
            record.call_answered = false;
            record.state = OperationState::Dispatching;
            record.cap_msat = max_msat;
            record.settled_ms = None;
            pending.operation_record = Some(record);
        }
        self.save(&pending)?;
        if let Some(record) = &pending.operation_record { self.write_operation(record)?; }
        Ok(pending)
        })()))
    }

    #[cfg(not(any(unix, windows)))]
    pub fn save(&self, _pending: &Pending) -> Result<(), ActionError> {
        Err(unknown("private spend journal storage is not supported on this platform"))
    }

    /// Windows: new private scratch, flush, read back and check, publish by
    /// handle, flush the folder. Success only when every step succeeded.
    #[cfg(windows)]
    pub fn save(&self, pending: &Pending) -> Result<(), ActionError> {
        save_pending_in(&WinStore, &self.dir, pending, || self.ensure_operation(pending))
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

    #[cfg(not(windows))]
    pub fn clear(&self) -> Result<(), ActionError> {
        std::fs::remove_file(self.dir.join("spend-pending.json")).map_err(unknown)?;
        self.sync_dir()
    }

    /// Windows: delete the verified record by handle, then flush the folder.
    #[cfg(windows)]
    pub fn clear(&self) -> Result<(), ActionError> {
        remove_durably(&self.dir.join("spend-pending.json"))
    }

    fn operation_path(&self, id: &str) -> Result<PathBuf, ActionError> {
        // IDs are host minted. Reject unsafe legacy/corrupt journal paths as well.
        if id.len() != 36 || !id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-') {
            return Err(unknown("Invalid operation id in the spend journal."));
        }
        Ok(self.dir.join("ops").join(format!("{id}.json")))
    }

    pub fn operation_record(&self, id: &str) -> Result<Option<OperationRecord>, ActionError> {
        read_operation(&self.dir, &self.operation_path(id)?, Some(id))
    }

    fn call_parent(&self, node_id: &str, peer: &str, call: &str) -> Result<Option<String>, ActionError> {
        Ok(read_call_admission(&self.dir, node_id, peer, call)?.map(|r| r.op_id))
    }

    /// Update exactly the captured admission; never resolve a reused call id
    /// again after waiting for the money lock. This does not settle payment.
    pub fn observe_call(&self, offer: &OperationRecord, ended: bool) -> Result<(), ActionError> {
        logical_write(|| self.observe_call_once(offer, ended))
    }

    fn observe_call_once(&self, offer: &OperationRecord, ended: bool) -> Result<(), ActionError> {
        let mut record = self.operation_record(&offer.op_id)?.ok_or_else(damaged_record)?;
        if record.node_id != offer.node_id || record.peer != offer.peer || record.call_id != offer.call_id
            || !matches!(record.kind.as_str(), "call_offer" | "call_recovery") {
            return Err(damaged_record());
        }
        // The same operation id can name a later, explicitly unpaid resend.
        if record.created_ms != offer.created_ms { return Ok(()); }
        if ended { record.call_closed = true; } else { record.call_answered = true; }
        self.write_operation(&record)
    }

    /// Owner-requested repair. Acknowledging damage never releases an admission
    /// or payment. Only the exact indexed record (or its durable pending snapshot)
    /// can restore membership; corrupt mappings are never guessed from history.
    pub fn repair_call_index(&self, node_id: &str, index_id: &str) -> Result<Option<String>, ActionError> {
        logical_write(|| self.repair_call_index_once(node_id, index_id))
    }

    fn repair_call_index_once(&self, node_id: &str, index_id: &str) -> Result<Option<String>, ActionError> {
        if index_id.len() != 64 || !index_id.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()) {
            return Err(ActionError::invalid("invalid call index id"));
        }
        let filename = format!("{index_id}.json");
        let path = self.dir.join("call-index").join(&filename);
        if !present(&self.dir, &path)? && !present(&self.dir, &self.dir.join("call-index-unresolved").join(&filename))? {
            return Err(damaged_record());
        }
        let index = read_file(&self.dir, &path).ok().and_then(|b| serde_json::from_slice::<CallIndex>(&b).ok());
        if let Some(index) = index {
            let record = self.operation_record(&index.op_id).ok().flatten().or_else(|| {
                // Reading the raw slot avoids automatic repair of damaged files.
                read_pending(&self.dir).ok().flatten().filter(|p|
                    p.operation_id.as_deref() == Some(index.op_id.as_str()))
                    .and_then(|p| p.operation_record.filter(|r| r.node_id == p.node_id))
            });
            if let Some(record) = record.filter(|r| r.op_id == index.op_id
                && r.created_ms == index.created_ms && matches!(r.kind.as_str(), "call_offer" | "call_recovery")
                && r.call_id.as_deref().is_some_and(|call|
                    call_index_path(&self.dir, &r.node_id, &r.peer, call) == path)) {
                if record.node_id != node_id {
                    return Err(ActionError::new("call_identity_changed", "This call record belongs to another node identity. Nothing was acknowledged or paid."));
                }
                let marker = self.dir.join("call-index-unresolved").join(&filename);
                create_marker(&self.dir, &marker)?;
                self.write_operation(&record)?;
                // Keep the owner-visible repair entry across restart until
                // actual closure evidence exists. Repair is not closure.
                let records = self.call_operations_for(node_id, Some(&record.peer), record.call_id.as_deref())?;
                let ambiguous_unpaid = record.state == OperationState::Unpaid && read_pending(&self.dir)?
                    .is_some_and(|p| p.operation_id.as_deref() == Some(record.op_id.as_str()) && !p.non_dispatch_proven);
                if !admission_open(&record, &records) && !ambiguous_unpaid {
                    remove_durably(&marker)?;
                }
                return Ok(record.call_id);
            }
        }
        let ack = self.dir.join("call-index-acknowledged").join(blake3::hash(node_id.as_bytes()).to_hex().as_str());
        create_marker(&self.dir, &ack.join(filename))?;
        Ok(None)
    }

    /// Call-only index, scoped to the authenticated node and optionally peer.
    /// Never use the capped/read-only op_list as an admission authority.
    pub fn call_operations(&self, node_id: &str, peer: Option<&str>) -> Result<Vec<OperationRecord>, ActionError> {
        self.call_operations_for(node_id, peer, None)
    }

    pub fn call_operations_for(&self, node_id: &str, peer: Option<&str>, call: Option<&str>) -> Result<Vec<OperationRecord>, ActionError> {
        logical_write(|| self.call_operations_once(node_id, peer, call))
    }

    fn call_operations_once(&self, node_id: &str, peer: Option<&str>, call: Option<&str>) -> Result<Vec<OperationRecord>, ActionError> {
        // An H1 index may outlive its damaged offer. Its hashed key cannot tell
        // us the peer, so preserve the evidence and fail closed for calls only.
        for entry in read_entries(&self.dir, &self.dir.join("call-index-unresolved"))? {
            let bytes = read_file(&self.dir, &self.dir.join("call-index").join(entry.file_name())).map_err(|_| damaged_record())?;
            let index: CallIndex = serde_json::from_slice(&bytes).map_err(|_| damaged_record())?;
            let record = crate::act::with_op(Active(Some(&index.op_id)),
                self.operation_record(&index.op_id).and_then(|r| r.ok_or_else(damaged_record)))?;
            let valid = record.call_id.as_deref().is_some_and(|call|
                call_index_path(&self.dir, &record.node_id, &record.peer, call).file_name() == Some(entry.file_name().as_os_str()))
                && matches!(record.kind.as_str(), "call_offer" | "call_recovery");
            if !valid { return crate::act::with_op(Active(Some(&index.op_id)), Err(damaged_record())); }
            write_call_membership(&self.dir, &record)?;
        }
        let root = call_membership_root(&self.dir, node_id);
        let directories = match peer {
            Some(peer) => vec![root.join(blake3::hash(peer.as_bytes()).to_hex().as_str())],
            None => read_entries(&self.dir, &root)?.into_iter().map(|e| e.path()).collect(),
        };
        let mut records = Vec::new();
        for dir in directories {
            let calls = match call {
                Some(call) => vec![dir.join(blake3::hash(call.as_bytes()).to_hex().as_str())],
                None => read_entries(&self.dir, &dir)?.into_iter().map(|e| e.path()).collect(),
            };
            for directory in calls {
                for entry in read_entries(&self.dir, &directory)? {
                    let id = entry.file_name().to_string_lossy().into_owned();
                    let record = crate::act::with_op(Active(Some(&id)), verify_membership(&entry.path())
                        .and_then(|()| self.operation_record(&id)).and_then(|r| r.ok_or_else(damaged_record)))?;
                    if record.node_id != node_id || peer.is_some_and(|p| record.peer != p)
                        || record.call_id.is_none() || call.is_some_and(|c| record.call_id.as_deref() != Some(c)) {
                        return crate::act::with_op(Active(Some(&id)), Err(damaged_record()));
                    }
                    records.push(record);
                }
            }
        }
        Ok(records)
    }

    fn ensure_operation(&self, pending: &Pending) -> Result<(), ActionError> {
        if let Some(id) = &pending.operation_id {
            if self.operation_record(id)?.is_none() {
                // Older pending journals have no kind/call metadata. Do not guess it.
                let record = pending.operation_record.clone().unwrap_or(OperationRecord {
                    op_id: id.clone(), node_id: pending.node_id.clone(), kind: "legacy".into(),
                    peer: pending.peer.clone().unwrap_or_default(), call_id: None, parent_op: None,
                    request_hash: pending.request_hash.clone(), cap_msat: pending.max_msat,
                    state: if pending.resumable { OperationState::Unpaid } else { OperationState::Unknown },
                    paid_msat: pending.undelivered.as_ref().map(|u| u.paid_msat), message_id: None,
                    payment_hash: pending.undelivered.as_ref().and_then(|u| u.payment_hash.clone()),
                    created_ms: timestamp_ms(), settled_ms: None, reason: None, hangup_cap_msat: None, call_closed: false, call_answered: false,
                });
                self.write_operation(&record)?;
            }
            if let Some(mut record) = self.operation_record(id)? {
                if let Some(parent) = &record.parent_op {
                    self.operation_record(parent)?.ok_or_else(damaged_record)?;
                }
                // Also repairs a crash after the operation rename but before its index.
                write_call_index(&self.dir, &record)?;
                write_call_membership(&self.dir, &record)?;
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
                    } else if pending.admission_resume && record.state != OperationState::AdmissionResumable {
                        record.state = OperationState::AdmissionResumable;
                        record.settled_ms = None;
                        changed = true;
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
        write_call_index(&self.dir, record)?;
        write_call_membership(&self.dir, record)
    }

    /// Windows: the record is published before its call index and membership
    /// advertise it, as on Unix; `ops` is created as a private folder.
    #[cfg(windows)]
    fn write_operation(&self, record: &OperationRecord) -> Result<(), ActionError> {
        let path = self.operation_path(&record.op_id)?;
        write_operation_in(&WinStore, &self.dir, &path, record)
    }

    #[cfg(not(any(unix, windows)))]
    fn write_operation(&self, _record: &OperationRecord) -> Result<(), ActionError> {
        Err(unknown("private spend journal storage is not supported on this platform"))
    }

    /// Commit history before releasing/replacing the pending slot. Evidence is
    /// whole-operation principal, never a retry's incremental budget charge.
    pub fn record_outcome(&self, pending: &Pending, state: OperationState, evidence: Option<&serde_json::Value>) -> Result<(), ActionError> {
        logical_write(|| self.record_outcome_once(pending, state, evidence))
    }

    fn record_outcome_once(&self, pending: &Pending, state: OperationState, evidence: Option<&serde_json::Value>) -> Result<(), ActionError> {
        let Some(id) = &pending.operation_id else { return Ok(()) };
        self.ensure_operation(pending)?;
        let mut record = self.operation_record(id)?.ok_or_else(|| unknown("Missing operation record."))?;
        record.state = state;
        if record.state == OperationState::Dispatching { record.cap_msat = pending.max_msat; }
        if let Some(value) = evidence {
            if let Some(reason) = value["reason"].as_str().filter(|r| matches!(*r,
                "call_not_live" | "call_not_found" | "call_id_used" | "call_signal_in_flight")) {
                record.reason = Some(reason.into());
            }
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

    #[cfg(unix)]
    fn sync_dir(&self) -> Result<(), ActionError> {
        #[cfg(unix)] File::open(&self.dir).and_then(|f| f.sync_all()).map_err(unknown)?;
        Ok(())
    }

    /// Never report a folder flush that did not happen.
    #[cfg(not(any(unix, windows)))]
    fn sync_dir(&self) -> Result<(), ActionError> {
        Err(unknown("private spend journal storage is not supported on this platform"))
    }
}

/// Maximum response size; listing is read-only and never takes either money lock.
pub const OP_LIST_LIMIT: usize = 100;

#[derive(Debug, Serialize)]
pub struct OpList {
    pub operations: Vec<OpView>,
    pub skipped: usize,
    pub has_more: bool,
    pub unresolved_calls: Vec<UnresolvedCall>,
}

#[derive(Debug, Serialize)]
pub struct UnresolvedCall {
    pub index_id: String,
    pub acknowledged: bool,
    /// Verified saved ceiling; absent records can only be checked/acknowledged.
    pub hangup_cap_msat: Option<u64>,
}

/// A dangling symlink reads as `NotFound` but is not an empty slot.
fn absent(path: &Path) -> bool {
    crate::pairing::key::nothing_at(path)
}

/// Folders from the journal folder `root` down to `path`'s own folder, in that
/// order. `None` when `root` is empty, `path` is not inside `root`, or a step
/// (the last one included) is not a plain name: nothing may be read through
/// it. The journal folder is the one the caller already holds, never a name
/// guessed from `path`.
#[cfg(any(windows, test))]
fn folders_from_root(root: &Path, path: &Path) -> Option<Vec<PathBuf>> {
    if root.components().next().is_none() { return None; }
    let mut steps = path.strip_prefix(root).ok()?.components();
    let Some(std::path::Component::Normal(_)) = steps.next_back() else { return None; };
    let mut folder = root.to_path_buf();
    let mut folders = vec![folder.clone()];
    for component in steps {
        let std::path::Component::Normal(name) = component else { return None; };
        folder.push(name);
        folders.push(folder.clone());
    }
    Some(folders)
}

/// Windows: every existing folder from the journal folder down to `path` is a
/// verified private folder. A link or reparse point on the way is refused, so
/// a missing record is never read through a redirected folder. Below a folder
/// that is really missing there is nothing to read.
#[cfg(windows)]
fn verify_folders(root: &Path, path: &Path) -> Result<(), ActionError> {
    for folder in folders_from_root(root, path).ok_or_else(storage_refused)? {
        if absent(&folder) { return Ok(()); }
        crate::private_fs::verify_dir(&folder).map_err(|_| storage_refused())?;
    }
    Ok(())
}

fn damaged_record() -> ActionError {
    // Do not log parser errors: they can contain bytes from a damaged record.
    eprintln!("spend ledger: required operation record or call index is missing, unreadable, or invalid");
    damaged_record_error()
}

/// The `damaged_record` error without its log line, for a failure already logged.
fn damaged_record_error() -> ActionError {
    unknown("Required operation record or call index is missing, unreadable, or invalid.")
}

/// Largest journal file accepted on Windows, written and read. A larger
/// record is refused: never truncated, and never treated as missing.
#[cfg(any(windows, test))]
const MAX_RECORD_BYTES: u64 = 1 << 20;

#[cfg(not(windows))]
fn read_file(_dir: &Path, path: &Path) -> std::io::Result<Vec<u8>> {
    std::fs::read(path)
}

/// Windows: a bounded read through a verified private handle. A missing file
/// is `NotFound`; a folder on the way that does not verify is `PermissionDenied`,
/// never a silent miss.
#[cfg(windows)]
fn read_file(dir: &Path, path: &Path) -> std::io::Result<Vec<u8>> {
    verify_folders(dir, path).map_err(|_| std::io::Error::from(std::io::ErrorKind::PermissionDenied))?;
    crate::private_fs::read(path, MAX_RECORD_BYTES).map(|mut bytes| std::mem::take(&mut *bytes))
}

#[cfg(not(windows))]
fn present(_dir: &Path, path: &Path) -> Result<bool, ActionError> {
    Ok(path.exists())
}

/// Windows: an object at `path` counts only after it verifies; otherwise refuse.
#[cfg(windows)]
fn present(dir: &Path, path: &Path) -> Result<bool, ActionError> {
    verify_folders(dir, path)?;
    if absent(path) { return Ok(false); }
    crate::private_fs::verify_file(path).map(|()| true).map_err(|_| storage_refused())
}

#[cfg(not(windows))]
fn history_marked(dir: &Path, marker: &Path) -> Result<bool, ActionError> {
    present(dir, marker)
}

#[cfg(windows)]
fn history_marked(dir: &Path, marker: &Path) -> Result<bool, ActionError> {
    history_marked_in(&WinStore, dir, marker)
}

/// A visible migration marker does not prove its folder flush finished:
/// flush again, and trust the marker only once that succeeds.
#[cfg(any(windows, test))]
fn history_marked_in<S: durable::Store>(store: &S, dir: &Path, marker: &Path) -> Result<bool, ActionError> {
    if !store.verify(marker).map_err(|_| storage_refused())? { return Ok(false); }
    marker_in(store, dir, marker).map(|()| true)
}

/// A call membership entry counts only as a verified private file.
#[cfg(not(windows))]
fn verify_membership(_path: &Path) -> Result<(), ActionError> {
    Ok(())
}

#[cfg(windows)]
fn verify_membership(path: &Path) -> Result<(), ActionError> {
    crate::private_fs::verify_file(path).map_err(|_| damaged_record())
}

/// An empty, durable marker file below the journal folder `_root`.
#[cfg(not(windows))]
fn create_marker(_root: &Path, path: &Path) -> Result<(), ActionError> {
    let parent = path.parent().expect("marker folder");
    std::fs::create_dir_all(parent).map_err(unknown)?;
    File::create(path).and_then(|f| f.sync_all()).map_err(unknown)?;
    File::open(parent).and_then(|f| f.sync_all()).map_err(unknown)
}

#[cfg(windows)]
fn create_marker(root: &Path, path: &Path) -> Result<(), ActionError> {
    marker_in(&WinStore, root, path)
}

#[cfg(not(windows))]
fn remove_durably(path: &Path) -> Result<(), ActionError> {
    std::fs::remove_file(path).map_err(unknown)?;
    File::open(path.parent().expect("journal folder")).and_then(|f| f.sync_all()).map_err(unknown)
}

#[cfg(windows)]
fn remove_durably(path: &Path) -> Result<(), ActionError> {
    journal_step(durable::remove(&WinStore, path))
}

/// Publish one record below the journal folder `root` (scratch: `.next`).
#[cfg(any(windows, test))]
fn put_in<S: durable::Store>(store: &S, root: &Path, dest: &Path, bytes: &[u8], check: impl FnOnce(&[u8]) -> bool) -> Result<(), ActionError> {
    journal_step(durable::put(store, root, &dest.with_extension("next"), dest, bytes, MAX_RECORD_BYTES, check))
}

#[cfg(any(windows, test))]
fn marker_in<S: durable::Store>(store: &S, root: &Path, path: &Path) -> Result<(), ActionError> {
    journal_step(durable::marker(store, root, path))
}

/// Windows `save`: the pending record first, then its operation graph.
#[cfg(any(windows, test))]
fn save_pending_in<S: durable::Store>(store: &S, dir: &Path, pending: &Pending,
    graph: impl FnOnce() -> Result<(), ActionError>) -> Result<(), ActionError> {
    logical_write(|| {
        let bytes = serde_json::to_vec(pending).map_err(|_| not_changed())?;
        put_in(store, dir, &dir.join("spend-pending.json"), &bytes,
            |b| serde_json::from_slice::<Pending>(b).is_ok())?;
        graph()
    })
}

/// Windows `write_operation`: the record is published before its call index
/// and membership advertise it.
#[cfg(any(windows, test))]
fn write_operation_in<S: durable::Store>(store: &S, dir: &Path, path: &Path, record: &OperationRecord) -> Result<(), ActionError> {
    logical_write(|| {
        let bytes = serde_json::to_vec(record).map_err(|_| not_changed())?;
        put_in(store, dir, path, &bytes,
            |b| serde_json::from_slice::<OperationRecord>(b).is_ok_and(|r| r.op_id == record.op_id))?;
        write_call_index_in(store, dir, record)?;
        write_call_membership_in(store, dir, record)
    })
}

/// A private object failed its check. No path or access-list detail is shown.
#[cfg(any(windows, test))]
fn storage_refused() -> ActionError {
    if sequence::published() { return may_not_be_on_disk(); }
    unknown("The private spend journal storage did not pass its access check. Nothing was changed.")
}

/// "Not changed" holds only while nothing in this logical write was published.
#[cfg(any(windows, test))]
fn not_changed() -> ActionError {
    if sequence::published() { return may_not_be_on_disk(); }
    unknown("The spend journal was not changed.")
}

#[cfg(any(windows, test))]
fn may_not_be_on_disk() -> ActionError {
    unknown("A spend journal change may not be on disk. Check the previous action before another spend.")
}

/// Only a write that finished every step succeeds. A failure before publish
/// left that file's old record in place; any later failure may or may not be
/// on disk. Once one file of a logical write is published, every later
/// failure in it is uncertain too.
#[cfg(any(windows, test))]
fn journal_failure(failed: durable::Failed) -> ActionError {
    // The error kind names no path or record content.
    eprintln!("spend journal: write stopped at {:?} ({:?})", failed.stage, failed.error.kind());
    match failed.stage.outcome() {
        durable::Outcome::NotCommitted => not_changed(),
        durable::Outcome::Uncertain => { sequence::mark_published(); may_not_be_on_disk() }
    }
}

/// One file step of a logical write; a finished step counts as published.
#[cfg(any(windows, test))]
fn journal_step(result: Result<(), durable::Failed>) -> Result<(), ActionError> {
    match result {
        Ok(()) => { sequence::mark_published(); Ok(()) }
        Err(failed) => Err(journal_failure(failed)),
    }
}

/// One logical journal write (for example pending record, then operation,
/// then call index and membership). Nested writes join the outermost one.
#[cfg(any(windows, test))]
fn logical_write<T>(f: impl FnOnce() -> T) -> T {
    sequence::run(f)
}

#[cfg(not(any(windows, test)))]
fn logical_write<T>(f: impl FnOnce() -> T) -> T {
    f()
}

/// Per-thread record of whether the current logical write has published a
/// file. Journal calls are synchronous and hold the journal locks.
#[cfg(any(windows, test))]
mod sequence {
    use std::cell::Cell;

    thread_local! {
        static DEPTH: Cell<usize> = const { Cell::new(0) };
        static PUBLISHED: Cell<bool> = const { Cell::new(false) };
    }

    struct Scope { outermost: bool }

    impl Drop for Scope {
        fn drop(&mut self) {
            DEPTH.with(|d| d.set(d.get() - 1));
            if self.outermost { PUBLISHED.with(|p| p.set(false)); }
        }
    }

    pub(super) fn run<T>(f: impl FnOnce() -> T) -> T {
        let outermost = DEPTH.with(|d| { let depth = d.get(); d.set(depth + 1); depth == 0 });
        if outermost { PUBLISHED.with(|p| p.set(false)); }
        let _scope = Scope { outermost };
        f()
    }

    /// Outside a logical write nothing is remembered.
    pub(super) fn mark_published() {
        if DEPTH.with(|d| d.get()) > 0 { PUBLISHED.with(|p| p.set(true)); }
    }

    pub(super) fn published() -> bool {
        PUBLISHED.with(|p| p.get())
    }
}

/// The Windows private-file layer as a [`durable::Store`]. Only safe facade
/// calls; the unsafe Windows calls stay in the FFI crate.
#[cfg(windows)]
struct WinStore;

#[cfg(windows)]
impl durable::Store for WinStore {
    type File = bitsov_ffi::win_private::VerifiedFile;
    fn ensure_dir(&self, dir: &Path) -> std::io::Result<()> { crate::private_fs::ensure_dir(dir) }
    fn sync_dir(&self, dir: &Path) -> std::io::Result<()> { crate::private_fs::sync_dir(dir) }
    fn verify(&self, path: &Path) -> std::io::Result<bool> {
        if absent(path) { return Ok(false); }
        crate::private_fs::verify_file(path).map(|()| true)
    }
    fn create(&self, path: &Path) -> std::io::Result<Self::File> { crate::private_fs::create_new(path) }
    // Only ever called on a scratch file this call just created.
    fn write(&self, file: &mut Self::File, bytes: &[u8]) -> std::io::Result<()> { file.replace_contents(bytes) }
    fn sync_file(&self, path: &Path) -> std::io::Result<()> { crate::private_fs::open_writable(path)?.sync() }
    fn read_back(&self, file: &mut Self::File, max: u64) -> std::io::Result<Vec<u8>> {
        file.read_bounded(max).map(|mut bytes| std::mem::take(&mut *bytes))
    }
    fn publish(&self, file: Self::File, dest: &Path, bytes: &[u8]) -> std::io::Result<()> {
        crate::private_fs::publish_replacing(file, dest, bytes)
    }
    fn open_existing(&self, path: &Path) -> std::io::Result<Self::File> { crate::private_fs::open_writable(path) }
    fn delete(&self, file: Self::File) -> std::io::Result<()> { file.discard() }
}

/// The fail-closed write protocol for one journal file, independent of the
/// storage layer so its outcome rules are tested on every platform.
///
/// - Before publish (bounds, folders, existing-object check, scratch create,
///   write+flush, read-back check): the old record is untouched and the
///   attempt's own scratch is deleted. [`Outcome::NotCommitted`].
/// - Publish, or anything after it: the new record may be visible without a
///   durability acknowledgement. [`Outcome::Uncertain`]. Nothing is rolled
///   back or deleted; the destination is never removed.
/// - A scratch left by an earlier attempt is never reused, promoted or
///   deleted: the write is refused until it is dealt with.
#[cfg(any(windows, test))]
mod durable {
    use std::io;
    use std::path::{Component, Path};

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(super) enum Stage { Prepare, Scratch, Write, Readback, Publish, Barrier }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(super) enum Outcome { NotCommitted, Uncertain }

    impl Stage {
        pub(super) fn outcome(self) -> Outcome {
            match self {
                Stage::Prepare | Stage::Scratch | Stage::Write | Stage::Readback => Outcome::NotCommitted,
                Stage::Publish | Stage::Barrier => Outcome::Uncertain,
            }
        }
    }

    #[derive(Debug)]
    pub(super) struct Failed { pub(super) stage: Stage, pub(super) error: io::Error }

    fn at(stage: Stage) -> impl FnOnce(io::Error) -> Failed {
        move |error| Failed { stage, error }
    }

    fn invalid(stage: Stage, what: &'static str) -> Failed {
        Failed { stage, error: io::Error::new(io::ErrorKind::InvalidInput, what) }
    }

    /// What the protocol needs from a private store.
    pub(super) trait Store {
        type File;
        /// Create a private folder, or verify an existing one.
        fn ensure_dir(&self, dir: &Path) -> io::Result<()>;
        fn sync_dir(&self, dir: &Path) -> io::Result<()>;
        /// `false`: nothing at all at `path`. An object that does not verify is an error.
        fn verify(&self, path: &Path) -> io::Result<bool>;
        /// A new private file; `AlreadyExists` when anything is at `path`.
        fn create(&self, path: &Path) -> io::Result<Self::File>;
        /// Write the whole new file and flush it.
        fn write(&self, file: &mut Self::File, bytes: &[u8]) -> io::Result<()>;
        /// Flush the existing verified file at `path`, never truncating it.
        fn sync_file(&self, path: &Path) -> io::Result<()>;
        fn read_back(&self, file: &mut Self::File, max: u64) -> io::Result<Vec<u8>>;
        /// Rename the file over `dest` by handle and flush `dest`'s folder.
        fn publish(&self, file: Self::File, dest: &Path, bytes: &[u8]) -> io::Result<()>;
        fn open_existing(&self, path: &Path) -> io::Result<Self::File>;
        /// Delete exactly this object, by handle.
        fn delete(&self, file: Self::File) -> io::Result<()>;
    }

    #[cfg(test)]
    thread_local! { static FAULT: std::cell::Cell<Option<Stage>> = const { std::cell::Cell::new(None) }; }

    /// Test seam: fail the next step at `stage` once (this thread only).
    #[cfg(test)]
    pub(super) fn inject(stage: Option<Stage>) { FAULT.with(|f| f.set(stage)); }

    fn fault(stage: Stage) -> io::Result<()> {
        #[cfg(test)]
        if FAULT.with(|f| f.get()) == Some(stage) {
            FAULT.with(|f| f.set(None));
            return Err(io::Error::other("injected fault"));
        }
        let _ = stage;
        Ok(())
    }

    /// Create every folder from `root` down to `path`'s folder as a private
    /// folder, flushing each into its parent. Only plain names below `root`.
    pub(super) fn dirs<S: Store>(store: &S, root: &Path, path: &Path) -> Result<(), Failed> {
        let relative = path.parent().and_then(|p| p.strip_prefix(root).ok())
            .ok_or_else(|| invalid(Stage::Prepare, "journal path is outside the journal folder"))?;
        fault(Stage::Prepare).and_then(|()| store.ensure_dir(root)).map_err(at(Stage::Prepare))?;
        let mut folder = root.to_path_buf();
        for component in relative.components() {
            let Component::Normal(name) = component else {
                return Err(invalid(Stage::Prepare, "journal path is not a plain name"));
            };
            let child = folder.join(name);
            store.ensure_dir(&child).map_err(at(Stage::Prepare))?;
            store.sync_dir(&folder).map_err(at(Stage::Prepare))?;
            folder = child;
        }
        Ok(())
    }

    /// Replace (or create) `dest` with `bytes` through the new scratch file `scratch`.
    pub(super) fn put<S: Store>(store: &S, root: &Path, scratch: &Path, dest: &Path, bytes: &[u8], max: u64,
        check: impl FnOnce(&[u8]) -> bool) -> Result<(), Failed> {
        if bytes.len() as u64 > max {
            return Err(Failed { stage: Stage::Prepare, error: io::Error::new(io::ErrorKind::InvalidData, "record is oversized") });
        }
        if scratch == dest || scratch.parent() != dest.parent() {
            return Err(invalid(Stage::Prepare, "scratch must sit beside its record"));
        }
        dirs(store, root, dest)?;
        // An existing record must verify before it may be replaced.
        store.verify(dest).map_err(at(Stage::Prepare))?;
        let mut file = fault(Stage::Scratch).and_then(|()| store.create(scratch)).map_err(at(Stage::Scratch))?;
        if let Err(error) = fault(Stage::Write).and_then(|()| store.write(&mut file, bytes)) {
            let _ = store.delete(file);
            return Err(Failed { stage: Stage::Write, error });
        }
        let readback = match fault(Stage::Readback).and_then(|()| store.read_back(&mut file, bytes.len() as u64)) {
            Ok(readback) => readback,
            Err(error) => {
                let _ = store.delete(file);
                return Err(Failed { stage: Stage::Readback, error });
            }
        };
        if readback != bytes || !check(&readback) {
            let _ = store.delete(file);
            return Err(Failed { stage: Stage::Readback, error: io::Error::new(io::ErrorKind::InvalidData, "record did not read back as written") });
        }
        if let Err(error) = fault(Stage::Publish) {
            // Stands in for a publish that failed: the outcome stays uncertain.
            let _ = store.delete(file);
            return Err(Failed { stage: Stage::Publish, error });
        }
        store.publish(file, dest, bytes).map_err(at(Stage::Publish))?;
        fault(Stage::Barrier).map_err(at(Stage::Barrier))
    }

    /// An empty marker at `path`, durable in its folder. An existing object
    /// must verify; it is never truncated or replaced.
    pub(super) fn marker<S: Store>(store: &S, root: &Path, path: &Path) -> Result<(), Failed> {
        dirs(store, root, path)?;
        let parent = path.parent().ok_or_else(|| invalid(Stage::Prepare, "marker has no folder"))?;
        match fault(Stage::Scratch).and_then(|()| store.create(path)) {
            // The entry is visible from here on, so a failure is uncertain.
            Ok(mut file) => fault(Stage::Write).and_then(|()| store.write(&mut file, b"")).map_err(at(Stage::Publish))?,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                if !store.verify(path).map_err(at(Stage::Prepare))? {
                    return Err(Failed { stage: Stage::Prepare, error: io::ErrorKind::NotFound.into() });
                }
                // An earlier attempt may have made it visible but failed its
                // file flush: finish that flush before trusting it.
                store.sync_file(path).map_err(at(Stage::Barrier))?;
            }
            Err(error) => return Err(Failed { stage: Stage::Scratch, error }),
        }
        // Verification alone does not prove an earlier flush: flush again.
        fault(Stage::Barrier).and_then(|()| store.sync_dir(parent)).map_err(at(Stage::Barrier))
    }

    /// Delete the verified object at `path` by handle, then flush its folder.
    pub(super) fn remove<S: Store>(store: &S, path: &Path) -> Result<(), Failed> {
        let parent = path.parent().filter(|p| !p.as_os_str().is_empty())
            .ok_or_else(|| invalid(Stage::Prepare, "record has no folder"))?;
        let file = fault(Stage::Prepare).and_then(|()| store.open_existing(path)).map_err(at(Stage::Prepare))?;
        fault(Stage::Publish).and_then(|()| store.delete(file)).map_err(at(Stage::Publish))?;
        fault(Stage::Barrier).and_then(|()| store.sync_dir(parent)).map_err(at(Stage::Barrier))
    }
}

fn read_operation(dir: &Path, path: &Path, expected_id: Option<&str>) -> Result<Option<OperationRecord>, ActionError> {
    match read_file(dir, path) {
        Ok(bytes) => {
            let record: OperationRecord = serde_json::from_slice(&bytes).map_err(|_| damaged_record())?;
            if expected_id.is_some_and(|id| id != record.op_id) { return Err(damaged_record()); }
            Ok(Some(record))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && absent(path) => Ok(None),
        Err(_) => Err(damaged_record()),
    }
}

// Stream entries so listing keeps a bounded working set.
#[cfg(not(windows))]
fn history_entries(dir: &Path) -> Result<impl Iterator<Item = std::io::Result<std::fs::DirEntry>>, ActionError> {
    match std::fs::read_dir(dir.join("ops")) {
        Ok(entries) => Ok(Some(entries).into_iter().flatten()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None.into_iter().flatten()),
        Err(e) => Err(unknown(e)),
    }
}

/// Windows: `ops` must be a verified private folder before it is listed.
/// Each listed record is still opened and verified on its own.
#[cfg(windows)]
fn history_entries(dir: &Path) -> Result<impl Iterator<Item = std::io::Result<std::fs::DirEntry>>, ActionError> {
    let ops = dir.join("ops");
    verify_folders(dir, &ops)?;
    if absent(&ops) { return Ok(None.into_iter().flatten()); }
    crate::private_fs::verify_dir(&ops).map_err(|_| storage_refused())?;
    std::fs::read_dir(ops).map(|entries| Some(entries).into_iter().flatten()).map_err(unknown)
}

fn unresolved_calls(dir: &Path, node_id: &str) -> Result<Vec<UnresolvedCall>, ActionError> {
    let mut names = std::collections::BTreeSet::new();
    for folder in ["call-index", "call-index-unresolved"] {
        for entry in read_entries(dir, &dir.join(folder))? { names.insert(entry.file_name()); }
    }
    let mut rows = Vec::new();
    for name in names {
        let Some(id) = name.to_str().and_then(|n| n.strip_suffix(".json")) else { continue };
        if id.len() != 64 || !id.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()) { continue; }
        let path = dir.join("call-index").join(&name);
        let record = read_file(dir, &path).ok().and_then(|b| serde_json::from_slice::<CallIndex>(&b).ok())
            .filter(|i| i.op_id.len() == 36 && i.op_id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-'))
            .and_then(|i| read_operation(dir, &dir.join("ops").join(format!("{}.json", i.op_id)), Some(&i.op_id)).ok().flatten()
                .filter(|r| r.created_ms == i.created_ms));
        let valid = record.as_ref().is_some_and(|r| matches!(r.kind.as_str(), "call_offer" | "call_recovery")
            && r.call_id.as_deref().is_some_and(|c| call_index_path(dir, &r.node_id, &r.peer, c) == path));
        if valid && !present(dir, &dir.join("call-index-unresolved").join(&name))? { continue; }
        if valid && record.as_ref().is_some_and(|r| r.node_id != node_id) { continue; }
        let hangup_cap_msat = record.as_ref().filter(|r| valid && r.node_id == node_id)
            .map(|r| r.hangup_cap_msat.unwrap_or(r.cap_msat));
        rows.push(UnresolvedCall { index_id: id.into(), hangup_cap_msat, acknowledged: present(dir, &dir.join("call-index-acknowledged")
            .join(blake3::hash(node_id.as_bytes()).to_hex().as_str()).join(&name))? });
    }
    Ok(rows)
}

pub fn list_operations(dir: &Path, node_id: &str, peer: Option<&str>, limit: usize) -> Result<OpList, ActionError> {
    let limit = limit.clamp(1, OP_LIST_LIMIT);
    let mut rows = std::collections::BTreeMap::new();
    let mut skipped = 0;
    let mut matched = 0;
    for entry in history_entries(dir)? {
        let path = match entry { Ok(e) => e.path(), Err(_) => { skipped += 1; continue; } };
        if path.extension().is_none_or(|e| e != "json") { continue; }
        let record = match read_operation(dir, &path, path.file_stem().and_then(|s| s.to_str())) {
            Ok(Some(record)) => record,
            _ => { skipped += 1; continue; }
        };
        if record.node_id != node_id || peer.is_some_and(|p| p != record.peer) { continue; }
        matched += 1;
        rows.insert((record.created_ms, record.op_id.clone()), record);
        if rows.len() > limit { rows.pop_first(); }
    }
    Ok(OpList { operations: rows.into_values().rev().map(Into::into).collect(), skipped, has_more: matched > limit, unresolved_calls: unresolved_calls(dir, node_id)? })
}

/// Read an atomic index/record snapshot when a live signal arrives, before
/// waiting on a dispatch. The snapshot grants no payment authority.
pub fn read_call_admission(dir: &Path, node_id: &str, peer: &str, call: &str) -> Result<Option<OperationRecord>, ActionError> {
    let path = call_index_path(dir, node_id, peer, call);
    let entry: CallIndex = match read_file(dir, &path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| damaged_record())?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && absent(&path) => return Ok(None),
        Err(_) => return Err(damaged_record()),
    };
    if entry.op_id.len() != 36 || !entry.op_id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-') {
        return Err(damaged_record());
    }
    let record = read_operation(dir, &dir.join("ops").join(format!("{}.json", entry.op_id)), Some(&entry.op_id))?
        .ok_or_else(damaged_record)?;
    if record.node_id != node_id || record.peer != peer || record.call_id.as_deref() != Some(call)
        || !matches!(record.kind.as_str(), "call_offer" | "call_recovery") {
        return Err(damaged_record());
    }
    Ok(Some(record))
}

/// Capture at receive time. A fresh wire ID can bind to its dispatching offer;
/// persistence waits for the money lock and the renderer waits for its receipt.
/// Reused IDs retain the older completed binding: never guess a new generation
/// from the peer's envelope clock.
pub fn read_completed_call_admission(dir: &Path, node_id: &str, peer: &str, call: &str) -> Result<Option<OperationRecord>, ActionError> {
    let Some(latest) = read_call_admission(dir, node_id, peer, call)? else { return Ok(None) };
    if latest.state != OperationState::Dispatching { return Ok(Some(latest)); }
    let directory = call_membership_root(dir, node_id)
        .join(blake3::hash(peer.as_bytes()).to_hex().as_str())
        .join(blake3::hash(call.as_bytes()).to_hex().as_str());
    let mut completed = None::<OperationRecord>;
    for entry in read_entries(dir, &directory)? {
        let id = entry.file_name().to_string_lossy().into_owned();
        if id.len() != 36 || !id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-') { return Err(damaged_record()); }
        verify_membership(&entry.path())?;
        let record = read_operation(dir, &dir.join("ops").join(format!("{id}.json")), Some(&id))?
            .ok_or_else(damaged_record)?;
        if record.node_id != node_id || record.peer != peer || record.call_id.as_deref() != Some(call) {
            return Err(damaged_record());
        }
        // Keep the receive-time upper bound even if dispatch finishes while
        // reading history. Its later receipt cannot change this binding.
        if matches!(record.kind.as_str(), "call_offer" | "call_recovery")
            && record.state != OperationState::Dispatching && record.created_ms < latest.created_ms
            && completed.as_ref().is_none_or(|r| record.created_ms > r.created_ms) {
            completed = Some(record);
        }
    }
    Ok(completed.or(Some(latest)))
}

/// Settling or failing a paid offer does not prove its admission is closed.
pub fn admission_open(offer: &OperationRecord, records: &[OperationRecord]) -> bool {
    matches!(offer.kind.as_str(), "call_offer" | "call_recovery")
        && !offer.call_closed
        && matches!(offer.state, OperationState::Dispatching | OperationState::Paid |
            OperationState::PaidUndelivered | OperationState::FailedPaid | OperationState::Unknown | OperationState::Settled)
        && !records.iter().any(|r| hangup_for(r, offer) && hangup_closes(r))
}

pub fn hangup_for(record: &OperationRecord, offer: &OperationRecord) -> bool {
    record.kind == "call_hangup" && record.node_id == offer.node_id
        && record.peer == offer.peer && record.call_id == offer.call_id
        && record.parent_op.as_deref() == Some(offer.op_id.as_str())
}

pub fn hangup_closes(record: &OperationRecord) -> bool {
    matches!(record.state, OperationState::Paid | OperationState::PaidUndelivered | OperationState::Settled | OperationState::FailedPaid)
        || (record.state == OperationState::Unpaid && matches!(record.reason.as_deref(), Some("call_not_live" | "call_not_found")))
}

pub fn hangup_blocks(record: &OperationRecord) -> bool {
    record.kind == "call_hangup" && (hangup_closes(record)
        || matches!(record.state, OperationState::Dispatching | OperationState::Unknown))
}

#[cfg(not(windows))]
fn read_entries(_dir: &Path, folder: &Path) -> Result<Vec<std::fs::DirEntry>, ActionError> {
    match std::fs::read_dir(folder) {
        Ok(entries) => entries.collect::<Result<Vec<_>, _>>().map_err(unknown),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(unknown(e)),
    }
}

/// Windows: only a verified private folder is listed. A link, reparse point
/// or folder with another access list is refused, never treated as empty.
/// Every folder from the journal folder down is checked first.
#[cfg(windows)]
fn read_entries(dir: &Path, folder: &Path) -> Result<Vec<std::fs::DirEntry>, ActionError> {
    verify_folders(dir, folder)?;
    if absent(folder) { return Ok(Vec::new()); }
    crate::private_fs::verify_dir(folder).map_err(|_| storage_refused())?;
    std::fs::read_dir(folder).and_then(|entries| entries.collect::<Result<Vec<_>, _>>()).map_err(unknown)
}

fn call_membership_root(dir: &Path, node_id: &str) -> PathBuf {
    dir.join("call-ops").join(blake3::hash(node_id.as_bytes()).to_hex().as_str())
}

#[cfg(unix)]
fn write_call_membership(dir: &Path, record: &OperationRecord) -> Result<(), ActionError> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    if record.call_id.is_none() || !record.kind.starts_with("call_") { return Ok(()); }
    if record.op_id.len() != 36 || !record.op_id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-') {
        return Err(damaged_record());
    }
    let root = call_membership_root(dir, &record.node_id);
    let peer = root.join(blake3::hash(record.peer.as_bytes()).to_hex().as_str());
    let call = peer.join(blake3::hash(record.call_id.as_deref().unwrap().as_bytes()).to_hex().as_str());
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&call).map_err(unknown)?;
    // Membership files contain no state. The atomic operation is authoritative;
    // pending repair recreates a missing membership after an interrupted write.
    let path = call.join(&record.op_id);
    OpenOptions::new().write(true).create(true).truncate(false).mode(0o600)
        .custom_flags(libc::O_NOFOLLOW).open(path).and_then(|f| f.sync_all()).map_err(unknown)?;
    for directory in [&call, &peer, &root, &dir.join("call-ops"), &dir.to_path_buf()] {
        File::open(directory).and_then(|f| f.sync_all()).map_err(unknown)?;
    }
    Ok(())
}

/// Windows: every folder level is a private folder, created from the journal
/// folder down and flushed into its parent; the empty entry is flushed too.
#[cfg(windows)]
fn write_call_membership(dir: &Path, record: &OperationRecord) -> Result<(), ActionError> {
    write_call_membership_in(&WinStore, dir, record)
}

#[cfg(any(windows, test))]
fn write_call_membership_in<S: durable::Store>(store: &S, dir: &Path, record: &OperationRecord) -> Result<(), ActionError> {
    if record.call_id.is_none() || !record.kind.starts_with("call_") { return Ok(()); }
    if record.op_id.len() != 36 || !record.op_id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-') {
        return Err(damaged_record());
    }
    let path = call_membership_root(dir, &record.node_id)
        .join(blake3::hash(record.peer.as_bytes()).to_hex().as_str())
        .join(blake3::hash(record.call_id.as_deref().unwrap().as_bytes()).to_hex().as_str())
        .join(&record.op_id);
    marker_in(store, dir, &path)
}

#[cfg(not(any(unix, windows)))]
fn write_call_membership(_dir: &Path, _record: &OperationRecord) -> Result<(), ActionError> {
    Err(unknown("private spend journal storage is not supported on this platform"))
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CallIndex { op_id: String, created_ms: u64 }

fn call_index_path(dir: &Path, node_id: &str, peer: &str, call: &str) -> PathBuf {
    let key = serde_json::to_vec(&(node_id, peer, call)).expect("string tuple serializes");
    dir.join("call-index").join(format!("{}.json", blake3::hash(&key).to_hex()))
}

/// What is at a call's index slot before `record` may be written there.
enum IndexSlot { Absent, Keep, Replace }

/// A call index slot that cannot be checked. Already logged by
/// `damaged_record`; the caller turns it into `damaged_record_error`.
struct SlotDamaged;

fn slot_damaged() -> SlotDamaged {
    let _ = damaged_record();
    SlotDamaged
}

/// A mapping is only replaced when it is readable and names an operation
/// record that exists and is a call admission for this same slot. A dangling
/// symlink, an unreadable file or a mapping whose record is missing or
/// damaged is evidence of an admission that cannot be checked any more:
/// refuse, and leave it in place for the owner's repair.
fn index_slot(dir: &Path, path: &Path, record: &OperationRecord) -> Result<IndexSlot, SlotDamaged> {
    let old: CallIndex = match read_file(dir, path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| slot_damaged())?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && absent(path) => return Ok(IndexSlot::Absent),
        Err(_) => return Err(slot_damaged()),
    };
    if (old.created_ms, &old.op_id) >= (record.created_ms, &record.op_id) { return Ok(IndexSlot::Keep); }
    if old.op_id == record.op_id { return Ok(IndexSlot::Replace); }
    if old.op_id.len() != 36 || !old.op_id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-') {
        return Err(slot_damaged());
    }
    // read_operation has already logged its failure through damaged_record.
    let mapped = read_operation(dir, &dir.join("ops").join(format!("{}.json", old.op_id)), Some(&old.op_id))
        .map_err(|_| SlotDamaged)?
        .ok_or_else(slot_damaged)?;
    let same_slot = matches!(mapped.kind.as_str(), "call_offer" | "call_recovery")
        && mapped.call_id.as_deref().is_some_and(|call| call_index_path(dir, &mapped.node_id, &mapped.peer, call) == path);
    if !same_slot { return Err(slot_damaged()); }
    Ok(IndexSlot::Replace)
}

#[cfg(unix)]
fn history_lock(dir: &Path) -> Result<File, ActionError> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::create_dir_all(dir).map_err(unknown)?;
    OpenOptions::new().read(true).write(true).create(true).truncate(false)
        .mode(0o600).custom_flags(libc::O_NOFOLLOW).open(dir.join("history.lock")).map_err(unknown)
}

#[cfg(windows)]
fn history_lock(dir: &Path) -> Result<LockFile, ActionError> {
    crate::private_fs::ensure_dir(dir).map_err(|_| storage_refused())?;
    crate::private_fs::open_lock(&dir.join("history.lock")).map_err(|_| storage_refused())
}

#[cfg(not(any(unix, windows)))]
fn history_lock(_dir: &Path) -> Result<File, ActionError> {
    Err(unknown("private spend journal storage is not supported on this platform"))
}

#[cfg(unix)]
fn write_call_index(dir: &Path, record: &OperationRecord) -> Result<(), ActionError> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    if !matches!(record.kind.as_str(), "call_offer" | "call_recovery") { return Ok(()); }
    let Some(call) = record.call_id.as_deref() else { return Ok(()) };
    let path = call_index_path(dir, &record.node_id, &record.peer, call);
    if let IndexSlot::Keep = index_slot(dir, &path, record).map_err(|SlotDamaged| damaged_record_error())? { return Ok(()); }
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

/// Windows: same slot rules as Unix; the index is a checked private record.
#[cfg(windows)]
fn write_call_index(dir: &Path, record: &OperationRecord) -> Result<(), ActionError> {
    write_call_index_in(&WinStore, dir, record)
}

#[cfg(any(windows, test))]
fn write_call_index_in<S: durable::Store>(store: &S, dir: &Path, record: &OperationRecord) -> Result<(), ActionError> {
    if !matches!(record.kind.as_str(), "call_offer" | "call_recovery") { return Ok(()); }
    let Some(call) = record.call_id.as_deref() else { return Ok(()) };
    let path = call_index_path(dir, &record.node_id, &record.peer, call);
    if let IndexSlot::Keep = index_slot(dir, &path, record).map_err(|SlotDamaged| damaged_record_error())? { return Ok(()); }
    let index = CallIndex { op_id: record.op_id.clone(), created_ms: record.created_ms };
    let bytes = serde_json::to_vec(&index).map_err(|_| not_changed())?;
    put_in(store, dir, &path, &bytes, |b| serde_json::from_slice::<CallIndex>(b)
        .is_ok_and(|i| i.op_id == record.op_id && i.created_ms == record.created_ms))
}

#[cfg(not(any(unix, windows)))]
fn write_call_index(_dir: &Path, _record: &OperationRecord) -> Result<(), ActionError> {
    Err(unknown("private spend journal storage is not supported on this platform"))
}

/// One-time upgrade of pre-index H1 history, before authenticating/enabling money
/// actions. Never invoked with NodeState::money or spend.lock held. Writers and
/// migration serialize only a single index update at a time.
/// Windows: the folder must be a verified private folder; every record, index
/// and marker below it is read and written through the private-file layer.
/// The marker is written last, after the steps before it were flushed.
pub fn initialize_history(dir: &Path) -> Result<(), ActionError> {
    logical_write(|| initialize_history_once(dir))
}

fn initialize_history_once(dir: &Path) -> Result<(), ActionError> {
    #[cfg(windows)] crate::private_fs::ensure_dir(dir).map_err(|_| storage_refused())?;
    let marker = dir.join("call-index-v2");
    if history_marked(dir, &marker)? {
        #[cfg(windows)] verify_history_root(dir)?;
        return Ok(());
    }
    for entry in history_entries(dir)? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if path.extension().is_none_or(|e| e != "json") { continue; }
        let Ok(Some(record)) = read_operation(dir, &path, path.file_stem().and_then(|s| s.to_str())) else { continue };
        write_call_membership(dir, &record)?;
        if !matches!(record.kind.as_str(), "call_offer" | "call_recovery") { continue; }
        let Some(call) = record.call_id.as_deref() else { continue };
        let lock = history_lock(dir)?;
        lock_handle(&lock).lock().map_err(unknown)?;
        // Preserve a damaged or dangling existing mapping as a fail-closed
        // marker for just this call (the scan below marks it unresolved). It
        // must not stop migration/authentication for other calls.
        let damaged = index_slot(dir, &call_index_path(dir, &record.node_id, &record.peer, call), &record).is_err();
        if damaged {
            let _ = damaged_record();
            let _ = lock_handle(&lock).unlock();
            continue;
        }
        let result = write_call_index(dir, &record);
        let _ = lock_handle(&lock).unlock();
        result?;
    }
    // Do not silently lose an indexed H1 admission when its record is damaged.
    // Keep unresolved references separate so normal call lookup stays scoped.
    for entry in read_entries(dir, &dir.join("call-index"))? {
        if entry.path().extension().is_none_or(|e| e != "json") { continue; }
        let readable = read_file(dir, &entry.path()).ok()
            .and_then(|bytes| serde_json::from_slice::<CallIndex>(&bytes).ok())
            .filter(|index| index.op_id.len() == 36 && index.op_id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-'))
            .and_then(|index| read_operation(dir, &dir.join("ops").join(format!("{}.json", index.op_id)), Some(&index.op_id)).ok().flatten())
            .filter(|record| matches!(record.kind.as_str(), "call_offer" | "call_recovery")
                && record.call_id.as_deref().is_some_and(|call|
                    call_index_path(dir, &record.node_id, &record.peer, call).file_name() == Some(entry.file_name().as_os_str())));
        if readable.is_none() {
            create_marker(dir, &dir.join("call-index-unresolved").join(entry.file_name()))?;
        }
    }
    create_marker(dir, &marker)
}

/// Windows: a marked history folder holds only verified private objects.
/// The two lock files are skipped here: `open_lock` verifies them on every
/// open, and a verifying read open would fail while another handle holds them.
#[cfg(windows)]
fn verify_history_root(dir: &Path) -> Result<(), ActionError> {
    for entry in std::fs::read_dir(dir).map_err(|_| storage_refused())? {
        let entry = entry.map_err(|_| storage_refused())?;
        let name = entry.file_name();
        if name == "spend.lock" || name == "history.lock" { continue; }
        let path = entry.path();
        let kind = entry.file_type().map_err(|_| storage_refused())?;
        let verified = if kind.is_dir() && !kind.is_symlink() {
            crate::private_fs::verify_dir(&path)
        } else {
            crate::private_fs::verify_file(&path)
        };
        verified.map_err(|_| storage_refused())?;
    }
    Ok(())
}

fn fresh_id() -> Result<String, ActionError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(unknown)?;
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

/// Native Windows coverage on the private-file layer. These need a real
/// Windows host (ordinary user, local NTFS); elevated runs return early.
#[cfg(all(test, windows))]
mod windows_journal_tests {
    use super::*;
    use crate::private_fs::fixtures::*;
    use serde_json::json;

    fn journal_dir(name: &str) -> PathBuf {
        temp_root(name).join("app-spend")
    }

    /// Plant a private file through the private-file layer.
    fn plant(path: &Path, bytes: &[u8]) {
        crate::private_fs::write_replacing_verified(&path.with_extension("plant"), path, bytes,
            |e| e, |_| Ok(())).unwrap();
    }

    fn call_body(call: &str) -> serde_json::Value {
        json!({"recipient":"peer", "kind":400, "plaintext":json!({"call_id":call}).to_string()})
    }

    // W01
    #[test]
    fn a_saved_record_reopens_exactly_and_every_object_is_private() {
        if elevated() { return; }
        let dir = journal_dir("w01");
        let journal = Journal::open(&dir).unwrap();
        let call = "0123456789abcdef0123456789abcdef";
        let id = new_operation_id().unwrap();
        let begun = journal.begin_operation("node", "/messages/compose", &call_body(call), 2000,
            Some((id.clone(), operation(&call_body(call))))).unwrap();
        drop(journal);
        let journal = Journal::open(&dir).unwrap();
        let reopened = journal.pending().unwrap().unwrap();
        assert_eq!(serde_json::to_value(&reopened).unwrap(), serde_json::to_value(&begun).unwrap());
        crate::private_fs::verify_file(&dir.join("spend-pending.json")).unwrap();
        crate::private_fs::verify_file(&dir.join("ops").join(format!("{id}.json"))).unwrap();
        crate::private_fs::verify_dir(&dir.join("ops")).unwrap();
        crate::private_fs::verify_file(&call_index_path(&dir, "node", "peer", call)).unwrap();
        assert_eq!(journal.call_operations("node", Some("peer")).unwrap().len(), 1);
        assert!(!dir.join("spend-pending.next").exists());
    }

    // W02
    #[test]
    fn widened_linked_or_foreign_objects_are_refused_untouched() {
        if elevated() { return; }
        let dir = journal_dir("w02");
        let journal = Journal::open(&dir).unwrap();
        let id = new_operation_id().unwrap();
        let body = json!({"recipient":"peer", "kind":1, "plaintext":"x"});
        journal.begin_operation("node", "/messages/compose", &body, 2000, Some((id.clone(), operation(&body)))).unwrap();
        let pending = dir.join("spend-pending.json");
        let before = std::fs::read(&pending).unwrap();
        grant_everyone_read(&pending);
        assert!(journal.pending().is_err());
        assert!(read_pending(&dir).is_err(), "a widened record is not an empty slot");
        assert!(journal.begin("node", "/payments/pay", &json!({}), 1).is_err());
        assert!(journal.save(&serde_json::from_slice(&before).unwrap()).is_err());
        assert_eq!(std::fs::read(&pending).unwrap(), before);
        // A second hard link to an operation record.
        let record = dir.join("ops").join(format!("{id}.json"));
        std::fs::hard_link(&record, dir.join("linked")).unwrap();
        assert!(journal.operation_record(&id).is_err());
        drop(journal);
        // A junction as the journal folder, and a folder owned by another account.
        let link = temp_root("w02-link").join("app-spend");
        junction(&link, &dir);
        assert!(Journal::open(&link).is_err());
        assert!(Journal::open(&foreign_owned_dir()).is_err());
    }

    // W04 (two handles in one process; separate processes are not run here)
    #[test]
    fn one_owner_at_a_time_and_no_redispatch_after_reopen() {
        if elevated() { return; }
        let dir = journal_dir("w04");
        let journal = Journal::open(&dir).unwrap();
        journal.begin("node", "/messages/compose", &json!({"plaintext":"PRIVATE"}), 2000).unwrap();
        assert!(Journal::open(&dir).is_err());
        drop(journal);
        let next = Journal::open(&dir).unwrap();
        assert!(next.begin("node", "/messages/compose", &json!({}), 2000).is_err());
        crate::private_fs::verify_file(&dir.join("spend.lock")).unwrap();
        crate::private_fs::verify_file(&dir.join("history.lock")).unwrap();
    }

    // W05
    #[test]
    fn write_readback_and_flush_failures_keep_the_old_record() {
        if elevated() { return; }
        for stage in [durable::Stage::Scratch, durable::Stage::Write, durable::Stage::Readback] {
            let dir = journal_dir(&format!("w05-{stage:?}"));
            let journal = Journal::open(&dir).unwrap();
            let mut p = journal.begin("node", "/messages/compose", &json!({}), 2000).unwrap();
            let before = std::fs::read(dir.join("spend-pending.json")).unwrap();
            p.resumable = true;
            durable::inject(Some(stage));
            let result = journal.save(&p);
            durable::inject(None);
            assert!(result.is_err(), "{stage:?}");
            assert_eq!(std::fs::read(dir.join("spend-pending.json")).unwrap(), before, "{stage:?}");
            assert!(absent(&dir.join("spend-pending.next")), "{stage:?}");
            assert!(journal.begin("node", "/payments/pay", &json!({}), 1).is_err(), "no new dispatch");
        }
    }

    // W06
    #[test]
    fn a_stale_scratch_is_never_overwritten_or_promoted() {
        if elevated() { return; }
        let dir = journal_dir("w06");
        let journal = Journal::open(&dir).unwrap();
        let mut p = journal.begin("node", "/messages/compose", &json!({}), 2000).unwrap();
        let before = std::fs::read(dir.join("spend-pending.json")).unwrap();
        plant(&dir.join("spend-pending.next"), b"{partial");
        p.resumable = true;
        assert!(journal.save(&p).is_err());
        assert_eq!(std::fs::read(dir.join("spend-pending.next")).unwrap(), b"{partial");
        assert_eq!(std::fs::read(dir.join("spend-pending.json")).unwrap(), before);
        assert!(!journal.pending().unwrap().unwrap().resumable);
    }

    // W07 / W08 (an injected error after the rename; not a power-loss test)
    #[test]
    fn a_flush_error_after_rename_is_reported_and_reconciled_on_reopen() {
        if elevated() { return; }
        let dir = journal_dir("w08");
        let journal = Journal::open(&dir).unwrap();
        let mut p = journal.begin("node", "/messages/compose", &json!({}), 2000).unwrap();
        p.resumable = true;
        durable::inject(Some(durable::Stage::Barrier));
        let result = journal.save(&p);
        durable::inject(None);
        let error = result.unwrap_err();
        assert_eq!(error.code, "spend_unknown");
        assert!(!error.message.contains("not changed"));
        drop(journal);
        let journal = Journal::open(&dir).unwrap();
        let seen = journal.pending().unwrap().unwrap();
        assert_eq!(seen.id, p.id, "same identity, never a fresh one");
        assert!(seen.resumable, "the published record is kept, not rolled back");
    }

    // W10
    #[test]
    fn an_interrupted_graph_is_repaired_from_the_pending_record() {
        if elevated() { return; }
        let dir = journal_dir("w10");
        let journal = Journal::open(&dir).unwrap();
        let call = "0123456789abcdef0123456789abcdef";
        let id = new_operation_id().unwrap();
        journal.begin_operation("node", "/messages/compose", &call_body(call), 2000,
            Some((id.clone(), operation(&call_body(call))))).unwrap();
        // As if stopped after the pending rename, before the operation record.
        remove_durably(&dir.join("ops").join(format!("{id}.json"))).unwrap();
        remove_durably(&call_index_path(&dir, "node", "peer", call)).unwrap();
        drop(journal);
        let journal = Journal::open(&dir).unwrap();
        journal.pending().unwrap().unwrap();
        assert_eq!(journal.operation_record(&id).unwrap().unwrap().state, OperationState::Dispatching);
        assert_eq!(journal.call_parent("node", "peer", call).unwrap(), Some(id));
    }

    // W11 / W12 partial: clear keeps history and a failed clear keeps the record
    #[test]
    fn clear_keeps_history_and_a_failed_clear_is_never_success() {
        if elevated() { return; }
        let dir = journal_dir("w11");
        let journal = Journal::open(&dir).unwrap();
        let body = json!({"recipient":"peer", "kind":1, "plaintext":"x"});
        let id = new_operation_id().unwrap();
        let p = journal.begin_operation("node", "/messages/compose", &body, 2000, Some((id.clone(), operation(&body)))).unwrap();
        journal.record_outcome(&p, OperationState::Settled, None).unwrap();
        durable::inject(Some(durable::Stage::Publish));
        let result = journal.clear();
        durable::inject(None);
        assert!(result.is_err());
        assert!(read_pending(&dir).unwrap().is_some());
        journal.clear().unwrap();
        assert!(read_pending(&dir).unwrap().is_none());
        assert!(journal.clear().is_err(), "clearing nothing is not success");
        assert_eq!(journal.operation_record(&id).unwrap().unwrap().state, OperationState::Settled);
    }

    // W13
    #[test]
    fn oversized_or_corrupt_records_are_refused_not_treated_as_missing() {
        if elevated() { return; }
        let dir = journal_dir("w13");
        let journal = Journal::open(&dir).unwrap();
        plant(&dir.join("spend-pending.json"), &vec![b' '; MAX_RECORD_BYTES as usize + 1]);
        assert!(read_pending(&dir).is_err());
        plant(&dir.join("spend-pending.json"), b"{\"surprise\":1}");
        assert!(journal.pending().is_err());
        plant(&dir.join("spend-pending.json"), br#"{"id":"x","node_id":"n","request_hash":"h","max_msat":1,"target":null,"over_budget":false,
            "undelivered":{"peer":"p","paid_msat":1,"retry":true}}"#);
        let legacy = journal.pending().unwrap().unwrap();
        assert_eq!(legacy.undelivered.unwrap().payment_hash, None);
    }

    // W14
    #[test]
    fn a_populated_history_initializes_and_lists_only_verified_entries() {
        if elevated() { return; }
        let dir = journal_dir("w14");
        initialize_history(&dir).unwrap();
        let journal = Journal::open(&dir).unwrap();
        for n in 0..3 {
            let body = json!({"recipient":"peer", "kind":1, "plaintext":format!("m{n}")});
            let p = journal.begin_operation("node", "/messages/compose", &body, 2000,
                Some((new_operation_id().unwrap(), operation(&body)))).unwrap();
            journal.record_outcome(&p, OperationState::Settled, None).unwrap();
            journal.clear().unwrap();
        }
        plant(&dir.join("ops").join("00000000-0000-4000-8000-000000000000.json"), b"PRIVATE malformed");
        std::fs::write(dir.join("ops").join("00000000-0000-4000-8000-000000000001.json"), b"{}").unwrap();
        drop(journal);
        initialize_history(&dir).unwrap();
        let page = list_operations(&dir, "node", None, 100).unwrap();
        assert_eq!(page.operations.len(), 3);
        assert_eq!(page.skipped, 2);
    }

    // W14: a populated history without its marker is migrated
    #[test]
    fn a_populated_history_without_its_marker_is_migrated() {
        if elevated() { return; }
        let dir = journal_dir("w14-markerless");
        let journal = Journal::open(&dir).unwrap();
        let call = "0123456789abcdef0123456789abcdef";
        let id = new_operation_id().unwrap();
        let p = journal.begin_operation("node", "/messages/compose", &call_body(call), 2000,
            Some((id.clone(), operation(&call_body(call))))).unwrap();
        journal.record_outcome(&p, OperationState::Settled, None).unwrap();
        journal.clear().unwrap();
        drop(journal);
        remove_durably(&call_index_path(&dir, "node", "peer", call)).unwrap();
        assert!(absent(&dir.join("call-index-v2")));
        initialize_history(&dir).unwrap();
        crate::private_fs::verify_file(&dir.join("call-index-v2")).unwrap();
        assert_eq!(read_call_admission(&dir, "node", "peer", call).unwrap().unwrap().op_id, id);
    }

    // G3: a membership entry counts only as a verified private file
    #[test]
    fn a_membership_entry_that_does_not_verify_is_refused() {
        if elevated() { return; }
        let call = "0123456789abcdef0123456789abcdef";
        for case in ["widened", "folder", "linked"] {
            let dir = journal_dir(&format!("membership-{case}"));
            let journal = Journal::open(&dir).unwrap();
            let id = new_operation_id().unwrap();
            journal.begin_operation("node", "/messages/compose", &call_body(call), 2000,
                Some((id.clone(), operation(&call_body(call))))).unwrap();
            let entry = call_membership_root(&dir, "node").join(blake3::hash(b"peer").to_hex().as_str())
                .join(blake3::hash(call.as_bytes()).to_hex().as_str()).join(&id);
            match case {
                "widened" => grant_everyone_read(&entry),
                "folder" => {
                    remove_durably(&entry).unwrap();
                    crate::private_fs::ensure_dir(&entry).unwrap();
                }
                _ => std::fs::hard_link(&entry, dir.join("linked")).unwrap(),
            }
            // The operation record itself is still valid.
            crate::private_fs::verify_file(&dir.join("ops").join(format!("{id}.json"))).unwrap();
            assert!(journal.call_operations("node", Some("peer")).is_err(), "{case}");
            assert!(read_completed_call_admission(&dir, "node", "peer", call).is_err(), "{case}");
        }
    }

    // A folder on the way to a record that is a junction is refused, never read
    // as "nothing there": not ops, not call-index, not a call-ops level.
    #[test]
    fn a_redirected_folder_above_a_record_is_refused() {
        if elevated() { return; }
        let call = "0123456789abcdef0123456789abcdef";
        for case in ["ops", "call-index", "call-ops"] {
            let dir = journal_dir(&format!("redirected-{case}"));
            let journal = Journal::open(&dir).unwrap();
            let id = new_operation_id().unwrap();
            journal.begin_operation("node", "/messages/compose", &call_body(call), 2000,
                Some((id.clone(), operation(&call_body(call))))).unwrap();
            let moved = match case {
                "call-ops" => call_membership_root(&dir, "node"),
                _ => dir.join(case),
            };
            std::fs::rename(&moved, dir.join(format!("{case}-moved"))).unwrap();
            let empty = temp_root(&format!("redirected-{case}-empty"));
            crate::private_fs::ensure_dir(&empty).unwrap();
            junction(&moved, &empty);
            match case {
                "ops" => assert!(journal.operation_record(&id).is_err(), "{case}"),
                "call-index" => assert!(read_call_admission(&dir, "node", "peer", call).is_err(), "{case}"),
                _ => assert!(journal.call_operations("node", Some("peer")).is_err(), "{case}"),
            }
        }
    }

    // The journal folder itself is a junction onto a private empty folder.
    // A missing record there is not an empty journal.
    #[test]
    fn a_redirected_journal_root_is_refused() {
        if elevated() { return; }
        let root = temp_root("redirected-journal-root");
        // A new child, so the private access list is applied at creation.
        let target = root.join("empty");
        crate::private_fs::ensure_dir(&target).unwrap();
        let dir = root.join("app-spend");
        junction(&dir, &target);
        assert!(read_pending(&dir).is_err(), "a redirected journal folder is not an empty slot");
        assert!(list_operations(&dir, "node", None, 100).is_err(), "a redirected journal folder is not an empty history");
    }

    // W02 / W14 on the history folder itself
    #[test]
    fn tampered_history_is_refused_without_writes() {
        if elevated() { return; }
        let root = temp_root("history-tampered");
        let dir = root.join("app-spend");
        initialize_history(&dir).unwrap();
        crate::private_fs::verify_file(&dir.join("call-index-v2")).unwrap();
        initialize_history(&dir).unwrap();
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1, "a fresh history holds only its marker");
        grant_everyone_read(&dir.join("call-index-v2"));
        assert!(initialize_history(&dir).is_err());
        // A valid marker plus any entry that does not verify: refused, nothing written.
        let marked = root.join("app-spend-marked");
        initialize_history(&marked).unwrap();
        let marker_bytes = std::fs::read(marked.join("call-index-v2")).unwrap();
        std::fs::create_dir(marked.join("ops")).unwrap();
        assert!(initialize_history(&marked).is_err());
        std::fs::remove_dir(marked.join("ops")).unwrap();
        std::fs::write(marked.join("spend-pending.json"), b"{}").unwrap();
        assert!(initialize_history(&marked).is_err());
        assert_eq!(std::fs::read(marked.join("call-index-v2")).unwrap(), marker_bytes);
        assert_eq!(std::fs::read(marked.join("spend-pending.json")).unwrap(), b"{}");
        assert_eq!(std::fs::read_dir(&marked).unwrap().count(), 2);
        // History objects that do not verify, without the marker: refused, no marker.
        let other = root.join("app-spend-2");
        crate::private_fs::ensure_dir(&other).unwrap();
        std::fs::create_dir(other.join("ops")).unwrap();
        assert!(initialize_history(&other).is_err());
        assert!(absent(&other.join("call-index-v2")));
        // A plainly created marker inherits its access list: refused.
        let plain = root.join("app-spend-3");
        crate::private_fs::ensure_dir(&plain).unwrap();
        std::fs::write(plain.join("call-index-v2"), b"").unwrap();
        assert!(initialize_history(&plain).is_err());
        // Reparse point as the history folder; wrong owner.
        let link = root.join("link");
        junction(&link, &dir);
        assert!(initialize_history(&link).is_err());
        assert!(initialize_history(&foreign_owned_dir()).is_err());
    }
}

#[cfg(test)]
mod journal_folder_tests {
    use super::folders_from_root;
    use std::path::{Path, PathBuf};

    fn folders(root: &Path, path: &Path) -> Option<Vec<PathBuf>> { folders_from_root(root, path) }

    #[test]
    fn every_folder_from_the_journal_folder_down_is_listed() {
        let root = Path::new("/data/ops/app-spend");
        let j = |parts: &[&str]| parts.iter().fold(root.to_path_buf(), |p, s| p.join(s));
        assert_eq!(folders(root, &j(&["spend-pending.json"])), Some(vec![j(&[])]));
        assert_eq!(folders(root, &j(&["call-index-v2"])), Some(vec![j(&[])]));
        assert_eq!(folders(root, &j(&["ops"])), Some(vec![j(&[])]));
        assert_eq!(folders(root, &j(&["ops", "a.json"])), Some(vec![j(&[]), j(&["ops"])]));
        assert_eq!(folders(root, &j(&["call-index-unresolved", "x.json"])), Some(vec![j(&[]), j(&["call-index-unresolved"])]));
        assert_eq!(folders(root, &j(&["call-ops", "n", "p", "c", "op"])),
            Some(vec![j(&[]), j(&["call-ops"]), j(&["call-ops", "n"]), j(&["call-ops", "n", "p"]), j(&["call-ops", "n", "p", "c"])]));
        // A lock file sits in the journal folder itself.
        assert_eq!(folders(root, &j(&["spend.lock"])), Some(vec![j(&[])]));
        // A path deeper than the call layout is still checked from the journal folder.
        assert_eq!(folders(root, &j(&["a", "b", "c", "d", "e", "f.json"])),
            Some(vec![j(&[]), j(&["a"]), j(&["a", "b"]), j(&["a", "b", "c"]), j(&["a", "b", "c", "d"]), j(&["a", "b", "c", "d", "e"])]));
    }

    #[test]
    fn a_path_outside_the_journal_folder_is_refused() {
        let root = Path::new("/data/ops/app-spend");
        assert_eq!(folders(root, Path::new("/data/app-spend/other.json")), None);
        assert_eq!(folders(root, Path::new("/data/ops/app-spend-extra/spend-pending.json")), None);
        assert_eq!(folders(root, Path::new("ops")), None);
        assert_eq!(folders(root, &root.join("ops").join("..").join("spend-pending.json")), None);
    }

    /// The last step names the record, so it must be a plain name too: a
    /// trailing `..` is refused, not silently popped by `parent()`. An empty
    /// journal folder would start the chain at a folder that reads as missing,
    /// so it is refused as well.
    #[test]
    fn a_trailing_parent_step_or_an_empty_journal_folder_is_refused() {
        let root = Path::new("/data/ops/app-spend");
        assert_eq!(folders(root, &root.join("..")), None);
        assert_eq!(folders(root, &root.join("ops").join("..")), None);
        assert_eq!(folders(root, root), None);
        assert_eq!(folders(Path::new(""), Path::new("ops/a.json")), None);
        assert_eq!(folders(Path::new(""), Path::new("spend-pending.json")), None);
    }

    /// A file under a journal subdirectory can share a top-level journal name.
    /// The chain must still start at the journal folder, not at that subdirectory.
    #[test]
    fn a_nested_journal_file_name_keeps_the_journal_folder() {
        let root = Path::new("/data/ops/app-spend");
        let path = root.join("ops").join("spend-pending.json");
        assert_eq!(folders(root, &path), Some(vec![root.to_path_buf(), root.join("ops")]));
    }
}

/// The write protocol's outcome rules, run on real files with a plain
/// POSIX store. They test the protocol, not Windows: native Windows runs
/// use `windows_journal_tests` below.
#[cfg(all(test, unix))]
mod durable_tests {
    use super::durable::{self, Outcome, Stage, Store};
    use super::*;
    use std::io::{Read, Seek, SeekFrom};

    struct Posix;

    impl Store for Posix {
        type File = (File, PathBuf);
        fn ensure_dir(&self, dir: &Path) -> std::io::Result<()> {
            match std::fs::create_dir(dir) {
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                other => other?,
            }
            let meta = std::fs::symlink_metadata(dir)?;
            if meta.is_dir() { Ok(()) } else { Err(std::io::ErrorKind::PermissionDenied.into()) }
        }
        fn sync_dir(&self, dir: &Path) -> std::io::Result<()> { File::open(dir)?.sync_all() }
        fn verify(&self, path: &Path) -> std::io::Result<bool> {
            match std::fs::symlink_metadata(path) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
                Err(e) => Err(e),
                Ok(meta) if meta.is_file() => Ok(true),
                Ok(_) => Err(std::io::ErrorKind::PermissionDenied.into()),
            }
        }
        fn create(&self, path: &Path) -> std::io::Result<Self::File> {
            Ok((OpenOptions::new().read(true).write(true).create_new(true).open(path)?, path.to_path_buf()))
        }
        fn write(&self, file: &mut Self::File, bytes: &[u8]) -> std::io::Result<()> {
            file.0.write_all(bytes)?;
            file.0.sync_all()
        }
        fn sync_file(&self, path: &Path) -> std::io::Result<()> {
            if !self.verify(path)? { return Err(std::io::ErrorKind::NotFound.into()); }
            OpenOptions::new().read(true).write(true).open(path)?.sync_all()
        }
        fn read_back(&self, file: &mut Self::File, max: u64) -> std::io::Result<Vec<u8>> {
            file.0.seek(SeekFrom::Start(0))?;
            let mut bytes = Vec::new();
            (&mut file.0).take(max + 1).read_to_end(&mut bytes)?;
            Ok(bytes)
        }
        fn publish(&self, file: Self::File, dest: &Path, _bytes: &[u8]) -> std::io::Result<()> {
            std::fs::rename(&file.1, dest)?;
            self.sync_dir(dest.parent().unwrap())
        }
        fn open_existing(&self, path: &Path) -> std::io::Result<Self::File> {
            if !self.verify(path)? { return Err(std::io::ErrorKind::NotFound.into()); }
            Ok((OpenOptions::new().read(true).write(true).open(path)?, path.to_path_buf()))
        }
        fn delete(&self, file: Self::File) -> std::io::Result<()> { std::fs::remove_file(file.1) }
    }

    fn put(root: &Path, dest: &Path, bytes: &[u8]) -> Result<(), durable::Failed> {
        durable::put(&Posix, root, &dest.with_extension("next"), dest, bytes, MAX_RECORD_BYTES, |_| true)
    }

    fn with_fault<T>(stage: Stage, f: impl FnOnce() -> T) -> T {
        durable::inject(Some(stage));
        let result = f();
        durable::inject(None);
        result
    }

    #[test]
    fn only_a_completed_write_succeeds_and_failures_map_by_stage() {
        for stage in [Stage::Prepare, Stage::Scratch, Stage::Write, Stage::Readback] {
            assert_eq!(stage.outcome(), Outcome::NotCommitted, "{stage:?}");
        }
        for stage in [Stage::Publish, Stage::Barrier] {
            assert_eq!(stage.outcome(), Outcome::Uncertain, "{stage:?}");
        }
        let failed = |stage| durable::Failed { stage, error: std::io::Error::other("x") };
        let not = journal_failure(failed(Stage::Write));
        let maybe = journal_failure(failed(Stage::Barrier));
        assert_eq!((not.code, maybe.code), ("spend_unknown", "spend_unknown"));
        assert_ne!(not.message, maybe.message, "an uncertain write must not read as unchanged");
        assert!(!maybe.message.contains("not changed"));
    }

    #[test]
    fn a_complete_write_creates_folders_and_publishes_exact_bytes() {
        let root = tempfile::tempdir().unwrap();
        let dest = root.path().join("ops").join("a.json");
        put(root.path(), &dest, b"{\"v\":1}").unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"{\"v\":1}");
        put(root.path(), &dest, b"{\"v\":2}").unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"{\"v\":2}");
        assert!(!dest.with_extension("next").exists());
    }

    #[test]
    fn failures_before_publish_keep_the_old_record_and_remove_only_own_scratch() {
        for stage in [Stage::Prepare, Stage::Scratch, Stage::Write, Stage::Readback] {
            let root = tempfile::tempdir().unwrap();
            let dest = root.path().join("spend-pending.json");
            put(root.path(), &dest, b"old").unwrap();
            let failed = with_fault(stage, || put(root.path(), &dest, b"new")).unwrap_err();
            assert_eq!((failed.stage, failed.stage.outcome()), (stage, Outcome::NotCommitted));
            assert_eq!(std::fs::read(&dest).unwrap(), b"old", "{stage:?}");
            assert!(!dest.with_extension("next").exists(), "{stage:?}");
        }
    }

    #[test]
    fn a_failed_read_back_check_is_not_committed() {
        let root = tempfile::tempdir().unwrap();
        let dest = root.path().join("a.json");
        put(root.path(), &dest, b"old").unwrap();
        let failed = durable::put(&Posix, root.path(), &dest.with_extension("next"), &dest, b"new", MAX_RECORD_BYTES, |_| false).unwrap_err();
        assert_eq!(failed.stage.outcome(), Outcome::NotCommitted);
        assert_eq!(std::fs::read(&dest).unwrap(), b"old");
        assert!(!dest.with_extension("next").exists());
    }

    #[test]
    fn a_publish_error_is_uncertain_and_never_deletes_the_destination() {
        let root = tempfile::tempdir().unwrap();
        let dest = root.path().join("a.json");
        put(root.path(), &dest, b"old").unwrap();
        let failed = with_fault(Stage::Publish, || put(root.path(), &dest, b"new")).unwrap_err();
        assert_eq!(failed.stage.outcome(), Outcome::Uncertain);
        assert_eq!(std::fs::read(&dest).unwrap(), b"old");
    }

    #[test]
    fn a_flush_error_after_rename_is_uncertain_and_keeps_the_new_record() {
        let root = tempfile::tempdir().unwrap();
        let dest = root.path().join("a.json");
        put(root.path(), &dest, b"old").unwrap();
        let failed = with_fault(Stage::Barrier, || put(root.path(), &dest, b"new")).unwrap_err();
        assert_eq!((failed.stage, failed.stage.outcome()), (Stage::Barrier, Outcome::Uncertain));
        // No rollback: the published record stays for reconciliation.
        assert_eq!(std::fs::read(&dest).unwrap(), b"new");
    }

    #[test]
    fn a_leftover_scratch_is_refused_and_left_untouched() {
        let root = tempfile::tempdir().unwrap();
        let dest = root.path().join("spend-pending.json");
        put(root.path(), &dest, b"old").unwrap();
        std::fs::write(dest.with_extension("next"), b"{partial").unwrap();
        let failed = put(root.path(), &dest, b"new").unwrap_err();
        assert_eq!((failed.stage, failed.error.kind()), (Stage::Scratch, std::io::ErrorKind::AlreadyExists));
        assert_eq!(failed.stage.outcome(), Outcome::NotCommitted);
        assert_eq!(std::fs::read(dest.with_extension("next")).unwrap(), b"{partial");
        assert_eq!(std::fs::read(&dest).unwrap(), b"old");
    }

    #[test]
    fn an_oversized_record_is_refused_before_any_io() {
        let root = tempfile::tempdir().unwrap();
        let dest = root.path().join("ops").join("a.json");
        let big = vec![b'x'; MAX_RECORD_BYTES as usize + 1];
        let failed = put(root.path(), &dest, &big).unwrap_err();
        assert_eq!((failed.stage, failed.error.kind()), (Stage::Prepare, std::io::ErrorKind::InvalidData));
        assert!(!root.path().join("ops").exists());
    }

    #[test]
    fn an_unverifiable_destination_or_path_is_refused_untouched() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("t"), b"target").unwrap();
        let dest = root.path().join("a.json");
        std::os::unix::fs::symlink(outside.path().join("t"), &dest).unwrap();
        assert_eq!(put(root.path(), &dest, b"new").unwrap_err().stage, Stage::Prepare);
        assert_eq!(std::fs::read(outside.path().join("t")).unwrap(), b"target");
        assert!(!dest.with_extension("next").exists());
        // Only plain names below the journal folder.
        for bad in [outside.path().join("b.json"), root.path().join("..").join("b.json")] {
            assert_eq!(put(root.path(), &bad, b"x").unwrap_err().stage, Stage::Prepare, "{bad:?}");
        }
        // A folder in the path that is a link is refused.
        std::os::unix::fs::symlink(outside.path(), root.path().join("ops")).unwrap();
        assert_eq!(put(root.path(), &root.path().join("ops").join("c.json"), b"x").unwrap_err().stage, Stage::Prepare);
        assert!(!outside.path().join("c.json").exists() && !outside.path().join("c.next").exists());
    }

    #[test]
    fn markers_are_durable_and_existing_objects_are_only_verified() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("call-ops").join("n").join("p").join("m");
        durable::marker(&Posix, root.path(), &path).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"");
        std::fs::write(&path, b"kept").unwrap();
        durable::marker(&Posix, root.path(), &path).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"kept", "never truncated");
        let failed = with_fault(Stage::Barrier, || durable::marker(&Posix, root.path(), &path)).unwrap_err();
        assert_eq!(failed.stage.outcome(), Outcome::Uncertain);
        let fresh = root.path().join("x");
        let failed = with_fault(Stage::Write, || durable::marker(&Posix, root.path(), &fresh)).unwrap_err();
        assert_eq!(failed.stage.outcome(), Outcome::Uncertain, "a created entry is visible");
        let link = root.path().join("link");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert_eq!(durable::marker(&Posix, root.path(), &link).unwrap_err().stage.outcome(), Outcome::NotCommitted);
    }

    #[test]
    fn removal_needs_a_verified_object_and_a_folder_flush() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("spend-pending.json");
        let failed = durable::remove(&Posix, &path).unwrap_err();
        assert_eq!(failed.stage.outcome(), Outcome::NotCommitted, "nothing to remove is not success");
        std::fs::write(&path, b"x").unwrap();
        let failed = with_fault(Stage::Publish, || durable::remove(&Posix, &path)).unwrap_err();
        assert_eq!(failed.stage.outcome(), Outcome::Uncertain);
        assert!(path.exists());
        let failed = with_fault(Stage::Barrier, || durable::remove(&Posix, &path)).unwrap_err();
        assert_eq!(failed.stage.outcome(), Outcome::Uncertain);
        assert!(!path.exists());
        std::fs::write(&path, b"x").unwrap();
        durable::remove(&Posix, &path).unwrap();
        assert!(!path.exists());
    }

    /// A store whose folder flush can be made to fail.
    struct FlushFails(std::cell::Cell<bool>);

    impl Store for FlushFails {
        type File = <Posix as Store>::File;
        fn ensure_dir(&self, dir: &Path) -> std::io::Result<()> { Posix.ensure_dir(dir) }
        fn sync_dir(&self, dir: &Path) -> std::io::Result<()> {
            if self.0.get() { return Err(std::io::Error::other("folder flush failed")); }
            Posix.sync_dir(dir)
        }
        fn verify(&self, path: &Path) -> std::io::Result<bool> { Posix.verify(path) }
        fn create(&self, path: &Path) -> std::io::Result<Self::File> { Posix.create(path) }
        fn write(&self, file: &mut Self::File, bytes: &[u8]) -> std::io::Result<()> { Posix.write(file, bytes) }
        fn sync_file(&self, path: &Path) -> std::io::Result<()> { Posix.sync_file(path) }
        fn read_back(&self, file: &mut Self::File, max: u64) -> std::io::Result<Vec<u8>> { Posix.read_back(file, max) }
        fn publish(&self, file: Self::File, dest: &Path, bytes: &[u8]) -> std::io::Result<()> { Posix.publish(file, dest, bytes) }
        fn open_existing(&self, path: &Path) -> std::io::Result<Self::File> { Posix.open_existing(path) }
        fn delete(&self, file: Self::File) -> std::io::Result<()> { Posix.delete(file) }
    }

    /// A store whose file flush can be made to fail; counts both flushes.
    #[derive(Default)]
    struct FileFlushFails { fail: std::cell::Cell<bool>, file_flushes: std::cell::Cell<u32>, dir_flushes: std::cell::Cell<u32> }

    impl Store for FileFlushFails {
        type File = <Posix as Store>::File;
        fn ensure_dir(&self, dir: &Path) -> std::io::Result<()> { Posix.ensure_dir(dir) }
        fn sync_dir(&self, dir: &Path) -> std::io::Result<()> {
            self.dir_flushes.set(self.dir_flushes.get() + 1);
            Posix.sync_dir(dir)
        }
        fn verify(&self, path: &Path) -> std::io::Result<bool> { Posix.verify(path) }
        fn create(&self, path: &Path) -> std::io::Result<Self::File> { Posix.create(path) }
        fn write(&self, file: &mut Self::File, bytes: &[u8]) -> std::io::Result<()> {
            file.0.write_all(bytes)?;
            self.flush_file(&file.0)
        }
        fn sync_file(&self, path: &Path) -> std::io::Result<()> {
            if !self.verify(path)? { return Err(std::io::ErrorKind::NotFound.into()); }
            self.flush_file(&OpenOptions::new().read(true).write(true).open(path)?)
        }
        fn read_back(&self, file: &mut Self::File, max: u64) -> std::io::Result<Vec<u8>> { Posix.read_back(file, max) }
        fn publish(&self, file: Self::File, dest: &Path, bytes: &[u8]) -> std::io::Result<()> { Posix.publish(file, dest, bytes) }
        fn open_existing(&self, path: &Path) -> std::io::Result<Self::File> { Posix.open_existing(path) }
        fn delete(&self, file: Self::File) -> std::io::Result<()> { Posix.delete(file) }
    }

    impl FileFlushFails {
        fn flush_file(&self, file: &File) -> std::io::Result<()> {
            self.file_flushes.set(self.file_flushes.get() + 1);
            if self.fail.get() { return Err(std::io::Error::other("file flush failed")); }
            file.sync_all()
        }
    }

    #[test]
    fn a_visible_marker_is_trusted_only_after_its_file_flush_succeeds() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("call-index-v2");
        let store = FileFlushFails::default();
        store.fail.set(true);
        let failed = durable::marker(&store, root.path(), &path).unwrap_err();
        assert_eq!(failed.stage.outcome(), Outcome::Uncertain, "the marker is visible");
        assert!(path.exists());
        // The file flush keeps failing: a retry must not report success.
        let failed = durable::marker(&store, root.path(), &path).unwrap_err();
        assert_eq!(failed.stage.outcome(), Outcome::Uncertain);
        assert!(!history_marked_in(&store, root.path(), &path).is_ok_and(|marked| marked));
        assert_eq!(store.file_flushes.get(), 3, "every retry flushes the file again");
        // Once the file flush succeeds, the folder is flushed and the marker counts.
        store.fail.set(false);
        let dirs_before = store.dir_flushes.get();
        assert!(history_marked_in(&store, root.path(), &path).unwrap());
        assert_eq!(store.file_flushes.get(), 4);
        assert!(store.dir_flushes.get() > dirs_before);
        durable::marker(&store, root.path(), &path).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"", "never truncated or rewritten");
    }

    const CALL: &str = "0123456789abcdef0123456789abcdef";

    fn record(call: Option<&str>) -> OperationRecord {
        OperationRecord {
            op_id: new_operation_id().unwrap(), node_id: "node".into(),
            kind: if call.is_some() { "call_offer" } else { "message" }.into(), peer: "peer".into(),
            call_id: call.map(str::to_string), parent_op: None, request_hash: "h".into(), cap_msat: 2000,
            state: OperationState::Dispatching, paid_msat: None, message_id: None, payment_hash: None,
            created_ms: 1, settled_ms: None, reason: None, hangup_cap_msat: None, call_closed: false, call_answered: false,
        }
    }

    fn op_path(dir: &Path, record: &OperationRecord) -> PathBuf {
        dir.join("ops").join(format!("{}.json", record.op_id))
    }

    fn assert_uncertain(error: &ActionError) {
        assert_eq!(error.code, "spend_unknown");
        assert!(!error.message.contains("not changed"), "{}", error.message);
        assert_eq!(error.message, may_not_be_on_disk().message);
    }

    // G1: pending record, then operation record
    #[test]
    fn an_operation_failure_after_the_pending_record_was_published_is_uncertain() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        let pending: Pending = serde_json::from_slice(br#"{"id":"kept","node_id":"node","request_hash":"h","max_msat":1,
            "target":null,"over_budget":false}"#).unwrap();
        let record = record(None);
        let op = op_path(dir, &record);
        // A leftover scratch refuses the operation write before its publish.
        std::fs::create_dir(dir.join("ops")).unwrap();
        std::fs::write(op.with_extension("next"), b"{stale").unwrap();
        let alone = write_operation_in(&Posix, dir, &op, &record).unwrap_err();
        assert!(alone.message.contains("not changed"), "nothing else was written: {}", alone.message);
        let error = save_pending_in(&Posix, dir, &pending, || write_operation_in(&Posix, dir, &op, &record)).unwrap_err();
        assert_uncertain(&error);
        let saved: Pending = serde_json::from_slice(&std::fs::read(dir.join("spend-pending.json")).unwrap()).unwrap();
        assert_eq!(saved.id, "kept", "the published pending record is kept, not rolled back");
        assert!(!op.exists());
        assert_eq!(std::fs::read(op.with_extension("next")).unwrap(), b"{stale");
        // The next logical write starts fresh.
        assert!(write_operation_in(&Posix, dir, &op, &record).unwrap_err().message.contains("not changed"));
    }

    // G1: operation record, then call index or membership
    #[test]
    fn an_index_or_membership_failure_after_the_operation_was_published_is_uncertain() {
        // Index: a leftover scratch refuses the index write before its publish.
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        let record = record(Some(CALL));
        let op = op_path(dir, &record);
        let index = call_index_path(dir, "node", "peer", CALL);
        std::fs::create_dir_all(index.parent().unwrap()).unwrap();
        std::fs::write(index.with_extension("next"), b"{stale").unwrap();
        assert_uncertain(&write_operation_in(&Posix, dir, &op, &record).unwrap_err());
        assert!(op.exists() && !index.exists());
        assert_eq!(std::fs::read(index.with_extension("next")).unwrap(), b"{stale");

        // Membership: a folder where the entry belongs refuses it before it is created.
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        let entry = call_membership_root(dir, "node").join(blake3::hash(b"peer").to_hex().as_str())
            .join(blake3::hash(CALL.as_bytes()).to_hex().as_str()).join(&record.op_id);
        std::fs::create_dir_all(&entry).unwrap();
        let op = op_path(dir, &record);
        assert_uncertain(&write_operation_in(&Posix, dir, &op, &record).unwrap_err());
        assert!(op.exists() && call_index_path(dir, "node", "peer", CALL).exists());
        assert!(entry.is_dir(), "nothing is rolled back or replaced");
    }

    // G2: a visible migration marker is not trusted while its folder flush fails
    #[test]
    fn a_visible_history_marker_counts_only_after_its_folder_flush() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        let marker = dir.join("call-index-v2");
        let store = FlushFails(std::cell::Cell::new(false));
        assert!(!history_marked_in(&store, dir, &marker).unwrap(), "no marker yet");
        // As if the marker was created but its folder flush failed.
        std::fs::write(&marker, b"").unwrap();
        store.0.set(true);
        assert_uncertain(&history_marked_in(&store, dir, &marker).unwrap_err());
        assert!(history_marked_in(&store, dir, &marker).is_err(), "still failing: still not trusted");
        store.0.set(false);
        assert!(history_marked_in(&store, dir, &marker).unwrap());
        assert!(history_marked_in(&store, dir, &marker).unwrap(), "idempotent");
        assert_eq!(std::fs::read(&marker).unwrap(), b"", "never rewritten");
    }

    /// Current and legacy records fit the Windows bound with wide margin;
    /// a valid old schema still loads.
    #[test]
    fn supported_records_fit_the_windows_bound_and_legacy_records_load() {
        let long = "f".repeat(4096);
        let pending: Pending = serde_json::from_value(serde_json::json!({
            "id": "a".repeat(64), "rollback_charge_id": long, "node_id": long, "request_hash": "h".repeat(64),
            "max_msat": u64::MAX, "target": {"Message": {"id": long, "peer": long}}, "over_budget": false,
            "accounting_msat": u64::MAX, "evidence_reservation_msat": u64::MAX,
            "undelivered": {"peer": long, "paid_msat": u64::MAX, "retry": true, "op": long, "admission_msat": u64::MAX,
                "in_flight": true, "attempts": u32::MAX, "payment_hash": long},
            "charge_id": long, "budgeted": true, "all_in": true, "operation_id": "0".repeat(36), "dispatched_at": u64::MAX,
            "op": long, "peer": long, "compose_fee_msat": u64::MAX, "failure_final_on": long,
            "operation_record": {"op_id": "0".repeat(36), "node_id": long, "kind": "call_offer", "peer": long,
                "call_id": long, "parent_op": long, "request_hash": long, "cap_msat": u64::MAX, "state": "paid_undelivered",
                "paid_msat": u64::MAX, "message_id": long, "payment_hash": long, "created_ms": u64::MAX, "settled_ms": u64::MAX,
                "reason": long, "hangup_cap_msat": u64::MAX, "call_closed": true, "call_answered": true},
            "direct": {"request_id": long, "path": "/payments/pay", "body": {"invoice": "l".repeat(16 * 1024), "request_id": long}},
        })).unwrap();
        let bytes = serde_json::to_vec(&pending).unwrap();
        // Every string field is 4 KiB (real ones are under 100 bytes): still far below the bound.
        assert!((bytes.len() as u64) < MAX_RECORD_BYTES / 8, "{}", bytes.len());
        let legacy = br#"{"node_id":"n","request_hash":"h","max_msat":1,"target":null,"over_budget":false,
            "undelivered":{"peer":"p","paid_msat":1,"retry":true}}"#;
        let old: Pending = serde_json::from_slice(legacy).unwrap();
        assert!(old.id.is_empty() && old.operation_id.is_none());
        let root = tempfile::tempdir().unwrap();
        let dest = root.path().join("spend-pending.json");
        durable::put(&Posix, root.path(), &dest.with_extension("next"), &dest, &bytes, MAX_RECORD_BYTES,
            |b| serde_json::from_slice::<Pending>(b).is_ok()).unwrap();
        // Unknown fields or state are refused by the record check, not dropped.
        let unknown_state = br#"{"node_id":"n","request_hash":"h","max_msat":1,"target":null,"over_budget":false,"surprise":1}"#;
        let failed = durable::put(&Posix, root.path(), &dest.with_extension("next"), &dest, unknown_state, MAX_RECORD_BYTES,
            |b| serde_json::from_slice::<Pending>(b).is_ok()).unwrap_err();
        assert_eq!(failed.stage.outcome(), Outcome::NotCommitted);
        assert_eq!(std::fs::read(&dest).unwrap(), bytes);
        assert!(not_changed().message.contains("not changed"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Main's lock test clones the lock handle; on Windows it is the verified handle's file.
    #[cfg(windows)]
    trait TryCloneLock { fn try_clone(&self) -> std::io::Result<File>; }
    #[cfg(windows)]
    impl TryCloneLock for LockFile {
        fn try_clone(&self) -> std::io::Result<File> { self.as_file().try_clone() }
    }

    fn history_fixture(dir: &Path, id: usize, state: OperationState, kind: &str) -> OperationRecord {
        let record = OperationRecord {
            op_id: format!("00000000-0000-4000-8000-{id:012x}"), node_id: "node".into(),
            kind: kind.into(), peer: "peer".into(), call_id: Some("0123456789abcdef0123456789abcdef".into()),
            parent_op: None, request_hash: "hash".into(), cap_msat: 2000, state,
            paid_msat: Some(2000), message_id: None, payment_hash: None,
            created_ms: id as u64, settled_ms: Some(100), reason: None, hangup_cap_msat: None, call_closed: false, call_answered: false,
        };
        std::fs::create_dir_all(dir.join("ops")).unwrap();
        std::fs::write(dir.join("ops").join(format!("{}.json", record.op_id)), serde_json::to_vec(&record).unwrap()).unwrap();
        record
    }

    #[test]
    fn recovery_index_acknowledgement_preserves_fence_until_exact_record_is_repaired() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        let offer = history_fixture(dir.path(), 1, OperationState::Paid, "call_offer");
        journal.write_operation(&offer).unwrap();
        let path = call_index_path(dir.path(), "node", "peer", offer.call_id.as_deref().unwrap());
        let id = path.file_stem().unwrap().to_str().unwrap();
        std::fs::remove_file(journal.operation_path(&offer.op_id).unwrap()).unwrap();
        initialize_history(dir.path()).unwrap();
        let rows = list_operations(dir.path(), "node", None, 100).unwrap();
        assert_eq!(rows.unresolved_calls.len(), 1);
        assert!(!rows.unresolved_calls[0].acknowledged);
        assert!(journal.repair_call_index("node", id).unwrap().is_none());
        assert!(list_operations(dir.path(), "node", None, 100).unwrap().unresolved_calls[0].acknowledged);
        assert!(journal.call_operations("node", Some("peer")).is_err());
        assert!(path.exists(), "acknowledgement must never delete evidence");
        // Only restoration of this exact record can remove the damaged-index fence.
        journal.write_operation(&offer).unwrap();
        assert_eq!(journal.repair_call_index("node", id).unwrap(), offer.call_id);
        let records = journal.call_operations("node", Some("peer")).unwrap();
        assert!(admission_open(&offer, &records), "repair must not close a paid admission");
        assert_eq!(list_operations(dir.path(), "node", None, 100).unwrap().unresolved_calls.len(), 1);
        journal.observe_call(&offer, true).unwrap();
        journal.repair_call_index("node", id).unwrap();
        assert!(list_operations(dir.path(), "node", None, 100).unwrap().unresolved_calls.is_empty());
        assert!(journal.repair_call_index("node", "../ops").is_err());
    }

    #[test]
    fn recovery_index_restores_exact_pending_snapshot_without_releasing_payment() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        let call = "0123456789abcdef0123456789abcdef";
        let body = json!({"recipient":"peer", "kind":400, "plaintext":json!({"call_id":call}).to_string()});
        let p = journal.begin_operation("node", "/messages/compose", &body, 2000,
            Some((new_operation_id().unwrap(), operation(&body)))).unwrap();
        let before = std::fs::read(dir.path().join("spend-pending.json")).unwrap();
        let path = call_index_path(dir.path(), "node", "peer", call);
        let id = path.file_stem().unwrap().to_str().unwrap();
        std::fs::write(journal.operation_path(p.operation_id.as_deref().unwrap()).unwrap(), "damaged").unwrap();
        assert_eq!(list_operations(dir.path(), "node", None, 100).unwrap().unresolved_calls.len(), 1);
        assert!(journal.repair_call_index("other", id).is_err(), "foreign pending snapshots cannot be acknowledged either");
        assert!(!dir.path().join("call-index-acknowledged").exists());
        assert_eq!(journal.repair_call_index("node", id).unwrap().as_deref(), Some(call));
        assert_eq!(std::fs::read(dir.path().join("spend-pending.json")).unwrap(), before);
        let restored = journal.operation_record(p.operation_id.as_deref().unwrap()).unwrap().unwrap();
        assert_eq!(restored.state, OperationState::Dispatching);
        assert!(admission_open(&restored, &[]));
        assert_eq!(list_operations(dir.path(), "node", None, 100).unwrap().unresolved_calls.len(), 1);
    }

    #[test]
    fn recovery_index_prices_only_the_exact_verified_record() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        let mut offer = history_fixture(dir.path(), 1, OperationState::Paid, "call_offer");
        offer.hangup_cap_msat = Some(6000);
        journal.write_operation(&offer).unwrap();
        let path = call_index_path(dir.path(), "node", "peer", offer.call_id.as_deref().unwrap());
        let id = path.file_stem().unwrap().to_str().unwrap();
        // Repair retains a visible marker until confirmed closure.
        journal.repair_call_index("node", id).unwrap();
        let price = || list_operations(dir.path(), "node", None, 100).unwrap().unresolved_calls[0].hangup_cap_msat;
        assert_eq!(price(), Some(6000));
        offer.hangup_cap_msat = None;
        journal.write_operation(&offer).unwrap();
        assert_eq!(price(), Some(offer.cap_msat), "legacy offers use the same fallback as op_end_call");
        offer.created_ms += 1;
        std::fs::write(journal.operation_path(&offer.op_id).unwrap(), serde_json::to_vec(&offer).unwrap()).unwrap();
        assert_eq!(price(), None, "another generation is not a price quote");
        std::fs::remove_file(journal.operation_path(&offer.op_id).unwrap()).unwrap();
        assert_eq!(price(), None, "missing evidence must not invent a limit");
        assert!(list_operations(dir.path(), "other", None, 100).unwrap().unresolved_calls.iter().all(|r| r.hangup_cap_msat.is_none()));
    }

    #[test]
    fn recovery_index_repair_never_uses_another_identity_or_guesses_a_corrupt_index() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        let offer = history_fixture(dir.path(), 1, OperationState::Paid, "call_offer");
        journal.write_operation(&offer).unwrap();
        let path = call_index_path(dir.path(), "node", "peer", offer.call_id.as_deref().unwrap());
        let id = path.file_stem().unwrap().to_str().unwrap();
        let before = std::fs::read(&path).unwrap();
        assert!(journal.repair_call_index("other", id).is_err());
        assert!(!dir.path().join("call-index-acknowledged").exists());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        std::fs::write(&path, "PRIVATE damaged").unwrap();
        drop(journal);
        initialize_history(dir.path()).unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        assert!(journal.repair_call_index("node", id).unwrap().is_none());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "PRIVATE damaged");
        assert!(journal.call_operations("node", None).is_err());
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
    fn ledger_corrupt_shared_call_index_keeps_parent_lookup_failing_closed() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        let mut older = history_fixture(dir.path(), 1, OperationState::Dispatching, "call_offer");
        journal.write_operation(&older).unwrap();
        let newer = history_fixture(dir.path(), 2, OperationState::PaidUndelivered, "call_recovery");
        journal.write_operation(&newer).unwrap();
        let call = older.call_id.as_deref().unwrap();
        assert_eq!(journal.call_parent("node", "peer", call).unwrap(), Some(newer.op_id));
        let index = call_index_path(dir.path(), "node", "peer", call);
        let damaged = "PRIVATE corrupt shared call index";
        std::fs::write(&index, damaged).unwrap();
        for state in [OperationState::Unpaid, OperationState::FailedPaid, OperationState::Closed] {
            older.state = state;
            let _ = journal.write_operation(&older);
            assert!(journal.call_parent("node", "peer", call).is_err());
            assert_eq!(std::fs::read_to_string(&index).unwrap(), damaged);
        }
        drop(journal);
        initialize_history(dir.path()).unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        assert!(journal.call_parent("node", "peer", call).is_err());
        assert_eq!(journal.call_parent("node", "other", call).unwrap(), None);
        assert_eq!(std::fs::read_to_string(index).unwrap(), damaged);
    }

    #[test]
    fn ledger_terminal_outcomes_preserve_the_latest_call_index() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        let mut older = history_fixture(dir.path(), 1, OperationState::Dispatching, "call_offer");
        journal.write_operation(&older).unwrap();
        let call = older.call_id.clone().unwrap();
        older.state = OperationState::Unpaid;
        journal.write_operation(&older).unwrap();
        assert_eq!(journal.call_parent("node", "peer", &call).unwrap(), Some(older.op_id.clone()));
        let mut newer = history_fixture(dir.path(), 2, OperationState::PaidUndelivered, "call_recovery");
        journal.write_operation(&newer).unwrap();
        journal.write_operation(&older).unwrap();
        assert_eq!(journal.call_parent("node", "peer", &call).unwrap(), Some(newer.op_id.clone()));
        newer.state = OperationState::FailedPaid;
        journal.write_operation(&newer).unwrap();
        assert_eq!(journal.call_parent("node", "peer", &call).unwrap(), Some(newer.op_id.clone()));
        drop(journal);
        initialize_history(dir.path()).unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        assert_eq!(journal.call_parent("node", "peer", &call).unwrap(), Some(newer.op_id));
    }

    #[test]
    fn h2_cleanup_lookup_ignores_other_calls_damaged_history() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        let mut ids = Vec::new();
        for (peer, call) in [("other", "1123456789abcdef0123456789abcdef"), ("peer", "0123456789abcdef0123456789abcdef")] {
            let body = json!({"recipient":peer, "kind":400, "plaintext":json!({"call_id":call}).to_string()});
            let p = journal.begin_operation("node", "/messages/compose", &body, 2000,
                Some((new_operation_id().unwrap(), operation(&body)))).unwrap();
            journal.record_outcome(&p, OperationState::Settled, None).unwrap();
            ids.push(p.operation_id.unwrap());
            journal.clear().unwrap();
        }
        std::fs::remove_file(dir.path().join(format!("ops/{}.json", ids[0]))).unwrap();
        let calls = journal.call_operations_for("node", None, Some("0123456789abcdef0123456789abcdef")).unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].op_id, ids[1]);
    }

    #[test]
    fn h2_migration_cannot_drop_an_indexed_h1_admission() {
        for missing in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let record = history_fixture(dir.path(), 1, OperationState::Settled, "call_offer");
            write_call_index(dir.path(), &record).unwrap();
            std::fs::write(dir.path().join("call-index-v1"), "").unwrap();
            let path = dir.path().join(format!("ops/{}.json", record.op_id));
            if missing { std::fs::remove_file(path).unwrap(); }
            else { std::fs::write(path, "broken").unwrap(); }
            initialize_history(dir.path()).unwrap();
            let journal = Journal::open(dir.path()).unwrap();
            let error = journal.call_operations("node", Some("peer")).unwrap_err();
            assert_eq!(error.code, "spend_unknown");
            // A damaged call does not alter the ordinary message path.
            let body = json!({"recipient":"other", "kind":1, "plaintext":"hello"});
            journal.begin_operation("node", "/messages/compose", &body, 2000,
                Some((new_operation_id().unwrap(), operation(&body)))).unwrap();
        }
    }

    #[test]
    fn h2_call_index_migrates_h1_and_repairs_pending_membership() {
        let dir = tempfile::tempdir().unwrap();
        let offer = history_fixture(dir.path(), 1, OperationState::Settled, "call_offer");
        std::fs::write(dir.path().join("call-index-v1"), "").unwrap();
        std::fs::write(dir.path().join("ops/unrelated.json"), "broken").unwrap();
        initialize_history(dir.path()).unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        let calls = journal.call_operations("node", Some("peer")).unwrap();
        assert_eq!(calls.len(), 1);
        assert!(admission_open(&offer, &calls));
        assert!(journal.call_operations("other", None).unwrap().is_empty());
        let body = json!({"recipient":"peer", "kind":403, "plaintext":r#"{"call_id":"0123456789abcdef0123456789abcdef"}"#});
        let p = journal.begin_operation("node", "/messages/compose", &body, 2000,
            Some((new_operation_id().unwrap(), operation(&body)))).unwrap();
        std::fs::remove_dir_all(dir.path().join("call-ops")).unwrap();
        drop(journal);
        let journal = Journal::open(dir.path()).unwrap();
        journal.pending().unwrap();
        let calls = journal.call_operations("node", Some("peer")).unwrap();
        assert!(calls.iter().any(|r| Some(&r.op_id) == p.operation_id.as_ref()));
        journal.record_outcome(&p, OperationState::Unpaid, Some(&json!({"reason":"call_not_live"}))).unwrap();
        journal.clear().unwrap();
        let calls = journal.call_operations("node", Some("peer")).unwrap();
        assert!(!admission_open(&offer, &calls));
        assert_eq!(calls[0].paid_msat, Some(0));
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
            target:Some(Target::Payment { hash:"abc".into() }), over_budget:false, accounting_msat: None, evidence_reservation_msat: None, failure_final_on: None, paid: None, undelivered: None, charge_id: None, budgeted: false, all_in: false, operation_id: None, dispatched_at: None, op: None, peer: None, resumable: false, non_dispatch_proven: false, admission_resume: false, compose_fee_msat: None, operation_record: None, direct: None, unpaid_release: None };
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
            target:Some(Target::Message { id:"abc".into(), peer:"peer".into() }), over_budget:false, accounting_msat: None, evidence_reservation_msat: None, failure_final_on: None, paid: None, undelivered: None, charge_id: None, budgeted: false, all_in: false, operation_id: None, dispatched_at: None, op: None, peer: None, resumable: false, non_dispatch_proven: false, admission_resume: false, compose_fee_msat: None, operation_record: None, direct: None, unpaid_release: None };
        let mut row = json!({"id":"abc", "sender":"other", "recipient":"peer", "payment_amount_msat":2000});
        assert_eq!(terminal(&p, &[row.clone()]), None);
        row["sender"] = json!("node");
        assert_eq!(terminal(&p, &[row.clone()]), Some("settled"));
        row["recipient"] = json!("other");
        assert_eq!(terminal(&p, &[row]), None);
    }
}
