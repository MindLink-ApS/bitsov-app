//! How old each broker read is.
//!
//! The age is the host's: [`LocalNodeRead`](super::LocalNodeRead) stamps every
//! response with a monotonic [`Instant`] (and the wall clock) once the body is
//! read. Nothing on the node's clock makes a read fresh or stale.
//!
//! rc7 bodies on the pinned routes carry one wall-clock field, `timestamp` on
//! each `/messages` entry (ms since epoch, the message's send time). It is not
//! an "as of": an idle mailbox is old and still current. It is used only as a
//! skew check. A newest message more than [`MAX_NODE_SKEW`] ahead of the host
//! is clamped to the host's fetch time and flagged. `block_height` (health,
//! pricing) and `uptime_secs` (health) are not times and are not used.
//!
//! Reads without a stamp (the in-process mock) and non-2xx reads have no
//! freshness claim.

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;

use super::route::ReadRoute;
use super::RawRead;

/// A read this old is stale. The window reads once per open, so this is how
/// long the rows may sit before the label asks for a reopen.
pub const STALE_AFTER: Duration = Duration::from_secs(60);

/// How far a node timestamp may run ahead of the host before it is clamped.
pub const MAX_NODE_SKEW: Duration = Duration::from_secs(120);

/// When the host finished reading a response.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fetched {
    /// Monotonic. Ages are measured from this.
    pub at: Instant,
    /// Host wall clock, ms since epoch. `None` if the clock is before 1970.
    pub wall_ms: Option<u64>,
}

impl Fetched {
    pub fn now() -> Self {
        let wall_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()
            .and_then(|since| u64::try_from(since.as_millis()).ok());
        Self {
            at: Instant::now(),
            wall_ms,
        }
    }
}

/// Which body field, if any, gives a node-side time for a route.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeTimeField {
    /// No wall-clock field on the rc7 body.
    None,
    /// Newest `timestamp` (ms since epoch) in the `/messages` array.
    MessageTimestamp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FreshnessState {
    Fresh,
    Stale,
    Unknown,
}

impl FreshnessState {
    pub fn code(self) -> &'static str {
        match self {
            Self::Fresh => "fresh",
            Self::Stale => "stale",
            Self::Unknown => "unknown",
        }
    }
}

/// Freshness of one route's read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RouteFreshness {
    pub route: ReadRoute,
    /// Host stamp. `None` for a mock read or a non-2xx status.
    pub fetched: Option<Fetched>,
    /// Node-side time from [`node_time_field`], clamped to the fetch time.
    pub node_time_ms: Option<u64>,
    /// The node's time ran more than [`MAX_NODE_SKEW`] ahead and was clamped.
    pub clock_skew: bool,
}

/// Stable name for the window. One per [`ReadRoute`] variant.
pub fn route_key(route: ReadRoute) -> &'static str {
    match route {
        ReadRoute::PaymentsBalance => "balance",
        ReadRoute::PaymentsChannels => "channels",
        ReadRoute::Health => "health",
        ReadRoute::Messages { .. } => "messages",
        ReadRoute::OwnPricing => "pricing",
    }
}

/// Per rc7 (`958e399`) response type:
///
/// | Route | Body | Time field used |
/// |---|---|---|
/// | `/payments/balance` | `BalanceResponse` | none |
/// | `/payments/channels` | `[ChannelResponse]` | none |
/// | `/health` | `PublicHealthResponse` | none (`block_height`, `uptime_secs` are not times) |
/// | `/messages` | `[MessageResponse]` | newest `timestamp`, skew check only |
/// | `/pricing` | `OwnPricingResponse` | none (`block_height` is not a time) |
pub fn node_time_field(route: ReadRoute) -> NodeTimeField {
    match route {
        ReadRoute::Messages { .. } => NodeTimeField::MessageTimestamp,
        ReadRoute::PaymentsBalance
        | ReadRoute::PaymentsChannels
        | ReadRoute::Health
        | ReadRoute::OwnPricing => NodeTimeField::None,
    }
}

#[derive(Deserialize)]
struct Stamp {
    timestamp: u64,
}

/// Newest `timestamp` in a `/messages` body. Entries are otherwise ignored.
fn newest_message_ms(body: &[u8]) -> Option<u64> {
    let stamps: Vec<Stamp> = serde_json::from_slice(body).ok()?;
    stamps.iter().map(|stamp| stamp.timestamp).max()
}

impl RouteFreshness {
    pub fn assess(route: ReadRoute, raw: &RawRead) -> Self {
        let unknown = Self {
            route,
            fetched: None,
            node_time_ms: None,
            clock_skew: false,
        };
        let Some(fetched) = raw.fetched else {
            return unknown;
        };
        if !(200..300).contains(&raw.status) {
            return unknown;
        }
        let node_time = match node_time_field(route) {
            NodeTimeField::None => None,
            NodeTimeField::MessageTimestamp => newest_message_ms(&raw.body),
        };
        // Without a host wall clock there is nothing to check a node time against.
        let (node_time_ms, clock_skew) = match (node_time, fetched.wall_ms) {
            (Some(node), Some(host)) => {
                let limit = host.saturating_add(MAX_NODE_SKEW.as_millis() as u64);
                if node > limit {
                    (Some(host), true)
                } else {
                    (Some(node), false)
                }
            }
            _ => (None, false),
        };
        Self {
            route,
            fetched: Some(fetched),
            node_time_ms,
            clock_skew,
        }
    }

