//! Table-driven tests for the MCP client grant checker. Every refusal reason
//! has at least one row; the one-budget-per-grant rule, the node capability
//! gate and overflow have their own tests. Nothing here touches a node, a socket or the Tauri runtime.

use std::collections::BTreeSet;

use super::*;

const T0: u64 = 1_800_000_000_000; // grant issued at
const HOUR: u64 = 3_600_000;
const DAY: u64 = 24 * HOUR;
const ALICE: &str = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const BOB: &str = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";

fn grant() -> ClientGrant {
    ClientGrant {
        client_id: ClientId::parse("editor-agent").unwrap(),
        scopes: [Scope::Read, Scope::Message, Scope::Pay].into_iter().collect(),
        budget_sats: 1_000,
        per_call_max_sats: 100,
        issued_at_ms: T0,
        expires_at_ms: T0 + DAY,
        revoked_at_ms: None,
        recipients_only: true,
        recipients: [ALICE.to_string()].into_iter().collect(),
    }
}

fn pay(amount: i64) -> Request<'static> {
    Request { client_id: "editor-agent", scope: "pay", amount_sats: amount, recipient: Some(ALICE), sent_at_ms: T0 + HOUR }
}

fn read() -> Request<'static> {
    Request { client_id: "editor-agent", scope: "read", amount_sats: 0, recipient: None, sent_at_ms: T0 + HOUR }
}

fn spent(sats: u64) -> GrantSpend {
    GrantSpend { grant_issued_at_ms: T0, sats }
}

/// Node capabilities once N-2 exists. Rows that probe checks after the node
/// gate use this; the gate itself has rows with [`NodeCaps::default`].
const N2: NodeCaps = NodeCaps { node_supports_recipient_pay: true };

const NOW: u64 = T0 + HOUR;

fn refused(r: Refusal) -> Decision {
    Decision::Refuse(r)
}

struct Row {
    name: &'static str,
    grant: ClientGrant,
    req: Request<'static>,
    now: u64,
    spent: GrantSpend,
    caps: NodeCaps,
    want: Decision,
}

fn row(name: &'static str, grant: ClientGrant, req: Request<'static>, now: u64, spent: GrantSpend, want: Decision) -> Row {
    Row { name, grant, req, now, spent, caps: N2, want }
}

/// A row run against a node without N-2 (the default today).
fn row_today(name: &'static str, grant: ClientGrant, req: Request<'static>, want: Decision) -> Row {
    Row { name, grant, req, now: NOW, spent: spent(0), caps: NodeCaps::default(), want }
}

fn with(f: impl FnOnce(&mut ClientGrant)) -> ClientGrant {
    let mut g = grant();
    f(&mut g);
    g
}

