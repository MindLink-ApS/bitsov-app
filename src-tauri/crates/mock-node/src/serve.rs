//! In-process read routes. Shapes follow BitSov-bitsov `v0.3.0-rc7`
//! (`958e3997f9969497c1d270f557282b9bb591fe85`):
//!
//! - `GET /health` — `PublicHealthResponse` (`handlers/health.rs`)
//! - `GET /status` — `HealthResponse`
//! - `GET /payments/balance` — `BalanceResponse` (`handlers/payments.rs`)
//! - `GET /payments/channels` — `ChannelResponse`
//! - `GET /payments` — `PaymentListEntry` (memos and preimages live here)
//! - `GET /payments/price/:kind` — `PriceResponse`
//! - `GET /messages` — `MessageResponse` (`handlers/messages/query.rs`)
//! - `GET /pricing` — `OwnPricingResponse` (`handlers/pricing.rs`)
//! - `GET /peers` — `PeerResponse` (`handlers/peers.rs`)
//!
//! rc7's LDK `get_balance_msat` adds spendable on-chain sats to the Lightning
//! total and returns one number. This fixture keeps the two parts exact:
//! `balance_msat = onchain_sats * 1000 + sum(local_balance_msat)`.
//!
//! The real `/health` handler turns a failed wallet or chain query into `0`.
//! This mock does not. A faulted route is an error, a timeout, or a stale
//! body, and [`crate::MockNode::read`] refuses all three.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::canary::{
    ALIAS_01, ALIAS_02, COUNTERPARTY_01, COUNTERPARTY_02, COUNTERPARTY_03, ERROR_BODY_01, EXTRA_01,
    EXTRA_02, MEMO_01, MEMO_02, MSG_BODIES, MSG_CIPHER_01, MSG_NESTED_01, PREIMAGE_01, PREIMAGE_02,
};
use crate::ids::{
    BLOCK_HEIGHT, CATEGORY_COMMUNICATION_MSAT, CHANNEL_LOCAL_MSAT, CHANNEL_REMOTE_MSAT,
    CONNECTED_PEERS, DIFFICULTY_EPOCH_POSITION, E2EE_SESSIONS, KIND_CALENDAR_MSAT, KIND_CHAT_MSAT,
    KIND_FILE_MSAT, KIND_LONGFORM_MSAT, LIGHTNING_NODE_PUBKEY, NODE_ID, ONCHAIN_SATS,
    PENDING_DELIVERIES, SENDER_A, SENDER_B, UPTIME_SECS, VALID_BLOCKS,
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
enum Request {
    Health,
    Status,
    Balance,
    Channels,
    Payments,
    Price { kind: u16 },
    Messages,
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
            Self::Messages => Route::Messages,
            Self::Pricing => Route::Pricing,
            Self::Peers => Route::Peers,
        }
    }
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
        let Some(req) = parse_path(path) else {
            return Exchange::Failed {
                status: 404,
                body: json!({"error": "not found: route", "code": 404}),
            };
        };
        if let Request::Price { kind } = req {
            if self.fault_of(Route::PaymentsPrice) == Fault::None && kind_price(kind).is_none() {
                return Exchange::Failed {
                    status: 400,
                    body: json!({"error": "bad request: unknown kind", "code": 400}),
                };
            }
        }
        match self.fault_of(req.route()) {
            Fault::None => Exchange::Ready {
                status: 200,
                body: payload(&req, false),
            },
            Fault::Error => Exchange::Failed {
                status: 502,
                body: error_body(),
            },
            Fault::Timeout => Exchange::TimedOut,
            Fault::Stale => Exchange::Stale {
                status: 200,
                body: payload(&req, true),
            },
        }
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

    fn fault_of(&self, route: Route) -> Fault {
        self.faults.get(&route).copied().unwrap_or(Fault::None)
    }
}

pub fn balance_msat() -> u64 {
    ONCHAIN_SATS * 1000 + CHANNEL_LOCAL_MSAT.iter().sum::<u64>()
}

fn kind_price(kind: u16) -> Option<u64> {
    match kind {
        0 => Some(KIND_CHAT_MSAT),
        1 => Some(KIND_LONGFORM_MSAT),
        100 => Some(KIND_CALENDAR_MSAT),
        200 => Some(KIND_FILE_MSAT),
        _ => None,
    }
}

fn error_body() -> Value {
    json!({
        "error": format!("lightning error: {ERROR_BODY_01}"),
        "code": 502,
    })
}

fn payload(req: &Request, stale: bool) -> Value {
    match req {
        Request::Health => health_body(stale),
        Request::Status => status_body(stale),
        Request::Balance => balance_body(stale),
        Request::Channels => channels_body(stale),
        Request::Payments => payments_body(stale),
        Request::Price { kind } => price_body(*kind, stale),
        Request::Messages => messages_body(stale),
        Request::Pricing => pricing_body(stale),
        Request::Peers => peers_body(stale),
    }
}

fn health_body(stale: bool) -> Value {
    json!({
        "status": "ok",
        "connected_peers": if stale { 0 } else { CONNECTED_PEERS },
        "e2ee_sessions": if stale { 0 } else { E2EE_SESSIONS },
        "pending_deliveries": if stale { 0 } else { PENDING_DELIVERIES },
        "lightning_available": !stale,
        "lightning_payment_capable": !stale,
        "uptime_secs": if stale { 0 } else { UPTIME_SECS },
        "version": if stale { 0 } else { 2 },
        "lightning_backend": "ldk",
        "chain_backend": "esplora",
        "block_height": if stale { 0 } else { BLOCK_HEIGHT },
    })
}

