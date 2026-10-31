# Bundled node rc11: upgrade from rc9

Historical release note. The current signed pin is described in [the fetch script](../scripts/fetch-node-sidecar.sh); runtime and packaging acceptance remain separate gates.

Historical rc11 pin (app #174). Later rc14 changes are documented
in [NODE_RC14_UPGRADE.md](NODE_RC14_UPGRADE.md).

The app pinned `MindLink-ApS/BitSov-bitsov@v0.3.0-rc11`, targeting
`834968b955eaa3d402b87cd0d6835456473115df`. Upgrade directly from rc9
(`cd75c69ed17eeb812d45bdc666b381ca7da1b697`): rc10 was tagged but never
published; rc11 includes its changes and the ticket-revocation fix.

On 2026-10-07, GitHub's release API reported a published pre-release and its
annotated tag resolved to the commit above. `SHA256SUMS` and `SHA256SUMS.asc`
were downloaded from that release. The repository's signature verifier accepted
the manifest under `B299274C200301714DC6F51A7C2D6F8AC842EF6E`; the fetched Darwin
arm64 sidecar matched it. No node or app was executed. The source archive at the
exact commit was inspected; its release docs still say “preparation”, so the
publication status comes from GitHub, not that stale heading.

## Retained identity and state

Keep the same config, data directory, wallet and pairing records. Reconcile
pending payments, channel opens and LSPS2 top-ups, then stop cleanly. Do not
re-run init, replace passwords, delete markers or restore stale Lightning state.
The [rc9 retained-identity guidance](NODE_RC9_UPGRADE.md) still applies to older
installs, including separate consent for marker and known legacy price repair.

rc11 raises `STATE_GENERATION` to `bitsov-state-v1:2` before opening SQLite/LDK
(on unlock for `--remote-unlock`). After that, rc9 refuses the directory with
`state_generation_newer`; roll forward. A stopped rc9 copy is a rollback option
only before the first rc11 state opening. The embedded SQL set remains 001–028.
SCB restore now refuses even preview; the owner-console `move-home` command uses
live state and its journal blocks normal startup. The app does not invoke SCB
restore or move-home.

The first unlocked start creates `pairing/box-transport.key` and its signed
proof in `identity/identity.json`. Preserve both with the identity. Publication
requires a filesystem with hard links; FAT/exFAT is incompatible. New config
keys are optional but must not be added to an rc9 config before replacing rc9.

## Changes that matter to the app

- **Remote unlock over the box-static tunnel (#244, #247).** Opt-in
  `start --remote-unlock --local-owner-device` boots locked without a password
  source. Existing owner-approved devices use `GET /api/v1/node/lock`,
  `POST /api/v1/node/unlock/challenge` and `POST /api/v1/node/unlock` over pinned
  Noise. Locked nodes neither receive messages nor monitor channels. The app's
  box proof, device-signed unlock tuple and body fields match rc11. Enroll while
  unlocked and let the app pin the signed box key before relying on unlock.
  `--remote-unlock` conflicts with password flags; the bundled local ceremony
  continues to use `--password-fd` with `--local-owner-device` instead.
- **One-shot tickets and `hosted_by` (#252, #259, #266).**
  `pair-ticket --config <cfg> [--qr] [--ttl 24h]` creates a durable single-use
  `read+receive` ticket; replacement revokes the old code, including same-size,
  same-timestamp replacements. Initialized nodes need an unlocked rc11 start
  first; issuance is refused while locked. Keep ticket contents out of logs.
  The app accepts initialized-node v1 tickets, expiry, box proofs and the
  optional 1–64-character label. `hosted_by` is display metadata, not authority
  or `identity.hosted` custody. The app clears a consumed code from persistence.
  **Label-hardening gap:** rc11 rejects U+206A–U+206F and Unicode tag characters
  U+E0020–U+E007F; the app's `is_invisible_format` currently omits those ranges.
  Node-generated labels comply, but a modified unsigned ticket or stored label
  can display them. The app must not claim the same filter as rc11; aligning
  that display filter remains a separate fix.
- **Remote first run (#256): app support gap.** A positively empty box can
  accept a pre-bootstrap ticket, run two-phase setup over the tunnel, encrypt
  the seed and enroll an owner device. `create-pending` requires a
  `password_commitment`; remote `finalize` supplies the password and returns
  identity/box proofs. The node exits 75; the supervisor must restart it into
  locked mode. This app explicitly rejects identity-less tickets in
  `remote_access::validate_link` and implements only the local owner ceremony.
  Re-pinning does not enable remote first run. Initialize/enroll using an
  existing supported setup flow before importing an initialized-node ticket.
- **Hub-only channels while lockable (#257).** Throughout a
  `--remote-unlock` run, including after unlock, new inbound/outbound channels
  are restricted to `[lightning.liquidity] providers`. Other opens return
  `HUB_ONLY_WHILE_LOCKABLE` (HTTP 403, `retry_allowed: false`); existing channels
  are not closed. With no providers or a non-LDK backend, all new opens refuse.
  LSPS2 service mode cannot start with the flag. App funding/onboarding cannot
  assume an arbitrary peer can open a channel on a lockable remote node; operator
  provider configuration remains necessary. Ordinary bundled starts are unchanged.
- **Home `to_self_delay`: requested default conflicts with this source.** At
  `834968b`, `our_to_self_delay_blocks` is optional, accepts 144–2016, and
  omission retains **144**, not 2016. `NodeConfig::for_tier` sets `None` and the
  home-node runbook suggests an explicit 288. **2016 is the maximum supported
  value, not the home default in this release.** The app writes no override;
  it inherits 144. An explicit value affects new channels only and peers may
  refuse it. Do not claim 2016 or active watchtower protection: rc11 tower
  support is optional local staging, without transport or acknowledgments.
- **DoS cookie edge (#250).** `cookie_mode` defaults to `adaptive`; `[dos_edge]`
  bounds unpaid peer connections and handshakes before DH, with per-IP and
  IPv6-/64 budgets (no IPv4-/24 aggregation). Under load, peers must answer
  `BSc1` cookies or cannot connect. This is the node's mesh peer doorway, not
  the separate app remote-access tunnel, which retains its own handshake
  limiter/refusal format. The app's bootstrap config omits these keys and
  inherits the new defaults. Its drift guard now checks the exact new limits,
  plus empty `[node]` and `[tower.clients]`, rather than expecting rc9 defaults.
- **1-sat admission floor (#245, #248, #253, #259).** Every paid admission is
  at least 1000 msat, including discounts, old quotes and owner overrides.
  Advertised and first-contact prices include the floor and any higher
  `min_admission_cost_msat`; zero chat prices no longer imply free admission.
  App sends remain node-quoted and budget/approval gated. Retained sub-sat
  ceilings may now refuse; refresh quotes and request consent rather than
  silently raising a cap. The legacy web-price repair is separate.

## Source contract review

Paths below are relative to the node repository at the exact pinned commit;
this is source evidence, not a live-node acceptance result.

| App assumption | rc11 evidence / result |
|---|---|
| `init --tier full --non-interactive --dir`; `start --config`; descriptor password and local owner flags; `repair mark-initialized --config --confirm` | `crates/konsensus-node/src/cli.rs`: switches retained. App local ceremony stays opt-in on macOS with Cargo feature and runtime environment gates. |
| Bootstrap state, create-pending, finalize and cancellation; local finalize has ceremony id, backup words and optional device | `crates/konsensus-api/src/bootstrap.rs`: local shapes/routes retained; remote first run has separate tunnel-only bodies. Additional response proof fields are compatible with app deserialization. |
| Local `/pair/request`, `/pair/confirm`, `/pair/challenge`, `/pair/token` and old-node-only 404 fallback | `crates/konsensus-api/src/handlers/pairing_routes.rs` and `pairing.rs`: existing request/token ceremony retained; no new fallback needed. |
| Full-tier onboarding, `funding_amount_sats`, `funding-seen`, funding-address and balance reads | `crates/konsensus-api/src/handlers/onboarding.rs`, `handlers/payments.rs`, and `crates/konsensus-node/src/onboarding/funding_poll.rs`: fields and step retained. Lockable channel policy above can still refuse auto-channel opens. |
| Initialized-node pairing links and Noise auth replies | `crates/konsensus-api/src/remote_access.rs`: v1 fields, proof domains and auth response agree with app `remote_access.rs`; pre-bootstrap ticket incompatibility is explicit above. |
| Box proof and unlock authority | `crates/konsensus-api/src/locked.rs`, `locked_body.rs`: `bitsov-node-unlock-v1` tuple matches app `home_node.rs`; body is challenge, key_id, signature, password. |
| Omitted bootstrap config defaults | `crates/konsensus-node/src/config.rs`, `crates/konsensus-message/src/transport/{cookie,edge}.rs`, `crates/konsensus-lightning/src/tower/mod.rs`: updated reviewed values in `local_owner/config_tests.rs`. |

Primary references: [rc11 upgrading](https://github.com/MindLink-ApS/BitSov-bitsov/blob/834968b955eaa3d402b87cd0d6835456473115df/docs/UPGRADING.md),
[home-node runbook](https://github.com/MindLink-ApS/BitSov-bitsov/blob/834968b955eaa3d402b87cd0d6835456473115df/docs/operations/home-node.md),
[node config source](https://github.com/MindLink-ApS/BitSov-bitsov/blob/834968b955eaa3d402b87cd0d6835456473115df/crates/konsensus-node/src/config.rs),
[release assets](https://github.com/MindLink-ApS/BitSov-bitsov/releases/tag/v0.3.0-rc11).

## Expected release bytes

All five entries below match the downloaded, signature-verified release manifest.
Only the Darwin arm64 binary was downloaded and hash-verified locally. Fetch and
package verification continue to require the pinned key and signed manifest;
there is no unsigned-manifest fallback.

| Asset | SHA-256 |
|---|---|
| bitsov-darwin-aarch64 | `4d6d88e613f90ccb828040826671f51f89a672f33b7524f141a342242c5349b1` |
| bitsov-darwin-x86_64 | `584c3e2853d92f7359b6bd84fa7ef0faff32c40559e386e4462915d7bd7d2bb5` |
| bitsov-linux-aarch64 | `bb939c96fe35ef1652f62d8a2cbc56bae6f2eaf5e1467f207c3805f1600079f1` |
| bitsov-linux-x86_64 | `16b7599fa74608318dfa0043bbf26bf88ca7229782c51b09c281b4f6453232e8` |
| bitsov-windows-x86_64 | `0c9a6e14bb387be833dcfac4eca788c1f8499eaf38d3daf20c7f45979092ce1c` |

## Validation and remaining acceptance

Local results (2026-10-07):

- `npx vitest run`: 66 files, 1053 tests passed.
- `cargo test --offline --locked --manifest-path src-tauri/Cargo.toml --test android_device_key_contract --test android_pairing_contract`: 19 text-only tests passed.
- `cargo check --offline --locked --manifest-path src-tauri/Cargo.toml --all-targets`: passed.
- `bash scripts/cs2-local-smoke.sh`: passed (static bindings).
- `bash scripts/test-fetch-verify.sh`: 7 signature cases passed.
- `python3 scripts/test-verify-sidecars.py`: 11 checksum cases passed.
- `bash scripts/test-check-mac-bundle.sh`: 19 static bundle cases passed.
- `bash scripts/fetch-node-sidecar.sh` and `--verify-only`: pinned signature
  and Darwin arm64 bytes passed; neither mode executes the sidecar.

The first Cargo attempt lacked the bundled file; it passed after verified
fetch. Vitest initially lacked dependencies/network; it passed using a copied
local dependency tree with an identical package lock. GPG fixture generation
required an unsandboxed retry for temporary agent sockets. No app, node, runtime
Rust test suite, CS-1 smoke or packaging build was run.

Sidecar CI must still execute the config drift and real local owner lifecycle
checks and CS-1 durable identity smoke against verified rc11. Mac Package CI
must fetch, re-verify before bundling and compare bundle bytes. Real retained
state upgrade, authenticated live reads, remote unlock and signed/hardened
Keychain/biometric acceptance remain separate gates. No funded migration or
runtime compatibility is claimed from this source review. App publication stays
human-only. Historical rc7/rc9 fixtures and upgrade notes retain their labels.
