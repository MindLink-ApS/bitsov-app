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

/// The per-payment maximum a node stores on a grant when it imposes its
/// messaging clamp rather than a limit the owner chose. Mirrors the node: a
/// stored `per_call_max_msat` exactly equal to this sets no extra per-payment
/// limit for calls (each call payment is bounded by the call's own pinned
/// per-block ceiling); any other stored value is the owner's own limit, which
/// call payments must also respect.
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

    /// As `check`, for a call offer or a call block. The node caps each call
    /// payment by the call's own pinned per-block ceiling, which the owner
    /// consented to. The grant's per-call maximum binds a call too, unless it
    /// is only the node's messaging clamp (`MESSAGING_PER_CALL_MAX_MSAT`).
    /// Expiry, the total budget and the recipient's budget always apply; the
    /// per-block ceiling is the node's to enforce.
    pub fn check_call(&self, max_msat: u64, recipient: Option<&str>, now_ms: u64) -> Result<(), ActionError> {
        self.check_under(PaymentCap::CallCeiling, max_msat, recipient, now_ms)
    }

    /// The per-payment maximum the grant sets under `cap`. `None` for a call
    /// when the grant carries only the node's messaging clamp.
    pub fn per_payment_max(&self, cap: PaymentCap) -> Option<u64> {
        match cap {
            PaymentCap::CallTotal => None,
            PaymentCap::CallCeiling if self.per_call_max_msat == MESSAGING_PER_CALL_MAX_MSAT => None,
            PaymentCap::Grant | PaymentCap::CallCeiling => Some(self.per_call_max_msat),
        }
    }

    pub fn check_under(&self, cap: PaymentCap, max_msat: u64, recipient: Option<&str>, now_ms: u64) -> Result<(), ActionError> {
        if !self.live(now_ms) {
            return Err(ended());
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
                // As the node: an envelope without a per-act maximum pays nothing.
                let per_act = self.per_act_max_by_recipient.get(&r.to_ascii_lowercase()).copied().unwrap_or(0);
                if max_msat > per_act {
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
    /// The grant's advertised `per_call_max_msat`: messages, files, rooms and payments.
    Grant,
    /// The call's own pinned per-block ceiling, enforced by the node, plus
    /// the grant's per-call maximum when the owner chose it (anything but
    /// `MESSAGING_PER_CALL_MAX_MSAT`).
    CallCeiling,
    /// A whole call's separate payments summed (offer plus hangup): expiry,
    /// the total budget and the recipient's budget only. Each payment is
    /// checked on its own against [`PaymentCap::CallCeiling`] by the caller.
    CallTotal,
}

/// What the renderer is told about the node grant. No credentials or authority.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct GrantSummary {
    pub expires_at_ms: u64,
    pub budget_msat: u64,
    pub remaining_msat: u64,
    pub per_call_max_msat: u64,
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
    fn a_call_is_bounded_by_the_total_not_the_message_per_call_cap() {
        let now = 1_000_000;
        let g = NodeGrant {
            expires_at: 2_000,
            budget_msat: 500_000,
            remaining_msat: 500_000,
            per_call_max_msat: 6_000,
            ..Default::default()
        };
        g.check_call(21_000, Some(A), now).unwrap();
        assert_eq!(g.check_under(PaymentCap::CallCeiling, 21_000, None, now), Ok(()));
        assert_eq!(g.check(21_000, Some(A), now).unwrap_err().code, "grant_per_call", "a message keeps the per-call cap");
        assert_eq!(g.check_call(500_001, Some(A), now).unwrap_err().code, "grant_exhausted");
        assert_eq!(g.check_call(1, Some(A), 2_000_000).unwrap_err().code, "grant_ended");
        let mut budgeted = g.clone();
        budgeted.per_recipient_msat = BTreeMap::from([(A.into(), 20_000)]);
        assert_eq!(budgeted.check_call(21_000, Some(A), now).unwrap_err().code, "grant_recipient");
    }

    #[test]
    fn an_owner_chosen_per_call_limit_binds_calls_but_the_messaging_clamp_does_not() {
        let now = 1_000_000;
        let owner = NodeGrant {
            expires_at: 2_000,
            budget_msat: 500_000,
            remaining_msat: 500_000,
            per_call_max_msat: 1_000,
            ..Default::default()
        };
        assert_eq!(owner.per_payment_max(PaymentCap::CallCeiling), Some(1_000));
        assert_eq!(owner.per_payment_max(PaymentCap::CallTotal), None, "a sum of payments is not one payment");
        assert_eq!(owner.check_under(PaymentCap::CallTotal, 21_000, Some(A), now), Ok(()));
        assert_eq!(owner.check_call(10_000, Some(A), now).unwrap_err().code, "grant_per_call");
        assert!(owner.check_call(10_000, Some(A), now).unwrap_err().message.contains("1 sat"));
        owner.check_call(1_000, Some(A), now).unwrap();
        // One msat either side of the clamp is the owner's own limit.
        for per_call in [MESSAGING_PER_CALL_MAX_MSAT - 1, MESSAGING_PER_CALL_MAX_MSAT + 1] {
            let g = NodeGrant { per_call_max_msat: per_call, ..owner.clone() };
            assert_eq!(g.check_call(10_000, Some(A), now).unwrap_err().code, "grant_per_call", "{per_call}");
        }

        let clamp = NodeGrant { per_call_max_msat: MESSAGING_PER_CALL_MAX_MSAT, ..owner.clone() };
        assert_eq!(clamp.per_payment_max(PaymentCap::CallCeiling), None);
        assert_eq!(clamp.per_payment_max(PaymentCap::Grant), Some(MESSAGING_PER_CALL_MAX_MSAT));
        clamp.check_call(10_000, Some(A), now).unwrap();
        assert_eq!(clamp.check(10_000, Some(A), now).unwrap_err().code, "grant_per_call", "a message keeps the clamp");

        // Expiry, the total and the recipient's budget bind either way.
        for g in [&owner, &clamp] {
            assert_eq!(g.check_call(1, Some(A), 2_000_000).unwrap_err().code, "grant_ended");
            let low = NodeGrant { remaining_msat: 500, ..g.clone() };
            assert_eq!(low.check_call(900, Some(A), now).unwrap_err().code, "grant_exhausted");
            let budgeted = NodeGrant { per_recipient_msat: BTreeMap::from([(A.into(), 700)]), ..g.clone() };
            assert_eq!(budgeted.check_call(900, Some(A), now).unwrap_err().code, "grant_recipient");
        }
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
