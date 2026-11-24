//! MCP client grants: contract types and a pure, fail-closed checker.
//!
//! **Not wired.** This module is the first slice of the design in
//! `docs/AI-MCP-DESIGN.md` ("MCP clients bound by sats and scopes"), which is
//! added by the design pull request (#392); merge that first. Nothing
//! here is registered as a Tauri command, reaches the node, the spend journal,
//! the payment path or any listener. It compiles only under `cfg(test)` or the
//! off-by-default `mcp-grant` feature, so the shipped app does not contain it.
//!
//! MCP is an adjacent layer, never core. The node's own debit of the client's
//! G1 grant stays the hard bound on money (design, section 5.5). This checker
//! only makes host refusals earlier and clearer; it never widens what the node
//! allows, and a future caller must still send every write through the node.
//!
//! [`check`] answers one question: may this client make this request now,
//! given what it already spent under this grant? Every path that
//! is not an explicit allow is a refusal, and refusals have stable codes
//! ([`Refusal::code`]) for the audit log (design, section 5.7).
//!
//! **One budget per grant.** `budget_sats` covers the whole life of the grant
//! (at most 24 h). There is no rolling window and no refill: once the budget
//! is spent the client waits for the owner's renewal, which is a new grant
//! with a new issue time and its own spend record.
//!
//! Checks run in a fixed order and the first refusal wins:
//!
//! 1. the grant is well formed (`malformed_grant`)
//! 2. the request names the grant's own client (`client_mismatch`)
//! 3. the grant is not revoked (`revoked`)
//! 4. the request stamp and the host clock are within [`MAX_CLOCK_SKEW_MS`]
//!    (`clock_skew`)
//! 5. the grant has not expired (`expired`), with no grace at the end
//! 6. the scope is one of the closed list (`unknown_scope`)
//! 7. the scope is granted (`scope_not_granted`)
//! 8. a read carries no amount and no recipient (`scope_escalation`)
//! 9. a write runs only on a `recipients_only` grant (`not_recipients_only`)
//! 10. `pay` runs only when the node supports explicit pay to named
//!     recipients ([`NodeCaps`], off by default) (`pay_not_supported_by_node`)
//! 11. the amount is a positive whole number of sats (`non_positive_amount`)
//! 12. the recipient is named by the grant (`recipient_not_allowed`)
//! 13. the amount is within the per-call cap, and a message within the node's
//!     6-sat cap (`over_per_call`)
//! 14. the spend record belongs to this grant (`spend_record_invalid`)
//! 15. spent + amount does not overflow (`overflow`)
//! 16. spent + amount is within the grant's budget (`over_budget`)

use std::collections::BTreeSet;

/// Longest a client grant may live, matching the node's G1 maximum (24 h).
pub const MAX_GRANT_LIFETIME_MS: u64 = 24 * 60 * 60 * 1000;

/// Largest accepted difference between the host clock and a request's stamp,
/// and how far the host clock may sit before a grant's issue time.
pub const MAX_CLOCK_SKEW_MS: u64 = 2 * 60 * 1000;

/// The node caps each paid message at 6 sats all-in (design, section 5.3).
pub const MESSAGE_MAX_SATS: u64 = 6;

/// Longest accepted client id.
pub const CLIENT_ID_MAX_LEN: usize = 64;

/// One paired MCP client's identity. Lowercase ASCII letters, digits, `-` and
/// `_`, starting with a letter or digit, at most [`CLIENT_ID_MAX_LEN`] bytes.
/// Compared byte for byte: no case folding, no normalisation.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ClientId(String);

