# ADR-001 — API-consumer boundary (charter gate G1)

**Decision.** `bitsov-app` consumes the **public BitSov node HTTP + WebSocket API** over
loopback. It **bundles and supervises the released `konsensus-node` binary as a subprocess**
and authenticates via `POST /api/v1/auth/local` on `127.0.0.1`. It does **not** link the
`konsensus-*` crates in-process, and it does **not** fork or vendor protocol logic.

**Why.** `BitSov-bitsov/docs/ops/PUBLIC_REPO_DECISION.md` reserves this repo as the "open
reference desktop app/client that consumes the public node API" and requires it to "remain
optional." In-process crate linking would blur the app/protocol boundary and risk vendored
protocol drift (the app silently diverging from the audited, released node). Subprocess +
loopback keeps one authoritative node implementation and a clean seam.

**Consequences.**
- The app pins a **released** node version; it upgrades the node like any dependency.
- Desktop (Mac/PC) is the clean first target: bundle node, `/auth/local`, keys hidden.
- Any **non-loopback** client (mobile/paired/hosted) is blocked until transport
  confidentiality (TLS/Noise) **and** delegated per-device auth exist (gate G2) — `/ws`
  carries decrypted plaintext and `/auth/local` has no TLS; signing is auth, not encryption.
- `/auth/local` mints a full node JWT to any loopback process — harden or disclose before the
  funds-holding "your bank" framing ships (gate G6).

**Status:** ACCEPTED (charter, 2026-08-12). Verified each pass by `CODEX_APP_AUTHORITY.md` (G1).
