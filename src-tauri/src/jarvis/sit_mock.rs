//! Mock-only SIT reader: broker + in-process mock node over the 50-question fixture.
//!
//! No network, no node sidecar, no wallet, no Tauri window. A person runs:
//! `cargo run --example jarvis_sit_mock --features sit-mock` from `src-tauri/`.

use std::fmt;
use std::fs;

use mock_node::{AnswerKey, Fault, MockNode, Route, SENDER_A, SENDER_B};
use serde::Deserialize;

use super::broker::{
    Amount, BalanceInput, BalanceReport, Broker, ChainBackend, ChannelsInput, ChannelsReport,
    HealthInput, HealthReport, LightningBackend, Liveness, LocalPrices, LocalPricesInput,
    MessageCountsInput, MessageMetadata, NodeRead, PriceCategory, PricingMode, RawRead, ReadFault,
    ReadRoute, Report, ToolCall, ToolOutput,
};

const UNAVAILABLE: &str = "Unavailable";

/// Fixture-positive questions the broker still does not answer.
const BROKER_GAPS: &[&str] = &["q20", "q24", "q25", "q27", "q32"];

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

fn exec(node: &MockRead, call: ToolCall) -> ToolOutput {
    Broker::new()
        .expect("allowlist")
        .dispatch(node, call)
        .expect("call")
        .output()
        .clone()
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

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Fixture {
    #[allow(dead_code)]
    pin: String,
    #[allow(dead_code)]
    source: String,
    #[allow(dead_code)]
    rule: String,
    questions: Vec<Question>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Question {
    id: String,
    #[allow(dead_code)]
    question: String,
    #[allow(dead_code)]
    expected: String,
    #[allow(dead_code)]
    unit: String,
    #[allow(dead_code)]
    sources: Vec<String>,
    #[allow(dead_code)]
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

fn amount_u64(amount: &Amount<u64>) -> Option<u64> {
    match amount {
        Amount::Available { value, .. } => Some(*value),
        Amount::Unavailable { .. } => None,
    }
}

fn report_down(output: &ToolOutput) -> bool {
    matches!(
        output,
        ToolOutput::Balance {
            report: Report::Unavailable { .. },
        } | ToolOutput::Channels {
            report: Report::Unavailable { .. },
        } | ToolOutput::Health {
            report: Report::Unavailable { .. },
        } | ToolOutput::MessageCounts {
            report: Report::Unavailable { .. },
        } | ToolOutput::LocalPrices {
            report: Report::Unavailable { .. },
        }
    )
}

fn ready_balance(output: &ToolOutput) -> Option<&BalanceReport> {
    match output {
        ToolOutput::Balance {
            report: Report::Ready { value },
        } => Some(value),
        _ => None,
    }
}

fn ready_channels(output: &ToolOutput) -> Option<&ChannelsReport> {
    match output {
        ToolOutput::Channels {
            report: Report::Ready { value },
        } => Some(value),
        _ => None,
    }
}

fn ready_health(output: &ToolOutput) -> Option<&HealthReport> {
    match output {
        ToolOutput::Health {
            report: Report::Ready { value },
        } => Some(value),
        _ => None,
    }
}

fn ready_messages(output: &ToolOutput) -> Option<&MessageMetadata> {
    match output {
        ToolOutput::MessageCounts {
            report: Report::Ready { value },
        } => Some(value),
        _ => None,
    }
}

fn ready_prices(output: &ToolOutput) -> Option<&LocalPrices> {
    match output {
        ToolOutput::LocalPrices {
            report: Report::Ready { value },
        } => Some(value),
        _ => None,
    }
}

fn category_price(report: &LocalPrices, category: PriceCategory) -> Option<u64> {
    report
        .prices
        .iter()
        .find(|price| price.category == category)
        .and_then(|price| amount_u64(&price.price))
}

fn sender_count(report: &MessageMetadata, sender: &str) -> Option<u64> {
    report
        .senders
        .iter()
        .find(|row| row.sender == sender)
        .and_then(|row| amount_u64(&row.count))
}

/// Answer one fixture question through the in-process mock broker.
fn answer(question: &Question) -> String {
    if BROKER_GAPS.contains(&question.id.as_str()) {
        return UNAVAILABLE.to_string();
    }

    let read = node_for(question);
    match question.key {
        AnswerKey::FirstChannelLocalMsat => {
            let output = exec(&read, channels_call());
            ready_channels(&output)
                .and_then(|report| report.channels.first())
                .and_then(|channel| amount_u64(&channel.local_balance))
                .map(|value| value.to_string())
                .unwrap_or_else(|| UNAVAILABLE.to_string())
        }
        AnswerKey::TotalBalanceMsat => {
            let output = exec(&read, balance_call());
            ready_balance(&output)
                .and_then(|report| amount_u64(&report.wallet_balance))
                .map(|value| value.to_string())
                .unwrap_or_else(|| UNAVAILABLE.to_string())
        }
        AnswerKey::ChannelLocalMsat => channel_sum(&read, |report| &report.channel_local_balance),
        AnswerKey::ChannelRemoteMsat => {
            channel_sum(&read, |report| &report.channel_remote_balance)
        }
        AnswerKey::ChannelCapacityMsat => channel_sum(&read, |report| &report.channel_capacity),
        AnswerKey::ChannelCount => {
            let output = exec(&read, channels_call());
            ready_channels(&output)
                .and_then(|report| amount_u64(&report.count))
                .map(|value| value.to_string())
                .unwrap_or_else(|| UNAVAILABLE.to_string())
        }
        AnswerKey::ChannelActiveCount => {
            let output = exec(&read, channels_call());
            ready_channels(&output)
                .and_then(|report| amount_u64(&report.active_count))
                .map(|value| value.to_string())
                .unwrap_or_else(|| UNAVAILABLE.to_string())
        }
        AnswerKey::ChannelInactiveCount => {
            let output = exec(&read, channels_call());
            match ready_channels(&output) {
                Some(report) => {
                    let count = amount_u64(&report.count);
                    let active = amount_u64(&report.active_count);
                    match (count, active) {
                        (Some(count), Some(active)) => (count - active).to_string(),
                        _ => UNAVAILABLE.to_string(),
                    }
                }
                None => UNAVAILABLE.to_string(),
            }
        }
        AnswerKey::HealthStatus => {
            let output = exec(&read, health_call());
            match ready_health(&output) {
                Some(report) if report.liveness == Liveness::Ok => "ok".to_string(),
                Some(_) | None => UNAVAILABLE.to_string(),
            }
        }
        AnswerKey::ConnectedPeers => health_amount(&read, |report| &report.connected_peers),
        AnswerKey::E2eeSessions => health_amount(&read, |report| &report.e2ee_sessions),
        AnswerKey::PendingDeliveries => health_amount(&read, |report| &report.pending_deliveries),
        AnswerKey::LightningAvailable => {
            let output = exec(&read, health_call());
            ready_health(&output)
                .map(|report| report.lightning_available.to_string())
                .unwrap_or_else(|| UNAVAILABLE.to_string())
        }
        AnswerKey::LightningPaymentCapable => {
            let output = exec(&read, health_call());
            ready_health(&output)
                .map(|report| report.lightning_payment_capable.to_string())
                .unwrap_or_else(|| UNAVAILABLE.to_string())
        }
        AnswerKey::UptimeSecs => health_amount(&read, |report| &report.uptime),
        AnswerKey::ProtocolVersion => health_amount(&read, |report| &report.version),
        AnswerKey::BlockHeight => {
            let health = exec(&read, health_call());
            let prices = exec(&read, prices_call());
            if report_down(&health) || report_down(&prices) {
                return UNAVAILABLE.to_string();
            }
            ready_health(&health)
                .and_then(|report| amount_u64(&report.block_height))
                .map(|value| value.to_string())
                .unwrap_or_else(|| UNAVAILABLE.to_string())
        }
        AnswerKey::LightningBackend => {
            let output = exec(&read, health_call());
            match ready_health(&output) {
                Some(report) if report.lightning_backend == LightningBackend::Ldk => {
                    "ldk".to_string()
                }
                Some(_) | None => UNAVAILABLE.to_string(),
            }
        }
        AnswerKey::ChainBackend => {
            let output = exec(&read, health_call());
            match ready_health(&output) {
                Some(report) if report.chain_backend == ChainBackend::Esplora => {
                    "esplora".to_string()
                }
                Some(_) | None => UNAVAILABLE.to_string(),
            }
        }
        AnswerKey::MessageCount
        | AnswerKey::MessagesSent
        | AnswerKey::ChatMessageCount
        | AnswerKey::PriceLongformMsat
        | AnswerKey::PeerCount => UNAVAILABLE.to_string(),
        AnswerKey::DistinctSenders => {
            let output = exec(&read, messages_call());
            ready_messages(&output)
                .map(|report| report.senders.len().to_string())
                .unwrap_or_else(|| UNAVAILABLE.to_string())
        }
        AnswerKey::MessagesFromA => {
            let output = exec(&read, messages_call());
            ready_messages(&output)
                .and_then(|report| sender_count(report, SENDER_A))
                .map(|value| value.to_string())
                .unwrap_or_else(|| UNAVAILABLE.to_string())
        }
        AnswerKey::MessagesFromB => {
            let output = exec(&read, messages_call());
            ready_messages(&output)
                .and_then(|report| sender_count(report, SENDER_B))
                .map(|value| value.to_string())
                .unwrap_or_else(|| UNAVAILABLE.to_string())
        }
        AnswerKey::PriceChatMsat | AnswerKey::PriceCommunicationMsat => {
            price_category(&read, PriceCategory::Communication)
        }
        AnswerKey::PriceFileMsat => price_category(&read, PriceCategory::FilesMedia),
        AnswerKey::PriceCalendarMsat => price_category(&read, PriceCategory::StructuredData),
        AnswerKey::PricingMode => {
            let output = exec(&read, prices_call());
            match ready_prices(&output) {
                Some(report) if report.mode == PricingMode::Static => "static".to_string(),
                Some(_) | None => UNAVAILABLE.to_string(),
            }
        }
    }
}

fn channel_sum(read: &MockRead, field: impl Fn(&BalanceReport) -> &Amount<u64>) -> String {
    let balance = exec(read, balance_call());
    let channels = exec(read, channels_call());
    if report_down(&channels) {
        return UNAVAILABLE.to_string();
    }
    ready_balance(&balance)
        .and_then(|report| amount_u64(field(report)))
        .map(|value| value.to_string())
        .unwrap_or_else(|| UNAVAILABLE.to_string())
}

fn health_amount(read: &MockRead, field: impl Fn(&HealthReport) -> &Amount<u64>) -> String {
    let output = exec(read, health_call());
    ready_health(&output)
        .and_then(|report| amount_u64(field(report)))
        .map(|value| value.to_string())
        .unwrap_or_else(|| UNAVAILABLE.to_string())
}

fn price_category(read: &MockRead, category: PriceCategory) -> String {
    let output = exec(read, prices_call());
    ready_prices(&output)
        .and_then(|report| category_price(report, category))
        .map(|value| value.to_string())
        .unwrap_or_else(|| UNAVAILABLE.to_string())
}

/// Drive the mock broker over every fixture question. One line per question:
/// `{id} {answer|Unavailable}`.
pub fn render() -> String {
    let fixture = load_fixture();
    let mut out = String::new();
    for question in &fixture.questions {
        let value = answer(question);
        out.push_str(&question.id);
        out.push(' ');
        out.push_str(&value);
        out.push('\n');
    }
    out
}

/// Print the fixture report to stdout.
pub fn run() {
    print!("{}", render());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reader_emits_fifty_rows_and_no_sent_mail_total_number() {
        let report = render();
        let rows: Vec<&str> = report.lines().filter(|line| !line.is_empty()).collect();
        assert_eq!(rows.len(), 50, "{report}");

        for (index, row) in rows.iter().enumerate() {
            let id = format!("q{:02}", index + 1);
            assert!(
                row.starts_with(&format!("{id} ")),
                "row {index} should start with {id}: {row}"
            );
        }

        let q24 = rows
            .iter()
            .find(|row| row.starts_with("q24 "))
            .expect("q24 row");
        assert_eq!(*q24, "q24 Unavailable", "{q24}");

        // Sent-mail total must not appear as a numeric answer on q24.
        let answer = q24.strip_prefix("q24 ").expect("prefix");
        assert_eq!(answer, UNAVAILABLE);
        assert!(
            answer.parse::<u64>().is_err(),
            "sent-mail total must not print as a number: {answer}"
        );
    }
}
