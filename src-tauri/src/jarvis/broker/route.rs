//! Closed set of node routes the broker may read.
//!
//! Paths are the pinned BitSov-bitsov `v0.3.0-rc7` (`958e399`) GET routes.
//! `RequestTarget::method` is fixed to GET. There is no constructor that
//! accepts a caller-supplied path or HTTP method.

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
    Messages {
        limit: u32,
    },
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
            Self::OwnPricing => (OWN_PRICING, None),
        };
        RequestTarget {
            method: "GET",
            path,
            query,
        }
    }
}

pub const fn sample_routes() -> [ReadRoute; 5] {
    [
        ReadRoute::PaymentsBalance,
        ReadRoute::PaymentsChannels,
        ReadRoute::Health,
        ReadRoute::Messages { limit: 1 },
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

/// Construction-time check: every sample route is GET, on the allowlist, and
/// free of mutating segments. [`crate::jarvis::broker::Broker::new`] calls this.
pub fn enforce() -> Result<(), ()> {
    let mut index = 0;
    let samples = sample_routes();
    while index < samples.len() {
        let target = samples[index].target();
        if !const_eq(target.method, "GET")
            || !path_allowed(target.path)
            || !segments_allowed(target.path)
        {
            return Err(());
        }
        if let Some(query) = target.query {
            if !const_eq(query.key, "limit") {
                return Err(());
            }
        }
        index += 1;
    }
    Ok(())
}

const _: () = {
    assert!(path_allowed(PAYMENTS_BALANCE));
    assert!(path_allowed(PAYMENTS_CHANNELS));
    assert!(path_allowed(HEALTH));
    assert!(path_allowed(MESSAGES));
    assert!(path_allowed(OWN_PRICING));
    assert!(segments_allowed(PAYMENTS_BALANCE));
    assert!(segments_allowed(PAYMENTS_CHANNELS));
    assert!(segments_allowed(HEALTH));
    assert!(segments_allowed(MESSAGES));
    assert!(segments_allowed(OWN_PRICING));
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
