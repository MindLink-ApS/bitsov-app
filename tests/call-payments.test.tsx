/**
 * M6 A2: a node-routed call is paid while it runs. The owner agrees to the
 * callee's per-minute price and the most any node may hold before Ring (sent
 * to the host with the offer); once it rings the card shows the node's exact
 * hold under its own call limit (`max_call_minutes`) and pays no minute until
 * the owner confirms it; a hold the host refuses (none, or above the consent)
 * ends the call with nothing paid; the caller pays one block per minute from
 * the answer on, at the node's reservation price, never an amount of its own;
 * the card shows the node's own running cost; every way the node or the
 * payment stops the call ends it with a plain reason; afterwards the card says
 * what was paid and what was released.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import { setLanguagePref } from '../src/i18n';
import { resetContactsForTests, setPetname } from '../src/control/petnames';
import { createCallEngine, parseSignal, SILENCED_GRACE_MS, type CallDeps, type CallView } from '../src/control/call';
import {
  BLOCK_GRACE_MS, ENDED_CONFIRM_MS, MAX_ATTEMPTS, PASSING_MAX_ATTEMPTS, RETRY_MS, STATUS_POLL_MS,
  createCallMinutes, waitUntilPaid, type MinutesDeps, type MinutesStop, type MinutesView,
} from '../src/control/callMinutes';
import { createNodeRoutedConnection, nodeRoutedSdp, type MediaSessionEvent } from '../src/control/nodeRoutedConnection';
import type { CallAudio } from '../src/control/callAudio';
import type { MediaBridge, MediaLink } from '../src/control/mediaBridge';
import { amount } from '../src/control/format';
import { provenUnpaid } from '../src/control/paymentOutcome';
import type { ActionError, CallQuote, CallReceipt, CallReservation, CallStatus, NodeGrantSummary, SpendView } from '../src/control/types';
import type { PairingView as OnboardingPairingView } from '../src/onboarding/pairing';

const OWN = '1'.repeat(64);
const A = 'a'.repeat(64);
const ID = '0123456789abcdef0123456789abcdef';
const BLOCK = 10_000;
const FEE = 5_000;
const QUOTE: CallQuote = {
  offer_msat: 10_000, offer_max_routing_fee_msat: 5_000, signal_msat: 1_000, signal_max_routing_fee_msat: 5_000, call_total_msat: 21_000,
  block_msat: BLOCK, block_max_routing_fee_msat: FEE, reservation_max_msat: 240 * (BLOCK + FEE), minutes_payable: true,
};
const CONSENT = { block_msat: BLOCK, block_max_routing_fee_msat: FEE, max_hold_msat: 240 * (BLOCK + FEE) };
const ABOVE = 'Your node reserved 36 sats for this call, more than you agreed to before calling. No minute was paid. The app hung up the call; your node releases what it held.';

type Outcome<T> = { ok: true; value: T } | { ok: false; error: ActionError };
const ok = <T,>(value: T): Outcome<T> => ({ ok: true, value });
const fail = (code: string, message = `refused: ${code}`): Outcome<never> => ({ ok: false, error: { code, message } as ActionError });
const receipt = (seq: number): CallReceipt => ({ message_id: `blk${seq}`, kind: 404, amount_msat: BLOCK, total_msat: BLOCK + FEE, max_routing_fee_msat: FEE, delivered: true, accepted: true, sent_at_ms: 0 });

/**
 * The caller's node as `GET /calls?peer=` reports one call: answered at
 * `answeredAt`, a reservation of `minutes` blocks (its call limit, 240 by
 * default), and blocks settling when paid.
 */
function fakeNode(opts: { now: () => number; perBlock?: number; reservation?: boolean; minutes?: number } ) {
  const perBlock = opts.perBlock ?? BLOCK;
  const minutes = opts.minutes ?? 240;
  const node = {
    answeredAt: opts.now(),
    seq: 0,
    paidUntil: null as number | null,
    ended: false,
    reservation: opts.reservation === false ? null : {
      reserved_msat: minutes * (perBlock + FEE), spent_msat: 0, remaining_msat: minutes * (perBlock + FEE),
      per_block_msat: perBlock, per_block_fee_msat: FEE, max_call_minutes: minutes, released_msat: 0, closed: false,
    } as CallReservation | null,
    status: (): CallStatus => ({
      id: ID, state: node.ended ? 'ended' : 'live', direction: 'outgoing', paid_until_ms: node.paidUntil, next_block_seq: node.seq,
      next_block_due_ms: node.ended ? null : node.paidUntil === null ? node.answeredAt : node.paidUntil - 20_000,
      reservation: node.reservation ? { ...node.reservation } : null,
    }),
    /** A block settles: one more paid minute from the previous boundary. */
    settle: (seq: number) => {
      node.seq = seq + 1;
      node.paidUntil = (node.paidUntil ?? node.answeredAt) + 60_000;
      if (node.reservation) {
        node.reservation.spent_msat += perBlock + FEE;
        node.reservation.remaining_msat -= perBlock + FEE;
      }
    },
    /** The call ended: the node closes the reservation and releases the rest. */
    close: () => {
      node.ended = true;
      if (node.reservation) {
        node.reservation.released_msat = node.reservation.remaining_msat;
        node.reservation.remaining_msat = 0;
        node.reservation.closed = true;
      }
    },
  };
  return node;
}

