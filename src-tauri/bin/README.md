# Bundled node binary (Tauri sidecar) — Gate G1

The app runs the **released** BitSov node as a **sidecar binary**; it does not link the
protocol crates, and the binary is **never committed**. Run the fetch/verify step immediately
before a package build (see `scripts/fetch-node-sidecar.sh`). The bundler itself does not yet
re-verify a pre-existing sidecar; closing that gap is required before public distribution.
Sidecars are named with the Rust target triple
Tauri's resolver expects: `bin/konsensus-<target-triple>[.exe]`.

## Hosts published at `v0.3.0-rc8`

> **DO NOT MERGE** this pin until `MindLink-ApS/BitSov-bitsov` release `v0.3.0-rc8`
> exists with signed `SHA256SUMS.asc`. Checksum/signature placeholders live in
> `scripts/fetch-node-sidecar.sh` (`EXPECTED_*`).

## App changes that ride with this pin (#60–#79)

When rc8 publishes and this pin merges, the app on `main` already carries:

- **#60** operation-id journal and reconcile (exactly-once slice 3)
- **#61** money-action lock (serialize spend)
- **#62–#63** capped / reason-code re-admission refusal copy
- **#65** attach to an owner-run external node (dev)
- **#66–#67** owner-contact command pre-check fixes
- **#68** pay a quoted re-admission after node restart (all-in)
- **#69** File tab → budget send, quiet copy, acked delivery tick
- **#70** calm chat layout + profile settings (EUT 9–12)
- **#71 / #75** voice notes as paid `audio/webm`
- **#72** AI endpoint badge (own / shared open / frontier)
- **#73** Discover view + My front door editor
- **#74** 1:1 voice/video calls over paid signalling (owner-set STUN; regtest prototype; genome #131)
- **#76** front-door editor media / CV / website / safe render
- **#77** Own-tier local model via loopback (AI P2)
- **#78** 15 KiB front-door publish budget (sig/site/endpoint margin vs node 16 KiB)
- **#79** offer the node's own STUN responder (`stun_url` from `/status`) in Calls settings (genome #136); Save still required

Genome companion (draft): https://github.com/MindLink-ApS/BitSov-bitsov/pull/124

`v0.3.0-rc8` publishes Linux, macOS and Windows node binaries, so all three hosts can
produce a sidecar:

| host | release asset | installed sidecar |
| --- | --- | --- |
| Linux x86_64 | `bitsov-linux-x86_64` | `bin/konsensus-x86_64-unknown-linux-gnu` |
| Linux aarch64 | `bitsov-linux-aarch64` | `bin/konsensus-aarch64-unknown-linux-gnu` |
| macOS arm64 | `bitsov-darwin-aarch64` | `bin/konsensus-aarch64-apple-darwin` |
| macOS x86_64 | `bitsov-darwin-x86_64` | `bin/konsensus-x86_64-apple-darwin` |
| Windows x86_64 | `bitsov-windows-x86_64` | `bin/konsensus-x86_64-pc-windows-msvc.exe` |

Release assets carry **no `.exe` suffix on any host**; only the installed Windows sidecar is
renamed to `.exe`, because that is what Tauri's resolver looks for. `npm run smoke:cs1`
runs on Linux and macOS (the Darwin `SKIP` was retired with `v0.3.0-rc5`) and still reports
`SMOKE: SKIP` on hosts without a signed sidecar.

## Fetch + verify (do this before building)
```bash
./scripts/fetch-node-sidecar.sh     # downloads the pinned binary for this host, verifies GPG + sha256, installs it
```
The script pins `v0.3.0-rc8` and verifies, fail-closed, that `SHA256SUMS.asc` is a valid
signature by the pinned release key `B299274C…`; if that key is not in your keyring it imports
`RELEASE_KEY.asc` from BitSov-bitsov `main` into a throwaway keyring (fingerprint checked against
the pin; your keyring is never written). Do not merge this pin until rc8 is a published
pre-release (placeholders `EXPECTED_TAG_SOURCE_SHA` / `EXPECTED_SHA256SUMS_*` must be filled).
Nothing here publishes anything. Record the sha256 in the authority ledger;
`scripts/authority-check.sh` checks source/configuration, not sidecar integrity. The
released artifact is the `konsensus` binary (CLI `konsensus init` / `konsensus start`).

## Dev only: a node built from genome `main`
`npm run tauri:dev:mainnode` runs an **unverified** local `konsensus` instead of this sidecar.
It is debug-only and a compile error in release. See `docs/DEV_NODE_FROM_MAIN.md`.
