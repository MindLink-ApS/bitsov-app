//! How old each broker read is.
//!
//! [`LocalNodeRead`](super::LocalNodeRead) stamps every response with a
//! monotonic [`Instant`] (and the wall clock) once the body is read. Ages are
//! measured on the host's monotonic clock from that stamp.
//!
//! Genome #78 (not in the pinned rc7) adds two headers on 200s from the five
//! pinned routes. `LocalNodeRead` parses them into [`NodeMarks`]:
//!
//! - `BitSov-Data-As-Of`: when the node's data was last known current. RFC
//!   3339 (the node sends UTC `Z`, whole seconds; numeric offsets are
//!   normalised to UTC), or plain ms-since-epoch digits. When present, the age
//!   is the node's lag at fetch time (host wall clock minus as-of) plus the
//!   monotonic time since. An as-of more than [`MAX_NODE_SKEW`] ahead of the
//!   host is clamped to the fetch time and flagged, like the `/messages` check.
//! - `BitSov-Data-Stale: 1`: the node says the data is stale. The route is
//!   [`FreshnessState::Stale`] whatever its age. Any other value is ignored.
//!
//! Precedence: `Stale: 1` > node as-of age > app-read age > unknown. rc7
//! sends neither header, so rc7 reads keep the app-read age. Either age is
//! compared with the route's own bound, [`stale_after`].
//!
//! rc7 bodies on the pinned routes carry one wall-clock field, `timestamp` on
//! each `/messages` entry (ms since epoch, the message's send time). It is not
//! an "as of": an idle mailbox is old and still current. It is used only as a
//! skew check. A newest message more than [`MAX_NODE_SKEW`] ahead of the host
//! is clamped to the host's fetch time and flagged. `block_height` (health,
//! pricing) and `uptime_secs` (health) are not times and are not used.
//!
//! Reads without a stamp (the in-process mock) and non-2xx reads have no
//! freshness claim, whatever their headers say.

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;

use super::route::ReadRoute;
use super::RawRead;

/// Default bound: a read this old is stale. The window reads once per open,
/// so this is how long the rows may sit before the label asks for a reopen.
/// Health, messages and pricing use it.
pub const STALE_AFTER: Duration = Duration::from_secs(60);

/// The node's default on-chain wallet sync interval (LDK). With #78, a
/// balance or channels as-of is the last sync, so it can be this old the
/// moment it is read.
pub const WALLET_SYNC_INTERVAL: Duration = Duration::from_secs(80);

/// Bound for balance and channels: two wallet syncs plus 20 s for the read
/// and the window, so one late sync does not flip the label.
pub const WALLET_STALE_AFTER: Duration = Duration::from_secs(180);

/// How old a route's read may be before it is stale. Applies to whichever
/// age [`RouteFreshness::age`] uses: node as-of or app read.
///
/// | Route | Bound |
/// |---|---|
/// | balance, channels | [`WALLET_STALE_AFTER`] (180 s) |
/// | health, messages, pricing | [`STALE_AFTER`] (60 s) |
pub fn stale_after(route: ReadRoute) -> Duration {
    match route {
        ReadRoute::PaymentsBalance | ReadRoute::PaymentsChannels => WALLET_STALE_AFTER,
        ReadRoute::Health | ReadRoute::Messages { .. } | ReadRoute::OwnPricing => STALE_AFTER,
    }
}

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

/// What a 2xx response's headers said about the node's data.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct NodeMarks {
    /// `BitSov-Data-As-Of`, ms since epoch, as the node sent it.
    pub as_of_ms: Option<u64>,
    /// `BitSov-Data-Stale: 1`.
    pub stale: bool,
}

/// `BitSov-Data-As-Of` as ms since epoch, or `None` if it is not an RFC 3339
/// date-time (`T`/`t`, `Z`/`z` or `+hh:mm`/`-hh:mm`, optional fraction,
/// leap second refused) or plain ms digits. Times before 1970 are `None`.
pub fn parse_as_of(text: &str) -> Option<u64> {
    if !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()) {
        return text.parse().ok();
    }
    parse_rfc3339(text.as_bytes())
}

