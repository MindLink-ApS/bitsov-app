# Bundled node binary (Tauri sidecar) — Gate G1

The app runs the **released** BitSov node as a **sidecar binary**; it does not link the
protocol crates, and the binary is **never committed** — it is fetched + verified at build
time (see `scripts/fetch-node-sidecar.sh`). Sidecars are named with the Rust target triple
Tauri's resolver expects: `bin/konsensus-<target-triple>[.exe]`.

## Hosts published at `v0.3.0-rc5`
`v0.3.0-rc5` publishes Linux, macOS and Windows node binaries, so all three hosts can
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
remains Linux-only and still reports `SMOKE: SKIP` elsewhere.

## Fetch + verify (do this before building)
```bash
./scripts/fetch-node-sidecar.sh     # downloads the pinned binary for this host, verifies GPG + sha256, installs it
```
The script pins `v0.3.0-rc5` and verifies against key `B299274C…` (import `RELEASE_KEY.asc`
from BitSov-bitsov first). rc5 is still a **draft** release — `gh release download` reaches it
with an authenticated `gh`, and nothing here publishes it. Record the sha256 in the authority
ledger; `scripts/authority-check.sh` and `CODEX_APP_AUTHORITY.md §G` re-check integrity. The
released artifact is the `konsensus` binary (CLI `konsensus init` / `konsensus start`).
