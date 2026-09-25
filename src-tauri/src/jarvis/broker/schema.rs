//! Typed tool inputs and allowlisted outputs.
//!
//! Tool inputs and outputs reject unknown fields. Numeric figures carry a unit
//! and the genome field they were read from. A missing, failed, or stale figure
//! is [`Amount::Unavailable`] and carries a closed reason with no numeric payload.

use serde::{Deserialize, Serialize};

/// Genome `MAX_LIST_LIMIT` for `GET /messages`.
pub const MAX_MESSAGE_LIMIT: u32 = 1000;

pub fn default_message_limit() -> u32 {
    50
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Unit {
    Msat,
    SatPerVbyte,
    Count,
    Seconds,
    Blocks,
    ProtocolVersion,
    Multiplier,
    EpochPosition,
}

/// Genome JSON field a figure was projected from. Closed so a node string
/// cannot become the label.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SourceField {
    #[serde(rename = "balance_msat")]
    BalanceMsat,
    #[serde(rename = "local_balance_msat")]
    LocalBalanceMsat,
    #[serde(rename = "remote_balance_msat")]
    RemoteBalanceMsat,
    #[serde(rename = "capacity_msat")]
    CapacityMsat,
    #[serde(rename = "channel_id")]
    ChannelId,
    #[serde(rename = "active")]
    Active,
    #[serde(rename = "connected_peers")]
    ConnectedPeers,
    #[serde(rename = "e2ee_sessions")]
    E2eeSessions,
    #[serde(rename = "pending_deliveries")]
    PendingDeliveries,
    #[serde(rename = "uptime_secs")]
    UptimeSecs,
    #[serde(rename = "version")]
    Version,
    #[serde(rename = "block_height")]
    BlockHeight,
    #[serde(rename = "messages")]
    Messages,
    #[serde(rename = "sender")]
    Sender,
    #[serde(rename = "prices")]
    Prices,
    #[serde(rename = "valid_blocks")]
    ValidBlocks,
    #[serde(rename = "difficulty_epoch_position")]
    DifficultyEpochPosition,
    #[serde(rename = "peer_tables_cached")]
    PeerTablesCached,
    #[serde(rename = "raw_fee_rate")]
    RawFeeRate,
    #[serde(rename = "ema_fee_rate")]
    EmaFeeRate,
    #[serde(rename = "max_price_multiplier")]
    MaxPriceMultiplier,
    #[serde(rename = "raw_sat_per_vbyte")]
    RawSatPerVbyte,
    #[serde(rename = "ema_sat_per_vbyte")]
    EmaSatPerVbyte,
    #[serde(rename = "fee_rates_by_target")]
    FeeRatesByTarget,
    #[serde(rename = "category_fee_targets")]
    CategoryFeeTargets,
}

/// Why a figure or report has no number.
///
/// Every variant is a unit. An HTTP status stays on the host log
/// ([`super::LogOutcome`]) and is not part of tool output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum UnavailableReason {
    /// The read did not complete.
    Timeout,
    /// The node returned a non-success status. The code is not stored here.
    UpstreamError,
    /// The body could not be projected into the allowlisted shape.
    Malformed,
    /// The node omitted a field that has no documented zero.
    Absent,
    /// The node used its documented "not available" sentinel instead of a figure.
    Stale,
    /// A sum did not fit in `u64`. The wrapped total is not stored.
    Overflow,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
pub enum Amount<T> {
    Available {
        value: T,
        unit: Unit,
        source_field: SourceField,
    },
    Unavailable {
        unit: Unit,
        source_field: SourceField,
        reason: UnavailableReason,
    },
}

