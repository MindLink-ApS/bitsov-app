//! In-test fake node. Canaries sit in bodies, memos, preimages, nested
//! unknown fields, and error responses. None of those bytes are allowed to
//! survive in tool output or in Debug / log formatting.

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::{json, Value};

use super::route::{self, ReadRoute};
use super::schema::{
    Amount, BalanceInput, ChannelsInput, HealthInput, LocalPricesInput, MessageCountsInput,
    PricingMode, Report, ToolCall, ToolOutput, TrustLevel, UnavailableReason, WalletBalanceLabel,
    MAX_MESSAGE_LIMIT,
};
use super::{Broker, Dispatch, LogOutcome, NodeRead, RawRead, ReadFault, ALLOWED_PATHS};

const CANARY: &str = "CANARY_9f3e2a";

const ERROR_BODY: &str = r#"{"error":"CANARY_9f3e2a","code":500,"memo":"CANARY_9f3e2a","preimage":"CANARY_9f3e2a","nested":{"body":"CANARY_9f3e2a","plaintext":"CANARY_9f3e2a"}}"#;

const UNKNOWN_OBJECT: &str = r#"{"balance_msat":"CANARY_9f3e2a","status":"ok","memo":"CANARY_9f3e2a","preimage":"CANARY_9f3e2a","plaintext":"CANARY_9f3e2a","nested":{"body":"CANARY_9f3e2a"}}"#;

const SENDER: &str = "abababababababababababababababababababababababababababababababab";
const PUBKEY: &str = "02abababababababababababababababababababababababababababababababab";

struct Fake {
    files: HashMap<&'static str, (u16, String)>,
    transport: bool,
    seen: Mutex<Vec<ReadRoute>>,
}

impl Fake {
    fn new() -> Self {
        Self {
            files: HashMap::new(),
            transport: false,
            seen: Mutex::new(Vec::new()),
        }
    }

    fn json(mut self, path: &'static str, body: impl Into<String>) -> Self {
        self.files.insert(path, (200, body.into()));
        self
    }

    fn http(mut self, path: &'static str, status: u16, body: impl Into<String>) -> Self {
        self.files.insert(path, (status, body.into()));
        self
    }

    fn transport(mut self) -> Self {
        self.transport = true;
        self
    }

    fn seen(&self) -> Vec<ReadRoute> {
        self.seen.lock().expect("seen").clone()
    }
}

impl NodeRead for Fake {
    fn read(&self, route: ReadRoute) -> Result<RawRead, ReadFault> {
        self.seen.lock().expect("seen").push(route);
        if self.transport {
            return Err(ReadFault::Transport);
        }
        let path = route.target().path;
        let (status, body) = match self.files.get(path) {
            Some((status, body)) => (*status, body.clone()),
            None => (500, ERROR_BODY.to_string()),
        };
        Ok(RawRead::new(status, body.into_bytes()))
    }
}

struct PanicNode;

impl NodeRead for PanicNode {
    fn read(&self, route: ReadRoute) -> Result<RawRead, ReadFault> {
        panic!("node read during a rejected call: {}", route.target().path);
    }
}

fn broker() -> Broker {
    Broker::new().expect("allowlist")
}

fn dispatch(node: &Fake, call: ToolCall) -> Dispatch {
    let done = broker().dispatch(node, call).expect("accepted call");
    assert_reads_allowlisted(node);
    done
}

fn assert_reads_allowlisted(node: &Fake) {
    for route in node.seen() {
        let target = route.target();
        assert_eq!(target.method, "GET");
        assert!(ALLOWED_PATHS.contains(&target.path), "{}", target.path);
        assert!(route::segments_allowed(target.path));
        assert!(route::path_allowed(target.path));
        if let Some(query) = target.query {
            assert!(query.key == "limit", "{}", query.key);
        }
    }
}

fn render(done: &Dispatch) -> String {
    format!(
        "{done:?}\n{}\n{done:?}",
        serde_json::to_string(&done.output).expect("output json")
    )
}

fn assert_no_canary(done: &Dispatch, fixture: impl AsRef<str>) {
    let fixture = fixture.as_ref();
    assert!(
        fixture.contains(CANARY),
        "fixture did not contain the canary"
    );
    let rendered = render(done);
    assert!(!rendered.contains(CANARY), "{rendered}");
}

fn assert_no_available_zero(value: &Value) {
    match value {
        Value::Object(map) => {
            if map.get("state").and_then(Value::as_str) == Some("available") {
                let number = map.get("value").and_then(Value::as_f64);
                assert_ne!(number, Some(0.0), "failed read surfaced as 0: {map:?}");
            }
            for child in map.values() {
                assert_no_available_zero(child);
            }
        }
        Value::Array(items) => {
            for child in items {
                assert_no_available_zero(child);
            }
        }
        _ => {}
    }
}

fn calls() -> [ToolCall; 5] {
    [
        ToolCall::Balance {
            input: BalanceInput {},
        },
        ToolCall::Channels {
            input: ChannelsInput {},
        },
        ToolCall::Health {
            input: HealthInput {},
        },
        ToolCall::MessageCounts {
            input: MessageCountsInput { limit: 10 },
        },
        ToolCall::LocalPrices {
            input: LocalPricesInput {},
        },
    ]
}

fn unavailable_reason(output: &ToolOutput) -> UnavailableReason {
    match output {
        ToolOutput::Balance {
            report: Report::Unavailable { reason },
        }
        | ToolOutput::Channels {
            report: Report::Unavailable { reason },
        }
        | ToolOutput::Health {
            report: Report::Unavailable { reason },
        }
        | ToolOutput::MessageCounts {
            report: Report::Unavailable { reason },
        }
        | ToolOutput::LocalPrices {
            report: Report::Unavailable { reason },
        } => *reason,
        other => panic!("expected unavailable, got {other:?}"),
    }
}

#[test]
fn broker_constructs_only_when_the_allowlist_holds() {
    assert!(Broker::new().is_ok());
    assert!(route::enforce().is_ok());
}

