//! Control center actions (slice B): the owner's spend window, request bodies
//! for every send, and the receipts the renderer is shown.
//!
//! # Spend authority, stated plainly
//!
//! The node decides what a token may do; this app can only narrow it.
//!
//! - **rc7 (`958e399`, the bundled sidecar):** tokens carry no scopes. The
//!   `/auth/local` token the app holds can already spend. Nothing on the node
//!   stops a send, so the only lock is this app's own [`SpendGate`].
//! - **#77 nodes (pairing):** a paired token is `read + receive`. `spend` arrives
//!   only after the app *asks* (`POST /pair/elevation-request`) and the owner
//!   confirms at their own terminal (`konsensus grant --op …` over
//!   `<data_dir>/control.sock`). No HTTP route writes a grant, and this app never
//!   touches the control socket: that separation is the node's whole mechanism.
//!   A packaged sidecar never gets `spend` at all.
//!
//! In both cases the owner's one tap in the app opens a [`SPEND_WINDOW_MS`]
//! window held in host memory. It is never written to disk, never outlives the
//! process, and never widens what the node allows. Outside the window every
//! spending or node-changing command is refused before any request is made.
//!
//! # What the renderer sees
//!
//! Receipts carry amounts, status and ids the user already knows. Preimages,
//! payment hashes and tokens are dropped here, as in `control`.

use lightning_invoice::{Bolt11Invoice, Bolt11InvoiceDescriptionRef, Currency, TaggedField};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::control::{self, KIND_CHAT};

/// `KIND_FILE_REF` (konsensus-core `kind.rs`): a file sent as a message.
pub const KIND_FILE_REF: u16 = 200;
/// 1:1 call signalling (genome kinds 400-403): offer, answer, ICE, hangup.
/// The offer is the per-call admission, paid at the callee's `call_msat`.
pub const KIND_CALL_OFFER: u16 = 400;
pub const KIND_CALL_HANGUP: u16 = 403;
/// A call signal carries SDP (genome caps it at 16 KiB) plus a small envelope.
pub const CALL_SIGNAL_MAX_BYTES: usize = 17 * 1024;

/// How long one owner approval lets this app spend.
pub const SPEND_WINDOW_MS: u64 = 10 * 60 * 1000;

/// The node floors every message payment at one sat (`compose.rs`).
pub const MIN_PAYMENT_MSAT: u64 = 1_000;

/// `/payments/invoice` and `/payments/keysend` upper bound (1 BTC).
pub const MAX_PAYMENT_MSAT: u64 = 100_000_000_000;

/// The node accepts 4 MiB per file, but axum's default 2 MB request limit caps
/// the base64 JSON body first. Stay under it rather than meet a bare 413.
pub const FILE_MAX_BYTES: usize = 1_400_000;

/// `compose` refuses plaintext over 1 MiB.
pub const PLAINTEXT_MAX_BYTES: usize = 1 << 20;

/// `description` limit on `/payments/invoice`.
pub const INVOICE_NOTE_MAX_BYTES: usize = 639;

/// `/invites` refuses an expiry more than 30 days out.
pub const INVITE_MAX_HOURS: u64 = 30 * 24;

/// Rooms are scoped to already-connected peers, and the node refuses more.
pub const ROOM_MAX_MEMBERS: usize = 256;

/// The app's ordinary per-payment routing ceiling. Sent explicitly to the node,
/// which may tighten it further; it never grants more routing authority.
pub fn routing_fee(principal: u64) -> u64 {
    if principal == 0 { 0 } else { (principal / 100).clamp(5_000, 10_000) }
}

/// The supervised node's ordinary routing policy (genome dac01c8).
/// This computes a display allowance; compose still enforces policy and caps.
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(default, deny_unknown_fields)]
pub struct RoutingFeePolicy {
    pub minimum_msat: u64,
    pub proportional_millionths: u64,
    pub maximum_msat: u64,
}

impl Default for RoutingFeePolicy {
    fn default() -> Self {
        Self { minimum_msat: 5000, proportional_millionths: 10_000, maximum_msat: 10_000 }
    }
}

impl RoutingFeePolicy {
    pub fn ceiling(self, principal: u64) -> u64 {
        if principal == 0 { return 0; }
        let proportional = (u128::from(principal) * u128::from(self.proportional_millionths) / 1_000_000)
            .min(u128::from(u64::MAX)) as u64;
        proportional.max(self.minimum_msat).min(self.maximum_msat)
    }
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct PaymentQuote {
    pub principal_msat: u64,
    pub max_routing_fee_msat: u64,
    pub total_msat: u64,
}

pub fn payment_quote(principal_msat: u64) -> Result<PaymentQuote, ActionError> {
    let max_routing_fee_msat = routing_fee(principal_msat);
    let total_msat = principal_msat.checked_add(max_routing_fee_msat)
        .ok_or_else(|| ActionError::invalid("The all-in amount overflows."))?;
    Ok(PaymentQuote { principal_msat, max_routing_fee_msat, total_msat })
}

// ---- errors -------------------------------------------------------------------

/// A refused or failed action. `code` lets the renderer react (re-prompt for
/// approval, name the unreachable members); `message` is shown as written.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct ActionError {
    pub code: &'static str,
    pub message: String,
    /// `payment_settled_undelivered` only: what was paid, and whether a retry is offered.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub undelivered: Option<UndeliveredView>,
    /// `retry_needs_admission` / `readmission_quoted`: the price the owner
    /// approves before a send or retry that may pay admission again.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub admission: Option<AdmissionView>,
    /// `payment_settled_undelivered` / `undelivered_pending`: the durable
    /// record's id. Stop retrying names it, so it never releases another one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_id: Option<String>,
}

/// Paid, not delivered, as the conversation shows it.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct UndeliveredView {
    /// Everything the node reported settled for this message, retries included.
    pub paid_msat: u64,
    /// The node said a retry re-sends its paid proof rather than paying again.
    pub retry: bool,
}

/// Admission may be due again (the node reconnected): its price and the
/// message's, for the owner's approval. Nothing has been paid for it.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct AdmissionView {
    pub admission_msat: u64,
    pub message_msat: u64,
    pub max_routing_fee_msat: u64,
    /// The cap the owner approves: admission, message and maximum routing fees.
    pub total_msat: u64,
    /// The contact's own signed quote; false: an estimate from what was paid before.
    pub quoted: bool,
}

pub const MONEY_NOT_READY: &str = "Money is not ready yet. Your node will retry automatically.";

/// Only this explicit pre-dispatch refusal may release a pending spend.
/// A generic 503 (or a broken response) still has an unknown outcome.
pub fn readiness_refusal(status: u16, body: &str) -> bool {
    status == 503 && serde_json::from_str::<serde_json::Value>(body).ok()
        .is_some_and(|v| v["code"] == "not_ready" && v["money_ready"] == false)
}

/// Genome #115: HTTP 400 with `code: "not_dispatched"` means the node proved
/// no payment left the wallet. Only that exact code may clear the spend journal;
/// any other 400 stays unknown.
pub fn not_dispatched_refusal(status: u16, body: &str) -> bool {
    status == 400
        && serde_json::from_str::<serde_json::Value>(body)
            .ok()
            .is_some_and(|v| v["code"] == "not_dispatched")
}

/// Genome `readmit_then_pay` (compose.rs): after a reconnect or restart the
/// recipient asks for admission again, and the node refuses to pay it under
/// any confirmed cap (quoted capped re-admission, genome #111, was closed
/// fail-closed). That `409 price_cap_exceeded` is not a changed price: a fresh
/// quote under the same cap is refused the same way.
///
/// Genome names it with `reason: "readmission_required"`; when a node sends a
/// `reason`, it decides. Older nodes send none, so their English wording is the
/// fallback.
pub fn readmission_capped_refusal(status: u16, body: &str) -> bool {
    status == 409
        && serde_json::from_str::<serde_json::Value>(body).ok().is_some_and(|v| {
            v["code"] == "price_cap_exceeded"
                && match v.get("reason") {
                    Some(reason) => reason == READMISSION_REQUIRED,
                    None => v["error"].as_str().is_some_and(|e| e.contains("requires admission again on a new connection")),
                }
        })
}

/// Genome's stable `reason` for the capped re-admission refusal.
pub const READMISSION_REQUIRED: &str = "readmission_required";

pub const READMISSION_CAPPED: &str = "Not sent - nothing was paid. This contact asks your node to pay their admission again (every reconnect or node restart starts unpaid), and your node cannot pay that under the app's all-in cap yet. The app will not retry; sending the same message again reuses its operation, so it can never be paid twice.";

/// Genome `quoted_readmission_v1` (#111 revived): under a cap that fits the
/// contact's fresh signed quote the node pays admission again once for this
/// connection, then the message. Nodes without it refuse any capped re-admission.
pub const QUOTED_READMISSION_CAPABILITY: &str = "quoted_readmission_v1";

pub const READMISSION_CAPPED_RETRY: &str = "Not delivered - nothing new was paid. This contact asks your node to pay their admission again (every reconnect or node restart starts unpaid), and your node cannot pay that under an app cap yet. The paid message stays here; retry later, or stop retrying.";

/// Neutral proven-non-dispatch copy. Fee-limit wording is added only when the
/// node's reason identifies a route/fee ceiling (see [`not_dispatched_message`]).
pub const NOT_DISPATCHED_MESSAGE: &str = "Not sent - nothing was paid.";

const NOT_DISPATCHED_FEE_LIMIT: &str = "Network fee would exceed your limit.";

/// Build user-facing copy from a `not_dispatched` body. Always starts from
/// [`NOT_DISPATCHED_MESSAGE`]; appends the node `error` when present; mentions
/// the network fee limit only when that reason points at a fee/route ceiling.
pub fn not_dispatched_message(body: &str) -> String {
    let reason = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| {
            v.get("error")
                .and_then(|e| e.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        });
    match reason.as_deref() {
        Some(r) if not_dispatched_fee_limit_reason(r) => {
            format!("{NOT_DISPATCHED_MESSAGE} {NOT_DISPATCHED_FEE_LIMIT} ({r})")
        }
        Some(r) => format!("{NOT_DISPATCHED_MESSAGE} {r}"),
        None => NOT_DISPATCHED_MESSAGE.to_string(),
    }
}

fn not_dispatched_fee_limit_reason(reason: &str) -> bool {
    let lower = reason.to_ascii_lowercase();
    lower.contains("fee ceiling")
        || lower.contains("routing fee")
        || lower.contains("route fee")
        || (lower.contains("fee") && lower.contains("exceed"))
}

