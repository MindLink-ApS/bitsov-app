//! Project allowlisted tool output from pinned genome JSON.
//!
//! Wire structs accept the real route shape, including fields the assistant
//! must never see (`ciphertext`, `plaintext`, `payment_hash`, `peer_pubkey`).
//! Those fields are not `Debug` and are not copied into the report. Unknown
//! response fields are ignored and are not stored. A body that does not match
//! the route shape becomes [`UnavailableReason::Malformed`] with no body.

use std::collections::BTreeMap;

use serde::de::DeserializeOwned;
use serde::Deserialize;

use super::route::{PeerKey, ReadRoute};
use super::schema::{
    Amount, BalanceReport, CategoryFeeTarget, CategoryPrice, ChainBackend, ChannelSummary,
    ChannelsReport, CopiedId, Direction, HealthReport, LightningBackend, Liveness, LocalPrices,
    MessageMetadata, PaymentEntry, PaymentsReport, PriceCategory, PricingMode, Report, SenderCount,
    SourceField, TargetFee, TrustLevel, UnavailableReason, Unit, WalletBalanceLabel,
    MAX_PAYMENT_ENTRIES, MAX_PAYMENT_PEERS, PAYMENT_THREAD_LIMIT,
};
use super::{LogOutcome, NodeRead, RawRead, ReadFault, ReadLog};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FetchFail {
    Transport,
    Stale,
    Http { status: u16 },
    Decode,
}

impl From<FetchFail> for UnavailableReason {
    fn from(fail: FetchFail) -> Self {
        match fail {
            FetchFail::Transport => Self::Timeout,
            FetchFail::Stale => Self::Stale,
            FetchFail::Http { .. } => Self::UpstreamError,
            FetchFail::Decode => Self::Malformed,
        }
    }
}

fn fetch<T: DeserializeOwned>(
    node: &impl NodeRead,
    route: ReadRoute,
    log: &mut Vec<ReadLog>,
) -> Result<T, UnavailableReason> {
    let target = route.target();
    let decoded = match node.read(route) {
        Err(ReadFault::Transport) => Err(FetchFail::Transport),
        Err(ReadFault::Stale) => Err(FetchFail::Stale),
        Ok(raw) => decode(raw),
    };
    let outcome = match &decoded {
        Ok(_) => LogOutcome::Ready,
        Err(FetchFail::Transport) => LogOutcome::Transport,
        Err(FetchFail::Stale) => LogOutcome::Stale,
        Err(FetchFail::Http { status }) => LogOutcome::Http { status: *status },
        Err(FetchFail::Decode) => LogOutcome::Decode,
    };
    log.push(ReadLog {
        method: target.method,
        path: target.path,
        query: target.query,
        outcome,
    });
    decoded.map_err(UnavailableReason::from)
}

fn decode<T: DeserializeOwned>(raw: RawRead) -> Result<T, FetchFail> {
    if !(200..300).contains(&raw.status) {
        return Err(FetchFail::Http { status: raw.status });
    }
    // Drop the serde error. Its Display quotes the offending JSON line.
    serde_json::from_slice(&raw.body).map_err(|_| FetchFail::Decode)
}

fn available<T>(value: T, unit: Unit, source_field: SourceField) -> Amount<T> {
    Amount::Available {
        value,
        unit,
        source_field,
    }
}

fn unavailable<T>(unit: Unit, source_field: SourceField, reason: UnavailableReason) -> Amount<T> {
    Amount::Unavailable {
        unit,
        source_field,
        reason,
    }
}

fn project<T, U>(
    value: Result<T, UnavailableReason>,
    ready: impl FnOnce(T) -> Report<U>,
) -> Report<U> {
    match value {
        Ok(value) => ready(value),
        Err(reason) => Report::Unavailable { reason },
    }
}

#[derive(Deserialize)]
struct BalanceWire {
    balance_msat: u64,
}

#[derive(Deserialize)]
struct ChannelWire {
    channel_id: String,
    capacity_msat: u64,
    local_balance_msat: u64,
    remote_balance_msat: u64,
    active: bool,
    short_channel_id: Option<String>,
}

