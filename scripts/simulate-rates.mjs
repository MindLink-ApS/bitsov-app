#!/usr/bin/env node
// Simulates standard sats rates and budget defaults for BitSov. See docs/STANDARD-RATES.md.
//
// Plain Node, no dependencies, offline and deterministic: no network, no clock,
// no randomness. Same input, same bytes out.
//
//   node scripts/simulate-rates.mjs          the tables
//   node scripts/simulate-rates.mjs --csv    every rate set and profile, as CSV
//
// All amounts are integer msat inside the model and whole sats in the tables.
// This is product pricing, not financial advice. It moves no funds.

// ---- assumptions: editable, and not facts ------------------------------------

/** ASSUMPTION, not a market quote: a round number to make sats readable. Edit it. */
const FIAT_CODE = 'DKK';
const BTC_PRICE_ASSUMPTION = 600_000;
/** ASSUMPTION: what one payment really costs in routing, for the "actual" column. One hop at a 1-sat base fee. */
const ACTUAL_ROUTING_MSAT = 1_000;
/** ASSUMPTION: the per-payment limit in the model. An owner-written grant defaults to its whole budget (node cli.rs `per_call`); an envelope uses its per-act maximum. */
const PER_CALL_CAP_DEFAULT = 50_000;
/** ASSUMPTION: the caller's outbound capacity in the profile runs. Node-side; large enough not to bind here. */
const OUTBOUND_DEFAULT = 1_000_000_000;

// ---- values read from this repo (file references in docs/STANDARD-RATES.md) ---

const SAT = 1_000;
/** src-tauri/src/act.rs MIN_PAYMENT_MSAT; src-tauri/src/porch.rs MIN_READ_MSAT */
const MIN_PAYMENT = 1 * SAT;
/** src-tauri/src/grant.rs MESSAGING_PER_CALL_MAX_MSAT */
const MESSAGE_CAP = 6 * SAT;
/** src-tauri/src/device.rs default_per_act: the envelope's per-act maximum without a quote */
const ENVELOPE_PER_ACT_DEFAULT = 10 * SAT;
/** src-tauri/src/budget.rs MAX_DAILY_MSAT */
const APP_MAX_DAILY = 100_000 * SAT;
/** docs/CONTROL_CENTER_ACT.md: first-contact admission, capped by the node */
const ADMISSION_CAP = 100 * SAT;
/** docs/NODE_RC11_UPGRADE.md: the admission floor */
const ADMISSION_FLOOR = 1 * SAT;
/** src/control/callMinutes.ts: a block buys 60 s; docs/CALLS.md and the same file: the next one is due 20 s before it ends */
const BLOCK_SECONDS = 60;
const BLOCK_DUE_BEFORE_END_SECONDS = 20;

/** src-tauri/src/act.rs routing_fee */
const routingFee = (principal) => (principal === 0 ? 0 : Math.min(Math.max(Math.floor(principal / 100), 5_000), 10_000));

// ---- read from the node repository at commit b3f1ad1 ---------------------------

/** crates/konsensus-node/src/config.rs:1333 default_max_call_minutes: what a box uses unless its config sets another value */
const NODE_DEFAULT_LIMIT = 60;
/** crates/konsensus-api/src/spend_budget.rs:138-147 BreakerLimits::default */
const BREAKERS = { perMinute: 10, perHour: 60, failures: 5, msatPer10Min: 1_000_000 };

// ---- reported by the owner's box and test; node-side, to be confirmed --------

/** The `max_call_minutes` the two test boxes reported. A configured value, not the node default. */
const TEST_BOX_LIMIT = 10;

const SIGNAL = 1 * SAT;
const PAGE = 1 * SAT;
/** The prices the two test boxes ran in the field test of 1 November. Only the replay in T11 uses them. */
const FIELD_OFFER = 10 * SAT;
const FIELD_BLOCK = 10 * SAT;

// ---- the standard card: decided by the owner -----------------------------------