impl ActionError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            undelivered: None,
            admission: None,
            pending_id: None,
        }
    }
    /// Name the durable record this error is about.
    pub fn for_pending(self, id: &str) -> Self {
        Self { pending_id: Some(id.to_string()), ..self }
    }
    /// The node settled payment but the message did not go. Never "not sent".
    pub fn undelivered(paid_msat: u64, retry: bool) -> Self {
        let next = if retry {
            "Do not send it again. Retry delivery pays nothing new: your node re-sends the proof it already paid for. If anything is still due (this message's price, or admission again after a reconnect), it stops before paying and asks you first, with the price."
        } else {
            "Do not send it again: that could pay twice. Check the pending result first."
        };
        Self {
            undelivered: Some(UndeliveredView { paid_msat, retry }),
            ..Self::new("payment_settled_undelivered", format!("Payment settled ({paid_msat} msat paid), message not yet delivered. {next}"))
        }
    }
    /// Retry delivery paid nothing new; a payment is still due (the message,
    /// and admission again if the contact reconnected). The owner approves it.
    pub fn needs_admission(view: Option<AdmissionView>) -> Self {
        let price = match view {
            Some(v) if v.quoted => format!(" Their price: {} msat to be admitted again, then {} msat for this message, plus up to {} msat in network fees ({} msat in all). If your node is still admitted, it pays only the message and its network fee.", v.admission_msat, v.message_msat, v.max_routing_fee_msat, v.total_msat),
            Some(v) => format!(" About {} msat to be admitted again (what it cost before), then {} msat for this message: up to {} msat.", v.admission_msat, v.message_msat, v.total_msat),
            None => " Your node could not tell the price.".into(),
        };
        Self {
            admission: view,
            ..Self::new("retry_needs_admission", format!("Retry delivery paid nothing new. Delivering the message needs a new payment: its price, and admission again if the contact reconnected. Nothing was paid.{price} Approve it to continue, or stop retrying."))
        }
    }
    /// The contact asks for admission again after a reconnect or restart and
    /// its signed quote does not fit this send's cap or the contact's budget.
    /// Nothing was paid; the owner approves the all-in price once.
    pub fn readmission_quoted(view: AdmissionView) -> Self {
        Self {
            admission: Some(view),
            ..Self::new("readmission_quoted", format!(
                "Not sent - nothing was paid. This contact asks for admission again (every reconnect or node restart starts unpaid): {} msat to be admitted again, then {} msat for this message, plus up to {} msat in network fees ({} msat in all). Send again to pay it; the same message keeps its operation, so it is never paid twice.",
                view.admission_msat, view.message_msat, view.max_routing_fee_msat, view.total_msat,
            ))
        }
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid", message)
    }
    pub fn node(message: impl Into<String>) -> Self {
        let message = message.into();
        if message == MONEY_NOT_READY { Self::new("not_ready", message) }
        else { Self::new("node", message) }
    }
}

impl From<String> for ActionError {
    fn from(message: String) -> Self {
        Self::node(message)
    }
}

impl std::fmt::Display for ActionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

// ---- spend window -------------------------------------------------------------

/// Where the authority behind an open window comes from.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SpendBasis {
    /// rc7: the node does not scope tokens; the window is this app's own lock.
    AppLock,
    /// A paired token carrying an owner-written `spend` grant.
    NodeGrant,
}

/// A pending `POST /pair/elevation-request`. Deserialize: restored from the
/// app's private approvals file after a restart.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Elevation {
    pub op_id: String,
    /// Unix ms after which the owner can no longer confirm it.
    pub expires_at_ms: u64,
    /// The node's own words for what the owner must do. Shown verbatim.
    pub owner_action: String,
    /// False when the node says no owner control socket exists (a sidecar):
    /// the request can never be granted there.
    pub owner_can_grant: bool,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SpendState {
    /// Never approved in this run, or locked by the owner.
    Locked,
    /// Asked the node; waiting for the owner's typed confirmation.
    Pending,
    /// Asked, but this deployment has no owner channel: it cannot be granted.
    Unavailable,
    Open,
    /// A window or a request ran out. The owner must approve again.
    Expired,
}

/// Why a pending request ended without a grant.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Lapse {
    /// Its window closed before the owner approved it.
    Expired,
    /// The node can no longer approve it: it restarted after the request was
    /// made (the owner code lived only in its memory), wrong codes cancelled
    /// it, or it no longer knows the request at all.
    Lost,
}

impl Lapse {
    /// `GET /pair/elevation/:op_id` → `status`, when the request is over.
    pub fn from_status(status: &str) -> Option<Self> {
        match status {
            "expired" => Some(Self::Expired),
            "lost" | "absent" => Some(Self::Lost),
            _ => None,
        }
    }
}

/// What the renderer is told about spending. No token, no scope list.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct SpendView {
    pub state: SpendState,
    /// Set when the last request ended without a grant: the owner can ask again.
    pub lapse: Option<Lapse>,
    pub basis: Option<SpendBasis>,
    pub open_until_ms: Option<u64>,
    pub pending: Option<Elevation>,
    pub window_ms: u64,
}

/// The owner's short-lived spend window. Host memory only.
#[derive(Default, Debug)]
pub struct SpendGate {
    generation: u64,
    open: Option<(u64, SpendBasis)>,
    pending: Option<Elevation>,
    expired: bool,
    lapse: Option<Lapse>,
}

impl SpendGate {
    /// Open the window for [`SPEND_WINDOW_MS`] from `now_ms`.
    pub fn arm(&mut self, now_ms: u64, basis: SpendBasis) {
        self.arm_until(now_ms, u64::MAX, basis);
    }

    /// Open the window, but never past `until_ms` (a G1 node grant's expiry).
    pub fn arm_until(&mut self, now_ms: u64, until_ms: u64, basis: SpendBasis) {
        self.generation = self.generation.wrapping_add(1);
        self.open = Some(((now_ms + SPEND_WINDOW_MS).min(until_ms), basis));
        self.pending = None;
        self.expired = false;
        self.lapse = None;
    }

    /// The owner locked spending, or the app lost its authority.
    pub fn lock(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.open = None;
        self.pending = None;
        self.expired = false;
        self.lapse = None;
    }

    pub fn set_pending(&mut self, elevation: Elevation) {
        self.generation = self.generation.wrapping_add(1);
        self.open = None;
        self.expired = false;
        self.lapse = None;
        self.pending = Some(elevation);
    }

    pub fn pending(&self) -> Option<&Elevation> {
        self.pending.as_ref()
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// A reply may change authority only while its exact request is still live.
    pub fn matches_poll(&mut self, generation: u64, pending: &Elevation, now_ms: u64) -> bool {
        self.settle(now_ms);
        self.generation == generation
            && self.pending.as_ref() == Some(pending)
            && pending.expires_at_ms > now_ms
    }

    pub fn check_generation(&mut self, generation: u64, now_ms: u64) -> Result<(), ActionError> {
        self.check(now_ms)?;
        if self.generation != generation {
            return Err(ActionError::new("spend_locked", "Approval changed while preparing this action. Confirm it again."));
        }
        Ok(())
    }

    /// The owner's grant arrived for something other than this window (a budget
    /// approval): the request is answered, and the window stays closed.
    pub fn clear_pending(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.pending = None;
        self.expired = false;
        self.lapse = None;
    }

    /// The owner's request lapsed on the node; the owner may ask again.
    pub fn pending_expired(&mut self, lapse: Lapse) {
        self.generation = self.generation.wrapping_add(1);
        self.pending = None;
        self.expired = true;
        self.lapse = Some(lapse);
    }

    fn settle(&mut self, now_ms: u64) {
        if let Some((until, _)) = self.open {
            if until <= now_ms {
                self.generation = self.generation.wrapping_add(1);
                self.open = None;
                self.expired = true;
                self.lapse = None;
            }
        }
        if let Some(p) = &self.pending {
            if p.expires_at_ms <= now_ms {
                // A request this node could never grant (a sidecar) offers no Ask again.
                let lapse = p.owner_can_grant.then_some(Lapse::Expired);
                self.generation = self.generation.wrapping_add(1);
                self.pending = None;
                self.expired = true;
                self.lapse = lapse;
            }
        }
    }

    /// Ok while the window is open. Checked before any spending request.
    pub fn check(&mut self, now_ms: u64) -> Result<SpendBasis, ActionError> {
        self.settle(now_ms);
        match (self.open, self.expired) {
            (Some((_, basis)), _) => Ok(basis),
            (None, true) => Err(ActionError::new(
                "spend_expired",
                "Your spending approval has expired. Approve again to send.",
            )),
            (None, false) => Err(ActionError::new(
                "spend_locked",
                "Sending spends from your node. Approve spending first.",
            )),
        }
    }

    /// The node answered 403 for a spending call: whatever the app believed,
    /// the token cannot spend. Lock, and say so.
    pub fn refused(&mut self) -> ActionError {
        self.lock();
        ActionError::new(
            "spend_refused",
            "Your node refused: this app's token cannot spend. Spending needs an owner grant on a node you run yourself.",
        )
    }

    pub fn view(&mut self, now_ms: u64) -> SpendView {
        self.settle(now_ms);
        let state = match (&self.open, &self.pending) {
            (Some(_), _) => SpendState::Open,
            (None, Some(p)) if p.owner_can_grant => SpendState::Pending,
            (None, Some(_)) => SpendState::Unavailable,
            (None, None) if self.expired => SpendState::Expired,
            (None, None) => SpendState::Locked,
        };
        SpendView {
            state,
            lapse: if state == SpendState::Expired { self.lapse } else { None },
            basis: self.open.map(|(_, b)| b),
            open_until_ms: self.open.map(|(u, _)| u),
            pending: self.pending.clone(),
            window_ms: SPEND_WINDOW_MS,
        }
    }
}

/// `POST /pair/elevation-request` response.
#[derive(Deserialize, Debug)]
pub struct ElevationReply {
    pub op_id: String,
    /// Unix seconds.
    pub expires_at: i64,
    pub owner_action: String,
}

impl ElevationReply {
    /// `owner_config` is the node's `konsensus.toml` when this app knows it
    /// (the node it launched, or an attached external node). A node that names
    /// no config in its command gets it appended, so the owner can run the
    /// command from any directory.
    pub fn into_elevation(self, owner_config: Option<&std::path::Path>) -> Result<Elevation, ActionError> {
        if self.op_id.is_empty() || self.op_id.len() > 64 || !self.op_id.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(ActionError::node("the node returned an unexpected operation id"));
        }
        let owner_can_grant = self.owner_action.trim_start().starts_with("konsensus grant");
        let mut owner_action = self.owner_action;
        if owner_action.trim() == format!("konsensus grant --op {}", self.op_id) {
            if let Some(path) = owner_config.and_then(config_arg) {
                owner_action = format!("{} --config {path}", owner_action.trim());
            }
        }
        Ok(Elevation {
            op_id: self.op_id,
            expires_at_ms: (self.expires_at.max(0) as u64).saturating_mul(1000),
            owner_action: owner_action.chars().take(600).collect(),
            owner_can_grant,
        })
    }
}

/// An absolute config path, single-quoted for a shell. None for a relative or
/// overlong path, or one with characters no owner should be asked to paste. A
/// quote or backslash is refused rather than escaped: no escape is safe in
/// every shell (fish reads `\'` inside single quotes).
fn config_arg(path: &std::path::Path) -> Option<String> {
    let text = path.to_str()?;
    if !path.is_absolute()
        || text.len() > 400
        || text.chars().any(|c| {
            c.is_control()
                || c == '\'' || c == '\\'
                || matches!(c, '\u{00AD}' | '\u{061C}' | '\u{180E}' | '\u{200B}'..='\u{200F}' | '\u{2028}'..='\u{202E}' | '\u{2060}'..='\u{2069}' | '\u{FEFF}')
        })
    {
        return None;
    }
    Some(format!("'{text}'"))
}

