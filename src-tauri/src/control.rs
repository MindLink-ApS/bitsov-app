//! Control center reads: typed node shapes, path building, and the `/ws` bridge.
//!
//! Everything here is READ or RECEIVE scope (a paired app holds `read + receive`;
//! rc7's `/auth/local` mints the same pair). Nothing here sends, pays, admits a
//! peer, or edits a room — that is slice B, behind owner elevation.
//!
//! Shapes follow BitSov-bitsov `v0.3.0-rc7` (`958e399`), `crates/konsensus-api`:
//! `handlers/peers.rs`, `rooms.rs`, `messages/query.rs`, `payments.rs`,
//! `pricing.rs`, `health.rs`, and `ws.rs`. Unknown fields are ignored so a newer
//! node does not break the app. What reaches the renderer is a projection: no
//! ciphertext, preimage, signature, nonce, token or key is ever forwarded.

use std::collections::HashMap;
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tokio_tungstenite::tungstenite::Message as Frame;

/// `KIND_CHAT` (konsensus-core `kind.rs`): a plain text message.
pub const KIND_CHAT: u16 = 0;
/// The pricing category `KIND_CHAT` falls in.
pub const CATEGORY_COMMUNICATION: &str = "communication";
/// Default and ceiling for one history page (the node clamps to 1000).
pub const DEFAULT_PAGE: u32 = 50;
pub const MAX_PAGE: u32 = 200;

// ---- node shapes (deserialize) ---------------------------------------------

/// `GET /peers` — `PeerResponse`.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
pub struct Peer {
    pub node_id: String,
    #[serde(default)]
    pub addr: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub connected: bool,
    #[serde(default)]
    pub fingerprint: Option<String>,
}

/// `GET /rooms` — `RoomResponse`. `metadata` is not forwarded.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
pub struct Room {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub created_by: Option<String>,
    /// ISO 8601, as the node sends it.
    #[serde(default)]
    pub created_at: Option<String>,
}

/// `GET /messages` — `MessageResponse`, minus ciphertext and payment hash.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
pub struct Message {
    pub id: String,
    pub kind: u16,
    pub sender: String,
    /// Hex node id, room UUID, or `broadcast`.
    pub recipient: String,
    /// Unix milliseconds.
    pub timestamp: u64,
    #[serde(default)]
    pub plaintext: Option<String>,
    #[serde(default)]
    pub payment_amount_msat: Option<u64>,
}

/// `GET /payments/price/:kind` — `PriceResponse`.
#[derive(Deserialize, Clone, Debug)]
pub struct KindPrice {
    pub kind: u16,
    pub price_msat: u64,
}

/// `GET /pricing/peers` — `PeerPriceResponse`.
#[derive(Deserialize, Clone, Debug)]
pub struct PeerPrice {
    pub peer_id: String,
    #[serde(default)]
    pub prices: HashMap<String, u64>,
    #[serde(default)]
    pub age_secs: u64,
    #[serde(default)]
    pub stale: bool,
}

/// `GET /payments/channels` — `ChannelResponse`.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
pub struct Channel {
    pub channel_id: String,
    pub peer_pubkey: String,
    pub capacity_msat: u64,
    pub local_balance_msat: u64,
    pub remote_balance_msat: u64,
    pub active: bool,
}

