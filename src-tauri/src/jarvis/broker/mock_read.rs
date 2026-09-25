//! In-process mock-node adapter for broker tests.
//!
//! Not a Tauri command and not linked into the app binary. A stale exchange
//! becomes [`super::ReadFault::Stale`] with the body dropped, so a zero decoy
//! cannot be decoded as a balance.

use std::fmt;
use std::fs;

use mock_node::{
    balance_msat, paths, AnswerKey, Fault, MockNode, Route, CANARIES, SENDER_A, SENDER_B,
};
use serde::Deserialize;
use serde_json::Value;

use super::route::ReadRoute;
use super::schema::{
    Amount, BalanceInput, BalanceReport, ChannelsInput, ChannelsReport, HealthInput, HealthReport,
    LocalPrices, LocalPricesInput, MessageCountsInput, MessageMetadata, PriceCategory, Report,
    SourceField, ToolCall, ToolOutput, UnavailableReason, Unit,
};
use super::{Broker, Dispatch, LogOutcome, NodeRead, RawRead, ReadFault};

struct MockRead {
    node: MockNode,
}

impl MockRead {
    fn new(node: MockNode) -> Self {
        Self { node }
    }
}

impl fmt::Debug for MockRead {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MockRead")
    }
}

impl NodeRead for MockRead {
    fn read(&self, route: ReadRoute) -> Result<RawRead, ReadFault> {
        let exchange = self.node.serve(&request_path(route));
        if exchange.timed_out {
            return Err(ReadFault::Transport);
        }
        if exchange.stale {
            return Err(ReadFault::Stale);
        }
        let body = match exchange.body {
            Some(body) => serde_json::to_vec(&body).expect("exchange json"),
            None => Vec::new(),
        };
        Ok(RawRead::new(exchange.status, body))
    }
}

fn request_path(route: ReadRoute) -> String {
    let target = route.target();
    match target.query {
        Some(query) => format!("{}?{}={}", target.path, query.key, query.value),
        None => target.path.to_string(),
    }
}

fn exec(node: &MockRead, call: ToolCall) -> Dispatch {
    Broker::new()
        .expect("allowlist")
        .dispatch(node, call)
        .expect("call")
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
            input: MessageCountsInput::default(),
        },
        ToolCall::LocalPrices {
            input: LocalPricesInput {},
        },
    ]
}

fn balance_call() -> ToolCall {
    ToolCall::Balance {
        input: BalanceInput {},
    }
}

fn channels_call() -> ToolCall {
    ToolCall::Channels {
        input: ChannelsInput {},
    }
}

fn health_call() -> ToolCall {
    ToolCall::Health {
        input: HealthInput {},
    }
}

fn messages_call() -> ToolCall {
    ToolCall::MessageCounts {
        input: MessageCountsInput::default(),
    }
}

fn prices_call() -> ToolCall {
    ToolCall::LocalPrices {
        input: LocalPricesInput {},
    }
}

/// Fixture-positive questions the broker still does not answer.
///
/// q20 is the stored mailbox total. The incoming page omits mail this node
/// sent, and `returned_count` is that page, not the total. q27 is only
/// `GET /payments/price/:kind`. q32 is only `GET /peers`. q24 reads the
/// `sent_to` row for one peer. q25 reads `chat_count`.
const EXPECTED_UNAVAILABLE: &[&str] = &["q20", "q27", "q32"];

