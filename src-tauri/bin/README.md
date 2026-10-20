# Bundled node binary (Tauri sidecar) — Gate G1

The app runs the **released** BitSov node as a **sidecar binary**; it does not link the
protocol crates, and the binary is **never committed**. Run the fetch/verify step immediately
before a package build (see `scripts/fetch-node-sidecar.sh`). Every package build now
re-verifies existing sidecars against the pinned release before bundling (see below).
Sidecars are named with the Rust target triple
Tauri's resolver expects: `bin/konsensus-<target-triple>[.exe]`.

## Hosts published at `v0.3.0-rc18`
The rc18 release publishes Linux, macOS and Windows node binaries:

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
The script pins `v0.3.0-rc18` and verifies, fail-closed, that `SHA256SUMS.asc` is a valid
signature by the pinned release key `B299274C…`; if that key is not in your keyring it imports
`RELEASE_KEY.asc` from BitSov-bitsov `main` into a throwaway keyring (fingerprint checked against
the pin; your keyring is never written). rc18 is a published, GPG-signed pre-release;
its five binary hashes and the local signature/byte verification are recorded in
[the upgrade note](../../docs/NODE_RC18_UPGRADE.md). Fetching fails closed if release access or signed
assets are unavailable. Nothing here publishes anything. Record the sha256 in the authority
ledger; `scripts/authority-check.sh` checks source/configuration, not sidecar integrity. The
released artifact is the `konsensus` binary (CLI `konsensus init` / `konsensus start`).

## Mandatory pre-bundle verification
```bash
bash scripts/fetch-node-sidecar.sh --verify-only
```
This mode downloads fresh `SHA256SUMS` and `SHA256SUMS.asc` from the **same pinned
repository/tag** as fetch, using the same pinned-key import and fail-closed GPG
signature predicate. It hashes **every** `src-tauri/bin/konsensus-*`, maps its exact
target filename to the release asset above, and requires exactly one valid SHA256
entry in the signed manifest. It never executes, replaces, or repairs a sidecar.

`scripts/package-mac.sh`, Tauri's `beforeBundleCommand` (including direct Tauri
bundling), and the Mac Package CI job enforce this check. `--use-existing-sidecar`
and `BITSOV_USE_EXISTING_SIDECAR=1` skip the binary download only; they cannot skip
verification. Other targets in `bin/` are checked too. The manual DMG fallback
and CI zip step re-verify and compare the bundled node to the verified source.

A mismatch stops packaging and names the file, pinned release, **expected sha256**
and **actual sha256**. An unknown target or absent/duplicate/malformed checksum
entry is refused with the actual hash and an unavailable expected hash. Missing
sidecars, symlinks, unavailable release metadata, and unaccepted signatures also
fail closed. `gh`, `gpg`, and access to the pinned release are required even when
the binary is already on disk; there is no offline or dev packaging bypass.
Re-fetch the pinned binary (and remove unintended target files) before retrying.

Offline regression coverage: `python3 scripts/test-verify-sidecars.py` and
`python3 scripts/test-package-mac.py` use local test keys, real GPG signatures and
real hashes with fixture-only GitHub downloads. `bash scripts/test-fetch-verify.sh`
covers the signature refusal classes. See the
[release checklist](../../docs/RELEASE_CHECKLIST.md) before shipping artifacts.

## Dev only: a node built from genome `main`
`npm run tauri:dev:mainnode` runs an **unverified** local `konsensus` instead of this sidecar.
It is debug-only and a compile error in release. See `docs/DEV_NODE_FROM_MAIN.md`.
