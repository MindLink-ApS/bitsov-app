//! Budget-scoped node spend grants (genome G1, `spend_budget_grant_v1`).
//!
//! On a G1 node a paired token's `spend` comes only from a grant the owner
//! wrote at the control socket: an absolute expiry (at most 24 h), a total
//! budget, a per-call maximum and optional per-recipient budgets. The node
//! debits it before any invoice or payment and refuses with
//! `409 {"code":"budget_exceeded","reason":…}` otherwise.
//!
//! `GET /pair/grant` is the source of truth. This app reads it when an owner
//! grant lands, on startup/reconnect budget reads, and before every paid
//! request, and bounds its own
//! approvals by it: the budget approval and the ten-minute window never
//! outlive the node grant, and the budget approval's ceiling is never above
//! the grant's total. The app keeps the latest read in host memory only.
//!
//! A node without the capability keeps the pre-G1 behaviour
//! (`docs/CONTROL_CENTER_BUDGET.md`). When the capability cannot be read at
//! the moment authority would open, nothing opens.

use crate::format::amount;
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::act::ActionError;

/// `/status` → `api_capabilities` entry for budget grants.
pub const CAPABILITY: &str = "spend_budget_grant_v1";

/// Node-owned identity for each accepted relation approval.
pub const RELATION_ENVELOPE_ID_CAPABILITY: &str = "relation_envelope_id_v1";

/// `/status` → `api_capabilities` entry for one-time first-contact grants:
/// the stranger's signed quote before paying
/// (`POST /messages/first-contact/quote`) and the owner's one-time OK for
/// exactly that contact and amount (`POST /pair/first-contact-grant`).
pub const FIRST_CONTACT_CAPABILITY: &str = "first_contact_grant_v1";

/// The node's longest grant, and the default it proposes.
pub const MAX_TTL_SECS: u64 = 24 * 3600;

/// The node's shortest grant.
pub const MIN_TTL_SECS: u64 = 60;

/// Most per-recipient budgets one proposal may carry.
pub const MAX_RECIPIENT_BUDGETS: usize = 256;

/// The most any non-call payment (a message, file, room send or plain
/// payment) may pay under a grant, whatever per-payment limit the owner
/// signed. Mirrors the node: each such payment is capped at
/// `min(per_call_max_msat, this)`. Calls are not bound by it.
pub const MESSAGING_PER_CALL_MAX_MSAT: u64 = 6_000;

/// `GET /pair/grant` → `grant`: the caller's live grant, as the node reports it.
#[derive(Deserialize, Clone, Debug, PartialEq, Eq, Default)]
pub struct NodeGrant {
    #[serde(default)]
    pub client_id: String,
    #[serde(default)]
    pub op_id: String,
    /// Unix seconds.
    pub expires_at: i64,
    pub budget_msat: u64,
    pub used_msat: u64,
    pub remaining_msat: u64,
    pub per_call_max_msat: u64,
    #[serde(default)]
    pub per_recipient_msat: BTreeMap<String, u64>,
    #[serde(default)]
    pub used_by_recipient: BTreeMap<String, u64>,
    /// A relation grant (device-signed envelopes): only recipients with a
    /// live envelope may be paid.
    #[serde(default)]
    pub recipients_only: bool,
    /// Relation grants: the most one act may pay each recipient, msat.
    #[serde(default)]
    pub per_act_max_by_recipient: BTreeMap<String, u64>,
    /// Relation grants: when each envelope ends, unix seconds.
    #[serde(default)]
    pub recipient_expires_at: BTreeMap<String, i64>,
    /// Current node envelope IDs; null without capability support or a map.
    /// Individual recipients may be null (legacy/unknown identity).
    #[serde(default)]
    pub envelope_id_by_recipient: Option<BTreeMap<String, Option<String>>>,
    /// Optional node breaker state, preserved unchanged for the renderer.
    pub breakers: Option<serde_json::Map<String, serde_json::Value>>,
    /// The per-payment limit for each call payment, as the node reports it:
    /// `Some(Some(msat))` the owner's signed value, `Some(None)` for a
    /// relation grant (each envelope's per-act maximum binds instead),
    /// `None` when an older node does not report it.
    #[serde(default, deserialize_with = "reported")]
    pub call_per_payment_max_msat: Option<Option<u64>>,
    /// The node's effective cap on each non-call payment; `None` when an
    /// older node does not report it (then `min(per_call_max_msat, 6 sats)`).
    #[serde(default)]
    pub message_per_payment_max_msat: Option<u64>,
}

/// A field the node reports, even as null, versus one it omits.
fn reported<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<u64>>, D::Error> {
    Option::<u64>::deserialize(d).map(Some)
}

/// Parse `GET /pair/grant`. Anything but the documented shape is an error: a
/// reply without the `grant` key is unreadable, not "no grant".
pub fn parse(body: &str) -> Result<Option<NodeGrant>, ActionError> {
    let v: serde_json::Value = serde_json::from_str(body).map_err(|_| unreadable())?;
    let grant = v.as_object().and_then(|o| o.get("grant")).ok_or_else(unreadable)?;
    serde_json::from_value(grant.clone()).map_err(|_| unreadable())
}