fn table() -> Vec<Row> {
    vec![
        // Allowed baselines.
        row("read allowed", grant(), read(), NOW, spent(0), Decision::Allow),
        row("pay allowed", grant(), pay(10), NOW, spent(0), Decision::Allow),
        row(
            "message allowed at node cap",
            grant(),
            Request { scope: "message", amount_sats: MESSAGE_MAX_SATS as i64, ..pay(0) },
            NOW,
            spent(0),
            Decision::Allow,
        ),
        // Malformed grants.
        row("zero budget", with(|g| g.budget_sats = 0), read(), NOW, spent(0), refused(Refusal::MalformedGrant)),
        row("zero per-call max", with(|g| g.per_call_max_sats = 0), read(), NOW, spent(0), refused(Refusal::MalformedGrant)),
        row("per-call over budget", with(|g| g.per_call_max_sats = 1_001), read(), NOW, spent(0), refused(Refusal::MalformedGrant)),
        row("expiry before issue", with(|g| g.expires_at_ms = T0), read(), NOW, spent(0), refused(Refusal::MalformedGrant)),
        row(
            "lifetime over 24 h",
            with(|g| g.expires_at_ms = T0 + MAX_GRANT_LIFETIME_MS + 1),
            read(),
            NOW,
            spent(0),
            refused(Refusal::MalformedGrant),
        ),
        row("no scopes", with(|g| g.scopes = BTreeSet::new()), read(), NOW, spent(0), refused(Refusal::MalformedGrant)),
        // Identity.
        row(
            "another client's grant",
            grant(),
            Request { client_id: "chat-app", ..read() },
            NOW,
            spent(0),
            refused(Refusal::ClientMismatch),
        ),
        row(
            "client id differs only by case",
            grant(),
            Request { client_id: "Editor-Agent", ..read() },
            NOW,
            spent(0),
            refused(Refusal::ClientMismatch),
        ),
        // Revocation wins over everything time-based.
        row("revoked", with(|g| g.revoked_at_ms = Some(T0 + 1)), read(), NOW, spent(0), refused(Refusal::Revoked)),
        row(
            "revoked with a future stamp is still revoked",
            with(|g| g.revoked_at_ms = Some(T0 + 10 * DAY)),
            read(),
            NOW,
            spent(0),
            refused(Refusal::Revoked),
        ),
        // Clock skew.
        row(
            "request stamped too far behind",
            grant(),
            Request { sent_at_ms: NOW - MAX_CLOCK_SKEW_MS - 1, ..read() },
            NOW,
            spent(0),
            refused(Refusal::ClockSkew),
        ),
        row(
            "request stamped too far ahead",
            grant(),
            Request { sent_at_ms: NOW + MAX_CLOCK_SKEW_MS + 1, ..read() },
            NOW,
            spent(0),
            refused(Refusal::ClockSkew),
        ),
        row(
            "request at skew bound behind",
            grant(),
            Request { sent_at_ms: NOW - MAX_CLOCK_SKEW_MS, ..read() },
            NOW,
            spent(0),
            Decision::Allow,
        ),
        row(
            "request at skew bound ahead",
            grant(),
            Request { sent_at_ms: NOW + MAX_CLOCK_SKEW_MS, ..read() },
            NOW,
            spent(0),
            Decision::Allow,
        ),
        row(
            "host clock far before issue",
            grant(),
            Request { sent_at_ms: T0 - MAX_CLOCK_SKEW_MS - 1, ..read() },
            T0 - MAX_CLOCK_SKEW_MS - 1,
            spent(0),
            refused(Refusal::ClockSkew),
        ),
        row(
            "host clock just before issue, inside skew",
            grant(),
            Request { sent_at_ms: T0 - 1, ..read() },
            T0 - 1,
            spent(0),
            Decision::Allow,
        ),
        // Expiry is strict: no skew grace at the end.
        row(
            "expired exactly at expiry",
            grant(),
            Request { sent_at_ms: T0 + DAY, ..read() },
            T0 + DAY,
            spent(0),
            refused(Refusal::Expired),
        ),
        row(
            "one ms before expiry",
            grant(),
            Request { sent_at_ms: T0 + DAY - 1, ..read() },
            T0 + DAY - 1,
            spent(0),
            Decision::Allow,
        ),
        // Scopes.
        row("unknown scope", grant(), Request { scope: "admin", ..read() }, NOW, spent(0), refused(Refusal::UnknownScope)),
        row("empty scope", grant(), Request { scope: "", ..read() }, NOW, spent(0), refused(Refusal::UnknownScope)),
        row("scope wrong case", grant(), Request { scope: "PAY", ..pay(1) }, NOW, spent(0), refused(Refusal::UnknownScope)),
        row("scope with padding", grant(), Request { scope: " pay", ..pay(1) }, NOW, spent(0), refused(Refusal::UnknownScope)),
        row(
            "call not granted",
            grant(),
            Request { scope: "call", ..pay(1) },
            NOW,
            spent(0),
            refused(Refusal::ScopeNotGranted),
        ),
        row(
            "pay on read-only grant",
            with(|g| g.scopes = [Scope::Read].into_iter().collect()),
            pay(1),
            NOW,
            spent(0),
            refused(Refusal::ScopeNotGranted),
        ),
        row(
            "read with an amount is escalation",
            grant(),
            Request { amount_sats: 1, ..read() },
            NOW,
            spent(0),
            refused(Refusal::ScopeEscalation),
        ),
        row(
            "read with a recipient is escalation",
            grant(),
            Request { recipient: Some(ALICE), ..read() },
            NOW,
            spent(0),
            refused(Refusal::ScopeEscalation),
        ),
        row(
            "write scope on a grant that is not recipients_only",
            with(|g| g.recipients_only = false),
            pay(1),
            NOW,
            spent(0),
            refused(Refusal::NotRecipientsOnly),
        ),
        // Node capability gate (N-2). Today the node refuses an explicit pay on
        // a recipients_only grant, so the host refuses it first.
        row_today("pay without node support", grant(), pay(1), refused(Refusal::PayNotSupportedByNode)),
        row_today("message without node support", grant(), Request { scope: "message", ..pay(1) }, Decision::Allow),
        row_today("read without node support", grant(), read(), Decision::Allow),
        row_today(
            "pay on a grant that is not recipients_only, without node support",
            with(|g| g.recipients_only = false),
            pay(1),
            refused(Refusal::NotRecipientsOnly),
        ),
        // Amounts.
        row("zero amount", grant(), pay(0), NOW, spent(0), refused(Refusal::NonPositiveAmount)),
        row("negative amount", grant(), pay(-1), NOW, spent(0), refused(Refusal::NonPositiveAmount)),
        row("i64::MIN amount", grant(), pay(i64::MIN), NOW, spent(0), refused(Refusal::NonPositiveAmount)),
        // Recipients.
        row(
            "recipient not named",
            grant(),
            Request { recipient: Some(BOB), ..pay(1) },
            NOW,
            spent(0),
            refused(Refusal::RecipientNotAllowed),
        ),
        row(
            "recipient missing on a write",
            grant(),
            Request { recipient: None, ..pay(1) },
            NOW,
            spent(0),
            refused(Refusal::RecipientNotAllowed),
        ),
        row(
            "recipient differs only by case",
            grant(),
            Request { recipient: Some("A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1"), ..pay(1) },
            NOW,
            spent(0),
            refused(Refusal::RecipientNotAllowed),
        ),
        // Per-call caps.
        row("pay at per-call max", grant(), pay(100), NOW, spent(0), Decision::Allow),
        row("pay one over per-call max", grant(), pay(101), NOW, spent(0), refused(Refusal::OverPerCall)),
        row(
            "message one over node cap",
            grant(),
            Request { scope: "message", amount_sats: MESSAGE_MAX_SATS as i64 + 1, ..pay(0) },
            NOW,
            spent(0),
            refused(Refusal::OverPerCall),
        ),
        // One budget for the whole grant.
        row("exactly at the limit", grant(), pay(100), NOW, spent(900), Decision::Allow),
        row("one over the limit", grant(), pay(100), NOW, spent(901), refused(Refusal::OverBudget)),
        row("already over the limit", grant(), pay(1), NOW, spent(1_000), refused(Refusal::OverBudget)),
        row(
            "budget spent early is still spent in the last ms of the grant",
            grant(),
            Request { sent_at_ms: T0 + DAY - 1, ..pay(1) },
            T0 + DAY - 1,
            spent(1_000),
            refused(Refusal::OverBudget),
        ),
        row(
            "spend record from an earlier grant",
            grant(),
            pay(1),
            NOW,
            GrantSpend { grant_issued_at_ms: T0 - DAY, sats: 0 },
            refused(Refusal::SpendRecordInvalid),
        ),
        row(
            "spend record from a later grant",
            grant(),
            pay(1),
            NOW,
            GrantSpend { grant_issued_at_ms: T0 + 1, sats: 0 },
            refused(Refusal::SpendRecordInvalid),
        ),
        // Overflow.
        row("spent near u64::MAX", grant(), pay(1), NOW, spent(u64::MAX), refused(Refusal::Overflow)),
    ]
}

