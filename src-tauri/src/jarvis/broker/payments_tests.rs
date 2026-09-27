//! The `payments` tool: the contact list, then each contact's thread.
//!
//! Labels, addresses, message bodies, ciphertext and hashes sit in the bodies
//! these routes return. Only time, side, amount and a checked node id may
//! come out.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use mock_node::{MockNode, CANARIES, NODE_ID, SENDER_A, SENDER_B};
use serde_json::json;

use super::route::{self, PeerKey, ReadRoute};
use super::schema::{
    Amount, CopiedId, Direction, PaymentsInput, Report, ToolCall, ToolOutput, UnavailableReason,
    MAX_PAYMENT_ENTRIES, MAX_PAYMENT_PEERS, PAYMENT_THREAD_LIMIT,
};
use super::test_server::TestServer;
use super::{AuditSink, BearerToken, Broker, LocalNodeRead, NodeRead, RawRead, ReadFault};

const TOKEN: &str = "payments-test-token";
const CANARY: &str = "CANARY_PAY_77c1";

struct Quiet;
impl AuditSink for Quiet {
    fn record(&self, _line: &str) {}
}

/// Answers by full request target (path and query), so each thread differs.
struct Threads {
    by_uri: HashMap<String, (u16, String)>,
    seen: Mutex<Vec<String>>,
}

impl Threads {
    fn new() -> Self {
        Self {
            by_uri: HashMap::new(),
            seen: Mutex::new(Vec::new()),
        }
    }

    fn at(mut self, uri: String, status: u16, body: String) -> Self {
        self.by_uri.insert(uri, (status, body));
        self
    }
}

impl NodeRead for Threads {
    fn read(&self, route: ReadRoute) -> Result<RawRead, ReadFault> {
        let uri = route.target().uri();
        self.seen.lock().unwrap().push(uri.clone());
        match self.by_uri.get(&uri) {
            Some((status, body)) => Ok(RawRead::new(*status, body.clone().into_bytes())),
            None => Err(ReadFault::Transport),
        }
    }
}

fn thread_uri(peer: &str) -> String {
    format!("/api/v1/messages?peer={peer}&limit={PAYMENT_THREAD_LIMIT}")
}

fn call(since_ms: Option<u64>) -> ToolCall {
    ToolCall::Payments {
        input: PaymentsInput { since_ms },
    }
}

fn report(node: &impl NodeRead, since_ms: Option<u64>) -> Report<super::PaymentsReport> {
    let done = Broker::new().unwrap().dispatch(node, call(since_ms)).unwrap();
    match done.output().clone() {
        ToolOutput::Payments { report } => report,
        other => panic!("not payments: {other:?}"),
    }
}

fn value(amount: &Amount<u64>) -> Option<u64> {
    match amount {
        Amount::Available { value, .. } => Some(*value),
        Amount::Unavailable { .. } => None,
    }
}

fn message(sender: &str, recipient: &str, at: u64, msat: Option<u64>) -> serde_json::Value {
    json!({
        "id": format!("{at:064x}"),
        "kind": 0,
        "sender": sender,
        "recipient": recipient,
        "timestamp": at,
        "ciphertext": CANARY,
        "payment_amount_msat": msat,
        "payment_hash": CANARY,
        "plaintext": CANARY,
        "references": [CANARY],
    })
}

fn peers(ids: &[&str]) -> String {
    json!(ids
        .iter()
        .map(|id| json!({"node_id": id, "label": CANARY, "addr": CANARY, "connected": true, "fingerprint": CANARY}))
        .collect::<Vec<_>>())
    .to_string()
}

#[test]
fn peer_keys_are_exactly_64_hex_and_written_back_lowercase() {
    let upper = "AB".repeat(32);
    assert_eq!(PeerKey::parse(&upper).unwrap().hex(), "ab".repeat(32));
    for bad in [
        "".to_string(),
        "a".repeat(63),
        "a".repeat(65),
        format!("{}g", "a".repeat(63)),
        format!("{}&limit=9", "a".repeat(55)),
        format!("../{}", "a".repeat(61)),
        format!("{} ", "a".repeat(63)),
        "é".repeat(32),
    ] {
        assert!(PeerKey::parse(&bad).is_none(), "{bad:?}");
    }
    // Debug shows a prefix only.
    let key = PeerKey::parse(&"cd".repeat(32)).unwrap();
    assert_eq!(format!("{key:?}"), "PeerKey(cdcd..)");
}