fn parse_rfc3339(b: &[u8]) -> Option<u64> {
    fn num(b: &[u8], from: usize, len: usize) -> Option<i64> {
        let digits = b.get(from..from + len)?;
        digits.iter().try_fold(0i64, |acc, &d| {
            d.is_ascii_digit().then(|| acc * 10 + i64::from(d - b'0'))
        })
    }
    fn at(b: &[u8], i: usize, want: &[u8]) -> Option<()> {
        want.contains(b.get(i)?).then_some(())
    }
    let year = num(b, 0, 4)?;
    at(b, 4, b"-")?;
    let month = num(b, 5, 2)?;
    at(b, 7, b"-")?;
    let day = num(b, 8, 2)?;
    at(b, 10, b"Tt")?;
    let hour = num(b, 11, 2)?;
    at(b, 13, b":")?;
    let minute = num(b, 14, 2)?;
    at(b, 16, b":")?;
    let second = num(b, 17, 2)?;

    let mut i = 19;
    let mut millis = 0;
    if b.get(i) == Some(&b'.') {
        let digits = b[i + 1..].iter().take_while(|d| d.is_ascii_digit()).count();
        if digits == 0 {
            return None;
        }
        // Truncated to ms, as the node truncates to seconds.
        millis = num(b, i + 1, digits.min(3))? * 10i64.pow(3 - digits.min(3) as u32);
        i += 1 + digits;
    }
    let offset = match b.get(i)? {
        b'Z' | b'z' if b.len() == i + 1 => 0,
        sign @ (b'+' | b'-') if b.len() == i + 6 => {
            let (oh, om) = (num(b, i + 1, 2)?, num(b, i + 4, 2)?);
            at(b, i + 3, b":")?;
            if oh > 23 || om > 59 {
                return None;
            }
            let secs = oh * 3600 + om * 60;
            if *sign == b'+' {
                secs
            } else {
                -secs
            }
        }
        _ => return None,
    };

    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let month_days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return None,
    };
    if day < 1 || day > month_days || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let secs =
        days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second - offset;
    let ms = secs.checked_mul(1000)?.checked_add(millis)?;
    u64::try_from(ms).ok()
}

/// Days since 1970-01-01 in the proleptic Gregorian calendar.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
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
    /// `BitSov-Data-As-Of`, clamped to the fetch time like `node_time_ms`.
    /// `None` without the header or without a host wall clock.
    pub as_of_ms: Option<u64>,
    /// The node sent `BitSov-Data-Stale: 1`.
    pub node_stale: bool,
    /// A node time or as-of ran more than [`MAX_NODE_SKEW`] ahead and was
    /// clamped.
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

/// `node` checked against the host wall clock at fetch time: more than
/// [`MAX_NODE_SKEW`] ahead is clamped to `host` and flagged. Without a host
/// wall clock there is nothing to check against.
fn clamp_to_host(node: Option<u64>, host: Option<u64>) -> (Option<u64>, bool) {
    match (node, host) {
        (Some(node), Some(host)) => {
            let limit = host.saturating_add(MAX_NODE_SKEW.as_millis() as u64);
            if node > limit {
                (Some(host), true)
            } else {
                (Some(node), false)
            }
        }
        _ => (None, false),
    }
}