const BROKER_ROUTES: [Route; 5] = [
    Route::Health,
    Route::PaymentsBalance,
    Route::PaymentsChannels,
    Route::Messages,
    Route::Pricing,
];

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Fixture {
    pin: String,
    source: String,
    rule: String,
    questions: Vec<Question>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Question {
    id: String,
    question: String,
    expected: String,
    unit: String,
    sources: Vec<String>,
    class: Class,
    key: AnswerKey,
    #[serde(default)]
    faults: Option<Vec<FaultSpec>>,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Class {
    Positive,
    Unavailable,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FaultSpec {
    route: Route,
    mode: Fault,
}

fn load_fixture() -> Fixture {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../jarvis/fixtures/questions.json"
    );
    serde_json::from_str(&fs::read_to_string(path).expect("fixture")).expect("fixture json")
}

fn node_for(question: &Question) -> MockRead {
    let mut node = MockNode::canonical();
    if let Some(faults) = &question.faults {
        for fault in faults {
            node = node.fault(fault.route, fault.mode);
        }
    }
    MockRead::new(node)
}

fn fault_reason(question: &Question) -> Option<UnavailableReason> {
    let faults = question.faults.as_ref()?;
    let mode = faults[0].mode;
    assert!(
        faults.iter().all(|fault| fault.mode == mode),
        "{}",
        question.id
    );
    Some(match mode {
        Fault::Error => UnavailableReason::UpstreamError,
        Fault::Timeout => UnavailableReason::Timeout,
        Fault::Stale => UnavailableReason::Stale,
        Fault::None => panic!("{} names a cleared route", question.id),
    })
}

fn truth(question: &Question) -> String {
    MockNode::canonical()
        .answer(question.key)
        .as_str()
        .to_string()
}

#[test]
fn adapter_drops_a_stale_body_and_keeps_a_fresh_balance() {
    let stale = MockRead::new(MockNode::canonical().fault(Route::PaymentsBalance, Fault::Stale));
    let err = stale.read(ReadRoute::PaymentsBalance).expect_err("stale");
    assert_eq!(err, ReadFault::Stale);
    assert_eq!(format!("{err:?}"), "Stale");

    let timeout =
        MockRead::new(MockNode::canonical().fault(Route::PaymentsChannels, Fault::Timeout));
    assert_eq!(
        timeout
            .read(ReadRoute::PaymentsChannels)
            .expect_err("timeout"),
        ReadFault::Transport
    );

    let error = MockRead::new(MockNode::canonical().fault(Route::Health, Fault::Error));
    let raw = error.read(ReadRoute::Health).expect("error status");
    assert_eq!(raw.status, 500);
    assert!(!format!("{raw:?}").contains("JARVIS_CANARY"));

    let fresh = MockRead::new(MockNode::canonical());
    let raw = fresh
        .read(ReadRoute::PaymentsBalance)
        .expect("fresh balance");
    assert_eq!(raw.status, 200);
    let body: Value = serde_json::from_slice(&raw.body).expect("json");
    assert_eq!(body["balance_msat"], serde_json::json!(balance_msat()));
}

#[test]
fn one_stale_route_leaves_the_other_tool_fresh() {
    // Balance route stale, channels fresh. The wallet figure is stale. The
    // channels tool, which never read the balance route, stays ready.
    let read = MockRead::new(MockNode::canonical().fault(Route::PaymentsBalance, Fault::Stale));
    let balance = exec(&read, balance_call());
    let channels = exec(&read, channels_call());
    match &balance.output {
        ToolOutput::Balance {
            report: Report::Ready { value },
        } => {
            assert!(matches!(
                value.wallet_balance,
                Amount::Unavailable {
                    reason: UnavailableReason::Stale,
                    unit: Unit::Msat,
                    source_field: SourceField::BalanceMsat,
                }
            ));
            let wallet = serde_json::to_value(&value.wallet_balance).expect("json");
            assert!(wallet.get("value").is_none(), "{wallet}");
            assert_eq!(wallet["reason"]["kind"], "stale");
            assert_json_omits_u64(&wallet, balance_msat());
            assert!(matches!(
                value.channel_local_balance,
                Amount::Available { .. }
            ));
        }
        other => panic!("{other:?}"),
    }
    assert!(balance
        .log
        .iter()
        .any(|entry| { entry.path == paths::BALANCE && entry.outcome == LogOutcome::Stale }));
    match &channels.output {
        ToolOutput::Channels {
            report: Report::Ready { value },
        } => {
            assert!(matches!(
                value.count,
                Amount::Available {
                    value: 3,
                    unit: Unit::Count,
                    source_field: SourceField::ChannelId,
                }
            ));
            assert!(matches!(
                value.channels[0].local_balance,
                Amount::Available { value: 500_000, .. }
            ));
        }
        other => panic!("{other:?}"),
    }
    assert!(channels
        .log
        .iter()
        .all(|entry| entry.outcome == LogOutcome::Ready));

    // Channels route stale, health fresh. The channels tool is entirely
    // stale. Health never read that route and keeps its peer count.
    let read = MockRead::new(MockNode::canonical().fault(Route::PaymentsChannels, Fault::Stale));
    let channels = exec(&read, channels_call());
    let health = exec(&read, health_call());
    assert_eq!(report_reason(&channels.output), UnavailableReason::Stale);
    let stale = serde_json::to_value(&channels.output).expect("json");
    assert_no_numbers(&stale);
    assert!(channels
        .log
        .iter()
        .all(|entry| entry.outcome == LogOutcome::Stale));
    match &health.output {
        ToolOutput::Health {
            report: Report::Ready { value },
        } => {
            assert!(matches!(
                value.connected_peers,
                Amount::Available {
                    value: 2,
                    unit: Unit::Count,
                    source_field: SourceField::ConnectedPeers,
                }
            ));
        }
        other => panic!("{other:?}"),
    }
    assert!(health
        .log
        .iter()
        .all(|entry| entry.outcome == LogOutcome::Ready));
}

#[test]
fn stale_is_stale_with_no_number_on_every_tool() {
    let mut node = MockNode::canonical();
    for route in BROKER_ROUTES {
        node = node.fault(route, Fault::Stale);
    }
    let read = MockRead::new(node);
    for call in calls() {
        let done = exec(&read, call);
        assert_eq!(report_reason(&done.output), UnavailableReason::Stale);
        let value = serde_json::to_value(&done.output).expect("json");
        assert_no_numbers(&value);
        let rendered = serde_json::to_string(&done.output).expect("json");
        assert!(rendered.contains("\"kind\":\"stale\""), "{rendered}");
        assert!(!rendered.contains("\"value\""), "{rendered}");
        assert!(!done.log.is_empty());
        assert!(done
            .log
            .iter()
            .all(|entry| entry.outcome == LogOutcome::Stale));
    }
}

#[test]
fn fixture_questions_match_broker_tools() {
    let fixture = load_fixture();
    assert_eq!(fixture.pin, "v0.3.0-rc7");
    assert_eq!(fixture.source, "958e3997f9969497c1d270f557282b9bb591fe85");
    assert!(fixture.rule.contains("unavailable"));
    assert_eq!(fixture.questions.len(), 50);

    let mut gaps = Vec::new();
    for (index, question) in fixture.questions.iter().enumerate() {
        assert_eq!(question.id, format!("q{:02}", index + 1));
        assert!(!question.question.is_empty());
        assert!(!question.sources.is_empty());
        if question.class == Class::Positive {
            assert_eq!(truth(question), question.expected, "{}", question.id);
        }
        if answered_as_gap(question) {
            gaps.push(question.id.as_str());
        }
        assert_question(question);
    }
    assert_eq!(gaps, EXPECTED_UNAVAILABLE);
}

fn answered_as_gap(question: &Question) -> bool {
    question.class == Class::Positive
        && matches!(
            question.key,
            AnswerKey::MessageCount | AnswerKey::PriceLongformMsat | AnswerKey::PeerCount
        )
}

fn assert_question(question: &Question) {
    let read = node_for(question);
    let fault = fault_reason(question);
    match question.key {
        AnswerKey::FirstChannelLocalMsat => {
            let done = exec(&read, channels_call());
            if let Some(reason) = fault {
                assert_down(&done, reason, question);
            } else {
                let report = ready_channels(&done, question);
                assert_u64(
                    &report.channels[0].local_balance,
                    question,
                    Unit::Msat,
                    SourceField::LocalBalanceMsat,
                    "msat",
                );
            }
        }
        AnswerKey::TotalBalanceMsat => {
            let done = exec(&read, balance_call());
            let report = ready_balance(&done, question);
            if let Some(reason) = fault {
                assert_amount_down(
                    &report.wallet_balance,
                    reason,
                    Unit::Msat,
                    SourceField::BalanceMsat,
                    question,
                );
                assert_json_omits_u64(
                    &serde_json::to_value(&done.output).expect("json"),
                    truth(question).parse().expect("balance"),
                );
            } else {
                assert_u64(
                    &report.wallet_balance,
                    question,
                    Unit::Msat,
                    SourceField::BalanceMsat,
                    "msat",
                );
            }
        }
        AnswerKey::ChannelLocalMsat => assert_channel_sum(
            &read,
            fault,
            question,
            |report| &report.channel_local_balance,
            SourceField::LocalBalanceMsat,
        ),
        AnswerKey::ChannelRemoteMsat => assert_channel_sum(
            &read,
            fault,
            question,
            |report| &report.channel_remote_balance,
            SourceField::RemoteBalanceMsat,
        ),
        AnswerKey::ChannelCapacityMsat => assert_channel_sum(
            &read,
            fault,
            question,
            |report| &report.channel_capacity,
            SourceField::CapacityMsat,
        ),
        AnswerKey::ChannelCount => {
            let done = exec(&read, channels_call());
            if let Some(reason) = fault {
                assert_down(&done, reason, question);
            } else {
                let report = ready_channels(&done, question);
                assert_u64(
                    &report.count,
                    question,
                    Unit::Count,
                    SourceField::ChannelId,
                    "channels",
                );
            }
        }
        AnswerKey::ChannelActiveCount => {
            let done = exec(&read, channels_call());
            if let Some(reason) = fault {
                assert_down(&done, reason, question);
            } else {
                let report = ready_channels(&done, question);
                assert_u64(
                    &report.active_count,
                    question,
                    Unit::Count,
                    SourceField::Active,
                    "channels",
                );
            }
        }
        AnswerKey::ChannelInactiveCount => {
            let done = exec(&read, channels_call());
            if let Some(reason) = fault {
                assert_down(&done, reason, question);
            } else {
                let report = ready_channels(&done, question);
                assert_eq!(question.unit, "channels", "{}", question.id);
                let count =
                    available_u64(&report.count, Unit::Count, SourceField::ChannelId, question);
                let active = available_u64(
                    &report.active_count,
                    Unit::Count,
                    SourceField::Active,
                    question,
                );
                assert_eq!(
                    (count - active).to_string(),
                    question.expected,
                    "{}",
                    question.id
                );
                let flagged = report
                    .channels
                    .iter()
                    .filter(|channel| !channel.active)
                    .count();
                assert_eq!(flagged.to_string(), question.expected, "{}", question.id);
            }
        }
        AnswerKey::HealthStatus => check_health(&read, fault, question, |report| {
            assert_eq!(question.unit, "status", "{}", question.id);
            assert_eq!(question.expected, "ok", "{}", question.id);
            assert_eq!(report.liveness, super::schema::Liveness::Ok);
            assert!(question
                .sources
                .iter()
                .any(|source| source.ends_with("status")));
        }),
        AnswerKey::ConnectedPeers => check_health_amount(
            &read,
            fault,
            question,
            |report| &report.connected_peers,
            Unit::Count,
            SourceField::ConnectedPeers,
            "peers",
        ),
        AnswerKey::E2eeSessions => check_health_amount(
            &read,
            fault,
            question,
            |report| &report.e2ee_sessions,
            Unit::Count,
            SourceField::E2eeSessions,
            "sessions",
        ),
        AnswerKey::PendingDeliveries => check_health_amount(
            &read,
            fault,
            question,
            |report| &report.pending_deliveries,
            Unit::Count,
            SourceField::PendingDeliveries,
            "messages",
        ),
        AnswerKey::LightningAvailable => check_health(&read, fault, question, |report| {
            assert_eq!(question.unit, "bool", "{}", question.id);
            assert_eq!(report.lightning_available.to_string(), question.expected);
            assert!(question
                .sources
                .iter()
                .any(|source| source.ends_with("lightning_available")));
        }),
        AnswerKey::LightningPaymentCapable => check_health(&read, fault, question, |report| {
            assert_eq!(question.unit, "bool", "{}", question.id);
            assert_eq!(
                report.lightning_payment_capable.to_string(),
                question.expected
            );
            assert!(question
                .sources
                .iter()
                .any(|source| source.ends_with("lightning_payment_capable")));
        }),
        AnswerKey::UptimeSecs => check_health_amount(
            &read,
            fault,
            question,
            |report| &report.uptime,
            Unit::Seconds,
            SourceField::UptimeSecs,
            "seconds",
        ),
        AnswerKey::ProtocolVersion => check_health_amount(
            &read,
            fault,
            question,
            |report| &report.version,
            Unit::ProtocolVersion,
            SourceField::Version,
            "version",
        ),
        AnswerKey::BlockHeight => {
            let health = exec(&read, health_call());
            let prices = exec(&read, prices_call());
            if let Some(reason) = fault {
                assert_down(&health, reason, question);
                assert_down(&prices, reason, question);
            } else {
                let health = ready_health(&health, question);
                let prices = ready_prices(&prices, question);
                assert_u64(
                    &health.block_height,
                    question,
                    Unit::Blocks,
                    SourceField::BlockHeight,
                    "blocks",
                );
                assert_u64(
                    &prices.block_height,
                    question,
                    Unit::Blocks,
                    SourceField::BlockHeight,
                    "blocks",
                );
            }
        }
        AnswerKey::LightningBackend => check_health(&read, fault, question, |report| {
            assert_eq!(question.unit, "name", "{}", question.id);
            assert_eq!(question.expected, "ldk");
            assert_eq!(
                report.lightning_backend,
                super::schema::LightningBackend::Ldk
            );
            assert!(question
                .sources
                .iter()
                .any(|source| source.ends_with("lightning_backend")));
        }),
        AnswerKey::ChainBackend => check_health(&read, fault, question, |report| {
            assert_eq!(question.unit, "name", "{}", question.id);
            assert_eq!(question.expected, "esplora");
            assert_eq!(report.chain_backend, super::schema::ChainBackend::Esplora);
            assert!(question
                .sources
                .iter()
                .any(|source| source.ends_with("chain_backend")));
        }),
        AnswerKey::MessageCount => {
            let done = exec(&read, messages_call());
            if let Some(reason) = fault {
                assert_down(&done, reason, question);
            } else {
                assert_gap_id(question);
                let report = ready_messages(&done, question);
                let returned = available_u64(
                    &report.returned_count,
                    Unit::Count,
                    SourceField::Messages,
                    question,
                );
                assert_ne!(
                    returned.to_string(),
                    question.expected,
                    "{} page count is not the mailbox total",
                    question.id
                );
                assert_eq!(
                    unanswered(&done.output),
                    UnavailableReason::Absent,
                    "{}",
                    question.id
                );
            }
        }
        AnswerKey::DistinctSenders => {
            let done = exec(&read, messages_call());
            if let Some(reason) = fault {
                assert_down(&done, reason, question);
            } else {
                let report = ready_messages(&done, question);
                assert_eq!(question.unit, "senders", "{}", question.id);
                assert_eq!(report.senders.len().to_string(), question.expected);
                for row in &report.senders {
                    available_u64(&row.count, Unit::Count, SourceField::Sender, question);
                }
            }
        }
        AnswerKey::MessagesFromA => assert_sender(&read, fault, question, SENDER_A),
        AnswerKey::MessagesFromB => assert_sender(&read, fault, question, SENDER_B),
        AnswerKey::MessagesSent => {
            let done = exec(&read, messages_call());
            if let Some(reason) = fault {
                assert_down(&done, reason, question);
            } else {
                let report = ready_messages(&done, question);
                let row = report
                    .sent_to
                    .iter()
                    .find(|row| row.peer == SENDER_A)
                    .unwrap_or_else(|| {
                        panic!("{} missing sent mail to the asked peer", question.id)
                    });
                assert_u64(
                    &row.count,
                    question,
                    Unit::Count,
                    SourceField::Messages,
                    "messages",
                );
                let mut total = 0u64;
                for row in &report.sent_to {
                    assert_eq!(row.peer.len(), 64, "{}", question.id);
                    assert!(
                        row.peer.bytes().all(|byte| byte.is_ascii_hexdigit()),
                        "{}",
                        question.id
                    );
                    total +=
                        available_u64(&row.count, Unit::Count, SourceField::Messages, question);
                }
                assert!(
                    report.sent_to.iter().any(|row| row.peer == SENDER_B),
                    "{} fixture must include sent mail to a second peer",
                    question.id
                );
                assert_ne!(
                    total.to_string(),
                    question.expected,
                    "{} is one conversation; a mailbox-wide sent count is {total}",
                    question.id
                );
                assert_message_bodies_withheld(&done, question);
            }
        }
        AnswerKey::ChatMessageCount => {
            let done = exec(&read, messages_call());
            if let Some(reason) = fault {
                assert_down(&done, reason, question);
            } else {
                let report = ready_messages(&done, question);
                assert_u64(
                    &report.chat_count,
                    question,
                    Unit::Count,
                    SourceField::Messages,
                    "messages",
                );
                assert_message_bodies_withheld(&done, question);
            }
        }
        AnswerKey::PriceChatMsat => {
            assert_category(&read, fault, question, PriceCategory::Communication)
        }
        AnswerKey::PriceLongformMsat => {
            assert!(fault.is_none(), "{}", question.id);
            assert_gap_id(question);
            let done = exec(&read, prices_call());
            let report = ready_prices(&done, question);
            let forbidden: u64 = question.expected.parse().expect("price");
            for price in &report.prices {
                if let Amount::Available { value, .. } = price.price {
                    assert_ne!(value, forbidden, "{}", question.id);
                }
            }
            assert!(done.log.iter().all(|entry| !entry.path.contains("price/")));
            assert_eq!(
                unanswered(&done.output),
                UnavailableReason::Absent,
                "{}",
                question.id
            );
            assert_no_available_u64(
                &serde_json::to_value(&done.output).expect("json"),
                forbidden,
            );
        }
        AnswerKey::PriceFileMsat => {
            assert_category(&read, fault, question, PriceCategory::FilesMedia)
        }
        AnswerKey::PriceCalendarMsat => {
            assert_category(&read, fault, question, PriceCategory::StructuredData)
        }
        AnswerKey::PriceCommunicationMsat => {
            assert_category(&read, fault, question, PriceCategory::Communication)
        }
        AnswerKey::PricingMode => {
            let done = exec(&read, prices_call());
            if let Some(reason) = fault {
                assert_down(&done, reason, question);
            } else {
                let report = ready_prices(&done, question);
                assert_eq!(question.unit, "mode", "{}", question.id);
                assert_eq!(question.expected, "static");
                assert_eq!(report.mode, super::schema::PricingMode::Static);
                assert!(question
                    .sources
                    .iter()
                    .any(|source| source.ends_with("mode")));
            }
        }
        AnswerKey::PeerCount => {
            // `GET /peers` is not a broker route. q32 has no fault. q43 times
            // that route out. The broker does not invent Timeout from a call
            // it never made: the contact count is Unavailable(Absent).
            if question.class == Class::Positive {
                assert_gap_id(question);
            } else {
                assert_eq!(fault, Some(UnavailableReason::Timeout), "{}", question.id);
            }
            let forbidden: u64 = truth(question).parse().expect("peer count");
            for call in calls() {
                let done = exec(&read, call);
                assert_eq!(
                    unanswered(&done.output),
                    UnavailableReason::Absent,
                    "{}",
                    question.id
                );
                assert_no_available_u64(
                    &serde_json::to_value(&done.output).expect("json"),
                    forbidden,
                );
                assert!(done.log.iter().all(|entry| entry.path != paths::PEERS));
            }
        }
    }
}

/// Why a figure the broker does not report is unavailable.
///
/// A down report keeps that fault. A ready report has no such figure, so the
/// reason is [`UnavailableReason::Absent`] rather than a missing JSON key.
fn unanswered(output: &ToolOutput) -> UnavailableReason {
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
        ToolOutput::Balance {
            report: Report::Ready { .. },
        }
        | ToolOutput::Channels {
            report: Report::Ready { .. },
        }
        | ToolOutput::Health {
            report: Report::Ready { .. },
        }
        | ToolOutput::MessageCounts {
            report: Report::Ready { .. },
        }
        | ToolOutput::LocalPrices {
            report: Report::Ready { .. },
        } => UnavailableReason::Absent,
    }
}

fn assert_message_bodies_withheld(done: &Dispatch, question: &Question) {
    let keys = json_keys(&serde_json::to_value(&done.output).expect("json"));
    for key in [
        "kind",
        "direction",
        "plaintext",
        "ciphertext",
        "outbound_note",
        "note",
    ] {
        assert!(
            !keys.iter().any(|found| found == key),
            "{key} in {keys:?} ({})",
            question.id
        );
    }
}

fn assert_gap_id(question: &Question) {
    assert!(
        EXPECTED_UNAVAILABLE.contains(&question.id.as_str()),
        "{}",
        question.id
    );
}

fn assert_channel_sum(
    read: &MockRead,
    fault: Option<UnavailableReason>,
    question: &Question,
    field: impl Fn(&BalanceReport) -> &Amount<u64>,
    source: SourceField,
) {
    let balance = exec(read, balance_call());
    let channels = exec(read, channels_call());
    if let Some(reason) = fault {
        let report = ready_balance(&balance, question);
        assert_amount_down(&field(report), reason, Unit::Msat, source, question);
        assert_down(&channels, reason, question);
    } else {
        let report = ready_balance(&balance, question);
        assert_u64(&field(report), question, Unit::Msat, source, "msat");
    }
}

fn assert_sender(
    read: &MockRead,
    fault: Option<UnavailableReason>,
    question: &Question,
    sender: &str,
) {
    let done = exec(read, messages_call());
    if let Some(reason) = fault {
        assert_down(&done, reason, question);
        return;
    }
    let report = ready_messages(&done, question);
    let row = report
        .senders
        .iter()
        .find(|row| row.sender == sender)
        .unwrap_or_else(|| panic!("{} missing sender", question.id));
    assert_u64(
        &row.count,
        question,
        Unit::Count,
        SourceField::Sender,
        "messages",
    );
}

fn assert_category(
    read: &MockRead,
    fault: Option<UnavailableReason>,
    question: &Question,
    category: PriceCategory,
) {
    let done = exec(read, prices_call());
    if let Some(reason) = fault {
        assert_down(&done, reason, question);
        return;
    }
    let report = ready_prices(&done, question);
    let price = report
        .prices
        .iter()
        .find(|price| price.category == category)
        .unwrap_or_else(|| panic!("{} missing {category:?}", question.id));
    assert_u64(
        &price.price,
        question,
        Unit::Msat,
        SourceField::Prices,
        "msat",
    );
}

fn check_health(
    read: &MockRead,
    fault: Option<UnavailableReason>,
    question: &Question,
    check: impl FnOnce(&HealthReport),
) {
    let done = exec(read, health_call());
    if let Some(reason) = fault {
        assert_down(&done, reason, question);
    } else {
        check(ready_health(&done, question));
    }
}

fn check_health_amount(
    read: &MockRead,
    fault: Option<UnavailableReason>,
    question: &Question,
    field: impl Fn(&HealthReport) -> &Amount<u64>,
    unit: Unit,
    source: SourceField,
    fixture_unit: &str,
) {
    check_health(read, fault, question, |report| {
        assert_u64(&field(report), question, unit, source, fixture_unit);
    });
}

fn assert_u64(
    amount: &Amount<u64>,
    question: &Question,
    unit: Unit,
    source: SourceField,
    fixture_unit: &str,
) {
    assert!(
        !EXPECTED_UNAVAILABLE.contains(&question.id.as_str()),
        "{}",
        question.id
    );
    assert_eq!(question.unit, fixture_unit, "{}", question.id);
    let value = available_u64(amount, unit, source, question);
    assert_eq!(value.to_string(), question.expected, "{}", question.id);
}

fn available_u64(
    amount: &Amount<u64>,
    unit: Unit,
    source: SourceField,
    question: &Question,
) -> u64 {
    match amount {
        Amount::Available {
            value,
            unit: got,
            source_field,
        } => {
            assert_eq!(*got, unit, "{}", question.id);
            assert_eq!(*source_field, source, "{}", question.id);
            *value
        }
        Amount::Unavailable { reason, .. } => panic!("{} unavailable {reason:?}", question.id),
    }
}

fn assert_amount_down(
    amount: &Amount<u64>,
    reason: UnavailableReason,
    unit: Unit,
    source: SourceField,
    question: &Question,
) {
    match amount {
        Amount::Unavailable {
            unit: got_unit,
            source_field,
            reason: got,
        } => {
            assert_eq!(*got, reason, "{}", question.id);
            assert_eq!(*got_unit, unit, "{}", question.id);
            assert_eq!(*source_field, source, "{}", question.id);
        }
        Amount::Available { value, .. } => panic!("{} surfaced {value}", question.id),
    }
    let value = serde_json::to_value(amount).expect("json");
    assert_no_numbers(&value);
    assert!(value.get("value").is_none(), "{value}");
}

fn assert_down(done: &Dispatch, reason: UnavailableReason, question: &Question) {
    assert_eq!(report_reason(&done.output), reason, "{}", question.id);
    let value = serde_json::to_value(&done.output).expect("json");
    assert_no_numbers(&value);
    let rendered = serde_json::to_string(&done.output).expect("json");
    assert!(
        rendered.contains(&format!("\"kind\":\"{}\"", reason_kind(reason))),
        "{rendered}"
    );
    assert!(!rendered.contains("\"value\""), "{rendered}");
    let fresh = truth(question);
    if let Ok(number) = fresh.parse::<u64>() {
        assert_json_omits_u64(&value, number);
    }
}

fn reason_kind(reason: UnavailableReason) -> &'static str {
    match reason {
        UnavailableReason::Timeout => "timeout",
        UnavailableReason::UpstreamError => "upstream_error",
        UnavailableReason::Malformed => "malformed",
        UnavailableReason::Absent => "absent",
        UnavailableReason::Stale => "stale",
        UnavailableReason::Overflow => "overflow",
    }
}

