import { describe, expect, it } from 'vitest';
import { amountText, inPaymentBounds, parseAmount } from '../src/control/amountInput';

// Pay and Request read typed amounts as exact integer msat. Anything finer
// than one msat is refused, never rounded into a different amount.

describe('typed amounts in sats', () => {
  it.each([
    ['21', 21_000],
    ['1', 1_000],
    ['0.001', 1],
    ['0.5', 500],
    ['.5', 500],
    ['5.', 5_000],
    ['0.500', 500],
    ['1.230000', 1_230],
    [' 1 000 ', 1_000_000],
    ['1_000', 1_000_000],
    ['9007199254740.991', Number.MAX_SAFE_INTEGER],
  ])('%s sats is %d msat', (text, msat) => {
    expect(parseAmount(text, 'sats')).toBe(msat);
  });

  it.each(['', '.', '0', '0.000', '0.0005', '1.2345', '-1', '1e3', '0x10', '1,000', '1.2.3', 'abc', 'Infinity', '9007199254740.992'])(
    'refuses %j',
    (text) => {
      expect(parseAmount(text, 'sats')).toBeNull();
    },
  );
});

describe('typed amounts in BTC', () => {
  it.each([
    ['1', 100_000_000_000],
    ['0.00000001', 1_000],
    ['0.00000000001', 1],
    // Float traps: 0.3 * 1e11 and 1.1 * 1e11 are not whole numbers in floating point.
    ['0.3', 30_000_000_000],
    ['1.1', 110_000_000_000],
    ['0.00000999', 999_000],
    ['0.12345678901', 12_345_678_901],
    ['90071.99254740991', Number.MAX_SAFE_INTEGER],
  ])('%s BTC is %d msat', (text, msat) => {
    expect(parseAmount(text, 'btc')).toBe(msat);
  });

  it.each(['0', '0.000000000001', '0.000000000005', '0.123456789012', '21000000', '90071.99254740992'])('refuses %j', (text) => {
    expect(parseAmount(text, 'btc')).toBeNull();
  });
});

describe('amount text round-trips exactly', () => {
  const values = [1, 999, 1_000, 1_001, 5_000, 21_000, 123_456_789, 30_000_000_000, 100_000_000_000, 100_000_000_001, Number.MAX_SAFE_INTEGER];
  it.each(values)('%d msat', (msat) => {
    expect(parseAmount(amountText(msat, 'sats'), 'sats')).toBe(msat);
    expect(parseAmount(amountText(msat, 'btc'), 'btc')).toBe(msat);
  });

  it('writes plain digits with no grouping or trailing zeros', () => {
    expect(amountText(1_500_000, 'sats')).toBe('1500');
    expect(amountText(1_500, 'sats')).toBe('1.5');
    expect(amountText(1_500_000, 'btc')).toBe('0.000015');
    expect(amountText(100_000_000_000, 'btc')).toBe('1');
    expect(amountText(1, 'btc')).toBe('0.00000000001');
  });
});

describe('host payment bounds (1 sat to 1 BTC)', () => {
  it.each([
    [999, false],
    [1_000, true],
    [100_000_000_000, true],
    [100_000_000_001, false],
  ])('%d msat in bounds: %s', (msat, ok) => {
    expect(inPaymentBounds(msat)).toBe(ok);
  });
});

describe('Danish thousands ambiguity', () => {
  it.each(['1.000', '1.250', '01.000', '01.250', '12.345', '1234.567', ' 1.250 '])('rejects %s in Danish sats only', text => {
    expect(parseAmount(text, 'sats', 'da')).toBeNull();
    expect(parseAmount(text, 'sats', 'en')).not.toBeNull();
    expect(parseAmount(text, 'btc', 'da')).not.toBeNull();
  });
  it.each(['en', 'da'] as const)('keeps genuine decimals and pasted spaces exact in %s', locale => {
    for (const text of ['1 250', '1\u202f250', '1\u00a0250', '1_250']) expect(parseAmount(text, 'sats', locale)).toBe(1250000);
    expect(parseAmount('1.25', 'sats', locale)).toBe(1250);
    expect(parseAmount('0.001', 'sats', locale)).toBe(1);
    expect(parseAmount('1.2500', 'sats', locale)).toBe(1250);
    expect(parseAmount('1.2345', 'sats', locale)).toBeNull();
    expect(parseAmount('0.00000000001', 'btc', locale)).toBe(1);
    for (const msat of [1001, 1250, 1234567]) expect(parseAmount(amountText(msat, 'sats', locale), 'sats', locale)).toBe(msat);
  });
});
