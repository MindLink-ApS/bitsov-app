/**
 * M6 A2: paying a node-routed call while it runs.
 *
 * Genome M6 N1/N3: the caller pays the callee one block (kind 404) per 60
 * seconds, at the callee's price. The caller's node holds ONE call-sized
 * reservation, made when the offer goes out, and draws every block from it.
 * Block 0 is due when the callee answers; block k+1 is due 20 seconds before
 * block k ends; after 10 seconds of grace the callee's node ends the call
 * (hangup reason `unpaid`).
 *
 * This module schedules those payments for one outgoing call and keeps the
 * running cost the card shows. Every amount it shows comes from the node's
 * call status (`reserved`, `spent`, `remaining`, `released`, per-block price,
 * `max_call_minutes`); the app never computes an authoritative amount.
 *
 * Consent is the host's: the offer carries the minutes the owner agreed to
 * before Ring, and the host pays no minute of a reservation above them (it
 * hangs up instead) and none before the owner confirmed the node's exact
 * hold, shown here as soon as the offer is out (`call_hold`). The renderer
 * never names an amount to pay. It never retries a payment whose outcome is
 * unknown, and reports every reason it stops.
 */
import { t as tr } from '../i18n';
import { provenUnpaid } from './paymentOutcome';
import { asActionError } from './state';
import type { ActionError, CallReceipt, CallReservation, CallStatus } from './types';

type Outcome<T> = { ok: true; value: T } | { ok: false; error: ActionError };

/** One block buys 60 seconds; the callee's node allows 10 seconds of grace after it. */
export const CALL_BLOCK_MS = 60_000;
export const BLOCK_GRACE_MS = 10_000;
/** How often the running cost is read from the node while a call runs. */
export const STATUS_POLL_MS = 5_000;
/** Pay a block this long after the node says it is due (clock skew between app and node). */
export const DUE_MARGIN_MS = 1_000;
/** A block the node did not dispatch (proven unpaid) is tried again after this wait, a few times. */
export const RETRY_MS = 2_000;
export const MAX_ATTEMPTS = 4;
/**
 * A minute refused for a passing reason is tried again for as long as paid time
 * and grace remain: 20 seconds before the boundary to 10 seconds after it.
 */
export const PASSING_MAX_ATTEMPTS = 15;
/** After the call ends, read the node until it closes the reservation, at most this long. */
export const SETTLE_POLL_MS = 1_000;
export const SETTLE_MAX_MS = 20_000;
/** The node shows the call ended: wait this long for their hangup to arrive before saying the node ended it. */
export const ENDED_CONFIRM_MS = 2_000;
/** Media waits for the node to report the first minute paid, at most the genome's initial window. */
export const PAID_POLL_MS = 1_000;
export const PAID_WAIT_MS = 30_000;

export type MinutesDeps = {
  /** `call_status`: the node's view of this call; null once it no longer lists it. Read-only. */
  status: (peer: string, callId: string) => Promise<Outcome<CallStatus | null>>;
  /**
   * `call_hold`: the host checks the node's reservation against the minutes
   * agreed before Ring (and hangs up if it is above them); with
   * `confirmReservedMsat` the owner confirms that exact hold.
   */
  hold: (peer: string, callId: string, confirmReservedMsat: number | null) => Promise<Outcome<CallStatus>>;
  /** `call_block`: pay block `seq`. The host takes the amount from the node's reservation. */
  pay: (peer: string, callId: string, seq: number) => Promise<Outcome<CallReceipt>>;
};

/** The host refused the node's hold for this call (and hung up where it was above the consent): nothing is paid. */
export const HOLD_REFUSED = new Set(['call_no_reservation', 'call_hold_above_consent', 'call_no_consent', 'call_reservation_closed']);

/**
 * Refused before anything was paid, for a reason that passes by itself: their
 * node or this one is catching up, a rate breaker, a channel read that failed. Each attempt is a new operation, so nothing is paid twice.
 */
const PASSING_REFUSAL = new Set(['not_ready', 'peer_not_ready', 'grant_rate_limited', 'grant_velocity', 'call_liquidity_unavailable']);
/** A limit the owner set: it stays reached until the owner raises it, so trying again cannot help. */
const LIMIT_REFUSAL = new Set(['budget_exhausted', 'ceiling_exhausted']);

/**
 * Why paying stopped. `unpaid`: the paid time ran out and the node ended the
 * call. `node_ended`: the node ended the call for another reason.
 * `payment_failed`: a block was refused (nothing paid for it).
 * `budget_limit`: the owner's budget has no room for the next block.
 * `payment_unknown`: a block's outcome is not known. `price_changed`: their
 * node asks more per minute than the owner agreed to. `hold_refused`: the
 * node holds no reservation for the call, or more than the owner agreed to.
 */