describe('paying the minutes of one outgoing call', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_790_000_000_000); });
  afterEach(() => { vi.useRealTimers(); });

  function session(node: ReturnType<typeof fakeNode>, pay?: MinutesDeps['pay'], pays = true, hold?: MinutesDeps['hold']) {
    const views: MinutesView[] = [];
    const stops: MinutesStop[] = [];
    const deps: MinutesDeps = {
      status: vi.fn(async () => ok(node.status())),
      hold: vi.fn(hold ?? (async () => ok(node.status()))),
      pay: vi.fn(pay ?? (async (_peer, _call, seq) => { node.settle(seq); return ok(receipt(seq)); })),
    };
    const minutes = createCallMinutes({
      peer: A, callId: ID, agreedBlockMsat: BLOCK, reservationMaxMsat: QUOTE.reservation_max_msat!, pays, deps, now: () => Date.now(),
      onChange: (v) => views.push(v), onStop: (s) => stops.push(s),
    });
    const last = () => views[views.length - 1];
    /** Rung: the host checked the node's hold; the owner confirmed it as shown. */
    const confirmed = async () => { await minutes.refresh(); await minutes.confirm(); expect(last().confirmed).toBe(true); };
    return { minutes, deps, views, stops, last, confirmed };
  }

  it('a call is paid to its hold, at the exact boundary, and a minute past it is refused and ends the call', async () => {
    const node = fakeNode({ now: () => Date.now(), minutes: 3 });
    const s = session(node);
    await s.confirmed();
    s.minutes.start();
    await vi.advanceTimersByTimeAsync(1);
    for (let i = 0; i < 2; i++) await vi.advanceTimersByTimeAsync(60_000);
    expect(s.deps.pay).toHaveBeenCalledTimes(3);
    expect(s.stops).toEqual([]);
    expect(node.reservation!.spent_msat).toBe(node.reservation!.reserved_msat);
    // A node that still asks for a minute past the hold: nothing is paid for it.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.deps.pay).toHaveBeenCalledTimes(3);
    expect(s.stops[0]?.code).toBe('hold_refused');
    expect(s.stops[0]?.message).toMatch(/nothing was paid for it/i);
  });

  it('the sum of paid receipts stops a minute when the node’s spent figure lags', async () => {
    const node = fakeNode({ now: () => Date.now(), minutes: 2 });
    const settle = node.settle;
    node.settle = (seq) => { settle(seq); node.reservation!.spent_msat = 0; };
    const s = session(node);
    await s.confirmed();
    s.minutes.start();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.deps.pay).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.deps.pay).toHaveBeenCalledTimes(2);
    expect(s.stops[0]?.code).toBe('hold_refused');
  });

  it('a direct call (no routing fee), with its hold above the minutes, is not cut short', async () => {
    const node = fakeNode({ now: () => Date.now(), minutes: 3 });
    node.reservation = { ...node.reservation!, per_block_fee_msat: 0, reserved_msat: 3 * BLOCK + 1_000, remaining_msat: 3 * BLOCK + 1_000 };
    const settle = node.settle;
    node.settle = (seq) => { settle(seq); node.reservation!.spent_msat = (seq + 1) * BLOCK; };
    const s = session(node, async (_peer, _call, seq) => { node.settle(seq); return ok({ ...receipt(seq), total_msat: BLOCK, max_routing_fee_msat: 0 }); });
    await s.confirmed();
    s.minutes.start();
    await vi.advanceTimersByTimeAsync(1);
    for (let i = 0; i < 2; i++) await vi.advanceTimersByTimeAsync(60_000);
    expect(s.deps.pay).toHaveBeenCalledTimes(3);
    expect(s.stops).toEqual([]);
  });

  it('pays no minute before the owner confirms the node’s exact hold, then pays block 0', async () => {
    const node = fakeNode({ now: () => Date.now(), minutes: 60 });
    const s = session(node);
    await s.minutes.refresh();
    expect(s.deps.hold).toHaveBeenLastCalledWith(A, ID, null);
    expect(s.last()).toMatchObject({ confirmed: false, reservation: { max_call_minutes: 60, reserved_msat: 60 * (BLOCK + FEE) } });
    s.minutes.start();
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS * 2);
    expect(s.deps.pay).not.toHaveBeenCalled();
    await s.minutes.confirm();
    // The confirmation names the node's own total; the host checks it is still that hold.
    expect(s.deps.hold).toHaveBeenLastCalledWith(A, ID, 60 * (BLOCK + FEE));
    await vi.advanceTimersByTimeAsync(0);
    expect(s.deps.pay).toHaveBeenCalledTimes(1);
    expect(s.deps.pay).toHaveBeenLastCalledWith(A, ID, 0);
    s.minutes.dispose();
  });

  it('no reservation at the node: the host refuses the hold and hangs up, and no minute is ever paid', async () => {
    const node = fakeNode({ now: () => Date.now(), reservation: false });
    const s = session(node, undefined, true, async () => fail('call_no_reservation', 'Your node keeps no reservation for this call’s minutes, so the app pays none of them. No minute was paid. The app hung up the call; your node releases what it held.'));
    await s.minutes.refresh();
    expect(s.stops).toEqual([{ code: 'hold_refused', message: expect.stringContaining('keeps no reservation') }]);
    expect(s.stops[0].message).toContain('does not match what you agreed to');
    s.minutes.start();
    await s.minutes.confirm();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.deps.pay).not.toHaveBeenCalled();
    expect(s.deps.hold).toHaveBeenCalledTimes(1);
  });

  it('a hold above the consent is hung up by the host before block 0: zero minutes paid', async () => {
    const node = fakeNode({ now: () => Date.now(), perBlock: BLOCK * 2 });
    const s = session(node, undefined, true, async () => fail('call_hold_above_consent', ABOVE));
    await s.minutes.refresh();
    expect(s.stops.map((x) => x.code)).toEqual(['hold_refused']);
    expect(s.stops[0].message).toContain(ABOVE);
    s.minutes.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.deps.pay).not.toHaveBeenCalled();
  });

  it('a block the host refuses for the hold stops the call; a changed hold must be confirmed again', async () => {
    const node = fakeNode({ now: () => Date.now() });
    const s = session(node, async () => fail('call_hold_above_consent', ABOVE));
    await s.confirmed();
    s.minutes.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.stops.map((x) => x.code)).toEqual(['hold_refused']);
    expect(s.deps.pay).toHaveBeenCalledTimes(1);
    // The hold changed between the card and the confirmation: not confirmed, read again, nothing paid.
    const changed = session(fakeNode({ now: () => Date.now() }), undefined, true,
      vi.fn(async (_p: string, _c: string, confirm: number | null) => confirm === null ? ok(node.status()) : fail('call_hold_changed', 'Your node’s hold for this call is not the one you confirmed.')));
    await changed.minutes.refresh();
    await changed.minutes.confirm();
    expect(changed.last()).toMatchObject({ confirmed: false, confirming: false, holdError: expect.stringContaining('not the one you confirmed') });
    changed.minutes.start();
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS * 2);
    expect(changed.deps.pay).not.toHaveBeenCalled();
    changed.minutes.dispose();
  });

  it('pays block 0 at the answer and each next block when the node says it is due, never naming an amount', async () => {
    const node = fakeNode({ now: () => Date.now() });
    const s = session(node);
    await s.confirmed();
    s.minutes.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.deps.pay).toHaveBeenCalledTimes(1);
    expect(s.deps.pay).toHaveBeenLastCalledWith(A, ID, 0);
    // The running cost is the node's: one block spent, the rest still reserved.
    expect(s.last().reservation).toMatchObject({ spent_msat: BLOCK + FEE, remaining_msat: 239 * (BLOCK + FEE) });
    expect(s.last().blocks).toBe(1);
    // Block 1 is due 20 s before block 0 ends (40 s after the answer), not earlier.
    await vi.advanceTimersByTimeAsync(39_000);
    expect(s.deps.pay).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(s.deps.pay).toHaveBeenCalledTimes(2);
    expect(s.deps.pay).toHaveBeenLastCalledWith(A, ID, 1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.deps.pay).toHaveBeenCalledTimes(3);
    expect(s.last()).toMatchObject({ blocks: 3, stop: null, paying: false });
    expect(s.stops).toEqual([]);
    s.minutes.dispose();
  });

  it('pays nothing when the node reserved a higher per-minute price than the owner agreed to', async () => {
    const node = fakeNode({ now: () => Date.now(), perBlock: BLOCK + 1 });
    const s = session(node);
    await s.confirmed();
    s.minutes.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.deps.pay).not.toHaveBeenCalled();
    expect(s.stops).toEqual([{ code: 'price_changed', message: expect.stringContaining('asks more per minute') }]);
  });

  it('their node now asks more per minute: the block is refused and the call stops', async () => {
    const node = fakeNode({ now: () => Date.now() });
    const s = session(node, async () => fail('call_price_changed'));
    await s.confirmed();
    s.minutes.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.stops.map((x) => x.code)).toEqual(['price_changed']);
  });

  it('a refused minute stops the call with the refusal, and nothing else is paid', async () => {
    const node = fakeNode({ now: () => Date.now() });
    const s = session(node, async () => fail('grant_paused', 'Your node paused spending after failed payments. Nothing was sent.'));
    await s.confirmed();
    s.minutes.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.stops).toHaveLength(1);
    expect(s.stops[0].code).toBe('payment_failed');
    expect(s.stops[0].message).toContain('could not be paid');
    expect(s.stops[0].message).toContain('paused spending');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.deps.pay).toHaveBeenCalledTimes(1);
  });

  it('a minute the node did not dispatch is tried again a few times, then the call stops', async () => {
    const node = fakeNode({ now: () => Date.now() });
    const s = session(node, async () => fail('not_dispatched', 'Nothing was paid.'));
    await s.confirmed();
    s.minutes.start();
    await vi.advanceTimersByTimeAsync(RETRY_MS * MAX_ATTEMPTS + 1);
    expect(s.deps.pay).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(s.stops.map((x) => x.code)).toEqual(['payment_failed']);
  });

  // The refusal a real node gives while its chain source is silent.
  const NOT_READY = 'Money is not ready yet. Your node will retry automatically.';

  it('a minute refused for a passing reason keeps the call: tried again, paid once when it clears', async () => {
    for (const code of ['not_ready', 'peer_not_ready', 'grant_rate_limited', 'grant_velocity', 'call_liquidity_unavailable']) {
      const node = fakeNode({ now: () => Date.now() });
      let refusals = 8;
      const s = session(node, async (_peer, _call, seq) => {
        if (refusals-- > 0) return fail(code, NOT_READY);
        node.settle(seq);
        return ok(receipt(seq));
      });
      await s.confirmed();
      s.minutes.start();
      await vi.advanceTimersByTimeAsync(RETRY_MS * 8 + 1);
      expect(s.stops, code).toEqual([]);
      expect(s.deps.pay, code).toHaveBeenCalledTimes(9);
      expect(node.seq, code).toBe(1);
      expect((s.deps.pay as ReturnType<typeof vi.fn>).mock.calls.every(([, , seq]) => seq === 0), code).toBe(true);
      expect(s.last().receiptsMsat, code).toBe(BLOCK + FEE);
      s.minutes.dispose();
    }
  });

  it('a passing refusal is tried again only while paid time and grace remain', async () => {
    const node = fakeNode({ now: () => Date.now() });
    let refusing = false;
    const s = session(node, async (_peer, _call, seq) => {
      if (refusing) return fail('not_ready', NOT_READY);
      node.settle(seq);
      return ok(receipt(seq));
    });
    await s.confirmed();
    s.minutes.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(node.seq).toBe(1);
    refusing = true;
    // Block 1 falls due 20 seconds before the paid time ends; the node's grace ends 10 seconds after it.
    await vi.advanceTimersByTimeAsync(39_000);
    (s.deps.pay as ReturnType<typeof vi.fn>).mockClear();
    await vi.advanceTimersByTimeAsync(20_000 + BLOCK_GRACE_MS);
    const tries = (s.deps.pay as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(tries).toBeGreaterThan(MAX_ATTEMPTS);
    expect(tries).toBeLessThanOrEqual(PASSING_MAX_ATTEMPTS);
    expect(s.stops.map((x) => x.code)).toEqual(['payment_failed']);
    expect(s.stops[0].message).toContain('could not be paid');
    await vi.advanceTimersByTimeAsync(120_000);
    expect((s.deps.pay as ReturnType<typeof vi.fn>).mock.calls.length).toBe(tries);
    expect(node.seq).toBe(1);
  });

  it('a call that never paid its first minute stops trying after the bound', async () => {
    const node = fakeNode({ now: () => Date.now() });
    const s = session(node, async () => fail('not_ready', NOT_READY));
    await s.confirmed();
    s.minutes.start();
    await vi.advanceTimersByTimeAsync(RETRY_MS * PASSING_MAX_ATTEMPTS + 1);
    expect(s.deps.pay).toHaveBeenCalledTimes(PASSING_MAX_ATTEMPTS);
    expect(s.stops.map((x) => x.code)).toEqual(['payment_failed']);
    expect(node.seq).toBe(0);
  });

  it('the call ending stops the tries of a passing refusal', async () => {
    const node = fakeNode({ now: () => Date.now() });
    const s = session(node, async () => fail('not_ready', NOT_READY));
    await s.confirmed();
    s.minutes.start();
    await vi.advanceTimersByTimeAsync(RETRY_MS + 1);
    expect(s.deps.pay).toHaveBeenCalledTimes(2);
    s.minutes.finish();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.deps.pay).toHaveBeenCalledTimes(2);
    expect(s.stops).toEqual([]);
  });

  it('a budget that has no room ends the call at once with its own plain reason, in both languages', async () => {
    for (const code of ['budget_exhausted', 'ceiling_exhausted']) {
      for (const [language, words] of [['en', 'You have reached your budget'], ['da', 'Du har nået dit budget']] as const) {
        setLanguagePref(language);
        const node = fakeNode({ now: () => Date.now() });
        const s = session(node, async () => fail(code, 'You have used 42 sats of 50 sats for this contact in the last 24 hours, and this costs 10 sats. Raise the budget to send.'));
        await s.confirmed();
        s.minutes.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(s.stops.map((x) => x.code), code).toEqual(['budget_limit']);
        expect(s.stops[0].message, code).toContain(words);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(s.deps.pay, code).toHaveBeenCalledTimes(1);
      }
    }
    setLanguagePref('system');
  });

  it('a minute refused because they are not a contact is refused, not unknown: no pending result to check', async () => {
    const node = fakeNode({ now: () => Date.now() });
    const s = session(node, async () => fail('call_needs_contact', 'Calls go to contacts you have already paid. Send them a message first. Nothing was paid.'));
    await s.confirmed();
    s.minutes.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.stops.map((x) => x.code)).toEqual(['payment_failed']);
    expect(s.stops[0].message).toContain('Nothing was paid');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.deps.pay).toHaveBeenCalledTimes(1);
  });

  it('a minute whose result is unknown is never paid again on top of it', async () => {
    const node = fakeNode({ now: () => Date.now() });
    const s = session(node, async () => fail('spend_unknown', 'The node did not return a complete response.'));
    await s.confirmed();
    s.minutes.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.stops.map((x) => x.code)).toEqual(['payment_unknown']);
    expect(s.stops[0].message).toContain('Check the pending result');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.deps.pay).toHaveBeenCalledTimes(1);
  });

  it('Unpaid: the node ended the call after its paid time and grace ran out', async () => {
    const node = fakeNode({ now: () => Date.now() });
    const s = session(node);
    await s.confirmed();
    s.minutes.start();
    await vi.advanceTimersByTimeAsync(0);
    // Paying stops elsewhere (say, the app was suspended): the node ends the call once grace runs out.
    node.ended = true;
    vi.setSystemTime(node.paidUntil! + BLOCK_GRACE_MS + 1);
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS);
    expect(s.stops.map((x) => x.code)).toEqual(['unpaid']);
    expect(s.stops[0].message).toBe('Payment for the call stopped, so their node ended it.');
  });

  it('the node ended the call for another reason: their hangup gets a moment to name it first', async () => {
    const node = fakeNode({ now: () => Date.now() });
    const s = session(node);
    await s.confirmed();
    s.minutes.start();
    await vi.advanceTimersByTimeAsync(0);
    node.ended = true;
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS);
    expect(s.stops).toEqual([]);
    await vi.advanceTimersByTimeAsync(ENDED_CONFIRM_MS);
    expect(s.stops.map((x) => x.code)).toEqual(['node_ended']);
  });

  it('a block the node keeps refusing as not live ends with node_ended, never as an unknown payment', async () => {
    const node = fakeNode({ now: () => Date.now() });
    const s = session(node, async () => fail('call_not_live', 'The node refused this call signal before payment. Nothing was paid.'));
    await s.confirmed();
    s.minutes.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(s.deps.pay).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(s.stops.map((x) => x.code)).toEqual(['node_ended']);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.deps.pay).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  it('after the call it pays nothing more and reads the node until the reservation is released', async () => {
    const node = fakeNode({ now: () => Date.now() });
    const s = session(node);
    await s.confirmed();
    s.minutes.start();
    await vi.advanceTimersByTimeAsync(0);
    s.minutes.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.last().settled).toBe(false);
    node.close();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.last()).toMatchObject({ settled: true, final: true });
    expect(s.last().reservation).toMatchObject({ spent_msat: BLOCK + FEE, released_msat: 239 * (BLOCK + FEE), closed: true });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.deps.pay).toHaveBeenCalledTimes(1);
    expect(s.stops).toEqual([]);
  });

  /** A session whose call can end from inside a published view, as the call engine's own checks do. */
  function endable(node: ReturnType<typeof fakeNode>, clock: { skew: number }, endOn: (v: MinutesView) => boolean, canPay?: () => boolean) {
    const deps: MinutesDeps = {
      status: vi.fn(async () => ok(node.status())),
      hold: vi.fn(async () => ok(node.status())),
      pay: vi.fn(async (_peer: string, _call: string, seq: number) => { node.settle(seq); return ok(receipt(seq)); }),
    };
    const views: MinutesView[] = [];
    let ending = false;
    const minutes = createCallMinutes({
      peer: A, callId: ID, agreedBlockMsat: BLOCK, reservationMaxMsat: QUOTE.reservation_max_msat!, pays: true, deps,
      now: () => Date.now() + clock.skew, canPay,
      onChange: (v) => { views.push(v); if (!ending && endOn(v)) { ending = true; minutes.finish(); } },
      onStop: () => {},
    });
    return { minutes, deps, views, last: () => views[views.length - 1] };
  }

  it('a status that ends the call when it is shown is followed by no payment, though a minute is due', async () => {
    const node = fakeNode({ now: () => Date.now() });
    const clock = { skew: 0 };
    let endNow = false;
    const s = endable(node, clock, () => endNow);
    await s.minutes.refresh();
    await s.minutes.confirm();
    s.minutes.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.deps.pay).toHaveBeenCalledTimes(1);
    // The next poll arrives late, with block 1 overdue; showing it ends the call.
    clock.skew = 21_000;
    endNow = true;
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS);
    expect(s.deps.pay).toHaveBeenCalledTimes(1);
    // Ended: the session reads the node until it releases the reservation, and never pays again.
    node.close();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(s.deps.pay).toHaveBeenCalledTimes(1);
    expect(s.last()).toMatchObject({ paying: false, settled: true, final: true });
  });

  it('a call that ends when the payment is announced is not paid', async () => {
    const node = fakeNode({ now: () => Date.now() });
    const s = endable(node, { skew: 0 }, (v) => v.paying);
    await s.minutes.refresh();
    await s.minutes.confirm();
    s.minutes.start();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(s.deps.pay).not.toHaveBeenCalled();
    expect(s.last().paying).toBe(false);
  });

  it('pays nothing for a call that is no longer going on', async () => {
    const node = fakeNode({ now: () => Date.now() });
    let going = true;
    const s = endable(node, { skew: 0 }, () => false, () => going);
    await s.minutes.refresh();
    await s.minutes.confirm();
    s.minutes.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.deps.pay).toHaveBeenCalledTimes(1);
    going = false;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(s.deps.pay).toHaveBeenCalledTimes(1);
    s.minutes.dispose();
  });

  it('a call its node no longer lists retires the last reservation snapshot: never shown as still held', async () => {
    const node = fakeNode({ now: () => Date.now() });
    let listed = true;
    const s = session(node);
    s.deps.status = vi.fn(async () => ok(listed ? node.status() : null));
    await s.confirmed();
    s.minutes.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.last().reservation).toMatchObject({ closed: false });
    s.minutes.finish();
    listed = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.last()).toMatchObject({ settled: true, final: true, reservation: null });
    expect(s.last().receiptsMsat).toBe(BLOCK + FEE);
  });

  it('the callee only watches: it never pays, and ends when its node ends the call unpaid', async () => {
    const node = fakeNode({ now: () => Date.now(), reservation: false });
    node.settle(0);
    const s = session(node, undefined, false);
    s.minutes.start();
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS * 3);
    node.ended = true;
    vi.setSystemTime(node.paidUntil! + BLOCK_GRACE_MS + 1);
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS);
    expect(s.deps.pay).not.toHaveBeenCalled();
    expect(s.stops.map((x) => x.code)).toEqual(['unpaid']);
  });

  it('media waits for the node to report the first minute paid, and gives up when the call ends or the window runs out', async () => {
    const node = fakeNode({ now: () => Date.now() });
    const status = async () => ok(node.status());
    const paid = waitUntilPaid(status, A, ID, () => Date.now());
    await vi.advanceTimersByTimeAsync(3_000);
    node.settle(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(paid).resolves.toBe(true);
    const ended = fakeNode({ now: () => Date.now() });
    const refused = waitUntilPaid(async () => ok(ended.status()), A, ID, () => Date.now());
    ended.ended = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(refused).resolves.toBe(false);
    const never = waitUntilPaid(async () => ok(fakeNode({ now: () => Date.now() }).status()), A, ID, () => Date.now());
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(never).resolves.toBe(false);
  });
});

