//! Table-driven tests for the MCP client grant checker. Every refusal reason
//! has at least one row; budget-window edges and overflow have their own
//! tests. Nothing here touches a node, a socket or the Tauri runtime.

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
        window_ms: DAY,
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

fn spent(sats: u64) -> WindowSpend {
    WindowSpend { window_start_ms: T0, sats }
}

const NOW: u64 = T0 + HOUR;

fn refused(r: Refusal) -> Decision {
    Decision::Refuse(r)
}

struct Row {
    name: &'static str,
    grant: ClientGrant,
    req: Request<'static>,
    now: u64,
    spent: WindowSpend,
    want: Decision,
}

fn row(name: &'static str, grant: ClientGrant, req: Request<'static>, now: u64, spent: WindowSpend, want: Decision) -> Row {
    Row { name, grant, req, now, spent, want }
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
        row("zero window", with(|g| g.window_ms = 0), read(), NOW, spent(0), refused(Refusal::MalformedGrant)),
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
            WindowSpend { window_start_ms: T0, sats: 0 },
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
        // Budget window.
        row("exactly at the limit", grant(), pay(100), NOW, spent(900), Decision::Allow),
        row("one over the limit", grant(), pay(100), NOW, spent(901), refused(Refusal::OverBudget)),
        row("already over the limit", grant(), pay(1), NOW, spent(1_000), refused(Refusal::OverBudget)),
        row(
            "spend recorded for a future window",
            grant(),
            pay(1),
            NOW,
            WindowSpend { window_start_ms: T0 + DAY, sats: 0 },
            refused(Refusal::SpendRecordInvalid),
        ),
        row(
            "spend record not on a window boundary",
            grant(),
            pay(1),
            NOW,
            WindowSpend { window_start_ms: T0 + 1, sats: 0 },
            refused(Refusal::SpendRecordInvalid),
        ),
        row(
            "spend record from before the grant",
            grant(),
            pay(1),
            NOW,
            WindowSpend { window_start_ms: T0 - DAY, sats: 0 },
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
        let got = check(&r.grant, &r.req, r.now, r.spent);
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
fn window_rolls_over_and_forgets_old_spend() {
    let g = grant();
    // A 1 h window inside a 24 h grant.
    let g = ClientGrant { window_ms: HOUR, budget_sats: 100, per_call_max_sats: 100, ..g };
    let last_ms_of_first = T0 + HOUR - 1;
    let first_ms_of_second = T0 + HOUR;
    let full = WindowSpend { window_start_ms: T0, sats: 100 };
    let at = |now: u64| Request { sent_at_ms: now, ..pay(1) };

    assert_eq!(check(&g, &at(last_ms_of_first), last_ms_of_first, full), Decision::Refuse(Refusal::OverBudget));
    // The stale record belongs to the previous window: it no longer counts.
    assert_eq!(check(&g, &at(first_ms_of_second), first_ms_of_second, full), Decision::Allow);
    // A full record for the new window refuses again.
    let full_second = WindowSpend { window_start_ms: T0 + HOUR, sats: 100 };
    assert_eq!(check(&g, &at(first_ms_of_second), first_ms_of_second, full_second), Decision::Refuse(Refusal::OverBudget));
    // Rolling over never grants more than one window's budget in one call.
    let big = Request { amount_sats: 101, ..at(first_ms_of_second) };
    assert_eq!(check(&g, &big, first_ms_of_second, full), Decision::Refuse(Refusal::OverPerCall));
}

#[test]
fn current_window_start_edges() {
    let g = ClientGrant { window_ms: HOUR, ..grant() };
    assert_eq!(current_window_start(&g, T0), Some(T0));
    assert_eq!(current_window_start(&g, T0 + HOUR - 1), Some(T0));
    assert_eq!(current_window_start(&g, T0 + HOUR), Some(T0 + HOUR));
    // Inside the skew before issue the first window applies.
    assert_eq!(current_window_start(&g, T0 - 1), Some(T0));
    let g = ClientGrant { window_ms: 0, ..g };
    assert_eq!(current_window_start(&g, T0), None);
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
        let window = rng.edgy();
        let spent_sats = rng.edgy();
        let amount = rng.next() as i64;
        let issued = rng.edgy();
        let lifetime = rng.edgy();
        let now = rng.edgy();
        let g = ClientGrant {
            budget_sats: budget,
            per_call_max_sats: per_call,
            window_ms: window,
            issued_at_ms: issued,
            expires_at_ms: issued.wrapping_add(lifetime),
            ..grant()
        };
        let req = Request { amount_sats: amount, sent_at_ms: now, ..pay(0) };
        let ws = WindowSpend { window_start_ms: current_window_start(&g, now).unwrap_or(0), sats: spent_sats };
        // Must not panic, whatever the inputs.
        let d = check(&g, &req, now, ws);
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
fn property_allowed_spends_sum_within_budget_per_window() {
    // Simulate a client spending as fast as it can across several windows:
    // the sum allowed inside any one window never passes the budget.
    let mut rng = XorShift(0xDEAD_BEEF_CAFE_F00D);
    let g = ClientGrant { window_ms: HOUR, budget_sats: 1_000, per_call_max_sats: 100, ..grant() };
    let mut ws = WindowSpend { window_start_ms: T0, sats: 0 };
    let mut now = T0;
    let mut per_window = std::collections::BTreeMap::<u64, u64>::new();
    while now < T0 + DAY {
        let amount = (rng.next() % 150) as i64;
        let start = current_window_start(&g, now).unwrap();
        if ws.window_start_ms != start {
            ws = WindowSpend { window_start_ms: start, sats: 0 };
        }
        let req = Request { amount_sats: amount, sent_at_ms: now, ..pay(0) };
        if check(&g, &req, now, ws) == Decision::Allow {
            ws.sats += amount as u64;
            *per_window.entry(start).or_default() += amount as u64;
        }
        now += rng.next() % 60_000;
    }
    assert!(per_window.len() >= 20, "simulation should cross many windows");
    for (start, sum) in per_window {
        assert!(sum <= 1_000, "window {start} allowed {sum}");
    }
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
        assert_eq!(check(&grant(), &req, NOW, spent(0)), Decision::Refuse(Refusal::UnknownScope), "{s:?}");
    }
}

#[test]
fn default_is_refuse() {
    // A grant built from defaults grants nothing.
    let g = ClientGrant::empty(ClientId::parse("editor-agent").unwrap());
    for scope in Scope::ALL {
        let req = Request { scope: scope.as_str(), ..pay(1) };
        assert!(matches!(check(&g, &req, NOW, spent(0)), Decision::Refuse(_)), "{scope:?}");
    }
    assert!(matches!(check(&g, &read(), NOW, spent(0)), Decision::Refuse(_)));
}
