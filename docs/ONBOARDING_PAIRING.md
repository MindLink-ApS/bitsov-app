# Onboarding + app pairing (F1)

**Less exposure, not solved local security.** That sentence is the claim
discipline for this feature, taken verbatim from the genome's
`docs/security/pairing.md` (BitSov-bitsov `56c0ee0`, PR #77). Nothing here, in
the app copy, or in release notes may be quoted as saying more.

## Status: rc19.2 pinned; release-binary CI pending

The app pins `v0.3.0-rc19.2` (`04fe65e03aad949ade90c10c8e8ccf36daf2b0f6`), which includes pairing and local owner
bootstrap. Mock tests cover pairing, token refresh, restore refusal, explicit
marker repair followed by separate price consent, and owner ceremony UI.
The old rc7 404 fallback remains tested. rc19.2 is signed and published. All five
binary pins are recorded from its authenticated manifest; fetch and pre-bundle
verification require both the signed entry and the recorded pin to match.
Config drift, owner lifecycle and CS-1 remain CI checks; a signed/hardened Mac
interactive run remains separate
acceptance. Remote first run is implemented on main (app #192 + node rc13);
runtime acceptance on real hardware (Touch ID + a fresh Pi) is still pending.
See [upgrade checks](NODE_RC19_2_UPGRADE.md) and [local owner ceremony](LOCAL_OWNER_CEREMONY.md).

## Node choices

This Mac is the default. Receiving requires the Mac to stay awake with BitSov
open. A node on the user's own home computer is under the collapsed Advanced
disclosure. Remote connections are shown as home/network connections; their
custody label remains **Hosted custody**, because the app cannot verify where
that node's keys live or who has access.

The internal test-node card is off by default. To enable it at runtime, set
`localStorage.setItem('bitsov.test-nodes', '1')` in the main webview, then reload.
Remove that key and reload to hide it again. This flag changes UI visibility
only; it grants no node authority and does not change the default selection.

**Use this Mac instead** forgets the saved remote descriptor and takes
effect on the next app start. At that startup it clears the old remote pairing
record, preserving the client key, so local pairing can start normally. It does not delete an identity or revoke a device
at the remote node. The current connection and trust disclosure remain remote
until restart. The action is available in onboarding and the connected Node
panel. Local nodes show the device-approval off reason, when provided, but no
at-the-node Touch ID registration or CLI approval ceremony.

## Flow

First run, as the onboarding screen shows it:

1. **Start node.** The host starts the bundled sidecar and waits for `/health`.
2. **Pair this app.**
   - The host loads the app's Ed25519 client key from `<app data dir>/app-client/`.
     macOS uses Secure Enclave ciphertext in `client-ed25519.sealed`; Android
     uses its Keystore sealer. An older `client-ed25519.key` hex seed is migrated
     by writing and reopening a sealed copy, verifying the seed, and making the
     sealed file durable before wiping and deleting plaintext. Files are `0600`
     inside a `0700` directory; group/other access is refused. If macOS sealing
     is unavailable before migration, the app logs it and keeps the plaintext
     behavior. An existing sealed identity is never replaced on an open error:
     restore access on the original device, or clear storage and pair again.
   - `POST /api/v1/pair/request {client_name, client_pubkey}` →
     `{pair_id, expires_at, challenge_path}`.
   - The host reads the 32-byte challenge from `challenge_path`. It refuses a
     path outside `<data dir>/pairing/`, a file with the wrong name or length,
     and a file that group or others can read.
   - Tripwire: the host derives the short code from the challenge the same way
     the node does (keyed BLAKE3, `bitsov-pair-shortcode-v1`). It compares it
     with the `bitsov pairing code for "<pair_id>": XXXX-XXXX` line the node
     printed to stdout. If they differ, pairing stops and nothing is signed.
   - `POST /api/v1/pair/confirm {pair_id, signature}` with an Ed25519 signature
     over `pair_id || client_pubkey || challenge` → `{client_id, scopes}`. The
     host stores the pairing record (client id, public key, scopes; no
     secret) in `app-client/pairing.json` at `0600`.
   - `GET /api/v1/pair/challenge?client_id=` → `POST /api/v1/pair/token
     {client_id, challenge, signature}` → `{token, expires_at, scopes}`.
3. **Create or restore identity.** On an rc7 node, `konsensus init` already
   created the identity, and the existing restore form is unchanged. On an
   local identity-free node, the restore form is available after pairing.
   The host probes `/bootstrap/state`: a bootstrap response uses the paired
   bootstrap router; only a 404 selects the rc7 live fallback. Both routers
   use `/api/v1/identity/restore`. Probe failures do not send the phrase.
   After restart, the live identity must match the restore response before
   setup can continue. Creating a new identity over HTTP remains unavailable.
4. **Fund.** Unchanged (CS-2), behind the G6 local-trust gate.

After first run, the stored pairing is reused. Each start mints a token with
`/pair/challenge` + `/pair/token`, with no second ceremony. Before each call,
the host refreshes any paired token with less than 120 s left (tokens live
600 s). A 401 on a paired session refreshes through pairing again.

## Fallback and fail-closed

There is exactly one fallback rule. **A 404 on `POST /pair/request` means the
node has no pairing routes (for example an older rc7 node), and only then does the host use
`/auth/local`.** It then uses `/auth/local` exactly as before, and later 401s
re-mint there, as before.

Everything else is an error shown on the pairing step, with a retry button.
None of it is downgraded to `/auth/local`:

- `409` pairing closed (another client is paired and no window is open)
- `401` bad or expired proof
- `404` on `/pair/challenge` or `/pair/token` for a stored pairing (revoked)
- an unreachable node, or an unexpected response body
- a short-code mismatch
- a key file, challenge file or pairing record with the wrong mode

A paired session never re-mints via `/auth/local`, including on a 401. Retry
re-runs the ceremony from scratch in only one case: the node answered 404 for
the stored client, meaning it no longer knows it. That fresh ceremony is still
gated by the challenge file and the node's own pairing window.

## What the copy says, and why

- **Scopes:** paired means `read + receive`. On a bootstrap node it also
  includes `identity`, which #77 strips when the identity is committed.
- **Short code:** it is labelled "matches what your node printed" only when
  the host actually read it from the node's stdout and it matched. Otherwise
  the UI shows it as derived, for the user to compare. It is always described
  as a tripwire and never as what protects the pairing: in the sidecar
  deployment the app owns the node's stdout, so it can read the code by
  construction.
- **Product constraint** (pairing.md): a packaged sidecar app cannot spend and
  cannot replace a live identity. Spending needs the user's own node plus the
  owner CLI (`konsensus grant` over `<data_dir>/control.sock`). This change
  requests no elevation.
- **Fallback:** the screen says the connected older node has no pairing routes and
  that the app signs in with `/auth/local`. It does not show paired scopes in
  that case.

## What this does not buy

On macOS the sealed pairing identity is bound to that Mac's Secure Enclave;
copying its envelope and the login Keychain to another Mac does not unlock it.
This does not isolate the app from another process running as the same OS user
on the original Mac: startup unsealing needs no biometric approval, and the
seed exists in app memory while signing. The plaintext fallback and old backups
containing the plaintext seed retain their original exposure. Overwriting a
file cannot guarantee erasure of old flash blocks or backups. The node's
`data_dir` and the G6 local-trust disclosure remain separate boundaries.

## Compatibility with nodes after rc7

For an existing local data directory, the host recognizes only the node's
`identity_without_marker` and `identity_and_state_without_marker` startup
refusals. It waits for the failed start to finish, then shows the one-time
initialization consent screen. **No repair runs automatically.** “Not now”
leaves the node stopped. The main-window command requires explicit consent,
a pending refusal, and a stopped supervised local node; remote and externally
managed nodes are excluded.

On agreement, the same sidecar runs
`repair mark-initialized --config <the existing config> --confirm`, then the
app restarts. A retained 50 msat page price then triggers a separate consent
screen before changing only that value to 1000 msat (with a config backup).
Authentication resumes after successful startup. The node writes its marker;
the app never manufactures it. Failure stays visible for an explicit
retry. The successful marker removes the need for the prompt on later starts.
The screen advises keeping a backup because normal startup can apply newer
database migrations.

The rc19.2 pin uses the existing first-run `init` flow when owner opt-in is off.
With opt-in enabled, fresh installs use the two-phase owner ceremony; retained
plaintext identities use ordinary startup and never enter that ceremony.
Restore readiness applies when the managed node is already in bootstrap mode;
it does not turn an initialized live node back into bootstrap. A live node that
no longer exposes restore produces an explanatory error. Compatibility is
mock-verified in `post_rc7_tests.rs` and `post-rc7-readiness.test.tsx`; a real rc7
upgrade and new-release restore smoke remain release checks.

## Non-goals (this change)

Pin bump or sidecar fetch; granting spend or touching `control.sock` (the app only *asks*: see `docs/CONTROL_CENTER_ACT.md`); OS keychain or
Touch ID; identity creation over HTTP; packaging; assistant broker
changes.

## Isolation

- **Assistant window.** `pairing_status` and `pairing_retry` are privileged
  commands. They are listed in `build.rs`, allowed only in
  `capabilities/default.json` (main window), and each handler rejects any
  non-main window first. `real_acl_allows_main_and_denies_assistant` asserts
  that the sealed assistant window is denied both, by the ACL.
- **mock-node.** mock-node stays socket-free and serde-only, as the Jarvis
  sit-mock guard requires. Its `pairing` module is a pure state machine with
  injected crypto. The ephemeral loopback listener (`127.0.0.1:0`, asserted
  never `3141`) and the real Ed25519/BLAKE3 implementation live in
  `src-tauri/tests/support/`, which is test code only.

## Tests

- `src-tauri/tests/pairing.rs`: the full ceremony; the 404 fallback;
  409/401/revoked/unreachable with no fallback; the tripwire; the challenge
  path bound; refresh before expiry; key file `0600`/`0700` and too-open key
  refused; bootstrap detection; view states with no token leakage.
- `src-tauri/src/main.rs` `pairing_wiring_tests`: host auth wiring (paired,
  rc7 fallback, refusal leaves no token, `call_api` pre-expiry refresh, a
  paired 401 never reaching `/auth/local`, bootstrap).
- `src-tauri/crates/mock-node/tests/pairing.rs`: the mock's route shapes and
  state machine.
- `tests/onboarding-pairing.test.tsx`, `tests/app-pairing.test.tsx`: the step
  model and panel for pending/paired/failed/fallback/bootstrap, and the shell's
  retry wiring.
- First run to the assistant's first answer, on mock data:
  `src-tauri/tests/onboarding_assistant.rs` (host: pair, then read with the
  paired token) and `tests/onboarding-assistant-e2e.test.tsx` (window: steps
  through pending → paired, then the first answer with its freshness label).
  See `docs/ASSISTANT_LOCAL_BROKER.md` → Tests.

### Add another owner device (node #301)

In the main control-center window, open **Settings** (the gear button), then
the **Devices** tab. On an enrolled owner device connected to a home node, the
**Devices** panel at the top of that tab offers **Add a device**. Approve ticket
creation with Touch ID (biometrics on Android).
The screen shows a one-use QR/link valid for five minutes. Older nodes do not
show the action; an ordinary pairing cannot issue tickets or delegate ownership.

On a fresh install, choose the home-node path and scan or paste that ticket.
Review the node and choose **Use remote node**, then reopen the app as directed
by the existing remote-pairing flow. The **Add this device** panel appears in
the device-approvals onboarding step, and later under **Settings → Devices**
(also in **Settings → Node**). Open BitSov on the other owner device and choose
**Add a device → Show the code for a new device**. Enter that 18-character code
on the new device. The ticket does not replace that code. Device-key
creation and possession proofs use the existing hardware-backed approval path.
Place the devices together, compare all four words in order, and approve on the
existing owner device. If they differ, close the ticket and cancel enrollment
on the new device. Closing a ticket screen does not revoke an unconsumed ticket;
it expires at the node after five minutes.

Enrollment uses one pinned Noise transcript through SAS finalization. The owner
host validates and re-reads the exact SAS-bound v2 delegation before asking for
its signature. No legacy delegation fallback is used. Expiry, revocation and
single use remain node-enforced. An enrollment can last up to 15 minutes after
ticket consumption. If its initial reply is lost, the app cannot recover the
unknown operation id: wait for that request to expire before starting again.
Once a reply contains an operation id, the app saves it before validating the
remaining reply, so **Cancel pending setup** works even after validation fails.
Local expiry checks allow 30 seconds of clock skew; the node still enforces its
own deadlines.

The code sheet makes one host request when opened. The host verifies the
current pairing's enrolled owner key, then uses its existing bearer for
`GET /api/v1/owner/claim-code` on the owner-local API. It never sends this
request through the remote proxy or to a LAN address. The endpoint is
`Cache-Control: no-store`; only `open` contains `code`, `expires_at` (Unix
seconds), and `device_name`. The host validates the code and deadline and
discards the device label. `closed`, `claimed`, and `unavailable` contain no
code. The sheet shows groups of six characters and an expiry countdown. Its
response stays in memory only and is cleared on expiry, dismissal, disposal,
or arrival after dismissal. Node response bodies are never shown as errors
or logged by this flow.

TODO(#346 A2): finish the node/app handoff for terminal-free initial enrollment.
The node only exposes a code while a claim-bound enrollment is already pending,
but the current SAS v1 app starts enrollment after code entry. The node endpoint
also deliberately rejects the remote tunnel, so an owner iPhone or a Mac paired
through that tunnel needs a separately authorized owner-local access path.
The app refuses that route before any proxy request; adding it to the remote
router is not a workaround. First-owner setup without an existing owner device
also remains outside this code-display slice. Ship a node release containing
the endpoint before relying on it with the bundled node.

Keep another owner device, including a Mac or another non-phone device.
Enrollment does not transfer the node's unlock password. This flow uses two
main-window-only host commands; assistant windows cannot issue or approve tickets.