export type MinutesStopCode = 'unpaid' | 'node_ended' | 'payment_failed' | 'budget_limit' | 'payment_unknown' | 'price_changed' | 'hold_refused';
export type MinutesStop = { code: MinutesStopCode; message: string };

export type MinutesView = {
  /** The per-minute price the owner agreed to before dialling (their node's advert). */
  agreedBlockMsat: number;
  /** The most the caller's node would hold, shown before dialling. */
  reservationMaxMsat: number | null;
  /** The node's reservation for this call, as last read; null until the node reports one. */
  reservation: CallReservation | null;
  /** The owner confirmed the node's hold (its exact total, at the host). No minute is paid before. */
  confirmed: boolean;
  /** The confirmation is with the host. */
  confirming: boolean;
  /** Why the last confirmation did not go through (the hold changed, or the host could not be reached). */
  holdError: string | null;
  /** End of the last paid minute (node clock, Unix ms). */
  paidUntilMs: number | null;
  /** Minutes paid so far (the node's next block sequence). */
  blocks: number;
  /** Sum of block receipts (each a ceiling), for a node that keeps no reservation (an owner session). */
  receiptsMsat: number;
  /** A block payment is in flight. */
  paying: boolean;
  stop: MinutesStop | null;
  /** The call ended and the node closed the reservation (or no longer lists the call). */
  settled: boolean;
  /** The call ended and the node was read until it settled or the wait ran out. */
  final: boolean;
};

export type CallMinutes = {
  view: () => MinutesView;
  /** Read the reservation the node made with the offer (while ringing), checked by the host. */
  refresh: () => Promise<void>;
  /** The owner confirms the node's hold as shown; then minutes may be paid. */
  confirm: () => Promise<void>;
  /** Their answer arrived: pay block 0 now and keep paying while the call runs. */
  start: () => void;
  /** The call ended: stop paying; read the node until it closes the reservation. */
  finish: () => void;
  /** Stop everything (no further reads). */
  dispose: () => void;
};

export const STOP_MESSAGE: Record<MinutesStopCode, () => string> = {
  unpaid: () => tr('caMinutesUnpaid'),
  node_ended: () => tr('caMinutesNodeEnded'),
  payment_failed: () => tr('caMinutesPaymentFailed'),
  budget_limit: () => tr('caMinutesBudgetLimit'),
  payment_unknown: () => tr('caMinutesPaymentUnknown'),
  price_changed: () => tr('caMinutesPriceChanged'),
  hold_refused: () => tr('caMinutesHoldRefused'),
};

