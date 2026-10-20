# Bundled node rc18: upgrade from rc14

The app pins `MindLink-ApS/BitSov-bitsov@v0.3.0-rc18`, source commit
`20c6449ebec9d656595390ee1f1623fb6af1411f`, replacing rc14
(`d55a88e439fd80dae89e263bef8378fd22c9a103`, app #199 / `2799e5a`).
rc15, rc16 and rc17 were never pinned by the app. The rc15 tag has no release
build (its Cargo Audit failed); rc16 is the first signed build of that content.

The [release](https://github.com/MindLink-ApS/BitSov-bitsov/releases/tag/v0.3.0-rc18)
is a published pre-release (2026-10-20). For this pin the signed tag, the
signed `SHA256SUMS` and the Darwin arm64 bytes were downloaded and verified
locally (see [Verification](#verification)).

## Retained identity and forward-only state

Follow the node's tagged procedures, in order, for every skipped release:
[rc14 → rc15](https://github.com/MindLink-ApS/BitSov-bitsov/blob/v0.3.0-rc18/docs/UPGRADING.md#rc14--rc15-procedure),
[rc15 → rc16](https://github.com/MindLink-ApS/BitSov-bitsov/blob/v0.3.0-rc18/docs/UPGRADING.md#rc15--rc16),
[rc16 → rc17](https://github.com/MindLink-ApS/BitSov-bitsov/blob/v0.3.0-rc18/docs/UPGRADING.md#rc16--rc17-pairing-storage-v8)
and [rc17 → rc18](https://github.com/MindLink-ApS/BitSov-bitsov/blob/v0.3.0-rc18/docs/UPGRADING.md#rc17--rc18).
Release notes:
[rc15](https://github.com/MindLink-ApS/BitSov-bitsov/blob/v0.3.0-rc18/docs/releases/v0.3.0-rc15.md),
[rc16](https://github.com/MindLink-ApS/BitSov-bitsov/blob/v0.3.0-rc18/docs/releases/v0.3.0-rc16.md),
[rc17](https://github.com/MindLink-ApS/BitSov-bitsov/blob/v0.3.0-rc18/docs/releases/v0.3.0-rc17.md),
[rc18](https://github.com/MindLink-ApS/BitSov-bitsov/blob/v0.3.0-rc18/docs/releases/v0.3.0-rc18.md).
The [historical rc14 app note](NODE_RC14_UPGRADE.md) still applies to installs
that skipped rc14.

Replace only the verified binary, keeping the same config, data directory,
identity, wallet, pairing records and offline-safety files. Do not re-run init,
replace passwords, delete markers or restore stale Lightning state.

**Reverting this app pin is not a safe node-state rollback.** Once the bundled
rc18 node has run on a data directory, the app must not ship or start an older
node against it:

| Fence | Introduced | Older binaries |
|---|---|---|
| Pairing storage **v8** (`relation_envelope_id_v1`) | rc17 | rc16 and older refuse `pairing/clients.json` v8. rc14 also refuses v7. Never lower the version, strip fields, or follow rc14's "remove the file to re-pair" hint. |
| SQL migration 029 (operation abandonment) | rc15 | Forward-only; rc14 must not run against upgraded storage. Leave `KONSENSUS_SQLITE_MIGRATIONS_DIR` unset. |
| Lightning 0.2.7 persisted fields | rc15 | No downgrade to rc14 after running with embedded LDK; 0.2.2 drops the new fields on reserialization. |

v2–v7 pairing stores migrate to v8 on the next pairing-store write. Existing
budgets, breakers, replay nonces and expiries are preserved; envelopes without
an identity stay `null` until approved again. rc18 itself adds no SQL,
pairing-store or peer-store schema change.

## Changes since rc14 and app impact

| Node change | App relevance and boundary |
|---|---|
| Owner-device enrollment over Noise, `owner_device_approval_v1` spend/first-contact approvals (rc15 #301/#303) | The app already feature-detects `owner_device_approval_v1` (app #216, `src/control/ownerApproval.ts`, `src-tauri/src/control.rs`). With the rc14 pin the capability was absent; on rc18 it is advertised when approval readiness is met (encrypted seed, password typed or supplied by descriptor/remote unlock with `--local-owner-device`). |
| Independent owner-device breaker reset, pairing v7 (rc15 #304) | `owner_device_approval_breaker_reset_v1` is already feature-detected (`src/control/OwnerApprovals.tsx`). A paused pairing still cannot reset itself. |
| Operation abandonment, migration 029 (rc15 #306) | `message_operation_abandon_v1` is already feature-detected in `src-tauri/src/app.rs`. Abandonment is not cancellation or refund of a dispatched payment. |
| Blank encryption passwords refused (rc15 #302) | The local owner ceremony already generates a random 32-byte (base64) Keychain password and passes it by descriptor; no app change. |
| Lightning 0.2.7 / ldk-node 0.7.1 backports (rc15) | New fail-closed startup error `Failed to read from store.` when the ChannelManager cannot be read. The app surfaces node start failures as-is; it must never offer to delete or replace Lightning state. |
| Zip advisory triage (rc16) | None. |
| `sign-challenge` and `node-id` decrypt `mnemonic.enc` (rc17 #317, rc18 #321) | Owner-console tooling only; no app change. |
| Per-approval envelope identity, pairing v8 (rc17 #312) | `relation_envelope_id_v1` is already feature-detected (`src-tauri/src/grant.rs`, `src/control/Shell.tsx`). Forward-only; see the fence table above. |
| Funding address reports the configured network; `/peers/export` accepts Read scope (rc18 #321) | The app already shows the optional `network` field next to the deposit address (`src/App.tsx`, `src/control/WalletPage.tsx`); a signet node now reports signet there. |
| Live `konsensus peer add`, peer admission hardening (rc18 #322/#324/#327) | Owner-console only; the app adds no peer-admission UI. |
| Optional `push_sats` on owner channel open; per-provider `trust_no_reserve` (rc18 #326) | Neither is used by the app. `trust_no_reserve` defaults to `false` and full-tier init writes `providers = []`, so the bootstrap config is unchanged. |
| Anchor-only inbound/JIT channels; recovery needs reserve or waiver (rc18 #329) | Inbound non-anchor channels are refused by the node. The app's default is embedded LDK with liquidity disabled; no app change. |

Remote first run (app #192), the local owner ceremony opt-in and the
retained-identity consent gates are unchanged. Existing app mocks and source
checks do not establish rc18 wire or retained-state compatibility; real-hardware
acceptance (Touch ID + a fresh Pi) remains pending.

## Config defaults and drift guard

`crates/konsensus-node/src/config.rs` (including
`NodeConfig::default_for_tier(Full)`) is unchanged between the rc14 and rc18
tags. The only new serialized config field is `trust_no_reserve` on liquidity
provider entries; the full-tier default has no provider entries, so nothing new
is written. The bootstrap writer and `OMITTED_DEFAULTS` therefore need no value
changes or new allowances. The drift guard was run locally against the verified
rc18 binary (see below) and still runs in Sidecar CI.

## Expected release bytes

Required signer, unchanged:
`B299274C200301714DC6F51A7C2D6F8AC842EF6E`.
`SHA256SUMS` sha256: `a0406d7c7ce5c6294d1bb67c571f40fd04fdb72e6d1763c55dcfc0301e4159d9`.

| Asset | SHA-256 |
|---|---|
| bitsov-darwin-aarch64 | `e2646029a79fa46ee69a80407429ba5dce5e066d3dfcb63b04bef9015577f917` |
| bitsov-darwin-x86_64 | `c468b9798eaa389084855ce19003a77f83626dbf1be15b8dd293a39f903f78fe` |
| bitsov-linux-aarch64 | `6dd33f65ae6ec0caed96a59d2d1b1b6b27aae15e3e47903f9d03d7107b7c8615` |
| bitsov-linux-x86_64 | `992ad172d238e08066a5b985f1ec9ccb52f36fe52f6b7abe661c1a3e87d603a1` |
| bitsov-windows-x86_64 | `0beed30b47115bca378898172b7d5ea72094fa63321def4dc796a79d45938e8d` |

These match the signed manifest and GitHub's asset digests. The fetcher pins
the tag and signer, authenticates `SHA256SUMS.asc`, and checks each binary
against exactly one valid entry in that signed manifest. The recorded hashes do
not bypass or replace those fail-closed checks.

## Verification

Local results (2026-10-20, macOS arm64):

- `git rev-parse v0.3.0-rc18^{commit}`: `20c6449ebec9d656595390ee1f1623fb6af1411f`;
  `git verify-tag v0.3.0-rc18`: `GOODSIG` / `VALIDSIG` by
  `B299274C200301714DC6F51A7C2D6F8AC842EF6E` (throwaway keyring, key from the
  tagged `RELEASE_KEY.asc`).
- `gpg --verify SHA256SUMS.asc SHA256SUMS`: `GOODSIG` / `VALIDSIG` by the
  pinned key, no refusal statuses; all five entries equal GitHub's asset digests.
- `bash scripts/fetch-node-sidecar.sh` (empty `GNUPGHOME`, so the
  `RELEASE_KEY.asc` import path ran): signature accepted, `bitsov-darwin-aarch64`
  sha256 `e2646029…f917`, installed as `konsensus-aarch64-apple-darwin`;
  `--version` reports `konsensus 0.3.0-rc18`.
- `bash scripts/fetch-node-sidecar.sh --verify-only`: signature accepted and
  the installed sidecar matches the signed manifest (exit 0).
- Config drift guard `bootstrap_config_matches_node_init` against the verified
  rc18 binary: passed (1 test ran).
- Owner lifecycle against the same binary: the `host_child` create, finalize and
  restart test passed when run directly (3.3 s). The CI wrapper
  `real_node_create_finalize_restart_lists_device` currently spawns its child
  with the pre-mobile-split test path and runs 0 child tests, so its pass alone
  is not lifecycle evidence; that is a separate fix.
- Every MVP path in [API_READINESS](API_READINESS.md) appears in the rc18
  `konsensus-api` source.
- `npm ci`, `tsc --noEmit`, `npm test` (91 files, 1,573 tests), `npm run build`
  and `npm run authority`: passed.
- `bash scripts/test-fetch-verify.sh` (7/7), `python3 scripts/test-verify-sidecars.py`
  (13 tests), `python3 scripts/test-package-mac.py` (7 tests),
  `bash scripts/test-check-mac-bundle.sh` (19 cases),
  `bash scripts/test-authority-source.sh`, `bash scripts/test-dev-node-release-guard.sh`,
  `bash scripts/cs2-local-smoke.sh` and
  `BITSOV_TEST_APP=/tmp/bitsov-rc18-no-built-app bash scripts/test-app-lifecycle.sh`
  (9 passed, bundle lifecycle skipped): passed.
- `cargo check --locked --all-targets` in `src-tauri`: passed.

Not run locally: Linux sidecar bytes, the live-network CS-1 smoke, a package
build, an app launch, or any retained-state upgrade. Sidecar CI must fetch and
verify rc18 on Linux and run the drift guard, owner lifecycle and CS-1 smoke;
Mac Package CI must re-verify before bundling. Retained state, grant behavior,
remote pairing/unlock and signed/hardened Mac biometric acceptance remain
separate checks.