pub(super) fn balance(node: &impl NodeRead, log: &mut Vec<ReadLog>) -> Report<BalanceReport> {
    let wallet = fetch::<BalanceWire>(node, ReadRoute::PaymentsBalance, log);
    let channels = fetch::<Vec<ChannelWire>>(node, ReadRoute::PaymentsChannels, log);
    if let (Err(reason), Err(_)) = (&wallet, &channels) {
        return Report::Unavailable { reason: *reason };
    }
    let wallet_balance = match wallet {
        Ok(wire) => available(wire.balance_msat, Unit::Msat, SourceField::BalanceMsat),
        Err(reason) => unavailable(Unit::Msat, SourceField::BalanceMsat, reason),
    };
    let sums = match channels {
        Ok(list) => channel_sums(&list),
        Err(reason) => ChannelSums {
            local: unavailable(Unit::Msat, SourceField::LocalBalanceMsat, reason),
            remote: unavailable(Unit::Msat, SourceField::RemoteBalanceMsat, reason),
            capacity: unavailable(Unit::Msat, SourceField::CapacityMsat, reason),
        },
    };
    Report::Ready {
        value: BalanceReport {
            label: wallet_label(node, log),
            wallet_balance,
            channel_local_balance: sums.local,
            channel_remote_balance: sums.remote,
            channel_capacity: sums.capacity,
        },
    }
}

fn wallet_label(node: &impl NodeRead, log: &mut Vec<ReadLog>) -> WalletBalanceLabel {
    let Ok(wire) = fetch::<HealthWire>(node, ReadRoute::Health, log) else {
        return WalletBalanceLabel::NodeReported;
    };
    match lightning_backend(&wire.lightning_backend) {
        LightningBackend::Ldk => WalletBalanceLabel::LdkOnchainPlusLightning,
        LightningBackend::Lnd => WalletBalanceLabel::LndChannelBalance,
        LightningBackend::Lnbits
        | LightningBackend::Mock
        | LightningBackend::Void
        | LightningBackend::Other => WalletBalanceLabel::NodeReported,
    }
}

struct ChannelSums {
    local: Amount<u64>,
    remote: Amount<u64>,
    capacity: Amount<u64>,
}

fn channel_sums(list: &[ChannelWire]) -> ChannelSums {
    let mut local = 0u64;
    let mut remote = 0u64;
    let mut capacity = 0u64;
    let mut local_overflow = false;
    let mut remote_overflow = false;
    let mut capacity_overflow = false;
    for channel in list {
        local_overflow |= overflowing_add(&mut local, channel.local_balance_msat);
        remote_overflow |= overflowing_add(&mut remote, channel.remote_balance_msat);
        capacity_overflow |= overflowing_add(&mut capacity, channel.capacity_msat);
    }
    ChannelSums {
        local: summed(local, local_overflow, SourceField::LocalBalanceMsat),
        remote: summed(remote, remote_overflow, SourceField::RemoteBalanceMsat),
        capacity: summed(capacity, capacity_overflow, SourceField::CapacityMsat),
    }
}

fn overflowing_add(slot: &mut u64, value: u64) -> bool {
    match slot.checked_add(value) {
        Some(sum) => {
            *slot = sum;
            false
        }
        None => true,
    }
}

fn summed(value: u64, overflow: bool, source_field: SourceField) -> Amount<u64> {
    if overflow {
        unavailable(Unit::Msat, source_field, UnavailableReason::Overflow)
    } else {
        available(value, Unit::Msat, source_field)
    }
}

pub(super) fn channels(node: &impl NodeRead, log: &mut Vec<ReadLog>) -> Report<ChannelsReport> {
    let listed = fetch::<Vec<ChannelWire>>(node, ReadRoute::PaymentsChannels, log);
    project(listed, project_channels)
}

fn project_channels(list: Vec<ChannelWire>) -> Report<ChannelsReport> {
    let count = list.len() as u64;
    let mut active = 0u64;
    let mut channels = Vec::with_capacity(list.len());
    for channel in list {
        if channel.active {
            active += 1;
        }
        channels.push(ChannelSummary {
            channel_id: copy_channel_id(&channel.channel_id),
            capacity: available(channel.capacity_msat, Unit::Msat, SourceField::CapacityMsat),
            local_balance: available(
                channel.local_balance_msat,
                Unit::Msat,
                SourceField::LocalBalanceMsat,
            ),
            remote_balance: available(
                channel.remote_balance_msat,
                Unit::Msat,
                SourceField::RemoteBalanceMsat,
            ),
            active: channel.active,
            short_channel_id: channel
                .short_channel_id
                .as_deref()
                .map(copy_short_channel_id),
        });
    }
    Report::Ready {
        value: ChannelsReport {
            count: available(count, Unit::Count, SourceField::ChannelId),
            active_count: available(active, Unit::Count, SourceField::Active),
            channels,
        },
    }
}

