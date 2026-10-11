# API_READINESS — the node contract CS-1..CS-6 build against

**Pinned protocol:** release **`v0.3.0-rc14`**, source-ref
**`d55a88e439fd80dae89e263bef8378fd22c9a103`**, repo `MindLink-ApS/BitSov-bitsov`.
The supplied release facts identify rc14 as published and GPG-signed. Its
five binary hashes are recorded without network access. The local rc14 tagged
source was inspected; release signatures and bytes were not verified here.
Live CS-1 and other runtime/package acceptance remain CI/operator checks.

rc14 includes pairing, scoped tokens, freshness headers and the opt-in local owner
ceremony. The app retains rc7 fallback and fixture coverage. The table below is
the historical CS route inventory, with the changed auth/restore boundaries
called out; route presence does not grant spending or live identity authority.
See [rc14 upgrade and release checks](NODE_RC14_UPGRADE.md) for the supplied
node changes and app integration limits. The rc12 enrolment source review remains
[historical evidence](NODE_RC12_UPGRADE.md), not an rc14 wire-contract review.
rc13 introduced claim-code / four-word SAS enrolment (`sas_version: 1`) and box approval.
Remote first run is implemented on main (app #192 + node rc13); runtime
acceptance on real hardware (Touch ID + a fresh Pi) is still pending. The
existing app does not display the node's `offline_safety` diagnostics.

rc14 adds forward-only pairing file v6 and durable grant breakers. Breaker reset
and `konsensus recover` remain owner-console-only; CLN is a receive/read preview
with no outgoing payments. See the upgrade note before replacing legacy grants.

Base URL: `http://127.0.0.1:$PORT/api/v1` (loopback only — Gate G2). Auth: `Authorization: Bearer <jwt>`
on REST; `bitsov.v1` + `bitsov.jwt.<token>` subprotocols on `/ws`.

## MVP contract — "fund your node and start talking" (rc14 pin; rc7 compatibility retained)
| MVP step | Method | Path | Purpose | Static |
|---|---|---|---|---|
| Boot/auth | POST | `/pair/request`, `/pair/confirm`, `/pair/token` | app pairing; `/auth/local` is only the rc7 404 fallback (rc14 smoke may use read/receive) | ✅ |
| Identity | GET | `/identity` | node_id + x25519/secp256k1 pubkeys | ✅ |
| Recovery | POST | `/identity/verify-mnemonic`, `/identity/restore` | verify needs identity scope; restore exists only on bootstrap in rc14 | ✅ |
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
git -C <BitSov-bitsov checkout> checkout d55a88e439fd80dae89e263bef8378fd22c9a103
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