describe('the call engine with paid minutes', () => {
  const stream = () => {
    const tracks = [{ kind: 'audio', enabled: true, stop: vi.fn() }];
    return { getTracks: () => tracks, getAudioTracks: () => tracks, getVideoTracks: () => [], addTrack: () => {}, removeTrack: () => {} } as unknown as MediaStream;
  };
  function engine(minutes: MinutesDeps, refuse?: () => Promise<Outcome<CallReceipt>>, grant?: NodeGrantSummary) {
    const views: CallView[] = [];
    const signals: { kind: number; plaintext: string; minutes?: unknown }[] = [];
    const ended: string[] = [];
    const deps: CallDeps = {
      routed: true,
      minutes,
      ...(grant ? { grant: () => grant } : {}),
      quote: async () => ok(QUOTE),
      signal: async (_peer, kind, plaintext, _max, consent) => {
        signals.push({ kind, plaintext, ...(consent ? { minutes: consent } : {}) });
        if (refuse) return refuse();
        return ok({ operation_id: `op-${kind}`, message_id: 'm', kind, amount_msat: 1, total_msat: 1, max_routing_fee_msat: 0, delivered: true, accepted: true, sent_at_ms: 0 });
      },
      getUserMedia: async () => stream(),
      peerConnection: () => {
        const conn = { connectionState: 'new', onconnectionstatechange: null, localDescription: null as unknown };
        return Object.assign(conn, {
          iceGatheringState: 'complete', iceConnectionState: 'new',
          addTrack: () => ({}), createOffer: async () => ({ type: 'offer', sdp: 'x' }), createAnswer: async () => ({ type: 'answer', sdp: 'x' }),
          setLocalDescription: async (d: unknown) => { conn.localDescription = d; },
          setRemoteDescription: async () => {}, addIceCandidate: async () => {}, getStats: async () => new Map(), close: () => {}, restartIce: () => {},
          addEventListener: () => {}, removeEventListener: () => {},
        }) as unknown as RTCPeerConnection;
      },
      now: () => Date.now(),
      onView: (v) => views.push(v),
      onStreams: () => {},
      newCallId: () => ID,
      endCall: async (callId) => { ended.push(callId); return ok({ op_id: 'end', kind: 'call_hangup', peer: A, call_id: ID, state: 'settled', cap_msat: 6_000, paid_msat: 6_000, message_id: 'h' } as never); },
    };
    return { engine: createCallEngine(deps), views, signals, ended, last: () => views[views.length - 1] };
  }
  const minutesOf = (node: ReturnType<typeof fakeNode>, pay: MinutesDeps['pay'], hold?: MinutesDeps['hold']): MinutesDeps =>
    ({ status: vi.fn(async () => ok(node.status())), hold: vi.fn(hold ?? (async () => ok(node.status()))), pay });
  const answer = (e: ReturnType<typeof engine>) => e.engine.receive({ id: 'ans', kind: 401, sender: A, recipient: OWN, timestamp: 0, plaintext: JSON.stringify({ v: 1, call_id: ID, sdp: nodeRoutedSdp('answer', ID) }), payment_amount_msat: 1 }, OWN);

  it('the offer carries the minutes agreed before Ring, for the host to keep; never from an owner session', async () => {
    const node = fakeNode({ now: () => Date.now() });
    const e = engine(minutesOf(node, vi.fn()));
    await e.engine.place(A, 'audio', QUOTE);
    expect(e.signals).toEqual([{ kind: 400, plaintext: expect.any(String), minutes: CONSENT }]);
    e.engine.dismiss();
    const owner = engine(minutesOf(node, vi.fn()));
    await owner.engine.place(A, 'audio', { ...QUOTE, minutes_payable: false });
    expect(owner.signals).toEqual([]);
    expect(owner.last()).toMatchObject({ phase: 'ended', error: expect.stringContaining('keeps no reservation for a call’s minutes') });
  });

  it('a hold above the consent ends the call while ringing: the host hung up, no minute was paid', async () => {
    const node = fakeNode({ now: () => Date.now() });
    const pay = vi.fn(async () => ok(receipt(0)));
    const e = engine(minutesOf(node, pay, async () => fail('call_hold_above_consent', ABOVE)));
    await e.engine.place(A, 'audio', QUOTE);
    await vi.waitFor(() => expect(e.last().phase).toBe('ended'));
    expect(e.last().error).toContain(ABOVE);
    expect(e.signals.map((x) => x.kind)).toEqual([400]);
    expect(e.ended).toEqual([ID]);
    await answer(e);
    expect(pay).not.toHaveBeenCalled();
    expect(e.last().paidMsat).toBe(1);
  });

  it('the signed per-payment limit binds one agreed minute; the 6-sat message cap does not', async () => {
    const node = fakeNode({ now: () => Date.now() });
    const grant = (per: number): NodeGrantSummary => ({ expires_at_ms: Date.now() + 3_600_000, budget_msat: 500_000, remaining_msat: 500_000, per_call_max_msat: per, message_per_payment_max_msat: Math.min(per, 6_000), call_per_payment_max_msat: per });
    // A 25-sat minute (its price; the 5-sat allowance stays in the hold): above the owner's 21-sat limit.
    const dear = { ...QUOTE, block_msat: 25_000, reservation_max_msat: 240 * 30_000 };
    const owner = engine(minutesOf(node, vi.fn()), undefined, grant(21_000));
    await owner.engine.place(A, 'audio', dear);
    expect(owner.signals).toEqual([]);
    expect(owner.last()).toMatchObject({ phase: 'ended', error: expect.stringContaining('This call needs up to 25 sats per payment. Your node grant allows 21 sats per payment.') });
    // A 30-sat signed limit: messages stay at 6 sats, the 30-sat minute fits.
    const wide = engine(minutesOf(node, vi.fn()), undefined, grant(30_000));
    await wide.engine.place(A, 'audio', dear);
    expect(wide.signals.map((x) => x.kind)).toEqual([400]);
    wide.engine.dismiss();
  });

  it.each([[10_000, true], [10_001, false]] as const)('compares a minute at its price with the signed limit: block %i', async (block, dials) => {
    // The node pins no routing fee for a usable direct channel; the 5-sat allowance stays in the hold.
    const node = fakeNode({ now: () => Date.now() });
    const grant: NodeGrantSummary = { expires_at_ms: Date.now() + 3_600_000, budget_msat: 500_000, remaining_msat: 500_000,
      per_call_max_msat: 10_000, message_per_payment_max_msat: 6_000, call_per_payment_max_msat: 10_000 };
    const q = { ...QUOTE, offer_msat: 1_000, call_total_msat: 12_000, block_msat: block, reservation_max_msat: 240 * (block + FEE) };
    const e = engine(minutesOf(node, vi.fn()), undefined, grant);
    await e.engine.place(A, 'audio', q);
    if (dials) {
      expect(e.signals.map((x) => x.kind)).toEqual([400]);
      e.engine.dismiss();
    } else {
      expect(e.signals).toEqual([]);
      expect(e.last()).toMatchObject({ phase: 'ended', error: expect.stringContaining(`This call needs up to ${amount(10_001)} per payment. Your node grant allows ${amount(10_000)} per payment.`) });
    }
  });

  it('places no call whose hangup the message cap could not pay', async () => {
    const node = fakeNode({ now: () => Date.now() });
    const grant = (message: number): NodeGrantSummary => ({ expires_at_ms: Date.now() + 3_600_000, budget_msat: 500_000, remaining_msat: 500_000,
      per_call_max_msat: 50_000, message_per_payment_max_msat: message, call_per_payment_max_msat: 50_000 });
    // QUOTE's hangup: 1 sat plus a 5-sat routing allowance.
    const tight = engine(minutesOf(node, vi.fn()), undefined, grant(5_999));
    await tight.engine.place(A, 'audio', QUOTE);
    expect(tight.signals).toEqual([]);
    expect(tight.last()).toMatchObject({ phase: 'ended', error: expect.stringContaining('could not be ended') });
    expect(tight.last().error).toContain('Nothing was sent or paid.');
    // A lower signed limit: the owner could approve enough.
    expect(tight.last().error).toContain(`The owner would need to approve at least ${amount(6_000)} per payment.`);
    const fits = engine(minutesOf(node, vi.fn()), undefined, grant(6_000));
    await fits.engine.place(A, 'audio', QUOTE);
    expect(fits.signals.map((x) => x.kind)).toEqual([400]);
    fits.engine.dismiss();
  });

  it.each([
    ['en', 'A larger per-payment limit would not change that.', 'approve'],
    ['da', 'En højere grænse pr. betaling ville ikke ændre det.', 'godkende'],
  ] as const)('a hangup above the 6-sat message maximum asks for no larger limit (%s)', async (lang, words, ask) => {
    setLanguagePref(lang);
    try {
      const node = fakeNode({ now: () => Date.now() });
      const grant: NodeGrantSummary = { expires_at_ms: Date.now() + 3_600_000, budget_msat: 500_000, remaining_msat: 500_000,
        per_call_max_msat: 50_000, message_per_payment_max_msat: 6_000, call_per_payment_max_msat: 50_000 };
      // A 2-sat hangup plus its 5-sat routing allowance: above what any message payment may carry.
      const e = engine(minutesOf(node, vi.fn()), undefined, grant);
      await e.engine.place(A, 'audio', { ...QUOTE, signal_msat: 2_000 });
      expect(e.signals).toEqual([]);
      const error = e.last().error ?? '';
      expect(error).toContain(words);
      expect(error).toContain(amount(7_000));
      expect(error).toContain(amount(6_000));
      expect(error).not.toContain(ask);
    } finally {
      setLanguagePref('en');
    }
  });

  it('places no call without the per-minute price the owner agreed to', async () => {
    const e = engine({ status: vi.fn(), hold: vi.fn(), pay: vi.fn() });
    await e.engine.place(A, 'audio', { ...QUOTE, block_msat: null, reservation_max_msat: null });
    expect(e.signals).toEqual([]);
    expect(e.last()).toMatchObject({ phase: 'ended', error: 'Their node does not advertise a per-minute call price, so this call cannot be placed. Nothing was paid.' });
  });

  it('a liquidity or grant refusal of the reservation ends the call with a plain reason, nothing paid', async () => {
    for (const [code, message, words] of [
      ['call_liquidity_insufficient', 'Your node’s channel cannot hold this call’s reservation right now. Nothing was paid.', 'channel cannot hold'],
      ['grant_per_call', 'This is more than the 3,000 sats per payment your node allows. Nothing was sent.', 'reserves the call’s minutes when it rings'],
    ] as const) {
      const e = engine({ status: vi.fn(async () => ok(null)), hold: vi.fn(), pay: vi.fn() }, async () => fail(code, message));
      await e.engine.place(A, 'audio', QUOTE);
      expect(e.last().phase).toBe('ended');
      expect(e.last().error).toContain(words);
      expect(e.last().error).toContain(message);
      expect(e.last().paidMsat).toBe(0);
    }
  });

  it('their node refusing the offer above the agreed price or hold ends the call in plain words (EN/DA), nothing sent, held or paid', async () => {
    const cases = [
      ['call_offer_price_above_consent', 'Their node now asks more per minute than you agreed to, so your node did not place the call. Nothing was sent, held or paid. Check the price and call again.',
        'Deres node beder nu om mere pr. minut, end du accepterede, så din node foretog ikke opkaldet. Der blev ikke sendt, reserveret eller betalt noget. Tjek prisen, og ring igen.'],
      ['call_offer_hold_above_consent', 'Your node would hold more for this call’s minutes than you agreed to, so it did not place the call. Nothing was sent, held or paid.',
        'Din node ville reservere mere til opkaldets minutter, end du accepterede, så den foretog ikke opkaldet. Der blev ikke sendt, reserveret eller betalt noget.'],
    ] as const;
    try {
      for (const [code, en, da] of cases) {
        expect(provenUnpaid(code)).toBe(true);
        for (const [lang, words] of [['en', en], ['da', da]] as const) {
          setLanguagePref(lang);
          const hold = vi.fn();
          const pay = vi.fn();
          const e = engine({ status: vi.fn(async () => ok(null)), hold, pay }, async () => fail(code, 'host words'));
          await e.engine.place(A, 'audio', QUOTE);
          expect(e.signals.map((s) => s.kind)).toEqual([400]);
          expect(e.last()).toMatchObject({ phase: 'ended', error: words, paidMsat: 0 });
          expect(hold).not.toHaveBeenCalled();
          expect(pay).not.toHaveBeenCalled();
        }
      }
    } finally { setLanguagePref('en'); }
  });

  it('pays block 0 when their answer arrives, and their node’s `unpaid` hangup ends the call', async () => {
    const node = fakeNode({ now: () => Date.now() });
    const pay = vi.fn(async (_p: string, _c: string, seq: number) => { node.settle(seq); return ok(receipt(seq)); });
    const e = engine(minutesOf(node, pay));
    await e.engine.place(A, 'audio', QUOTE);
    expect(e.signals.map((s) => s.kind)).toEqual([400]);
    expect(e.last().phase).toBe('ringing');
    expect(e.last().minutes).toMatchObject({ agreedBlockMsat: BLOCK, reservationMaxMsat: QUOTE.reservation_max_msat });
    await vi.waitFor(() => expect(e.last().minutes?.reservation).not.toBeNull());
    await e.engine.confirmMinutes();
    expect(pay).not.toHaveBeenCalled();
    await answer(e);
    await vi.waitFor(() => expect(pay).toHaveBeenCalledWith(A, ID, 0));
    await vi.waitFor(() => expect(e.last().minutes?.reservation?.spent_msat).toBe(BLOCK + FEE));
    // Their node ended it for payment: a 403 `unpaid` bound to our offer.
    expect(parseSignal(403, JSON.stringify({ v: 1, call_id: ID, reason: 'unpaid' }))?.reason).toBe('unpaid');
    await e.engine.receive({ id: 'end', kind: 403, sender: A, recipient: OWN, timestamp: 0, plaintext: JSON.stringify({ v: 1, call_id: ID, reason: 'unpaid' }), payment_amount_msat: 1, admission_operation_id: 'op-400' }, OWN);
    expect(e.last()).toMatchObject({ phase: 'ended', reason: 'unpaid' });
    e.engine.dismiss();
  });

  it('a stop while the call runs ends it at once, never left connected', async () => {
    const node = fakeNode({ now: () => Date.now() });
    const e = engine(minutesOf(node, vi.fn(async () => fail('grant_paused', 'Your node paused spending.'))));
    await e.engine.place(A, 'audio', QUOTE);
    await vi.waitFor(() => expect(e.last().minutes?.reservation).not.toBeNull());
    await e.engine.confirmMinutes();
    await answer(e);
    await vi.waitFor(() => expect(e.last().phase).toBe('ended'));
    expect(e.last().error).toContain('A minute of the call could not be paid');
    expect(e.last().reason).toBe('failed');
  });
});