#[test]
fn table_rows_match() {
    let rows = table();
    let mut failures = Vec::new();
    for r in &rows {
        let got = check(&r.grant, &r.req, r.now, r.spent, r.caps);
        if got != r.want {
            failures.push(format!("{}: want {:?}, got {:?}", r.name, r.want, got));
        }
    }
    assert!(failures.is_empty(), "{} of {} rows failed:\n{}", failures.len(), rows.len(), failures.join("\n"));
}

#[test]
fn every_refusal_reason_has_a_row() {
    let covered: BTreeSet<&'static str> = table()
        .iter()
        .filter_map(|r| match r.want {
            Decision::Refuse(reason) => Some(reason.code()),
            Decision::Allow => None,
        })
        .collect();
    let all: BTreeSet<&'static str> = Refusal::ALL.iter().map(|r| r.code()).collect();
    let missing: Vec<_> = all.difference(&covered).collect();
    assert!(missing.is_empty(), "refusal reasons without a table row: {missing:?}");
}

#[test]
fn refusal_codes_are_unique_and_snake_case() {
    let mut seen = BTreeSet::new();
    for r in Refusal::ALL {
        let code = r.code();
        assert!(seen.insert(code), "duplicate code {code}");
        assert!(!code.is_empty() && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'), "bad code {code}");
    }
}

#[test]
fn scope_parse_is_closed_and_round_trips() {
    for s in Scope::ALL {
        assert_eq!(Scope::parse(s.as_str()), Some(s));
    }
    for bad in ["", "READ", "spend", "receive", "admin", "read ", "pay\0", "*"] {
        assert_eq!(Scope::parse(bad), None, "{bad:?}");
    }
}

#[test]
fn client_id_parse_is_narrow() {
    for ok in ["a", "editor-agent", "chat_app-2", &"x".repeat(CLIENT_ID_MAX_LEN)] {
        assert!(ClientId::parse(ok).is_some(), "{ok:?}");
    }
    for bad in ["", "Editor", "a b", "a/b", "é", &"x".repeat(CLIENT_ID_MAX_LEN + 1), "-lead", "a\n"] {
        assert!(ClientId::parse(bad).is_none(), "{bad:?}");
    }
}

#[test]
fn budget_never_refills_inside_one_grant() {
    // A 24 h grant: one budget for its whole life, whatever the hour.
    let g = ClientGrant { budget_sats: 100, per_call_max_sats: 100, ..grant() };
    let full = spent(100);
    let at = |now: u64| Request { sent_at_ms: now, ..pay(1) };
    for now in [T0, T0 + HOUR - 1, T0 + HOUR, T0 + 2 * HOUR, T0 + 12 * HOUR, T0 + DAY - 1] {
        assert_eq!(check(&g, &at(now), now, full, N2), Decision::Refuse(Refusal::OverBudget), "at +{} ms", now - T0);
    }
    // A record from an earlier grant is not a fresh budget: the ledger is
    // refused rather than counted as zero.
    let stale = GrantSpend { grant_issued_at_ms: T0 - DAY, sats: 100 };
    assert_eq!(check(&g, &at(T0 + HOUR), T0 + HOUR, stale, N2), Decision::Refuse(Refusal::SpendRecordInvalid));
    // Past expiry nothing is allowed, spent or not.
    assert_eq!(check(&g, &at(T0 + DAY), T0 + DAY, spent(0), N2), Decision::Refuse(Refusal::Expired));
}

#[test]
fn renewal_is_the_only_way_to_more_budget() {
    let g = ClientGrant { budget_sats: 100, per_call_max_sats: 100, ..grant() };
    let later = T0 + DAY;
    let at = |now: u64| Request { sent_at_ms: now, ..pay(1) };
    // The old grant is spent and then dead.
    assert_eq!(check(&g, &at(later - 1), later - 1, spent(100), N2), Decision::Refuse(Refusal::OverBudget));
    assert_eq!(check(&g, &at(later), later, spent(0), N2), Decision::Refuse(Refusal::Expired));
    // The owner issues a new grant; its own fresh record starts at zero.
    let renewed = ClientGrant { issued_at_ms: later, expires_at_ms: later + DAY, ..g.clone() };
    let fresh = GrantSpend { grant_issued_at_ms: later, sats: 0 };
    assert_eq!(check(&renewed, &at(later), later, fresh, N2), Decision::Allow);
    // Carrying the old grant's record into the new one is refused, not reset.
    assert_eq!(check(&renewed, &at(later), later, spent(100), N2), Decision::Refuse(Refusal::SpendRecordInvalid));
}

#[test]
fn pay_refused_until_node_supports_recipient_pay() {
    assert!(!NodeCaps::default().node_supports_recipient_pay, "N-2 must default to absent");
    for amount in [1, 50, 100] {
        assert_eq!(check(&grant(), &pay(amount), NOW, spent(0), NodeCaps::default()), Decision::Refuse(Refusal::PayNotSupportedByNode));
        assert_eq!(check(&grant(), &pay(amount), NOW, spent(0), N2), Decision::Allow);
    }
    // The gate narrows pay only: message is unchanged without N-2.
    let msg = Request { scope: "message", ..pay(1) };
    assert_eq!(check(&grant(), &msg, NOW, spent(0), NodeCaps::default()), Decision::Allow);
}

/// Small deterministic generator, so the property tests need no new crate.
struct XorShift(u64);
impl XorShift {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    /// Biased towards the edges where overflow lives.
    fn edgy(&mut self) -> u64 {
        const EDGES: [u64; 9] = [0, 1, 2, 99, 100, 101, u64::MAX / 2, u64::MAX - 1, u64::MAX];
        match self.next() % 3 {
            0 => EDGES[(self.next() % EDGES.len() as u64) as usize],
            1 => self.next(),
            _ => self.next() % 2_000,
        }
    }
}

#[test]
fn property_never_allows_more_than_the_budget() {
    let mut rng = XorShift(0x9E37_79B9_7F4A_7C15);
    let mut allowed = 0;
    for _ in 0..50_000 {
        let budget = rng.edgy();
        let per_call = rng.edgy();
        let spent_sats = rng.edgy();
        let amount = rng.next() as i64;
        let issued = rng.edgy();
        let lifetime = rng.edgy();
        let now = rng.edgy();
        let g = ClientGrant {
            budget_sats: budget,
            per_call_max_sats: per_call,
            issued_at_ms: issued,
            expires_at_ms: issued.wrapping_add(lifetime),
            ..grant()
        };
        let req = Request { amount_sats: amount, sent_at_ms: now, ..pay(0) };
        let ws = GrantSpend { grant_issued_at_ms: issued, sats: spent_sats };
        // Must not panic, whatever the inputs.
        let d = check(&g, &req, now, ws, N2);
        if d == Decision::Allow {
            allowed += 1;
            assert!(amount > 0, "allowed non-positive amount {amount}");
            let a = amount as u64;
            assert!(a <= per_call && a <= budget, "allowed {a} over cap {per_call}/{budget}");
            let total = spent_sats.checked_add(a).expect("allowed an overflowing total");
            assert!(total <= budget, "allowed {spent_sats}+{a} over budget {budget}");
            assert!(now < g.expires_at_ms && g.expires_at_ms > g.issued_at_ms);
            assert!(g.expires_at_ms - g.issued_at_ms <= MAX_GRANT_LIFETIME_MS);
        }
    }
    assert!(allowed > 0, "the generator should reach some allowed cases");
}

#[test]
fn property_max_speed_client_gets_at_most_the_budget_per_grant() {
    // Simulate a client spending as fast as it can for the whole 24 h life of
    // one grant, with an honest ledger: the sum allowed over the grant never
    // passes the budget, and the budget is used up early, not refilled.
    let mut rng = XorShift(0xDEAD_BEEF_CAFE_F00D);
    let g = ClientGrant { budget_sats: 1_000, per_call_max_sats: 100, ..grant() };
    let mut ws = spent(0);
    let mut now = T0;
    let mut calls = 0u32;
    let mut allowed_after_first_hour = 0u64;
    while now < T0 + DAY {
        let amount = (rng.next() % 150) as i64;
        let req = Request { amount_sats: amount, sent_at_ms: now, ..pay(0) };
        if check(&g, &req, now, ws, N2) == Decision::Allow {
            ws.sats += amount as u64;
            if now >= T0 + HOUR {
                allowed_after_first_hour += amount as u64;
            }
        }
        calls += 1;
        now += rng.next() % 60_000;
    }
    assert!(calls > 1_000, "simulation should run the whole grant ({calls} calls)");
    assert!(ws.sats <= 1_000, "whole grant allowed {} sats", ws.sats);
    assert!(ws.sats >= 900, "an honest client should reach the budget ({} sats)", ws.sats);
    assert_eq!(allowed_after_first_hour, 0, "budget refilled after the first hour");
    // Only a renewal, a new grant with its own record, allows more.
    let renewed = ClientGrant { issued_at_ms: T0 + DAY, expires_at_ms: T0 + 2 * DAY, ..g.clone() };
    let req = Request { sent_at_ms: T0 + DAY, ..pay(1) };
    assert_eq!(check(&renewed, &req, T0 + DAY, GrantSpend { grant_issued_at_ms: T0 + DAY, sats: 0 }, N2), Decision::Allow);
}

#[test]
fn property_unknown_scope_strings_always_refuse() {
    let mut rng = XorShift(42);
    for _ in 0..5_000 {
        let len = (rng.next() % 8) as usize;
        let s: String = (0..len).map(|_| (b'a' + (rng.next() % 26) as u8) as char).collect();
        if Scope::parse(&s).is_some() {
            continue;
        }
        let req = Request { scope: &s, ..pay(1) };
        assert_eq!(check(&grant(), &req, NOW, spent(0), N2), Decision::Refuse(Refusal::UnknownScope), "{s:?}");
    }
}

#[test]
fn default_is_refuse() {
    // A grant built from defaults grants nothing.
    let g = ClientGrant::empty(ClientId::parse("editor-agent").unwrap());
    for scope in Scope::ALL {
        let req = Request { scope: scope.as_str(), ..pay(1) };
        assert!(matches!(check(&g, &req, NOW, spent(0), NodeCaps::default()), Decision::Refuse(_)), "{scope:?}");
    }
    assert!(matches!(check(&g, &read(), NOW, spent(0), NodeCaps::default()), Decision::Refuse(_)));
}