impl RouteFreshness {
    pub fn assess(route: ReadRoute, raw: &RawRead) -> Self {
        let unknown = Self {
            route,
            fetched: None,
            node_time_ms: None,
            as_of_ms: None,
            node_stale: false,
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
        let (node_time_ms, message_skew) = clamp_to_host(node_time, fetched.wall_ms);
        let (as_of_ms, as_of_skew) = clamp_to_host(raw.marks.as_of_ms, fetched.wall_ms);
        Self {
            route,
            fetched: Some(fetched),
            node_time_ms,
            as_of_ms,
            node_stale: raw.marks.stale,
            clock_skew: message_skew || as_of_skew,
        }
    }

    /// Age at `now`. With a node as-of: the node's lag behind the host wall
    /// clock at fetch time plus the monotonic time since. Without: the host
    /// monotonic time since the fetch. Never negative.
    pub fn age(&self, now: Instant) -> Option<Duration> {
        let fetched = self.fetched?;
        let since_fetch = now.saturating_duration_since(fetched.at);
        let lag = match (self.as_of_ms, fetched.wall_ms) {
            (Some(as_of), Some(host)) => Duration::from_millis(host.saturating_sub(as_of)),
            _ => Duration::ZERO,
        };
        Some(since_fetch.saturating_add(lag))
    }

    pub fn state(&self, now: Instant) -> FreshnessState {
        match self.age(now) {
            None => FreshnessState::Unknown,
            Some(_) if self.node_stale => FreshnessState::Stale,
            Some(age) if age >= stale_after(self.route) => FreshnessState::Stale,
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
    /// host and ages from fresh to stale at its own [`stale_after`].
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

            let bound = stale_after(route);
            assert_eq!(fresh.age(fetched.at), Some(Duration::ZERO));
            assert_eq!(fresh.state(fetched.at), FreshnessState::Fresh);
            let almost = fetched.at + bound - Duration::from_millis(1);
            assert_eq!(fresh.state(almost), FreshnessState::Fresh, "{route:?}");
            let stale = fetched.at + bound;
            assert_eq!(fresh.age(stale), Some(bound));
            assert_eq!(fresh.state(stale), FreshnessState::Stale, "{route:?}");
        }
    }

    /// Balance and channels allow for the node's 80 s default on-chain wallet
    /// sync; everything else keeps the 60 s bound.
    #[test]
    fn each_route_has_its_documented_stale_bound() {
        let expected = [
            (ReadRoute::PaymentsBalance, 180),
            (ReadRoute::PaymentsChannels, 180),
            (ReadRoute::Health, 60),
            (ReadRoute::Messages { limit: 50 }, 60),
            (ReadRoute::OwnPricing, 60),
        ];
        for (route, secs) in expected {
            assert_eq!(stale_after(route), Duration::from_secs(secs), "{route:?}");
        }
        assert_eq!(STALE_AFTER, Duration::from_secs(60));
        assert_eq!(WALLET_STALE_AFTER, Duration::from_secs(180));
        assert!(WALLET_STALE_AFTER >= 2 * WALLET_SYNC_INTERVAL);
        assert_eq!(
            super::super::route::sample_routes().len(),
            expected.len(),
            "a new route needs a stale bound"
        );
    }

    /// The same bound applies to the app-read age (rc7, no headers) and to a
    /// node as-of age, at the exact boundary, and `Stale: 1` still wins.
    #[test]
    fn per_route_bounds_apply_to_app_read_and_as_of_ages_at_the_boundary() {
        let host = 1_800_000_000_000;
        let ms = Duration::from_millis(1);
        for route in super::super::route::sample_routes() {
            let bound = stale_after(route);
            let body = match route {
                ReadRoute::Messages { .. } => "[]",
                _ => "{}",
            };

            // rc7: no headers, app-read age only.
            let fetched = at_wall(host);
            let fresh = RouteFreshness::assess(route, &stamped(200, body, fetched));
            assert_eq!(fresh.state(fetched.at + bound - ms), FreshnessState::Fresh);
            assert_eq!(fresh.state(fetched.at + bound), FreshnessState::Stale);

            // #78 as-of: the node's lag counts toward the same bound.
            for lag in [Duration::ZERO, Duration::from_secs(45), bound - ms, bound] {
                let raw = RawRead::new(200, body.as_bytes().to_vec())
                    .marked(NodeMarks {
                        as_of_ms: Some(host - lag.as_millis() as u64),
                        stale: false,
                    })
                    .stamped(fetched);
                let fresh = RouteFreshness::assess(route, &raw);
                let turn = fetched.at + (bound - lag);
                if lag < bound {
                    assert_eq!(
                        fresh.state(turn - ms),
                        FreshnessState::Fresh,
                        "{route:?} {lag:?}"
                    );
                }
                assert_eq!(
                    fresh.state(turn),
                    FreshnessState::Stale,
                    "{route:?} {lag:?}"
                );
            }

            // `Stale: 1` wins over a fresh as-of on every route.
            let raw = RawRead::new(200, body.as_bytes().to_vec())
                .marked(NodeMarks {
                    as_of_ms: Some(host),
                    stale: true,
                })
                .stamped(fetched);
            let fresh = RouteFreshness::assess(route, &raw);
            assert_eq!(fresh.state(fetched.at), FreshnessState::Stale, "{route:?}");
        }
    }

    /// A balance as-of one wallet sync old (80 s) is fresh; at 60 s it would
    /// have read stale between every sync.
    #[test]
    fn a_balance_one_wallet_sync_behind_is_fresh() {
        let host = 1_800_000_000_000;
        let fetched = at_wall(host);
        for route in [ReadRoute::PaymentsBalance, ReadRoute::PaymentsChannels] {
            let raw = RawRead::new(200, b"{}".to_vec())
                .marked(NodeMarks {
                    as_of_ms: Some(host - WALLET_SYNC_INTERVAL.as_millis() as u64),
                    stale: false,
                })
                .stamped(fetched);
            let fresh = RouteFreshness::assess(route, &raw);
            assert_eq!(fresh.state(fetched.at), FreshnessState::Fresh, "{route:?}");
            assert_eq!(
                fresh.state(fetched.at + Duration::from_secs(60)),
                FreshnessState::Fresh,
                "{route:?}"
            );
        }
        // Pricing at the same lag is stale: its bound stays 60 s.
        let raw = RawRead::new(200, b"{}".to_vec())
            .marked(NodeMarks {
                as_of_ms: Some(host - WALLET_SYNC_INTERVAL.as_millis() as u64),
                stale: false,
            })
            .stamped(fetched);
        let fresh = RouteFreshness::assess(ReadRoute::OwnPricing, &raw);
        assert_eq!(fresh.state(fetched.at), FreshnessState::Stale);
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

    // --- BitSov-Data-As-Of / BitSov-Data-Stale (genome #78) ---

    /// `2026-09-27T08:20:00Z`.
    const AS_OF_MS: u64 = 1_790_497_200_000;
    const AS_OF: &str = "BitSov-Data-As-Of";
    const STALE: &str = "BitSov-Data-Stale";

    /// `secs` since the epoch as #78 writes it: RFC 3339, UTC `Z`, whole seconds.
    fn rfc3339(secs: u64) -> String {
        let days = (secs / 86_400) as i64;
        let rem = secs % 86_400;
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let day = doy - (153 * mp + 2) / 5 + 1;
        let month = if mp < 10 { mp + 3 } else { mp - 9 };
        let year = yoe + era * 400 + i64::from(month <= 2);
        format!(
            "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
            rem / 3600,
            rem % 3600 / 60,
            rem % 60
        )
    }

    fn host_secs() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
    }

    #[derive(Default)]
    struct Lines(std::sync::Mutex<Vec<String>>);

    impl super::super::AuditSink for Lines {
        fn record(&self, line: &str) {
            self.0.lock().unwrap().push(line.to_string());
        }
    }

    /// One read of `route` from a loopback server that adds `headers` to every
    /// response. Returns the assessed freshness and the host log.
    fn read_marked(
        node: MockNode,
        headers: &[(&str, &str)],
        route: ReadRoute,
    ) -> (u16, RouteFreshness, Vec<String>) {
        let server = TestServer::start(node, TOKEN);
        assert_ne!(server.port(), NODE_PORT);
        server.set_headers(headers);
        let audit = std::sync::Arc::new(Lines::default());
        let read = LocalNodeRead::new(
            &server.api_base(),
            BearerToken::new(TOKEN.to_string()).expect("token"),
            audit.clone(),
        )
        .expect("loopback base");
        let raw = read.read(route).expect("read");
        let fresh = RouteFreshness::assess(route, &raw);
        let lines = audit.0.lock().unwrap().clone();
        (raw.status, fresh, lines)
    }

    #[test]
    fn the_test_formatter_matches_the_node_example() {
        assert_eq!(rfc3339(AS_OF_MS / 1000), "2026-09-27T08:20:00Z");
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(1_709_164_800), "2024-02-29T00:00:00Z");
    }