fn copy_channel_id(value: &str) -> CopiedId {
    copy_hex(value, 1, 64)
}

fn copy_hex(value: &str, min: usize, max: usize) -> CopiedId {
    if value.len() >= min
        && value.len() <= max
        && value.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        CopiedId::Value {
            value: value.to_string(),
        }
    } else {
        CopiedId::Withheld
    }
}

fn copy_short_channel_id(value: &str) -> CopiedId {
    let bytes = value.as_bytes();
    let shaped = !bytes.is_empty()
        && bytes.len() <= 64
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_digit() || *byte == b'x')
        && bytes.first() != Some(&b'x')
        && bytes.last() != Some(&b'x')
        && !value.contains("xx")
        && bytes.iter().any(|byte| byte.is_ascii_digit());
    if shaped {
        CopiedId::Value {
            value: value.to_string(),
        }
    } else {
        CopiedId::Withheld
    }
}

#[derive(Deserialize)]
struct HealthWire {
    status: String,
    connected_peers: u64,
    e2ee_sessions: u64,
    pending_deliveries: u64,
    lightning_available: bool,
    lightning_payment_capable: bool,
    uptime_secs: u64,
    version: u16,
    lightning_backend: String,
    chain_backend: String,
    #[serde(default)]
    block_height: Option<u64>,
}

pub(super) fn health(node: &impl NodeRead, log: &mut Vec<ReadLog>) -> Report<HealthReport> {
    let wire = fetch::<HealthWire>(node, ReadRoute::Health, log);
    project(wire, project_health)
}

fn project_health(wire: HealthWire) -> Report<HealthReport> {
    let liveness = if wire.status == "ok" {
        Liveness::Ok
    } else {
        Liveness::Other
    };
    let block_height = match wire.block_height {
        Some(height) => available(height, Unit::Blocks, SourceField::BlockHeight),
        None => unavailable(
            Unit::Blocks,
            SourceField::BlockHeight,
            UnavailableReason::Absent,
        ),
    };
    Report::Ready {
        value: HealthReport {
            liveness,
            connected_peers: available(
                wire.connected_peers,
                Unit::Count,
                SourceField::ConnectedPeers,
            ),
            e2ee_sessions: available(wire.e2ee_sessions, Unit::Count, SourceField::E2eeSessions),
            pending_deliveries: available(
                wire.pending_deliveries,
                Unit::Count,
                SourceField::PendingDeliveries,
            ),
            lightning_available: wire.lightning_available,
            lightning_payment_capable: wire.lightning_payment_capable,
            uptime: available(wire.uptime_secs, Unit::Seconds, SourceField::UptimeSecs),
            version: available(
                u64::from(wire.version),
                Unit::ProtocolVersion,
                SourceField::Version,
            ),
            lightning_backend: lightning_backend(&wire.lightning_backend),
            chain_backend: chain_backend(&wire.chain_backend),
            block_height,
        },
    }
}

fn lightning_backend(name: &str) -> LightningBackend {
    match name {
        "ldk" => LightningBackend::Ldk,
        "lnbits" => LightningBackend::Lnbits,
        "lnd" => LightningBackend::Lnd,
        "mock" => LightningBackend::Mock,
        "void" => LightningBackend::Void,
        _ => LightningBackend::Other,
    }
}

fn chain_backend(name: &str) -> ChainBackend {
    match name {
        "esplora" => ChainBackend::Esplora,
        "mock" => ChainBackend::Mock,
        _ => ChainBackend::Other,
    }
}

/// `MessageResponse` at 958e399. Body-bearing fields stay on this struct so a
/// real payload decodes, and nowhere else.
#[derive(Deserialize)]
struct MessageWire {
    sender: String,
    #[allow(dead_code)]
    id: String,
    #[allow(dead_code)]
    kind: u16,
    #[allow(dead_code)]
    recipient: String,
    #[allow(dead_code)]
    timestamp: u64,
    #[allow(dead_code)]
    ciphertext: String,
    #[allow(dead_code)]
    payment_amount_msat: u64,
    #[allow(dead_code)]
    payment_hash: String,
    #[serde(default)]
    #[allow(dead_code)]
    plaintext: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    references: Vec<String>,
}

