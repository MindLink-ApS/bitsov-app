# Standard rates and budget defaults

Proposal for owner decision. Nothing here changes the app or a node. This is
product pricing, not financial advice.

Every table comes from the offline simulation, and more tables are there
(T1 to T13 with T7c and T11c, plus the full grid of 1,125 rate sets with `--csv`):

```sh
node scripts/simulate-rates.mjs
node scripts/simulate-rates.mjs --csv
```

Fiat figures use one editable assumption, not a market quote:
`BTC_PRICE_ASSUMPTION` = 600,000 DKK per BTC, so 1,000 sats = 6 DKK.

## The short answer

The 50-sat first-contact budget cannot hold one call, at any price the
simulation tried. Raising the budgets is cheap and fixes it, but other limits
must move with them, or calls still fail.

"Today" for the call limit means two different things, and they must not be
mixed: the **node default is 60 minutes**
(`crates/konsensus-node/src/config.rs:1333`), and the **two test boxes reported
10**, a value they have configured. A box left on the default needs **921 sats
free at Ring**. On it, the budgets 50, 100, 250 and 500 refuse every call, and
the 1,000 proposed below holds exactly one call with 79 sats beside it: 13
messages on ceilings, and no second call that day. That is why the card below
asks the node repo to lower the default to 30 rather than only raising budgets.

