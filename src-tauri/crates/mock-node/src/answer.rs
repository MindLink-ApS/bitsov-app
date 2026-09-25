//! Answers computed from fresh route JSON.
//!
//! A route error, a timeout, or a stale body never becomes `0`. The read fails
//! and the answer is [`Answer::Unavailable`]. A genuine zero on a fresh route
//! would still be returned; this fixture's answerable fields are not zero.

use std::collections::BTreeSet;

use serde_json::Value;

use crate::ids::{NODE_ID, SENDER_A, SENDER_B};
use crate::serve::{paths, MockNode, ReadFailure};

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, serde::Deserialize, serde::Serialize,
)]
#[serde(rename_all = "snake_case")]
pub enum AnswerKey {
    OnchainSats,
    TotalBalanceMsat,
    ChannelLocalMsat,
    ChannelRemoteMsat,
    ChannelCapacityMsat,
    ChannelCount,
    ChannelActiveCount,
    ChannelInactiveCount,
    HealthStatus,
    ConnectedPeers,
    E2eeSessions,
    PendingDeliveries,
    LightningAvailable,
    LightningPaymentCapable,
    UptimeSecs,
    ProtocolVersion,
    BlockHeight,
    LightningBackend,
    ChainBackend,
    MessageCount,
    DistinctSenders,
    MessagesFromA,
    MessagesFromB,
    MessagesSent,
    ChatMessageCount,
    PriceChatMsat,
    PriceLongformMsat,
    PriceFileMsat,
    PriceCalendarMsat,
    PriceCommunicationMsat,
    PricingMode,
    PeerCount,
}

impl AnswerKey {
    pub const ALL: [AnswerKey; 32] = [
        Self::OnchainSats,
        Self::TotalBalanceMsat,
        Self::ChannelLocalMsat,
        Self::ChannelRemoteMsat,
        Self::ChannelCapacityMsat,
        Self::ChannelCount,
        Self::ChannelActiveCount,
        Self::ChannelInactiveCount,
        Self::HealthStatus,
        Self::ConnectedPeers,
        Self::E2eeSessions,
        Self::PendingDeliveries,
        Self::LightningAvailable,
        Self::LightningPaymentCapable,
        Self::UptimeSecs,
        Self::ProtocolVersion,
        Self::BlockHeight,
        Self::LightningBackend,
        Self::ChainBackend,
        Self::MessageCount,
        Self::DistinctSenders,
        Self::MessagesFromA,
        Self::MessagesFromB,
        Self::MessagesSent,
        Self::ChatMessageCount,
        Self::PriceChatMsat,
        Self::PriceLongformMsat,
        Self::PriceFileMsat,
        Self::PriceCalendarMsat,
        Self::PriceCommunicationMsat,
        Self::PricingMode,
        Self::PeerCount,
    ];

    pub fn routes(self) -> &'static [crate::Route] {
        use crate::Route::{
            Health, Messages, PaymentsBalance, PaymentsChannels, PaymentsPrice, Peers, Pricing,
            Status,
        };
        match self {
            Self::OnchainSats => &[PaymentsBalance, PaymentsChannels],
            Self::TotalBalanceMsat => &[PaymentsBalance],
            Self::ChannelLocalMsat
            | Self::ChannelRemoteMsat
            | Self::ChannelCapacityMsat
            | Self::ChannelCount
            | Self::ChannelActiveCount
            | Self::ChannelInactiveCount => &[PaymentsChannels],
            Self::HealthStatus
            | Self::ConnectedPeers
            | Self::E2eeSessions
            | Self::PendingDeliveries
            | Self::LightningAvailable
            | Self::LightningPaymentCapable
            | Self::UptimeSecs
            | Self::ProtocolVersion
            | Self::BlockHeight
            | Self::LightningBackend
            | Self::ChainBackend => &[Health],
            Self::MessageCount
            | Self::DistinctSenders
            | Self::MessagesFromA
            | Self::MessagesFromB
            | Self::ChatMessageCount => &[Messages],
            Self::MessagesSent => &[Messages, Status],
            Self::PriceChatMsat
            | Self::PriceLongformMsat
            | Self::PriceFileMsat
            | Self::PriceCalendarMsat => &[PaymentsPrice],
            Self::PriceCommunicationMsat | Self::PricingMode => &[Pricing],
            Self::PeerCount => &[Peers],
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Answer {
    Value(String),
    Unavailable,
}

impl Answer {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Value(value) => value,
            Self::Unavailable => "unavailable",
        }
    }
}

