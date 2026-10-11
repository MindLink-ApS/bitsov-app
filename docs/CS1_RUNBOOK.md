# CS-1 runbook — desktop app shell (Linux + macOS since `v0.3.0-rc5`; B10 landed)

**Scope (only):** app shell → bundle/spawn the node → loopback auth (`/auth/local`) →
identity screen → authority verdict. No funding, rooms, messaging, mobile, calls, hosted, AI.

## Prerequisites
- **Linux** (x86_64/aarch64) or **macOS** (arm64/x86_64) for this smoke.
- Rust stable + Tauri v2 system deps (webkit2gtk, etc.). Node 20+. `gh` + `gpg` for the
  signed sidecar fetch: it verifies against the pinned release key and, if that key is not in
  your keyring, imports `RELEASE_KEY.asc` from BitSov-bitsov into a throwaway keyring.

## Build & run (clean checkout)
```bash
npm ci                              # uses the committed package-lock.json
./scripts/fetch-node-sidecar.sh     # fetch + VERIFY the signed node, place it as the sidecar
scripts/authority-check.sh          # must print AUTHORITY: PASS before you build
npm run smoke:cs1                   # isolated Linux/Mac host only: starts a temporary node on standard ports
npm run tauri dev                   # spawns node → /health → /auth/local → identity screen
```
A clean `cargo check` fails until the sidecar is fetched (the node binary is intentionally
not committed) — run `fetch-node-sidecar.sh` first. The app icon (`src-tauri/icons/`) and
both lockfiles (`package-lock.json`, `src-tauri/Cargo.lock`) are committed.

## What it does
1. Rust host runs `konsensus init` on first run, then `konsensus start --config …` as a
   **supervised sidecar** (killed on exit; init exit status + stderr are checked).
2. Polls health, pairs with rc14, then reads identity. Only a 404 on pair/request
   selects the retained rc7 auth/local fallback. The smoke uses rc14 read-scoped
   auth/local directly; it is not a pairing or owner-device test.
3. SolidJS UI reflects state; it never talks to the node directly and holds no shell/kill authority.

## Boundary (do not break)
Node = bundled binary, no `konsensus-*` crate dep (G1). Control plane loopback-only (G2).
Shell capability is scoped to the `konsensus` sidecar only; CSP is set (not null). Node CLI +
API paths pinned to BitSov-bitsov `v0.3.0-rc14 / d55a88e`. `scripts/authority-check.sh` checks the app-source boundary;
`fetch-node-sidecar.sh` verifies sidecar authenticity and integrity.

## Local pass/fail smoke

Run on an isolated Linux or macOS machine after the signed sidecar is available.
Do not run against the operator's live app: the smoke uses standard ports, including 3141.

```bash
npm run smoke:cs1
```

Pass condition: prints `SMOKE: PASS node_id=<node_id>`.

The smoke starts the signed sidecar on loopback, waits for `/health`, calls
`POST /api/v1/auth/local`, reads `/identity`, and asserts the renderer binds
`node_status.node_id` into the identity screen. It deliberately does not touch
funding, rooms, messaging, mobile, calls, hosted, AI, relay, merge, or deploy.

## rc4/rc5 boot workarounds — removed at rc6

Two splints carried since CS-1.5.1 are gone: the node fixed both at the root in `v0.3.0-rc6`
(BitSov-bitsov PR #61; issues #56 and #57).

- **Port collision (#56).** rc4/rc5 `init --tier full` wrote `[network].listen_addr` and
  `[lightning].listening_address` both on `0.0.0.0:9735`, and `start` fail-closed. The app
  moved `[network]` to `:9736` before every start (`dodge_rc4_port_collision` in
  `src-tauri/src/main.rs`; `patch_ports`/`port_in` in the CS-1 smoke). rc6's `init` defaults are
  P2P `0.0.0.0:9736`, Lightning `0.0.0.0:9735` — the patch is **deleted**.
- **Migrations not shipped (#57).** rc4/rc5 resolved SQLite migrations at runtime from
  `KONSENSUS_SQLITE_MIGRATIONS_DIR` and the release carried none, so the app fetched them pinned
  to the node's source-ref, bundled them as a Tauri resource and set the env var on `init`,
  `start` and restart. rc6 embeds the migrations in the binary (the env var remains an optional
  override the app does not set) — the fetch, `bundle.resources`, the env wiring and the CI
  placeholder that existed only for `resources` are **deleted**.

`konsensus start` uses fresh init defaults unchanged. On a retained rc7 upgrade,
the host can repair the page price only after separate consent; see
[NODE_RC14_UPGRADE.md](NODE_RC14_UPGRADE.md).
Acceptance: `npm run smoke:cs1` must boot rc14 with zero config edits; the non-gating `sidecar` CI job
runs the same smoke against the published release on every PR.

rc7 fixes #66: fresh init writes a primary/fallback pair, and startup validates
fee-estimate payloads before selecting an endpoint. The old rc6
`CS1_SMOKE_ESPLORA_PRIMARY` / `CS1_SMOKE_ESPLORA_FALLBACK` overrides are retired:
the smoke rejects them rather than silently testing a modified configuration.
Existing operator configurations retain their previous endpoints. Startup
selection is not runtime failover; both providers being unavailable may still
prevent startup. Do not mask a failed default-config smoke with an endpoint patch.

## CS-1.1 — durable two-run identity contract

`scripts/cs1-local-smoke.sh` proves the node identity is **durable across a restart**, matching
the app (`src-tauri/src/main.rs`): init once into the persistent data dir, skip re-init when
`konsensus.toml` already exists.

**Two runs, one data dir (no `rm` between them):**
1. **Run 1** — `init --tier full` + `start` → `/health` → `/auth/local` → `/identity` → `node_id A`. Stop the node (no cleanup).
2. **Run 2** — `start` from the **same** dir. `konsensus.toml` exists, so init is **skipped** (durable-identity restart). → `node_id B`. Stop.

**Verdict:**
- `A == B` and both non-empty →
  ```
  SMOKE: PASS node_id=<id>
  SMOKE: IDENTITY_STABLE node_id=<id>
  ```
- otherwise → `SMOKE: FAIL - identity not durable (run1=<A> run2=<B>)` (exit 1).

The temp data dir is removed **only** on EXIT (after run 2, or on FAIL) — never between the two
runs, since the dir surviving the restart is what proves durability. Hosts without a signed
sidecar still `SMOKE: SKIP` (exit 2), not PASS. Both runs start the config exactly as `init`
wrote it — the CS-1.5.1 rc4/rc5 splints were removed at rc6 (see above).
