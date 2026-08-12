# CS-1 runbook — desktop app shell

**Scope (only):** app shell → bundle/spawn the node → loopback auth (`/auth/local`) →
identity screen → authority verdict. No funding, rooms, messaging, mobile, calls,
hosted, or AI (see `CLAUDE_GOAL_BITSOV_APP.md` §6/§9, `CODEX_APP_AUTHORITY.md`).

## Prerequisites
- Rust stable + the Tauri v2 system deps for your OS (webkit2gtk on Linux, Xcode CLT on macOS).
- Node 20+.

## Build & run
```bash
npm install
# 1) drop + verify the pinned node binary into src-tauri/bin/ (see src-tauri/bin/README.md)
# 2) generate app icons: npm run tauri icon path/to/bitsov-1024.png
npm run tauri dev      # spawns the node, waits for /health, mints a loopback JWT, shows node_id
```

## What it does
1. Rust host (`src-tauri/src/main.rs`) resolves the app data dir, runs `konsensus init`
   on first run, then `konsensus start --config …` as a supervised **sidecar** (killed on exit).
2. Polls `http://127.0.0.1:3141/api/v1/health` (node ApiConfig default), then
   `POST /auth/local` → JWT, then `GET /identity` → `node_id`.
3. SolidJS UI reflects state: *Starting your node…* → *Your node is running* + `node_id`,
   or an error with a pointer to `bin/README.md`.

## Expected first-build friction (this is the point of a focused PR, per Codex)
- **Icons** missing → `tauri build` fails until `tauri icon` is run.
- **Capability scoping** for the shell sidecar may need tightening to the exact `konsensus`
  command in `src-tauri/capabilities/default.json` (currently broad allow-execute/spawn).
- **Tauri v2 API** specifics (sidecar `.status()`/`.spawn()` signatures, `CommandEvent`) may
  need minor adjustment on first `cargo build`.
- **Node CLI flags**: `konsensus init --dir --non-interactive --tier full` then
  `konsensus start --config` are pinned from source at v0.3.0-rc4; re-confirm on node upgrade.

## Boundary (Gate G1 — do not break)
The node is a **bundled binary**, never a linked crate. `src-tauri/Cargo.toml` has **no**
`konsensus-*` dependency. The control plane is **loopback only** (Gate G2).
