CODEX APP AUTHORITY — 2026-08-12 — PR factory/cs1-app-shell (builder self-assessment; Codex to ratify)
Scope: CS-1 desktop app shell scaffold — Tauri v2 + SolidJS, node-binary sidecar supervision, /auth/local, identity screen.

Invariants (A): PASS (static)
 - Payment gate: app has NO send path (only /auth/local + /health + /identity) — gate cannot be bypassed by code that doesn't send. PASS.
 - Zero plaintext outside trust boundary: control plane is loopback-only; node stdout/stderr drained to app log, never rendered. PASS.
 - Node is identity anchor: app mints no authority; JWT comes from the node's /auth/local. PASS.
 - Honesty ceiling: copy scan clean (no banned claims). PASS.

Gates (B): G1 PASS  G2 PASS  G3 n/a  G4 n/a  G5 n/a  G6 PENDING
 - G1: src-tauri/Cargo.toml has no konsensus-* path/git dep; node is externalBin sidecar "bin/konsensus". PASS.
 - G2: API_BASE + all /api/v1 references are 127.0.0.1 loopback only. PASS.
 - G3/G4/G5: no calls, no AI, no website change in this PR. n/a.
 - G6: no funds framing yet; /auth/local local-trust assumption is documented in code. HARDEN before the M1 funding UI ships.

Product gates (C): n/a (no rooms/membership in CS-1).
Sequencing (D): ok — desktop-only; nothing gated (mobile/calls/hosted/AI) is shipped.

VERDICT: QUALIFIED-GO to merge the scaffold. RUNTIME verification (cargo build + node boot + live identity) is PENDING a toolchain + the dropped-in pinned node binary; the first build will surface tooling friction (icons, capability scoping, Tauri v2 API) — expected and intended for this focused PR.

Must-fix before M1: drop+verify the pinned node binary (src-tauri/bin/README.md); confirm shell-sidecar capability scoping; G6 /auth/local hardening before any funds UI.
