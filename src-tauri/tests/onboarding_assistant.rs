//! First run → pairing → the assistant's first answer, host side, on mock
//! data only.
//!
//! One loopback server on an ephemeral port (never 3141) plays the node:
//! mock-node's #77 `/pair/*` state machine for pairing, and mock-node's rc7
//! read bodies for the five broker routes, gated on a token the pairing mock
//! issued. The app pairs with the real pairing client, and the assistant feed
//! then reads with that paired token and hands the window its rows plus
//! per-route freshness. No Tauri, no app start, no window.
//!
//! Needs `assistant_feed`, which is compiled for `--features sit-mock`.
#![cfg(feature = "sit-mock")]

// Shared with tests/pairing.rs; not every helper is used here.
#[allow(dead_code)]
mod support;

use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use bitsov_app::jarvis::assistant_feed;
use bitsov_app::jarvis::assistant_source::{
    Feed, MockReason, NodeAuth, Source, FRESHNESS_GLOBAL, LIVE_ROWS_GLOBAL, SOURCE_GLOBAL,
};
use bitsov_app::jarvis::broker::{AuditSink, BearerToken};
use bitsov_app::pairing::{self, ClientKey, Established, PairingClient, PrintedCodes};
use mock_node::pairing::PairRoutes;
use mock_node::MockNode;
use serde_json::{json, Value};
use support::{mock, Reads, Server};

const NAME: &str = "BitSov app";

#[derive(Default)]
struct Lines(Mutex<Vec<String>>);

