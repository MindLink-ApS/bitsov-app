# CODEX APP AUTHORITY — 2026-09-28 — PR #55 room fee fix

Scope: bounded follow-up to app `3eea0c5`, addressing the room fee mismatch
reported in `55-verdict.txt`. Protocol contract checked at `dac01c8`.

Room compose now takes its shared caller fee ceiling from the smallest
quoted member allowance. Genome applies `min(node policy, caller ceiling)`
per member, so a configured 7,500-msat minimum cannot exceed a displayed
5,000-msat allowance. Mixed-price rooms keep their conservative displayed
allowances and their original total and recipient caps.

The ordinary node price endpoint returns principal only, not a routing-policy
quote. No mandatory minimum routing charge exists in this contract; the
caller may tighten the policy. The app does not invent a higher mandatory
price or automatically increase approval. Changed all-in prices are refused,
refreshed, displayed, and require another send tap. First-contact quotes,
which do expose node fee allowances, retain their exact-total owner approval.

Pattern audit: direct messages pass their quoted fee ceiling; files use the
same fee calculation in display, preflight and dispatch; invoice/keysend use
`payment_quote` for both approval and caller fee; first contact validates
admission + message + fee against the node total and grants exactly the
approved cap. No equivalent fixed room-style fee override found elsewhere.

Invariants (A): PASS for this diff — payment-gated compose and cap enforcement
remain intact; identity, credentials and transport are unchanged.
Gates (B): G1 PASS, G2 PASS, G3 PASS, G4 PASS, G5 unchanged/out of scope,
G6 PASS. No release metadata, remote-client scope or bundled release pin change.
Product gates (C): rooms remain connected-peer scoped; mobile/hosting unchanged.
Sequencing (D): no change.
VERDICT: QUALIFIED-GO for this desktop correction; no merge or release approval.

Validation: authority-check PASS; npm ci PASS (two existing moderate advisories);
Vitest 342 tests PASS; production build PASS; cargo test --locked 447 tests PASS;
cargo clippy --locked --all-targets -- -D warnings PASS; git diff --check PASS.
Regressions exercise default and 7,500-msat policies, mixed member prices,
unchanged caps, and the higher-price refresh/re-approval flow. The high-policy
and mixed-price cases reproduced the refusal before the fix and pass after it.
Loopback fixtures exercise the app quote/request/journal path; no real Lightning
payment or live routing claim is made.