pub(super) fn messages(
    node: &impl NodeRead,
    limit: u32,
    log: &mut Vec<ReadLog>,
) -> Report<MessageMetadata> {
    let listed = fetch::<Vec<MessageWire>>(node, ReadRoute::Messages { limit }, log);
    project(listed, project_messages)
}

fn project_messages(list: Vec<MessageWire>) -> Report<MessageMetadata> {
    let returned = list.len() as u64;
    let mut counts: BTreeMap<String, u64> = BTreeMap::new();
    let mut withheld = 0u64;
    for message in list {
        match checked_sender(&message.sender) {
            Some(sender) => *counts.entry(sender).or_default() += 1,
            None => withheld += 1,
        }
    }
    let senders = counts
        .into_iter()
        .map(|(sender, count)| SenderCount {
            sender,
            count: available(count, Unit::Count, SourceField::Sender),
        })
        .collect();
    Report::Ready {
        value: MessageMetadata {
            returned_count: available(returned, Unit::Count, SourceField::Messages),
            senders,
            withheld_senders: available(withheld, Unit::Count, SourceField::Sender),
        },
    }
}

fn checked_sender(sender: &str) -> Option<String> {
    if sender.len() == 64 && sender.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Some(sender.to_string())
    } else {
        None
    }
}

#[derive(Deserialize)]
struct FeeWire {
    raw_sat_per_vbyte: f64,
    ema_sat_per_vbyte: f64,
}

/// `OwnPricingResponse` at 958e399.
#[derive(Deserialize)]
struct PricingWire {
    mode: String,
    prices: BTreeMap<String, u64>,
    block_height: u64,
    valid_blocks: u32,
    trust_level: String,
    difficulty_epoch_position: u64,
    peer_tables_cached: u64,
    #[serde(default)]
    raw_fee_rate: Option<f64>,
    #[serde(default)]
    ema_fee_rate: Option<f64>,
    #[serde(default)]
    max_price_multiplier: Option<f64>,
    #[serde(default)]
    fee_rates_by_target: Option<BTreeMap<String, FeeWire>>,
    #[serde(default)]
    category_fee_targets: Option<BTreeMap<String, u32>>,
}

pub(super) fn prices(node: &impl NodeRead, log: &mut Vec<ReadLog>) -> Report<LocalPrices> {
    let wire = fetch::<PricingWire>(node, ReadRoute::OwnPricing, log);
    project(wire, project_prices)
}

fn project_prices(wire: PricingWire) -> Report<LocalPrices> {
    let chain_missing = wire.block_height == 0;
    let block_height = if chain_missing {
        unavailable(
            Unit::Blocks,
            SourceField::BlockHeight,
            UnavailableReason::Stale,
        )
    } else {
        available(wire.block_height, Unit::Blocks, SourceField::BlockHeight)
    };
    let difficulty_epoch_position = if chain_missing {
        unavailable(
            Unit::EpochPosition,
            SourceField::DifficultyEpochPosition,
            UnavailableReason::Stale,
        )
    } else {
        available(
            wire.difficulty_epoch_position,
            Unit::EpochPosition,
            SourceField::DifficultyEpochPosition,
        )
    };
    let (prices, withheld_prices) = project_price_map(wire.prices);
    let (fee_rates_by_target, withheld_fee_targets) = project_fee_targets(wire.fee_rates_by_target);
    let (category_fee_targets, withheld_category_targets) =
        project_category_targets(wire.category_fee_targets);
    Report::Ready {
        value: LocalPrices {
            mode: pricing_mode(&wire.mode),
            prices,
            withheld_prices: available(withheld_prices, Unit::Count, SourceField::Prices),
            block_height,
            valid_blocks: available(
                u64::from(wire.valid_blocks),
                Unit::Blocks,
                SourceField::ValidBlocks,
            ),
            trust_level: trust_level(&wire.trust_level),
            difficulty_epoch_position,
            peer_tables_cached: available(
                wire.peer_tables_cached,
                Unit::Count,
                SourceField::PeerTablesCached,
            ),
            raw_fee_rate: optional_float(
                wire.raw_fee_rate,
                Unit::SatPerVbyte,
                SourceField::RawFeeRate,
            ),
            ema_fee_rate: optional_float(
                wire.ema_fee_rate,
                Unit::SatPerVbyte,
                SourceField::EmaFeeRate,
            ),
            max_price_multiplier: optional_float(
                wire.max_price_multiplier,
                Unit::Multiplier,
                SourceField::MaxPriceMultiplier,
            ),
            fee_rates_by_target,
            withheld_fee_targets,
            category_fee_targets,
            withheld_category_targets,
        },
    }
}

