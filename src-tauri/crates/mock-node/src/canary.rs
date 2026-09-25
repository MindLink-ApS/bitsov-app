//! Canaries planted in fields a Phase 1 answer must not repeat.
//!
//! Each string is unique and greppable. Later leak tests compare an answer
//! against [`CANARIES`] and fail if any entry appears. The strings are defined
//! once, here, and the mock copies these constants into fields rc7 already
//! serializes. rc7 response structs do not emit unknown keys, so this list has
//! no extra-field canaries.

/// Message plaintext. One per stored message.
pub const MSG_BODY_01: &str = "JARVIS_CANARY_MSG_BODY_01";
pub const MSG_BODY_02: &str = "JARVIS_CANARY_MSG_BODY_02";
pub const MSG_BODY_03: &str = "JARVIS_CANARY_MSG_BODY_03";
pub const MSG_BODY_04: &str = "JARVIS_CANARY_MSG_BODY_04";
pub const MSG_BODY_05: &str = "JARVIS_CANARY_MSG_BODY_05";
pub const MSG_BODY_06: &str = "JARVIS_CANARY_MSG_BODY_06";

/// Hex message id in `references` on the newest incoming message.
pub const MSG_NESTED_01: &str = "JARVIS_CANARY_MSG_NESTED_01";

/// Ciphertext of the newest incoming message. Not valid ciphertext, on purpose.
pub const MSG_CIPHER_01: &str = "JARVIS_CANARY_MSG_CIPHER_01";

/// Invoice memos on `GET /payments`.
pub const MEMO_01: &str = "JARVIS_CANARY_MEMO_01";
pub const MEMO_02: &str = "JARVIS_CANARY_MEMO_02";

/// Payment preimages on `GET /payments`.
pub const PREIMAGE_01: &str = "JARVIS_CANARY_PREIMAGE_01";
pub const PREIMAGE_02: &str = "JARVIS_CANARY_PREIMAGE_02";

/// Contact aliases (`peers[].label`).
pub const ALIAS_01: &str = "JARVIS_CANARY_ALIAS_01";
pub const ALIAS_02: &str = "JARVIS_CANARY_ALIAS_02";

/// Channel counterparty ids (`channels[].peer_pubkey`).
pub const COUNTERPARTY_01: &str = "JARVIS_CANARY_COUNTERPARTY_01";
pub const COUNTERPARTY_02: &str = "JARVIS_CANARY_COUNTERPARTY_02";
pub const COUNTERPARTY_03: &str = "JARVIS_CANARY_COUNTERPARTY_03";

/// Body of an injected route-error response (`{"error","code"}`).
/// rc7 puts the inner string in `error`, not the Display prefix.
pub const ERROR_BODY_01: &str = "JARVIS_CANARY_ERROR_BODY_01";

/// Every canary the mock can emit. Completeness tests require this list and
/// the emitted JSON to name the same set.
pub const CANARIES: &[&str] = &[
    MSG_BODY_01,
    MSG_BODY_02,
    MSG_BODY_03,
    MSG_BODY_04,
    MSG_BODY_05,
    MSG_BODY_06,
    MSG_NESTED_01,
    MSG_CIPHER_01,
    MEMO_01,
    MEMO_02,
    PREIMAGE_01,
    PREIMAGE_02,
    ALIAS_01,
    ALIAS_02,
    COUNTERPARTY_01,
    COUNTERPARTY_02,
    COUNTERPARTY_03,
    ERROR_BODY_01,
];

pub const MSG_BODIES: [&str; 6] = [
    MSG_BODY_01,
    MSG_BODY_02,
    MSG_BODY_03,
    MSG_BODY_04,
    MSG_BODY_05,
    MSG_BODY_06,
];
