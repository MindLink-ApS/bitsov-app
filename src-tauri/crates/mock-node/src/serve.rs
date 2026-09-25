//! In-process read routes. Shapes follow BitSov-bitsov `v0.3.0-rc7`
//! (`958e3997f9969497c1d270f557282b9bb591fe85`):
//!
//! - `GET /api/v1/health` — `PublicHealthResponse` (`handlers/health.rs`)
//! - `GET /api/v1/status` — `HealthResponse`
//! - `GET /api/v1/payments/balance` — `BalanceResponse` (`handlers/payments.rs`)
//! - `GET /api/v1/payments/channels` — `ChannelResponse`
//! - `GET /api/v1/payments` — `PaymentListEntry`
//! - `GET /api/v1/payments/price/:kind` — `PriceResponse`
//! - `GET /api/v1/messages` — `MessageResponse` (`handlers/messages/query.rs`)
//! - `GET /api/v1/pricing` — `OwnPricingResponse` (`handlers/pricing.rs`)
//! - `GET /api/v1/peers` — `PeerResponse` (`handlers/peers.rs`)
//!
//! rc7 `get_balance_msat` returns `total_lightning_balance_sats * 1000 +
//! spendable_onchain_balance_sats * 1000` as one number. Channel
//! `local_balance_msat` is `outbound_capacity_msat` and is not that Lightning
//! term. This mock does not invent an on-chain field from the difference.
//!
//! Paths are the full `/api/v1/...` routes only. A faulted route is an error,
//! a timeout, or a stale body, and [`crate::MockNode::read`] refuses all three.

use std::cmp::Reverse;
use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::canary::{
    ALIAS_01, ALIAS_02, COUNTERPARTY_01, COUNTERPARTY_02, COUNTERPARTY_03, ERROR_BODY_01, MEMO_01,
    MEMO_02, MSG_BODIES, MSG_CIPHER_01, MSG_NESTED_01, PREIMAGE_01, PREIMAGE_02,
};
use crate::ids::{
    BLOCK_HEIGHT, CATEGORY_COMMUNICATION_MSAT, CHANNEL_LOCAL_MSAT, CHANNEL_REMOTE_MSAT,
    CONNECTED_PEERS, DIFFICULTY_EPOCH_POSITION, E2EE_SESSIONS, KIND_APP_MSAT, KIND_CALENDAR_MSAT,
    KIND_CHAT_MSAT, KIND_COLLABORATION_MSAT, KIND_CONTROL_MSAT, KIND_FILE_MSAT, KIND_LONGFORM_MSAT,
    KIND_SIGNALING_MSAT, KIND_STORAGE_MSAT, KIND_WEB_MSAT, LIGHTNING_NODE_PUBKEY, NODE_ID,
    PENDING_DELIVERIES, SENDER_A, SENDER_B, SPENDABLE_ONCHAIN_SATS, TOTAL_LIGHTNING_BALANCE_SATS,
    UPTIME_SECS, VALID_BLOCKS,
};

pub mod paths {
    pub const HEALTH: &str = "/api/v1/health";
    pub const STATUS: &str = "/api/v1/status";
    pub const BALANCE: &str = "/api/v1/payments/balance";
    pub const CHANNELS: &str = "/api/v1/payments/channels";
    pub const PAYMENTS: &str = "/api/v1/payments";
    pub const MESSAGES: &str = "/api/v1/messages";
    pub const PRICING: &str = "/api/v1/pricing";
    pub const PEERS: &str = "/api/v1/peers";

    pub fn price(kind: u16) -> String {
        format!("/api/v1/payments/price/{kind}")
    }
}