fn project_price_map(prices: BTreeMap<String, u64>) -> (Vec<CategoryPrice>, u64) {
    let mut kept = Vec::new();
    let mut withheld = 0u64;
    for (name, price) in prices {
        match price_category(&name) {
            Some(category) => kept.push(CategoryPrice {
                category,
                price: available(price, Unit::Msat, SourceField::Prices),
            }),
            None => withheld += 1,
        }
    }
    (kept, withheld)
}

fn project_fee_targets(
    targets: Option<BTreeMap<String, FeeWire>>,
) -> (Vec<TargetFee>, Amount<u64>) {
    let Some(targets) = targets else {
        return (
            Vec::new(),
            unavailable(
                Unit::Count,
                SourceField::FeeRatesByTarget,
                UnavailableReason::Absent,
            ),
        );
    };
    let mut kept = Vec::new();
    let mut withheld = 0u64;
    for (key, fee) in targets {
        if let Some(target_blocks) = digits_u32(&key) {
            kept.push(TargetFee {
                target_blocks,
                raw: finite_float(fee.raw_sat_per_vbyte, SourceField::RawSatPerVbyte),
                ema: finite_float(fee.ema_sat_per_vbyte, SourceField::EmaSatPerVbyte),
            });
        } else {
            withheld += 1;
        }
    }
    (
        kept,
        available(withheld, Unit::Count, SourceField::FeeRatesByTarget),
    )
}

fn project_category_targets(
    targets: Option<BTreeMap<String, u32>>,
) -> (Vec<CategoryFeeTarget>, Amount<u64>) {
    let Some(targets) = targets else {
        return (
            Vec::new(),
            unavailable(
                Unit::Count,
                SourceField::CategoryFeeTargets,
                UnavailableReason::Absent,
            ),
        );
    };
    let mut kept = Vec::new();
    let mut withheld = 0u64;
    for (name, blocks) in targets {
        match price_category(&name) {
            Some(category) => kept.push(CategoryFeeTarget {
                category,
                target_blocks: available(
                    u64::from(blocks),
                    Unit::Blocks,
                    SourceField::CategoryFeeTargets,
                ),
            }),
            None => withheld += 1,
        }
    }
    (
        kept,
        available(withheld, Unit::Count, SourceField::CategoryFeeTargets),
    )
}

fn digits_u32(value: &str) -> Option<u32> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

fn optional_float(value: Option<f64>, unit: Unit, source_field: SourceField) -> Amount<f64> {
    match value {
        Some(value) => finite_float_unit(value, unit, source_field),
        None => unavailable(unit, source_field, UnavailableReason::Absent),
    }
}

fn finite_float(value: f64, source_field: SourceField) -> Amount<f64> {
    finite_float_unit(value, Unit::SatPerVbyte, source_field)
}

fn finite_float_unit(value: f64, unit: Unit, source_field: SourceField) -> Amount<f64> {
    if value.is_finite() && value >= 0.0 {
        available(value, unit, source_field)
    } else {
        unavailable(unit, source_field, UnavailableReason::Malformed)
    }
}

fn pricing_mode(mode: &str) -> PricingMode {
    match mode {
        "static" => PricingMode::Static,
        "chain_aware" => PricingMode::ChainAware,
        _ => PricingMode::Other,
    }
}

fn trust_level(level: &str) -> TrustLevel {
    match level {
        "spv" => TrustLevel::Spv,
        "server_trust" => TrustLevel::ServerTrust,
        "full_validation" => TrustLevel::FullValidation,
        _ => TrustLevel::Other,
    }
}

fn price_category(name: &str) -> Option<PriceCategory> {
    Some(match name {
        "communication" => PriceCategory::Communication,
        "structured_data" => PriceCategory::StructuredData,
        "files_media" => PriceCategory::FilesMedia,
        "collaboration" => PriceCategory::Collaboration,
        "realtime_signaling" => PriceCategory::RealtimeSignaling,
        "web_content" => PriceCategory::WebContent,
        "relay_storage" => PriceCategory::Storage,
        "control" => PriceCategory::Control,
        "app_extension" => PriceCategory::AppExtension,
        "unknown" => PriceCategory::Unknown,
        _ => return None,
    })
}

