//! Fixed identities for the deterministic fixture. Not canaries: message
//! counts and sender metadata are allowed to name these.

pub const NODE_ID: &str = "1111111111111111111111111111111111111111111111111111111111111111";
pub const SENDER_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
pub const SENDER_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/// Compressed secp256k1 hex, 33 bytes. Present on `GET /status` only.
pub const LIGHTNING_NODE_PUBKEY: &str =
    "02cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";

pub const BLOCK_HEIGHT: u64 = 860_123;

/// `860123 % 2016 = 1307`, which is mid-epoch. Pinned rc7
/// `compute_valid_blocks` returns 144 for that position. Stored, not copied.
pub const DIFFICULTY_EPOCH_POSITION: u64 = 1_307;
pub const VALID_BLOCKS: u32 = 144;

/// rc7 `get_balance_msat` (`ldk.rs`) adds these two wallet figures and returns
/// one number. Neither figure is a public route field. Channel
/// `local_balance_msat` is outbound capacity and is not the Lightning term.
pub const TOTAL_LIGHTNING_BALANCE_SATS: u64 = 40_000;
pub const SPENDABLE_ONCHAIN_SATS: u64 = 12_500;

/// Outbound capacity per channel, millisatoshis. Not a partition of the
/// combined balance.
pub const CHANNEL_LOCAL_MSAT: [u64; 3] = [500_000, 1_250_000, 80_000];
pub const CHANNEL_REMOTE_MSAT: [u64; 3] = [200_000, 750_000, 20_000];

pub const KIND_CHAT_MSAT: u64 = 1_000;
pub const KIND_LONGFORM_MSAT: u64 = 5_000;
pub const KIND_CALENDAR_MSAT: u64 = 2_500;
pub const KIND_FILE_MSAT: u64 = 8_000;
pub const KIND_COLLABORATION_MSAT: u64 = 4_000;
pub const KIND_SIGNALING_MSAT: u64 = 3_500;
pub const KIND_WEB_MSAT: u64 = 6_000;
pub const KIND_STORAGE_MSAT: u64 = 7_500;
pub const KIND_CONTROL_MSAT: u64 = 500;
pub const KIND_APP_MSAT: u64 = 9_000;
pub const CATEGORY_COMMUNICATION_MSAT: u64 = KIND_CHAT_MSAT;

pub const UPTIME_SECS: u64 = 172_800;
pub const CONNECTED_PEERS: u64 = 2;
pub const E2EE_SESSIONS: u64 = 11;
pub const PENDING_DELIVERIES: u64 = 13;