#[test]
fn allowlist_is_exactly_the_phase1_reads() {
    let mut paths = ALLOWED_PATHS.to_vec();
    paths.sort_unstable();
    assert_eq!(
        paths,
        vec![
            "/api/v1/health",
            "/api/v1/messages",
            "/api/v1/payments/balance",
            "/api/v1/payments/channels",
            "/api/v1/pricing",
        ]
    );
}

#[test]
fn every_route_target_is_an_allowlisted_get() {
    let mut seen = [false; 5];
    for route in route::sample_routes() {
        let target = route.target();
        assert_eq!(target.method, "GET");
        assert!(route::path_allowed(target.path), "{}", target.path);
        assert!(route::segments_allowed(target.path));
        assert!(ALLOWED_PATHS.contains(&target.path));
        let slot = match route {
            ReadRoute::PaymentsBalance => {
                assert_eq!(target.path, route::PAYMENTS_BALANCE);
                assert!(target.query.is_none());
                0
            }
            ReadRoute::PaymentsChannels => {
                assert_eq!(target.path, route::PAYMENTS_CHANNELS);
                assert!(target.query.is_none());
                1
            }
            ReadRoute::Health => {
                assert_eq!(target.path, route::HEALTH);
                assert!(target.query.is_none());
                2
            }
            ReadRoute::Messages { limit } => {
                assert_eq!(target.path, route::MESSAGES);
                assert_eq!(target.query.map(|query| query.key), Some("limit"));
                assert_eq!(target.query.map(|query| query.value), Some(limit));
                3
            }
            ReadRoute::OwnPricing => {
                assert_eq!(target.path, route::OWN_PRICING);
                assert!(target.query.is_none());
                4
            }
        };
        assert!(!seen[slot]);
        seen[slot] = true;
    }
    assert_eq!(seen, [true; 5]);
}

#[test]
fn mutating_routes_are_rejected_by_the_allowlist() {
    const MUTATING: &[&str] = &[
        "/api/v1/payments/invoice",
        "/api/v1/payments/pay",
        "/api/v1/payments/keysend",
        "/api/v1/payments/send-onchain",
        "/api/v1/payments/open-channel",
        "/api/v1/payments/close-channel",
        "/api/v1/payments",
        "/api/v1/identity/restore",
        "/api/v1/identity/verify-mnemonic",
        "/api/v1/messages/compose",
        "/api/v1/messages/search",
        "/api/v1/messages/resync",
        "/api/v1/admin",
        "/api/v1/onboarding/start",
        "/api/v1/auth/local",
        "/api/v1/pricing/peers",
    ];
    for path in MUTATING {
        assert!(!route::path_allowed(path), "{path}");
        assert!(!ALLOWED_PATHS.contains(path), "{path}");
    }
    assert!(route::segments_allowed("/api/v1/payments/balance"));
    assert!(!route::segments_allowed("/api/v1/payments/pay"));
    assert!(!route::segments_allowed("/api/v1/payments/invoice"));
    assert!(!route::segments_allowed("/api/v1/identity/restore"));
    assert!(!route::segments_allowed("/api/v1/messages/compose"));
    assert!(!route::segments_allowed("/api/v1/admin"));
}

#[test]
fn rejected_tool_names_do_not_reach_the_node() {
    let samples: &[&[u8]] = &[
        br#"{"tool":"invoice","input":{"memo":"CANARY_9f3e2a"}}"#,
        br#"{"tool":"pay","input":{"preimage":"CANARY_9f3e2a"}}"#,
        br#"{"tool":"spend","input":{}}"#,
        br#"{"tool":"restore","input":{"mnemonic":"CANARY_9f3e2a"}}"#,
        br#"{"tool":"admin","input":{}}"#,
        br#"{"tool":"compose","input":{"plaintext":"CANARY_9f3e2a"}}"#,
        br#"{"tool":"balance","input":{"route":"/api/v1/payments/pay","memo":"CANARY_9f3e2a"}}"#,
        br#"{"tool":"message_counts","input":{"limit":1,"peer":"CANARY_9f3e2a"}}"#,
    ];
    assert!(samples[0]
        .windows(CANARY.len())
        .any(|window| window == CANARY.as_bytes()));
    for bytes in samples {
        let err = broker().execute(&PanicNode, bytes).expect_err("rejected");
        let rendered = format!("{err} {err:?}");
        assert_eq!(rendered, "rejected Rejected");
        assert!(!rendered.contains(CANARY));
    }
}

#[test]
fn message_limit_outside_the_genome_cap_is_rejected() {
    for limit in [0, MAX_MESSAGE_LIMIT + 1] {
        let call = ToolCall::MessageCounts {
            input: MessageCountsInput { limit },
        };
        let err = broker()
            .dispatch(&PanicNode, call)
            .expect_err("limit rejected");
        assert_eq!(format!("{err}"), "rejected");
    }
    assert_eq!(super::default_limit(), 50);
}

#[test]
fn error_bodies_become_unavailable_and_drop_the_canary() {
    let node = Fake::new();
    assert!(ERROR_BODY.contains("\"memo\""));
    assert!(ERROR_BODY.contains("\"preimage\""));
    assert!(ERROR_BODY.contains("\"plaintext\""));
    for call in calls() {
        let done = dispatch(&node, call);
        assert_eq!(
            unavailable_reason(&done.output),
            UnavailableReason::UpstreamError
        );
        assert_no_canary(&done, ERROR_BODY);
        let output = serde_json::to_value(&done.output).expect("json");
        assert_no_available_zero(&output);
        assert_reasons_carry_no_payload(&output);
        assert_no_json_number(&output, 500);
        assert!(done
            .log
            .iter()
            .any(|entry| { matches!(entry.outcome, LogOutcome::Http { status: 500 }) }));
    }
}