/** Message 1, offer 5, minute 2 sats; call limit 60 minutes (the node default). No sub-sat prices. */
const CARD = { message: 1 * SAT, offer: 5 * SAT, block: 2 * SAT, limit: NODE_DEFAULT_LIMIT };
/** Suggested contact and daily defaults; the owner has not set these. Both are changeable. */
const SUGGESTED_CONTACT = 1000 * SAT;
const SUGGESTED_DAILY = 2500 * SAT;
/** Decided by the owner: the AI client budget per 24 h. */
const AI_BUDGET = 1000 * SAT;

// ---- the model -----------------------------------------------------------------

/** A rate set. Prices in msat; `limit` in minutes. */
const rates = (o = {}) => ({
  block: CARD.block, message: CARD.message, limit: CARD.limit, contact: SUGGESTED_CONTACT, daily: SUGGESTED_DAILY,
  perCall: PER_CALL_CAP_DEFAULT, offer: CARD.offer, blockFee: null, outbound: OUTBOUND_DEFAULT, ...o,
});

const fee = (r) => r.blockFee ?? routingFee(r.offer);
const perMinute = (r) => r.block + fee(r);
/** The minutes of the hold: (price + routing allowance) x the caller's max_call_minutes. The node adds the closing hangup to the same reservation. */
const holdOf = (r) => perMinute(r) * r.limit;
const offerAllIn = (r) => r.offer + routingFee(r.offer);
const hangupAllIn = () => SIGNAL + routingFee(SIGNAL);
/** The app's own check before the offer (src-tauri/src/app.rs): offer plus one hangup. */
const preflightOf = (r) => offerAllIn(r) + hangupAllIn();
/** What must be free at Ring: the hold (minutes + closing hangup) and the offer, reserved together (node handlers/messages/compose.rs, pairing/call_spend.rs). */
const ringNeed = (r) => preflightOf(r) + holdOf(r);
/** src/control/call.ts callPerPaymentNeed */
const perPaymentNeed = (r) => Math.max(offerAllIn(r), hangupAllIn(), perMinute(r));

/** Block 0 at the answer; block k is paid 20 s before minute k starts, while the call runs; the hold ends it at the limit. */
function blocksPaid(seconds, limit) {
  let blocks = 1;
  for (let k = 1; BLOCK_SECONDS * k - BLOCK_DUE_BEFORE_END_SECONDS < seconds; k++) blocks++;
  return Math.min(blocks, limit);
}

const callCost = (r, minutes) => {
  const blocks = blocksPaid(minutes * 60, r.limit);
  return {
    blocks,
    ceiling: preflightOf(r) + blocks * perMinute(r),
    actual: r.offer + SIGNAL + blocks * r.block + (blocks + 2) * ACTUAL_ROUTING_MSAT,
    principal: r.offer + SIGNAL + blocks * r.block,
  };
};
const paidAction = (price) => ({ ceiling: price + routingFee(price), actual: price + ACTUAL_ROUTING_MSAT });

/** Why a call is refused, in the order the host and node check it (grant.rs check_under, then the hold). Null if it rings. */
function callRefusal(r, contactLeft, dailyLeft) {
  if (perPaymentNeed(r) > r.perCall) return 'per-call cap';
  if (preflightOf(r) > dailyLeft) return 'daily budget';
  if (preflightOf(r) > contactLeft) return 'contact budget';
  if (ringNeed(r) > dailyLeft) return 'daily, at hold';
  if (ringNeed(r) > contactLeft) return 'contact, at hold';
  if (holdOf(r) > r.outbound) return 'channel, at hold';
  return null;
}

function actionRefusal(cost, contactLeft, dailyLeft) {
  if (cost > MESSAGE_CAP) return 'message cap';
  if (cost > dailyLeft) return 'daily budget';
  if (cost > contactLeft) return 'contact budget';
  return null;
}

