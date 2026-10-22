import { afterEach, expect, it } from 'vitest';
import { budgetNote, paidAmount } from '../src/control/format';
import { setDenom } from '../src/control/prefs';

afterEach(() => setDenom('sats'));

it('distinguishes an unreported settled fee from a known zero fee', () => {
  setDenom('sats');
  expect(paidAmount(2000)).toBe('paid 2 sats · network fee not reported');
  expect(paidAmount(2000, 0)).toBe('paid 2 sats');
  expect(paidAmount(2000, 250)).toBe('paid 2.25 sats');
  for (const fee of [-1, NaN, Infinity, 0.5]) {
    expect(paidAmount(2000, fee)).toBe('paid 2 sats · network fee not reported');
  }
});

it('keeps reserved money and unreported costs separate from settled spending', () => {
  setDenom('sats');
  expect(budgetNote({ spent_msat: 2000, unsettled_msat: 3000, accounted_msat: 10000, fee_unknown: true }))
    .toBe('3 sats reserved · network fee not reported · up to 5 sats held for unreported costs');
  expect(budgetNote({ spent_msat: 2000, unsettled_msat: 0, fee_unknown: false })).toBe('');
  setDenom('btc');
  expect(paidAmount(2000)).toBe('paid 0.00000002 BTC · network fee not reported');
});
