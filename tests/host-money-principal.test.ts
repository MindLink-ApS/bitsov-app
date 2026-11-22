import { describe, expect, it } from 'vitest';
import { hostText } from '../src/control/hostCopy';

describe('a payment principal reads as the principal in Danish', () => {
  it('names the principal, not any amount', () => {
    expect(hostText('The payment record has no principal.', 'da')).toBe('Betalingsposten har intet hovedbeløb.');
  });
});