/// `GET /pair/elevation/:op_id` → `status`.
#[derive(Deserialize, Debug)]
pub struct ElevationStatusReply {
    pub status: String,
}

pub fn elevation_status_path(op_id: &str) -> Result<String, ActionError> {
    if op_id.is_empty() || op_id.len() > 64 || !op_id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ActionError::invalid("unexpected operation id"));
    }
    Ok(format!("/pair/elevation/{op_id}"))
}

// ---- messages ---------------------------------------------------------------

/// `POST /messages/compose` body. The node does E2EE, pricing, payment and,
/// for an unknown peer, the paid first contact. The app never builds or
/// delivers an envelope itself (authority invariant A.1).
pub fn compose_body(recipient: &str, is_room: bool, plaintext: &str) -> Result<serde_json::Value, ActionError> {
    let recipient = if is_room {
        control::room_id(recipient).map_err(ActionError::invalid)?
    } else {
        control::node_id(recipient).map_err(ActionError::invalid)?
    };
    if plaintext.trim().is_empty() {
        return Err(ActionError::invalid("the message is empty"));
    }
    if plaintext.len() > PLAINTEXT_MAX_BYTES {
        return Err(ActionError::invalid("the message is larger than 1 MiB"));
    }
    Ok(json!({
        "recipient": recipient,
        "is_room": is_room,
        "kind": KIND_CHAT,
        "plaintext": plaintext,
    }))
}

/// `/messages/compose` body for one call signal to one contact. The node
/// checks the payload and the call state again before paying.
pub fn call_body(recipient: &str, kind: u16, plaintext: &str) -> Result<serde_json::Value, ActionError> {
    let recipient = control::node_id(recipient).map_err(ActionError::invalid)?;
    if !(KIND_CALL_OFFER..=KIND_CALL_HANGUP).contains(&kind) {
        return Err(ActionError::invalid("not a call signal"));
    }
    let v: serde_json::Value = serde_json::from_str(plaintext).map_err(|_| ActionError::invalid("the call signal is not JSON"))?;
    if !v.is_object() || plaintext.len() > CALL_SIGNAL_MAX_BYTES {
        return Err(ActionError::invalid("the call signal is too large"));
    }
    Ok(json!({ "recipient": recipient, "is_room": false, "kind": kind, "plaintext": plaintext }))
}

/// What one paid call signal cost.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct CallReceipt {
    pub message_id: String,
    pub kind: u16,
    pub amount_msat: u64,
    pub total_msat: u64,
    pub max_routing_fee_msat: u64,
    pub delivered: bool,
    pub accepted: bool,
    pub sent_at_ms: u64,
}

/// `compose` and `files/:id/send` response, and `GET /messages/operations/{id}`.
#[derive(Deserialize, Debug)]
pub struct SendReply {
    #[serde(default)]
    pub max_routing_fee_msat: u64,
    #[serde(default)]
    pub message_id: String,
    pub delivered: bool,
    pub amount_msat: u64,
    /// Admission paid again during this send after a reconnect (genome #85).
    #[serde(default)]
    pub readmission_msat: Option<u64>,
    /// `message_operations_v1`: the node's idempotency key, echoed.
    #[serde(default)]
    pub operation_id: Option<String>,
    /// The operation's state (`acked`, `sent`, `paid`, ...). Older nodes omit it.
    #[serde(default)]
    pub state: Option<String>,
    /// The recipient's node stored it (`acked`).
    #[serde(default)]
    pub accepted: bool,
    #[serde(default)]
    pub payment_hash: Option<String>,
    #[serde(default)]
    pub retry_allowed: bool,
}

/// The operation fields genome adds to an error body (`ApiError::Operation`)
/// or a 409 `OperationConflict`: `{code, state, operation_id, retry_allowed}`.
#[derive(Deserialize, Debug, Default, Clone, PartialEq, Eq)]
pub struct OperationError {
    #[serde(default)]
    pub code: serde_json::Value,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub operation_id: Option<String>,
    #[serde(default)]
    pub payment_hash: Option<String>,
    #[serde(default)]
    pub retry_allowed: bool,
}

/// The error body's operation fields, only when they name `operation_id`.
pub fn operation_error(body: &str, operation_id: &str) -> Option<OperationError> {
    let e: OperationError = serde_json::from_str(body).ok()?;
    (e.operation_id.as_deref() == Some(operation_id)).then_some(e)
}

/// 409 codes the node answers for an operation before it pays anything in this call.
pub fn operation_conflict(status: u16, body: &str) -> Option<&'static str> {
    if status != 409 { return None; }
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    ["operation_mismatch", "payment_unresolved", "failed_paid"].into_iter().find(|c| v["code"] == *c)
}

pub const OPERATION_MISMATCH: &str = "Your node refused this retry: its text differs from the message it retries. Nothing was paid. Retry with the original text, or send it as a new message once the earlier one is resolved.";
pub const PAYMENT_UNKNOWN: &str = "Payment unknown: your node has not resolved whether this message's payment went through. It will not pay for it again, and the app will not resend it. Check the pending result later.";
pub const FAILED_PAID: &str = "Paid, and the recipient's node refused this message for good. The payment is not refundable. Do not send it again.";

/// `502 payment_settled_send_incomplete` from compose: the node paid, the
/// message did not go. The prior/current admission amounts are read from the
/// node's reason when it gives them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettledIncomplete {
    pub amount_msat: u64,
    pub prior_admission_msat: Option<u64>,
    pub current_call_msat: Option<u64>,
    /// The node itself says a retry re-sends the held proof and pays no second
    /// admission (genome #100: same connection only; a new one pays again).
    pub retry_safe: bool,
}

/// The node's own statements that a retry pays no second admission. Anything
/// else (a message paid, then not stored) must not be sent again.
const RETRY_SAFE: [&str; 2] = ["will not pay admission again", "re-send the paid proof, not pay again"];

pub fn settled_incomplete(status: u16, body: &str) -> Option<SettledIncomplete> {
    if status != 502 { return None; }
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    if v["code"] != "payment_settled_send_incomplete" { return None; }
    let amount_msat = v["amount_msat"].as_u64()?;
    let reason = v["error"].as_str().unwrap_or_default();
    let prior_admission_msat = msat_after(reason, "prior admission: ");
    let current_call_msat = msat_after(reason, "current call: ");
    let lower = reason.to_ascii_lowercase();
    let retry_safe = prior_admission_msat.is_some() && current_call_msat == Some(amount_msat)
        && RETRY_SAFE.iter().any(|s| lower.contains(s));
    Some(SettledIncomplete { amount_msat, prior_admission_msat, current_call_msat, retry_safe })
}

fn msat_after(reason: &str, key: &str) -> Option<u64> {
    let rest = &reason[reason.find(key)? + key.len()..];
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    rest[digits..].starts_with(" msat").then(|| rest[..digits].parse().ok()).flatten()
}

impl SendReply {
    pub fn total_msat(&self) -> Result<u64, ActionError> {
        self.amount_msat.checked_add(self.readmission_msat.unwrap_or(0))
            .and_then(|v| v.checked_add(self.max_routing_fee_msat))
            .ok_or_else(|| ActionError::new("spend_unknown", "The reported all-in total overflows."))
    }
}

/// What a send shows in the stream, straight after it returns.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct SendReceipt {
    pub total_msat: u64,
    pub max_routing_fee_msat: u64,
    pub message_id: String,
    pub recipient: String,
    pub is_room: bool,
    /// Handed to the recipient's node now; `false` means queued.
    pub delivered: bool,
    /// What this send actually paid, summed over room members.
    pub amount_msat: u64,
    pub sent_at_ms: u64,
    /// The node's idempotency key for this send, when it has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    /// The operation's state from the node (`acked`, `sent`, `paid`, ...).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    /// The recipient's node stored it. `delivered` alone is only a transport write.
    pub accepted: bool,
    /// Admission paid again in this send after a reconnect, msat. Part of
    /// `total_msat`; `amount_msat` stays the message alone.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub readmission_msat: Option<u64>,
}

/// Validate complete, unique per-member evidence against the confirmed room.
/// Returns (all terminal, any incomplete message); malformed evidence remains ambiguous.
pub fn room_result(reply: &serde_json::Value, request: &serde_json::Value, max: u64) -> Result<(bool, bool), ActionError> {
    let unknown = || ActionError::new("spend_unknown", "Room outcome missing or inconsistent; do not retry.");
    let caps = request["max_recipient_msat"].as_object().ok_or_else(unknown)?;
    let rows = reply["member_outcomes"].as_array().ok_or_else(unknown)?;
    if rows.len() != caps.len() || caps.is_empty() { return Err(unknown()); }
    let mut seen = std::collections::HashSet::new();
    let (mut total, mut terminal, mut refused) = (0u64, true, false);
    for row in rows {
        let peer = row["recipient"].as_str().ok_or_else(unknown)?;
        let cap = caps.get(peer).and_then(|v| v.as_u64()).ok_or_else(unknown)?;
        let amount = row["amount_msat"].as_u64().ok_or_else(unknown)?;
        if !seen.insert(peer) || amount > cap { return Err(unknown()); }
        total = total.checked_add(amount).ok_or_else(unknown)?;
        match row["status"].as_str() {
            Some("settled") => {
                // A terminal payment is not proof that its message was stored.
                if row["message_id"].as_str().is_none_or(str::is_empty) { refused = true; }
            },
            Some("refused") if amount == 0 => refused = true,
            Some("unknown" | "pending") => terminal = false,
            _ => return Err(unknown()),
        }
    }
    if total > max || reply["amount_msat"].as_u64() != Some(total) { return Err(unknown()); }
    Ok((terminal, refused))
}

// ---- rooms --------------------------------------------------------------------

/// One room member's share of a room message.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct MemberCost {
    pub max_routing_fee_msat: u64,
    pub node_id: String,
    pub msat: u64,
    /// The member's own advertised price (fresh table), not this node's estimate.
    pub advertised: bool,
    pub connected: bool,
}

/// `room_quote`: a room message costs each member's own price, paid separately.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct RoomQuote {
    pub max_routing_fee_msat: u64,
    pub room_id: String,
    pub members: Vec<MemberCost>,
    pub total_msat: u64,
    /// Members who are not connected peers. The app will not send to a room
    /// while any exist: the node would skip them silently.
    pub unreachable: Vec<String>,
    /// True when any share is this node's own price standing in for theirs.
    pub estimate: bool,
}

