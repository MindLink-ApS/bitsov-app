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

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::control::{self, KIND_CHAT};

/// `KIND_FILE_REF` (konsensus-core `kind.rs`): a file sent as a message.
pub const KIND_FILE_REF: u16 = 200;

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

// ---- errors -------------------------------------------------------------------

/// A refused or failed action. `code` lets the renderer react (re-prompt for
/// approval, name the unreachable members); `message` is shown as written.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct ActionError {
    pub code: &'static str,
    pub message: String,
}

impl ActionError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid", message)
    }
    pub fn node(message: impl Into<String>) -> Self {
        Self::new("node", message)
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

/// A pending `POST /pair/elevation-request`.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
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

/// What the renderer is told about spending. No token, no scope list.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct SpendView {
    pub state: SpendState,
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
}

impl SpendGate {
    /// Open the window for [`SPEND_WINDOW_MS`] from `now_ms`.
    pub fn arm(&mut self, now_ms: u64, basis: SpendBasis) {
        self.generation = self.generation.wrapping_add(1);
        self.open = Some((now_ms + SPEND_WINDOW_MS, basis));
        self.pending = None;
        self.expired = false;
    }

    /// The owner locked spending, or the app lost its authority.
    pub fn lock(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.open = None;
        self.pending = None;
        self.expired = false;
    }

    pub fn set_pending(&mut self, elevation: Elevation) {
        self.generation = self.generation.wrapping_add(1);
        self.open = None;
        self.expired = false;
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
    }

    /// The owner's request lapsed on the node.
    pub fn pending_expired(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.pending = None;
        self.expired = true;
    }

    fn settle(&mut self, now_ms: u64) {
        if let Some((until, _)) = self.open {
            if until <= now_ms {
                self.generation = self.generation.wrapping_add(1);
                self.open = None;
                self.expired = true;
            }
        }
        if let Some(p) = &self.pending {
            if p.expires_at_ms <= now_ms {
                self.generation = self.generation.wrapping_add(1);
                self.pending = None;
                self.expired = true;
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
    pub fn into_elevation(self) -> Result<Elevation, ActionError> {
        if self.op_id.is_empty() || self.op_id.len() > 64 || !self.op_id.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(ActionError::node("the node returned an unexpected operation id"));
        }
        let owner_can_grant = self.owner_action.trim_start().starts_with("konsensus grant");
        Ok(Elevation {
            op_id: self.op_id,
            expires_at_ms: (self.expires_at.max(0) as u64).saturating_mul(1000),
            owner_action: self.owner_action.chars().take(600).collect(),
            owner_can_grant,
        })
    }
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

/// `compose` and `files/:id/send` response.
#[derive(Deserialize, Debug)]
pub struct SendReply {
    pub message_id: String,
    pub delivered: bool,
    pub amount_msat: u64,
}

/// What a send shows in the stream, straight after it returns.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct SendReceipt {
    pub message_id: String,
    pub recipient: String,
    pub is_room: bool,
    /// Handed to the recipient's node now; `false` means queued.
    pub delivered: bool,
    /// What this send actually paid, summed over room members.
    pub amount_msat: u64,
    pub sent_at_ms: u64,
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
    pub node_id: String,
    pub msat: u64,
    /// The member's own advertised price (fresh table), not this node's estimate.
    pub advertised: bool,
    pub connected: bool,
}

/// `room_quote`: a room message costs each member's own price, paid separately.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct RoomQuote {
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
) -> RoomQuote {
    let mut out = Vec::new();
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
        out.push(MemberCost {
            node_id: id,
            msat: advertised.unwrap_or(own_msat).max(MIN_PAYMENT_MSAT),
            advertised: advertised.is_some(),
            connected,
        });
    }
    RoomQuote {
        room_id: room_id.to_string(),
        total_msat: out.iter().map(|m| m.msat).sum(),
        unreachable: out.iter().filter(|m| !m.connected).map(|m| m.node_id.clone()).collect(),
        estimate: out.iter().any(|m| !m.advertised),
        members: out,
    }
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

/// The amount a BOLT 11 invoice names, in msat, read from its human-readable
/// part. `None` for an amountless invoice. The app refuses those: it cannot
/// show the cost before paying.
pub fn bolt11_amount_msat(invoice: &str) -> Result<Option<u64>, ActionError> {
    let lower = invoice.trim().to_ascii_lowercase();
    let lower = lower.strip_prefix("lightning:").unwrap_or(&lower);
    if lower.len() > 2048 {
        return Err(ActionError::invalid("that invoice is too long"));
    }
    let hrp = lower
        .rfind('1')
        .map(|i| &lower[..i])
        .and_then(|h| h.strip_prefix("ln"))
        .ok_or_else(|| ActionError::invalid("that is not a Lightning invoice"))?;
    let digits_at = hrp.find(|c: char| c.is_ascii_digit()).unwrap_or(hrp.len());
    let (currency, amount) = hrp.split_at(digits_at);
    if !matches!(currency, "bc" | "tb" | "tbs" | "bcrt" | "sb") {
        return Err(ActionError::invalid("that is not a Lightning invoice"));
    }
    if amount.is_empty() {
        return Ok(None);
    }
    let (number, multiplier) = match amount.chars().last() {
        Some(c @ ('m' | 'u' | 'n' | 'p')) => (&amount[..amount.len() - 1], Some(c)),
        _ => (amount, None),
    };
    let bad = || ActionError::invalid("the invoice amount could not be read");
    if number.is_empty() || !number.chars().all(|c| c.is_ascii_digit()) || number.starts_with('0') {
        return Err(bad());
    }
    let n: u64 = number.parse().map_err(|_| bad())?;
    let msat = match multiplier {
        None => n.checked_mul(100_000_000_000),
        Some('m') => n.checked_mul(100_000_000),
        Some('u') => n.checked_mul(100_000),
        Some('n') => n.checked_mul(100),
        Some('p') if n.is_multiple_of(10) => Some(n / 10),
        _ => None,
    }
    .ok_or_else(bad)?;
    Ok(Some(msat))
}

/// Which chain an invoice is for, from its prefix. Shown next to the amount.
pub fn bolt11_network(invoice: &str) -> &'static str {
    let lower = invoice.trim().to_ascii_lowercase();
    let lower = lower.strip_prefix("lightning:").unwrap_or(&lower);
    if lower.starts_with("lnbcrt") {
        "regtest"
    } else if lower.starts_with("lnbc") {
        "mainnet"
    } else if lower.starts_with("lntbs") {
        "signet"
    } else if lower.starts_with("lntb") {
        "testnet"
    } else {
        "unknown"
    }
}

