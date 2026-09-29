//! AI track host rules: reads go through the broker with the paired token
//! only; presets only narrow; a remote send carries exactly the bytes shown,
//! once; remote providers are off unless this computer's file turns them on.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use mock_node::{balance_msat, MockNode, CANARIES, SENDER_A, SENDER_B};
use serde_json::{json, Value};

use super::*;
use crate::jarvis::broker::test_server::TestServer;
use crate::jarvis::broker::BearerToken;

const TOKEN: &str = "ai-track-test-token";
const TOPICS: [Topic; 6] = [
    Topic::Balance,
    Topic::Channels,
    Topic::Node,
    Topic::Inbox,
    Topic::Prices,
    Topic::Payments,
];
const PRESETS: [Preset; 3] = [Preset::Exact, Preset::Rounded, Preset::Counts];

struct Quiet;
impl AuditSink for Quiet {
    fn record(&self, _line: &str) {}
}

fn paired(scopes: &[&str]) -> NodeAuth {
    NodeAuth::Paired {
        token: BearerToken::new(TOKEN.into()).unwrap(),
        scopes: scopes.iter().map(|s| s.to_string()).collect(),
    }
}

fn read(server: &TestServer, topic: Topic) -> TopicRead {
    read_topic(paired(&["read", "receive"]), &server.api_base(), Arc::new(Quiet), topic, None)
}

fn remote(endpoint: &str) -> Remote {
    Remote {
        kind: ProviderKind::Shared,
        label: "Shared open model".into(),
        endpoint: endpoint.into(),
        host: endpoint_host(endpoint).expect("endpoint"),
        model: "open-model-8b".into(),
        key_env: None,
    }
}

fn outputs(read: &TopicRead) -> &[ToolOutput] {
    match read {
        TopicRead::Live { outputs, .. } => outputs,
        other => panic!("not live: {other:?}"),
    }
}

/// Every string and number in `value`, flattened.
fn leaves(value: &Value, out: &mut Vec<Value>) {
    match value {
        Value::Object(map) => map.values().for_each(|inner| leaves(inner, out)),
        Value::Array(items) => items.iter().for_each(|inner| leaves(inner, out)),
        other => out.push(other.clone()),
    }
}

// ---- reads ---------------------------------------------------------------------

#[test]
fn every_topic_reads_live_through_the_broker_with_freshness() {
    let server = TestServer::start(MockNode::canonical(), TOKEN);
    let as_of = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis()
        .to_string();
    server.set_headers(&[("BitSov-Data-As-Of", &as_of)]);
    for topic in TOPICS {
        let TopicRead::Live {
            topic: got,
            outputs,
            freshness,
            routes,
        } = read(&server, topic)
        else {
            panic!("{topic:?} not live")
        };
        assert_eq!(got, topic);
        assert!(!outputs.is_empty());
        assert_eq!(freshness.state, "fresh", "{topic:?}");
        assert!(freshness.age_ms.is_some());
        assert!(!routes.is_empty());
        for line in &routes {
            assert!(line.starts_with("GET /api/v1/"), "{line}");
            // A peer id is never written into a route line.
            assert!(!line.contains(SENDER_A) && !line.contains(SENDER_B), "{line}");
        }
    }
    for request in server.seen() {
        assert_eq!(request.method, "GET");
        assert_eq!(request.bearer.as_deref(), Some(TOKEN));
    }
}

#[test]
fn without_node_as_of_a_live_read_is_unknown_not_fresh() {
    let server = TestServer::start(MockNode::canonical(), TOKEN);
    for topic in TOPICS {
        let TopicRead::Live { freshness, .. } = read(&server, topic) else {
            panic!("{topic:?} not live")
        };
        assert_eq!(freshness.state, "unknown", "{topic:?}");
        assert_eq!(freshness.age_ms, None, "{topic:?}");
        assert_eq!(freshness.fresh_for_ms, None, "{topic:?}");
    }
    server.set_headers(&[("BitSov-Data-Stale", "1")]);
    let TopicRead::Live { freshness, .. } = read(&server, Topic::Node) else {
        panic!()
    };
    assert_eq!(freshness.state, "stale", "the node's own Stale: 1 wins without an as-of");
    assert_eq!(freshness.fresh_for_ms, Some(0));
}

