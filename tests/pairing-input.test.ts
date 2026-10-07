import { describe, expect, it } from 'vitest';
import { normalizePairingLink } from '../src/onboarding/pairing';

describe('shared paste, QR and deep-link envelope validation', () => {
  it('preserves the opaque ticket for the existing host parser', () => {
    expect(normalizePairingLink('  bitsov://pair/eyJ2IjoxfQ\n')).toBe('bitsov://pair/eyJ2IjoxfQ');
  });

  it('accepts the full 14 + 16384 character native envelope', () => {
    const link = 'bitsov://pair/' + 'a'.repeat(16384);
    expect(link.length).toBe(16398);
    expect(normalizePairingLink(link)).toBe(link);
  });

  it.each([
    '', 'ticket', 'https://pair/abc', 'bitsov://other/abc', 'bitsov://pair/',
    'bitsov://pair/abc?x=1', 'bitsov://pair/abc#fragment', 'bitsov://pair/abc=',
    'bitsov://pair/a/b', 'bitsov://pair/a%2Fb', 'bitsov://pair/a b',
    'bitsov://pair/' + 'a'.repeat(16385),
  ])('rejects an unsupported envelope without echoing it (case %#)', (input) => {
    expect(() => normalizePairingLink(input)).toThrow('Use a bitsov://pair/ pairing ticket from your node.');
  });
});