impl MockNode {
    pub fn answer(&self, key: AnswerKey) -> Answer {
        match compute(self, key) {
            Ok(value) => Answer::Value(value),
            Err(_) => Answer::Unavailable,
        }
    }
}

fn compute(node: &MockNode, key: AnswerKey) -> Result<String, ReadFailure> {
    match key {
        AnswerKey::OnchainSats => onchain_sats(node),
        AnswerKey::TotalBalanceMsat => field_u64(node, paths::BALANCE, "balance_msat"),
        AnswerKey::ChannelLocalMsat => channel_sum(node, "local_balance_msat"),
        AnswerKey::ChannelRemoteMsat => channel_sum(node, "remote_balance_msat"),
        AnswerKey::ChannelCapacityMsat => channel_sum(node, "capacity_msat"),
        AnswerKey::ChannelCount => array_len(node, paths::CHANNELS),
        AnswerKey::ChannelActiveCount => channel_active(node, true),
        AnswerKey::ChannelInactiveCount => channel_active(node, false),
        AnswerKey::HealthStatus => field_str(node, paths::HEALTH, "status"),
        AnswerKey::ConnectedPeers => field_u64(node, paths::HEALTH, "connected_peers"),
        AnswerKey::E2eeSessions => field_u64(node, paths::HEALTH, "e2ee_sessions"),
        AnswerKey::PendingDeliveries => field_u64(node, paths::HEALTH, "pending_deliveries"),
        AnswerKey::LightningAvailable => field_bool(node, paths::HEALTH, "lightning_available"),
        AnswerKey::LightningPaymentCapable => {
            field_bool(node, paths::HEALTH, "lightning_payment_capable")
        }
        AnswerKey::UptimeSecs => field_u64(node, paths::HEALTH, "uptime_secs"),
        AnswerKey::ProtocolVersion => field_u64(node, paths::HEALTH, "version"),
        AnswerKey::BlockHeight => field_u64(node, paths::HEALTH, "block_height"),
        AnswerKey::LightningBackend => field_str(node, paths::HEALTH, "lightning_backend"),
        AnswerKey::ChainBackend => field_str(node, paths::HEALTH, "chain_backend"),
        AnswerKey::MessageCount => array_len(node, paths::MESSAGES),
        AnswerKey::DistinctSenders => distinct_senders(node),
        AnswerKey::MessagesFromA => messages_from(node, SENDER_A),
        AnswerKey::MessagesFromB => messages_from(node, SENDER_B),
        AnswerKey::MessagesSent => messages_sent(node),
        AnswerKey::ChatMessageCount => chat_messages(node),
        AnswerKey::PriceChatMsat => kind_price(node, 0),
        AnswerKey::PriceLongformMsat => kind_price(node, 1),
        AnswerKey::PriceFileMsat => kind_price(node, 200),
        AnswerKey::PriceCalendarMsat => kind_price(node, 100),
        AnswerKey::PriceCommunicationMsat => category_price(node, "communication"),
        AnswerKey::PricingMode => field_str(node, paths::PRICING, "mode"),
        AnswerKey::PeerCount => array_len(node, paths::PEERS),
    }
}

fn onchain_sats(node: &MockNode) -> Result<String, ReadFailure> {
    let balance = node.read(paths::BALANCE)?;
    let channels = node.read(paths::CHANNELS)?;
    let total = require_u64(&balance, "balance_msat")?;
    let local = sum_field(&channels, "local_balance_msat")?;
    let onchain_msat = total.checked_sub(local).ok_or(ReadFailure::Unreadable)?;
    if onchain_msat % 1000 != 0 {
        return Err(ReadFailure::Unreadable);
    }
    Ok((onchain_msat / 1000).to_string())
}

fn channel_sum(node: &MockNode, field: &str) -> Result<String, ReadFailure> {
    let channels = node.read(paths::CHANNELS)?;
    Ok(sum_field(&channels, field)?.to_string())
}

