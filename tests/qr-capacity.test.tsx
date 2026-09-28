import { describe, expect, it } from 'vitest';
import { qrMatrix } from '../src/qr';

// Size = 4 × version + 17. Level M byte-mode capacity: v10 213, v11 251, v20 666,
// v21 711, v25 997, v30 1,370.
const version = (n: number) => (qrMatrix('A'.repeat(n)).length - 17) / 4;

describe('QR capacity (versions 1–30, level M)', () => {
  it('keeps short values on the versions they used before', () => {
    expect(version(42)).toBe(3); // a bc1q address
    expect(version(213)).toBe(10);
  });

  it('fits a BOLT11 invoice with a memo instead of dropping the QR', () => {
    expect(version(214)).toBe(11);
    expect(version(400)).toBe(15);
    expect(version(666)).toBe(20);
  });

  it('fits a K1 starter-bitcoin request, which wraps a whole invoice', () => {
    expect(version(667)).toBe(21);
    expect(version(748)).toBe(22); // the request from the real-window run
    expect(version(997)).toBe(25);
    expect(version(1370)).toBe(30);
  });

  it('still refuses what no supported version holds', () => {
    expect(() => qrMatrix('A'.repeat(1371))).toThrow(/too long/);
  });
});
