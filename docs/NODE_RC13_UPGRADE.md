# Bundled node rc13: upgrade from rc12

Historical release note. The current signed pin is described in [the fetch script](../scripts/fetch-node-sidecar.sh); runtime and packaging acceptance remain separate gates.

Historical rc13 pin (app #193). The current pin and its changes are documented
in [NODE_RC14_UPGRADE.md](NODE_RC14_UPGRADE.md).

The app pinned `MindLink-ApS/BitSov-bitsov@v0.3.0-rc13`, source commit
`d625e85a04886ac81f76f77a6ae41651dbb3e157`, replacing rc12
(`41b9e7811fe3ecdc89eab06ea3cf54d1a31661fd`, app #178 / `a20bf2c`).

The supplied release facts identify rc13 as **published and GPG-signed**.
The tag, commit, manifest hash and five binary hashes below are recorded from
that request. No network access, release download, independent node-source
review or release-signature verification was performed for this change.
The fetcher still requires the pinned release key's valid signature and matching
binary hashes, failing closed on unavailable or invalid assets. Recording these
hashes does not substitute for those checks or publish an app release.

## Retained identity and state

Stop cleanly after reconciling pending payments/channel operations. Replace only
the verified binary, retaining the same config, data directory, wallet, pairing
records and box-transport proof/key. Do not re-run init, delete markers, replace
passwords or restore stale Lightning state. Preserve `offline-heartbeat.json`
and `offline-channel-windows.json` with the node data.

The [rc12 upgrade guidance](NODE_RC12_UPGRADE.md) records the prior home-profile
delay policy and retained-state precautions; the [rc11 note](NODE_RC11_UPGRADE.md)
records older migration constraints. This pin does not establish rc13 state-format
or rollback compatibility. rc13 adds a copied-state fence: do not treat a copied
data directory as an independently usable live node or bypass a refusal by
removing state. Retained-state acceptance against the verified binary is pending.

## Changes since rc12

These are the supplied node release changes and their relevance to the app.
This pin updates release selection and documentation; it does not implement the
new app flows or establish their runtime compatibility.

| Node addition | App relevance and limit |
|---|---|
| Channel caps and hub-only policy, with owner status fields | Owner clients can receive these policy fields. This change adds no controls or status UI for them and does not claim particular cap values. |
| `--home` and systemd support | Adds node deployment support for home operation. This pin does not change the Mac supervisor's launch flags or install a systemd service. |
| Signed endpoint lists: PairLink v2, `--legacy` v1 | Changes the pairing material available from the node. This pin does not add v2 parsing or prove existing app compatibility; `--legacy` selects v1 at the node. |
| Claim code and four-word SAS enrolment, `sas_version: 1` | Adds a node enrolment flow with an explicit SAS version. This pin does not implement claim-code entry, SAS comparison or approval UI. |
| LAN box setup page with box approval | Supports node setup over the LAN with box approval. The page's existence is not app first-run acceptance or permission to skip approval. |
| Identity-signed live transport pin in finalize / locked auth reply | Provides a node identity signature over the live transport pin in those replies. Merely receiving that data does not establish app verification or persistence of the pin. |
| Grant payee allowlist and dedupe | Adds node-side grant restrictions and deduplication. This pin does not add app grant controls or claim broader payment guarantees. |
| Copied-state fence | Adds a node-side guard for copied state. Its presence does not make stale Lightning restores safe or establish rollback support. |

## App compatibility and remote first run

**Remote first run is implemented on main (app #192 + node rc13).** Runtime
acceptance on real hardware (Touch ID + a fresh Pi) is still pending. PairLink
v2, claim-code / SAS enrolment, box approval and identity-signed live transport
pin handling land with that app integration; they still need their own
acceptance checks.

The local owner ceremony remains opt-in through the existing Cargo feature and
runtime setting; this change does not alter its authority or retained-identity
consent gates. The `FUNDING_SEEN` constant remains `funding-seen`; only its pinned
contract reference changes. Existing mocks and source guards are evidence for
app behavior, not proof of rc13 wire compatibility.

The rc12 note's enrolment DTO/route review and compatibility gaps describe that
specific source revision. They have not been re-reviewed against rc13 here.
No remote Touch ID, contact approval, first-run, live tunnel or signed/hardened
Mac acceptance is claimed by this pin.

## Config drift guard

The app bootstrap config and its explicit intentional-difference list are
unchanged. No claim is made that rc13 has identical serialized init defaults:
node source and release bytes were not inspected here. Sidecar CI must run the
existing full-tier `init` drift guard and create/finalize/restart lifecycle
against the verified rc13 binary. Any mismatch needs review against the actual
node defaults; do not broadly ignore fields to make the check pass.

## Expected release bytes

Required signer, unchanged:
`B299274C200301714DC6F51A7C2D6F8AC842EF6E`.

SHA-256 of the supplied `SHA256SUMS` manifest:
`0fe4b6c87a8cc9ab30a905ff70eb4599c1d3b738b866141ce333bad967e5b978`.

| Asset | SHA-256 |
|---|---|
| bitsov-darwin-aarch64 | `1cdd95ef1519dee2019f45774e424aa3361594dfe4972e93674d9f898126be5e` |
| bitsov-darwin-x86_64 | `8f9dd40e57ad03311647835f64bcddf311fed358a7d4387aebe7875ff3495c7a` |
| bitsov-linux-aarch64 | `65f66bed28311d66317bb94edca37f2b7c623679a6e217c31c06206ca8d24c67` |
| bitsov-linux-x86_64 | `143678b9b55d066324eb638454fa3d56fbe4f2b8aa0c18d67408520ca2159a11` |
| bitsov-windows-x86_64 | `d638b93b8c4701fe6d657c607f73de29d4170da628746a8a924185662eb953fa` |

These supplied values do not replace the fetcher's fail-closed signature and
binary-hash checks. The release signature and actual release bytes were not
verified locally.

## Validation and remaining acceptance

Local results (2026-10-08), with no release downloads:

- `bash scripts/test-fetch-verify.sh`: 7/7 passed.
- `python3 scripts/test-verify-sidecars.py`: 11 tests passed.
- `python3 scripts/test-package-mac.py`: 7 tests passed, using stubbed build and packaging commands.
- `bash scripts/test-check-mac-bundle.sh`: 19 cases passed.
- `bash scripts/test-authority-source.sh`: 7 cases passed.
- `bash scripts/cs2-local-smoke.sh`: passed (static bindings).
- `BITSOV_TEST_APP=/tmp/bitsov-rc13-no-built-app bash scripts/test-app-lifecycle.sh`: 9 source checks passed; real bundle lifecycle skipped.
- `python3 scripts/test_two_node_harness.py`: 13 tests passed.
- `python3 scripts/test_two_node_network.py SocketParsingTests`: 4 tests passed; live socket tests were not run.
- `UIE2E_A_API=45131 UIE2E_UI_PORT=45132 python3 scripts/test_ui_e2e_harness.py`: 15 tests passed; explicit test ports avoid port discovery, and no service is started.
- Shell syntax checks for changed scripts and `git diff --check`: passed.

The sandbox initially blocked GnuPG agent IPC and UI-harness socket/process
inspection. The three GPG-dependent suites and the UI-harness suite passed when
rerun outside that sandbox; the UI tests used the explicit ports above. Local
GPG tests use throwaway fixture keys and payloads, not the release key or rc13
bytes. The Cargo-based release guard was not run; this validation covers offline
script fixtures and source checks, not a Rust build.

Sidecar CI must fetch and verify rc13, then run config drift, local owner
lifecycle and durable-identity CS-1 smoke checks. Mac Package CI must re-verify
before bundling and compare bundle bytes. Retained-state behavior, remote
enrolment, transport pin verification, remote unlock and signed/hardened Mac
biometric acceptance remain separate checks. Remote first run is implemented on
main (app #192 + node rc13); runtime acceptance on real hardware (Touch ID + a
fresh Pi) is still pending. No release fetch, real node execution, package build
or live-network smoke is part of this offline pin change.
