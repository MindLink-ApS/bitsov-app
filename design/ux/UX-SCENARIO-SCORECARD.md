# UX scenario scorecard (living)

**Owner:** UI/UX lane. **Started:** 2026-10-11, at app `main` 2799e5a (rc14 pin, #197 calls hardening, #198 polish).

**How things are measured.** Code-path tracing counts the sequential app↔node round trips per click. The network
leg is timed from this Mac. The UI side is timed in tests against a stubbed host. The node's own payment and
delivery time needs a recorded run on the pilot, which needs Rasmus's OK because it moves mainnet sats. Until then
that column says **unmeasured**; it is never guessed.

**Columns:**
- **Feedback** is the time from the click to the first visible change.
- **Done** is the time to the final state.
- **Leaves app** is any step the user must do outside BitSov.

## 1. "Send a paid message" (first deep dive)

### What happens today on Send (code path, `main` 2799e5a)

| # | Where | Call | Sequential? | Cost |
|---|---|---|---|---|
| 0 | Renderer | `submit()` → `busy`, draft stays in the composer, **no bubble** | | ~1 frame |
| 1 | Host `do_conversation_send` | `require_conversation_ceiling` → `GET /status` | yes | 1 RTT |
| 2 | Host `do_message_send_with` | `require_price_caps` → `GET /status` **again** | yes | 1 RTT (duplicate) |
| 3 | Host `read_price_quote` | `GET` own price | yes | 1 RTT |
| 4 | Host `read_price_quote` | `GET /pricing/peers` | yes | 1 RTT |
| 5 | Host `money_post` | `ensure_fresh_token` (refresh only near expiry) | yes | 0–1 RTT |
| 6 | Host `check_node_grant` | `GET` grant | yes | 1 RTT |
| 7 | Node | `POST /messages/compose`: Lightning payment to the peer + encrypted delivery | yes | **unmeasured** (node + LN + peer) |
| 8 | Renderer | `sentOne()` → bubble appears, draft clears, "paid N sats" | | ~1 frame |

**Measured network leg.** TCP connect from this Mac to the pilot endpoint (136.71.194.190:8443) took **74 ms
median**, with one outlier of 153 ms across 5 tries. This is from NOVA, not from Rasmus's location. Each
pre-flight call over the pinned tunnel costs at least one RTT, so steps 1–6 alone take **≈ 0.4–0.75 s** before the
node starts paying.

**Measured UI side.** The test `tests/send-latency.test.tsx` uses a stubbed host whose `message_send` takes
1200 ms. Run on `main` 2799e5a:

| | Today (measured) | With fix 1 (target) |
|---|---|---|
| Click → bubble visible | **1218 ms** (= the whole send) | ≤ 1 frame |
| Click → "paid ✓" | **1218 ms** | unchanged; it is real settlement |

The composer keeps the draft and a disabled Send for the whole time. Nothing on screen says "sending".

**Why it feels slow.** The perceived latency is the whole pre-flight plus payment plus delivery, with no feedback at
all. Even a 1 s send feels broken if nothing moves.

### Fixes for this scenario (ranked)

1. **Optimistic send (renderer only).** On Send, the message appears at once as an outgoing bubble marked
   *Sending · up to N sats* and the composer clears.
   - **On settle:** the bubble becomes the real message with *paid N sats* (proven fee).
   - **Paid but not delivered:** the existing undelivered card takes over.
   - **Nothing paid:** the bubble goes away and the text returns to the composer, unless the user has typed
     something new. In that case a note quotes the unsent text.
   - **Doctrine:** the price is still a ceiling until it settles; nothing claims "delivered" early.
   - **Effect:** feedback goes from "whole send" to one frame. **Biggest perceived win.**
2. **Host: drop the duplicate `/status` per send.** Cache capabilities per connection, refreshed on reconnect or
   pairing change. Saves **1 RTT** per send. Host PR.
3. **Host: read own price, peer prices and the grant in parallel.** Use `join!` for the independent reads. Saves
   **2 RTT** per send. Host PR.
4. **Node issue: compose timing breakdown.** Return or log `pay_ms` / `deliver_ms` per compose, so the
   unmeasured step 7 becomes measured. The app shows nothing new; this is diagnostics only.
5. **Send stays one tap after the first approval.** See the scenarios below that send the user to the console.

## 2. Scenario inventory

| Scenario | Feedback | Done | Leaves app? | Main friction found | Status |
|---|---|---|---|---|---|
| First run: This Mac | spinner while the node starts | node start + pair | no | none since #148/#176 | ok |
| First run: home box | paste link → review | after restart | no | Mac can't scan (QR PR pending, jsQR approved) | **planned** |
| Pairing: 4 words + claim code | — | — | — | waits on node work (`--home` → mDNS → words → box page) | blocked (node) |
| Add a device | — | — | — | in progress in another lane | n/a |
| Unlock after power cut | one tap (Touch ID) or typed | node unlock | no | typed-first until Remember (#184) | ok |
| **Send a paid message** | **none until settled** | pre-flight 5–6 RTT + pay + deliver | no | no "sending" state, duplicate reads | **fix 1–3** |
| First paid message to a new contact | owner request card | **owner runs `konsensus approve first-contact …` at the node** | **yes** | console step, unless Touch ID approvals are on | **fix 5** |
| Spend window ("Approve spending") | approval line | **owner runs `konsensus grant …` at the node** | **yes** (Rasmus hit this on 11 Oct) | console step; Touch ID per-contact envelope exists but needs device setup first | **fix 5** |
| Receive a message | live stream | instant on event | no | unmeasured | to measure |
| Rooms | quote → confirm | per leg sends | no | each leg is a full send (sequential) | to measure |
| Wallet receive | invoice/QR | payer side | no | unmeasured | to measure |
| Wallet send | review → confirm | pay | no | same pre-flight pattern as send (to check) | to measure |
| Call / video | "Calling…" | ICE + paid signals | no | "No STUN server is set" note on every chat; no STUN default | **next deep dive** |
| Meeting | planner → invite | per invitee | no | invitees ringed one by one | to measure |
| Offline / reconnect | offline screen (#198) | reconnect | no | — | to measure |
| Settings | instant | instant | no | Display repeated on every tab (inspiration doc §6) | planned |
| AI "Ask your node" | thinking line | local model | no | unmeasured | to measure |
| Device setup (Touch ID approvals) | pending card | **owner runs `konsensus device approve …` at the box** | **yes** | console step by design (owner ceremony) | design question |

## 3. Top 5 fixes (ranked by felt impact ÷ effort)

1. **Optimistic send bubble.** Renderer only, small, high impact. Ready to build.
2. **Parallel pre-flight reads and capabilities caching in `message_send`.** Host, small. About -3 RTT, roughly 0.2 s
   or more per send at 74 ms.
3. **Get approvals out of the console.**
   - Offer Touch ID approvals right where *Approve spending* and *first contact* stall, not only in Settings.
   - Long term, a node-side owner approval from an enrolled device. Needs a node issue.
   - Removes the "leave the app" step Rasmus hit.
4. **Calls: STUN default and copy.**
   - The "No STUN server is set" line shows on every chat.
   - Ship a sensible owner-chosen default prompt in Settings → Calls.
   - Show the warning only when starting a call across networks.
   - (Calls deep dive is next.)
5. **Node: compose timing breakdown.** Diagnostics, so step 7 can be measured and owned.

## 4. Log

- **2026-10-11:** UI side measured with the stubbed host (1.2 s send): bubble at 1218 ms, paid at 1218 ms.
- **2026-10-11:** Scorecard started. Send path traced: 5–6 sequential pre-flight RTTs plus compose, with no visual
  feedback until settled. RTT from NOVA to the pilot measured at 74 ms (TCP connect).
