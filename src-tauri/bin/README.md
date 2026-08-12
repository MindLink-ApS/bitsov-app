# Bundled node binary (Tauri sidecar) — Gate G1 · **CS-1 is Linux-only**

The app runs the **released** BitSov node as a **sidecar binary**; it does not link the
protocol crates, and the binary is **never committed** — it is fetched + verified at build
time (see `scripts/fetch-node-sidecar.sh`). Sidecars are named with the Rust target triple
Tauri's resolver expects: `bin/konsensus-<target-triple>[.exe]`.

## Linux-only today (blocker B10)
The public `v0.3.0-rc4` release publishes **only Linux** node binaries
(`bitsov-linux-x86_64`, `bitsov-linux-aarch64`). So only these sidecars can be produced:

    bin/konsensus-x86_64-unknown-linux-gnu
    bin/konsensus-aarch64-unknown-linux-gnu

**macOS / Windows are NOT available yet** — publishing signed `konsensus-*-apple-darwin`
and `-pc-windows-msvc` binaries (add those targets to the protocol `release-cli` matrix) is
the prerequisite for a Mac/Windows app. Do not ship a Mac/Windows build without a verified
signed node sidecar.

## Fetch + verify (do this before building)
```bash
./scripts/fetch-node-sidecar.sh     # downloads the pinned rc4 Linux binary, verifies GPG + sha256, installs it
```
The script pins `v0.3.0-rc4` and verifies against key `B299274C…` (import `RELEASE_KEY.asc`
from BitSov-bitsov first). Record the sha256 in the authority ledger; `scripts/authority-check.sh`
and `CODEX_APP_AUTHORITY.md §G` re-check integrity. The released artifact is the `konsensus`
binary (CLI `konsensus init` / `konsensus start`).