pub fn unreadable() -> ActionError {
    ActionError::new(
        "grant_unknown",
        "Your node's spend budget could not be read. Nothing was sent or opened.",
    )
}

impl NodeGrant {
    pub fn expires_at_ms(&self) -> u64 {
        (self.expires_at.max(0) as u64).saturating_mul(1000)
    }

    pub fn live(&self, now_ms: u64) -> bool {
        self.expires_at_ms() > now_ms
    }

    /// What is left for one recipient, when the grant budgets them.
    pub fn recipient_left(&self, key: &str) -> Option<u64> {
        let key = key.to_ascii_lowercase();
        let cap = *self.per_recipient_msat.get(&key)?;
        Some(cap.saturating_sub(self.used_by_recipient.get(&key).copied().unwrap_or(0)))
    }

    /// Refuse before any request what the node would refuse. `recipient` is the
    /// node id of a single-peer message or file; rooms and payments pass None
    /// (the node checks each member or payee itself).
    pub fn check(&self, max_msat: u64, recipient: Option<&str>, now_ms: u64) -> Result<(), ActionError> {
        self.check_under(PaymentCap::Grant, max_msat, recipient, now_ms)
    }

    /// As `check`, for one call payment (an offer, a signal or a call block).
    /// The node caps each call payment by the call's own pinned per-block
    /// ceiling, which the owner consented to, and by the call per-payment
    /// limit (`per_payment_max(CallCeiling)`, or a relation envelope's per-act
    /// maximum), never by the 6-sat messaging cap. Expiry, the total budget
    /// and the recipient's budget always apply; the per-block ceiling is the
    /// node's to enforce.
    pub fn check_call(&self, max_msat: u64, recipient: Option<&str>, now_ms: u64) -> Result<(), ActionError> {
        self.check_under(PaymentCap::CallCeiling, max_msat, recipient, now_ms)
    }

    /// The grant-wide per-payment maximum under `cap`. A non-call payment: the
    /// node's reported message cap, else `min(per_call_max_msat, 6 sats)`. A
    /// call payment: the node's reported call limit, else the signed
    /// `per_call_max_msat` for an owner grant; a relation grant has none here
    /// (each envelope's per-act maximum binds each payment, per recipient).
    /// A sum of call payments (`CallTotal`) has none. An explicit payment
    /// (`Payment`): the signed `per_call_max_msat`, never the message cap.
    pub fn per_payment_max(&self, cap: PaymentCap) -> Option<u64> {
        match cap {
            PaymentCap::CallTotal => None,
            PaymentCap::Payment => Some(self.per_call_max_msat),
            PaymentCap::CallCeiling => match self.call_per_payment_max_msat {
                Some(Some(max)) => Some(max),
                _ if self.recipients_only => None,
                _ => Some(self.per_call_max_msat),
            },
            PaymentCap::Grant => Some(self.message_per_payment_max_msat
                .unwrap_or(self.per_call_max_msat.min(MESSAGING_PER_CALL_MAX_MSAT))),
        }
    }

    pub fn check_under(&self, cap: PaymentCap, max_msat: u64, recipient: Option<&str>, now_ms: u64) -> Result<(), ActionError> {
        if !self.live(now_ms) {
            return Err(ended());
        }
        // As the node: a relation grant is messaging authority and funds no
        // explicit payment. (An owner-approved grant is too, but the grant
        // view does not say so; the node's `messaging_grant` refusal does.)
        if cap == PaymentCap::Payment && self.recipients_only {
            return Err(messaging_grant());
        }
        if let Some(max) = self.per_payment_max(cap).filter(|max| max_msat > *max) {
            return Err(per_call(max));
        }
        if max_msat > self.remaining_msat {
            return Err(total(self.remaining_msat));
        }
        if let Some(left) = recipient.and_then(|r| self.recipient_left(r)) {
            if max_msat > left {
                return Err(recipient_left(left));
            }
        }
        if self.recipients_only {
            if let Some(r) = recipient {
                if !self.has_envelope(r, now_ms) {
                    return Err(no_envelope());
                }
                // As the node: an envelope without a per-act maximum pays
                // nothing. It bounds each payment on its own, never a sum of
                // a call's separate payments (`CallTotal`).
                let per_act = self.per_act_max_by_recipient.get(&r.to_ascii_lowercase()).copied().unwrap_or(0);
                if cap != PaymentCap::CallTotal && max_msat > per_act {
                    return Err(per_call(per_act));
                }
            }
        }
        Ok(())
    }

    /// Whether `recipient` has a live device-signed envelope.
    pub fn has_envelope(&self, recipient: &str, now_ms: u64) -> bool {
        let key = recipient.to_ascii_lowercase();
        self.recipients_only
            && self
                .recipient_expires_at
                .get(&key)
                .is_some_and(|at| ((*at).max(0) as u64).saturating_mul(1000) > now_ms)
    }
}

