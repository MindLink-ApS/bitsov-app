import { describe, expect, it } from 'vitest';
import { MIN_PAYMENT_MSAT, priceBreakdown } from '../src/control/state';

const quote = { kind: 0, own_msat: 9000, peer_msat: 2250, peer_age_secs: 30, peer_stale: false, max_routing_fee_msat: 7500 };

describe('priceBreakdown (display only)', () => {
  it('splits a ceiling that is exactly peer price + routing allowance', () => {
    expect(priceBreakdown(quote, 9750)).toEqual({ priceMsat: 2250, routingMsat: 7500, ceilingMsat: 9750 });
  });
  it('uses the minimum payment the cap itself uses', () => {
    expect(priceBreakdown({ ...quote, peer_msat: 0 }, MIN_PAYMENT_MSAT + 7500)).toEqual({ priceMsat: MIN_PAYMENT_MSAT, routingMsat: 7500, ceilingMsat: MIN_PAYMENT_MSAT + 7500 });
  });
  it.each([
    ['no quote', null, 9750],
    ['no ceiling', quote, null],
    ['unknown peer price', { ...quote, peer_msat: null }, 9750],
    ['stale table', { ...quote, peer_stale: true }, 9750],
    ['missing routing allowance', { ...quote, max_routing_fee_msat: undefined }, 9750],
    ['parts that do not add up (door, readmission, room)', quote, 12000],
  ])('shows nothing for %s', (_, q, cap) => {
    expect(priceBreakdown(q as never, cap as number | null)).toBeNull();
  });
});
