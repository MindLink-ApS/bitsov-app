# API_READINESS — the node contract CS-1..CS-6 build against

**Pinned protocol:** release **`v0.3.0-rc7`**, source-ref **`958e3997f9969497c1d270f557282b9bb591fe85`**,
repo `MindLink-ApS/BitSov-bitsov`. All paths below were verified **present in this source**
(route grep at `958e399`, 2026-09-17; API/onboarding source unchanged from rc6).
Re-verify on every node upgrade and re-pin this header.
rc7 validates fee-estimate payloads and writes a primary/fallback pair on fresh init;
existing configurations retain their chosen/default providers. This is startup selection,
not continuous failover.
rc6 fixed at the root the two rc5 boot defects the app had splinted around (#56 P2P/Lightning
port collision, #57 unshipped SQLite migrations; PR #61): `konsensus start` boots the `init`
config with zero edits and needs no `KONSENSUS_SQLITE_MIGRATIONS_DIR`.
Base URL: `http://127.0.0.1:$PORT/api/v1` (loopback only — Gate G2). Auth: `Authorization: Bearer <jwt>`
on REST; `bitsov.v1` + `bitsov.jwt.<token>` subprotocols on `/ws`.

## MVP contract — "fund your node and start talking" (all VERIFIED PRESENT at 958e399)
| MVP step | Method | Path | Purpose | Static |
|---|---|---|---|---|
| Boot/auth | POST | `/auth/local` | mint JWT for the loopback (desktop) app | ✅ |
| Identity | GET | `/identity` | node_id + x25519/secp256k1 pubkeys | ✅ |
| Recovery | POST | `/identity/verify-mnemonic`, `/identity/restore` | BIP-39 verify → restore | ✅ |
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
- **No device pairing / mobile push / remote transport confidentiality** — gates all mobile/paired
  work (Gate G2, milestone M5).

## Verification
**Static (no running node) — re-pin check:**
```bash
git -C <BitSov-bitsov checkout> checkout 958e3997f9969497c1d270f557282b9bb591fe85
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
**CS-1 may proceed:** every MVP-contract route is present in the pinned release; the desktop
API-consumer path (bundle node → `/auth/local` → drive over loopback) is real today. **Do not**
build against calls, mobile, pairing, hosted, relay, or AI endpoints — they are gated (see the
goal file §6/§7 and `CODEX_APP_AUTHORITY.md` §B/§G).

## Offline money readiness (genome PR #107)

App readiness support targets `feat/boot-offline` at
`b984d514e9c25b8925f4daaf65db1b2baf18f3bb` without changing the bundled release.
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
