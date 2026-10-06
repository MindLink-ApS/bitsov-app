//! Closed set of node routes the broker may read.
//!
//! Allowlisted GET routes on rc9, retaining rc7 (`958e399`) response compatibility.
//! `RequestTarget::method` is fixed to GET. The only query keys are `limit`
//! and, on `/messages` only, `peer`, whose value is a [`PeerKey`]: 32 bytes
//! written as 64 lowercase hex, so nothing caller-shaped reaches a path.
//! There is no constructor that accepts a caller-supplied path or HTTP method.
//! `ListMessagesQuery` also documents `before`; it is not a broker query value.

/// `GET /api/v1/payments/balance`
pub const PAYMENTS_BALANCE: &str = "/api/v1/payments/balance";
/// `GET /api/v1/payments/channels`
pub const PAYMENTS_CHANNELS: &str = "/api/v1/payments/channels";
/// `GET /api/v1/health`
pub const HEALTH: &str = "/api/v1/health";
/// `GET /api/v1/messages`
pub const MESSAGES: &str = "/api/v1/messages";
/// `GET /api/v1/pricing` — this node's own price table.
pub const OWN_PRICING: &str = "/api/v1/pricing";
/// `GET /api/v1/peers` — the private contact list. Only ids are projected.
pub const PEERS: &str = "/api/v1/peers";

pub const ALLOWED_PATHS: &[&str] = &[
    PAYMENTS_BALANCE,
    PAYMENTS_CHANNELS,
    HEALTH,
    MESSAGES,
    OWN_PRICING,
    PEERS,
];

/// Path segments that belong to invoice, spend, restore, admin, or other
/// mutating (or body-bearing) routes. Matched as whole segments, so
/// `payments` does not match `pay`.
const FORBIDDEN_SEGMENTS: &[&str] = &[
    "admin",
    "auth",
    "close-channel",
    "compose",
    "export",
    "files",
    "hosting",
    "invoice",
    "keysend",
    "mnemonic",
    "onboarding",
    "open-channel",
    "pay",
    "plaintext",
    "restore",
    "resync",
    "search",
    "seed",
    "send-onchain",
    "ws",
];

/// A peer's node id: exactly 32 bytes. The only non-numeric value a broker
/// request may carry. Built from 64 hex characters, written back as lowercase
/// hex, so the query value cannot hold anything else. `Debug` shows a prefix.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PeerKey([u8; 32]);

impl PeerKey {
    /// `None` unless `text` is exactly 64 hex digits (either case).
    pub fn parse(text: &str) -> Option<Self> {
        let bytes = text.as_bytes();
        if bytes.len() != 64 {
            return None;
        }
        let mut out = [0u8; 32];
        for (index, pair) in bytes.chunks(2).enumerate() {
            out[index] = (nibble(pair[0])? << 4) | nibble(pair[1])?;
        }
        Some(Self(out))
    }

    /// 64 lowercase hex characters.
    pub fn hex(&self) -> String {
        self.0.iter().map(|byte| format!("{byte:02x}")).collect()
    }
}

fn nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

impl std::fmt::Debug for PeerKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "PeerKey({:02x}{:02x}..)", self.0[0], self.0[1])
    }
}

/// Stands in for a peer in [`sample_routes`]. Never read from a node.
const SAMPLE_PEER: PeerKey = PeerKey([0; 32]);