fn report_reason(output: &ToolOutput) -> UnavailableReason {
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

fn ready_balance<'a>(done: &'a Dispatch, question: &Question) -> &'a BalanceReport {
    match &done.output {
        ToolOutput::Balance {
            report: Report::Ready { value },
        } => value,
        other => panic!("{}: {other:?}", question.id),
    }
}

fn ready_channels<'a>(done: &'a Dispatch, question: &Question) -> &'a ChannelsReport {
    match &done.output {
        ToolOutput::Channels {
            report: Report::Ready { value },
        } => value,
        other => panic!("{}: {other:?}", question.id),
    }
}

fn ready_health<'a>(done: &'a Dispatch, question: &Question) -> &'a HealthReport {
    match &done.output {
        ToolOutput::Health {
            report: Report::Ready { value },
        } => value,
        other => panic!("{}: {other:?}", question.id),
    }
}

fn ready_messages<'a>(done: &'a Dispatch, question: &Question) -> &'a MessageMetadata {
    match &done.output {
        ToolOutput::MessageCounts {
            report: Report::Ready { value },
        } => value,
        other => panic!("{}: {other:?}", question.id),
    }
}

fn ready_prices<'a>(done: &'a Dispatch, question: &Question) -> &'a LocalPrices {
    match &done.output {
        ToolOutput::LocalPrices {
            report: Report::Ready { value },
        } => value,
        other => panic!("{}: {other:?}", question.id),
    }
}