    /// Host monotonic age at `now`. Never negative.
    pub fn age(&self, now: Instant) -> Option<Duration> {
        self.fetched
            .map(|fetched| now.saturating_duration_since(fetched.at))
    }

    pub fn state(&self, now: Instant) -> FreshnessState {
        match self.age(now) {
            None => FreshnessState::Unknown,
            Some(age) if age >= STALE_AFTER => FreshnessState::Stale,
            Some(_) => FreshnessState::Fresh,
        }
    }
}

#[cfg(test)]
mod tests {
    use mock_node::MockNode;

    use super::super::test_server::{TestServer, NODE_PORT};
    use super::super::{BearerToken, LocalNodeRead, NodeRead};
    use super::*;

    const TOKEN: &str = "paired-FRESH-CANARY-2b8e";
    /// Newest message `timestamp` in mock-node's rc7 `/messages` body.
    const NEWEST_MESSAGE_MS: u64 = 1_725_000_005_000;

    struct Quiet;

    impl super::super::AuditSink for Quiet {
        fn record(&self, _line: &str) {}
    }

    fn live_reader(server: &TestServer) -> LocalNodeRead {
        LocalNodeRead::new(
            &server.api_base(),
            BearerToken::new(TOKEN.to_string()).expect("token"),
            std::sync::Arc::new(Quiet),
        )
        .expect("loopback base")
    }

    fn stamped(status: u16, body: &str, fetched: Fetched) -> RawRead {
        RawRead::new(status, body.as_bytes().to_vec()).stamped(fetched)
    }

    fn at_wall(wall_ms: u64) -> Fetched {
        Fetched {
            at: Instant::now(),
            wall_ms: Some(wall_ms),
        }
    }

    #[test]
    fn every_route_has_a_key_and_a_documented_time_field() {
        let expected = [
            (ReadRoute::PaymentsBalance, "balance", NodeTimeField::None),
            (ReadRoute::PaymentsChannels, "channels", NodeTimeField::None),
            (ReadRoute::Health, "health", NodeTimeField::None),
            (
                ReadRoute::Messages { limit: 50 },
                "messages",
                NodeTimeField::MessageTimestamp,
            ),
            (ReadRoute::OwnPricing, "pricing", NodeTimeField::None),
        ];
        for (route, key, field) in expected {
            assert_eq!(route_key(route), key);
            assert_eq!(node_time_field(route), field, "{key}");
        }
        assert_eq!(
            super::super::route::sample_routes().len(),
            expected.len(),
            "a new route needs a freshness row"
        );
    }

    /// Every pinned route, read over a real loopback socket, is stamped by the
    /// host and ages from fresh to stale at [`STALE_AFTER`].
    #[test]
    fn every_live_read_is_stamped_and_ages_into_stale() {
        let server = TestServer::start(MockNode::canonical(), TOKEN);
        assert_ne!(server.port(), NODE_PORT);
        let read = live_reader(&server);
        for route in super::super::route::sample_routes() {
            let before = Instant::now();
            let raw = read.read(route).expect("read");
            let after = Instant::now();
            let fresh = RouteFreshness::assess(route, &raw);
            let fetched = fresh.fetched.expect("host stamp");
            assert!(before <= fetched.at && fetched.at <= after, "{route:?}");
            assert!(fetched.wall_ms.is_some());
            assert!(!fresh.clock_skew, "{route:?}");

            assert_eq!(fresh.age(fetched.at), Some(Duration::ZERO));
            assert_eq!(fresh.state(fetched.at), FreshnessState::Fresh);
            let almost = fetched.at + STALE_AFTER - Duration::from_millis(1);
            assert_eq!(fresh.state(almost), FreshnessState::Fresh, "{route:?}");
            let stale = fetched.at + STALE_AFTER;
            assert_eq!(fresh.age(stale), Some(STALE_AFTER));
            assert_eq!(fresh.state(stale), FreshnessState::Stale, "{route:?}");
        }
    }

    #[test]
    fn only_messages_carry_a_node_time() {
        let server = TestServer::start(MockNode::canonical(), TOKEN);
        let read = live_reader(&server);
        for route in super::super::route::sample_routes() {
            let fresh = RouteFreshness::assess(route, &read.read(route).expect("read"));
            let want = match route {
                ReadRoute::Messages { .. } => Some(NEWEST_MESSAGE_MS),
                _ => None,
            };
            assert_eq!(fresh.node_time_ms, want, "{route:?}");
        }
    }