#[test]
fn mistyped_responses_are_malformed_and_drop_the_canary() {
    let node = Fake::new()
        .json(route::PAYMENTS_BALANCE, UNKNOWN_OBJECT)
        .json(route::PAYMENTS_CHANNELS, UNKNOWN_OBJECT)
        .json(route::HEALTH, UNKNOWN_OBJECT)
        .json(route::MESSAGES, UNKNOWN_OBJECT)
        .json(route::OWN_PRICING, UNKNOWN_OBJECT);
    assert!(UNKNOWN_OBJECT.contains("\"nested\""));
    for call in calls() {
        let done = dispatch(&node, call);
        assert_eq!(
            unavailable_reason(&done.output),
            UnavailableReason::Malformed
        );
        assert_no_canary(&done, UNKNOWN_OBJECT);
        assert_no_available_zero(&serde_json::to_value(&done.output).expect("json"));
    }
}

#[test]
fn transport_failure_is_unavailable_not_zero() {
    let node = Fake::new().transport();
    let done = dispatch(
        &node,
        ToolCall::Balance {
            input: BalanceInput {},
        },
    );
    assert_eq!(unavailable_reason(&done.output), UnavailableReason::Timeout);
    let rendered = render(&done);
    assert!(!rendered.contains("\"value\""));
}

#[test]
fn raw_read_debug_redacts_the_body() {
    let raw = RawRead::new(500, ERROR_BODY.as_bytes().to_vec());
    let rendered = format!("{raw:?}");
    assert!(ERROR_BODY.contains(CANARY));
    assert!(!rendered.contains(CANARY), "{rendered}");
    assert!(rendered.contains("body_len"));
}

#[test]
fn balance_projects_wallet_and_channel_figures_with_units() {
    let node = Fake::new()
        .json(route::PAYMENTS_BALANCE, r#"{"balance_msat":2500}"#)
        .json(route::PAYMENTS_CHANNELS, channels_body())
        .json(route::HEALTH, health_body("ldk"));
    let done = dispatch(
        &node,
        ToolCall::Balance {
            input: BalanceInput {},
        },
    );
    let ToolOutput::Balance {
        report: Report::Ready { value },
    } = &done.output
    else {
        panic!("{:?}", done.output);
    };
    assert_eq!(value.label, WalletBalanceLabel::LdkOnchainPlusLightning);
    assert_eq!(
        value.wallet_balance,
        Amount::Available {
            value: 2500,
            unit: super::Unit::Msat,
            source_field: super::SourceField::BalanceMsat,
        }
    );
    assert_eq!(
        value.channel_local_balance,
        Amount::Available {
            value: 400,
            unit: super::Unit::Msat,
            source_field: super::SourceField::LocalBalanceMsat,
        }
    );
    assert_eq!(
        value.channel_remote_balance,
        Amount::Available {
            value: 60,
            unit: super::Unit::Msat,
            source_field: super::SourceField::RemoteBalanceMsat,
        }
    );
    let rendered = serde_json::to_string(&done.output).expect("json");
    assert!(rendered.contains("\"unit\":\"msat\""));
    assert!(rendered.contains("\"source_field\":\"balance_msat\""));
    assert!(rendered.contains("\"source_field\":\"local_balance_msat\""));
}

fn health_body(lightning_backend: &str) -> String {
    format!(
        r#"{{"status":"ok","connected_peers":1,"e2ee_sessions":0,"pending_deliveries":0,"lightning_available":true,"lightning_payment_capable":true,"uptime_secs":3,"version":2,"lightning_backend":"{lightning_backend}","chain_backend":"esplora","block_height":100}}"#
    )
}

fn channels_body() -> &'static str {
    r#"[{"channel_id":"7","peer_pubkey":"02abababababababababababababababababababababababababababababababab","capacity_msat":1000,"local_balance_msat":400,"remote_balance_msat":60,"active":true,"short_channel_id":"1x2x3"}]"#
}

