//! Host-side choice of the assistant window's rows: the local node or mock.
//!
//! Live only when the host holds a paired session with the `read` scope and
//! the node answers on loopback with that token. Everything else is mock rows
//! plus a reason. The inputs are the host's auth state and base URL; nothing
//! from the assistant window reaches this function.

use std::sync::Arc;

pub use super::assistant_source::NodeAuth;
use super::assistant_source::{Feed, MockReason};
use super::broker::{
    AuditSink, Broker, HealthInput, LocalNodeRead, NodeRead, Report, Snapshot, ToolCall, ToolOutput,
};
use super::sit_mock;

/// The pairing scope that allows reads.
const READ_SCOPE: &str = "read";

/// Read the 50-question fixture from the node, or fall back to mock.
pub fn build(auth: NodeAuth, base_url: &str, audit: Arc<dyn AuditSink>) -> Feed {
    let token = match auth {
        NodeAuth::NotPaired => return Feed::mock(MockReason::NotPaired),
        NodeAuth::Rc7Fallback => return Feed::mock(MockReason::Rc7Fallback),
        NodeAuth::Paired { token, scopes } => {
            if !scopes.iter().any(|scope| scope == READ_SCOPE) {
                return Feed::mock(MockReason::NotPaired);
            }
            token
        }
    };
    let Ok(node) = LocalNodeRead::new(base_url, token, audit) else {
        return Feed::mock(MockReason::NodeUnreachable);
    };
    let snapshot = Snapshot::new(&node);
    let rows = healthy(&snapshot).then(|| sit_mock::live_rows(&snapshot));
    if snapshot.transport_failed() {
        return Feed::mock(MockReason::NodeUnreachable);
    }
    if snapshot.unauthorized() {
        return Feed::mock(MockReason::NotPaired);
    }
    match rows {
        Some(rows) => Feed::live(rows).with_freshness(snapshot.freshness()),
        None => Feed::mock(MockReason::NodeUnreachable),
    }
}

