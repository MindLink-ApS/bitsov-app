import { afterEach, expect, it, vi } from 'vitest';
import { amount, sats, satUnit, satsWhole } from '../src/control/format';
import { setDenom } from '../src/control/prefs';

afterEach(() => { vi.restoreAllMocks(); setDenom('sats'); });
it.each([
  ['da-DK', '188.800 sats', '21,187 sats', '0,011 sats', '1,019 sats'],
  ['en-US', '188,800 sats', '21.187 sats', '0.011 sats', '1.019 sats'],
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