/// `invoice_amount`: what paying this invoice would cost, before paying.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct InvoiceAmount {
    pub amount_msat: u64,
    pub network: &'static str,
}

pub fn invoice_amount(invoice: &str) -> Result<InvoiceAmount, ActionError> {
    let amount_msat = bolt11_amount_msat(invoice)?.ok_or_else(|| {
        ActionError::invalid("This invoice names no amount. The app pays only invoices whose cost it can show first.")
    })?;
    Ok(InvoiceAmount {
        amount_msat,
        network: bolt11_network(invoice),
    })
}

/// `POST /payments/pay` body, refused unless the invoice asks for exactly the
/// amount the owner was shown.
pub fn pay_body(invoice: &str, confirmed_msat: u64) -> Result<serde_json::Value, ActionError> {
    let shown = invoice_amount(invoice)?;
    if shown.amount_msat != confirmed_msat {
        return Err(ActionError::invalid(
            "The invoice amount does not match the cost you confirmed. Nothing was paid.",
        ));
    }
    let bolt11 = invoice.trim();
    let bolt11 = bolt11.strip_prefix("lightning:").unwrap_or(bolt11);
    Ok(json!({ "bolt11": bolt11 }))
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
    pub amount_msat: u64,
    #[serde(default)]
    pub preimage: String,
}

/// `/payments/keysend` response. `status` is Debug-cased by the node.
#[derive(Deserialize, Debug)]
pub struct KeysendReply {
    pub amount_msat: u64,
    pub status: String,
}

/// A payment as the stream shows it. No hash, no preimage.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct PaymentReceipt {
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

#[derive(Deserialize, Debug)]
pub struct UploadReply {
    pub file_id: String,
    pub size_bytes: u64,
}

pub fn file_send_path(file_id: &str) -> Result<String, ActionError> {
    Ok(format!("/files/{}/send", control::room_id(file_id).map_err(|_| ActionError::node("the node returned an unexpected file id"))?))
}