/** One day of one profile. `mode` is what the budgets count: `ceiling` (allowance kept) or `actual` (the node reports the fee paid). */
function simulateDay(r, events, mode) {
  const contact = Math.min(r.contact, r.daily);
  const left = new Map();
  let daily = r.daily;
  let refused = 0;
  let first = null;
  let actual = 0;
  let maxHold = 0;
  for (const e of events) {
    const contactLeft = e.unbudgeted ? Infinity : left.get(e.to) ?? contact;
    let why;
    let spent = 0;
    if (e.kind === 'call') {
      why = callRefusal(r, contactLeft, daily);
      if (!why) {
        const c = callCost(r, e.minutes === 'limit' ? r.limit : e.minutes);
        spent = c[mode];
        actual += c.actual;
        maxHold = Math.max(maxHold, ringNeed(r));
      }
    } else {
      const c = paidAction(e.kind === 'page' ? PAGE : r.message);
      why = actionRefusal(c.ceiling, contactLeft, daily);
      if (!why) {
        spent = c[mode];
        actual += c.actual;
      }
    }
    if (why) {
      refused++;
      first ??= why;
    } else {
      daily -= spent;
      if (!e.unbudgeted) left.set(e.to, contactLeft - spent);
    }
  }
  return { attempts: events.length, refused, first, actual, maxHold };
}

/** Spread `messages` evenly around `calls`, so a day has no lucky order. */
function day({ messages, calls = 0, minutes = 10, contacts = 1, kind = 'msg', unbudgeted = false }) {
  const events = [];
  const stretches = calls + 1;
  let sent = 0;
  for (let b = 0; b < stretches; b++) {
    const upto = Math.round((messages * (b + 1)) / stretches);
    for (; sent < upto; sent++) events.push({ kind, to: sent % contacts, unbudgeted });
    if (b < calls) events.push({ kind: 'call', to: b % contacts, minutes });
  }
  return events;
}

const PROFILES = [
  ['light', day({ messages: 3 })],
  ['regular', day({ messages: 30, calls: 2, minutes: 10 })],
  ['heavy', day({ messages: 100, calls: 5, minutes: 'limit', contacts: 5 })],
  ['ai client', day({ messages: 200, contacts: 3 })],
  ['porch reader', day({ messages: 30, contacts: 5, kind: 'page', unbudgeted: true })],
];
const REGULAR = PROFILES[1][1];
const HEAVY = PROFILES[2][1];

/** Sequential full calls of `minutes` that ring inside one budget. */
function fullCalls(r, minutes, mode) {
  let contact = Math.min(r.contact, r.daily);
  let daily = r.daily;
  let n = 0;
  while (!callRefusal(r, contact, daily) && n < 1000) {
    const spent = callCost(r, minutes)[mode];
    contact -= spent;
    daily -= spent;
    n++;
  }
  return n;
}

// ---- output helpers --------------------------------------------------------------

const out = [];
const say = (line = '') => out.push(line);
const grouped = (text) => text.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const sats = (msat) => {
  const value = msat / SAT;
  return grouped(Number.isInteger(value) ? String(value) : value.toFixed(1));
};
const fiat = (msat) => {
  const value = ((msat / SAT) * BTC_PRICE_ASSUMPTION) / 100_000_000;
  return `${value < 10 ? value.toFixed(2) : grouped(value.toFixed(0))} ${FIAT_CODE}`;
};
const percent = (part, whole) => {
  const value = (100 * part) / whole;
  return `${Number.isInteger(value) || value >= 10 ? Math.round(value) : value.toFixed(1)}%`;
};
function table(title, headers, rows) {
  say(`### ${title}`);
  say();
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => String(row[i]).length)));
  const line = (cells) => `| ${cells.map((c, i) => String(c).padEnd(widths[i])).join(' | ')} |`;
  say(line(headers));
  say(`|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`);
  rows.forEach((row) => say(line(row)));
  say();
}

const BLOCKS = [1, 2, 5, 10, 20].map((n) => n * SAT);
const MESSAGES = [1, 2, 5].map((n) => n * SAT);
const LIMITS = [TEST_BOX_LIMIT, NODE_DEFAULT_LIMIT];
const CONTACTS = [50, 250, 500, 1000, 2500].map((n) => n * SAT);
const DAILIES = [200, 1000, 2500, 5000, 10000].map((n) => n * SAT);
const STANDARD_MINUTES = 10;