#[test]
fn empty_channel_list_is_a_real_zero() {
    let node = Fake::new()
        .json(route::PAYMENTS_BALANCE, r#"{"balance_msat":0}"#)
        .json(route::PAYMENTS_CHANNELS, "[]");
    let done = dispatch(
        &node,
        ToolCall::Balance {
            input: BalanceInput {},
        },
    );
    let ToolOutput::Balance {
        report: Report::Ready { value },
    } = &done.output
    else {
        panic!("{:?}", done.output);
    };
    assert!(matches!(
        value.wallet_balance,
        Amount::Available { value: 0, .. }
    ));
    assert!(matches!(
        value.channel_local_balance,
        Amount::Available { value: 0, .. }
    ));
    let channels = dispatch(
        &node,
        ToolCall::Channels {
            input: ChannelsInput {},
        },
    );
    let ToolOutput::Channels {
        report: Report::Ready { value },
    } = &channels.output
    else {
        panic!("{:?}", channels.output);
    };
    assert!(matches!(value.count, Amount::Available { value: 0, .. }));
    assert!(value.channels.is_empty());
}

#[test]
fn a_failed_wallet_read_does_not_zero_the_channel_figures() {
    let node = Fake::new()
        .http(route::PAYMENTS_BALANCE, 502, ERROR_BODY)
        .json(route::PAYMENTS_CHANNELS, channels_body());
    let done = dispatch(
        &node,
        ToolCall::Balance {
            input: BalanceInput {},
        },
    );
    assert_no_canary(&done, ERROR_BODY);
    let ToolOutput::Balance {
        report: Report::Ready { value },
    } = &done.output
    else {
        panic!("{:?}", done.output);
    };
    assert_eq!(value.label, WalletBalanceLabel::NodeReported);
    assert!(matches!(
        value.wallet_balance,
        Amount::Unavailable {
            reason: UnavailableReason::UpstreamError,
            ..
        }
    ));
    let output = serde_json::to_value(&done.output).expect("json");
    assert_reasons_carry_no_payload(&output);
    assert_no_json_number(&output, 502);
    assert!(done.log.iter().any(|entry| {
        entry.path == route::PAYMENTS_BALANCE
            && matches!(entry.outcome, LogOutcome::Http { status: 502 })
    }));
    assert!(matches!(
        value.channel_local_balance,
        Amount::Available { value: 400, .. }
    ));
}

#[test]
fn channel_summary_withholds_ids_that_fail_the_charset_check() {
    let body = concat!(
        r#"[{"channel_id":"7","peer_pubkey":"CANARY_9f3e2a","capacity_msat":9,"local_balance_msat":4,"remote_balance_msat":5,"active":true,"short_channel_id":"CANARY_9f3e2a"},{"channel_id":"CANARY_9f3e2a","peer_pubkey":""#,
        "02abababababababababababababababababababababababababababababababab",
        r#"","capacity_msat":3,"local_balance_msat":1,"remote_balance_msat":2,"active":false,"short_channel_id":"8x9x10"}]"#
    );
    let node = Fake::new().json(route::PAYMENTS_CHANNELS, body);
    let done = dispatch(
        &node,
        ToolCall::Channels {
            input: ChannelsInput {},
        },
    );
    assert_no_canary(&done, body);
    let ToolOutput::Channels {
        report: Report::Ready { value },
    } = &done.output
    else {
        panic!("{:?}", done.output);
    };
    assert!(matches!(value.count, Amount::Available { value: 2, .. }));
    assert!(matches!(
        value.active_count,
        Amount::Available { value: 1, .. }
    ));
    assert!(matches!(
        value.channels[0].local_balance,
        Amount::Available { value: 4, .. }
    ));
    assert!(matches!(
        value.channels[0].short_channel_id,
        Some(super::CopiedId::Withheld)
    ));
    assert!(matches!(
        value.channels[1].channel_id,
        super::CopiedId::Withheld
    ));
    assert!(matches!(
        value.channels[1].capacity,
        Amount::Available { value: 3, .. }
    ));
    let rendered = render(&done);
    assert!(!rendered.contains("peer_pubkey"), "{rendered}");
    assert!(
        !rendered.contains("02abababababababababababababababababababababababababababababababab"),
        "{rendered}"
    );
}

#[test]
fn channel_sum_overflow_is_unavailable() {
    let max = u64::MAX;
    let body = format!(
        r#"[{{"channel_id":"1","peer_pubkey":"{PUBKEY}","capacity_msat":{max},"local_balance_msat":{max},"remote_balance_msat":1,"active":true,"short_channel_id":"1x1x1"}},{{"channel_id":"2","peer_pubkey":"{PUBKEY}","capacity_msat":{max},"local_balance_msat":{max},"remote_balance_msat":1,"active":true,"short_channel_id":null}}]"#
    );
    let node = Fake::new()
        .json(route::PAYMENTS_BALANCE, r#"{"balance_msat":1}"#)
        .json(route::PAYMENTS_CHANNELS, body);
    let done = dispatch(
        &node,
        ToolCall::Balance {
            input: BalanceInput {},
        },
    );
    let ToolOutput::Balance {
        report: Report::Ready { value },
    } = &done.output
    else {
        panic!("{:?}", done.output);
    };
    assert!(matches!(
        value.channel_local_balance,
        Amount::Unavailable {
            reason: UnavailableReason::Overflow,
            ..
        }
    ));
    assert!(matches!(
        value.channel_capacity,
        Amount::Unavailable {
            reason: UnavailableReason::Overflow,
            ..
        }
    ));
    assert!(matches!(
        value.channel_remote_balance,
        Amount::Available { value: 2, .. }
    ));
    let local = serde_json::to_value(&value.channel_local_balance).expect("json");
    assert!(local.get("value").is_none(), "{local}");
}

#[test]
fn health_keeps_counters_and_drops_unexpected_strings() {
    let body = r#"{"status":"CANARY_9f3e2a","connected_peers":0,"e2ee_sessions":2,"pending_deliveries":4,"lightning_available":true,"lightning_payment_capable":false,"uptime_secs":9,"version":2,"lightning_backend":"CANARY_9f3e2a","chain_backend":"CANARY_9f3e2a","block_height":100}"#;
    let node = Fake::new().json(route::HEALTH, body);
    let done = dispatch(
        &node,
        ToolCall::Health {
            input: HealthInput {},
        },
    );
    assert_no_canary(&done, body);
    let ToolOutput::Health {
        report: Report::Ready { value },
    } = &done.output
    else {
        panic!("{:?}", done.output);
    };
    assert_eq!(value.liveness, super::Liveness::Other);
    assert_eq!(value.lightning_backend, super::LightningBackend::Other);
    assert_eq!(value.chain_backend, super::ChainBackend::Other);
    assert!(matches!(
        value.connected_peers,
        Amount::Available { value: 0, .. }
    ));
    assert!(matches!(
        value.block_height,
        Amount::Available { value: 100, .. }
    ));
    assert!(matches!(
        value.uptime,
        Amount::Available {
            value: 9,
            unit: super::Unit::Seconds,
            source_field: super::SourceField::UptimeSecs,
        }
    ));
}

#[test]
fn omitted_block_height_is_absent_not_zero() {
    let body = r#"{"status":"ok","connected_peers":1,"e2ee_sessions":0,"pending_deliveries":0,"lightning_available":true,"lightning_payment_capable":true,"uptime_secs":3,"version":2,"lightning_backend":"ldk","chain_backend":"esplora"}"#;
    let node = Fake::new().json(route::HEALTH, body);
    let done = dispatch(
        &node,
        ToolCall::Health {
            input: HealthInput {},
        },
    );
    let ToolOutput::Health {
        report: Report::Ready { value },
    } = &done.output
    else {
        panic!("{:?}", done.output);
    };
    assert_eq!(value.liveness, super::Liveness::Ok);
    assert_eq!(value.lightning_backend, super::LightningBackend::Ldk);
    assert_eq!(value.chain_backend, super::ChainBackend::Esplora);
    assert!(matches!(
        value.block_height,
        Amount::Unavailable {
            reason: UnavailableReason::Absent,
            ..
        }
    ));
}

#[test]
fn message_metadata_drops_bodies_memos_and_bad_senders() {
    let body = format!(
        r#"[{{"id":"CANARY_9f3e2a","kind":100,"sender":"{SENDER}","recipient":"CANARY_9f3e2a","timestamp":1,"ciphertext":"CANARY_9f3e2a","payment_amount_msat":0,"payment_hash":"CANARY_9f3e2a","plaintext":"CANARY_9f3e2a body","references":["CANARY_9f3e2a"]}},{{"id":"dd","kind":2,"sender":"CANARY_9f3e2a","recipient":"room","timestamp":2,"ciphertext":"CANARY_9f3e2a","payment_amount_msat":5,"payment_hash":"CANARY_9f3e2a","memo":"CANARY_9f3e2a","preimage":"CANARY_9f3e2a","nested":{{"plaintext":"CANARY_9f3e2a"}}}},{{"id":"ee","kind":1,"sender":"{SENDER}","recipient":"{PUBKEY}","timestamp":3,"ciphertext":"CANARY_9f3e2a","payment_amount_msat":0,"payment_hash":"CANARY_9f3e2a","plaintext":"CANARY_9f3e2a"}}]"#
    );
    // Unknown memo/preimage/nested fields are ignored. The canary sender is withheld.
    let node = Fake::new().json(route::MESSAGES, &body);
    let done = dispatch(
        &node,
        ToolCall::MessageCounts {
            input: MessageCountsInput { limit: 25 },
        },
    );
    assert_no_canary(&done, body);
    let ToolOutput::MessageCounts {
        report: Report::Ready { value },
    } = &done.output
    else {
        panic!("{:?}", done.output);
    };
    assert!(matches!(
        value.returned_count,
        Amount::Available { value: 3, .. }
    ));
    assert!(matches!(
        value.withheld_senders,
        Amount::Available { value: 1, .. }
    ));
    assert_eq!(value.senders.len(), 1);
    assert_eq!(value.senders[0].sender, SENDER);
    let rendered = render(&done);
    assert!(!rendered.contains(PUBKEY), "{rendered}");
    assert_eq!(node.seen().len(), 1);
    assert!(matches!(node.seen()[0], ReadRoute::Messages { limit: 25 }));
}

#[test]
fn message_page_counts_senders_and_strips_plaintext() {
    let body = format!(
        r#"[{{"id":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","kind":100,"sender":"{SENDER}","recipient":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","timestamp":5,"ciphertext":"CANARY_9f3e2a","payment_amount_msat":9,"payment_hash":"CANARY_9f3e2a","plaintext":"CANARY_9f3e2a","references":["CANARY_9f3e2a"]}},{{"id":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","kind":100,"sender":"CANARY_9f3e2a","recipient":"CANARY_9f3e2a","timestamp":6,"ciphertext":"CANARY_9f3e2a","payment_amount_msat":0,"payment_hash":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}}]"#
    );
    let node = Fake::new().json(route::MESSAGES, &body);
    let done = dispatch(
        &node,
        ToolCall::MessageCounts {
            input: MessageCountsInput::default(),
        },
    );
    assert_no_canary(&done, body);
    let ToolOutput::MessageCounts {
        report: Report::Ready { value },
    } = &done.output
    else {
        panic!("{:?}", done.output);
    };
    assert!(matches!(
        value.returned_count,
        Amount::Available {
            value: 2,
            source_field: super::SourceField::Messages,
            ..
        }
    ));
    assert!(matches!(
        value.withheld_senders,
        Amount::Available { value: 1, .. }
    ));
    assert_eq!(value.senders.len(), 1);
    assert_eq!(value.senders[0].sender, SENDER);
    assert!(matches!(
        value.senders[0].count,
        Amount::Available { value: 1, .. }
    ));
    assert_eq!(node.seen().len(), 1);
    assert!(matches!(node.seen()[0], ReadRoute::Messages { limit: 50 }));
}

#[test]
fn a_limit_of_one_is_a_page_not_a_mailbox_total() {
    // The node applies limit before returning. This body is the one-message
    // page for limit=1; the unread mailbox is larger. returned_count is that
    // page, and the broker must not invent a chat/sent/stored total from it.
    let body = format!(
        r#"[{{"id":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","kind":0,"sender":"{SENDER}","recipient":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","timestamp":5,"ciphertext":"x","payment_amount_msat":0,"payment_hash":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}}]"#
    );
    let node = Fake::new().json(route::MESSAGES, &body);
    let done = dispatch(
        &node,
        ToolCall::MessageCounts {
            input: MessageCountsInput { limit: 1 },
        },
    );
    let ToolOutput::MessageCounts {
        report: Report::Ready { value },
    } = &done.output
    else {
        panic!("{:?}", done.output);
    };
    assert!(matches!(
        value.returned_count,
        Amount::Available { value: 1, .. }
    ));
    assert_eq!(value.senders.len(), 1);
    let keys = json_keys(&serde_json::to_value(&done.output).expect("json"));
    for forbidden in ["chat_count", "sent_to", "sent_count", "sent"] {
        assert!(
            !keys.iter().any(|found| found == forbidden),
            "{forbidden} must not appear as a total from a page: {keys:?}"
        );
    }
    assert_eq!(node.seen().len(), 1);
    assert!(matches!(node.seen()[0], ReadRoute::Messages { limit: 1 }));
}

#[test]
fn incoming_recipients_are_not_counted_as_sent_mail() {
    // A default 50-message page whose unread sent history would exceed one
    // page. Incoming recipients must not become invented sent totals.
    let mut messages = Vec::new();
    for index in 0u32..50 {
        let recipient = format!("{index:064x}");
        messages.push(format!(
            r#"{{"id":"{recipient}","kind":0,"sender":"{SENDER}","recipient":"{recipient}","timestamp":{ts},"ciphertext":"x","payment_amount_msat":0,"payment_hash":"{recipient}"}}"#,
            ts = 1_000 + index
        ));
    }
    let body = format!("[{}]", messages.join(","));
    let node = Fake::new().json(route::MESSAGES, &body);
    let done = dispatch(
        &node,
        ToolCall::MessageCounts {
            input: MessageCountsInput { limit: 50 },
        },
    );
    let ToolOutput::MessageCounts {
        report: Report::Ready { value },
    } = &done.output
    else {
        panic!("{:?}", done.output);
    };
    assert!(matches!(
        value.returned_count,
        Amount::Available { value: 50, .. }
    ));
    assert_eq!(value.senders.len(), 1);
    assert_eq!(value.senders[0].sender, SENDER);
    let keys = json_keys(&serde_json::to_value(&done.output).expect("json"));
    for forbidden in ["chat_count", "sent_to", "sent_count", "recipient"] {
        assert!(
            !keys.iter().any(|found| found == forbidden),
            "must not invent sent totals from an incoming page: {forbidden} in {keys:?}"
        );
    }
    assert_eq!(node.seen().len(), 1);
    assert!(matches!(node.seen()[0], ReadRoute::Messages { limit: 50 }));
}

#[test]
fn local_prices_drop_unknown_keys_and_absent_fees_are_not_zero() {
    let body = r#"{"mode":"CANARY_9f3e2a","prices":{"communication":1000,"CANARY_9f3e2a":5},"block_height":800000,"valid_blocks":144,"trust_level":"CANARY_9f3e2a","difficulty_epoch_position":10,"peer_tables_cached":2,"fee_rates_by_target":{"6":{"raw_sat_per_vbyte":3.5,"ema_sat_per_vbyte":2.0},"CANARY_9f3e2a":{"raw_sat_per_vbyte":1.0,"ema_sat_per_vbyte":1.0}},"category_fee_targets":{"communication":6,"CANARY_9f3e2a":1}}"#;
    let node = Fake::new().json(route::OWN_PRICING, body);
    let done = dispatch(
        &node,
        ToolCall::LocalPrices {
            input: LocalPricesInput {},
        },
    );
    assert_no_canary(&done, body);
    let ToolOutput::LocalPrices {
        report: Report::Ready { value },
    } = &done.output
    else {
        panic!("{:?}", done.output);
    };
    assert_eq!(value.mode, PricingMode::Other);
    assert_eq!(value.trust_level, TrustLevel::Other);
    assert_eq!(value.prices.len(), 1);
    assert_eq!(
        value.prices[0].category,
        super::PriceCategory::Communication
    );
    assert!(matches!(
        value.prices[0].price,
        Amount::Available {
            value: 1000,
            unit: super::Unit::Msat,
            source_field: super::SourceField::Prices,
        }
    ));
    assert!(matches!(
        value.withheld_prices,
        Amount::Available { value: 1, .. }
    ));
    assert!(matches!(
        value.raw_fee_rate,
        Amount::Unavailable {
            reason: UnavailableReason::Absent,
            ..
        }
    ));
    assert!(matches!(
        value.ema_fee_rate,
        Amount::Unavailable {
            reason: UnavailableReason::Absent,
            ..
        }
    ));
    assert_eq!(value.fee_rates_by_target.len(), 1);
    assert_eq!(value.fee_rates_by_target[0].target_blocks, 6);
    assert!(matches!(
        value.fee_rates_by_target[0].raw,
        Amount::Available { value, .. } if value == 3.5
    ));
    assert!(matches!(
        value.withheld_fee_targets,
        Amount::Available { value: 1, .. }
    ));
    assert_eq!(value.category_fee_targets.len(), 1);
    assert!(matches!(
        value.withheld_category_targets,
        Amount::Available { value: 1, .. }
    ));
    assert!(matches!(
        value.block_height,
        Amount::Available { value: 800000, .. }
    ));
}

#[test]
fn stale_chain_anchor_is_unavailable_not_zero() {
    let body = r#"{"mode":"static","prices":{"communication":9},"block_height":0,"valid_blocks":72,"trust_level":"spv","difficulty_epoch_position":0,"peer_tables_cached":0}"#;
    let node = Fake::new().json(route::OWN_PRICING, body);
    let done = dispatch(
        &node,
        ToolCall::LocalPrices {
            input: LocalPricesInput {},
        },
    );
    let ToolOutput::LocalPrices {
        report: Report::Ready { value },
    } = &done.output
    else {
        panic!("{:?}", done.output);
    };
    assert_eq!(value.mode, PricingMode::Static);
    assert_eq!(value.trust_level, TrustLevel::Spv);
    assert!(matches!(
        value.block_height,
        Amount::Unavailable {
            reason: UnavailableReason::Stale,
            source_field: super::SourceField::BlockHeight,
            ..
        }
    ));
    assert!(matches!(
        value.difficulty_epoch_position,
        Amount::Unavailable {
            reason: UnavailableReason::Stale,
            ..
        }
    ));
    assert!(matches!(
        value.valid_blocks,
        Amount::Available { value: 72, .. }
    ));
    assert!(matches!(
        value.peer_tables_cached,
        Amount::Available { value: 0, .. }
    ));
    assert!(matches!(
        value.prices[0].price,
        Amount::Available { value: 9, .. }
    ));
    let height = serde_json::to_value(&value.block_height).expect("json");
    assert!(height.get("value").is_none(), "{height}");
}

#[test]
fn nested_unknown_message_fields_are_ignored() {
    let body = format!(
        r#"[{{"id":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","kind":1,"sender":"{SENDER}","recipient":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","timestamp":1,"ciphertext":"abcdef","payment_amount_msat":1,"payment_hash":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","plaintext":"CANARY_9f3e2a","memo":"CANARY_9f3e2a","preimage":"CANARY_9f3e2a","nested":{{"body":"CANARY_9f3e2a"}}}}]"#
    );
    let node = Fake::new().json(route::MESSAGES, &body);
    let done = dispatch(
        &node,
        ToolCall::MessageCounts {
            input: MessageCountsInput { limit: 1 },
        },
    );
    assert_no_canary(&done, body);
    let ToolOutput::MessageCounts {
        report: Report::Ready { value },
    } = &done.output
    else {
        panic!("{:?}", done.output);
    };
    assert!(matches!(
        value.returned_count,
        Amount::Available { value: 1, .. }
    ));
    assert_eq!(value.senders.len(), 1);
    assert_eq!(value.senders[0].sender, SENDER);
}

#[test]
fn tool_output_rejects_unknown_fields() {
    let node = Fake::new()
        .json(route::PAYMENTS_BALANCE, r#"{"balance_msat":1}"#)
        .json(route::PAYMENTS_CHANNELS, "[]");
    let done = dispatch(
        &node,
        ToolCall::Balance {
            input: BalanceInput {},
        },
    );
    let mut value = serde_json::to_value(&done.output).expect("json");
    value
        .as_object_mut()
        .expect("object")
        .insert("memo".to_string(), json!(CANARY));
    let err = serde_json::from_value::<ToolOutput>(value);
    assert!(err.is_err());
}

#[test]
fn a_full_dispatch_only_reads_allowlisted_gets() {
    let node = Fake::new()
        .json(route::PAYMENTS_BALANCE, r#"{"balance_msat":1}"#)
        .json(route::PAYMENTS_CHANNELS, "[]")
        .json(
            route::HEALTH,
            r#"{"status":"ok","connected_peers":0,"e2ee_sessions":0,"pending_deliveries":0,"lightning_available":false,"lightning_payment_capable":false,"uptime_secs":1,"version":2,"lightning_backend":"mock","chain_backend":"mock"}"#,
        )
        .json(route::MESSAGES, "[]")
        .json(
            route::OWN_PRICING,
            r#"{"mode":"static","prices":{},"block_height":10,"valid_blocks":144,"trust_level":"spv","difficulty_epoch_position":10,"peer_tables_cached":0}"#,
        );
    for call in calls() {
        let _ = dispatch(&node, call);
    }
    let seen = node.seen();
    assert!(seen.len() >= 5);
    for route in &seen {
        assert_eq!(route.target().method, "GET");
        assert!(ALLOWED_PATHS.contains(&route.target().path));
    }
}

#[test]
fn forbidden_output_keys_are_absent_from_a_hostile_success_page() {
    let body = format!(
        r#"[{{"id":"c","kind":1,"sender":"{SENDER}","recipient":"b","timestamp":1,"ciphertext":"CANARY_9f3e2a","payment_amount_msat":1,"payment_hash":"CANARY_9f3e2a","plaintext":"CANARY_9f3e2a"}}]"#
    );
    // id "c" is not 64 hex, but id is not copied. sender is valid.
    // Wait, the message decodes. id can be any string. Good.
    let node = Fake::new().json(route::MESSAGES, &body);
    let done = dispatch(
        &node,
        ToolCall::MessageCounts {
            input: MessageCountsInput { limit: 2 },
        },
    );
    assert_no_canary(&done, body);
    let keys = json_keys(&serde_json::to_value(&done.output).expect("json"));
    for forbidden in [
        "plaintext",
        "ciphertext",
        "outbound_note",
        "memo",
        "preimage",
        "body",
        "snippet",
        "error",
        "bolt11",
        "description",
        "mnemonic",
        "payment_hash",
        "peer_pubkey",
        "recipient",
    ] {
        assert!(
            !keys.iter().any(|key| key == forbidden),
            "{forbidden} in {keys:?}"
        );
    }
}

#[test]
fn extra_response_fields_decode_and_the_canary_stays_out() {
    let balance =
        r#"{"balance_msat":2500,"memo":"CANARY_9f3e2a","nested":{"preimage":"CANARY_9f3e2a"}}"#;
    let channels = format!(
        r#"[{{"channel_id":"7","peer_pubkey":"{PUBKEY}","capacity_msat":1000,"local_balance_msat":400,"remote_balance_msat":60,"active":true,"short_channel_id":"1x2x3","memo":"CANARY_9f3e2a","nested":{{"preimage":"CANARY_9f3e2a"}}}}]"#
    );
    let health = r#"{"status":"ok","connected_peers":1,"e2ee_sessions":0,"pending_deliveries":0,"lightning_available":true,"lightning_payment_capable":true,"uptime_secs":3,"version":2,"lightning_backend":"lnd","chain_backend":"esplora","block_height":100,"memo":"CANARY_9f3e2a","nested":{"plaintext":"CANARY_9f3e2a"}}"#;
    let messages = format!(
        r#"[{{"id":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","kind":1,"sender":"{SENDER}","recipient":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","timestamp":1,"ciphertext":"CANARY_9f3e2a","payment_amount_msat":1,"payment_hash":"CANARY_9f3e2a","memo":"CANARY_9f3e2a","preimage":"CANARY_9f3e2a","nested":{{"body":"CANARY_9f3e2a"}}}}]"#
    );
    let pricing = r#"{"mode":"static","prices":{"communication":9},"block_height":10,"valid_blocks":72,"trust_level":"spv","difficulty_epoch_position":1,"peer_tables_cached":0,"memo":"CANARY_9f3e2a","fee_rates_by_target":{"6":{"raw_sat_per_vbyte":1.0,"ema_sat_per_vbyte":1.0,"preimage":"CANARY_9f3e2a"}},"nested":{"plaintext":"CANARY_9f3e2a"}}"#;
    let node = Fake::new()
        .json(route::PAYMENTS_BALANCE, balance)
        .json(route::PAYMENTS_CHANNELS, &channels)
        .json(route::HEALTH, health)
        .json(route::MESSAGES, &messages)
        .json(route::OWN_PRICING, pricing);
    let fixture = format!("{balance}{channels}{health}{messages}{pricing}");
    for call in calls() {
        let done = dispatch(&node, call);
        assert!(
            matches!(
                &done.output,
                ToolOutput::Balance {
                    report: Report::Ready { .. }
                } | ToolOutput::Channels {
                    report: Report::Ready { .. }
                } | ToolOutput::Health {
                    report: Report::Ready { .. }
                } | ToolOutput::MessageCounts {
                    report: Report::Ready { .. }
                } | ToolOutput::LocalPrices {
                    report: Report::Ready { .. }
                }
            ),
            "{:?}",
            done.output
        );
        assert_no_canary(&done, &fixture);
    }
    let balance_done = dispatch(
        &node,
        ToolCall::Balance {
            input: BalanceInput {},
        },
    );
    let ToolOutput::Balance {
        report: Report::Ready { value },
    } = &balance_done.output
    else {
        panic!("{:?}", balance_done.output);
    };
    assert_eq!(value.label, WalletBalanceLabel::LndChannelBalance);
    assert!(matches!(
        value.wallet_balance,
        Amount::Available { value: 2500, .. }
    ));
}

#[test]
fn wallet_label_follows_the_lightning_backend() {
    let cases = [
        ("ldk", WalletBalanceLabel::LdkOnchainPlusLightning),
        ("lnd", WalletBalanceLabel::LndChannelBalance),
        ("lnbits", WalletBalanceLabel::NodeReported),
        ("mock", WalletBalanceLabel::NodeReported),
        ("void", WalletBalanceLabel::NodeReported),
        ("CANARY_9f3e2a", WalletBalanceLabel::NodeReported),
    ];
    for (backend, label) in cases {
        let health = health_body(backend);
        let node = Fake::new()
            .json(route::PAYMENTS_BALANCE, r#"{"balance_msat":2500}"#)
            .json(route::PAYMENTS_CHANNELS, channels_body())
            .json(route::HEALTH, &health);
        let done = dispatch(
            &node,
            ToolCall::Balance {
                input: BalanceInput {},
            },
        );
        if health.contains(CANARY) {
            assert_no_canary(&done, &health);
        }
        let ToolOutput::Balance {
            report: Report::Ready { value },
        } = &done.output
        else {
            panic!("{:?}", done.output);
        };
        assert_eq!(value.label, label, "{backend}");
        assert!(matches!(
            value.wallet_balance,
            Amount::Available { value: 2500, .. }
        ));
    }
}

#[test]
fn a_failed_health_read_does_not_claim_wallet_contents() {
    let node = Fake::new()
        .json(route::PAYMENTS_BALANCE, r#"{"balance_msat":2500}"#)
        .json(route::PAYMENTS_CHANNELS, channels_body())
        .http(route::HEALTH, 500, ERROR_BODY);
    let done = dispatch(
        &node,
        ToolCall::Balance {
            input: BalanceInput {},
        },
    );
    assert_no_canary(&done, ERROR_BODY);
    let ToolOutput::Balance {
        report: Report::Ready { value },
    } = &done.output
    else {
        panic!("{:?}", done.output);
    };
    assert_eq!(value.label, WalletBalanceLabel::NodeReported);
    assert!(matches!(
        value.wallet_balance,
        Amount::Available { value: 2500, .. }
    ));
    let output = serde_json::to_value(&done.output).expect("json");
    assert_reasons_carry_no_payload(&output);
    assert_no_json_number(&output, 500);
    assert!(done.log.iter().any(|entry| {
        entry.path == route::HEALTH && matches!(entry.outcome, LogOutcome::Http { status: 500 })
    }));
}

const _: fn() = || {
    // `Dispatch` must not implement `Serialize`. If it does, both impls apply
    // and this method resolution fails to compile. The model bytes are
    // [`Dispatch::output`] only.
    trait AmbiguousIfImpl<A> {
        fn some_item() {}
    }
    impl<T: ?Sized> AmbiguousIfImpl<()> for T {}
    impl<T: ?Sized + serde::Serialize> AmbiguousIfImpl<u8> for T {}
    let _ = <super::Dispatch as AmbiguousIfImpl<_>>::some_item;
};

#[test]
fn only_dispatch_output_reaches_the_model() {
    let node = Fake::new()
        .json(route::PAYMENTS_BALANCE, r#"{"balance_msat":2500}"#)
        .json(route::PAYMENTS_CHANNELS, channels_body())
        .json(route::HEALTH, &health_body("ldk"));
    let done = dispatch(
        &node,
        ToolCall::Balance {
            input: BalanceInput {},
        },
    );
    let model = serde_json::to_string(done.output()).expect("json");
    assert!(model.contains("2500"), "{model}");
    assert!(!model.contains("/api/v1/"), "{model}");
    assert!(!model.contains("outcome"), "{model}");
    let host = format!("{:?}", done.log);
    assert!(host.contains("/api/v1/payments/balance"), "{host}");
    assert!(!model.contains("payments/balance"), "{model}");
}

fn assert_no_json_number(value: &Value, forbidden: u64) {
    match value {
        Value::Number(number) => {
            assert_ne!(number.as_u64(), Some(forbidden), "{value}");
        }
        Value::Object(map) => {
            for child in map.values() {
                assert_no_json_number(child, forbidden);
            }
        }
        Value::Array(items) => {
            for child in items {
                assert_no_json_number(child, forbidden);
            }
        }
        Value::Null | Value::Bool(_) | Value::String(_) => {}
    }
}

fn assert_reasons_carry_no_payload(value: &Value) {
    match value {
        Value::Object(map) => {
            if let Some(kind) = map.get("kind").and_then(Value::as_str) {
                match kind {
                    "timeout" | "upstream_error" | "malformed" | "absent" | "stale"
                    | "overflow" => {
                        assert_eq!(map.len(), 1, "reason carries a payload: {map:?}");
                    }
                    _ => {}
                }
            }
            for child in map.values() {
                assert_reasons_carry_no_payload(child);
            }
        }
        Value::Array(items) => {
            for child in items {
                assert_reasons_carry_no_payload(child);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
    }
}

fn json_keys(value: &Value) -> Vec<String> {
    let mut keys = Vec::new();
    collect_keys(value, &mut keys);
    keys
}

fn collect_keys(value: &Value, keys: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                keys.push(key.clone());
                collect_keys(child, keys);
            }
        }
        Value::Array(items) => {
            for child in items {
                collect_keys(child, keys);
            }
        }
        _ => {}
    }
}