#[test]
fn the_balance_answer_is_the_node_figure() {
    let server = TestServer::start(MockNode::canonical(), TOKEN);
    let value = serde_json::to_value(outputs(&read(&server, Topic::Balance))).unwrap();
    assert_eq!(
        value[0]["report"]["value"]["wallet_balance"]["value"].as_u64(),
        Some(balance_msat())
    );
}

#[test]
fn node_as_of_headers_feed_freshness_and_stale_wins() {
    let server = TestServer::start(MockNode::canonical(), TOKEN);
    let as_of = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        - 30_000;
    let as_of = as_of.to_string();
    server.set_headers(&[("BitSov-Data-As-Of", &as_of)]);
    let TopicRead::Live { freshness, .. } = read(&server, Topic::Node) else {
        panic!()
    };
    assert!(freshness.node_as_of);
    assert!(freshness.age_ms.unwrap() >= 30_000);
    assert_eq!(freshness.state, "fresh");

    server.set_headers(&[("BitSov-Data-Stale", "1")]);
    let TopicRead::Live { freshness, .. } = read(&server, Topic::Node) else {
        panic!()
    };
    assert_eq!(freshness.state, "stale");
    assert!(freshness.node_stale);
}

#[test]
fn explicit_node_stale_survives_every_topic_and_disclosure_preset() {
    let server = TestServer::start(MockNode::canonical(), TOKEN);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
    let recent = (now - 1_000).to_string();
    let future = (now + 86_400_000).to_string();
    let shared = remote("https://a.org/v1");
    for as_of in [None, Some("invalid"), Some(future.as_str()), Some(recent.as_str())] {
        let mut headers = vec![("BitSov-Data-Stale", "1")];
        if let Some(as_of) = as_of {
            headers.push(("BitSov-Data-As-Of", as_of));
        }
        server.set_headers(&headers);
        for topic in TOPICS {
            let got = read(&server, topic);
            let wire = serde_json::to_value(&got).unwrap();
            assert_eq!(wire["freshness"]["state"], "stale", "{topic:?} {as_of:?}");
            assert_eq!(wire["freshness"]["node_stale"], true);
            for preset in [Preset::Counts, Preset::Rounded, Preset::Exact] {
                let body = request_body(&shared, "How current is this?", &got, preset).unwrap();
                let body: Value = serde_json::from_str(&body).unwrap();
                let user: Value = serde_json::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap();
                assert_eq!(user["freshness"]["state"], "stale");
                assert_eq!(user["freshness"]["node_stale"], true);
            }
        }
    }
}

#[test]
fn mixed_route_freshness_keeps_the_earliest_actual_expiry() {
    use crate::jarvis::broker::{Fetched, NodeMarks, RawRead};
    let now = Instant::now();
    let wall = 1_800_000_000_000;
    let routes = [
        (ReadRoute::PaymentsBalance, 70_000),
        (ReadRoute::PaymentsChannels, 70_000),
        (ReadRoute::Health, 0),
    ].map(|(route, lag)| RouteFreshness::assess(route, &RawRead::new(200, b"{}".to_vec())
        .marked(NodeMarks { as_of_ms: Some(wall - lag), stale: false })
        .stamped(Fetched { at: now, wall_ms: Some(wall) })));
    for (elapsed, state, remaining) in [(0, "fresh", 60_000), (59_999, "fresh", 1), (60_000, "stale", 0)] {
        let summary = summarize(&routes, now + Duration::from_millis(elapsed));
        assert_eq!(summary.state, state);
        assert_eq!(summary.age_ms, Some(70_000 + elapsed));
        assert_eq!(serde_json::to_value(summary).unwrap()["fresh_for_ms"], remaining);
    }
    // The wallet can expire first too; neither a hardcoded health bound nor
    // oldest-age/minimum-bound pairing gives the correct remaining lifetime.
    let old_wallet = RouteFreshness::assess(ReadRoute::PaymentsBalance, &RawRead::new(200, b"{}".to_vec())
        .marked(NodeMarks { as_of_ms: Some(wall - 170_000), stale: false })
        .stamped(Fetched { at: now, wall_ms: Some(wall) }));
    let summary = summarize(&[old_wallet, routes[2]], now);
    assert_eq!(serde_json::to_value(summary).unwrap()["fresh_for_ms"], 10_000);
}