impl AuditSink for Lines {
    fn record(&self, line: &str) {
        self.0.lock().unwrap().push(line.to_string());
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

/// Pull `value: <json>` for `global` back out of an init script.
fn defined(script: &str, global: &str) -> Option<Value> {
    let head = format!("Object.defineProperty(window, '{global}', {{ value: deepFreeze(");
    let start = script.find(&head)? + head.len();
    let rest = &script[start..];
    let end = rest.find("), writable: false, configurable: false });")?;
    Some(serde_json::from_str(&rest[..end]).expect("json literal"))
}

struct Node {
    server: Server,
    dir: tempfile::TempDir,
    codes: PrintedCodes,
}

fn node(routes: PairRoutes, headers: &[(&str, String)]) -> Node {
    let dir = tempfile::tempdir().unwrap();
    let pairing = mock(dir.path(), routes, now_secs() as i64);
    let codes = PrintedCodes::default();
    let reads = Reads {
        node: MockNode::canonical(),
        headers: headers
            .iter()
            .map(|(name, value)| (name.to_string(), value.clone()))
            .collect(),
    };
    let server = Server::start_with_reads(pairing, codes.clone(), Some(reads));
    assert!(
        !server.api_base().contains(":3141/"),
        "{}",
        server.api_base()
    );
    Node { server, dir, codes }
}

/// The app's first-run pairing, as `main.rs` runs it, mapped to the auth
/// state the assistant feed sees (`node_auth` in `main.rs`).
fn pair(node: &Node, app_dir: &std::path::Path) -> NodeAuth {
    let client = PairingClient::new(reqwest::Client::new(), node.server.api_base())
        .expect_challenge_dir(node.dir.path().join("pairing"))
        .with_code_wait(std::time::Duration::from_millis(500));
    let key = ClientKey::load_or_create(app_dir).unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let outcome = runtime
        .block_on(pairing::establish(
            &client,
            &key,
            app_dir,
            NAME,
            &node.codes,
        ))
        .expect("pairing");
    match outcome {
        Established::Paired { session, .. } => NodeAuth::Paired {
            token: BearerToken::new(session.token).expect("printable token"),
            scopes: session.scopes,
        },
        _ => NodeAuth::Rc7Fallback,
    }
}

fn build(auth: NodeAuth, node: &Node) -> (Feed, Vec<String>) {
    let audit = Arc::new(Lines::default());
    let feed = assistant_feed::build(auth, &node.server.api_base(), audit.clone());
    let lines = audit.0.lock().unwrap().clone();
    (feed, lines)
}

#[test]
fn first_run_pairs_then_the_first_answer_is_live_with_a_freshness_label() {
    let as_of = now_secs().to_string() + "000";
    let node = node(PairRoutes::Live, &[("BitSov-Data-As-Of", as_of)]);
    let app_dir = tempfile::tempdir().unwrap();

    // First run, before pairing: the window shows mock rows and says why.
    let (before, _) = build(NodeAuth::NotPaired, &node);
    assert_eq!(before.source(), Source::Mock(MockReason::NotPaired));
    let script = before.init_script();
    assert_eq!(
        defined(&script, SOURCE_GLOBAL),
        Some(json!({"kind": "mock", "reason": "not_paired"}))
    );
    assert!(!script.contains(FRESHNESS_GLOBAL));

    // Onboarding pairs this app (#77 ceremony against the mock `/pair/*`).
    let auth = pair(&node, app_dir.path());
    let NodeAuth::Paired { scopes, .. } = &auth else {
        panic!("expected a paired session");
    };
    assert_eq!(scopes, &["read", "receive"]);

    // The assistant reads with the paired token and goes live.
    let (feed, lines) = build(auth, &node);
    assert_eq!(feed.source(), Source::Live, "{lines:?}");
    let script = feed.init_script();
    assert_eq!(
        defined(&script, SOURCE_GLOBAL),
        Some(json!({"kind": "live"}))
    );
    let rows = defined(&script, LIVE_ROWS_GLOBAL).expect("live rows");
    // The window's first answer: q01, the first channel's local balance.
    assert_eq!(rows[0], json!(["q01", "500000"]));
    assert_eq!(rows.as_array().unwrap().len(), 50);

    // Every route supplied current node evidence, each with its own bound.
    let freshness = defined(&script, FRESHNESS_GLOBAL).expect("freshness");
    let routes = freshness["routes"].as_array().unwrap();
    let got: Vec<(&str, &str, u64)> = routes
        .iter()
        .map(|r| {
            (
                r["route"].as_str().unwrap(),
                r["state"].as_str().unwrap(),
                r["stale_after_ms"].as_u64().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        got,
        [
            ("balance", "fresh", 180_000),
            ("channels", "fresh", 180_000),
            ("health", "fresh", 60_000),
            ("messages", "fresh", 60_000),
            ("pricing", "fresh", 60_000),
        ]
    );
    for route in routes {
        assert!(route["age_ms"].as_u64().unwrap() < 5_000, "{route}");
        assert_eq!(route["clock_skew"], false);
    }
    assert!(lines.is_empty(), "{lines:?}");
}

#[test]
fn a_paired_live_answer_without_node_as_of_has_unknown_freshness() {
    let node = node(PairRoutes::Live, &[]);
    let app_dir = tempfile::tempdir().unwrap();
    let auth = pair(&node, app_dir.path());
    let (feed, lines) = build(auth, &node);
    assert_eq!(feed.source(), Source::Live, "{lines:?}");
    let freshness = defined(&feed.init_script(), FRESHNESS_GLOBAL).unwrap();
    let routes = freshness["routes"].as_array().unwrap();
    assert_eq!(routes.len(), 5);
    for route in routes {
        assert_eq!(route["state"], "unknown", "{route}");
        assert_eq!(route["age_ms"], Value::Null, "{route}");
    }
}

/// With #78 headers, a balance one wallet sync (80 s) old is still fresh; the
/// 60 s routes at the same as-of are stale. `Data-Stale: 1` wins everywhere.
#[test]
fn after_pairing_node_as_of_uses_each_routes_own_bound() {
    let as_of = (now_secs() - 80).to_string() + "000";
    let node = node(PairRoutes::Live, &[("BitSov-Data-As-Of", as_of.clone())]);
    let app_dir = tempfile::tempdir().unwrap();
    let auth = pair(&node, app_dir.path());
    let (feed, _) = build(auth, &node);
    assert_eq!(feed.source(), Source::Live);
    let freshness = defined(&feed.init_script(), FRESHNESS_GLOBAL).unwrap();
    let states: Vec<(&str, &str)> = freshness["routes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| (r["route"].as_str().unwrap(), r["state"].as_str().unwrap()))
        .collect();
    assert_eq!(
        states,
        [
            ("balance", "fresh"),
            ("channels", "fresh"),
            ("health", "stale"),
            ("messages", "stale"),
            ("pricing", "stale"),
        ]
    );

    let node = node_with_stale();
    let app_dir = tempfile::tempdir().unwrap();
    let auth = pair(&node, app_dir.path());
    let (feed, _) = build(auth, &node);
    let freshness = defined(&feed.init_script(), FRESHNESS_GLOBAL).unwrap();
    for route in freshness["routes"].as_array().unwrap() {
        assert_eq!(route["state"], "stale", "{route}");
    }
}

fn node_with_stale() -> Node {
    let as_of = now_secs().to_string() + "000";
    node(
        PairRoutes::Live,
        &[
            ("BitSov-Data-As-Of", as_of),
            ("BitSov-Data-Stale", "1".to_string()),
        ],
    )
}

/// rc7 has no `/pair/*`: onboarding falls back to `/auth/local`, and the
/// assistant stays on mock rows with that reason and no freshness claim.
#[test]
fn an_rc7_node_falls_back_and_the_assistant_stays_mock() {
    let node = node(PairRoutes::Absent, &[]);
    let app_dir = tempfile::tempdir().unwrap();
    let auth = pair(&node, app_dir.path());
    assert!(matches!(auth, NodeAuth::Rc7Fallback));
    let (feed, lines) = build(auth, &node);
    assert_eq!(feed.source(), Source::Mock(MockReason::Rc7Fallback));
    let script = feed.init_script();
    assert!(!script.contains(FRESHNESS_GLOBAL));
    assert!(!script.contains(LIVE_ROWS_GLOBAL));
    assert!(lines.is_empty(), "{lines:?}");
}