/// A sent file, as the stream shows it.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct FileReceipt {
    pub message_id: String,
    pub recipient: String,
    pub filename: String,
    pub size_bytes: u64,
    pub delivered: bool,
    pub amount_msat: u64,
    pub sent_at_ms: u64,
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
        gate.set_pending(reply.into_elevation().unwrap());
        assert_eq!(gate.view(99_999).state, SpendState::Pending);
        assert_eq!(gate.check(99_999).unwrap_err().code, "spend_locked");
        assert_eq!(gate.view(100_000).state, SpendState::Expired);

        let sidecar = ElevationReply {
            op_id: "cd34".into(),
            expires_at: 100,
            owner_action: "unavailable in this deployment: …".into(),
        };
        gate.set_pending(sidecar.into_elevation().unwrap());
        let view = gate.view(0);
        assert_eq!(view.state, SpendState::Unavailable);
        assert!(!view.pending.unwrap().owner_can_grant);

        let hostile = ElevationReply { op_id: "../x".into(), expires_at: 1, owner_action: String::new() };
        assert!(hostile.into_elevation().is_err());
        assert!(elevation_status_path("../../payments").is_err());
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
        control::Peer { node_id: id.into(), addr: None, label: None, connected, fingerprint: None }
    }

    #[test]
    fn room_cost_is_the_sum_of_each_members_own_price() {
        let tables = vec![
            control::PeerPrice { peer_id: A.into(), prices: HashMap::from([("communication".into(), 2_000)]), age_secs: 10, stale: false },
            control::PeerPrice { peer_id: B.into(), prices: HashMap::from([("communication".into(), 9_000)]), age_secs: 9_000, stale: true },
        ];
        let members = vec![OWN.into(), A.to_uppercase(), B.into(), A.into()];
        let q = room_quote(ROOM, OWN, 500, &members, &[peer(A, true), peer(B, true)], &tables);
        // A: advertised 2000. B: stale table, so own price 500, floored at 1 sat. Self and duplicates skipped.
        assert_eq!(q.members.len(), 2);
        assert_eq!((q.members[0].msat, q.members[0].advertised), (2_000, true));
        assert_eq!((q.members[1].msat, q.members[1].advertised), (1_000, false));
        assert_eq!(q.total_msat, 3_000);
        assert!(q.estimate);
        assert!(q.unreachable.is_empty());
        assert!(room_sendable(&q).is_ok());
    }

    #[test]
    fn a_room_with_an_unconnected_member_is_not_sendable() {
        let members = vec![OWN.into(), A.into(), C.into()];
        let q = room_quote(ROOM, OWN, 1_000, &members, &[peer(A, true), peer(C, false)], &[]);
        assert_eq!(q.unreachable, vec![C.to_string()]);
        let err = room_sendable(&q).unwrap_err();
        assert_eq!(err.code, "room_unreachable");
        assert!(err.message.contains("1 member is not a connected peer"));
        let alone = room_quote(ROOM, OWN, 1_000, &[OWN.into()], &[], &[]);
        assert_eq!(room_sendable(&alone).unwrap_err().code, "room_unreachable");
    }

    #[test]
    fn bolt11_amounts_are_read_from_the_prefix() {
        assert_eq!(bolt11_amount_msat("lnbc2500u1pvjluez").unwrap(), Some(250_000_000));
        assert_eq!(bolt11_amount_msat("LNBC20M1PVJLUEZ").unwrap(), Some(2_000_000_000));
        assert_eq!(bolt11_amount_msat("lntb10n1abc").unwrap(), Some(1_000));
        assert_eq!(bolt11_amount_msat("lnbcrt1500n1xyz").unwrap(), Some(150_000));
        assert_eq!(bolt11_amount_msat("lnbc10p1abc").unwrap(), Some(1));
        assert_eq!(bolt11_amount_msat("lightning:lnbc1u1abc").unwrap(), Some(100_000));
        assert_eq!(bolt11_amount_msat("lnbc1pvjluez").unwrap(), None, "amountless");
        assert!(bolt11_amount_msat("lnbc15p1abc").is_err(), "sub-msat");
        assert!(bolt11_amount_msat("lnbc01u1abc").is_err());
        assert!(bolt11_amount_msat("hello").is_err());
        assert!(bolt11_amount_msat("lnxx10u1abc").is_err());
        assert!(bolt11_amount_msat("lnbc99999999999999999999m1abc").is_err());
        assert_eq!(bolt11_network("lnbcrt1n1x"), "regtest");
        assert_eq!(bolt11_network("lntb1n1x"), "testnet");
        assert_eq!(bolt11_network("lnbc1n1x"), "mainnet");
    }

    #[test]
    fn pay_refuses_amountless_and_mismatched_invoices() {
        assert_eq!(pay_body("lnbc10n1abc", 1_000).unwrap(), json!({"bolt11": "lnbc10n1abc"}));
        assert_eq!(pay_body("lightning:lnbc10n1abc", 1_000).unwrap(), json!({"bolt11": "lnbc10n1abc"}));
        assert!(pay_body("lnbc10n1abc", 999).unwrap_err().message.contains("does not match"));
        assert!(pay_body("lnbc1abc", 0).unwrap_err().message.contains("no amount"));
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
    }
}
