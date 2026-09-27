//! What the sealed assistant window is told about where its rows came from.
//!
//! The host decides. The window gets frozen, non-configurable globals through
//! its initialization script and has no command, IPC grant or network path to
//! change them. There is no window-callable way to pick the backend.

use std::time::Instant;

use serde_json::{json, Value};

use super::broker::{route_key, stale_after, BearerToken, RouteFreshness};

/// The host's auth state, as F1 (`crate::pairing`) established it.
#[derive(Debug)]
pub enum NodeAuth {
    /// No session: not started, pairing pending, or pairing failed.
    NotPaired,
    /// rc7: `/pair/request` was 404 and the host minted via `/auth/local`.
    /// The assistant does not read with that token.
    Rc7Fallback,
    /// #77 pairing. `token` is the current paired token.
    Paired {
        token: BearerToken,
        scopes: Vec<String>,
    },
}

/// Global holding `{kind: "live"}` or `{kind: "mock", reason}`. Must match
/// `src/assistant/source.ts`.
pub const SOURCE_GLOBAL: &str = "__BITSOV_ASSISTANT_SOURCE__";

/// Global holding live `[[id, answer], ...]`. Defined only for a live feed.
/// Must match `src/assistant/source.ts`.
pub const LIVE_ROWS_GLOBAL: &str = "__BITSOV_LIVE_ROWS__";

/// Global holding `{routes: [{route, state, age_ms, clock_skew,
/// stale_after_ms}]}`. `stale_after_ms` is the route's own bound
/// ([`stale_after`]). Defined only for a live feed. Must match
/// `src/assistant/source.ts`.
pub const FRESHNESS_GLOBAL: &str = "__BITSOV_LIVE_FRESHNESS__";

/// Why the window shows mock rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MockReason {
    /// No paired session with a `read` scope (includes a refused token).
    NotPaired,
    /// The node did not answer on loopback, or the base URL was refused.
    NodeUnreachable,
    /// The node has no pairing routes (rc7): the app is on `/auth/local`,
    /// which the assistant does not use.
    Rc7Fallback,
}

impl MockReason {
    pub fn code(self) -> &'static str {
        match self {
            Self::NotPaired => "not_paired",
            Self::NodeUnreachable => "node_unreachable",
            Self::Rc7Fallback => "rc7_fallback",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Live,
    Mock(MockReason),
}

/// The host's decision plus, when live, the rows read from the node and how
/// old each route's read is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Feed {
    source: Source,
    live_rows: Vec<(String, String)>,
    freshness: Vec<RouteFreshness>,
}

impl Feed {
    pub fn mock(reason: MockReason) -> Self {
        Self {
            source: Source::Mock(reason),
            live_rows: Vec::new(),
            freshness: Vec::new(),
        }
    }

    pub fn live(rows: Vec<(String, String)>) -> Self {
        Self {
            source: Source::Live,
            live_rows: rows,
            freshness: Vec::new(),
        }
    }

    /// Per-route freshness for a live feed. Mock rows make no freshness claim,
    /// so a mock feed drops it.
    pub fn with_freshness(mut self, freshness: Vec<RouteFreshness>) -> Self {
        if self.source == Source::Live {
            self.freshness = freshness;
        }
        self
    }

    pub fn freshness(&self) -> &[RouteFreshness] {
        &self.freshness
    }

    pub fn source(&self) -> Source {
        self.source
    }

    pub fn live_rows(&self) -> &[(String, String)] {
        &self.live_rows
    }

    /// Initialization script: defines [`SOURCE_GLOBAL`], and
    /// [`LIVE_ROWS_GLOBAL`] and [`FRESHNESS_GLOBAL`] for a live feed. All are
    /// frozen, not writable and not configurable. Ages are taken now.
    pub fn init_script(&self) -> String {
        self.init_script_at(Instant::now())
    }

    /// [`Feed::init_script`] with ages measured at `now`.
    pub fn init_script_at(&self, now: Instant) -> String {
        let source = match self.source {
            Source::Live => json!({ "kind": "live" }),
            Source::Mock(reason) => json!({ "kind": "mock", "reason": reason.code() }),
        };
        let mut script = String::from(
            "(() => { const deepFreeze = (v) => { if (v && typeof v === 'object') \
             { Object.values(v).forEach(deepFreeze); Object.freeze(v); } return v; }; ",
        );
        script.push_str(&define(SOURCE_GLOBAL, &source));
        if self.source == Source::Live {
            let rows: Vec<[&str; 2]> = self
                .live_rows
                .iter()
                .map(|(id, value)| [id.as_str(), value.as_str()])
                .collect();
            script.push_str(&define(LIVE_ROWS_GLOBAL, &json!(rows)));
            script.push_str(&define(FRESHNESS_GLOBAL, &self.freshness_json(now)));
        }
        script.push_str("})();");
        script
    }
}