/// Mirror the node's compose pricing per member: the member's fresh advertised
/// `communication` price, else this node's own, floored at one sat.
pub fn room_quote(
    room_id: &str,
    own_id: &str,
    own_msat: u64,
    members: &[String],
    peers: &[control::Peer],
    tables: &[control::PeerPrice],
    policy: RoutingFeePolicy,
) -> Result<RoomQuote, ActionError> {
    let mut out = Vec::new();
    let mut total_msat = 0u64;
    let mut max_routing_fee_msat = 0u64;
    for member in members {
        let id = member.to_ascii_lowercase();
        if id == own_id.to_ascii_lowercase() || out.iter().any(|m: &MemberCost| m.node_id == id) {
            continue;
        }
        let connected = peers
            .iter()
            .any(|p| p.connected && p.node_id.eq_ignore_ascii_case(&id));
        let advertised = tables
            .iter()
            .find(|t| t.peer_id.eq_ignore_ascii_case(&id) && !t.stale)
            .and_then(|t| t.prices.get(control::CATEGORY_COMMUNICATION).copied());
        let principal = advertised.unwrap_or(own_msat).max(MIN_PAYMENT_MSAT);
        let fee = policy.ceiling(principal);
        let msat = principal.checked_add(fee)
            .ok_or_else(|| ActionError::invalid("The room all-in quote overflows."))?;
        total_msat = total_msat.checked_add(msat)
            .ok_or_else(|| ActionError::invalid("The room all-in quote overflows."))?;
        max_routing_fee_msat = max_routing_fee_msat.checked_add(fee)
            .ok_or_else(|| ActionError::invalid("The room routing fee quote overflows."))?;
        out.push(MemberCost {
            node_id: id,
            msat,
            max_routing_fee_msat: fee,
            advertised: advertised.is_some(),
            connected,
        });
    }
    Ok(RoomQuote {
        room_id: room_id.to_string(),
        max_routing_fee_msat,
        total_msat,
        unreachable: out.iter().filter(|m| !m.connected).map(|m| m.node_id.clone()).collect(),
        estimate: out.iter().any(|m| !m.advertised),
        members: out,
    })
}

/// Refuse a room send unless every other member is a connected peer.
pub fn room_sendable(quote: &RoomQuote) -> Result<(), ActionError> {
    if quote.members.is_empty() {
        return Err(ActionError::new("room_unreachable", "This room has no other members yet."));
    }
    if quote.members.len() > ROOM_MAX_MEMBERS {
        return Err(ActionError::new("room_unreachable", "This room has more than 256 members."));
    }
    match quote.unreachable.len() {
        0 => Ok(()),
        n => Err(ActionError::new(
            "room_unreachable",
            format!(
                "{n} {} not a connected peer, so the node would skip them without telling you. Rooms send only when every member is connected.",
                if n == 1 { "member is" } else { "members are" },
            ),
        )),
    }
}

// ---- payments -----------------------------------------------------------------

/// The one reading of a BOLT 11 invoice the app shows or pays. It is decoded
/// with `lightning-invoice` at the same version the node's payment path parses
/// it with (genome `dac01c8`, via ldk-node 0.7.0), so the payee, amount and
/// expiry shown are the ones the node acts on.
///
/// An invoice is refused unless it is exactly its canonical encoding. The
/// parser hashes its own re-serialization of the fields; a string with padding
/// bits, leading zero words or other non-canonical field encodings still parses,
/// but anything that read its raw words would name a different signer.
/// Refusing them keeps every reader of the string in agreement.
fn decode_bolt11(invoice: &str) -> Result<Bolt11Invoice, ActionError> {
    let text = invoice.trim();
    if text.len() > 2048 {
        return Err(ActionError::invalid("that invoice is too long"));
    }
    let lower = text.to_ascii_lowercase();
    let lower = lower.strip_prefix("lightning:").unwrap_or(&lower);
    let bad = || ActionError::invalid("That is not a valid Lightning invoice.");
    let parsed: Bolt11Invoice = lower.parse().map_err(|_| bad())?;
    if parsed.to_string() != lower {
        return Err(ActionError::invalid(
            "This invoice is not in its standard encoding, so the app cannot be sure who it pays. Ask for a fresh invoice.",
        ));
    }
    // The parser uses the first `n`; more than one is refused, not guessed at.
    let named = parsed.tagged_fields().filter(|f| matches!(f, TaggedField::PayeePubKey(_))).count();
    if named > 1 {
        return Err(bad());
    }
    Ok(parsed)
}

/// Which chain an invoice is for. Shown next to the amount.
pub fn bolt11_network(currency: Currency) -> &'static str {
    match currency {
        Currency::Bitcoin => "mainnet",
        Currency::BitcoinTestnet => "testnet",
        Currency::Signet => "signet",
        Currency::Regtest => "regtest",
        Currency::Simnet => "simnet",
    }
}

/// `invoice_amount`: what paying this invoice would cost and whom it pays,
/// before paying. The only source of an invoice's payee the renderer shows.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct InvoiceAmount {
    pub amount_msat: u64,
    pub network: &'static str,
    /// The node the payment goes to: the `n` field, else the signer.
    pub payee: String,
    /// Unix ms.
    pub expires_at_ms: u64,
    /// The canonical invoice, lower case, without `lightning:`. Pay sends this.
    pub bolt11: String,
    /// The `p` field, hex.
    pub payment_hash: String,
    /// The `d` field as the payee wrote it; null for a description hash.
    pub description: Option<String>,
}

pub fn invoice_amount(invoice: &str) -> Result<InvoiceAmount, ActionError> {
    let parsed = decode_bolt11(invoice)?;
    let amount_msat = parsed.amount_milli_satoshis().filter(|m| *m > 0).ok_or_else(|| {
        ActionError::invalid("This invoice names no amount. The app pays only invoices whose cost it can show first.")
    })?;
    let expires_at_ms = parsed
        .expires_at()
        .and_then(|d| u64::try_from(d.as_millis()).ok())
        .ok_or_else(|| ActionError::invalid("That is not a valid Lightning invoice."))?;
    Ok(InvoiceAmount {
        amount_msat,
        network: bolt11_network(parsed.currency()),
        payee: parsed.get_payee_pub_key().to_string(),
        expires_at_ms,
        bolt11: parsed.to_string(),
        payment_hash: parsed.payment_hash().to_string(),
        description: match parsed.description() {
            Bolt11InvoiceDescriptionRef::Direct(d) => Some(d.as_inner().0.clone()),
            Bolt11InvoiceDescriptionRef::Hash(_) => None,
        },
    })
}

/// A valid 1,000-msat testnet invoice (payee `0324653e…ab1c`) for host tests.
#[doc(hidden)]
pub const TEST_INVOICE_1000: &str = "lntb10n1pj48ugqdq8w3jhxaqpp5qurswpc8qurswpc8qurswpc8qurswpc8qurswpc8qurswpc8qurssp5pyysjzgfpyysjzgfpyysjzgfpyysjzgfpyysjzgfpyysjzgfpyys9qrsgqcqpjwcyh3lmtqk07y4678usw99mc95k5xkn5nl3g3rv0kucq4m8603d4pv4vzzaj3pqffa6zge5xgz2lzn238xt7z5w3q8v8z8wkj9ylxcqpl5fqza";

/// `POST /payments/pay` body, refused unless the invoice asks for exactly the
/// amount the owner was shown. The body carries the canonical invoice.
pub fn pay_body(invoice: &str, confirmed_msat: u64) -> Result<serde_json::Value, ActionError> {
    let shown = invoice_amount(invoice)?;
    if shown.amount_msat != confirmed_msat {
        return Err(ActionError::invalid(
            "The invoice amount does not match the cost you confirmed. Nothing was paid.",
        ));
    }
    Ok(json!({ "bolt11": shown.bolt11 }))
}

/// `POST /payments/keysend` body.
pub fn keysend_body(dest_pubkey: &str, amount_msat: u64, memo: Option<&str>) -> Result<serde_json::Value, ActionError> {
    let dest = dest_pubkey.trim().to_ascii_lowercase();
    if dest.len() != 66 || !(dest.starts_with("02") || dest.starts_with("03")) || !dest.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ActionError::invalid("expected a 66-character Lightning node pubkey"));
    }
    if !(MIN_PAYMENT_MSAT..=MAX_PAYMENT_MSAT).contains(&amount_msat) {
        return Err(ActionError::invalid("the amount must be between 1 sat and 1 BTC"));
    }
    let memo = memo.map(str::trim).filter(|m| !m.is_empty());
    if memo.is_some_and(|m| m.len() > 280 || m.chars().any(char::is_control)) {
        return Err(ActionError::invalid("the note is too long or has control characters"));
    }
    Ok(json!({ "dest_pubkey": dest, "amount_msat": amount_msat, "memo": memo }))
}

/// `/payments/pay` response. The preimage is read so it can be dropped.
#[derive(Deserialize, Debug)]
pub struct PayReply {
    #[serde(default)]
    pub max_routing_fee_msat: u64,
    pub amount_msat: u64,
    #[serde(default)]
    pub preimage: String,
}

/// `/payments/keysend` response. `status` is Debug-cased by the node.
#[derive(Deserialize, Debug)]
pub struct KeysendReply {
    #[serde(default)]
    pub max_routing_fee_msat: u64,
    pub amount_msat: u64,
    pub status: String,
}

/// A payment as the stream shows it. No hash, no preimage.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct PaymentReceipt {
    pub max_routing_fee_msat: u64,
    /// `invoice` or `keysend`.
    pub method: &'static str,
    pub amount_msat: u64,
    /// `settled`, `pending`, `inflight` or `failed`.
    pub status: String,
    pub paid_at_ms: u64,
}

impl PayReply {
    pub fn receipt(self, now_ms: u64) -> PaymentReceipt {
        PaymentReceipt {
            method: "invoice",
            max_routing_fee_msat: self.max_routing_fee_msat,
            amount_msat: self.amount_msat,
            // The node returns once the payment resolves; an empty preimage
            // means it has not settled yet.
            status: if self.preimage.is_empty() { "pending" } else { "settled" }.into(),
            paid_at_ms: now_ms,
        }
    }
}

impl KeysendReply {
    pub fn receipt(self, now_ms: u64) -> PaymentReceipt {
        let status = self.status.to_ascii_lowercase();
        PaymentReceipt {
            method: "keysend",
            max_routing_fee_msat: self.max_routing_fee_msat,
            amount_msat: self.amount_msat,
            status: match status.as_str() {
                "settled" | "pending" | "inflight" | "failed" => status,
                _ => "pending".into(),
            },
            paid_at_ms: now_ms,
        }
    }
}

/// `POST /payments/invoice` body. Receiving needs no spend approval.
pub fn invoice_body(amount_msat: u64, note: &str, expiry_secs: u32) -> Result<serde_json::Value, ActionError> {
    if !(MIN_PAYMENT_MSAT..=MAX_PAYMENT_MSAT).contains(&amount_msat) {
        return Err(ActionError::invalid("the amount must be between 1 sat and 1 BTC"));
    }
    let note = note.trim();
    if note.len() > INVOICE_NOTE_MAX_BYTES || note.chars().any(|c| c.is_control() && c != '\n') {
        return Err(ActionError::invalid("the note is too long or has control characters"));
    }
    let expiry_secs = expiry_secs.clamp(60, 604_800);
    let mut body = json!({ "amount_msat": amount_msat, "expiry_secs": expiry_secs });
    if !note.is_empty() {
        body["description"] = json!(note);
    }
    Ok(body)
}

#[derive(Deserialize, Debug)]
pub struct InvoiceReply {
    pub bolt11: String,
}

/// An invoice to show as an inline artifact (QR + text).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct InvoiceView {
    pub bolt11: String,
    pub amount_msat: u64,
    pub note: Option<String>,
    pub expires_at_ms: u64,
}

// ---- invites ------------------------------------------------------------------

