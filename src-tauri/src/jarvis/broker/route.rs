//! Closed set of node routes the broker may read.
//!
//! Paths are the pinned BitSov-bitsov `v0.3.0-rc7` (`958e399`) GET routes.
//! `RequestTarget::method` is fixed to GET. Query keys are `limit` and the
//! fixed `sent=1` selector. There is no constructor that accepts a
//! caller-supplied path or HTTP method.

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

pub const ALLOWED_PATHS: &[&str] = &[
    PAYMENTS_BALANCE,
    PAYMENTS_CHANNELS,
    HEALTH,
    MESSAGES,
    OWN_PRICING,
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

/// A read the broker is allowed to perform. Adding a variant does not compile
/// until [`ReadRoute::target`] names an allowlisted GET path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadRoute {
    PaymentsBalance,
    PaymentsChannels,
    Health,
    /// `limit` is a page size, not a path. The dispatcher rejects `0` and
    /// values above the genome cap (1000) before building this route.
    /// Incoming mail only: the mock omits messages this node sent.
    Messages {
        limit: u32,
    },
    /// `GET /api/v1/messages?sent=1`. Mail this node sent. Same allowlisted
    /// path as [`ReadRoute::Messages`]. The query value is the constant `1`.
    SentMessages,
    OwnPricing,
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
}

impl ReadRoute {
    pub const fn target(self) -> RequestTarget {
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
            Self::SentMessages => (
                MESSAGES,
                Some(Query {
                    key: "sent",
                    value: 1,
                }),
            ),
            Self::OwnPricing => (OWN_PRICING, None),
        };
        RequestTarget {
            method: "GET",
            path,
            query,
        }
    }
}

pub const fn sample_routes() -> [ReadRoute; 6] {
    [
        ReadRoute::PaymentsBalance,
        ReadRoute::PaymentsChannels,
        ReadRoute::Health,
        ReadRoute::Messages { limit: 1 },
        ReadRoute::SentMessages,
        ReadRoute::OwnPricing,
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
        Some(query) => {
            const_eq(query.key, "limit") || (const_eq(query.key, "sent") && query.value == 1)
        }
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
        ReadRoute::Messages { .. } | ReadRoute::SentMessages => MESSAGES,
        ReadRoute::OwnPricing => OWN_PRICING,
    };
    const_eq(target.method, "GET")
        && const_eq(target.path, expected)
        && path_allowed(target.path)
        && segments_allowed(target.path)
        && query_ok(target.query)
}

/// Slot per variant. A new `ReadRoute` fails this match until it is numbered,
/// and the const block requires every slot to appear in [`sample_routes`].
const fn variant_slot(route: ReadRoute) -> usize {
    match route {
        ReadRoute::PaymentsBalance => 0,
        ReadRoute::PaymentsChannels => 1,
        ReadRoute::Health => 2,
        ReadRoute::Messages { .. } => 3,
        ReadRoute::SentMessages => 4,
        ReadRoute::OwnPricing => 5,
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
    let mut seen = [false; 6];
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