const MAX_LIST_LIMIT: u32 = 1000;
const DEFAULT_LIST_LIMIT: u32 = 50;
const MESSAGE_PAYMENT_MSAT: u64 = 4_242;

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, serde::Deserialize, serde::Serialize,
)]
#[serde(rename_all = "snake_case")]
pub enum Route {
    Health,
    Status,
    PaymentsBalance,
    PaymentsChannels,
    Payments,
    PaymentsPrice,
    Messages,
    Pricing,
    Peers,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Fault {
    None,
    Error,
    Timeout,
    Stale,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Exchange {
    Ready { status: u16, body: Value },
    Failed { status: u16, body: Value },
    TimedOut,
    Stale { status: u16, body: Value },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadFailure {
    RouteError,
    Timeout,
    Stale,
    NotFound,
    Unreadable,
}

#[derive(Clone, Debug)]
enum PeerFilter {
    Node(String),
    Room,
}

#[derive(Clone, Debug)]
struct MessageQuery {
    limit: u32,
    before: Option<u64>,
    peer: Option<PeerFilter>,
}

#[derive(Clone, Debug)]
enum Request {
    Health,
    Status,
    Balance,
    Channels,
    Payments,
    Price { kind: u16 },
    Messages(MessageQuery),
    Pricing,
    Peers,
}

impl Request {
    fn route(&self) -> Route {
        match self {
            Self::Health => Route::Health,
            Self::Status => Route::Status,
            Self::Balance => Route::PaymentsBalance,
            Self::Channels => Route::PaymentsChannels,
            Self::Payments => Route::Payments,
            Self::Price { .. } => Route::PaymentsPrice,
            Self::Messages(_) => Route::Messages,
            Self::Pricing => Route::Pricing,
            Self::Peers => Route::Peers,
        }
    }
}

enum Parsed {
    Ready(Request),
    BadRequest(Value),
    Missing,
}

#[derive(Clone, Debug)]
pub struct MockNode {
    faults: BTreeMap<Route, Fault>,
}

impl Default for MockNode {
    fn default() -> Self {
        Self::canonical()
    }
}

impl MockNode {
    pub fn canonical() -> Self {
        Self {
            faults: BTreeMap::new(),
        }
    }

    pub fn fault(mut self, route: Route, fault: Fault) -> Self {
        match fault {
            Fault::None => {
                self.faults.remove(&route);
            }
            Fault::Error | Fault::Timeout | Fault::Stale => {
                self.faults.insert(route, fault);
            }
        }
        self
    }

    pub fn serve(&self, path: &str) -> Exchange {
        let req = match parse_path(path) {
            Parsed::Missing => return not_found(),
            Parsed::BadRequest(body) => {
                if self.fault_of(Route::Messages) != Fault::None {
                    return self.dispatch(Request::Messages(MessageQuery {
                        limit: DEFAULT_LIST_LIMIT,
                        before: None,
                        peer: None,
                    }));
                }
                return Exchange::Failed { status: 400, body };
            }
            Parsed::Ready(req) => req,
        };
        if let Request::Price { kind } = req {
            if self.fault_of(Route::PaymentsPrice) == Fault::None && kind_price(kind).is_none() {
                return Exchange::Failed {
                    status: 400,
                    body: json!({
                        "error": format!("kind {kind} is not priceable"),
                        "code": 400,
                    }),
                };
            }
        }
        self.dispatch(req)
    }

    /// A fresh 200 body, or why the read cannot be used. A stale 200 is a
    /// failure here: the numeric decoy in that body is not a value.
    pub fn read(&self, path: &str) -> Result<Value, ReadFailure> {
        match self.serve(path) {
            Exchange::Ready { status: 200, body } => Ok(body),
            Exchange::Ready { .. } => Err(ReadFailure::Unreadable),
            Exchange::Failed { status: 404, .. } => Err(ReadFailure::NotFound),
            Exchange::Failed { .. } => Err(ReadFailure::RouteError),
            Exchange::TimedOut => Err(ReadFailure::Timeout),
            Exchange::Stale { .. } => Err(ReadFailure::Stale),
        }
    }

    fn dispatch(&self, req: Request) -> Exchange {
        match self.fault_of(req.route()) {
            Fault::None => Exchange::Ready {
                status: 200,
                body: payload(&req, false),
            },
            Fault::Error => error_exchange(req.route()),
            Fault::Timeout => Exchange::TimedOut,
            Fault::Stale => Exchange::Stale {
                status: 200,
                body: payload(&req, true),
            },
        }
    }

    fn fault_of(&self, route: Route) -> Fault {
        self.faults.get(&route).copied().unwrap_or(Fault::None)
    }
}

/// Combined balance rc7 returns from `get_balance_msat`.
pub fn balance_msat() -> u64 {
    (TOTAL_LIGHTNING_BALANCE_SATS + SPENDABLE_ONCHAIN_SATS) * 1000
}

/// Static engine: kind 1 is the long-form override, `0..=99` (including kind 7)
/// is the communication price, and `700..=899` is not priceable.
fn kind_price(kind: u16) -> Option<u64> {
    if kind == 1 {
        return Some(KIND_LONGFORM_MSAT);
    }
    Some(match kind {
        0..=99 => KIND_CHAT_MSAT,
        100..=199 => KIND_CALENDAR_MSAT,
        200..=299 => KIND_FILE_MSAT,
        300..=399 => KIND_COLLABORATION_MSAT,
        400..=499 => KIND_SIGNALING_MSAT,
        500..=599 => KIND_WEB_MSAT,
        600..=699 => KIND_STORAGE_MSAT,
        900..=999 => KIND_CONTROL_MSAT,
        1000.. => KIND_APP_MSAT,
        _ => return None,
    })
}

fn not_found() -> Exchange {
    Exchange::Failed {
        status: 404,
        body: json!({"error": "route", "code": 404}),
    }
}

/// Lightning handlers map to 502. `get_price` maps to 400. Storage-backed
/// reads and the handlers rc7 does not fail with a gateway error map to 500.
/// The JSON `error` field is the inner string, not the Display prefix.
fn error_exchange(route: Route) -> Exchange {
    let status = match route {
        Route::PaymentsBalance | Route::PaymentsChannels | Route::Payments => 502,
        Route::PaymentsPrice => 400,
        Route::Health | Route::Status | Route::Messages | Route::Pricing | Route::Peers => 500,
    };
    Exchange::Failed {
        status,
        body: json!({"error": ERROR_BODY_01, "code": status}),
    }
}

fn payload(req: &Request, stale: bool) -> Value {
    match req {
        Request::Health => health_body(stale),
        Request::Status => status_body(stale),
        Request::Balance => balance_body(stale),
        Request::Channels => channels_body(stale),
        Request::Payments => payments_body(stale),
        Request::Price { kind } => price_body(*kind, stale),
        Request::Messages(query) => messages_body(query, stale),
        Request::Pricing => pricing_body(stale),
        Request::Peers => peers_body(stale),
    }
}

fn health_body(stale: bool) -> Value {
    let mut body = json!({
        "status": "ok",
        "connected_peers": if stale { 0 } else { CONNECTED_PEERS },
        "e2ee_sessions": if stale { 0 } else { E2EE_SESSIONS },
        "pending_deliveries": if stale { 0 } else { PENDING_DELIVERIES },
        "lightning_available": !stale,
        "lightning_payment_capable": !stale,
        "uptime_secs": if stale { 0 } else { UPTIME_SECS },
        "version": 2,
        "lightning_backend": "ldk",
        "chain_backend": "esplora",
    });
    if !stale {
        body["block_height"] = json!(BLOCK_HEIGHT);
    }
    body
}

fn status_body(stale: bool) -> Value {
    let mut body = health_body(stale);
    body["node_id"] = json!(NODE_ID);
    body["connected_peer_ids"] = if stale {
        json!([])
    } else {
        json!([SENDER_A, SENDER_B])
    };
    if !stale {
        body["lightning_balance_msat"] = json!(balance_msat());
        body["lightning_node_pubkey"] = json!(LIGHTNING_NODE_PUBKEY);
    }
    body
}

fn balance_body(stale: bool) -> Value {
    json!({"balance_msat": if stale { 0 } else { balance_msat() }})
}

fn channels_body(stale: bool) -> Value {
    if stale {
        return json!([]);
    }
    let peers = [COUNTERPARTY_01, COUNTERPARTY_02, COUNTERPARTY_03];
    let active = [true, true, false];
    let scids = [Some("860123x1x0"), Some("860123x2x0"), None];
    let mut out = Vec::with_capacity(3);
    for i in 0..3 {
        out.push(json!({
            "channel_id": (i + 1).to_string(),
            "peer_pubkey": peers[i],
            "capacity_msat": CHANNEL_LOCAL_MSAT[i] + CHANNEL_REMOTE_MSAT[i],
            "local_balance_msat": CHANNEL_LOCAL_MSAT[i],
            "remote_balance_msat": CHANNEL_REMOTE_MSAT[i],
            "active": active[i],
            "short_channel_id": scids[i],
        }));
    }
    Value::Array(out)
}

fn payments_body(stale: bool) -> Value {
    if stale {
        return json!([]);
    }
    json!([
        payment(PREIMAGE_01, MEMO_01, 21_000, 100, 1_725_000_000),
        payment(PREIMAGE_02, MEMO_02, 42_000, 250, 1_725_000_100),
    ])
}

fn payment(preimage: &str, memo: &str, amount: u64, fee: u64, timestamp: u64) -> Value {
    json!({
        "payment_hash": format!("{timestamp:064x}"),
        "preimage": preimage,
        "amount_msat": amount,
        "status": "settled",
        "direction": "outgoing",
        "timestamp": timestamp,
        "memo": memo,
        "fee_msat": fee,
    })
}

fn price_body(kind: u16, stale: bool) -> Value {
    let price = if stale {
        0
    } else {
        kind_price(kind).expect("fresh price route only serves a priceable kind")
    };
    json!({ "kind": kind, "price_msat": price })
}

struct StoredMessage {
    kind: u16,
    sender: &'static str,
    recipient: &'static str,
    timestamp: u64,
    ciphertext: &'static str,
    plaintext: &'static str,
    references: &'static [&'static str],
}

fn stored_messages() -> Vec<StoredMessage> {
    vec![
        StoredMessage {
            kind: 0,
            sender: SENDER_A,
            recipient: NODE_ID,
            timestamp: 1_725_000_005_000,
            ciphertext: MSG_CIPHER_01,
            plaintext: MSG_BODIES[0],
            references: &[MSG_NESTED_01],
        },
        StoredMessage {
            kind: 0,
            sender: NODE_ID,
            recipient: SENDER_A,
            timestamp: 1_725_000_004_500,
            ciphertext: "0000000000000000000000000000000000000000000000000000000000000000",
            plaintext: MSG_BODIES[5],
            references: &[],
        },
        StoredMessage {
            kind: 0,
            sender: SENDER_A,
            recipient: NODE_ID,
            timestamp: 1_725_000_004_000,
            ciphertext: "0000000000000000000000000000000000000000000000000000000000000000",
            plaintext: MSG_BODIES[1],
            references: &[],
        },
        StoredMessage {
            kind: 0,
            sender: SENDER_A,
            recipient: NODE_ID,
            timestamp: 1_725_000_003_000,
            ciphertext: "0000000000000000000000000000000000000000000000000000000000000000",
            plaintext: MSG_BODIES[2],
            references: &[],
        },
        StoredMessage {
            kind: 1,
            sender: SENDER_A,
            recipient: NODE_ID,
            timestamp: 1_725_000_002_500,
            ciphertext: "0000000000000000000000000000000000000000000000000000000000000000",
            plaintext: MSG_BODIES[3],
            references: &[],
        },
        StoredMessage {
            kind: 200,
            sender: SENDER_B,
            recipient: NODE_ID,
            timestamp: 1_725_000_001_600,
            ciphertext: "0000000000000000000000000000000000000000000000000000000000000000",
            plaintext: MSG_BODIES[4],
            references: &[],
        },
    ]
}

fn messages_body(query: &MessageQuery, stale: bool) -> Value {
    if stale {
        return json!([]);
    }
    let stored = stored_messages();
    let mut rows: Vec<&StoredMessage> = stored
        .iter()
        .filter(|msg| message_visible(msg, query))
        .filter(|msg| query.before.is_none_or(|before| msg.timestamp < before))
        .collect();
    rows.sort_by_key(|msg| Reverse(msg.timestamp));
    rows.truncate(query.limit as usize);
    Value::Array(rows.into_iter().map(message_json).collect())
}

fn message_visible(msg: &StoredMessage, query: &MessageQuery) -> bool {
    match &query.peer {
        None => msg.recipient == NODE_ID,
        Some(PeerFilter::Room) => false,
        Some(PeerFilter::Node(peer)) => {
            (msg.sender == peer && msg.recipient == NODE_ID)
                || (msg.sender == NODE_ID && msg.recipient == peer)
        }
    }
}

fn message_json(msg: &StoredMessage) -> Value {
    let mut body = json!({
        "id": format!("{:064x}", msg.timestamp),
        "kind": msg.kind,
        "sender": msg.sender,
        "recipient": msg.recipient,
        "timestamp": msg.timestamp,
        "ciphertext": msg.ciphertext,
        "payment_amount_msat": MESSAGE_PAYMENT_MSAT,
        "payment_hash": format!("{:064x}", msg.timestamp.wrapping_add(1)),
        "plaintext": msg.plaintext,
    });
    if !msg.references.is_empty() {
        body["references"] = json!(msg.references);
    }
    body
}

fn pricing_body(stale: bool) -> Value {
    let price = |fresh: u64| if stale { 0 } else { fresh };
    json!({
        "mode": "static",
        "prices": {
            "communication": price(CATEGORY_COMMUNICATION_MSAT),
            "structured_data": price(KIND_CALENDAR_MSAT),
            "files_media": price(KIND_FILE_MSAT),
            "collaboration": price(KIND_COLLABORATION_MSAT),
            "web_content": price(KIND_WEB_MSAT),
            "control": price(KIND_CONTROL_MSAT),
            "app_extension": price(KIND_APP_MSAT),
        },
        "block_height": if stale { 0 } else { BLOCK_HEIGHT },
        "valid_blocks": if stale { 0 } else { VALID_BLOCKS },
        "trust_level": "server_trust",
        "difficulty_epoch_position": if stale { 0 } else { DIFFICULTY_EPOCH_POSITION },
        "peer_tables_cached": 0,
    })
}

fn peers_body(stale: bool) -> Value {
    if stale {
        return json!([]);
    }
    let mut peers = vec![
        peer(SENDER_A, "127.0.0.1:9735", Some(ALIAS_01), true, "aaaaaaaa"),
        peer(SENDER_B, "127.0.0.1:9736", Some(ALIAS_02), true, "bbbbbbbb"),
    ];
    for n in 3u8..=8 {
        let node_id = format!("{n:02x}").repeat(32);
        let fingerprint = node_id[..8].to_string();
        let addr = format!("127.0.0.1:{}", 9734 + u16::from(n));
        peers.push(peer(&node_id, &addr, None, false, &fingerprint));
    }
    Value::Array(peers)
}

fn peer(
    node_id: &str,
    addr: &str,
    label: Option<&str>,
    connected: bool,
    fingerprint: &str,
) -> Value {
    let mut body = json!({
        "node_id": node_id,
        "addr": addr,
        "label": label,
        "connected": connected,
        "auto_connect": connected,
        "fingerprint": fingerprint,
        "safety_number": "11111 22222 33333 44444 55555 66666 77777 88888 99999 00000 12121 34343",
    });
    if connected {
        body["tier"] = json!("T1");
        body["capabilities"] = json!(["X3dh"]);
    }
    body
}

fn parse_path(path: &str) -> Parsed {
    let (path, query) = path.split_once('?').unwrap_or((path, ""));
    let path = path.trim_end_matches('/');
    let Some(path) = path.strip_prefix("/api/v1") else {
        return Parsed::Missing;
    };
    if let Some(kind) = path.strip_prefix("/payments/price/") {
        let Ok(kind) = kind.parse::<u16>() else {
            return Parsed::Missing;
        };
        return Parsed::Ready(Request::Price { kind });
    }
    match path {
        "/health" => Parsed::Ready(Request::Health),
        "/status" => Parsed::Ready(Request::Status),
        "/payments/balance" => Parsed::Ready(Request::Balance),
        "/payments/channels" => Parsed::Ready(Request::Channels),
        "/payments" => Parsed::Ready(Request::Payments),
        "/messages" => match parse_message_query(query) {
            Ok(query) => Parsed::Ready(Request::Messages(query)),
            Err(body) => Parsed::BadRequest(body),
        },
        "/pricing" => Parsed::Ready(Request::Pricing),
        "/peers" => Parsed::Ready(Request::Peers),
        _ => Parsed::Missing,
    }
}

fn parse_message_query(query: &str) -> Result<MessageQuery, Value> {
    let mut limit = DEFAULT_LIST_LIMIT;
    let mut before = None;
    let mut peer = None;
    if !query.is_empty() {
        for pair in query.split('&') {
            if pair.is_empty() {
                continue;
            }
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            match key {
                "limit" => {
                    limit = value
                        .parse::<u32>()
                        .map_err(|_| bad_request("invalid limit"))?;
                }
                "before" => {
                    before = Some(
                        value
                            .parse::<u64>()
                            .map_err(|_| bad_request("invalid before"))?,
                    );
                }
                "peer" => peer = Some(value.to_string()),
                _ => {}
            }
        }
    }
    let peer = match peer {
        None => None,
        Some(peer) => Some(validate_peer(&peer)?),
    };
    Ok(MessageQuery {
        limit: limit.min(MAX_LIST_LIMIT),
        before,
        peer,
    })
}

fn validate_peer(peer: &str) -> Result<PeerFilter, Value> {
    if peer.contains('-') {
        if is_room_uuid(peer) {
            Ok(PeerFilter::Room)
        } else {
            Err(bad_request(&format!("invalid room UUID: {peer}")))
        }
    } else if peer.len() == 64 && peer.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(PeerFilter::Node(peer.to_string()))
    } else {
        Err(bad_request(
            "invalid peer: expected 64-char hex node ID or UUID",
        ))
    }
}

fn is_room_uuid(value: &str) -> bool {
    let expected = [8, 4, 4, 4, 12];
    let parts: Vec<&str> = value.split('-').collect();
    parts.len() == expected.len()
        && parts
            .iter()
            .zip(expected)
            .all(|(part, len)| part.len() == len && part.chars().all(|c| c.is_ascii_hexdigit()))
}

fn bad_request(message: &str) -> Value {
    json!({"error": message, "code": 400})
}
