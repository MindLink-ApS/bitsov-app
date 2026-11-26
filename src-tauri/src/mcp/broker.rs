//! MCP phase 1, slice 3: the read broker behind the session layer.
//!
//! **Not wired.** Turns one topic read from the assistant's existing closed
//! broker ([`crate::ai::read_topic`]: the allowlisted node routes, the paired
//! `read` token, the host's audit) into what an MCP client may see:
//! - every output narrowed with the assistant's own [`narrow`], **counts by
//!   default**, so amounts, times and ids stay home unless the owner widens it;
//! - the read's freshness (state, age, whether the node itself said stale);
//! - nothing else: no route lines, no node error, no token.
//!
//! **Channels are a phone book** when the client has [`Handles`] (owner GO,
//! 26 Nov): one entry per peer, a masked handle and `active` or `inactive`.
//! No size, amount, channel id or peer key, and no count beyond the list's
//! length. Without handles, channels are counts only, as every other topic.
//!
//! A topic that is not read live (not paired, rc7 fallback, node unreachable)
//! is a [`ReadFailed`] with no detail. The source of reads is a function, so
//! this module opens nothing itself and holds no token; whoever wires it binds
//! the function to the paired session. It compiles only where its parent does
//! (`cfg(test)` or the off-by-default `mcp-grant` feature).

use std::collections::BTreeMap;

use serde_json::{json, Value};

use super::handles::Handles;
use super::server::{ReadFailed, Reads};
use super::store::{mcp_topic_allowed, R2Preset};
use crate::ai::{narrow, Preset, Topic, TopicRead};
use crate::jarvis::broker::{ChannelPeer, Report, ToolOutput};

/// What MCP clients get unless the owner chooses otherwise.
pub const DEFAULT_PRESET: R2Preset = R2Preset::Counts;

/// The read broker for one client: a topic source and how far to narrow.
pub struct BrokerReads<F>
where
    F: Fn(Topic, Option<u64>) -> TopicRead,
{
    read: F,
    preset: Preset,
    handles: Option<Handles>,
}

impl<F> BrokerReads<F>
where
    F: Fn(Topic, Option<u64>) -> TopicRead,
{
    /// Narrowed to [`DEFAULT_PRESET`] (counts).
    pub fn new(read: F) -> Self {
        Self::with_preset(read, DEFAULT_PRESET)
    }

    /// Narrowed to `preset`, as the owner set it for this client: counts or
    /// rounded, never exact.
    pub fn with_preset(read: F, preset: R2Preset) -> Self {
        Self { read, preset: preset.preset(), handles: None }
    }

    /// Channels as a phone book of this client's handles.
    pub fn with_handles(mut self, handles: Option<Handles>) -> Self {
        self.handles = handles;
        self
    }
}

/// The phone-book view of a channel read: one entry per peer, sorted by
/// handle, `active` when any channel with that peer is. A channel whose peer
/// key did not pass its check is left out. `None` unless the read is one
/// ready channel report.
fn phonebook(outputs: &[ToolOutput], handles: &Handles) -> Option<Value> {
    let [ToolOutput::Channels { report: Report::Ready { value } }] = outputs else { return None };
    Some(contacts(value.channels.iter().map(|channel| (channel.peer.as_ref(), channel.active)), handles))
}

fn contacts<'a>(channels: impl Iterator<Item = (Option<&'a ChannelPeer>, bool)>, handles: &Handles) -> Value {
    let mut peers: BTreeMap<String, bool> = BTreeMap::new();
    for (peer, active) in channels {
        if let Some(peer) = peer {
            *peers.entry(handles.handle(peer.as_str())).or_default() |= active;
        }
    }
    let contacts: Vec<Value> = peers
        .into_iter()
        .map(|(handle, active)| json!({"handle": handle, "state": if active { "active" } else { "inactive" }}))
        .collect();
    json!({ "contacts": contacts })
}