const TEST_BOX = TEST_BOX_LIMIT;
const SUGGESTED = rates();
const NAMED = [
  ['Card, limit 60: today, 50 / 500', rates({ contact: 50 * SAT, daily: 500 * SAT })],
  ['Card, limit 60: 500 / 2 500', rates({ contact: 500 * SAT })],
  ['Card, limit 60: suggested 1 000 / 2 500', SUGGESTED],
  ['Card, limit 10: today, 50 / 500', rates({ limit: TEST_BOX, contact: 50 * SAT, daily: 500 * SAT })],
  ['Card, limit 10: suggested 1 000 / 2 500', rates({ limit: TEST_BOX })],
  ['Card, limit 60: suggested, per-payment 6', rates({ perCall: MESSAGE_CAP })],
  ['Card, limit 60: suggested, per-payment 10', rates({ perCall: ENVELOPE_PER_ACT_DEFAULT })],
  ['AI client budget', rates({ contact: AI_BUDGET, daily: AI_BUDGET })],
];

function* grid() {
  for (const block of BLOCKS) for (const message of MESSAGES) for (const limit of LIMITS)
    for (const contact of CONTACTS) for (const daily of DAILIES) yield rates({ block, message, limit, contact, daily });
}

// ---- CSV: the whole grid -----------------------------------------------------------

function printCsv() {
  console.log('block_sats,message_sats,max_call_minutes,contact_sats,daily_sats,profile,attempts,refused_ceiling,first_refusal_ceiling,refused_actual,first_refusal_actual,sats_per_day_actual,hold_at_ring_sats');
  for (const r of grid()) for (const [name, events] of PROFILES) {
    const ceiling = simulateDay(r, events, 'ceiling');
    const actual = simulateDay(r, events, 'actual');
    console.log(`${r.block / SAT},${r.message / SAT},${r.limit},${r.contact / SAT},${r.daily / SAT},${name},${ceiling.attempts},${ceiling.refused},${ceiling.first ?? ''},${actual.refused},${actual.first ?? ''},${actual.actual / SAT},${ceiling.maxHold / SAT}`);
  }
}

// ---- tables -------------------------------------------------------------------------

