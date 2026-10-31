# API_READINESS — the node contract CS-1..CS-6 build against

**Pinned protocol:** [the fetch script](../scripts/fetch-node-sidecar.sh) defines
the release tag, release-key fingerprint and all five binary checksum pins for
`MindLink-ApS/BitSov-bitsov`. Fetch and pre-bundle verification enforce both the
signature and the recorded binary hashes.
The route inventory below is historical source evidence, not acceptance of the pinned binary.
Live CS-1 and other runtime/package acceptance remain CI/operator checks.

The pinned release includes pairing, scoped tokens, freshness headers and the opt-in local owner
ceremony. The app retains rc7 fallback and fixture coverage. The table below is
the historical CS route inventory, with the changed auth/restore boundaries
called out; route presence does not grant spending or live identity authority.
See [the historical upgrade note](NODE_RC19_2_UPGRADE.md) and
[the current release checklist](RELEASE_CHECKLIST.md) for the supplied
node changes and app integration limits. The rc12 enrolment source review remains
[historical evidence](NODE_RC12_UPGRADE.md), not a wire-contract review of the pinned release.
rc13 introduced claim-code / four-word SAS enrolment (`sas_version: 1`) and box approval.
Remote first run is implemented on main (app #192 + node rc13); runtime
acceptance on real hardware (Touch ID + a fresh Pi) is still pending. The
existing app does not display the node's `offline_safety` diagnostics.

Since rc14, owner-device approvals and independent breaker reset, operation
abandonment, pairing v8 envelope IDs and channel-open operations were added.
The pinned release also targets explicit `not_dispatched` call refusals before payment and
ONB5 LDK dispatch compatibility. See the upgrade note for capability gates,
retry semantics, security changes and forward-only state.

Base URL: `http://127.0.0.1:$PORT/api/v1` (loopback only — Gate G2). Auth: `Authorization: Bearer <jwt>`
on REST; `bitsov.v1` + `bitsov.jwt.<token>` subprotocols on `/ws`.

## MVP contract — "fund your node and start talking" (current pin; rc7 compatibility retained)
| MVP step | Method | Path | Purpose | Static |
|---|---|---|---|---|
| Boot/auth | POST | `/pair/request`, `/pair/confirm`, `/pair/token` | app pairing; `/auth/local` is only the rc7 404 fallback (sidecar smoke may use read/receive) | ✅ |
| Identity | GET | `/identity` | node_id + x25519/secp256k1 pubkeys | ✅ |
| Recovery | POST | `/identity/verify-mnemonic`, `/identity/restore` | verify needs identity scope; restore exists only on bootstrap in the pinned release | ✅ |
| Fund | POST | `/onboarding/start` | first-run funding state machine (tier full → funding_address) | ✅ |
| Fund | GET | `/onboarding/state` | poll until `funding-seen` | ✅ |
| Fund | GET | `/payments/balance`, `/payments/funding-address` | balance + deposit address (QR) | ✅ |
| Liquidity | POST | `/payments/open-channel` | channel needed before paid messaging | ✅ |
| Contacts | GET/POST | `/peers`, GET `/peers/connected` | add counterpart {node_id,address}, presence | ✅ |
| Rooms | POST/GET | `/rooms`, GET/DELETE `/rooms/:id` | create/list/get a room | ✅ |
| Rooms | GET/POST | `/rooms/:id/members`, DELETE `/rooms/:id/members/:node_id` | list/add/remove members | ✅ |
| **Talk** | **POST** | **`/messages/compose`** | the one call — node does E2EE + Lightning; client sends `{recipient,is_room,kind,plaintext}` | ✅ |
| Live | GET (WS) | `/ws` | inbound stream; own-node receive carries plaintext | ✅ |
| History | GET/POST | `/messages`, `/messages/search`, `/messages/resync` | backfill + reconnect resync | ✅ |
| Session (transparent) | GET | `/sessions/prekey` (+ `/sessions`) | Double-Ratchet prekey/initiate/accept | ✅ |
| Pricing (preview) | GET | `/payments/price/:kind`, `/pricing/peers` | show/estimate sat cost | ✅ |
| Files (optional) | POST | `/files`, `/files/:id/send` | upload + send (Recipient::Node only) | ✅ |

## Known gaps — design AROUND these (from the seam audit; not blockers for desktop 1:1)
- **Room membership is local-only.** Adding a member does NOT admit/notify the peer, and there is
  no room invite/join protocol. **CS-3 MVP is scoped to 1:1 + already-peered members** so
  "add participant" cannot silently fail. Full multi-party rooms wait on a membership-propagation
  + participant-profile endpoint (new protocol work).
- **No participant-profile endpoint.** The UI joins member node-ids to `KIND_PROFILE` display
  names/avatars itself.
- **Calls (kinds 400–499) deferred/unimplemented** — OUT of the MVP contract (Gate G3).
- Pairing and pinned Noise remote transport are supported; mobile push remains outside this contract.

## Verification
**Static (no running node) — re-pin check:**
```bash
# Read the release tag from TAG in scripts/fetch-node-sidecar.sh, then:
git -C <BitSov-bitsov checkout> checkout <pinned-tag>
grep -rhoE '"/api/v1/[^"]+"' crates/konsensus-api/src | tr -d '"' | sort -u
# every path in the MVP table above must appear. String-literal grep on purpose: the
# room-member routes are declared across lines, which a single-line `.route("…")` grep misses.
```
**Runtime smoke (against a running bundled node on $PORT):**
```bash
JWT=$(curl -s -X POST http://127.0.0.1:$PORT/api/v1/auth/local | jq -r .token)   # PASS: non-empty
curl -s -H "Authorization: Bearer $JWT" http://127.0.0.1:$PORT/api/v1/identity | jq -e .node_id
curl -s -H "Authorization: Bearer $JWT" http://127.0.0.1:$PORT/api/v1/health
# compose is exercised in an integration test with a funded 2-node fixture, not a bare smoke.
```

## CS-1 gate
CS-1 exercises fresh ordinary `init`, read-scoped loopback authentication and durable
identity across two starts. It does not qualify a funded-wallet migration, owner
Touch ID/Keychain behavior or paid operations. The app normally pairs; its rc7
`/auth/local` fallback remains restricted to a 404 on `/pair/request`.

## Offline money readiness (genome PR #107)

App readiness support targets `feat/boot-offline` at
`b984d514e9c25b8925f4daaf65db1b2baf18f3bb` and is included in the rc9 pin.
The authenticated `GET /status` adds optional top-level `money_ready` and
`readiness`: `{ money_ready, state, retry_attempt, retry_after_secs, events }`.
Events contain `{ sequence, timestamp, state, money_ready }`; timestamps are
Unix **seconds**. States include `offline`, `retrying`, `synchronizing`, `ready`,
`failed`, and `stopped`. A retry delay is a node-reported interval, not an app
countdown. Missing fields keep the legacy behavior.

The app keeps local reads available, displays status age and transition age,
and gates money preparation and dispatch while `money_ready` is false. The
existing ten-second status poll restores controls and refreshes active pricing;
it never retries a send or payment. Channel controls are not exposed by this
app; the shared notice includes channel actions and the wallet avoids claiming
its outbound balance is ready to send.

The exact pre-dispatch refusal is HTTP **503** with
`{ "code": "not_ready", "money_ready": false, "error": "…" }`. Only this
contract releases the app's spending reservation and pending journal. Generic
503s and interrupted responses remain unknown outcomes. Host-local identity,
authentication, and data-directory failures use `app_not_ready`, preserving
their own explanations instead of promising a chain retry.