#[test]
fn a_peer_thread_is_written_peer_then_limit() {
    let key = PeerKey::parse(&"0f".repeat(32)).unwrap();
    let target = ReadRoute::PeerMessages { peer: key, limit: 7 }.target();
    assert_eq!(target.uri(), format!("/api/v1/messages?peer={}&limit=7", "0f".repeat(32)));
    assert_eq!(ReadRoute::Peers.target().uri(), route::PEERS);
    assert_eq!(ReadRoute::Messages { limit: 3 }.target().uri(), "/api/v1/messages?limit=3");
}

#[test]
fn sent_and_received_come_out_with_amounts_and_nothing_else() {
    let a = "aa".repeat(32);
    let b = "bb".repeat(32);
    let own = "11".repeat(32);
    let node = Threads::new()
        .at(route::PEERS.into(), 200, peers(&[&a, &b]))
        .at(
            thread_uri(&a),
            200,
            json!([
                message(&a, &own, 5_000, Some(2_000)),
                message(&own, &a, 4_000, Some(2_000)),
                message(&own, &a, 3_000, Some(0)),
                message(&own, &a, 2_500, None),
            ])
            .to_string(),
        )
        .at(
            thread_uri(&b),
            200,
            json!([message(&own, &b, 6_000, Some(1_000))]).to_string(),
        );
    let Report::Ready { value: done } = report(&node, None) else {
        panic!("unavailable")
    };
    let sides: Vec<(u64, Direction, Option<u64>)> = done
        .entries
        .iter()
        .map(|entry| (entry.at_ms, entry.direction, value(&entry.amount)))
        .collect();
    // Newest first; unpaid messages skipped.
    assert_eq!(
        sides,
        vec![
            (6_000, Direction::Sent, Some(1_000)),
            (5_000, Direction::Received, Some(2_000)),
            (4_000, Direction::Sent, Some(2_000)),
        ]
    );
    assert_eq!(done.entries[0].peer, CopiedId::Value { value: b.clone() });
    assert_eq!(value(&done.sent_total), Some(3_000));
    assert_eq!(value(&done.received_total), Some(2_000));
    assert_eq!(value(&done.peers_read), Some(2));
    assert_eq!(value(&done.peers_unread), Some(0));
    assert_eq!(value(&done.partial_threads), Some(0));

    let rendered = serde_json::to_string(&done).unwrap();
    assert!(!rendered.contains(CANARY), "{rendered}");
    for key in ["plaintext", "ciphertext", "payment_hash", "label", "addr", "\"kind\"", "\"id\""] {
        assert!(!rendered.contains(key), "{key} in {rendered}");
    }
}

#[test]
fn since_filters_locally_and_totals_follow_the_filter() {
    let a = "aa".repeat(32);
    let own = "11".repeat(32);
    let node = Threads::new().at(route::PEERS.into(), 200, peers(&[&a])).at(
        thread_uri(&a),
        200,
        json!([
            message(&own, &a, 9_000, Some(2_000)),
            message(&own, &a, 1_000, Some(5_000)),
        ])
        .to_string(),
    );
    let Report::Ready { value: done } = report(&node, Some(5_000)) else {
        panic!()
    };
    assert_eq!(done.entries.len(), 1);
    assert_eq!(value(&done.sent_total), Some(2_000));
}

#[test]
fn a_thread_that_fails_is_counted_unread_and_the_rest_still_report() {
    let a = "aa".repeat(32);
    let b = "bb".repeat(32);
    let own = "11".repeat(32);
    let node = Threads::new()
        .at(route::PEERS.into(), 200, peers(&[&a, &b, "not-a-node-id"]))
        .at(thread_uri(&a), 500, json!({"error": CANARY}).to_string())
        .at(
            thread_uri(&b),
            200,
            json!([message(&own, &b, 1, Some(1_000))]).to_string(),
        );
    let Report::Ready { value: done } = report(&node, None) else {
        panic!()
    };
    assert_eq!(value(&done.peers_read), Some(1));
    // One failed thread, one invalid id.
    assert_eq!(value(&done.peers_unread), Some(2));
    assert_eq!(value(&done.sent_total), Some(1_000));
}