/// Offline-readiness v1, genome PR #107. Timestamps are Unix seconds.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
pub struct ReadinessEvent {
    pub sequence: u64,
    pub timestamp: u64,
    pub state: String,
    pub money_ready: bool,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
pub struct LightningReadiness {
    pub money_ready: bool,
    pub state: String,
    pub retry_attempt: u64,
    pub retry_after_secs: Option<u64>,
    pub events: Vec<ReadinessEvent>,
}

/// `GET /status` — `HealthResponse`. The subset the Node panel shows.
#[derive(Deserialize, Clone, Debug)]
pub struct NodeStatusResponse {
    #[serde(default)]
    pub money_ready: Option<bool>,
    #[serde(default)]
    pub readiness: Option<LightningReadiness>,
    pub status: String,
    pub node_id: String,
    #[serde(default)]
    pub connected_peers: u64,
    #[serde(default)]
    pub e2ee_sessions: u64,
    #[serde(default)]
    pub pending_deliveries: u64,
    #[serde(default)]
    pub lightning_available: bool,
    #[serde(default)]
    pub uptime_secs: u64,
    #[serde(default)]
    pub version: Option<u16>,
    #[serde(default)]
    pub lightning_backend: Option<String>,
    #[serde(default)]
    pub chain_backend: Option<String>,
    #[serde(default)]
    pub block_height: Option<u64>,
    /// What this node build can do (`energy_v1`, `membrane_v1`, …). Absent on rc7.
    #[serde(default)]
    pub api_capabilities: Vec<String>,
}

// ---- organism reads (O1 v2: genome N1 + N2) ----------------------------------
//
// Local reads of this node's own ledger, read scope. A counterparty is a node id
// or room id this node already stores; each is re-validated here so nothing
// unshaped reaches the renderer. Payment hashes, preimages, ciphertext and
// signatures are not in these node shapes and are not accepted if they appear.

/// Capabilities the renderer may act on. Anything else the node lists is dropped.
pub const KNOWN_CAPABILITIES: &[&str] = &["energy_v1", "membrane_v1"];

pub fn known_capabilities(listed: &[String]) -> Vec<String> {
    KNOWN_CAPABILITIES
        .iter()
        .filter(|c| listed.iter().any(|l| l == *c))
        .map(|c| (*c).to_string())
        .collect()
}

/// A node id or a room UUID, lowercased; anything else is refused.
fn counterparty_id(value: &str) -> Option<String> {
    node_id(value).or_else(|_| room_id(value)).ok()
}

/// `?window=` for `GET /energy`.
pub fn energy_path(window: &str) -> Result<String, String> {
    match window {
        "1h" | "24h" | "7d" => Ok(format!("/energy?window={window}")),
        _ => Err("window must be 1h, 24h or 7d".into()),
    }
}

/// `GET /membrane?limit=` (the node caps at its ring size).
pub fn membrane_path(limit: Option<u32>) -> String {
    format!("/membrane?limit={}", limit.unwrap_or(50).clamp(1, 500))
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
pub struct EnergyBucket {
    pub start_ms: u64,
    #[serde(default)]
    pub in_msat: u64,
    #[serde(default)]
    pub out_msat: u64,
}

#[derive(Deserialize, Clone, Debug)]
struct NodeCounterpartyEnergy {
    counterparty: String,
    #[serde(default)]
    counterparty_kind: Option<String>,
    #[serde(default)]
    in_msat: u64,
    #[serde(default)]
    out_msat: u64,
    #[serde(default)]
    in_count: u64,
    #[serde(default)]
    out_count: u64,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Default)]
pub struct EnergyTotals {
    #[serde(default)]
    pub in_msat: u64,
    #[serde(default)]
    pub out_msat: u64,
    #[serde(default)]
    pub in_count: u64,
    #[serde(default)]
    pub out_count: u64,
}

/// `GET /energy` as the node sends it.
#[derive(Deserialize, Clone, Debug)]
pub struct NodeEnergy {
    window: String,
    as_of_ms: u64,
    #[serde(default)]
    bucket_ms: u64,
    #[serde(default)]
    buckets: Vec<EnergyBucket>,
    #[serde(default)]
    counterparties: Vec<NodeCounterpartyEnergy>,
    #[serde(default)]
    totals: EnergyTotals,
    #[serde(default)]
    truncated: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct CounterpartyEnergy {
    /// `peer` or `room`, as the renderer keys tracks.
    pub kind: &'static str,
    pub id: String,
    pub in_msat: u64,
    pub out_msat: u64,
    pub in_count: u64,
    pub out_count: u64,
}

/// `energy_read`: the renderer's projection of `GET /energy`.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct EnergyRead {
    pub window: String,
    pub as_of_ms: u64,
    pub bucket_ms: u64,
    /// Oldest first; a bucket with nothing in it is absent (a gap, not a zero).
    pub buckets: Vec<EnergyBucket>,
    pub counterparties: Vec<CounterpartyEnergy>,
    pub totals: EnergyTotals,
    pub truncated: bool,
}

impl EnergyRead {
    pub fn from_node(node: NodeEnergy) -> Self {
        let counterparties = node
            .counterparties
            .into_iter()
            .filter_map(|c| {
                let id = counterparty_id(&c.counterparty)?;
                let kind = if c.counterparty_kind.as_deref() == Some("room") || id.contains('-') { "room" } else { "peer" };
                Some(CounterpartyEnergy { kind, id, in_msat: c.in_msat, out_msat: c.out_msat, in_count: c.in_count, out_count: c.out_count })
            })
            .collect();
        let mut buckets = node.buckets;
        buckets.sort_by_key(|b| b.start_ms);
        Self {
            window: node.window,
            as_of_ms: node.as_of_ms,
            bucket_ms: node.bucket_ms,
            buckets,
            counterparties,
            totals: node.totals,
            truncated: node.truncated,
        }
    }
}

/// One admission decision at the payment gate (`/ws` `membrane`, `GET /membrane`).
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
pub struct MembraneEvent {
    pub seq: u64,
    pub at: u64,
    /// `inbound` or `outbound`.
    pub direction: String,
    /// `admitted` or `refused`.
    pub verdict: String,
    pub code: String,
    #[serde(default)]
    pub kind: Option<u16>,
    /// Present only when the node verified the sender before deciding.
    #[serde(default)]
    pub counterparty: Option<String>,
    #[serde(default)]
    pub first_contact: bool,
    #[serde(default)]
    pub required_msat: Option<u64>,
    #[serde(default)]
    pub paid_msat: Option<u64>,
    #[serde(default)]
    pub cap_msat: Option<u64>,
}

impl MembraneEvent {
    /// Keep an event only if its enums are known and its counterparty is id-shaped.
    fn checked(mut self) -> Option<Self> {
        let token = |s: &str| !s.is_empty() && s.len() <= 40 && s.bytes().all(|b| b.is_ascii_lowercase() || b == b'_');
        if !matches!(self.direction.as_str(), "inbound" | "outbound")
            || !matches!(self.verdict.as_str(), "admitted" | "refused")
            || !token(&self.code)
        {
            return None;
        }
        self.counterparty = match self.counterparty.take() {
            Some(c) => Some(counterparty_id(&c)?),
            None => None,
        };
        Some(self)
    }
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Default)]
pub struct MembraneTotals {
    #[serde(default)]
    pub admitted: u64,
    #[serde(default)]
    pub first_contacts: u64,
    #[serde(default)]
    pub refused: u64,
    #[serde(default)]
    pub outbound_refused: u64,
}

mod refusals;
use refusals::{NodePrePaymentRefusals, PrePaymentRefusals};

#[derive(Deserialize, Clone, Debug)]
pub struct NodeMembrane {
    #[serde(default)]
    capacity: u64,
    #[serde(default)]
    totals: MembraneTotals,
    #[serde(default)]
    events: Vec<MembraneEvent>,
    #[serde(default)]
    pre_payment_refusals: Option<NodePrePaymentRefusals>,
}

/// `membrane_read`: the node's bounded ring, newest first.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct MembraneRead {
    pub capacity: u64,
    pub totals: MembraneTotals,
    pub events: Vec<MembraneEvent>,
    /// None means an older node or an unavailable aggregate, never zero.
    pub pre_payment_refusals: Option<PrePaymentRefusals>,
    /// Unix ms when the host read it.
    pub read_at: u64,
}

impl MembraneRead {
    pub fn from_node(node: NodeMembrane, read_at: u64) -> Self {
        Self {
            capacity: node.capacity,
            totals: node.totals,
            events: node.events.into_iter().filter_map(MembraneEvent::checked).collect(),
            pre_payment_refusals: node.pre_payment_refusals.and_then(|counts| counts.project()),
            read_at,
        }
    }
}

// ---- renderer shapes (serialize) -------------------------------------------

