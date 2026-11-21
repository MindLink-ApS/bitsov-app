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
    getrandom::getrandom(&mut b).map_err(unknown)?;
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
    match std::fs::read(dir.join("spend-pending.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(unknown),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && absent(&dir.join("spend-pending.json")) => Ok(None),
        Err(e) => Err(unknown(e)),
    }
}

/// The OS lock also serializes two app processes. A crash releases the lock,
/// but leaves the pending record. No approval, token, invoice or plaintext is saved.
pub struct Journal {
    _lock: File,
    // Serialize call-index updates with the one-time history migration.
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
        crate::act::with_op(Active(operation_id.as_deref()), (|| {
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
        })())
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

    pub fn operation_record(&self, id: &str) -> Result<Option<OperationRecord>, ActionError> {
        read_operation(&self.operation_path(id)?, Some(id))
    }

    fn call_parent(&self, node_id: &str, peer: &str, call: &str) -> Result<Option<String>, ActionError> {
        Ok(read_call_admission(&self.dir, node_id, peer, call)?.map(|r| r.op_id))
    }

    /// Update exactly the captured admission; never resolve a reused call id
    /// again after waiting for the money lock. This does not settle payment.
    pub fn observe_call(&self, offer: &OperationRecord, ended: bool) -> Result<(), ActionError> {
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
        if index_id.len() != 64 || !index_id.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()) {
            return Err(ActionError::invalid("invalid call index id"));
        }
        let filename = format!("{index_id}.json");
        let path = self.dir.join("call-index").join(&filename);
        if !path.exists() && !self.dir.join("call-index-unresolved").join(&filename).exists() {
            return Err(damaged_record());
        }
        let index = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice::<CallIndex>(&b).ok());
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
                std::fs::create_dir_all(marker.parent().unwrap()).map_err(unknown)?;
                File::create(&marker).and_then(|f| f.sync_all()).map_err(unknown)?;
                File::open(marker.parent().unwrap()).and_then(|f| f.sync_all()).map_err(unknown)?;
                self.write_operation(&record)?;
                // Keep the owner-visible repair entry across restart until
                // actual closure evidence exists. Repair is not closure.
                let records = self.call_operations_for(node_id, Some(&record.peer), record.call_id.as_deref())?;
                let ambiguous_unpaid = record.state == OperationState::Unpaid && read_pending(&self.dir)?
                    .is_some_and(|p| p.operation_id.as_deref() == Some(record.op_id.as_str()) && !p.non_dispatch_proven);
                if !admission_open(&record, &records) && !ambiguous_unpaid {
                    std::fs::remove_file(&marker).map_err(unknown)?;
                    File::open(marker.parent().unwrap()).and_then(|f| f.sync_all()).map_err(unknown)?;
                }
                return Ok(record.call_id);
            }
        }
        let ack = self.dir.join("call-index-acknowledged").join(blake3::hash(node_id.as_bytes()).to_hex().as_str());
        std::fs::create_dir_all(&ack).map_err(unknown)?;
        File::create(ack.join(filename)).and_then(|f| f.sync_all()).map_err(unknown)?;
        File::open(ack).and_then(|f| f.sync_all()).map_err(unknown)?;
        Ok(None)
    }

    /// Call-only index, scoped to the authenticated node and optionally peer.
    /// Never use the capped/read-only op_list as an admission authority.
    pub fn call_operations(&self, node_id: &str, peer: Option<&str>) -> Result<Vec<OperationRecord>, ActionError> {
        self.call_operations_for(node_id, peer, None)
    }

    pub fn call_operations_for(&self, node_id: &str, peer: Option<&str>, call: Option<&str>) -> Result<Vec<OperationRecord>, ActionError> {
        // An H1 index may outlive its damaged offer. Its hashed key cannot tell
        // us the peer, so preserve the evidence and fail closed for calls only.
        for entry in read_entries(&self.dir.join("call-index-unresolved"))? {
            let bytes = std::fs::read(self.dir.join("call-index").join(entry.file_name())).map_err(|_| damaged_record())?;
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
            None => read_entries(&root)?.into_iter().map(|e| e.path()).collect(),
        };
        let mut records = Vec::new();
        for dir in directories {
            let calls = match call {
                Some(call) => vec![dir.join(blake3::hash(call.as_bytes()).to_hex().as_str())],
                None => read_entries(&dir)?.into_iter().map(|e| e.path()).collect(),
            };
            for directory in calls {
                for entry in read_entries(&directory)? {
                    let id = entry.file_name().to_string_lossy().into_owned();
                    let record = crate::act::with_op(Active(Some(&id)),
                        self.operation_record(&id).and_then(|r| r.ok_or_else(damaged_record)))?;
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

    fn sync_dir(&self) -> Result<(), ActionError> {
        #[cfg(unix)] File::open(&self.dir).and_then(|f| f.sync_all()).map_err(unknown)?;
        Ok(())
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

fn damaged_record() -> ActionError {
    // Do not log parser errors: they can contain bytes from a damaged record.
    eprintln!("spend ledger: required operation record or call index is missing, unreadable, or invalid");
    damaged_record_error()
}

/// The `damaged_record` error without its log line, for a failure already logged.
fn damaged_record_error() -> ActionError {
    unknown("Required operation record or call index is missing, unreadable, or invalid.")
}

fn read_operation(path: &Path, expected_id: Option<&str>) -> Result<Option<OperationRecord>, ActionError> {
    match std::fs::read(path) {
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
fn history_entries(dir: &Path) -> Result<impl Iterator<Item = std::io::Result<std::fs::DirEntry>>, ActionError> {
    match std::fs::read_dir(dir.join("ops")) {
        Ok(entries) => Ok(Some(entries).into_iter().flatten()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None.into_iter().flatten()),
        Err(e) => Err(unknown(e)),
    }
}

fn unresolved_calls(dir: &Path, node_id: &str) -> Result<Vec<UnresolvedCall>, ActionError> {
    let mut names = std::collections::BTreeSet::new();
    for folder in ["call-index", "call-index-unresolved"] {
        for entry in read_entries(&dir.join(folder))? { names.insert(entry.file_name()); }
    }
    let mut rows = Vec::new();
    for name in names {
        let Some(id) = name.to_str().and_then(|n| n.strip_suffix(".json")) else { continue };
        if id.len() != 64 || !id.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()) { continue; }
        let path = dir.join("call-index").join(&name);
        let record = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice::<CallIndex>(&b).ok())
            .filter(|i| i.op_id.len() == 36 && i.op_id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-'))
            .and_then(|i| read_operation(&dir.join("ops").join(format!("{}.json", i.op_id)), Some(&i.op_id)).ok().flatten()
                .filter(|r| r.created_ms == i.created_ms));
        let valid = record.as_ref().is_some_and(|r| matches!(r.kind.as_str(), "call_offer" | "call_recovery")
            && r.call_id.as_deref().is_some_and(|c| call_index_path(dir, &r.node_id, &r.peer, c) == path));
        if valid && !dir.join("call-index-unresolved").join(&name).exists() { continue; }
        if valid && record.as_ref().is_some_and(|r| r.node_id != node_id) { continue; }
        let hangup_cap_msat = record.as_ref().filter(|r| valid && r.node_id == node_id)
            .map(|r| r.hangup_cap_msat.unwrap_or(r.cap_msat));
        rows.push(UnresolvedCall { index_id: id.into(), hangup_cap_msat, acknowledged: dir.join("call-index-acknowledged")
            .join(blake3::hash(node_id.as_bytes()).to_hex().as_str()).join(&name).exists() });
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
        let record = match read_operation(&path, path.file_stem().and_then(|s| s.to_str())) {
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
    let entry: CallIndex = match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| damaged_record())?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && absent(&path) => return Ok(None),
        Err(_) => return Err(damaged_record()),
    };
    if entry.op_id.len() != 36 || !entry.op_id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-') {
        return Err(damaged_record());
    }
    let record = read_operation(&dir.join("ops").join(format!("{}.json", entry.op_id)), Some(&entry.op_id))?
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
    for entry in read_entries(&directory)? {
        let id = entry.file_name().to_string_lossy().into_owned();
        if id.len() != 36 || !id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-') { return Err(damaged_record()); }
        let record = read_operation(&dir.join("ops").join(format!("{id}.json")), Some(&id))?
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

fn read_entries(dir: &Path) -> Result<Vec<std::fs::DirEntry>, ActionError> {
    match std::fs::read_dir(dir) {
        Ok(entries) => entries.collect::<Result<Vec<_>, _>>().map_err(unknown),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(unknown(e)),
    }
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

#[cfg(not(unix))]
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
// Windows initializes history without the index graph (see initialize_history).
#[cfg_attr(windows, allow(dead_code))]
enum IndexSlot { Absent, Keep, Replace }

/// A call index slot that cannot be checked. Already logged by
/// `damaged_record`; the caller turns it into `damaged_record_error`.
#[cfg_attr(windows, allow(dead_code))]
struct SlotDamaged;

#[cfg_attr(windows, allow(dead_code))]
fn slot_damaged() -> SlotDamaged {
    let _ = damaged_record();
    SlotDamaged
}

/// A mapping is only replaced when it is readable and names an operation
/// record that exists and is a call admission for this same slot. A dangling
/// symlink, an unreadable file or a mapping whose record is missing or
/// damaged is evidence of an admission that cannot be checked any more:
/// refuse, and leave it in place for the owner's repair.
#[cfg_attr(windows, allow(dead_code))]
fn index_slot(dir: &Path, path: &Path, record: &OperationRecord) -> Result<IndexSlot, SlotDamaged> {
    let old: CallIndex = match std::fs::read(path) {
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
    let mapped = read_operation(&dir.join("ops").join(format!("{}.json", old.op_id)), Some(&old.op_id))
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

#[cfg(not(unix))]
#[cfg_attr(windows, allow(dead_code))]
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

#[cfg(not(unix))]
fn write_call_index(_dir: &Path, _record: &OperationRecord) -> Result<(), ActionError> {
    Err(unknown("private spend journal storage is not supported on this platform"))
}

/// One-time upgrade of pre-index H1 history, before authenticating/enabling money
/// actions. Never invoked with NodeState::money or spend.lock held. Writers and
/// migration serialize only a single index update at a time.
/// Windows: operation records and indexes cannot be written there yet, so a
/// valid history folder holds at most the migration marker. Anything else is
/// unexpected and refused as is (no reset, no write). The folder and marker
/// are private objects, and the marker is made durable with a real flush.
#[cfg(windows)]
pub fn initialize_history(dir: &Path) -> Result<(), ActionError> {
    crate::private_fs::ensure_dir(dir).map_err(unknown)?;
    let marker = dir.join("call-index-v2");
    // Checked on every start, with or without a marker.
    for entry in std::fs::read_dir(dir).map_err(unknown)? {
        if entry.map_err(unknown)?.file_name() != "call-index-v2" {
            return Err(damaged_record());
        }
    }
    if !absent(&marker) {
        return crate::private_fs::verify_file(&marker).map_err(unknown);
    }
    crate::private_fs::ensure_marker(&marker).map_err(unknown)
}

#[cfg(not(windows))]
pub fn initialize_history(dir: &Path) -> Result<(), ActionError> {
    let marker = dir.join("call-index-v2");
    if marker.exists() { return Ok(()); }
    for entry in history_entries(dir)? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if path.extension().is_none_or(|e| e != "json") { continue; }
        let Ok(Some(record)) = read_operation(&path, path.file_stem().and_then(|s| s.to_str())) else { continue };
        write_call_membership(dir, &record)?;
        if !matches!(record.kind.as_str(), "call_offer" | "call_recovery") { continue; }
        let Some(call) = record.call_id.as_deref() else { continue };
        let lock = history_lock(dir)?;
        lock.lock().map_err(unknown)?;
        // Preserve a damaged or dangling existing mapping as a fail-closed
        // marker for just this call (the scan below marks it unresolved). It
        // must not stop migration/authentication for other calls.
        let damaged = index_slot(dir, &call_index_path(dir, &record.node_id, &record.peer, call), &record).is_err();
        if damaged {
            let _ = damaged_record();
            let _ = lock.unlock();
            continue;
        }
        let result = write_call_index(dir, &record);
        let _ = lock.unlock();
        result?;
    }
    // Do not silently lose an indexed H1 admission when its record is damaged.
    // Keep unresolved references separate so normal call lookup stays scoped.
    for entry in read_entries(&dir.join("call-index"))? {
        if entry.path().extension().is_none_or(|e| e != "json") { continue; }
        let readable = std::fs::read(entry.path()).ok()
            .and_then(|bytes| serde_json::from_slice::<CallIndex>(&bytes).ok())
            .filter(|index| index.op_id.len() == 36 && index.op_id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-'))
            .and_then(|index| read_operation(&dir.join("ops").join(format!("{}.json", index.op_id)), Some(&index.op_id)).ok().flatten())
            .filter(|record| matches!(record.kind.as_str(), "call_offer" | "call_recovery")
                && record.call_id.as_deref().is_some_and(|call|
                    call_index_path(dir, &record.node_id, &record.peer, call).file_name() == Some(entry.file_name().as_os_str())));
        if readable.is_none() {
            let unresolved = dir.join("call-index-unresolved");
            std::fs::create_dir_all(&unresolved).map_err(unknown)?;
            File::create(unresolved.join(entry.file_name())).and_then(|f| f.sync_all()).map_err(unknown)?;
            File::open(unresolved).and_then(|f| f.sync_all()).map_err(unknown)?;
        }
    }
    std::fs::create_dir_all(dir).map_err(unknown)?;
    File::create(marker).and_then(|f| f.sync_all()).map_err(unknown)?;
    File::open(dir).and_then(|f| f.sync_all()).map_err(unknown)
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

#[cfg(all(test, windows))]
mod windows_history_tests {
    use super::*;
    use crate::private_fs::fixtures::*;

    #[test]
    fn a_fresh_history_gets_a_private_marker_and_restarts_cleanly() {
        if elevated() {
            return;
        }
        let dir = temp_root("history").join("app-spend");
        initialize_history(&dir).unwrap();
        crate::private_fs::verify_file(&dir.join("call-index-v2")).unwrap();
        initialize_history(&dir).unwrap();
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    }

    #[test]
    fn unexpected_or_tampered_history_is_refused_without_writes() {
        if elevated() {
            return;
        }
        let root = temp_root("history-tampered");
        // An existing marker with a widened access list.
        let dir = root.join("app-spend");
        initialize_history(&dir).unwrap();
        grant_everyone_read(&dir.join("call-index-v2"));
        assert!(initialize_history(&dir).is_err());
        // A valid marker plus any other entry: refused, nothing written.
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
        // Any history object without the marker: refused, no marker written.
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
        // Reparse point as the history folder.
        let link = root.join("link");
        junction(&link, &dir);
        assert!(initialize_history(&link).is_err());
        // Wrong owner.
        assert!(initialize_history(&foreign_owned_dir()).is_err());
    }
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