fn assert_no_numbers(value: &Value) {
    match value {
        Value::Number(number) => panic!("number {number}"),
        Value::Object(map) => {
            for child in map.values() {
                assert_no_numbers(child);
            }
        }
        Value::Array(items) => {
            for child in items {
                assert_no_numbers(child);
            }
        }
        Value::Null | Value::Bool(_) | Value::String(_) => {}
    }
}

fn assert_json_omits_u64(value: &Value, forbidden: u64) {
    match value {
        Value::Number(number) => assert_ne!(number.as_u64(), Some(forbidden), "{value}"),
        Value::Object(map) => {
            for child in map.values() {
                assert_json_omits_u64(child, forbidden);
            }
        }
        Value::Array(items) => {
            for child in items {
                assert_json_omits_u64(child, forbidden);
            }
        }
        Value::Null | Value::Bool(_) | Value::String(_) => {}
    }
}

fn assert_no_available_u64(value: &Value, forbidden: u64) {
    match value {
        Value::Object(map) => {
            if map.get("state").and_then(Value::as_str) == Some("available") {
                if let Some(number) = map.get("value").and_then(Value::as_u64) {
                    assert_ne!(number, forbidden, "{map:?}");
                }
            }
            for child in map.values() {
                assert_no_available_u64(child, forbidden);
            }
        }
        Value::Array(items) => {
            for child in items {
                assert_no_available_u64(child, forbidden);
            }
        }
        _ => {}
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

#[test]
fn canary_sweep_covers_every_question_and_fault_mode() {
    assert!(CANARIES.len() >= 20, "{}", CANARIES.len());
    let fixture = load_fixture();
    assert_eq!(fixture.questions.len(), 50);
    for question in &fixture.questions {
        sweep(&node_for(question));
    }
    sweep(&MockRead::new(MockNode::canonical()));
    for mode in [Fault::Error, Fault::Timeout, Fault::Stale] {
        for route in Route::ALL {
            sweep(&MockRead::new(MockNode::canonical().fault(route, mode)));
        }
        let mut node = MockNode::canonical();
        for route in Route::ALL {
            node = node.fault(route, mode);
        }
        sweep(&MockRead::new(node));
    }
}

fn sweep(read: &MockRead) {
    for call in calls() {
        let done = exec(read, call);
        let rendered = format!(
            "{done:?}\n{}\n{:?}\n{:?}",
            serde_json::to_string(&done.output).expect("json"),
            done.output,
            done.log
        );
        for canary in CANARIES {
            assert!(!rendered.contains(canary), "{canary} in {rendered}");
        }
    }
}