#[test]
fn without_a_paired_read_token_nothing_is_read() {
    let server = TestServer::start(MockNode::canonical(), TOKEN);
    let base = server.api_base();
    let cases = [
        (NodeAuth::NotPaired, NoRead::NotPaired),
        (NodeAuth::Rc7Fallback, NoRead::Rc7Fallback),
        (paired(&["receive"]), NoRead::NotPaired),
    ];
    for (auth, reason) in cases {
        let got = read_topic(auth, &base, Arc::new(Quiet), Topic::Balance, None);
        assert_eq!(
            got,
            TopicRead::Unavailable {
                topic: Topic::Balance,
                reason
            }
        );
    }
    assert!(server.seen().is_empty(), "a read happened without a paired read token");
}

#[test]
fn a_refused_token_or_a_dead_node_is_unavailable() {
    let server = TestServer::start(MockNode::canonical(), "some-other-token");
    let got = read(&server, Topic::Balance);
    assert!(matches!(got, TopicRead::Unavailable { reason: NoRead::NotPaired, .. }), "{got:?}");

    let port = crate::jarvis::broker::test_server::closed_loopback_port();
    let got = read_topic(
        paired(&["read"]),
        &format!("http://127.0.0.1:{port}/api/v1"),
        Arc::new(Quiet),
        Topic::Node,
        None,
    );
    assert!(matches!(got, TopicRead::Unavailable { reason: NoRead::NodeUnreachable, .. }), "{got:?}");

    // A non-loopback base is refused before any socket opens.
    let got = read_topic(paired(&["read"]), &format!("{}://10.0.0.1:3141/api/v1", "http"), Arc::new(Quiet), Topic::Node, None);
    assert!(matches!(got, TopicRead::Unavailable { reason: NoRead::NodeUnreachable, .. }));
}

#[test]
fn no_canary_reaches_a_read_or_any_disclosure() {
    let server = TestServer::start(MockNode::canonical(), TOKEN);
    let shared = remote("https://models.example.org/v1/chat/completions");
    for topic in TOPICS {
        let got = read(&server, topic);
        let mut rendered = serde_json::to_string(&got).unwrap();
        for preset in PRESETS {
            rendered.push_str(&request_body(&shared, "what did I spend", &got, preset).unwrap());
        }
        for canary in CANARIES {
            assert!(!rendered.contains(canary), "{topic:?}: {canary}");
        }
    }
}

// ---- presets -------------------------------------------------------------------

fn sample_outputs() -> Vec<Value> {
    let server = TestServer::start(MockNode::canonical(), TOKEN);
    TOPICS
        .iter()
        .flat_map(|topic| outputs(&read(&server, *topic)).to_vec())
        .map(|output| serde_json::to_value(output).unwrap())
        .collect()
}

#[test]
fn exact_is_the_broker_output_unchanged() {
    for output in sample_outputs() {
        assert_eq!(narrow(&output, Preset::Exact), output);
    }
}

/// Counts ⊑ Rounded ⊑ Exact: narrowing twice lands on the narrower preset, and
/// each preset is idempotent. A widening step would break one of these.
#[test]
fn presets_form_a_chain_and_only_narrow() {
    for output in sample_outputs() {
        for a in PRESETS {
            let once = narrow(&output, a);
            assert_eq!(narrow(&once, a), once, "{a:?} is not idempotent");
            for b in PRESETS {
                let narrower = a.max(b);
                assert_eq!(
                    narrow(&narrow(&output, a), b),
                    narrow(&output, narrower),
                    "{a:?} then {b:?}"
                );
            }
        }
    }
}