describe('node-routed calls carry audio only, and a dead media session stops the minutes', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_790_000_000_000); });
  afterEach(() => { vi.useRealTimers(); });

  const audioStream = () => {
    const tracks = [{ kind: 'audio', enabled: true, stop: vi.fn() }];
    return { getTracks: () => tracks, getAudioTracks: () => tracks, getVideoTracks: () => [], addTrack: () => {}, removeTrack: () => {} } as unknown as MediaStream;
  };
  const okReceipt = (kind: number): Outcome<CallReceipt> =>
    ok({ operation_id: `op-${kind}`, message_id: 'm', kind, amount_msat: 1, total_msat: 1, max_routing_fee_msat: 0, delivered: true, accepted: true, sent_at_ms: 0 });
  const minutesOf = (node: ReturnType<typeof fakeNode>, pay: MinutesDeps['pay']): MinutesDeps =>
    ({ status: vi.fn(async () => ok(node.status())), hold: vi.fn(async () => ok(node.status())), pay });
  const answerMessage = { id: 'ans', kind: 401, sender: A, recipient: OWN, timestamp: 0, plaintext: JSON.stringify({ v: 1, call_id: ID, sdp: nodeRoutedSdp('answer', ID) }), payment_amount_msat: 1 };

  /** The engine on the real node-routed adapter, a fake host socket and a fake audio engine. */
  function routedEngine(minutes: MinutesDeps, over: Partial<CallDeps> = {}) {
    const views: CallView[] = [];
    const signals: { kind: number; plaintext: string }[] = [];
    const sessions: MediaSessionEvent[] = [];
    const media: MediaStreamConstraints[] = [];
    let link: ((l: MediaLink) => void) | null = null;
    let fatal: (() => void) | null = null;
    const bridge: MediaBridge = { open: async (_c, _p, _f, l) => { link = l; }, send: () => {}, close: async () => {} };
    const audio = (_s: MediaStream, _t: unknown, onFatal: () => void): CallAudio => {
      fatal = onFatal;
      return { ready: Promise.resolve(), feed: () => {}, setMuted: () => {}, codecs: () => ({ sending: 'pcmu', localCaps: 1, peerCaps: null }), stats: async () => null, close: async () => {} } as CallAudio;
    };
    let calls: ReturnType<typeof createCallEngine> | null = null;
    const deps: CallDeps = {
      routed: true,
      minutes,
      quote: async () => ok(QUOTE),
      signal: async (_peer, kind, plaintext) => { signals.push({ kind, plaintext }); return okReceipt(kind); },
      getUserMedia: async (c) => { media.push(c); return audioStream(); },
      peerConnection: () => createNodeRoutedConnection({
        callId: () => calls?.view().callId ?? null, peer: () => calls?.view().peer ?? null, bridge, audio,
        onSession: (event) => { sessions.push(event); if (event.state === 'closed') calls?.mediaClosed(event.callId); },
      }),
      now: () => Date.now(),
      onView: (v) => views.push(v),
      onStreams: () => {},
      newCallId: () => ID,
      endCall: async () => ok({ op_id: 'end', kind: 'call_hangup', peer: A, call_id: ID, state: 'settled', cap_msat: 6_000, paid_msat: 6_000, message_id: 'h' } as never),
      ...over,
    };
    calls = createCallEngine(deps);
    return { engine: calls, views, signals, sessions, media, last: () => views[views.length - 1], link: (l: MediaLink) => link?.(l), fatal: () => fatal?.() };
  }

  it('a video offer to a node-routed app rings as audio and is answered without the camera', async () => {
    const node = fakeNode({ now: () => Date.now() });
    const e = routedEngine(minutesOf(node, vi.fn()));
    await e.engine.receive({ id: 'off', kind: 400, sender: A, recipient: OWN, timestamp: 0,
      plaintext: JSON.stringify({ v: 1, call_id: ID, media: 'video', sdp: nodeRoutedSdp('offer', ID) }), payment_amount_msat: 1 }, OWN);
    expect(e.last()).toMatchObject({ phase: 'incoming', media: 'audio', camera: false });
    await e.engine.accept(QUOTE);
    expect(e.media).toEqual([{ audio: true, video: false }]);
    expect(e.signals.map((x) => x.kind)).toEqual([401]);
    expect(e.last().camera).toBe(false);
  });

  it('a node-routed call placed as video goes out as audio, with no camera', async () => {
    const node = fakeNode({ now: () => Date.now() });
    const e = routedEngine(minutesOf(node, vi.fn()));
    await e.engine.place(A, 'video', QUOTE);
    expect(e.media).toEqual([{ audio: true, video: false }]);
    expect(JSON.parse(e.signals[0].plaintext).media).toBe('audio');
    expect(e.last()).toMatchObject({ media: 'audio', camera: false });
  });

  it('fatal audio mid-call closes the media session once and the minutes stop: no further block is paid', async () => {
    const node = fakeNode({ now: () => Date.now() });
    const pay = vi.fn(async (_p: string, _c: string, seq: number) => { node.settle(seq); return ok(receipt(seq)); });
    const e = routedEngine(minutesOf(node, pay));
    await e.engine.place(A, 'audio', QUOTE);
    await vi.waitFor(() => expect(e.last().minutes?.reservation).not.toBeNull());
    await e.engine.confirmMinutes();
    await e.engine.receive(answerMessage, OWN);
    await vi.waitFor(() => expect(pay).toHaveBeenCalledWith(A, ID, 0));
    await vi.advanceTimersByTimeAsync(0);
    e.link({ link: 'open', detail: null });
    await vi.waitFor(() => expect(e.last().phase).toBe('live'));
    expect(e.sessions.map((x) => x.state)).toEqual(['open']);
    e.fatal();
    expect(e.last()).toMatchObject({ phase: 'ended', reason: 'failed' });
    expect(e.sessions.map((x) => x.state)).toEqual(['open', 'closed']);
    // Long past every renewal: the minutes stopped with the media session.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(pay).toHaveBeenCalledTimes(1);
    expect(e.sessions.map((x) => x.state)).toEqual(['open', 'closed']);
  });

  it('a phone locked mid-call: minutes are paid during the grace, then the call is hung up and no further minute is paid', async () => {
    const node = fakeNode({ now: () => Date.now() });
    const pay = vi.fn(async (_p: string, _c: string, seq: number) => { node.settle(seq); return ok(receipt(seq)); });
    const ended: string[] = [];
    const e = routedEngine(minutesOf(node, pay), {
      stopWhenSilenced: true,
      endCall: async (callId) => { ended.push(callId); return ok({ op_id: 'end', kind: 'call_hangup', peer: A, call_id: ID, state: 'settled', cap_msat: 6_000, paid_msat: 6_000, message_id: 'h' } as never); },
    });
    await e.engine.place(A, 'audio', QUOTE);
    await vi.waitFor(() => expect(e.last().minutes?.reservation).not.toBeNull());
    await e.engine.confirmMinutes();
    await e.engine.receive(answerMessage, OWN);
    await vi.waitFor(() => expect(pay).toHaveBeenCalledWith(A, ID, 0));
    await vi.advanceTimersByTimeAsync(0);
    e.link({ link: 'open', detail: null });
    await vi.waitFor(() => expect(e.last().phase).toBe('live'));
    // Locked 30 s in: the next minute falls due inside the grace and is still paid...
    await vi.advanceTimersByTimeAsync(30_000);
    e.engine.setBackgrounded(true);
    await vi.advanceTimersByTimeAsync(SILENCED_GRACE_MS - 1);
    expect(e.last().phase).toBe('live');
    expect(pay).toHaveBeenCalledTimes(2);
    // ...and once the grace is over the call ends through the normal hangup.
    await vi.advanceTimersByTimeAsync(1);
    expect(e.last()).toMatchObject({ phase: 'ended', reason: 'hangup', stopped: { cause: 'background', endsAt: null } });
    expect(ended).toEqual([ID]);
    expect(e.sessions.map((x) => x.state)).toEqual(['open', 'closed']);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(pay).toHaveBeenCalledTimes(2);
  });

  it('a closed media session ends its call even when the connection never reports it; another call id is ignored', async () => {
    const node = fakeNode({ now: () => Date.now() });
    const pay = vi.fn(async (_p: string, _c: string, seq: number) => { node.settle(seq); return ok(receipt(seq)); });
    const e = engine(minutesOf(node, pay));
    await e.engine.place(A, 'audio', QUOTE);
    await vi.waitFor(() => expect(e.last().minutes?.reservation).not.toBeNull());
    await e.engine.confirmMinutes();
    await e.engine.receive(answerMessage, OWN);
    await vi.waitFor(() => expect(pay).toHaveBeenCalledWith(A, ID, 0));
    e.engine.mediaClosed('f'.repeat(32));
    expect(e.last().phase).not.toBe('ended');
    e.engine.mediaClosed(ID);
    expect(e.last()).toMatchObject({ phase: 'ended', reason: 'failed' });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(pay).toHaveBeenCalledTimes(1);
  });

  function engine(minutes: MinutesDeps) {
    const views: CallView[] = [];
    const deps: CallDeps = {
      routed: true,
      minutes,
      quote: async () => ok(QUOTE),
      signal: async (_peer, kind) => okReceipt(kind),
      getUserMedia: async () => audioStream(),
      peerConnection: () => {
        const conn = { connectionState: 'new', onconnectionstatechange: null, localDescription: null as unknown };
        return Object.assign(conn, {
          iceGatheringState: 'complete', iceConnectionState: 'new',
          addTrack: () => ({}), createOffer: async () => ({ type: 'offer', sdp: 'x' }), createAnswer: async () => ({ type: 'answer', sdp: 'x' }),
          setLocalDescription: async (d: unknown) => { conn.localDescription = d; },
          setRemoteDescription: async () => {}, addIceCandidate: async () => {}, getStats: async () => new Map(), close: () => {}, restartIce: () => {},
          addEventListener: () => {}, removeEventListener: () => {},
        }) as unknown as RTCPeerConnection;
      },
      now: () => Date.now(),
      onView: (v) => views.push(v),
      onStreams: () => {},
      newCallId: () => ID,
      endCall: async () => ok({ op_id: 'end', kind: 'call_hangup', peer: A, call_id: ID, state: 'settled', cap_msat: 6_000, paid_msat: 6_000, message_id: 'h' } as never),
    };
    return { engine: createCallEngine(deps), last: () => views[views.length - 1] };
  }
});