impl ClientId {
    pub fn parse(raw: &str) -> Option<ClientId> {
        let bytes = raw.as_bytes();
        let first_ok = bytes.first().is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
        let rest_ok = bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-' || *b == b'_');
        (first_ok && rest_ok && bytes.len() <= CLIENT_ID_MAX_LEN).then(|| ClientId(raw.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// App-level scopes, chosen per client by the owner (design, section 5.3).
/// The list is closed: anything else is `unknown_scope`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Scope {
    Read,
    Message,
    Pay,
    Call,
}

impl Scope {
    pub const ALL: [Scope; 4] = [Scope::Read, Scope::Message, Scope::Pay, Scope::Call];

    /// Exact, case-sensitive match against the closed list.
    pub fn parse(raw: &str) -> Option<Scope> {
        Scope::ALL.into_iter().find(|s| s.as_str() == raw)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Scope::Read => "read",
            Scope::Message => "message",
            Scope::Pay => "pay",
            Scope::Call => "call",
        }
    }

    /// Scopes that move sats. These need a `recipients_only` grant.
    pub fn spends(self) -> bool {
        !matches!(self, Scope::Read)
    }
}

/// What the owner granted one client. Mirrors the node grant the client's
/// writes will be debited from; the node copy stays the source of truth.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientGrant {
    pub client_id: ClientId,
    pub scopes: BTreeSet<Scope>,
    /// Sats the client may spend over the whole life of this grant. Never
    /// refilled: more needs a new grant from the owner.
    pub budget_sats: u64,
    /// Largest single write, in sats. Never above `budget_sats`.
    pub per_call_max_sats: u64,
    /// Also identifies this grant's spend record (see [`GrantSpend`]).
    pub issued_at_ms: u64,
    /// Exclusive: the grant is dead at this instant.
    pub expires_at_ms: u64,
    /// Any value means revoked, whatever the time.
    pub revoked_at_ms: Option<u64>,
    /// Owner decision: MCP client grants pay only named recipients, always.
    pub recipients_only: bool,
    /// Named recipients (node ids), compared byte for byte.
    pub recipients: BTreeSet<String>,
}

impl ClientGrant {
    /// A grant that allows nothing: no scopes, no budget, no lifetime.
    pub fn empty(client_id: ClientId) -> ClientGrant {
        ClientGrant {
            client_id,
            scopes: BTreeSet::new(),
            budget_sats: 0,
            per_call_max_sats: 0,
            issued_at_ms: 0,
            expires_at_ms: 0,
            revoked_at_ms: None,
            recipients_only: true,
            recipients: BTreeSet::new(),
        }
    }

    fn well_formed(&self) -> bool {
        !self.scopes.is_empty()
            && self.budget_sats > 0
            && self.per_call_max_sats > 0
            && self.per_call_max_sats <= self.budget_sats
            && self.expires_at_ms > self.issued_at_ms
            && self.expires_at_ms - self.issued_at_ms <= MAX_GRANT_LIFETIME_MS
    }
}

/// One tool call as the host would see it, before any trust is given.
/// Fields stay raw so the checker, not the caller, decides what is valid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request<'a> {
    pub client_id: &'a str,
    pub scope: &'a str,
    /// Signed so a negative amount from the wire is refused, not wrapped.
    pub amount_sats: i64,
    pub recipient: Option<&'a str>,
    /// The client's own timestamp for the call.
    pub sent_at_ms: u64,
}

/// What the caller has recorded as spent by this client under one grant.
/// The caller's ledger is not trusted: a record that names another grant is
/// refused, never read as a fresh zero.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GrantSpend {
    /// `issued_at_ms` of the grant the record belongs to.
    pub grant_issued_at_ms: u64,
    pub sats: u64,
}

/// What the node can do today. The checker never allows a call the node
/// would refuse. `Default` is the node as it is now: no explicit pay on a
/// `recipients_only` grant until that node feature exists and is proven.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct NodeCaps {
    pub node_supports_recipient_pay: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Refuse(Refusal),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Refusal {
    MalformedGrant,
    ClientMismatch,
    Revoked,
    ClockSkew,
    Expired,
    UnknownScope,
    ScopeNotGranted,
    ScopeEscalation,
    NotRecipientsOnly,
    PayNotSupportedByNode,
    NonPositiveAmount,
    RecipientNotAllowed,
    OverPerCall,
    SpendRecordInvalid,
    Overflow,
    OverBudget,
}

impl Refusal {
    pub const ALL: [Refusal; 16] = [
        Refusal::MalformedGrant,
        Refusal::ClientMismatch,
        Refusal::Revoked,
        Refusal::ClockSkew,
        Refusal::Expired,
        Refusal::UnknownScope,
        Refusal::ScopeNotGranted,
        Refusal::ScopeEscalation,
        Refusal::NotRecipientsOnly,
        Refusal::PayNotSupportedByNode,
        Refusal::NonPositiveAmount,
        Refusal::RecipientNotAllowed,
        Refusal::OverPerCall,
        Refusal::SpendRecordInvalid,
        Refusal::Overflow,
        Refusal::OverBudget,
    ];