/// Which per-payment maximum bounds a payment under the grant.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaymentCap {
    /// One message, file, room or porch payment: the node's message cap, at
    /// most 6 sats.
    Grant,
    /// One explicit payment (an invoice or a keysend): the signed
    /// `per_call_max_msat`. The node exempts it from the message cap.
    Payment,
    /// One call payment: the call's own pinned per-block ceiling, enforced by
    /// the node, plus the call per-payment limit (or a relation envelope's
    /// per-act maximum).
    CallCeiling,
    /// A whole call's separate payments summed (offer plus hangup): expiry,
    /// the total budget, the recipient's budget and the envelope only. Each
    /// payment is checked on its own against [`PaymentCap::CallCeiling`] by
    /// the caller.
    CallTotal,
}

/// What the renderer is told about the node grant. No credentials or authority.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct GrantSummary {
    pub expires_at_ms: u64,
    pub budget_msat: u64,
    pub remaining_msat: u64,
    /// The per-payment limit the owner signed.
    pub per_call_max_msat: u64,
    /// The cap on each non-call payment (messages, files, rooms, payments).
    pub message_per_payment_max_msat: u64,
    /// The limit on each call payment; null for a relation grant, where each
    /// envelope's per-act maximum binds instead.
    pub call_per_payment_max_msat: Option<u64>,
    /// A relation grant: each contact with an envelope, and when it ends (ms).
    /// None for an owner console grant, which pays any contact within it.
    pub envelopes: Option<BTreeMap<String, u64>>,
    /// Node-owned IDs, preserved as reported; never inferred from grant terms.
    pub envelope_id_by_recipient: Option<BTreeMap<String, Option<String>>>,
    /// Remaining per-recipient budgets, keyed by lower-case node ID; unbudgeted peers are absent.
    pub recipient_left_msat_by_recipient: BTreeMap<String, u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub breakers: Option<serde_json::Map<String, serde_json::Value>>,
}

impl From<&NodeGrant> for GrantSummary {
    fn from(g: &NodeGrant) -> Self {
        Self {
            breakers: g.breakers.clone(),
            envelope_id_by_recipient: g.envelope_id_by_recipient.clone(),
            recipient_left_msat_by_recipient: g.per_recipient_msat.keys()
                .filter_map(|peer| g.recipient_left(peer).map(|left| (peer.to_ascii_lowercase(), left)))
                .collect(),
            expires_at_ms: g.expires_at_ms(),
            budget_msat: g.budget_msat,
            remaining_msat: g.remaining_msat,
            per_call_max_msat: g.per_call_max_msat,
            message_per_payment_max_msat: g.per_payment_max(PaymentCap::Grant).unwrap_or(0),
            call_per_payment_max_msat: g.per_payment_max(PaymentCap::CallCeiling),
            envelopes: g.recipients_only.then(|| {
                g.recipient_expires_at
                    .iter()
                    .map(|(peer, at)| (peer.clone(), ((*at).max(0) as u64).saturating_mul(1000)))
                    .collect()
            }),
        }
    }
}

/// The `budget` proposal on `POST /pair/elevation-request`. Only a suggestion:
/// the owner's flags at `konsensus grant` override it field by field.
pub fn proposal(budget_msat: u64, ttl_secs: u64, per_recipient: &BTreeMap<String, u64>) -> serde_json::Value {
    let ttl = ttl_secs.clamp(MIN_TTL_SECS, MAX_TTL_SECS);
    let mut out = serde_json::json!({ "budget_msat": budget_msat, "ttl_secs": ttl });
    // A proposal the node cannot enforce is a 400 and nothing is left pending,
    // so send per-recipient budgets only when every entry is well formed.
    let recipients: BTreeMap<String, u64> = per_recipient
        .iter()
        .map(|(k, v)| (k.to_ascii_lowercase(), (*v).min(budget_msat)))
        .collect();
    let well_formed = !recipients.is_empty()
        && recipients.len() <= MAX_RECIPIENT_BUDGETS
        && recipients
            .iter()
            .all(|(k, v)| *v > 0 && matches!(k.len(), 64 | 66) && k.bytes().all(|c| c.is_ascii_hexdigit()));
    if well_formed {
        out["per_recipient_msat"] = serde_json::json!(recipients);
    }
    out
}

// ---- `409 budget_exceeded` ------------------------------------------------------

/// A node refusal under the grant. Nothing was reserved or paid on the node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub reason: String,
    pub remaining_msat: Option<u64>,
}