fn status_body(stale: bool) -> Value {
    let mut body = health_body(stale);
    body["node_id"] = json!(NODE_ID);
    body["connected_peer_ids"] = if stale {
        json!([])
    } else {
        json!([SENDER_A, SENDER_B])
    };
    body["lightning_balance_msat"] = json!(if stale { 0 } else { balance_msat() });
    body["lightning_node_pubkey"] = json!(LIGHTNING_NODE_PUBKEY);
    body
}

fn balance_body(stale: bool) -> Value {
    if stale {
        json!({"balance_msat": 0})
    } else {
        json!({
            "balance_msat": balance_msat(),
            "_unknown": EXTRA_01,
        })
    }
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
        let mut ch = json!({
            "channel_id": (i + 1).to_string(),
            "peer_pubkey": peers[i],
            "capacity_msat": CHANNEL_LOCAL_MSAT[i] + CHANNEL_REMOTE_MSAT[i],
            "local_balance_msat": CHANNEL_LOCAL_MSAT[i],
            "remote_balance_msat": CHANNEL_REMOTE_MSAT[i],
            "active": active[i],
            "short_channel_id": scids[i],
        });
        if i == 0 {
            ch["_unknown"] = json!({"nested": EXTRA_02});
        }
        out.push(ch);
    }
    Value::Array(out)
}

fn payments_body(stale: bool) -> Value {
    json!([
        payment(
            "c1",
            PREIMAGE_01,
            MEMO_01,
            if stale { 0 } else { 21_000 },
            100,
            1_725_000_000
        ),
        payment(
            "c2",
            PREIMAGE_02,
            MEMO_02,
            if stale { 0 } else { 42_000 },
            250,
            1_725_000_100
        ),
    ])
}

fn payment(tag: &str, preimage: &str, memo: &str, amount: u64, fee: u64, timestamp: u64) -> Value {
    json!({
        "payment_hash": tag.repeat(32),
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
        kind_price(kind).expect("fresh price route only serves a known kind")
    };
    json!({ "kind": kind, "price_msat": price })
}

fn messages_body(stale: bool) -> Value {
    if stale {
        return json!([]);
    }
    let senders = [SENDER_A, SENDER_A, SENDER_A, SENDER_B, SENDER_B, NODE_ID];
    let kinds = [0u16, 0, 1, 0, 200, 0];
    let mut out = Vec::with_capacity(6);
    for i in 0..6 {
        let recipient = if senders[i] == NODE_ID {
            SENDER_A
        } else {
            NODE_ID
        };
        let ciphertext = if i == 0 { MSG_CIPHER_01 } else { "00" };
        let mut msg = json!({
            "id": format!("d{i}").repeat(32),
            "kind": kinds[i],
            "sender": senders[i],
            "recipient": recipient,
            "timestamp": 1_725_000_000_000u64 + (i as u64) * 1_000,
            "ciphertext": ciphertext,
            "payment_amount_msat": 1_000,
            "payment_hash": format!("e{i}").repeat(32),
            "plaintext": MSG_BODIES[i],
        });
        if i == 0 {
            msg["_unknown"] = json!({"body": MSG_NESTED_01});
        }
        out.push(msg);
    }
    Value::Array(out)
}

fn pricing_body(stale: bool) -> Value {
    let price = |fresh: u64| if stale { 0 } else { fresh };
    json!({
        "mode": "static",
        "prices": {
            "communication": price(CATEGORY_COMMUNICATION_MSAT),
            "structured_data": price(2_500),
            "files_media": price(8_000),
            "collaboration": price(4_000),
            "web_content": price(6_000),
            "control": price(500),
            "app_extension": price(9_000),
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
    json!([
        peer(SENDER_A, "127.0.0.1:9735", ALIAS_01, "aaaaaaaa"),
        peer(SENDER_B, "127.0.0.1:9736", ALIAS_02, "bbbbbbbb"),
    ])
}

fn peer(node_id: &str, addr: &str, label: &str, fingerprint: &str) -> Value {
    json!({
        "node_id": node_id,
        "addr": addr,
        "label": label,
        "connected": true,
        "auto_connect": true,
        "fingerprint": fingerprint,
        "safety_number": "11111 22222 33333 44444 55555 66666 77777 88888 99999 00000 12121 34343",
        "tier": "T1",
        "capabilities": ["X3dh"],
    })
}

fn parse_path(path: &str) -> Option<Request> {
    let path = path.split('?').next().unwrap_or(path);
    let path = path.trim_end_matches('/');
    let path = path.strip_prefix("/api/v1").unwrap_or(path);
    if let Some(kind) = path.strip_prefix("/payments/price/") {
        let kind = kind.parse::<u16>().ok()?;
        return Some(Request::Price { kind });
    }
    Some(match path {
        "/health" => Request::Health,
        "/status" => Request::Status,
        "/payments/balance" => Request::Balance,
        "/payments/channels" => Request::Channels,
        "/payments" => Request::Payments,
        "/messages" => Request::Messages,
        "/pricing" => Request::Pricing,
        "/peers" => Request::Peers,
        _ => return None,
    })
}