/// `price_quote`: what reaching one track costs, and where the figure came from.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PriceQuote {
    pub max_routing_fee_msat: u64,
    pub kind: u16,
    /// This node's own price for the kind.
    pub own_msat: u64,
    /// The peer's advertised price, if the node holds its pricing table.
    pub peer_msat: Option<u64>,
    pub peer_age_secs: Option<u64>,
    pub peer_stale: bool,
}

/// `first_contact_quote`: a stranger's own signed price before anything is
/// paid (genome `first_contact_grant_v1`). The admission is paid once; the
/// message price is for this first message; `total_msat` is the cap to confirm.
#[derive(Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct FirstContactQuote {
    #[serde(default)]
    pub max_routing_fee_msat: u64,
    pub recipient: String,
    pub admission_msat: u64,
    pub message_msat: u64,
    pub total_msat: u64,
    /// Unix seconds. After it the node asks the stranger again when sending,
    /// still capped at the confirmed total.
    pub expires_at: u64,
}

/// `payments_overview`.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct WalletOverview {
    /// rc7 returns ONE figure: Lightning + spendable on-chain. No split exists.
    pub balance_msat: u64,
    /// Sum of channel outbound capacity. Not a partition of `balance_msat`.
    pub lightning_outbound_msat: u64,
    pub channels: Vec<Channel>,
}

/// `node_overview`.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct NodeOverview {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub money_ready: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub readiness: Option<LightningReadiness>,
    pub node_id: String,
    pub status: String,
    pub version: Option<String>,
    pub connected_peers: u64,
    pub e2ee_sessions: u64,
    pub pending_deliveries: u64,
    pub lightning_available: bool,
    pub block_height: Option<u64>,
    pub uptime_secs: u64,
    pub lightning_backend: Option<String>,
    pub chain_backend: Option<String>,
    /// Known capabilities only (see [`KNOWN_CAPABILITIES`]).
    pub capabilities: Vec<String>,
    /// Unix ms when the host read it, for the freshness line.
    pub read_at: u64,
}

impl NodeOverview {
    pub fn from_status(status: NodeStatusResponse, read_at: u64) -> Self {
        Self {
            money_ready: status.money_ready,
            readiness: status.readiness,
            node_id: status.node_id,
            status: status.status,
            version: status.version.map(|v| format!("api v{v}")),
            connected_peers: status.connected_peers,
            e2ee_sessions: status.e2ee_sessions,
            pending_deliveries: status.pending_deliveries,
            lightning_available: status.lightning_available,
            block_height: status.block_height,
            uptime_secs: status.uptime_secs,
            lightning_backend: status.lightning_backend,
            chain_backend: status.chain_backend,
            capabilities: known_capabilities(&status.api_capabilities),
            read_at,
        }
    }
}

pub fn wallet_overview(balance_msat: u64, channels: Vec<Channel>) -> WalletOverview {
    let lightning_outbound_msat = channels
        .iter()
        .filter(|c| c.active)
        .map(|c| c.local_balance_msat)
        .sum();
    WalletOverview {
        balance_msat,
        lightning_outbound_msat,
        channels,
    }
}

/// Combine this node's own kind price with the peer's cached table, if any.
pub fn price_quote(own: KindPrice, tables: &[PeerPrice], peer: Option<&str>) -> PriceQuote {
    let table = peer.and_then(|id| tables.iter().find(|t| t.peer_id.eq_ignore_ascii_case(id)));
    let peer_msat = table.and_then(|t| t.prices.get(CATEGORY_COMMUNICATION).copied());
    PriceQuote {
        max_routing_fee_msat: crate::act::routing_fee(
            peer_msat.filter(|_| table.is_some_and(|t| !t.stale)).unwrap_or(own.price_msat).max(crate::act::MIN_PAYMENT_MSAT)),
        kind: own.kind,
        own_msat: own.price_msat,
        peer_msat,
        peer_age_secs: peer_msat.and(table.map(|t| t.age_secs)),
        peer_stale: peer_msat.is_some() && table.is_some_and(|t| t.stale),
    }
}

// ---- inputs -----------------------------------------------------------------

/// A 64-hex node id, lowercased.
pub fn node_id(value: &str) -> Result<String, String> {
    let v = value.trim();
    if v.len() == 64 && v.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(v.to_ascii_lowercase())
    } else {
        Err("expected a 64-character hex node id".into())
    }
}

/// A room UUID (8-4-4-4-12 hex), lowercased.
pub fn room_id(value: &str) -> Result<String, String> {
    let v = value.trim();
    let parts: Vec<&str> = v.split('-').collect();
    let ok = parts.len() == 5
        && parts
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(p, n)| p.len() == n && p.chars().all(|c| c.is_ascii_hexdigit()));
    if ok {
        Ok(v.to_ascii_lowercase())
    } else {
        Err("expected a room UUID".into())
    }
}

/// `/messages?peer=…&limit=…[&before=…]`. `peer` is a node id or a room UUID;
/// both are validated, so nothing user-shaped is spliced into the path.
pub fn messages_path(peer: &str, before: Option<u64>, limit: Option<u32>) -> Result<String, String> {
    let peer = if peer.contains('-') {
        room_id(peer)?
    } else {
        node_id(peer)?
    };
    let limit = limit.unwrap_or(DEFAULT_PAGE).clamp(1, MAX_PAGE);
    let mut path = format!("/messages?peer={peer}&limit={limit}");
    if let Some(before) = before {
        path.push_str(&format!("&before={before}"));
    }
    Ok(path)
}

pub fn room_members_path(id: &str) -> Result<String, String> {
    Ok(format!("/rooms/{}/members", room_id(id)?))
}

pub fn price_path(kind: u16) -> String {
    format!("/payments/price/{kind}")
}

/// Oldest first, as the stream renders. The node pages newest first.
pub fn chronological(mut messages: Vec<Message>) -> Vec<Message> {
    messages.sort_by(|a, b| a.timestamp.cmp(&b.timestamp).then_with(|| a.id.cmp(&b.id)));
    messages
}

// ---- /ws ----------------------------------------------------------------------

