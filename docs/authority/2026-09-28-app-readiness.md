# CODEX APP AUTHORITY — 2026-09-28 — APP-READINESS

Scope: `feat/app-readiness`, based on app `060f14c`; consume genome PR #107
`feat/boot-offline` at `b984d514e9c25b8925f4daaf65db1b2baf18f3bb`.

Invariants (A): PASS for this change — paid compose paths, host-only credentials,
and node authority are preserved. Readiness can narrow actions, never authorize
spending. Only the explicit pre-dispatch refusal releases a spend reservation.

Gates (B): G1 PASS (static), G2 PASS (local app scope), G3 PASS, G4 unchanged,
G5 unchanged, G6 PASS. `scripts/authority-check.sh` → PASS.

Product gates (C): existing connected-member room scope and custody copy remain
unchanged; mobile push is outside this change. Money unavailable is represented
separately from local node health and available funds. Missing readiness fields
retain the existing behavior. Recovery refreshes controls and quotes, never
replays a send or payment.

Sequencing (D): OK — app-only compatibility work; no node repin, publishing,
release, or merge. Channel actions remain outside the app's exposed controls.

VERDICT: QUALIFIED-GO for draft app PR review. This is not a signed-release or
runtime sidecar certification. Rust compilation/tests use the CI-style empty
sidecar placeholder; no real-node offline/recovery smoke was performed.

Validation: npm ci, full Vitest suite, TypeScript/Vite build, locked Cargo tests,
and Clippy with warnings denied. npm ci reports two moderate dependency
advisories; dependencies were not changed. Existing Solid test ownership warnings
remain in the frontend suite. Independent code review findings were fixed:
funding source bypass, recovery quote refresh, and local error-code collision.

Must-fix before next ship: no outstanding issue found within this ticket. Genome
#107 is still under review; the bundled older node remains on legacy behavior.


## Review follow-up — #56

Offline transitions now invalidate pending owner approvals independently of input
edits. A successful operation that was already dispatched clears its unchanged
inputs, including across offline/recovery; cancelled requests and newer drafts
remain intact. Funding-address preparation uses the shared readiness guard and
notice, while local funding-state polling remains available. Recovery does not
replay a send or payment. No host permissions, credentials, IPC grants, dependency
versions, or sidecar pin changed. App main `060f14c` was already an ancestor of
`8316f55`; the requested normal merge therefore required no merge commit.
