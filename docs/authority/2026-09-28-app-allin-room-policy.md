# CODEX APP AUTHORITY — 2026-09-28 — PR #55 node-policy room fees

Scope: follow-up to `2674a1d` and the second `55-verdict.txt` FAIL. This
supersedes the earlier shared-minimum room fix. No merge or release approval.

Each displayed member cap is its principal plus its node-policy routing fee
allowance. Compose sends the largest member fee as the single caller ceiling,
the original approved member caps, and the original approved total cap. A fresh
quote exceeding either an individual approval or the total is refused before
any POST, journal reservation or payment. The renderer refreshes the quote and
requires another send tap. The quote's aggregate routing fee remains the sum
of fees; only the compose caller field is the maximum.

Genome contract checked at `dac01c8fadc3d22047d21895bcb0c1a6e30feafe`:

- `messages/compose.rs:2504–2522` computes each member's all-in debit before
  fan-out. `messages/caps.rs:17–30` checks exact membership, individual caps,
  and total cap before any member invoice/payment. A larger shared caller
  ceiling cannot override a smaller member cap; a policy/price increase causes
  refusal, not a larger payment.
- `traits/lightning.rs:28–33` takes `min(policy, caller)` per payment;
  `metered.rs:218–219` passes that limit to the payment path.
- Ordinary room/member pricing exposes principal only. The first-contact
  quote includes combined admission/message fees and cannot serve as a room
  member fee quote. No ordinary member fee quote API is available at this pin.
- `node.rs:149,218` gives LND/LDK the configured `[routing_fees]` policy. The
  host parses that policy from the same `konsensus.toml` passed to the supervised
  node, capturing it at start/restart. Later file edits do not alter the quote
  until restart. Missing fields use the node configuration's documented defaults.
  Unreadable/malformed policy never means default. The live `/status` backend
  must match the captured backend. Restart clears the snapshot before any
  listener adoption; a terminated sidecar cannot lend its policy to another
  listener. No config credentials reach the renderer.
- `/status` reporting `mock` or `shared_mock` identifies providers which use
  the trait's default policy, regardless of `[routing_fees]`. Unknown backends
  or unavailable LND/LDK startup policy fail the quote instead of guessing.

Regressions exercise the actual Rust quote/request/journal path with loopback
node fixtures: 2,000/750,000 principals and a modeled 6,000 route for the larger
member; a configured 7,500 minimum; default policy; policy-only price changes
and re-approval; a member increase within an unchanged total; startup snapshots;
invalid/unavailable policy; proportional ceilings, maximums and overflow. The
first two failures and missing re-approval were reproduced against the old code.
The route is modeled from genome's contract, not a live Lightning payment.
The renderer test separately proves refresh/display/no automatic retry/second tap.

Invariants (A): payment-gated compose, caps, node identity and transport preserved.
Gates (B): G1/G2/G3/G4/G6 covered by the executable authority check; G5 unchanged.
No node crate dependency, protocol modification, release pin, website artifact,
remote-client scope or new payment authority is introduced.
Product gates (C): connected-peer room restriction retained.
Sequencing (D): unchanged.

Validation: authority-check PASS; npm ci PASS (two pre-existing moderate
advisories); Vitest 27 files / 342 tests PASS; production build PASS;
`cargo test --locked` 453 tests PASS;
`cargo clippy --locked --all-targets -- -D warnings` PASS; `git diff --check` PASS.
A separate review identified stale policy after restore/adoption; both restart
and termination regressions failed before the correction and passed afterwards.
Final review found no remaining issues within this change. The existing startup
listener-adoption behavior was not redesigned.

VERDICT: QUALIFIED-GO for this desktop correction; no merge or release approval.
