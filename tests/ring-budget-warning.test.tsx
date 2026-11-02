/**
 * Display only: the call confirm warns before Ring when the box's budget for
 * this contact is below what the call may hold, and the post-Ring
 * `grant_recipient` refusal says the same thing plainly. Nothing here gates
 * Ring or names an amount to pay.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'solid-js/web';
import { setLanguagePref } from '../src/i18n';
import { callRefusal } from '../src/control/call';
import { amount } from '../src/control/format';
import { callHoldMsat, knownCallLimit, ringBudgetShort, RingBudgetNote } from '../src/control/ringBudget';
import type { ActionError, CallQuote, NodeGrantSummary } from '../src/control/types';

const A = 'a'.repeat(64);
const BLOCK = 10_000;
const FEE = 5_000;
const QUOTE: CallQuote = {
  offer_msat: 10_000, offer_max_routing_fee_msat: 5_000, signal_msat: 1_000, signal_max_routing_fee_msat: 5_000, call_total_msat: 21_000,
  block_msat: BLOCK, block_max_routing_fee_msat: FEE, reservation_max_msat: 240 * (BLOCK + FEE), minutes_payable: true,
};
// A box that caps calls at 10 minutes: 10 × (price + routing allowance) + the offer and its routing cap.
const LIMIT = 10;
const HOLD = LIMIT * (BLOCK + FEE) + 10_000 + 5_000;
const NOW = 1_800_000_000_000;
const grant = (left?: Record<string, number>, expiresAt = NOW + 86_400_000): NodeGrantSummary => ({
  expires_at_ms: expiresAt, budget_msat: 500_000_000, remaining_msat: 500_000_000, per_call_max_msat: 5_000_000,
  ...(left ? { recipient_left_msat_by_recipient: left } : {}),
});

let dispose: (() => void) | undefined;
let mount: HTMLElement | undefined;
afterEach(() => {
  setLanguagePref('en');
  dispose?.();
  dispose = undefined;
  mount?.remove();
  mount = undefined;
});
function note(g: NodeGrantSummary | null, limit: number | null = LIMIT, quote: CallQuote | null = QUOTE, peer = A) {
  dispose?.();
  mount?.remove();
  mount = document.createElement('div');
  document.body.appendChild(mount);
  dispose = render(() => <RingBudgetNote grant={g} peer={peer} name="Maya" quote={quote} callLimitMinutes={limit} now={NOW} />, mount);
  return mount.querySelector('[data-call-contact-budget-short]');
}

describe('the contact-budget line before Ring', () => {
  it('the hold is the known call limit × (price + routing allowance) plus the offer and its routing cap', () => {
    expect(callHoldMsat(QUOTE, LIMIT)).toBe(HOLD);
    expect(callHoldMsat(QUOTE, null)).toBeNull();
    expect(callHoldMsat({ ...QUOTE, block_msat: null }, LIMIT)).toBeNull();
    expect(callHoldMsat({ ...QUOTE, offer_msat: null }, LIMIT)).toBeNull();
    expect(callHoldMsat(null, LIMIT)).toBeNull();
  });

  it('only a limit a node could pin counts as known', () => {
    expect(knownCallLimit(10)).toBe(10);
    expect(knownCallLimit(240)).toBe(240);
    for (const bad of [null, undefined, 0, -1, 241, 2.5, Number.NaN]) expect(knownCallLimit(bad)).toBeNull();
  });

  it('shows with a known 10-minute limit when the box has less left than the hold (EN)', () => {
    const left = 50_000;
    const el = note(grant({ [A]: left }));
    expect(el?.textContent).toBe(
      `Your box has only ${amount(left)} left for Maya right now. A call holds up to ${amount(HOLD)}, so your box will likely turn it down. Raise this contact’s budget on your box before you ring.`);
    expect(el?.getAttribute('role')).toBe('note');
  });

  it('says it in Danish too', () => {
    setLanguagePref('da');
    const left = 50_000;
    expect(note(grant({ [A]: left }))?.textContent).toBe(
      `Din boks har kun ${amount(left)} tilbage til Maya lige nu. Et opkald holder op til ${amount(HOLD)}, så boksen vil sandsynligvis afvise det. Hæv kontaktens budget på boksen, før du ringer.`);
  });

  it('shows nothing while the call limit is unknown, however little is left', () => {
    expect(note(grant({ [A]: 0 }), null)).toBeNull();
    expect(ringBudgetShort(grant({ [A]: 0 }), A, QUOTE, null, NOW)).toBeNull();
  });

  it('reads the contact lower-cased, as the host keys it', () => {
    expect(note(grant({ [A]: 0 }), LIMIT, QUOTE, A.toUpperCase())).not.toBeNull();
  });

  it('is absent when the box has enough left for the whole hold', () => {
    expect(note(grant({ [A]: HOLD }))).toBeNull();
    expect(note(grant({ [A]: HOLD + 1 }))).toBeNull();
  });

  it('is absent when the remainder is unknown: no grant, no per-contact entry, an older host, or an expired grant', () => {
    expect(ringBudgetShort(null, A, QUOTE, LIMIT, NOW)).toBeNull();
    expect(ringBudgetShort(grant({ ['b'.repeat(64)]: 0 }), A, QUOTE, LIMIT, NOW)).toBeNull();
    expect(ringBudgetShort(grant(), A, QUOTE, LIMIT, NOW)).toBeNull();
    expect(ringBudgetShort(grant({ [A]: 0 }, NOW), A, QUOTE, LIMIT, NOW)).toBeNull();
    expect(note(null)).toBeNull();
  });

  it('is absent without a per-minute price on the quote', () => {
    expect(ringBudgetShort(grant({ [A]: 0 }), A, { ...QUOTE, block_msat: null }, LIMIT, NOW)).toBeNull();
    expect(ringBudgetShort(grant({ [A]: 0 }), A, null, LIMIT, NOW)).toBeNull();
  });

  it('reports the remainder and the hold it compared', () => {
    expect(ringBudgetShort(grant({ [A]: 50_000 }), A, QUOTE, LIMIT, NOW)).toEqual({ leftMsat: 50_000, holdMsat: HOLD });
  });
});

describe('the grant_recipient refusal after Ring', () => {
  const refusal = { code: 'grant_recipient', message: 'Your node’s budget for this recipient has 50 sats left, less than this costs. Nothing was sent.' } as ActionError;

  it('says what to do, in plain English', () => {
    expect(callRefusal(refusal)).toBe('Your box turned the call down: this contact’s budget on your box can’t hold the call. Nothing was paid. Raise this contact’s budget on your box, then ring again.');
  });

  it('and in Danish', () => {
    setLanguagePref('da');
    expect(callRefusal(refusal)).toBe('Din boks afviste opkaldet: kontaktens budget på boksen kan ikke rumme opkaldet. Der er ikke betalt noget. Hæv kontaktens budget på boksen, og ring igen.');
  });

  it('leaves the other grant refusals as they were', () => {
    const perCall = { code: 'grant_per_call', message: 'host words' } as ActionError;
    expect(callRefusal(perCall)).toContain('reserves the call’s minutes when it rings');
    expect(callRefusal(perCall)).toContain('host words');
  });
});
