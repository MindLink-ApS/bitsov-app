# CS-1 runbook — desktop app shell (**Linux-only**, blocker B10)

**Scope (only):** app shell → bundle/spawn the node → loopback auth (`/auth/local`) →
identity screen → authority verdict. No funding, rooms, messaging, mobile, calls, hosted, AI.

## Prerequisites
- **Linux** (x86_64 or aarch64) — the only OS with a signed released node binary today.
- Rust stable + Tauri v2 system deps (webkit2gtk, etc.). Node 20+. `gh` + `gpg` (for the
  signed sidecar fetch; import `RELEASE_KEY.asc` from BitSov-bitsov to verify).

## Build & run (clean checkout)
```bash
npm ci                              # uses the committed package-lock.json
./scripts/fetch-node-sidecar.sh     # fetch + VERIFY the signed node, place it as the sidecar
scripts/authority-check.sh          # must print AUTHORITY: PASS before you build
npm run smoke:cs1                   # Linux local smoke: sidecar -> /auth/local -> identity node_id
npm run tauri dev                   # spawns node → /health → /auth/local → identity screen
```
A clean `cargo check` fails until the sidecar is fetched (the node binary is intentionally
not committed) — run `fetch-node-sidecar.sh` first. The app icon (`src-tauri/icons/`) and
both lockfiles (`package-lock.json`, `src-tauri/Cargo.lock`) are committed.

## What it does
1. Rust host runs `konsensus init` on first run, then `konsensus start --config …` as a
   **supervised sidecar** (killed on exit; init exit status + stderr are checked).
2. Polls `http://127.0.0.1:3141/api/v1/health`, then `POST /auth/local` → JWT, `GET /identity`.
3. SolidJS UI reflects state; it never talks to the node directly and holds no shell/kill authority.

## Boundary (do not break)
Node = bundled binary, no `konsensus-*` crate dep (G1). Control plane loopback-only (G2).
Shell capability is scoped to the `konsensus` sidecar only; CSP is set (not null). Node CLI +
API paths pinned to BitSov-bitsov `v0.3.0-rc4 / aa159189`. `scripts/authority-check.sh` enforces all of this.

## Local pass/fail smoke

Run on Linux after the signed sidecar is available:

```bash
npm run smoke:cs1
```

Pass condition: prints `SMOKE: PASS node_id=<node_id>`.

The smoke starts the signed sidecar on loopback, waits for `/health`, calls
`POST /api/v1/auth/local`, reads `/identity`, and asserts the renderer binds
`node_status.node_id` into the identity screen. It deliberately does not touch
funding, rooms, messaging, mobile, calls, hosted, AI, relay, merge, or deploy.