#[test]
fn no_contact_list_means_no_report_and_no_thread_reads() {
    let node = Threads::new().at(route::PEERS.into(), 503, CANARY.into());
    assert_eq!(
        report(&node, None),
        Report::Unavailable {
            reason: UnavailableReason::UpstreamError
        }
    );
    assert_eq!(*node.seen.lock().unwrap(), vec![route::PEERS.to_string()]);
}

#[test]
fn contacts_and_entries_are_capped_and_the_rest_counted() {
    let own = "11".repeat(32);
    let ids: Vec<String> = (0..MAX_PAYMENT_PEERS + 3).map(|n| format!("{:064x}", n + 1)).collect();
    let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    let mut node = Threads::new().at(route::PEERS.into(), 200, peers(&refs));
    for (n, id) in ids.iter().enumerate() {
        let thread: Vec<_> = (0..5)
            .map(|k| message(&own, id, (n * 10 + k) as u64, Some(1_000)))
            .collect();
        node = node.at(thread_uri(id), 200, json!(thread).to_string());
    }
    let Report::Ready { value: done } = report(&node, None) else {
        panic!()
    };
    assert_eq!(value(&done.peers_read), Some(MAX_PAYMENT_PEERS as u64));
    assert_eq!(value(&done.peers_unread), Some(3));
    assert_eq!(done.entries.len(), MAX_PAYMENT_ENTRIES);
    let listed_and_not = MAX_PAYMENT_ENTRIES as u64 + value(&done.unlisted).unwrap();
    assert_eq!(listed_and_not, MAX_PAYMENT_PEERS as u64 * 5);
    // Totals cover every read entry, listed or not.
    assert_eq!(value(&done.sent_total), Some(listed_and_not * 1_000));
    // Only the capped peers' threads were requested.
    assert_eq!(node.seen.lock().unwrap().len(), 1 + MAX_PAYMENT_PEERS);
}

#[test]
fn a_full_page_is_flagged_partial() {
    let a = "aa".repeat(32);
    let own = "11".repeat(32);
    let page: Vec<_> = (0..PAYMENT_THREAD_LIMIT)
        .map(|n| message(&own, &a, u64::from(n), Some(1_000)))
        .collect();
    let node = Threads::new()
        .at(route::PEERS.into(), 200, peers(&[&a]))
        .at(thread_uri(&a), 200, json!(page).to_string());
    let Report::Ready { value: done } = report(&node, None) else {
        panic!()
    };
    assert_eq!(value(&done.partial_threads), Some(1));
}

/// Over a real loopback socket against the mock node: canaries in labels,
/// bodies, ciphertext and memos never come out, and every request is one the
/// gate admits.
#[test]
fn over_loopback_the_mock_node_leaks_no_canary() {
    let server = TestServer::start(MockNode::canonical(), TOKEN);
    let read = LocalNodeRead::new(
        &server.api_base(),
        BearerToken::new(TOKEN.into()).unwrap(),
        Arc::new(Quiet),
    )
    .unwrap();
    let done = Broker::new().unwrap().dispatch(&read, call(None)).unwrap();
    let rendered = format!("{:?}\n{}", done, serde_json::to_string(done.output()).unwrap());
    for canary in CANARIES {
        assert!(!rendered.contains(canary), "{canary} leaked: {rendered}");
    }
    let ToolOutput::Payments {
        report: Report::Ready { value: report },
    } = done.output()
    else {
        panic!("payments unavailable: {rendered}")
    };
    assert!(report.entries.iter().any(|e| e.direction == Direction::Sent));
    assert!(report.entries.iter().any(|e| e.direction == Direction::Received));
    for entry in &report.entries {
        let CopiedId::Value { value } = &entry.peer else {
            panic!()
        };
        assert!(value == SENDER_A || value == SENDER_B || PeerKey::parse(value).is_some());
        assert_ne!(value, NODE_ID);
    }
    let seen = server.seen();
    assert_eq!(seen[0].target, route::PEERS);
    for request in &seen[1..] {
        assert_eq!(request.method, "GET");
        assert!(
            request.target.starts_with("/api/v1/messages?peer=")
                && request.target.ends_with(&format!("&limit={PAYMENT_THREAD_LIMIT}")),
            "{}",
            request.target
        );
    }
}
