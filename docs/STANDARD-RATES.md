# Standard rates and budget defaults

Owner decisions recorded, with the rest open. Nothing here changes the app or a
node. This is product pricing, not financial advice.

**Principle.** Build little policy in; ship defaults the user can change. BitSov
is the base for open source, and what nodes share is timechain entrainment and
payment attached to the packet. So every number below is a changeable default
unless marked protocol. Money-path correctness and the review gate are not
defaults.

Every table comes from the offline simulation, and more tables are there
(T1 to T13 with T5d, T7c and T11c; plus a grid of 750 rate sets with `--csv`):

```sh
node scripts/simulate-rates.mjs
node scripts/simulate-rates.mjs --csv
```

Fiat figures use one editable assumption, not a market quote:
`BTC_PRICE_ASSUMPTION` = 600,000 DKK per BTC, so 1,000 sats = 6 DKK.

## The short answer

The owner set the standard price at **1 / 5 / 2 sats: message / offer / minute**,
and it stays there. No sub-sat work. The default call limit stays **60 minutes**.
This replaces the earlier card of offer 10, minute 10 and limit 30.

| Item | Today | Now | Status |
|---|---|---|---|
| Message | 1 sat | 1 sat | decided |
| Call offer | 10 sats (reported) | 5 sats | decided |
| Per minute | 10 sats (reported) | 2 sats | decided |
| Caller's call limit (`max_call_minutes`) | node default 60; the two test boxes 10 (reported) | 60, the node default | decided |
| In-app self-approval (#394) | 200 sats a day | 2,500 sats per 24 h, as a total | decided |
| AI client budget | none | 1,000 sats per 24 h | decided |
| Default contact budget | 50 sats a day (Careful) | 1,000 sats a day | suggested; owner has not set this |
| Default daily budget | 500 sats (Careful) | 2,500 sats | suggested; owner has not set this |
| Per-payment limit on an envelope or a self grant | 6 or 10 sats | 50 sats, owner-changeable | decided (section 6) |
| First-contact admission | 100 in a fixture; **cannot be paid under a grant** | 1 sat, until the node lets a grant pay more | open (section 6) |

One call on this card (T1):

| Box limit | Each minute, all-in | Hold (minutes) | Free at Ring | Largest payment | 10-min call, price only |
|---|---|---|---|---|---|
| 10 (the two boxes report this) | 7 | 70 | 86 | 10 | 26 |
| 60 (node default) | 7 | 420 | 436 | 10 | 28 |

"Free at Ring" adds the closing hangup (6 sats, held with the minutes) and the
offer (10 sats all-in). A 50-sat contact budget still refuses every call; so does
250 at limit 60.

**The routing floor, honestly.** The price no longer dominates the hold. At 2 sats
a minute the 5-sat routing allowance is **71% of each minute** (a review found 83%
at 1 sat), and 300 of the 420 sats held at limit 60. The minute price is the other
120. The allowance is a ceiling that is released when unused: on the assumed 1 sat
of routing per payment, an hour pays 120 sats to the person called and 60 to
routing, so routing is 33% (T8c). Lowering the allowance would shrink the hold
(240 sats at 2 sats a block, T1b) but more routes could fail, so measure first.

At the suggested defaults the regular day (30 messages and two 10-minute calls) is
refused nothing at either limit and costs about 142 sats a day at limit 60, or
26 DKK a month on the assumption. On that routing assumption 86 of the 142 sats go
to the people messaged and called, and 56 to routing.

## 1. What the code says today

Status: **app** is read in this repo. **Node** is read in the node repository at
commit `b3f1ad1`. **Node-side** is not confirmed and must be. **Reported** comes
from the owner's box and the field test of 1 November.

### Budgets and grants

| Value | Where | Status |
|---|---|---|
| Contact envelope default 200 sats a day, window 24 h | `src-tauri/src/device.rs` `DEFAULT_BUDGET_MSAT`, `DEFAULT_WINDOW_SECS` | app |
| Envelope per-act maximum: the quoted price, at least 1 sat, 10 sats without a quote | `device.rs` `default_per_act` | app |
| Approving a contact from the message box passes the shown message cost as that maximum | `src/control/Shell.tsx` `approveContact(target(), msat)` | app |
| Presets, daily / contact / room: Careful 500 / 50 / 100, Everyday 2,000 / 200 / 500, Generous 10,000 / 1,000 / 2,500 | `src-tauri/src/budget.rs` `PRESETS` | app |
| First-contact choices: the preset's contact budget (or the cost, if higher), then x2 and x5, clamped to the daily total. Careful gives 50, 100, 250 | `src/control/state.ts`, `Shell.tsx` `firstOptions` | app |
| Most in one budget: 100,000 sats a day, rolling 24 h | `budget.rs` `MAX_DAILY_MSAT` | app |
| Grant: at most 24 h, at least 60 s, at most 256 recipient budgets; finite, does not refill | `src-tauri/src/grant.rs`, `docs/BUDGET_SCOPE.md` | app, mirrors node |
| Non-call payment cap: 6 sats, all-in, whatever the owner signed | `grant.rs` `MESSAGING_PER_CALL_MAX_MSAT`, `PaymentCap::Grant` | app, mirrors node |
| Call payment cap: the signed `per_call_max_msat`, or an envelope's per-act maximum | `grant.rs` `per_payment_max`, `check_under` | app, mirrors node |
| Order of checks: per payment, then total, then recipient, then envelope | `grant.rs` `check_under` | app |
| `recipients_only`: only contacts with a live envelope may be paid; such a grant funds no explicit payment | `grant.rs` | app, mirrors node |
| Breakers per grant, defaults: 10 payments a minute, 60 an hour, pause after 5 failures, 1,000 sats per 10 minutes. The 2, 12, 3 and 9 in this repo's tests are fixtures, not defaults | `crates/konsensus-api/src/spend_budget.rs:138-147` | node |
| What a ring counts: the hold and the offer, as 2 payments and their whole reserved amount, even if released. Blocks draw on the hold and no breaker check runs there | `handlers/messages/compose.rs:3646-3648`, `pairing/call_spend.rs:336-417` | node |
| Self-approval: 2,500 sats per 24 h as a total, 1 live, 3-day cooldown, per-payment limit 50 sats | open draft #394, `docs/IN-APP-BUDGET-APPROVAL.md` on its branch | owner decision, changeable default |

### Prices and routing

| Value | Where | Status |
|---|---|---|
| Smallest payment 1 sat; a porch read never pays less | `src-tauri/src/act.rs` `MIN_PAYMENT_MSAT`, `src-tauri/src/porch.rs` `MIN_READ_MSAT` | app |
| Routing allowance per payment: 1% of the principal, at least 5 sats, at most 10 sats | `act.rs` `routing_fee`, `docs/BUDGET_SCOPE.md` | app; the node may tighten it |
| Message price 1 sat | reported; the price is the callee's. Test configs use 2 and 2.3 sats | node-side |
| Each box sets its own inbound prices | `docs/CALLS.md` (`[pricing] call_block_msat`), `src-tauri/src/control.rs` | node-side |
| File: the node's kind-200 price, file at most 1.4 MB, subject to the 6-sat cap | `act.rs` `KIND_FILE_REF`, `FILE_MAX_BYTES`; `grant.rs`. Test configs use 3 sats | price node-side |
| First-contact admission: at least 1 sat, at most 100 sats | `ADMISSION_MAX_MSAT`, `handlers/messages/compose.rs:1085` | node |
| **Under a grant, admission plus first message, all-in, is at most 6 sats.** The 100-sat figure applies only to an unmetered owner session | `messaging_per_call_max_msat`, `pairing.rs:3529-3532`; `spend_budget.rs:113`; test `a_confirmation_must_fit_the_budget_grant`. App: `do_first_contact_request` `grant.check` | node, mirrored by the app |
| Front-door prices `admission_msat`, `message_msat`, `page_msat` are advertised on the card. Fixture: 100, 10, 1 sat | `src-tauri/src/front_door.rs`, `porch.rs` tests | fields app, **values node-side** |
| Package prices | none found in this repo | not present |
| AI client grant | none in this repo; the assistant broker refuses spend routes and no sats rail to a model provider exists | `docs/ASSISTANT_LOCAL_BROKER.md`, `docs/CONTROL_CENTER_AI.md` |

### Calls

| Value | Where | Status |
|---|---|---|
| Today, until each box is set to the card: offer 10 sats, signal 1 sat, per minute 10 sats | reported; the offer and signal also appear in `scripts/calls/media-check.py` | node-side |
| Block 60 s, next block due 20 s before the end, 10 s grace | `src/control/callMinutes.ts`, `docs/CALLS.md` | protocol |
| Routing allowance per block: the offer's allowance, so 5 sats | `control.rs` `with_call_blocks` | app, mirrors node |
| Hold = (price + allowance) x `max_call_minutes`, plus the closing hangup (its price and allowance, at least 1 sat). The offer is reserved with it, as its own charge | `CallSpendTerms`, `spend_budget/calls.rs:51-59`; `pairing/call_spend.rs` `reserve_call_with_offer` | node |
| `max_call_minutes`, node default **60**, allowed 1 to 240. It is the caller's cap | `crates/konsensus-node/src/config.rs:1333`, `docs/UPGRADING.md` in the node repository | node |
| `max_call_minutes` on the **two test boxes: 10**. A configured value (the node's call runbook uses 10 as its example). Not readable before the offer | reported; to confirm on each box | reported |
| Ceiling shown before Ring: 240 minutes, so 1,680 sats on the card (3,600 at 10 sats a minute) | `control.rs` `CALL_MAX_BLOCKS`, `docs/CALLS.md` | app |
| App check before the offer: offer plus one hangup against the budgets; largest single payment against the per-payment limit | `src-tauri/src/app.rs` `do_call_signal`, `src/control/call.ts` `callPerPaymentNeed` | app |
| Calls go only to contacts already paid; the first contact is a message | `app.rs` `call_needs_contact` | app |

### The field test, 1 November (reported)

67 sats for the day, including a call of about 5 minutes at 60 sats. A 47-sat
remainder refused a call. The box's recipient budget had to be re-approved at 250.
Those boxes ran 10 sats a minute with a 10-sat offer, so the replay keeps those
prices.

The simulation agrees with all three:

- At the test boxes' limit of 10 and those prices, a call needs 171 sats free at
  Ring (T11): 15 for the offer and 156 for the hold, which is 150 for the minutes
  and 6 for the hangup. So 47 sats passes the app's own check for the offer and
  hangup (21 sats), then fails at the hold.
- Of the Careful choices 50, 100 and 250, only 250 holds one call.
- 60 sats fits the offer plus 5 blocks, a call of 3:40 to 4:40 (T11b). A full
  5:00 pays 6 blocks, 70 sats with the offer, so that decomposition is an
  inference. 60 rather than 90 (the same payments with full allowances) also
  suggests the day's figure counted fees paid. To be confirmed on the node.

### Node-side

Answered from the node source: the hold covers the hangup and the offer comes
with it, so 86 and 436 are exact on the card. Defaults for the breakers are
listed above. An owner-written grant's per-payment limit defaults to its whole
budget, and a relation envelope's per-act maximum binds each call payment
(`spend_budget/calls.rs:170-172`). A hangup under a grant is limited to 6 sats
all-in, so a signal price above 1 sat refuses the call before anything is held
(`check_call_closing`, `spend_budget/calls.rs:204-211`).

Still to be confirmed:

1. Which `max_call_minutes` are the two test boxes actually configured with?
2. Does the grant count the routing allowance or the fee paid? The app counts
   `fee_paid_msat` when reported and the allowance otherwise (`app.rs`). This
   decides between the two columns below.
3. Do a call's breaker counts behave in practice as read in the source (T12)?
4. Is a routed first contact really refused under a grant (T7c)? The default
   ceilings make it at least 12 sats all-in, above the 6-sat cap, unless the
   route is direct or the caller tightens the fee. This is read from the code.
5. What happens to a call at `max_call_minutes`? The model ends it there.
6. Is the hold only a budget and capacity check, or does it lock an HTLC?
   `call_liquidity_insufficient` shows a capacity check. Nothing in this repo
   says funds are locked on the channel.
7. What are the default prices a new box advertises? The card needs the node's
   defaults to be 5 and 2, and the two test boxes set to match.

## 2. The simulation

The model mirrors the rules above in integer msat. A day is an ordered list of
actions, checked in the order the host and node check them. Calls are paid from
the block schedule. Budgets are counted two ways, shown as `ceiling/actual`:

- **ceiling**: the whole routing allowance stays counted. The safe worst case.
- **actual**: the node reports the fee paid. The assumption is 1 sat per payment.

Profiles:

| Profile | One day |
|---|---|
| light | 3 messages |
| regular | 30 messages, two 10-minute calls, one contact |
| heavy | 100 messages, five calls to the box limit, five contacts |
| AI client | 200 small paid actions, three recipients |
| porch reader | 30 page reads across five boxes |

### What fits a standard call

From T2, T3 and T5d, on the card. Calls are full 10-minute calls in one contact
budget, `ceiling/actual`; `0/0` means one call does not fit.

| Contact budget | Limit 10 | Limit 60 |
|---|---|---|
| 50 | 0/0 | 0/0 |
| 250 | 2/5 | 0/0 |
| 500 | 5/11 | 1/2 |
| 1,000 | 11/25 | 7/14 |
| 2,500 | 29/64 | 23/51 |

The smallest contact budget that gets the regular day through on ceilings is 352
sats at limit 10 and 649 at limit 60 (T5d). 500 at limit 60 loses the second call.

### Profiles

From T4 and T13: cost as `actual`, refusals as `ceiling/actual`. The T4 month is 30
such days.

| Budgets, contact / daily | Profile | Sats/day | DKK/month (assumed) | Free at Ring | Refused | First refusal |
|---|---|---|---|---|---|---|
| Today, 50 / 500, limit 60 | regular | 46 | 8.28 | - | 75%/28% | contact budget |
| 500 / 2,500, limit 60 | regular | 101 | 18 | 436 | 3%/3% | contact, at hold |
| **Suggested, 1,000 / 2,500, limit 60** | light | 6 | 1.08 | - | 0/0 | none |
| | regular | 142 | 26 | 436 | 0/0 | none |
| | heavy | 1,140 | 205 | 436 | 1%/0% | daily, at hold |
| | porch reader | 60 | 11 | - | 0/0 | none |
| Suggested, limit 10 | regular | 136 | 24 | 86 | 0/0 | none |
| | heavy | 390 | 70 | 86 | 0/0 | none |
| Suggested, limit 60, per-payment limit 6 | regular | 60 | 11 | - | 6%/6% | per-call cap |
| AI client budget, 1,000 / 1,000 | AI client | 400 | 72 | - | 17%/0% | daily budget |

### Findings

1. **The hold, not the cost, is the failure.** A 2-minute call needs the same
   free amount at Ring as a 60-minute one. The rest is released afterwards.
2. **The routing floor is most of the hold.** See the short answer: 71% of each
   minute, 300 of 420 sats at limit 60.
3. **A message cannot cost more than 1 sat under a grant today.** 1 sat plus the
   5-sat allowance is exactly the 6-sat cap. At 2 or 5 sats every message is
   refused (T5b). The same holds for a file, and for the 10-sat message in the
   front-door fixture.
4. **A per-payment limit below 10 sats blocks all calls on the card.** The largest
   payment is the offer: 5 sats plus the 5-sat allowance. A minute is 7. At a box
   still on 10 sats a minute it is 15 (T3b). An envelope approved from the message
   box takes the message cost as its per-act maximum, about 6 sats, so on a relation
   grant `check_under` still refuses any call with `grant_per_call`. The default
   without a quote, 10, now just fits. This comes from reading the code in both repos
   (`spend_budget/calls.rs:168` in the node), not from a test; section 7, step 5
   tests it. The owner set the limit at 50 (section 6, item 2), so the envelope
   default is now a change to make, not a choice.
5. **What a budget buys depends on fee reporting.** 200 sats is 33 messages on
   ceilings and 100 on 1-sat fees (T5b). The chip's message count divides the
   budget by the shown message cost; check it stays all-in when this changes.
6. **The Ring text names the wrong number.** It shows the 240-minute ceiling, 1,680
   sats on the card, because the box limit cannot be read before the offer. A
   first-time user sees 4 times the real hold at the node default, and 24 times at
   limit 10.
7. **The breaker allows two rings in 10 minutes at the default limit.** The default
   of 1,000 sats per 10 minutes counts each ring's whole 436 sats even when the call
   was short; a third ring in that window is refused. At limit 10 it allows eleven
   (T12). No change to the breaker is needed for this card.
8. **A first contact under a grant has very little room.** Admission plus the
   first message must fit 6 sats all-in. A 100-sat admission cannot be paid by a
   paired app, at any budget, and neither can 6 sats or more (T7c). On default
   routing ceilings even a 1-sat admission is 12 sats all-in, so it fits only on a
   direct channel or with a tightened fee (node-side item 4).

### Exposure

The node's grant is the real bound. An app cannot spend beyond it however
compromised, and a messaging grant funds no explicit payment, so money leaves
only as messages and calls to peers. A colluding peer can collect it.

From T6 and T6b:

| Daily budget | Worst per day | DKK (assumed) | 10-min calls that ring |
|---|---|---|---|
| 1,000 | 1,000 | 6 | 7 |
| 2,500 | 2,500 | 15 | 23 |
| 5,000 | 5,000 | 30 | 50 |

Per contact, the worst is the contact budget, bounded by the daily one: 1,000
sats, or 6 DKK a day, per contact. Three colluding contacts reach a 2,500
budget. In-app self-approval counts its 2,500 as a total over 24 hours, so more
approvals do not raise the worst day.

### Spam

From T7. The attacker pays, and the receiver takes it (routing also falls on the
attacker). Admission is what would make fresh identities expensive.

| Admission | Message | 100 messages, fresh identities | 1,000 | 10,000 | 1,000 from one identity |
|---|---|---|---|---|---|
| 1 | 1 | 200 | 2,000 | 20,000 | 1,001 |
| 10 | 1 | 1,100 | 11,000 | 110,000 | 1,010 |
| 50 | 1 | 5,100 | 51,000 | 510,000 | 1,050 |
| 100 | 1 | 10,100 | 101,000 | 1,010,000 | 1,100 |
| 100 | 5 | 10,500 | 105,000 | 1,050,000 | 5,100 |

Ten thousand fresh identities at 100 sats would cost about 6,060 DKK on the
assumption above, all of it paid to the receiver. **That row applies only to a
sender on an unmetered owner session.** A sender on a paired app pays through a
grant, and a grant cannot pay it (T7c), so today the admission that actually
works for those senders is the 1-sat row: 20,000 sats, about 120 DKK, for ten
thousand identities. So admission is a much weaker spam brake than the table
first suggests, unless the node changes. Unsolicited rings cost the offer each, so
1,000 rings at 5 sats is 5,000 sats (T7b), half of what they cost at the old offer. The sender-side rule that calls go
only to contacts is an app rule. Whether a node gates rings from strangers is
node-side.

### Lightning

From T8 and T8b. Hop fees are an assumption, not a measurement.

| Principal | Allowance | Share of principal | Fits 5 hops at 1 sat? |
|---|---|---|---|
| 1 | 5 | 500% | yes |
| 10 | 5 | 50% | yes |
| 50 | 5 | 10% | yes |
| 100 | 5 | 5% | yes |
| 500 | 5 | 1% | yes |
| 1,000 | 10 | 1% | yes, 10 hops |

- **Minimum viable payment.** 1 sat is payable only because the allowance is
  5 times the payment. The allowance is at most the principal from 5 sats, half
  from 10 sats, a tenth from 50 sats.
- **The allowance is a ceiling, not a charge.** A direct channel costs nothing,
  and a payment the route prices above the allowance fails.
- **Per-minute blocks at 2 sats.** On 1 sat of routing per payment, routing is a
  third of what is paid in an hour; at 10 sats it would be 9% (T8c). Prepaying 5
  minutes at a time would cut routing to a fifth but overpay on short calls, and
  the block length is a protocol constant. Keep it.
- **Channel use.** Blocks are small, sequential and settle quickly, so they
  should use one HTLC slot at a time. Such small HTLCs sit below the dust limit,
  which the implementation's dust exposure limit bounds. This is general
  Lightning behaviour, to be measured in section 7.

### Liquidity

From T9. Channel sizes are assumptions.

| sats/min | Limit | Hold | Share of 10,000 outbound | Calls at once | Share of 50,000 | Calls at once |
|---|---|---|---|---|---|---|
| 2 | 10 | 70 | 0.7% | 142 | 0.1% | 714 |
| 2 | 60 | 420 | 4.2% | 23 | 0.8% | 119 |
| 2 | 240 | 1,680 | 17% | 5 | 3.4% | 29 |

The hold ties up that much outbound capacity for the length of the call and no
longer. At the default limit it is small for any channel a box would run. A
small starter channel is where `call_liquidity_insufficient` would first appear,
so the starter amount (node-side, `docs/STARTER-BALANCE.md`) should cover at
least one hold. The callee's inbound must also take the blocks.

## 3. The card

**Kind** says who owns the number:

- **Protocol**: the same everywhere, changed only in the node repo.
- **Node default**: the value a new box ships with. Each box sets its own, since
  the callee sets the price, so "standard" means a suggested default.
- **App default**: this repo; the user can change it.

| Item | Value | Kind | Note |
|---|---|---|---|
| Message | **1 sat**, decided | Node default | Anything higher hits the 6-sat cap. |
| File reference | **1 sat**, suggested | Node default | Same cap. A per-megabyte charge cannot be paid under a grant today. |
| Call offer | **5 sats**, decided | Node default | An unanswered call still costs it. Down from 10 reported. |
| Signal | **1 sat** | Node default | Floor. |
| Per minute | **2 sats**, decided | Node default | An hour is 120 sats to the person called, 0.72 DKK on the assumption. No sub-sat prices. |
| Block, grace, due time | 60 s, 10 s, 20 s, no change | Protocol | Nothing in the simulation asks for more. |
| `max_call_minutes` | **60**, decided | Node default; no node change | A box that sets its own value keeps it. The two test boxes report 10; a call there stops at 10 minutes. |
| Default contact budget | **1,000 sats a day**, suggested; owner has not set this | App default | Holds seven full 10-minute calls on ceilings at limit 60. Exposure per contact goes up 20 times, to 6 DKK a day on the assumption. |
| Default daily budget | **2,500 sats**, suggested; owner has not set this | App default | Equals the self-approval ceiling, so it can be approved in the app. Heavy loses at most one call. Worst day 15 DKK on the assumption. |
| Envelope default (`DEFAULT_BUDGET_MSAT`) | **1,000 sats**, suggested; owner has not set this | App default | Follows the contact budget; 200 rings no call at limit 60. |
| Per-payment limit | **50 sats**, decided | App and node default | Owner-changeable, inside the daily ceiling. On this card it covers the offer (10 all-in) and each minute (7 all-in); see section 6, item 2. Totals and holds bound the money either way, and messages keep their 6-sat cap. The Touch ID text must say "per payment", not "per message" (`device.rs` `intent_reason`). |
| Self-approval ceiling (#394) | **2,500 sats per 24 h, as a total**, decided | Node default | The owner can change it. |
| AI client budget | **1,000 sats per 24 h**, decided | Node default | 166 to 500 small actions a day (T13). The node's default breakers are the rate bound: 60 payments an hour at 6 sats all-in is 360 sats an hour, so the messaging budget lasts at least 167 minutes. No separate AI velocity limit. |
| Human grant breakers | 10 a minute, 60 an hour, 5 failures, 1,000 sats per 10 minutes, no change | Node default | Two rings fit in 10 minutes (T12). |
| Routing allowance | at least 5 sats, no change yet | App and node | Measure first (short answer). |
| Porch page | **1 sat** | Node default | The floor; all-in 6 fits the cap. |
| Front-door admission | **open** | Node default; node-repo change for more | See section 6. |
| Front-door message | **1 sat**, suggested | Node default | 10 sats plus routing exceeds the 6-sat cap, so later messages would be refused under a grant. |

The app's three presets and the first-contact choices are not re-tuned here. The
choices already follow the contact budget (x1, x2, x5, clamped to the daily total).
Facts to carry: on the card, Careful's contact budget of 50 rings no call, and
Everyday's 200 rings none at limit 60.

## 4. Interactions

- **Raising the contact budget raises exposure.** Per contact, 50 to 1,000 sats.
  The daily budget still caps the total, and a colluding contact gets that money
  at most once a day.
- **The self-grant limit in #394 is 50 sats, not the 6-sat cap.** A self grant
  signing `per_call_max_msat` at 6 sats would refuse every call (T3b, T4). The
  node's 6-sat cap on non-call payments is separate. Section 6, item 2.
- **In-app approval also depends on the box.** #394 needs device approvals, which
  the node turns off when the seed's password comes from a file or a flag
  (`owner_approval_key`, `crates/konsensus-node/src/main.rs:1087-1107`). Reported,
  to confirm: both real boxes are such boxes. Device approvals are being built as
  an owner-chosen setting; there the self-approval ceiling changes nothing until
  it ships.

## 5. What a first-time user should see

A call should never fail because of a default nobody chose. Plain words only; the
hold stays in the details.

| Moment | Dansk | English |
|---|---|---|
| Choosing for a new contact | Til opkald: op til 1 000 sats om dagen. Du betaler kun for det, I bruger. | For calls: up to 1,000 sats a day. You only pay for what you use. |
| Before Ring | 2 sats i minuttet. Et opkald kan vare op til 60 minutter. | 2 sats a minute. A call can last up to 60 minutes. |
| Budget too small | Der er ikke nok i budgettet til dette opkald. Hæv til 1 000 sats i dag? (Kræver punkt 3 nedenfor.) | There isn't enough in the budget for this call. Raise it to 1,000 sats today? (Needs item 3 below.) |
| After the call | Opkaldet kostede 28 sats. Resten er tilbage i dit budget. | The call cost 28 sats. The rest is back in your budget. |

Three changes would make this true, and all need work outside this document. A
fourth fact bounds them: **"Before Ring" is true only on a box at the node
default**; a box set to 10 must say 10, which needs item 1.

1. **Read the box limit before dialling** (node). The Ring text can then state the
   real hold instead of the 240-minute ceiling, and the app can see a budget that
   will not fit before anything happens.
2. **A shorter call instead of a refusal** (node). When the budget cannot hold the
   full limit, hold what fits and say so. 250 sats free would allow 33 minutes at
   limit 60, instead of no call. This removes most of finding 1.
3. **One tap to raise, at the moment of refusal** (node and app). The message box
   has this for messages, through a device-signed envelope, where device approvals
   are on. On an owner-written grant the app cannot do it: a recipient budget cannot
   be raised while the grant is live (`pairing.rs:3553-3585` in the node repository).
   So this needs a node change, must never raise silently, and until then the copy
   says a bigger budget is approved on the box's own computer (#399).

## 6. Owner decisions

Decided and no longer asked: the prices, the call limit, the self-approval ceiling,
the AI client budget and the per-payment limit (item 2). Items 1, 3 and 4 are open.

1. **How much may the app spend by default?** Suggested, not set: up to 1,000 sats
   a day to one person and 2,500 sats a day in total (about 6 and 15 DKK at the
   assumed price). The user can change both. If the phone or app were misused, that
   is the most that could go in a day.
2. **What per-payment limit goes on an envelope or a self grant? Decided by the
   owner: 50 sats,** inside the daily ceiling, an owner-changeable setting. On this
   card it covers the call payments: the offer, 10 sats all-in, and each minute, 7.
   A box on 10 sats a minute needs 15, and 50 fits an offer or a minute priced up to
   45 sats. It does not cover messages, files, a first contact or the closing
   hangup: those keep the node's 6-sat cap, which the app mirrors. The hold at Ring
   is checked against the budgets, not this limit. The tables already model 50
   (`PER_CALL_CAP_DEFAULT`). The app and node still have to change: today an envelope
   approved from the message box takes the message cost as its maximum (finding 4).
3. **Should a call get shorter instead of being refused?** Ask for this in the node
   repo, so a nearly used budget gives a shorter call rather than no call.
4. **What should a stranger pay to reach you for the first time?** Under an app's
   budget, the box allows only about 6 sats in total for that first message, so a
   100-sat door fee cannot be paid. Keep the fee at 1 sat, which stops little spam
   (10,000 fresh identities cost about 120 DKK), or ask the node repo to let you
   approve a larger amount. Routed first contacts need that too (node-side item 4).

## 7. Next step: a run without real funds

Run the card on regtest, then signet, with the existing two-node test bench
and call demo (`scripts/calls/regtest-demo.sh`, `scripts/real-ui-e2e/`) plus one
routing node between the boxes. Test funds only.

| Step | Do | Answers |
|---|---|---|
| 1 | Set the card's prices, limits 10 and 60, read `GET /pair/grant` and call status | Node-side items 1, 2, 7 |
| 2 | Run a regular and a heavy day at contact budgets 50, 250, 500, 1,000 | Refusal points against T3, T4; the first refusal must match |
| 3 | Run direct, 1-hop and 3-hop routes; record `fee_paid_msat` for 1-sat, 2-sat and 5-sat payments | Real routing against the 5-sat allowance; whether a 2-sat allowance would work |
| 4 | Run an hour-long call, repeated rings within 10 minutes and a burst of messages | Node-side item 3: that blocks count nothing more and holds count in full |
| 5 | Try a relation grant with a 6-sat envelope, then a 10-sat one, then a 50-sat one; try a first contact, routed and direct | Finding 4; node-side item 4 |
| 6 | Reach `max_call_minutes`; drop a block; shrink the channel until `call_liquidity_insufficient` | Node-side items 5, 6; the smallest workable channel |
| 7 | Run many short calls in parallel and watch HTLC slots and dust exposure | The channel-use claim above |

Pass condition: the simulation's first-refusal column matches in every case. Any
mismatch corrects the model first, then this card.