/// What the host forwards to the main window as the `node-live` event.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LiveEvent {
    Message {
        message: Message,
        room_id: Option<String>,
    },
    Delivery {
        message_id: String,
        status: String,
        reason: Option<String>,
    },
    Onboarding {
        step: String,
    },
    Link {
        state: LinkState,
        detail: Option<String>,
    },
    Membrane {
        event: MembraneEvent,
    },
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LinkState {
    Connecting,
    Open,
    Closed,
}

/// The `/ws` link as the socket last reported it.
///
/// Every live event the host forwards passes through [`LiveLink::publish`], so
/// the recorded state is whatever the socket session last said, never what a
/// renderer happened to hear. A renderer that subscribes late (the shell mounts
/// after the bridge has already opened) asks for [`LiveLink::replay`]; both run
/// under one lock, so a replay can never overtake a newer transition.
#[derive(Default)]
pub struct LiveLink {
    current: std::sync::Mutex<Option<LiveEvent>>,
}

impl LiveLink {
    /// Forward `event`, recording it first when it is a link transition.
    pub fn publish(&self, event: LiveEvent, emit: impl FnOnce(LiveEvent)) {
        let mut current = self.current.lock().unwrap();
        if matches!(event, LiveEvent::Link { .. }) {
            *current = Some(event.clone());
        }
        emit(event);
    }

    /// Re-send the current link state, if the bridge has reported one.
    pub fn replay(&self, emit: impl FnOnce(LiveEvent)) -> Option<LinkState> {
        let current = self.current.lock().unwrap();
        let event = current.clone()?;
        let state = match &event {
            LiveEvent::Link { state, .. } => *state,
            _ => unreachable!("only link events are recorded"),
        };
        emit(event);
        Some(state)
    }
}

/// `Recipient` is externally tagged in the envelope: `{"Node":hex}`,
/// `{"Room":uuid}`, or `"Broadcast"`.
#[derive(Deserialize)]
enum WsRecipient {
    Node(String),
    Room(String),
    Broadcast,
}

#[derive(Deserialize)]
struct WsProof {
    #[serde(default)]
    amount_msat: Option<u64>,
}

/// `WsMessage` = flattened `UkmEnvelope` + optional plaintext. Only these
/// fields are read; ciphertext, signature, nonce and the preimage are dropped.
#[derive(Deserialize)]
struct WsEnvelope {
    id: String,
    kind: u16,
    sender: String,
    recipient: WsRecipient,
    timestamp: u64,
    #[serde(default)]
    payment_proof: Option<WsProof>,
    #[serde(default)]
    plaintext: Option<String>,
}

/// One `/ws` text frame to a [`LiveEvent`]. Status frames carry a `type` tag;
/// message frames carry none. Pong, hosting and unknown frames yield `None`.
pub fn parse_ws_frame(text: &str) -> Option<LiveEvent> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    if let Some(kind) = value.get("type").and_then(|t| t.as_str()) {
        let field = |name: &str| value.get(name).and_then(|v| v.as_str()).map(str::to_owned);
        return match kind {
            "delivery_status" => Some(LiveEvent::Delivery {
                message_id: field("message_id")?,
                status: field("status")?,
                reason: field("reason"),
            }),
            "onboarding_progress" => Some(LiveEvent::Onboarding {
                step: field("status")?,
            }),
            "membrane" => Some(LiveEvent::Membrane {
                event: serde_json::from_value::<MembraneEvent>(value).ok()?.checked()?,
            }),
            _ => None,
        };
    }
    let env: WsEnvelope = serde_json::from_value(value).ok()?;
    let (recipient, room_id) = match env.recipient {
        WsRecipient::Node(id) => (id, None),
        WsRecipient::Room(id) => (id.clone(), Some(id)),
        WsRecipient::Broadcast => ("broadcast".to_string(), None),
    };
    Some(LiveEvent::Message {
        message: Message {
            id: env.id,
            kind: env.kind,
            sender: env.sender,
            recipient,
            timestamp: env.timestamp,
            plaintext: env.plaintext,
            payment_amount_msat: env.payment_proof.and_then(|p| p.amount_msat),
        },
        room_id,
    })
}

/// `ws://127.0.0.1:<port>/api/v1/ws?token=…` from the loopback API base.
///
/// Refuses anything but a plain-http loopback base: the socket carries decrypted
/// plaintext and the token, so it must never leave the machine (Gate G2).
pub fn ws_url(api_base: &str, token: &str) -> Result<String, String> {
    let rest = api_base
        .strip_prefix("http://")
        .ok_or_else(|| "live events need a plain loopback API base".to_string())?;
    let host = rest.split(['/', ':']).next().unwrap_or("");
    if host != "127.0.0.1" && host != "localhost" {
        return Err("live events are loopback-only".into());
    }
    if token.is_empty() || !token.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)) {
        return Err("the node token is not URL-safe".into());
    }
    Ok(format!("ws://{}/ws?token={token}", rest.trim_end_matches('/')))
}

/// Backoff after a dropped or refused socket: 1s, 2s, 4s … capped at 30s.
pub fn backoff(attempt: u32) -> Duration {
    Duration::from_secs(1u64 << attempt.min(5)).min(Duration::from_secs(30))
}

