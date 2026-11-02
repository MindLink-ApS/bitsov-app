/**
 * A phone call muted by the owner, then unmuted into a microphone the phone
 * OS keeps silenced: the real capture path (silence detector), the real call
 * engine and node-routed adapter, and the real minute scheduler, with only
 * the audio graph, the host socket and the node simulated. The owner's mute
 * is no evidence of a silenced microphone; unmuting starts a fresh
 * observation, so the call still ends after the detection time and the
 * grace, and no further minute is paid.
 *
 * A suspended phone delivers its timers late: a minute poll (or a status
 * reply) that arrives after the stop deadline ends the call, and pays no
 * further minute.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCallEngine, SILENCED_GRACE_MS, type CallDeps, type CallView } from '../src/control/call';
import { createCallAudio, SILENT_FRAMES } from '../src/control/callAudio';
import { STATUS_POLL_MS, type MinutesDeps } from '../src/control/callMinutes';
import { createNodeRoutedConnection, nodeRoutedSdp } from '../src/control/nodeRoutedConnection';
import type { MediaBridge, MediaLink } from '../src/control/mediaBridge';
import { setLanguagePref } from '../src/i18n';
import type { ActionError, CallQuote, CallReceipt, CallReservation, CallStatus } from '../src/control/types';

const OWN = '1'.repeat(64);
const A = 'a'.repeat(64);
const ID = '0123456789abcdef0123456789abcdef';
const BLOCK = 10_000;
const FEE = 5_000;
const QUOTE: CallQuote = {
  offer_msat: 10_000, offer_max_routing_fee_msat: 5_000, signal_msat: 1_000, signal_max_routing_fee_msat: 5_000, call_total_msat: 21_000,
  block_msat: BLOCK, block_max_routing_fee_msat: FEE, reservation_max_msat: 240 * (BLOCK + FEE), minutes_payable: true,
};
/** One captured frame every 20 ms, as the capture worklet posts them. */
const FRAME_MS = 20;
const DETECT_MS = SILENT_FRAMES * FRAME_MS;

type Outcome<T> = { ok: true; value: T } | { ok: false; error: ActionError };
const ok = <T,>(value: T): Outcome<T> => ({ ok: true, value });

/** The caller's node: one call answered at `answeredAt`, one block per paid minute. */
function fakeNode() {
  const node = {
    answeredAt: Date.now(),
    seq: 0,
    paidUntil: null as number | null,
    reservation: {
      reserved_msat: 240 * (BLOCK + FEE), spent_msat: 0, remaining_msat: 240 * (BLOCK + FEE),
      per_block_msat: BLOCK, per_block_fee_msat: FEE, max_call_minutes: 240, released_msat: 0, closed: false,
    } as CallReservation,
    status: (): CallStatus => ({
      id: ID, state: 'live', direction: 'outgoing', paid_until_ms: node.paidUntil, next_block_seq: node.seq,
      next_block_due_ms: node.paidUntil === null ? node.answeredAt : node.paidUntil - 20_000,
      reservation: { ...node.reservation },
    }),
    settle: (seq: number) => {
      node.seq = seq + 1;
      node.paidUntil = (node.paidUntil ?? node.answeredAt) + 60_000;
      node.reservation.spent_msat += BLOCK + FEE;
      node.reservation.remaining_msat -= BLOCK + FEE;
    },
  };
  return node;
}

class FakeNode {
  port = { postMessage: vi.fn(), onmessage: null as ((event: { data: unknown }) => void) | null };
  gain = { value: 1 };
  onprocessorerror: (() => void) | null = null;
  connect<T>(next: T) { return next; }
  disconnect() {}
}
class FakeWorkletNode extends FakeNode {
  static made: { name: string; node: FakeWorkletNode }[] = [];
  constructor(_ctx: unknown, name: string) { super(); FakeWorkletNode.made.push({ name, node: this }); }
}
class FakeContext {
  sampleRate = 48_000;
  currentTime = 0;
  destination = new FakeNode();
  audioWorklet = { addModule: async () => {} };
  async resume() {}
  async close() {}
  createMediaStreamSource() { return new FakeNode(); }
  createGain() { return new FakeNode(); }
}

beforeEach(() => {
  FakeWorkletNode.made = [];
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
  vi.useFakeTimers();
  vi.setSystemTime(1_790_000_000_000);
  setLanguagePref('en');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setLanguagePref('system');
});