// ---- the shell ---------------------------------------------------------------

class FakePc { constructor() { throw new Error('no RTCPeerConnection in M6'); } }
class FakeAudioNode {
  port = { postMessage: vi.fn(), onmessage: null as unknown };
  gain = { value: 1 };
  connect<T>(next: T) { return next; }
  disconnect() {}
}
class FakeAudioContext {
  sampleRate = 48_000;
  currentTime = 0;
  destination = new FakeAudioNode();
  audioWorklet = { addModule: async () => {} };
  async resume() {}
  async close() {}
  createMediaStreamSource() { return new FakeAudioNode(); }
  createGain() { return new FakeAudioNode(); }
}
const micStream = () => {
  const tracks = [{ kind: 'audio', enabled: true, stop: vi.fn() }];
  return { getTracks: () => tracks, getAudioTracks: () => tracks, getVideoTracks: () => [], addTrack: () => {}, removeTrack: () => {} } as unknown as MediaStream;
};
const paired = { state: 'paired', scopes: ['read', 'receive', 'spend'], node_id: OWN, expires_at_ms: Date.now() + 3_600_000 } as unknown as OnboardingPairingView;

type Reply = (args?: Record<string, unknown>) => unknown;

function stubHost(opts: { quote?: CallQuote; offer?: Reply; block?: Reply; hold?: Reply; minutes?: number; endKeepsHold?: boolean; endLeavesUnresolved?: boolean } = {}) {
  resetContactsForTests();
  setPetname(A, 'Maya');
  const calls: { cmd: string; args?: unknown }[] = [];
  const callbacks = new Map<number, (e: unknown) => void>();
  let mediaIndex = 0;
  const node = fakeNode({ now: () => Date.now(), minutes: opts.minutes });
  let callId: string | null = null;
  const spending: SpendView = { state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 600_000, pending: null, window_ms: 600_000 };
  const REPLIES: Record<string, Reply> = {
    node_status: () => ({ ready: true, node_id: OWN, error: null }),
    trust_acknowledge: () => true,
    pairing_status: () => paired,
    node_overview: () => ({ node_id: OWN, status: 'ok', version: 'api v2', connected_peers: 1, e2ee_sessions: 1, pending_deliveries: 0,
      lightning_available: true, block_height: 1, uptime_secs: 1, lightning_backend: 'ldk', chain_backend: 'esplora', read_at: Date.now(), capabilities: [] }),
    peers_list: () => [{ node_id: A, addr: null, label: 'Maya', connected: true, fingerprint: null, meetings: true }],
    rooms_list: () => [],
    messages_list: () => [],
    price_quote: () => ({ kind: 0, own_msat: 1000, peer_msat: 2000, peer_age_secs: 30, max_routing_fee_msat: 0, peer_stale: false }),
    payments_overview: () => ({ balance_msat: 1_000_000, lightning_outbound_msat: 500_000, channels: [] }),
    fund_state: () => null,
    spend_status: () => spending,
    budget_status: () => null,
    call_quote: () => opts.quote ?? QUOTE,
    call_signal: (args) => {
      const kind = (args as { kind: number }).kind;
      if (kind === 400) {
        // A refused offer leaves no call (and no reservation) at the node.
        if (opts.offer) return opts.offer(args);
        callId = JSON.parse((args as { plaintext: string }).plaintext).call_id;
      }
      return { operation_id: `op-${kind}`, message_id: 'sig', kind, amount_msat: 10_000, total_msat: 15_000, max_routing_fee_msat: 5000, delivered: true, accepted: true, sent_at_ms: Date.now() };
    },
    call_status: (args) => (callId && (args as { call_id: string }).call_id === callId ? { ...node.status(), id: callId } : null),
    // The host's check of the node's hold (and the owner's confirmation of its exact total).
    call_hold: (args) => {
      if (opts.hold) return opts.hold(args);
      const confirm = (args as { confirm_reserved_msat?: number }).confirm_reserved_msat;
      if (confirm !== undefined && confirm !== node.reservation?.reserved_msat) throw { code: 'call_hold_changed', message: 'Your node’s hold for this call is not the one you confirmed.' };
      return { ...node.status(), id: callId };
    },
    call_block: (args) => {
      if (opts.block) return opts.block(args);
      const seq = (args as { seq: number }).seq;
      node.settle(seq);
      return receipt(seq);
    },
    op_end_call: (args) => {
      if (!callId) throw { code: 'call_not_found', message: 'No outgoing admission is recorded for this call.' };
      // A node that is slow to release: the hold stays until the test closes it.
      if (!opts.endKeepsHold) node.close();
      // A minute whose payment is still unresolved stays in the closed hold.
      if (opts.endLeavesUnresolved && node.reservation) { node.reservation.remaining_msat = BLOCK + FEE; node.reservation.released_msat -= BLOCK + FEE; }
      return { op_id: 'end', kind: 'call_hangup', peer: A, call_id: (args as { call_id: string }).call_id, state: 'settled', cap_msat: 6_000, paid_msat: 6_000, message_id: 'hangup' };
    },
    op_list: () => ({ operations: [], skipped: 0, has_more: false }),
    live_link: () => null,
    call_media_open: () => null,
    call_media_send: () => null,
    call_media_close: () => null,
    'plugin:event|listen': () => 1,
    'plugin:event|unlisten': () => null,
  };
  vi.stubGlobal('__TAURI_INTERNALS__', {
    transformCallback: (cb: (e: unknown) => void) => { const id = callbacks.size + 1; callbacks.set(id, cb); return id; },
    invoke: (cmd: string, args?: unknown) => {
      calls.push({ cmd, args });
      const reply = REPLIES[cmd];
      if (!reply) return Promise.reject(new Error(`unexpected ${cmd}`));
      try { return Promise.resolve(reply(args as Record<string, unknown>)); } catch (e) { return Promise.reject(e); }
    },
  });
  vi.stubGlobal('__TAURI_EVENT_PLUGIN_INTERNALS__', { unregisterListener: () => {} });
  return {
    node,
    calls,
    callId: () => callId!,
    used: (cmd: string) => calls.filter((c) => c.cmd === cmd),
    emitLive: (payload: unknown) => {
      const listen = calls.find((c) => c.cmd === 'plugin:event|listen');
      callbacks.get((listen!.args as { handler: number }).handler)!({ event: 'node-live', id: 1, payload });
    },
    media: (message: unknown) => {
      const opens = calls.filter((c) => c.cmd === 'call_media_open');
      const channel = (opens[opens.length - 1]!.args as { on_frame: { id: number } }).on_frame;
      callbacks.get(channel.id)!({ message, index: mediaIndex++ });
    },
  };
}