/// `PeerResponse` at 958e399: only the id is decoded. Label, address and
/// fingerprint are never read into memory the tool keeps.
#[derive(Deserialize)]
struct PeerIdWire {
    node_id: String,
}

/// `MessageResponse` in a peer thread: only who, when and how much. Body,
/// ciphertext, hash, kind and references are not decoded.
#[derive(Deserialize)]
struct ThreadWire {
    sender: String,
    recipient: String,
    timestamp: u64,
    #[serde(default)]
    payment_amount_msat: Option<u64>,
}

/// Paid messages with each contact, both directions, newest first.
///
/// Reads `/peers`, then each valid peer's thread (at most
/// [`MAX_PAYMENT_PEERS`], one page of [`PAYMENT_THREAD_LIMIT`] each). A thread
/// that fails is counted in `peers_unread` and the rest still report, so a
/// total is a floor, never a guess. Unpaid messages are skipped.
pub(super) fn payments(
    node: &impl NodeRead,
    since_ms: Option<u64>,
    log: &mut Vec<ReadLog>,
) -> Report<PaymentsReport> {
    let listed = match fetch::<Vec<PeerIdWire>>(node, ReadRoute::Peers, log) {
        Ok(listed) => listed,
        Err(reason) => return Report::Unavailable { reason },
    };
    let mut keys: Vec<PeerKey> = Vec::new();
    let mut unread = 0u64;
    for peer in &listed {
        match PeerKey::parse(&peer.node_id) {
            Some(key) if !keys.contains(&key) => keys.push(key),
            Some(_) => {}
            None => unread += 1,
        }
    }
    if keys.len() > MAX_PAYMENT_PEERS {
        unread += (keys.len() - MAX_PAYMENT_PEERS) as u64;
        keys.truncate(MAX_PAYMENT_PEERS);
    }

    let mut entries: Vec<PaymentEntry> = Vec::new();
    let mut read = 0u64;
    let mut partial = 0u64;
    let mut sent: Option<u64> = Some(0);
    let mut received: Option<u64> = Some(0);
    for key in keys {
        let route = ReadRoute::PeerMessages {
            peer: key,
            limit: PAYMENT_THREAD_LIMIT,
        };
        let Ok(thread) = fetch::<Vec<ThreadWire>>(node, route, log) else {
            unread += 1;
            continue;
        };
        read += 1;
        if thread.len() >= PAYMENT_THREAD_LIMIT as usize {
            partial += 1;
        }
        let hex = key.hex();
        for message in thread {
            let amount = message.payment_amount_msat.unwrap_or(0);
            if amount == 0 || since_ms.is_some_and(|since| message.timestamp < since) {
                continue;
            }
            let direction = if message.sender.eq_ignore_ascii_case(&hex) {
                Direction::Received
            } else if message.recipient.eq_ignore_ascii_case(&hex) {
                Direction::Sent
            } else {
                continue;
            };
            let total = match direction {
                Direction::Sent => &mut sent,
                Direction::Received => &mut received,
            };
            *total = total.and_then(|sum| sum.checked_add(amount));
            entries.push(PaymentEntry {
                at_ms: message.timestamp,
                direction,
                amount: available(amount, Unit::Msat, SourceField::PaymentAmountMsat),
                peer: CopiedId::Value { value: hex.clone() },
            });
        }
    }
    entries.sort_by(|a, b| b.at_ms.cmp(&a.at_ms));
    let unlisted = entries.len().saturating_sub(MAX_PAYMENT_ENTRIES) as u64;
    entries.truncate(MAX_PAYMENT_ENTRIES);
    let total = |sum: Option<u64>| match sum {
        Some(sum) => available(sum, Unit::Msat, SourceField::PaymentAmountMsat),
        None => unavailable(
            Unit::Msat,
            SourceField::PaymentAmountMsat,
            UnavailableReason::Overflow,
        ),
    };
    let count = |value: u64, field: SourceField| available(value, Unit::Count, field);
    Report::Ready {
        value: PaymentsReport {
            entries,
            sent_total: total(sent),
            received_total: total(received),
            unlisted: count(unlisted, SourceField::Messages),
            peers_read: count(read, SourceField::NodeId),
            peers_unread: count(unread, SourceField::NodeId),
            partial_threads: count(partial, SourceField::Messages),
        },
    }
}
