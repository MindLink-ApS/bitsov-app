import { afterEach, expect, it, vi } from 'vitest';
import { amount, sats, satUnit, satsWhole } from '../src/control/format';
import { parseAmount, amountText } from '../src/control/amountInput';
import { t, setLanguagePref } from '../src/i18n';
import { setDenom } from '../src/control/prefs';

afterEach(() => { vi.restoreAllMocks(); setDenom('sats'); setLanguagePref('en'); });
it.each([
  ['da-DK', '188\u202f800 sats', '21,187 sats', '0,011 sats', '1,019 sats'],
  ['en-US', '188\u202f800 sats', '21.187 sats', '0.011 sats', '1.019 sats'],
])('formats exact amounts in the chosen denomination in %s', (locale, whole, call, tiny, price) => {
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(locale);
  setLanguagePref('system');
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

it.each(['en', 'da'] as const)('uses the selected %s decimal for every sats display helper', locale => {
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(locale === 'da' ? 'en-US' : 'da-DK');
  setLanguagePref(locale);
  const decimal = locale === 'da' ? ',' : '.';
  expect(amount(1234)).toBe(`1${decimal}234 sats`);
  expect(amount(-1234567890123)).toBe(`-1\u202f234\u202f567\u202f890${decimal}123 sats`);
  expect(amount(Number.MAX_SAFE_INTEGER)).toBe(`9\u202f007\u202f199\u202f254\u202f740${decimal}991 sats`);
  expect(satsWhole(1234.567)).toBe(`1\u202f234${decimal}567`);
  expect(sats(1234.5)).toBe(`1${decimal}234`);
});

it.each(['en', 'da'] as const)('pastes %s display amounts exactly or refuses them, never changing their value', locale => {
  setLanguagePref(locale);
  for (const unit of ['sats', 'btc'] as const) {
    setDenom(unit);
    for (const msat of [0, -1234, 1, 11, 500, 1000, 1001, 1234, 1250, 21187, 1234567, 1250000, Number.MAX_SAFE_INTEGER]) {
      const displayed = sats(msat);
      const refused = msat <= 0 || (locale === 'da' && unit === 'sats' && msat % 1000 !== 0);
      expect(parseAmount(displayed, unit), displayed).toBe(refused ? null : msat);
      // Including the displayed unit is also refused by the existing input grammar.
      expect(parseAmount(amount(msat), unit)).toBeNull();
      // Even a paste after changing the language must be exact or refused.
      const otherLanguage = locale === 'da' ? 'en' : 'da';
      const parsed = parseAmount(displayed, unit, otherLanguage);
      expect(parsed === null || parsed === msat, displayed).toBe(true);
    }
    expect(amount(1234)).toBe(unit === 'btc' ? '0.00000001234 BTC' : locale === 'da' ? '1,234 sats' : '1.234 sats');
  }
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