    #[test]
    fn a_node_time_ahead_of_the_host_is_clamped_and_flagged() {
        let host = 1_800_000_000_000;
        let route = ReadRoute::Messages { limit: 2 };
        let skew = MAX_NODE_SKEW.as_millis() as u64;

        let within = format!(r#"[{{"timestamp":{}}},{{"timestamp":1}}]"#, host + skew);
        let fresh = RouteFreshness::assess(route, &stamped(200, &within, at_wall(host)));
        assert_eq!(
            (fresh.node_time_ms, fresh.clock_skew),
            (Some(host + skew), false)
        );

        let ahead = format!(r#"[{{"timestamp":1}},{{"timestamp":{}}}]"#, host + skew + 1);
        let fresh = RouteFreshness::assess(route, &stamped(200, &ahead, at_wall(host)));
        assert_eq!((fresh.node_time_ms, fresh.clock_skew), (Some(host), true));

        let far = format!(r#"[{{"timestamp":{}}}]"#, u64::MAX);
        let fresh = RouteFreshness::assess(route, &stamped(200, &far, at_wall(host)));
        assert_eq!((fresh.node_time_ms, fresh.clock_skew), (Some(host), true));
        // The flag does not change the host's age or state.
        let fetched = fresh.fetched.expect("stamp");
        assert_eq!(fresh.state(fetched.at), FreshnessState::Fresh);
    }

    #[test]
    fn a_node_time_is_not_trusted_without_a_host_wall_clock() {
        let route = ReadRoute::Messages { limit: 1 };
        let fetched = Fetched {
            at: Instant::now(),
            wall_ms: None,
        };
        let raw = stamped(200, r#"[{"timestamp":5}]"#, fetched);
        let fresh = RouteFreshness::assess(route, &raw);
        assert_eq!((fresh.node_time_ms, fresh.clock_skew), (None, false));
        assert_eq!(fresh.state(fetched.at), FreshnessState::Fresh);
    }

    #[test]
    fn no_or_malformed_message_timestamps_are_no_node_time() {
        let route = ReadRoute::Messages { limit: 1 };
        for body in [
            "[]",
            "{}",
            "not json",
            r#"[{"timestamp":"soon"}]"#,
            r#"[{"timestamp":-1}]"#,
            r#"[{"id":"x"}]"#,
        ] {
            let fresh = RouteFreshness::assess(route, &stamped(200, body, at_wall(10)));
            assert_eq!(
                (fresh.node_time_ms, fresh.clock_skew),
                (None, false),
                "{body}"
            );
            assert!(fresh.fetched.is_some(), "{body}");
        }
        // A time field on a route that has none is ignored.
        let fresh = RouteFreshness::assess(
            ReadRoute::Health,
            &stamped(
                200,
                r#"{"timestamp":99,"block_height":860123}"#,
                at_wall(10),
            ),
        );
        assert_eq!(fresh.node_time_ms, None);
    }

    #[test]
    fn an_unstamped_read_is_unknown() {
        for route in super::super::route::sample_routes() {
            let raw = RawRead::new(200, b"[]".to_vec());
            let fresh = RouteFreshness::assess(route, &raw);
            assert_eq!(fresh.fetched, None);
            assert_eq!(fresh.age(Instant::now()), None);
            assert_eq!(fresh.state(Instant::now()), FreshnessState::Unknown);
        }
    }

    #[test]
    fn an_error_status_makes_no_freshness_claim() {
        for status in [401, 404, 502, 503] {
            let raw = stamped(status, r#"[{"timestamp":5}]"#, at_wall(10));
            let fresh = RouteFreshness::assess(ReadRoute::Messages { limit: 1 }, &raw);
            assert_eq!(fresh.fetched, None, "{status}");
            assert_eq!(fresh.node_time_ms, None, "{status}");
            assert_eq!(fresh.state(Instant::now()), FreshnessState::Unknown);
        }
    }

    #[test]
    fn an_instant_before_the_fetch_is_age_zero_not_a_panic() {
        let fetched = Fetched {
            at: Instant::now() + Duration::from_secs(5),
            wall_ms: Some(1),
        };
        let fresh = RouteFreshness::assess(ReadRoute::Health, &stamped(200, "{}", fetched));
        assert_eq!(fresh.age(Instant::now()), Some(Duration::ZERO));
        assert_eq!(fresh.state(Instant::now()), FreshnessState::Fresh);
    }

    #[test]
    fn state_codes_match_the_window() {
        assert_eq!(FreshnessState::Fresh.code(), "fresh");
        assert_eq!(FreshnessState::Stale.code(), "stale");
        assert_eq!(FreshnessState::Unknown.code(), "unknown");
    }

    #[test]
    fn fetched_now_uses_the_host_wall_clock() {
        let before = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let fetched = Fetched::now();
        let wall = fetched.wall_ms.expect("wall clock");
        assert!(wall >= before && wall < before + 60_000);
    }
}