    #[test]
    fn as_of_parses_rfc3339_and_normalises_to_utc() {
        for text in [
            "2026-09-27T08:20:00Z",
            "2026-09-27t08:20:00z",
            "2026-09-27T08:20:00+00:00",
            "2026-09-27T08:20:00-00:00",
            "2026-09-27T10:20:00+02:00",
            "2026-09-27T03:50:00-04:30",
            "2026-09-28T00:20:00+16:00",
        ] {
            assert_eq!(parse_as_of(text), Some(AS_OF_MS), "{text}");
        }
        assert_eq!(parse_as_of("2026-09-27T08:20:00.5Z"), Some(AS_OF_MS + 500));
        assert_eq!(
            parse_as_of("2026-09-27T08:20:00.123999999Z"),
            Some(AS_OF_MS + 123)
        );
        assert_eq!(parse_as_of("2024-02-29T00:00:00Z"), Some(1_709_164_800_000));
        assert_eq!(parse_as_of("1970-01-01T00:00:00Z"), Some(0));
    }

    #[test]
    fn as_of_accepts_plain_millisecond_digits() {
        assert_eq!(parse_as_of("1790497200000"), Some(AS_OF_MS));
        assert_eq!(parse_as_of("1790497200123"), Some(AS_OF_MS + 123));
        assert_eq!(parse_as_of("0"), Some(0));
    }