#[test]
fn rounded_and_counts_withhold_every_id_and_counts_every_amount() {
    for output in sample_outputs() {
        let mut exact = Vec::new();
        leaves(&output, &mut exact);
        let exact_numbers: Vec<u64> = exact.iter().filter_map(Value::as_u64).filter(|n| *n > 999).collect();

        for preset in [Preset::Rounded, Preset::Counts] {
            let narrowed = narrow(&output, preset);
            let mut got = Vec::new();
            leaves(&narrowed, &mut got);
            for leaf in &got {
                if let Some(text) = leaf.as_str() {
                    assert!(!looks_like_id(text), "{preset:?} kept an id: {text}");
                }
            }
            if preset == Preset::Counts {
                // No amount or time survives; only small counts might coincide.
                let text = narrowed.to_string();
                assert!(!text.contains("\"available\",\"unit\":\"msat\""), "{text}");
                assert!(!text.contains("\"rounded\""), "{text}");
                assert!(!text.contains("at_ms\":1"), "{text}");
            }
        }
        // Rounded never shows a big msat figure verbatim.
        let rounded = narrow(&output, Preset::Rounded).to_string();
        for msat in exact_numbers.iter().filter(|n| **n >= 100_000) {
            let needle = format!("\"value\":{msat}");
            if output.to_string().contains(&format!("\"value\":{msat},\"unit\":\"msat\"")) {
                assert!(!rounded.contains(&needle), "rounded kept {msat} msat");
            }
        }
    }
}

#[test]
fn round_sats_keeps_two_significant_figures() {
    for (msat, sats) in [
        (0, 0),
        (499, 0),
        (1_000, 1),
        (7_000, 7),
        (99_000, 99),
        (123_000, 120),
        (482_500_000, 480_000),
        (52_500_000, 53_000),
        (999_999_000, 1_000_000),
    ] {
        assert_eq!(round_sats(msat), sats, "{msat}");
    }
}

#[test]
fn payments_counts_keeps_the_count_of_entries_only() {
    let server = TestServer::start(MockNode::canonical(), TOKEN);
    let value = serde_json::to_value(outputs(&read(&server, Topic::Payments))).unwrap();
    let entries = value[0]["report"]["value"]["entries"].as_array().unwrap().len();
    assert!(entries > 0);
    // Each output is narrowed on its own, as `request_body` does.
    let counts = narrow(&value[0], Preset::Counts);
    assert_eq!(counts["report"]["value"]["entries"], json!({ "withheld_items": entries }));
    assert_eq!(counts["report"]["value"]["sent_total"]["state"], "withheld");
    let rounded = narrow(&value[0], Preset::Rounded);
    let first = &rounded["report"]["value"]["entries"][0];
    assert_eq!(first["peer"], json!({"state": "withheld"}));
    assert_eq!(first["at_ms"].as_u64().unwrap() % 86_400_000, 0);
    assert_eq!(first["amount"]["state"], "rounded");
}

// ---- providers -----------------------------------------------------------------

#[test]
fn only_local_is_on_without_a_settings_file() {
    let (views, remotes) = providers(None);
    assert!(remotes.is_empty());
    assert_eq!(views.len(), 3);
    assert_eq!(views[0].kind, ProviderKind::Local);
    assert!(views[0].enabled);
    assert!(views[1..].iter().all(|view| !view.enabled && view.host.is_none()));
}