impl Feed {
    fn freshness_json(&self, now: Instant) -> Value {
        let routes: Vec<Value> = self
            .freshness
            .iter()
            .map(|fresh| {
                json!({
                    "route": route_key(fresh.route),
                    "state": fresh.state(now).code(),
                    "age_ms": fresh.age(now).map(|age| age.as_millis() as u64),
                    "clock_skew": fresh.clock_skew,
                    "stale_after_ms": stale_after(fresh.route).as_millis() as u64,
                })
            })
            .collect();
        json!({ "routes": routes })
    }
}

fn define(global: &str, value: &Value) -> String {
    format!(
        "Object.defineProperty(window, '{global}', {{ value: deepFreeze({}), \
         writable: false, configurable: false }}); ",
        js_literal(value)
    )
}

/// JSON as a JS expression that cannot close a `<script>` or split a statement.
///
/// serde_json escapes quotes, backslashes and control characters. `<` and the
/// JS line separators are escaped here.
pub fn js_literal(value: &Value) -> String {
    value
        .to_string()
        .replace('<', "\\u003c")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::super::broker::{
        Fetched, NodeMarks, RawRead, ReadRoute, STALE_AFTER, WALLET_STALE_AFTER,
    };
    use super::*;

    /// Pull `value: <json>` for `global` back out of a script.
    fn defined(script: &str, global: &str) -> Option<Value> {
        let head = format!("Object.defineProperty(window, '{global}', {{ value: ");
        let start = script.find(&head)? + head.len();
        let rest = &script[start..];
        let end = rest.find(", writable: false, configurable: false });")?;
        let expr = &rest[..end];
        let json = expr
            .strip_prefix("deepFreeze(")
            .and_then(|e| e.strip_suffix(')'))
            .unwrap_or(expr);
        Some(serde_json::from_str(json).expect("json literal"))
    }

    #[test]
    fn mock_feed_names_its_reason_and_defines_no_live_rows() {
        for (reason, code) in [
            (MockReason::NotPaired, "not_paired"),
            (MockReason::NodeUnreachable, "node_unreachable"),
            (MockReason::Rc7Fallback, "rc7_fallback"),
        ] {
            let script = Feed::mock(reason).init_script();
            assert_eq!(
                defined(&script, SOURCE_GLOBAL),
                Some(json!({ "kind": "mock", "reason": code })),
                "{script}"
            );
            assert!(!script.contains(LIVE_ROWS_GLOBAL), "{script}");
            assert!(!script.contains(FRESHNESS_GLOBAL), "{script}");
        }
    }

    fn stamped_at(route: ReadRoute, at: Instant, body: &str) -> RouteFreshness {
        let raw = RawRead::new(200, body.as_bytes().to_vec())
            .marked(NodeMarks {
                as_of_ms: Some(1_800_000_000_000),
                stale: false,
            })
            .stamped(Fetched {
                at,
                wall_ms: Some(1_800_000_000_000),
            });
        RouteFreshness::assess(route, &raw)
    }

    #[test]
    fn live_feed_carries_each_route_age_at_script_time() {
        let t0 = Instant::now();
        let freshness = vec![
            stamped_at(ReadRoute::PaymentsBalance, t0, "{}"),
            stamped_at(
                ReadRoute::Messages { limit: 1 },
                t0 + Duration::from_secs(2),
                r#"[{"timestamp":9999999999999}]"#,
            ),
            RouteFreshness::assess(ReadRoute::Health, &RawRead::new(200, b"{}".to_vec())),
        ];
        let feed = Feed::live(vec![("q01".into(), "1".into())]).with_freshness(freshness);

        let script = feed.init_script_at(t0 + Duration::from_secs(12));
        assert_eq!(
            defined(&script, FRESHNESS_GLOBAL),
            Some(json!({
                "routes": [
                    {"route": "balance", "state": "fresh", "age_ms": 12_000, "clock_skew": false, "stale_after_ms": 180_000},
                    {"route": "messages", "state": "fresh", "age_ms": 10_000, "clock_skew": true, "stale_after_ms": 60_000},
                    {"route": "health", "state": "unknown", "age_ms": null, "clock_skew": false, "stale_after_ms": 60_000},
                ],
            }))
        );

        // Messages turns stale at 60 s; balance allows for a wallet sync.
        let later = feed.init_script_at(t0 + STALE_AFTER + Duration::from_secs(2));
        let routes = defined(&later, FRESHNESS_GLOBAL).unwrap()["routes"].clone();
        assert_eq!(routes[0]["state"], "fresh");
        assert_eq!(routes[0]["age_ms"], 62_000);
        assert_eq!(routes[1]["state"], "stale");
        assert_eq!(routes[1]["age_ms"], 60_000);

        let later = feed.init_script_at(t0 + WALLET_STALE_AFTER);
        let routes = defined(&later, FRESHNESS_GLOBAL).unwrap()["routes"].clone();
        assert_eq!(routes[0]["state"], "stale");
        assert_eq!(routes[0]["age_ms"], 180_000);
    }

    /// Node marks reach the window only as `state` and `age_ms`: same keys.
    #[test]
    fn node_as_of_and_stale_reach_the_window_as_age_and_state() {
        let t0 = Instant::now();
        let wall = 1_800_000_000_000;
        let marked = |route, marks| {
            let raw = RawRead::new(200, b"{}".to_vec())
                .marked(marks)
                .stamped(Fetched {
                    at: t0,
                    wall_ms: Some(wall),
                });
            RouteFreshness::assess(route, &raw)
        };
        let freshness = vec![
            marked(
                ReadRoute::PaymentsBalance,
                NodeMarks {
                    as_of_ms: Some(wall - 50_000),
                    stale: false,
                },
            ),
            marked(
                ReadRoute::OwnPricing,
                NodeMarks {
                    as_of_ms: None,
                    stale: true,
                },
            ),
            marked(
                ReadRoute::Health,
                NodeMarks {
                    as_of_ms: Some(wall + 3_600_000),
                    stale: false,
                },
            ),
        ];
        let feed = Feed::live(vec![("q01".into(), "1".into())]).with_freshness(freshness);
        let script = feed.init_script_at(t0 + Duration::from_secs(2));
        assert_eq!(
            defined(&script, FRESHNESS_GLOBAL),
            Some(json!({
                "routes": [
                    {"route": "balance", "state": "fresh", "age_ms": 52_000, "clock_skew": false, "stale_after_ms": 180_000},
                    {"route": "pricing", "state": "stale", "age_ms": null, "clock_skew": false, "stale_after_ms": 60_000},
                    {"route": "health", "state": "unknown", "age_ms": null, "clock_skew": true, "stale_after_ms": 60_000},
                ],
            }))
        );
        // Balance as-of 50 s behind: stale when the node's data is 180 s old.
        let later = feed.init_script_at(t0 + Duration::from_secs(10));
        let routes = defined(&later, FRESHNESS_GLOBAL).unwrap()["routes"].clone();
        assert_eq!(routes[0]["state"], "fresh");
        assert_eq!(routes[0]["age_ms"], 60_000);
        let later = feed.init_script_at(t0 + Duration::from_secs(130) - Duration::from_millis(1));
        let routes = defined(&later, FRESHNESS_GLOBAL).unwrap()["routes"].clone();
        assert_eq!(routes[0]["state"], "fresh");
        let later = feed.init_script_at(t0 + Duration::from_secs(130));
        let routes = defined(&later, FRESHNESS_GLOBAL).unwrap()["routes"].clone();
        assert_eq!(routes[0]["state"], "stale");
        assert_eq!(routes[0]["age_ms"], 180_000);
    }

    #[test]
    fn a_live_feed_without_reads_has_no_routes() {
        let script = Feed::live(vec![("q01".into(), "1".into())]).init_script();
        assert_eq!(
            defined(&script, FRESHNESS_GLOBAL),
            Some(json!({ "routes": [] }))
        );
    }

    #[test]
    fn mock_ignores_freshness_even_if_handed_some() {
        let stamped = stamped_at(ReadRoute::Health, Instant::now(), "{}");
        let feed = Feed::mock(MockReason::NodeUnreachable).with_freshness(vec![stamped]);
        assert!(feed.freshness().is_empty());
        assert!(!feed.init_script().contains(FRESHNESS_GLOBAL));
    }

    #[test]
    fn live_feed_defines_source_and_rows() {
        let rows = vec![
            ("q01".to_string(), "500000".to_string()),
            ("q02".to_string(), "Unavailable".to_string()),
        ];
        let script = Feed::live(rows).init_script();
        assert_eq!(
            defined(&script, SOURCE_GLOBAL),
            Some(json!({ "kind": "live" }))
        );
        assert_eq!(
            defined(&script, LIVE_ROWS_GLOBAL),
            Some(json!([["q01", "500000"], ["q02", "Unavailable"]]))
        );
    }

    #[test]
    fn globals_are_frozen_and_cannot_be_redefined() {
        let script = Feed::live(vec![("q01".into(), "1".into())]).init_script();
        assert_eq!(
            script
                .matches(", writable: false, configurable: false });")
                .count(),
            3,
            "{script}"
        );
        assert_eq!(script.matches("value: deepFreeze(").count(), 3, "{script}");
        assert!(script.contains("Object.freeze"), "{script}");
    }

    #[test]
    fn live_values_cannot_close_the_script_or_split_a_statement() {
        let hostile = "</script><img src=x>'\"\\\u{2028}\u{2029}".to_string();
        let script = Feed::live(vec![("q01".into(), hostile.clone())]).init_script();
        assert!(!script.contains('<'), "{script}");
        assert!(!script.contains('\u{2028}') && !script.contains('\u{2029}'));
        assert_eq!(
            defined(&script, LIVE_ROWS_GLOBAL),
            Some(json!([["q01", hostile]]))
        );
    }
}