export function createCallMinutes(opts: {
  peer: string;
  callId: string;
  agreedBlockMsat: number;
  reservationMaxMsat: number | null;
  /** Outgoing: pay the blocks. Incoming: only watch the node end the call (the caller pays). */
  pays: boolean;
  deps: MinutesDeps;
  now: () => number;
  onChange: (view: MinutesView) => void;
  /** Paying stopped while the call was running: the call must end now. */
  onStop: (stop: MinutesStop) => void;
  /** The call this session pays for is still going on (checked right before every payment). */
  canPay?: () => boolean;
}): CallMinutes {
  const { peer, callId, deps, now } = opts;
  let view: MinutesView = {
    agreedBlockMsat: opts.agreedBlockMsat, reservationMaxMsat: opts.reservationMaxMsat,
    reservation: null, confirmed: false, confirming: false, holdError: null,
    paidUntilMs: null, blocks: 0, receiptsMsat: 0, paying: false, stop: null, settled: false, final: false,
  };
  /** Paying blocks (between answer and end). */
  let running = false;
  /** Reading the node after the call ended. */
  let settling = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let passingAttempts = 0;
  let settleUntil = 0;
  let inFlight = false;
  /** A status read of `tick` is in progress: a second tick would pay the same block twice. */
  let reading = false;
  let stopped = false;
  let endedSeen = false;

  const emit = (patch: Partial<MinutesView>) => {
    view = { ...view, ...patch };
    if (!disposed) opts.onChange(view);
  };
  const schedule = (ms: number, run: () => void) => {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; run(); }, Math.max(0, ms));
  };
  /** The node's clock: has the paid time (plus grace) run out? */
  const lapsed = () => view.paidUntilMs !== null && now() > view.paidUntilMs + BLOCK_GRACE_MS;
  // The node's latest view replaces the last one: a reservation it no longer reports is not shown as still held.
  const apply = (status: CallStatus) => emit({
    reservation: status.reservation ?? null,
    paidUntilMs: status.paid_until_ms ?? view.paidUntilMs,
    blocks: Math.max(view.blocks, status.next_block_seq),
  });
  /**
   * Paying may go on. Publishing a view runs the call's own checks, which can
   * end the call there and then (`finish` or `dispose`): every step after an
   * `emit` or an `await` asks again before it pays or schedules anything.
   */
  const payable = () => running && !disposed && !settling && !stopped && (opts.canPay?.() ?? true);
  const read = async (): Promise<Outcome<CallStatus | null>> => {
    try { return await deps.status(peer, callId); } catch (error) { return { ok: false, error: asActionError(error) }; }
  };

  /** Stops while ringing (the hold was refused) or while paying; never after the call ended. */
  const stopWith = (code: MinutesStopCode, detail: string | null = null) => {
    if (stopped || disposed || settling) return;
    stopped = true;
    running = false;
    clearTimeout(timer);
    timer = undefined;
    const stop = { code, message: detail ? `${STOP_MESSAGE[code]()} ${detail}` : STOP_MESSAGE[code]() };
    emit({ stop });
    opts.onStop(stop);
  };

  const tick = async () => {
    if (!running || inFlight || reading) return;
    reading = true;
    const r = await read();
    reading = false;
    if (!running) return;
    // A failed read is not evidence of anything: read again shortly. The node's grace ends the call if paying is impossible.
    if (!r.ok) { schedule(RETRY_MS, () => void tick()); return; }
    const status = r.value;
    if (status) apply(status);
    // Publishing the status may have ended the call (a stop deadline that passed while the app was suspended).
    if (!running) return;
    if (!status || status.state === 'ended') {
      // Their hangup may be on its way: give it a moment to name the end first.
      if (!endedSeen && !lapsed()) { endedSeen = true; schedule(ENDED_CONFIRM_MS, () => void tick()); return; }
      stopWith(lapsed() ? 'unpaid' : 'node_ended');
      return;
    }
    endedSeen = false;
    if (!opts.pays) { schedule(STATUS_POLL_MS, () => void tick()); return; }
    const hold = status.reservation;
    if (hold && hold.per_block_msat > view.agreedBlockMsat) { stopWith('price_changed'); return; }
    const due = status.next_block_due_ms;
    // No block due (the node's duration cap): keep the running cost fresh until the call ends.
    if (due === null) { schedule(STATUS_POLL_MS, () => void tick()); return; }
    // The host pays no minute before the owner confirmed the node's hold; confirm() ticks again.
    if (!view.confirmed) { schedule(STATUS_POLL_MS, () => void tick()); return; }
    // Block 0 is payable from the answer on; a renewal waits a little past its due time (clock skew).
    const wait = due + (status.next_block_seq > 0 ? DUE_MARGIN_MS : 0) - now();
    if (wait > 0) { schedule(Math.min(wait, STATUS_POLL_MS), () => void tick()); return; }
    if (!payable()) return;
    await payBlock(status.next_block_seq);
  };

  const payBlock = async (seq: number) => {
    inFlight = true;
    emit({ paying: true });
    // The view just published can end the call: no block is paid for a call that ended.
    if (!payable()) {
      inFlight = false;
      emit({ paying: false });
      return;
    }
    let r: Outcome<CallReceipt>;
    try { r = await deps.pay(peer, callId, seq); } catch (error) { r = { ok: false, error: asActionError(error) }; }
    inFlight = false;
    // A receipt is counted even if the call ended meanwhile: it was paid.
    emit({ paying: false, ...(r.ok ? { receiptsMsat: view.receiptsMsat + r.value.total_msat, blocks: Math.max(view.blocks, seq + 1) } : {}) });
    if (!running) return;
    if (r.ok) { attempts = 0; passingAttempts = 0; void tick(); return; }
    const code = r.error.code;
    if (code === 'call_price_changed' || code === 'price_cap_exceeded' || code === 'price_changed') { stopWith('price_changed'); return; }
    // No reservation, or one above the consent: the host hung up and pays none of it.
    if (HOLD_REFUSED.has(code)) { stopWith('hold_refused', r.error.message); return; }
    // The host has no confirmation of this hold (it changed): show it again, pay nothing until confirmed.
    if (code === 'call_hold_unconfirmed' || code === 'call_hold_changed') {
      emit({ confirmed: false });
      if (running) schedule(STATUS_POLL_MS, () => void tick());
      return;
    }
    // The node no longer runs the call: read it once more, so their hangup (or the lapse) names the end.
    if (code === 'call_not_live') {
      if (++attempts < MAX_ATTEMPTS) { schedule(0, () => void tick()); return; }
      stopWith(lapsed() ? 'unpaid' : 'node_ended');
      return;
    }
    if (LIMIT_REFUSAL.has(code)) { stopWith('budget_limit'); return; }
    if (PASSING_REFUSAL.has(code)) {
      if (++passingAttempts < PASSING_MAX_ATTEMPTS && !lapsed()) { schedule(RETRY_MS, () => void tick()); return; }
      stopWith('payment_failed', r.error.message);
      return;
    }
    if (provenUnpaid(code)) {
      // Not dispatched (for example the node's clock says it is not due yet): nothing was paid, try again a few times.
      const retryable = code === 'not_dispatched' || code === 'call_block_not_due';
      attempts++;
      if (retryable && attempts < MAX_ATTEMPTS && !lapsed()) { schedule(RETRY_MS, () => void tick()); return; }
      stopWith('payment_failed', r.error.message);
      return;
    }
    // Paid or not is unknown: never pay again on top of it.
    stopWith('payment_unknown', r.error.message);
  };

  const settle = async () => {
    if (!settling || disposed) return;
    const r = await read();
    if (!settling || disposed) return;
    if (r.ok) {
      const status = r.value;
      // The node no longer lists the call: its last reservation snapshot is retired, never shown as still held.
      if (!status) { settling = false; emit({ reservation: null, settled: true, final: true }); return; }
      apply(status);
      if (!status.reservation || status.reservation.closed) { settling = false; emit({ settled: true, final: true }); return; }
    }
    if (now() >= settleUntil) { settling = false; emit({ final: true }); return; }
    schedule(SETTLE_POLL_MS, () => void settle());
  };

  /** The host's check of the node's hold. A refused hold stops the call now; a failed read is tried again. */
  const checkHold = async (attempt: number): Promise<void> => {
    if (disposed || settling || stopped || !opts.pays) return;
    let r: Outcome<CallStatus>;
    try { r = await deps.hold(peer, callId, null); } catch (error) { r = { ok: false, error: asActionError(error) }; }
    if (disposed || settling || stopped) return;
    if (r.ok) { apply(r.value); return; }
    if (HOLD_REFUSED.has(r.error.code)) { stopWith('hold_refused', r.error.message); return; }
    if (attempt + 1 < MAX_ATTEMPTS && !running) await new Promise((resolve) => setTimeout(resolve, RETRY_MS)).then(() => checkHold(attempt + 1));
  };

  return {
    view: () => view,
    refresh: () => checkHold(0),
    confirm: async () => {
      const hold = view.reservation;
      if (disposed || settling || stopped || !opts.pays || !hold || view.confirmed || view.confirming) return;
      emit({ confirming: true, holdError: null });
      let r: Outcome<CallStatus>;
      try { r = await deps.hold(peer, callId, hold.reserved_msat); } catch (error) { r = { ok: false, error: asActionError(error) }; }
      if (disposed || settling || stopped) return;
      if (r.ok) {
        apply(r.value);
        emit({ confirming: false, confirmed: true });
        if (running) { clearTimeout(timer); timer = undefined; void tick(); }
        return;
      }
      emit({ confirming: false, holdError: r.error.message });
      if (HOLD_REFUSED.has(r.error.code)) stopWith('hold_refused', r.error.message);
      else if (r.error.code === 'call_hold_changed') void checkHold(0);
    },
    start: () => {
      if (running || disposed || settling || stopped) return;
      running = true;
      attempts = 0;
      passingAttempts = 0;
      void tick();
    },
    finish: () => {
      if (disposed || settling || view.final) return;
      running = false;
      clearTimeout(timer);
      timer = undefined;
      settling = true;
      settleUntil = now() + SETTLE_MAX_MS;
      // Let an in-flight block settle first; then read until the node closes the reservation.
      schedule(inFlight ? SETTLE_POLL_MS : 0, () => void settle());
    },
    dispose: () => {
      disposed = true;
      running = false;
      settling = false;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

/**
 * The node admits call audio (the media socket) only once the call is live
 * and its first minute is paid. Resolves true when the node reports that,
 * false when the call ended or the initial window ran out unpaid.
 */
export async function waitUntilPaid(
  status: MinutesDeps['status'], peer: string, callId: string, now: () => number,
  closed: () => boolean = () => false, timeoutMs = PAID_WAIT_MS,
): Promise<boolean> {
  const until = now() + timeoutMs;
  for (;;) {
    if (closed()) return false;
    let r: Outcome<CallStatus | null>;
    try { r = await status(peer, callId); } catch (error) { r = { ok: false, error: asActionError(error) }; }
    if (r.ok && r.value) {
      if (r.value.state === 'ended') return false;
      if (r.value.state === 'live' && r.value.paid_until_ms !== null) return true;
    }
    if (closed() || now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, PAID_POLL_MS));
  }
}