    /// Stable code for the audit log.
    pub fn code(self) -> &'static str {
        match self {
            Refusal::MalformedGrant => "malformed_grant",
            Refusal::ClientMismatch => "client_mismatch",
            Refusal::Revoked => "revoked",
            Refusal::ClockSkew => "clock_skew",
            Refusal::Expired => "expired",
            Refusal::UnknownScope => "unknown_scope",
            Refusal::ScopeNotGranted => "scope_not_granted",
            Refusal::ScopeEscalation => "scope_escalation",
            Refusal::NotRecipientsOnly => "not_recipients_only",
            Refusal::PayNotSupportedByNode => "pay_not_supported_by_node",
            Refusal::NonPositiveAmount => "non_positive_amount",
            Refusal::RecipientNotAllowed => "recipient_not_allowed",
            Refusal::OverPerCall => "over_per_call",
            Refusal::SpendRecordInvalid => "spend_record_invalid",
            Refusal::Overflow => "overflow",
            Refusal::OverBudget => "over_budget",
        }
    }
}

/// Pure, fail-closed authorization check. See the module docs for the order.
pub fn check(grant: &ClientGrant, req: &Request<'_>, now_ms: u64, spent: GrantSpend, node: NodeCaps) -> Decision {
    match check_inner(grant, req, now_ms, spent, node) {
        Ok(()) => Decision::Allow,
        Err(r) => Decision::Refuse(r),
    }
}

fn check_inner(grant: &ClientGrant, req: &Request<'_>, now_ms: u64, spent: GrantSpend, node: NodeCaps) -> Result<(), Refusal> {
    if !grant.well_formed() {
        return Err(Refusal::MalformedGrant);
    }
    if req.client_id != grant.client_id.as_str() {
        return Err(Refusal::ClientMismatch);
    }
    if grant.revoked_at_ms.is_some() {
        return Err(Refusal::Revoked);
    }
    if now_ms.abs_diff(req.sent_at_ms) > MAX_CLOCK_SKEW_MS
        || now_ms < grant.issued_at_ms.saturating_sub(MAX_CLOCK_SKEW_MS)
    {
        return Err(Refusal::ClockSkew);
    }
    if now_ms >= grant.expires_at_ms {
        return Err(Refusal::Expired);
    }
    let scope = Scope::parse(req.scope).ok_or(Refusal::UnknownScope)?;
    if !grant.scopes.contains(&scope) {
        return Err(Refusal::ScopeNotGranted);
    }
    if !scope.spends() {
        // A read moves nothing. Anything that looks like a spend is an attempt
        // to borrow a write through the read scope.
        if req.amount_sats != 0 || req.recipient.is_some() {
            return Err(Refusal::ScopeEscalation);
        }
        return Ok(());
    }
    if !grant.recipients_only {
        return Err(Refusal::NotRecipientsOnly);
    }
    if scope == Scope::Pay && !node.node_supports_recipient_pay {
        return Err(Refusal::PayNotSupportedByNode);
    }
    let amount = u64::try_from(req.amount_sats).ok().filter(|a| *a > 0).ok_or(Refusal::NonPositiveAmount)?;
    match req.recipient {
        Some(r) if grant.recipients.contains(r) => {}
        _ => return Err(Refusal::RecipientNotAllowed),
    }
    let per_call = match scope {
        Scope::Message => grant.per_call_max_sats.min(MESSAGE_MAX_SATS),
        _ => grant.per_call_max_sats,
    };
    if amount > per_call {
        return Err(Refusal::OverPerCall);
    }
    if spent.grant_issued_at_ms != grant.issued_at_ms {
        return Err(Refusal::SpendRecordInvalid);
    }
    let total = spent.sats.checked_add(amount).ok_or(Refusal::Overflow)?;
    if total > grant.budget_sats {
        return Err(Refusal::OverBudget);
    }
    Ok(())
}

/// Phase 1, slice 1: the read-only MCP protocol skeleton (not wired).
pub mod server;
/// Phase 1, slice 2: per-client sessions (registry, revoke, rate limit, audit; not wired).
pub mod session;
/// Phase 1, slice 3: the read broker (closed node reads, counts by default; not wired).
pub mod broker;
/// Phase 1, slice 4: per-client keys and a single-use session challenge (not wired).
pub mod identity;
/// Phase 1, slice A1.1: the sealed approved-clients file, fail closed (not wired).
pub mod store;

#[cfg(test)]
mod tests;
