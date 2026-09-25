//! Jarvis Phase 1 test bed: a deterministic mock of the BitSov read routes.
//!
//! No real node, no wallet, no socket. Callers pass a path to [`MockNode::serve`]
//! and get the JSON a loopback `GET` would return. The app binary does not
//! depend on this crate.
//!
//! Protocol pin: `v0.3.0-rc7`, source `958e3997f9969497c1d270f557282b9bb591fe85`.

mod answer;
mod canary;
mod ids;
mod serve;

pub use answer::{Answer, AnswerKey};
pub use canary::{
    ALIAS_01, ALIAS_02, CANARIES, COUNTERPARTY_01, COUNTERPARTY_02, COUNTERPARTY_03, ERROR_BODY_01,
    EXTRA_01, EXTRA_02, MEMO_01, MEMO_02, MSG_BODY_01, MSG_BODY_02, MSG_BODY_03, MSG_BODY_04,
    MSG_BODY_05, MSG_BODY_06, MSG_BODY_07, MSG_CIPHER_01, MSG_NESTED_01, PREIMAGE_01, PREIMAGE_02,
    SENT_NOTE_01,
};
pub use ids::{
    BLOCK_HEIGHT, DIFFICULTY_EPOCH_POSITION, LIGHTNING_NODE_PUBKEY, NODE_ID, SENDER_A, SENDER_B,
    SPENDABLE_ONCHAIN_SATS, TOTAL_LIGHTNING_BALANCE_SATS, VALID_BLOCKS,
};
pub use serve::{balance_msat, paths, Exchange, Fault, MockNode, ReadFailure, Route};