#[test]
fn a_remote_turns_on_only_when_enabled_with_https_and_a_variable_name() {
    let entry = |endpoint: &str, enabled: bool, key: Option<&str>| RemoteConfig {
        label: "Shared".into(),
        endpoint: endpoint.into(),
        model: "m".into(),
        key_env: key.map(str::to_string),
        enabled,
    };
    let on = |shared: RemoteConfig| {
        let file = ProvidersFile { shared: Some(shared), frontier: None };
        providers(Some(&file))
    };
    let (views, remotes) = on(entry("https://ai.example.org/v1/chat/completions", true, Some("BITSOV_SHARED_KEY")));
    assert!(views[1].enabled);
    assert_eq!(views[1].host.as_deref(), Some("ai.example.org"));
    assert_eq!(remotes.len(), 1);

    for (endpoint, enabled, key) in [
        ("https://ai.example.org/v1", false, None),
        ("http://ai.example.org/v1", true, None),
        ("https://user:pw@ai.example.org/v1", true, None),
        ("ftp://ai.example.org", true, None),
        ("https://ai.example.org/v1", true, Some("lower_case")),
        ("https://ai.example.org/v1", true, Some("A B")),
    ] {
        let (views, remotes) = on(entry(endpoint, enabled, key));
        assert!(!views[1].enabled, "{endpoint} {enabled} {key:?}");
        assert!(views[1].note.is_some());
        assert!(remotes.is_empty());
    }
    // A model server on this machine may be plain http.
    let (_, remotes) = on(entry("http://127.0.0.1:11434/v1/chat/completions", true, None));
    assert_eq!(remotes[0].host, "127.0.0.1");
}

#[test]
fn the_badge_says_who_is_paid_and_what_leaves() {
    let entry = |endpoint: &str, enabled: bool, key: Option<&str>| RemoteConfig {
        label: "Remote".into(),
        endpoint: endpoint.into(),
        model: "m".into(),
        key_env: key.map(str::to_string),
        enabled,
    };
    // Local, and remotes that are not set up: nobody is paid, nothing leaves.
    let (views, _) = providers(None);
    for view in &views {
        assert_eq!(view.pays, Pays { to: None, rail: PayRail::None }, "{:?}", view.kind);
        assert_eq!(view.data_leaves, None, "{:?}", view.kind);
    }

    let file = ProvidersFile {
        shared: Some(entry("http://127.0.0.1:11434/v1/chat/completions", true, None)),
        frontier: Some(entry("https://api.vendor.example/v1/chat/completions", true, Some("BITSOV_FRONTIER_KEY"))),
    };
    let (views, _) = providers(Some(&file));
    // A keyless model server: nobody is billed, but the preview still leaves the app.
    assert_eq!(views[1].kind, ProviderKind::Shared);
    assert_eq!(views[1].pays, Pays { to: None, rail: PayRail::None });
    assert_eq!(views[1].data_leaves, Some(Preset::Counts));
    // A keyed vendor: its host's operator bills the owner's own account.
    assert_eq!(views[2].kind, ProviderKind::Frontier);
    assert_eq!(
        views[2].pays,
        Pays { to: Some("api.vendor.example".into()), rail: PayRail::Fiat }
    );
    assert_eq!(views[2].data_leaves, Some(DEFAULT_PRESET));
    assert_eq!(DEFAULT_PRESET, Preset::Counts, "a preview starts at the narrowest preset");

    // Off in the file, or an address that is not allowed: nothing leaves, nobody paid.
    for (endpoint, enabled) in [
        ("https://api.vendor.example/v1", false),
        ("http://api.vendor.example/v1", true),
    ] {
        let file = ProvidersFile {
            shared: None,
            frontier: Some(entry(endpoint, enabled, Some("BITSOV_FRONTIER_KEY"))),
        };
        let (views, _) = providers(Some(&file));
        assert!(!views[2].enabled);
        assert_eq!(views[2].pays, Pays { to: None, rail: PayRail::None }, "{endpoint}");
        assert_eq!(views[2].data_leaves, None, "{endpoint}");
    }
}

#[test]
fn the_provider_view_carries_no_endpoint_path_key_or_spend() {
    let file = ProvidersFile {
        shared: Some(RemoteConfig {
            label: "Open".into(),
            endpoint: "https://open.example.org/secret/path/v1/chat/completions".into(),
            model: "open-8b".into(),
            key_env: Some("BITSOV_SHARED_KEY".into()),
            enabled: true,
        }),
        frontier: None,
    };
    let (views, _) = providers(Some(&file));
    let value = serde_json::to_value(&views).unwrap();
    let text = value.to_string();
    assert!(!text.contains("secret/path"), "{text}");
    assert!(!text.contains("BITSOV_SHARED_KEY"), "{text}");
    let keys: Vec<&str> = value[1].as_object().unwrap().keys().map(String::as_str).collect();
    let mut keys = keys;
    keys.sort_unstable();
    assert_eq!(
        keys,
        ["data_leaves", "enabled", "host", "kind", "label", "model", "note", "pays"]
    );
    assert_eq!(value[1]["pays"], json!({"to": "open.example.org", "rail": "fiat"}));
    assert_eq!(value[1]["data_leaves"], json!("counts"));
    assert_eq!(value[0]["pays"], json!({"to": null, "rail": "none"}));
    assert_eq!(value[0]["data_leaves"], Value::Null);
    // There is no rail by which the app, or any model, pays.
    assert!(!text.contains("spend"), "{text}");
}

