# Onboarding + app pairing (F1)

**Less exposure, not solved local security.** That sentence is the claim
discipline for this feature, taken verbatim from the genome's
`docs/security/pairing.md` (BitSov-bitsov `56c0ee0`, PR #77). Nothing here, in
the app copy, or in release notes may be quoted as saying more.

## Status: mock-verified only

The app pins genome `v0.3.0-rc7` (`958e399`). #77 is **not in any tag**, so the
sidecar this app bundles has no `/pair/*` routes. Everything below is verified
against `src-tauri/crates/mock-node` using #77's route shapes. It is not yet
verified against a real node.

| Behaviour | Mock-verified here | Needs a HUMAN genome tag + pin bump |
|---|---|---|
| Ceremony: request → read `0600` challenge → sign → confirm → token | yes | real-node run |
| Short code read from node stdout, matched against the challenge file | yes (mock stdout lines) | real sidecar stdout format |
| 10-minute tokens refreshed before expiry | yes | real JWT expiry |
| 404 on `/pair/request` → `/auth/local`, unchanged | yes (rc7-shaped mock) | — (this is today's product path) |
| Refusal / bad proof / revoked / unreachable → error, **no fallback** | yes | real error texts |
| Identity-free bootstrap detected (`/bootstrap/state`) | yes | real bootstrap router |
| First-run identity create/restore on a bootstrap node | **not implemented** | genome tag, then a follow-up ticket |

Bumping the pin means cutting a genome tag that contains #77, running
`scripts/fetch-node-sidecar.sh` against it, and re-running the CS-1/CS-2
smokes. That is a HUMAN step. This change does not do it.

## Flow

First run, as the onboarding screen shows it:

1. **Start node.** The host starts the bundled sidecar and waits for `/health`.
2. **Pair this app.**
   - The host loads the app's Ed25519 client key from
     `<app data dir>/app-client/client-ed25519.key`. On first run it creates
     the key: a hex seed, mode `0600`, in a `0700` directory. It refuses a key
     file that group or others can read.
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
   identity-free #77 node the step shows as waiting on a genome release. The
   app creates nothing there.
4. **Fund.** Unchanged (CS-2), behind the G6 local-trust gate.

After first run, the stored pairing is reused. Each start mints a token with
`/pair/challenge` + `/pair/token`, with no second ceremony. Before each call,
the host refreshes any paired token with less than 120 s left (tokens live
600 s). A 401 on a paired session refreshes through pairing again.

## Fallback and fail-closed

There is exactly one fallback rule. **A 404 on `POST /pair/request` means the
node has no pairing routes (the rc7 sidecar), and only then does the host use
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
- **Fallback:** the screen says the bundled node (rc7) predates pairing and
  that the app signs in with `/auth/local`. It does not show paired scopes in
  that case.

## What this does not buy

Any process running as the same OS user can read `client-ed25519.key` and the
node's `data_dir`. It can do everything this app can. Closing that gap needs
an OS keychain with a per-application ACL, or hardware-backed keys. Both are
out of scope, and nothing weaker stands in for them. The G6 local-trust
disclosure stays as written.

## Non-goals (this change)

Pin bump or sidecar fetch; spend elevation or `control.sock`; OS keychain or
Touch ID; identity create/restore over HTTP; packaging; assistant broker
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