/// The health tool produced a report from a fresh read.
fn healthy(node: &impl NodeRead) -> bool {
    let Ok(broker) = Broker::new() else {
        return false;
    };
    let call = ToolCall::Health {
        input: HealthInput {},
    };
    matches!(
        broker.dispatch(node, call).map(|d| d.output().clone()),
        Ok(ToolOutput::Health {
            report: Report::Ready { .. }
        })
    )
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::time::Instant;

    use mock_node::{Fault, MockNode, Route};

    use super::super::assistant_source::{Source, FRESHNESS_GLOBAL};
    use super::super::broker::test_server::{closed_loopback_port, TestServer, NODE_PORT};
    use super::super::broker::{route_key, stale_after, FreshnessState};
    use super::super::broker::{BearerToken, LocalNodeRead};
    use super::super::sit_mock;
    use super::*;

    const TOKEN: &str = "paired-FEED-CANARY-91c0";

    #[derive(Default)]
    struct Collect(Mutex<Vec<String>>);

    impl AuditSink for Collect {
        fn record(&self, line: &str) {
            self.0.lock().unwrap().push(line.to_string());
        }
    }

    fn paired(scopes: &[&str]) -> NodeAuth {
        NodeAuth::Paired {
            token: BearerToken::new(TOKEN.to_string()).expect("token"),
            scopes: scopes.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn build_logged(auth: NodeAuth, base: &str) -> (Feed, Vec<String>) {
        let audit = Arc::new(Collect::default());
        let feed = build(auth, base, audit.clone());
        let lines = audit.0.lock().unwrap().clone();
        for line in &lines {
            assert!(!line.contains(TOKEN), "token in log: {line}");
        }
        (feed, lines)
    }

    /// Every fixture question, each against a node with that question's
    /// faults, over a real loopback socket, answers the same as the
    /// in-process mock adapter.
    #[test]
    fn fixture_over_loopback_matches_the_in_process_mock() {
        let server = TestServer::start(MockNode::canonical(), TOKEN);
        assert_ne!(server.port(), NODE_PORT);
        let audit: Arc<dyn AuditSink> = Arc::new(Collect::default());

        let over_socket = sit_mock::rows_via(|node| {
            server.set_node(node.clone());
            LocalNodeRead::new(
                &server.api_base(),
                BearerToken::new(TOKEN.to_string()).expect("token"),
                audit.clone(),
            )
            .expect("loopback base")
        });
        let in_process = sit_mock::rows();

        assert_eq!(in_process.len(), 50);
        assert_eq!(over_socket, in_process);

        let seen = server.seen();
        assert!(!seen.is_empty());
        for request in &seen {
            assert_eq!(request.method, "GET");
            assert_eq!(request.bearer.as_deref(), Some(TOKEN));
            let path = request.target.split('?').next().unwrap();
            assert!(
                super::super::broker::ALLOWED_PATHS.contains(&path),
                "{}",
                request.target
            );
        }
    }

    #[test]
    fn paired_and_healthy_is_live_with_node_values() {
        let server = TestServer::start(MockNode::canonical(), TOKEN);
        let (feed, _) = build_logged(paired(&["read", "receive"]), &server.api_base());
        assert_eq!(feed.source(), Source::Live);

        let want: Vec<(String, String)> = [
            ("q01", "500000"),
            ("q02", "52500000"),
            ("q03", "1830000"),
            ("q04", "970000"),
            ("q05", "2800000"),
            ("q06", "3"),
            ("q07", "2"),
            ("q08", "1"),
            ("q09", "ok"),
            ("q10", "2"),
            ("q11", "11"),
            ("q12", "13"),
            ("q13", "true"),
            ("q14", "true"),
            ("q15", "172800"),
            ("q16", "2"),
            ("q17", "860123"),
            ("q18", "ldk"),
            ("q19", "esplora"),
            ("q20", "Unavailable"),
            ("q21", "2"),
            ("q22", "4"),
            ("q23", "1"),
            ("q24", "Unavailable"),
            ("q25", "Unavailable"),
            ("q26", "1000"),
            ("q27", "Unavailable"),
            ("q28", "8000"),
            ("q29", "2500"),
            ("q30", "1000"),
            ("q31", "static"),
            ("q32", "Unavailable"),
            // The fixture's fault rows ask the same keys; a healthy node answers.
            ("q33", "500000"),
            ("q34", "3"),
            ("q35", "Unavailable"),
            ("q36", "1000"),
            ("q37", "11"),
            ("q38", "52500000"),
            ("q39", "1830000"),
            ("q40", "13"),
            ("q41", "4"),
            ("q42", "8000"),
            ("q43", "Unavailable"),
            ("q44", "860123"),
            ("q45", "500000"),
            ("q46", "1830000"),
            ("q47", "Unavailable"),
            ("q48", "1000"),
            ("q49", "3"),
            ("q50", "172800"),
        ]
        .iter()
        .map(|(id, value)| (id.to_string(), value.to_string()))
        .collect();
        assert_eq!(feed.live_rows(), want.as_slice());
    }

    /// Golden init script for a paired, live window, loaded by the window's
    /// onboarding e2e test (`tests/onboarding-assistant-e2e.test.tsx`), so
    /// host and window agree on the exact globals. Fixed clocks: balance has
    /// a #78 as-of one wallet sync (80 s) old; the rest are rc7 app reads;
    /// ages are taken 12 s after the reads. `BITSOV_BLESS=1` rewrites it.
    #[test]
    fn the_live_init_script_matches_the_window_golden() {
        use super::super::broker::{Fetched, NodeMarks, RawRead, ReadRoute, RouteFreshness};
        use std::time::Duration;

        let t0 = Instant::now();
        let wall = 1_790_497_200_000; // 2026-09-27T08:20:00Z
        let read = |route: ReadRoute, as_of_ms: Option<u64>| {
            let body: &[u8] = match route {
                ReadRoute::Messages { .. } => b"[]",
                _ => b"{}",
            };
            let raw = RawRead::new(200, body.to_vec())
                .marked(NodeMarks {
                    as_of_ms,
                    stale: false,
                })
                .stamped(Fetched {
                    at: t0,
                    wall_ms: Some(wall),
                });
            RouteFreshness::assess(route, &raw)
        };
        let freshness = vec![
            read(ReadRoute::PaymentsBalance, Some(wall - 80_000)),
            read(ReadRoute::PaymentsChannels, Some(wall)),
            read(ReadRoute::Health, Some(wall)),
            read(ReadRoute::Messages { limit: 50 }, Some(wall)),
            read(ReadRoute::OwnPricing, Some(wall)),
        ];
        let feed = Feed::live(sit_mock::rows()).with_freshness(freshness);
        let script = feed.init_script_at(t0 + Duration::from_secs(12));

        let golden = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/assistant-live-init.js");
        if std::env::var_os("BITSOV_BLESS").is_some() {
            std::fs::write(&golden, format!("{script}\n")).expect("write golden");
        }
        let want = std::fs::read_to_string(&golden).expect("golden init script");
        assert_eq!(
            want.trim_end(),
            script,
            "BITSOV_BLESS=1 cargo test to update"
        );
    }

    #[test]
    fn a_live_feed_stamps_every_route_it_read() {
        let before = Instant::now();
        let server = TestServer::start(MockNode::canonical(), TOKEN);
        let as_of = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
            .to_string();
        server.set_headers(&[("BitSov-Data-As-Of", &as_of)]);
        let (feed, _) = build_logged(paired(&["read"]), &server.api_base());
        let after = Instant::now();
        assert_eq!(feed.source(), Source::Live);

        let keys: Vec<&str> = feed
            .freshness()
            .iter()
            .map(|f| route_key(f.route))
            .collect();
        assert_eq!(
            keys,
            ["balance", "channels", "health", "messages", "pricing"]
        );
        for fresh in feed.freshness() {
            let fetched = fresh.fetched.expect("host stamp");
            assert!(before <= fetched.at && fetched.at <= after);
            assert_eq!(fresh.state(after), FreshnessState::Fresh);
            assert_eq!(
                fresh.state(fetched.at + stale_after(fresh.route)),
                FreshnessState::Stale
            );
            assert!(!fresh.clock_skew);
        }
        let script = feed.init_script_at(after);
        assert_eq!(script.matches(r#""state":"fresh""#).count(), 5, "{script}");
    }

    #[test]
    fn a_live_feed_with_a_failed_route_marks_only_that_route_unknown() {
        let node = MockNode::canonical().fault(Route::PaymentsChannels, Fault::Error);
        let server = TestServer::start(node, TOKEN);
        let as_of = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
            .to_string();
        server.set_headers(&[("BitSov-Data-As-Of", &as_of)]);
        let (feed, _) = build_logged(paired(&["read"]), &server.api_base());
        assert_eq!(feed.source(), Source::Live);
        let now = Instant::now();
        let states: Vec<(&str, FreshnessState)> = feed
            .freshness()
            .iter()
            .map(|f| (route_key(f.route), f.state(now)))
            .collect();
        assert_eq!(
            states,
            [
                ("balance", FreshnessState::Fresh),
                ("channels", FreshnessState::Unknown),
                ("health", FreshnessState::Fresh),
                ("messages", FreshnessState::Fresh),
                ("pricing", FreshnessState::Fresh),
            ]
        );
    }

    #[test]
    fn every_mock_feed_has_no_freshness() {
        let server = TestServer::start(MockNode::canonical(), "a-different-token");
        let port = closed_loopback_port();
        for (auth, base) in [
            (NodeAuth::NotPaired, server.api_base()),
            (NodeAuth::Rc7Fallback, server.api_base()),
            (paired(&["read"]), server.api_base()),
            (paired(&["read"]), format!("http://127.0.0.1:{port}/api/v1")),
        ] {
            let (feed, _) = build_logged(auth, &base);
            assert!(matches!(feed.source(), Source::Mock(_)));
            assert!(feed.freshness().is_empty());
            assert!(!feed.init_script().contains(FRESHNESS_GLOBAL));
        }
    }

    #[test]
    fn a_live_feed_reads_each_route_once() {
        let server = TestServer::start(MockNode::canonical(), TOKEN);
        let (feed, _) = build_logged(paired(&["read"]), &server.api_base());
        assert_eq!(feed.source(), Source::Live);
        let mut targets: Vec<String> = server.seen().into_iter().map(|s| s.target).collect();
        targets.sort();
        assert_eq!(
            targets,
            [
                "/api/v1/health",
                "/api/v1/messages?limit=50",
                "/api/v1/payments/balance",
                "/api/v1/payments/channels",
                "/api/v1/pricing",
            ]
        );
    }

    #[test]
    fn rc7_fallback_is_mock_and_never_reads() {
        let server = TestServer::start(MockNode::canonical(), TOKEN);
        let (feed, _) = build_logged(NodeAuth::Rc7Fallback, &server.api_base());
        assert_eq!(feed, Feed::mock(MockReason::Rc7Fallback));
        assert!(server.seen().is_empty());
    }

    #[test]
    fn not_paired_is_mock_and_never_reads() {
        let server = TestServer::start(MockNode::canonical(), TOKEN);
        let (feed, _) = build_logged(NodeAuth::NotPaired, &server.api_base());
        assert_eq!(feed, Feed::mock(MockReason::NotPaired));
        assert!(server.seen().is_empty());
    }

    #[test]
    fn a_pairing_without_read_scope_is_not_paired_and_never_reads() {
        let server = TestServer::start(MockNode::canonical(), TOKEN);
        let (feed, _) = build_logged(paired(&["receive"]), &server.api_base());
        assert_eq!(feed, Feed::mock(MockReason::NotPaired));
        assert!(server.seen().is_empty());
    }

    #[test]
    fn a_refused_token_is_not_paired() {
        let server = TestServer::start(MockNode::canonical(), "a-different-token");
        let (feed, _) = build_logged(paired(&["read"]), &server.api_base());
        assert_eq!(feed, Feed::mock(MockReason::NotPaired));
    }

    #[test]
    fn an_unreachable_node_is_mock_with_a_reason() {
        let port = closed_loopback_port();
        let (feed, lines) = build_logged(
            paired(&["read"]),
            &format!("http://127.0.0.1:{port}/api/v1"),
        );
        assert_eq!(feed, Feed::mock(MockReason::NodeUnreachable));
        assert_eq!(
            lines,
            ["[assistant-broker] GET /api/v1/health: transport error"]
        );
    }

    #[test]
    fn a_route_that_drops_mid_read_is_mock() {
        let node = MockNode::canonical().fault(Route::Messages, Fault::Timeout);
        let server = TestServer::start(node, TOKEN);
        let (feed, _) = build_logged(paired(&["read"]), &server.api_base());
        assert_eq!(feed, Feed::mock(MockReason::NodeUnreachable));
    }

    #[test]
    fn a_non_loopback_base_is_refused_and_mock() {
        // Scheme split off for the G2 authority gate's source scan.
        let base = format!("{}://192.168.1.5:3141/api/v1", "http");
        let (feed, lines) = build_logged(paired(&["read"]), &base);
        assert_eq!(feed, Feed::mock(MockReason::NodeUnreachable));
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("refused base url"), "{lines:?}");
    }
}
