# CODEX APP AUTHORITY — 2026-09-28 — BUDGET-SCOPE

Scope: app `7bda72c` → `feat/budget-scope`; genome `4aa5089eb997ac3c2ad6927c43f0d808e7ec2708` used read-only. Draft PR only; no merge or release.

The rolling app principal book now covers automatic/manual messages, rooms, files, app invoice payments and keysend. “Owner-direct” means independent owner CLI/API calls, which remain outside alongside channel/on-chain actions, fees and background workers. The Budget panel lists these boundaries together and identifies G1 as a finite grant. Payment and wallet surfaces disclose their applicable boundary. See [scope](../BUDGET_SCOPE.md) and [real-window copy snapshot](../control-center/budget-scope-copy.png).

Invariants (A): PASS within this diff. No payment-gate, transport, identity-anchor or protocol changes. Owner copy no longer claims a wallet-wide daily limit or that pausing the app stops the whole node.

Gates (B): G1 PASS (public API only); G2 PASS (host-mediated loopback); G3/G4 PASS (no new claims); G5 unchanged (no artifacts published); G6 PASS (existing local-trust gate retained).

Product gates (C): room send caps and terminal accounting retained; mobile push/custody unchanged and outside this desktop change. Sequencing (D): no violation introduced.

Executable authority check: PASS. Independent review: no remaining must-fix findings after file re-admission reservation, manual refusal feedback, failed-keysend accounting and durable reconciliation corrections.

Validation:

- `npm ci` completed with the existing lockfile unchanged (two moderate dependency advisories reported).
- Vitest: 339 tests passed, including the scope copy snapshot, visible refusals preserving drafts, sample behavior and direct tally labels.
- `npm run build`: PASS.
- `cargo test --locked --offline`: 428 tests passed across app/mock-node suites. Tauri test config disables only the unused external sidecar (`TAURI_CONFIG='{"bundle":{"externalBin":[]}}'`).
- `cargo clippy --locked --offline --all-targets -- -D warnings`: PASS with the same test-sidecar config.
- Real Tauri-window UI-E2E against genome `4aa5089`: 8 scenarios / 62 checks passed; disposable mock chain/Lightning, no real funds. Shared invoice/file tally, file refusal, delivery, finite-grant copy, room caps, idle/reconnect and unchanged-price refusal exercised. Evidence scan and cleanup passed.
- E2E harness process-cleanup unit tests: 15 passed. They require process inspection outside the restricted sandbox.
- Cargo cache: `/tmp/bitsov-target-b-app`.

VERDICT: QUALIFIED-GO for this desktop app scope correction. This is not a real-sats readiness approval; fees and independent node/owner spending are explicitly outside the app principal limit. No existing spending cap is increased.