describe('the shell: consent, running cost, stop states and summary', () => {
  let dispose: (() => void) | undefined;
  let mount: HTMLElement;
  beforeEach(() => {
    vi.stubEnv('VITE_CALL_MEDIA', 'node');
    vi.stubGlobal('isTauri', true);
    vi.stubGlobal('RTCPeerConnection', FakePc);
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('AudioWorkletNode', FakeAudioNode);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => micStream() } });
  });
  afterEach(() => {
    setLanguagePref('en');
    dispose?.();
    dispose = undefined;
    mount?.remove();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const $ = <T extends Element = HTMLElement>(sel: string) => mount.querySelector<T>(sel);
  async function openShell() {
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => <App />, mount);
    await vi.waitFor(() => expect([...mount.querySelectorAll('button')].some((b) => b.textContent?.includes('I understand'))).toBe(true));
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
    await vi.waitFor(() => expect($(`[data-track="peer:${A}"]`)?.getAttribute('aria-current')).toBe('true'));
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
  }
  async function ringAndAnswer(host: ReturnType<typeof stubHost>) {
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ringing"]')).not.toBeNull());
    // The node's exact hold, shown once it rings: no minute is paid until the owner confirms it.
    await vi.waitFor(() => expect($('[data-call-minutes-confirm]')).not.toBeNull());
    $<HTMLButtonElement>('[data-call-minutes-confirm]')!.click();
    await vi.waitFor(() => expect($('[data-call-minutes-confirm]')).toBeNull());
    const callId = host.callId();
    host.emitLive({ type: 'message', room_id: null, message: { id: 'ans', kind: 401, sender: A, recipient: OWN, timestamp: Date.now(), plaintext: JSON.stringify({ v: 1, call_id: callId, sdp: nodeRoutedSdp('answer', callId) }), payment_amount_msat: 1000 } });
    return callId;
  }

  it('shows the per-minute price and the most the node will hold before Ring; nothing is dialled until Ring', async () => {
    const host = stubHost();
    await openShell();
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    expect($('[data-call-minute-price]')?.textContent).toBe(`Then ${amount(BLOCK)} a minute, plus up to ${amount(FEE)} routing a minute, paid by your node while the call runs.`);
    expect($('[data-call-reservation-max]')?.textContent).toBe(`When it rings, your node holds the minutes under its own call limit. The call goes out with your limits: this per-minute price and a hold of at most ${amount(240 * (BLOCK + FEE))} (4 hours, the most a node allows). If their live price or the hold would be higher, your node does not ring them and nothing is paid. You see the exact hold and confirm it before the first minute is paid.`);
    expect(host.used('call_signal')).toHaveLength(0);
    $<HTMLButtonElement>('[data-call-confirm-cancel]')!.click();
    expect($('[data-call-confirm-box]')).toBeNull();
    expect(host.used('call_signal')).toHaveLength(0);
    expect(host.used('call_block')).toHaveLength(0);
  });

  it('says it in Danish too', async () => {
    stubHost();
    setLanguagePref('da');
    await openShell();
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    expect($('[data-call-minute-price]')?.textContent).toContain('pr. minut');
    expect($('[data-call-reservation-max]')?.textContent).toContain('ringer din node ikke op');
  });

  it('once it rings, the card shows the node’s exact hold under its own call limit (max_call_minutes) to confirm', async () => {
    const host = stubHost({ minutes: 60 });
    await openShell();
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-hold]')).not.toBeNull());
    expect($('[data-call-hold]')!.textContent).toBe(
      `Your node holds ${amount(60 * (BLOCK + FEE))} for this call: up to 60 minutes (its call limit) at ${amount(BLOCK)} a minute plus up to ${amount(FEE)} routing. It releases what is not used when the call ends. No minute is paid until you confirm.`);
    expect(host.used('call_block')).toHaveLength(0);
    $<HTMLButtonElement>('[data-call-minutes-confirm]')!.click();
    await vi.waitFor(() => expect(host.used('call_hold').slice(-1)[0]?.args).toEqual({ peer: A, call_id: host.callId(), confirm_reserved_msat: 60 * (BLOCK + FEE) }));
    await vi.waitFor(() => expect($('[data-call-hold]')).toBeNull());
    expect(host.used('call_block')).toHaveLength(0);
  });

  it('says the hold in Danish too, with the node’s call limit', async () => {
    stubHost({ minutes: 60 });
    setLanguagePref('da');
    await openShell();
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-hold]')).not.toBeNull());
    expect($('[data-call-hold]')!.textContent).toContain('højst 60 minutter (dens opkaldsgrænse)');
    expect($('[data-call-minutes-confirm]')!.textContent).toBe('Bekræft reservation');
  });

  it('a hold above the consent: the host hung up, the card ends with the reason, and no minute is paid', async () => {
    const host = stubHost({ hold: () => { throw { code: 'call_hold_above_consent', message: ABOVE }; } });
    await openShell();
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect($('[data-call-ended]')?.textContent).toBe(`Your node’s hold for this call does not match what you agreed to, so the call ended. ${ABOVE}`);
    expect(host.used('call_block')).toHaveLength(0);
    expect(host.used('call_media_open')).toHaveLength(0);
  });

  it('an owner session (no reservation from its node) cannot ring a paid-minutes call, and the button says why', async () => {
    const host = stubHost({ quote: { ...QUOTE, minutes_payable: false } });
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => <App />, mount);
    await vi.waitFor(() => expect([...mount.querySelectorAll('button')].some((b) => b.textContent?.includes('I understand'))).toBe(true));
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')?.title).toContain('keeps no reservation for a call’s minutes'));
    expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(true);
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    expect(host.used('call_signal')).toHaveLength(0);
  });

  it('a callee without a per-minute price cannot be rung, and the button says why', async () => {
    const host = stubHost({ quote: { ...QUOTE, block_msat: null, block_max_routing_fee_msat: 0, reservation_max_msat: null } });
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => <App />, mount);
    await vi.waitFor(() => expect([...mount.querySelectorAll('button')].some((b) => b.textContent?.includes('I understand'))).toBe(true));
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')?.title).toContain('does not advertise a per-minute call price'));
    expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(true);
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    expect(host.used('call_signal')).toHaveLength(0);
  });

  it('pays the first minute at the answer, opens audio only once it is paid, and shows the node’s running cost', async () => {
    const host = stubHost();
    await openShell();
    const callId = await ringAndAnswer(host);
    await vi.waitFor(() => expect(host.used('call_block')).toHaveLength(1));
    // The renderer names no amount: the host pays the node's reservation price.
    expect(host.used('call_block')[0].args).toEqual({ peer: A, call_id: callId, seq: 0 });
    expect(host.used('call_signal')[0].args).toMatchObject({ kind: 400, minutes: CONSENT });
    expect(host.used('call_hold').map((c) => c.args)).toEqual([{ peer: A, call_id: callId }, { peer: A, call_id: callId, confirm_reserved_msat: 240 * (BLOCK + FEE) }]);
    await vi.waitFor(() => expect(host.used('call_media_open')).toHaveLength(1), { timeout: 3_000 });
    // The socket opened after the minute was paid, never before (the node would refuse it).
    expect(host.calls.findIndex((c) => c.cmd === 'call_media_open')).toBeGreaterThan(host.calls.findIndex((c) => c.cmd === 'call_block'));
    await vi.waitFor(() => expect($('[data-call-minutes="running"]')?.textContent).toBe(
      `${amount(BLOCK)} a minute (plus up to ${amount(FEE)} routing). Paid so far: ${amount(BLOCK + FEE)}. Still reserved: ${amount(239 * (BLOCK + FEE))}.`));
    host.media({ link: 'open', detail: null });
    await vi.waitFor(() => expect($('[data-call-panel="live"]')).not.toBeNull());
    expect($('[data-call-route="node"]')).not.toBeNull();
  });

  it('Unpaid: their node ends the call for payment; the card ends with the reason, not live', async () => {
    const host = stubHost();
    await openShell();
    const callId = await ringAndAnswer(host);
    await vi.waitFor(() => expect(host.used('call_media_open')).toHaveLength(1), { timeout: 3_000 });
    host.media({ link: 'open', detail: null });
    await vi.waitFor(() => expect($('[data-call-panel="live"]')).not.toBeNull());
    host.emitLive({ type: 'message', room_id: null, message: { id: 'unpaid', kind: 403, sender: A, recipient: OWN, timestamp: Date.now(), plaintext: JSON.stringify({ v: 1, call_id: callId, reason: 'unpaid' }), payment_amount_msat: 1000, admission_operation_id: 'op-400' } });
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect($('[data-call-ended]')?.textContent).toBe('Payment stopped, so the call ended.');
    await vi.waitFor(() => expect(host.used('call_media_close').length).toBeGreaterThan(0));
  });

  it('payment_failed: a refused minute ends the call with a plain reason', async () => {
    const host = stubHost({ block: () => { throw { code: 'grant_paused', message: 'Your node paused spending after failed payments. Nothing was sent.' }; } });
    await openShell();
    await ringAndAnswer(host);
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect($('[data-call-ended]')?.textContent).toBe('A minute of the call could not be paid, so the call ended. Nothing was paid for that minute. Your node paused spending after failed payments. Nothing was sent.');
    expect(host.used('call_media_open')).toHaveLength(0);
  });

  it('a budget with no room ends the call with its own plain reason, not as a failed payment', async () => {
    const host = stubHost({ block: () => { throw { code: 'budget_exhausted', message: 'You have used 42 sats of 50 sats for this contact in the last 24 hours, and this costs 10 sats. Raise the budget to send.' }; } });
    await openShell();
    await ringAndAnswer(host);
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect($('[data-call-ended]')?.textContent).toBe('You have reached your budget, so the call ended. Nothing was paid for the next minute. Raise the budget to call again.');
    expect(host.used('call_block')).toHaveLength(1);
  });

  it('money not ready does not end the call: the shell holds the minute until the node reads ready, then it is paid once', async () => {
    let refusals = 1;
    const host = stubHost({ block: (args) => {
      if (refusals-- > 0) throw { code: 'not_ready', message: 'Money is not ready yet. Your node will retry automatically.' };
      const seq = (args as { seq: number }).seq;
      host.node.settle(seq);
      return receipt(seq);
    } });
    await openShell();
    await ringAndAnswer(host);
    await vi.waitFor(() => expect(host.used('call_block')).toHaveLength(1));
    // Until the next overview read the shell refuses the tries itself, so the host hears of none.
    await vi.waitFor(() => expect(host.node.seq).toBe(1), { timeout: 14_000 });
    expect($('[data-call-panel="ended"]')).toBeNull();
    expect(host.used('call_block').map((c) => (c.args as { seq: number }).seq)).toEqual([0, 0]);
  }, 20_000);

  it('a liquidity refusal of the reservation ends the call before ringing, nothing paid', async () => {
    const host = stubHost({ offer: () => { throw { code: 'call_liquidity_insufficient', message: 'Your node’s channel cannot hold this call’s reservation right now. Nothing was paid. Add outbound capacity, then call again.' }; } });
    await openShell();
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect($('[data-call-ended]')?.textContent).toBe('Your node’s channel cannot hold this call’s reservation right now. Nothing was paid. Add outbound capacity, then call again.');
    expect($('[data-call-paid="nothing"]')).not.toBeNull();
    expect(host.used('call_block')).toHaveLength(0);
  });

  it('after hanging up: what the minutes cost and what the node released', async () => {
    const host = stubHost();
    await openShell();
    await ringAndAnswer(host);
    await vi.waitFor(() => expect(host.used('call_media_open')).toHaveLength(1), { timeout: 3_000 });
    host.media({ link: 'open', detail: null });
    await vi.waitFor(() => expect($('[data-call-panel="live"]')).not.toBeNull());
    $<HTMLButtonElement>('[data-call-hangup]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    await vi.waitFor(() => expect($('[data-call-minutes="released"]')?.textContent).toBe(
      `Minutes: paid ${amount(BLOCK + FEE)}. Released back to your budget: ${amount(239 * (BLOCK + FEE))}.`), { timeout: 4_000 });
    expect(host.used('call_block')).toHaveLength(1);
  }, 15_000);

  it('a closed hold that still holds an unresolved minute never says "nothing more is paid"', async () => {
    const host = stubHost({ endLeavesUnresolved: true });
    await openShell();
    await ringAndAnswer(host);
    await vi.waitFor(() => expect(host.used('call_media_open')).toHaveLength(1), { timeout: 3_000 });
    host.media({ link: 'open', detail: null });
    await vi.waitFor(() => expect($('[data-call-panel="live"]')).not.toBeNull());
    $<HTMLButtonElement>('[data-call-hangup]')!.click();
    await vi.waitFor(() => expect($('[data-call-minutes="released"]')).not.toBeNull(), { timeout: 4_000 });
    await vi.waitFor(() => expect($('[data-call-close]')).toBeNull(), { timeout: 4_000 });
    await new Promise((r) => setTimeout(r, 300));
    expect($('[data-call-nothing-more]')).toBeNull();
  }, 15_000);

  it('"nothing more is paid" waits for the node to release the minutes hold', async () => {
    const host = stubHost({ endKeepsHold: true });
    await openShell();
    await ringAndAnswer(host);
    await vi.waitFor(() => expect(host.used('call_media_open')).toHaveLength(1), { timeout: 3_000 });
    host.media({ link: 'open', detail: null });
    await vi.waitFor(() => expect($('[data-call-panel="live"]')).not.toBeNull());
    expect($('[data-call-nothing-more]')).toBeNull();
    $<HTMLButtonElement>('[data-call-hangup]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    // The node still holds minutes for this call: never "nothing more".
    await vi.waitFor(() => expect($('[data-call-minutes="held"]')).not.toBeNull(), { timeout: 4_000 });
    // The end is done at the host, but the node still holds minutes: still not "nothing more".
    await vi.waitFor(() => expect($('[data-call-close]')).toBeNull(), { timeout: 4_000 });
    await new Promise((r) => setTimeout(r, 300));
    expect($('[data-call-minutes="held"]')).not.toBeNull();
    expect($('[data-call-nothing-more]')).toBeNull();
    expect($('[data-call-nothing-more]')).toBeNull();
    host.node.close();
    await vi.waitFor(() => expect($('[data-call-minutes="released"]')).not.toBeNull(), { timeout: 8_000 });
    await vi.waitFor(() => expect($('[data-call-nothing-more]')?.textContent).toBe('The call is over. Nothing more is paid for it.'), { timeout: 4_000 });
  }, 20_000);
});