/// A read the broker is allowed to perform. Adding a variant does not compile
/// until [`ReadRoute::target`] names an allowlisted GET path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadRoute {
    PaymentsBalance,
    PaymentsChannels,
    Health,
    /// `limit` is a page size, not a path. The dispatcher rejects `0` and
    /// values above the genome cap (1000) before building this route.
    /// Incoming mail only: with no peer the pinned handler returns messages
    /// addressed to this node and does not support a `sent=` selector.
    Messages {
        limit: u32,
    },
    OwnPricing,
    /// The contact list. The tool keeps each valid node id and drops the rest
    /// (labels, addresses, fingerprints).
    Peers,
    /// One peer's thread, both directions. Same `limit` rule as
    /// [`ReadRoute::Messages`]. The tool keeps time, direction and amount.
    PeerMessages {
        peer: PeerKey,
        limit: u32,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Query {
    pub key: &'static str,
    pub value: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RequestTarget {
    pub method: &'static str,
    pub path: &'static str,
    pub query: Option<Query>,
    /// `peer=`, written before `limit`. Only on `/messages`, only with `limit`.
    pub peer: Option<PeerKey>,
}

impl RequestTarget {
    /// Path and query as written on the wire.
    pub fn uri(&self) -> String {
        let mut uri = self.path.to_string();
        let mut sep = '?';
        if let Some(peer) = self.peer {
            uri.push_str(&format!("{sep}peer={}", peer.hex()));
            sep = '&';
        }
        if let Some(query) = self.query {
            uri.push_str(&format!("{sep}{}={}", query.key, query.value));
        }
        uri
    }
}

impl ReadRoute {
    pub const fn target(self) -> RequestTarget {
        let peer = match self {
            Self::PeerMessages { peer, .. } => Some(peer),
            _ => None,
        };
        let (path, query) = match self {
            Self::PaymentsBalance => (PAYMENTS_BALANCE, None),
            Self::PaymentsChannels => (PAYMENTS_CHANNELS, None),
            Self::Health => (HEALTH, None),
            Self::Messages { limit } => (
                MESSAGES,
                Some(Query {
                    key: "limit",
                    value: limit,
                }),
            ),
            Self::OwnPricing => (OWN_PRICING, None),
            Self::Peers => (PEERS, None),
            Self::PeerMessages { limit, .. } => (
                MESSAGES,
                Some(Query {
                    key: "limit",
                    value: limit,
                }),
            ),
        };
        RequestTarget {
            method: "GET",
            path,
            query,
            peer,
        }
    }
}

pub const fn sample_routes() -> [ReadRoute; 7] {
    [
        ReadRoute::PaymentsBalance,
        ReadRoute::PaymentsChannels,
        ReadRoute::Health,
        ReadRoute::Messages { limit: 1 },
        ReadRoute::OwnPricing,
        ReadRoute::Peers,
        ReadRoute::PeerMessages {
            peer: SAMPLE_PEER,
            limit: 1,
        },
    ]
}

const fn const_eq(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    if left.len() != right.len() {
        return false;
    }
    let mut index = 0;
    while index < left.len() {
        if left[index] != right[index] {
            return false;
        }
        index += 1;
    }
    true
}

pub const fn path_allowed(path: &str) -> bool {
    let mut index = 0;
    while index < ALLOWED_PATHS.len() {
        if const_eq(path, ALLOWED_PATHS[index]) {
            return true;
        }
        index += 1;
    }
    false
}

const fn segment_forbidden(path: &[u8], start: usize, end: usize) -> bool {
    let mut index = 0;
    while index < FORBIDDEN_SEGMENTS.len() {
        let forbidden = FORBIDDEN_SEGMENTS[index].as_bytes();
        if end - start == forbidden.len() {
            let mut offset = 0;
            let mut same = true;
            while offset < forbidden.len() {
                if path[start + offset] != forbidden[offset] {
                    same = false;
                    break;
                }
                offset += 1;
            }
            if same {
                return true;
            }
        }
        index += 1;
    }
    false
}

pub const fn segments_allowed(path: &str) -> bool {
    let bytes = path.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'/' {
            index += 1;
            continue;
        }
        let start = index;
        while index < bytes.len() && bytes[index] != b'/' {
            index += 1;
        }
        if segment_forbidden(bytes, start, index) {
            return false;
        }
    }
    true
}

const fn query_ok(query: Option<Query>) -> bool {
    match query {
        None => true,
        Some(query) => const_eq(query.key, "limit"),
    }
}

/// True when [`ReadRoute::target`] is an allowlisted GET for this variant.
///
/// The path compared here is `route.target().path`, not a free-standing copy
/// of the path constant.
const fn mapping_ok(route: ReadRoute) -> bool {
    let target = route.target();
    let expected = match route {
        ReadRoute::PaymentsBalance => PAYMENTS_BALANCE,
        ReadRoute::PaymentsChannels => PAYMENTS_CHANNELS,
        ReadRoute::Health => HEALTH,
        ReadRoute::Messages { .. } => MESSAGES,
        ReadRoute::OwnPricing => OWN_PRICING,
        ReadRoute::Peers => PEERS,
        ReadRoute::PeerMessages { .. } => MESSAGES,
    };
    // A peer rides only on a `/messages` page with a limit.
    let peer_ok = match target.peer {
        None => true,
        Some(_) => const_eq(target.path, MESSAGES) && target.query.is_some(),
    };
    const_eq(target.method, "GET")
        && const_eq(target.path, expected)
        && path_allowed(target.path)
        && segments_allowed(target.path)
        && query_ok(target.query)
        && peer_ok
}

/// Slot per variant. A new `ReadRoute` fails this match until it is numbered,
/// and the const block requires every slot to appear in [`sample_routes`].
const fn variant_slot(route: ReadRoute) -> usize {
    match route {
        ReadRoute::PaymentsBalance => 0,
        ReadRoute::PaymentsChannels => 1,
        ReadRoute::Health => 2,
        ReadRoute::Messages { .. } => 3,
        ReadRoute::OwnPricing => 4,
        ReadRoute::Peers => 5,
        ReadRoute::PeerMessages { .. } => 6,
    }
}

/// Construction-time check: every sample route's [`ReadRoute::target`] is an
/// allowlisted GET. [`crate::jarvis::broker::Broker::new`] calls this.
pub fn enforce() -> Result<(), ()> {
    let samples = sample_routes();
    let mut index = 0;
    while index < samples.len() {
        if !mapping_ok(samples[index]) {
            return Err(());
        }
        index += 1;
    }
    Ok(())
}

const _: () = {
    let routes = sample_routes();
    let mut seen = [false; 7];
    let mut index = 0;
    while index < routes.len() {
        let route = routes[index];
        assert!(mapping_ok(route));
        let slot = variant_slot(route);
        assert!(slot < seen.len());
        assert!(!seen[slot]);
        seen[slot] = true;
        index += 1;
    }
    let mut slot = 0;
    while slot < seen.len() {
        assert!(seen[slot]);
        slot += 1;
    }
    assert!(!path_allowed("/api/v1/payments/pay"));
    assert!(!path_allowed("/api/v1/payments/invoice"));
    assert!(!path_allowed("/api/v1/payments/keysend"));
    assert!(!path_allowed("/api/v1/payments/send-onchain"));
    assert!(!path_allowed("/api/v1/payments/open-channel"));
    assert!(!path_allowed("/api/v1/payments/close-channel"));
    assert!(!path_allowed("/api/v1/identity/restore"));
    assert!(!path_allowed("/api/v1/messages/compose"));
    assert!(!path_allowed("/api/v1/admin"));
};