/// `POST /invites` body: an invite bound to one invitee's key.
pub fn invite_body(invitee: &str, addr: &str, hours: u64, now_unix: u64) -> Result<serde_json::Value, ActionError> {
    let invitee = control::node_id(invitee).map_err(ActionError::invalid)?;
    let addr = addr.trim();
    let port_ok = addr
        .rsplit_once(':')
        .is_some_and(|(host, port)| !host.is_empty() && port.parse::<u16>().is_ok_and(|p| p > 0));
    if !port_ok || addr.len() > 255 || addr.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(ActionError::invalid("your address must be host:port, as the invitee will dial it"));
    }
    if !(1..=INVITE_MAX_HOURS).contains(&hours) {
        return Err(ActionError::invalid("an invite can last from 1 hour to 30 days"));
    }
    Ok(json!({
        "invitee_pubkey": invitee,
        "expiry_unix": now_unix + hours * 3600,
        "addr": addr,
    }))
}

#[derive(Deserialize, Debug)]
pub struct InviteReply {
    pub invite_id: String,
    pub invite_link: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct InviteView {
    pub invite_id: String,
    pub invite_link: String,
    pub invitee: String,
    pub expires_at_ms: u64,
}

/// The token from a `bitsov://invite/<token>` link or a bare token.
pub fn invite_token(input: &str) -> Result<String, ActionError> {
    let raw = input.trim();
    let token = raw.strip_prefix("bitsov://invite/").unwrap_or(raw);
    if token.is_empty()
        || token.len() > 4096
        || !token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(ActionError::invalid("that does not look like a BitSov invite"));
    }
    Ok(token.to_string())
}

/// `POST /invites/accept` (202) response, the fields worth showing.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Eq)]
pub struct RedeemView {
    pub inviter_pubkey: String,
    pub addr: String,
}

// ---- files --------------------------------------------------------------------

/// Decoded length of standard base64, validating the alphabet.
pub fn base64_decoded_len(data: &str) -> Option<usize> {
    let bytes = data.as_bytes();
    if bytes.is_empty() || !bytes.len().is_multiple_of(4) {
        return None;
    }
    let pad = bytes.iter().rev().take_while(|&&b| b == b'=').count();
    if pad > 2 {
        return None;
    }
    let body_ok = bytes[..bytes.len() - pad]
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || *b == b'+' || *b == b'/');
    body_ok.then(|| bytes.len() / 4 * 3 - pad)
}

/// `POST /files` body.
pub fn file_upload_body(filename: &str, mime_type: &str, data_b64: &str) -> Result<serde_json::Value, ActionError> {
    let name = filename.trim();
    if name.is_empty()
        || name.len() > 255
        || name.contains(['/', '\\', '\0'])
        || name.contains("..")
    {
        return Err(ActionError::invalid("that file name cannot be sent"));
    }
    let mime = mime_type.trim();
    let mime = if mime.is_empty() { "application/octet-stream" } else { mime };
    if mime.len() > 255 || mime.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(ActionError::invalid("that file type cannot be sent"));
    }
    match base64_decoded_len(data_b64) {
        None => Err(ActionError::invalid("the file could not be read")),
        Some(0) => Err(ActionError::invalid("the file is empty")),
        Some(n) if n > FILE_MAX_BYTES => Err(ActionError::invalid(
            "Files up to 1.4 MB can be sent from the app for now.",
        )),
        Some(_) => Ok(json!({ "filename": name, "mime_type": mime, "data_b64": data_b64 })),
    }
}

/// One row of `GET /files` (metadata only; the node never lists file bytes).
#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct FileRow {
    pub id: String,
    pub mime_type: String,
    #[serde(default)]
    pub message_id: Option<String>,
}

/// `GET /files/:id`: one stored file with its bytes.
#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
pub struct FileBlob {
    pub filename: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub data_b64: String,
}

/// A voice note is an ordinary kind-200 file whose type is audio. Only these
/// are handed to the webview for inline playback.
pub fn is_voice_mime(mime: &str) -> bool {
    mime.trim().to_ascii_lowercase().starts_with("audio/")
}

/// `GET /files` windows, newest first. Genome's list takes only `limit`, so a
/// lookup widens the window until it finds the message or the list ends.
pub const FILE_LIST_WINDOWS: [usize; 3] = [50, 200, 1000];
/// Error text the renderer tells apart: the file exists but is not audio
/// (a name that only looks like a voice note).
pub const NOT_A_VOICE_NOTE: &str = "not a voice note";
pub const VOICE_NOT_STORED: &str = "voice note not stored on this node";
pub const FILE_NOT_STORED: &str = "file not stored on this node";
/// Received file over the app's 1.4 MB send/receive cap.
pub const FILE_TOO_LARGE: &str = "file over 1.4 MB";

/// What a message's stored file is, by its type (never its name).
#[derive(Debug, PartialEq, Eq)]
pub enum VoiceLookup<'a> {
    Voice(&'a FileRow),
    NotVoice,
    Missing,
}

/// Any stored file for a message id (voice or not).
#[derive(Debug, PartialEq, Eq)]
pub enum StoredLookup<'a> {
    Found(&'a FileRow),
    Missing,
}

/// The stored file a received message carried. The node records the
/// envelope id as `message_id` when it stores the file.
pub fn stored_file_for<'a>(rows: &'a [FileRow], message_id: &str) -> StoredLookup<'a> {
    match rows.iter().find(|r| r.message_id.as_deref().is_some_and(|m| m.eq_ignore_ascii_case(message_id))) {
        Some(r) => StoredLookup::Found(r),
        None => StoredLookup::Missing,
    }
}

/// Voice notes only: same lookup, then require an audio mime.
pub fn voice_file_for<'a>(rows: &'a [FileRow], message_id: &str) -> VoiceLookup<'a> {
    match stored_file_for(rows, message_id) {
        StoredLookup::Found(r) if is_voice_mime(&r.mime_type) => VoiceLookup::Voice(r),
        StoredLookup::Found(_) => VoiceLookup::NotVoice,
        StoredLookup::Missing => VoiceLookup::Missing,
    }
}

/// Refuse a blob whose declared size or decoded bytes exceed [`FILE_MAX_BYTES`].
pub fn blob_within_cap(blob: &FileBlob) -> Result<(), String> {
    let decoded = base64_decoded_len(&blob.data_b64).unwrap_or(usize::MAX);
    let declared = usize::try_from(blob.size_bytes).unwrap_or(usize::MAX);
    if declared > FILE_MAX_BYTES || decoded > FILE_MAX_BYTES {
        Err(FILE_TOO_LARGE.into())
    } else {
        Ok(())
    }
}

/// Cap on the save-dialog name suggestion (peer input can be arbitrarily long).
pub const SAVE_NAME_MAX: usize = 180;

/// A single path segment for the save dialog: no directories, no empty name.
pub fn safe_save_name(filename: &str) -> String {
    let base = filename
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim()
        .trim_start_matches('.');
    let cleaned: String = base
        .chars()
        .map(|c| if c.is_control() || c == ':' { '_' } else { c })
        .collect();
    // Truncate then drop trailing spaces/dots (Windows reserved tails).
    let truncated: String = cleaned.chars().take(SAVE_NAME_MAX).collect();
    let trimmed = truncated.trim_end_matches([' ', '.']).to_string();
    if trimmed.is_empty() { "file".into() } else { trimmed }
}

/// Decode base64 and write exactly to `path` (caller chose it via the save dialog).
pub fn write_file_bytes(path: &std::path::Path, data_b64: &str) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64)
        .map_err(|_| "corrupt file data".to_string())?;
    if bytes.len() > FILE_MAX_BYTES {
        return Err(FILE_TOO_LARGE.into());
    }
    std::fs::write(path, bytes).map_err(|e| format!("could not save: {e}"))
}

/// Result of a user-chosen save (or cancel).
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct FileSaveResult {
    pub saved: bool,
    pub filename: String,
    pub mime_type: String,
    pub size_bytes: u64,
}

#[derive(Deserialize, Debug)]
pub struct UploadReply {
    pub file_id: String,
    pub size_bytes: u64,
}

/// The send route for a file id the node returned: a stored file's UUID, or a
/// volatile staged upload, `stage-<uuid>` (genome F1 file staging, #83).
/// Anything else is refused before any request, so it can never reach a path.
pub fn file_send_path(file_id: &str) -> Result<String, ActionError> {
    let unexpected = || ActionError::node("the node returned an unexpected file id");
    let id = match file_id.trim().strip_prefix("stage-") {
        Some(uuid) => format!("stage-{}", control::room_id(uuid).map_err(|_| unexpected())?),
        None => control::room_id(file_id).map_err(|_| unexpected())?,
    };
    Ok(format!("/files/{id}/send"))
}

/// A sent file, as the stream shows it.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct FileReceipt {
    pub total_msat: u64,
    pub max_routing_fee_msat: u64,
    pub message_id: String,
    pub recipient: String,
    pub filename: String,
    pub size_bytes: u64,
    pub delivered: bool,
    pub amount_msat: u64,
    pub sent_at_ms: u64,
    /// Present when the node echoes operation fields (compose-shaped replies).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    pub accepted: bool,
}

// ---- node refusals --------------------------------------------------------------