#[test]
fn endpoint_hosts_are_parsed_strictly() {
    for (endpoint, host) in [
        ("https://ai.example.org/v1/chat", Some("ai.example.org")),
        ("https://AI.Example.org:8443/v1", Some("ai.example.org")),
        ("http://127.0.0.1:8080/v1", Some("127.0.0.1")),
        ("http://[::1]:8080/v1", Some("::1")),
        ("http://localhost:8080/v1", None),
        ("http://192.168.1.2/v1", None),
        ("https://", None),
        ("https://:443/v1", None),
        ("https://a.org:0/v1", None),
        ("https://a.org:x/v1", None),
        ("https://a.org /v1", None),
        ("https://u@a.org/v1", None),
        ("a.org/v1", None),
    ] {
        assert_eq!(endpoint_host(endpoint).as_deref(), host, "{endpoint}");
    }
}

#[test]
fn the_settings_file_rejects_unknown_fields() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ai-providers.json");
    std::fs::write(&path, r#"{"shared":{"label":"x","endpoint":"https://a.org","model":"m","api_key":"sk-..."}}"#).unwrap();
    assert!(load_providers_file(&path).is_none(), "a key inline in the file is refused");
    std::fs::write(&path, r#"{"shared":{"label":"x","endpoint":"https://a.org","model":"m","enabled":true}}"#).unwrap();
    assert!(load_providers_file(&path).unwrap().shared.unwrap().enabled);
    assert!(load_providers_file(&dir.path().join("missing.json")).is_none());
}

// ---- disclosure ----------------------------------------------------------------

#[test]
fn nothing_is_disclosed_about_a_node_the_app_cannot_read() {
    let shared = remote("https://a.org/v1");
    let none = TopicRead::Unavailable {
        topic: Topic::Balance,
        reason: NoRead::Rc7Fallback,
    };
    assert!(request_body(&shared, "q", &none, Preset::Exact).is_none());
}

#[test]
fn the_body_carries_the_question_the_preset_and_the_fixed_instructions() {
    let server = TestServer::start(MockNode::canonical(), TOKEN);
    let got = read(&server, Topic::Balance);
    let shared = remote("https://a.org/v1");
    let body: Value = serde_json::from_str(&request_body(&shared, "How much?", &got, Preset::Rounded).unwrap()).unwrap();
    assert_eq!(body["model"], "open-model-8b");
    assert_eq!(body["messages"][0]["content"], SYSTEM_PROMPT);
    let user: Value = serde_json::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap();
    assert_eq!(user["question"], "How much?");
    assert_eq!(user["shared"], "rounded");
    assert_eq!(user["topic"], "balance");
    assert_eq!(user["data"][0]["report"]["value"]["wallet_balance"]["state"], "rounded");
}

#[test]
fn questions_are_cleaned_and_capped() {
    assert_eq!(clean_question("  hi\u{0}there\n "), Some("hi there".into()));
    assert_eq!(clean_question(" \n\t "), None);
    assert_eq!(clean_question(&"x".repeat(900)).unwrap().chars().count(), MAX_QUESTION_CHARS);
}

#[test]
fn a_disclosure_is_single_use_and_expires() {
    let store = Disclosures::default();
    let shared = remote("https://a.org/v1");
    let now = Instant::now();
    let shown = store.hold(&shared, Preset::Counts, "BODY".into(), now).unwrap();
    assert_eq!(shown.body, "BODY");
    assert_eq!(shown.bytes, 4);
    assert_eq!(shown.id.len(), 32);
    let (to, body) = store.take(&shown.id, now).unwrap();
    assert_eq!((to.host.as_str(), body.as_str()), ("a.org", "BODY"));
    assert!(store.take(&shown.id, now).is_none(), "sent twice");

    let late = store.hold(&shared, Preset::Counts, "B".into(), now).unwrap();
    assert!(store.take(&late.id, now + DISCLOSURE_TTL).is_none(), "expired disclosure sent");

    let dropped = store.hold(&shared, Preset::Counts, "B".into(), now).unwrap();
    assert!(store.cancel(&dropped.id));
    assert!(store.take(&dropped.id, now).is_none());
    assert!(store.take("not-an-id", now).is_none());
}

#[test]
fn pending_disclosures_are_capped_oldest_first() {
    let store = Disclosures::default();
    let shared = remote("https://a.org/v1");
    let start = Instant::now();
    let ids: Vec<String> = (0..10)
        .map(|n| store.hold(&shared, Preset::Counts, n.to_string(), start + Duration::from_millis(n)).unwrap().id)
        .collect();
    let later = start + Duration::from_millis(20);
    assert!(store.take(&ids[0], later).is_none());
    assert!(store.take(&ids[1], later).is_none());
    assert_eq!(store.take(&ids[9], later).unwrap().1, "9");
}

// ---- remote send ---------------------------------------------------------------

/// One-shot loopback HTTP server. Captures the request, answers `reply`.
fn one_shot(status: &str, reply: &str) -> (String, mpsc::Receiver<(String, Vec<u8>)>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = mpsc::channel();
    let (status, reply) = (status.to_string(), reply.to_string());
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        let (head, body) = loop {
            let n = stream.read(&mut chunk).unwrap();
            buf.extend_from_slice(&chunk[..n]);
            if let Some(split) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&buf[..split]).to_string();
                let length: usize = head
                    .lines()
                    .find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap()))
                    .unwrap_or(0);
                while buf.len() < split + 4 + length {
                    let n = stream.read(&mut chunk).unwrap();
                    buf.extend_from_slice(&chunk[..n]);
                }
                break (head, buf[split + 4..split + 4 + length].to_vec());
            }
        };
        let response = format!(
            "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nlocation: https://evil.example/\r\nconnection: close\r\n\r\n{reply}",
            reply.len()
        );
        stream.write_all(response.as_bytes()).unwrap();
        tx.send((head, body)).unwrap();
    });
    (format!("http://127.0.0.1:{port}/v1/chat/completions"), rx)
}

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(future)
}

