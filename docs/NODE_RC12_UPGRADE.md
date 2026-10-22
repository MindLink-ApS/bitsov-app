# Bundled node rc12: upgrade from rc11

Historical release note. The current signed pin is described in [NODE_RC19_2_UPGRADE.md](NODE_RC19_2_UPGRADE.md); runtime and packaging acceptance remain separate gates.

Historical rc12 pin (app #178). The current pin and its changes are documented
in [NODE_RC14_UPGRADE.md](NODE_RC14_UPGRADE.md).

The app pinned `MindLink-ApS/BitSov-bitsov@v0.3.0-rc12`, source commit
`41b9e7811fe3ecdc89eab06ea3cf54d1a31661fd`, replacing rc11
(`834968b955eaa3d402b87cd0d6835456473115df`, app #174 / `81ee030`).

On 2026-10-07, GitHub's annotated tag resolved to this exact commit and its
source archive was inspected. The releases list reported rc12 as a **draft
pre-release**, with no publication timestamp; the release-by-tag endpoint
returned 404. The expected hashes below came from the pin request, not a local
signature or binary verification. A tag is not evidence of signed release
bytes. Fetch/package verification still requires the signed manifest and release
access and fails closed when unavailable. This change does not publish anything.

## Retained identity and state

Stop cleanly after reconciling pending payments/channel operations, replace the
verified binary and retain the same config, data directory, wallet and pairing
records. Do not re-run init, delete markers, replace passwords or restore stale
Lightning state. Keep the signed box-transport proof and key. The
[rc11 upgrade guidance](NODE_RC11_UPGRADE.md) still applies to older installs,
including state generation 2 and the refusal to reopen that state with rc9.
rc12 retains state generation 2; this is not a rollback acceptance claim.

Preserve `offline-heartbeat.json` and `offline-channel-windows.json` with the
node data. Check any retained explicit Lightning delay before a home start:
values below 288 now refuse startup, as described below.

## Changes since rc11

### #269: home default 2016 blocks, floor 288

With embedded LDK and the LSPS2 service disabled, `--remote-unlock` or
`--local-owner-device` selects the home profile. Omitted
`[lightning] our_to_self_delay_blocks` now resolves to **2016 blocks** (roughly
two weeks); explicit values must be **288–2016**. Raise or remove a retained
value below 288 before starting this profile. Ordinary starts and enabled
hub/LSP service starts retain the 144-block default and 144–2016 explicit range.

The app writes no delay override. Its opt-in bundled local owner ceremony uses
`--local-owner-device`, so it inherits the home default; ordinary bundled
starts retain 144. The delay is selected at startup, not serialized by `init`.
Only new channels use the new delay; existing channels retain their negotiated
window. Peers can refuse a larger delay and there is no automatic fallback.
This delays the peer's funds after its force-close; it neither provides active
watchtower protection nor removes the lockable node's hub-only channel policy.

### #270: owner status adds `offline_safety`

Authenticated owner `GET /api/v1/status` adds amount-free `offline_safety`
diagnostics, nullable for unsupported backends. Warning begins at 50% and
critical at 80% of each channel's negotiated breach window. The report includes
offline blocks, smallest window, percentage/severity, per-channel diagnostics,
`estimated`, `coverage_complete`, `startup_alert`, `history_available_on_start`
and `heartbeat_error`.

Missing history on the first upgraded start cannot establish past offline time.
`estimated: true` identifies an elapsed-time estimate when chain observation
stalls; incomplete coverage is not an all-clear. `startup_alert` retains a startup
warning after catch-up until process exit. Unlock, restore chain connectivity,
let the node sync, then check channels. These are local reminders, without hub
push, live alerts from a locked/offline node, or active offline protection.

**App gap:** this pin does not add UI for these diagnostics. The extra response
field is additive; the app's existing selected-field reads do not display it.
Do not present the existing connection indicator as an offline-safety alert.

### #273: remote device-key enrolment

While the node is unlocked and pairing/device approvals are enabled, a paired
Noise-tunnel client can now request, poll, cancel and list its device keys.
This removes rc11's route barrier for the Mac's **Set up Touch ID approvals**
enrolment flow. Registration remains bound to the authenticated paired client;
the P-256 proof does not approve the key. Pending requests are capped at eight
node-wide (HTTP 429), with existing per-client limits retained.

For this remote flow, the owner must compare fingerprints and approve at the
node console with `konsensus device approve`. Use `--owner-control` and a typed
encrypted-seed password for console approval. `--password-fd` does not provide
console device authority; `--local-owner-device` is separate and conflicts with
`--owner-control`. `--remote-unlock` also conflicts with `--owner-control`:
complete console enrolment in an unlocked owner-control start before switching
to remote-unlock mode. The locked router does not expose enrolment, and remote
delegation/revocation remain unavailable.

## App enrolment contract review

This is source evidence at the exact pin, not a live tunnel or Touch ID test.
The app's shared `call_api` adds bearer authentication and uses its remote
HTTP-over-Noise proxy with the original method, path and body. No enrolment
transport or DTO change is required.

| Operation | App request / rc12 agreement |
|---|---|
| Binding/list | `GET /api/v1/pair/device-keys`: `node`, `client_id`, `device_keys[].key_id` and optional `device_approvals` match `DeviceBinding`. Extra node fields are tolerated. |
| Register | `POST /api/v1/pair/device-key`: `{public_key, name, proof}` matches the strict node body. The registration message, uncompressed P-256 public key and hex DER/SHA-256 signature agree. |
| Pending reply | `op_id`, `key_id`, `fingerprint`, `expires_at`, `owner_action` and optional/null `delegation_message` match `DeviceKeyReply`. The app converts expiry seconds to milliseconds and accepts the node's 24-character hex operation ID. |
| Status | `GET /api/v1/pair/device-key/{op_id}`: `pending`, `registered`, `expired`, `lost`, `absent` match the app state transitions. The app also notices owner revocation through the binding/list call. |
| Cancel | `DELETE /api/v1/pair/device-key/{op_id}`: successful JSON or 404 is accepted by `withdraw_at_node`; other errors preserve the pending record. The node scopes status/cancel to the authenticated client. |
| Authority | All four routes require read-scoped pairing authentication. They confer no approval authority; approval/delegation routes remain absent from the remote router. |

**Incompatibility beyond enrolment:** the app's `do_relation_approve` posts to
`/api/v1/pair/relation-intent`, which rc12 deliberately excludes from its remote
router (404). The current setup copy promises contact approvals too broadly:
successful remote enrolment does **not** enable remote Touch ID contact-envelope
approval. Use the supported console approval flow; this pin does not widen the
node's authority boundary.

**Existing cancellation UX gap:** `Shell.tsx`'s `cancelDevice` ignores a failed
outcome, so the pending-request component cannot show that cancellation error.
The host correctly retains the pending record; a failed cancellation must not be
treated as confirmed. This is not a new rc12 wire incompatibility.

Other inherited limitations remain: remote first run is unsupported by this
app, and its `hosted_by` display filter still omits the Unicode ranges recorded
in the rc11 note. The local owner ceremony remains opt-in.

Source evidence: app `src-tauri/src/app.rs` (`device_binding`,
`do_device_key_register`, `do_device_key_status_local`, `do_device_key_cancel`,
`withdraw_at_node`, `do_relation_approve`), `src-tauri/src/device.rs`,
`src-tauri/src/remote_access.rs`, `src-tauri/native/device_key.swift`, and
`src/control/Shell.tsx`; node
[`handlers/pairing_routes.rs`](https://github.com/MindLink-ApS/BitSov-bitsov/blob/41b9e7811fe3ecdc89eab06ea3cf54d1a31661fd/crates/konsensus-api/src/handlers/pairing_routes.rs),
[`handlers/device_routes.rs`](https://github.com/MindLink-ApS/BitSov-bitsov/blob/41b9e7811fe3ecdc89eab06ea3cf54d1a31661fd/crates/konsensus-api/src/handlers/device_routes.rs),
[`pairing/device.rs`](https://github.com/MindLink-ApS/BitSov-bitsov/blob/41b9e7811fe3ecdc89eab06ea3cf54d1a31661fd/crates/konsensus-api/src/pairing/device.rs),
and [`device_key_http_tests.rs`](https://github.com/MindLink-ApS/BitSov-bitsov/blob/41b9e7811fe3ecdc89eab06ea3cf54d1a31661fd/crates/konsensus-api/tests/device_key_http_tests.rs)
(test source inspected, not executed).

## Config drift guard

Compared rc11 and rc12 `crates/konsensus-node/src/config.rs` and
`crates/konsensus-lightning/src/tower/mod.rs`: no added fields under `[node]`,
`[tower]`, or elsewhere in the serialized init config. The config change is
the startup delay policy above; the optional delay still serializes as absent
when unset. `local_owner/config_tests.rs` therefore retains its exact rc11
allowances, including empty `[node]` / `[tower.clients]`, with no new ignored
fields. The real `init` drift test remains a CI gate and was not run locally.

Primary references at the pin:
[`config.rs`](https://github.com/MindLink-ApS/BitSov-bitsov/blob/41b9e7811fe3ecdc89eab06ea3cf54d1a31661fd/crates/konsensus-node/src/config.rs),
[`health.rs`](https://github.com/MindLink-ApS/BitSov-bitsov/blob/41b9e7811fe3ecdc89eab06ea3cf54d1a31661fd/crates/konsensus-api/src/handlers/health.rs),
[upgrading](https://github.com/MindLink-ApS/BitSov-bitsov/blob/41b9e7811fe3ecdc89eab06ea3cf54d1a31661fd/docs/UPGRADING.md),
[home-node runbook](https://github.com/MindLink-ApS/BitSov-bitsov/blob/41b9e7811fe3ecdc89eab06ea3cf54d1a31661fd/docs/operations/home-node.md).

## Expected release bytes

Expected `SHA256SUMS`, supplied for this pin. Required signer:
`B299274C200301714DC6F51A7C2D6F8AC842EF6E`. These values do not replace the
fetcher's fail-closed signature and binary-hash checks. Neither was run here.

| Asset | SHA-256 |
|---|---|
| bitsov-darwin-aarch64 | `560403b52163930efde3c2db3da533d8b425ea0c5cdcee7f86792c0b085c983a` |
| bitsov-darwin-x86_64 | `97733203a71aa6c449ea74a005be65fbc87171aab47d5aaa00c8303cee61aef1` |
| bitsov-linux-aarch64 | `817a08fecee38d15152e3059d54e41f5a4ab4b2ea698a7bf5482fe25917eecef` |
| bitsov-linux-x86_64 | `e92ee07cfb2fd585a5c62cbeffd001ab2e07b24548dc7f6cc57a3b5873aeb251` |
| bitsov-windows-x86_64 | `d1e7b1a305a1f4940d3e49d59b5487d99fc6cbcb4abc5306408c2804b4632074` |

## Validation and remaining acceptance

Local results (2026-10-07), restricted to the requested commands:

- `npx vitest run`: 66 files, 1064 tests passed; Solid computation-disposal warnings emitted.
- `npx tsc --noEmit`: passed.
- `cargo test --offline --locked --manifest-path src-tauri/Cargo.toml --test android_device_key_contract --test android_pairing_contract --test mac_keychain_contract --test mac_typed_unlock_contract`: 27 text-only tests passed.
- `cargo check --offline --locked --manifest-path src-tauri/Cargo.toml --all-targets`: passed using the pre-existing local sidecar file for build-time discovery; this does not verify rc12 bytes.
- `bash scripts/cs2-local-smoke.sh`: passed (static bindings).

No app, node, other Rust test binary, fetch/verification script, CS-1 smoke,
packaging build or live enrolment was run. Source review finds the requested
register/status/cancel flow compatible, with the limitations above.

Sidecar CI must fetch and verify accessible rc12 release assets, then run the
config drift and local owner lifecycle checks and durable-identity CS-1 smoke.
Mac Package CI must re-verify before bundling and compare bundle bytes. Retained
state, unlocked remote enrolment with console approval, cancel/refusal handling,
remote unlock and signed/hardened Mac biometric acceptance remain operator/CI
gates. App publication remains human-only; nothing was pushed by this change.
