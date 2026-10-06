# Local owner ceremony (development only)

The rc7 pin does not contain node #237. `local-owner-ceremony` is a non-default
Cargo feature, additionally requiring `BITSOV_LOCAL_OWNER_CEREMONY=1`. While
`BUNDLED_NODE_SUPPORTS_LOCAL_OWNER` is false it only runs with the debug `dev-node`
sidecar override. Release/bundled rc7, external nodes and remote nodes retain their
existing behavior. Do not enable bundled support until a release containing #237
is pinned and its lifecycle has been tested with a signed, hardened Mac bundle.

Implementation plan:
1. Add a native, narrowly scoped Keychain adapter and descriptor-only launch.
   Store 32 random bytes (base64) before spawning; never replace a missing password
   for an existing installation. No password in arguments, environment or files.
2. Add host-only two-phase API commands, serialized across create/cancel/finalize.
   Retain public ceremony metadata, not the phrase; sign the pending identity's
   registration tuple with the existing Secure Enclave code. Save the public key
   record before finalize so a lost response can be reconciled after relaunch.
3. Add a dedicated phrase/backup screen. Clear phrase references and DOM before
   asking for words; clear words on submit/cancel/unmount. No clipboard or storage.
4. Mock node responses and exercise one-time display, cancel failures, orphaned
   pending state, refusals, uncertain finalize and the default-off boundary. Run
   TypeScript, Vitest and Rust tests with only externalBin removed from bundle
   configuration; review and commit locally.

Recovery rules: a lost create response is cancelled using the same-client
`pending/current` alias. Cancellation never claims success without a node reply.
After a lost finalize response, reconcile by explicit restart of the owned child
and live identity/device binding, never by resubmitting finalize automatically.
Partial commits remain node refusals and use the existing explicit repair screen.
The app never deletes a Keychain password on cancel or invents missing authority.

Security limits: first-run local trust is the root of enrollment, and the node
cannot attest Enclave hardware. Unsigned development builds do not provide a
strong application Keychain ACL. Rust-owned secret buffers are zeroized; WebView
strings/IPC copies are cleared and released but cannot be reliably zeroized by
JavaScript. The phrase remains visible to screenshots/accessibility while shown.

Development activation uses a node binary built with #237 and a fresh private
`BITSOV_DEV_DATA_DIR`, following [the dev-sidecar setup](DEV_NODE_FROM_MAIN.md):
`BITSOV_LOCAL_OWNER_CEREMONY=1`, Cargo features `dev-node,local-owner-ceremony`, and
`src-tauri/tauri.dev-node.conf.json`. The normal dev launcher supplies only
`dev-node`; it does not turn on this ceremony. Enabling the runtime variable alone
has no effect. No release pin or release configuration changes in this patch.

The node determines emptiness and authority. Existing installations with no
matching Keychain item stop with an explanation, never a replacement password.
Cancel does not delete that item. Orphan recovery uses `pending/current`; a screen
that received its handle cancels that specific ceremony, preventing a late reply
from cancelling a newer screen's attempt. Failed backup checks can be cancelled
and restarted with a fresh phrase. Unknown finalize outcomes are never replayed.
The public attempt receipt and device record are synced before submission.
A startup missing device enrollment shows a persistent console-recovery warning
while retaining the node's actual read/receive access.

Validation covers mocked loopback responses, UI lifecycle and cleanup, refusal
codes, orphan/lost responses, scope-safe cancellation, unchanged default arguments,
Keychain adapter failures and missing-item preservation, and pipe EOF delivery.
Real signed-bundle Keychain ACL and interactive Touch ID lifecycle remain release
acceptance checks; automated tests do not claim to prove those OS protections.

Owner startup persists the Keychain password **before** atomically writing a
bootstrap-only `konsensus.toml`, then passes the password through stdin. Node
#237 has no config-only CLI. The app therefore mirrors
`NodeConfig::default_for_tier(Full)` from `cli/owner.rs::prepare_start`: it writes
the required sections, absolute identity/storage/backup/audit paths, full-tier
network and LDK settings, fresh Esplora primary/fallback providers, and payment
verification. Remaining values use the node's matching serde defaults. No identity,
marker or database is created. Keep these defaults aligned when updating the pin.
Existing config is never overwritten, and a nonempty directory missing config is
refused. Finalize's node-owned alignment changes the mnemonic path to `.enc`.

Contract §5 A is exercised in a host subprocess with a separate HTTP/descriptor
fixture process. It captures node stdout/stderr and host stdout/stderr, exercises
host create/finalize and durable receipts, and scans every generated regular file.
The forbidden set contains the password (byte substring) and **every** phrase word
(alphabetic tokens, so `act` inside `active` is not a leak). A scanner control
checks each canary, and synthetic secret-bearing diagnostics exercise the host's
owner-mode log suppression. Failures never dump captured secret-bearing output.

An additional real-node subprocess test discovers
`../pa-ownerB/{target-review-node,target}/debug/konsensus`, or uses an explicit
`BITSOV_OWNER_TEST_BINARY`. It skips with a diagnostic only when no binary was
configured or found; an explicit missing/broken binary fails. It uses the app's
bootstrap config, descriptor handoff, pairing, create and finalize code; verifies
`.enc` alignment and the marker; restarts with `--local-owner-device`; then checks
the live identity and enabled device listing. It scans the same surfaces for the
password and complete random phrase before finalize and after restart. Individual
random words can coincide with public config/log tokens such as `network` or
`true`; strict every-word coverage belongs to the deterministic host fixture.
Only the live restart substitutes mock chain
and wallet backends and an ephemeral P2P port to avoid external services. Its
software P-256 enrollment proof does not test Touch ID or Keychain ACLs.

Run with the ceremony and development features on, preserving the app identifier
and capabilities and overriding only the sidecar bundle list:

```sh
npx tsc --noEmit
npm test
TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo test --manifest-path src-tauri/Cargo.toml --features dev-node,local-owner-ceremony
```
