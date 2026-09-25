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

/// Spendable on-chain sats. The public balance route does not split this out;
/// see `balance_msat` in the serve module.
pub const ONCHAIN_SATS: u64 = 150_000;

/// Local channel balances, millisatoshis. Sum is the Lightning portion of
/// `GET /payments/balance`.
pub const CHANNEL_LOCAL_MSAT: [u64; 3] = [500_000, 1_250_000, 80_000];
pub const CHANNEL_REMOTE_MSAT: [u64; 3] = [200_000, 750_000, 20_000];

pub const KIND_CHAT_MSAT: u64 = 1_000;
pub const KIND_LONGFORM_MSAT: u64 = 5_000;
pub const KIND_CALENDAR_MSAT: u64 = 2_500;
pub const KIND_FILE_MSAT: u64 = 8_000;
pub const CATEGORY_COMMUNICATION_MSAT: u64 = 1_000;

pub const UPTIME_SECS: u64 = 172_800;
pub const CONNECTED_PEERS: u64 = 2;
pub const E2EE_SESSIONS: u64 = 4;
pub const PENDING_DELIVERIES: u64 = 7;