/// A 403 on a spending route: post-rc7 `token lacks required scope: …` (plain
/// text), or a pairing refusal. Either way the token cannot do this.
pub fn is_scope_refusal(status: u16) -> bool {
    status == 403
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn readmission_capped_refusal_matches_the_reason_code_first() {
        // Current genome: the stable reason decides, whatever the wording.
        let coded = r#"{"code":"price_cap_exceeded","reason":"readmission_required","error":"reworded by a later genome"}"#;
        assert!(readmission_capped_refusal(409, coded));
        assert!(!readmission_capped_refusal(400, coded));
        assert!(!readmission_capped_refusal(409, r#"{"code":"operation_mismatch","reason":"readmission_required"}"#));
        // A different reason is not this refusal, even with the old wording.
        assert!(!readmission_capped_refusal(409, r#"{"code":"price_cap_exceeded","reason":"total_exceeds_cap","error":"ab requires admission again on a new connection"}"#));
    }

    #[test]
    fn readmission_capped_refusal_falls_back_to_the_wording_of_older_nodes() {
        let genome = r#"{"code":"price_cap_exceeded","error":"ab requires admission again on a new connection, and the confirmed cap covers the message only; no invoice was paid."}"#;
        assert!(readmission_capped_refusal(409, genome));
        assert!(!readmission_capped_refusal(400, genome));
        assert!(!readmission_capped_refusal(409, r#"{"code":"price_cap_exceeded","error":"total exceeds cap"}"#));
        assert!(!readmission_capped_refusal(409, r#"{"code":"operation_mismatch","error":"requires admission again on a new connection"}"#));
        assert!(!readmission_capped_refusal(409, "not json"));
    }

    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const C: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    #[test]
    fn room_evidence_requires_exact_unique_members_and_bounded_amounts() {
        let request=json!({"max_recipient_msat":{"a":1000,"b":2000}});
        let good=json!({"amount_msat":1000,"member_outcomes":[{"recipient":"a","status":"settled","amount_msat":1000,"message_id":"m1"},{"recipient":"b","status":"refused","amount_msat":0}]});
        assert_eq!(room_result(&good,&request,3000).unwrap(),(true,true));
        let mut unknown=good.clone();
        unknown["member_outcomes"][1]["status"]=json!("unknown");
        assert_eq!(room_result(&unknown,&request,3000).unwrap(),(false,false));
        for bad in [
            json!({"amount_msat":0}),
            json!({"amount_msat":1000,"member_outcomes":[good["member_outcomes"][0].clone()]}),
            json!({"amount_msat":2000,"member_outcomes":[good["member_outcomes"][0].clone(),good["member_outcomes"][0].clone()]}),
        ] { assert_eq!(room_result(&bad,&request,3000).unwrap_err().code,"spend_unknown"); }
        let mut excess=good.clone();
        excess["member_outcomes"][0]["amount_msat"]=json!(1001);
        excess["amount_msat"]=json!(1001);
        assert!(room_result(&excess,&request,3000).is_err());
    }

    #[test]
    fn pending_room_principal_is_bounded_but_not_terminal() {
        let request = json!({"max_recipient_msat":{"a":1000}});
        let reply = json!({"amount_msat":1000,"member_outcomes":[{"recipient":"a","status":"pending","amount_msat":1000,"message_id":null}]});
        assert_eq!(room_result(&reply,&request,1000).unwrap(),(false,false));
        assert!(room_result(&reply,&request,999).is_err());
    }

    #[test]
    fn room_settled_without_stored_message_is_incomplete_not_success() {
        let request=json!({"max_recipient_msat":{"peer":1000}});
        let reply=json!({"amount_msat":1000,"member_outcomes":[{"recipient":"peer","status":"settled","amount_msat":1000,"message_id":null,"reason":"storage failed"}]});
        assert_eq!(room_result(&reply,&request,1000).unwrap(),(true,true));
    }

    const OWN: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const ROOM: &str = "0f8e2b7a-1c3d-4e5f-8a9b-0c1d2e3f4a5b";

    #[test]
    fn poll_ticket_requires_same_operation_generation_and_unexpired_deadline() {
        let mut gate = SpendGate::default();
        let pending = Elevation { op_id:"ab12".into(), expires_at_ms:100, owner_action:"konsensus grant".into(), owner_can_grant:true };
        gate.set_pending(pending.clone());
        let generation = gate.generation();
        assert!(gate.matches_poll(generation, &pending, 99));
        assert!(!gate.matches_poll(generation, &pending, 100));
        gate.set_pending(pending.clone());
        assert!(!gate.matches_poll(generation, &pending, 1));
        let generation = gate.generation();
        let mut other = pending.clone();
        other.op_id = "cd34".into();
        assert!(!gate.matches_poll(generation, &other, 1));
        gate.lock();
        assert!(!gate.matches_poll(generation, &pending, 1));
    }

    #[test]
    fn the_window_opens_on_approval_and_closes_after_ten_minutes() {
        let mut gate = SpendGate::default();
        assert_eq!(gate.check(0).unwrap_err().code, "spend_locked");
        assert_eq!(gate.view(0).state, SpendState::Locked);
        gate.arm(1_000, SpendBasis::AppLock);
        assert_eq!(gate.check(1_000 + SPEND_WINDOW_MS - 1).unwrap(), SpendBasis::AppLock);
        let view = gate.view(2_000);
        assert_eq!((view.state, view.open_until_ms), (SpendState::Open, Some(1_000 + SPEND_WINDOW_MS)));
        assert_eq!(gate.check(1_000 + SPEND_WINDOW_MS).unwrap_err().code, "spend_expired");
        assert_eq!(gate.view(1_000 + SPEND_WINDOW_MS).state, SpendState::Expired);
        gate.lock();
        assert_eq!(gate.check(0).unwrap_err().code, "spend_locked");
    }

    #[test]
    fn a_node_refusal_locks_the_window() {
        let mut gate = SpendGate::default();
        gate.arm(0, SpendBasis::NodeGrant);
        assert_eq!(gate.refused().code, "spend_refused");
        assert_eq!(gate.check(1).unwrap_err().code, "spend_locked");
    }

    #[test]
    fn a_pending_request_expires_into_expired_and_a_sidecar_is_unavailable() {
        let reply = ElevationReply {
            op_id: "ab12".into(),
            expires_at: 100,
            owner_action: "konsensus grant --op ab12".into(),
        };
        let mut gate = SpendGate::default();
        gate.set_pending(reply.into_elevation(None).unwrap());
        assert_eq!(gate.view(99_999).state, SpendState::Pending);
        assert_eq!(gate.check(99_999).unwrap_err().code, "spend_locked");
        assert_eq!(gate.view(100_000).state, SpendState::Expired);

        let sidecar = ElevationReply {
            op_id: "cd34".into(),
            expires_at: 100,
            owner_action: "unavailable in this deployment: …".into(),
        };
        gate.set_pending(sidecar.into_elevation(None).unwrap());
        let view = gate.view(0);
        assert_eq!(view.state, SpendState::Unavailable);
        assert!(!view.pending.unwrap().owner_can_grant);

        let hostile = ElevationReply { op_id: "../x".into(), expires_at: 1, owner_action: String::new() };
        assert!(hostile.into_elevation(None).is_err());
        assert!(elevation_status_path("../../payments").is_err());
    }

    #[test]
    fn a_lapsed_request_says_why_until_the_next_ask() {
        let pending = |op: &str| ElevationReply { op_id: op.into(), expires_at: 100, owner_action: format!("konsensus grant --op {op}") }
            .into_elevation(None)
            .unwrap();
        let mut gate = SpendGate::default();
        gate.set_pending(pending("ab12"));
        gate.pending_expired(Lapse::Lost);
        let view = gate.view(0);
        assert_eq!((view.state, view.lapse), (SpendState::Expired, Some(Lapse::Lost)));
        gate.set_pending(pending("ab13"));
        assert_eq!(gate.view(0).lapse, None);
        // Running out on the app's clock is an expiry too.
        assert_eq!(gate.view(100_000).lapse, Some(Lapse::Expired));
        gate.lock();
        assert_eq!(gate.view(100_000).lapse, None);

        // A sidecar request running out offers no Ask again: it can never be granted.
        let sidecar = ElevationReply { op_id: "cd34".into(), expires_at: 100, owner_action: "unavailable in this deployment".into() }
            .into_elevation(None)
            .unwrap();
        gate.set_pending(sidecar);
        let view = gate.view(100_000);
        assert_eq!((view.state, view.lapse), (SpendState::Expired, None));

        assert_eq!(Lapse::from_status("lost"), Some(Lapse::Lost));
        assert_eq!(Lapse::from_status("absent"), Some(Lapse::Lost));
        assert_eq!(Lapse::from_status("expired"), Some(Lapse::Expired));
        assert_eq!(Lapse::from_status("pending"), None);
        assert_eq!(Lapse::from_status("granted"), None);
    }

    #[test]
    fn only_a_safe_absolute_config_is_added_to_the_owner_command() {
        let reply = |action: &str| ElevationReply { op_id: "ab12".into(), expires_at: 1, owner_action: action.into() };
        let with = |action: &str, config: &str| reply(action).into_elevation(Some(std::path::Path::new(config))).unwrap().owner_action;
        assert_eq!(with("konsensus grant --op ab12", "/n/konsensus.toml"), "konsensus grant --op ab12 --config '/n/konsensus.toml'");
        // Relative, or with characters that could rewrite what the owner sees: left out.
        assert_eq!(with("konsensus grant --op ab12", "n/konsensus.toml"), "konsensus grant --op ab12");
        assert_eq!(with("konsensus grant --op ab12", "/n/\u{202E}lmot.toml"), "konsensus grant --op ab12");
        assert_eq!(with("konsensus grant --op ab12", "/n/\nx.toml"), "konsensus grant --op ab12");
        assert_eq!(with("konsensus grant --op ab12", "/Users/o'neil/konsensus.toml"), "konsensus grant --op ab12");
        assert_eq!(with("konsensus grant --op ab12", r"/a\' ; touch /tmp/p ; \'/k.toml"), "konsensus grant --op ab12");
        assert_eq!(with("konsensus grant --op ab12", &format!("/{}", "n".repeat(500))), "konsensus grant --op ab12");
        // Only the bare command of THIS request is extended.
        assert_eq!(with("konsensus grant --op cd34", "/n/konsensus.toml"), "konsensus grant --op cd34");
        assert_eq!(with("unavailable in this deployment", "/n/konsensus.toml"), "unavailable in this deployment");
    }

    #[test]
    fn the_view_carries_no_token_or_scope() {
        let mut gate = SpendGate::default();
        gate.arm(0, SpendBasis::NodeGrant);
        let json = serde_json::to_string(&gate.view(1)).unwrap();
        assert!(json.contains("\"basis\":\"node_grant\""));
        assert!(!json.contains("token") && !json.contains("scope"));
    }

    #[test]
    fn compose_bodies_are_exact_and_validated() {
        assert_eq!(
            compose_body(&A.to_uppercase(), false, "gm").unwrap(),
            json!({"recipient": A, "is_room": false, "kind": 0, "plaintext": "gm"})
        );
        assert_eq!(compose_body(ROOM, true, "hi").unwrap()["recipient"], ROOM);
        assert!(compose_body(ROOM, false, "hi").is_err(), "a room id is not a node id");
        assert!(compose_body(A, true, "hi").is_err());
        assert!(compose_body(A, false, "  \n").is_err());
        assert!(compose_body(A, false, &"x".repeat(PLAINTEXT_MAX_BYTES + 1)).is_err());
    }

    fn peer(id: &str, connected: bool) -> control::Peer {
        control::Peer { node_id: id.into(), addr: None, label: None, connected, fingerprint: None, capabilities: None, meetings: false }
    }

    #[test]
    fn room_cost_is_the_sum_of_each_members_own_price() {
        let tables = vec![
            control::PeerPrice { peer_id: A.into(), prices: HashMap::from([("communication".into(), 2_000)]), age_secs: 10, stale: false },
            control::PeerPrice { peer_id: B.into(), prices: HashMap::from([("communication".into(), 9_000)]), age_secs: 9_000, stale: true },
        ];
        let members = vec![OWN.into(), A.to_uppercase(), B.into(), A.into()];
        let q = room_quote(ROOM, OWN, 500, &members, &[peer(A, true), peer(B, true)], &tables, RoutingFeePolicy::default()).unwrap();
        // A: advertised 2000. B: stale table, so own price 500, floored at 1 sat. Self and duplicates skipped.
        assert_eq!(q.members.len(), 2);
        assert_eq!((q.members[0].msat, q.members[0].advertised), (7_000, true));
        assert_eq!((q.members[1].msat, q.members[1].advertised), (6_000, false));
        assert_eq!(q.total_msat, 13_000);
        assert_eq!(q.max_routing_fee_msat, 10_000);
        assert!(q.estimate);
        assert!(q.unreachable.is_empty());
        assert!(room_sendable(&q).is_ok());
    }

    #[test]
    fn room_policy_proportional_and_maximum_allowances_and_overflow() {
        let policy = RoutingFeePolicy { minimum_msat: 7500, proportional_millionths: 20_000, maximum_msat: 20_000 };
        for (principal, total, fee) in [(2000, 9500, 7500), (750_000, 765_000, 15_000), (2_000_000, 2_020_000, 20_000)] {
            let quote = room_quote(ROOM, OWN, principal, &[A.into()], &[peer(A, true)], &[], policy).unwrap();
            assert_eq!((quote.total_msat, quote.max_routing_fee_msat), (total, fee));
        }
        assert!(room_quote(ROOM, OWN, u64::MAX, &[A.into()], &[], &[], policy).is_err());
        assert!(room_quote(ROOM, OWN, u64::MAX / 2, &[A.into(), B.into()], &[], &[], policy).is_err());
    }

    #[test]
    fn a_room_with_an_unconnected_member_is_not_sendable() {
        let members = vec![OWN.into(), A.into(), C.into()];
        let q = room_quote(ROOM, OWN, 1_000, &members, &[peer(A, true), peer(C, false)], &[], RoutingFeePolicy::default()).unwrap();
        assert_eq!(q.unreachable, vec![C.to_string()]);
        let err = room_sendable(&q).unwrap_err();
        assert_eq!(err.code, "room_unreachable");
        assert!(err.message.contains("1 member is not a connected peer"));
        let alone = room_quote(ROOM, OWN, 1_000, &[OWN.into()], &[], &[], RoutingFeePolicy::default()).unwrap();
        assert_eq!(room_sendable(&alone).unwrap_err().code, "room_unreachable");
    }

    /// Codex's review fixture: a 21,000-msat regtest invoice signed by
    /// `CANONICAL_PAYEE`, and three re-encodings the node's parser accepts as
    /// that same invoice (a set padding bit in `p`, a leading zero word in `c`,
    /// a leading zero word in the features). Read from their raw words, each
    /// names a different node.
    const CANONICAL: &str = "lnbcrt210n1p45n5sqdq2v35kumn9wgpp5vj92t3telvc08zhhgnvh6mkggrr6jynh5jv6p4uq70nnznk2py9ssp5qszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszq9qrsgqcqpjgpd0vndshg0682c4gpxyde0sr785uz9eqc36yjugphpzpkn55zmy6v4nszm0ym8vqwvgrp4jh9us9d593yftaz5sgxwyxyf9z0hmsnsqcufc8l";
    const CANONICAL_PAYEE: &str = "031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f";
    const NONCANONICAL: [&str; 3] = [
        "lnbcrt210n1p45n5sqdq2v35kumn9wgpp5vj92t3telvc08zhhgnvh6mkggrr6jynh5jv6p4uq70nnznk2py93sp5qszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszq9qrsgqcqpjgpd0vndshg0682c4gpxyde0sr785uz9eqc36yjugphpzpkn55zmy6v4nszm0ym8vqwvgrp4jh9us9d593yftaz5sgxwyxyf9z0hmsnsq3ul59u",
        "lnbcrt210n1p45n5sqdq2v35kumn9wgpp5vj92t3telvc08zhhgnvh6mkggrr6jynh5jv6p4uq70nnznk2py9ssp5qszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszq9qrsgqcqzqjgpd0vndshg0682c4gpxyde0sr785uz9eqc36yjugphpzpkn55zmy6v4nszm0ym8vqwvgrp4jh9us9d593yftaz5sgxwyxyf9z0hmsnsq53y0av",
        "lnbcrt210n1p45n5sqdq2v35kumn9wgpp5vj92t3telvc08zhhgnvh6mkggrr6jynh5jv6p4uq70nnznk2py9ssp5qszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszq9qyqsgqcqpjgpd0vndshg0682c4gpxyde0sr785uz9eqc36yjugphpzpkn55zmy6v4nszm0ym8vqwvgrp4jh9us9d593yftaz5sgxwyxyf9z0hmsnsqfvef43",
    ];
    /// Two `n` fields (A then B), both parsable; which one pays is refused, not guessed.
    const DUPLICATE_N: &str = "lnbcrt210n1p4tex6ldpvv3jkxmmyv4ezqcm0denx7undv9hxxefqve5hsar4wfjspp5vj92t3telvc08zhhgnvh6mkggrr6jynh5jv6p4uq70nnznk2py9ssp5qszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszq9qrsgqcqpjnp4qvdcf32k0vfxgsyet5ldt246q4jaw8scx3sysx0lnstlt6w4m5rc7np4qfx5kmx3xcgr9j5m62htnkgq4fx5tk02mq9vjs3nwnz9rfe9f5rkvku2gq78kmvpjp67txksuenlzjsfndm0jy4k4m8hz2sv56kc0h8fsuj4a95rfnvqd2j8kj376s5zjyn276428cvn7x3glf405m28246cqu503zx";

    #[test]
    fn an_invoice_is_read_as_the_node_parses_it() {
        let read = invoice_amount(CANONICAL).unwrap();
        assert_eq!(read.amount_msat, 21_000);
        assert_eq!(read.network, "regtest");
        assert_eq!(read.payee, CANONICAL_PAYEE);
        assert_eq!(read.bolt11, CANONICAL);
        assert_eq!(read.payment_hash, "648aa5c579fb30f38af744d97d6ec840c7a91277a499a0d780f3e7314eca090b");
        assert_eq!(read.description.as_deref(), Some("dinner"));
        let parsed: Bolt11Invoice = CANONICAL.parse().unwrap();
        assert_eq!(read.expires_at_ms, (parsed.duration_since_epoch().as_secs() + 3600) * 1000);
        // Case and a `lightning:` prefix are not re-encodings: the same invoice.
        let upper = invoice_amount(&format!("  LIGHTNING:{}\n", CANONICAL.to_ascii_uppercase())).unwrap();
        assert_eq!(upper, read);
        let t = invoice_amount(TEST_INVOICE_1000).unwrap();
        assert_eq!((t.amount_msat, t.network), (1_000, "testnet"));
        assert_eq!(t.payee, "0324653eac434488002cc06bbfb7f10fe18991e35f9fe4302dbea6d2353dc0ab1c");
    }

    #[test]
    fn a_non_canonical_encoding_is_refused_whatever_its_signer() {
        // The node's parser accepts each as the canonical invoice; the app does not.
        for bolt11 in NONCANONICAL {
            assert_eq!(bolt11.parse::<Bolt11Invoice>().unwrap().get_payee_pub_key().to_string(), CANONICAL_PAYEE);
            let err = invoice_amount(bolt11).unwrap_err();
            assert_eq!(err.code, "invalid");
            assert!(err.message.contains("standard encoding"), "{}", err.message);
            assert!(pay_body(bolt11, 21_000).unwrap_err().message.contains("standard encoding"));
        }
        assert_eq!(invoice_amount(DUPLICATE_N).unwrap_err().code, "invalid");
        // One `n`: the signer's is read as the payee; anyone else's fails the signature.
        let pre = &CANONICAL[..CANONICAL.len() - 110];
        let single_match = format!("{pre}np4qvdcf32k0vfxgsyet5ldt246q4jaw8scx3sysx0lnstlt6w4m5rc7utvphkf0r6r8hqss2xsg5pa3k5094vr0szxcaq96z28ytekr7at380elc26wu0j6u7fzhxwwux67vsqs7jpyfk0dqar3y86qj3urrvqpvaf6md");
        let single_other = format!("{pre}np4qfx5kmx3xcgr9j5m62htnkgq4fx5tk02mq9vjs3nwnz9rfe9f5rkv8wux8u2ga730fxufdqte2kkh7vk2yu57uemxxguwr26kpwhh528qq36j5yrvjd0mgtvazaghc2svyvauk5u4sacaarg20n4upjk3jjsqa2gc5d");
        assert_eq!(invoice_amount(&single_match).unwrap().payee, CANONICAL_PAYEE);
        assert_eq!(invoice_amount(&single_other).unwrap_err().code, "invalid");
        assert!(pay_body(DUPLICATE_N, 21_000).is_err());
    }

    #[test]
    fn malformed_and_amountless_invoices_are_refused() {
        for bad in ["hello", "lnbc10n1abc", "lntb10n1x", "lnbc1pvjluez", "", &format!("{}q", CANONICAL)] {
            assert_eq!(invoice_amount(bad).unwrap_err().code, "invalid", "{bad}");
        }
        // One changed character fails the checksum.
        let mut flipped = CANONICAL.to_string();
        flipped.replace_range(30..31, "q");
        assert!(invoice_amount(&flipped).is_err());
        assert_eq!(bolt11_network(Currency::Signet), "signet");
        assert_eq!(bolt11_network(Currency::Bitcoin), "mainnet");
    }

    #[test]
    fn pay_refuses_amountless_and_mismatched_invoices() {
        assert_eq!(pay_body(TEST_INVOICE_1000, 1_000).unwrap(), json!({"bolt11": TEST_INVOICE_1000}));
        let prefixed = format!("lightning:{}", TEST_INVOICE_1000.to_ascii_uppercase());
        assert_eq!(pay_body(&prefixed, 1_000).unwrap(), json!({"bolt11": TEST_INVOICE_1000}));
        assert!(pay_body(TEST_INVOICE_1000, 999).unwrap_err().message.contains("does not match"));
        assert!(pay_body("lnbc1abc", 0).is_err());
    }

    #[test]
    fn keysend_and_invoice_bodies_are_bounded() {
        let pk = format!("02{}", "ab".repeat(32));
        assert_eq!(keysend_body(&pk, 5_000, Some(" thanks ")).unwrap(), json!({"dest_pubkey": pk, "amount_msat": 5_000, "memo": "thanks"}));
        assert_eq!(keysend_body(&pk, 5_000, Some("")).unwrap()["memo"], serde_json::Value::Null);
        assert!(keysend_body(&pk, 999, None).is_err());
        assert!(keysend_body(A, 5_000, None).is_err());
        assert!(keysend_body(&pk, 5_000, Some("a\u{7}b")).is_err());

        assert_eq!(invoice_body(21_000, "coffee", 3600).unwrap(), json!({"amount_msat": 21_000, "expiry_secs": 3600, "description": "coffee"}));
        assert!(invoice_body(21_000, "", 3600).unwrap().get("description").is_none());
        assert!(invoice_body(0, "", 3600).is_err());
        assert!(invoice_body(1_000, &"x".repeat(640), 3600).is_err());
        assert_eq!(invoice_body(1_000, "", 1).unwrap()["expiry_secs"], 60);
    }

    #[test]
    fn receipts_drop_preimages_and_normalise_status() {
        let pay: PayReply = serde_json::from_value(json!({"payment_hash": "HASH", "amount_msat": 1000, "preimage": "PRE"})).unwrap();
        let out = serde_json::to_string(&pay.receipt(5)).unwrap();
        assert!(out.contains("\"status\":\"settled\"") && !out.contains("PRE") && !out.contains("HASH"));
        let pending: PayReply = serde_json::from_value(json!({"payment_hash": "h", "amount_msat": 1000, "preimage": ""})).unwrap();
        assert_eq!(pending.receipt(5).status, "pending");
        let ks: KeysendReply = serde_json::from_value(json!({"payment_hash": "h", "amount_msat": 1000, "preimage": "p", "status": "InFlight"})).unwrap();
        assert_eq!(ks.receipt(5).status, "inflight");
    }

    #[test]
    fn invites_are_bound_to_one_key_and_bounded_in_time() {
        let body = invite_body(A, "203.0.113.5:9735", 24, 1_000).unwrap();
        assert_eq!(body, json!({"invitee_pubkey": A, "expiry_unix": 1_000 + 86_400, "addr": "203.0.113.5:9735"}));
        assert!(invite_body(A, "nohost", 24, 0).is_err());
        assert!(invite_body(A, "host:0", 24, 0).is_err());
        assert!(invite_body(A, "a b:1", 24, 0).is_err());
        assert!(invite_body(A, "h:1", 0, 0).is_err());
        assert!(invite_body(A, "h:1", INVITE_MAX_HOURS + 1, 0).is_err());
        assert!(invite_body("x", "h:1", 1, 0).is_err());
        assert_eq!(invite_token("bitsov://invite/eyJ2Ijoy_-x").unwrap(), "eyJ2Ijoy_-x");
        assert!(invite_token("bitsov://invite/a b").is_err());
        assert!(invite_token("").is_err());
    }

    #[test]
    fn files_are_checked_before_upload() {
        assert_eq!(base64_decoded_len("aGk="), Some(2));
        assert_eq!(base64_decoded_len("aGVsbG8="), Some(5));
        assert_eq!(base64_decoded_len("aGk"), None);
        assert_eq!(base64_decoded_len("a-k="), None);
        assert!(file_upload_body("note.txt", "text/plain", "aGk=").is_ok());
        assert_eq!(file_upload_body("n.bin", "", "aGk=").unwrap()["mime_type"], "application/octet-stream");
        assert!(file_upload_body("../etc", "", "aGk=").is_err());
        assert!(file_upload_body("a/b", "", "aGk=").is_err());
        assert!(file_upload_body("a", "", "").is_err());
        let big = "A".repeat((FILE_MAX_BYTES / 3 + 1) * 4);
        assert!(file_upload_body("big.bin", "", &big).unwrap_err().message.contains("1.4 MB"));
        assert!(file_send_path("../x").is_err());
        assert_eq!(file_send_path(ROOM).unwrap(), format!("/files/{ROOM}/send"));
        // F1 (#83) stages paired uploads in memory as `stage-<uuid>`.
        assert_eq!(file_send_path(&format!("stage-{ROOM}")).unwrap(), format!("/files/stage-{ROOM}/send"));
        assert!(file_send_path("stage-../x").is_err());
        assert!(file_send_path("stage-").is_err());
        assert!(file_send_path(&format!("stage-{ROOM}/../x")).is_err());
    }

    #[test]
    fn call_bodies_are_one_contact_one_signal() {
        let peer = "ab".repeat(32);
        let body = call_body(&peer.to_uppercase(), 400, r#"{"v":1}"#).unwrap();
        assert_eq!(body, json!({"recipient": peer, "is_room": false, "kind": 400, "plaintext": r#"{"v":1}"#}));
        assert!(call_body(&peer, 0, "{}").is_err());
        assert!(call_body(&peer, 404, "{}").is_err());
        assert!(call_body(&peer, 401, "hi").is_err());
        assert!(call_body(&peer, 401, "[]").is_err());
        assert!(call_body(ROOM, 401, "{}").is_err());
        let big = format!(r#"{{"sdp":"{}"}}"#, "a".repeat(CALL_SIGNAL_MAX_BYTES));
        assert!(call_body(&peer, 401, &big).is_err());
    }

    #[test]
    fn only_audio_files_resolve_as_voice_notes() {
        let row = |id: &str, mime: &str, m: Option<&str>| FileRow { id: id.into(), mime_type: mime.into(), message_id: m.map(Into::into) };
        let rows = [
            row("a", "application/pdf", Some("AB")),
            row("b", "audio/webm", Some("ab")),
            row("c", "audio/webm", None),
        ];
        let rows = [rows[1].clone(), rows[0].clone(), rows[2].clone()];
        assert_eq!(voice_file_for(&rows, "ab"), VoiceLookup::Voice(&rows[0]));
        assert_eq!(voice_file_for(&rows, "AB"), VoiceLookup::Voice(&rows[0]));
        // A name that looks like a voice note does not make a PDF one.
        assert_eq!(voice_file_for(&rows[1..], "ab"), VoiceLookup::NotVoice);
        assert_eq!(voice_file_for(&rows, "cd"), VoiceLookup::Missing);
        assert!(is_voice_mime(" Audio/MP4"));
        assert!(!is_voice_mime("text/html"));
        assert_eq!(stored_file_for(&rows, "ab"), StoredLookup::Found(&rows[0]));
        assert_eq!(stored_file_for(&rows[1..], "ab"), StoredLookup::Found(&rows[1]));
        assert_eq!(stored_file_for(&rows, "zz"), StoredLookup::Missing);
    }

    #[test]
    fn received_files_refuse_the_size_cap_and_sanitize_save_names() {
        let ok = FileBlob {
            filename: "note.txt".into(),
            mime_type: "text/plain".into(),
            size_bytes: 2,
            data_b64: "aGk=".into(),
        };
        blob_within_cap(&ok).unwrap();
        let big = FileBlob {
            filename: "big.bin".into(),
            mime_type: "application/octet-stream".into(),
            size_bytes: (FILE_MAX_BYTES as u64) + 1,
            data_b64: "aGk=".into(),
        };
        assert_eq!(blob_within_cap(&big).unwrap_err(), FILE_TOO_LARGE);
        assert_eq!(safe_save_name("../etc/passwd"), "passwd");
        assert_eq!(safe_save_name("a\\b:c.png"), "b_c.png");
        assert_eq!(safe_save_name("..."), "file");
        assert_eq!(safe_save_name("note.txt   "), "note.txt");
        let long = format!("{}.png", "a".repeat(SAVE_NAME_MAX + 40));
        let capped = safe_save_name(&long);
        assert!(capped.len() <= SAVE_NAME_MAX);
        assert!(!capped.ends_with('.'));
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(safe_save_name("hi.txt"));
        write_file_bytes(&path, "aGk=").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"hi");
    }

    /// The node's BUG-PSI reply, as genome #100's compose writes it.
    fn psi(amount: u64, prior: u64, current: u64, tail: &str) -> String {
        serde_json::json!({
            "error": format!("payment settled but send did not complete (prior admission: {prior} msat; current call: {current} msat): {tail}"),
            "code": "payment_settled_send_incomplete",
            "amount_msat": amount,
        }).to_string()
    }
    const SESSION_TIMEOUT: &str = "internal error: first-contact admission payment for 02ab settled and a signed proof is held, but the E2EE session did not establish within 25s (the proof envelope may still need re-delivery) — retry the message shortly; the retry is guarded by admission idempotence and will NOT pay admission again";

    #[test]
    fn settled_incomplete_reads_amount_and_admission_fields() {
        let got = settled_incomplete(502, &psi(2000, 0, 2000, SESSION_TIMEOUT)).unwrap();
        assert_eq!(got, SettledIncomplete { amount_msat: 2000, prior_admission_msat: Some(0), current_call_msat: Some(2000), retry_safe: true });
        // A retry on the same connection: the prior admission is not a new debit.
        let again = settled_incomplete(502, &psi(0, 2000, 0, SESSION_TIMEOUT)).unwrap();
        assert_eq!((again.amount_msat, again.prior_admission_msat, again.retry_safe), (0, Some(2000), true));
        let envelope = "internal error: admission payment settled but delivering the admission envelope failed (a retry will re-send the paid proof, not pay again): closed";
        assert!(settled_incomplete(502, &psi(2000, 0, 2000, envelope)).unwrap().retry_safe);
    }

    #[test]
    fn settled_incomplete_offers_no_retry_unless_the_node_says_so() {
        // A message paid, then not stored: sending again would pay again.
        let stored = serde_json::json!({"error":"file payment settled but storing message failed: disk","code":"payment_settled_send_incomplete","amount_msat":3000}).to_string();
        assert_eq!(settled_incomplete(502, &stored).unwrap(), SettledIncomplete { amount_msat: 3000, prior_admission_msat: None, current_call_msat: None, retry_safe: false });
        assert!(!settled_incomplete(502, &psi(4000, 0, 4000, "bad request: no route")).unwrap().retry_safe);
        // The reported total must be the current call the reason names.
        assert!(!settled_incomplete(502, &psi(4000, 0, 2000, SESSION_TIMEOUT)).unwrap().retry_safe);
        // Not this error: the caller keeps its generic outcome-unknown path.
        assert!(settled_incomplete(500, &psi(2000, 0, 2000, SESSION_TIMEOUT)).is_none());
        assert!(settled_incomplete(502, r#"{"error":"no route","code":502}"#).is_none());
        assert!(settled_incomplete(502, r#"{"code":"payment_settled_send_incomplete"}"#).is_none(), "no amount, no mapping");
        assert!(settled_incomplete(502, "bad gateway").is_none());
    }

    #[test]
    fn undelivered_copy_never_says_not_sent() {
        let retry = ActionError::undelivered(2000, true);
        assert_eq!(retry.code, "payment_settled_undelivered");
        assert_eq!(retry.undelivered, Some(UndeliveredView { paid_msat: 2000, retry: true }));
        assert!(retry.message.starts_with("Payment settled (2000 msat paid), message not yet delivered. Do not send it again."), "{}", retry.message);
        assert!(retry.message.contains("Retry delivery pays nothing new") && retry.message.contains("asks you first"), "{}", retry.message);
        assert!(!retry.message.contains("no second admission"), "never promise what the node does not enforce");
        let stop = ActionError::undelivered(3000, false);
        assert!(stop.message.contains("Do not send it again") && !stop.message.contains("Retry"), "{}", stop.message);
        let wire = serde_json::to_value(&stop).unwrap();
        assert_eq!(wire["undelivered"], serde_json::json!({"paid_msat": 3000, "retry": false}));
        assert!(serde_json::to_value(ActionError::node("x")).unwrap().get("undelivered").is_none());
        assert!(serde_json::to_value(ActionError::node("x")).unwrap().get("admission").is_none());
        assert!(serde_json::to_value(ActionError::node("x")).unwrap().get("pending_id").is_none());
        assert_eq!(serde_json::to_value(retry.for_pending("r1")).unwrap()["pending_id"], "r1");
    }

    #[test]
    fn needs_admission_shows_the_price_or_says_it_is_unknown() {
        let v = AdmissionView { admission_msat: 2000, message_msat: 1000, max_routing_fee_msat: 0, total_msat: 3000, quoted: true };
        let e = ActionError::needs_admission(Some(v));
        assert_eq!((e.code, e.admission), ("retry_needs_admission", Some(v)));
        assert!(e.message.contains("Nothing was paid") && e.message.contains("3000 msat in all"), "{}", e.message);
        let estimate = ActionError::needs_admission(Some(AdmissionView { quoted: false, ..v }));
        assert!(estimate.message.contains("up to 3000 msat"), "{}", estimate.message);
        let unknown = ActionError::needs_admission(None);
        assert!(unknown.admission.is_none() && unknown.message.contains("could not tell the price"));
        assert_eq!(serde_json::to_value(&e).unwrap()["admission"], serde_json::json!({"admission_msat": 2000, "message_msat": 1000, "max_routing_fee_msat": 0, "total_msat": 3000, "quoted": true}));
    }
}