#[test]
fn the_send_carries_exactly_the_disclosed_bytes_and_the_key() {
    let reply = json!({"choices": [{"message": {"content": "You spent 3 sats.\u{7}\nThat is all."}}]}).to_string();
    let (endpoint, seen) = one_shot("200 OK", &reply);
    let shared = remote(&endpoint);
    let store = Disclosures::default();
    let body = "{\"exact\": \"bytes\", \"ü\": 1}".to_string();
    let shown = store.hold(&shared, Preset::Counts, body.clone(), Instant::now()).unwrap();
    let (to, stored) = store.take(&shown.id, Instant::now()).unwrap();
    let answer = block_on(send(&to, stored, Some("sk-test".into()))).unwrap();
    assert_eq!(answer.text, "You spent 3 sats.\nThat is all.");
    assert_eq!(answer.sent_bytes, shown.bytes);
    let (head, got) = seen.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(got, shown.body.as_bytes());
    assert!(head.starts_with("POST /v1/chat/completions HTTP/1.1"), "{head}");
    assert!(head.to_ascii_lowercase().contains("authorization: bearer sk-test"));
}

#[test]
fn a_refusal_or_redirect_is_an_error_that_quotes_nothing() {
    let (endpoint, _seen) = one_shot("500 Internal Server Error", "{\"error\":\"SECRET_BODY_TEXT\"}");
    let err = block_on(send(&remote(&endpoint), "{}".into(), None)).unwrap_err();
    assert!(err.contains("http 500") && !err.contains("SECRET_BODY_TEXT"), "{err}");

    let (endpoint, _seen) = one_shot("302 Found", "");
    let err = block_on(send(&remote(&endpoint), "{}".into(), None)).unwrap_err();
    assert!(err.contains("http 302"), "{err}");
}

