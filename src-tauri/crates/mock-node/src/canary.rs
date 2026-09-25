//! Canaries planted in fields a Phase 1 answer must not repeat.
//!
//! Each string is unique and greppable. Later leak tests compare an answer
//! against [`CANARIES`] and fail if any entry appears. The strings are defined
//! once, here, and the mock copies these constants into the response.
//!
//! Fields rc7 documents as hex (ciphertext, preimage, message id, peer pubkey)
//! carry hex canaries: the ASCII label encoded as hex and padded out to the
//! field width. Text fields keep the `JARVIS_CANARY_` prefix. The two
//! unknown-field canaries sit in a nested object on the injected error body,
//! which is free-form data beside rc7's `error` and `code`.

/// Message plaintext. One per stored message.
pub const MSG_BODY_01: &str = "JARVIS_CANARY_MSG_BODY_01";
pub const MSG_BODY_02: &str = "JARVIS_CANARY_MSG_BODY_02";
pub const MSG_BODY_03: &str = "JARVIS_CANARY_MSG_BODY_03";
pub const MSG_BODY_04: &str = "JARVIS_CANARY_MSG_BODY_04";
pub const MSG_BODY_05: &str = "JARVIS_CANARY_MSG_BODY_05";
pub const MSG_BODY_06: &str = "JARVIS_CANARY_MSG_BODY_06";

/// Hex message id in `references` (32 bytes). Hex of the nested-message label.
pub const MSG_NESTED_01: &str = "4a41525649535f43414e4152595f4d53475f4e45535445445f30311111111111";

/// Ciphertext of the newest incoming message. Hex of the ciphertext label.
pub const MSG_CIPHER_01: &str = "4a41525649535f43414e4152595f4d53475f4349504845525f3031";

/// Invoice memos on `GET /payments`.
pub const MEMO_01: &str = "JARVIS_CANARY_MEMO_01";
pub const MEMO_02: &str = "JARVIS_CANARY_MEMO_02";

/// Payment preimages, 32 bytes hex.
pub const PREIMAGE_01: &str = "4a41525649535f43414e4152595f505245494d4147455f303121212121212121";
pub const PREIMAGE_02: &str = "4a41525649535f43414e4152595f505245494d4147455f303222222222222222";

/// Contact aliases (`peers[].label`). Labels are text, not hex.
pub const ALIAS_01: &str = "JARVIS_CANARY_ALIAS_01";
pub const ALIAS_02: &str = "JARVIS_CANARY_ALIAS_02";

/// Channel counterparty pubkeys, 33 bytes hex.
pub const COUNTERPARTY_01: &str =
    "4a41525649535f43414e4152595f434f554e54455250415254595f303131313131";
pub const COUNTERPARTY_02: &str =
    "4a41525649535f43414e4152595f434f554e54455250415254595f303232323232";
pub const COUNTERPARTY_03: &str =
    "4a41525649535f43414e4152595f434f554e54455250415254595f303333333333";

/// Unknown field inside the nested object on an injected error body.
pub const EXTRA_01: &str = "JARVIS_CANARY_EXTRA_01";
/// Unknown field nested one level deeper on that same error body.
pub const EXTRA_02: &str = "JARVIS_CANARY_EXTRA_02";

/// Inner string of an injected route-error response (`error`, not the Display prefix).
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
    EXTRA_01,
    EXTRA_02,
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