    #[test]
    fn a_malformed_as_of_is_none() {
        for text in [
            "",
            " ",
            "yesterday",
            "2026-09-27",
            "2026-09-27T08:20:00",
            "2026-09-27 08:20:00Z",
            "2026-09-27T08:20Z",
            "2026-9-27T08:20:00Z",
            "02026-09-27T08:20:00Z",
            "2026-13-01T00:00:00Z",
            "2026-00-01T00:00:00Z",
            "2026-02-29T00:00:00Z",
            "2026-04-31T00:00:00Z",
            "2026-09-00T00:00:00Z",
            "2026-09-27T24:00:00Z",
            "2026-09-27T08:60:00Z",
            "2026-09-27T08:20:60Z",
            "2026-09-27T08:20:00+24:00",
            "2026-09-27T08:20:00+02:60",
            "2026-09-27T08:20:00+0200",
            "2026-09-27T08:20:00+02",
            "2026-09-27T08:20:00.Z",
            "2026-09-27T08:20:00ZZ",
            "2026-09-27T08:20:00Z ",
            " 2026-09-27T08:20:00Z",
            "2026-09-27T08:20:00UTC",
            "Sun, 27 Sep 2026 08:20:00 GMT",
            "1969-12-31T23:59:59Z",
            "1970-01-01T00:30:00+01:00",
            "-5",
            "+5",
            "1.79e12",
            "1790497200000.0",
            "12a",
            "99999999999999999999",
            "\u{ff11}\u{ff17}\u{ff19}",
        ] {
            assert_eq!(parse_as_of(text), None, "{text:?}");
        }
    }

    /// rc7 sends neither header: every route keeps the app-read age.
    #[test]
    fn without_headers_every_route_keeps_the_app_read_age() {
        for route in super::super::route::sample_routes() {
            let (status, fresh, lines) = read_marked(MockNode::canonical(), &[], route);
            assert_eq!(status, 200);
            assert_eq!(
                (fresh.as_of_ms, fresh.node_stale),
                (None, false),
                "{route:?}"
            );
            let fetched = fresh.fetched.expect("stamp");
            assert_eq!(fresh.age(fetched.at), Some(Duration::ZERO));
            let bound = stale_after(route);
            assert_eq!(
                fresh.state(fetched.at + bound - Duration::from_millis(1)),
                FreshnessState::Fresh
            );
            assert_eq!(fresh.state(fetched.at + bound), FreshnessState::Stale);
            assert!(lines.is_empty(), "{lines:?}");
        }
    }

    #[test]
    fn a_node_as_of_sets_the_age_on_every_route() {
        let as_of_secs = host_secs() - 30;
        let header = rfc3339(as_of_secs);
        for route in super::super::route::sample_routes() {
            let (_, fresh, lines) = read_marked(MockNode::canonical(), &[(AS_OF, &header)], route);
            assert_eq!(fresh.as_of_ms, Some(as_of_secs * 1000), "{route:?}");
            assert!(!fresh.clock_skew && !fresh.node_stale, "{route:?}");
            let fetched = fresh.fetched.expect("stamp");
            let lag = fetched.wall_ms.expect("wall") - as_of_secs * 1000;
            assert!((30_000..40_000).contains(&lag), "{lag}");
            assert_eq!(fresh.age(fetched.at), Some(Duration::from_millis(lag)));
            assert_eq!(
                fresh.age(fetched.at + Duration::from_secs(5)),
                Some(Duration::from_millis(lag + 5_000))
            );
            // Stale once the node's data, not the app read, is past the
            // route's bound.
            let turn = fetched.at + stale_after(route) - Duration::from_millis(lag);
            assert_eq!(
                fresh.state(turn - Duration::from_millis(1)),
                FreshnessState::Fresh
            );
            assert_eq!(fresh.state(turn), FreshnessState::Stale, "{route:?}");
            assert!(lines.is_empty(), "{lines:?}");
        }
    }

