# CODEX APP AUTHORITY — 2026-09-28 — APP-READINESS integration

Scope: normal merge of app main `6c6e67fa8716e14c67dc40dbe4e514ff46fde1e8`
into `feat/app-readiness` at `eb055c99bceb08f69062850934045efba88441b1`,
including #53 paid-delivery retries, #55 all-in bounds and #57 CI scheduling.
Addresses the two current-main integration findings in the #56 verdict.

Invariants (A): PASS for this delta. An exact pre-dispatch readiness refusal
releases only the current reservation and restores the prior paid journal
record. Its identity, retry fence, accounting and retry metadata survive.
An ordinary send remains fenced; later manual retries reuse that record.
Retry delivery remains zero-capped; approved retries retain the explicit
all-in cap and existing host approval checks.

Gates (B): G1 PASS (source), G2 PASS (local desktop scope), G3 PASS,
G4/G5 unchanged, G6 PASS. All 12 `scripts/authority-check.sh` checks pass.
No dependency, capability, permission, credential, transport or sidecar pin
change is introduced by the integration fixes.

Product gates (C): PASS for this bounded integration. Retry preparation and
dispatch use the shared readiness guard and notice. Offline controls prevent
retry/approval; undispatched owner approvals are cancelled, including replies
arriving after recovery. The paid card remains available for a new manual
retry or dismissal. Recovery never automatically dispatches a retry. Existing
room membership, custody and mobile-push scope is unchanged.

Sequencing (D): OK — branch-only integration; no merge to main or release.

Validation:
- npm ci: PASS; two moderate advisories in unchanged dependencies.
- Authority gate: PASS, all 12 checks.
- Full Vitest: PASS, 400 tests across 30 files.
- TypeScript/Vite build: PASS.
- cargo test --locked: PASS, 480 tests, zero failed/ignored.
- cargo clippy --locked -- -D warnings: PASS.
- New regressions failed before the fixes and passed afterward: full paid
  journal/accounting preservation for both zero-cap and approved retries;
  offline controls, racing refusal notices and pending/late approval cancellation.
- Existing Solid ownership warnings remain in frontend tests.

VERDICT: QUALIFIED-GO for branch review of these integration fixes. No
signed-release or runtime certification is claimed. Rust checks use the existing
CI-style empty externalBin placeholder; no real-node offline/recovery smoke test
was run. The released sidecar pin is unchanged.
