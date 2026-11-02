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
/** ASSUMPTION: the per-payment limit a box signs on a grant. Node-side; 50 sats is the value in the app's test fixtures. */
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
/** src-tauri/src/grant.rs and owner_approval_tests.rs: breaker values in test FIXTURES only. The node's real defaults are node-side. */
const BREAKER_FIXTURE = { perMinute: 2, perHour: 12, msatPer10Min: 9_000 };

/** src-tauri/src/act.rs routing_fee */
const routingFee = (principal) => (principal === 0 ? 0 : Math.min(Math.max(Math.floor(principal / 100), 5_000), 10_000));

// ---- reported by the owner's box and test; node-side, to be confirmed --------

const OFFER = 10 * SAT;
const SIGNAL = 1 * SAT;
const PAGE = 1 * SAT;

// ---- the model -----------------------------------------------------------------

/** A rate set. Prices in msat; `limit` in minutes. */
const rates = (o = {}) => ({
  block: 10 * SAT, message: 1 * SAT, limit: 10, contact: 50 * SAT, daily: 500 * SAT,
  perCall: PER_CALL_CAP_DEFAULT, offer: OFFER, blockFee: null, outbound: OUTBOUND_DEFAULT, ...o,
});

const fee = (r) => r.blockFee ?? routingFee(r.offer);
const perMinute = (r) => r.block + fee(r);
/** docs/CALLS.md: the hold is (price + routing allowance) x the box's max_call_minutes. */
const holdOf = (r) => perMinute(r) * r.limit;
const offerAllIn = (r) => r.offer + routingFee(r.offer);
const hangupAllIn = () => SIGNAL + routingFee(SIGNAL);
/** The app's own check before the offer (src-tauri/src/app.rs): offer plus one hangup. */
const preflightOf = (r) => offerAllIn(r) + hangupAllIn();
/** What must be free at Ring. Whether the node adds the hangup to the hold is node-side; this counts it. */
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
  ['family', day({ messages: 30, calls: 2, minutes: 10 })],
  ['heavy', day({ messages: 100, calls: 5, minutes: 'limit', contacts: 5 })],
  ['ai client', day({ messages: 200, contacts: 3 })],
  ['porch reader', day({ messages: 30, contacts: 5, kind: 'page', unbudgeted: true })],
];
const FAMILY = PROFILES[1][1];
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
const LIMITS = [10, 30, 60];
const CONTACTS = [50, 250, 500, 1000, 2500].map((n) => n * SAT);
const DAILIES = [200, 1000, 2500, 5000, 10000].map((n) => n * SAT);
const STANDARD_MINUTES = 10;