function printTables() {
  say('# BitSov standard rates simulation');
  say();
  say(`Offline and deterministic. Fiat is an ASSUMPTION, not a quote: 1 BTC = ${BTC_PRICE_ASSUMPTION.toLocaleString('en-US')} ${FIAT_CODE} (edit BTC_PRICE_ASSUMPTION).`);
  say(`1 000 sats = ${fiat(1000 * SAT)} on that assumption. "Actual" assumes ${sats(ACTUAL_ROUTING_MSAT)} sat of routing per payment; "ceiling" counts the full routing allowance.`);
  say();

  table(`T1. One call, by block price and box limit (offer ${sats(CARD.offer)} sats, routing allowance ${sats(routingFee(CARD.offer))} sats a block; the card is ${sats(CARD.block)} sats a minute)`,
    ['sats/min', 'box limit', 'each min, all-in', 'hold', 'free at Ring', 'allowance share', 'largest payment', '10-min call, price only', '10-min call, ceiling'],
    BLOCKS.flatMap((block) => LIMITS.map((limit) => {
      const r = rates({ block, limit });
      const c = callCost(r, STANDARD_MINUTES);
      return [sats(block), limit, sats(perMinute(r)), sats(holdOf(r)), sats(ringNeed(r)), percent(fee(r), perMinute(r)), sats(perPaymentNeed(r)), sats(c.principal), sats(c.ceiling)];
    })));

  table(`T1b. Hold at ${sats(CARD.block)} sats a minute if the routing allowance per block changed (node and app change)`,
    ['allowance/block', ...LIMITS.map((limit) => `box limit ${limit}`)],
    [5, 2, 1, 0].map((f) => [sats(f * SAT), ...LIMITS.map((limit) => sats(holdOf(rates({ limit, blockFee: f * SAT }))))]));

  for (const limit of LIMITS) {
    table(`T2. Full ${STANDARD_MINUTES}-minute calls per day inside one contact budget, box limit ${limit} (ceiling/actual; daily budget not binding; 0/0 = one call does not fit)`,
      ['sats/min', ...CONTACTS.map((c) => `${sats(c)} sats`)],
      BLOCKS.map((block) => [sats(block), ...CONTACTS.map((contact) => {
        const r = rates({ block, limit, contact, daily: APP_MAX_DAILY });
        return `${fullCalls(r, STANDARD_MINUTES, 'ceiling')}/${fullCalls(r, STANDARD_MINUTES, 'actual')}`;
      })]));
  }

  for (const limit of LIMITS) {
    table(`T3. What refuses the first call of a fresh day, ${sats(CARD.block)} sats a minute, box limit ${limit}`,
      ['contact \\ daily', ...DAILIES.map((d) => sats(d))],
      CONTACTS.map((contact) => [sats(contact), ...DAILIES.map((daily) =>
        callRefusal(rates({ limit, contact, daily }), Math.min(contact, daily), daily) ?? 'rings')]));
  }

  table('T3b. The per-payment limit against one call at each block price (largest single payment, all-in)',
    ['sats/min', 'largest payment', '6-sat limit', '10-sat envelope default', '15', '25', '50'],
    BLOCKS.map((block) => {
      const need = perPaymentNeed(rates({ block }));
      return [sats(block), sats(need), ...[MESSAGE_CAP, ENVELOPE_PER_ACT_DEFAULT, 15 * SAT, 25 * SAT, 50 * SAT].map((cap) => (need <= cap ? 'fits' : 'REFUSED'))];
    }));

  table('T4. Profiles under named rate sets (refused: budgets counting ceilings/actual)',
    ['rate set', 'profile', 'sats/day', 'sats/month', 'fiat/month', 'free at Ring', 'refused', 'share', 'first refusal'],
    NAMED.flatMap(([name, r]) => PROFILES.map(([profile, events]) => {
      const ceiling = simulateDay(r, events, 'ceiling');
      const actual = simulateDay(r, events, 'actual');
      return [name, profile, sats(actual.actual), sats(actual.actual * 30), fiat(actual.actual * 30), actual.maxHold ? sats(actual.maxHold) : '-',
        `${ceiling.refused}/${actual.refused}`, `${percent(ceiling.refused, ceiling.attempts)}/${percent(actual.refused, actual.attempts)}`, ceiling.first ?? actual.first ?? 'none'];
    })));

  let total = 0;
  const clean = new Map(PROFILES.map(([name]) => [name, 0]));
  const messageRefused = new Map(MESSAGES.map((m) => [m, 0]));
  for (const r of grid()) {
    total++;
    for (const [name, events] of PROFILES) if (simulateDay(r, events, 'ceiling').refused === 0) clean.set(name, clean.get(name) + 1);
    if (simulateDay(r, day({ messages: 1 }), 'ceiling').first === 'message cap') messageRefused.set(r.message, messageRefused.get(r.message) + 1);
  }
  table(`T5. The whole grid: ${total} rate sets (5 block x 3 message x 2 limit x 5 contact x 5 daily; --csv prints them)`,
    ['profile', 'rate sets with no refusal (ceiling)', 'share'],
    [...clean].map(([name, n]) => [name, n, percent(n, total)]));
  table('T5b. The 6-sat message cap against the message price',
    ['message sats', 'routing allowance', 'all-in', 'fits the cap?', 'rate sets refusing every message', 'allowance share of all-in', 'messages in 200 sats, ceiling', 'in 200 sats, actual'],
    MESSAGES.map((m) => {
      const c = paidAction(m);
      return [sats(m), sats(routingFee(m)), sats(c.ceiling), c.ceiling <= MESSAGE_CAP ? 'yes' : 'NO', messageRefused.get(m), percent(routingFee(m), c.ceiling), Math.floor((200 * SAT) / c.ceiling), Math.floor((200 * SAT) / c.actual)];
    }));
  const smallestContact = (limit, events) => {
    for (let contact = 1; contact <= 2500; contact++) {
      if (simulateDay(rates({ limit, contact: contact * SAT, daily: APP_MAX_DAILY }), events, 'ceiling').refused === 0) return `${grouped(String(contact))} sats`;
    }
    return 'above 2 500';
  };
  table('T5d. The card: the exact smallest contact budget for the regular day, and what the suggested defaults leave',
    ['box limit', 'smallest contact budget', 'regular refused at 1 000 / 2 500', 'heavy refused at 1 000 / 2 500', 'heavy, first refusal'],
    LIMITS.map((limit) => {
      const r = rates({ limit });
      const h = simulateDay(r, HEAVY, 'ceiling');
      return [limit, smallestContact(limit, REGULAR), `${simulateDay(r, REGULAR, 'ceiling').refused}/${REGULAR.length}`, `${h.refused}/${HEAVY.length}`, h.first ?? 'none'];
    }));
  const smallest = (limit, block, events) => {
    for (const contact of CONTACTS) for (const daily of DAILIES) {
      if (contact <= daily && simulateDay(rates({ block, limit, contact, daily }), events, 'ceiling').refused === 0) return `${sats(contact)} / ${sats(daily)}`;
    }
    return 'none in grid';
  };
  table('T5c. Smallest candidate contact / daily budget with no refusal (message 1 sat, budgets count ceilings)',
    ['sats/min', 'box limit', 'regular', 'heavy'],
    BLOCKS.flatMap((block) => LIMITS.map((limit) => [sats(block), limit, smallest(limit, block, REGULAR), smallest(limit, block, HEAVY)])));

  table('T6. Exposure: the worst a compromised or misbehaving app can spend',
    ['daily budget', 'worst/day', 'fiat', 'worst, 30 days', 'fiat', '10-min calls that ring (card, ceiling)'],
    DAILIES.map((d) => [sats(d), sats(d), fiat(d), sats(30 * d), fiat(30 * d), fullCalls({ ...SUGGESTED, contact: d, daily: d }, STANDARD_MINUTES, 'ceiling')]));

  table('T6b. Exposure per contact: the most one contact can be paid in 24 h',
    ['contact budget', 'worst/contact/day', 'fiat', 'contacts to reach a 2 500 daily budget', 'messages, ceiling', 'messages, actual'],
    CONTACTS.map((c) => [sats(c), sats(c), fiat(c), Math.ceil((2500 * SAT) / c), grouped(String(Math.floor(c / paidAction(SAT).ceiling))), grouped(String(Math.floor(c / paidAction(SAT).actual)))]));

  const N = [100, 1000, 10000];
  table('T7. Spam: cost to an attacker of N unsolicited messages from fresh identities (the receiver takes this; the attacker also pays routing)',
    ['admission', 'message', ...N.flatMap((n) => [`N=${n} sats`, 'fiat']), 'one identity, N=1000'],
    [ADMISSION_FLOOR, 10 * SAT, 50 * SAT, ADMISSION_CAP].flatMap((admission) => MESSAGES.map((message) => [
      sats(admission), sats(message),
      ...N.flatMap((n) => [sats(n * (admission + message)), fiat(n * (admission + message))]),
      sats(admission + 1000 * message),
    ])));
  table(`T7c. First contact under a grant: the node caps admission plus first message, all-in, at ${sats(MESSAGE_CAP)} sats (node pairing.rs grant_first_contact_locked). Routed uses the default ceilings; direct uses no routing`,
    ['admission', 'message', 'all-in, routed', 'routed under a grant?', 'all-in, direct', 'direct under a grant?'],
    [ADMISSION_FLOOR, 2 * SAT, 5 * SAT, 10 * SAT, 50 * SAT, ADMISSION_CAP].map((admission) => {
      const routed = paidAction(admission).ceiling + paidAction(SAT).ceiling;
      const direct = admission + SAT;
      return [sats(admission), 1, sats(routed), routed <= MESSAGE_CAP ? 'fits' : 'REFUSED', sats(direct), direct <= MESSAGE_CAP ? 'fits' : 'REFUSED'];
    }));
  table('T7b. Spam: unsolicited rings at the offer price (the callee takes the offer; no minute is paid unless answered)',
    ['offer', ...N.flatMap((n) => [`N=${n} sats`, 'fiat'])],
    [1, 5, 10, 20].map((o) => [sats(o * SAT), ...N.flatMap((n) => [sats(n * o * SAT), fiat(n * o * SAT)])]));

  table('T8. Lightning: the routing allowance against the payment (src-tauri/src/act.rs routing_fee; hop fees are an ASSUMPTION)',
    ['principal', 'allowance', 'share of principal', 'share of all-in', '0 hops', '1 hop, 1 sat', '3 hops, 1 sat', '5 hops, 1 sat', '6 hops, 1 sat'],
    [1, 2, 5, 10, 20, 50, 100, 500, 1000, 2000, 10000].map((p) => {
      const allowance = routingFee(p * SAT);
      const hops = (n) => (n * SAT <= allowance ? 'fits' : 'FAILS');
      return [sats(p * SAT), sats(allowance), percent(allowance, p * SAT), percent(allowance, p * SAT + allowance), hops(0), hops(1), hops(3), hops(5), hops(6)];
    }));

  table('T8b. Smallest principal for a given allowance share',
    ['allowance at most', 'smallest principal', 'its allowance'],
    [100, 50, 20, 10, 5, 1].map((share) => {
      let p = MIN_PAYMENT;
      while ((routingFee(p) * 100) / p > share) p += SAT;
      return [`${share}% of principal`, `${sats(p)} sats`, `${sats(routingFee(p))} sats`];
    }));

  table('T8c. Per-minute blocks: one hour of call (60 blocks, each one payment; routing is the ASSUMED actual)',
    ['sats/min', 'callee takes/hour', 'fiat', 'routing/hour', 'routing share', 'allowance share of each block', 'if prepaid 5 min at a time: routing/hour', 'routing share'],
    BLOCKS.map((block) => {
      const routing = 60 * ACTUAL_ROUTING_MSAT;
      const f = routingFee(CARD.offer);
      return [sats(block), sats(60 * block), fiat(60 * block), sats(routing), percent(routing, 60 * block + routing), percent(f, block + f), sats(12 * ACTUAL_ROUTING_MSAT), percent(12 * ACTUAL_ROUTING_MSAT, 60 * block + 12 * ACTUAL_ROUTING_MSAT)];
    }));

  const channels = [10_000, 50_000, 200_000, 1_000_000];
  table('T9. Liquidity: the hold against the channel, for the length of the call (channel sizes are ASSUMPTIONS)',
    ['sats/min', 'box limit', 'hold', ...channels.flatMap((c) => [`${sats(c * SAT)} outbound`, 'calls at once'])],
    [[2, 10], [2, 60], [2, 240], [10, 10], [10, 60]].map(([block, limit]) => {
      const hold = holdOf(rates({ block: block * SAT, limit }));
      return [block, limit, sats(hold), ...channels.flatMap((c) => [percent(hold, c * SAT), Math.floor((c * SAT) / hold)])];
    }));

  const today = rates({ limit: TEST_BOX, block: FIELD_BLOCK, offer: FIELD_OFFER });
  table(`T11. Replay of the field test: 10 sats a minute, offer 10, the test boxes' reported limit ${TEST_BOX}, so ${sats(ringNeed(today))} sats free at Ring`,
    ['free in the budget', 'result', 'left beside the hold'],
    [47, 50, 171, 200, 250, 500].map((n) => [`${n} sats`, n * SAT < ringNeed(today) ? 'offer and hangup fit; refused at the hold' : 'rings', sats(n * SAT - Math.min(n * SAT, ringNeed(today)))]));
  const unconfigured = rates();
  table(`T11c. The card on a box with the node default limit ${NODE_DEFAULT_LIMIT}: ${sats(ringNeed(unconfigured))} sats free at Ring`,
    ['free in the budget', 'result', 'left beside the hold', 'full 10-min calls that ring', 'messages left beside the hold, ceiling'],
    [50, 100, 250, 436, 500, 1000, 2500].map((n) => {
      const r = rates({ contact: n * SAT, daily: APP_MAX_DAILY });
      const fits = n * SAT >= ringNeed(unconfigured);
      return [`${n} sats`, fits ? 'rings' : (n * SAT < preflightOf(unconfigured) ? 'refused before the hold' : 'offer and hangup fit; refused at the hold'),
        fits ? sats(n * SAT - ringNeed(unconfigured)) : '-', fullCalls(r, STANDARD_MINUTES, 'ceiling'), fits ? Math.floor((n * SAT - ringNeed(unconfigured)) / paidAction(SAT).ceiling) : '-'];
    }));
  table('T11b. Blocks paid by call length, at the field test price (block 0 at the answer, the next 20 s before each minute ends)',
    ['call length', 'blocks', 'blocks at 10 sats', 'with the 10-sat offer'],
    [['0:30', 30], ['1:00', 60], ['3:30', 210], ['4:30', 270], ['5:00', 300], ['10:00', 600]].map(([label, seconds]) => {
      const blocks = blocksPaid(seconds, 240);
      return [label, blocks, blocks * 10, blocks * 10 + 10];
    }));

  const ringsIn10 = (limit) => Math.floor(BREAKERS.msatPer10Min / ringNeed(rates({ limit })));
  table(`T12. What counts against the node's default breakers (${BREAKERS.perMinute} a minute, ${BREAKERS.perHour} an hour, ${BREAKERS.failures} failures, ${sats(BREAKERS.msatPer10Min)} sats per 10 minutes). A ring counts the hold and the offer as 2 payments and their whole reserved amount, even when released; blocks draw on the hold and count no further`,
    ['need', 'payments counted', 'sats counted in 10 min (ceiling)', 'fits one time?', 'how many in 10 minutes'],
    [...LIMITS.map((limit) => [`one ring, any length, limit ${limit}`, 2, sats(ringNeed(rates({ limit }))), ringNeed(rates({ limit })) <= BREAKERS.msatPer10Min ? 'fits' : 'REFUSED', ringsIn10(limit)]),
      ['a burst of 10 messages', 10, sats(10 * paidAction(SAT).ceiling), 'fits', `${BREAKERS.perMinute} a minute`],
      ['a burst of 61 messages in an hour', 61, sats(61 * paidAction(SAT).ceiling), 'REFUSED, the 61st', `${BREAKERS.perHour} an hour`],
      ['ai client: 200 actions over 10 hours', 20, sats(Math.round((200 / 60) * 10) * paidAction(SAT).ceiling), 'fits', `${BREAKERS.perHour} an hour`],
      ['porch reader: 30 reads in an hour', 30, sats(5 * paidAction(PAGE).ceiling), 'fits', `${BREAKERS.perHour} an hour`]]);

  const AI = PROFILES[3][1];
  const allIn = paidAction(CARD.message).ceiling;
  table(`T13. AI client budget (decided: ${sats(AI_BUDGET)} sats per 24 h) against 200 small actions a day. The node's default breaker of ${BREAKERS.perHour} payments an hour is the rate bound; at ${sats(allIn)} sats all-in that is ${sats(BREAKERS.perHour * allIn)} sats an hour`,
    ['budget/day', 'fiat', 'actions, ceiling', 'actions, actual', 'refused, ceiling', 'refused, actual', 'fastest drain at the breaker'],
    [AI_BUDGET / SAT].map((n) => {
      const d = n * SAT;
      const r = rates({ contact: d, daily: d });
      return [sats(d), fiat(d), Math.floor(d / paidAction(SAT).ceiling), Math.floor(d / paidAction(SAT).actual),
        percent(simulateDay(r, AI, 'ceiling').refused, AI.length), percent(simulateDay(r, AI, 'actual').refused, AI.length), `${Math.ceil((60 * Math.ceil(d / allIn)) / BREAKERS.perHour)} min`];
    }));

  console.log(out.join('\n').trimEnd());
}

if (process.argv.includes('--csv')) printCsv();
else printTables();
