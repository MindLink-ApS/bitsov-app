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

## 0. Headless walkthrough (2026-10-12, app `main` 69df4c8)

**How it was measured:**
- **Script:** `scripts/design/walkthrough-headless.cjs`, run in headless Chromium at 1280×820. Each scenario ran 5 times and the table shows the median. Evidence (results.json and one PNG per scenario) is in `design/ux/walkthrough/`.
- **Modes:** sample mode (`?sample`) for the running app; a stubbed host for first run, offline, unlock and pairing.
- **No window, no node, no money.** Rasmus chose headless only. The two-mock-node window runner (`scripts/ui-e2e-two-node.sh`) was **not** run, because it opens the real app window on NOVA.
- **Feedback** is the time from the click to the first DOM change. **Done** is the time from the click to the scenario's end state.
- **What these numbers leave out:** they measure the **UI only**. Sample mode answers at once, except AI reads, which take a fixed 350 ms. Node, Lightning and peer time are **not** in them. For those, see the traced round trips in §1 and §1b, which stay **unmeasured** end to end until a recorded mock-node or pilot run.

| Scenario | Feedback | Done | |
|---|---|---|---|
| First run: app start → setup on screen | — | 74 ms | PASS |
| Running app: start → chat ready | — | 110 ms | PASS |
| Send a message (sample; approval card first) | 5 ms | 9 ms | PASS |
| Approve the daily budget (one tap) | 0 ms | 0 ms | PASS |
| Open a contact | 1 ms | 1 ms | PASS |
| Switch to another chat | 11 ms | 11 ms | PASS |
| Start a call (sample: no peer media) | 2 ms | 8 ms | PASS |
| Composer: More → Pay | 1 ms | 1 ms | PASS |
| Request: amount → Create invoice → QR | 2 ms | 17 ms | PASS |
| Attach a file → price shown | 0 ms | 0 ms | PASS |
| You → Wallet | 3 ms | 3 ms | PASS |
| Wallet → Receive tab | 1 ms | 1 ms | PASS |
| You → Profile and settings | 0 ms | 0 ms | PASS |
| Settings → Devices (add a device) | 1 ms | 1 ms | PASS |
| Open Ask your node | 3 ms | 3 ms | PASS |
| Ask your node: a suggested question → answer | 1 ms | 364 ms | PASS |
| + New (node id, intro card, starter bitcoin) | 11 ms | 11 ms | PASS |
| Offline: Retry now → back | 1 ms | 2 ms | PASS |
| Unlock with typed password | 1 ms | 11 ms | PASS |
| Paste a pairing link → Review | 1 ms | 14 ms | PASS |

**What this shows:** the renderer itself is not where time goes. Every scenario gives feedback within one or two frames and reaches its UI end state in under 20 ms (Ask your node takes 364 ms, of which 350 ms is the sample read). The felt slowness and friction are elsewhere:
- steps that leave the app (terminal approvals);
- sequential host round trips before each payment;
- payment flows that give no feedback until the node settles.

The ranked list below follows from that.

## 0b. Top 10 friction points (2026-10-12)