const NAMED = [
  ['Today: first-contact default', rates({ contact: 50 * SAT, daily: 500 * SAT })],
  ['Today: as re-approved', rates({ contact: 250 * SAT, daily: 500 * SAT })],
  ['#394 ceiling, per-call 6', rates({ contact: 200 * SAT, daily: 200 * SAT, perCall: MESSAGE_CAP })],
  ['#394 ceiling, per-call 50', rates({ contact: 200 * SAT, daily: 200 * SAT })],
  ['Fallback: 10-min box', rates({ contact: 1000 * SAT, daily: 2500 * SAT })],
  ['Proposed', rates({ limit: 30, contact: 1000 * SAT, daily: 2500 * SAT })],
  ['Cheap: 2 sats a minute', rates({ block: 2 * SAT, limit: 30, contact: 250 * SAT, daily: 1000 * SAT })],
  ['Long calls', rates({ limit: 60, contact: 2500 * SAT, daily: 10000 * SAT })],
];
const PROPOSED = NAMED.find(([name]) => name === 'Proposed')[1];

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

  table('T1. One call, by block price and box limit (offer 10 sats, routing allowance 5 sats a block)',
    ['sats/min', 'box limit', 'each min, all-in', 'hold', 'free at Ring', 'allowance share', 'largest payment', '10-min call, price only', '10-min call, ceiling'],
    BLOCKS.flatMap((block) => LIMITS.map((limit) => {
      const r = rates({ block, limit });
      const c = callCost(r, STANDARD_MINUTES);
      return [sats(block), limit, sats(perMinute(r)), sats(holdOf(r)), sats(ringNeed(r)), percent(fee(r), perMinute(r)), sats(perPaymentNeed(r)), sats(c.principal), sats(c.ceiling)];
    })));

  table('T1b. Hold at 10 sats a minute if the routing allowance per block changed (node and app change)',
    ['allowance/block', 'box limit 10', 'box limit 30', 'box limit 60'],
    [5, 2, 1, 0].map((f) => [sats(f * SAT), ...LIMITS.map((limit) => sats(holdOf(rates({ limit, blockFee: f * SAT }))))]));

  for (const limit of LIMITS) {
    table(`T2. Full ${STANDARD_MINUTES}-minute calls per day inside one contact budget, box limit ${limit} (ceiling/actual; daily budget not binding; 0/0 = one call does not fit)`,
      ['sats/min', ...CONTACTS.map((c) => `${sats(c)} sats`)],
      BLOCKS.map((block) => [sats(block), ...CONTACTS.map((contact) => {
        const r = rates({ block, limit, contact, daily: APP_MAX_DAILY });
        return `${fullCalls(r, STANDARD_MINUTES, 'ceiling')}/${fullCalls(r, STANDARD_MINUTES, 'actual')}`;
      })]));
  }

  for (const limit of [10, 30]) {
    table(`T3. What refuses the first call of a fresh day, 10 sats a minute, box limit ${limit}`,
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
  table(`T5. The whole grid: ${total} rate sets (5 block x 3 message x 3 limit x 5 contact x 5 daily; --csv prints them)`,
    ['profile', 'rate sets with no refusal (ceiling)', 'share'],
    [...clean].map(([name, n]) => [name, n, percent(n, total)]));
  table('T5b. The 6-sat message cap against the message price',
    ['message sats', 'routing allowance', 'all-in', 'fits the cap?', 'rate sets refusing every message', 'allowance share of all-in', 'messages in 200 sats, ceiling', 'in 200 sats, actual'],
    MESSAGES.map((m) => {
      const c = paidAction(m);
      return [sats(m), sats(routingFee(m)), sats(c.ceiling), c.ceiling <= MESSAGE_CAP ? 'yes' : 'NO', messageRefused.get(m), percent(routingFee(m), c.ceiling), Math.floor((200 * SAT) / c.ceiling), Math.floor((200 * SAT) / c.actual)];
    }));
  const smallest = (limit, block, events) => {
    for (const contact of CONTACTS) for (const daily of DAILIES) {
      if (contact <= daily && simulateDay(rates({ block, limit, contact, daily }), events, 'ceiling').refused === 0) return `${sats(contact)} / ${sats(daily)}`;
    }
    return 'none in grid';
  };
  table('T5c. Smallest candidate contact / daily budget with no refusal (message 1 sat, budgets count ceilings)',
    ['sats/min', 'box limit', 'family', 'heavy'],
    BLOCKS.flatMap((block) => LIMITS.map((limit) => [sats(block), limit, smallest(limit, block, FAMILY), smallest(limit, block, HEAVY)])));

  table('T6. Exposure: the worst a compromised or misbehaving app can spend',
    ['daily budget', 'worst/day', 'fiat', 'worst, 3 self grants in 24 h (#394)', 'fiat', 'worst, 30 days', 'fiat', '10-min calls that ring (proposed rates, ceiling)'],
    DAILIES.map((d) => [sats(d), sats(d), fiat(d), sats(3 * d), fiat(3 * d), sats(30 * d), fiat(30 * d), fullCalls({ ...PROPOSED, contact: d, daily: d }, STANDARD_MINUTES, 'ceiling')]));

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
      const f = routingFee(OFFER);
      return [sats(block), sats(60 * block), fiat(60 * block), sats(routing), percent(routing, 60 * block + routing), percent(f, block + f), sats(12 * ACTUAL_ROUTING_MSAT), percent(12 * ACTUAL_ROUTING_MSAT, 60 * block + 12 * ACTUAL_ROUTING_MSAT)];
    }));

  const channels = [10_000, 50_000, 200_000, 1_000_000];
  table('T9. Liquidity: the hold against the channel, for the length of the call (channel sizes are ASSUMPTIONS)',
    ['sats/min', 'box limit', 'hold', ...channels.flatMap((c) => [`${sats(c * SAT)} outbound`, 'calls at once'])],
    [[10, 10], [10, 30], [10, 60], [10, 240], [5, 30], [2, 30], [20, 30]].map(([block, limit]) => {
      const hold = holdOf(rates({ block: block * SAT, limit }));
      return [block, limit, sats(hold), ...channels.flatMap((c) => [percent(hold, c * SAT), Math.floor((c * SAT) / hold)])];
    }));

  table('T10. The in-app self-approval ceiling (#394: 200 sats a day today), used as contact and daily budget, 10 sats a minute',
    ['ceiling', 'worst/24 h, 3 grants', 'fiat', 'calls ring, limit 10', 'calls ring, limit 30', 'family refused, limit 10', 'family refused, limit 30', 'approves a 2 500 daily default in the app?'],
    [200, 500, 1000, 2500, 5000].map((n) => {
      const d = n * SAT;
      const short = rates({ limit: 10, contact: d, daily: d });
      const long = rates({ limit: 30, contact: d, daily: d });
      return [sats(d), sats(3 * d), fiat(3 * d), fullCalls(short, STANDARD_MINUTES, 'ceiling'), fullCalls(long, STANDARD_MINUTES, 'ceiling'),
        `${simulateDay(short, FAMILY, 'ceiling').refused}/${FAMILY.length}`, `${simulateDay(long, FAMILY, 'ceiling').refused}/${FAMILY.length}`, n >= 2500 ? 'yes' : 'no, node computer'];
    }));

  const today = rates();
  table(`T11. Replay of the live test: 10 sats a minute, offer 10, box limit 10, so ${sats(ringNeed(today))} sats free at Ring`,
    ['free in the budget', 'result', 'left beside the hold'],
    [47, 50, 171, 200, 250, 500].map((n) => [`${n} sats`, n * SAT < ringNeed(today) ? 'offer and hangup fit; refused at the hold' : 'rings', sats(n * SAT - Math.min(n * SAT, ringNeed(today)))]));
  table('T11b. Blocks paid by call length (block 0 at the answer, the next 20 s before each minute ends)',
    ['call length', 'blocks', 'blocks at 10 sats', 'with the 10-sat offer'],
    [['0:30', 30], ['1:00', 60], ['3:30', 210], ['4:30', 270], ['5:00', 300], ['10:00', 600]].map(([label, seconds]) => {
      const blocks = blocksPaid(seconds, 240);
      return [label, blocks, blocks * 10, blocks * 10 + 10];
    }));

  table('T12. Payment rate needed, against the breaker values in the test fixtures (node defaults are node-side, to be confirmed)',
    ['need', 'payments/min', 'payments/hour', `fixture ${BREAKER_FIXTURE.perMinute}/min`, `fixture ${BREAKER_FIXTURE.perHour}/hour`, 'sats in 10 min (ceiling)', `fixture ${sats(BREAKER_FIXTURE.msatPer10Min)} sats/10 min`],
    [['one call for an hour, 10 sats a minute', 2, 60, 10 * perMinute(today)],
      ['one call, reserved at Ring, limit 30', 1, 1, ringNeed(rates({ limit: 30 }))],
      ['a burst of 10 messages', 10, 10, 10 * paidAction(SAT).ceiling],
      ['ai client: 200 actions over 10 hours', 1, 20, Math.round((200 / 60) * 10) * paidAction(SAT).ceiling],
      ['porch reader: 30 reads in an hour', 1, 30, 5 * paidAction(PAGE).ceiling]].map(([name, perMin, perHour, inTen]) => [name, perMin, perHour,
      perMin <= BREAKER_FIXTURE.perMinute ? 'fits' : 'REFUSED', perHour <= BREAKER_FIXTURE.perHour ? 'fits' : 'REFUSED', sats(inTen), inTen <= BREAKER_FIXTURE.msatPer10Min ? 'fits' : 'REFUSED']));

  const AI = PROFILES[3][1];
  const VELOCITY_10_MIN = 100 * SAT;
  table(`T13. AI client grant sizes against 200 small actions a day (each recipient may use the whole grant; drain time at ${sats(VELOCITY_10_MIN)} sats per 10 minutes)`,
    ['grant/day', 'fiat', 'actions, ceiling', 'actions, actual', 'refused, ceiling', 'refused, actual', 'fastest drain at that velocity'],
    [200, 500, 1000, 1500, 2500].map((n) => {
      const d = n * SAT;
      const r = rates({ contact: d, daily: d });
      return [sats(d), fiat(d), Math.floor(d / paidAction(SAT).ceiling), Math.floor(d / paidAction(SAT).actual),
        percent(simulateDay(r, AI, 'ceiling').refused, AI.length), percent(simulateDay(r, AI, 'actual').refused, AI.length), `${Math.ceil(d / VELOCITY_10_MIN) * 10} min`];
    }));

  console.log(out.join('\n').trimEnd());
}

if (process.argv.includes('--csv')) printCsv();
else printTables();