function phone() {
  const views: CallView[] = [];
  const ended: string[] = [];
  const reports: boolean[] = [];
  const node = fakeNode();
  const pay = vi.fn(async (_p: string, _c: string, seq: number) => { node.settle(seq); return ok<CallReceipt>({ message_id: `blk${seq}`, kind: 404, amount_msat: BLOCK, total_msat: BLOCK + FEE, max_routing_fee_msat: FEE, delivered: true, accepted: true, sent_at_ms: 0 }); });
  /** Status replies held back (a request in flight while the phone is suspended). */
  let holding = false;
  const held: (() => void)[] = [];
  const status = vi.fn((): Promise<Outcome<CallStatus | null>> => holding
    ? new Promise((resolve) => { held.push(() => resolve(ok(node.status()))); })
    : Promise.resolve(ok(node.status())));
  const minutes: MinutesDeps = { status, hold: vi.fn(async () => ok(node.status())), pay };
  /** The app's wall clock runs ahead of its timers: they were held while the phone was suspended. */
  let skew = 0;
  // The microphone: a disabled track (the owner's mute) delivers exact zeros, as does a microphone the OS silenced.
  const mic = { kind: 'audio', enabled: true, muted: false, readyState: 'live', stop: vi.fn() };
  let osSilenced = false;
  const tracks = [mic];
  const stream = { getTracks: () => tracks, getAudioTracks: () => tracks, getVideoTracks: () => [], addTrack: () => {}, removeTrack: () => {} } as unknown as MediaStream;
  let link: ((l: MediaLink) => void) | null = null;
  const bridge: MediaBridge = { open: async (_c, _p, _f, l) => { link = l; }, send: () => {}, close: async () => {} };
  let calls: ReturnType<typeof createCallEngine> | null = null;
  const deps: CallDeps = {
    routed: true,
    minutes,
    stopWhenSilenced: true,
    quote: async () => ok(QUOTE),
    signal: async (_peer, kind) => ok({ operation_id: `op-${kind}`, message_id: 'm', kind, amount_msat: 1, total_msat: 1, max_routing_fee_msat: 0, delivered: true, accepted: true, sent_at_ms: 0 }),
    getUserMedia: async () => stream,
    peerConnection: () => createNodeRoutedConnection({
      callId: () => calls?.view().callId ?? null, peer: () => calls?.view().peer ?? null, bridge,
      // As the phone shell wires it: the capture path's silence reports go to the engine.
      audio: (s, transport, onFatal) => createCallAudio({ stream: s, transport, onError: onFatal, audioContext: () => new FakeContext() as unknown as AudioContext,
        workletUrl: 'worklet.js', opus: false, onSilence: (silent) => { reports.push(silent); calls?.micSilent(silent); } }),
      onSession: (event) => { if (event.state === 'closed') calls?.mediaClosed(event.callId); },
    }),
    now: () => Date.now() + skew,
    onView: (v) => views.push(v),
    onStreams: () => {},
    newCallId: () => ID,
    endCall: async (callId) => { ended.push(callId); return ok({ op_id: 'end', kind: 'call_hangup', peer: A, call_id: ID, state: 'settled', cap_msat: 6_000, paid_msat: 6_000, message_id: 'h' } as never); },
  };
  calls = createCallEngine(deps);
  const engine = calls;
  // The capture worklet posts a frame every 20 ms: a quiet room's noise floor, or exact zeros.
  setInterval(() => {
    const capture = [...FakeWorkletNode.made].reverse().find((m) => m.name === 'bitsov-call-capture')?.node;
    const zero = osSilenced || !mic.enabled;
    capture?.port.onmessage?.({ data: { type: 'frame', pcm: new Float32Array(960).map((_, i) => (zero ? 0 : (i % 7 - 3) * 1e-5)) } });
  }, FRAME_MS);
  const live = async () => {
    await engine.place(A, 'audio', QUOTE);
    await vi.waitFor(() => expect(engine.view().minutes?.reservation).not.toBeNull());
    await engine.confirmMinutes();
    node.answeredAt = Date.now();
    await engine.receive({ id: 'ans', kind: 401, sender: A, recipient: OWN, timestamp: 0, plaintext: JSON.stringify({ v: 1, call_id: ID, sdp: nodeRoutedSdp('answer', ID) }), payment_amount_msat: 1 }, OWN);
    await vi.waitFor(() => expect(pay).toHaveBeenCalledWith(A, ID, 0));
    await vi.advanceTimersByTimeAsync(0);
    link?.({ link: 'open', detail: null });
    await vi.waitFor(() => expect(engine.view().phase).toBe('live'));
  };
  return {
    engine, views, ended, reports, pay, status, mic, live, silence: () => { osSilenced = true; },
    /** The wall clock moves on; no timer fires. */
    suspend: (ms: number) => { skew += ms; },
    hold: () => { holding = true; },
    /** Deliver the held status replies now. */
    release: () => { holding = false; held.splice(0).forEach((reply) => reply()); },
    heldReplies: () => held.length,
  };
}