    #[test]
    fn as_of_forms_on_the_wire_are_one_instant() {
        let secs = host_secs() - 5;
        let ms = secs * 1000;
        let zulu = rfc3339(secs);
        let plus = rfc3339(secs + 2 * 3600).replace('Z', "+02:00");
        let minus = rfc3339(secs - 4 * 3600 - 1800).replace('Z', "-04:30");
        let digits = ms.to_string();
        for (name, value) in [
            (AS_OF, zulu.as_str()),
            ("bitsov-data-as-of", plus.as_str()),
            ("BITSOV-DATA-AS-OF", minus.as_str()),
            (AS_OF, digits.as_str()),
        ] {
            let (_, fresh, lines) =
                read_marked(MockNode::canonical(), &[(name, value)], ReadRoute::Health);
            assert_eq!(fresh.as_of_ms, Some(ms), "{name}: {value}");
            assert!(lines.is_empty(), "{lines:?}");
        }
        let sub_second = (ms + 250).to_string();
        let (_, fresh, _) = read_marked(
            MockNode::canonical(),
            &[(AS_OF, &sub_second)],
            ReadRoute::Health,
        );
        assert_eq!(fresh.as_of_ms, Some(ms + 250));
    }

    #[test]
    fn a_malformed_as_of_is_ignored_and_logged_without_its_value() {
        for (headers, reason) in [
            (vec![(AS_OF, "CANARY-asof-7f")], "malformed"),
            (vec![(AS_OF, "2026-09-27T08:20:00")], "malformed"),
            (vec![(AS_OF, "")], "malformed"),
            (
                vec![
                    (AS_OF, "2026-09-27T08:20:00Z"),
                    (AS_OF, "2026-09-27T08:21:00Z"),
                ],
                "repeated",
            ),
        ] {
            let (status, fresh, lines) =
                read_marked(MockNode::canonical(), &headers, ReadRoute::PaymentsBalance);
            assert_eq!(status, 200);
            assert_eq!(fresh.as_of_ms, None, "{headers:?}");
            let fetched = fresh.fetched.expect("stamp");
            assert_eq!(fresh.age(fetched.at), Some(Duration::ZERO));
            assert_eq!(fresh.state(fetched.at), FreshnessState::Fresh);
            assert_eq!(
                lines,
                [format!(
                    "[assistant-broker] GET /api/v1/payments/balance: ignored BitSov-Data-As-Of: {reason}"
                )]
            );
            assert!(!lines[0].contains("CANARY") && !lines[0].contains("2026"));
        }
    }

    #[test]
    fn a_future_as_of_beyond_the_skew_is_clamped_and_flagged() {
        let ahead = rfc3339(host_secs() + MAX_NODE_SKEW.as_secs() + 600);
        let (_, fresh, _) =
            read_marked(MockNode::canonical(), &[(AS_OF, &ahead)], ReadRoute::Health);
        let fetched = fresh.fetched.expect("stamp");
        assert_eq!(fresh.as_of_ms, fetched.wall_ms);
        assert!(fresh.clock_skew);
        assert_eq!(fresh.age(fetched.at), Some(Duration::ZERO));
        assert_eq!(fresh.state(fetched.at), FreshnessState::Fresh);

        // Within the skew: not flagged, and never a negative age.
        let near = rfc3339(host_secs() + 30);
        let (_, fresh, _) =
            read_marked(MockNode::canonical(), &[(AS_OF, &near)], ReadRoute::Health);
        let fetched = fresh.fetched.expect("stamp");
        assert!(!fresh.clock_skew);
        assert!(fresh.as_of_ms > fetched.wall_ms);
        assert_eq!(fresh.age(fetched.at), Some(Duration::ZERO));
    }