/// Run one `/ws` session: connect, forward each parsed frame to `emit`, return
/// when the socket closes. Errors are phrased without the URL, which holds the
/// token.
pub async fn run_ws_session(url: &str, emit: &(dyn Fn(LiveEvent) + Send + Sync)) -> Result<(), String> {
    let mut request = tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(url)
        .map_err(|_| "the live-event request could not be built".to_string())?;
    request
        .headers_mut()
        .insert("Sec-WebSocket-Protocol", "bitsov.v1".parse().expect("static header"));
    let (mut socket, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| match e {
            tokio_tungstenite::tungstenite::Error::Http(response) => {
                format!("the node refused live events ({})", response.status().as_u16())
            }
            _ => "the node's live-event socket is not reachable".to_string(),
        })?;
    emit(LiveEvent::Link {
        state: LinkState::Open,
        detail: None,
    });
    while let Some(frame) = socket.next().await {
        match frame {
            Ok(Frame::Text(text)) => {
                if let Some(event) = parse_ws_frame(text.as_str()) {
                    emit(event);
                }
            }
            Ok(Frame::Close(_)) => break,
            // tungstenite answers pings itself; binary frames are not part of the contract.
            Ok(_) => {}
            Err(_) => return Err("the live-event socket dropped".into()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const ROOM: &str = "0f8e2b7a-1c3d-4e5f-8a9b-0c1d2e3f4a5b";

    fn link(state: LinkState, detail: Option<&str>) -> LiveEvent {
        LiveEvent::Link { state, detail: detail.map(str::to_string) }
    }

    #[test]
    fn readiness_status_preserves_false_true_and_absent() {
        for ready in [Some(false), Some(true), None] {
            let mut wire = serde_json::json!({"status":"ok", "node_id":"x"});
            if let Some(ready) = ready {
                wire["money_ready"] = ready.into();
                wire["readiness"] = serde_json::json!({"money_ready":ready,"state":"offline",
                    "retry_attempt":3,"retry_after_secs":10,
                    "events":[{"sequence":1,"timestamp":1725000000,"state":"offline","money_ready":false}]});
            }
            let projected = serde_json::to_value(NodeOverview::from_status(serde_json::from_value(wire).unwrap(), 123)).unwrap();
            assert_eq!(projected.get("money_ready").and_then(|v| v.as_bool()), ready);
            if ready.is_some() {
                assert_eq!(projected["readiness"]["retry_attempt"], 3);
                assert_eq!(projected["readiness"]["events"][0]["timestamp"], 1725000000u64);
            }
        }
    }

    #[test]
    fn live_link_replays_the_state_the_socket_last_reported() {
        let live = LiveLink::default();
        let mut sent = Vec::new();
        assert_eq!(live.replay(|e| sent.push(e)), None, "nothing to replay before the bridge runs");
        assert!(sent.is_empty());

        live.publish(link(LinkState::Connecting, None), |e| sent.push(e));
        live.publish(link(LinkState::Open, None), |e| sent.push(e));
        // Traffic after the open does not change the link state.
        live.publish(LiveEvent::Onboarding { step: "funding-seen".into() }, |e| sent.push(e));
        assert_eq!(sent.len(), 3);

        let mut replayed = Vec::new();
        assert_eq!(live.replay(|e| replayed.push(e)), Some(LinkState::Open));
        assert_eq!(replayed, [link(LinkState::Open, None)]);

        live.publish(link(LinkState::Closed, Some("the live-event socket dropped")), |_| {});
        let mut replayed = Vec::new();
        assert_eq!(live.replay(|e| replayed.push(e)), Some(LinkState::Closed));
        assert_eq!(replayed, [link(LinkState::Closed, Some("the live-event socket dropped"))]);
    }

    #[test]
    fn peer_and_room_ids_are_validated_before_they_reach_a_path() {
        assert_eq!(node_id(&A.to_uppercase()).unwrap(), A);
        assert!(node_id("../payments/pay").is_err());
        assert!(node_id(&A[..63]).is_err());
        assert_eq!(room_id(ROOM).unwrap(), ROOM);
        assert!(room_id("0f8e2b7a-1c3d-4e5f-8a9b-0c1d2e3f4a5b/../../x").is_err());
        assert!(room_members_path("x").is_err());
        assert_eq!(room_members_path(ROOM).unwrap(), format!("/rooms/{ROOM}/members"));
    }

    #[test]
    fn messages_path_clamps_the_page_and_carries_the_cursor() {
        assert_eq!(messages_path(A, None, None).unwrap(), format!("/messages?peer={A}&limit=50"));
        assert_eq!(
            messages_path(ROOM, Some(1_725_000_000_000), Some(5000)).unwrap(),
            format!("/messages?peer={ROOM}&limit=200&before=1725000000000")
        );
        assert!(messages_path(A, None, Some(0)).unwrap().contains("limit=1"));
        assert!(messages_path("zz&limit=1000", None, None).is_err());
    }

    #[test]
    fn rest_shapes_decode_and_drop_what_the_renderer_must_not_see() {
        let body = serde_json::json!([{
            "id": "ab", "kind": 0, "sender": A, "recipient": "11", "timestamp": 5,
            "ciphertext": "deadbeef", "payment_amount_msat": 4242, "payment_hash": "ff",
            "plaintext": "hi", "references": ["x"]
        }]);
        let messages: Vec<Message> = serde_json::from_value(body).unwrap();
        let out = serde_json::to_string(&messages).unwrap();
        assert!(out.contains("\"plaintext\":\"hi\""));
        assert!(!out.contains("deadbeef") && !out.contains("payment_hash"));

        let peers: Vec<Peer> = serde_json::from_value(serde_json::json!([{
            "node_id": A, "addr": "127.0.0.1:9735", "label": null, "connected": true,
            "auto_connect": true, "fingerprint": "aaaaaaaa", "safety_number": "1 2", "tier": "T1"
        }]))
        .unwrap();
        assert_eq!(peers[0].label, None);
        assert!(!serde_json::to_string(&peers).unwrap().contains("safety_number"));

        let rooms: Vec<Room> = serde_json::from_value(serde_json::json!([{
            "id": ROOM, "name": "Mexico", "created_by": A, "created_at": "2026-09-27T10:00:00Z",
            "metadata": {"secret": "x"}
        }]))
        .unwrap();
        assert!(!serde_json::to_string(&rooms).unwrap().contains("secret"));
    }

    #[test]
    fn wallet_outbound_counts_active_channels_only() {
        let ch = |local, active| Channel {
            channel_id: "c".into(),
            peer_pubkey: "02".into(),
            capacity_msat: local + 1,
            local_balance_msat: local,
            remote_balance_msat: 1,
            active,
        };
        let w = wallet_overview(52_500_000, vec![ch(500_000, true), ch(80_000, false)]);
        assert_eq!(w.balance_msat, 52_500_000);
        assert_eq!(w.lightning_outbound_msat, 500_000);
        assert_eq!(w.channels.len(), 2);
    }

    #[test]
    fn price_quote_uses_the_peer_table_only_when_cached() {
        let own = || KindPrice { kind: 0, price_msat: 1_000 };
        let tables = vec![PeerPrice {
            peer_id: A.to_uppercase(),
            prices: HashMap::from([(CATEGORY_COMMUNICATION.to_string(), 2_000)]),
            age_secs: 240,
            stale: true,
        }];
        let q = price_quote(own(), &tables, Some(A));
        assert_eq!((q.own_msat, q.peer_msat, q.peer_age_secs, q.peer_stale), (1_000, Some(2_000), Some(240), true));
        let q = price_quote(own(), &tables, Some(&"b".repeat(64)));
        assert_eq!((q.peer_msat, q.peer_age_secs, q.peer_stale), (None, None, false));
        assert_eq!(price_quote(own(), &[], None).peer_msat, None);
    }

    #[test]
    fn ws_message_frames_become_projected_messages() {
        let frame = serde_json::json!({
            "id": "0a", "kind": 0, "sender": A, "recipient": {"Room": ROOM},
            "timestamp": 1_725_000_000_000u64, "ciphertext": [1, 2, 3],
            "payment_proof": {"payment_hash": "ff", "preimage": "PREIMAGE", "amount_msat": 1000},
            "signature": "SIG", "nonce": "NONCE", "references": [], "plaintext": "gm"
        });
        let event = parse_ws_frame(&frame.to_string()).expect("message");
        match &event {
            LiveEvent::Message { message, room_id } => {
                assert_eq!(room_id.as_deref(), Some(ROOM));
                assert_eq!(message.recipient, ROOM);
                assert_eq!(message.payment_amount_msat, Some(1000));
                assert_eq!(message.plaintext.as_deref(), Some("gm"));
            }
            other => panic!("{other:?}"),
        }
        let out = serde_json::to_string(&event).unwrap();
        for secret in ["PREIMAGE", "SIG", "NONCE", "ciphertext"] {
            assert!(!out.contains(secret), "{secret} leaked to the renderer");
        }
        assert!(out.contains("\"type\":\"message\""));

        let direct = serde_json::json!({
            "id": "0b", "kind": 0, "sender": A, "recipient": {"Node": "11"}, "timestamp": 1
        });
        match parse_ws_frame(&direct.to_string()) {
            Some(LiveEvent::Message { message, room_id: None }) => {
                assert_eq!(message.recipient, "11");
                assert_eq!(message.payment_amount_msat, None);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn ws_status_frames_are_tagged_and_noise_is_dropped() {
        assert_eq!(
            parse_ws_frame(r#"{"type":"delivery_status","message_id":"0a","status":"rejected","reason":"price"}"#),
            Some(LiveEvent::Delivery {
                message_id: "0a".into(),
                status: "rejected".into(),
                reason: Some("price".into())
            })
        );
        assert_eq!(
            parse_ws_frame(r#"{"type":"onboarding_progress","message_id":"onboarding","status":"funding-seen"}"#),
            Some(LiveEvent::Onboarding { step: "funding-seen".into() })
        );
        assert_eq!(parse_ws_frame(r#"{"type":"pong"}"#), None);
        assert_eq!(parse_ws_frame(r#"{"type":"operator_hosting_overdue","message_id":"x","status":"y"}"#), None);
        assert_eq!(parse_ws_frame("not json"), None);
        assert_eq!(parse_ws_frame(r#"{"id":"x"}"#), None);
    }

    #[test]
    fn ws_membrane_frames_are_projected_and_checked() {
        let a = "ab".repeat(32);
        let frame = format!(
            r#"{{"type":"membrane","seq":7,"at":1000,"direction":"inbound","verdict":"admitted","code":"settled","kind":0,"counterparty":"{}","first_contact":true,"paid_msat":20000,"payment_hash":"ff","preimage":"ee"}}"#,
            a.to_uppercase()
        );
        let Some(LiveEvent::Membrane { event }) = parse_ws_frame(&frame) else { panic!("membrane frame dropped") };
        assert_eq!(event.counterparty.as_deref(), Some(a.as_str()), "lowercased id");
        assert!(event.first_contact);
        let json = serde_json::to_string(&LiveEvent::Membrane { event }).unwrap();
        assert!(!json.contains("payment_hash") && !json.contains("preimage"), "{json}");

        // A counterparty that is not id-shaped, or an unknown verdict, drops the frame.
        assert_eq!(parse_ws_frame(r#"{"type":"membrane","seq":1,"at":1,"direction":"inbound","verdict":"admitted","code":"settled","counterparty":"../x"}"#), None);
        assert_eq!(parse_ws_frame(r#"{"type":"membrane","seq":1,"at":1,"direction":"inbound","verdict":"maybe","code":"settled"}"#), None);
        assert_eq!(parse_ws_frame(r#"{"type":"membrane","seq":1,"at":1,"direction":"inbound","verdict":"refused","code":"<b>"}"#), None);
        // A refusal without a verified sender stays anonymous.
        let Some(LiveEvent::Membrane { event }) = parse_ws_frame(
            r#"{"type":"membrane","seq":2,"at":2,"direction":"inbound","verdict":"refused","code":"unpaid","required_msat":20000,"paid_msat":0}"#,
        ) else { panic!() };
        assert_eq!((event.counterparty, event.required_msat), (None, Some(20000)));
    }

    #[test]
    fn organism_reads_are_projected_and_capabilities_filtered() {
        assert_eq!(energy_path("24h").unwrap(), "/energy?window=24h");
        assert!(energy_path("30d").is_err());
        assert!(energy_path("24h&x=1").is_err());
        assert_eq!(membrane_path(None), "/membrane?limit=50");
        assert_eq!(membrane_path(Some(9999)), "/membrane?limit=500");

        let a = "cd".repeat(32);
        let node: NodeEnergy = serde_json::from_str(&format!(
            r#"{{"window":"24h","as_of_ms":5,"since_ms":0,"bucket_ms":3600000,
               "buckets":[{{"start_ms":7200000,"in_msat":1,"out_msat":0}},{{"start_ms":0,"in_msat":2,"out_msat":3}}],
               "counterparties":[{{"counterparty":"{a}","counterparty_kind":"node","in_msat":4,"out_msat":5,"in_count":1,"out_count":1}},
                                  {{"counterparty":"0f8e2b7a-1c3d-4e5f-8a9b-0c1d2e3f4a5b","counterparty_kind":"room","in_msat":1,"out_msat":0,"in_count":1,"out_count":0}},
                                  {{"counterparty":"not an id","in_msat":9}}],
               "totals":{{"in_msat":5,"out_msat":5,"in_count":2,"out_count":1}},"truncated":false,"source":"x"}}"#
        ))
        .unwrap();
        let read = EnergyRead::from_node(node);
        assert_eq!(read.buckets.iter().map(|b| b.start_ms).collect::<Vec<_>>(), [0, 7_200_000], "oldest first");
        assert_eq!(read.counterparties.len(), 2, "a non-id counterparty is dropped");
        assert_eq!((read.counterparties[0].kind, read.counterparties[1].kind), ("peer", "room"));

        let status: NodeStatusResponse = serde_json::from_str(
            r#"{"status":"ok","node_id":"x","api_capabilities":["paid_send_caps_v1","membrane_v1","energy_v1","<script>"]}"#,
        )
        .unwrap();
        assert_eq!(NodeOverview::from_status(status, 1).capabilities, ["energy_v1", "membrane_v1"]);
        let rc7: NodeStatusResponse = serde_json::from_str(r#"{"status":"ok","node_id":"x"}"#).unwrap();
        assert!(NodeOverview::from_status(rc7, 1).capabilities.is_empty(), "rc7 advertises nothing: v1 sources");
    }

    #[test]
    fn ws_url_is_loopback_only() {
        assert_eq!(
            ws_url("http://127.0.0.1:3141/api/v1", "a.b-c_d").unwrap(),
            "ws://127.0.0.1:3141/api/v1/ws?token=a.b-c_d"
        );
        assert!(ws_url("http://localhost:3141/api/v1", "t").is_ok());
        assert!(ws_url("https://127.0.0.1:3141/api/v1", "t").is_err());
        // Hostile bases are assembled at runtime: the G2 source gate forbids a
        // non-loopback control-plane URL literal anywhere in the tree, tests included.
        let base = |host: &str| format!("http://{host}:3141/api{}", "/v1");
        assert!(ws_url(&base("10.0.0.2"), "t").is_err());
        assert!(ws_url(&base("127.0.0.1.evil.example"), "t").is_err());
        assert!(ws_url(&base("localhost"), "t").is_ok());
        assert!(ws_url("http://127.0.0.1:3141/api/v1", "t&x=1").is_err());
        assert!(ws_url("http://127.0.0.1:3141/api/v1", "").is_err());
    }

    #[test]
    fn backoff_grows_and_caps() {
        assert_eq!(backoff(0), Duration::from_secs(1));
        assert_eq!(backoff(3), Duration::from_secs(8));
        assert_eq!(backoff(40), Duration::from_secs(30));
    }

    /// A real socket on an ephemeral loopback port: the session presents the
    /// token as a query, offers `bitsov.v1`, forwards parsed frames in order,
    /// and never reports the URL in an error.
    #[tokio::test]
    async fn ws_session_forwards_frames_from_a_loopback_socket() {
        use futures_util::SinkExt;
        use std::sync::{Arc, Mutex};
        use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        assert_ne!(port, 3141);
        let seen = Arc::new(Mutex::new(None::<(String, String)>));
        let seen_srv = seen.clone();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_hdr_async(stream, |req: &Request, mut res: Response| {
                let proto = req
                    .headers()
                    .get("Sec-WebSocket-Protocol")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string();
                *seen_srv.lock().unwrap() = Some((req.uri().to_string(), proto));
                res.headers_mut()
                    .insert("Sec-WebSocket-Protocol", "bitsov.v1".parse().unwrap());
                Ok(res)
            })
            .await
            .unwrap();
            let msg = serde_json::json!({
                "id": "0a", "kind": 0, "sender": A, "recipient": {"Node": "11"},
                "timestamp": 7, "payment_proof": {"amount_msat": 1000}, "plaintext": "gm"
            });
            ws.send(Frame::text(r#"{"type":"pong"}"#)).await.unwrap();
            ws.send(Frame::text(msg.to_string())).await.unwrap();
            ws.send(Frame::text(r#"{"type":"delivery_status","message_id":"0a","status":"delivered"}"#))
                .await
                .unwrap();
            ws.close(None).await.unwrap();
        });

        let url = ws_url(&format!("http://127.0.0.1:{port}/api/v1"), "tok").unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        run_ws_session(&url, &move |e| sink.lock().unwrap().push(e)).await.unwrap();
        server.await.unwrap();

        let (uri, proto) = seen.lock().unwrap().clone().unwrap();
        assert_eq!(uri, "/api/v1/ws?token=tok");
        assert_eq!(proto, "bitsov.v1");
        {
            let events = events.lock().unwrap();
            assert_eq!(events.len(), 3, "{events:?}");
            assert!(matches!(events[0], LiveEvent::Link { state: LinkState::Open, .. }));
            assert!(matches!(&events[1], LiveEvent::Message { message, .. } if message.plaintext.as_deref() == Some("gm")));
            assert!(matches!(&events[2], LiveEvent::Delivery { status, .. } if status == "delivered"));
        }

        // Nothing listening: the error names no URL, so the token cannot leak into it.
        let dead = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let dead_port = dead.local_addr().unwrap().port();
        drop(dead);
        let url = ws_url(&format!("http://127.0.0.1:{dead_port}/api/v1"), "SECRET").unwrap();
        let err = run_ws_session(&url, &|_| {}).await.unwrap_err();
        assert!(!err.contains("SECRET") && !err.contains("ws://"), "{err}");
    }
}

#[cfg(test)]
mod pre_payment_refusal_tests {
    use super::*;
    use serde_json::{json, Value};
    const HOUR: u64 = 3_600_000;
    const NOW: u64 = 100 * HOUR + 123_000;

    fn project(field: Option<Value>) -> Value {
        let mut wire = json!({"capacity":500,"totals":{"refused":9},"events":[]});
        if let Some(field) = field { wire["pre_payment_refusals"] = field; }
        let node = serde_json::from_value(wire).unwrap();
        serde_json::to_value(MembraneRead::from_node(node, NOW)).unwrap()
    }
    fn counts(buckets: Value) -> Value {
        json!({"bucket_ms":HOUR,"capacity":24,"effective_hour_start_ms":100*HOUR,"buckets":buckets})
    }

    #[test]
    fn refusal_counts_present_sum_only_the_reported_hours_and_known_reasons() {
        let read = project(Some(counts(json!([
            {"start_ms":76*HOUR,"counts":{"session_before_payment":100}},
            {"start_ms":77*HOUR,"counts":{"session_before_payment":3}},
            {"start_ms":99*HOUR,"counts":{"session_before_payment":5}},
            {"start_ms":100*HOUR,"counts":{"session_before_payment":2,"admission_required":1,"arbitrary_sender":42}}
        ]))));
        let rows = read["pre_payment_refusals"]["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 8);
        assert_eq!(rows[0], json!({"reason":"session_before_payment","hour":{"count":"2","at_least":false},"day":{"count":"10","at_least":false}}));
        assert_eq!(rows[7]["day"]["count"], "1");
        assert_eq!(rows[1]["hour"]["count"], "0");
        assert!(!read.to_string().contains("arbitrary_sender"));
        assert_eq!(read["totals"]["refused"], 9);
        assert_eq!(read["read_at"], NOW);
    }

    #[test]
    fn refusal_counts_absent_are_unavailable_but_present_empty_means_zero() {
        assert!(project(None)["pre_payment_refusals"].is_null());
        let read = project(Some(counts(json!([]))));
        let rows = read["pre_payment_refusals"]["rows"].as_array().unwrap();
        assert!(rows.iter().all(|r| r["hour"]["count"] == "0" && r["day"]["count"] == "0"));
    }

    #[test]
    fn refusal_counts_saturated_are_exact_lower_bounds_and_sum_without_overflow() {
        let read = project(Some(counts(json!([
            {"start_ms":99*HOUR,"counts":{"session_before_payment":u64::MAX,"price_before_payment":9007199254740993_u64}},
            {"start_ms":100*HOUR,"counts":{"session_before_payment":u64::MAX,"price_before_payment":1}}
        ]))));
        let rows = &read["pre_payment_refusals"]["rows"];
        assert_eq!(rows[0]["hour"], json!({"count":"18446744073709551615","at_least":true}));
        assert_eq!(rows[0]["day"], json!({"count":"36893488147419103230","at_least":true}));
        assert_eq!(rows[2]["day"], json!({"count":"9007199254740994","at_least":false}));
    }

    #[test]
    fn refusal_counts_rollback_keeps_the_nodes_most_recent_hour() {
        let mut field = counts(json!([
            {"start_ms":101*HOUR,"counts":{"admission_required":4}}
        ]));
        field["effective_hour_start_ms"] = json!(101*HOUR);
        let read = project(Some(field));
        assert_eq!(read["pre_payment_refusals"]["hour_start_ms"], 101*HOUR);
        assert_eq!(read["pre_payment_refusals"]["rows"][7]["hour"]["count"], "4");
    }

    #[test]
    fn refusal_counts_quiet_hour_before_rollback_uses_authoritative_anchor() {
        // Record at hour 100, quiet node read at 101, then read at hour 99.
        let wire = json!({"capacity":500,"totals":{},"events":[],"pre_payment_refusals":{
            "bucket_ms":HOUR,"capacity":24,"effective_hour_start_ms":101*HOUR,
            "buckets":[{"start_ms":100*HOUR,"counts":{"session_before_payment":1}}]
        }});
        let node = serde_json::from_value(wire).unwrap();
        let read = serde_json::to_value(MembraneRead::from_node(node, 99*HOUR)).unwrap();
        let counts = &read["pre_payment_refusals"];
        assert_eq!(counts["hour_start_ms"], 101*HOUR);
        assert_eq!(counts["rows"][0]["hour"]["count"], "0");
        assert_eq!(counts["rows"][0]["day"]["count"], "1");
    }

    #[test]
    fn refusal_counts_older_node_keeps_day_but_hour_is_unavailable() {
        for anchor in [None, Some(Value::Null)] {
            let mut field = counts(json!([
                {"start_ms":100*HOUR,"counts":{"session_before_payment":1}},
                {"start_ms":101*HOUR,"counts":{"admission_required":4}}
            ]));
            field.as_object_mut().unwrap().remove("effective_hour_start_ms");
            if let Some(anchor) = anchor { field["effective_hour_start_ms"] = anchor; }
            let read = project(Some(field));
            let counts = &read["pre_payment_refusals"];
            assert!(counts["hour_start_ms"].is_null());
            assert!(counts["rows"].as_array().unwrap().iter().all(|r| r["hour"].is_null()));
            assert_eq!(counts["rows"][0]["day"]["count"], "1");
            assert_eq!(counts["rows"][7]["day"]["count"], "4");
        }
    }

    #[test]
    fn refusal_counts_invalid_bucket_shape_is_unavailable() {
        for field in [
            json!({"bucket_ms":1,"capacity":24,"buckets":[]}),
            json!({"bucket_ms":HOUR,"capacity":25,"buckets":[]}),
            json!({"bucket_ms":HOUR,"capacity":24,"effective_hour_start_ms":NOW,"buckets":[]}),
            counts(json!([{"start_ms":101*HOUR,"counts":{}}])),
            counts(json!([{"start_ms":NOW,"counts":{}}])),
            counts(json!([{"start_ms":100*HOUR,"counts":{}},{"start_ms":100*HOUR,"counts":{}}])),
            counts(json!(vec![json!({"start_ms":0,"counts":{}});25])),
        ] {
            assert!(project(Some(field))["pre_payment_refusals"].is_null());
        }
    }
}
