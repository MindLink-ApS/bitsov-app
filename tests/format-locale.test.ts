import { afterEach, expect, it, vi } from 'vitest';
import { amount, sats, satUnit, satsWhole } from '../src/control/format';
import { parseAmount, amountText } from '../src/control/amountInput';
import { t, setLanguagePref } from '../src/i18n';
import { setDenom } from '../src/control/prefs';

afterEach(() => { vi.restoreAllMocks(); setDenom('sats'); setLanguagePref('en'); });
it.each([
  ['da-DK', '188\u202f800 sats', '21.187 sats', '0.011 sats', '1.019 sats'],
  ['en-US', '188\u202f800 sats', '21.187 sats', '0.011 sats', '1.019 sats'],
])('formats exact amounts in the chosen denomination in %s', (locale, whole, call, tiny, price) => {
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(locale);
  setDenom('sats');
  expect(amount(188800000)).toBe(whole);
  expect(amount(21187)).toBe(call);
  expect(amount(11)).toBe(tiny);
  expect(amount(1019)).toBe(price);
  expect(`${sats(21187)} ${satUnit(21187)}`).toBe(call);
  expect(`${satsWhole(188800)} sats`).toBe(whole);
  expect(amount(1000)).toBe('1 sat');
  expect(amount(0)).toBe('0 sats');
});

it('groups signed large values without losing msat precision', () => {
  expect(amount(1250000)).toBe('1\u202f250 sats');
  expect(amount(-1234567890123)).toBe('-1\u202f234\u202f567\u202f890.123 sats');
  expect(satsWhole(1234567)).toBe('1\u202f234\u202f567');
  expect(amount(Number.MAX_SAFE_INTEGER)).toBe('9\u202f007\u202f199\u202f254\u202f740.991 sats');
  setDenom('btc');
  expect(amount(1234567890123000)).toBe('12\u202f345.67890123 BTC');
});

it.each(['en', 'da'] as const)('keeps digit groups together in %s running text and copy-pastes exactly', locale => {
  setLanguagePref(locale);
  expect(t('uiSentTo', amount(1250000), 'Maya')).toContain('1\u202f250 sats');
  expect(t('uiBalancesAndCostsUseThisUnitEverywhereYour')).toContain('1 sat = 1\u202f000');
  expect(parseAmount(sats(1250000), 'sats')).toBe(1250000);
  expect(amountText(1250000, 'sats')).toBe('1250');
});
