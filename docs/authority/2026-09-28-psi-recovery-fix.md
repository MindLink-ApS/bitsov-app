# APP-PSI-MSG recovery follow-up (PR #53)

CODEX APP AUTHORITY — 2026-09-28 — follow-up to app 9970b2c

Scope: unique pending-send identity, refusal rollback accounting, and paired
first-contact renewal. The baseline already contains the normal merge of app
main 060f14c; merging current origin/main again reports already up to date.
Genome examined and built: a400629ff8489395888b62c5059acb4e1a3c2db9.

Invariants (A): PASS for this app delta. Retry delivery keeps max_total_msat=0.
An approved retry retains the exact approved aggregate cap. Every compose still
uses the same durable journal. No renderer node credential, direct transport
send, plaintext journal, or owner-token delegation was added.

Gates (B): G1/G2/G3/G4/G6 static/source checks PASS; G5 unchanged.
Signed released-sidecar runtime validation is not claimed.

Product gates (C): NO-GO for the full requested admission behavior. In pinned
genome, compose.rs:449-453 still unconditionally rejects capped reconnect
readmission, and compose.rs:2997 enables that refusal whenever any cap is present.
Neither a higher cap nor a renewed grant makes that path executable. Removing
the cap would violate the requested spending bound. A bounded backend operation
is required; no genome source change is included here.

The app now renews a paired caller's consumed first-contact authorization using
the existing independent-owner handoff. The live grant's recipient budget is
preserved (genome pairing.rs:1901-1908 requires equality), while the retry amount
remains a separate cap. The regression covers a 14,000-msat retry under an
existing 100,000-msat contact budget and uses the fee-aware all-in quote shape.
This is HTTP-fixture evidence, not a successful two-node admission test.

P2-2: a random durable per-send ID replaces the content hash for dismissal.
Legacy journals migrate under the exclusive journal lock before exposing an ID;
operation fingerprints and accounting references remain unchanged. Reconciliation
snapshots invalidate on dismissal or successful retry, including late check replies.

P2-3: reservation no longer performs unqualified nested pruning. The atomic
in-flight journal also retains its rollback accounting reference. The regression
ages an incomplete retry, refuses its successor, reopens state, and exercises
reconciliation followed by either dismissal or another approved retry.

Validation:
- npm ci: PASS (locked dependencies; npm reports two moderate advisories).
- npm run authority: PASS, all 12 static checks.
- npm test: PASS, 28 files / 355 tests.
- npm run build: PASS (TypeScript and Vite).
- cargo test --locked: PASS, 476 tests, zero failed/ignored.
- cargo clippy --locked -- -D warnings: PASS.
- git diff --check: PASS.
- Real-window UI-E2E against a400629: BLOCKED at preflight by occupied port 3141
  (1420 is also occupied by another scratchpad app). The genome build succeeded;
  no test app or nodes launched. Evidence scan and temporary runtime cleanup passed.
  Evidence: /tmp/uie2e-evidence.pTDL1L/summary.json.

Rust and UI reproductions failed before their fixes. The independent review
caught the existing-contact-budget renewal constraint; its stricter fixture also
failed before correction. Existing zero-cap, journal, pause and spending tests
remain green. A capped-reconnect refusal regression preserves the pending record
and its accounting; it does not claim to fix the backend refusal.

Sequencing (D): branch-only changes; no merge or release.
VERDICT: NO-GO for complete ticket closure.
Must-fix: bounded genome reconnect readmission and a completed real-window run.