/// `Some` only for `409 {"code":"budget_exceeded",…}`.
pub fn refusal(status: u16, body: &str) -> Option<Refusal> {
    if status != 409 {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    if v["code"] != "budget_exceeded" {
        return None;
    }
    Some(Refusal {
        reason: v["reason"].as_str().unwrap_or_default().chars().take(32).collect(),
        remaining_msat: v["remaining_msat"].as_u64(),
    })
}

impl Refusal {
    /// The grant itself is gone: every approval built on it must close.
    pub fn ends_grant(&self) -> bool {
        self.reason == "no_grant"
    }

    /// Per reason, what the owner is told. `known` is the last grant read, for
    /// numbers the node did not repeat.
    pub fn error(&self, known: Option<&NodeGrant>) -> ActionError {
        let left = self.remaining_msat;
        match self.reason.as_str() {
            "no_grant" => ended(),
            "messaging_grant" => messaging_grant(),
            "per_call" => per_call(known.map(|g| g.per_call_max_msat).unwrap_or(0)),
            "total" => total(left.or(known.map(|g| g.remaining_msat)).unwrap_or(0)),
            "recipient" => recipient_left(left.unwrap_or(0)),
            "unpriced" => ActionError::new(
                "grant_unpriced",
                "Your node can't pay this from a budget: its price isn't known before paying (an invoice without an amount, or a first contact). Nothing was sent.",
            ),
            "first_contact" => ActionError::new(
                "grant_first_contact",
                "Your node needs your OK for this first contact, and it did not get it. Nothing was sent. Confirm the first message again.",
            ),
            // M6 N3: the call-sized reservation made when an offer goes out.
            "call_liquidity_insufficient" => ActionError::new(
                "call_liquidity_insufficient",
                "Your node's channel cannot hold this call's reservation right now. Nothing was paid. Add outbound capacity, then call again.",
            ),
            "call_price_changed" => ActionError::new(
                "call_price_changed",
                "Their node now asks more per minute than this call reserved. Nothing more was paid.",
            ),
            "grant_paused" => ActionError::new(
                "grant_paused",
                "Your node paused spending after failed payments. Nothing was sent.",
            ),
            "failure_limit_pending" => ActionError::new(
                "grant_failures_pending",
                "Your node is waiting for unresolved payments before allowing more spending. Nothing was sent.",
            ),
            "rate_limit_minute" => ActionError::new(
                "grant_rate_limited",
                "Too many payments this minute. Nothing was sent. Wait a little before trying again.",
            ),
            "rate_limit_hour" => ActionError::new(
                "grant_rate_limited",
                "Too many payments this hour. Nothing was sent. Wait before trying again.",
            ),
            "velocity_limit" => ActionError::new(
                "grant_velocity",
                "Spending is too fast for this grant. Nothing was sent. Wait before trying again.",
            ),
            "ledger" => ActionError::new(
                "grant_ledger",
                "Your node could not record the spend, so it refused. Nothing was sent. Try again shortly.",
            ),
            _ => ActionError::new("grant_refused", "Your node refused this under its spend budget. Nothing was sent."),
        }
    }
}

/// The node's `messaging_grant` refusal: messaging authority (a relation or
/// owner-approved grant) never funds an explicit payment.
pub fn messaging_grant() -> ActionError {
    ActionError::new(
        "grant_messaging",
        "This permission covers messages and calls. Ask the owner to approve this payment separately. Nothing was paid.",
    )
}

/// A relation grant without an envelope for this contact.
pub fn no_envelope() -> ActionError {
    ActionError::new(
        "grant_no_envelope",
        "You have not approved spending for this contact yet. Nothing was sent. Approve this contact first.",
    )
}

pub fn ended() -> ActionError {
    ActionError::new(
        "grant_ended",
        "Your node's spend budget has ended (expired or revoked). Nothing was sent. Ask for a new budget.",
    )
}

/// A payment above the grant's per-payment maximum of `max_msat`.
pub fn per_call(max_msat: u64) -> ActionError {
    ActionError::new(
        "grant_per_call",
        format!("This is more than the {} per payment your node allows. Nothing was sent.", amount(max_msat)),
    )
}

fn total(remaining_msat: u64) -> ActionError {
    ActionError::new(
        "grant_exhausted",
        format!("Your node's spend budget has {} left, less than this costs. Nothing was sent. Ask for a new budget.", amount(remaining_msat)),
    )
}

fn recipient_left(remaining_msat: u64) -> ActionError {
    ActionError::new(
        "grant_recipient",
        format!("Your node's budget for this recipient has {} left, less than this costs. Nothing was sent.", amount(remaining_msat)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn grant(expires_at: i64) -> NodeGrant {
        NodeGrant {
            client_id: "c1".into(),
            op_id: "ab12".into(),
            expires_at,
            budget_msat: 10_000,
            used_msat: 4_000,
            remaining_msat: 6_000,
            per_call_max_msat: 3_000,
            per_recipient_msat: BTreeMap::from([(A.into(), 5_000)]),
            used_by_recipient: BTreeMap::from([(A.into(), 4_000)]),
            ..Default::default()
        }
    }

    #[test]
    fn summary_recipient_left_matches_grant_with_and_without_usage() {
        for (used, expected) in [(Some(4_000), 1_000), (None, 5_000)] {
            let mut g = grant(2_000_000_000);
            g.used_by_recipient = used.map(|v| BTreeMap::from([(A.into(), v)])).unwrap_or_default();
            let wire = serde_json::to_value(GrantSummary::from(&g)).unwrap();
            assert_eq!(wire["recipient_left_msat_by_recipient"], serde_json::json!({A: expected}));
            assert_eq!(g.recipient_left(&A.to_ascii_uppercase()), Some(expected));
        }
    }

    #[test]
    fn summary_recipient_left_saturates_when_usage_exceeds_cap() {
        let mut g = grant(2_000_000_000);
        g.used_by_recipient.insert(A.into(), 5_001);
        let wire = serde_json::to_value(GrantSummary::from(&g)).unwrap();
        assert_eq!(wire["recipient_left_msat_by_recipient"], serde_json::json!({A: 0}));
        assert_eq!(g.recipient_left(A), Some(0));
    }

    #[test]
    fn summary_recipient_left_omits_recipients_without_a_budget() {
        const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let mut g = grant(2_000_000_000);
        g.used_by_recipient.insert(B.into(), 100);
        g.recipient_expires_at.insert(B.into(), 2_000_000_000);
        g.recipients_only = true;
        let wire = serde_json::to_value(GrantSummary::from(&g)).unwrap();
        assert_eq!(wire["recipient_left_msat_by_recipient"], serde_json::json!({A: 1_000}));
        assert!(wire["recipient_left_msat_by_recipient"].get(B).is_none());
        assert_eq!(g.recipient_left(B), None);

        g.per_recipient_msat.clear();
        let wire = serde_json::to_value(GrantSummary::from(&g)).unwrap();
        assert_eq!(wire["recipient_left_msat_by_recipient"], serde_json::json!({}));
    }

    #[test]
    fn a_relation_grant_refuses_a_contact_outside_its_envelope_before_any_request() {
        const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let mut g = grant(2_000_000_000);
        g.recipients_only = true;
        g.per_act_max_by_recipient = BTreeMap::from([(A.into(), 500)]);
        g.recipient_expires_at = BTreeMap::from([(A.into(), 1_000)]);
        g.per_recipient_msat = BTreeMap::from([(A.into(), 5_000)]);
        g.used_by_recipient = BTreeMap::new();
        assert!(g.has_envelope(A, 999_000) && !g.has_envelope(B, 0));
        g.check(500, Some(A), 999_000).unwrap();
        assert_eq!(g.check(501, Some(A), 999_000).unwrap_err().code, "grant_per_call");
        assert_eq!(g.check(1, Some(B), 0).unwrap_err().code, "grant_no_envelope");
        // No per-act maximum on record: nothing may be paid, as on the node.
        g.per_act_max_by_recipient.clear();
        assert_eq!(g.check(1, Some(A), 999_000).unwrap_err().code, "grant_per_call");
        g.per_act_max_by_recipient = BTreeMap::from([(A.into(), 500)]);
        // The envelope's own end, before the grant's.
        assert_eq!(g.check(1, Some(A), 1_000_000).unwrap_err().code, "grant_no_envelope");
    }

    #[test]
    fn parses_the_node_shape_and_null() {
        assert_eq!(parse(r#"{"grant":null}"#).unwrap(), None);
        let body = serde_json::json!({"grant": {"op_id": "ab", "client_id": "c1", "granted_at": 1, "expires_at": 2_000_000_000,
            "budget_msat": 10, "used_msat": 0, "remaining_msat": 10, "per_call_max_msat": 10,
            "per_recipient_msat": {}, "used_by_recipient": {}}});
        let g = parse(&body.to_string()).unwrap().unwrap();
        assert_eq!((g.expires_at_ms(), g.remaining_msat), (2_000_000_000_000, 10));
        for bad in ["", "{}", r#"{"grant":{"expires_at":"soon"}}"#, "[]"] {
            assert_eq!(parse(bad).unwrap_err().code, "grant_unknown", "{bad}");
        }
    }

    #[test]
    fn breaker_state_passes_from_node_grant_to_renderer_unchanged() {
        let breakers = serde_json::json!({
            "limits": {"max_payments_per_minute": 2, "max_payments_per_hour": 12,
                "max_consecutive_failures": 3, "max_msat_per_10_minutes": 9000},
            "payments_last_minute": 1, "payments_last_hour": 7,
            "reserved_msat_last_10_minutes": 1234, "consecutive_failures": 3,
            "unresolved_payments": 2, "paused": true
        });
        let mut body = serde_json::json!({"grant": {"expires_at": 2000000000,
            "budget_msat": 10000, "used_msat": 1234, "remaining_msat": 8766,
            "per_call_max_msat": 1000, "breakers": breakers}});
        let g = parse(&body.to_string()).unwrap().unwrap();
        let wire = serde_json::to_value(GrantSummary::from(&g)).unwrap();
        assert_eq!(wire["breakers"], breakers);
        for absent in [false, true] {
            if absent { body["grant"].as_object_mut().unwrap().remove("breakers"); }
            else { body["grant"]["breakers"] = serde_json::Value::Null; }
            let g = parse(&body.to_string()).unwrap().unwrap();
            let wire = serde_json::to_value(GrantSummary::from(&g)).unwrap();
            assert!(wire.get("breakers").is_none());
        }
    }

    #[test]
    fn breaker_refusals_map_each_reason_without_ending_the_grant() {
        for (reason, code, message) in [
            ("grant_paused", "grant_paused", "Your node paused spending after failed payments. Nothing was sent."),
            ("failure_limit_pending", "grant_failures_pending", "Your node is waiting for unresolved payments before allowing more spending. Nothing was sent."),
            ("rate_limit_minute", "grant_rate_limited", "Too many payments this minute. Nothing was sent. Wait a little before trying again."),
            ("rate_limit_hour", "grant_rate_limited", "Too many payments this hour. Nothing was sent. Wait before trying again."),
            ("velocity_limit", "grant_velocity", "Spending is too fast for this grant. Nothing was sent. Wait before trying again."),
        ] {
            let body = serde_json::json!({"code":"budget_exceeded", "reason":reason}).to_string();
            let refusal = refusal(409, &body).unwrap();
            assert!(!refusal.ends_grant(), "{reason}");
            for known in [None, Some(grant(2000)).as_ref()] {
                let error = refusal.error(known);
                assert_eq!(error.code, code, "{reason}");
                assert_eq!(error.message, message, "{reason}");
            }
            assert!(super::refusal(403, &body).is_none());
            assert!(super::refusal(409, &serde_json::json!({"code":"other", "reason":reason}).to_string()).is_none());
        }
    }

    #[test]
    fn check_refuses_what_the_node_would() {
        let now = 1_000_000;
        let g = grant(2_000);
        g.check(1_000, Some(A), now).unwrap();
        assert_eq!(g.check(3_001, None, now).unwrap_err().code, "grant_per_call");
        assert_eq!(g.check(1_001, Some(A), now).unwrap_err().code, "grant_recipient");
        assert_eq!(g.check(1_001, Some(&A.to_ascii_uppercase()), now).unwrap_err().code, "grant_recipient");
        assert!(g.check(3_000, None, now).is_ok(), "an unbudgeted recipient is bounded by the total only");
        let mut low = grant(2_000);
        low.remaining_msat = 500;
        assert_eq!(low.check(1_000, None, now).unwrap_err().code, "grant_exhausted");
        assert_eq!(g.check(1, None, 2_000_000).unwrap_err().code, "grant_ended", "expiry is absolute");
    }

    #[test]
    fn messages_are_capped_at_six_sats_and_calls_at_the_signed_limit() {
        let now = 1_000_000;
        // The owner signed 50 sats per payment; an older node reports neither cap.
        let g = NodeGrant {
            expires_at: 2_000,
            budget_msat: 500_000,
            remaining_msat: 500_000,
            per_call_max_msat: 50_000,
            ..Default::default()
        };
        assert_eq!(g.per_payment_max(PaymentCap::Grant), Some(MESSAGING_PER_CALL_MAX_MSAT));
        assert_eq!(g.per_payment_max(PaymentCap::CallCeiling), Some(50_000));
        assert_eq!(g.per_payment_max(PaymentCap::CallTotal), None, "a sum of payments is not one payment");
        g.check(6_000, Some(A), now).unwrap();
        let message = g.check(6_001, Some(A), now).unwrap_err();
        assert_eq!(message.code, "grant_per_call");
        assert!(message.message.contains("6 sats"), "{}", message.message);
        g.check_call(50_000, Some(A), now).unwrap();
        assert_eq!(g.check_call(50_001, Some(A), now).unwrap_err().code, "grant_per_call");
        g.check_under(PaymentCap::CallTotal, 90_000, Some(A), now).unwrap();
        // A signed limit under 6 sats binds messages and calls alike.
        let small = NodeGrant { per_call_max_msat: 1_000, ..g.clone() };
        assert_eq!(small.check(1_001, Some(A), now).unwrap_err().code, "grant_per_call");
        let call = small.check_call(10_000, Some(A), now).unwrap_err();
        assert_eq!(call.code, "grant_per_call");
        assert!(call.message.contains("1 sat"), "{}", call.message);
        // Exactly 6 sats is the owner's value like any other: it binds calls.
        let six = NodeGrant { per_call_max_msat: MESSAGING_PER_CALL_MAX_MSAT, ..g.clone() };
        assert_eq!(six.check_call(6_001, Some(A), now).unwrap_err().code, "grant_per_call");
        // The node's reported caps win over the stored value.
        let reported = NodeGrant { message_per_payment_max_msat: Some(2_000), call_per_payment_max_msat: Some(Some(30_000)), ..g.clone() };
        assert_eq!(reported.check(2_001, Some(A), now).unwrap_err().code, "grant_per_call");
        reported.check_call(30_000, Some(A), now).unwrap();
        assert_eq!(reported.check_call(30_001, Some(A), now).unwrap_err().code, "grant_per_call");
        let summary = GrantSummary::from(&reported);
        assert_eq!((summary.message_per_payment_max_msat, summary.call_per_payment_max_msat), (2_000, Some(30_000)));
        let summary = GrantSummary::from(&small);
        assert_eq!((summary.message_per_payment_max_msat, summary.call_per_payment_max_msat), (1_000, Some(1_000)));
        // A null call limit on an owner grant falls back to the signed value.
        let null = NodeGrant { call_per_payment_max_msat: Some(None), ..g.clone() };
        assert_eq!(null.per_payment_max(PaymentCap::CallCeiling), Some(50_000));
        // Expiry, the total and the recipient's budget bind every cap.
        for cap in [PaymentCap::Grant, PaymentCap::CallCeiling, PaymentCap::CallTotal] {
            assert_eq!(g.check_under(cap, 1, Some(A), 2_000_000).unwrap_err().code, "grant_ended");
            let low = NodeGrant { remaining_msat: 500, ..g.clone() };
            assert_eq!(low.check_under(cap, 900, Some(A), now).unwrap_err().code, "grant_exhausted");
            let budgeted = NodeGrant { per_recipient_msat: BTreeMap::from([(A.into(), 700)]), ..g.clone() };
            assert_eq!(budgeted.check_under(cap, 900, Some(A), now).unwrap_err().code, "grant_recipient");
        }
    }

    #[test]
    fn an_explicit_payment_is_bounded_by_the_signed_limit_not_the_message_cap() {
        let now = 1_000_000;
        let g = NodeGrant {
            expires_at: 2_000,
            budget_msat: 500_000,
            remaining_msat: 500_000,
            per_call_max_msat: 50_000,
            message_per_payment_max_msat: Some(MESSAGING_PER_CALL_MAX_MSAT),
            ..Default::default()
        };
        assert_eq!(g.per_payment_max(PaymentCap::Payment), Some(50_000));
        g.check_under(PaymentCap::Payment, 10_000, None, now).unwrap();
        g.check_under(PaymentCap::Payment, 50_000, None, now).unwrap();
        assert_eq!(g.check_under(PaymentCap::Payment, 50_001, None, now).unwrap_err().code, "grant_per_call");
        assert_eq!(g.check(10_000, Some(A), now).unwrap_err().code, "grant_per_call", "a message keeps the 6-sat cap");
        // An older node reports no message cap: the payment still uses the signed value.
        let older = NodeGrant { message_per_payment_max_msat: None, ..g.clone() };
        older.check_under(PaymentCap::Payment, 10_000, None, now).unwrap();
        assert_eq!(older.check(6_001, Some(A), now).unwrap_err().code, "grant_per_call");
        // Expiry and the budgets still bind.
        assert_eq!(g.check_under(PaymentCap::Payment, 1, None, 2_000_000).unwrap_err().code, "grant_ended");
        let low = NodeGrant { remaining_msat: 9_999, ..g.clone() };
        assert_eq!(low.check_under(PaymentCap::Payment, 10_000, None, now).unwrap_err().code, "grant_exhausted");
    }

    #[test]
    fn a_messaging_grant_never_funds_an_explicit_payment() {
        let now = 1_000_000;
        let relation = NodeGrant {
            expires_at: 2_000,
            budget_msat: 500_000,
            remaining_msat: 500_000,
            per_call_max_msat: 50_000,
            recipients_only: true,
            per_act_max_by_recipient: BTreeMap::from([(A.into(), 50_000)]),
            recipient_expires_at: BTreeMap::from([(A.into(), 2_000)]),
            ..Default::default()
        };
        let err = relation.check_under(PaymentCap::Payment, 1_000, Some(A), now).unwrap_err();
        assert_eq!(err.code, "grant_messaging");
        assert_eq!(err.message, "This permission covers messages and calls. Ask the owner to approve this payment separately. Nothing was paid.");
        relation.check(1_000, Some(A), now).unwrap();
        // The node's refusal for an owner-approved grant maps to the same words.
        let refused = refusal(409, r#"{"code":"budget_exceeded","reason":"messaging_grant","remaining_msat":null}"#).unwrap();
        assert!(!refused.ends_grant());
        assert_eq!(refused.error(Some(&relation)), err);
    }

    #[test]
    fn parses_the_reported_caps() {
        let parsed = |field: &str| parse(&format!(r#"{{"grant":{{"expires_at":2000,"budget_msat":500000,"used_msat":0,"remaining_msat":500000,"per_call_max_msat":50000{field}}}}}"#)).unwrap().unwrap();
        let old = parsed("");
        assert_eq!((old.call_per_payment_max_msat, old.message_per_payment_max_msat), (None, None), "an older node omits them");
        assert_eq!(parsed(r#","call_per_payment_max_msat":null"#).call_per_payment_max_msat, Some(None));
        let new = parsed(r#","call_per_payment_max_msat":50000,"message_per_payment_max_msat":6000"#);
        assert_eq!((new.call_per_payment_max_msat, new.message_per_payment_max_msat), (Some(Some(50_000)), Some(6_000)));
    }

    #[test]
    fn a_relation_envelope_bounds_each_call_payment_not_their_sum() {
        let now = 1_000_000;
        let g = NodeGrant {
            expires_at: 2_000,
            budget_msat: 500_000,
            remaining_msat: 500_000,
            per_call_max_msat: 20_000,
            recipients_only: true,
            per_act_max_by_recipient: BTreeMap::from([(A.into(), 20_000)]),
            recipient_expires_at: BTreeMap::from([(A.into(), 2_000)]),
            call_per_payment_max_msat: Some(None),
            ..Default::default()
        };
        assert_eq!(g.per_payment_max(PaymentCap::CallCeiling), None, "the envelope binds, per recipient");
        assert_eq!(GrantSummary::from(&g).call_per_payment_max_msat, None);
        // A 15-sat offer plus a 6-sat hangup under a 20-sat envelope: each
        // payment fits it; only the budgets bound their 21-sat sum.
        g.check_under(PaymentCap::CallTotal, 21_000, Some(A), now).unwrap();
        g.check_call(15_000, Some(A), now).unwrap();
        g.check_call(6_000, Some(A), now).unwrap();
        assert_eq!(g.check_call(21_000, Some(A), now).unwrap_err().code, "grant_per_call", "one payment above the envelope");
        // The sum still needs a live envelope and the budgets.
        const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        assert_eq!(g.check_under(PaymentCap::CallTotal, 21_000, Some(B), now).unwrap_err().code, "grant_no_envelope");
        let budgeted = NodeGrant { per_recipient_msat: BTreeMap::from([(A.into(), 20_000)]), ..g.clone() };
        assert_eq!(budgeted.check_under(PaymentCap::CallTotal, 21_000, Some(A), now).unwrap_err().code, "grant_recipient");
        // A message under the envelope keeps the 6-sat cap.
        assert_eq!(g.check(6_001, Some(A), now).unwrap_err().code, "grant_per_call");
    }

    #[test]
    fn call_reservation_refusals_are_named() {
        let r = |reason: &str| refusal(409, &serde_json::json!({"code": "budget_exceeded", "reason": reason, "remaining_msat": null}).to_string()).unwrap();
        assert_eq!(r("call_liquidity_insufficient").error(None).code, "call_liquidity_insufficient");
        assert_eq!(r("call_price_changed").error(None).code, "call_price_changed");
    }

    #[test]
    fn refusals_map_per_reason_and_only_for_budget_exceeded() {
        let r = |reason: &str| refusal(409, &serde_json::json!({"code": "budget_exceeded", "reason": reason, "remaining_msat": 500}).to_string()).unwrap();
        let g = grant(2_000);
        assert_eq!(r("no_grant").error(None).code, "grant_ended");
        assert!(r("no_grant").ends_grant() && !r("total").ends_grant());
        assert!(r("per_call").error(Some(&g)).message.contains("3 sats"));
        assert!(r("total").error(None).message.contains("500 msat left"));
        assert_eq!(r("recipient").error(None).code, "grant_recipient");
        assert_eq!(r("unpriced").error(None).code, "grant_unpriced");
        assert_eq!(r("ledger").error(None).code, "grant_ledger");
        assert_eq!(r("something_new").error(None).code, "grant_refused");
        assert_eq!(refusal(409, r#"{"code":"price_cap_exceeded"}"#), None);
        assert_eq!(refusal(400, r#"{"code":"budget_exceeded"}"#), None);
        assert_eq!(refusal(409, "not json"), None);
    }

    #[test]
    fn a_proposal_is_bounded_and_drops_recipients_it_cannot_state() {
        let p = proposal(2_000, 999_999, &BTreeMap::new());
        assert_eq!(p, serde_json::json!({"budget_msat": 2_000, "ttl_secs": MAX_TTL_SECS}));
        assert_eq!(proposal(2_000, 1, &BTreeMap::new())["ttl_secs"], MIN_TTL_SECS);
        let upper = A.to_ascii_uppercase();
        let p = proposal(2_000, 600, &BTreeMap::from([(upper, 5_000)]));
        assert_eq!(p["per_recipient_msat"], serde_json::json!({A: 2_000}), "lowercased and never above the total");
        let p = proposal(2_000, 600, &BTreeMap::from([("not-hex".to_string(), 5)]));
        assert!(p.get("per_recipient_msat").is_none());
        let many: BTreeMap<String, u64> = (0..=MAX_RECIPIENT_BUDGETS).map(|i| (format!("{i:064x}"), 1)).collect();
        assert!(proposal(2_000, 600, &many).get("per_recipient_msat").is_none());
    }
}
