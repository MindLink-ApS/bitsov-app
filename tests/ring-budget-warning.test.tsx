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
import { callHoldCeilingMsat, ringBudgetShort, RingBudgetNote } from '../src/control/ringBudget';
import type { ActionError, CallQuote, NodeGrantSummary } from '../src/control/types';

const A = 'a'.repeat(64);
const BLOCK = 10_000;
const FEE = 5_000;
const QUOTE: CallQuote = {
  offer_msat: 10_000, offer_max_routing_fee_msat: 5_000, signal_msat: 1_000, signal_max_routing_fee_msat: 5_000, call_total_msat: 21_000,
  block_msat: BLOCK, block_max_routing_fee_msat: FEE, reservation_max_msat: 240 * (BLOCK + FEE), minutes_payable: true,
};
const HOLD = 240 * (BLOCK + FEE) + 10_000 + 5_000;
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
function note(g: NodeGrantSummary | null, quote: CallQuote | null = QUOTE, peer = A) {
  mount = document.createElement('div');
  document.body.appendChild(mount);
  dispose = render(() => <RingBudgetNote grant={g} peer={peer} name="Maya" quote={quote} now={NOW} />, mount);
  return mount.querySelector('[data-call-contact-budget-short]');
}

describe('the contact-budget line before Ring', () => {
  it('the call ceiling is the reservation ceiling plus the offer', () => {
    expect(callHoldCeilingMsat(QUOTE)).toBe(HOLD);
    expect(callHoldCeilingMsat({ ...QUOTE, reservation_max_msat: null })).toBeNull();
    expect(callHoldCeilingMsat({ ...QUOTE, offer_msat: null })).toBeNull();
    expect(callHoldCeilingMsat(null)).toBeNull();
  });

  it('shows when the call may hold more than the box has left for this contact (EN)', () => {
    const left = 50_000;
    const el = note(grant({ [A]: left }));
    expect(el?.textContent).toBe(
      `Your box has only ${amount(left)} left for Maya right now. A call can hold up to ${amount(HOLD)}, so your box may turn it down. Raise this contact’s budget on your box before you ring.`);
    expect(el?.getAttribute('role')).toBe('note');
  });

  it('says it in Danish too', () => {
    setLanguagePref('da');
    const left = 50_000;
    expect(note(grant({ [A]: left }))?.textContent).toBe(
      `Din boks har kun ${amount(left)} tilbage til Maya lige nu. Et opkald kan holde op til ${amount(HOLD)}, så boksen kan afvise det. Hæv kontaktens budget på boksen, før du ringer.`);
  });

  it('reads the contact lower-cased, as the host keys it', () => {
    expect(note(grant({ [A]: 0 }), QUOTE, A.toUpperCase())).not.toBeNull();
  });

  it('is absent when the box has enough left for the whole hold', () => {
    expect(note(grant({ [A]: HOLD }))).toBeNull();
    dispose?.(); mount?.remove();
    expect(note(grant({ [A]: HOLD + 1 }))).toBeNull();
  });

  it('is absent when the remainder is unknown: no grant, no per-contact entry, an older host, or an expired grant', () => {
    expect(ringBudgetShort(null, A, QUOTE, NOW)).toBeNull();
    expect(ringBudgetShort(grant({ ['b'.repeat(64)]: 0 }), A, QUOTE, NOW)).toBeNull();
    expect(ringBudgetShort(grant(), A, QUOTE, NOW)).toBeNull();
    expect(ringBudgetShort(grant({ [A]: 0 }, NOW), A, QUOTE, NOW)).toBeNull();
    expect(note(null)).toBeNull();
  });

  it('is absent without a hold ceiling on the quote', () => {
    expect(ringBudgetShort(grant({ [A]: 0 }), A, { ...QUOTE, reservation_max_msat: null }, NOW)).toBeNull();
    expect(ringBudgetShort(grant({ [A]: 0 }), A, null, NOW)).toBeNull();
  });

  it('reports the remainder and the ceiling it compared', () => {
    expect(ringBudgetShort(grant({ [A]: 50_000 }), A, QUOTE, NOW)).toEqual({ leftMsat: 50_000, holdMsat: HOLD });
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
