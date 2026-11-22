import { afterEach, expect, it, vi } from 'vitest';
import { amount, estimatedSats, exactSats, sats, satUnit, satsWhole } from '../src/control/format';
import { parseAmount, amountText } from '../src/control/amountInput';
import { t, setLanguagePref } from '../src/i18n';
import { setDenom } from '../src/control/prefs';

afterEach(() => { vi.restoreAllMocks(); setDenom('sats'); setLanguagePref('en'); });
it.each([
  ['da-DK', '188\u202f800 sats', 'ca. 22 sats', 'ca. 1 sat', 'ca. 2 sats'],
  ['en-US', '188\u202f800 sats', 'about 22 sats', 'about 1 sat', 'about 2 sats'],
])('shows whole sats, rounded up and marked as rounded, in %s', (locale, whole, call, tiny, price) => {
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(locale);
  setLanguagePref('system');
  setDenom('sats');
  expect(amount(188800000, 'up')).toBe(whole);
  expect(amount(21187, 'up')).toBe(call);
  expect(amount(11, 'up')).toBe(tiny);
  expect(amount(1019, 'up')).toBe(price);
  expect(`${sats(21187, 'up')} ${satUnit(21187, 'up')}`).toBe(call);
  expect(`${satsWhole(188800)} sats`).toBe(whole);
  expect(amount(1000, 'up')).toBe('1 sat');
  expect(amount(0, 'up')).toBe('0 sats');
});

it.each(['en', 'da'] as const)('never shows a %s msat decimal on a sats amount; exact sats keep the selected decimal', locale => {
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(locale === 'da' ? 'en-US' : 'da-DK');
  setLanguagePref(locale);
  const decimal = locale === 'da' ? ',' : '.';
  const about = locale === 'da' ? 'ca.' : 'about';
  expect(amount(1234, 'up')).toBe(`${about} 2 sats`);
  expect(amount(-1234567890123, 'up')).toBe(`${about} -1\u202f234\u202f567\u202f891 sats`);
  expect(amount(Number.MAX_SAFE_INTEGER, 'up')).toBe(`${about} 9\u202f007\u202f199\u202f254\u202f741 sats`);
  expect(satsWhole(1234.567)).toBe(`1\u202f234${decimal}567`);
  expect(sats(1234.5, 'up')).toBe(`${about} 2`);
  // Rounding is never down: a ceiling of 29.079 sats is not shown as 29.
  expect(amount(29079, 'up')).toBe(`${about} 30 sats`);
  expect(amount(29000, 'up')).toBe('29 sats');
  for (const msat of [1, 999, 1001, 21187, 29079, 71921, 177447]) expect(amount(msat, 'up')).not.toMatch(/\d[.,]\d/);
  // An estimate keeps its own sign and is not marked twice.
  expect(estimatedSats(9750, true, 'up')).toBe('≈ 10');
  expect(estimatedSats(9750, false, 'up')).toBe(`${about} 10`);
  expect(estimatedSats(9000, true, 'up')).toBe('≈ 9');
  // The exact value stays available for technical details.
  expect(exactSats(1234)).toBe(`1${decimal}234`);
  expect(exactSats(-1234567890123)).toBe(`-1\u202f234\u202f567\u202f890${decimal}123`);
});

it.each(['en', 'da'] as const)('pastes %s display amounts exactly or refuses them, never changing their value', locale => {
  setLanguagePref(locale);
  for (const unit of ['sats', 'btc'] as const) {
    setDenom(unit);
    for (const msat of [0, -1234, 1, 11, 500, 1000, 1001, 1234, 1250, 21187, 1234567, 1250000, Number.MAX_SAFE_INTEGER]) {
      const displayed = sats(msat, 'up');
      // A rounded sats display ("about 2") is refused, never read as a different amount.
      const refused = msat <= 0 || (unit === 'sats' && msat % 1000 !== 0);
      expect(parseAmount(displayed, unit), displayed).toBe(refused ? null : msat);
      // Including the displayed unit is also refused by the existing input grammar.
      expect(parseAmount(amount(msat, 'up'), unit)).toBeNull();
      // Even a paste after changing the language must be exact or refused.
      const otherLanguage = locale === 'da' ? 'en' : 'da';
      const parsed = parseAmount(displayed, unit, otherLanguage);
      expect(parsed === null || parsed === msat, displayed).toBe(true);
    }
    expect(amount(1234, 'up')).toBe(unit === 'btc' ? '0.00000001234 BTC' : locale === 'da' ? 'ca. 2 sats' : 'about 2 sats');
  }
});

it('groups signed large values; only BTC keeps msat precision', () => {
  expect(amount(1250000, 'up')).toBe('1\u202f250 sats');
  expect(amount(-1234567890123, 'up')).toBe('about -1\u202f234\u202f567\u202f891 sats');
  expect(satsWhole(1234567)).toBe('1\u202f234\u202f567');
  expect(amount(Number.MAX_SAFE_INTEGER, 'up')).toBe('about 9\u202f007\u202f199\u202f254\u202f741 sats');
  expect(exactSats(Number.MAX_SAFE_INTEGER)).toBe('9\u202f007\u202f199\u202f254\u202f740.991');
  setDenom('btc');
  expect(amount(1234567890123000, 'up')).toBe('12\u202f345.67890123 BTC');
});

it.each(['en', 'da'] as const)('uses readable digit groups in %s running text and copy-pastes exactly', locale => {
  setLanguagePref(locale);
  expect(t('uiSentTo', amount(1250000, 'up'), 'Robin')).toContain('1\u202f250 sats');
  expect(t('uiBalancesAndCostsUseThisUnitEverywhereYour')).toContain('1 sat = 1\u202f000');
  expect(parseAmount(sats(1250000, 'up'), 'sats')).toBe(1250000);
  expect(amountText(1250000, 'sats')).toBe('1250');
});
