# Bundled node rc14: upgrade from rc13

Historical rc14 pin (app #199). The current pin and its changes are documented
in [NODE_RC18_UPGRADE.md](NODE_RC18_UPGRADE.md).

The app pinned `MindLink-ApS/BitSov-bitsov@v0.3.0-rc14`, source commit
`d55a88e439fd80dae89e263bef8378fd22c9a103`, replacing rc13
(`d625e85a04886ac81f76f77a6ae41651dbb3e157`, app #193 / `9f10373`).

The [release](https://github.com/MindLink-ApS/BitSov-bitsov/releases/tag/v0.3.0-rc14)
is **published and GPG-signed**, per the supplied release facts. The source SHA
was resolved from the local node tag, and its release notes and config changes
were inspected offline. The tagged operator checklist still contains preparation
status; publication status and the five hashes below come from the pin request.
No assets were downloaded, no release signature or binary was verified locally,
and neither the app nor a real node was launched for this change.

## Retained identity and forward-only pairing

Follow the node's tagged
[rc13 → rc14 procedure](https://github.com/MindLink-ApS/BitSov-bitsov/blob/v0.3.0-rc14/docs/UPGRADING.md#rc13--rc14-procedure)
and [release notes](https://github.com/MindLink-ApS/BitSov-bitsov/blob/v0.3.0-rc14/docs/releases/v0.3.0-rc14.md).
For skipped releases, also follow the earlier procedures in
[UPGRADING](https://github.com/MindLink-ApS/BitSov-bitsov/blob/v0.3.0-rc14/docs/UPGRADING.md)
and the [historical rc13 app note](NODE_RC13_UPGRADE.md).

Stop cleanly after reconciling pending payments/channel operations. Replace only
the verified binary, keeping the same config, data directory, identity, wallet,
pairing records, box-transport proof/key and offline-safety files. Do not re-run
init, replace passwords, delete markers or restore stale Lightning state.

**Pairing file v6 is forward-only: rc13 refuses it.** Preserve the current store
and roll forward; reverting this app pin is not a safe node-state rollback.
Existing generation-3 and copied-state/recovery fences remain. A host/volume
fence cannot prove freshness or detect every same-host SD-image rollback.
Never start a historical LDK store or remove refusal markers to bypass a fence.

## Changes since rc13 and app limits

| Node change | App relevance and boundary |
|---|---|
| Durable grant breakers / pairing v6 | New grants default to 10 attempts/minute, 60/hour, 5 consecutive failures and 1,000 sats/10 minutes. New relation grants share fixed limits across envelopes; a larger envelope cannot widen them. Console approval may choose other positive limits. |
| Grandfathered grants | Legacy grants without breaker fields retain `u64::MAX` limits until explicitly replaced. Envelope renewal preserves those limits; this pin does not silently migrate or replace grants. |
| Failure pause and reset | Time, renewal and restart cannot clear a failure pause. Reset requires the owner console; it does not refund budget, clear dedupe or resolve unknown payments. Paired apps have no reset authority. Separate AI pairing work (#195) depends on rc14 and is not implemented by this pin. |
| Encrypted backup metadata index and `konsensus recover` | Owner-console-only maintenance for embedded LDK. The SCB is an index, not live-state restore. Recovery needs a reachable original hub closing from its state, confirmed sweeps, an externally funded fresh LSPS2 channel, a settled 1-sat hub payment and a final chain recheck. An unreachable hub has no backup force-close fallback. HTLCs/legacy non-v2 keys are outside scope; seed-only scanning cannot prove every channel closed. |
| Recovery status | Sanitized owner status is read-only. Maintenance serves no API; public health and non-owner status expose no recovery state. This pin adds no app recovery workflow. |
| LAN setup page limits | Node enforces source rate limits, bounded source tracking, a 2,048-byte body limit, 5-second body/header deadlines and 32 concurrent connections shared across listeners. These are internal limits, not new app-written config fields; box approval remains required. |
| Core Lightning preview | Pinned HTTPS/rune/getinfo plus invoice creation, incoming settlement verification, history, channels and balances. Outgoing invoice payments and keysend refuse before dispatch; payment capability and money readiness remain false. Stateless quotes, hold invoices, inbound keysend TLV watching, channel management and on-chain sends remain unsupported. CLN owns its funds and backups; the app's default remains embedded LDK. |

Remote first run is implemented on main (app #192 + node rc13), including
PairLink v2, claim-code/SAS and box approval. Real-hardware acceptance with
Touch ID and a fresh Pi remains pending. The local owner ceremony remains
opt-in, and retained-identity consent gates are unchanged. Existing app mocks
and source checks do not establish rc14 wire or retained-state compatibility.

## Config defaults and drift guard

The local tag comparison of rc13 to rc14 shows no changes to
`NodeConfig::default_for_tier(Full)` or its embedded LDK defaults. The new CLN
config variant does not affect that profile. The bootstrap writer retains:

- `[setup_page].port = 8080`.
- `[lightning].backend = "ldk"`, network `bitcoin`.
- `max_channel_capacity_sats = 1000000` and
  `max_total_channel_capacity_sats = 2000000`.
- Existing primary/fallback providers, paths and explicit app differences.

Grant breakers are pairing/grant state, not node TOML defaults. LAN setup limits
are implementation constants. No new serialized full-tier defaults need adding
to `OMITTED_DEFAULTS`; its literal checks and unknown-field comparison remain
strict. The existing config drift and owner lifecycle CI steps now select rc14
and must still run against the fetched, verified release binary.

## Expected release bytes

Required signer, unchanged:
`B299274C200301714DC6F51A7C2D6F8AC842EF6E`.

These are the supplied entries from the signed `SHA256SUMS`. A hash of the
manifest itself was not supplied and is not inferred.

| Asset | SHA-256 |
|---|---|
| bitsov-darwin-aarch64 | `1b8fdecb87a308aff657a476eb92c5b100496c64076e90a45e3bee0fb2301305` |
| bitsov-darwin-x86_64 | `f75bb56fca4b5e7bad998cfab1b4b775a863108c0520710b006a9ea78ff64f63` |
| bitsov-linux-aarch64 | `6d11b992b939ca0c6ee058e0b82c26ab8dc1ab96b1f61d1e049bef6685fb310c` |
| bitsov-linux-x86_64 | `07b0ace79c362c5d30431b47856e7ca3bb9515b73aa37a0c342988dd70849e78` |
| bitsov-windows-x86_64 | `5f8e80990b603e334e574a585217edeb23de70873b2ea4701317fa533ca33a19` |

As in #193, the fetcher pins the tag and signer, authenticates `SHA256SUMS.asc`,
and checks each binary against exactly one valid entry in that signed manifest.
The recorded per-platform hashes do not bypass or replace those fail-closed
checks. Missing, invalid or inaccessible release assets must still fail.

## Validation and remaining acceptance

Local results (2026-10-11), headless and offline:

- `npm test`: 74 files, 1,143 tests passed.
- `tsc --noEmit`: passed.
- `bash scripts/test-fetch-verify.sh`: 7/7 passed.
- `python3 scripts/test-verify-sidecars.py`: 11 tests passed.
- `python3 scripts/test-package-mac.py`: 7 tests passed with stubbed build commands.
- `bash scripts/test-check-mac-bundle.sh`: 19 cases passed.
- `bash scripts/test-authority-source.sh`: 7 cases passed.
- `bash scripts/authority-check.sh`: passed.
- `bash scripts/cs2-local-smoke.sh`: passed (static bindings).
- `BITSOV_TEST_APP=/tmp/bitsov-rc14-no-built-app bash scripts/test-app-lifecycle.sh`:
  9 source checks passed; real bundle lifecycle skipped.
- Changed shell scripts passed `bash -n`; changed Markdown links resolve;
  `git diff --check` passed.

The initial frontend/type run used an older local dependency tree missing the
barcode plugin. Both passed after selecting a local dependency tree with an
identical lockfile; no packages were downloaded. Frontend tests emitted Solid
reactive-root disposal warnings. The sandbox blocked GnuPG agent IPC; the three
signature-dependent fixture suites passed outside it. Fixture signing uses
temporary test keys and payloads, not the release key or rc14 bytes. No Rust
build, real-node config drift/lifecycle run, app launch or package build was
performed locally.

Sidecar CI must fetch and verify rc14, then run the full-tier init drift guard,
owner create/finalize/restart lifecycle and durable-identity CS-1 smoke. Mac
Package CI must re-verify before bundling and compare bundled bytes. Retained
state, grant behavior, remote pairing/unlock and signed/hardened Mac biometric
acceptance remain separate checks. No runtime or packaging acceptance is claimed.