    #[test]
    fn data_stale_1_forces_stale_whatever_the_age() {
        let now = rfc3339(host_secs());
        for headers in [
            vec![(STALE, "1")],
            vec![("bitsov-data-stale", "1")],
            vec![(AS_OF, now.as_str()), (STALE, "1")],
            vec![(AS_OF, "not a time"), (STALE, "1")],
        ] {
            let (_, fresh, _) =
                read_marked(MockNode::canonical(), &headers, ReadRoute::PaymentsBalance);
            assert!(fresh.node_stale, "{headers:?}");
            let fetched = fresh.fetched.expect("stamp");
            assert!(fresh.age(fetched.at).expect("age") < Duration::from_secs(5));
            assert_eq!(
                fresh.state(fetched.at),
                FreshnessState::Stale,
                "{headers:?}"
            );
        }
    }

    #[test]
    fn data_stale_other_than_1_has_no_effect() {
        for value in ["0", "", "true", "yes", "01", "2", "1, 1", "stale"] {
            let (_, fresh, lines) = read_marked(
                MockNode::canonical(),
                &[(STALE, value)],
                ReadRoute::OwnPricing,
            );
            assert!(!fresh.node_stale, "{value:?}");
            let fetched = fresh.fetched.expect("stamp");
            assert_eq!(fresh.state(fetched.at), FreshnessState::Fresh, "{value:?}");
            assert!(lines.is_empty(), "{lines:?}");
        }
    }

    #[test]
    fn headers_on_an_error_response_are_ignored() {
        let old = rfc3339(host_secs() - 3600);
        let headers = [(AS_OF, old.as_str()), (STALE, "1")];
        let node = MockNode::canonical().fault(mock_node::Route::Health, mock_node::Fault::Error);
        let (status, fresh, lines) = read_marked(node, &headers, ReadRoute::Health);
        assert_eq!(status, 500);
        assert_eq!(
            (fresh.fetched, fresh.as_of_ms, fresh.node_stale),
            (None, None, false)
        );
        assert_eq!(fresh.state(Instant::now()), FreshnessState::Unknown);
        assert_eq!(lines, ["[assistant-broker] GET /api/v1/health: http 500"]);

        // A malformed header on an error is not even logged.
        let node = MockNode::canonical().fault(mock_node::Route::Health, mock_node::Fault::Error);
        let (_, _, lines) = read_marked(node, &[(AS_OF, "junk")], ReadRoute::Health);
        assert_eq!(lines, ["[assistant-broker] GET /api/v1/health: http 500"]);
    }

    #[test]
    fn marks_need_a_stamp_and_as_of_needs_a_host_wall_clock() {
        let marks = NodeMarks {
            as_of_ms: Some(5),
            stale: true,
        };
        // In-process mock: no stamp, no claim.
        let raw = RawRead::new(200, b"{}".to_vec()).marked(marks);
        let fresh = RouteFreshness::assess(ReadRoute::Health, &raw);
        assert_eq!(fresh.state(Instant::now()), FreshnessState::Unknown);
        assert_eq!((fresh.as_of_ms, fresh.node_stale), (None, false));

        // No host wall clock: the as-of cannot be placed, Stale still counts.
        let fetched = Fetched {
            at: Instant::now(),
            wall_ms: None,
        };
        let raw = RawRead::new(200, b"{}".to_vec())
            .marked(marks)
            .stamped(fetched);
        let fresh = RouteFreshness::assess(ReadRoute::Health, &raw);
        assert_eq!(fresh.as_of_ms, None);
        assert_eq!(fresh.age(fetched.at), Some(Duration::ZERO));
        assert_eq!(fresh.state(fetched.at), FreshnessState::Stale);
    }

    #[test]
    fn a_messages_skew_still_flags_alongside_an_as_of() {
        let host = 1_800_000_000_000;
        let route = ReadRoute::Messages { limit: 1 };
        let ahead = format!(r#"[{{"timestamp":{}}}]"#, host + 3_600_000);
        let raw = RawRead::new(200, ahead.into_bytes())
            .marked(NodeMarks {
                as_of_ms: Some(host - 10_000),
                stale: false,
            })
            .stamped(at_wall(host));
        let fresh = RouteFreshness::assess(route, &raw);
        assert!(fresh.clock_skew);
        assert_eq!(fresh.node_time_ms, Some(host));
        assert_eq!(fresh.as_of_ms, Some(host - 10_000));
        let fetched = fresh.fetched.expect("stamp");
        assert_eq!(fresh.age(fetched.at), Some(Duration::from_secs(10)));
    }
}
