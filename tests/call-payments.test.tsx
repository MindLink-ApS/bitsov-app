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
import { createCallEngine, parseSignal, shownPhase, SILENCED_GRACE_MS, type CallDeps, type CallView } from '../src/control/call';
import * as callEngine from '../src/control/call';
import {
  BLOCK_GRACE_MS, ENDED_CONFIRM_MS, MAX_ATTEMPTS, PASSING_MAX_ATTEMPTS, RETRY_MS, STATUS_POLL_MS,
  createCallMinutes, waitUntilPaid, type MinutesDeps, type MinutesStop, type MinutesView,
} from '../src/control/callMinutes';
import { createNodeRoutedConnection, LINK_GRACE_MS, nodeRoutedSdp, type MediaSessionEvent } from '../src/control/nodeRoutedConnection';
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
    expect(s.stops).toEqual([{ code: 'hold_refused', message: expect.stringContaining('keeps no reservation'), raw: expect.stringContaining('keeps no reservation') }]);
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

  it.each(['budget_exhausted', 'ceiling_exhausted'])('keeps the exact %s refusal when stopping the minutes', async code => {
    const node = fakeNode({ now: () => Date.now() });
    const message = 'You have used 42 sats of 50 sats for this contact in the last 24 hours, and this costs 10 sats. Raise the budget to send.';
    const s = session(node, async () => fail(code, message));
    await s.confirmed();
    s.minutes.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.last().stop).toMatchObject({ code: 'budget_limit', limit: { code, message } });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.deps.pay).toHaveBeenCalledTimes(1);
    expect(node.reservation!.spent_msat).toBe(0);
  });

  it('keeps an exhausted node grant for display without changing the payment failure or retrying', async () => {
    const node = fakeNode({ now: () => Date.now() });
    const message = "Your node's spend budget has 8 sats left, less than this costs. Nothing was sent. Ask for a new budget.";
    const s = session(node, async () => fail('grant_exhausted', message));
    await s.confirmed();
    s.minutes.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.last().stop).toMatchObject({ code: 'payment_failed', limit: { code: 'grant_exhausted', message } });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.deps.pay).toHaveBeenCalledTimes(1);
    expect(node.reservation!.spent_msat).toBe(0);
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

  it('the call ends while a minute is being paid and its result is lost: the view says so, nothing is paid again', async () => {
    const node = fakeNode({ now: () => Date.now() });
    let answer: (r: Outcome<CallReceipt>) => void = () => {};
    const s = session(node, () => new Promise((resolve) => { answer = resolve; }));
    await s.confirmed();
    s.minutes.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.deps.pay).toHaveBeenCalledTimes(1);
    s.minutes.finish();
    answer(fail('spend_unknown', 'The node did not return a complete response.'));
    await vi.advanceTimersByTimeAsync(0);
    expect(s.last().lostMinute).toBe(true);
    expect(s.stops).toEqual([]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.deps.pay).toHaveBeenCalledTimes(1);
  });

  it('a minute that came back paid or proven unpaid after the call ended is not lost', async () => {
    for (const reply of [ok(receipt(0)), fail('not_dispatched', 'Nothing was paid.'), fail('call_not_live', 'Nothing was paid.')]) {
      const node = fakeNode({ now: () => Date.now() });
      let answer: (r: Outcome<CallReceipt>) => void = () => {};
      const s = session(node, () => new Promise((resolve) => { answer = resolve; }));
      await s.confirmed();
      s.minutes.start();
      await vi.advanceTimersByTimeAsync(0);
      s.minutes.finish();
      answer(reply);
      await vi.advanceTimersByTimeAsync(0);
      expect(s.last().lostMinute).toBe(false);
      s.minutes.dispose();
    }
  });

  it('a paid minute that comes back after the call ended is not unknown, through the whole settlement poll', async () => {
    for (const [code, undelivered] of [['failed_paid', false], ['payment_settled_undelivered', true]] as const) {
      const node = fakeNode({ now: () => Date.now() });
      let answer: (r: Outcome<CallReceipt>) => void = () => {};
      const s = session(node, () => new Promise((resolve) => { answer = resolve; }));
      await s.confirmed();
      s.minutes.start();
      await vi.advanceTimersByTimeAsync(0);
      s.minutes.finish();
      answer(fail(code));
      await vi.advanceTimersByTimeAsync(25_000);
      expect(s.last().final, code).toBe(true);
      expect(s.views.some((v) => v.lostMinute), code).toBe(false);
      expect(s.last().undeliveredMinute, code).toBe(undelivered);
      expect(s.stops, code).toEqual([]);
      expect(s.deps.pay, code).toHaveBeenCalledTimes(1);
    }
  });

  it('an unknown minute while the call runs ends it through End, which checks that minute itself', async () => {
    const node = fakeNode({ now: () => Date.now() });
    const s = session(node, async () => fail('spend_unknown', 'The node did not return a complete response.'));
    await s.confirmed();
    s.minutes.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.stops.map((x) => x.code)).toEqual(['payment_unknown']);
    expect(s.last().lostMinute).toBe(false);
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

  it('a refused Accept clears its short-approval line once a later Accept goes through', async () => {
    const node = fakeNode({ now: () => Date.now() });
    const grant: NodeGrantSummary = { budget_msat: 2_000_000, remaining_msat: 2_000_000, per_call_max_msat: 2_000_000, expires_at_ms: Date.now() + 5 * 60_000, envelopes: null } as NodeGrantSummary;
    const e = engine(minutesOf(node, vi.fn()), undefined, grant);
    await e.engine.receive({ id: 'off', kind: 400, sender: A, recipient: OWN, timestamp: 0,
      plaintext: JSON.stringify({ v: 1, call_id: ID, media: 'audio', sdp: nodeRoutedSdp('offer', ID) }), payment_amount_msat: 1 }, OWN);
    await e.engine.accept(QUOTE);
    expect(e.last()).toMatchObject({ phase: 'incoming' });
    expect(e.last().error).toMatch(/ends in/);
    grant.expires_at_ms = Date.now() + 86_400_000;   // the box owner approves a whole day
    await e.engine.accept(QUOTE);
    expect(e.signals.map((x) => x.kind)).toEqual([401]);
    expect(e.last().phase).not.toBe('incoming');
    expect(e.last().error ?? '').not.toMatch(/ends in/);
  });

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
    const grant = (per: number): NodeGrantSummary => ({ expires_at_ms: Date.now() + 86_400_000, budget_msat: 500_000, remaining_msat: 500_000, per_call_max_msat: per, message_per_payment_max_msat: Math.min(per, 6_000), call_per_payment_max_msat: per });
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
    const grant: NodeGrantSummary = { expires_at_ms: Date.now() + 86_400_000, budget_msat: 500_000, remaining_msat: 500_000,
      per_call_max_msat: 10_000, message_per_payment_max_msat: 6_000, call_per_payment_max_msat: 10_000 };
    const q = { ...QUOTE, offer_msat: 1_000, call_total_msat: 12_000, block_msat: block, reservation_max_msat: 240 * (block + FEE) };
    const e = engine(minutesOf(node, vi.fn()), undefined, grant);
    await e.engine.place(A, 'audio', q);
    if (dials) {
      expect(e.signals.map((x) => x.kind)).toEqual([400]);
      e.engine.dismiss();
    } else {
      expect(e.signals).toEqual([]);
      expect(e.last()).toMatchObject({ phase: 'ended', error: expect.stringContaining(`This call needs up to ${amount(10_001, 'up')} per payment. Your node grant allows ${amount(10_000, 'up')} per payment.`) });
    }
  });

  it('places no call whose hangup the message cap could not pay', async () => {
    const node = fakeNode({ now: () => Date.now() });
    const grant = (message: number): NodeGrantSummary => ({ expires_at_ms: Date.now() + 86_400_000, budget_msat: 500_000, remaining_msat: 500_000,
      per_call_max_msat: 50_000, message_per_payment_max_msat: message, call_per_payment_max_msat: 50_000 });
    // QUOTE's hangup: 1 sat plus a 5-sat routing allowance.
    const tight = engine(minutesOf(node, vi.fn()), undefined, grant(5_999));
    await tight.engine.place(A, 'audio', QUOTE);
    expect(tight.signals).toEqual([]);
    expect(tight.last()).toMatchObject({ phase: 'ended', error: expect.stringContaining('could not be ended') });
    expect(tight.last().error).toContain('Nothing was sent or paid.');
    // A lower signed limit: the owner could approve enough.
    expect(tight.last().error).toContain(`The owner would need to approve at least ${amount(6_000, 'up')} per payment.`);
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
      expect(error).toContain(amount(7_000, 'up'));
      expect(error).toContain(amount(6_000, 'up'));
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

  it('a liquidity refusal does not only ask for capacity: a node just restarted says the same, and waiting is enough', async () => {
    for (const [language, wait, capacity] of [['en', 'wait a minute and call again', 'add outbound capacity'], ['da', 'vent et minut og ring igen', 'tilføj udgående kapacitet']] as const) {
      setLanguagePref(language);
      const e = engine({ status: vi.fn(async () => ok(null)), hold: vi.fn(), pay: vi.fn() },
        async () => fail('call_liquidity_insufficient', 'Your node’s channel cannot hold this call’s reservation right now. Nothing was paid. Add outbound capacity, then call again.'));
      await e.engine.place(A, 'audio', QUOTE);
      expect(e.last().phase).toBe('ended');
      expect(e.last().error).toContain(wait);
      expect(e.last().error).toContain(capacity);
      expect(e.last().error).not.toContain('Add outbound capacity, then');
      expect(e.last().paidMsat).toBe(0);
    }
    setLanguagePref('system');
  });

  it('the box refusing the call for this contact’s budget (grant_recipient) ends it in plain words (EN/DA), nothing held or paid', async () => {
    const cases = [
      ['en', 'Your box turned the call down: this contact’s budget on your box can’t hold the call. Nothing was paid. A bigger budget for this contact usually has to be approved on the box’s own computer.'],
      ['da', 'Din boks afviste opkaldet: kontaktens budget på boksen kan ikke rumme opkaldet. Der er ikke betalt noget. Et større budget til kontakten skal som regel godkendes på boksens egen computer.'],
    ] as const;
    try {
      for (const [lang, words] of cases) {
        setLanguagePref(lang);
        const hold = vi.fn();
        const pay = vi.fn();
        const e = engine({ status: vi.fn(async () => ok(null)), hold, pay },
          async () => fail('grant_recipient', 'Your node’s budget for this recipient has 50 sats left, less than this costs. Nothing was sent.'));
        await e.engine.place(A, 'audio', QUOTE);
        expect(e.last()).toMatchObject({ phase: 'ended', error: words, paidMsat: 0 });
        expect(hold).not.toHaveBeenCalled();
        expect(pay).not.toHaveBeenCalled();
      }
    } finally { setLanguagePref('en'); }
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

  it('the first ended view of the owner’s hangup already says closing: a minute lost then is End’s to answer', async () => {
    const node = fakeNode({ now: () => Date.now() });
    const e = engine(minutesOf(node, () => new Promise(() => {})));
    await e.engine.place(A, 'audio', QUOTE);
    await vi.waitFor(() => expect(e.last().minutes?.reservation).not.toBeNull());
    await e.engine.confirmMinutes();
    await answer(e);
    void e.engine.hangup();
    const ended = e.views.find((v) => v.phase === 'ended')!;
    expect(ended.close).toEqual({ status: 'closing', message: null });
    expect(e.ended).toEqual([]);
    await vi.waitFor(() => expect(e.ended).toHaveLength(1));
    await vi.waitFor(() => expect(e.last().close?.status).toBe('closed'));
  });

  it('their hangup ends nothing at the host, and the ended card says no closing', async () => {
    const node = fakeNode({ now: () => Date.now() });
    const e = engine(minutesOf(node, () => new Promise(() => {})));
    await e.engine.place(A, 'audio', QUOTE);
    await vi.waitFor(() => expect(e.last().minutes?.reservation).not.toBeNull());
    await e.engine.confirmMinutes();
    await answer(e);
    await e.engine.receive({ id: 'bye', kind: 403, sender: A, recipient: OWN, timestamp: 0, plaintext: JSON.stringify({ v: 1, call_id: ID, reason: 'hangup' }), payment_amount_msat: 1, admission_operation_id: 'op-400' }, OWN);
    await vi.waitFor(() => expect(e.last().phase).toBe('ended'));
    expect(e.last().close).toBeNull();
    expect(e.ended).toEqual([]);
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
    let frame: ((f: Uint8Array) => void) | null = null;
    let fatal: (() => void) | null = null;
    const bridge: MediaBridge = { open: async (_c, _p, f, l) => { link = l; frame = f; }, send: () => {}, close: async () => {} };
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
    return { engine: calls, views, signals, sessions, media, last: () => views[views.length - 1], link: (l: MediaLink) => link?.(l), frame: () => frame?.(new Uint8Array([0, 0, 0, 1, 1, 2, 3])), fatal: () => fatal?.() };
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

  it('frozen media: a node link down for 3 s shows Reconnecting, back to Live when it returns, and ends after its grace; nothing extra is sent', async () => {
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
    const sent = e.signals.length;
    // A short blip stays Live.
    e.link({ link: 'closed', detail: null });
    await vi.advanceTimersByTimeAsync(2_900);
    expect(e.last().phase).toBe('live');
    // Frozen past about 3 s: shown as Reconnecting, with when the link's own grace (30 s) ends the call.
    // Display only: the engine's phase stays live, so no recovery path can see it.
    await vi.advanceTimersByTimeAsync(100);
    expect(e.last()).toMatchObject({ phase: 'live', interruptedUntil: Date.now() - 3_000 + LINK_GRACE_MS });
    expect(shownPhase(e.last())).toBe('reconnecting');
    e.link({ link: 'open', detail: null });
    expect(e.last()).toMatchObject({ phase: 'live', interruptedUntil: null });
    expect(shownPhase(e.last())).toBe('live');
    // Lost for good: Reconnecting, then the card ends (never just gone), at the existing 30 s deadline.
    e.link({ link: 'closed', detail: null });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(shownPhase(e.last())).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(LINK_GRACE_MS - 3_000);
    expect(e.last()).toMatchObject({ phase: 'ended', reason: 'failed' });
    // Display only: no restart offer or other signal was sent for any of it.
    expect(e.signals.slice(sent).map((x) => x.kind)).toEqual([]);
  });

  it('frames stalling on an open link: a short stall stays Live, past 3 s it shows Reconnecting, frames back clear it, and a stall past the grace ends the call; nothing extra is sent', async () => {
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
    const sent = e.signals.length;
    e.frame();
    // A short stall (2 s) with the link open: still Live.
    await vi.advanceTimersByTimeAsync(2_000);
    e.frame();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(shownPhase(e.last())).toBe('live');
    // Frames stop while the link stays open (its heartbeat still answers): Reconnecting within about 3 s.
    const lastFrame = Date.now() - 2_000;
    await vi.advanceTimersByTimeAsync(1_500);
    expect(e.last()).toMatchObject({ phase: 'live', interruptedUntil: lastFrame + LINK_GRACE_MS });
    expect(shownPhase(e.last())).toBe('reconnecting');
    // Frames resume: Live again, no deadline.
    e.frame();
    expect(e.last().interruptedUntil).toBeNull();
    expect(shownPhase(e.last())).toBe('live');
    // Frames stop for good: Reconnecting, then the call ends at the existing 30 s grace, counted from the last frame.
    await vi.advanceTimersByTimeAsync(LINK_GRACE_MS - 1_000);
    expect(shownPhase(e.last())).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(e.last()).toMatchObject({ phase: 'ended', reason: 'failed' });
    expect(e.signals.slice(sent).map((x) => x.kind)).toEqual([]);
  });

  /** A live routed call whose frames flowed at the returned time and then stopped; Reconnecting shows after 3 s. */
  async function frozenAfterFrames(pay: MinutesDeps['pay'], node: ReturnType<typeof fakeNode>) {
    const e = routedEngine(minutesOf(node, pay));
    await e.engine.place(A, 'audio', QUOTE);
    await vi.waitFor(() => expect(e.last().minutes?.reservation).not.toBeNull());
    await e.engine.confirmMinutes();
    await e.engine.receive(answerMessage, OWN);
    await vi.waitFor(() => expect(pay).toHaveBeenCalledWith(A, ID, 0));
    await vi.advanceTimersByTimeAsync(0);
    e.link({ link: 'open', detail: null });
    await vi.waitFor(() => expect(e.last().phase).toBe('live'));
    e.frame();
    const lastFrame = Date.now();
    await vi.advanceTimersByTimeAsync(3_500);
    expect(shownPhase(e.last())).toBe('reconnecting');
    return { e, lastFrame };
  }

  it('a socket that reopens without frames is not recovery: still Reconnecting, and the call ends at last frame + 30 s', async () => {
    const node = fakeNode({ now: () => Date.now() });
    const pay = vi.fn(async (_p: string, _c: string, seq: number) => { node.settle(seq); return ok(receipt(seq)); });
    const { e, lastFrame } = await frozenAfterFrames(pay, node);
    const sent = e.signals.length;
    await vi.advanceTimersByTimeAsync(20_000 - 3_500);
    e.link({ link: 'closed', detail: null });
    await vi.advanceTimersByTimeAsync(1_000);
    e.link({ link: 'open', detail: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(e.last()).toMatchObject({ phase: 'live', interruptedUntil: lastFrame + LINK_GRACE_MS });
    expect(shownPhase(e.last())).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(lastFrame + LINK_GRACE_MS - 1 - Date.now());
    expect(e.last().phase).toBe('live');
    await vi.advanceTimersByTimeAsync(1);
    expect(e.last()).toMatchObject({ phase: 'ended', reason: 'failed' });
    expect(e.signals.slice(sent).map((x) => x.kind)).toEqual([]);
  });

  it('after a socket reopen, a frame arriving again is what clears Reconnecting and its deadline', async () => {
    const node = fakeNode({ now: () => Date.now() });
    const pay = vi.fn(async (_p: string, _c: string, seq: number) => { node.settle(seq); return ok(receipt(seq)); });
    const { e } = await frozenAfterFrames(pay, node);
    e.link({ link: 'closed', detail: null });
    await vi.advanceTimersByTimeAsync(1_000);
    e.link({ link: 'open', detail: null });
    expect(shownPhase(e.last())).toBe('reconnecting');
    e.frame();
    expect(e.last().interruptedUntil).toBeNull();
    expect(shownPhase(e.last())).toBe('live');
    // Frames keep coming: no deadline is left to end the call.
    for (let i = 0; i < 40; i++) { await vi.advanceTimersByTimeAsync(1_000); e.frame(); }
    expect(e.last().phase).toBe('live');
  });

  it('an interruption while an answer receipt is still on its way never starts a paid recovery', async () => {
    const node = fakeNode({ now: () => Date.now() });
    let land: (r: Outcome<CallReceipt>) => void = () => {};
    const signals: number[] = [];
    const authorize = vi.fn(async () => true);
    const e = routedEngine(minutesOf(node, vi.fn()), {
      authorize,
      signal: (_peer, kind) => { signals.push(kind); return kind === 401 ? new Promise((r) => { land = r; }) : Promise.resolve(okReceipt(kind)); },
    });
    await e.engine.receive({ id: 'off', kind: 400, sender: A, recipient: OWN, timestamp: 0,
      plaintext: JSON.stringify({ v: 1, call_id: ID, media: 'audio', sdp: nodeRoutedSdp('offer', ID) }), payment_amount_msat: 1 }, OWN);
    const accepting = e.engine.accept(QUOTE);
    await vi.waitFor(() => expect(signals).toEqual([401]));
    const asked = authorize.mock.calls.length;
    // The caller got the answer first: the link opens and the call is live before our receipt lands.
    e.link({ link: 'open', detail: null });
    await vi.waitFor(() => expect(e.last().phase).toBe('live'));
    e.link({ link: 'closed', detail: null });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(shownPhase(e.last())).toBe('reconnecting');
    land(okReceipt(401));
    await accepting;
    await vi.advanceTimersByTimeAsync(5_000);
    // No recovery request, offer or approval for one: only the answer was ever sent.
    expect(signals).toEqual([401]);
    expect(authorize).toHaveBeenCalledTimes(asked);
    expect(e.last().recoveryUsed).toBe(false);
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

function stubHost(opts: { quote?: CallQuote | Reply; peers?: string[]; grant?: NodeGrantSummary; offer?: Reply; block?: Reply; hold?: Reply; spendRequest?: Reply; ownerCanGrant?: boolean; minutes?: number; retireOnEnd?: boolean; endKeepsHold?: boolean; endLeavesUnresolved?: boolean; pairing?: Reply; spend?: SpendView; request?: Reply; reconcile?: Reply; dismiss?: Reply; budget?: Reply; cancel?: Reply; replies?: Record<string, Reply> } = {}) {
  let retired = false;
  resetContactsForTests();
  setPetname(A, 'Maya');
  const calls: { cmd: string; args?: unknown }[] = [];
  const callbacks = new Map<number, (e: unknown) => void>();
  let mediaIndex = 0;
  const node = fakeNode({ now: () => Date.now(), minutes: opts.minutes });
  let callId: string | null = null;
  let spending: SpendView = { state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 600_000, pending: null, window_ms: 600_000 };
  const REPLIES: Record<string, Reply> = {
    node_status: () => ({ ready: true, node_id: OWN, error: null }),
    trust_acknowledge: () => true,
    pairing_status: opts.pairing ?? (() => paired),
    node_overview: () => ({ node_id: OWN, status: 'ok', version: 'api v2', connected_peers: 1, e2ee_sessions: 1, pending_deliveries: 0,
      lightning_available: true, block_height: 1, uptime_secs: 1, lightning_backend: 'ldk', chain_backend: 'esplora', read_at: Date.now(), capabilities: [] }),
    peers_list: () => (opts.peers ?? [A]).map((node_id) => ({ node_id, addr: null, label: node_id === A ? 'Maya' : 'Other contact', connected: true, fingerprint: null, meetings: true })),
    rooms_list: () => [],
    messages_list: () => [],
    price_quote: () => ({ kind: 0, own_msat: 1000, peer_msat: 2000, peer_age_secs: 30, max_routing_fee_msat: 0, peer_stale: false }),
    payments_overview: () => ({ balance_msat: 1_000_000, lightning_outbound_msat: 500_000, channels: [] }),
    fund_state: () => null,
    spend_status: () => opts.spend ?? spending,
    spend_request: opts.request ?? ((args) => {
      opts.spendRequest?.(args);
      return spending = { ...(args?.budget_msat ? spending : { state: 'pending', basis: null, open_until_ms: null, window_ms: 600_000 }),
        pending: { op_id: 'ab12', expires_at_ms: Date.now() + 600_000, owner_action: 'konsensus grant --op ab12', owner_can_grant: opts.ownerCanGrant ?? true } };
    }),
    spend_cancel: opts.cancel ?? (() => spending),
    budget_status: opts.budget ?? (() => opts.grant ? {
      paused: false, autopay: { state: 'off', open_until_ms: null, ceiling_msat: null, basis: null },
      waiting_for_owner: false, preset: 'careful', ceiling_msat: 500_000, spent_msat: 0,
      unsettled_msat: 0, rows: [], presets: [], window_ms: 86_400_000, max_daily_msat: 100_000_000,
      node_grant: opts.grant,
    } : null),
    call_quote: (args) => typeof opts.quote === 'function' ? opts.quote(args) : opts.quote ?? QUOTE,
    call_signal: (args) => {
      const kind = (args as { kind: number }).kind;
      if (kind === 400) {
        // A refused offer leaves no call (and no reservation) at the node.
        if (opts.offer) return opts.offer(args);
        callId = JSON.parse((args as { plaintext: string }).plaintext).call_id;
      }
      return { operation_id: `op-${kind}`, message_id: 'sig', kind, amount_msat: 10_000, total_msat: 15_000, max_routing_fee_msat: 5000, delivered: true, accepted: true, sent_at_ms: Date.now() };
    },
    // retireOnEnd: once ended, the node no longer lists the call.
    call_status: (args) => (!retired && callId && (args as { call_id: string }).call_id === callId ? { ...node.status(), id: callId } : null),
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
      if (opts.retireOnEnd) retired = true;
      return { op_id: 'end', kind: 'call_hangup', peer: A, call_id: (args as { call_id: string }).call_id, state: 'settled', cap_msat: 6_000, paid_msat: 6_000, message_id: 'hangup' };
    },
    ...(opts.reconcile ? { spend_reconcile: opts.reconcile } : {}),
    ...(opts.dismiss ? { spend_dismiss_undelivered: opts.dismiss } : {}),
    op_list: () => ({ operations: [], skipped: 0, has_more: false }),
    live_link: () => null,
    call_media_open: () => null,
    call_media_send: () => null,
    call_media_close: () => null,
    'plugin:event|listen': () => 1,
    'plugin:event|unlisten': () => null,
    ...opts.replies,
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
    setSpending: (value: SpendView) => { spending = value; },
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
    dispose?.();
    dispose = undefined;
    mount?.remove();
    setLanguagePref('en');
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const $ = <T extends Element = HTMLElement>(sel: string) => mount.querySelector<T>(sel);
  async function openShell() {
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => <App />, mount);
    await vi.waitFor(() => expect([...mount.querySelectorAll('button')].some((b) => b.hasAttribute('data-trust-continue'))).toBe(true));
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.hasAttribute('data-trust-continue'))!.click();
    await vi.waitFor(() => expect($(`[data-track="peer:${A}"]`)?.getAttribute('aria-current')).toBe('true'));
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
  }
  it.each([
    ['node', 'audio', 'approve', { call_peer: A }],
    ['node', 'video', 'approve', { call_peer: A }],
    ['node', 'audio', 'ask-again', { call_peer: A }],
    ['node', 'video', 'ask-again', { call_peer: A }],
    ['webrtc', 'audio', 'approve', {}],
    ['webrtc', 'audio', 'ask-again', {}],
  ] as const)('keeps the request context after a pairing read fails: %s %s %s',
  async (route, media, button, expected) => {
    vi.stubEnv('VITE_CALL_MEDIA', route);
    vi.stubEnv('VITE_CALL_VIDEO', 'node');
    let failNextPairing = false;
    const host = stubHost({
      pairing: () => {
        if (failNextPairing) {
          failNextPairing = false;
          throw { code: 'read_failed', message: 'Pairing status is temporarily unavailable.' };
        }
        return { ...paired, scopes: ['read', 'receive'] };
      },
      spend: {
        state: 'expired', basis: null, open_until_ms: null,
        pending: null, window_ms: 600_000, lapse: 'lost',
      },
    });
    const capture = vi.spyOn(navigator.mediaDevices, 'getUserMedia');
    await openShell();
    $<HTMLButtonElement>('[data-call="' + media + '"]')!.click();
    await vi.waitFor(() =>
      expect($<HTMLButtonElement>('[data-call-confirm="' + media + '"]')?.disabled).toBe(false));
    failNextPairing = true;
    $<HTMLButtonElement>('[data-call-confirm="' + media + '"]')!.click();
    await vi.waitFor(() =>
      expect($('[data-call-approval]')?.textContent).toContain('Pairing status is temporarily unavailable.'));
    expect(host.used('spend_request')).toHaveLength(0);
    const selector = button === 'approve'
      ? '[data-call-approve]'
      : '[data-call-approval] [data-spend-ask-again]';
    await vi.waitFor(() => expect($<HTMLButtonElement>(selector)?.disabled).toBe(false));
    $<HTMLButtonElement>(selector)!.click();
    await vi.waitFor(() => expect(host.used('spend_request')).toHaveLength(1));
    expect(host.used('spend_request')[0].args).toEqual(expected);
    expect(host.used('call_signal')).toHaveLength(0);
    expect(host.used('call_block')).toHaveLength(0);
    expect(capture).not.toHaveBeenCalled();
  });

  it.each(['approve', 'ask-again'] as const)(
    'uses the later contact after closing a failed pairing check through %s',
    async button => {
      const other = 'b'.repeat(64);
      let failNextPairing = false;
      const host = stubHost({
        peers: [A, other],
        pairing: () => {
          if (failNextPairing) {
            failNextPairing = false;
            throw { code: 'read_failed', message: 'Pairing status is temporarily unavailable.' };
          }
          return { ...paired, scopes: ['read', 'receive'] };
        },
        spend: {
          state: 'expired', basis: null, open_until_ms: null,
          pending: null, window_ms: 600_000, lapse: 'lost',
        },
      });
      const capture = vi.spyOn(navigator.mediaDevices, 'getUserMedia');
      await openShell();
      for (const peer of [A, other]) {
        $<HTMLButtonElement>('[data-track="peer:' + peer + '"]')!.click();
        await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')?.disabled).toBe(false));
        $<HTMLButtonElement>('[data-call="audio"]')!.click();
        await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
        failNextPairing = true;
        $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
        await vi.waitFor(() =>
          expect($('[data-call-approval]')?.textContent).toContain('Pairing status is temporarily unavailable.'));
        if (peer === A) {
          [...$('[data-call-approval]')!.querySelectorAll('button')]
            .find(b => b.textContent === 'Close')!.click();
          await vi.waitFor(() => expect($('[data-call-approval]')).toBeNull());
        }
      }
      const selector = button === 'approve'
        ? '[data-call-approve]'
        : '[data-call-approval] [data-spend-ask-again]';
      await vi.waitFor(() => expect($<HTMLButtonElement>(selector)?.disabled).toBe(false));
      $<HTMLButtonElement>(selector)!.click();
      await vi.waitFor(() => expect(host.used('spend_request')).toHaveLength(1));
      expect(host.used('spend_request')[0].args).toEqual({ call_peer: other });
      expect(host.used('call_signal')).toHaveLength(0);
      expect(host.used('call_block')).toHaveLength(0);
      expect(capture).not.toHaveBeenCalled();
    });

  it.each(['approve', 'ask-again'] as const)(
    'keeps incoming approval ordinary after a delayed pairing failure through %s',
    async button => {
      const incomingPeer = 'b'.repeat(64);
      const pairing = { ...paired, scopes: ['read', 'receive'] };
      let reply: Reply = () => pairing;
      const host = stubHost({
        peers: [A, incomingPeer],
        pairing: args => reply(args),
        spend: {
          state: 'expired', basis: null, open_until_ms: null,
          pending: null, window_ms: 600_000, lapse: 'lost',
        },
      });
      const capture = vi.spyOn(navigator.mediaDevices, 'getUserMedia');
      await openShell();
      let rejectPairing!: (reason: unknown) => void;
      reply = () => new Promise<OnboardingPairingView>((_resolve, reject) => {
        rejectPairing = reject;
      });
      $<HTMLButtonElement>('[data-call="audio"]')!.click();
      await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
      $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
      await vi.waitFor(() => expect(rejectPairing).toBeTypeOf('function'));
      host.emitLive({
        type: 'message', room_id: null,
        message: {
          id: 'incoming', kind: 400, sender: incomingPeer, recipient: OWN,
          timestamp: Date.now(),
          plaintext: JSON.stringify({ v: 1, call_id: ID, media: 'audio', sdp: nodeRoutedSdp('offer', ID) }),
          payment_amount_msat: 10_000,
        },
      });
      await vi.waitFor(() => expect($('[data-call-panel="incoming"]')).not.toBeNull());
      reply = () => pairing;
      rejectPairing({ code: 'read_failed', message: 'Pairing status is temporarily unavailable.' });
      await vi.waitFor(() =>
        expect($('[data-call-approval]')?.textContent).toContain('Pairing status is temporarily unavailable.'));
      const selector = button === 'approve'
        ? '[data-call-approve]'
        : '[data-call-approval] [data-spend-ask-again]';
      await vi.waitFor(() => expect($<HTMLButtonElement>(selector)?.disabled).toBe(false));
      $<HTMLButtonElement>(selector)!.click();
      await vi.waitFor(() => expect(host.used('spend_request')).toHaveLength(1));
      expect(host.used('spend_request')[0].args).toEqual({});
      expect(host.used('call_signal')).toHaveLength(0);
      expect(host.used('call_block')).toHaveLength(0);
      expect(capture).not.toHaveBeenCalled();
    });
  it.each([['audio', 'approve'], ['video', 'approve'], ['audio', 'ask-again'], ['video', 'ask-again']])('requests a call-specific budget for %s through %s without sending a call', async (media, button) => {
    vi.stubEnv('VITE_CALL_VIDEO', 'node');
    const host = stubHost({
      pairing: () => ({ ...paired, scopes: ['read', 'receive'] }),
      spend: { state: 'expired', basis: null, open_until_ms: null, pending: null, window_ms: 600_000, lapse: 'lost' },
    });
    const capture = vi.spyOn(navigator.mediaDevices, 'getUserMedia');
    await openShell();
    $<HTMLButtonElement>(`[data-call="${media}"]`)!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>(`[data-call-confirm="${media}"]`)?.disabled).toBe(false));
    $<HTMLButtonElement>(`[data-call-confirm="${media}"]`)!.click();
    await vi.waitFor(() => expect($('[data-call-approval]')).not.toBeNull());
    $<HTMLButtonElement>(button === 'approve' ? '[data-call-approve]' : '[data-call-approval] [data-spend-ask-again]')!.click();
    await vi.waitFor(() => expect(host.used('spend_request')).toHaveLength(1));
    expect(host.used('spend_request')[0].args).toEqual({ call_peer: A });
    expect(capture).not.toHaveBeenCalled();
    expect(host.used('call_signal')).toHaveLength(0);
    expect(host.used('call_block')).toHaveLength(0);
  });
  it.each([['approve', 'reopened'], ['ask-again', 'reopened'], ['approve', 'left open'], ['ask-again', 'left open']])('keeps incoming approval ordinary through %s with the outgoing panel %s', async (button, panel) => {
    const incomingPeer = 'b'.repeat(64);
    const host = stubHost({
      peers: [A, incomingPeer],
      pairing: () => ({ ...paired, scopes: ['read', 'receive'] }),
      spend: { state: 'expired', basis: null, open_until_ms: null, pending: null, window_ms: 600_000, lapse: 'lost' },
    });
    const capture = vi.spyOn(navigator.mediaDevices, 'getUserMedia');
    await openShell();
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-approval]')).not.toBeNull());
    if (panel === 'reopened') [...$('[data-call-approval]')!.querySelectorAll('button')].find(b => b.textContent === 'Close')!.click();
    host.emitLive({ type: 'message', room_id: null, message: { id: 'incoming', kind: 400, sender: incomingPeer, recipient: OWN,
      timestamp: Date.now(), plaintext: JSON.stringify({ v: 1, call_id: ID, media: 'audio', sdp: nodeRoutedSdp('offer', ID) }), payment_amount_msat: 10_000 } });
    await vi.waitFor(() => expect($('[data-call-spend-approve]')).not.toBeNull());
    if (panel === 'reopened') $<HTMLButtonElement>('[data-call-spend-approve]')!.click();
    await vi.waitFor(() => expect($('[data-call-approval]')).not.toBeNull());
    $<HTMLButtonElement>(button === 'approve' ? '[data-call-approve]' : '[data-call-approval] [data-spend-ask-again]')!.click();
    await vi.waitFor(() => expect(host.used('spend_request')).toHaveLength(1));
    expect(host.used('spend_request')[0].args).toEqual({});
    expect(capture).not.toHaveBeenCalled();
    expect(host.used('call_signal')).toHaveLength(0);
    expect(host.used('call_block')).toHaveLength(0);
  });
  it.each(['approve', 'ask-again'])('keeps an in-call %s request free of the initial Ring peer', async button => {
    const host = stubHost({ block: () => {
      host.setSpending({ state: 'expired', basis: null, open_until_ms: null, pending: null, window_ms: 600_000, lapse: 'lost' });
      throw { code: 'spend_expired', message: 'Spending approval expired.' };
    } });
    await openShell();
    await ringAndAnswer(host);
    await vi.waitFor(() => expect($('[data-call-approval] [data-spend="expired"]')).not.toBeNull());
    const signals = host.used('call_signal').length;
    const blocks = host.used('call_block').length;
    $<HTMLButtonElement>(button === 'approve' ? '[data-call-approve]' : '[data-call-approval] [data-spend-ask-again]')!.click();
    await vi.waitFor(() => expect(host.used('spend_request')).toHaveLength(1));
    expect(host.used('spend_request')[0].args).toEqual({});
    expect(host.used('call_signal')).toHaveLength(signals);
    expect(host.used('call_block')).toHaveLength(blocks);
  });
  it.each(['approve', 'ask-again'])('keeps incoming %s ordinary when it arrives during outgoing authorization', async button => {
    const incomingPeer = 'b'.repeat(64);
    const pairing = { ...paired, scopes: ['read', 'receive'] };
    let reply: Reply = () => pairing;
    const host = stubHost({
      peers: [A, incomingPeer], pairing: args => reply(args),
      spend: { state: 'expired', basis: null, open_until_ms: null, pending: null, window_ms: 600_000, lapse: 'lost' },
    });
    const capture = vi.spyOn(navigator.mediaDevices, 'getUserMedia');
    await openShell();
    let finish!: (value: OnboardingPairingView) => void;
    reply = () => new Promise<OnboardingPairingView>(resolve => { finish = resolve; });
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    host.emitLive({ type: 'message', room_id: null, message: { id: 'incoming', kind: 400, sender: incomingPeer, recipient: OWN,
      timestamp: Date.now(), plaintext: JSON.stringify({ v: 1, call_id: ID, media: 'audio', sdp: nodeRoutedSdp('offer', ID) }), payment_amount_msat: 10_000 } });
    await vi.waitFor(() => expect($('[data-call-panel="incoming"]')).not.toBeNull());
    reply = () => pairing;
    finish(pairing);
    await vi.waitFor(() => expect($('[data-call-approval]')).not.toBeNull());
    $<HTMLButtonElement>(button === 'approve' ? '[data-call-approve]' : '[data-call-approval] [data-spend-ask-again]')!.click();
    await vi.waitFor(() => expect(host.used('spend_request')).toHaveLength(1));
    expect(host.used('spend_request')[0].args).toEqual({});
    expect(host.used('call_signal')).toHaveLength(0);
    expect(host.used('call_block')).toHaveLength(0);
    expect(capture).not.toHaveBeenCalled();
  });
  it('keeps Ask again ordinary after dismissing a refused Ring and starting another call', async () => {
    // A whole-day approval: a window ending before the call could is refused on its own (below).
    const grant: NodeGrantSummary = { budget_msat: 10_000, remaining_msat: 10_000, per_call_max_msat: 10_000,
      expires_at_ms: Date.now() + 86_400_000, envelopes: null };
    const host = stubHost({
      grant,
      block: () => {
        host.setSpending({ state: 'expired', basis: null, open_until_ms: null, pending: null, window_ms: 600_000, lapse: 'lost' });
        throw { code: 'spend_expired', message: 'Spending approval expired.' };
      },
    });
    await openShell();
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-budget-sats]')).not.toBeNull());
    $<HTMLButtonElement>('[data-call-dismiss]')!.click();
    expect($('[data-call-approval]')).toBeNull();
    Object.assign(grant, { budget_msat: 10_000_000, remaining_msat: 10_000_000, per_call_max_msat: 10_000_000 });
    host.emitLive({ type: 'link', state: 'open' });
    await ringAndAnswer(host);
    await vi.waitFor(() => expect($('[data-call-approval] [data-spend-ask-again]')).not.toBeNull());
    $<HTMLButtonElement>('[data-call-approval] [data-spend-ask-again]')!.click();
    await vi.waitFor(() => expect(host.used('spend_request')).toHaveLength(1));
    expect(host.used('spend_request')[0].args).toEqual({});
    expect(host.used('call_block')).toHaveLength(1);
  });
  // A box approval that ends mid-call cuts the call off (the callee's media is refused).
  // So a node-routed call is never placed or answered inside a window that ends first.
  const SHORT = () => ({ budget_msat: 2_000_000, remaining_msat: 2_000_000, per_call_max_msat: 2_000_000, expires_at_ms: Date.now() + 5 * 60_000 - 1_000, envelopes: null });
  const visibleText = (el: Element) => {
    const copy = el.cloneNode(true) as Element;
    copy.querySelectorAll('details:not([open])').forEach((d) => [...d.childNodes].forEach((n) => { if (!(n instanceof Element && n.tagName === 'SUMMARY')) n.remove(); }));
    return copy.textContent ?? '';
  };
  it.each([
    ['en', 'Your box’s approval ends in 5 min, before this call could end, and the call would stop there. Nothing was paid. Ask the person who set up your box for a new approval, then call again.'],
    ['da', 'Godkendelsen fra din boks udløber om 5 min, før opkaldet kan nå at slutte, så opkaldet ville stoppe der. Intet blev betalt. Bed den, der har sat din boks op, om en ny godkendelse, og ring igen.'],
  ] as const)('refuses to ring when the box approval ends before the call could (%s)', async (lang, said) => {
    const capture = vi.spyOn(navigator.mediaDevices, 'getUserMedia');
    const host = stubHost({ grant: SHORT() });
    await openShell(); setLanguagePref(lang);
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect($('[data-call-ended]')!.textContent).toBe(said);
    expect(visibleText($('[data-call-panel]')!)).not.toMatch(/konsensus\s|--op\b|Terminal/);
    expect(host.used('call_signal')).toHaveLength(0);
    expect(host.used('call_block')).toHaveLength(0);
    expect(capture).not.toHaveBeenCalled();
  });
  it('rings as before inside a whole-day approval', async () => {
    const host = stubHost({ grant: { ...SHORT(), expires_at_ms: Date.now() + 86_400_000 } });
    await openShell();
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ringing"]')).not.toBeNull());
    expect(host.used('call_signal').map((c) => (c.args as { kind: number }).kind)).toEqual([400]);
  });
  it.each([
    ['en', 'Your box’s approval ends in 5 min, before this call could end, and the call would stop there. Nothing was paid. Ask the person who set up your box for a new approval. The caller keeps ringing until it times out.'],
    ['da', 'Godkendelsen fra din boks udløber om 5 min, før opkaldet kan nå at slutte, så opkaldet ville stoppe der. Intet blev betalt. Bed den, der har sat din boks op, om en ny godkendelse. Det ringer hos den anden, til opkaldet udløber.'],
  ] as const)('refuses to answer when the box approval ends before the call could, and pays nothing (%s)', async (lang, said) => {
    const capture = vi.spyOn(navigator.mediaDevices, 'getUserMedia');
    const host = stubHost({ grant: SHORT() });
    await openShell(); setLanguagePref(lang);
    host.emitLive({ type: 'message', room_id: null, message: { id: 'incoming', kind: 400, sender: A, recipient: OWN,
      timestamp: Date.now(), plaintext: JSON.stringify({ v: 1, call_id: ID, media: 'audio', sdp: nodeRoutedSdp('offer', ID) }), payment_amount_msat: 10_000 } });
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-accept]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-accept]')!.click();
    await vi.waitFor(() => expect($('[data-call-error]')?.textContent).toBe(said));
    expect($('[data-call-panel="incoming"]')).not.toBeNull();
    expect(host.used('call_signal')).toHaveLength(0);
    expect(capture).not.toHaveBeenCalled();
  });
  // The box's call limit is unknown until its first hold: assume the most any node allows (240 min).
  const HOUR = () => ({ ...SHORT(), expires_at_ms: Date.now() + 60 * 60_000 });
  it('an unknown call limit counts as the longest any box allows: a one-hour approval rings nothing and pays nothing', async () => {
    const capture = vi.spyOn(navigator.mediaDevices, 'getUserMedia');
    const host = stubHost({ grant: HOUR() });
    await openShell();
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect($('[data-call-ended]')!.textContent).toMatch(/ends in 60 min/);
    expect(host.used('call_signal')).toHaveLength(0);
    expect(host.used('call_block')).toHaveLength(0);
    expect(capture).not.toHaveBeenCalled();
  });
  it('an unknown call limit counts as the longest any box allows: a one-hour approval answers nothing and pays nothing', async () => {
    const capture = vi.spyOn(navigator.mediaDevices, 'getUserMedia');
    const host = stubHost({ grant: HOUR() });
    await openShell();
    host.emitLive({ type: 'message', room_id: null, message: { id: 'incoming', kind: 400, sender: A, recipient: OWN,
      timestamp: Date.now(), plaintext: JSON.stringify({ v: 1, call_id: ID, media: 'audio', sdp: nodeRoutedSdp('offer', ID) }), payment_amount_msat: 10_000 } });
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-accept]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-accept]')!.click();
    await vi.waitFor(() => expect($('[data-call-error]')?.textContent).toMatch(/ends in 60 min/));
    expect(host.used('call_signal')).toHaveLength(0);
    expect(capture).not.toHaveBeenCalled();
  });
  // Time passes while the microphone is prepared: the approval is checked again right before the paid step.
  const LONG_ENOUGH = () => ({ ...SHORT(), expires_at_ms: Date.now() + 250 * 60_000 });
  const slowMicrophone = () => {
    const real = Date.now.bind(Date);
    const media = navigator.mediaDevices;
    const prepare = media.getUserMedia.bind(media);
    let shift = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => real() + shift);
    vi.spyOn(media, 'getUserMedia').mockImplementation(async (c) => { shift = 15 * 60_000; return prepare(c); });
  };
  it('re-checks the approval at the paid step: a ring whose approval ran short during setup sends and pays nothing', async () => {
    const host = stubHost({ grant: LONG_ENOUGH() });
    await openShell();
    slowMicrophone();
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect($('[data-call-ended]')!.textContent).toMatch(/ends in 235 min/);
    expect(host.used('call_signal')).toHaveLength(0);
    expect(host.used('call_block')).toHaveLength(0);
  });
  it('re-checks the approval at the paid step: an answer whose approval ran short during setup sends and pays nothing', async () => {
    const host = stubHost({ grant: LONG_ENOUGH() });
    await openShell();
    slowMicrophone();
    host.emitLive({ type: 'message', room_id: null, message: { id: 'incoming', kind: 400, sender: A, recipient: OWN,
      timestamp: Date.now(), plaintext: JSON.stringify({ v: 1, call_id: ID, media: 'audio', sdp: nodeRoutedSdp('offer', ID) }), payment_amount_msat: 10_000 } });
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-accept]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-accept]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect($('[data-call-ended]')!.textContent).toMatch(/ends in 235 min/);
    expect(host.used('call_signal')).toHaveLength(0);
  });
  it.each([
    ['en', 'Their box stopped the call. Its approval may have run out. Nothing was paid for that minute.'],
    ['da', 'Den andens boks stoppede opkaldet. Dens godkendelse kan være udløbet. Der blev ikke betalt for det minut.'],
  ] as const)('a minute their box refused ends with a plain cause, the raw node text only under Details (%s)', async (lang, said) => {
    const raw = 'Not sent - nothing was paid. callee refused the call block invoice: deadline margin, call sequence or no E2EE session; nothing was paid';
    const host = stubHost({ block: () => { throw { code: 'not_dispatched', message: raw, reason: 'call_block_unpayable' }; } });
    await openShell(); setLanguagePref(lang);
    await ringAndAnswer(host);
    // Not dispatched: tried again a few times (2 s apart), then the call ends.
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull(), { timeout: 12_000 });
    expect($('[data-call-ended]')?.textContent).toBe(said);
    const panel = $('[data-call-panel]')!;
    expect(visibleText(panel)).not.toContain('callee refused');
    expect(visibleText(panel)).not.toContain('E2EE');
    const details = $<HTMLDetailsElement>('[data-call-end-detail]')!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('callee refused the call block invoice');
  }, 20_000);
  it.each(['approve', 'ask-again'])('keeps recovery %s approval ordinary after the initial call', async (button) => {
    let scopes = paired.scopes;
    const spend: SpendView = { state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 600_000, pending: null, window_ms: 600_000 };
    const host = stubHost({ pairing: () => ({ ...paired, scopes }), spend });
    await openShell();
    const callId = await ringAndAnswer(host);
    await vi.waitFor(() => expect(host.used('call_media_open')).toHaveLength(1), { timeout: 3_000 });
    host.media({ link: 'open', detail: null });
    await vi.waitFor(() => expect($('[data-call-panel="live"]')).not.toBeNull());
    scopes = ['read', 'receive'];
    Object.assign(spend, { state: 'expired', basis: null, open_until_ms: null, lapse: 'lost' });
    const signals = host.used('call_signal').length;
    const blocks = host.used('call_block').length;
    const capture = vi.spyOn(navigator.mediaDevices, 'getUserMedia');
    host.emitLive({ type: 'message', room_id: null, message: { id: 'restart', kind: 402, sender: A, recipient: OWN,
      timestamp: Date.now(), plaintext: JSON.stringify({ v: 1, call_id: callId, candidate: '', sdp_mid: 'bitsov-restart-v1' }), payment_amount_msat: 1000 } });
    await vi.waitFor(() => expect($('[data-call-approval]')).not.toBeNull());
    $<HTMLButtonElement>(button === 'approve' ? '[data-call-approve]' : '[data-call-approval] [data-spend-ask-again]')!.click();
    await vi.waitFor(() => expect(host.used('spend_request')).toHaveLength(1));
    expect(host.used('spend_request')[0].args).toEqual({});
    expect(host.used('call_signal')).toHaveLength(signals);
    expect(host.used('call_block')).toHaveLength(blocks);
    expect(capture).not.toHaveBeenCalled();
  });
  it.each([
    ['en', 'A request already waiting for approval may not cover this call. If it was made before the call, cancel it, then request approval again here.'],
    ['da', 'En anmodning, der allerede venter på godkendelse, dækker måske ikke dette opkald. Hvis den blev oprettet før opkaldet, skal du annullere den og bede om godkendelse igen her.'],
  ] as const)('explains an earlier pending request before calling in %s', async (language, hint) => {
    const spend: SpendView = { state: 'pending', basis: null, open_until_ms: null, window_ms: 600_000,
      pending: { op_id: 'ordinary', expires_at_ms: Date.now() + 600_000, owner_action: 'Approve the waiting request at your node.', owner_can_grant: true } };
    const host = stubHost({ pairing: () => ({ ...paired, scopes: ['read', 'receive'] }), spend,
      cancel: () => { Object.assign(spend, { state: 'locked', pending: null }); return { ...spend }; } });
    const capture = vi.spyOn(navigator.mediaDevices, 'getUserMedia');
    await openShell();
    setLanguagePref(language);
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-approval]')).not.toBeNull());
    expect($('[data-call-pending-budget-hint]')?.textContent).toBe(hint);
    expect($('[data-call-approve]')).toBeNull();
    expect(host.used('spend_request')).toHaveLength(0);
    expect(host.used('spend_cancel')).toHaveLength(0);
    $<HTMLButtonElement>('[data-call-approval] [data-spend-cancel]')!.click();
    await vi.waitFor(() => expect($('[data-call-approve]')).not.toBeNull());
    expect(host.used('spend_cancel')).toHaveLength(1);
    expect($('[data-call-pending-budget-hint]')).toBeNull();
    $<HTMLButtonElement>('[data-call-approve]')!.click();
    await vi.waitFor(() => expect(host.used('spend_request')).toHaveLength(1));
    expect(host.used('spend_request')[0].args).toEqual({ call_peer: A });
    expect(host.used('call_signal')).toHaveLength(0);
    expect(host.used('call_block')).toHaveLength(0);
    expect(capture).not.toHaveBeenCalled();
  });
  it('keeps an incoming pending approval free of outgoing budget guidance', async () => {
    const host = stubHost({ pairing: () => ({ ...paired, scopes: ['read', 'receive'] }),
      spend: { state: 'pending', basis: null, open_until_ms: null, window_ms: 600_000,
        pending: { op_id: 'ordinary', expires_at_ms: Date.now() + 600_000, owner_action: 'Approve the waiting request at your node.', owner_can_grant: true } } });
    await openShell();
    host.emitLive({ type: 'message', room_id: null, message: { id: 'incoming', kind: 400, sender: A, recipient: OWN,
      timestamp: Date.now(), plaintext: JSON.stringify({ v: 1, call_id: ID, media: 'audio', sdp: nodeRoutedSdp('offer', ID) }), payment_amount_msat: 10_000 } });
    await vi.waitFor(() => expect($('[data-call-spend-approve]')).not.toBeNull());
    $<HTMLButtonElement>('[data-call-spend-approve]')!.click();
    await vi.waitFor(() => expect($('[data-call-approval] [data-approval="pending"]')).not.toBeNull());
    expect($('[data-call-pending-budget-hint]')).toBeNull();
    expect(host.used('spend_request')).toHaveLength(0);
    expect(host.used('call_signal')).toHaveLength(0);
    expect(host.used('call_block')).toHaveLength(0);
  });
  it.each([['audio', 'approve'], ['video', 'approve'], ['audio', 'ask-again'], ['video', 'ask-again']])('hides unrelated-request guidance after a pending %s budget request through %s', async (media, button) => {
    vi.stubEnv('VITE_CALL_VIDEO', 'node');
    const spend: SpendView = { state: 'expired', basis: null, open_until_ms: null, pending: null, window_ms: 600_000, lapse: 'lost' };
    const host = stubHost({ pairing: () => ({ ...paired, scopes: ['read', 'receive'] }), spend,
      request: () => {
        Object.assign(spend, { state: 'pending', pending: { op_id: 'call-budget', expires_at_ms: Date.now() + 600_000,
          owner_action: 'Approve the call budget at your node.', owner_can_grant: true } });
        return { ...spend };
      } });
    const capture = vi.spyOn(navigator.mediaDevices, 'getUserMedia');
    await openShell();
    $<HTMLButtonElement>(`[data-call="${media}"]`)!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>(`[data-call-confirm="${media}"]`)?.disabled).toBe(false));
    $<HTMLButtonElement>(`[data-call-confirm="${media}"]`)!.click();
    await vi.waitFor(() => expect($('[data-call-approval]')).not.toBeNull());
    $<HTMLButtonElement>(button === 'approve' ? '[data-call-approve]' : '[data-call-approval] [data-spend-ask-again]')!.click();
    await vi.waitFor(() => expect($('[data-call-approval] [data-approval="pending"]')).not.toBeNull());
    expect(host.used('spend_request')).toHaveLength(1);
    expect(host.used('spend_request')[0].args).toEqual({ call_peer: A });
    expect($('[data-call-pending-budget-hint]')).toBeNull();
    expect($('[data-call-approve]')).toBeNull();
    expect(host.used('spend_cancel')).toHaveLength(0);
    expect(host.used('call_signal')).toHaveLength(0);
    expect(host.used('call_block')).toHaveLength(0);
    expect(capture).not.toHaveBeenCalled();
  });
  it('replaces earlier-request guidance with the pending call budget and restores it for a different request', async () => {
    const spend: SpendView = { state: 'pending', basis: null, open_until_ms: null, window_ms: 600_000,
      pending: { op_id: 'ordinary', expires_at_ms: Date.now() + 600_000, owner_action: 'Approve the waiting request at your node.', owner_can_grant: true } };
    const host = stubHost({ pairing: () => ({ ...paired, scopes: ['read', 'receive'] }), spend,
      cancel: () => { Object.assign(spend, { state: 'locked', pending: null }); return { ...spend }; },
      request: () => {
        Object.assign(spend, { state: 'pending', pending: { op_id: 'call-budget', expires_at_ms: Date.now() + 600_000,
          owner_action: 'Approve the call budget at your node.', owner_can_grant: true } });
        return { ...spend };
      } });
    await openShell();
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-pending-budget-hint]')).not.toBeNull());
    $<HTMLButtonElement>('[data-call-approval] [data-spend-cancel]')!.click();
    await vi.waitFor(() => expect($('[data-call-approve]')).not.toBeNull());
    $<HTMLButtonElement>('[data-call-approve]')!.click();
    await vi.waitFor(() => expect($('[data-call-approval] [data-approval="pending"]')).not.toBeNull());
    expect(host.used('spend_request')[0].args).toEqual({ call_peer: A });
    expect($('[data-call-pending-budget-hint]')).toBeNull();

    host.emitLive({ type: 'link', state: 'open' });
    await vi.waitFor(() => expect(host.used('spend_status').length).toBeGreaterThan(1));
    expect($('[data-call-pending-budget-hint]')).toBeNull();
    spend.pending = { ...spend.pending!, op_id: 'different-request' };
    const reads = host.used('spend_status').length;
    host.emitLive({ type: 'link', state: 'closed' });
    host.emitLive({ type: 'link', state: 'open' });
    await vi.waitFor(() => expect(host.used('spend_status').length).toBeGreaterThan(reads));
    await vi.waitFor(() => expect($('[data-call-pending-budget-hint]')).not.toBeNull());
    expect(host.used('spend_cancel')).toHaveLength(1);
    expect(host.used('spend_request')).toHaveLength(1);
    expect(host.used('call_signal')).toHaveLength(0);
    expect(host.used('call_block')).toHaveLength(0);
  });
  it.each([A, 'b'.repeat(64)])('remembers a pending call budget only for its peer when opening approval for %s', async (peer) => {
    const spend: SpendView = { state: 'locked', basis: null, open_until_ms: null, pending: null, window_ms: 600_000 };
    const host = stubHost({ peers: [A, 'b'.repeat(64)], pairing: () => ({ ...paired, scopes: ['read', 'receive'] }), spend,
      request: () => {
        Object.assign(spend, { state: 'pending', pending: { op_id: 'call-budget', expires_at_ms: Date.now() + 600_000,
          owner_action: 'Approve the call budget at your node.', owner_can_grant: true } });
        return { ...spend };
      } });
    await openShell();
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-approve]')).not.toBeNull());
    $<HTMLButtonElement>('[data-call-approve]')!.click();
    await vi.waitFor(() => expect($('[data-call-approval] [data-approval="pending"]')).not.toBeNull());
    [...$('[data-call-approval]')!.querySelectorAll('button')].find(b => b.textContent === 'Close')!.click();
    $<HTMLButtonElement>(`[data-track="peer:${peer}"]`)!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-approval] [data-approval="pending"]')).not.toBeNull());
    expect(!!$('[data-call-pending-budget-hint]')).toBe(peer !== A);
    expect(host.used('spend_request')).toHaveLength(1);
    expect(host.used('spend_request')[0].args).toEqual({ call_peer: A });
    expect(host.used('spend_cancel')).toHaveLength(0);
    expect(host.used('call_signal')).toHaveLength(0);
    expect(host.used('call_block')).toHaveLength(0);
  });
  it.each(['recheck', 'call-first', 'ordinary-first'])('keeps pending request origin accurate during an ordinary approval: %s', async (sequence) => {
    const spend: SpendView = { state: 'expired', basis: null, open_until_ms: null, pending: null, window_ms: 600_000, lapse: 'lost' };
    let finishRequest: ((view: SpendView) => void) | undefined;
    const host = stubHost({ pairing: () => ({ ...paired, scopes: ['read', 'receive'] }), spend,
      replies: { spend_status: () => ({ ...spend }), sponsor_status: () => ({ enabled: true, gift_msat: 20_000_000, fee_msat: 100_000,
        purse_msat: 100_000_000, purse_used_msat: 0, kits_per_day: 2, kits_today: 0 }) },
      request: args => {
        if (sequence === 'call-first' && args?.call_peer) return new Promise<SpendView>(resolve => { finishRequest = resolve; });
        Object.assign(spend, { state: 'pending', pending: spend.pending ?? { op_id: sequence === 'recheck' ? 'call-budget' : 'ordinary',
          expires_at_ms: Date.now() + 600_000, owner_action: 'Approve the waiting request at your node.', owner_can_grant: true } });
        if (sequence === 'ordinary-first' && !args?.call_peer) return new Promise<SpendView>(resolve => { finishRequest = resolve; });
        return { ...spend };
      } });
    const openApproval = async () => {
      $<HTMLButtonElement>(`[data-track="peer:${A}"]`)!.click();
      await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')?.disabled).toBe(false));
      $<HTMLButtonElement>('[data-call="audio"]')!.click();
      await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
      $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
      await vi.waitFor(() => expect($('[data-call-approval]')).not.toBeNull());
    };
    const ordinaryApproval = async () => {
      $<HTMLButtonElement>('[data-track="new"]')!.click();
      await vi.waitFor(() => expect($('[data-starter-include]')).not.toBeNull());
      $<HTMLButtonElement>('[data-starter-include]')!.click();
    };
    await openShell();
    if (sequence === 'ordinary-first') {
      await ordinaryApproval();
      await vi.waitFor(() => expect(finishRequest).toBeDefined());
    }
    await openApproval();
    $<HTMLButtonElement>('[data-call-approve]')!.click();
    await vi.waitFor(() => expect(host.used('spend_request')).toHaveLength(sequence === 'ordinary-first' ? 2 : 1));
    if (sequence !== 'ordinary-first') {
      if (sequence === 'recheck') await vi.waitFor(() => expect($('[data-call-approval] [data-approval="pending"]')).not.toBeNull());
      [...$('[data-call-approval]')!.querySelectorAll('button')].find(b => b.textContent === 'Close')!.click();
      await ordinaryApproval();
      await vi.waitFor(() => expect(host.used('spend_request')).toHaveLength(2));
    }
    finishRequest?.({ ...spend });
    await vi.waitFor(() => expect($('[data-spend="pending"]')).not.toBeNull());
    if (sequence !== 'ordinary-first') await openApproval();
    await vi.waitFor(() => expect($('[data-call-approval] [data-approval="pending"]')).not.toBeNull());
    expect(!!$('[data-call-pending-budget-hint]')).toBe(sequence !== 'recheck');
    expect(host.used('spend_request').map(call => call.args)).toEqual(sequence === 'ordinary-first' ? [{}, { call_peer: A }] : [{ call_peer: A }, {}]);
    expect(host.used('spend_cancel')).toHaveLength(0);
    expect(host.used('sponsor_offer')).toHaveLength(0);
    expect(host.used('call_signal')).toHaveLength(0);
    expect(host.used('call_block')).toHaveLength(0);
  });
  it.each(['pending', 'unreadable'])('keeps guidance for an unobserved existing request when prior status is %s', async (priorStatus) => {
    let spend: SpendView = { state: 'expired', basis: null, open_until_ms: null, pending: null, window_ms: 600_000, lapse: 'lost' };
    let priorUnreadable = false;
    const host = stubHost({ pairing: () => ({ ...paired, scopes: ['read', 'receive'] }),
      replies: { spend_status: () => {
        if (priorUnreadable) throw { code: 'read_failed', message: 'Spending status is temporarily unavailable.' };
        return { ...spend };
      } }, request: () => ({ ...spend }) });
    await openShell();
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-approve]')).not.toBeNull());
    spend = { state: 'pending', basis: null, open_until_ms: null, window_ms: 600_000,
      pending: { op_id: 'unobserved-ordinary', expires_at_ms: Date.now() + 600_000,
        owner_action: 'Approve the waiting request at your node.', owner_can_grant: true } };
    priorUnreadable = priorStatus === 'unreadable';
    $<HTMLButtonElement>('[data-call-approve]')!.click();
    await vi.waitFor(() => expect($('[data-call-approval] [data-approval="pending"]')).not.toBeNull());
    expect($('[data-call-pending-budget-hint]')).not.toBeNull();
    expect(host.used('spend_request')).toHaveLength(1);
    expect(host.used('spend_request')[0].args).toEqual({ call_peer: A });
    expect(host.used('spend_cancel')).toHaveLength(0);
    expect(host.used('call_signal')).toHaveLength(0);
    expect(host.used('call_block')).toHaveLength(0);
  });
  it('approves answering without requiring a reservation price from the caller', async () => {
    let quote = QUOTE;
    const host = stubHost({
      quote: () => quote,
      pairing: () => ({ ...paired, scopes: ['read', 'receive'] }),
      spend: { state: 'locked', basis: null, open_until_ms: null, pending: null, window_ms: 600_000 },
    });
    await openShell();
    quote = { ...QUOTE, block_msat: null, reservation_max_msat: null };
    host.emitLive({ type: 'message', room_id: null, message: { id: 'incoming', kind: 400, sender: A, recipient: OWN,
      timestamp: Date.now(), plaintext: JSON.stringify({ v: 1, call_id: ID, media: 'audio', sdp: nodeRoutedSdp('offer', ID) }), payment_amount_msat: 10_000 } });
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-accept]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-accept]')!.click();
    await vi.waitFor(() => expect($('[data-call-approval]')).not.toBeNull());
    $<HTMLButtonElement>('[data-call-approve]')!.click();
    await vi.waitFor(() => expect(host.used('spend_request')).toHaveLength(1));
    expect(host.used('spend_request')[0].args).toEqual({});
    expect(host.used('call_signal')).toHaveLength(0);
    expect(host.used('call_block')).toHaveLength(0);
  });
  async function ringAndAnswer(host: ReturnType<typeof stubHost>) {
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
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

  it.each(['en', 'da'] as const)('a cached grant that is too small offers a request before any signal (%s)', async lang => {
    const host = stubHost({
      quote: { ...QUOTE, offer_msat: 600_000, offer_max_routing_fee_msat: 0, signal_msat: 1_000, signal_max_routing_fee_msat: 0, call_total_msat: 601_000 },
      grant: { budget_msat: 500_000, remaining_msat: 499_000, per_call_max_msat: 500_000, expires_at_ms: Date.now() + 600_000, envelopes: null },
    });
    await openShell(); setLanguagePref(lang);
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect($<HTMLInputElement>('[data-call-budget-sats]')?.value).toBe('601');
    expect($('[data-call-approval] strong')?.textContent).toBe(lang === 'en'
      ? 'Approve spending before calling' : 'Godkend betalinger før opkald');
    expect($('[data-call-approval]')?.textContent).toContain(lang === 'en'
      ? 'After approval, press Call or Answer again.' : 'Tryk Ring eller Besvar igen, når du har godkendt.');
    expect($('[data-call-approval]')?.textContent).not.toContain(lang === 'en'
      ? 'ask them to call again' : 'bed dem derefter ringe igen');
    expect(host.used('call_signal')).toHaveLength(0);
    $<HTMLButtonElement>('[data-call-budget-request]')!.click();
    await vi.waitFor(() => expect($('[data-call-approval] [data-approval="pending"]')).not.toBeNull());
    expect(host.used('spend_request').map(c => c.args)).toEqual([{ budget_msat: 601_000 }]);
    expect(host.used('call_signal')).toHaveLength(0);
    expect(host.used('call_block')).toHaveLength(0);
  });

  it('closes and resets replacement approval when pending clears into an already open grant', async () => {
    const grant: NodeGrantSummary = { budget_msat: 500_000, remaining_msat: 499_000,
      per_call_max_msat: 500_000, expires_at_ms: Date.now() + 600_000, envelopes: null };
    const host = stubHost({
      quote: { ...QUOTE, offer_msat: 600_000, offer_max_routing_fee_msat: 0,
        signal_msat: 1_000, signal_max_routing_fee_msat: 0, call_total_msat: 601_000 }, grant,
    });
    await openShell();
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-budget-request]')).not.toBeNull());
    $<HTMLButtonElement>('[data-call-budget-request]')!.click();
    await vi.waitFor(() => expect($('[data-call-approval] [data-approval="pending"]')).not.toBeNull());
    expect($('[data-call-approval] [data-spend="open"]')).not.toBeNull();

    Object.assign(grant, { budget_msat: 700_000, remaining_msat: 700_000, per_call_max_msat: 700_000 });
    host.setSpending({ state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 600_000,
      pending: null, granted_op: 'ab12', armed_by_request: 'ab12', window_ms: 600_000 });
    host.emitLive({ type: 'link', state: 'open' });
    await vi.waitFor(() => expect($('[data-call-approval]')).toBeNull());
    expect($('[data-call-budget-sats]')).toBeNull();
    expect(host.used('spend_request')).toHaveLength(1);
    expect(host.used('call_signal')).toHaveLength(0);
    expect(host.used('call_block')).toHaveLength(0);
  });

  it('blocks a replacement amount already covered by the live grant', async () => {
    const host = stubHost({
      quote: { ...QUOTE, offer_msat: 600_000, offer_max_routing_fee_msat: 0,
        signal_msat: 1_000, signal_max_routing_fee_msat: 0, call_total_msat: 601_000 },
      grant: { budget_msat: 500_000, remaining_msat: 499_000, per_call_max_msat: 500_000,
        expires_at_ms: Date.now() + 600_000, envelopes: null },
    });
    await openShell();
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-budget-sats]')).not.toBeNull());
    const input = $<HTMLInputElement>('[data-call-budget-sats]')!;
    input.value = '499'; input.dispatchEvent(new Event('input', { bubbles: true }));
    const submit = $<HTMLButtonElement>('[data-call-budget-request]')!;
    expect(submit.disabled).toBe(true);
    submit.click();
    expect(host.used('spend_request')).toHaveLength(0);
    input.value = '500'; input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(submit.disabled).toBe(false);
    expect(host.used('call_signal')).toHaveLength(0);
  });

  it.each(['', '100001', '499'])('guards expired-window Ask again for replacement amount %j', async value => {
    const host = stubHost({
      quote: { ...QUOTE, offer_msat: 600_000, offer_max_routing_fee_msat: 0,
        signal_msat: 1_000, signal_max_routing_fee_msat: 0, call_total_msat: 601_000 },
      grant: { budget_msat: 500_000, remaining_msat: 499_000, per_call_max_msat: 500_000,
        expires_at_ms: Date.now() + 600_000, envelopes: null },
      spend: { state: 'expired', basis: null, open_until_ms: null, pending: null, window_ms: 600_000, lapse: 'lost' },
    });
    const capture = vi.spyOn(navigator.mediaDevices, 'getUserMedia');
    await openShell();
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-budget-sats]')).not.toBeNull());
    const input = $<HTMLInputElement>('[data-call-budget-sats]')!;
    input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
    const approve = $<HTMLButtonElement>('[data-call-approve]')!;
    const askAgain = $<HTMLButtonElement>('[data-call-approval] [data-spend-ask-again]')!;
    expect(approve.disabled).toBe(true);
    expect(askAgain.disabled).toBe(true);
    askAgain.click();
    expect(host.used('spend_request')).toHaveLength(0);
    input.value = '601'; input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(approve.disabled).toBe(false);
    expect(askAgain.disabled).toBe(false);
    askAgain.click();
    await vi.waitFor(() => expect(host.used('spend_request')).toHaveLength(1));
    expect(host.used('spend_request')[0].args).toEqual({ budget_msat: 601_000 });
    expect(host.used('call_signal')).toHaveLength(0);
    expect(host.used('call_block')).toHaveLength(0);
    expect(capture).not.toHaveBeenCalled();
  });

  it('a host refusal for a too-short approval is proven unpaid: Call again stays, nothing counts as maybe paid', async () => {
    // The app's own checks pass on its last-read whole-day grant; the host then
    // finds the node's grant short and refuses before anything is sent.
    const host = stubHost({
      grant: { budget_msat: 2_000_000, remaining_msat: 2_000_000, per_call_max_msat: 2_000_000, expires_at_ms: Date.now() + 86_400_000, envelopes: null },
      offer: () => { throw { code: 'call_window_short', message: 'Your box’s approval ends before this call could end, and the call would stop there. Nothing was sent or paid. Ask the person who set up your box for a new approval.' }; },
    });
    await openShell();
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect(host.used('call_signal')).toHaveLength(1);
    expect(host.used('call_block')).toHaveLength(0);
    await vi.waitFor(() => expect($('[data-call-again]')).not.toBeNull());
    expect($('[data-call-panel]')!.textContent).not.toMatch(/may have been paid|kan være betalt|unknown|ukendt/i);
  });
  it.each(['en', 'da'] as const)('an exhausted active grant offers a larger owner request without ringing again (%s)', async lang => {
    const host = stubHost({
      quote: { ...QUOTE, offer_msat: 600_000, offer_max_routing_fee_msat: 0, signal_msat: 1_000, signal_max_routing_fee_msat: 0, call_total_msat: 601_000 },
      offer: () => { throw { code: 'grant_exhausted', message: 'Your node\'s spend budget has 499 sats left, less than this costs. Nothing was sent. Ask for a new budget.' }; },
    });
    await openShell();
    setLanguagePref(lang);
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    const input = $<HTMLInputElement>('[data-call-budget-sats]');
    expect(input?.value).toBe('601');
    expect($('[data-call-budget-request]')?.textContent).toBe(lang === 'en' ? 'Ask for a bigger budget' : 'Bed om et større budget');
    expect(host.used('spend_request')).toHaveLength(0);
    input!.value = '700'; input!.dispatchEvent(new Event('input', { bubbles: true }));
    $<HTMLButtonElement>('[data-call-budget-request]')!.click();
    await vi.waitFor(() => expect($('[data-call-approval] [data-approval="pending"]')).not.toBeNull());
    expect(host.used('spend_request').map(c => c.args)).toEqual([{ budget_msat: 700_000 }]);
    expect(host.used('call_signal')).toHaveLength(1);
    expect(host.used('call_block')).toHaveLength(0);
    expect($('[data-call-budget-request]')).toBeNull();
  });

  it.each(['en', 'da'] as const)('an unavailable replacement keeps the existing window without offering approval instructions (%s)', async lang => {
    const host = stubHost({
      ownerCanGrant: false,
      offer: () => { throw { code: 'grant_exhausted', message: 'Not enough remaining budget.' }; },
    });
    await openShell(); setLanguagePref(lang);
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-budget-request]')).not.toBeNull());
    $<HTMLButtonElement>('[data-call-budget-request]')!.click();
    await vi.waitFor(() => expect($('[data-call-approval] [data-approval="unavailable"]')).not.toBeNull());
    expect($('[data-call-approval] [data-approval="pending"]')).toBeNull();
    expect($('[data-call-budget-request]')).toBeNull();
    expect($('[data-call-approval] [data-spend="open"]')).not.toBeNull();
    expect(host.used('spend_request').map(c => c.args)).toEqual([{ budget_msat: 21_000 }]);
    expect(host.used('call_signal')).toHaveLength(1);
  });

  it('a failed larger-budget request keeps its amount available for retry', async () => {
    let reject = true;
    const host = stubHost({
      offer: () => { throw { code: 'grant_exhausted', message: 'Not enough remaining budget.' }; },
      spendRequest: () => { if (reject) throw { code: 'node', message: 'Request unavailable.' }; },
    });
    await openShell();
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect($<HTMLInputElement>('[data-call-budget-sats]')?.value).toBe('21');
    $<HTMLButtonElement>('[data-call-budget-request]')!.click();
    await vi.waitFor(() => expect($('[data-call-approval]')?.textContent).toContain('Request unavailable.'));
    expect($<HTMLInputElement>('[data-call-budget-sats]')?.value).toBe('21');
    reject = false;
    $<HTMLButtonElement>('[data-call-budget-request]')!.click();
    await vi.waitFor(() => expect($('[data-call-approval] [data-approval="pending"]')).not.toBeNull());
    expect(host.used('spend_request')).toHaveLength(2);
    expect(host.used('call_signal')).toHaveLength(1);
  });

  it.each(['audio', 'video'] as const)('refreshes the minute price before enabling %s Ring and submits the displayed limits', async (media) => {
    vi.stubEnv('VITE_CALL_VIDEO', 'node');
    let reply: Reply = () => QUOTE;
    const host = stubHost({ quote: (args) => reply(args) });
    await openShell();
    let finish!: (q: CallQuote) => void;
    reply = () => new Promise<CallQuote>((resolve) => { finish = resolve; });
    $<HTMLButtonElement>(`[data-call="${media}"]`)!.click();
    const ring = $<HTMLButtonElement>(`[data-call-confirm="${media}"]`)!;
    expect(ring.disabled).toBe(true);
    expect($('[data-call-minute-price]')).toBeNull();
    expect($('[data-call-reservation-max]')).toBeNull();
    expect($('[data-call-confirm-box]')?.textContent).toContain('Fetching price…');
    ring.click();
    expect(host.used('call_signal')).toHaveLength(0);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    finish({ ...QUOTE, block_msat: 20_000, block_max_routing_fee_msat: 6_000, reservation_max_msat: 6_240_000 });
    await vi.waitFor(() => expect(ring.disabled).toBe(false));
    expect($('[data-call-minute-price]')?.textContent).toBe('Then 20 sats a minute, plus up to 6 sats routing a minute, paid by your node while the call runs.');
    expect($('[data-call-reservation-max]')?.textContent).toContain('6\u202f240 sats');
    expect(host.used('call_signal')).toHaveLength(0);
    ring.click();
    await vi.waitFor(() => expect(host.used('call_signal')).toHaveLength(1));
    expect(host.used('call_signal')[0].args).toMatchObject({ peer: A, kind: 400,
      minutes: { block_msat: 20_000, block_max_routing_fee_msat: 6_000, max_hold_msat: 6_240_000 } });
    expect(host.used('call_block')).toHaveLength(0);
  });

  it('reads the minute price again every time the dialog opens', async () => {
    let q = QUOTE;
    const host = stubHost({ quote: () => q });
    await openShell();
    for (const price of [20_000, 30_000]) {
      q = { ...QUOTE, block_msat: price, reservation_max_msat: 240 * (price + FEE) };
      $<HTMLButtonElement>('[data-call="audio"]')!.click();
      await vi.waitFor(() => expect($('[data-call-minute-price]')?.textContent).toContain(`${price / 1000} sats a minute`));
      $<HTMLButtonElement>('[data-call-confirm-cancel]')!.click();
    }
    expect(host.used('call_signal')).toHaveLength(0);
    expect(host.used('call_block')).toHaveLength(0);
  });

  it.each([
    ['no minute price', { ...QUOTE, block_msat: null }],
    ['no reservation', { ...QUOTE, minutes_payable: false }],
    ['no offer price', { ...QUOTE, offer_msat: null, call_total_msat: null }],
  ] as const)('cannot ring when the refreshed quote has %s', async (_reason, unavailable) => {
    let q: CallQuote = QUOTE;
    const host = stubHost({ quote: () => q });
    await openShell();
    q = unavailable;
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-confirm-box]')).toBeNull());
    expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(true);
    expect(host.used('call_signal')).toHaveLength(0);
    expect(host.used('call_block')).toHaveLength(0);
  });

  it('a failed dialog price read hides the old amounts and cannot ring, then reopening retries', async () => {
    let reply: Reply = () => QUOTE;
    const host = stubHost({ quote: () => reply() });
    await openShell();
    reply = () => { throw { code: 'node', message: 'Call price is unavailable.' }; };
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-confirm-box]')?.textContent).toContain('Call price is unavailable.'));
    expect($('[data-call-minute-price]')).toBeNull();
    expect($('[data-call-reservation-max]')).toBeNull();
    expect($<HTMLButtonElement>('[data-call-confirm="audio"]')!.disabled).toBe(true);
    $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
    expect(host.used('call_signal')).toHaveLength(0);
    $<HTMLButtonElement>('[data-call-confirm-cancel]')!.click();
    reply = () => ({ ...QUOTE, block_msat: 30_000 });
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-minute-price]')?.textContent).toContain('30 sats a minute'));
    expect($<HTMLButtonElement>('[data-call-confirm="audio"]')!.disabled).toBe(false);
  });

  it('a cancelled dialog read cannot replace the next dialog price or enable Ring', async () => {
    const pending: ((q: CallQuote) => void)[] = [];
    let reply: Reply = () => QUOTE;
    const host = stubHost({ quote: () => reply() });
    await openShell();
    reply = () => new Promise<CallQuote>((resolve) => { pending.push(resolve); });
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    $<HTMLButtonElement>('[data-call-confirm-cancel]')!.click();
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[0]({ ...QUOTE, block_msat: 20_000 });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect($<HTMLButtonElement>('[data-call-confirm="audio"]')!.disabled).toBe(true);
    expect($('[data-call-minute-price]')).toBeNull();
    pending[1]({ ...QUOTE, block_msat: 30_000 });
    await vi.waitFor(() => expect($('[data-call-minute-price]')?.textContent).toContain('30 sats a minute'));
    expect($<HTMLButtonElement>('[data-call-confirm="audio"]')!.disabled).toBe(false);
    expect(host.used('call_signal')).toHaveLength(0);
  });

  it('a price read with an empty error cannot reuse the cached consent', async () => {
    let reply: Reply = () => QUOTE;
    const host = stubHost({ quote: () => reply() });
    await openShell();
    reply = () => { throw { code: 'node', message: '' }; };
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect(host.used('call_quote')).toHaveLength(2));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect($<HTMLButtonElement>('[data-call-confirm="audio"]')!.disabled).toBe(true);
    expect($('[data-call-minute-price]')).toBeNull();
    expect($('[data-call-confirm-box] [role="status"]')?.textContent).toBeTruthy();
    $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
    expect(host.used('call_signal')).toHaveLength(0);
  });

  it('an old contact read cannot overwrite the refreshed dialog after navigating away and back', async () => {
    const other = 'b'.repeat(64);
    let finish!: (q: CallQuote) => void;
    let reads = 0;
    const host = stubHost({ peers: [A, other], quote: (args) => {
      if (args?.peer === A && ++reads === 1) return new Promise<CallQuote>((resolve) => { finish = resolve; });
      return { ...QUOTE, block_msat: 30_000 };
    } });
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => <App />, mount);
    await vi.waitFor(() => expect([...mount.querySelectorAll('button')].some((b) => b.hasAttribute('data-trust-continue'))).toBe(true));
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.hasAttribute('data-trust-continue'))!.click();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    $<HTMLButtonElement>(`[data-track="peer:${other}"]`)!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')?.disabled).toBe(false));
    $<HTMLButtonElement>(`[data-track="peer:${A}"]`)!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    expect($('[data-call-minute-price]')?.textContent).toContain('30 sats a minute');
    finish(QUOTE);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect($('[data-call-minute-price]')?.textContent).toContain('30 sats a minute');
    $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
    await vi.waitFor(() => expect(host.used('call_signal')).toHaveLength(1));
    expect(host.used('call_signal')[0].args).toMatchObject({ peer: A, kind: 400, minutes: { block_msat: 30_000 } });
  });

  it('shows the per-minute price and the most the node will hold before Ring; nothing is dialled until Ring', async () => {
    const host = stubHost();
    await openShell();
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    expect($('[data-call-minute-price]')?.textContent).toBe(`Then ${amount(BLOCK, 'up')} a minute, plus up to ${amount(FEE, 'up')} routing a minute, paid by your node while the call runs.`);
    expect($('[data-call-reservation-max]')?.textContent).toBe(`Your node sets aside at most ${amount(240 * (BLOCK + FEE), 'up')} for the minutes and gives back what is not used. If it would need more, it does not ring and nothing is paid. You confirm before the first minute is paid.`);
    // The full rules, word for word, one tap away behind Details.
    expect($<HTMLDetailsElement>('[data-call-reservation-detail]')!.open).toBe(false);
    expect($('[data-call-reservation-detail] p')?.textContent).toBe(`When it rings, your node holds the minutes under its own call limit. The call goes out with your limits: this per-minute price and a hold of at most ${amount(240 * (BLOCK + FEE), 'up')} (4 hours, the most a node allows). If their live price or the hold would be higher, your node does not ring them and nothing is paid. You see the exact hold and confirm it before the first minute is paid.`);
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
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    expect($('[data-call-minute-price]')?.textContent).toContain('pr. minut');
    expect($('[data-call-reservation-max]')?.textContent).toBe(`Din node reserverer højst ${amount(240 * (BLOCK + FEE), 'up')} til minutterne og giver det ubrugte tilbage. Skulle den bruge mere, ringer den ikke op, og der betales intet. Du bekræfter, før det første minut betales.`);
    expect($('[data-call-reservation-detail] p')?.textContent).toContain('ringer din node ikke op');
  });

  it('the contact-budget line shows only once the box’s call limit is known: none before any call, then with the 10-minute limit its reservation pinned', async () => {
    const left = 50_000;
    const host = stubHost({ minutes: 10, budget: () => ({
      paused: false, waiting_for_owner: false, ceiling_msat: 500_000, max_daily_msat: 100_000_000, spent_msat: 0, unsettled_msat: 0,
      preset: 'careful', presets: [{ id: 'careful', contact_msat: 50_000, room_msat: 100_000, ceiling_msat: 500_000 }],
      rows: [], autopay: { state: 'off', open_until_ms: null, ceiling_msat: null, basis: null }, window_ms: 600_000,
      node_grant: { expires_at_ms: Date.now() + 86_400_000, budget_msat: 5_000_000, remaining_msat: 5_000_000, per_call_max_msat: 5_000_000,
        recipient_left_msat_by_recipient: { [A]: left } },
    }) });
    await openShell();
    // The limit is unknown before any call: no warning, Ring enabled.
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    expect($('[data-call-reservation-max]')).not.toBeNull();
    expect($('[data-call-contact-budget-short]')).toBeNull();
    expect($<HTMLButtonElement>('[data-call-confirm="audio"]')!.disabled).toBe(false);
    $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
    // The box pins its 10-minute limit on the reservation.
    await vi.waitFor(() => expect($('[data-call-hold]')).not.toBeNull());
    $<HTMLButtonElement>('[data-call-hangup]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-dismiss]')?.disabled).toBe(false), { timeout: 4_000 });
    $<HTMLButtonElement>('[data-call-dismiss]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    const hold = 10 * (BLOCK + FEE) + QUOTE.offer_msat! + QUOTE.offer_max_routing_fee_msat + QUOTE.signal_msat + QUOTE.signal_max_routing_fee_msat;
    expect($('[data-call-contact-budget-short]')?.textContent).toBe(
      `Your box has only ${amount(left, 'up')} left for Maya right now. A call holds up to ${amount(hold, 'up')}, so your box will likely turn it down. A bigger budget for this contact usually has to be approved on the box’s own computer.`);
    // Display only: Ring stays enabled; the box remains the authority.
    expect($<HTMLButtonElement>('[data-call-confirm="audio"]')!.disabled).toBe(false);
    expect(host.used('call_block')).toHaveLength(0);
  }, 15_000);

  it('once it rings, the card shows the node’s exact hold under its own call limit (max_call_minutes) to confirm', async () => {
    const host = stubHost({ minutes: 60 });
    await openShell();
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-hold]')).not.toBeNull());
    expect($('[data-call-hold]')!.textContent).toBe(
      `Your node holds ${amount(60 * (BLOCK + FEE), 'up')} for this call: up to 60 minutes (its call limit) at ${amount(BLOCK, 'up')} a minute plus up to ${amount(FEE, 'up')} routing. It releases what is not used when the call ends. No minute is paid until you confirm.`);
    expect(host.used('call_block')).toHaveLength(0);
    $<HTMLButtonElement>('[data-call-minutes-confirm]')!.click();
    await vi.waitFor(() => expect(host.used('call_hold').slice(-1)[0]?.args).toEqual({ peer: A, call_id: host.callId(), confirm_reserved_msat: 60 * (BLOCK + FEE) }));
    await vi.waitFor(() => expect($('[data-call-hold]')).toBeNull());
    expect(host.used('call_block')).toHaveLength(0);
  });

  it('next to Confirm hold, the card says the call connects only after you confirm (EN and DA); the line goes once confirmed', async () => {
    const host = stubHost({ minutes: 60 });
    await openShell();
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-minutes-confirm]')).not.toBeNull());
    expect($('[data-call-hold-needed]')?.textContent).toBe('Press Confirm hold now: the call connects only after you confirm. No minute is paid before.');
    try {
      setLanguagePref('da');
      expect($('[data-call-hold-needed]')?.textContent).toBe('Tryk Bekræft reservation nu: opkaldet forbindes først, når du har bekræftet. Der betales intet minut før.');
      expect($('[data-call-minutes-confirm]')?.textContent).toBe('Bekræft reservation');
    } finally { setLanguagePref('en'); }
    expect(host.used('call_block')).toHaveLength(0);
    $<HTMLButtonElement>('[data-call-minutes-confirm]')!.click();
    await vi.waitFor(() => expect($('[data-call-hold-needed]')).toBeNull());
  });

  it('says the hold in Danish too, with the node’s call limit', async () => {
    stubHost({ minutes: 60 });
    setLanguagePref('da');
    await openShell();
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-hold]')).not.toBeNull());
    expect($('[data-call-hold]')!.textContent).toContain('højst 60 minutter (dens opkaldsgrænse)');
    expect($('[data-call-minutes-confirm]')!.textContent).toBe('Bekræft reservation');
  });

  it('a hold above the consent: the host hung up, the card ends with the reason, and no minute is paid', async () => {
    const host = stubHost({ hold: () => { throw { code: 'call_hold_above_consent', message: ABOVE }; } });
    await openShell();
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    // One plain line; the node's own words wait under a closed Details.
    expect($('[data-call-ended]')?.textContent).toBe('Your node’s hold for this call does not match what you agreed to, so the call ended.');
    expect($<HTMLDetailsElement>('[data-call-end-detail]')!.open).toBe(false);
    expect($('[data-call-end-detail]')!.textContent).toContain(ABOVE);
    expect(host.used('call_block')).toHaveLength(0);
    expect(host.used('call_media_open')).toHaveLength(0);
  });

  it('an owner session (no reservation from its node) cannot ring a paid-minutes call, and the button says why', async () => {
    const host = stubHost({ quote: { ...QUOTE, minutes_payable: false } });
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => <App />, mount);
    await vi.waitFor(() => expect([...mount.querySelectorAll('button')].some((b) => b.hasAttribute('data-trust-continue'))).toBe(true));
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.hasAttribute('data-trust-continue'))!.click();
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
    await vi.waitFor(() => expect([...mount.querySelectorAll('button')].some((b) => b.hasAttribute('data-trust-continue'))).toBe(true));
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.hasAttribute('data-trust-continue'))!.click();
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
      `${amount(BLOCK, 'up')} a minute (plus up to ${amount(FEE, 'up')} routing). Paid so far: ${amount(BLOCK + FEE, 'up')}. Still reserved: ${amount(239 * (BLOCK + FEE), 'up')}.`));
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

  /** Their hangup arrives while the first minute is being paid; then that minute's result comes back unknown. */
  async function peerHangsUpOnALostMinute(reconcile: Reply, code = 'spend_unknown', dismiss?: Reply, budget?: Reply) {
    let lose: (error: unknown) => void = () => {};
    const host = stubHost({ block: () => new Promise((_, reject) => { lose = reject; }), reconcile, dismiss, budget });
    await openShell();
    const callId = await ringAndAnswer(host);
    await vi.waitFor(() => expect(host.used('call_block')).toHaveLength(1));
    host.emitLive({ type: 'message', room_id: null, message: { id: 'gone', kind: 403, sender: A, recipient: OWN, timestamp: Date.now(), plaintext: JSON.stringify({ v: 1, call_id: callId, reason: 'hangup' }), payment_amount_msat: 1000, admission_operation_id: 'op-400' } });
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect($('[data-call-lost-minute]')).toBeNull();
    expect(host.used('spend_reconcile')).toHaveLength(0);
    lose({ code, message: 'Outcome unknown; another spend is blocked until reconciled. The node did not return a complete response.' });
    return host;
  }
  /** The node still holds the reservation, so the card goes on reading it about once a second. */
  const THROUGH_THE_POLL = 2_500;
  const FAILED_PAID = 'Paid, and the recipient’s node refused this message for good. The payment is not refundable. Do not send it again.';
  const STILL_UNKNOWN = { code: 'payment_unknown', message: 'Payment unknown: the original send may still reach your node.' };
  const NOTHING = 'Not sent - nothing was paid: your node reports no payment for this message. Nothing was dispatched again.';

  it('a minute lost to their hangup: the ended card checks it once by itself, and a settled result needs nothing more', async () => {
    const host = await peerHangsUpOnALostMinute(() => NOTHING);
    await vi.waitFor(() => expect($('[data-call-pay-status="checked"]')?.textContent).toBe(NOTHING));
    expect(host.used('spend_reconcile')).toHaveLength(1);
    expect($('[data-call-lost-minute]')).toBeNull();
    expect($('[data-call-panel="ended"] [data-spend-reconcile]')).toBeNull();
    expect(host.used('call_block')).toHaveLength(1);
    expect(host.used('op_end_call')).toHaveLength(0);
  });

  it('a minute lost to their hangup, still unknown: one plain line and one action on the card, and the action clears it', async () => {
    let settled = false;
    const host = await peerHangsUpOnALostMinute(() => { if (!settled) throw STILL_UNKNOWN; return NOTHING; });
    await vi.waitFor(() => expect($('[data-call-lost-minute]')).not.toBeNull());
    expect($('[data-call-lost-minute]')!.textContent).toBe('The result of this call’s last minute is not known yet, so other payments wait until it is checked.');
    await vi.waitFor(() => expect(host.used('spend_reconcile')).toHaveLength(1));
    const actions = () => mount.querySelectorAll<HTMLButtonElement>('[data-call-panel="ended"] [data-spend-reconcile]');
    expect(actions()).toHaveLength(1);
    expect(actions()[0].textContent).toBe('Check pending result');
    settled = true;
    actions()[0].click();
    await vi.waitFor(() => expect($('[data-call-lost-minute]')).toBeNull());
    expect(host.used('spend_reconcile')).toHaveLength(2);
    await vi.waitFor(() => expect($('[data-call-pay-status="checked"]')?.textContent).toBe(NOTHING));
    expect(actions()).toHaveLength(0);
    expect(host.used('call_block')).toHaveLength(1);
    expect(host.used('op_end_call')).toHaveLength(0);
  });

  it('a check that failed is not run again by the card’s later updates', async () => {
    const host = await peerHangsUpOnALostMinute(() => { throw STILL_UNKNOWN; });
    await vi.waitFor(() => expect($('[data-call-lost-minute]')).not.toBeNull());
    const reads = host.used('call_status').length;
    await new Promise((resolve) => setTimeout(resolve, THROUGH_THE_POLL));
    expect(host.used('call_status').length).toBeGreaterThan(reads);
    expect(host.used('spend_reconcile')).toHaveLength(1);
    expect($('[data-call-lost-minute]')).not.toBeNull();
  }, 10_000);

  it('a minute refused for good after their hangup is closed at the host: no line, no check, through the settlement poll', async () => {
    const host = await peerHangsUpOnALostMinute(() => NOTHING, 'failed_paid');
    await new Promise((resolve) => setTimeout(resolve, THROUGH_THE_POLL));
    expect($('[data-call-lost-minute]')).toBeNull();
    expect($('[data-call-panel="ended"] [data-spend-reconcile]')).toBeNull();
    expect(host.used('spend_reconcile')).toHaveLength(0);
  }, 10_000);

  // The host's reply while a paid, undelivered record stays pending: every paid action waits.
  const ACCOUNTED = { code: 'undelivered_pending', message: 'Accounted: 10000 msat paid, and the message is not delivered yet. Your node keeps resending it; nothing was dispatched again.', pending_id: 'rec-9' };
  const STOPPED = 'Stopped retrying. 10000 msat was paid and the message was not delivered; nothing more will be paid for it.';
  const UNDELIVERED_LINE = 'This call’s last minute was paid but not delivered, so other payments wait until you stop retrying it.';
  const actions = (name: string) => mount.querySelectorAll<HTMLButtonElement>(`[data-call-panel="ended"] [${name}]`);

  /** The record stays until the owner stops retrying: the line, one action, through the poll, and then nothing. */
  async function stoppingClearsIt(host: ReturnType<typeof stubHost>) {
    await vi.waitFor(() => expect(actions('data-stop-retrying')).toHaveLength(1));
    expect($('[data-call-lost-minute]')!.textContent).toBe(UNDELIVERED_LINE);
    expect(actions('data-spend-reconcile')).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, THROUGH_THE_POLL));
    expect($('[data-call-lost-minute]')!.textContent).toBe(UNDELIVERED_LINE);
    expect(actions('data-stop-retrying')).toHaveLength(1);
    actions('data-stop-retrying')[0].click();
    await vi.waitFor(() => expect($('[data-call-lost-minute]')).toBeNull());
    expect(host.used('spend_dismiss_undelivered').map((c) => c.args)).toEqual([{ pending_id: 'rec-9' }]);
    await vi.waitFor(() => expect($('[data-call-pay-status="checked"]')?.textContent).toBe(STOPPED));
    expect(actions('data-stop-retrying')).toHaveLength(0);
    expect(host.used('call_block')).toHaveLength(1);
    expect(host.used('op_end_call')).toHaveLength(0);
  }
  const accountedThenStopped = { reconcile: () => { throw ACCOUNTED; }, dismiss: () => STOPPED };

  it('a minute paid and not delivered after their hangup: the card says so, and stopping retries clears it', async () => {
    let lose: (error: unknown) => void = () => {};
    const host = stubHost({ block: () => new Promise((_, reject) => { lose = reject; }), ...accountedThenStopped });
    await openShell();
    const callId = await ringAndAnswer(host);
    await vi.waitFor(() => expect(host.used('call_block')).toHaveLength(1));
    host.emitLive({ type: 'message', room_id: null, message: { id: 'gone', kind: 403, sender: A, recipient: OWN, timestamp: Date.now(), plaintext: JSON.stringify({ v: 1, call_id: callId, reason: 'hangup' }), payment_amount_msat: 1000, admission_operation_id: 'op-400' } });
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    lose({ code: 'payment_settled_undelivered', message: 'Paid, not delivered.', pending_id: 'rec-9', undelivered: { paid_msat: 10_000, retry: false } });
    await stoppingClearsIt(host);
    expect(host.used('spend_reconcile')).toHaveLength(1);
  }, 15_000);

  it('a minute paid and not delivered offers stopping that record while the automatic check is still out', async () => {
    let lose: (error: unknown) => void = () => {};
    const host = stubHost({ block: () => new Promise((_, reject) => { lose = reject; }), reconcile: () => new Promise(() => {}), dismiss: () => STOPPED });
    await openShell();
    const callId = await ringAndAnswer(host);
    await vi.waitFor(() => expect(host.used('call_block')).toHaveLength(1));
    host.emitLive({ type: 'message', room_id: null, message: { id: 'gone', kind: 403, sender: A, recipient: OWN, timestamp: Date.now(), plaintext: JSON.stringify({ v: 1, call_id: callId, reason: 'hangup' }), payment_amount_msat: 1000, admission_operation_id: 'op-400' } });
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    lose({ code: 'payment_settled_undelivered', message: 'Paid, not delivered.', pending_id: 'rec-9', undelivered: { paid_msat: 10_000, retry: false } });
    await vi.waitFor(() => expect(host.used('spend_reconcile')).toHaveLength(1));
    await vi.waitFor(() => expect($('[data-call-lost-minute]')).not.toBeNull());
    expect($('[data-call-lost-minute]')!.textContent).toBe(UNDELIVERED_LINE);
    expect(actions('data-stop-retrying')).toHaveLength(1);
    expect(actions('data-spend-reconcile')).toHaveLength(0);
    actions('data-stop-retrying')[0].click();
    await vi.waitFor(() => expect($('[data-call-lost-minute]')).toBeNull());
    expect(host.used('spend_dismiss_undelivered').map((c) => c.args)).toEqual([{ pending_id: 'rec-9' }]);
  });

  it('the automatic check returning undelivered_pending keeps the line and the action: the record is still pending', async () => {
    const other = await peerHangsUpOnALostMinute(accountedThenStopped.reconcile);
    await vi.waitFor(() => expect(actions('data-stop-retrying')).toHaveLength(1));
    expect($('[data-call-lost-minute]')!.textContent).toBe(UNDELIVERED_LINE);
    expect(actions('data-spend-reconcile')).toHaveLength(0);
    expect(other.used('spend_reconcile')).toHaveLength(1);
  });

  it('the owner’s check returning undelivered_pending keeps the line and offers stopping retries', async () => {
    let checks = 0;
    const host = await peerHangsUpOnALostMinute(() => { if (++checks === 1) throw STILL_UNKNOWN; throw ACCOUNTED; }, 'spend_unknown', accountedThenStopped.dismiss);
    await vi.waitFor(() => expect(host.used('spend_reconcile')).toHaveLength(1));
    await vi.waitFor(() => expect(actions('data-spend-reconcile')).toHaveLength(1));
    actions('data-spend-reconcile')[0].click();
    await stoppingClearsIt(host);
    expect(host.used('spend_reconcile')).toHaveLength(2);
  }, 15_000);

  it('stopping retries that is refused leaves the line and the action', async () => {
    let refuse = true;
    const host = await peerHangsUpOnALostMinute(accountedThenStopped.reconcile, 'spend_unknown', () => {
      if (refuse) throw { code: 'money_busy', message: 'Another payment action is still running. Nothing was changed; try again in a moment.' };
      return STOPPED;
    });
    await vi.waitFor(() => expect(actions('data-stop-retrying')).toHaveLength(1));
    actions('data-stop-retrying')[0].click();
    await vi.waitFor(() => expect(host.used('spend_dismiss_undelivered')).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect($('[data-call-lost-minute]')).not.toBeNull();
    expect(actions('data-stop-retrying')).toHaveLength(1);
    refuse = false;
    actions('data-stop-retrying')[0].click();
    await vi.waitFor(() => expect($('[data-call-lost-minute]')).toBeNull());
  });

  it('the automatic check finding the minute paid settles the line, with what it found', async () => {
    const host = await peerHangsUpOnALostMinute(() => { throw { code: 'failed_paid', message: FAILED_PAID }; });
    await vi.waitFor(() => expect($('[data-call-pay-status="checked"]')?.textContent).toBe(FAILED_PAID));
    await new Promise((resolve) => setTimeout(resolve, THROUGH_THE_POLL));
    expect($('[data-call-lost-minute]')).toBeNull();
    expect($('[data-call-panel="ended"] [data-spend-reconcile]')).toBeNull();
    expect(host.used('spend_reconcile')).toHaveLength(1);
  }, 10_000);

  it('the owner’s check finding the minute paid settles the line too', async () => {
    let checks = 0;
    const host = await peerHangsUpOnALostMinute(() => { if (++checks === 1) throw STILL_UNKNOWN; throw { code: 'failed_paid', message: FAILED_PAID }; });
    await vi.waitFor(() => expect($('[data-call-lost-minute]')).not.toBeNull());
    await vi.waitFor(() => expect(host.used('spend_reconcile')).toHaveLength(1));
    $<HTMLButtonElement>('[data-call-panel="ended"] [data-spend-reconcile]')!.click();
    await vi.waitFor(() => expect($('[data-call-lost-minute]')).toBeNull());
    expect($('[data-call-pay-status="checked"]')?.textContent).toBe(FAILED_PAID);
  });

  it('a record already stopped from another card settles the line when stopping finds it gone', async () => {
    const gone = 'That message is no longer waiting for delivery. Nothing was changed.';
    await peerHangsUpOnALostMinute(accountedThenStopped.reconcile, 'spend_unknown', () => { throw { code: 'retry_unavailable', message: gone }; });
    await vi.waitFor(() => expect(actions('data-stop-retrying')).toHaveLength(1));
    actions('data-stop-retrying')[0].click();
    await vi.waitFor(() => expect($('[data-call-lost-minute]')).toBeNull());
    expect($('[data-call-pay-status="checked"]')?.textContent).toBe(gone);
  });

  /** The minute is held at the host, so the wallet offers the check too. */
  const HELD_BUDGET: Reply = () => ({
    paused: false, waiting_for_owner: false, ceiling_msat: 500_000, max_daily_msat: 100_000_000, spent_msat: 0, unsettled_msat: 10_000,
    preset: 'careful', presets: [{ id: 'careful', contact_msat: 50_000, room_msat: 100_000, ceiling_msat: 500_000 }],
    rows: [{ target: A, room: false, limit_msat: 50_000, spent_msat: 0 }],
    autopay: { state: 'open', open_until_ms: Date.now() + 86_400_000, ceiling_msat: 500_000, basis: 'node_grant' },
    window_ms: 600_000, node_grant: null,
  });
  async function checkFromTheWallet() {
    $<HTMLButtonElement>('[data-profile]')!.click();
    $<HTMLButtonElement>('[data-open-wallet]')!.click();
    await vi.waitFor(() => expect($('[data-wallet-tab="send"]')).not.toBeNull());
    $<HTMLButtonElement>('[data-wallet-tab="send"]')!.click();
    await vi.waitFor(() => expect($('[data-wallet-page] [data-spend-reconcile]')).not.toBeNull());
    $<HTMLButtonElement>('[data-wallet-page] [data-spend-reconcile]')!.click();
  }

  it('a check from the wallet finding the minute refused for good settles the ended card’s warning', async () => {
    let checks = 0;
    const host = await peerHangsUpOnALostMinute(() => { if (++checks === 1) throw STILL_UNKNOWN; throw { code: 'failed_paid', message: FAILED_PAID }; }, 'spend_unknown', undefined, HELD_BUDGET);
    await vi.waitFor(() => expect($('[data-call-lost-minute]')).not.toBeNull());
    await vi.waitFor(() => expect(host.used('spend_reconcile')).toHaveLength(1));
    await checkFromTheWallet();
    await vi.waitFor(() => expect($('[data-call-lost-minute]')).toBeNull());
    expect($('[data-call-pay-status="checked"]')?.textContent).toBe(FAILED_PAID);
  });

  it('a check from the wallet finding the minute undelivered keeps the card’s warning, now with its action, and stopping from the wallet clears it', async () => {
    let checks = 0;
    const host = await peerHangsUpOnALostMinute(() => { if (++checks === 1) throw STILL_UNKNOWN; throw ACCOUNTED; }, 'spend_unknown', accountedThenStopped.dismiss, HELD_BUDGET);
    await vi.waitFor(() => expect($('[data-call-lost-minute]')).not.toBeNull());
    await vi.waitFor(() => expect(host.used('spend_reconcile')).toHaveLength(1));
    await checkFromTheWallet();
    await vi.waitFor(() => expect($('[data-call-lost-minute]')!.textContent).toBe(UNDELIVERED_LINE));
    expect(actions('data-stop-retrying')).toHaveLength(1);
    await vi.waitFor(() => expect($('[data-wallet-page] [data-stop-retrying]')).not.toBeNull());
    $<HTMLButtonElement>('[data-wallet-page] [data-stop-retrying]')!.click();
    await vi.waitFor(() => expect($('[data-call-lost-minute]')).toBeNull());
    expect(host.used('spend_dismiss_undelivered').map((c) => c.args)).toEqual([{ pending_id: 'rec-9' }]);
  });

  it('a record stopped mid-call is not the ended card’s minute: their hangup on an unknown minute keeps the lost line and its check', async () => {
    const MID_CALL = { ...ACCOUNTED, pending_id: 'msg-42' };
    let lose: (error: unknown) => void = () => {};
    let checks = 0;
    const host = stubHost({
      block: () => new Promise((_, reject) => { lose = reject; }),
      reconcile: () => { if (++checks === 1) throw MID_CALL; throw STILL_UNKNOWN; },
      dismiss: () => STOPPED,
      budget: HELD_BUDGET,
    });
    await openShell();
    const callId = await ringAndAnswer(host);
    await vi.waitFor(() => expect(host.used('call_block')).toHaveLength(1));
    // Mid-call: an earlier payment is paid, not delivered, and the owner stops retrying it.
    await checkFromTheWallet();
    await vi.waitFor(() => expect($('[data-wallet-page] [data-stop-retrying]')).not.toBeNull());
    $<HTMLButtonElement>('[data-wallet-page] [data-stop-retrying]')!.click();
    await vi.waitFor(() => expect(host.used('spend_dismiss_undelivered')).toHaveLength(1));
    // Their hangup, then the minute in flight comes back unknown.
    host.emitLive({ type: 'message', room_id: null, message: { id: 'gone', kind: 403, sender: A, recipient: OWN, timestamp: Date.now(), plaintext: JSON.stringify({ v: 1, call_id: callId, reason: 'hangup' }), payment_amount_msat: 1000, admission_operation_id: 'op-400' } });
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    lose({ code: 'spend_unknown', message: 'The node did not return a complete response.' });
    await vi.waitFor(() => expect(host.used('spend_reconcile')).toHaveLength(2));
    await vi.waitFor(() => expect($('[data-call-lost-minute]')).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect($('[data-call-lost-minute]')!.textContent).toBe('The result of this call’s last minute is not known yet, so other payments wait until it is checked.');
    expect(actions('data-spend-reconcile')).toHaveLength(1);
    expect(actions('data-stop-retrying')).toHaveLength(0);
    expect(host.used('spend_dismiss_undelivered').map((c) => c.args)).toEqual([{ pending_id: 'msg-42' }]);
  });

  it('a check still out says nothing: the line and the link stay, and a failed one changes neither', async () => {
    let finish: (value: unknown) => void = () => {};
    const host = await peerHangsUpOnALostMinute(() => new Promise((_, reject) => { finish = reject; }));
    await vi.waitFor(() => expect(host.used('spend_reconcile')).toHaveLength(1));
    await vi.waitFor(() => expect($('[data-call-lost-minute]')).not.toBeNull());
    expect(actions('data-spend-reconcile')).toHaveLength(1);
    finish(STILL_UNKNOWN);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect($('[data-call-lost-minute]')).not.toBeNull();
    expect(actions('data-spend-reconcile')).toHaveLength(1);
    expect(actions('data-stop-retrying')).toHaveLength(0);
  });

  it('says the undelivered minute in Danish too', async () => {
    setLanguagePref('da');
    await peerHangsUpOnALostMinute(accountedThenStopped.reconcile);
    await vi.waitFor(() => expect(actions('data-stop-retrying')).toHaveLength(1));
    expect($('[data-call-lost-minute]')!.textContent).toBe('Opkaldets sidste minut blev betalt, men ikke leveret, så andre betalinger venter, til du stopper genforsøgene.');
    expect(actions('data-stop-retrying')[0].textContent).toBe('Stop genforsøg');
  });

  it('says the lost minute in Danish too', async () => {
    setLanguagePref('da');
    await peerHangsUpOnALostMinute(() => { throw STILL_UNKNOWN; });
    await vi.waitFor(() => expect($('[data-call-lost-minute]')).not.toBeNull());
    expect($('[data-call-lost-minute]')!.textContent).toBe('Resultatet af opkaldets sidste minut kendes ikke endnu, så andre betalinger venter, til det er kontrolleret.');
    expect($('[data-call-panel="ended"] [data-spend-reconcile]')!.textContent).toBe('Kontrollér afventende resultat');
  });

  it('a minute in flight when the owner hangs up: End answers for it, and the card adds no check of its own', async () => {
    let lose: (error: unknown) => void = () => {};
    const host = stubHost({ block: () => new Promise((_, reject) => { lose = reject; }), reconcile: () => NOTHING });
    await openShell();
    await ringAndAnswer(host);
    await vi.waitFor(() => expect(host.used('call_block')).toHaveLength(1));
    $<HTMLButtonElement>('[data-call-hangup]')!.click();
    await vi.waitFor(() => expect(host.used('op_end_call')).toHaveLength(1));
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    lose({ code: 'spend_unknown', message: 'The node did not return a complete response.' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect($('[data-call-lost-minute]')).toBeNull();
    expect(host.used('spend_reconcile')).toHaveLength(0);
  });

  it('payment_failed: a refused minute ends the call with a plain reason', async () => {
    const host = stubHost({ block: () => { throw { code: 'grant_paused', message: 'Your node paused spending after failed payments. Nothing was sent.' }; } });
    await openShell();
    await ringAndAnswer(host);
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect($('[data-call-ended]')?.textContent).toBe('A minute of the call could not be paid, so the call ended. Nothing was paid for that minute.');
    expect($('[data-call-end-detail]')!.textContent).toContain('Your node paused spending after failed payments. Nothing was sent.');
    expect(host.used('call_media_open')).toHaveLength(0);
  });

  it.each([
    ['en', 'da', 'Et minut af opkaldet kunne ikke betales, så opkaldet sluttede. Der blev ikke betalt for det minut.'],
    ['da', 'en', 'A minute of the call could not be paid, so the call ended. Nothing was paid for that minute.'],
  ] as const)('changing the language on an ended card (%s to %s) re-words the cause and keeps the node text under Details', async (from, to, said) => {
    const RAW = 'node says: callee_block_refused (seq 0)';
    const host = stubHost({ block: () => { throw { code: 'grant_paused', message: RAW }; } });
    setLanguagePref(from);
    try {
      await openShell();
      await ringAndAnswer(host);
      await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
      expect($('[data-call-ended]')!.textContent).not.toContain(RAW);
      setLanguagePref(to);
      await vi.waitFor(() => expect($('[data-call-ended]')!.textContent).toBe(said));
      expect($<HTMLDetailsElement>('[data-call-end-detail]')!.open).toBe(false);
      expect($('[data-call-end-detail]')!.textContent).toContain(RAW);
    } finally { setLanguagePref('en'); }
  });

  it('a budget with no room ends the call with its own plain reason, not as a failed payment', async () => {
    const host = stubHost({ block: () => { throw { code: 'budget_exhausted', message: 'You have used 42 sats of 50 sats for this contact in the last 24 hours, and this costs 10 sats. Raise the budget to send.' }; } });
    await openShell();
    await ringAndAnswer(host);
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect($('[data-call-ended]')?.textContent).toBe('This contact’s rolling 24-hour limit cannot cover the next minute, so the call ended. Nothing was paid for that minute.');
    expect(host.used('call_block')).toHaveLength(1);
  });

  it.each([
    ['budget_exhausted', 'You have used 42 sats of 50 sats for this contact in the last 24 hours, and this costs 10 sats. Raise the budget to send.',
      'Change this contact’s rolling 24-hour limit in Budget, then call again.',
      'Ret kontaktens grænse for de seneste 24 timer under Budget, og ring igen.'],
    ['ceiling_exhausted', 'You have used 42 sats of your 50 sats app all-in payment limit (rolling 24 hours), and this costs 10 sats. Raise the limit to send.',
      'Change the app’s rolling 24-hour total in Budget, then call again.',
      'Ret appens samlede grænse for de seneste 24 timer under Budget, og ring igen.'],
  ] as const)('the ended card identifies %s separately from a call hold or node grant', async (code, message, english, danish) => {
    const host = stubHost({ block: () => { throw { code, message }; } });
    await openShell();
    await ringAndAnswer(host);
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    const detail = $(`[data-call-budget-limit="${code}"]`);
    expect(detail?.textContent).toContain(message);
    expect(detail?.textContent).toContain(english);
    setLanguagePref('da');
    expect(detail?.textContent).toContain(code === 'budget_exhausted'
      ? 'Du har brugt 42 sats af 50 sats til denne kontakt'
      : 'Du har brugt 42 sats af appens samlede betalingsgrænse på 50 sats');
    expect(detail?.textContent).toContain(danish);
    expect(host.used('call_block')).toHaveLength(1);
    expect(host.used('call_media_open')).toHaveLength(0);
  });

  it.each([
    ['budget_exhausted', 'You have used 42 sats of 50 sats for this contact in the last 24 hours, and this costs 10 sats. Raise the budget to send.',
      'This contact’s rolling 24-hour limit cannot cover the next minute, so the call ended. Nothing was paid for that minute.',
      'Kontaktens grænse for de seneste 24 timer kan ikke dække det næste minut, så opkaldet sluttede. Der blev ikke betalt for det minut.',
      'Change this contact’s rolling 24-hour limit in Budget, then call again.',
      'Ret kontaktens grænse for de seneste 24 timer under Budget, og ring igen.',
      'Du har brugt 42 sats af 50 sats til denne kontakt de seneste 24 timer, og dette koster 10 sats. Hæv budgettet for at sende.'],
    ['ceiling_exhausted', 'You have used 42 sats of your 50 sats app all-in payment limit (rolling 24 hours), and this costs 10 sats. Raise the limit to send.',
      'The app’s rolling 24-hour total limit cannot cover the next minute, so the call ended. Nothing was paid for that minute.',
      'Appens samlede grænse for de seneste 24 timer kan ikke dække det næste minut, så opkaldet sluttede. Der blev ikke betalt for det minut.',
      'Change the app’s rolling 24-hour total in Budget, then call again.',
      'Ret appens samlede grænse for de seneste 24 timer under Budget, og ring igen.',
      'Du har brugt 42 sats af appens samlede betalingsgrænse på 50 sats (seneste 24 timer), og dette koster 10 sats. Hæv grænsen for at sende.'],
    ['grant_exhausted', "Your node's spend budget has 8 sats left, less than this costs. Nothing was sent. Ask for a new budget.",
      'Your node grant cannot cover the next minute, so the call ended. Nothing was paid for that minute.',
      'Boksens forbrugsbudget kan ikke dække det næste minut, så opkaldet sluttede. Der blev ikke betalt for det minut.',
      'Ask the owner to approve a new node grant, then call again.',
      'Bed ejeren godkende et nyt forbrugsbudget på boksen, og ring igen.',
      'Din boks’ forbrugsbudget har 8 sats tilbage, mindre end dette koster. Intet blev sendt. Bed om et nyt budget.'],
  ] as const)('the ended card leads with the true %s limit in both languages', async (code, message, english, danish, englishAction, danishAction, danishMessage) => {
    const host = stubHost({ block: () => { throw { code, message }; } });
    await openShell();
    await ringAndAnswer(host);
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect($('[data-call-ended]')?.textContent).toBe(english);
    const detail = $(`[data-call-budget-limit="${code}"]`);
    expect(detail?.textContent).toContain(message);
    expect(detail?.textContent).toContain(englishAction);
    setLanguagePref('da');
    expect($('[data-call-ended]')?.textContent).toBe(danish);
    expect(detail?.textContent).toContain(danishAction);
    expect(detail?.textContent).toBe(`${danishMessage} ${danishAction}`);
    expect(host.used('call_block')).toHaveLength(1);
    expect(host.used('call_media_open')).toHaveLength(0);
  });

  it.each([
    ['budget_exhausted', 'You have used 42 sats of 50 sats for this contact in the last 24 hours, and this costs 10 sats. Raise the budget to send.'],
    ['ceiling_exhausted', 'You have used 42 sats of your 50 sats app all-in payment limit (rolling 24 hours), and this costs 10 sats. Raise the limit to send.'],
    ['grant_exhausted', "Your node's spend budget has 8 sats left, less than this costs. Nothing was sent. Ask for a new budget."],
  ] as const)('a stuck closing call hides %s call-again guidance in both languages until it clears', async (code, message) => {
    const original = callEngine.createCallEngine;
    let latest: CallView | undefined;
    let publish: CallDeps['onView'] = () => {};
    vi.spyOn(callEngine, 'createCallEngine').mockImplementation(deps => {
      publish = deps.onView;
      return original({ ...deps, onView: view => {
        latest = view;
        deps.onView(view.minutes?.stop?.limit ? { ...view, stuck: { opId: 'closing-call' } } : view);
      } });
    });
    const host = stubHost({ block: () => { throw { code, message }; } });
    await openShell();
    await ringAndAnswer(host);
    await vi.waitFor(() => expect($('[data-call-end-stuck]')).not.toBeNull());
    expect(latest?.minutes?.stop?.limit).toEqual({ code, message });
    expect($('[data-call-ended]')?.textContent).toBe('A call to Maya is still closing at your node. Nothing was paid for this one. End it to call again.');
    expect($('[data-call-budget-limit]')).toBeNull();
    expect($('[data-call-again]')).toBeNull();
    expect($('[data-call-end-stuck]')?.textContent).toBe('End that call');
    setLanguagePref('da');
    expect($('[data-call-ended]')?.textContent).toBe('Et opkald til Maya lukkes stadig på din node. Intet blev betalt for dette. Afslut det for at ringe igen.');
    expect($('[data-call-budget-limit]')).toBeNull();
    expect($('[data-call-again]')).toBeNull();
    expect($('[data-call-end-stuck]')?.textContent).toBe('Afslut det opkald');
    publish(latest!);
    expect($(`[data-call-budget-limit="${code}"]`)).not.toBeNull();
    expect($('[data-call-end-stuck]')).toBeNull();
    expect(host.used('call_block')).toHaveLength(1);
    expect(host.used('call_media_open')).toHaveLength(0);
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
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect($('[data-call-ended]')?.textContent).toBe('Your node’s channel cannot hold this call’s reservation right now. Nothing was paid. If your node just restarted, wait a minute and call again. If this keeps happening, add outbound capacity.');
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
      `Minutes: paid ${amount(BLOCK + FEE, 'up')}. Released back to your budget: ${amount(239 * (BLOCK + FEE), 'up')}.`), { timeout: 4_000 });
    expect(host.used('call_block')).toHaveLength(1);
  }, 15_000);

  it('a call cancelled before an answer pays no minutes and shows no minutes line, so it keeps "media was not billed" (EN and DA)', async () => {
    const host = stubHost({ retireOnEnd: true });
    await openShell();
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    // Ring waits for the fresh quote.
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ringing"]')).not.toBeNull());
    $<HTMLButtonElement>('[data-call-hangup]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    await vi.waitFor(() => expect($('[data-call-paid="settled"]')).not.toBeNull(), { timeout: 4_000 });
    // Let the node's last read land: it no longer lists the call.
    await new Promise((r) => setTimeout(r, 1_500));
    expect(host.used('call_block')).toHaveLength(0);
    expect($('[data-call-minutes]')).toBeNull();
    expect($('[data-call-paid="settled"]')!.textContent).toMatch(/the exact fees are not reported\. Media was not billed\.$/);
    try {
      setLanguagePref('da');
      expect($('[data-call-paid="settled"]')!.textContent).toMatch(/de præcise gebyrer oplyses ikke\. Medier blev ikke faktureret\.$/);
    } finally { setLanguagePref('en'); }
  }, 15_000);

  it('a caller whose minutes were paid is never told media was not billed, live or after; the minutes are counted separately (EN and DA)', async () => {
    const host = stubHost();
    await openShell();
    await ringAndAnswer(host);
    await vi.waitFor(() => expect(host.used('call_media_open')).toHaveLength(1), { timeout: 3_000 });
    host.media({ link: 'open', detail: null });
    await vi.waitFor(() => expect($('[data-call-panel="live"]')).not.toBeNull());
    await vi.waitFor(() => expect(host.used('call_block')).toHaveLength(1), { timeout: 4_000 });
    // Live: the signal cap waits behind Details, and says the minutes are apart.
    await vi.waitFor(() => expect($('[data-call-details] [data-call-paid]')).not.toBeNull());
    expect($('[data-call-details] [data-call-paid]')!.textContent).toMatch(/\(includes maximum routing fees; settled amount may be lower\)\. The minutes are counted separately\.$/);
    expect($('[data-call-panel]')!.textContent).not.toMatch(/not billed/i);
    $<HTMLButtonElement>('[data-call-hangup]')!.click();
    await vi.waitFor(() => expect($('[data-call-minutes="released"]')).not.toBeNull(), { timeout: 4_000 });
    await vi.waitFor(() => expect($('[data-call-paid="settled"]')).not.toBeNull(), { timeout: 4_000 });
    expect($('[data-call-paid="settled"]')!.textContent).toMatch(/^This call paid up to .+: each signal’s price plus its routing-fee cap; the exact fees are not reported\. The minutes are counted separately\.$/);
    expect($('[data-call-panel]')!.textContent).not.toMatch(/not billed/i);
    try {
      setLanguagePref('da');
      expect($('[data-call-paid="settled"]')!.textContent).toMatch(/de præcise gebyrer oplyses ikke\. Minutterne opgøres for sig\.$/);
      expect($('[data-call-panel]')!.textContent).not.toMatch(/ikke faktureret/i);
    } finally { setLanguagePref('en'); }
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
