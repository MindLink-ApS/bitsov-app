# API_READINESS — the node contract CS-1..CS-6 build against

**Pinned protocol:** release **`v0.3.0-rc4`**, source-ref **`aa159189ae280a17c5eee136ee6018128206e046`**,
repo `MindLink-ApS/BitSov-bitsov`. All paths below were verified **present in this source**
(route grep at `aa15918`). Re-verify on every node upgrade and re-pin this header.
Base URL: `http://127.0.0.1:$PORT/api/v1` (loopback only — Gate G2). Auth: `Authorization: Bearer <jwt>`
on REST; `bitsov.v1` + `bitsov.jwt.<token>` subprotocols on `/ws`.

## MVP contract — "fund your node and start talking" (all VERIFIED PRESENT at aa15918)
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
git -C <BitSov-bitsov checkout> checkout aa159189
grep -rhoE '\.route\("(/api/v1/[^"]+)"' crates/konsensus-api/src | grep -oE '/api/v1/[^"]+' | sort -u
# every path in the MVP table above must appear.
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