| Item | Today | Proposed |
|---|---|---|
| Message | 1 sat | 1 sat |
| Call offer | 10 sats | 10 sats |
| Per minute | 10 sats | 10 sats |
| Caller's call limit (`max_call_minutes`) | node default 60 min; the two test boxes 10 min (reported) | 30 min |
| First-contact admission | 100 in a fixture; **cannot be paid under a grant** | 1 sat, until the node lets a grant pay more |
| Default contact budget | 50 sats a day (Careful) | 1,000 sats a day |
| Default daily budget | 500 sats (Careful) | 2,500 sats |
| Per-payment limit on an envelope | 6 or 10 sats | 50 sats |
| In-app self-approval ceiling (#394) | 200 sats a day | 2,500 sats a day, as a 24-hour total |

At these numbers the regular profile (30 messages and two 10-minute calls a
day) is refused nothing and costs about 328 sats a day, or 59 DKK a month on
the assumption above. Most of that goes to the person called, not to the
network.

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
| Self-approval: 200 sats a day, 6-sat cap per message, 1 live, 3 per 24 h, 3-day cooldown | open draft #394, `docs/IN-APP-BUDGET-APPROVAL.md` on its branch | owner-accepted default |

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
| Offer 10 sats, signal 1 sat, per minute 10 sats | reported; the offer and signal also appear in `scripts/calls/media-check.py` | node-side |
| Block 60 s, next block due 20 s before the end, 10 s grace | `src/control/callMinutes.ts`, `docs/CALLS.md` | protocol |
| Routing allowance per block: the offer's allowance, so 5 sats | `control.rs` `with_call_blocks` | app, mirrors node |
| Hold = (price + allowance) x `max_call_minutes`, plus the closing hangup (its price and allowance, at least 1 sat). The offer is reserved with it, as its own charge | `CallSpendTerms`, `spend_budget/calls.rs:51-59`; `pairing/call_spend.rs` `reserve_call_with_offer` | node |
| `max_call_minutes`, node default **60**, allowed 1 to 240. It is the caller's cap | `crates/konsensus-node/src/config.rs:1333`, `docs/UPGRADING.md` in the node repository | node |
| `max_call_minutes` on the **two test boxes: 10**. A configured value (the node's call runbook uses 10 as its example). Not readable before the offer | reported; to confirm on each box | reported |
| Ceiling shown before Ring: 240 minutes, so 3,600 sats at these prices | `control.rs` `CALL_MAX_BLOCKS`, `docs/CALLS.md` | app |
| App check before the offer: offer plus one hangup against the budgets; largest single payment against the per-payment limit | `src-tauri/src/app.rs` `do_call_signal`, `src/control/call.ts` `callPerPaymentNeed` | app |
| Calls go only to contacts already paid; the first contact is a message | `app.rs` `call_needs_contact` | app |

### The field test, 1 November (reported)

67 sats for the day, including a call of about 5 minutes at 60 sats. A 47-sat
remainder refused a call. The box's recipient budget had to be re-approved at 250.

The simulation agrees with all three:

- At the test boxes' limit of 10, a call needs 171 sats free at Ring (T11): 15
  for the offer and 156 for the hold, which is 150 for the minutes and 6 for the
  hangup. So 47 sats passes the app's own check for the offer and
  hangup (21 sats), then fails at the hold.
- Of the Careful choices 50, 100 and 250, only 250 holds one call.
- 60 sats fits the offer plus 5 blocks, a call of 3:40 to 4:40 (T11b). A full
  5:00 pays 6 blocks, 70 sats with the offer, so that decomposition is an
  inference. 60 rather than 90 (the same payments with full allowances) also
  suggests the day's figure counted fees paid. To be confirmed on the node.

The field test says nothing about a box on the node default. There the same
numbers need 921 sats (T11c), so none of those budgets would have rung.

### Node-side

Answered from the node source: the hold covers the hangup and the offer comes
with it, so 171 and 921 are exact at these prices. Defaults for the breakers are
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
7. What are the default prices a new box advertises?

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

### One call

From T1. The "hold" column is the limit times the all-in minute, even for a short
call. "Free at Ring" adds the hangup (6 sats, also held) and the offer (15).

| sats/min | box limit | each min, all-in | hold | free at Ring | allowance share | 10-min call, price only |
|---|---|---|---|---|---|---|
| 1 | 10 | 6 | 60 | 81 | 83% | 21 |
| 2 | 30 | 7 | 210 | 231 | 71% | 33 |
| 5 | 30 | 10 | 300 | 321 | 50% | 66 |
| 10 | 10 (test boxes) | 15 | 150 | 171 | 33% | 111 |
| 10 | 30 | 15 | 450 | 471 | 33% | 121 |
| 10 | 60 (node default) | 15 | 900 | 921 | 33% | 121 |
| 20 | 30 | 25 | 750 | 771 | 20% | 231 |

### Does a call fit, and how many?

From T2: full 10-minute calls a day inside one contact budget (`ceiling/actual`;
`0/0` means one call does not fit). Budget in sats.

| sats/min | limit | 50 | 250 | 500 | 1,000 | 2,500 |
|---|---|---|---|---|---|---|
| 1 | 10 | 0/0 | 3/6 | 6/13 | 12/28 | 30/74 |
| 5 | 10 | 0/0 | 2/2 | 4/6 | 8/13 | 20/33 |
| 10 | 10 | 0/0 | 1/1 | 2/3 | 5/7 | 14/19 |
| 20 | 10 | 0/0 | 0/0 | 1/2 | 3/4 | 9/10 |
| 1 | 30 | 0/0 | 1/2 | 4/9 | 10/23 | 27/66 |
| 5 | 30 | 0/0 | 0/0 | 2/3 | 6/9 | 17/28 |
| 10 | 30 | 0/0 | 0/0 | 1/1 | 3/4 | 11/16 |
| 20 | 30 | 0/0 | 0/0 | 0/0 | 1/1 | 6/8 |
| 10 | 60 (node default) | 0/0 | 0/0 | 0/0 | 1/1 | 9/12 |

### What refuses first

From T3, the first call of a fresh day at 10 sats a minute. A 50-sat contact
budget passes the app's check and fails at the node's hold.

| Contact budget | Test boxes: limit 10, daily 1,000+ | Limit 30, daily 200 | Limit 30, daily 1,000+ | Node default: limit 60, daily 1,000+ |
|---|---|---|---|---|
| 50 | contact, at hold | daily, at hold | contact, at hold | contact, at hold |
| 250 | rings | daily, at hold | contact, at hold | contact, at hold |
| 500 | rings | daily, at hold | rings | contact, at hold |
| 1,000 | rings | daily, at hold | rings | rings, once |
| 2,500 | rings | daily, at hold | rings | rings |

With a per-payment limit of 6 or 10 sats, every call is refused before any
budget is looked at, because the largest single payment is 15 sats (25 at 20
sats a minute; T3b).

### Profiles

From T4: cost as `actual`, refusals as `ceiling/actual`. All rate sets use 1 sat
a message. Sets use 10 sats a minute unless named. The T4 month is 30 such days.

| Rate set | Profile | Sats/day | Sats/month | DKK/month (assumed) | Free at Ring | Refused | First refusal |
|---|---|---|---|---|---|---|---|
| Node default limit 60: 50 / 500 | light | 6 | 180 | 1.08 | - | 0/0 | none |
| | regular | 46 | 1,380 | 8.28 | - | 75%/28% | contact budget |
| | heavy | 200 | 6,000 | 36 | - | 62%/5% | daily, at hold |
| Node default limit 60: 1,000 / 2,500 | regular | 194 | 5,820 | 35 | 921 | 3%/3% | contact, at hold |
| | heavy | 2,219 | 66,570 | 399 | 921 | 16%/2% | daily, at hold |
| Node default limit 60: 2,500 / 2,500 | regular | 328 | 9,840 | 59 | 921 | 0/0 | none |
| | heavy | 2,219 | 66,570 | 399 | 921 | 3%/2% | daily, at hold |
| Test boxes limit 10: 50 / 500 | regular | 46 | 1,380 | 8.28 | - | 75%/28% | contact budget |
| | heavy | 200 | 6,000 | 36 | - | 62%/5% | contact, at hold |
| | AI client | 138 | 4,140 | 25 | - | 88%/66% | contact budget |
| Test boxes limit 10: as re-approved, 250 / 500 | regular | 183 | 5,490 | 33 | 171 | 56%/3% | contact budget |
| | heavy | 446 | 13,380 | 80 | 171 | 48%/3% | daily, at hold |
| #394 today, limit 10: 200 / 200, per-call 6 | regular | 60 | 1,800 | 11 | - | 6%/6% | per-call cap |
| #394 today, limit 10: 200 / 200, per-call 50 | regular | 183 | 5,490 | 33 | 171 | 6%/3% | daily, at hold |
| #394 today, limit 60: 200 / 200, per-call 50 | regular | 60 | 1,800 | 11 | - | 6%/6% | daily, at hold |
| 2 sats a min: 250 / 1,000, limit 30 | regular | 60 | 1,800 | 11 | - | 6%/6% | contact, at hold |
| **Proposed: 1,000 / 2,500, limit 30** | light | 6 | 180 | 1.08 | - | 0/0 | none |
| | regular | 328 | 9,840 | 59 | 471 | 0/0 | none |
| | heavy | 1,915 | 57,450 | 345 | 471 | 1%/0% | daily, at hold |
| | AI client | 400 | 12,000 | 72 | - | 0/0 | none |
| | porch reader | 60 | 1,800 | 11 | - | 0/0 | none |
| Same budgets, limit 10 | regular | 306 | 9,180 | 55 | 171 | 0/0 | none |
| Long calls: 2,500 / 10,000, limit 60 | heavy | 3,565 | 106,950 | 642 | 921 | 0/0 | none |

Across the grid (T5, `ceiling`), the share of rate sets refusing nothing: light
33%, regular 11%, heavy 9%, AI client 12%, porch reader 100%. Light tops out at
33% because a message above 1 sat is refused (next section).

Smallest candidate budgets refusing nothing at 10 sats a minute (T5c,
contact / daily):

| Box limit | Regular | Heavy |
|---|---|---|
| 10 | 1,000 / 1,000 | 500 / 2,500 |
| 30 | 1,000 / 1,000 | 1,000 / 5,000 |
| 60 (node default) | 2,500 / 2,500 | 2,500 / 10,000 |

Regular needs a higher contact budget than heavy because its day goes to one contact.

### Findings

1. **The hold, not the cost, is the failure.** A 2-minute call needs the same
   free amount at Ring as a 30-minute one. The rest is released afterwards.
2. **The routing floor limits how cheap a call can get.** At 1 sat a minute the
   allowance is 83% of each minute. Cutting the price from 10 to 1 sat lowers
   the hold only from 15 to 6 sats a minute.
3. **A message cannot cost more than 1 sat under a grant today.** 1 sat plus the
   5-sat allowance is exactly the 6-sat cap. At 2 or 5 sats every message is
   refused: 375 rate sets each (T5b). The same holds for a file, and for the
   10-sat message in the front-door fixture.
4. **A per-payment limit below 15 sats blocks all calls.** An envelope approved
   from the message box takes the message cost as its per-act maximum, about 6
   sats. The default without a quote is 10. On a relation grant, `check_under`
   then refuses any call with `grant_per_call`. This comes from reading the code in
   both repos (`spend_budget/calls.rs:168` in the node), not from a test; section 7,
   step 5 tests it.
5. **What a budget buys depends on fee reporting.** 200 sats is 33 messages on
   ceilings and 100 on 1-sat fees (T5b). The chip's message count divides the
   budget by the shown message cost; check it stays all-in when this changes.
6. **The Ring text names the wrong number.** It shows the 240-minute ceiling,
   3,600 sats, because the box limit cannot be read before the offer. A
   first-time user sees a figure 8 times the real hold at limit 30, and 4 times
   at the node default.
7. **On a default box, one call a budget.** At limit 60 a 1,000-sat contact budget
   holds one call. The default breaker of 1,000 sats per 10 minutes also allows
   only one ring in 10 minutes, because a ring counts its whole 921 sats even when
   the call was short (T12). At limit 30 that is two rings, at limit 10 five.
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

| Daily budget | Worst per day | DKK (assumed) | Worst with 3 self grants in 24 h | DKK | 10-min calls that ring |
|---|---|---|---|---|---|
| 200 | 200 | 1.20 | 600 | 3.60 | 0 |
| 1,000 | 1,000 | 6 | 3,000 | 18 | 3 |
| 2,500 | 2,500 | 15 | 7,500 | 45 | 11 |
| 5,000 | 5,000 | 30 | 15,000 | 90 | 25 |
| 10,000 | 10,000 | 60 | 30,000 | 180 | 52 |

Per contact, the worst is the contact budget, bounded by the daily one: 1,000
sats, or 6 DKK a day, per contact. Three colluding contacts reach a 2,500
budget. The last column uses the proposed rates at limit 30.

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
1,000 rings at 10 sats is 10,000 sats (T7b). The sender-side rule that calls go
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
- **Per-minute blocks make sense from about 5 sats.** At 1 sat a minute, 1 sat of
  routing would be half of what is paid in an hour; at 10 sats, 9% (T8c).
  Prepaying 5 minutes at a time would cut routing to a fifth but overpay on short
  calls, and the block length is a protocol constant. Keep it.
- **Channel use.** Blocks are small, sequential and settle quickly, so they
  should use one HTLC slot at a time. Such small HTLCs sit below the dust limit,
  which the implementation's dust exposure limit bounds. This is general
  Lightning behaviour, to be measured in section 7.

### Liquidity

From T9. Channel sizes are assumptions.

| sats/min | Limit | Hold | Share of 10,000 outbound | Calls at once | Share of 50,000 | Calls at once |
|---|---|---|---|---|---|---|
| 10 | 10 | 150 | 1.5% | 66 | 0.3% | 333 |
| 10 | 30 | 450 | 4.5% | 22 | 0.9% | 111 |
| 10 | 60 | 900 | 9% | 11 | 1.8% | 55 |
| 10 | 240 | 3,600 | 36% | 2 | 7.2% | 13 |

The hold ties up that much outbound capacity for the length of the call and no
longer. At the proposed limit it is small for any channel a box would run. A
small starter channel is where `call_liquidity_insufficient` would first appear,
so the starter amount (node-side, `docs/STARTER-BALANCE.md`) should cover at
least one hold. The callee's inbound must also take the blocks.

## 3. The recommendation

**Kind** says who owns the number:

- **Protocol**: the same everywhere, changed only in the node repo.
- **Node default**: the value a new box ships with. Each box sets its own, since
  the callee sets the price, so "standard" means a suggested default.
- **App default**: this repo; the user can change it.

| Item | Today | Proposed | Kind | Why, and the tradeoff |
|---|---|---|---|---|
| Message | 1 sat | **1 sat** | Node default | Anything higher hits the 6-sat cap. Raising it needs the cap or floor moved in both repos. Neither this nor today's payable admission stops determined spam (see Spam). |
| File reference | Node's kind-200 price; 3 in test configs | **1 sat** | Node default | Same cap. A per-megabyte charge cannot be paid under a grant today. |
| Call offer | 10 sats | **10 sats** | Node default | One minute's price. Pays for the ring, and 1,000 unwanted rings cost 10,000 sats. An unanswered call still costs it. |
| Signal | 1 sat | **1 sat** | Node default | Floor. |
| Per minute | 10 sats | **10 sats** | Node default | Keeps routing a minor part. Already tested live. An hour is 600 sats, 3.60 DKK on the assumption, paid to the person called. 5 sats would lower the hold by a third; below that the routing floor dominates. |
| Block, grace, due time | 60 s, 10 s, 20 s | **no change** | Protocol | Short enough to limit loss on either side; nothing in the simulation asks for more. |
| `max_call_minutes`, the caller's cap | Node default 60; the two test boxes 10 (reported, configured) | **30** | Node default; node-repo change | For a new box this **lowers** the default. At 60, a call needs 921 sats free at Ring, one contact budget of 1,000 holds one call (`1/1`), and the breaker allows one ring in 10 minutes. At 30 it needs 471 sats, holds three to four full calls, and allows two rings in 10 minutes. A call that stops at 30 minutes is the cost. For the two test boxes this raises the limit from 10; a call cut off at 10 minutes is a failure for the person using it. The extra is held, not spent. A box that sets its own value keeps it. |
| Default contact budget | 50 sats a day | **1,000 sats a day**, which depends on the limit above | App default | Regular refuses nothing at limit 10 or 30, and three to five full calls fit. **On a box still at the default limit of 60 it is not enough:** one call rings, 79 sats stay beside it, and the regular day has a refusal. Exposure per contact goes up 20 times, to 6 DKK a day on the assumption. |
| First-contact choices | 50, 100, 250 | **Kun beskeder 250; Til opkald 1,000, preselected; Til lange opkald 2,500** | App default | "Til opkald" is the default, so a call works without a second decision at limit 30 or lower. At the node default of 60 it is one call, and only "Til lange opkald" allows more. Do not show the label as a promise until the limit is known. 250 says plainly that it is for messages. |
| Default daily budget | 500 (Careful) | **2,500 sats** | App default | Eleven 10-minute calls across contacts, and heavy loses at most one call. Worst day 15 DKK on the assumption. |
| Presets, daily / contact | see section 1 | **Careful 1,000 / 1,000; Everyday 2,500 / 1,000 (default); Generous 10,000 / 2,500** | App default | No preset may refuse a call. Careful keeps the smallest worst day. Room budgets are not simulated and stay as they are. |
| Envelope default (`DEFAULT_BUDGET_MSAT`) | 200 sats | **1,000 sats** | App default | Same reasoning as the contact budget. |
| Per-payment limit | 6 or 10 on envelope paths | **50 sats** | App and node default | Fits calls up to about 45 sats a minute. No added exposure: totals and holds still bound it, and messages keep their 6-sat cap. The Touch ID text must then say "per payment", not "per message" (`device.rs` `intent_reason`). |
| Self-approval ceiling (#394) | 200 sats a day | **2,500 sats, as a total over 24 h** | Node rule, owner decision | See section 4. |
| AI client grant | none | **1,000 sats a day, recipients only, 6-sat per-payment cap, not auto-renewed. Open owner decision: reported, the owner may have said 100 sats; confirm** | Node default, owner decision | 166 to 500 actions a day (T13), against 16 to 50 at 100 sats. A refusal is safe for a program, so a low default is right. 6 DKK worst day on the assumption. No 100-sat decision is written in `docs/AI-MCP-DESIGN.md` (its section 9, item 3 leaves the maximum open), so 1,000 stays until confirmed. |
| AI client velocity | none | **10 a minute, 120 an hour, 100 sats per 10 minutes, pause after 3 failures** | Node default | Stretches a stolen grant's drain to at least 100 minutes, time to notice it. |
| Human grant breakers | Node default: 10 a minute, 60 an hour, 5 failures, 1,000 sats per 10 minutes | **no change at limit 30** | Node default | An hour of blocks counts no further payments, so the hour limit has room. Two rings fit in 10 minutes at 471 sats each (T12). If the limit stays at 60, raise the amount to at least 2,000 sats per 10 minutes, or a second ring within 10 minutes is refused. |
| Routing allowance | at least 5 sats | **no change yet** | App and node | At 2 sats a block the limit-30 hold falls 20%, from 450 to 360 sats (T1b), but more routes could fail. Measure first. |
| Porch page | 1 sat | **1 sat** | Node default | The floor; all-in 6 fits the cap. |
| Front-door admission | Fixture 100 sats | **1 sat, the floor, unless the node changes.** Owner decision | Node default; node-repo change for more | A 100-sat admission cannot be paid under a grant, so every stranger on a paired app would be refused at the door (T7c). The cost is a weak brake: 10,000 fresh identities cost about 120 DKK, not 6,060. For a real brake, the node needs a first-contact limit above the 6-sat message cap, approved by the owner; then 100 sats is the option to weigh. Routed first contacts need that too (node-side item 4). |
| Front-door message | Fixture 10 sats | **1 sat** | Node default | 10 sats plus routing exceeds the 6-sat cap, so later messages would be refused under a grant. |
| Packages | none | **none yet** | Owner | At 1-sat reads a package saves little, and nothing in the repo uses one. |

### If the owner picks another limit

- **10 minutes.** Everything else stands. The regular result is the same (306 sats
  a day, no refusals) and a 1,000-sat contact budget holds five full calls. The
  tradeoff is calls that stop at 10 minutes. It is what the test boxes run, not
  what a new box gets, so it still needs the node default changed or each box
  configured.
- **60 minutes, the node default, with no node change.** A call needs 921 sats free
  at Ring. The contact and daily defaults must then both be **2,500 sats** for the
  regular day to refuse nothing (T5c), the first-contact choices become 1,000 for
  one call and 2,500 for more, and the breaker's amount must rise to at least
  2,000 sats per 10 minutes. Worst day per contact goes from 6 to 15 DKK on the
  assumption.

### Where the money goes

Most of a call's cost is paid to the other person. When two boxes call each
other, money mostly moves between them and only routing leaves. Monthly figures
in section 2 are gross, not net.

## 4. Interactions

- **Raising the contact budget raises exposure.** Per contact, 50 to 1,000 sats.
  The daily budget still caps the total, and a colluding contact gets that money
  at most once a day.
- **200 sats a day is too low to approve a working budget in the app.** At the
  test boxes' limit of 10 it holds one call and leaves 29 sats when that call runs
  to the limit, so the next call is refused and four more messages fit on
  ceilings. At limit 30, and at the node default of 60, it holds no call at all
  (T10, T11c).
  An owner who needs more is sent to the node's computer, which is what #394 set
  out to remove.
- **The 6-sat cap in #394 must not become the call limit.** #394 says the ceiling
  also bounds the per-call maximum, and states the ceiling "with the node's 6-sat
  cap per message". A self grant signing `per_call_max_msat` at 6 sats refuses
  every call (T3b, T4). It should sign 50 sats and let the node keep the
  6-sat message cap separately.
- **In-app approval also depends on the box.** #394 needs device approvals, which
  the node turns off when the seed's password comes from a file or a flag
  (`owner_approval_key`, `crates/konsensus-node/src/main.rs:1087-1107`). Reported,
  to confirm: both real boxes are such boxes. There the self-approval ceiling
  changes nothing until the node has a policy for them.
- **Three self grants triple the worst case.** At 2,500 sats, 3 self grants a day
  would reach 7,500 sats, or 45 DKK on the assumption.

**Recommendation for #394:** a ceiling of 2,500 sats, counted as a total across
self grants in any 24 hours, so the worst day stays at 2,500 sats, and a signed
per-payment limit of 50 sats. If the owner wants a smaller ceiling, 1,000 sats is
the lowest that still works (regular refused nothing, T10), and the default daily
budget should then also be 1,000. A default above the ceiling could not be
approved in the app.

This changes an owner-accepted default, so it is a decision below.

## 5. What a first-time user should see

A call should never fail because of a default nobody chose. Plain words only; the
hold stays in the details.

| Moment | Dansk | English |
|---|---|---|
| Choosing for a new contact | Til opkald: op til 1 000 sats om dagen. Du betaler kun for det, I bruger. | For calls: up to 1,000 sats a day. You only pay for what you use. |
| Before Ring | 10 sats i minuttet. Et opkald kan vare op til 30 minutter. | 10 sats a minute. A call can last up to 30 minutes. |
| Budget too small | Der er ikke nok i budgettet til dette opkald. Hæv til 1 000 sats i dag? (Kræver punkt 3 nedenfor.) | There isn't enough in the budget for this call. Raise it to 1,000 sats today? (Needs item 3 below.) |
| After the call | Opkaldet kostede 121 sats. Resten er tilbage i dit budget. | The call cost 121 sats. The rest is back in your budget. |

Three changes would make this true, and all need work outside this document. A
fourth fact bounds them: **"Before Ring" is true only when the limit is 30**, so
the node default has to change first (section 3).

1. **Read the box limit before dialling** (node). The Ring text can then state the
   real hold instead of the 240-minute ceiling, and the app can see a budget that
   will not fit before anything happens.
2. **A shorter call instead of a refusal** (node). When the budget cannot hold the
   full limit, hold what fits and say so. 250 sats free would allow 15 minutes at
   limit 30, instead of no call. This removes most of finding 1.
3. **One tap to raise, at the moment of refusal** (node and app). The message box
   has this for messages, through a device-signed envelope, where device approvals
   are on. On an owner-written grant the app cannot do it: a recipient budget cannot
   be raised while the grant is live (`pairing.rs:3553-3585` in the node repository).
   So this needs a node change, must never raise silently, and until then the copy
   says a bigger budget is approved on the box's own computer (#399).

### Who owns what

| App defaults (this repo) | Node defaults (node repo) | Owner decisions |
|---|---|---|
| Presets and first-contact choices | Message, signal, offer and per-minute prices | The call limit |
| `DEFAULT_BUDGET_MSAT` | `max_call_minutes` default (60 today) | The contact and daily defaults |
| Envelope per-payment limit and its Touch ID text | Grant per-payment default, breakers, AI client defaults | The self-approval ceiling |
| Ring and refusal copy | Front-door and file prices; self-approval rule (#394); device approvals on boxes whose password comes from a file or a flag | Prices to suggest |
| | Pre-dial limit read, shorter-call hold, raising a contact's budget on a live grant, a first-contact limit above 6 sats | Whether to ask the node repo for the shorter call; the first-contact limit; the AI client grant |

## 6. Owner decisions

1. **How long may a call last?** Up to 30 minutes on a new box. Today a new box
   allows 60 and your two test boxes are set to 10. At 60 almost 1,000 sats are set
   aside for every call, so one person's budget covers only one call a day. Only
   what is used gets paid.
2. **How much may the app spend by default?** Up to 1,000 sats a day to one person
   and 2,500 sats a day in total (about 6 and 15 DKK at the assumed price). If the
   phone or app were misused, that is the most that could go in a day.
3. **How much may be approved in the app itself?** Raise the Touch ID limit from
   200 to 2,500 sats a day as a total, because 200 is not enough for two calls.
   This reopens a limit you already accepted.
4. **Which prices should new boxes suggest?** Keep 10 sats a minute and 1 sat a
   message. Each box can still set its own.
5. **Should a call get shorter instead of being refused?** Ask for this in the node
   repo, so a nearly used budget gives a shorter call rather than no call.
6. **What should a stranger pay to reach you for the first time?** Under an app's
   budget, the box allows only about 6 sats in total for that first message, so a
   100-sat door fee cannot be paid. Keep the fee at 1 sat, which stops little spam,
   or ask the node repo to let you approve a larger amount.
7. **How much may an AI client spend in a day?** Proposed 1,000 sats. Reported: you
   may have said 100 sats; please confirm. At 100 sats a client gets about 16 to 50
   small actions a day instead of 166 to 500.

## 7. Next step: a run without real funds

Run the proposed card on regtest, then signet, with the existing two-node test bench
and call demo (`scripts/calls/regtest-demo.sh`, `scripts/real-ui-e2e/`) plus one
routing node between the boxes. Test funds only.

| Step | Do | Answers |
|---|---|---|
| 1 | Set the proposed prices, limits 10, 30 and 60, read `GET /pair/grant` and call status | Node-side items 1, 2, 7 |
| 2 | Run a regular and a heavy day at contact budgets 50, 250, 500, 1,000 | Refusal points against T3, T4; the first refusal must match |
| 3 | Run direct, 1-hop and 3-hop routes; record `fee_paid_msat` for 1-sat and 10-sat payments | Real routing against the 5-sat allowance; whether a 2-sat allowance would work |
| 4 | Run an hour-long call, repeated rings within 10 minutes and a burst of messages | Node-side item 3: that blocks count nothing more and holds count in full |
| 5 | Try a relation grant with a 6-sat envelope, then a 50-sat one; try a first contact, routed and direct | Finding 4; node-side item 4 |
| 6 | Reach `max_call_minutes`; drop a block; shrink the channel until `call_liquidity_insufficient` | Node-side items 5, 6; the smallest workable channel |
| 7 | Run many short calls in parallel and watch HTLC slots and dust exposure | The channel-use claim above |

Pass condition: the simulation's first-refusal column matches in every case. Any
mismatch corrects the model first, then this card.