fn channel_active(node: &MockNode, want: bool) -> Result<String, ReadFailure> {
    let channels = node.read(paths::CHANNELS)?;
    let arr = channels.as_array().ok_or(ReadFailure::Unreadable)?;
    let mut n = 0u64;
    for ch in arr {
        let active = ch
            .get("active")
            .and_then(Value::as_bool)
            .ok_or(ReadFailure::Unreadable)?;
        if active == want {
            n = n.checked_add(1).ok_or(ReadFailure::Unreadable)?;
        }
    }
    Ok(n.to_string())
}

fn distinct_senders(node: &MockNode) -> Result<String, ReadFailure> {
    let messages = node.read(paths::MESSAGES)?;
    let mut senders = BTreeSet::new();
    for msg in messages.as_array().ok_or(ReadFailure::Unreadable)? {
        senders.insert(require_str(msg, "sender")?.to_string());
    }
    Ok(senders.len().to_string())
}

fn messages_from(node: &MockNode, sender: &str) -> Result<String, ReadFailure> {
    let messages = node.read(paths::MESSAGES)?;
    let mut n = 0u64;
    for msg in messages.as_array().ok_or(ReadFailure::Unreadable)? {
        if require_str(msg, "sender")? == sender {
            n = n.checked_add(1).ok_or(ReadFailure::Unreadable)?;
        }
    }
    Ok(n.to_string())
}

fn messages_sent(node: &MockNode) -> Result<String, ReadFailure> {
    let status = node.read(paths::STATUS)?;
    let me = require_str(&status, "node_id")?;
    if me != NODE_ID {
        return Err(ReadFailure::Unreadable);
    }
    messages_from(node, me)
}

fn chat_messages(node: &MockNode) -> Result<String, ReadFailure> {
    let messages = node.read(paths::MESSAGES)?;
    let mut n = 0u64;
    for msg in messages.as_array().ok_or(ReadFailure::Unreadable)? {
        if require_u64(msg, "kind")? == 0 {
            n = n.checked_add(1).ok_or(ReadFailure::Unreadable)?;
        }
    }
    Ok(n.to_string())
}

fn kind_price(node: &MockNode, kind: u16) -> Result<String, ReadFailure> {
    let body = node.read(&paths::price(kind))?;
    let reported = require_u64(&body, "kind")?;
    if reported != u64::from(kind) {
        return Err(ReadFailure::Unreadable);
    }
    Ok(require_u64(&body, "price_msat")?.to_string())
}

fn category_price(node: &MockNode, category: &str) -> Result<String, ReadFailure> {
    let body = node.read(paths::PRICING)?;
    let prices = body.get("prices").ok_or(ReadFailure::Unreadable)?;
    Ok(require_u64(prices, category)?.to_string())
}

fn field_u64(node: &MockNode, path: &str, field: &str) -> Result<String, ReadFailure> {
    let body = node.read(path)?;
    Ok(require_u64(&body, field)?.to_string())
}

fn field_str(node: &MockNode, path: &str, field: &str) -> Result<String, ReadFailure> {
    let body = node.read(path)?;
    Ok(require_str(&body, field)?.to_string())
}

fn field_bool(node: &MockNode, path: &str, field: &str) -> Result<String, ReadFailure> {
    let body = node.read(path)?;
    let value = body
        .get(field)
        .and_then(Value::as_bool)
        .ok_or(ReadFailure::Unreadable)?;
    Ok(value.to_string())
}

fn array_len(node: &MockNode, path: &str) -> Result<String, ReadFailure> {
    let body = node.read(path)?;
    let n = body.as_array().ok_or(ReadFailure::Unreadable)?.len();
    Ok(n.to_string())
}

fn sum_field(channels: &Value, field: &str) -> Result<u64, ReadFailure> {
    let arr = channels.as_array().ok_or(ReadFailure::Unreadable)?;
    let mut total = 0u64;
    for ch in arr {
        total = total
            .checked_add(require_u64(ch, field)?)
            .ok_or(ReadFailure::Unreadable)?;
    }
    Ok(total)
}

fn require_u64(value: &Value, field: &str) -> Result<u64, ReadFailure> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .ok_or(ReadFailure::Unreadable)
}

fn require_str<'a>(value: &'a Value, field: &str) -> Result<&'a str, ReadFailure> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or(ReadFailure::Unreadable)
}
