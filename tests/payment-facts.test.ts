/**
 * Payment known and fence cleared are two facts. The host keeps a paid, undelivered
 * record pending, and that record blocks every other paid action.
 */
import { describe, expect, it } from 'vitest';
import { checkFacts, sendFacts } from '../src/control/paymentOutcome';

const CLEAR = { paymentKnown: true, fenceCleared: true };
const HELD = { paymentKnown: true, fenceCleared: false };
const UNKNOWN = { paymentKnown: false, fenceCleared: false };

describe('a send refused', () => {
  it.each([
    ['not_dispatched', CLEAR], ['call_not_live', CLEAR], ['budget_exhausted', CLEAR],
    ['failed_paid', CLEAR],
    ['payment_settled_undelivered', HELD], ['undelivered_pending', HELD],
    ['spend_unknown', UNKNOWN], ['payment_unknown', UNKNOWN], ['app_not_ready', UNKNOWN], ['anything_else', UNKNOWN],
  ])('%s', (code, facts) => expect(sendFacts(code)).toEqual(facts));
});

describe('a check of the pending result', () => {
  it('a success settles it', () => expect(checkFacts({ ok: true })).toEqual(CLEAR));
  it.each([
    ['failed_paid', CLEAR],
    ['undelivered_pending', HELD], ['payment_settled_undelivered', HELD],
    ['spend_unknown', UNKNOWN], ['payment_unknown', UNKNOWN],
    // A refused check says nothing about the record, even with a code that proves a send unpaid.
    ['not_dispatched', UNKNOWN], ['not_ready', UNKNOWN], ['anything_else', UNKNOWN],
  ])('%s', (code, facts) => expect(checkFacts({ ok: false, error: { code } })).toEqual(facts));
});
