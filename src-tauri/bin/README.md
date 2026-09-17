# Bundled node binary (Tauri sidecar) — Gate G1

The app runs the **released** BitSov node as a **sidecar binary**; it does not link the
protocol crates, and the binary is **never committed**. Run the fetch/verify step immediately
before a package build (see `scripts/fetch-node-sidecar.sh`). The bundler itself does not yet
re-verify a pre-existing sidecar; closing that gap is required before public distribution.
Sidecars are named with the Rust target triple
Tauri's resolver expects: `bin/konsensus-<target-triple>[.exe]`.

## Hosts published at `v0.3.0-rc7`
`v0.3.0-rc7` publishes Linux, macOS and Windows node binaries, so all three hosts can
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
The script pins `v0.3.0-rc7` and verifies, fail-closed, that `SHA256SUMS.asc` is a valid
signature by the pinned release key `B299274C…`; if that key is not in your keyring it imports
`RELEASE_KEY.asc` from BitSov-bitsov `main` into a throwaway keyring (fingerprint checked against
the pin; your keyring is never written). rc7 is a published pre-release, so any `gh` reaches it,
and nothing here publishes anything. Record the sha256 in the authority
ledger; `scripts/authority-check.sh` checks source/configuration, not sidecar integrity. The
released artifact is the `konsensus` binary (CLI `konsensus init` / `konsensus start`).
