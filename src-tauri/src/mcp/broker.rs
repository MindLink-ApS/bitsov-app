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
//! A topic that is not read live (not paired, rc7 fallback, node unreachable)
//! is a [`ReadFailed`] with no detail. The source of reads is a function, so
//! this module opens nothing itself and holds no token; whoever wires it binds
//! the function to the paired session. It compiles only where its parent does
//! (`cfg(test)` or the off-by-default `mcp-grant` feature).

use serde_json::{json, Value};

use super::server::{ReadFailed, Reads};
use crate::ai::{narrow, Preset, Topic, TopicRead};

/// What MCP clients get unless the owner chooses otherwise.
pub const DEFAULT_PRESET: Preset = Preset::Counts;

/// The read broker for one client: a topic source and how far to narrow.
pub struct BrokerReads<F>
where
    F: Fn(Topic, Option<u64>) -> TopicRead,
{
    read: F,
    preset: Preset,
}

impl<F> BrokerReads<F>
where
    F: Fn(Topic, Option<u64>) -> TopicRead,
{
    /// Narrowed to [`DEFAULT_PRESET`] (counts).
    pub fn new(read: F) -> Self {
        Self { read, preset: DEFAULT_PRESET }
    }

    /// Narrowed to `preset`, as the owner set it for this client.
    pub fn with_preset(read: F, preset: Preset) -> Self {
        Self { read, preset }
    }
}

impl<F> Reads for BrokerReads<F>
where
    F: Fn(Topic, Option<u64>) -> TopicRead,
{
    fn read(&self, topic: Topic, since_ms: Option<u64>) -> Result<Value, ReadFailed> {
        match (self.read)(topic, since_ms) {
            TopicRead::Live { topic: got, outputs, freshness, .. } if got == topic => {
                let data: Vec<Value> = outputs
                    .iter()
                    .map(|output| serde_json::to_value(output).map(|value| narrow(&value, self.preset)))
                    .collect::<Result<_, _>>()
                    .map_err(|_| ReadFailed)?;
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
    const TOOLS: [&str; 6] = ["read_node", "read_channels", "read_prices", "read_balance", "read_payments", "read_inbox_counts"];

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

    #[test]
    fn the_owner_can_widen_a_client_to_exact() {
        let server = TestServer::start(MockNode::canonical(), TOKEN);
        let base = server.api_base();
        let reads = BrokerReads::with_preset(|topic, since| read_topic(paired(&["read"]), &base, Arc::new(Quiet), topic, since), Preset::Exact);
        let mut registry = Registry::default();
        registry.add("desk", "Desk assistant", &[Topic::Balance]);
        let (mut sessions, mut audit) = (Sessions::default(), Vec::new());
        let reply = ask(&mut sessions, &registry, &reads, &mut audit, "read_balance");
        let data = data(&reply);
        assert_eq!(data["shared"], "exact");
        assert!(reply.to_string().contains(&balance_msat().to_string()), "exact keeps the amount");
        // Message text is never part of any projection, even exact.
        for canary in CANARIES {
            assert!(!reply.to_string().contains(canary), "{canary}");
        }
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
            if topic == Topic::Payments {
                TopicRead::Unavailable { topic, reason: NoRead::NodeUnreachable }
            } else {
                // A live answer, but for the balance.
                TopicRead::Live {
                    topic: Topic::Balance,
                    outputs: Vec::new(),
                    freshness: Freshness { state: "fresh", age_ms: Some(0), fresh_for_ms: Some(1), node_as_of: false, node_stale: false, clock_skew: false },
                    routes: Vec::new(),
                }
            }
        });
        assert_eq!(reads.read(Topic::Node, None), Err(ReadFailed));
        assert_eq!(reads.read(Topic::Payments, Some(1700)), Err(ReadFailed));
        // The client's since_ms reaches the broker unchanged.
        assert_eq!(*seen.borrow(), vec![(Topic::Node, None), (Topic::Payments, Some(1700))]);
    }
}
