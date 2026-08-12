# Bundled node binary (Tauri sidecar) — Gate G1

The app runs the **released** BitSov node as a **sidecar binary**; it does not link the
protocol crates. Drop the pinned node binary here, named with the Rust target triple that
Tauri's sidecar resolver expects:

    bin/konsensus-<target-triple>[.exe]

e.g. `bin/konsensus-aarch64-apple-darwin`, `bin/konsensus-x86_64-apple-darwin`,
`bin/konsensus-x86_64-unknown-linux-gnu`, `bin/konsensus-x86_64-pc-windows-msvc.exe`.

## Get + verify the pinned binary (v0.3.0-rc4 / aa159189…)
```bash
gh release download v0.3.0-rc4 --repo MindLink-ApS/BitSov-bitsov \
  -p 'bitsov-linux-*' -p 'SHA256SUMS' -p 'SHA256SUMS.asc' --dir /tmp/bitsov-rc4
# verify signature + checksums BEFORE bundling (see BitSov-bitsov SECURITY.md, key B299274C…)
( cd /tmp/bitsov-rc4 && gpg --verify SHA256SUMS.asc SHA256SUMS && sha256sum -c SHA256SUMS )
cp /tmp/bitsov-rc4/bitsov-linux-x86_64 bin/konsensus-x86_64-unknown-linux-gnu
chmod +x bin/konsensus-*
```
Record the sha256 here and in the authority ledger; `CODEX_APP_AUTHORITY.md §G` re-checks it.
The released artifact is the `konsensus` binary (CLI `konsensus init` / `konsensus start`).