impl<F> Reads for BrokerReads<F>
where
    F: Fn(Topic, Option<u64>) -> TopicRead,
{
    fn read(&self, topic: Topic, since_ms: Option<u64>) -> Result<Value, ReadFailed> {
        // Never read for an MCP client, whatever asked (owner GO, 26 Nov).
        if !mcp_topic_allowed(topic) {
            return Err(ReadFailed);
        }
        match (self.read)(topic, since_ms) {
            TopicRead::Live { topic: got, outputs, freshness, .. } if got == topic => {
                let book = match (&self.handles, topic) {
                    (Some(handles), Topic::Channels) => phonebook(&outputs, handles),
                    _ => None,
                };
                let data: Vec<Value> = match book {
                    Some(book) => vec![book],
                    // Counts only: a channel list becomes its length, with no ids and no amounts.
                    None => outputs
                        .iter()
                        .map(|output| serde_json::to_value(output).map(|value| narrow(&value, self.preset)))
                        .collect::<Result<_, _>>()
                        .map_err(|_| ReadFailed)?,
                };
                Ok(json!({
                    "shared": self.preset,
                    "freshness": {
                        "state": freshness.state,
                        "age_seconds": freshness.age_ms.map(|ms| ms / 1000),
                        "node_stale": freshness.node_stale,
                    },
                    "data": data,
                }))
            }
            // Not live, or an answer for another topic: nothing is passed on.
            _ => Err(ReadFailed),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::sync::Arc;

    use mock_node::{balance_msat, MockNode, CANARIES, SENDER_A};
    use serde_json::json;

    use super::*;
    use crate::ai::{read_topic, Freshness, NoRead};
    use crate::jarvis::assistant_source::NodeAuth;
    use crate::jarvis::broker::test_server::TestServer;
    use crate::jarvis::broker::{AuditSink, BearerToken};
    use crate::mcp::session::{Outcome, Registry, Sessions};

    const TOKEN: &str = "mcp-broker-test-token";
    const ALL: [Topic; 6] = [Topic::Node, Topic::Channels, Topic::Prices, Topic::Balance, Topic::Payments, Topic::Inbox];
    const TOOLS: [&str; 4] = ["read_node", "read_channels", "read_prices", "read_inbox_counts"];

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

    /// A fake MCP client: one tools/call through the session, the skeleton and the broker.
    fn ask(sessions: &mut Sessions, registry: &Registry, reads: &dyn Reads, audit: &mut Vec<crate::mcp::session::AuditRow>, tool: &str) -> Value {
        let frame = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":tool}}).to_string();
        let reply = sessions.handle("desk", frame.as_bytes(), 0, registry, reads, audit).expect("a reply");
        serde_json::from_slice(&reply).unwrap()
    }

    fn data(reply: &Value) -> Value {
        assert_eq!(reply["result"]["isError"], false, "{reply}");
        let wrapped: Value = serde_json::from_str(reply["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(wrapped["trust"], "untrusted_data");
        wrapped["data"].clone()
    }

    #[test]
    fn every_tool_reads_the_node_through_the_closed_broker_as_counts_by_default() {
        let server = TestServer::start(MockNode::canonical(), TOKEN);
        let base = server.api_base();
        let reads = BrokerReads::new(|topic, since| read_topic(paired(&["read"]), &base, Arc::new(Quiet), topic, since));
        let mut registry = Registry::default();
        registry.add("desk", "Desk assistant", &ALL);
        let (mut sessions, mut audit) = (Sessions::default(), Vec::new());
        let balance = balance_msat().to_string();
        let balance_sats = (balance_msat() / 1000).to_string();
        for tool in TOOLS {
            let reply = ask(&mut sessions, &registry, &reads, &mut audit, tool);
            let data = data(&reply);
            assert_eq!(data["shared"], "counts", "{tool}");
            assert!(!data["data"].as_array().unwrap().is_empty(), "{tool}");
            assert!(data["freshness"]["state"].is_string(), "{tool}");
            let text = reply.to_string();
            // Counts keep no amount, id or message text from the node.
            assert!(!text.contains(&balance) && !text.contains(&balance_sats), "{tool} leaked the balance");
            assert!(!text.contains(SENDER_A), "{tool} leaked a node id");
            for canary in CANARIES {
                assert!(!text.contains(canary), "{tool} leaked {canary}");
            }
            assert!(!text.contains(TOKEN), "{tool} leaked the token");
            assert!(!text.contains("GET /api"), "{tool} leaked route lines");
        }
        assert_eq!(audit.len(), TOOLS.len());
        assert!(audit.iter().all(|row| row.outcome == Outcome::Read));
    }

    /// Every key anywhere in `value`.
    fn keys(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::Array(items) => items.iter().for_each(|item| keys(item, out)),
            Value::Object(map) => map.iter().for_each(|(key, inner)| {
                out.push(key.clone());
                keys(inner, out);
            }),
            _ => {}
        }
    }

    #[test]
    fn balance_and_payments_are_never_read_and_channels_are_counts_with_no_amount_or_id() {
        let server = TestServer::start(MockNode::canonical(), TOKEN);
        let base = server.api_base();
        let read_count = std::cell::Cell::new(0);
        let reads = BrokerReads::new(|topic, since| {
            read_count.set(read_count.get() + 1);
            read_topic(paired(&["read"]), &base, Arc::new(Quiet), topic, since)
        });
        // Even a registry that lists every topic gets no balance or payments.
        let mut registry = Registry::default();
        registry.add("desk", "Desk assistant", &ALL);
        let (mut sessions, mut audit) = (Sessions::default(), Vec::new());
        for tool in ["read_balance", "read_payments"] {
            assert_eq!(ask(&mut sessions, &registry, &reads, &mut audit, tool)["error"]["message"], "unknown tool", "{tool}");
        }
        assert_eq!(read_count.get(), 0, "the node was not asked");
        for topic in [Topic::Balance, Topic::Payments] {
            assert_eq!(reads.read(topic, None), Err(ReadFailed), "{topic:?}");
        }
        assert_eq!(read_count.get(), 0, "refused before any read");

        // A channel read: the list is only its length; no amount and no id survives.
        let reply = ask(&mut sessions, &registry, &reads, &mut audit, "read_channels");
        let data = data(&reply);
        assert_eq!(data["shared"], "counts");
        let report = &data["data"][0]["report"]["value"];
        assert!(report["channels"]["withheld_items"].as_u64().is_some(), "{report}");
        let mut found = Vec::new();
        keys(&data, &mut found);
        for field in ["capacity", "local_balance", "remote_balance", "channel_id", "short_channel_id", "sats"] {
            assert!(!found.iter().any(|key| key == field), "the channel read has a {field:?} field: {data}");
        }
        // Every figure left is a count.
        let mut units = Vec::new();
        fn unit_of(value: &Value, out: &mut Vec<String>) {
            match value {
                Value::Array(items) => items.iter().for_each(|item| unit_of(item, out)),
                Value::Object(map) => {
                    if let Some(unit) = map.get("unit").and_then(Value::as_str) {
                        out.push(unit.to_owned());
                    }
                    map.values().for_each(|inner| unit_of(inner, out));
                }
                _ => {}
            }
        }
        unit_of(&data, &mut units);
        assert!(!units.is_empty() && units.iter().all(|unit| unit == "count"), "{units:?}");
        let text = reply.to_string();
        assert!(!text.contains(r#""msat""#), "no amount in msat: {text}");
        assert!(!text.contains(&balance_msat().to_string()), "the balance figure stays home");
    }

    fn desk_handles() -> Handles {
        Handles::new(Arc::new(crate::mcp::handles::HandleKey::from_bytes([5; 32])), "mcp-01", 1)
    }

    #[test]
    fn channels_read_as_a_phone_book_of_handles_with_no_size_amount_or_id() {
        use mock_node::{COUNTERPARTY_01, COUNTERPARTY_02, COUNTERPARTY_03, LIGHTNING_NODE_PUBKEY, NODE_ID};
        let server = TestServer::start(MockNode::canonical(), TOKEN);
        let base = server.api_base();
        let handles = desk_handles();
        let reads = BrokerReads::new(|topic, since| read_topic(paired(&["read"]), &base, Arc::new(Quiet), topic, since))
            .with_handles(Some(handles.clone()));
        let mut registry = Registry::default();
        registry.add("desk", "Desk assistant", &ALL);
        let (mut sessions, mut audit) = (Sessions::default(), Vec::new());
        let reply = ask(&mut sessions, &registry, &reads, &mut audit, "read_channels");
        let data = data(&reply);
        // The mock node has three channels with three peers: two active, one not.
        let mut expected = vec![
            (handles.handle(COUNTERPARTY_01), "active"),
            (handles.handle(COUNTERPARTY_02), "active"),
            (handles.handle(COUNTERPARTY_03), "inactive"),
        ];
        expected.sort();
        let got: Vec<(String, &str)> = data["data"][0]["contacts"].as_array().unwrap().iter()
            .map(|c| (c["handle"].as_str().unwrap().to_owned(), c["state"].as_str().unwrap()))
            .collect();
        let expected: Vec<(String, &str)> = expected.into_iter().collect();
        assert_eq!(got, expected, "{data}");
        assert_eq!(data["data"].as_array().unwrap().len(), 1);
        assert_eq!(data["shared"], "counts");

        // Only these keys, anywhere: no size, amount, id or peer field.
        let mut found = Vec::new();
        keys(&data, &mut found);
        found.sort();
        found.dedup();
        let allowed = ["age_seconds", "contacts", "data", "freshness", "handle", "node_stale", "shared", "state"];
        assert!(found.iter().all(|key| allowed.contains(&key.as_str())), "unexpected keys {found:?}");
        for field in ["peer", "peer_id", "peer_pubkey", "remote_pubkey", "pubkey", "node_id", "alias", "counterparty",
            "capacity", "local_balance", "remote_balance", "channel_id", "short_channel_id", "sats", "msat", "value", "count"] {
            assert!(!found.iter().any(|key| key == field), "the phone book has a {field:?} field: {data}");
        }
        // No figure or identifier from the node, in any form.
        let text = reply.to_string();
        for peer in [COUNTERPARTY_01, COUNTERPARTY_02, COUNTERPARTY_03, LIGHTNING_NODE_PUBKEY, NODE_ID, SENDER_A] {
            assert!(!text.to_ascii_lowercase().contains(&peer.to_ascii_lowercase()), "a peer or node id leaked");
            assert!(!text.contains(&peer[..16]), "part of a peer or node id leaked");
        }
        for figure in [500_000u64, 1_250_000, 80_000, 200_000, 750_000, 20_000, 700_000, 2_000_000, 100_000, 500, 1_250, 80, 200, 750, 20, 700, 2_000, 100] {
            assert!(!text.contains(&format!(":{figure}")) && !text.contains(&format!("\"{figure}\"")), "the figure {figure} leaked: {text}");
        }
        for id in ["UserChannelId", "860123x1x0", "860123x2x0"] {
            assert!(!text.contains(id), "{id} leaked");
        }
        assert!(!text.contains(&balance_msat().to_string()));
        for canary in CANARIES {
            assert!(!text.contains(canary), "{canary} leaked");
        }
        // The same read again gives the same handles.
        assert_eq!(data["data"], self::data(&ask(&mut sessions, &registry, &reads, &mut audit, "read_channels"))["data"]);
    }

    #[test]
    fn two_apps_see_different_handles_for_the_same_peers() {
        let server = TestServer::start(MockNode::canonical(), TOKEN);
        let base = server.api_base();
        let book = |handles: Handles| {
            let reads = BrokerReads::new(|topic, since| read_topic(paired(&["read"]), &base, Arc::new(Quiet), topic, since))
                .with_handles(Some(handles));
            reads.read(Topic::Channels, None).unwrap()["data"][0]["contacts"].clone()
        };
        let desk = book(desk_handles());
        let other = book(Handles::new(Arc::new(crate::mcp::handles::HandleKey::from_bytes([5; 32])), "mcp-02", 1));
        assert_eq!(desk.as_array().unwrap().len(), 3);
        let handles_of = |list: &Value| list.as_array().unwrap().iter().map(|c| c["handle"].clone()).collect::<Vec<_>>();
        assert!(handles_of(&desk).iter().all(|h| !handles_of(&other).contains(h)));
    }

    #[test]
    fn several_channels_to_one_peer_are_one_entry_active_when_any_is() {
        use crate::jarvis::broker::ChannelPeer;
        let handles = desk_handles();
        let a = ChannelPeer::parse(&"02".repeat(33)).unwrap();
        let b = ChannelPeer::parse(&"03".repeat(33)).unwrap();
        let book = contacts([(Some(&a), false), (Some(&b), false), (Some(&a), true), (None, true)].into_iter(), &handles);
        let mut expected = vec![(handles.handle(a.as_str()), "active"), (handles.handle(b.as_str()), "inactive")];
        expected.sort();
        let got: Vec<(String, String)> = book["contacts"].as_array().unwrap().iter()
            .map(|c| (c["handle"].as_str().unwrap().to_owned(), c["state"].as_str().unwrap().to_owned()))
            .collect();
        assert_eq!(got, expected.into_iter().map(|(h, s)| (h, s.to_owned())).collect::<Vec<_>>());
        assert!(ChannelPeer::parse("not hex").is_none() && ChannelPeer::parse(&"0".repeat(63)).is_none());
        assert_eq!(format!("{a:?}"), "ChannelPeer(..)", "Debug never shows the key");
    }

    #[test]
    fn without_handles_channels_stay_counts_and_other_topics_are_unchanged() {
        let server = TestServer::start(MockNode::canonical(), TOKEN);
        let base = server.api_base();
        let plain = BrokerReads::new(|topic, since| read_topic(paired(&["read"]), &base, Arc::new(Quiet), topic, since));
        let with = BrokerReads::new(|topic, since| read_topic(paired(&["read"]), &base, Arc::new(Quiet), topic, since))
            .with_handles(Some(desk_handles()));
        assert!(plain.read(Topic::Channels, None).unwrap()["data"][0]["report"]["value"]["channels"]["withheld_items"].as_u64().is_some());
        for topic in [Topic::Node, Topic::Prices, Topic::Inbox] {
            assert_eq!(plain.read(topic, None).unwrap()["data"], with.read(topic, None).unwrap()["data"], "{topic:?}");
        }
        for topic in [Topic::Balance, Topic::Payments] {
            assert_eq!(with.read(topic, None), Err(ReadFailed), "{topic:?}");
        }
        // The peer key is kept in memory only: no serialized output carries it,
        // not even the assistant's own unnarrowed one.
        let TopicRead::Live { outputs, .. } = read_topic(paired(&["read"]), &base, Arc::new(Quiet), Topic::Channels, None) else {
            panic!("a live channel read");
        };
        let raw = serde_json::to_string(&outputs).unwrap().to_ascii_lowercase();
        for peer in [mock_node::COUNTERPARTY_01, mock_node::COUNTERPARTY_02, mock_node::COUNTERPARTY_03] {
            assert!(!raw.contains(peer), "a peer key was serialized");
        }
    }

    #[test]
    fn a_client_whose_file_says_rounded_still_reads_channels_with_no_amount() {
        use crate::mcp::endpoint::Host;
        use crate::mcp::store::testing::{MemFile, TagSealer};
        use crate::mcp::store::{self, CLIENTS_PURPOSE};
        use crate::at_rest::Sealer;
        // A clients file written before counts-only: rounded, with channels and balance.
        let (file, sealer) = (MemFile::default(), TagSealer);
        let key = hex::encode([7u8; 32]);
        let plain = format!(r#"{{"version":2,"clients":[{{"id":"mcp-01","name":"Desk","public_key":"{key}","topics":["channels","balance"],"preset":"rounded","created_ms":1}}]}}"#);
        *file.bytes.borrow_mut() = Some(sealer.seal(CLIENTS_PURPOSE, plain.as_bytes()).unwrap());
        let host = Host::from_stored(store::load(&file, Some(&sealer)).unwrap());
        assert_eq!(host.preset("mcp-01"), R2Preset::Counts, "loaded as counts");
        assert_eq!(host.stored()[0].topics, [Topic::Channels], "balance dropped");

        // The channel read at the preset the host gives this client.
        let server = TestServer::start(MockNode::canonical(), TOKEN);
        let base = server.api_base();
        let reads = BrokerReads::with_preset(|topic, since| read_topic(paired(&["read"]), &base, Arc::new(Quiet), topic, since), host.preset("mcp-01"));
        let mut registry = Registry::default();
        registry.add("desk", "Desk assistant", &host.stored()[0].topics);
        let (mut sessions, mut audit) = (Sessions::default(), Vec::new());
        let reply = ask(&mut sessions, &registry, &reads, &mut audit, "read_channels");
        let data = data(&reply);
        assert_eq!(data["shared"], "counts");
        let text = reply.to_string();
        assert!(!text.contains(r#""msat""#) && !text.contains(r#""rounded""#) && !text.contains(r#""sats""#), "no amount: {text}");
        assert!(!text.contains("capacity") && !text.contains("local_balance") && !text.contains("remote_balance"), "{text}");
        assert!(data["data"][0]["report"]["value"]["channels"]["withheld_items"].as_u64().is_some(), "{data}");
    }

    #[test]
    fn a_topic_not_read_live_fails_without_detail() {
        let server = TestServer::start(MockNode::canonical(), TOKEN);
        let base = server.api_base();
        let mut registry = Registry::default();
        registry.add("desk", "Desk assistant", &ALL);
        // Without the read scope, with no pairing, and with no node at all.
        type Source<'a> = Box<dyn Fn(Topic, Option<u64>) -> TopicRead + 'a>;
        let sources: Vec<Source> = vec![
            Box::new(|topic, since| read_topic(paired(&["receive"]), &base, Arc::new(Quiet), topic, since)),
            Box::new(|topic, since| read_topic(NodeAuth::NotPaired, &base, Arc::new(Quiet), topic, since)),
            Box::new(|topic, since| read_topic(paired(&["read"]), "http://127.0.0.1:9/api/v1", Arc::new(Quiet), topic, since)),
        ];
        for source in sources {
            let reads = BrokerReads::new(source);
            let (mut sessions, mut audit) = (Sessions::default(), Vec::new());
            let reply = ask(&mut sessions, &registry, &reads, &mut audit, "read_node");
            assert_eq!(reply["result"]["isError"], true);
            assert_eq!(reply["result"]["content"][0]["text"], "The read failed.");
            assert_eq!(audit[0].outcome, Outcome::ReadFailed);
        }
    }

    #[test]
    fn an_answer_for_another_topic_is_not_passed_on() {
        let seen = RefCell::new(Vec::new());
        let reads = BrokerReads::new(|topic, since| {
            seen.borrow_mut().push((topic, since));
            if topic == Topic::Prices {
                TopicRead::Unavailable { topic, reason: NoRead::NodeUnreachable }
            } else {
                // A live answer, but for another topic.
                TopicRead::Live {
                    topic: Topic::Inbox,
                    outputs: Vec::new(),
                    freshness: Freshness { state: "fresh", age_ms: Some(0), fresh_for_ms: Some(1), node_as_of: false, node_stale: false, clock_skew: false },
                    routes: Vec::new(),
                }
            }
        });
        assert_eq!(reads.read(Topic::Node, None), Err(ReadFailed));
        assert_eq!(reads.read(Topic::Prices, Some(1700)), Err(ReadFailed));
        // The broker is asked exactly what the session asked.
        assert_eq!(*seen.borrow(), vec![(Topic::Node, None), (Topic::Prices, Some(1700))]);
    }
}