impl<T: Eq> Eq for Amount<T> {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
pub enum Report<T> {
    Ready { value: T },
    Unavailable { reason: UnavailableReason },
}

/// Identifier copied only after a charset check. Anything else is dropped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
pub enum CopiedId {
    Value { value: String },
    Withheld,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BalanceInput {}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChannelsInput {}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HealthInput {}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalPricesInput {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MessageCountsInput {
    #[serde(default = "default_message_limit")]
    pub limit: u32,
}

impl Default for MessageCountsInput {
    fn default() -> Self {
        Self {
            limit: default_message_limit(),
        }
    }
}

/// What tool output claims `balance_msat` includes.
///
/// LDK reports spendable on-chain plus lightning. LND rc7 reports the channel
/// balance. Every other case is the node-reported wallet balance, with no
/// claim about which balances that field includes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WalletBalanceLabel {
    LdkOnchainPlusLightning,
    LndChannelBalance,
    NodeReported,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BalanceReport {
    pub label: WalletBalanceLabel,
    /// `GET /payments/balance` field `balance_msat`. See [`BalanceReport::label`].
    pub wallet_balance: Amount<u64>,
    /// Sum of `local_balance_msat` (outbound capacity) from `GET /payments/channels`.
    pub channel_local_balance: Amount<u64>,
    /// Sum of `remote_balance_msat` (inbound capacity).
    pub channel_remote_balance: Amount<u64>,
    /// Sum of `capacity_msat`.
    pub channel_capacity: Amount<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChannelSummary {
    pub channel_id: CopiedId,
    pub capacity: Amount<u64>,
    pub local_balance: Amount<u64>,
    pub remote_balance: Amount<u64>,
    pub active: bool,
    pub short_channel_id: Option<CopiedId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChannelsReport {
    pub count: Amount<u64>,
    pub active_count: Amount<u64>,
    pub channels: Vec<ChannelSummary>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Liveness {
    Ok,
    /// Status was not the documented `"ok"`. The raw string is not kept.
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LightningBackend {
    Ldk,
    Lnbits,
    Lnd,
    Mock,
    Void,
    /// Not one of the pinned backend names. The raw string is not kept.
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChainBackend {
    Esplora,
    Mock,
    /// Not one of the pinned backend names. The raw string is not kept.
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HealthReport {
    pub liveness: Liveness,
    pub connected_peers: Amount<u64>,
    pub e2ee_sessions: Amount<u64>,
    pub pending_deliveries: Amount<u64>,
    pub lightning_available: bool,
    pub lightning_payment_capable: bool,
    pub uptime: Amount<u64>,
    pub version: Amount<u64>,
    pub lightning_backend: LightningBackend,
    pub chain_backend: ChainBackend,
    pub block_height: Amount<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SenderCount {
    pub sender: String,
    pub count: Amount<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MessageMetadata {
    /// Messages returned by this page, not a mailbox total.
    pub returned_count: Amount<u64>,
    pub senders: Vec<SenderCount>,
    pub withheld_senders: Amount<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PricingMode {
    Static,
    ChainAware,
    /// Not `static` or `chain_aware`. The raw string is not kept.
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrustLevel {
    Spv,
    ServerTrust,
    FullValidation,
    /// Not one of the pinned trust labels. The raw string is not kept.
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PriceCategory {
    Communication,
    StructuredData,
    FilesMedia,
    Collaboration,
    #[serde(rename = "realtime_signaling")]
    RealtimeSignaling,
    WebContent,
    #[serde(rename = "relay_storage")]
    Storage,
    Control,
    AppExtension,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CategoryPrice {
    pub category: PriceCategory,
    pub price: Amount<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TargetFee {
    pub target_blocks: u32,
    pub raw: Amount<f64>,
    pub ema: Amount<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CategoryFeeTarget {
    pub category: PriceCategory,
    pub target_blocks: Amount<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalPrices {
    pub mode: PricingMode,
    pub prices: Vec<CategoryPrice>,
    pub withheld_prices: Amount<u64>,
    pub block_height: Amount<u64>,
    pub valid_blocks: Amount<u64>,
    pub trust_level: TrustLevel,
    pub difficulty_epoch_position: Amount<u64>,
    pub peer_tables_cached: Amount<u64>,
    pub raw_fee_rate: Amount<f64>,
    pub ema_fee_rate: Amount<f64>,
    pub max_price_multiplier: Amount<f64>,
    pub fee_rates_by_target: Vec<TargetFee>,
    pub withheld_fee_targets: Amount<u64>,
    pub category_fee_targets: Vec<CategoryFeeTarget>,
    pub withheld_category_targets: Amount<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "tool", rename_all = "snake_case", deny_unknown_fields)]
pub enum ToolCall {
    Balance {
        #[serde(default)]
        input: BalanceInput,
    },
    Channels {
        #[serde(default)]
        input: ChannelsInput,
    },
    Health {
        #[serde(default)]
        input: HealthInput,
    },
    MessageCounts {
        #[serde(default)]
        input: MessageCountsInput,
    },
    LocalPrices {
        #[serde(default)]
        input: LocalPricesInput,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "tool", rename_all = "snake_case", deny_unknown_fields)]
pub enum ToolOutput {
    Balance { report: Report<BalanceReport> },
    Channels { report: Report<ChannelsReport> },
    Health { report: Report<HealthReport> },
    MessageCounts { report: Report<MessageMetadata> },
    LocalPrices { report: Report<LocalPrices> },
}