describe('a phone call muted, then unmuted into a silenced microphone', () => {
  it('ends after a fresh detection and the grace; no minute is paid after that', async () => {
    const h = phone();
    await h.live();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.engine.view()).toMatchObject({ phase: 'live', stopped: null });

    // The owner mutes for 12 s: the track delivers zeros, which are no evidence.
    h.engine.toggleMute();
    expect(h.mic.enabled).toBe(false);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(h.engine.view()).toMatchObject({ phase: 'live', muted: true, stopped: null });
    expect(h.reports).toEqual([]);

    // Unmuted, but the phone OS keeps the microphone silenced: the capture path still hears only zeros.
    h.silence();
    h.engine.toggleMute();
    expect(h.mic.enabled).toBe(true);
    await vi.advanceTimersByTimeAsync(DETECT_MS - 5 * FRAME_MS);
    expect(h.engine.view()).toMatchObject({ phase: 'live', muted: false, stopped: null });
    await vi.advanceTimersByTimeAsync(10 * FRAME_MS);
    expect(h.reports).toEqual([true]);
    const stop = h.engine.view().stopped;
    expect(stop).toMatchObject({ cause: 'microphone', endsAt: expect.any(Number) });
    expect(stop!.endsAt! - Date.now()).toBeGreaterThan(SILENCED_GRACE_MS - 10 * FRAME_MS);
    expect(stop!.endsAt! - Date.now()).toBeLessThanOrEqual(SILENCED_GRACE_MS);

    await vi.advanceTimersByTimeAsync(stop!.endsAt! - Date.now() - 1);
    expect(h.engine.view().phase).toBe('live');
    expect(h.ended).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.engine.view()).toMatchObject({ phase: 'ended', reason: 'hangup', stopped: { cause: 'microphone', endsAt: null } });
    expect(h.ended).toEqual([ID]);

    // Block 0 at the answer and block 1 inside the call; nothing after it ended.
    const paid = h.pay.mock.calls.length;
    expect(paid).toBe(2);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.pay).toHaveBeenCalledTimes(paid);
    expect(h.engine.view().phase).toBe('ended');
  });
});

describe('a suspended phone call whose minute check arrives after the stop deadline', () => {
  it('an overdue minute poll ends the call and pays no further minute', async () => {
    const h = phone();
    await h.live();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.engine.view().phase).toBe('live');
    expect(h.pay).toHaveBeenCalledTimes(1);

    // Hidden at t=30 s: the call ends at t=50 s.
    h.engine.setBackgrounded(true);
    const endsAt = h.engine.view().stopped!.endsAt!;
    // The phone suspends the app past the deadline (t=51 s), then delivers the minute poll it held (due at t=35 s).
    // The node still runs the call, with the next minute due at t=40 s.
    h.suspend(endsAt - Date.now() + 1_000);
    const polls = h.status.mock.calls.length;
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS);
    expect(h.status.mock.calls.length).toBeGreaterThan(polls);

    expect(h.engine.view()).toMatchObject({ phase: 'ended', reason: 'hangup', stopped: { cause: 'background', endsAt: null } });
    expect(h.ended).toEqual([ID]);
    expect(h.pay).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.pay).toHaveBeenCalledTimes(1);
  });

  it('a status reply that arrives after the deadline ends the call and pays no further minute', async () => {
    const h = phone();
    await h.live();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(h.pay).toHaveBeenCalledTimes(1);

    // A minute check is on its way to the node when the app is hidden.
    h.hold();
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS);
    expect(h.heldReplies()).toBe(1);
    h.engine.setBackgrounded(true);
    const endsAt = h.engine.view().stopped!.endsAt!;
    // Its reply comes back only after the deadline, while the node still runs the call with the next minute due.
    h.suspend(endsAt - Date.now() + 1_000);
    h.release();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.engine.view()).toMatchObject({ phase: 'ended', reason: 'hangup', stopped: { cause: 'background', endsAt: null } });
    expect(h.ended).toEqual([ID]);
    expect(h.pay).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.pay).toHaveBeenCalledTimes(1);
  });
});
