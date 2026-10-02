import { describe, expect, it } from 'vitest';
import { costToSend } from '../src/control/state';
import type { PriceQuote } from '../src/control/types';

describe('all-in quote boundaries', () => {
  it('uses the host fee ceiling, including a non-default quoted fee', () => {
    const quote = { kind: 0, own_msat: 1000, peer_msat: 2000, peer_age_secs: 0,
      peer_stale: false, max_routing_fee_msat: 7500 } as PriceQuote;
    const cost = costToSend({ kind: 'peer', id: 'a'.repeat(64) }, quote)!;
    expect(cost.msat).toBe(9500);
    expect(cost.basis).toContain('up to 7,500 msat network fee');
  });
});
