# Draft bundled node rc19.2: upgrade from rc14

This prepares `MindLink-ApS/BitSov-bitsov@v0.3.0-rc19.2`, replacing main's
rc14 pin (`d55a88e439fd80dae89e263bef8378fd22c9a103`, app #199).
It supersedes the stale rc18 proposal [app #266](https://github.com/MindLink-ApS/bitsov-app/pull/266),
which was not merged. This branch is for a **draft PR only**.

**rc19.2 is tagged; signing is in progress.** Tag `v0.3.0-rc19.2` points to
BitSov-bitsov commit `04fe65e03aad949ade90c10c8e8ccf36daf2b0f6`. Signed
manifest and binary hashes remain pending; no rc19.2 release binary has been
fetched, verified, launched or packaged for this app pin.

rc19.1 was superseded unsigned and will never be signed because its Darwin
binaries were not reproducible. rc19.2 has the same node runtime code as rc19,
with release-tooling fixes [#355](https://github.com/MindLink-ApS/BitSov-bitsov/pull/355),
[#358](https://github.com/MindLink-ApS/BitSov-bitsov/pull/358) and
[#359](https://github.com/MindLink-ApS/BitSov-bitsov/pull/359). Node upgrade
guidance is unchanged from **rc18 → rc19**; upgrading the app's rc14 pin still
requires every intervening release's migration and rollback precautions below.

The prepared scope below comes from the
[node changelog](https://github.com/MindLink-ApS/BitSov-bitsov/blob/04fe65e03aad949ade90c10c8e8ccf36daf2b0f6/CHANGELOG.md)
and [upgrade guidance](https://github.com/MindLink-ApS/BitSov-bitsov/blob/04fe65e03aad949ade90c10c8e8ccf36daf2b0f6/docs/UPGRADING.md).
Reconcile the signed manifest and published assets against this tag before
enabling the pin. #347 and #350 are part of rc19's runtime scope; this draft
does not establish signed-binary or hardware acceptance.

## Changes app users should expect since rc14

| Change | App impact |
|---|---|
| rc15–rc18 owner-device enrollment, spending/first-contact approvals and independent breaker reset | Existing app capability checks expose these only when the node advertises readiness. A paused pairing cannot reset itself. |
| Operation abandonment (migration 029) and per-approval envelope IDs (pairing v8) | Existing app feature detection remains. Abandonment is not cancellation or a refund of dispatched payment. Existing envelopes without IDs require renewed approval to acquire one. |
| Lightning 0.2.7 state and stricter startup | Preserve current wallet/LDK state; never delete it to make a startup error disappear. |
| Network-aware funding address, live owner-console peer admission, anchor-only inbound channels | Signet funding is labelled correctly. Reserve/trust waivers remain explicit provider policy; this pin adds no automatic liquidity or peer-admission UI. |
| Stable LDK channel IDs and idempotent opens (#330/#332/#334; migration 030) | Use decimal-string `user_channel_id` for stable LDK identity; other backends retain native IDs. Retry the same operation ID and parameters, reconcile uncertain outcomes, and never invent a new ID merely because a request disconnected. |
| Call refusals [#347](https://github.com/MindLink-ApS/BitSov-bitsov/pull/347) | Before an operation is created, quoted or paid, `call_id_used`, `call_busy`, `call_signal_in_flight`, `call_signal_invalid` and `call_not_live` return HTTP 400 with `code: "not_dispatched"` and the specific `reason`. A retry of an existing operation does **not** promise non-dispatch: an earlier attempt may have paid. Do not treat every HTTP 400 as safe to resend. |
| ONB5 on LDK [#350](https://github.com/MindLink-ApS/BitSov-bitsov/pull/350), fixing #349 | Channel opens use an LDK-compatible six-block funding priority, checked quote and hard total-fee cap from the existing buffer. Non-LDK behavior is unchanged. Channels remain private with no balance push. **Starter hub / automatic onboarding opens remain off by default**; this pin does not enable them. |

Remote first run, local-owner opt-in and retained-identity consent remain.
Mock/source tests do not establish signed-binary or hardware acceptance.

## Security and startup compatibility

- **H1 (#339):** Host/Origin validation protects local token issuance and
  local-only reads/WebSocket admission against DNS rebinding. Native clients
  without Origin remain supported. Keep the app's loopback endpoint; do not
  bypass a refusal with permissive CORS or arbitrary hostnames.
- **H2 (#340), breaking argv-secret change:** passwords, mnemonic phrases,
  `--encrypt <password>` and nonempty BIP-39 `--passphrase` arguments refuse
  execution unless `--insecure-argv` is explicit; even that opt-in warns.
  Migrate launchers to descriptors, protected files or prompts, using
  `--password-fd`, `--password-file` or `--passphrase-fd` as applicable.
  The app's owner ceremony already passes its Keychain password by descriptor;
  do not add `--insecure-argv` to the app launcher.
- **H3 (#341):** artifact signing requires a rebuild of the exact tag for the
  signing host using the pinned recipe and hash comparison with CI bytes.
  Mismatch evidence is retained; host break-glass requires an explicit reason,
  and non-host targets require individual waivers. A signature alone does not
  claim every target was independently rebuilt.
- **[#337](https://github.com/MindLink-ApS/BitSov-bitsov/pull/337):** the directory
  containing `--config` must be dedicated to the node, owned by its user and
  forced to **0700** before binding; the control socket is **0600**. Startup
  refuses if this cannot be enforced. Do not put the config directly in `$HOME`
  or a shared directory. Check retained-directory and container-volume ownership.
  CORS drops wildcard/null origins, traces omit query tokens, WebSocket
  subprotocol tokens take precedence, and amount/invite/signature parsers tighten.
- **[#342](https://github.com/MindLink-ApS/BitSov-bitsov/pull/342):** upstream
  signing validates the anchored primary-key VALIDSIG field and the exact
  asset set. Its signed manifest covers 15 entries (five binaries plus their
  checksum files and SBOMs). LND settled amounts must match the invoice;
  missing/mismatched amounts and arithmetic overflow fail closed without
  incorrectly releasing reserved budget. This app change preserves its
  existing GPG acceptance predicate and adds enforced binary checksum pins.
- Dependency hardening includes modern WebPKI/root fixes (#335) and the
  additional shipped-dependency updates recorded in Unreleased (#338).
  Documented legacy TLS exceptions remain; this is not a claim of zero debt.

## Retained state and rollback

Follow every skipped-release procedure in the node's upgrade guide. Keep the
same identity, config, wallet, pairing store and latest offline-safety files.
Do not rerun init, replace credentials, strip pairing fields or restore stale
Lightning snapshots. Pairing v8 is forward-only (rc16 and earlier cannot read
it); migration 029 adds abandonment and 030 adds channel-open operations.
After embedded LDK runs with the newer persisted fields, rc14 is not a safe
rollback. rc18 lacks migration-030 reconciliation. Prefer rolling forward;
reverting the app pin does not undo data migrations or make replay safe.

## Expected SHA256SUMS entries — intentionally incomplete

Required signer remains `B299274C200301714DC6F51A7C2D6F8AC842EF6E`.
Tag: `v0.3.0-rc19.2`; source: `04fe65e03aad949ade90c10c8e8ccf36daf2b0f6`.
Signed-release verification and manifest hash: **PENDING_SIGNED_RC19_2_TAG**.

| Asset | SHA-256 |
|---|---|
| bitsov-darwin-aarch64 | `PLACEHOLDER_SHA256_FROM_SIGNED_RC19_2` |
| bitsov-darwin-x86_64 | `PLACEHOLDER_SHA256_FROM_SIGNED_RC19_2` |
| bitsov-linux-aarch64 | `PLACEHOLDER_SHA256_FROM_SIGNED_RC19_2` |
| bitsov-linux-x86_64 | `PLACEHOLDER_SHA256_FROM_SIGNED_RC19_2` |
| bitsov-windows-x86_64 | `PLACEHOLDER_SHA256_FROM_SIGNED_RC19_2` |

`scripts/fetch-node-sidecar.sh` enforces these five pins. Both fetch and
`--verify-only` return exit 1 with `REFUSED: checksum pin incomplete` before
network access while any entry is absent, duplicated, malformed or still a
placeholder. Once all are valid, signed-manifest authentication remains
mandatory and each fetched/installed binary must match both the signed entry
and its recorded pin. No environment flag bypasses this gate.

The network-dependent Sidecar CI job expects this precise refusal while the
placeholders remain and skips real-binary checks. It resumes those checks when
all placeholders are replaced; any other error still fails. Mac packaging
remains blocked. Offline fixture suites substitute test-key/test-payload pins
only in temporary script copies, preserving coverage of signature, byte and
packaging checks without accepting production placeholders.

## Before promoting this draft

1. Verify the final signed rc19.2 tag and source commit, scope, published assets,
   signer and signed 15-entry manifest. Record rebuild/waiver evidence accurately.
2. Replace all five script placeholders and the table above with the exact
   binary entries from authenticated `SHA256SUMS`; record the source SHA and
   manifest hash throughout current-pin documentation. Do not copy rc18 hashes.
3. Fetch and re-verify every supported target. Run the strict full-tier init
   drift guard and owner create/finalize/restart test against verified rc19.2.
   No config-default allowances are added by this draft; new drift must be reviewed.
4. Run durable-identity CS1, CS2, retained-state/0700 checks, Host/Origin,
   descriptor-password and call-retry acceptance. Exercise ONB5 only on an
   explicitly opted-in test hub; preserve the off-by-default policy.
5. Inspect Mac Package/bundled-byte verification and signed/hardened hardware
   acceptance (Touch ID + fresh Pi). Keep this a draft until release and runtime
   gates are satisfied. Publishing/signing is outside this app change.

## Local validation (2026-10-21)

Merged `origin/main` at `606dae1` with normal merge commit `4568e02`;
there were no conflicts. Main's app behavior is preserved.

- `python3 scripts/test-verify-sidecars.py`: 16 tests passed.
- `bash scripts/test-check-mac-bundle.sh`: 19 cases passed.
- `TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo test --locked --offline
  --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=1`: 1,041 app
  tests and 12 FFI tests passed; one existing Touch ID test ignored.
- `tsc --noEmit`, `npm test` (100 files / 1,798 tests), `npm run build` and
  `npm run authority`: passed.
- The actual CI placeholder step passed in both fetch and verify modes and
  emitted `ready=false`. All five production pins remain placeholders.
- CS2 source smoke, changed shell syntax, renamed upgrade-note links and
  `git diff --check`: passed. Final diff review found no issues.

The sandbox blocked temporary GPG-agent IPC and Rust loopback/process fixtures;
these headless suites passed outside it. Dependencies were installed from the
local npm cache with the committed lockfile. Existing Solid test warnings and
Vite's large-chunk advisory remain.

No `cargo fmt`, window-opening binaries, release download, signed-binary drift
guard, full Tauri bundle build or hardware acceptance was performed. These
source and fixture gates do not establish rc19.2 runtime acceptance.