Each point is marked by what it needs to move: **UI** (this lane, now), **host ledger** (parked #201, #203 and #207; they re-land on #209/H1), **host** (pre-flight / API) or **node**.

| # | Friction | Evidence | Needs |
|---|---|---|---|
| 1 | **The first send leaves the app.** A fresh setup's first Send shows "Confirm at your node… Run `konsensus grant --op …`" on the node's computer. | `send.png`; scenario `send` | **node + host**: owner approval from an enrolled device (Touch ID approvals exist but need device setup first). UI part: offer Touch ID setup right there. |
| 2 | **No feedback while a paid message goes out.** No bubble until the node settles: the whole pre-flight, payment and delivery (§1). | 1218 ms to the bubble with a 1.2 s stubbed send (§1) | **host ledger** (#201 parked) |
| 3 | **Approve, then press Send again.** The approval succeeds and nothing is sent. | §3 #1; #207 | **host ledger** (#207 parked) |
| 4 | **Calls across networks cannot connect.** There is no STUN by default; own-node STUN is built but parked. | §1b C1; beta STUN verified | **host ledger** (#203 parked; the STUN default is part of it) |
| 5 | **First contact with a stranger needs an owner command** (`konsensus approve first-contact …`). | OWNER_FIRST_CONTACT.md; #207 Codex finding | **node + host** |
| 6 | **5–6 sequential host round trips before each payment** (≈ 0.4–0.75 s at 74 ms RTT). #204 reuses status within the pre-flight. | §1; #204 merged | **host** (rest of the parallel reads) |
| 7 | **On a phone, Wallet and Settings were unreachable** and tap targets were 25–38 px. | `capture-phone.cjs` | **UI**: #208, round 2 in review |
| 8 | **The offline screen sat on top of the setup steps**; unlock spanned the window; jargon in step 2. | `capture-offline.cjs` | **UI**: #211, round 1 fix pushed |
| 9 | **The "No STUN server" note shows on every chat.** | §1b C2 | **UI**: #210 in review |
| 10 | **The file composer shows no price on Send while approval is pending.** It says only "pays like a message". | `file.png` | **UI**: not yet built (small) |

**Not measurable headless (stays open):**
- receive latency (node delivery);
- rooms ("This node does not support rooms yet" in sample);
- add a device (disabled without an owner device);
- any real call media.

These need the recorded mock-node run (with Rasmus's OK) or a hand check on the pilot.

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
| Click → bubble visible | **1218 ms** (= the whole send) | **2–3 ms** (measured on `feat/optimistic-send`) |
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

## 1b. "Call / video call" (second deep dive, traced)

### Path (`src/control/call.ts`, host `do_call_signal`)

1. **Click Call.** The button already shows the read-only quote. The panel goes to **Calling…** at once, which is
   good immediate feedback.
2. **Media and offer, before anything is paid.**
   - `getUserMedia`: the first time, macOS shows its permission prompt (timeout 15 s).
   - `createOffer`, then vanilla ICE gather, waiting **up to 3 s** (`GATHER_MS`) before the offer is sent.
3. **The offer is a paid signal (`call_signal`).** The host does `GET /status`, reads the call quote, reads the
   grant, then `POST /messages/compose`. That is **≈ 3–4 sequential RTTs plus payment and delivery**, the same
   pattern as a message. When it settles the panel shows **Ringing**.
4. **The callee taps Accept.** That is the same path again for the answer: media, gather (≤ 3 s), then a paid
   signal of ≈ 3–4 RTT plus payment.
5. **ICE connectivity.** With **no ICE servers (the default), only host candidates exist.**
   - On one LAN or VPN it connects.
   - **Across networks (Rasmus in Mexico ↔ Maya) it cannot connect at all.** "Calls may not connect across
     networks yet" is accurate.

### Findings

| # | Finding | Kind | Fix |
|---|---|---|---|
| C1 | Calls across networks **cannot connect**: no STUN/TURN by design (the app contacts no third party) | reachability, not latency | **Product decision.** STUN (and later TURN) served by **the user's own node** keeps the "no third party" rule. Needs a node issue (STUN on the node's public endpoint; TURN for symmetric NAT). The app then defaults to the paired node's STUN when remote. |
| C2 | The "No STUN server is set" note shows on **every chat** (track header), not only around calls | noise | Show it only in the call panel and next to the call buttons when a call is started. Small renderer PR. |
| C3 | Each paid signal repeats the message pre-flight (`/status`, quote, grant) | latency, ≈ 3–4 RTT per signal, × 2 per call setup | Same host fixes as send (#2–#3 in the top list): cache capabilities, parallel reads |
| C4 | Vanilla ICE waits up to 3 s for gathering before sending the offer | latency on slow or blocked STUN | Fine with host-only; with STUN, consider trickle ICE later (one more paid signal per batch, so a cost/latency trade-off to decide) |
| C5 | Callee sees an incoming card only after the offer's payment settles | inherent to "payment is the connection" | Keep; make sure the caller sees **Ringing** only after settle (it does) |

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
| Call / video | "Calling…" at once | offer paid → Ringing → answer paid → ICE | no | **cannot connect across networks (C1)**; note on every chat (C2); 3–4 RTT pre-flight per signal (C3) | **traced, fixes C1–C3** |
| Meeting | planner → invite | per invitee | no | invitees ringed one by one | to measure |
| Offline / reconnect | offline screen (#198) | reconnect | no | — | to measure |
| Settings | instant | instant | no | Display repeated on every tab (inspiration doc §6) | planned |
| AI "Ask your node" | thinking line | local model | no | unmeasured | to measure |
| Device setup (Touch ID approvals) | pending card | **owner runs `konsensus device approve …` at the box** | **yes** | console step by design (owner ceremony) | design question |

## 3. Top fixes (re-ranked 2026-10-11 after the Codex second opinion)

1. **Approve & continue: one action.** Today a Touch ID approval succeeds and then returns without sending
   (`Shell.tsx` approve path), and calls say "press Call or Accept again". Make it *Approve & send* /
   *Approve & call*: keep the recipient, the draft or media choice and the ceiling through authentication, then
   continue once. Ask again only if the terms change (price, recipient, ceiling). **Biggest simplification.**
   Renderer PR, queued after calls.
2. **Optimistic send bubble (#201).** Done, in review. Unknown or paid-not-delivered outcomes are never a
   retryable draft: the box stays empty and points to *Check pending result* (the host blocks further spending
   until reconciled).
3. **Calls: feedback from the press and STUN by default.** On `feat/calls-sequence`: *Calling* shows at the press,
   Mute/Camera/own preview from the first moment, own-node STUN by default, the network note only in the call panel,
   the no-relay limit stated plainly.
4. **Host pre-flight (ATLAS lane, bitsov-app #202).** Parallel reads and capabilities caching across messages and
   call signals; the fresh grant check stays inside serialised spending. About -3 RTT per send or signal.
5. **Get approvals out of the console.** Offer Touch ID approvals where *Approve spending* and *first contact*
   stall, not only in Settings. Long term, owner approval from an enrolled device (node issue).
6. **Node: compose timing breakdown.** Diagnostics, so step 7 can be measured and owned.
7. **TURN on the node, later.** An explicitly consented relay on the user's own node (node issue filed by ATLAS).
   Until then the UI says there is no relay and some networks cannot connect.

## 4. Log

- **2026-10-12:** Headless walkthrough of 20 scenarios at `main` 69df4c8 (5 runs each; all PASS). The UI responds within frames everywhere, so the friction is approvals, host round trips and the parked payment flows. Top 10 friction points are ranked in §0b. The window runner was not used (Rasmus: headless only).

- **2026-10-11:** Beta's own-node STUN checked from NOVA: a STUN Binding Request to 136.71.194.190:3478 got a
  Binding Success response with a mapped address in **114 ms** (transaction id matched). **Verified by the lead**
  from beta's loopback owner API: `/status` reports `"stun_url":"stun:136.71.194.190:3478"`, `"stun_port":3478`. The
  host maps `stun_url` into the overview (`own_stun_url`, plain `stun:host:port` only) and the app uses it as the
  default from the **first overview read** (test: *By default, calls ask your own node*). So the own-node default is
  real end to end on the node side; a real app paired to beta opening Settings → Calls is still to be seen.
- **2026-10-11:** Codex second opinion adopted: *Approve & continue* moves to #1; unknown payment results are never a
  retryable draft; calls show *Calling* at the press with preview/mute; TURN later on the node with consent.

- **2026-10-11:** Calls traced: cross-network calls cannot connect without STUN/TURN (C1, needs a node issue and a product decision); the STUN note shows on every chat (C2); each paid signal repeats the send pre-flight (C3).
- **2026-10-11:** Optimistic send built on `feat/optimistic-send`: bubble at 2–3 ms, paid at 1209 ms (real settlement). A second Send while one is in flight queues in order instead of being ignored.
- **2026-10-11:** UI side measured with the stubbed host (1.2 s send): bubble at 1218 ms, paid at 1218 ms.
- **2026-10-11:** Scorecard started. Send path traced: 5–6 sequential pre-flight RTTs plus compose, with no visual
  feedback until settled. RTT from NOVA to the pilot measured at 74 ms (TCP connect).
