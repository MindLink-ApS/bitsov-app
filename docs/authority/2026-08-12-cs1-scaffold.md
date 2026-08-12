CODEX APP AUTHORITY — 2026-08-12 — PR #1 factory/cs1-app-shell (rev 2, after Codex code review)
Scope: CS-1 desktop app shell — Tauri v2 + SolidJS, node-binary sidecar supervision, /auth/local, identity screen. LINUX-ONLY (blocker B10).

Codex code review (request-changes) resolved in rev 2:
 - [blocking] clean build fails on missing sidecar/icon → sidecar is fetched+verified via scripts/fetch-node-sidecar.sh (runbook step before build); real icon committed from the brand mark.
 - [blocking] Mac/PC sidecar not in rc4 → CS-1 explicitly scoped Linux-only; B10 tracks publishing signed macOS/Windows node binaries.
 - [important] broad renderer shell perms + CSP null → capability scoped to the konsensus sidecar only; CSP set.
 - [important] konsensus init non-zero exit unchecked → now checks .status.success() and surfaces exit code + stderr.
 - [important] missing lockfiles → package-lock.json + src-tauri/Cargo.lock committed.

Invariants (A): PASS (static).  Gates (B): G1 PASS · G2 PASS · G3/G4/G5 n/a · G6 PENDING (harden /auth/local before M1 funds UI).
Build readiness (scripts/authority-check.sh): icon ✓ · lockfiles ✓ · sidecar-fetch script ✓ · capability scoped ✓ · CSP set ✓.

VERDICT: QUALIFIED-GO to merge (Linux). RUNTIME (node boot + live identity on Linux) still to be confirmed by a Linux builder running the runbook. Rust source verified to compile by Codex; the init exit-check edit is a safe swap.
Must-fix before M1: G6 /auth/local hardening; confirm live identity on Linux; then wire scripts/authority-check.sh into CI.