/// Keep the response unfinished until the caller releases it. A size rejection
/// must arrive without waiting for EOF or the provider's final chunk.
fn unfinished_response(headers: &str, body: Vec<u8>) -> (String, mpsc::Sender<()>, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let endpoint = format!("http://{}/v1/chat/completions", listener.local_addr().unwrap());
    let headers = headers.to_string();
    let (release, wait) = mpsc::channel();
    let thread = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        stream.set_write_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut request = Vec::new();
        let mut chunk = [0; 4096];
        while !request.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = stream.read(&mut chunk).unwrap();
            assert_ne!(n, 0);
            request.extend_from_slice(&chunk[..n]);
        }
        stream.write_all(format!("HTTP/1.1 200 OK\r\n{headers}\r\n\r\n").as_bytes()).unwrap();
        // An early header-based refusal is allowed to close before body writes.
        let _ = stream.write_all(&body);
        let _ = wait.recv_timeout(Duration::from_secs(5));
    });
    (endpoint, release, thread)
}

#[test]
fn remote_response_rejects_oversized_content_length_before_waiting_for_body() {
    let (endpoint, release, thread) = unfinished_response(
        &format!("Content-Length: {}", MAX_REMOTE_BYTES + 1), Vec::new(),
    );
    let result = block_on(async {
        tokio::time::timeout(Duration::from_secs(3), send(&remote(&endpoint), "{}".into(), None)).await
    });
    let _ = release.send(());
    thread.join().unwrap();
    let error = result.expect("must reject the headers without waiting for body/EOF").unwrap_err();
    assert!(error.contains("answer was too large"), "{error}");
}

#[test]
fn remote_response_caps_chunked_bytes_before_eof_or_json_parsing() {
    let mut body = Vec::new();
    // Each chunk fits the cap; only their cumulative length exceeds it.
    for size in [MAX_REMOTE_BYTES / 2, MAX_REMOTE_BYTES / 2, 1] {
        body.extend_from_slice(format!("{size:x}\r\n").as_bytes());
        body.extend(std::iter::repeat_n(b'x', size));
        body.extend_from_slice(b"\r\n");
    }
    let (endpoint, release, thread) = unfinished_response("Transfer-Encoding: chunked", body);
    let result = block_on(async {
        tokio::time::timeout(Duration::from_secs(3), send(&remote(&endpoint), "{}".into(), None)).await
    });
    let _ = release.send(());
    thread.join().unwrap();
    let error = result.expect("must reject while the response is still unfinished").unwrap_err();
    assert!(error.contains("answer was too large"), "{error}");
}

#[test]
fn remote_response_accepts_valid_json_up_to_the_byte_limit() {
    for size in [MAX_REMOTE_BYTES - 1, MAX_REMOTE_BYTES] {
        let mut body = json!({"choices": [{"message": {"content": "Within the limit."}}]}).to_string();
        body.extend(std::iter::repeat_n(' ', size - body.len()));
        let (endpoint, _seen) = one_shot("200 OK", &body);
        let answer = block_on(send(&remote(&endpoint), "{}".into(), None)).unwrap();
        assert_eq!(answer.text, "Within the limit.");
    }
}

#[test]
fn answer_text_takes_the_first_choice_and_caps_it() {
    let long = "a".repeat(MAX_ANSWER_CHARS + 50);
    let body = json!({"choices": [{"message": {"content": long}}, {"message": {"content": "second"}}]});
    assert_eq!(answer_text(body.to_string().as_bytes()).unwrap().len(), MAX_ANSWER_CHARS);
    assert!(answer_text(b"{\"choices\":[]}").is_none());
    assert!(answer_text(b"not json").is_none());
    assert!(answer_text(json!({"choices": [{"message": {"content": "  "}}]}).to_string().as_bytes()).is_none());
}
