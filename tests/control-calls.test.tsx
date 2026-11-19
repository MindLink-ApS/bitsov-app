import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setLanguagePref } from '../src/i18n';
import { asActionError } from '../src/control/state';
import { sampleSource } from '../src/control/sample';
import { setStunPref, setDenom } from '../src/control/prefs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import type { PairingView } from '../src/onboarding/pairing';
import { resetContactsForTests, setPetname } from '../src/control/petnames';
import type { ActionError, BudgetView, CallQuote, CallReceipt, LiveEvent, Message, SpendView, OpView } from '../src/control/types';
import { closeOutcome, CONNECT_TIMEOUT_MS, createCallEngine, mediaError, NO_MEDIA_DEVICES, RECONNECT_GRACE_MS, isCallKind, newCallId, parseSignal, RING_MS, signalCost, stunServer, type CallDeps, type CallView } from '../src/control/call';

const OWN = '1'.repeat(64);
const A = 'a'.repeat(64);
const ID = '0123456789abcdef0123456789abcdef';
const QUOTE: CallQuote = { offer_msat: 10_000, offer_max_routing_fee_msat: 5_000, signal_msat: 1_000, signal_max_routing_fee_msat: 5_000, call_total_msat: 21_000 };

/** A stand-in RTCPeerConnection: records what the engine asks of it. */
class FakePc {
  static made: FakePc[] = [];
  stats = new Map<string, Record<string, unknown>>();
  async getStats() { return this.stats; }
  iceGatheringState = 'complete';
  connectionState = 'new';
  iceConnectionState = 'new';
  oniceconnectionstatechange: (() => void) | null = null;
  offers: RTCOfferOptions[] = [];
  restartIce = vi.fn();
  localDescription: { type: string; sdp: string } | null = null;
  remote: { type: string; sdp: string } | null = null;
  tracks: MediaStreamTrack[] = [];
  candidates: unknown[] = [];
  closed = false;
  ontrack: ((e: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  constructor(public config: RTCConfiguration) { FakePc.made.push(this); }
  senders: { track: MediaStreamTrack | null; replaced: (MediaStreamTrack | null)[]; replaceTrack: (t: MediaStreamTrack | null) => Promise<void> }[] = [];
  addTrack(t: MediaStreamTrack) {
    this.tracks.push(t);
    const sender = { track: t as MediaStreamTrack | null, replaced: [] as (MediaStreamTrack | null)[], replaceTrack: async (n: MediaStreamTrack | null) => { sender.replaced.push(n); sender.track = n; } };
    this.senders.push(sender);
    return sender;
  }
  state(s: string) { this.connectionState = s; this.onconnectionstatechange?.(); }
  async createOffer(options: RTCOfferOptions = {}) { this.offers.push(options); return { type: 'offer', sdp: 'v=0 offer' }; }
  async createAnswer() { return { type: 'answer', sdp: 'v=0 answer' }; }
  async setLocalDescription(d: { type: string; sdp: string }) { this.localDescription = d; }
  async setRemoteDescription(d: { type: string; sdp: string }) { this.remote = d; }
  async addIceCandidate(c: unknown) { this.candidates.push(c); }
  addEventListener() {}
  removeEventListener() {}
  close() { this.closed = true; }
  connect() { this.connectionState = 'connected'; this.onconnectionstatechange?.(); }
}

function track(kind: 'audio' | 'video') {
  return { kind, enabled: true, stop: vi.fn() } as unknown as MediaStreamTrack;
}
function stream(video = false, audio = true) {
  const tracks = [...(audio ? [track('audio')] : []), ...(video ? [track('video')] : [])];
  return {
    addTrack: (t: MediaStreamTrack) => { tracks.push(t); },
    removeTrack: (t: MediaStreamTrack) => { tracks.splice(tracks.indexOf(t), 1); },
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
  } as unknown as MediaStream;
}

type Sent = { peer: string; kind: number; body: Record<string, unknown>; max: number };

function engine(over: Partial<CallDeps> = {}) {
  const sent: Sent[] = [];
  const views: CallView[] = [];
  const media: MediaStreamConstraints[] = [];
  let n = 0;
  let ids = 0;
  const e = createCallEngine({
    quote: async () => ({ ok: true, value: QUOTE }),
    signal: async (peer, kind, plaintext, max) => {
      sent.push({ peer, kind, body: JSON.parse(plaintext), max });
      return { ok: true, value: { message_id: `m${++n}`, kind, amount_msat: kind === 400 ? 10_000 : 1_000, total_msat: kind === 400 ? 15_000 : 6_000, max_routing_fee_msat: 5_000, delivered: true, accepted: true, sent_at_ms: 0 } satisfies CallReceipt };
    },
    getUserMedia: async (c) => { media.push(c); return stream(!!c.video, c.audio !== undefined); },
    peerConnection: (config) => new FakePc(config) as unknown as RTCPeerConnection,
    now: () => 1_000,
    onView: (v) => views.push(v),
    onStreams: () => {},
    newCallId: () => ids++ === 0 ? ID : 'e'.repeat(32),
    ...over,
  });
  return { e, sent, views, media, last: () => views[views.length - 1] };
}

const msg = (kind: number, body: Record<string, unknown>, sender = A): Message => ({
  id: `in-${kind}-${Math.random()}`, kind, sender, recipient: OWN, timestamp: 0, plaintext: JSON.stringify({ v: 1, call_id: ID, ...body }), payment_amount_msat: 1000,
});

describe('answering and declining within the price shown', () => {
  const live = (value: CallQuote) => async () => ({ ok: true as const, value });
  const REFUSED: [string, CallDeps['quote']][] = [
    ['their signal price rose', live({ ...QUOTE, signal_msat: 1_001 })],
    ['their routing ceiling rose', live({ ...QUOTE, signal_max_routing_fee_msat: 5_001 })],
    ['the price cannot be held exactly', live({ ...QUOTE, signal_msat: Number.MAX_SAFE_INTEGER })],
    ['their node gave no live price', live({ ...QUOTE, offer_msat: null, offer_max_routing_fee_msat: 0, call_total_msat: null })],
    ['the read failed', async () => ({ ok: false as const, error: { code: 'node', message: 'Could not read it' } as ActionError })],
  ];

  it.each(REFUSED)('Accept pays nothing when %s, and says so', async (_case, quote) => {
    const { e, sent, last } = engine({ quote });
    await e.receive(msg(400, { media: 'audio', sdp: 'offer' }), OWN);
    await e.accept(QUOTE);
    expect(sent).toHaveLength(0);
    expect(last()).toMatchObject({ phase: 'ended', paidMsat: 0, pendingCount: 0, unknownCount: 0 });
    expect(last().error).toMatch(/nothing was paid/i);
  });

  it.each(REFUSED)('Decline pays nothing when %s, and says so', async (_case, quote) => {
    const { e, sent, last } = engine({ quote });
    await e.receive(msg(400, { media: 'audio', sdp: 'offer' }), OWN);
    await e.decline(QUOTE);
    expect(sent).toHaveLength(0);
    expect(last()).toMatchObject({ phase: 'ended', reason: 'declined', paidMsat: 0, pendingCount: 0, unknownCount: 0 });
    expect(last().error).toMatch(/nothing was paid/i);
  });

  it('pays the live price when it is at or below the one shown, on either button', async () => {
    for (const [value, max] of [[QUOTE, 6_000], [{ ...QUOTE, signal_msat: 500, signal_max_routing_fee_msat: 4_000 }, 4_500]] as const) {
      const accepting = engine({ quote: live(value) });
      await accepting.e.receive(msg(400, { media: 'audio', sdp: 'offer' }), OWN);
      await accepting.e.accept(QUOTE);
      expect(accepting.sent.map((s) => [s.kind, s.max])).toEqual([[401, max]]);
      const declining = engine({ quote: live(value) });
      await declining.e.receive(msg(400, { media: 'audio', sdp: 'offer' }), OWN);
      await declining.e.decline(QUOTE);
      expect(declining.sent.map((s) => [s.kind, s.max])).toEqual([[403, max]]);
    }
  });

  it('Ignore stops the ring here: no quote read, no signal, no record, and nothing later', async () => {
    vi.useFakeTimers();
    try {
      const quote = vi.fn(async () => ({ ok: true as const, value: QUOTE }));
      const onMissed = vi.fn();
      const { e, sent, last } = engine({ quote, onMissed });
      await e.receive(msg(400, { media: 'audio', sdp: 'offer' }), OWN);
      expect(last().phase).toBe('incoming');
      e.ignore();
      expect(last().phase).toBe('idle');
      await vi.advanceTimersByTimeAsync(120_000);
      await e.receive(msg(403, { reason: 'timeout' }), OWN);
      expect(last().phase).toBe('idle');
      expect(sent).toHaveLength(0);
      expect(quote).not.toHaveBeenCalled();
      expect(onMissed).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('a press waiting on approval when Ignore lands pays nothing', async () => {
    let allow: (yes: boolean) => void = () => {};
    const { e, sent, last } = engine({ authorize: () => new Promise<boolean>((resolve) => { allow = resolve; }) });
    await e.receive(msg(400, { media: 'audio', sdp: 'offer' }), OWN);
    const accepting = e.accept(QUOTE);
    e.ignore();
    allow(true);
    await accepting;
    expect(sent).toHaveLength(0);
    expect(last().phase).toBe('idle');
  });

  it('an offer carries the hangup ceiling shown with it, and no other signal does', async () => {
    const hangups: [number, number | undefined][] = [];
    const { e } = engine({ signal: async (_peer, kind, _plaintext, max, _minutes, maxHangup) => {
      hangups.push([kind, maxHangup]);
      return { ok: true, value: { message_id: 'm', kind, amount_msat: max, total_msat: max, max_routing_fee_msat: 0, delivered: true, accepted: true, sent_at_ms: 0 } };
    } });
    await e.place(A, 'audio', { ...QUOTE, signal_msat: 1_500, signal_max_routing_fee_msat: 5_000 });
    await e.hangup();
    expect(hangups[0]).toEqual([400, 6_500]);
    expect(hangups.slice(1).every(([kind, maxHangup]) => kind !== 400 && maxHangup === undefined)).toBe(true);
  });

  it('a waiting Accept pressed while the engine is starting another call says why nothing happened', async () => {
    let allow: (yes: boolean) => void = () => {};
    let gate = false;
    const waitingViews: CallView[][] = [];
    const { e, sent } = engine({
      authorize: () => (gate ? new Promise<boolean>((resolve) => { allow = resolve; }) : Promise.resolve(true)),
      onWaiting: (calls) => waitingViews.push(calls),
    });
    await e.place(A, 'audio', QUOTE);
    await e.receive(msg(400, { call_id: 'f'.repeat(32), media: 'audio', sdp: 'second' }), OWN);
    await e.hangup();
    await vi.waitFor(() => expect(e.view().close?.status ?? 'closed').toBe('closed'));
    gate = true;
    const placing = e.place(A, 'audio', QUOTE);
    const before = sent.length;
    await e.acceptWaiting(`${A}:${'f'.repeat(32)}`, QUOTE);
    expect(sent.length).toBe(before);
    expect(waitingViews[waitingViews.length - 1][0]).toMatchObject({ phase: 'incoming', error: expect.stringMatching(/another call is waiting|finish/i) });
    gate = false;
    allow(false);
    await placing;
    await e.acceptWaiting(`${A}:${'f'.repeat(32)}`, QUOTE);
    expect(sent.slice(before).map((s) => s.kind)).toEqual([401]);
  });
});

describe('call refusal recovery', () => {
  it('ends a stalled host request without retrying or reviving on a late receipt', async () => {
    vi.useFakeTimers();
    try {
      let finish!: (outcome: { ok: true; value: CallReceipt }) => void;
      const signal = vi.fn(() => new Promise<{ ok: true; value: CallReceipt }>((resolve) => { finish = resolve; }));
      const { e } = engine({ signal });
      const placing = e.place(A, 'audio', QUOTE);
      await vi.advanceTimersByTimeAsync(30_001);
      expect(e.view()).toMatchObject({ phase: 'ended', error: expect.stringMatching(/outcome.*unknown/i) });
      await placing;
      expect(FakePc.made[FakePc.made.length - 1].closed).toBe(true);
      finish({ ok: true, value: { message_id: 'late', kind: 400, amount_msat: 10000, total_msat: 15000, max_routing_fee_msat: 5000, delivered: true, accepted: true, sent_at_ms: 0 } });
      await vi.advanceTimersByTimeAsync(1);
      expect(e.view().phase).toBe('ended');
      expect(signal).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('does not let a cancelled operation rejection end a newer incoming call', async () => {
    let reject!: (error: Error) => void;
    const { e } = engine({ signal: () => new Promise((_, no) => { reject = no; }) });
    const placing = e.place(A, 'audio', QUOTE);
    await vi.waitFor(() => expect(reject).toBeDefined());
    await e.hangup();
    await e.receive(msg(400, { call_id: 'f'.repeat(32), media: 'audio', sdp: 'offer' }), OWN);
    reject(new Error('old refusal'));
    await placing;
    expect(e.view()).toMatchObject({ phase: 'incoming', callId: 'f'.repeat(32), error: null });
    e.endLocal();
  });

  it.each(['token lacks required scope: spend', { code: 'spend_refused', message: 'Owner grant required' }])('ends and releases media when signalling rejects: %s', async (error) => {
    const local = stream();
    const { e } = engine({ authorize: async () => true, getUserMedia: async () => local, signal: async () => { throw error; } });
    await e.place(A, 'audio', QUOTE);
    expect(e.view()).toMatchObject({ phase: 'ended', error: typeof error === 'string' ? error : error.message });
    expect(local.getTracks().every((t) => vi.mocked(t.stop).mock.calls.length === 1)).toBe(true);
    expect(FakePc.made[FakePc.made.length - 1]?.closed).toBe(true);
  });
});

describe('call unknown outcomes', () => {
  beforeEach(() => { FakePc.made = []; vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  it('a hangup that times out after the call ended stays counted as unknown, not paid', async () => {
    let pending = false;
    const { e, last } = engine({ signal: (_peer, kind) => {
      if (kind === 403) { pending = true; return new Promise(() => {}); }
      return Promise.resolve({ ok: true as const, value: { message_id: 'm', kind, amount_msat: 10_000, total_msat: 15_000, max_routing_fee_msat: 5_000, delivered: true, accepted: true, sent_at_ms: 0 } });
    } });
    await e.place(A, 'audio', QUOTE);
    await e.receive(msg(401, { sdp: 'v=0 answer' }), OWN);
    FakePc.made[0].connect();
    const hanging = e.hangup();
    await vi.advanceTimersByTimeAsync(0);
    expect(pending).toBe(true);
    expect(last()).toMatchObject({ phase: 'ended', paidMsat: 15_000, unknownCount: 0, pendingCount: 1, pendingMsat: 6_000 });
    await vi.advanceTimersByTimeAsync(30_001);
    await hanging;
    expect(last()).toMatchObject({ phase: 'ended', paidMsat: 15_000, unknownCount: 1, unknownMsat: 6_000, pendingCount: 0, pendingMsat: 0 });
  });

  it('a hangup whose signal rejects after dispatch is counted as unknown, and the rejection still reaches the caller', async () => {
    const { e, last } = engine({ signal: async (_peer, kind) => {
      if (kind === 403) throw new Error('connection lost');
      return { ok: true, value: { message_id: 'm', kind, amount_msat: 10_000, total_msat: 15_000, max_routing_fee_msat: 5_000, delivered: true, accepted: true, sent_at_ms: 0 } };
    } });
    await e.place(A, 'audio', QUOTE);
    await e.receive(msg(401, { sdp: 'v=0 answer' }), OWN);
    FakePc.made[0].connect();
    await e.hangup();
    // hangup's own catch still sees the rejection (unchanged) and shows it.
    expect(last()).toMatchObject({ phase: 'ended', paidMsat: 15_000, unknownCount: 1, unknownMsat: 6_000, error: 'connection lost' });
  });

  it.each([
    ['a rejection proven unpaid', async () => { throw { code: 'spend_refused', message: 'refused' }; }, 0],
    ['a failure proven unpaid', async () => ({ ok: false as const, error: { code: 'budget_exhausted' as const, message: 'used up' } }), 0],
    ['a failure not proven unpaid', async () => ({ ok: false as const, error: { code: 'node' as const, message: 'connection lost' } }), 1],
  ])('with the shell classification, %s on the offer counts %i unknown', async (_name, signal, unknown) => {
    const { e, last } = engine({ signal, provenUnpaid: (code) => code === 'spend_refused' || code === 'budget_exhausted' });
    await e.place(A, 'audio', QUOTE);
    expect(last()).toMatchObject({ phase: 'ended', paidMsat: 0, unknownCount: unknown, unknownMsat: unknown ? 15_000 : 0 });
  });

  type Outcome = Awaited<ReturnType<CallDeps['signal']>>;
  const receipt = (kind: number, total: number): Outcome => ({ ok: true, value: { message_id: `m${kind}`, kind, amount_msat: total - 5_000, total_msat: total, max_routing_fee_msat: 5_000, delivered: true, accepted: true, sent_at_ms: 0 } });

  it('cancelling while the offer is in flight ends at once with it pending, then counts its receipt', async () => {
    let land!: (r: Outcome) => void;
    const { e, last } = engine({ signal: () => new Promise((resolve) => { land = resolve; }) });
    const placing = e.place(A, 'audio', QUOTE);
    await vi.waitFor(() => expect(land).toBeDefined());
    expect(last()).toMatchObject({ phase: 'calling', pendingCount: 1, pendingMsat: 15_000 });
    await e.hangup();
    expect(last()).toMatchObject({ phase: 'ended', paidMsat: 0, unknownCount: 0, pendingCount: 1, pendingMsat: 15_000 });
    land(receipt(400, 15_000));
    await placing;
    expect(last()).toMatchObject({ phase: 'ended', paidMsat: 15_000, unknownCount: 0, pendingCount: 0, pendingMsat: 0 });
  });

  it('hanging up while the answer is in flight keeps it pending until its receipt lands', async () => {
    let land!: (r: Outcome) => void;
    const { e, sent, last } = engine({ signal: async (peer, kind, plaintext, max) => {
      sent.push({ peer, kind, body: JSON.parse(plaintext), max });
      if (kind === 401) return new Promise((resolve) => { land = resolve; });
      return receipt(kind, 6_000);
    } });
    await e.receive(msg(400, { media: 'audio', sdp: 'offer' }), OWN);
    const accepting = e.accept(QUOTE);
    await vi.waitFor(() => expect(land).toBeDefined());
    await e.hangup();
    // The paid hangup settled; the answer is still in flight.
    expect(last()).toMatchObject({ phase: 'ended', paidMsat: 6_000, pendingCount: 1, pendingMsat: 6_000 });
    land(receipt(401, 6_000));
    await accepting;
    expect(last()).toMatchObject({ phase: 'ended', paidMsat: 12_000, pendingCount: 0, pendingMsat: 0 });
  });

  it('declining with its hangup in flight is pending, and a proven-unpaid refusal then leaves nothing paid', async () => {
    let land!: (r: Outcome) => void;
    const { e, last } = engine({
      signal: () => new Promise((resolve) => { land = resolve; }),
      provenUnpaid: (code) => code === 'spend_refused',
    });
    await e.receive(msg(400, { media: 'audio', sdp: 'offer' }), OWN);
    const declining = e.decline(QUOTE);
    await vi.waitFor(() => expect(land).toBeDefined());
    expect(last()).toMatchObject({ phase: 'ended', reason: 'declined', pendingCount: 1, pendingMsat: 6_000 });
    land({ ok: false, error: { code: 'spend_refused', message: 'refused' } });
    await declining;
    expect(last()).toMatchObject({ phase: 'ended', paidMsat: 0, unknownCount: 0, pendingCount: 0, pendingMsat: 0 });
  });

  const zeroEnded = (v: CallView) => v.phase === 'ended' && v.pendingCount === 0 && v.unknownCount === 0 && v.paidMsat === 0;

  it('declining: a quote that never resolves never ends the call; once quoted, the hangup is pending in the first ended view', async () => {
    const stuck = engine({ quote: () => new Promise(() => {}) });
    await stuck.e.receive(msg(400, { media: 'audio', sdp: 'offer' }), OWN);
    void stuck.e.decline(QUOTE);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stuck.views.some((v) => v.phase === 'ended')).toBe(false);

    const { e, views, sent } = engine({ signal: () => new Promise(() => {}) });
    await e.receive(msg(400, { media: 'audio', sdp: 'offer' }), OWN);
    void e.decline(QUOTE);
    await vi.advanceTimersByTimeAsync(0);
    const ended = views.filter((v) => v.phase === 'ended');
    expect(ended.length).toBeGreaterThan(0);
    expect(ended.some(zeroEnded)).toBe(false);
    expect(ended[0]).toMatchObject({ reason: 'declined', pendingCount: 1, pendingMsat: 6_000 });
    expect(sent).toHaveLength(0);
  });

  it('hanging up: every owed hangup is pending in the first ended view, before it is sent', async () => {
    const { e, views } = engine({ signal: async (_peer, kind) => kind === 403 ? new Promise(() => {}) : ({ ok: true, value: { message_id: 'm', kind, amount_msat: 10_000, total_msat: 15_000, max_routing_fee_msat: 5_000, delivered: true, accepted: true, sent_at_ms: 0 } }) });
    await e.place(A, 'audio', QUOTE);
    await e.receive(msg(401, { sdp: 'v=0 answer' }), OWN);
    FakePc.made[0].connect();
    void e.hangup();
    expect(views.find((v) => v.phase === 'ended')).toMatchObject({ paidMsat: 15_000, pendingCount: 1, pendingMsat: 6_000 });
  });

  it('closing the ended card waits until nothing is settling', async () => {
    let land!: (r: Awaited<ReturnType<CallDeps['signal']>>) => void;
    const { e, last } = engine({ signal: () => new Promise((resolve) => { land = resolve; }) });
    await e.receive(msg(400, { media: 'audio', sdp: 'offer' }), OWN);
    const declining = e.decline(QUOTE);
    await vi.waitFor(() => expect(land).toBeDefined());
    e.dismiss();
    expect(last()).toMatchObject({ phase: 'ended', pendingCount: 1 });
    land({ ok: true, value: { message_id: 'm', kind: 403, amount_msat: 1_000, total_msat: 6_000, max_routing_fee_msat: 5_000, delivered: true, accepted: true, sent_at_ms: 0 } });
    await declining;
    expect(last()).toMatchObject({ phase: 'ended', paidMsat: 6_000, pendingCount: 0 });
    e.dismiss();
    expect(last().phase).toBe('idle');
  });

  it('an unknown recovery admission is counted as unknown with its cap', async () => {
    let n = 0;
    const restartId = 'e'.repeat(32);
    const { e, sent, last } = engine({
      newCallId: () => n++ === 0 ? ID : restartId,
      signal: async (peer, kind, plaintext, max) => {
        const body = JSON.parse(plaintext);
        sent.push({ peer, kind, body, max });
        if (body.call_id === restartId) return { ok: false, error: { code: 'payment_unknown', message: 'The node has not resolved the payment.' } };
        return { ok: true, value: { message_id: 'm', kind, amount_msat: 10_000, total_msat: 15_000, max_routing_fee_msat: 5_000, delivered: true, accepted: true, sent_at_ms: 0 } };
      },
    });
    await e.place(A, 'audio', QUOTE);
    await e.receive(msg(401, { sdp: 'v=0 answer' }), OWN);
    const pc = FakePc.made[0];
    pc.connect();
    pc.state('failed'); pc.state('failed');
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.some((s) => s.kind === 400 && s.body.call_id === restartId)).toBe(true);
    expect(last()).toMatchObject({ paidMsat: 15_000, unknownCount: 1, unknownMsat: 15_000 });
    e.endLocal();
    expect(last()).toMatchObject({ phase: 'ended', paidMsat: 15_000, unknownCount: 1, unknownMsat: 15_000 });
  });
});

describe('call restart negotiation', () => {
  beforeEach(() => { FakePc.made = []; vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  it('restarts over a fresh paid admission, answers automatically, and retains media and duration', async () => {
    const restartId = 'e'.repeat(32);
    let n = 0;
    const caller = engine({ newCallId: () => n++ === 0 ? ID : restartId });
    const callee = engine();
    const deliver = async (target: ReturnType<typeof engine>, signal: Sent, sender: string, own: string) =>
      target.e.receive(msg(signal.kind, signal.body, sender), own);
    await caller.e.place(A, 'video', QUOTE);
    await deliver(callee, caller.sent[0], OWN, A);
    await callee.e.accept(QUOTE);
    await deliver(caller, callee.sent[0], A, OWN);
    const [a, b] = FakePc.made;
    a.connect(); b.connect();
    a.state('failed');
    a.state('failed');
    b.iceConnectionState = 'failed'; b.oniceconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(caller.e.view()).toMatchObject({ state: 'reconnecting', liveAt: 1000, callId: ID });
    expect(a.restartIce).toHaveBeenCalledOnce();
    expect(a.offers[1]).toEqual({ iceRestart: true });
    const restart = caller.sent.find(s => s.kind === 400 && s.body.call_id === restartId)!;
    expect(restart).toBeDefined();
    expect(restart.max).toBe(15000);
    expect(restart.body.sdp).toContain(`a=x-bitsov-restart-of:${ID}`);
    await deliver(callee, restart, OWN, A);
    const answer = callee.sent.find(s => s.kind === 401 && s.body.call_id === restartId)!;
    expect(answer).toBeDefined();
    await deliver(caller, answer, A, OWN);
    a.connect(); b.connect();
    await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_MS);
    expect(caller.e.view()).toMatchObject({ state: 'live', liveAt: 1000, callId: ID });
    expect(callee.e.view()).toMatchObject({ state: 'live', liveAt: 1000, callId: ID });
    // Both sides spent their one recovery (the caller's offer, the callee's answer); the drop is over.
    expect(caller.e.view()).toMatchObject({ recoveryUsed: true, dropAt: null });
    expect(callee.e.view()).toMatchObject({ recoveryUsed: true, dropAt: null });
    expect(FakePc.made).toHaveLength(2);
    expect(a.tracks.concat(b.tracks).every(t => vi.mocked(t.stop).mock.calls.length === 0)).toBe(true);
    // A replay cannot charge for a second answer or re-enter negotiation.
    const paidAnswers = callee.sent.filter(s => s.kind === 401).length;
    await deliver(callee, restart, OWN, A);
    expect(callee.sent.filter(s => s.kind === 401)).toHaveLength(paidAnswers);
    await caller.e.hangup();
    for (const signal of caller.sent.filter(s => s.kind === 403)) await deliver(callee, signal, OWN, A);
    expect(callee.e.view().state).toBe('ended');
  });

  it('says how long a drop has left and whether its one recovery was already spent; the grace itself is unchanged', async () => {
    let n = 0;
    const caller = engine({ newCallId: () => n++ === 0 ? ID : 'e'.repeat(32) });
    await caller.e.place(A, 'audio', QUOTE);
    await caller.e.receive(msg(401, { sdp: 'v=0 answer' }), OWN);
    const pc = FakePc.made[0];
    pc.connect();
    pc.state('disconnected');
    expect(caller.e.view()).toMatchObject({ phase: 'reconnecting', dropAt: 1000 + RECONNECT_GRACE_MS, recoveryUsed: false, recoveryUsedBefore: false });
    // The one recovery goes after the restart delay.
    await vi.advanceTimersByTimeAsync(2000);
    expect(caller.e.view().recoveryUsed).toBe(true);
    const offers = caller.sent.filter(s => s.kind === 400).length;
    expect(offers).toBe(2);
    pc.connect();
    expect(caller.e.view()).toMatchObject({ phase: 'live', dropAt: null });
    // A second drop: no recovery is tried, and the view says so.
    pc.state('disconnected');
    expect(caller.e.view()).toMatchObject({ phase: 'reconnecting', dropAt: 1000 + RECONNECT_GRACE_MS, recoveryUsedBefore: true });
    await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_MS - 1);
    expect(caller.e.view().phase).toBe('reconnecting');
    expect(caller.sent.filter(s => s.kind === 400)).toHaveLength(offers);
    await vi.advanceTimersByTimeAsync(1);
    expect(caller.e.view()).toMatchObject({ phase: 'ended', reason: 'failed', dropAt: null });
  });

  it('a callee that only answers the caller\'s recovery has spent the call\'s one recovery too', async () => {
    const restartId = 'e'.repeat(32);
    let n = 0;
    const caller = engine({ newCallId: () => n++ === 0 ? ID : restartId });
    const callee = engine();
    const deliver = async (target: ReturnType<typeof engine>, signal: Sent, sender: string, own: string) =>
      target.e.receive(msg(signal.kind, signal.body, sender), own);
    await caller.e.place(A, 'audio', QUOTE);
    await deliver(callee, caller.sent[0], OWN, A);
    await callee.e.accept(QUOTE);
    await deliver(caller, callee.sent[0], A, OWN);
    const [a, b] = FakePc.made;
    a.connect(); b.connect();
    // Only the caller's side fails; the callee never asks for a recovery itself.
    a.state('failed');
    await vi.advanceTimersByTimeAsync(0);
    expect(callee.e.view().recoveryUsed).toBe(false);
    const restart = caller.sent.find(s => s.kind === 400 && s.body.call_id === restartId)!;
    await deliver(callee, restart, OWN, A);
    expect(callee.sent.some(s => s.kind === 401 && s.body.call_id === restartId)).toBe(true);
    expect(callee.e.view().recoveryUsed).toBe(true);
    caller.e.endLocal(); callee.e.endLocal();
  });

  it('a camera error before a drop is not a recovery error: recoveryError stays empty', async () => {
    const local = stream(true);
    const fresh = stream(true, false);
    let n = 0;
    const caller = engine({ newCallId: () => n++ === 0 ? ID : 'e'.repeat(32), getUserMedia: async c => c.audio ? local : fresh });
    await caller.e.place(A, 'video', QUOTE);
    await caller.e.receive(msg(401, { sdp: 'v=0 answer' }), OWN);
    const pc = FakePc.made[0];
    pc.connect();
    await caller.e.toggleCamera();
    pc.senders[1].replaceTrack = async () => { throw new Error('sender failed'); };
    await caller.e.toggleCamera();
    expect(caller.e.view().error).toEqual(expect.any(String));
    pc.state('disconnected');
    expect(caller.e.view()).toMatchObject({ phase: 'reconnecting', recoveryUsed: false, recoveryError: null });
    caller.e.endLocal();
  });

  it('a refused recovery\'s words stay while live after a heal, and are gone when a later drop starts', async () => {
    let allow = true;
    let n = 0;
    const caller = engine({ newCallId: () => n++ === 0 ? ID : 'e'.repeat(32), authorize: async () => allow });
    await caller.e.place(A, 'audio', QUOTE);
    await caller.e.receive(msg(401, { sdp: 'v=0 answer' }), OWN);
    const pc = FakePc.made[0];
    pc.connect();
    allow = false;
    pc.state('failed');
    await vi.advanceTimersByTimeAsync(0);
    expect(caller.e.view()).toMatchObject({ phase: 'reconnecting', error: 'Call recovery needs spending approval.', recoveryError: 'Call recovery needs spending approval.' });
    // Healed on its own: still said while live (the recovery could not happen), no longer framed.
    pc.connect();
    expect(caller.e.view()).toMatchObject({ phase: 'live', error: 'Call recovery needs spending approval.', recoveryError: null });
    // A second drop: no stale refusal text.
    pc.state('disconnected');
    expect(caller.e.view()).toMatchObject({ phase: 'reconnecting', error: null, recoveryError: null });
    caller.e.endLocal();
  });

  it('a new drop clears only a refused recovery\'s words: a camera error stays', async () => {
    const local = stream(true);
    const fresh = stream(true, false);
    let n = 0;
    const caller = engine({ newCallId: () => n++ === 0 ? ID : 'e'.repeat(32), getUserMedia: async c => c.audio ? local : fresh });
    await caller.e.place(A, 'video', QUOTE);
    await caller.e.receive(msg(401, { sdp: 'v=0 answer' }), OWN);
    const pc = FakePc.made[0];
    pc.connect();
    await caller.e.toggleCamera();
    pc.senders[1].replaceTrack = async () => { throw new Error('sender failed'); };
    await caller.e.toggleCamera();
    const cameraError = caller.e.view().error;
    expect(cameraError).toEqual(expect.any(String));
    pc.state('disconnected');
    pc.connect();
    pc.state('disconnected');
    expect(caller.e.view()).toMatchObject({ phase: 'reconnecting', error: cameraError });
    caller.e.endLocal();
  });

  it('a callee-only failure requests one restart and caller ignores duplicate requests', async () => {
    const incoming = engine();
    await incoming.e.receive(msg(400, { media: 'audio', sdp: 'offer' }), OWN);
    await incoming.e.accept(QUOTE);
    const pc = FakePc.made[0]; pc.connect(); pc.state('failed'); pc.state('failed');
    await vi.advanceTimersByTimeAsync(0);
    expect(incoming.sent.filter(s => s.kind === 402)).toHaveLength(1);
    expect(incoming.sent[1].body).toMatchObject({ candidate: '', sdp_mid: 'bitsov-restart-v1' });
    incoming.e.endLocal();

    let n = 0;
    const caller = engine({ newCallId: () => n++ === 0 ? ID : 'e'.repeat(32) });
    await caller.e.place(A, 'audio', QUOTE);
    await caller.e.receive(msg(401, { sdp: 'answer' }), OWN);
    FakePc.made[1].connect();
    const request = msg(402, { candidate: '', sdp_mid: 'bitsov-restart-v1' });
    await Promise.all([caller.e.receive(request, OWN), caller.e.receive(request, OWN)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(caller.sent.filter(s => s.kind === 400)).toHaveLength(2);
    caller.e.endLocal();
  });

  it('accepts a restart offer while the original answer receipt is still pending', async () => {
    let finish!: (r: Awaited<ReturnType<CallDeps['signal']>>) => void;
    let answers = 0;
    const { e } = engine({ signal: async (_peer, kind) => {
      if (kind === 401 && ++answers === 1) return new Promise(resolve => { finish = resolve; });
      return { ok: true, value: { total_msat: 6000 } as CallReceipt };
    } });
    await e.receive(msg(400, { media: 'audio', sdp: 'offer' }), OWN);
    const accepting = e.accept(QUOTE);
    await vi.advanceTimersByTimeAsync(0);
    FakePc.made[0].connect();
    await e.receive(msg(400, { call_id: 'e'.repeat(32), media: 'audio', sdp: `restart\r\na=x-bitsov-restart-of:${ID}\r\n` }), OWN);
    expect(answers).toBe(2);
    finish({ ok: true, value: { total_msat: 6000 } as CallReceipt });
    await accepting;
    expect(e.view().state).toBe('reconnecting');
    e.endLocal();
  });

  it('the incoming card\'s words hold: a callee\'s reconnect try is paid even when the line never comes back, each payment at most one signal', async () => {
    const { e, sent } = engine();
    await e.receive(msg(400, { media: 'audio', sdp: 'offer' }), OWN);
    await e.accept(QUOTE);
    const pc = FakePc.made[0]; pc.connect(); pc.state('failed');
    await vi.advanceTimersByTimeAsync(0);
    expect(e.view().state).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_MS);
    expect(e.view().state).toBe('ended');
    // Answer, then the paid reconnect request; the line never came back.
    expect(sent.map(s => s.kind)).toEqual([401, 402]);
    expect(sent[1].body).toMatchObject({ sdp_mid: 'bitsov-restart-v1' });
    for (const s of sent) expect(s.max).toBeLessThanOrEqual(signalCost(QUOTE));
  });

  it('retains a callee restart request while the initial answer is still being applied', async () => {
    const { e, sent } = engine();
    await e.place(A, 'audio', QUOTE);
    const pc = FakePc.made[0];
    let applied!: () => void;
    pc.setRemoteDescription = async () => new Promise<void>(resolve => { applied = resolve; });
    const answering = e.receive(msg(401, { sdp: 'answer' }), OWN);
    await e.receive(msg(402, { candidate: '', sdp_mid: 'bitsov-restart-v1' }), OWN);
    expect(e.view().state).toBe('reconnecting');
    expect(sent.filter(s => s.kind === 400)).toHaveLength(1);
    applied();
    await answering;
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.filter(s => s.kind === 400)).toHaveLength(2);
    e.endLocal();
  });

  it('does not retry a refused recovery payment and retains media for the grace window', async () => {
    let offers = 0;
    const { e } = engine({ signal: async (_peer, kind) => {
      if (kind === 400 && ++offers === 2) return { ok: false, error: { code: 'spend_unknown', message: 'Payment outcome unknown.' } };
      return { ok: true, value: { total_msat: 1 } as CallReceipt };
    } });
    await e.place(A, 'audio', QUOTE);
    await e.receive(msg(401, { sdp: 'answer' }), OWN);
    const pc = FakePc.made[0]; pc.connect(); pc.state('failed');
    await vi.advanceTimersByTimeAsync(0);
    expect(e.view()).toMatchObject({ state: 'reconnecting', error: 'Payment outcome unknown.' });
    expect(pc.tracks[0].stop).not.toHaveBeenCalled();
    pc.state('failed');
    await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_MS);
    expect(e.view()).toMatchObject({ state: 'ended', error: 'Payment outcome unknown.' });
    expect(offers).toBe(2);
    expect(pc.tracks[0].stop).toHaveBeenCalledOnce();
  });

  it.each(['authorization', 'remaining grant', 'owner per-payment limit'] as const)('keeps a connected caller live when recovery is refused by %s', async (refusal) => {
    let recovering = false;
    const { e, sent, views } = engine({
      authorize: async () => !recovering || refusal !== 'authorization',
      grant: () => recovering ? {
        expires_at_ms: 3_600_000, budget_msat: 21_000,
        remaining_msat: refusal === 'remaining grant' ? 0 : 21_000,
        per_call_max_msat: refusal === 'owner per-payment limit' ? 1_000 : 21_000,
      } : null,
    });
    await e.place(A, 'audio', QUOTE);
    await e.receive(msg(401, { sdp: 'answer' }), OWN);
    const pc = FakePc.made[0]; pc.connect();
    recovering = true;
    await e.receive(msg(402, { candidate: '', sdp_mid: 'bitsov-restart-v1' }), OWN);
    expect(views.some(v => v.phase === 'reconnecting')).toBe(true);
    expect(e.view()).toMatchObject({ phase: 'live', liveAt: 1000, error: expect.stringMatching(/approval|grant/) });
    expect(pc.restartIce).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_MS + 1);
    expect(e.view().phase).toBe('live');
    expect(pc.closed).toBe(false);
    expect(pc.tracks[0].stop).not.toHaveBeenCalled();
    await e.hangup();
    expect(sent.filter(s => s.kind === 403).map(s => s.body.call_id)).toEqual([ID]);
  });

  it('keeps a connected callee live when authorization refuses a restart offer', async () => {
    let allowed = true;
    const { e } = engine({ authorize: async () => allowed });
    await e.receive(msg(400, { media: 'audio', sdp: 'offer' }), OWN);
    await e.accept(QUOTE);
    const pc = FakePc.made[0]; pc.connect();
    allowed = false;
    await e.receive(msg(400, { call_id: 'e'.repeat(32), media: 'audio', sdp: `restart\r\na=x-bitsov-restart-of:${ID}\r\n` }), OWN);
    expect(e.view()).toMatchObject({ phase: 'live', liveAt: 1000, error: 'Call recovery needs spending approval.' });
    await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_MS + 1);
    expect(e.view().phase).toBe('live');
    expect(pc.closed).toBe(false);
    e.endLocal();
  });

  it.each([true, false])('rechecks connectivity at grace expiry after refusal (healed: %s)', async (healed) => {
    let allowed = true;
    const { e } = engine({ authorize: async () => allowed });
    await e.place(A, 'audio', QUOTE);
    await e.receive(msg(401, { sdp: 'answer' }), OWN);
    const pc = FakePc.made[0]; pc.connect();
    allowed = false;
    pc.state('failed');
    await vi.advanceTimersByTimeAsync(0);
    expect(e.view().phase).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_MS - 1);
    // The transport heals without dispatching another state-change event.
    if (healed) pc.connectionState = 'connected';
    await vi.advanceTimersByTimeAsync(1);
    expect(e.view()).toMatchObject({ phase: healed ? 'live' : 'ended', liveAt: 1000 });
    expect(pc.closed).toBe(!healed);
    expect(pc.tracks[0].stop).toHaveBeenCalledTimes(healed ? 0 : 1);
    e.endLocal();
  });

  it.each(['refused', 'rejected'] as const)('does not hang up an unpaid recovery admission when payment is %s', async (outcome) => {
    const sent: { kind: number; body: Record<string, unknown> }[] = [];
    const { e } = engine({ signal: async (_peer, kind, plaintext) => {
      const body = JSON.parse(plaintext);
      sent.push({ kind, body });
      if (kind === 400 && body.call_id !== ID) {
        if (outcome === 'rejected') throw new Error('Recovery refused.');
        return { ok: false, error: { code: 'spend_refused', message: 'Recovery refused.' } };
      }
      return { ok: true, value: { total_msat: 1 } as CallReceipt };
    } });
    await e.place(A, 'audio', QUOTE);
    await e.receive(msg(401, { sdp: 'answer' }), OWN);
    const pc = FakePc.made[0]; pc.connect();
    await e.receive(msg(402, { candidate: '', sdp_mid: 'bitsov-restart-v1' }), OWN);
    expect(sent.filter(s => s.kind === 400).map(s => s.body.call_id)).toEqual([ID, 'e'.repeat(32)]);
    expect(e.view()).toMatchObject({ phase: 'live', liveAt: 1000, error: expect.stringContaining('Recovery refused.') });
    await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_MS + 1);
    expect(e.view().phase).toBe('live');
    expect(pc.closed).toBe(false);
    expect(pc.tracks[0].stop).not.toHaveBeenCalled();
    await e.hangup();
    expect(sent.filter(s => s.kind === 403).map(s => s.body.call_id)).toEqual([ID]);
  });

  it.each([true, false])('handles an early recovery answer and only hangs up paid admissions (paid: %s)', async (paid) => {
    let finish!: (r: Awaited<ReturnType<CallDeps['signal']>>) => void;
    const hangups: string[] = [];
    const { e } = engine({ signal: async (_peer, kind, plaintext) => {
      const body = JSON.parse(plaintext);
      if (kind === 400 && body.call_id !== ID) return new Promise(resolve => { finish = resolve; });
      if (kind === 403) hangups.push(body.call_id);
      return { ok: true, value: { total_msat: 1 } as CallReceipt };
    } });
    await e.place(A, 'audio', QUOTE);
    await e.receive(msg(401, { sdp: 'answer' }), OWN);
    const pc = FakePc.made[0]; pc.connect(); pc.state('failed');
    await vi.advanceTimersByTimeAsync(0);
    await e.receive(msg(401, { call_id: 'e'.repeat(32), sdp: 'restart answer' }), OWN);
    expect(pc.remote).toEqual({ type: 'answer', sdp: 'restart answer' });
    if (paid) {
      finish({ ok: true, value: { total_msat: 15000 } as CallReceipt });
      await vi.advanceTimersByTimeAsync(0);
    }
    await e.hangup();
    expect(hangups).toEqual(paid ? ['e'.repeat(32), ID] : [ID]);
    if (!paid) {
      finish({ ok: true, value: { total_msat: 15000 } as CallReceipt });
      await vi.advanceTimersByTimeAsync(0);
      expect(e.view().phase).toBe('ended');
      expect(hangups).toEqual([ID]);
    }
  });

  it('does not treat stale aggregate connectivity as healed while ICE is failed', async () => {
    let allowed = true;
    const { e } = engine({ authorize: async () => allowed });
    await e.place(A, 'audio', QUOTE);
    await e.receive(msg(401, { sdp: 'answer' }), OWN);
    const pc = FakePc.made[0]; pc.connect();
    allowed = false;
    pc.iceConnectionState = 'failed'; pc.oniceconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(e.view().phase).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_MS);
    expect(e.view().phase).toBe('ended');
    expect(pc.closed).toBe(true);
  });

  it('waits for the exact host-bound recovery receipt before ending on a peer hangup', async () => {
    let finish!: (r: Awaited<ReturnType<CallDeps['signal']>>) => void;
    const { e } = engine({ signal: async (_peer, kind, plaintext) => {
      if (kind === 400 && JSON.parse(plaintext).call_id !== ID) return new Promise(resolve => { finish = resolve; });
      return { ok: true, value: { total_msat: 1 } as CallReceipt };
    } });
    await e.place(A, 'audio', QUOTE);
    await e.receive(msg(401, { sdp: 'answer' }), OWN);
    const pc = FakePc.made[0]; pc.connect(); pc.state('failed');
    await vi.advanceTimersByTimeAsync(0);
    await e.receive({ ...msg(403, { call_id: 'e'.repeat(32), reason: 'hangup' }), admission_operation_id: 'recovery-op' }, OWN);
    expect(e.view().phase).toBe('reconnecting');
    finish({ ok: true, value: { operation_id: 'recovery-op', total_msat: 15000 } as CallReceipt });
    await vi.advanceTimersByTimeAsync(0);
    expect(e.view()).toMatchObject({ phase: 'ended', reason: 'hangup' });
    expect(pc.closed).toBe(true);
    expect(pc.tracks[0].stop).toHaveBeenCalledOnce();
    expect(e.view().phase).toBe('ended');
  });

  it('bounds a failed restart without replaying an unknown paid operation or reviving late', async () => {
    let n = 0;
    const { e, sent } = engine({ newCallId: () => n++ === 0 ? ID : 'e'.repeat(32) });
    await e.place(A, 'audio', QUOTE);
    await e.receive(msg(401, { sdp: 'answer' }), OWN);
    const pc = FakePc.made[0]; pc.connect(); pc.state('failed');
    await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_MS);
    expect(e.view()).toMatchObject({ state: 'ended', reason: 'failed' });
    expect(pc.closed).toBe(true);
    expect(sent.filter(s => s.kind === 400)).toHaveLength(2);
    await e.receive(msg(401, { call_id: 'e'.repeat(32), sdp: 'late' }), OWN);
    pc.connect();
    expect(e.view().state).toBe('ended');
  });
});

describe('call lifecycle hardening', () => {
  beforeEach(() => { FakePc.made = []; vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  it.each(['outgoing', 'incoming'] as const)('explains denied or absent devices for %s capture without signalling', async (direction) => {
    for (const [name, message] of [['NotAllowedError', /permission.*denied/i], ['NotFoundError', /no.*microphone.*camera/i], ['NotReadableError', /in use|busy/i]]) {
      const { e, sent } = engine({ getUserMedia: async () => { throw new DOMException('capture failed', String(name)); } });
      if (direction === 'incoming') await e.receive(msg(400, { media: 'video', sdp: 'offer' }), OWN);
      await (direction === 'incoming' ? e.accept(QUOTE) : e.place(A, 'video', QUOTE));
      expect(e.view()).toMatchObject({ phase: 'ended', state: 'ended', error: expect.stringMatching(message) });
      expect(sent).toEqual([]);
      e.dismiss();
      expect(e.view()).toMatchObject({ phase: 'idle', state: 'idle' });
    }
  });

  it('releases all media immediately even if hangup signalling never settles', async () => {
    const local = stream(true);
    const next = engine({ getUserMedia: async () => local, signal: async (_peer, kind) => {
      if (kind === 403) return new Promise(() => {});
      return { ok: true, value: { total_msat: 1 } as CallReceipt };
    } });
    await next.e.place(A, 'video', QUOTE);
    FakePc.made[0].connect();
    const ending = next.e.hangup();
    expect(next.e.view()).toMatchObject({ phase: 'ended', state: 'ended' });
    expect(local.getTracks().every(t => vi.mocked(t.stop).mock.calls.length === 1)).toBe(true);
    expect(FakePc.made[0].closed).toBe(true);
    await vi.advanceTimersByTimeAsync(30_001);
    await ending;
  });

  it('hangup cancels an incoming permission prompt and releases its late stream', async () => {
    let release!: (s: MediaStream) => void;
    const { e, sent } = engine({ getUserMedia: () => new Promise(resolve => { release = resolve; }) });
    await e.receive(msg(400, { media: 'video', sdp: 'offer' }), OWN);
    const accepting = e.accept(QUOTE);
    await vi.advanceTimersByTimeAsync(0);
    const ending = e.hangup();
    expect(e.view().phase).toBe('ended');
    const late = stream(true);
    release(late);
    await accepting;
    await ending;
    expect(late.getTracks().every(t => vi.mocked(t.stop).mock.calls.length === 1)).toBe(true);
    expect(sent.some(s => s.kind === 401)).toBe(false);
  });

  it('exposes reconnecting during a blip without extending the grace on repeated events', async () => {
    const { e } = engine();
    expect(e.view()).toHaveProperty('state', 'idle');
    await e.place(A, 'audio', QUOTE);
    expect(e.view()).toHaveProperty('state', 'ringing');
    await e.receive(msg(401, { sdp: 'answer' }), OWN);
    expect(e.view()).toHaveProperty('state', 'connecting');
    const pc = FakePc.made[0];
    pc.connect();
    pc.state('disconnected');
    expect(e.view()).toMatchObject({ phase: 'reconnecting', state: 'reconnecting', liveAt: 1000 });
    expect(pc.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_MS - 1);
    pc.state('disconnected');
    await vi.advanceTimersByTimeAsync(1);
    expect(e.view()).toMatchObject({ phase: 'ended', state: 'ended' });
  });

  it('does not regress a live call when the original offer receipt arrives after the answer', async () => {
    let finish!: (r: Awaited<ReturnType<CallDeps['signal']>>) => void;
    const { e } = engine({ signal: () => new Promise(resolve => { finish = resolve; }) });
    const placing = e.place(A, 'audio', QUOTE);
    await vi.advanceTimersByTimeAsync(0);
    await e.receive(msg(401, { sdp: 'answer' }), OWN);
    FakePc.made[0].connect();
    finish({ ok: true, value: { total_msat: 15000 } as CallReceipt });
    await placing;
    expect(e.view()).toMatchObject({ state: 'live', liveAt: 1000 });
    await vi.advanceTimersByTimeAsync(RING_MS);
    expect(e.view().state).toBe('live');
    e.endLocal();
  });

  it('a stale decline quote cannot pay against or end a new incoming call', async () => {
    let quoted!: (r: Awaited<ReturnType<CallDeps['quote']>>) => void;
    const { e, sent } = engine({ quote: () => new Promise(resolve => { quoted = resolve; }) });
    await e.receive(msg(400, { media: 'audio', sdp: 'offer' }), OWN);
    const declining = e.decline(QUOTE);
    e.endLocal();
    await e.receive(msg(400, { call_id: 'f'.repeat(32), media: 'audio', sdp: 'new' }, 'b'.repeat(64)), OWN);
    quoted({ ok: true, value: QUOTE });
    await declining;
    expect(sent).toEqual([]);
    expect(e.view()).toMatchObject({ state: 'ringing', peer: 'b'.repeat(64), callId: 'f'.repeat(32) });
    e.endLocal();
  });

  it('bounds a hung incoming quote and ignores its late success', async () => {
    let quoted!: (r: Awaited<ReturnType<CallDeps['quote']>>) => void;
    const { e, sent, media } = engine({ quote: () => new Promise(resolve => { quoted = resolve; }) });
    await e.receive(msg(400, { media: 'audio', sdp: 'offer' }), OWN);
    const accepting = e.accept(QUOTE);
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    expect(e.view().state).toBe('ended');
    quoted({ ok: true, value: QUOTE });
    await accepting;
    expect(sent).toEqual([]);
    expect(media).toEqual([]);
  });

  it('does not open a permission prompt if capture is cancelled before it starts', async () => {
    const { e, media } = engine();
    const placing = e.place(A, 'audio', QUOTE);
    await e.hangup();
    await placing;
    expect(media).toEqual([]);
  });

  it('camera enable failures stop the new track and keep the audio call usable', async () => {
    const local = stream(true);
    const fresh = stream(true, false);
    const { e } = engine({ getUserMedia: async c => c.audio ? local : fresh });
    await e.place(A, 'video', QUOTE);
    const pc = FakePc.made[0]; pc.connect();
    await e.toggleCamera();
    pc.senders[1].replaceTrack = async () => { throw new Error('sender failed'); };
    await e.toggleCamera();
    expect(fresh.getVideoTracks()[0].stop).toHaveBeenCalled();
    expect(e.view()).toMatchObject({ state: 'live', camera: false, error: expect.any(String) });
    expect(local.getAudioTracks()[0].stop).not.toHaveBeenCalled();
    e.endLocal();
  });

  it('serializes camera acquisition and does not revive its state after hangup', async () => {
    const local = stream(true);
    const fresh = stream(true, false);
    let release!: (s: MediaStream) => void;
    let captures = 0;
    const { e } = engine({ getUserMedia: async c => {
      captures++;
      return c.audio ? local : new Promise(resolve => { release = resolve; });
    } });
    await e.place(A, 'video', QUOTE);
    FakePc.made[0].connect();
    await e.toggleCamera();
    const enabling = e.toggleCamera();
    const duplicate = e.toggleCamera();
    await vi.advanceTimersByTimeAsync(0);
    expect(captures).toBe(2);
    await e.hangup();
    release(fresh);
    await Promise.all([enabling, duplicate]);
    await vi.advanceTimersByTimeAsync(0);
    expect(e.view()).toMatchObject({ state: 'ended', camera: false });
    expect(fresh.getVideoTracks()[0].stop).toHaveBeenCalled();
  });

  it('ignores late answer payment failures after hangup and a new incoming call', async () => {
    let finish!: (r: Awaited<ReturnType<CallDeps['signal']>>) => void;
    const { e } = engine({ signal: (_p, kind) => kind === 401 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true, value: { total_msat: 1 } as CallReceipt }) });
    await e.receive(msg(400, { media: 'audio', sdp: 'offer' }), OWN);
    const accepting = e.accept(QUOTE);
    await vi.advanceTimersByTimeAsync(0);
    await e.hangup();
    await e.receive(msg(400, { call_id: 'f'.repeat(32), media: 'audio', sdp: 'new' }), OWN);
    finish({ ok: false, error: { code: 'node', message: 'old failure' } });
    await accepting;
    expect(e.view()).toMatchObject({ phase: 'incoming', state: 'ringing', callId: 'f'.repeat(32), error: null, paidMsat: 0 });
    e.endLocal();
  });
});

describe('call permission snapshots', () => {
  it.each(['window', 'budget'] as const)('sample %s approval updates the scopes read by call preflight', async (kind) => {
    const source = sampleSource();
    expect((await source.pairingStatus()).scopes).not.toContain('spend');
    if (kind === 'window') await source.spendRequest();
    else await source.budgetApprove(500_000, 'careful');
    await source.spendStatus();
    await source.spendStatus();
    expect((await source.pairingStatus()).scopes).toContain('spend');
  });
});

describe('a network change during a call (display only)', () => {
  beforeEach(() => { FakePc.made = []; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  /** A fresh call id for every allocation (a duplicate-id refusal can never stand in for the restart guard). */
  const freshIds = () => { let n = 0; return () => (n++).toString(16).padStart(32, '0'); };
  const answer = (e: ReturnType<typeof engine>['e']) => e.receive(msg(401, { sdp: 'v=0 answer', call_id: e.view().callId! }), OWN);
  const offlineOnline = () => { window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online')); };
  const offers = (sent: Sent[]) => sent.filter((x) => x.kind === 400).length;

  it('offline only sets the display flag: the call phase is unchanged; online clears it', async () => {
    const { e, last } = engine({ newCallId: freshIds() });
    await e.place(A, 'audio', QUOTE);
    await answer(e);
    FakePc.made[0].connect();
    window.dispatchEvent(new Event('offline'));
    expect(last()).toMatchObject({ phase: 'live', offline: true });
    window.dispatchEvent(new Event('online'));
    expect(last()).toMatchObject({ phase: 'live', offline: false });
  });

  it('offline/online while their answer is still being applied: one 400, as on main', async () => {
    const { e, sent } = engine({ newCallId: freshIds() });
    await e.place(A, 'audio', QUOTE);
    let apply!: () => void;
    FakePc.made[0].setRemoteDescription = (d) => new Promise<void>((r) => { apply = () => { FakePc.made[0].remote = d; r(); }; });
    const answered = answer(e);
    offlineOnline();
    apply();
    await answered;
    FakePc.made[0].connect();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(offers(sent)).toBe(1);
  });

  it('live → ICE disconnected → offline → online → ICE back in 100 ms: one 400, as on main', async () => {
    const { e, sent } = engine({ newCallId: freshIds() });
    await e.place(A, 'audio', QUOTE);
    await answer(e);
    const pc = FakePc.made[0];
    pc.connect();
    pc.state('disconnected');
    offlineOnline();
    await vi.advanceTimersByTimeAsync(100);
    pc.connect();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(offers(sent)).toBe(1);
  });

  it('offline → online → offline → online on a live call: one 400, as on main', async () => {
    const { e, sent } = engine({ newCallId: freshIds() });
    await e.place(A, 'audio', QUOTE);
    await answer(e);
    FakePc.made[0].connect();
    offlineOnline();
    offlineOnline();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(offers(sent)).toBe(1);
  });

  it('place → ringing → offline → online → their answer: one 400, as on main', async () => {
    const { e, sent, last } = engine({ newCallId: freshIds() });
    await e.place(A, 'audio', QUOTE);
    expect(last().phase).toBe('ringing');
    offlineOnline();
    expect(last().phase).toBe('ringing');
    await answer(e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(offers(sent)).toBe(1);
  });

  it('after the call ends its network listeners are removed (every add has its remove) and the flag is cleared', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const { e, sent, last } = engine({ newCallId: freshIds() });
    await e.place(A, 'audio', QUOTE);
    await answer(e);
    FakePc.made[0].connect();
    window.dispatchEvent(new Event('offline'));
    const added = add.mock.calls.filter(([t]) => t === 'offline' || t === 'online').map(([t, fn]) => [t, fn]);
    expect(added.map(([t]) => t).sort()).toEqual(['offline', 'online']);
    await e.hangup();
    for (const [t, fn] of added) expect(remove).toHaveBeenCalledWith(t, fn);
    expect(last()).toMatchObject({ phase: 'ended', offline: false });
    const before = sent.length;
    offlineOnline();
    expect(sent).toHaveLength(before);
    expect(last().offline).toBe(false);
  });
});

describe('microphone and camera errors say what is true on this platform', () => {
  const err = (name: string) => Object.assign(new Error('x'), { name });
  it('a denied permission points to the right settings on Mac, iPhone and Android', () => {
    expect(mediaError(err('NotAllowedError'), 'audio', 'desktop')).toBe('Permission to use the microphone was denied — allow access in System Settings → Privacy & Security');
    expect(mediaError(err('NotAllowedError'), 'video', 'ios')).toBe('Permission to use the microphone or camera was denied — allow access in Settings → BitSov');
    expect(mediaError(err('NotAllowedError'), 'audio', 'android')).toBe('Permission to use the microphone was denied — allow access in Settings → Apps → BitSov → Permissions');
  });
  it('a webview with no media devices says the build cannot use the microphone yet', () => {
    expect(mediaError(err(NO_MEDIA_DEVICES), 'audio', 'ios')).toBe('This build cannot use the microphone yet');
    expect(mediaError(err(NO_MEDIA_DEVICES), 'video', 'android')).toBe('This build cannot use the microphone or camera yet');
  });
  it('an unknown failure keeps the Mac wording on a Mac and names the phone\'s settings on a phone', () => {
    expect(mediaError(new Error('?'), 'audio', 'desktop')).toBe('Camera/microphone not available — check System Settings → Privacy');
    expect(mediaError(new Error('?'), 'audio', 'android')).toBe('Camera/microphone not available — check Settings → Apps → BitSov → Permissions');
  });
});

describe('call signals', () => {
  it('parse like the node: right fields per kind, 32-hex ids, v1 only', () => {
    expect(parseSignal(400, JSON.stringify({ v: 1, call_id: ID, media: 'audio', sdp: 'x' }))?.media).toBe('audio');
    expect(parseSignal(400, JSON.stringify({ v: 1, call_id: ID, sdp: 'x' }))).toBeNull();
    expect(parseSignal(401, JSON.stringify({ v: 1, call_id: 'XYZ', sdp: 'x' }))).toBeNull();
    expect(parseSignal(401, JSON.stringify({ v: 2, call_id: ID, sdp: 'x' }))).toBeNull();
    expect(parseSignal(403, JSON.stringify({ v: 1, call_id: ID, reason: 'nope' }))).toBeNull();
    expect(parseSignal(403, 'not json')).toBeNull();
    expect(parseSignal(0, JSON.stringify({ v: 1, call_id: ID }))).toBeNull();
    expect([399, 400, 403, 404].map(isCallKind)).toEqual([false, true, true, false]);
    expect(newCallId((a) => a.fill(0xab))).toBe('ab'.repeat(16));
  });
});

describe('call engine', () => {
  beforeEach(() => { FakePc.made = []; });
  afterEach(() => { vi.useRealTimers(); });

  it('does not capture or pay when the shell closes during spend preflight', async () => {
    let authorize!: (allowed: boolean) => void;
    const { e, sent, media } = engine({ authorize: () => new Promise((resolve) => { authorize = resolve; }) });
    const placing = e.place(A, 'audio', QUOTE);
    e.endLocal();
    authorize(true);
    await placing;
    expect(media).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('a late capture from a cancelled call cannot disturb a newer incoming call', async () => {
    let release!: (s: MediaStream) => void;
    const { e, sent } = engine({ getUserMedia: () => new Promise((resolve) => { release = resolve; }) });
    const placing = e.place(A, 'audio', QUOTE);
    await vi.waitFor(() => expect(release).toBeDefined());
    await e.hangup();
    await placing;
    await e.receive(msg(400, { call_id: 'f'.repeat(32), media: 'audio', sdp: 'new offer' }), OWN);
    const late = stream();
    release(late);
    await vi.waitFor(() => expect(late.getTracks()[0].stop).toHaveBeenCalledOnce());
    expect(e.view()).toMatchObject({ phase: 'incoming', callId: 'f'.repeat(32), error: null });
    expect(sent).toEqual([]);
    e.endLocal();
  });

  it('bounds camera re-acquisition without ending a live call or keeping late video', async () => {
    vi.useFakeTimers();
    let release!: (s: MediaStream) => void;
    const { e, sent } = engine({ getUserMedia: async (c) => c.audio ? stream(true) : new Promise((resolve) => { release = resolve; }) });
    await e.place(A, 'video', QUOTE);
    FakePc.made[0].connect();
    await e.toggleCamera();
    const enabling = e.toggleCamera();
    await vi.advanceTimersByTimeAsync(15_000);
    await enabling;
    expect(e.view()).toMatchObject({ phase: 'live', camera: false, error: expect.stringContaining('System Settings → Privacy') });
    const late = stream(true, false);
    release(late);
    await vi.advanceTimersByTimeAsync(1);
    expect(late.getVideoTracks()[0].stop).toHaveBeenCalledOnce();
    expect(sent.map((s) => s.kind)).toEqual([400]);
    e.endLocal();
  });

  it.each(['outgoing', 'incoming'] as const)('bounds hung %s capture and stops a late stream without paying', async (direction) => {
    vi.useFakeTimers();
    let release!: (s: MediaStream) => void;
    const { e, sent } = engine({ getUserMedia: () => new Promise((resolve) => { release = resolve; }) });
    if (direction === 'incoming') await e.receive(msg(400, { media: 'video', sdp: 'offer' }), OWN);
    const pending = direction === 'outgoing' ? e.place(A, 'video', QUOTE) : e.accept(QUOTE);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(e.view()).toMatchObject({ phase: 'ended', paidMsat: 0, error: expect.stringContaining('Camera/microphone not available — check System Settings → Privacy') });
    await pending;
    const late = stream(true);
    release(late);
    await vi.advanceTimersByTimeAsync(1);
    expect(late.getTracks().every((t) => vi.mocked(t.stop).mock.calls.length === 1)).toBe(true);
    expect(sent).toEqual([]);
    expect(FakePc.made).toEqual([]);
    // The timed-out action must release the action lock.
    e.dismiss();
    expect(e.view().phase).toBe('idle');
  });

  it.each(['host', 'srflx', 'relay'])('reports the selected %s pair, not an unselected candidate', async (kind) => {
    const { e } = engine();
    await e.place(A, 'audio', QUOTE);
    const pc = FakePc.made[0];
    pc.stats = new Map([
      ['transport', { type: 'transport', selectedCandidatePairId: 'chosen' }],
      ['other', { type: 'candidate-pair', state: 'succeeded', localCandidateId: 'other-local' }],
      ['other-local', { type: 'local-candidate', candidateType: 'relay' }],
      ['chosen', { type: 'candidate-pair', localCandidateId: 'local', remoteCandidateId: 'remote' }],
      ['local', { type: 'local-candidate', candidateType: kind }],
      ['remote', { type: 'remote-candidate', candidateType: 'host' }],
    ]);
    pc.connect();
    await vi.waitFor(() => expect(e.view()).toHaveProperty('connection', { local: kind, remote: 'host' }));
    await e.hangup();
    expect(e.view()).toHaveProperty('connection', { local: kind, remote: 'host' });
  });

  it('places one paid offer at the quoted all-in, with STUN only, then goes live and hangs up once', async () => {
    const { e, sent, media, last } = engine();
    await Promise.all([e.place(A, 'audio', QUOTE), e.place(A, 'audio', QUOTE)]);
    expect(media).toEqual([{ audio: true, video: false }]);
    expect(FakePc.made).toHaveLength(1);
    // No STUN unless the owner set one: host candidates only, no third party.
    expect(FakePc.made[0].config.iceServers).toEqual([]);
    expect(sent).toEqual([{ peer: A, kind: 400, body: { v: 1, call_id: ID, media: 'audio', sdp: 'v=0 offer' }, max: 15_000 }]);
    expect(last()).toMatchObject({ phase: 'ringing', outgoing: true, paidMsat: 15_000 });
    await e.receive(msg(401, { sdp: 'v=0 answer' }), OWN);
    expect(FakePc.made[0].remote).toEqual({ type: 'answer', sdp: 'v=0 answer' });
    FakePc.made[0].connect();
    expect(last()).toMatchObject({ phase: 'live', liveAt: 1_000 });
    e.toggleMute();
    expect(FakePc.made[0].tracks[0].enabled).toBe(false);
    expect(last().muted).toBe(true);
    await Promise.all([e.hangup(), e.hangup()]);
    expect(sent.map((s) => [s.kind, s.body.reason ?? null, s.max])).toEqual([[400, null, 15_000], [403, 'hangup', 6_000]]);
    expect(last()).toMatchObject({ phase: 'ended', reason: 'hangup', paidMsat: 21_000, unknownCount: 0, unknownMsat: 0 });
    expect(FakePc.made[0].closed).toBe(true);
    expect(FakePc.made[0].tracks[0].stop).toHaveBeenCalled();
  });

  it('pays nothing when their node has no call price, or when the mic is missing', async () => {
    const { e, sent, last } = engine();
    await e.place(A, 'audio', { ...QUOTE, offer_msat: null, call_total_msat: null });
    expect(sent).toHaveLength(0);
    expect(last().error).toMatch(/gave no call price\. They may be offline.*Nothing was paid/);
    const denied = engine({ getUserMedia: () => Promise.reject(new Error('denied')) });
    await denied.e.place(A, 'video', QUOTE);
    expect(denied.sent).toHaveLength(0);
    expect(denied.last()).toMatchObject({ phase: 'ended', error: expect.stringMatching(/Nothing was paid/) });
  });

  it('a refused offer ends the call with the node’s words and releases the mic', async () => {
    const { e, last } = engine({ signal: async () => ({ ok: false, error: { code: 'budget_exhausted', message: 'Maya’s budget is used up.' } }) });
    await e.place(A, 'audio', QUOTE);
    expect(last()).toMatchObject({ phase: 'ended', error: 'Maya’s budget is used up.', paidMsat: 0 });
    expect(FakePc.made[0].closed).toBe(true);
  });

  it('an unanswered call stops ringing without paying a hangup', async () => {
    vi.useFakeTimers();
    const { e, sent, last } = engine();
    await e.place(A, 'audio', QUOTE);
    vi.advanceTimersByTime(RING_MS);
    expect(last()).toMatchObject({ phase: 'ended', reason: 'timeout' });
    expect(sent.map((s) => s.kind)).toEqual([400]);
  });

  it('rings on an offer, answers once at the signal price, and ends on their hangup without paying', async () => {
    const { e, sent, media, last } = engine();
    await e.receive(msg(400, { media: 'video', sdp: 'v=0 offer' }), OWN);
    expect(last()).toMatchObject({ phase: 'incoming', peer: A, media: 'video', outgoing: false });
    await Promise.all([e.accept(QUOTE), e.accept(QUOTE)]);
    expect(sent).toEqual([{ peer: A, kind: 401, body: { v: 1, call_id: ID, sdp: 'v=0 answer' }, max: 6_000 }]);
    expect(FakePc.made[0].remote).toEqual({ type: 'offer', sdp: 'v=0 offer' });
    FakePc.made[0].connect();
    // Camera off stops the capture (light off); camera on re-acquires onto the same sender.
    const cam = FakePc.made[0].tracks[1];
    await e.toggleCamera();
    expect(cam.stop).toHaveBeenCalled();
    expect(FakePc.made[0].senders[1].replaced).toEqual([null]);
    expect(last().camera).toBe(false);
    await e.toggleCamera();
    expect(media[media.length - 1]).toEqual({ video: true });
    expect(FakePc.made[0].senders[1].track).not.toBeNull();
    expect(FakePc.made[0].senders[1].track).not.toBe(cam);
    expect(last().camera).toBe(true);
    await e.receive(msg(402, { candidate: 'candidate:1 1 udp 1 127.0.0.1 9 typ host', sdp_mid: '0', sdp_mline_index: 0 }), OWN);
    expect(FakePc.made[0].candidates).toHaveLength(1);
    await e.receive(msg(403, { reason: 'hangup' }), OWN);
    expect(last()).toMatchObject({ phase: 'ended', reason: 'hangup' });
    expect(sent).toHaveLength(1);
  });

  it('declining pays one hangup so the caller stops ringing', async () => {
    const { e, sent, last } = engine();
    await e.receive(msg(400, { media: 'audio', sdp: 'v=0 offer' }), OWN);
    await e.decline(QUOTE);
    expect(sent.map((s) => [s.kind, s.body.reason])).toEqual([[403, 'declined']]);
    expect(last()).toMatchObject({ phase: 'ended', reason: 'declined' });
  });

  it('keeps its current caller when echoes, other hangups, junk and a second caller arrive', async () => {
    const { e, last } = engine();
    await e.receive(msg(400, { media: 'audio', sdp: 'x' }, OWN), OWN);
    expect(last()).toBeUndefined();
    await e.receive(msg(400, { media: 'audio', sdp: 'x' }), OWN);
    await e.receive(msg(400, { media: 'audio', sdp: 'y' }, 'b'.repeat(64)), OWN);
    expect(last()).toMatchObject({ phase: 'incoming', peer: A });
    await e.receive({ ...msg(403, {}), plaintext: JSON.stringify({ v: 1, call_id: 'f'.repeat(32), reason: 'hangup' }) }, OWN);
    await e.receive({ ...msg(403, {}), plaintext: 'junk' }, OWN);
    expect(last().phase).toBe('incoming');
  });
});

describe('H2: every end of our call asks the host to end its admission (op_end_call), once', () => {
  beforeEach(() => { FakePc.made = []; });
  afterEach(() => { vi.useRealTimers(); });
  const ended = (callId: string, over: Partial<OpView> = {}): OpView => ({ op_id: `end-${callId}`, kind: 'call_hangup', peer: A, call_id: callId, state: 'settled', cap_msat: 6_000, paid_msat: 6_000, message_id: 'h', ...over });
  const withEnd = (over: Partial<CallDeps> = {}, reply: (id: string) => Awaited<ReturnType<NonNullable<CallDeps['endCall']>>> = (id) => ({ ok: true, value: ended(id) })) => {
    const endCall = vi.fn(async (id: string) => reply(id));
    return { ...engine({ endCall, ...over }), endCall };
  };
  const live = async (e: ReturnType<typeof engine>['e']) => {
    await e.place(A, 'audio', QUOTE);
    await e.receive(msg(401, { sdp: 'v=0 answer' }), OWN);
    FakePc.made[0].connect();
  };

  it('our hang-up: the host ends it (no hangup paid here), once, and its cost is counted', async () => {
    const { e, sent, endCall, last } = withEnd();
    await live(e);
    await Promise.all([e.hangup(), e.hangup()]);
    await vi.waitFor(() => expect(last().close).toEqual({ status: 'closed', message: null }));
    expect(endCall.mock.calls).toEqual([[ID]]);
    expect(sent.map((x) => x.kind)).toEqual([400]);
    expect(last()).toMatchObject({ phase: 'ended', reason: 'hangup', paidMsat: 21_000 });
  });

  it('an unbound hangup event never ends our call; our own hang-up then ends it at the host, once', async () => {
    const { e, endCall, last } = withEnd();
    await live(e);
    await e.receive(msg(403, { reason: 'hangup' }), OWN);
    await e.receive(msg(403, { reason: 'hangup' }), OWN);
    expect(last().phase).toBe('live');
    await e.hangup();
    await vi.waitFor(() => expect(last().close?.status).toBe('closed'));
    expect(endCall.mock.calls).toEqual([[ID]]);
  });

  it('ring timeout ends it at the host, once', async () => {
    vi.useFakeTimers();
    const { e, endCall, last } = withEnd();
    await e.place(A, 'audio', QUOTE);
    await vi.advanceTimersByTimeAsync(RING_MS);
    expect(last()).toMatchObject({ phase: 'ended', reason: 'timeout' });
    await e.hangup();
    expect(endCall.mock.calls).toEqual([[ID]]);
  });

  it('a failed connection ends it at the host, once', async () => {
    const { e, endCall, last } = withEnd();
    await live(e);
    FakePc.made[0].state('closed');
    await vi.waitFor(() => expect(last().close?.status).toBe('closed'));
    expect(last()).toMatchObject({ phase: 'ended', reason: 'failed' });
    expect(endCall.mock.calls).toEqual([[ID]]);
  });

  it('cancel while ringing ends it at the host, once (no hangup paid here)', async () => {
    const { e, sent, endCall } = withEnd();
    await e.place(A, 'audio', QUOTE);
    expect(e.view().phase).toBe('ringing');
    await e.hangup();
    await vi.waitFor(() => expect(endCall).toHaveBeenCalledTimes(1));
    expect(endCall).toHaveBeenCalledWith(ID);
    expect(sent.map((x) => x.kind)).toEqual([400]);
  });

  it('cancel while the offer is in flight: the host ends it (it waits for that offer), once; the late receipt adds nothing', async () => {
    let settle!: (v: Awaited<ReturnType<CallDeps['signal']>>) => void;
    const { e, endCall } = withEnd({ signal: () => new Promise((r) => { settle = r; }) });
    const placing = e.place(A, 'audio', QUOTE);
    await vi.waitFor(() => expect(settle).toBeDefined());
    await e.hangup();
    await vi.waitFor(() => expect(endCall).toHaveBeenCalledTimes(1));
    settle({ ok: true, value: { message_id: 'm', kind: 400, amount_msat: 10_000, total_msat: 15_000, max_routing_fee_msat: 5000, delivered: true, accepted: true, sent_at_ms: 0 } });
    await placing;
    expect(endCall.mock.calls).toEqual([[ID]]);
  });

  it('cancel before the offer reached the host asks nothing of it', async () => {
    let grant!: (s: MediaStream) => void;
    const { e, endCall } = withEnd({ getUserMedia: () => new Promise((r) => { grant = r; }) });
    const placing = e.place(A, 'audio', QUOTE);
    await vi.waitFor(() => expect(grant).toBeDefined());
    await e.hangup();
    grant(stream());
    await placing;
    expect(endCall).not.toHaveBeenCalled();
  });

  it('a refused offer is still ended at the host once (it answers "unpaid": nothing owed, nothing paid)', async () => {
    const { e, endCall, last } = withEnd(
      { signal: async () => ({ ok: false, error: { code: 'budget_exhausted', message: 'Maya’s budget is used up.' } }) },
      (id) => ({ ok: true, value: ended(id, { kind: 'call_offer', state: 'unpaid', paid_msat: null }) }));
    await e.place(A, 'audio', QUOTE);
    await vi.waitFor(() => expect(last().close?.status).toBe('closed'));
    expect(endCall.mock.calls).toEqual([[ID]]);
    expect(last()).toMatchObject({ error: 'Maya’s budget is used up.', paidMsat: 0 });
  });

  it('as the callee nothing is ours to end: decline and hang-up pay their hangup as before', async () => {
    const declined = withEnd();
    await declined.e.receive(msg(400, { media: 'audio', sdp: 'v=0 offer' }), OWN);
    await declined.e.decline(QUOTE);
    expect(declined.sent.map((x) => [x.kind, x.body.reason])).toEqual([[403, 'declined']]);
    expect(declined.endCall).not.toHaveBeenCalled();
    FakePc.made = [];
    const answered = withEnd();
    await answered.e.receive(msg(400, { media: 'audio', sdp: 'v=0 offer' }), OWN);
    await answered.e.accept(QUOTE);
    FakePc.made[0].connect();
    await answered.e.hangup();
    expect(answered.sent.map((x) => x.kind)).toEqual([401, 403]);
    expect(answered.endCall).not.toHaveBeenCalled();
  });

  it('closing the window asks nothing of the host (nothing is paid then)', async () => {
    const { e, endCall } = withEnd();
    await live(e);
    e.endLocal();
    await new Promise((r) => setTimeout(r, 10));
    expect(endCall).not.toHaveBeenCalled();
  });

  it('a recovery admission we placed is ended too: each id once', async () => {
    vi.useFakeTimers();
    const restartId = 'e'.repeat(32);
    let n = 0;
    const { e, endCall, sent } = withEnd({ newCallId: () => n++ === 0 ? ID : restartId });
    await e.place(A, 'audio', QUOTE);
    await e.receive(msg(401, { sdp: 'v=0 answer' }), OWN);
    const pc = FakePc.made[0];
    pc.connect();
    pc.state('failed');
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.some((x) => x.kind === 400 && x.body.call_id === restartId)).toBe(true);
    await e.hangup();
    await vi.advanceTimersByTimeAsync(0);
    expect(endCall.mock.calls.map((c) => c[0]).sort()).toEqual([ID, restartId].sort());
    expect(sent.filter((x) => x.kind === 403)).toHaveLength(0);
  });
});

describe('H2 710f67e × R2: op_close_call records, then op_end_call ends (idempotent)', () => {
  beforeEach(() => { FakePc.made = []; });
  afterEach(() => { vi.useRealTimers(); });
  const both = () => {
    const order: string[] = [];
    const closeAdmission = vi.fn(async (op: string) => { order.push(`record:${op}`); });
    const endCall = vi.fn(async (id: string) => { order.push(`end:${id}`); return { ok: true as const, value: { op_id: 'h', kind: 'call_offer', peer: A, call_id: id, state: 'settled' as const, cap_msat: 1, paid_msat: null, message_id: null } }; });
    const kinds: number[] = [];
    const signal: CallDeps['signal'] = async (_p, kind) => (kinds.push(kind), { ok: true, value: { operation_id: kind === 400 ? 'offer-op' : null, message_id: 'm', kind, amount_msat: 10_000, total_msat: 15_000, max_routing_fee_msat: 5_000, delivered: true, accepted: true, sent_at_ms: 0 } as CallReceipt });
    return { ...engine({ closeAdmission, endCall, signal }), order, closeAdmission, endCall, kinds };
  };

  it('ring timeout: the closure is recorded first, then op_end_call (which sends nothing more)', async () => {
    vi.useFakeTimers();
    const { e, order } = both();
    await e.place(A, 'audio', QUOTE);
    await vi.advanceTimersByTimeAsync(RING_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['record:offer-op', `end:${ID}`]);
  });

  it('their hang-up bound by the host to this admission ends the card; the host closes it, so nothing is recorded or ended from here', async () => {
    const { e, order } = both();
    await e.place(A, 'audio', QUOTE);
    await e.receive(msg(401, { sdp: 'v=0 answer' }), OWN);
    FakePc.made[0].connect();
    await e.receive({ ...msg(403, { reason: 'hangup' }), admission_operation_id: 'offer-op' }, OWN);
    expect(e.view()).toMatchObject({ phase: 'ended', reason: 'hangup' });
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([]);
  });

  it('their hang-up with no host binding (or another admission\'s) never ends our call', async () => {
    const { e, order } = both();
    await e.place(A, 'audio', QUOTE);
    await e.receive(msg(401, { sdp: 'v=0 answer' }), OWN);
    FakePc.made[0].connect();
    await e.receive({ ...msg(403, { reason: 'hangup' }), admission_operation_id: null }, OWN);
    expect(e.view().phase).toBe('live');
    expect(order).toEqual([]);
  });

  it('their bound hang-up before our offer receipt applies once the receipt brings that op id', async () => {
    let finish!: (r: Awaited<ReturnType<CallDeps['signal']>>) => void;
    const order: string[] = [];
    const { e } = engine({
      closeAdmission: async (op) => { order.push(`record:${op}`); },
      endCall: async (id) => { order.push(`end:${id}`); return { ok: true, value: { op_id: 'h', kind: 'call_hangup', peer: A, call_id: id, state: 'settled', cap_msat: 1, paid_msat: null, message_id: null } }; },
      signal: () => new Promise((r) => { finish = r; }),
    });
    const placing = e.place(A, 'audio', QUOTE);
    await vi.waitFor(() => expect(finish).toBeDefined());
    await e.receive({ ...msg(403, { reason: 'declined' }), admission_operation_id: 'offer-op' }, OWN);
    expect(e.view().phase).not.toBe('ended');
    finish({ ok: true, value: { operation_id: 'offer-op', message_id: 'm', kind: 400, amount_msat: 10_000, total_msat: 15_000, max_routing_fee_msat: 5_000, delivered: true, accepted: true, sent_at_ms: 0 } as CallReceipt });
    await placing;
    await vi.waitFor(() => expect(e.view()).toMatchObject({ phase: 'ended', reason: 'declined' }));
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([]);
  });

  it('our hang-up while live: not recorded first, so op_end_call sends the one hangup; no app-paid 403', async () => {
    const { e, order, kinds } = both();
    await e.place(A, 'audio', QUOTE);
    await e.receive(msg(401, { sdp: 'v=0 answer' }), OWN);
    FakePc.made[0].connect();
    await e.hangup();
    await vi.waitFor(() => expect(order).toEqual([`end:${ID}`]));
    expect(kinds).toEqual([400]);
  });

  it('the window closing records the closure and asks nothing more (nothing paid)', async () => {
    const { e, order } = both();
    await e.place(A, 'audio', QUOTE);
    e.endLocal();
    await vi.waitFor(() => expect(order).toEqual(['record:offer-op']));
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['record:offer-op']);
  });
});

describe('#222 r2: ends racing the offer, and recovery admissions', () => {
  beforeEach(() => { FakePc.made = []; });
  afterEach(() => { vi.useRealTimers(); });
  const offerReceipt = (op: string) => ({ ok: true as const, value: { operation_id: op, message_id: 'm', kind: 400, amount_msat: 10_000, total_msat: 15_000, max_routing_fee_msat: 5_000, delivered: true, accepted: true, sent_at_ms: 0 } as CallReceipt });
  const hangupView = (id: string): OpView => ({ op_id: `h-${id}`, kind: 'call_hangup', peer: A, call_id: id, state: 'settled', cap_msat: 6000, paid_msat: 6000, message_id: 'h' });

  it('#1 cancel during the offer\'s preflight: "not found" is not "closed"; when the offer\'s receipt lands, op_end_call runs exactly once more', async () => {
    let finish!: (r: Awaited<ReturnType<CallDeps['signal']>>) => void;
    const replies: Awaited<ReturnType<NonNullable<CallDeps['endCall']>>>[] = [
      { ok: false, error: { code: 'call_not_found' as never, message: 'No outgoing admission is recorded for this call.' } },
      { ok: true, value: hangupView(ID) },
    ];
    const endCall = vi.fn(async () => replies.shift()!);
    const { e, last } = engine({ endCall, signal: () => new Promise((r) => { finish = r; }) });
    const placing = e.place(A, 'audio', QUOTE);
    await vi.waitFor(() => expect(finish).toBeDefined());
    await e.hangup();
    await vi.waitFor(() => expect(endCall).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(last().close?.status).toBe('closing');
    finish(offerReceipt('op-A'));
    await placing;
    await vi.waitFor(() => expect(endCall).toHaveBeenCalledTimes(2));
    expect(endCall.mock.calls).toEqual([[ID], [ID]]);
    await vi.waitFor(() => expect(last().close).toEqual({ status: 'closed', message: null }));
    await new Promise((r) => setTimeout(r, 10));
    expect(endCall).toHaveBeenCalledTimes(2);
  });

  for (const ending of ['cancel', 'timeout'] as const) {
    for (const order of ['not-found-first', 'offer-first'] as const) {
      for (const outcome of ['paid', 'undelivered_pending', 'failed_paid', 'budget_unreadable', 'node', 'rejected'] as const) {
        it(`A2 deferred cleanup: ${ending}, ${order}, ${outcome}`, async () => {
          vi.useFakeTimers();
          let finish!: (r: Awaited<ReturnType<CallDeps['signal']>>) => void;
          let reject!: (e: unknown) => void;
          let notFound!: (r: Awaited<ReturnType<NonNullable<CallDeps['endCall']>>>) => void;
          const endCall = vi.fn<NonNullable<CallDeps['endCall']>>()
            .mockImplementationOnce(() => new Promise(resolve => { notFound = resolve; }))
            .mockResolvedValue({ ok: true, value: hangupView(ID) });
          const { e } = engine({ endCall, signal: () => new Promise((resolve, fail) => { finish = resolve; reject = fail; }) });
          const placing = e.place(A, 'audio', QUOTE);
          await vi.advanceTimersByTimeAsync(0);
          if (ending === 'cancel') await e.hangup();
          else await vi.advanceTimersByTimeAsync(30_000);
          await vi.advanceTimersByTimeAsync(0);
          expect(endCall).toHaveBeenCalledTimes(1);
          const missing = () => notFound({ ok: false, error: { code: 'call_not_found', message: 'Not recorded yet.' } });
          const offer = () => outcome === 'rejected' ? reject({ code: 'node', message: 'Lost reply.', operation_id: 'op-A' })
            : finish(outcome === 'paid' ? offerReceipt('op-A')
              : { ok: false, error: { code: outcome, message: 'Post-dispatch result.', operation_id: 'op-A' } });
          if (order === 'not-found-first') { missing(); await vi.advanceTimersByTimeAsync(0); offer(); }
          else { offer(); await vi.advanceTimersByTimeAsync(0); missing(); }
          await placing;
          await vi.advanceTimersByTimeAsync(0);
          expect(endCall.mock.calls).toEqual([[ID], [ID]]);
          expect(e.view().close?.status).toBe('closed');
          expect(FakePc.made[0].closed).toBe(true);
        });
      }
    }
  }

  it('#1 the same race, but the offer is refused with no operation: nothing was admitted, so it is closed and not asked again', async () => {
    let finish!: (r: Awaited<ReturnType<CallDeps['signal']>>) => void;
    const endCall = vi.fn(async () => ({ ok: false as const, error: { code: 'call_not_found' as never, message: 'x' } }));
    const { e, last } = engine({ endCall, signal: () => new Promise((r) => { finish = r; }) });
    const placing = e.place(A, 'audio', QUOTE);
    await vi.waitFor(() => expect(finish).toBeDefined());
    await e.hangup();
    await vi.waitFor(() => expect(endCall).toHaveBeenCalledTimes(1));
    finish({ ok: false, error: { code: 'budget_exhausted' as never, message: 'Budget used up.' } });
    await placing;
    await vi.waitFor(() => expect(last().close).toEqual({ status: 'closed', message: null }));
    expect(endCall).toHaveBeenCalledTimes(1);
  });

  it('#1 an op-bearing unknown offer result also brings the asked end back once', async () => {
    let finish!: (r: Awaited<ReturnType<CallDeps['signal']>>) => void;
    const replies: Awaited<ReturnType<NonNullable<CallDeps['endCall']>>>[] = [
      { ok: false, error: { code: 'call_not_found' as never, message: 'x' } },
      { ok: true, value: hangupView(ID) },
    ];
    const endCall = vi.fn(async () => replies.shift()!);
    const { e } = engine({ endCall, signal: () => new Promise((r) => { finish = r; }) });
    const placing = e.place(A, 'audio', QUOTE);
    await vi.waitFor(() => expect(finish).toBeDefined());
    await e.hangup();
    await vi.waitFor(() => expect(endCall).toHaveBeenCalledTimes(1));
    finish({ ok: false, error: { code: 'spend_unknown' as never, message: 'Outcome unknown.', operation_id: 'op-A' } });
    await placing;
    await vi.waitFor(() => expect(endCall).toHaveBeenCalledTimes(2));
  });

  it('#2 their bound hangup confirms only the original admission: the recovery admission we placed is still ended at the host', async () => {
    vi.useFakeTimers();
    const restartId = 'e'.repeat(32);
    let n = 0;
    const endCall = vi.fn(async (id: string) => ({ ok: true as const, value: hangupView(id) }));
    const signal: CallDeps['signal'] = async (_p, kind, plaintext) => {
      const id = JSON.parse(plaintext).call_id as string;
      return { ok: true, value: { operation_id: kind === 400 ? (id === ID ? 'op-A' : 'op-B') : null, message_id: 'm', kind, amount_msat: 1, total_msat: 1, max_routing_fee_msat: 0, delivered: true, accepted: true, sent_at_ms: 0 } as CallReceipt };
    };
    const { e } = engine({ endCall, signal, newCallId: () => (n++ === 0 ? ID : restartId) });
    await e.place(A, 'audio', QUOTE);
    await e.receive(msg(401, { sdp: 'v=0 answer' }), OWN);
    const pc = FakePc.made[0];
    pc.connect();
    pc.state('failed');
    await vi.advanceTimersByTimeAsync(0);
    // Their hangup, bound by the host to the original admission (op-A, call id ID).
    await e.receive({ ...msg(403, { reason: 'hangup' }), admission_operation_id: 'op-A' }, OWN);
    await vi.advanceTimersByTimeAsync(0);
    expect(e.view().phase).toBe('ended');
    expect(endCall.mock.calls).toEqual([[restartId]]);
  });
});

describe('H2: what the host says about ending, said honestly', () => {
  beforeEach(() => { FakePc.made = []; });
  const err = (code: string, message = 'x') => ({ ok: false as const, error: { code: code as never, message } });
  const view = (state: OpView['state']): OpView => ({ op_id: 'o', kind: 'call_hangup', peer: A, call_id: ID, state, cap_msat: 6000, paid_msat: null, message_id: null });

  it('closeOutcome: ended, nothing recorded, unknown, price moved, other refusals', () => {
    expect(closeOutcome({ ok: true, value: view('settled') })).toEqual({ status: 'closed', message: null });
    expect(closeOutcome({ ok: true, value: view('unpaid') })).toEqual({ status: 'closed', message: null });
    expect(closeOutcome(err('call_not_found'))).toEqual({ status: 'closed', message: null });
    for (const unknown of [closeOutcome({ ok: true, value: view('unknown') }), closeOutcome({ ok: true, value: view('dispatching') }), closeOutcome(err('spend_unknown')), closeOutcome(err('payment_unknown'))]) {
      expect(unknown).toEqual({ status: 'unknown', message: 'Ending the call: the result is not known yet. Check pending result before calling them again.' });
    }
    expect(closeOutcome(err('price_changed'))).toMatchObject({ status: 'refused', message: expect.stringContaining('Nothing was paid') });
    expect(closeOutcome(err('price_cap_exceeded')).status).toBe('refused');
    expect(closeOutcome(err('not_ready', 'Your node is not ready.'))).toEqual({ status: 'refused', message: 'Couldn’t end the call: Your node is not ready.' });
  });

  it('a refused end can be asked again by the owner, and only then', async () => {
    const replies = [err('price_changed'), { ok: true as const, value: view('settled') }];
    const endCall = vi.fn(async () => replies.shift()!);
    const { e, last } = engine({ endCall });
    await e.place(A, 'audio', QUOTE);
    await e.hangup();
    await vi.waitFor(() => expect(last().close?.status).toBe('refused'));
    expect(endCall).toHaveBeenCalledTimes(1);
    await e.closeAgain();
    expect(endCall).toHaveBeenCalledTimes(2);
    expect(last().close).toEqual({ status: 'closed', message: null });
    await e.closeAgain();
    expect(endCall).toHaveBeenCalledTimes(2);
  });

  it('"Try ending it again" belongs to its own call: a late answer for call A never clears call B\'s', async () => {
    const second = 'b'.repeat(32);
    let ids = 0;
    let releaseA!: (v: unknown) => void;
    const endCall = vi.fn((id: string) => id === ID
      ? new Promise((r) => { releaseA = r; }) as never
      : Promise.resolve(err('price_changed')));
    const { e, last } = engine({ endCall, newCallId: () => (ids++ === 0 ? ID : second) });
    await e.place(A, 'audio', QUOTE);
    await e.hangup(); // call A: its end is still out
    e.dismiss();
    await e.place(A, 'audio', QUOTE);
    await e.hangup(); // call B: refused
    await vi.waitFor(() => expect(last()).toMatchObject({ callId: second, close: { status: 'refused' } }));
    releaseA({ ok: true, value: view('settled') }); // A's late success
    await new Promise((r) => setTimeout(r, 10));
    expect(last()).toMatchObject({ callId: second, close: { status: 'refused' } });
    await e.closeAgain();
    expect(endCall.mock.calls.map((c) => c[0])).toEqual([ID, second, second]);
  });

  it('an unknown end stays unknown and offers no "try again"', async () => {
    const endCall = vi.fn(async () => err('spend_unknown'));
    const { e, last } = engine({ endCall });
    await e.place(A, 'audio', QUOTE);
    await e.hangup();
    await vi.waitFor(() => expect(last().close?.status).toBe('unknown'));
    await e.closeAgain();
    expect(endCall).toHaveBeenCalledTimes(1);
  });

  it('recovery refusal explains closure and End call closes the original admission', async () => {
    vi.useFakeTimers();
    let offers = 0;
    const endCall = vi.fn(async () => ({ ok: true as const, value: view('settled') }));
    const { e, last } = engine({ endCall, signal: async () => ++offers === 1
      ? { ok: true, value: { operation_id: 'original', message_id: 'm', kind: 400, amount_msat: 10000, total_msat: 15000, max_routing_fee_msat: 5000, delivered: true, accepted: true, sent_at_ms: 0 } }
      : { ok: false, error: { code: 'call_admission_open', message: 'generic', operation_id: 'original' } } });
    await e.place(A, 'audio', QUOTE);
    await e.receive(msg(401, { sdp: 'answer' }), OWN);
    const pc = FakePc.made[FakePc.made.length - 1];
    pc.connect(); pc.state('failed');
    await vi.advanceTimersByTimeAsync(0);
    expect(last().recoveryError).toBe('Your last call is still closing. End it, then call again.');
    await e.hangup();
    await vi.advanceTimersByTimeAsync(0);
    expect(endCall.mock.calls).toHaveLength(1);
    expect(endCall).toHaveBeenCalledWith(ID);
    expect(last().close?.status).toBe('closed');
    vi.useRealTimers();
  });

  it.each(['hangup', 'busy'])('host-bound early %s waits for the exact offer receipt', async (reason) => {
    let resolve!: (r: Awaited<ReturnType<CallDeps['signal']>>) => void;
    const endCall = vi.fn();
    const { e, last } = engine({ endCall, signal: () => new Promise(r => { resolve = r; }) });
    const placing = e.place(A, 'audio', QUOTE);
    await vi.waitFor(() => expect(resolve).toBeDefined());
    await e.receive({ ...msg(403, { reason }), admission_operation_id: 'fresh' }, OWN);
    expect(last().phase).toBe('calling');
    resolve({ ok: true, value: { operation_id: 'fresh', message_id: 'm', kind: 400, amount_msat: 10000, total_msat: 15000, max_routing_fee_msat: 5000, delivered: true, accepted: true, sent_at_ms: 0 } });
    await placing;
    expect(last()).toMatchObject({ phase: 'ended', reason });
    expect(endCall).not.toHaveBeenCalled();
  });

  it('call_admission_open: said, never a silent block; the owner ends the earlier call, found by its op', async () => {
    const earlier = 'c'.repeat(32);
    const endCall = vi.fn(async (id: string) => ({ ok: true as const, value: { ...view('settled'), call_id: id } }));
    const stuckCall = vi.fn(async () => earlier);
    const { e, last } = engine({
      endCall, stuckCall,
      signal: async () => ({ ok: false, error: { code: 'call_admission_open', message: 'End the existing call before starting another admission. Nothing was paid.', operation_id: 'op-old' } }),
    });
    await e.place(A, 'audio', QUOTE);
    expect(last()).toMatchObject({ phase: 'ended', stuck: { opId: 'op-old' }, paidMsat: 0, unknownCount: 0, unknownMsat: 0 });
    // The refused offer is not an admission: nothing to end for it.
    expect(endCall).not.toHaveBeenCalled();
    await e.endStuck();
    expect(stuckCall).toHaveBeenCalledWith(A, 'op-old');
    expect(endCall.mock.calls).toEqual([[earlier]]);
    expect(last()).toMatchObject({ stuck: null, close: { status: 'closed', message: 'The earlier call is ended. You can call them again.' } });
  });

  // The host's answer for a call the node already ended: its hangup, unpaid, closing the admission.
  it('call_admission_open: an earlier call the node already ended is closed, nothing paid, and the card says so', async () => {
    const earlier = 'c'.repeat(32);
    const endCall = vi.fn(async (id: string) => ({ ok: true as const, value: { ...view('unpaid'), call_id: id, paid_msat: 0 } }));
    const { e, last } = engine({
      endCall, stuckCall: async () => earlier,
      signal: async () => ({ ok: false, error: { code: 'call_admission_open', message: 'End the existing call before starting another admission. Nothing was paid.', operation_id: 'op-old' } }),
    });
    await e.place(A, 'audio', QUOTE);
    await e.endStuck();
    expect(endCall.mock.calls).toEqual([[earlier]]);
    expect(last()).toMatchObject({ stuck: null, paidMsat: 0, unknownCount: 0, unknownMsat: 0, close: { status: 'closed', message: 'The earlier call is ended. You can call them again.' } });
  });

  it('a call nobody answered: End asks the host once, its unpaid hangup closes the call, nothing is owed', async () => {
    vi.useFakeTimers();
    try {
      const endCall = vi.fn(async (id: string) => ({ ok: true as const, value: { ...view('unpaid'), call_id: id, paid_msat: 0 } }));
      const { e, last, sent } = engine({ endCall });
      await e.place(A, 'audio', QUOTE);
      expect(last().phase).toBe('ringing');
      await vi.advanceTimersByTimeAsync(RING_MS);
      expect(endCall.mock.calls).toEqual([[ID]]);
      expect(sent.map(s => s.kind)).toEqual([400]);
      expect(last()).toMatchObject({ phase: 'ended', reason: 'timeout', close: { status: 'closed', message: null }, unknownCount: 0, unknownMsat: 0, pendingCount: 0, pendingMsat: 0 });
    } finally { vi.useRealTimers(); }
  });

  it('call_needs_node_upgrade (refused before dispatch): says so honestly, nothing paid, nothing to end at the host', async () => {
    const endCall = vi.fn();
    const { e, last } = engine({
      endCall,
      signal: async () => ({ ok: false, error: { code: 'call_needs_node_upgrade', message: 'Upgrade your node before making calls. Nothing was paid.' } }),
    });
    await e.place(A, 'audio', QUOTE);
    expect(last()).toMatchObject({ phase: 'ended', error: 'Your node needs an update before paid calls work. Nothing was paid.', paidMsat: 0, stuck: null });
    await new Promise((r) => setTimeout(r, 10));
    expect(endCall).not.toHaveBeenCalled();
    expect(FakePc.made[0].closed).toBe(true);
  });

  it('call_admission_open with no earlier call found: says so, ends nothing', async () => {
    const endCall = vi.fn();
    const { e, last } = engine({
      endCall, stuckCall: async () => null,
      signal: async () => ({ ok: false, error: { code: 'call_admission_open', message: 'x' } }),
    });
    await e.place(A, 'audio', QUOTE);
    await e.endStuck();
    expect(endCall).not.toHaveBeenCalled();
    expect(last().close).toEqual({ status: 'refused', message: 'Couldn’t find the earlier call to end. Check pending result.' });
  });
});

describe('call engine: review #74 fixes', () => {
  beforeEach(() => { FakePc.made = []; });
  afterEach(() => { vi.useRealTimers(); });

  it('uses only the owner’s STUN server, validated, and none by default', async () => {
    expect(stunServer('')).toEqual([]);
    expect(stunServer(null)).toEqual([]);
    expect(stunServer('stun:stun.example.org:3478')).toEqual([{ urls: 'stun:stun.example.org:3478' }]);
    expect(stunServer('stun:[2001:db8::1]:3478')).toEqual([{ urls: 'stun:[2001:db8::1]:3478' }]);
    for (const bad of ['turn:relay.example.org', 'stun:user:pw@host', 'https://x.org', 'stun:host:3478?transport=tcp', 'stun:', 'stun:[x@y]:1', 'stun:2001:db8::1']) expect(stunServer(bad)).toEqual([]);
    const { e } = engine({ iceServers: () => stunServer('stun:own-node.example:3478') });
    await e.place(A, 'audio', QUOTE);
    expect(FakePc.made[0].config.iceServers).toEqual([{ urls: 'stun:own-node.example:3478' }]);
  });

  it('cancel before the offer is sent pays nothing and stops the mic', async () => {
    let grant!: (s: MediaStream) => void;
    const s = stream();
    const { e, sent, last } = engine({ getUserMedia: () => new Promise((r) => { grant = r; }) });
    const placing = e.place(A, 'audio', QUOTE);
    await vi.waitFor(() => expect(grant).toBeDefined());
    await e.hangup();
    expect(last()).toMatchObject({ phase: 'ended', reason: 'hangup' });
    grant(s);
    await placing;
    expect(sent).toHaveLength(0);
    expect(s.getTracks()[0].stop).toHaveBeenCalled();
    expect(FakePc.made.every((pc) => pc.closed)).toBe(true);
  });

  it('cancel while the offer is in flight stops the mic now and sends nothing more', async () => {
    let settle!: (v: Awaited<ReturnType<CallDeps['signal']>>) => void;
    const kinds: number[] = [];
    const { e, last } = engine({ signal: (_p, kind) => { kinds.push(kind); return new Promise((r) => { settle = r; }); } });
    const placing = e.place(A, 'audio', QUOTE);
    await vi.waitFor(() => expect(settle).toBeDefined());
    await e.hangup();
    expect(FakePc.made[0].closed).toBe(true);
    expect(FakePc.made[0].tracks[0].stop).toHaveBeenCalled();
    settle({ ok: true, value: { message_id: 'm', kind: 400, amount_msat: 10_000, total_msat: 15_000, max_routing_fee_msat: 5000, delivered: true, accepted: true, sent_at_ms: 0 } });
    await placing;
    expect(kinds).toEqual([400]);
    expect(last().phase).toBe('ended');
    // Their answer, if it comes, is ignored.
    await e.receive(msg(401, { sdp: 'v=0 answer' }), OWN);
    expect(last().phase).toBe('ended');
  });

  it('ending locally (window closing) pays nothing', async () => {
    const { e, sent, last } = engine();
    await e.place(A, 'audio', QUOTE);
    await e.receive(msg(401, { sdp: 'v=0 answer' }), OWN);
    FakePc.made[0].connect();
    e.endLocal();
    expect(sent.map((x) => x.kind)).toEqual([400]);
    expect(last()).toMatchObject({ phase: 'ended' });
    expect(FakePc.made[0].tracks[0].stop).toHaveBeenCalled();
  });

  it('a dropped connection ends the call after a grace period and releases media; a blip does not', async () => {
    vi.useFakeTimers();
    const { e, sent, last } = engine();
    await e.place(A, 'audio', QUOTE);
    await e.receive(msg(401, { sdp: 'v=0 answer' }), OWN);
    const pc = FakePc.made[0];
    pc.connect();
    pc.state('disconnected');
    vi.advanceTimersByTime(1_999);
    pc.state('connected');
    vi.advanceTimersByTime(RECONNECT_GRACE_MS);
    expect(last().phase).toBe('live');
    pc.state('disconnected');
    vi.advanceTimersByTime(RECONNECT_GRACE_MS);
    expect(last()).toMatchObject({ phase: 'ended', reason: 'failed', error: expect.stringContaining('The connection was lost.') });
    expect(pc.closed && (pc.tracks[0].stop as unknown as { mock: { calls: unknown[] } }).mock.calls.length > 0).toBe(true);
    expect(sent.map((x) => x.kind)).toEqual([400]);
  });

  it('closes an answered admission when its offer result is unknown, including late errors', async () => {
    for (const late of [false, true]) {
      const closeAdmission = vi.fn(async () => {});
      let finish!: (r: Awaited<ReturnType<CallDeps['signal']>>) => void;
      const { e } = engine({ closeAdmission, signal: () => new Promise(resolve => { finish = resolve; }) });
      const placing = e.place(A, 'audio', QUOTE);
      await vi.waitFor(() => expect(finish).toBeDefined());
      await e.receive(msg(401, { sdp: 'v=0 answer' }), OWN);
      if (late) e.endLocal();
      finish({ ok: false, error: asActionError({ code: 'spend_unknown', message: 'unknown', operation_id: 'ambiguous-offer' }) });
      await placing;
      expect(closeAdmission).toHaveBeenCalledWith('ambiguous-offer', A, ID);
    }
  });

  it('records local closure after dispatching the explicit paid hangup', async () => {
    const actions: string[] = [];
    const { e } = engine({
      closeAdmission: async id => { actions.push(id); },
      signal: async (_peer, kind) => {
        actions.push(String(kind));
        return { ok: true, value: { operation_id: kind === 400 ? 'offer-op' : 'hangup-op', total_msat: 1 } as CallReceipt };
      },
    });
    await e.place(A, 'audio', QUOTE);
    await e.hangup();
    expect(actions).toEqual(['400', '403', 'offer-op']);
  });

  it('uses the host-bound hangup operation and never selects a reused admission itself', async () => {
    const closeAdmission = vi.fn(async () => {});
    const { e } = engine({ closeAdmission, signal: async () => ({ ok: true, value: { operation_id: 'new-offer', total_msat: 1 } as CallReceipt }) });
    await e.place(A, 'audio', QUOTE);
    await e.receive({ ...msg(403, { reason: 'hangup' }), admission_operation_id: 'old-offer' } as Message, OWN);
    expect(e.view().phase).toBe('ringing');
    expect(closeAdmission).not.toHaveBeenCalled();
    await e.receive({ ...msg(403, { reason: 'hangup' }), admission_operation_id: null } as Message, OWN);
    expect(e.view().phase).toBe('ringing');
    await e.receive({ ...msg(403, { reason: 'hangup' }), admission_operation_id: 'new-offer' } as Message, OWN);
    expect(e.view().phase).toBe('ended');
    expect(closeAdmission).not.toHaveBeenCalled();
  });

  it('reports local failure by admission operation id, including a late offer receipt', async () => {
    const closeAdmission = vi.fn(async (_id: string) => {});
    const first = engine({ closeAdmission, signal: async () => ({ ok: true, value: { operation_id: 'offer-one', total_msat: 1 } as CallReceipt }) });
    await first.e.place(A, 'audio', QUOTE);
    await first.e.receive(msg(401, { sdp: 'v=0 answer' }), OWN);
    FakePc.made[0].state('closed');
    expect(closeAdmission).toHaveBeenCalledWith('offer-one', A, ID);

    let finish!: (r: Awaited<ReturnType<CallDeps['signal']>>) => void;
    const second = engine({ closeAdmission, signal: () => new Promise(resolve => { finish = resolve; }) });
    const placing = second.e.place(A, 'audio', QUOTE);
    await vi.waitFor(() => expect(finish).toBeDefined());
    second.e.endLocal();
    finish({ ok: true, value: { operation_id: 'offer-two', total_msat: 1 } as CallReceipt });
    await placing;
    expect(closeAdmission.mock.calls).toEqual([['offer-one', A, ID], ['offer-two', A, ID]]);
  });

  it('closed ends at once; a call stuck connecting ends after a timeout', async () => {
    vi.useFakeTimers();
    const a = engine();
    await a.e.place(A, 'audio', QUOTE);
    await a.e.receive(msg(401, { sdp: 'v=0 answer' }), OWN);
    FakePc.made[0].state('closed');
    expect(a.last()).toMatchObject({ phase: 'ended', reason: 'failed' });
    setStunPref('');
    setDenom('sats');
    FakePc.made = [];
    const b = engine();
    await b.e.receive(msg(400, { media: 'audio', sdp: 'v=0 offer' }), OWN);
    await b.e.accept(QUOTE);
    expect(b.last().phase).toBe('connecting');
    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS);
    expect(b.last()).toMatchObject({ phase: 'ended', reason: 'failed' });
    expect(FakePc.made[0].closed).toBe(true);
  });
});

// ---- the shell: price before calling, ring card, thread stays chat-only ----

const paired: PairingView = { state: 'paired', scopes: ['read', 'receive', 'spend'], short_code: 'ABCD-EFGH', code_from_node: true, reason: null, remote: false, bootstrap: null };
const openBudget = (): BudgetView => ({
  paused: false, waiting_for_owner: false, ceiling_msat: 500_000, max_daily_msat: 100_000_000, spent_msat: 0, unsettled_msat: 0,
  preset: 'careful', presets: [{ id: 'careful', contact_msat: 50_000, room_msat: 100_000, ceiling_msat: 500_000 }],
  rows: [{ target: A, room: false, limit_msat: 50_000, spent_msat: 0 }],
  autopay: { state: 'open', open_until_ms: Date.now() + 86_400_000, ceiling_msat: 500_000, basis: 'node_grant' },
  window_ms: 600_000, node_grant: null,
});

type Reply = (args?: Record<string, unknown>) => unknown;
function stubHost(overrides: Record<string, Reply> = {}) {
  resetContactsForTests();
  setPetname(A, 'Maya');
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const callbacks = new Map<number, (e: unknown) => void>();
  const spend: SpendView = { state: 'locked', basis: null, open_until_ms: null, pending: null, window_ms: 600_000 };
  const REPLIES: Record<string, Reply> = {
    node_status: () => ({ ready: true, node_id: OWN, error: null }),
    trust_acknowledge: () => true,
    pairing_status: () => paired,
    node_overview: () => ({ node_id: OWN, status: 'ok', version: 'api v2', connected_peers: 1, e2ee_sessions: 1, pending_deliveries: 0,
      lightning_available: true, block_height: 1, uptime_secs: 1, lightning_backend: 'ldk', chain_backend: 'esplora', read_at: Date.now() }),
    peers_list: () => [{ node_id: A, addr: null, label: 'Maya', connected: true, fingerprint: null }],
    rooms_list: () => [],
    messages_list: (args) => (args!.peer === A
      ? [
          { id: 'chat-1', kind: 0, sender: A, recipient: OWN, timestamp: Date.now() - 5000, plaintext: 'hello', payment_amount_msat: 2000 },
          { id: 'call-1', kind: 400, sender: A, recipient: OWN, timestamp: Date.now() - 4000, plaintext: JSON.stringify({ v: 1, call_id: ID, media: 'audio', sdp: 'v=0' }), payment_amount_msat: 10_000 },
          // A paid minute block (M6, kind 404) is call traffic too, never a chat bubble.
          { id: 'block-1', kind: 404, sender: OWN, recipient: A, timestamp: Date.now() - 3000, plaintext: JSON.stringify({ call_id: ID, seq: 0 }), payment_amount_msat: 10_000 },
        ]
      : []),
    price_quote: () => ({ kind: 0, own_msat: 1000, peer_msat: 2000, peer_age_secs: 30, max_routing_fee_msat: 0, peer_stale: false }),
    payments_overview: () => ({ balance_msat: 1_000_000, lightning_outbound_msat: 500_000, channels: [] }),
    fund_state: () => null,
    file_price: () => ({ principal_msat: 3000, max_routing_fee_msat: 5000, total_msat: 8000 }),
    spend_status: () => spend,
    budget_status: () => openBudget(),
    call_quote: () => QUOTE,
    call_signal: (args) => ({ message_id: 'sig', kind: args!.kind, amount_msat: 10_000, total_msat: 15_000, max_routing_fee_msat: 5000, delivered: true, accepted: true, sent_at_ms: Date.now() }),
    // H2: the host ends our admission with one paid hangup.
    op_end_call: (args) => ({ op_id: `end-${args!.call_id}`, kind: 'call_hangup', peer: A, call_id: args!.call_id, state: 'settled', cap_msat: 6_000, paid_msat: 6_000, message_id: 'hangup' }),
    op_list: () => ({ operations: [], skipped: 0, has_more: false }),
    live_link: () => null,
    'plugin:event|listen': () => 1,
    'plugin:event|unlisten': () => null,
    ...overrides,
  };
  vi.stubGlobal('__TAURI_INTERNALS__', {
    transformCallback: (cb: (e: unknown) => void) => { const id = callbacks.size + 1; callbacks.set(id, cb); return id; },
    invoke: (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      const reply = REPLIES[cmd];
      if (!reply) return Promise.reject(new Error(`unexpected ${cmd}`));
      try { return Promise.resolve(reply(args)); } catch (e) { return Promise.reject(e); }
    },
  });
  vi.stubGlobal('__TAURI_EVENT_PLUGIN_INTERNALS__', { unregisterListener: () => {} });
  return {
    used: (cmd: string) => calls.filter((c) => c.cmd === cmd),
    emitLive: (payload: LiveEvent) => {
      const listen = calls.find((c) => c.cmd === 'plugin:event|listen');
      callbacks.get(listen!.args!.handler as number)!({ event: 'node-live', id: 1, payload });
    },
  };
}

describe('calls in the shell', () => {
  let dispose: (() => void) | undefined;
  let mount: HTMLElement;
  beforeEach(() => {
    setStunPref('');
    setDenom('sats');
    FakePc.made = [];
    vi.stubGlobal('RTCPeerConnection', FakePc);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async (c: MediaStreamConstraints) => stream(!!c.video) } });
  });
  afterEach(() => {
    setLanguagePref('en');
    dispose?.();
    dispose = undefined;
    mount?.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const $ = <T extends Element = HTMLElement>(sel: string) => mount.querySelector<T>(sel);
  // Call and Video call ask first; Ring places the call.
  const ring = (media: 'audio' | 'video') => {
    $<HTMLButtonElement>(`[data-call="${media}"]`)!.click();
    $<HTMLButtonElement>(`[data-call-confirm="${media}"]`)?.click();
  };
  const text = (sel: string) => $(sel)?.textContent ?? '';
  async function openShell() {
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => <App />, mount);
    await vi.waitFor(() => expect([...mount.querySelectorAll('button')].some((b) => b.hasAttribute('data-trust-continue'))).toBe(true));
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.hasAttribute('data-trust-continue'))!.click();
    await vi.waitFor(() => expect($(`[data-track="peer:${A}"]`)?.getAttribute('aria-current')).toBe('true'));
  }

  const LN = '02' + 'b'.repeat(64);
  const spending = (): SpendView => ({ state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 600_000, pending: null, window_ms: 600_000 });
  const payHost = (over: Record<string, Reply> = {}) => stubHost({
    peers_list: () => [{ node_id: A, ln_pubkey: LN, addr: null, label: 'Maya', connected: true, fingerprint: null }],
    spend_status: spending,
    payment_keysend: () => ({ method: 'keysend', amount_msat: 5000, max_routing_fee_msat: 5000, status: 'settled', paid_at_ms: Date.now() }),
    ...over,
  });
  async function liveCall() {
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    ring('audio');
    await vi.waitFor(() => expect($('[data-call-panel="ringing"]')).not.toBeNull());
    expect($('[data-call-pay]')).toBeNull();
    FakePc.made[0].connect();
    await vi.waitFor(() => expect($('[data-call-panel="live"]')).not.toBeNull());
  }

  it.each(['en', 'da'] as const)('a refused recovery offer keeps budget replacement out of the live call (%s)', async lang => {
    let offers = 0;
    const host = payHost({ call_signal: (args) => {
      if (args!.kind === 400 && ++offers === 2) throw { code: 'grant_exhausted', message: 'Recovery exceeds the remaining grant.' };
      return { message_id: 'sig', kind: args!.kind, amount_msat: 10_000, total_msat: 15_000, max_routing_fee_msat: 5000, delivered: true, accepted: true, sent_at_ms: Date.now() };
    } });
    await liveCall();
    setLanguagePref(lang);
    const pc = FakePc.made[0];
    const callId = JSON.parse(host.used('call_signal')[0].args!.plaintext as string).call_id;
    host.emitLive({ type: 'message', room_id: null, message: msg(401, { call_id: callId, sdp: 'v=0 answer' }) });
    await vi.waitFor(() => expect(pc.remote).not.toBeNull());
    vi.useFakeTimers();
    pc.state('failed');
    await vi.advanceTimersByTimeAsync(0);
    expect(host.used('call_signal').filter(c => c.args!.kind === 400)).toHaveLength(2);
    expect(text('[data-call-panel="reconnecting"]')).toContain('Recovery exceeds the remaining grant.');
    expect($('[data-call-budget-request]')).toBeNull();
    expect($('[data-call-approval]')).toBeNull();
    expect(host.used('spend_request')).toHaveLength(0);
    pc.connect();
    expect($('[data-call-panel="live"]')).not.toBeNull();
    $<HTMLButtonElement>('[data-call-hangup]')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.used('op_end_call')).toHaveLength(1);
    expect($('[data-call-panel="ended"]')).not.toBeNull();
    expect(host.used('spend_request')).toHaveLength(0);
  });
  function enterCallAmount(value = '5') {
    $<HTMLButtonElement>('[data-call-pay]')!.click();
    const input = $<HTMLInputElement>('[data-in-call-pay] [data-pay-amount]')!;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('in-call Pay binds the contact, shows the fee cap, and consumes one confirm without touching the call', async () => {
    let finish!: (value: unknown) => void;
    const host = payHost({ payment_keysend: () => new Promise(resolve => { finish = resolve; }) });
    await liveCall();
    const pc = FakePc.made[0];
    const media = $('[data-call-media="remote"]');
    enterCallAmount();
    expect(text('[data-in-call-pay]')).toContain('Maya');
    expect(text('[data-call-pay-total]')).toContain('10');
    expect(text('[data-call-pay-fee]')).toContain('5');
    expect(host.used('payment_keysend')).toHaveLength(0);
    const confirm = $<HTMLButtonElement>('[data-call-pay-confirm]')!;
    confirm.click(); confirm.click();
    await vi.waitFor(() => expect(host.used('payment_keysend')).toHaveLength(1));
    expect(host.used('payment_keysend')[0].args).toEqual({ dest_pubkey: LN, amount_msat: 5000, memo: null, max_msat: 10000 });
    expect(text('[data-call-pay-status]')).toMatch(/sending/i);
    expect(pc.closed).toBe(false);
    expect($('[data-call-media="remote"]')).toBe(media);
    expect(host.used('op_end_call')).toHaveLength(0);
    expect(host.used('op_close_call')).toHaveLength(0);
    expect(host.used('call_signal')).toHaveLength(1);
    finish({ method: 'keysend', amount_msat: 5000, max_routing_fee_msat: 5000, status: 'settled', paid_at_ms: Date.now() });
    await vi.waitFor(() => expect(text('[data-call-pay-status]')).toMatch(/sent/i));
    expect($('[data-call-panel="live"]')).not.toBeNull();
    expect(text('[data-call-paid]')).toContain('15');
    $<HTMLButtonElement>('[data-call-hangup]')!.click();
    await vi.waitFor(() => expect(host.used('op_end_call')).toHaveLength(1));
    expect(text('[data-call-pay-status]')).toMatch(/sent/i);
  });

  it('in-call Pay keeps the amount through approval and requires a separate explicit payment tap', async () => {
    let approved = false;
    const host = payHost({
      spend_status: () => approved ? spending() : { state: 'locked', basis: null, open_until_ms: null, pending: null, window_ms: 600_000 },
      spend_request: () => { approved = true; return spending(); },
    });
    await liveCall();
    enterCallAmount();
    expect($<HTMLButtonElement>('[data-call-pay-confirm]')!.disabled).toBe(true);
    $<HTMLButtonElement>('[data-call-pay-approve]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-pay-confirm]')!.disabled).toBe(false));
    expect(host.used('payment_keysend')).toHaveLength(0);
    expect($<HTMLInputElement>('[data-in-call-pay] [data-pay-amount]')!.value).toBe('5');
    $<HTMLButtonElement>('[data-call-pay-confirm]')!.click();
    await vi.waitFor(() => expect(text('[data-call-pay-status]')).toMatch(/sent/i));
  });

  it.each([null, A, '04' + 'b'.repeat(64)])('in-call Pay refuses an absent or invalid Lightning mapping: %s', async (ln) => {
    const host = payHost({ peers_list: () => [{ node_id: A, ln_pubkey: ln, label: 'Maya', connected: true }] });
    await liveCall();
    expect($<HTMLButtonElement>('[data-call-pay]')!.disabled).toBe(true);
    expect(text('[data-in-call-pay]')).toMatch(/Lightning.*unavailable/i);
    expect(host.used('payment_keysend')).toHaveLength(0);
  });

  it.each(['0', '0.0001', '100000001', 'abc'])('in-call Pay rejects invalid amount %s', async (amount) => {
    const host = payHost();
    await liveCall(); enterCallAmount(amount);
    expect($<HTMLButtonElement>('[data-call-pay-confirm]')!.disabled).toBe(true);
    expect(host.used('payment_keysend')).toHaveLength(0);
  });

  it.each([
    ['failed', /Payment of 5 sats failed.*No amount or routing fee was paid/i], ['inflight', /not confirmed|unknown/i],
    ['spend_unknown', /unknown/i], ['not_dispatched', /not sent|failed/i],
  ])('in-call Pay reports %s honestly and leaves the call live', async (status, words) => {
    const host = payHost({ payment_keysend: () => {
      if (status.includes('_')) throw { code: status, message: 'Check the payment result.' };
      return { method: 'keysend', amount_msat: 5000, max_routing_fee_msat: 5000, status, paid_at_ms: Date.now() };
    } });
    await liveCall(); enterCallAmount();
    $<HTMLButtonElement>('[data-call-pay-confirm]')!.click();
    await vi.waitFor(() => expect(text('[data-call-pay-status]')).toMatch(words));
    expect($('[data-call-panel="live"]')).not.toBeNull();
    expect(host.used('call_signal')).toHaveLength(1);
    expect(host.used('op_end_call')).toHaveLength(0);
    expect(FakePc.made[0].closed).toBe(false);
  });

  it('in-call Pay cannot dispatch after hangup or while another spend is pending', async () => {
    const host = payHost({ budget_status: () => ({ ...openBudget(), unsettled_msat: 1000 }) });
    await liveCall();
    expect($<HTMLButtonElement>('[data-call-pay]')!.disabled).toBe(true);
    $<HTMLButtonElement>('[data-call-hangup]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect($('[data-call-pay]')).toBeNull();
    expect(host.used('payment_keysend')).toHaveLength(0);
  });

  it('in-call Pay drops a draft on hangup and retains a late receipt on the ended card', async () => {
    let finish!: (v: unknown) => void;
    const host = payHost({ payment_keysend: () => new Promise(resolve => { finish = resolve; }) });
    await liveCall(); enterCallAmount();
    $<HTMLButtonElement>('[data-call-pay-confirm]')!.click();
    await vi.waitFor(() => expect(finish).toBeDefined());
    $<HTMLButtonElement>('[data-call-hangup]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect($('[data-call-pay-confirm]')).toBeNull();
    finish({ method: 'keysend', amount_msat: 5000, max_routing_fee_msat: 5000, status: 'settled', paid_at_ms: Date.now() });
    await vi.waitFor(() => expect(text('[data-call-pay-status]')).toMatch(/sent/i));
    expect($('[data-call-panel="live"]')).toBeNull();
    expect(host.used('payment_keysend')).toHaveLength(1);
  });

  it('hangup tears down media when the host refuses closure during a pending keysend', async () => {
    let finish!: (v: unknown) => void;
    const host = payHost({
      payment_keysend: () => new Promise(resolve => { finish = resolve; }),
      op_end_call: () => { throw { code: 'spend_unknown', message: 'Check the pending payment.' }; },
    });
    await liveCall(); enterCallAmount();
    $<HTMLButtonElement>('[data-call-pay-confirm]')!.click();
    await vi.waitFor(() => expect(finish).toBeDefined());
    $<HTMLButtonElement>('[data-call-hangup]')!.click();
    await vi.waitFor(() => expect(host.used('op_end_call')).toHaveLength(1));
    await vi.waitFor(() => expect(text('[data-call-close]')).toMatch(/unknown|pending/i));
    expect(FakePc.made[0].closed).toBe(true);
    expect($('[data-call-panel="ended"]')).not.toBeNull();
    expect($('[data-call-again]')).toBeNull();
    finish({ method: 'keysend', amount_msat: 5000, max_routing_fee_msat: 5000, status: 'settled', paid_at_ms: Date.now() });
    await vi.waitFor(() => expect(text('[data-call-pay-status]')).toMatch(/sent/i));
    expect($('[data-call-panel="live"]')).toBeNull();
    expect(host.used('op_end_call')).toHaveLength(1);
    expect(host.used('payment_keysend')).toHaveLength(1);
    expect(host.used('call_signal')).toHaveLength(1);
  });

  it('wallet reconciliation re-enables in-call Pay without an automatic payment', async () => {
    let resolved = false;
    let pending = false;
    const host = payHost({
      budget_status: () => ({ ...openBudget(), unsettled_msat: pending ? 10000 : 0 }),
      payment_keysend: () => { pending = true; return ({ method: 'keysend', amount_msat: 5000, max_routing_fee_msat: 5000, status: 'inflight', paid_at_ms: Date.now() }); },
      spend_reconcile: () => { if (!resolved) throw { code: 'spend_unknown', message: 'Still pending.' }; pending = false; return 'Payment settled; the pending slot is clear.'; },
    });
    await liveCall(); enterCallAmount();
    $<HTMLButtonElement>('[data-call-pay-confirm]')!.click();
    await vi.waitFor(() => expect($('[data-call-pay-status="unknown"]')).not.toBeNull());
    $<HTMLButtonElement>('[data-profile]')!.click();
    $<HTMLButtonElement>('[data-open-wallet]')!.click();
    await vi.waitFor(() => expect($('[data-wallet-tab="send"]')).not.toBeNull());
    $<HTMLButtonElement>('[data-wallet-tab="send"]')!.click();
    await vi.waitFor(() => expect($('[data-wallet-page] [data-spend-reconcile]')).not.toBeNull());
    $<HTMLButtonElement>('[data-wallet-page] [data-spend-reconcile]')!.click();
    await vi.waitFor(() => expect(text('[data-wallet-page] [data-reconciliation]')).toContain('Still pending'));
    expect($<HTMLButtonElement>('[data-call-pay]')!.disabled).toBe(true);
    resolved = true;
    $<HTMLButtonElement>('[data-wallet-page] [data-spend-reconcile]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-pay]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-wallet-close]')!.click();
    expect(text('[data-call-pay-status]')).toContain('Payment settled');
    expect(host.used('payment_keysend')).toHaveLength(1);
    enterCallAmount('7');
    expect(host.used('payment_keysend')).toHaveLength(1);
    $<HTMLButtonElement>('[data-call-pay-confirm]')!.click();
    await vi.waitFor(() => expect(host.used('payment_keysend')).toHaveLength(2));
    expect(host.used('op_end_call')).toHaveLength(0);
  });

  it.each(['wallet', 'call'])('a delayed %s check cannot clear a newer unknown in-call payment', async (first) => {
    let pending = false;
    let checks = 0;
    let finishOld!: (text: string) => void;
    const host = payHost({
      budget_status: () => ({ ...openBudget(), unsettled_msat: pending ? 10000 : 0 }),
      payment_keysend: () => { pending = true; return { method: 'keysend', amount_msat: 5000, max_routing_fee_msat: 5000, status: 'inflight', paid_at_ms: Date.now() }; },
      spend_reconcile: () => ++checks === 1 ? new Promise<string>(resolve => { finishOld = resolve; }) : (pending = false, 'First payment checked.'),
    });
    await liveCall(); enterCallAmount();
    $<HTMLButtonElement>('[data-call-pay-confirm]')!.click();
    await vi.waitFor(() => expect($('[data-call-pay-status="unknown"]')).not.toBeNull());
    const openWallet = async () => {
      $<HTMLButtonElement>('[data-profile]')!.click();
      $<HTMLButtonElement>('[data-open-wallet]')!.click();
      await vi.waitFor(() => expect($('[data-wallet-page] [data-spend-reconcile]')).not.toBeNull());
    };
    if (first === 'wallet') await openWallet();
    $<HTMLButtonElement>(first === 'wallet' ? '[data-wallet-page] [data-spend-reconcile]' : '[data-in-call-pay] [data-spend-reconcile]')!.click();
    await vi.waitFor(() => expect(finishOld).toBeDefined());
    if (first === 'wallet') $<HTMLButtonElement>('[data-wallet-close]')!.click();
    else await openWallet();
    $<HTMLButtonElement>(first === 'wallet' ? '[data-in-call-pay] [data-spend-reconcile]' : '[data-wallet-page] [data-spend-reconcile]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-pay]')!.disabled).toBe(false));
    if (first === 'call') $<HTMLButtonElement>('[data-wallet-close]')!.click();
    enterCallAmount();
    $<HTMLButtonElement>('[data-call-pay-confirm]')!.click();
    await vi.waitFor(() => expect($('[data-call-pay-status="unknown"]')).not.toBeNull());
    finishOld('Old payment settled.');
    // Drain the deferred IPC completion and Solid effects in this event-loop turn.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect($('[data-call-pay-status="unknown"]')).not.toBeNull();
    expect(text('[data-call-pay-status]')).not.toContain('Old payment');
    expect($<HTMLButtonElement>('[data-call-pay]')!.disabled).toBe(true);
    expect(host.used('payment_keysend')).toHaveLength(2);
  });

  it('after hanging up, "nothing more is paid" shows only once the hangup has settled, in English and Danish', async () => {
    let finish!: (value: unknown) => void;
    const host = stubHost({ op_end_call: (args) => new Promise((resolve) => { finish = () => resolve({ op_id: `end-${args!.call_id}`, kind: 'call_hangup', peer: A, call_id: args!.call_id, state: 'settled', cap_msat: 6_000, paid_msat: 6_000, message_id: 'hangup' }); }) });
    await liveCall();
    $<HTMLButtonElement>('[data-call-hangup]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    await vi.waitFor(() => expect(host.used('op_end_call')).toHaveLength(1));
    // The end is still with the host: never "nothing more".
    expect($('[data-call-close="closing"]')).not.toBeNull();
    expect($('[data-call-nothing-more]')).toBeNull();
    finish(null);
    await vi.waitFor(() => expect($('[data-call-nothing-more]')).not.toBeNull());
    expect($('[data-call-close]')).toBeNull();
    expect($('[data-call-paid="pending"]')).toBeNull();
    expect(text('[data-call-nothing-more]')).toBe('The call is over. Nothing more is paid for it.');
    try {
      setLanguagePref('da');
      expect(text('[data-call-nothing-more]')).toBe('Opkaldet er slut. Der betales ikke mere for det.');
    } finally { setLanguagePref('en'); }
  });

  it('before the host has started ending the call (its closure still being recorded), never "nothing more is paid"', async () => {
    const host = stubHost({
      call_signal: (args) => ({ operation_id: args!.kind === 400 ? 'offer-op' : null, message_id: 'sig', kind: args!.kind, amount_msat: 10_000, total_msat: 15_000, max_routing_fee_msat: 5000, delivered: true, accepted: true, sent_at_ms: Date.now() }),
      op_close_call: () => new Promise(() => {}),
    });
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    vi.useFakeTimers();
    ring('audio');
    await vi.waitFor(() => expect($('[data-call-panel="ringing"]')).not.toBeNull());
    await vi.advanceTimersByTimeAsync(RING_MS + 1);
    vi.useRealTimers();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    await vi.waitFor(() => expect(host.used('op_close_call')).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 300));
    // The closure is still being recorded, so the paid end has not started.
    expect(host.used('op_end_call')).toHaveLength(0);
    expect($('[data-call-nothing-more]')).toBeNull();
  });

  it('a refused end at the host never says "nothing more is paid"', async () => {
    stubHost({ op_end_call: () => { throw { code: 'call_end_refused', message: 'The node did not end it.' }; } });
    await liveCall();
    $<HTMLButtonElement>('[data-call-hangup]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    await vi.waitFor(() => expect($('[data-call-close]')).not.toBeNull());
    await new Promise((r) => setTimeout(r, 50));
    expect($('[data-call-nothing-more]')).toBeNull();
  });

  it('a muted call says in words that they cannot hear you, in English and Danish, and the line goes on unmute', async () => {
    payHost();
    await liveCall();
    expect($('[data-call-mic-off]')).toBeNull();
    $<HTMLButtonElement>('[data-call-mute]')!.click();
    await vi.waitFor(() => expect($('[data-call-mic-off]')).not.toBeNull());
    expect(text('[data-call-mic-off]')).toBe('Your microphone is off. They cannot hear you. Press Mute again to talk.');
    expect($('[data-call-camera-off]')).toBeNull();
    try {
      setLanguagePref('da');
      expect(text('[data-call-mic-off]')).toBe('Din mikrofon er slukket. De kan ikke høre dig. Tryk Slå lyd fra igen for at tale.');
      expect(text('[data-call-mute]')).toBe('Slå lyd fra');
    } finally { setLanguagePref('en'); }
    $<HTMLButtonElement>('[data-call-mute]')!.click();
    await vi.waitFor(() => expect($('[data-call-mic-off]')).toBeNull());
  });

  it.each(['unit', 'language'])('in-call Pay clears a rejected Danish draft on %s change', async change => {
    const host = payHost();
    await liveCall();
    try {
      setLanguagePref('da');
      enterCallAmount('1.000');
      if (change === 'unit') setDenom('btc'); else setLanguagePref('en');
      expect($<HTMLInputElement>('[data-in-call-pay] [data-pay-amount]')!.value).toBe('');
      expect($('[data-in-call-pay] [data-amount-cleared]')).not.toBeNull();
      expect($<HTMLButtonElement>('[data-call-pay-confirm]')!.disabled).toBe(true);
      $<HTMLButtonElement>('[data-call-pay-confirm]')!.click();
      expect(host.used('payment_keysend')).toHaveLength(0);
    } finally { setLanguagePref('en'); }
  });

  it('in-call Pay clears the typed amount when the denomination changes', async () => {
    const host = payHost();
    await liveCall(); enterCallAmount();
    setDenom('btc');
    await vi.waitFor(() => expect($<HTMLInputElement>('[data-in-call-pay] [data-pay-amount]')!.value).toBe(''));
    expect($<HTMLButtonElement>('[data-call-pay-confirm]')!.disabled).toBe(true);
    expect(host.used('payment_keysend')).toHaveLength(0);
  });

  it('in-call Pay stays fenced on an unresolved check and permits a new explicit payment after reconciliation', async () => {
    let resolved = false;
    const host = payHost({
      payment_keysend: () => ({ method: 'keysend', amount_msat: 5000, max_routing_fee_msat: 5000, status: 'inflight', paid_at_ms: Date.now() }),
      spend_reconcile: () => { if (!resolved) throw { code: 'spend_unknown', message: 'Still pending.' }; return 'Payment settled; the pending slot is clear.'; },
    });
    await liveCall(); enterCallAmount();
    $<HTMLButtonElement>('[data-call-pay-confirm]')!.click();
    await vi.waitFor(() => expect($('[data-call-pay-status="unknown"]')).not.toBeNull());
    $<HTMLButtonElement>('[data-in-call-pay] [data-spend-reconcile]')!.click();
    await vi.waitFor(() => expect(text('[data-in-call-pay] [data-reconciliation]')).toContain('Still pending'));
    expect($<HTMLButtonElement>('[data-call-pay]')!.disabled).toBe(true);
    resolved = true;
    $<HTMLButtonElement>('[data-in-call-pay] [data-spend-reconcile]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-pay]')!.disabled).toBe(false));
    expect(text('[data-call-pay-status]')).toContain('Payment settled');
    expect(host.used('payment_keysend')).toHaveLength(1);
    expect(host.used('op_end_call')).toHaveLength(0);
    enterCallAmount('7');
    expect(host.used('payment_keysend')).toHaveLength(1);
  });

  it('in-call Pay preserves the amount when muting the same live call', async () => {
    payHost();
    await liveCall(); enterCallAmount('7');
    $<HTMLButtonElement>('[data-call-mute]')!.click();
    expect($<HTMLButtonElement>('[data-call-mute]')!.getAttribute('aria-pressed')).toBe('true');
    expect($<HTMLInputElement>('[data-in-call-pay] [data-pay-amount]')!.value).toBe('7');
    expect($<HTMLButtonElement>('[data-call-pay-confirm]')!.disabled).toBe(false);
  });

  it('shows approval before dialling when the paired token lacks spend, and permits an explicit retry after approval', async () => {
    const capture = vi.spyOn(navigator.mediaDevices, 'getUserMedia');
    let approved = false;
    const host = stubHost({
      pairing_status: () => ({ ...paired, scopes: approved ? paired.scopes : ['read', 'receive'] }),
      spend_request: () => {
        approved = true;
        return { state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 600_000, pending: null, window_ms: 600_000 };
      },
    });
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    ring('audio');
    await vi.waitFor(() => expect($('[data-call-approval]')).not.toBeNull());
    expect($('[data-call-panel="calling"]')).toBeNull();
    expect(capture).not.toHaveBeenCalled();
    expect(host.used('call_signal')).toHaveLength(0);
    $<HTMLButtonElement>('[data-call-approve]')!.click();
    await vi.waitFor(() => expect(host.used('spend_request')).toHaveLength(1));
    expect(host.used('call_signal')).toHaveLength(0);
    ring('audio');
    await vi.waitFor(() => expect($('[data-call-panel="ringing"]')).not.toBeNull());
    expect(host.used('call_signal')).toHaveLength(1);
  });

  it('call approval waiting on a node command (remote, Touch ID not set up): the offer says what is true for a call', async () => {
    const host = stubHost({
      pairing_status: () => ({ ...paired, remote: true, scopes: ['read', 'receive'] }),
      device_key_status: () => ({ available: true, state: 'none', fingerprint: null, owner_action: null, expires_at_ms: null }),
      spend_status: () => ({ state: 'pending', basis: null, open_until_ms: null, window_ms: 600_000,
        pending: { op_id: 'ab01', expires_at_ms: Date.now() + 600_000, owner_action: 'konsensus grant --op ab01', owner_can_grant: true } }),
    });
    await openShell();
    await vi.waitFor(() => expect($('[data-call="audio"]')!.getAttribute('aria-label')).toMatch(/^Call Maya/));
    ring('audio');
    await vi.waitFor(() => expect($('[data-call-approval] [data-touch-id-first]')).not.toBeNull());
    const stays = $('[data-call-approval] [data-touch-id-stays-text="spend"]')!;
    expect(stays.textContent).toContain('Nothing is paid until you press Call or Accept again after approval.');
    expect($('[data-call-approval]')!.textContent).not.toMatch(/press Send/);
    expect(host.used('call_signal')).toHaveLength(0);
  });

  it('shows the permission timeout on the call card and never submits an offer', async () => {
    const host = stubHost();
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockImplementation(() => new Promise(() => {}));
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="video"]')!.disabled).toBe(false));
    vi.useFakeTimers();
    try {
      ring('video');
      await vi.advanceTimersByTimeAsync(15_000);
      expect(text('[data-call-ended]')).toContain('Camera/microphone not available — check System Settings → Privacy');
      expect(host.used('call_signal')).toEqual([]);
      expect($('[data-call-panel="calling"]')).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it.each(['token lacks spend scope', { code: 'spend_refused', message: '403: token lacks required scope: spend' }])('shows approval when permission preflight refuses: %s', async (error) => {
    let refuse = false;
    const capture = vi.spyOn(navigator.mediaDevices, 'getUserMedia');
    const host = stubHost({ pairing_status: () => { if (refuse) throw error; return paired; } });
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    refuse = true;
    ring('audio');
    await vi.waitFor(() => expect($('[data-call-approval]')).not.toBeNull());
    expect(text('[data-call-approval]')).toContain(typeof error === 'string' ? error : error.message);
    expect(capture).not.toHaveBeenCalled();
    expect(host.used('call_signal')).toEqual([]);
  });

  /** Settings → Node → the connection card's "Last call" line, then back to the chat. */
  async function lastCallLine() {
    $<HTMLButtonElement>('[data-profile]')!.click();
    await vi.waitFor(() => expect($('[data-open-settings]')).not.toBeNull());
    $<HTMLButtonElement>('[data-open-settings]')!.click();
    await vi.waitFor(() => expect($('[data-tab="node"]')).not.toBeNull());
    $<HTMLButtonElement>('[data-tab="node"]')!.click();
    await vi.waitFor(() => expect($('[data-connection-line="5"]')).not.toBeNull());
    const line = text('[data-connection-line="5"]');
    $<HTMLButtonElement>('[data-settings-close]')!.click();
    return line;
  }

  it('the connection card describes the latest call: its route when it connected, "no route" when a later one did not', async () => {
    let refuse = false;
    stubHost({ call_signal: (args) => {
      if (refuse) throw { code: 'spend_refused', message: 'Owner grant required.' };
      return { message_id: 'sig', kind: args!.kind, amount_msat: 1000, total_msat: 6000, max_routing_fee_msat: 5000, delivered: true, accepted: true, sent_at_ms: Date.now() };
    } });
    await openShell();
    expect(await lastCallLine()).toBe('Last call: no call yet');
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    ring('audio');
    await vi.waitFor(() => expect($('[data-call-panel="ringing"]')).not.toBeNull());
    const pc = FakePc.made[0];
    pc.stats = new Map([
      ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
      ['pair', { type: 'candidate-pair', localCandidateId: 'local', remoteCandidateId: 'remote' }],
      ['local', { type: 'local-candidate', candidateType: 'srflx' }],
      ['remote', { type: 'remote-candidate', candidateType: 'host' }],
    ]);
    pc.connect();
    await vi.waitFor(() => expect(text('[data-call-connection]')).toContain('srflx(STUN)'));
    $<HTMLButtonElement>('[data-call-hangup]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-dismiss]')!.disabled).toBe(false));
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-dismiss]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-dismiss]')!.click();
    expect(await lastCallLine()).toBe('Last call: srflx (this device) / host (theirs)');
    // A later call is refused before it connects: the card says so, not the earlier route.
    refuse = true;
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    ring('audio');
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-dismiss]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-dismiss]')!.click();
    expect(await lastCallLine()).toBe('Last call: no route (it didn’t connect)');
  });

  it('a call that went live with no stats read is "connected, route unavailable"; a later call refused before it starts is "didn\'t connect"', async () => {
    let small = false;
    stubHost({
      call_signal: (args) => ({ message_id: 'sig', kind: args!.kind, amount_msat: 1000, total_msat: 6000, max_routing_fee_msat: 5000, delivered: true, accepted: true, sent_at_ms: Date.now() }),
      // Later, the node grant has too little left for a call: place() refuses before the call has an id.
      budget_status: () => ({ ...openBudget(), ...(small ? { node_grant: { expires_at_ms: Date.now() + 86_400_000, budget_msat: 200_000, remaining_msat: 1000, per_call_max_msat: 1000 } } : {}) }),
    });
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    ring('audio');
    await vi.waitFor(() => expect($('[data-call-panel="ringing"]')).not.toBeNull());
    // No stats ever name a pair (an empty report), but the call goes live.
    FakePc.made[0].stats = new Map();
    FakePc.made[0].connect();
    await vi.waitFor(() => expect($('[data-call-panel="live"]')).not.toBeNull());
    $<HTMLButtonElement>('[data-call-hangup]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-dismiss]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-dismiss]')!.click();
    expect(await lastCallLine()).toBe('Last call: connected, route unavailable');
    small = true;
    await new Promise((r) => setTimeout(r, 3500));
    ring('audio');
    await vi.waitFor(() => expect(text('[data-call-ended]')).toMatch(/This call needs up to/));
    expect(FakePc.made).toHaveLength(1);
    $<HTMLButtonElement>('[data-call-dismiss]')!.click();
    expect(await lastCallLine()).toBe('Last call: no route (it didn’t connect)');
  }, 20_000);

  it('a first call that never connects is "no route", not "no call yet"', async () => {
    stubHost({ call_signal: () => { throw { code: 'spend_refused', message: 'Owner grant required.' }; } });
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    ring('audio');
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    $<HTMLButtonElement>('[data-call-dismiss]')!.click();
    expect(await lastCallLine()).toBe('Last call: no route (it didn’t connect)');
  });

  it('labels a six-sat maximum as a cap and retains the selected ICE route', async () => {
    stubHost({ call_signal: (args) => ({ message_id: 'sig', kind: args!.kind, amount_msat: 1000, total_msat: 6000, max_routing_fee_msat: 5000, delivered: true, accepted: true, sent_at_ms: Date.now() }) });
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    ring('audio');
    await vi.waitFor(() => expect($('[data-call-panel="ringing"]')).not.toBeNull());
    const pc = FakePc.made[0];
    pc.stats = new Map([
      ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
      ['pair', { type: 'candidate-pair', localCandidateId: 'local', remoteCandidateId: 'remote' }],
      ['local', { type: 'local-candidate', candidateType: 'srflx' }],
      ['remote', { type: 'remote-candidate', candidateType: 'host' }],
    ]);
    pc.connect();
    await vi.waitFor(() => expect(text('[data-call-connection]')).toContain('srflx(STUN)'));
    pc.state('closed');
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    // After the call: what it paid, as an upper bound (fees are not reported), never an exact "paid 6 sats".
    expect($('[data-call-paid]')!.getAttribute('data-call-paid')).toBe('settled');
    expect(text('[data-call-paid]')).toBe('This call paid up to 6 sats: each signal’s price plus its routing-fee cap; the exact fees are not reported. Media was not billed.');
    expect(text('[data-call-paid]')).not.toMatch(/paid 6 sats/i);
    expect(text('[data-call-connection]')).toContain('host');
  });

  it('refuses the full call ceiling against the grant remaining budget before media or signalling', async () => {
    const capture = vi.spyOn(navigator.mediaDevices, 'getUserMedia');
    const host = stubHost({
      call_quote: () => ({ ...QUOTE, call_total_msat: 21_205_000 }),
      budget_status: () => ({ ...openBudget(), node_grant: {
        expires_at_ms: Date.now() + 3600_000, budget_msat: 50_000_000,
        remaining_msat: 500_000, per_call_max_msat: 50_000_000,
      } }),
    });
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    ring('audio');
    await vi.waitFor(() => expect(text('[data-call-ended]')).toMatch(/owner.*approve/i));
    expect(text('[data-call-ended]')).toContain('21\u202f205 sats');
    expect(text('[data-call-ended]')).toContain('500 sats');
    expect(text('[data-call-ended]')).not.toMatch(/per call/i);
    expect(capture).not.toHaveBeenCalled();
    expect(FakePc.made).toHaveLength(0);
    expect(host.used('call_signal')).toHaveLength(0);
    expect(host.used('budget_approve')).toHaveLength(0);
  });

  it('dials when the call payments are above the 6-sat message cap but within the signed limit', async () => {
    // The node caps messages at 6 sats; each call payment is bounded by the signed limit instead.
    const host = stubHost({ budget_status: () => ({ ...openBudget(), node_grant: {
      expires_at_ms: Date.now() + 3600_000, budget_msat: 500_000,
      remaining_msat: 500_000, per_call_max_msat: 50_000,
      message_per_payment_max_msat: 6_000, call_per_payment_max_msat: 50_000,
    } }) });
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    ring('audio');
    await vi.waitFor(() => expect($('[data-call-panel="ringing"]')).not.toBeNull());
    expect(host.used('call_signal')).toHaveLength(1);
    expect(host.used('call_signal')[0].args).toMatchObject({ kind: 400 });
  });

  it.each([1_000, 5_999, 6_000, 6_001, 14_999])('refuses a call above the signed per-payment limit (%i msat) before media or signalling', async (perCall) => {
    // The signed value binds every call payment; exactly 6 sats is no exception.
    const capture = vi.spyOn(navigator.mediaDevices, 'getUserMedia');
    const host = stubHost({ budget_status: () => ({ ...openBudget(), node_grant: {
      expires_at_ms: Date.now() + 3600_000, budget_msat: 500_000,
      remaining_msat: 500_000, per_call_max_msat: perCall,
    } }) });
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    ring('audio');
    await vi.waitFor(() => expect(text('[data-call-ended]')).toMatch(/per payment/i));
    // The largest single payment is the 15-sat offer (the hangup is 6 sats).
    expect(text('[data-call-ended]')).toContain('15 sats per payment');
    expect(text('[data-call-ended]')).toMatch(/owner.*approve/i);
    expect(capture).not.toHaveBeenCalled();
    expect(FakePc.made).toHaveLength(0);
    expect(host.used('call_signal')).toHaveLength(0);
  });

  it('follows the node record of the owner call limit over the stored value', async () => {
    // An owner who chose exactly 6 sats binds calls; one who chose none does not.
    const refused = stubHost({ budget_status: () => ({ ...openBudget(), node_grant: {
      expires_at_ms: Date.now() + 3600_000, budget_msat: 500_000,
      remaining_msat: 500_000, per_call_max_msat: 6_000, call_per_payment_max_msat: 6_000,
    } }) });
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    ring('audio');
    await vi.waitFor(() => expect(text('[data-call-ended]')).toContain('15 sats per payment'));
    expect(refused.used('call_signal')).toHaveLength(0);
  });

  it('under a relation grant, a 15-sat offer and a 6-sat hangup each fit a 20-sat envelope', async () => {
    // The envelope's per-act maximum binds each payment on its own (the host
    // checks it); only the budgets bound their 21-sat sum.
    const host = stubHost({ budget_status: () => ({ ...openBudget(), node_grant: {
      expires_at_ms: Date.now() + 3600_000, budget_msat: 500_000,
      remaining_msat: 500_000, per_call_max_msat: 20_000,
      message_per_payment_max_msat: 6_000, call_per_payment_max_msat: null,
      envelopes: { [A]: Date.now() + 3600_000 },
    } }) });
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    ring('audio');
    await vi.waitFor(() => expect($('[data-call-panel="ringing"]')).not.toBeNull());
    expect(host.used('call_signal')).toHaveLength(1);
  });

  it('checks each call payment alone against an owner-chosen per-payment limit', async () => {
    // A 15-sat limit carries the 15-sat offer and the 6-sat hangup one at a
    // time, though the call needs 21 sats in all from the remaining budget.
    const host = stubHost({ budget_status: () => ({ ...openBudget(), node_grant: {
      expires_at_ms: Date.now() + 3600_000, budget_msat: 21_000,
      remaining_msat: 21_000, per_call_max_msat: 15_000,
    } }) });
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    ring('audio');
    await vi.waitFor(() => expect($('[data-call-panel="ringing"]')).not.toBeNull());
    expect(host.used('call_signal')).toHaveLength(1);
  });

  it('dials when the full ceiling equals both grant limits', async () => {
    const host = stubHost({ budget_status: () => ({ ...openBudget(), node_grant: {
      expires_at_ms: Date.now() + 3600_000, budget_msat: 21_000,
      remaining_msat: 21_000, per_call_max_msat: 21_000,
    } }) });
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    ring('audio');
    await vi.waitFor(() => expect($('[data-call-panel="ringing"]')).not.toBeNull());
    expect(host.used('call_signal')).toHaveLength(1);
    expect(host.used('call_signal')[0].args).toMatchObject({ kind: 400, max_msat: 15_000, max_hangup_msat: 6_000 });
  });

  it('shows a bounded node timeout in the shell and releases media', async () => {
    const host = stubHost({ call_signal: () => new Promise(() => {}) });
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    vi.useFakeTimers();
    try {
      ring('audio');
      await vi.advanceTimersByTimeAsync(30_001);
      expect(text('[data-call-ended]')).toMatch(/node did not answer.*outcome is unknown/i);
      expect($('[data-call-panel="calling"]')).toBeNull();
      expect(FakePc.made[0].closed).toBe(true);
      expect(host.used('call_signal')).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it('shows a host spend refusal and ends the call in the shell', async () => {
    stubHost({ call_signal: () => { throw { code: 'spend_refused', message: 'token lacks required scope: spend' }; }, op_end_call: () => { throw { code: 'call_not_found', message: 'No outgoing admission.' }; } });
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    ring('audio');
    // One plain line; the host's own words wait under Details.
    await vi.waitFor(() => expect(text('[data-call-ended]')).toBe('The call could not be placed.'));
    expect(text('[data-call-end-detail]')).toContain('token lacks required scope: spend');
    expect($('[data-call-panel="calling"]')).toBeNull();
    expect(FakePc.made[0].closed).toBe(true);
    // A refused offer paid nothing, and the ended panel says so.
    expect($('[data-call-paid]')!.getAttribute('data-call-paid')).toBe('nothing');
    expect(text('[data-call-paid]')).toBe('This call paid nothing.');
  });

  it('cancelling while the offer is in flight says it is settling, never "paid nothing", then shows what it paid', async () => {
    let land!: (r: unknown) => void;
    stubHost({ call_signal: () => new Promise((resolve) => { land = resolve; }) });
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    ring('audio');
    await vi.waitFor(() => expect(land).toBeDefined());
    $<HTMLButtonElement>('[data-call-hangup]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect($('[data-call-paid]')!.getAttribute('data-call-paid')).toBe('pending');
    expect(text('[data-call-paid]')).toBe('A payment for this call is still settling: up to 15 sats. The total updates when it finishes. Media was not billed.');
    expect($('[data-call-paid="nothing"]')).toBeNull();
    land({ message_id: 'sig', kind: 400, amount_msat: 10_000, total_msat: 15_000, max_routing_fee_msat: 5000, delivered: true, accepted: true, sent_at_ms: Date.now() });
    await vi.waitFor(() => expect($('[data-call-paid]')!.getAttribute('data-call-paid')).toBe('settled'));
    expect(text('[data-call-paid]')).toMatch(/^This call paid up to 21 sats:/);
  });

  it('declining sends and owes nothing: no hangup is paid, no "paid" line ever shows, and the card goes away', async () => {
    const host = stubHost({ messages_list: () => [] });
    await openShell();
    const seen: string[] = [];
    const watch = new MutationObserver((records) => records.forEach((r) => r.addedNodes.forEach((n) => {
      if (!(n instanceof Element)) return;
      [n, ...n.querySelectorAll('[data-call-paid]')].forEach((el) => { if (el.hasAttribute('data-call-paid')) seen.push(el.getAttribute('data-call-paid')!); });
    })));
    watch.observe(mount, { subtree: true, childList: true, attributes: true, characterData: true });
    host.emitLive({ type: 'message', room_id: null, message: { id: 'live-offer', kind: 400, sender: A, recipient: OWN, timestamp: Date.now(), plaintext: JSON.stringify({ v: 1, call_id: ID, media: 'audio', sdp: 'v=0 offer' }), payment_amount_msat: 10_000 } });
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-decline]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-decline]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="incoming"]')).toBeNull());
    watch.disconnect();
    expect(seen).toEqual([]);
    expect(host.used('call_signal')).toHaveLength(0);
    expect(host.used('op_end_call')).toHaveLength(0);
  });

  it.each(['call_id_used', 'call_busy', 'call_signal_in_flight', 'call_signal_invalid', 'call_not_live'])(
    'a hangup refused with %s keeps the paid offer total without an unknown payment', async (code) => {
      stubHost({ op_end_call: () => { throw { code, message: 'The node refused this call signal before payment. Nothing was paid.' }; }, call_signal: (args) => {
        return { message_id: 'sig', kind: args!.kind, amount_msat: 10_000, total_msat: 15_000, max_routing_fee_msat: 5000, delivered: true, accepted: true, sent_at_ms: Date.now() };
      } });
      await openShell();
      await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
      ring('audio');
      await vi.waitFor(() => expect($('[data-call-panel="ringing"]')).not.toBeNull());
      $<HTMLButtonElement>('[data-call-hangup]')!.click();
      await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
      await vi.waitFor(() => expect($('[data-call-paid]')?.getAttribute('data-call-paid')).toBe('settled'));
      expect(text('[data-call-paid]')).toMatch(/^This call paid up to 15 sats:/);
      expect(text('[data-call-paid]')).not.toMatch(/not known|check pending result/);
      expect($<HTMLButtonElement>('[data-call-dismiss]')!.disabled).toBe(false);
    },
  );

  it('a hangup lost in transport (not proven unpaid) is said as not known, not as paid nothing', async () => {
    stubHost({ op_end_call: () => { throw 'connection lost'; }, call_signal: (args) => {
      return { message_id: 'sig', kind: args!.kind, amount_msat: 10_000, total_msat: 15_000, max_routing_fee_msat: 5000, delivered: true, accepted: true, sent_at_ms: Date.now() };
    } });
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    ring('audio');
    await vi.waitFor(() => expect($('[data-call-panel="ringing"]')).not.toBeNull());
    $<HTMLButtonElement>('[data-call-hangup]')!.click();
    await vi.waitFor(() => expect($('[data-call-paid]')?.getAttribute('data-call-paid')).toBe('unknown'));
    expect(text('[data-call-paid]')).toMatch(/^This call paid up to 15 sats\. One signal’s result is not known yet/);
  });

  it('an ended call with an unknown hangup says so, and never folds it into what was paid', async () => {
    stubHost({ op_end_call: () => { throw { code: 'spend_unknown', message: 'The payment outcome is unknown.' }; }, call_signal: (args) => {
      return { message_id: 'sig', kind: args!.kind, amount_msat: 10_000, total_msat: 15_000, max_routing_fee_msat: 5000, delivered: true, accepted: true, sent_at_ms: Date.now() };
    } });
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    ring('audio');
    await vi.waitFor(() => expect($('[data-call-panel="ringing"]')).not.toBeNull());
    $<HTMLButtonElement>('[data-call-hangup]')!.click();
    await vi.waitFor(() => expect($('[data-call-paid]')?.getAttribute('data-call-paid')).toBe('unknown'));
    expect(text('[data-call-paid]')).toMatch(/^This call paid up to 15 sats\. One signal’s result is not known yet \(up to \d+ sats in all if it went through\): check pending result\. Media was not billed\.$/);
    expect(text('[data-call-paid]')).not.toMatch(/direct/);
  });

  it.each([['sats', '42.762 sats'], ['btc', '0.00000042762 BTC']] as const)('uses the %s denomination for a fractional call quote', async (denomination, shown) => {
    setDenom(denomination);
    stubHost({ call_quote: () => ({ ...QUOTE, call_total_msat: 21_381 }) });
    await openShell();
    await vi.waitFor(() => expect($('[data-call="audio"]')!.getAttribute('aria-label')).toBe(`Call Maya, up to ${shown}`));
    expect($('[data-call="video"]')!.getAttribute('title')).toContain(`Up to ${shown}:`);
  });

  it('shows the all-in call price before calling, then pays one offer at that ceiling', async () => {
    const host = stubHost();
    await openShell();
    // Icon buttons: no price text on the button; the price rides in the label and title.
    await vi.waitFor(() => expect($('[data-call="audio"]')!.getAttribute('aria-label')).toBe('Call Maya, up to 42 sats'));
    expect(text('[data-call="audio"]')).toBe('');
    expect($('[data-call="audio"]')!.getAttribute('title')).toMatch(/Media goes directly between you/);
    // Call signals from history are not chat bubbles.
    await vi.waitFor(() => expect($('[data-message="chat-1"]')).not.toBeNull());
    expect($('[data-message="call-1"]')).toBeNull();
    expect($('[data-message="block-1"]')).toBeNull();
    expect(document.body.textContent).not.toContain('"seq"');
    expect(host.used('call_signal')).toHaveLength(0);
    ring('audio');
    await vi.waitFor(() => expect($('[data-call-panel="ringing"]')).not.toBeNull());
    expect(host.used('call_signal')).toHaveLength(1);
    const args = host.used('call_signal')[0].args!;
    expect(args).toMatchObject({ peer: A, kind: 400, max_msat: 15_000 });
    expect(JSON.parse(args.plaintext as string)).toMatchObject({ v: 1, media: 'audio', sdp: 'v=0 offer' });
    expect(text('[data-call-paid]')).toMatch(/cap.*15 sats/i);
  });

  it.each(['', 'stun:owner.example:3478'])('says the cross-network note in the call panel only, and only without STUN (%s)', async (stun) => {
    setStunPref(stun);
    stubHost({ call_signal: () => new Promise(() => {}) });
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    // Not on every chat: the chat itself carries no network note.
    expect($('[data-call-network-note]')).toBeNull();
    ring('audio');
    await vi.waitFor(() => expect($('[data-call-panel="calling"]')).not.toBeNull());
    const note = $('[data-call-panel] [data-call-network-note]');
    if (stun) expect(note).toBeNull();
    else expect(note?.textContent).toMatch(/calls may not connect across networks/i);
    expect(mount.querySelectorAll('[data-call-network-note]').length).toBe(stun ? 0 : 1);
    $<HTMLButtonElement>('[data-call-hangup]')!.click();
  });

  it.each(['answer', 'decline', 'timeout', 'cancel'] as const)('loops the bundled ring and stops on %s', async outcome => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const host = stubHost({ messages_list: () => [] });
    await openShell();
    if (outcome === 'timeout') vi.useFakeTimers();
    host.emitLive({ type: 'message', room_id: null, message: msg(400, { media: 'audio', sdp: 'offer' }) });
    await vi.waitFor(() => expect($('[data-call-panel="incoming"]')).not.toBeNull());
    const audio = play.mock.contexts.find(a => a instanceof HTMLAudioElement && a.loop) as HTMLAudioElement;
    expect(audio).toBeDefined();
    expect(audio.src).toMatch(/incoming-ring\.wav/);
    expect($('[data-incoming-announcement]')?.textContent).toContain('Maya');
    if (outcome === 'answer' || outcome === 'decline') await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-accept]')!.disabled).toBe(false));
    if (outcome === 'answer') $<HTMLButtonElement>('[data-call-accept]')!.click();
    if (outcome === 'decline') $<HTMLButtonElement>('[data-call-decline]')!.click();
    if (outcome === 'cancel') host.emitLive({ type: 'message', room_id: null, message: msg(403, { reason: 'hangup' }) });
    if (outcome === 'timeout') {
      await vi.advanceTimersByTimeAsync(RING_MS + 1);
      vi.useRealTimers();
    }
    await vi.waitFor(() => expect(pause.mock.contexts).toContain(audio));
    expect(audio.currentTime).toBe(0);
    if (outcome === 'timeout' || outcome === 'cancel') expect($('[data-missed-call]')).not.toBeNull();
    else expect($('[data-missed-call]')).toBeNull();
  });

  it('keeps a second card visible with a soft tone and a working free decline while the first call stays live', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const host = payHost(); await liveCall();
    const pc = FakePc.made[0];
    host.emitLive({ type: 'message', room_id: null, message: msg(400, { call_id: 'f'.repeat(32), media: 'audio', sdp: 'offer' }) });
    await vi.waitFor(() => expect($('[data-waiting-calls] [data-call-panel="incoming"]')).not.toBeNull());
    const accept = $<HTMLButtonElement>('[data-waiting-calls] [data-call-accept]')!;
    expect(accept.disabled).toBe(true);
    await vi.waitFor(() => expect(text('[data-waiting-calls] [data-call-answer-cost]')).toContain('6 sats'));
    expect(accept.textContent).toBe('Accept');
    const audio = play.mock.contexts.find(a => a instanceof HTMLAudioElement && a.src.includes('incoming-ring')) as HTMLAudioElement;
    expect(audio.loop).toBe(false); expect(audio.volume).toBeLessThan(0.5);
    const before = host.used('call_signal').length;
    $<HTMLButtonElement>('[data-waiting-calls] [data-call-decline]')!.click();
    // The free Decline: the waiting card goes, nothing is sent for it, and the live call goes on.
    await vi.waitFor(() => expect($('[data-waiting-calls] [data-call-panel="incoming"]')).toBeNull());
    expect(host.used('call_signal')).toHaveLength(before);
    expect($('[data-call-panel="live"]')).not.toBeNull(); expect(pc.closed).toBe(false);
    expect($('[data-missed-call]')).toBeNull();
  });

  it('allows answering the waiting caller after the first call ends, with the same quoted price', async () => {
    const host = payHost(); await liveCall();
    host.emitLive({ type: 'message', room_id: null, message: msg(400, { call_id: 'f'.repeat(32), media: 'audio', sdp: 'second-offer' }) });
    await vi.waitFor(() => expect($('[data-waiting-calls] [data-call-accept]')).not.toBeNull());
    $<HTMLButtonElement>('[data-call-panel="live"] [data-call-hangup]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-waiting-calls] [data-call-accept]')!.disabled).toBe(false));
    await vi.waitFor(() => expect(text('[data-waiting-calls] [data-call-answer-cost]')).toContain('6 sats'));
    $<HTMLButtonElement>('[data-waiting-calls] [data-call-accept]')!.click();
    await vi.waitFor(() => expect(host.used('call_signal').some(c => c.args?.kind === 401 && String(c.args.plaintext).includes('f'.repeat(32)))).toBe(true));
    expect($('[data-waiting-calls] [data-call-panel]')).toBeNull();
    expect($('[data-missed-call]')).toBeNull();
    expect(FakePc.made[1].remote?.sdp).toBe('second-offer');
    FakePc.made[1].connect();
    expect($('[data-call-panel="live"]')).not.toBeNull();
  });

  it('marks a missed call read when its open thread regains focus', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const host = stubHost({ messages_list: () => [] }); await openShell();
    host.emitLive({ type: 'message', room_id: null, message: msg(400, { media: 'audio', sdp: 'offer' }) });
    host.emitLive({ type: 'message', room_id: null, message: msg(403, { reason: 'hangup' }) });
    await vi.waitFor(() => expect($(`[data-track="peer:${A}"] .badge`)?.textContent).toBe('1'));
    window.dispatchEvent(new Event('focus'));
    expect($(`[data-track="peer:${A}"] .badge`)).toBeNull();
    expect($('[data-missed-call]')).not.toBeNull();
  });

  it.each(['cancel', 'timeout'] as const)('keeps a missed waiting call visible after %s without ending the live call', async outcome => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const host = payHost(); await liveCall();
    if (outcome === 'timeout') vi.useFakeTimers();
    const id = 'f'.repeat(32);
    host.emitLive({ type: 'message', room_id: null, message: msg(400, { call_id: id, media: 'audio', sdp: 'second' }) });
    await vi.waitFor(() => expect($('[data-waiting-calls] [data-call-panel="incoming"]')).not.toBeNull());
    const tone = play.mock.contexts.find(a => a instanceof HTMLAudioElement && a.src.includes('incoming-ring'));
    if (outcome === 'timeout') { await vi.advanceTimersByTimeAsync(RING_MS + 1); vi.useRealTimers(); }
    else host.emitLive({ type: 'message', room_id: null, message: msg(403, { call_id: id, reason: 'hangup' }) });
    expect(pause.mock.contexts).toContain(tone);
    expect($('[data-waiting-calls] [data-call-panel="ended"]')).not.toBeNull();
    expect($('[data-missed-call]')).not.toBeNull();
    expect($('[data-call-panel="live"]')).not.toBeNull();
    expect(FakePc.made[0].closed).toBe(false);
  });

  it('keeps alert lifetimes separate when two callers use the same call id, and stops on unmount', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const host = stubHost(); await openShell();
    const offer = msg(400, { media: 'audio', sdp: 'first' });
    host.emitLive({ type: 'message', room_id: null, message: offer });
    host.emitLive({ type: 'message', room_id: null, message: offer });
    host.emitLive({ type: 'message', room_id: null, message: msg(400, { media: 'audio', sdp: 'second' }, 'b'.repeat(64)) });
    const tones = play.mock.contexts.filter(a => a instanceof HTMLAudioElement && a.src.includes('incoming-ring')) as HTMLAudioElement[];
    expect(tones).toHaveLength(2);
    expect(tones.map(a => a.loop)).toEqual([true, false]);
    host.emitLive({ type: 'message', room_id: null, message: msg(403, { reason: 'hangup' }) });
    expect(pause.mock.contexts).toContain(tones[0]);
    expect(pause.mock.contexts).not.toContain(tones[1]);
    expect($('[data-waiting-calls] [data-call-panel="incoming"]')).not.toBeNull();
    dispose?.(); dispose = undefined;
    expect(pause.mock.contexts).toContain(tones[1]);
  });

  it('restores a missed call in its contact thread after reopening the app', async () => {
    const host = stubHost({ messages_list: () => [] }); await openShell();
    host.emitLive({ type: 'message', room_id: null, message: msg(400, { media: 'video', sdp: 'offer' }) });
    host.emitLive({ type: 'message', room_id: null, message: msg(403, { reason: 'hangup' }) });
    expect($('[data-missed-call]')).not.toBeNull();
    dispose?.(); dispose = undefined; mount.remove();
    stubHost({ messages_list: () => [] }); await openShell();
    expect($('[data-missed-call]')).not.toBeNull();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-back]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-back]')!.click();
    expect($('[data-missed-call] [data-call-confirm="video"]')).not.toBeNull();
    $<HTMLButtonElement>('[data-missed-call] [data-call-confirm-cancel]')!.click();
    expect(document.activeElement).toBe($('[data-call-back]'));
  });

  it('keeps cancelled calls in the contact thread with time, unread badge and a priced call-back confirmation', async () => {
    const host = stubHost({ messages_list: () => [] }); await openShell();
    $<HTMLButtonElement>('[data-track="discover"]')!.click();
    const offer = msg(400, { media: 'audio', sdp: 'offer' });
    host.emitLive({ type: 'message', room_id: null, message: offer });
    host.emitLive({ type: 'message', room_id: null, message: msg(403, { reason: 'hangup' }) });
    await vi.waitFor(() => expect($(`[data-track="peer:${A}"] .badge`)?.textContent).toBe('1'));
    $<HTMLButtonElement>(`[data-track="peer:${A}"]`)!.click();
    await vi.waitFor(() => expect($('[data-missed-call]')).not.toBeNull());
    expect(text('[data-missed-call]')).toContain('Missed call');
    expect($('[data-missed-call] time')?.getAttribute('datetime')).toBeTruthy();
    expect($(`[data-track="peer:${A}"] .badge`)).toBeNull();
    host.emitLive({ type: 'message', room_id: null, message: offer });
    expect(mount.querySelectorAll('[data-missed-call]')).toHaveLength(1);
    expect($('[data-call-panel="incoming"]')).toBeNull();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-back]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-back]')!.click();
    await vi.waitFor(() => expect($('[data-missed-call] [data-call-confirm]')).not.toBeNull());
    expect(host.used('call_signal')).toHaveLength(0);
  });

  const incoming = (host: ReturnType<typeof stubHost>, id = ID) => host.emitLive({ type: 'message', room_id: null, message: { id: `live-${id}`, kind: 400, sender: A, recipient: OWN, timestamp: Date.now(), plaintext: JSON.stringify({ v: 1, call_id: id, media: 'audio', sdp: 'v=0' }), payment_amount_msat: 1000 } });

  it.each(['locked', 'expired'] as const)('an incoming call explains %s spending before Accept and approval still needs an explicit answer', async state => {
    let approved = false;
    const capture = vi.spyOn(navigator.mediaDevices, 'getUserMedia');
    const host = stubHost({
      messages_list: () => [],
      pairing_status: () => ({ ...paired, scopes: approved ? paired.scopes : ['read', 'receive'] }),
      budget_status: () => ({ ...openBudget(), autopay: { state: 'off', open_until_ms: null, ceiling_msat: null, basis: null } }),
      spend_status: () => approved ? spending() : { state, basis: null, open_until_ms: null, pending: null, window_ms: 600_000 },
      spend_request: () => { approved = true; return spending(); },
    });
    await openShell();
    incoming(host);
    await vi.waitFor(() => expect($('[data-call-spend-needed]')).not.toBeNull());
    expect(text('[data-call-spend-needed]')).toMatch(/answer.*paid signal.*approval/i);
    expect(text('[data-call-spend-approve]')).toBe('Approve spending');
    expect(host.used('spend_request')).toHaveLength(0);
    expect(host.used('call_signal')).toHaveLength(0);
    expect(capture).not.toHaveBeenCalled();
    setLanguagePref('da');
    expect(text('[data-call-spend-needed]')).toMatch(/svar.*betalt signal.*godkend/i);
    expect(text('[data-call-spend-approve]')).toBe('Godkend betalinger');
    $<HTMLButtonElement>('[data-call-spend-approve]')!.click();
    await vi.waitFor(() => expect($('[data-call-approval] [data-call-approve]')).not.toBeNull());
    expect(text('[data-call-approval]')).toContain('Acceptér');
    $<HTMLButtonElement>('[data-call-approve]')!.click();
    await vi.waitFor(() => expect(host.used('spend_request')).toHaveLength(1));
    await vi.waitFor(() => expect($('[data-call-spend-needed]')).toBeNull());
    expect($('[data-call-panel="incoming"]')).not.toBeNull();
    expect(host.used('call_signal')).toHaveLength(0);
    expect(capture).not.toHaveBeenCalled();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-accept]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-accept]')!.click();
    await vi.waitFor(() => expect(host.used('call_signal')).toHaveLength(1));
    expect(host.used('call_signal')[0].args).toMatchObject({ peer: A, kind: 401, max_msat: 6_000 });
  });

  it('a waiting incoming call offers the spending approval path without answering either call', async () => {
    const host = stubHost({
      messages_list: () => [],
      budget_status: () => ({ ...openBudget(), autopay: { state: 'off', open_until_ms: null, ceiling_msat: null, basis: null } }),
    });
    await openShell();
    incoming(host);
    incoming(host, 'f'.repeat(32));
    await vi.waitFor(() => expect($('[data-waiting-calls] [data-call-spend-needed]')).not.toBeNull());
    $<HTMLButtonElement>('[data-waiting-calls] [data-call-spend-approve]')!.click();
    await vi.waitFor(() => expect($('[data-call-approval] [data-call-approve]')).not.toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe($('[data-call-approve]')));
    expect(host.used('spend_request')).toHaveLength(0);
    expect(host.used('call_signal')).toHaveLength(0);
  });

  it.each(['before', 'after'])('a waiting call stays answerable when the primary call ends %s opening approval', async timing => {
    const host = stubHost({
      messages_list: () => [],
      budget_status: () => ({ ...openBudget(), autopay: { state: 'off', open_until_ms: null, ceiling_msat: null, basis: null } }),
      spend_request: spending,
    });
    await openShell();
    incoming(host);
    incoming(host, 'f'.repeat(32));
    const endPrimary = () => host.emitLive({ type: 'message', room_id: null, message: msg(403, { reason: 'hangup' }) });
    await vi.waitFor(() => expect($('[data-waiting-calls] [data-call-spend-approve]')).not.toBeNull());
    if (timing === 'before') endPrimary();
    $<HTMLButtonElement>('[data-waiting-calls] [data-call-spend-approve]')!.click();
    if (timing === 'after') endPrimary();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect(text('[data-call-approval]')).toContain('press Call or Accept again');
    expect(text('[data-call-approval]')).not.toContain('ask them to call again');
    $<HTMLButtonElement>('[data-call-approve]')!.click();
    await vi.waitFor(() => expect(host.used('spend_request')).toHaveLength(1));
    expect(host.used('call_signal')).toHaveLength(0);
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-waiting-calls] [data-call-accept]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-waiting-calls] [data-call-accept]')!.click();
    await vi.waitFor(() => expect(host.used('call_signal')).toHaveLength(1));
    expect(host.used('call_signal')[0].args).toMatchObject({ kind: 401, max_msat: 6_000 });
  });

  it.each(['approve', 'close'] as const)('returns to the waiting Accept after %s', async action => {
    const capture = vi.spyOn(navigator.mediaDevices, 'getUserMedia');
    const host = stubHost({
      messages_list: () => [],
      budget_status: () => ({ ...openBudget(), autopay: { state: 'off', open_until_ms: null, ceiling_msat: null, basis: null } }),
      spend_request: spending,
    });
    await openShell();
    incoming(host);
    incoming(host, 'f'.repeat(32));
    await vi.waitFor(() => expect($('[data-waiting-calls] [data-call-spend-approve]')).not.toBeNull());
    $<HTMLButtonElement>('[data-waiting-calls] [data-call-spend-approve]')!.click();
    host.emitLive({ type: 'message', room_id: null, message: msg(403, { reason: 'hangup' }) });
    await vi.waitFor(() => expect(document.activeElement).toBe($('[data-call-approve]')));
    if (action === 'approve') $<HTMLButtonElement>('[data-call-approve]')!.click();
    else [...$('[data-call-approval]')!.querySelectorAll('button')].find(b => b.textContent === 'Close')!.click();
    await vi.waitFor(() => expect($('[data-call-approval-open]')).toBeNull());
    expect($('[data-call-approval]')).toBeNull();
    const accept = $<HTMLButtonElement>('[data-waiting-calls] [data-call-accept]')!;
    await vi.waitFor(() => expect(document.activeElement === accept).toBe(true));
    expect(accept.disabled).toBe(false);
    expect(host.used('spend_request')).toHaveLength(action === 'approve' ? 1 : 0);
    expect(host.used('call_signal')).toHaveLength(0);
    expect(capture).not.toHaveBeenCalled();
    if (action === 'approve') {
      accept.click();
      await vi.waitFor(() => expect(host.used('call_signal')).toHaveLength(1));
      expect(host.used('call_signal')[0].args).toMatchObject({ kind: 401, max_msat: 6_000 });
      expect(JSON.parse(host.used('call_signal')[0].args!.plaintext as string).call_id).toBe('f'.repeat(32));
    }
  });

  it.each(['pending', 'refused', 'unavailable'] as const)('keeps %s approval visible for a waiting call', async state => {
    const host = stubHost({
      messages_list: () => [],
      budget_status: () => ({ ...openBudget(), autopay: { state: 'off', open_until_ms: null, ceiling_msat: null, basis: null } }),
      spend_request: () => {
        if (state === 'refused') throw { code: 'spend_refused', message: 'Approval was refused. Nothing was paid.' };
        if (state === 'unavailable') return { state: 'unavailable', basis: null, open_until_ms: null, pending: null, window_ms: 600_000 };
        return { state: 'pending', basis: null, open_until_ms: null, pending: { op_id: 'ab01', expires_at_ms: Date.now() + 600_000, owner_action: 'approve request', owner_can_grant: true }, window_ms: 600_000 };
      },
    });
    await openShell();
    incoming(host);
    incoming(host, 'f'.repeat(32));
    await vi.waitFor(() => expect($('[data-waiting-calls] [data-call-spend-approve]')).not.toBeNull());
    $<HTMLButtonElement>('[data-waiting-calls] [data-call-spend-approve]')!.click();
    $<HTMLButtonElement>('[data-call-approve]')!.click();
    await vi.waitFor(() => expect(host.used('spend_request')).toHaveLength(1));
    await vi.waitFor(() => expect(text('[data-call-approval]')).toContain(state === 'pending' ? 'Cancel request' : state === 'refused' ? 'Approval was refused' : 'cannot grant spending'));
    expect($('[data-call-approval-open]')).not.toBeNull();
    expect(host.used('call_signal')).toHaveLength(0);
  });

  it('returns to the waiting Accept when a pending approval opens on a later poll', async () => {
    let approved = false;
    const host = stubHost({
      messages_list: () => [],
      budget_status: () => ({ ...openBudget(), autopay: { state: 'off', open_until_ms: null, ceiling_msat: null, basis: null } }),
      spend_status: () => approved ? spending() : { state: 'locked', basis: null, open_until_ms: null, pending: null, window_ms: 600_000 },
      spend_request: () => ({ state: 'pending', basis: null, open_until_ms: null,
        pending: { op_id: 'ab01', expires_at_ms: Date.now() + 600_000, owner_action: 'approve request', owner_can_grant: true }, window_ms: 600_000 }),
    });
    vi.useFakeTimers();
    await openShell();
    incoming(host);
    incoming(host, 'f'.repeat(32));
    await vi.waitFor(() => expect($('[data-waiting-calls] [data-call-spend-approve]')).not.toBeNull());
    $<HTMLButtonElement>('[data-waiting-calls] [data-call-spend-approve]')!.click();
    host.emitLive({ type: 'message', room_id: null, message: msg(403, { reason: 'hangup' }) });
    $<HTMLButtonElement>('[data-call-approve]')!.click();
    await vi.waitFor(() => expect(text('[data-call-approval]')).toContain('Cancel request'));
    approved = true;
    await vi.advanceTimersByTimeAsync(3500);
    expect($('[data-call-approval]')).toBeNull();
    expect($('[data-call-approval-open]')).toBeNull();
    expect(document.activeElement === $('[data-waiting-calls] [data-call-accept]')).toBe(true);
    expect(host.used('call_signal')).toHaveLength(0);
  });

  it('an answer refused with grant_ended offers approval and asks for a new call without retrying the paid signal', async () => {
    const host = payHost({
      messages_list: () => [],
      call_signal: () => { throw { code: 'grant_ended', message: 'The node grant cannot cover this answer. Nothing was paid.' }; },
      spend_request: spending,
    });
    await openShell();
    incoming(host);
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-accept]')?.disabled).toBe(false));
    expect($('[data-call-spend-needed]')).toBeNull();
    $<HTMLButtonElement>('[data-call-accept]')!.click();
    await vi.waitFor(() => expect($('[data-call-approval] [data-call-approve]')).not.toBeNull());
    // One plain line; the host's own words wait under Details.
    expect(text('[data-call-ended]')).toBe('The call could not be answered.');
    expect(text('[data-call-end-detail]')).toContain('The node grant cannot cover this answer. Nothing was paid.');
    expect(text('[data-call-approval]')).toMatch(/call has ended.*approve spending.*call again/i);
    expect(text('[data-call-approval]')).not.toContain('press Call or Accept again');
    setLanguagePref('da');
    expect(text('[data-call-approval]')).toMatch(/opkaldet er slut.*godkend betalinger.*ringe igen/i);
    expect(host.used('call_signal')).toHaveLength(1);
    $<HTMLButtonElement>('[data-call-approve]')!.click();
    await vi.waitFor(() => expect(host.used('spend_request')).toHaveLength(1));
    expect(host.used('call_signal')).toHaveLength(1);
  });

  it.each(['grant_exhausted', 'grant_per_call'])('an answer refused with %s keeps the reason without offering an ineffective window approval', async code => {
    const host = payHost({
      messages_list: () => [],
      call_signal: () => { throw { code, message: 'The node grant cannot cover this answer. Nothing was paid.' }; },
    });
    await openShell();
    incoming(host);
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-accept]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-accept]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect(text('[data-call-ended]')).toBe('The call could not be answered.');
    expect(text('[data-call-end-detail]')).toContain('The node grant cannot cover this answer. Nothing was paid.');
    expect($('[data-call-approval]')).toBeNull();
    expect(host.used('call_signal')).toHaveLength(1);
    expect(host.used('spend_request')).toHaveLength(0);
  });

  /** What the card shows without opening anything: closed Details keep only their summary. */
  const visible = (sel: string) => {
    const el = $(sel);
    if (!el) return '';
    const copy = el.cloneNode(true) as Element;
    copy.querySelectorAll('details:not([open])').forEach((d) => [...d.childNodes].forEach((n) => { if (!(n instanceof Element && n.tagName === 'SUMMARY')) n.remove(); }));
    return copy.textContent ?? '';
  };

  it.each([
    ['en', 'Accept', 'Decline', 'Declining is free and sends nothing. Their phone keeps ringing until the call times out.'],
    ['da', 'Acceptér', 'Afvis', 'Det er gratis at afvise, og intet bliver sendt. Det ringer hos den anden, til opkaldet udløber.'],
  ] as const)('Decline is the free local Ignore, said honestly, and no button carries a price (%s)', async (lang, accept, decline, note) => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const host = stubHost({ messages_list: () => [], call_quote: () => QUOTE });
    await openShell();
    setLanguagePref(lang);
    incoming(host);
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-accept]')!.disabled).toBe(false));
    expect(text('[data-call-accept]')).toBe(accept);
    expect(text('[data-call-decline]')).toBe(decline);
    expect(visible('[data-call-panel="incoming"]')).not.toMatch(/\bsats?\b/);
    expect(text('[data-call-decline-note]')).toBe(note);
    // One way to say no: no second, differently priced button.
    expect(mount.querySelectorAll('[data-call-panel="incoming"] .call-actions button')).toHaveLength(2);
    // What answering costs is still there, one tap away under Details.
    const cost = $('[data-call-answer-cost]')!;
    expect(cost.closest('details')?.open).toBe(false);
    const audio = play.mock.contexts.find(a => a instanceof HTMLAudioElement && a.loop) as HTMLAudioElement;
    $<HTMLButtonElement>('[data-call-decline]')!.click();
    await vi.waitFor(() => expect(pause.mock.contexts).toContain(audio));
    expect($('[data-call-panel="incoming"]')).toBeNull();
    expect(host.used('call_signal')).toHaveLength(0);
    expect(host.used('op_end_call')).toHaveLength(0);
    expect(host.used('spend_request')).toHaveLength(0);
  });

  it('Decline works with no readable price: it pays nothing either way', async () => {
    let answer: Reply = () => QUOTE;
    const host = stubHost({ messages_list: () => [], call_quote: (args) => answer(args) });
    await openShell();
    answer = () => { throw { code: 'node', message: 'Could not read it' }; };
    incoming(host);
    await vi.waitFor(() => expect($('[data-call-answer-price]')).not.toBeNull());
    expect($<HTMLButtonElement>('[data-call-accept]')!.disabled).toBe(true);
    expect($<HTMLButtonElement>('[data-call-decline]')!.disabled).toBe(false);
    $<HTMLButtonElement>('[data-call-decline]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="incoming"]')).toBeNull());
    expect(host.used('call_signal')).toHaveLength(0);
  });

  it('the ring confirm keeps the STUN address out of sight, under Details', async () => {
    const own = 'stun:192.0.2.10:3478';
    stubHost({ node_overview: overviewWith({ stun_source: 'own', stun_port: 3478, stun_url: own }) });
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-confirm-box]')).not.toBeNull());
    expect(visible('[data-call-confirm-box]')).not.toContain('stun:');
    expect(visible('[data-call-confirm-box]')).not.toContain('192.0.2.10');
    const source = $('[data-call-stun-source]')!;
    expect(source.closest('details')?.open).toBe(false);
    expect(source.textContent).toContain(own);
  });

  it('Accept waits for the price, which shows as a ceiling under Details; Decline is free at once', async () => {
    let read = (_q: CallQuote) => {};
    let answer: Reply = () => QUOTE;
    const host = stubHost({ messages_list: () => [], call_quote: (args) => answer(args) });
    await openShell();
    answer = () => new Promise<CallQuote>((resolve) => { read = resolve; });
    incoming(host);
    await vi.waitFor(() => expect($('[data-call-panel="incoming"]')).not.toBeNull());
    expect($<HTMLButtonElement>('[data-call-accept]')!.disabled).toBe(true);
    expect($<HTMLButtonElement>('[data-call-decline]')!.disabled).toBe(false);
    read(QUOTE);
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-accept]')!.disabled).toBe(false));
    expect($<HTMLButtonElement>('[data-call-decline]')!.disabled).toBe(false);
    expect(text('[data-call-answer-cost]')).toContain('at most 6 sats');
    expect(text('[data-call-accept]')).toBe('Accept');
    expect(text('[data-call-decline]')).toBe('Decline');
  });

  it('the incoming card says in words what answering can cost: the answer, your own hangup, and nothing more but a reconnect', async () => {
    const host = stubHost({ messages_list: () => [], call_quote: () => QUOTE });
    await openShell();
    incoming(host);
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-accept]')!.disabled).toBe(false));
    expect(text('[data-call-answer-cost]')).toContain('at most 6 sats');
    expect(text('[data-call-answer-cost]')).toBe('Answering costs you at most 6 sats. Hanging up costs at most 6 sats more. The caller pays for the call itself. Declining costs nothing. If the connection drops, trying to reconnect can add payments of at most 6 sats each, even if it fails.');
    try {
      setLanguagePref('da');
      expect(text('[data-call-answer-cost]')).toBe('At svare koster dig højst 6 sats. At lægge på koster højst 6 sats mere. Den, der ringer, betaler selve opkaldet. Det er gratis at afvise. Hvis forbindelsen falder ud, kan forsøg på at forbinde igen medføre flere betalinger på højst 6 sats hver, også hvis det ikke lykkes.');
    } finally { setLanguagePref('en'); }
    expect(host.used('call_signal')).toHaveLength(0);
  });

  it.each([
    ['the read fails', () => { throw { code: 'node', message: 'Could not read it' }; }],
    ['their node gives no live price', () => ({ ...QUOTE, offer_msat: null, offer_max_routing_fee_msat: 0, call_total_msat: null })],
  ] as [string, Reply][])('when %s Accept stays off and the card says why', async (_case, reply) => {
    let answer: Reply = () => QUOTE;
    const host = stubHost({ messages_list: () => [], call_quote: (args) => answer(args) });
    await openShell();
    answer = reply;
    incoming(host);
    await vi.waitFor(() => expect($('[data-call-answer-price]')).not.toBeNull());
    expect($<HTMLButtonElement>('[data-call-accept]')!.disabled).toBe(true);
    // Declining is the free local ignore: it needs no price.
    expect($<HTMLButtonElement>('[data-call-decline]')!.disabled).toBe(false);
    expect(text('[data-call-accept]')).toBe('Accept');
    expect(text('[data-call-answer-price]')).toMatch(/nothing can be paid/i);
    expect($('[data-call-answer-cost]')).toBeNull();
    expect(host.used('call_signal')).toHaveLength(0);
  });

  it('with no readable price, Ignore stops the ring and no signal is sent', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    let answer: Reply = () => QUOTE;
    const host = stubHost({ messages_list: () => [], call_quote: (args) => answer(args) });
    await openShell();
    answer = () => { throw { code: 'node', message: 'Could not read it' }; };
    incoming(host);
    await vi.waitFor(() => expect($('[data-call-answer-price]')).not.toBeNull());
    const audio = play.mock.contexts.find(a => a instanceof HTMLAudioElement && a.loop) as HTMLAudioElement;
    expect(text('[data-call-ignore]')).toBe('Decline');
    $<HTMLButtonElement>('[data-call-ignore]')!.click();
    await vi.waitFor(() => expect(pause.mock.contexts).toContain(audio));
    expect($('[data-call-panel="incoming"]')).toBeNull();
    expect($('[data-missed-call]')).toBeNull();
    expect(host.used('call_signal')).toHaveLength(0);
    expect(host.used('op_end_call')).toHaveLength(0);
  });

  it('a price read that lands after its waiting card has gone is dropped without an error', async () => {
    const seen: unknown[] = [];
    const onError = (reason: unknown) => { seen.push(reason); };
    process.on('unhandledRejection', onError);
    try {
      let read = (_q: CallQuote) => {};
      let answer: Reply = () => QUOTE;
      const host = payHost({ call_quote: (args) => answer(args) }); await liveCall();
      answer = () => new Promise<CallQuote>((resolve) => { read = resolve; });
      host.emitLive({ type: 'message', room_id: null, message: msg(400, { call_id: 'f'.repeat(32), media: 'audio', sdp: 'second-offer' }) });
      await vi.waitFor(() => expect($('[data-waiting-calls] [data-call-ignore]')).not.toBeNull());
      $<HTMLButtonElement>('[data-waiting-calls] [data-call-ignore]')!.click();
      await vi.waitFor(() => expect($('[data-waiting-calls] [data-call-panel]')).toBeNull());
      read(QUOTE);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(seen).toEqual([]);
    } finally { process.off('unhandledRejection', onError); }
  });

  it('Ignore on a waiting card leaves the live call alone and sends nothing', async () => {
    const host = payHost(); await liveCall();
    const before = host.used('call_signal').length;
    host.emitLive({ type: 'message', room_id: null, message: msg(400, { call_id: 'f'.repeat(32), media: 'audio', sdp: 'second-offer' }) });
    await vi.waitFor(() => expect($('[data-waiting-calls] [data-call-ignore]')).not.toBeNull());
    $<HTMLButtonElement>('[data-waiting-calls] [data-call-ignore]')!.click();
    await vi.waitFor(() => expect($('[data-waiting-calls] [data-call-panel]')).toBeNull());
    expect($('[data-call-panel="live"]')).not.toBeNull();
    expect(host.used('call_signal')).toHaveLength(before);
    expect($('[data-missed-call]')).toBeNull();
  });

  it.each([
    ['Accept', '[data-call-accept]', 'a dearer price', () => ({ ...QUOTE, signal_msat: 2_000 })],
    ['Accept', '[data-call-accept]', 'a failed read', () => { throw { code: 'node', message: 'Could not read it' }; }],
  ] as [string, string, string, Reply][])('%s showing 6 sats: on %s no call_signal goes out and the card says nothing was paid', async (_button, selector, _case, second) => {
    let answer: Reply = () => QUOTE;
    const host = stubHost({ messages_list: () => [], call_quote: (args) => answer(args) });
    await openShell();
    incoming(host);
    await vi.waitFor(() => expect(text('[data-call-answer-cost]')).toContain('at most 6 sats'));
    answer = second;
    $<HTMLButtonElement>(selector)!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect(host.used('call_signal')).toHaveLength(0);
    expect(text('[data-call-ended]')).toMatch(/nothing was paid/i);
  });

  it('a waiting card pays nothing above the price it shows', async () => {
    let answer: Reply = () => QUOTE;
    const host = payHost({ call_quote: (args) => answer(args) }); await liveCall();
    host.emitLive({ type: 'message', room_id: null, message: msg(400, { call_id: 'f'.repeat(32), media: 'audio', sdp: 'second-offer' }) });
    await vi.waitFor(() => expect(text('[data-waiting-calls] [data-call-answer-cost]')).toContain('at most 6 sats'));
    $<HTMLButtonElement>('[data-call-panel="live"] [data-call-hangup]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-waiting-calls] [data-call-accept]')!.disabled).toBe(false));
    answer = () => ({ ...QUOTE, signal_msat: 2_000 });
    $<HTMLButtonElement>('[data-waiting-calls] [data-call-accept]')!.click();
    await vi.waitFor(() => expect(text('[data-call-ended]')).toMatch(/nothing was paid/i));
    expect(host.used('call_signal').some((c) => c.args?.kind === 401)).toBe(false);
  });

  it('rings on a live offer with the answer price, and never adds call signals to the thread', async () => {
    const host = stubHost({ messages_list: () => [] });
    await openShell();
    host.emitLive({ type: 'message', room_id: null, message: { id: 'live-offer', kind: 400, sender: A, recipient: OWN, timestamp: Date.now(), plaintext: JSON.stringify({ v: 1, call_id: ID, media: 'audio', sdp: 'v=0 offer' }), payment_amount_msat: 10_000 } });
    await vi.waitFor(() => expect($('[data-call-panel="incoming"]')).not.toBeNull());
    expect(text('[data-call-title]')).toBe('Incoming call');
    await vi.waitFor(() => expect(text('[data-call-answer-cost]')).toContain('at most 6 sats'));
    expect($('[data-message="live-offer"]')).toBeNull();
    $<HTMLButtonElement>('[data-call-accept]')!.click();
    await vi.waitFor(() => expect(host.used('call_signal')).toHaveLength(1));
    expect(host.used('call_signal')[0].args).toMatchObject({ peer: A, kind: 401, max_msat: 6_000 });
    FakePc.made[0].connect();
    await vi.waitFor(() => expect($('[data-call-panel="live"]')).not.toBeNull());
    expect(text('[data-call-duration]')).toMatch(/^0:0\d$/);
    const pill = $<HTMLButtonElement>('[data-on-call]')!;
    expect(pill?.textContent).toMatch(/Live · 00:0\d/);
    expect(text('[data-call-title]')).toBe('Live');
    $<HTMLButtonElement>('[data-track="discover"]')!.click();
    pill.click();
    await vi.waitFor(() => expect(document.activeElement).toBe($('[data-call-panel="live"]')));
    expect($('[data-track="peer:' + A + '"]')?.getAttribute('aria-current')).toBe('true');

    $<HTMLButtonElement>('[data-call-mute]')!.click();
    await vi.waitFor(() => expect($('[data-call-mute]')!.getAttribute('aria-pressed')).toBe('true'));
    expect(text('[data-call-mute]')).toBe('Mute');
    $<HTMLButtonElement>('[data-call-hangup]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect(host.used('call_signal').map((c) => c.args!.kind)).toEqual([401, 403]);
    // The pill says the call ended until the card is closed, then goes.
    expect($('[data-on-call]')!.textContent).toBe('Call ended');
    // Close waits until the hangup's payment has settled.
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-dismiss]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-dismiss]')!.click();
    await vi.waitFor(() => expect($('[data-on-call]')).toBeNull());
  });

  it('while reconnecting, says the connection was lost and how many seconds are left, in the panel and the pill; the ended card makes no recovery promise', async () => {
    const host = stubHost({ messages_list: () => [] });
    await openShell();
    host.emitLive({ type: 'message', room_id: null, message: { ...msg(400, { media: 'audio', sdp: 'offer' }), timestamp: Date.now() } });
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-accept]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-accept]')!.click();
    await vi.waitFor(() => expect(host.used('call_signal')).toHaveLength(1));
    const pc = FakePc.made[0]; pc.connect();
    await vi.waitFor(() => expect($('[data-call-panel="live"]')).not.toBeNull());
    expect($('[data-call-reconnecting]')).toBeNull();
    // The seconds left are read from Date.now() on a 1 s display interval. Fake the clock
    // before the drop so the countdown moves by the time we advance, not by how fast the
    // runner happens to deliver that interval within a real wait.
    vi.useFakeTimers();
    pc.state('disconnected');
    await vi.waitFor(() => expect($('[data-call-reconnecting]')).not.toBeNull());
    expect(text('[data-call-reconnecting]')).toMatch(/^Connection lost\. Reconnecting… If it isn’t back in (29|30) s, the call ends\.$/);
    expect(text('[data-on-call]')).toMatch(/^Reconnecting… · (29|30) s$/);
    const pillSeconds = () => Number(/· (\d+) s$/.exec(text('[data-on-call]'))?.[1]);
    const before = Number(text('[data-call-drop-in]'));
    const pillBefore = pillSeconds();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(Number(text('[data-call-drop-in]'))).toBeLessThan(before);
    expect(pillSeconds()).toBeLessThan(pillBefore);
    $<HTMLButtonElement>('[data-call-hangup]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect($('[data-call-recovery-note]')).toBeNull();
    expect($('[data-call-reconnecting]')).toBeNull();
  });

  it('before Accept, a video call says your camera turns on and how to turn it off (EN and DA); an audio call does not', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'srcObject', 'set').mockImplementation(() => {});
    const host = stubHost({ messages_list: () => [] });
    await openShell();
    host.emitLive({ type: 'message', room_id: null, message: { ...msg(400, { media: 'video', sdp: 'offer' }), timestamp: Date.now() } });
    await vi.waitFor(() => expect($('[data-call-panel="incoming"]')).not.toBeNull());
    expect(text('[data-call-camera-notice]')).toBe('This is a video call: your camera turns on when you press Accept. You can turn it off with Camera.');
    try {
      setLanguagePref('da');
      expect(text('[data-call-camera-notice]')).toBe('Dette er et videoopkald: dit kamera tændes, når du trykker Acceptér. Du kan slukke det med Kamera.');
      expect(text('[data-call-accept]')).toMatch(/^Acceptér/);
    } finally { setLanguagePref('en'); }
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-accept]')?.disabled).toBe(false));
    expect(text('[data-call-accept]')).toMatch(/^Accept/);
    $<HTMLButtonElement>('[data-call-accept]')!.click();
    await vi.waitFor(() => expect(host.used('call_signal')).toHaveLength(1));
    FakePc.made[0].connect();
    await vi.waitFor(() => expect($('[data-call-panel="live"]')).not.toBeNull());
    expect($('[data-call-camera-notice]')).toBeNull();
    expect(text('[data-call-camera]')).toBe('Camera');
  });

  it('an incoming audio call has no camera notice', async () => {
    const host = stubHost({ messages_list: () => [] });
    await openShell();
    host.emitLive({ type: 'message', room_id: null, message: { ...msg(400, { media: 'audio', sdp: 'offer' }), timestamp: Date.now() } });
    await vi.waitFor(() => expect($('[data-call-panel="incoming"]')).not.toBeNull());
    expect($('[data-call-camera-notice]')).toBeNull();
  });

  it('your own picture is named, shown as in a mirror, and says "Camera off" instead of going black', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'srcObject', 'set').mockImplementation(() => {});
    const host = stubHost({ messages_list: () => [] });
    await openShell();
    host.emitLive({ type: 'message', room_id: null, message: { ...msg(400, { media: 'video', sdp: 'offer' }), timestamp: Date.now() } });
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-accept]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-accept]')!.click();
    await vi.waitFor(() => expect(host.used('call_signal')).toHaveLength(1));
    FakePc.made[0].connect();
    await vi.waitFor(() => expect($('[data-call-panel="live"]')).not.toBeNull());
    const self = $('[data-call-self]')!;
    const video = self.querySelector('[data-call-media="local"]');
    expect(video).not.toBeNull();
    expect(self.hasAttribute('data-camera-off')).toBe(false);
    expect(text('[data-call-self-label]')).toBe('You');
    $<HTMLButtonElement>('[data-call-camera]')!.click();
    await vi.waitFor(() => expect($('[data-call-self]')!.hasAttribute('data-camera-off')).toBe(true));
    expect(text('[data-call-self-label]')).toBe('You · Camera off');
    // The same element stays: turning the camera back on needs no new player.
    expect($('[data-call-self] [data-call-media="local"]')).toBe(video);
    try {
      setLanguagePref('da');
      expect(text('[data-call-self-label]')).toBe('Dig · Kamera slukket');
    } finally { setLanguagePref('en'); }
    $<HTMLButtonElement>('[data-call-camera]')!.click();
    await vi.waitFor(() => expect($('[data-call-self]')!.hasAttribute('data-camera-off')).toBe(false));
    expect(text('[data-call-self-label]')).toBe('You');
    const css = readFileSync(join(__dirname, '../src/styles.css'), 'utf8');
    expect(css).toMatch(/\.call-video\.local \{[^}]*transform: scaleX\(-1\)/);
    // Hidden, never display:none: WebKit may pause a removed player that is shown again.
    expect(css).toMatch(/\.call-self\[data-camera-off\] \.call-video\.local \{ visibility: hidden; \}/);
    expect(css).not.toMatch(/\.call-self\[data-camera-off\] \.call-video\.local \{[^}]*display: none/);
  });

  it('a video call with the camera off says they cannot see you, and the line goes when it is back on', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'srcObject', 'set').mockImplementation(() => {});
    const host = stubHost({ messages_list: () => [] });
    await openShell();
    host.emitLive({ type: 'message', room_id: null, message: { ...msg(400, { media: 'video', sdp: 'offer' }), timestamp: Date.now() } });
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-accept]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-accept]')!.click();
    await vi.waitFor(() => expect(host.used('call_signal')).toHaveLength(1));
    FakePc.made[0].connect();
    await vi.waitFor(() => expect($('[data-call-panel="live"]')).not.toBeNull());
    expect($('[data-call-camera-off]')).toBeNull();
    $<HTMLButtonElement>('[data-call-camera]')!.click();
    await vi.waitFor(() => expect($('[data-call-camera-off]')).not.toBeNull());
    expect(text('[data-call-camera-off]')).toBe('Your camera is off. They cannot see you. Press Camera to turn it on.');
    try {
      setLanguagePref('da');
      expect(text('[data-call-camera-off]')).toBe('Dit kamera er slukket. De kan ikke se dig. Tryk Kamera for at tænde det.');
    } finally { setLanguagePref('en'); }
    $<HTMLButtonElement>('[data-call-camera]')!.click();
    await vi.waitFor(() => expect($('[data-call-camera-off]')).toBeNull());
  });

  it('a camera error, then a drop: the camera error is shown as it is, never as a recovery that could not start', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'srcObject', 'set').mockImplementation(() => {});
    const host = stubHost({ messages_list: () => [] });
    await openShell();
    host.emitLive({ type: 'message', room_id: null, message: { ...msg(400, { media: 'video', sdp: 'offer' }), timestamp: Date.now() } });
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-accept]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-accept]')!.click();
    await vi.waitFor(() => expect(host.used('call_signal')).toHaveLength(1));
    const pc = FakePc.made[0]; pc.connect();
    await vi.waitFor(() => expect($('[data-call-panel="live"]')).not.toBeNull());
    $<HTMLButtonElement>('[data-call-camera]')!.click();
    await vi.waitFor(() => expect($('[data-call-camera]')!.getAttribute('aria-pressed')).toBe('false'));
    pc.senders[1].replaceTrack = async () => { throw new Error('sender failed'); };
    $<HTMLButtonElement>('[data-call-camera]')!.click();
    await vi.waitFor(() => expect($('[data-call-error]')).not.toBeNull());
    const cameraError = text('[data-call-error]');
    pc.state('disconnected');
    await vi.waitFor(() => expect($('[data-call-panel="reconnecting"]')).not.toBeNull());
    expect(text('[data-call-error]')).toBe(cameraError);
    expect(text('[data-call-error]')).not.toMatch(/Recovery could not start/);
  });

  it('a recovery that cannot start is said as such while it still waits for the connection', async () => {
    const host = stubHost({
      messages_list: () => [],
      call_signal: (args) => {
        if (args!.kind === 402) throw { code: 'spend_refused', message: 'Owner grant required.' };
        return { message_id: 'sig', kind: args!.kind, amount_msat: 1000, total_msat: 6000, max_routing_fee_msat: 5000, delivered: true, accepted: true, sent_at_ms: Date.now() };
      },
    });
    await openShell();
    host.emitLive({ type: 'message', room_id: null, message: { ...msg(400, { media: 'audio', sdp: 'offer' }), timestamp: Date.now() } });
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-accept]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-accept]')!.click();
    await vi.waitFor(() => expect(host.used('call_signal')).toHaveLength(1));
    const pc = FakePc.made[0]; pc.connect();
    await vi.waitFor(() => expect($('[data-call-panel="live"]')).not.toBeNull());
    pc.state('failed');
    await vi.waitFor(() => expect($('[data-call-error]')).not.toBeNull(), { timeout: 4000 });
    expect(text('[data-call-error]')).toMatch(/^Recovery could not start: .+ Still waiting for the connection to come back on its own\.$/);
    expect($('[data-call-panel="reconnecting"]')).not.toBeNull();
  });

  it('shows Reconnecting… and keeps video and controls mounted through a network blip', async () => {
    // Media playback is a browser boundary; these streams are track-owning fakes.
    vi.spyOn(HTMLMediaElement.prototype, 'srcObject', 'set').mockImplementation(() => {});
    const host = stubHost({ messages_list: () => [] });
    await openShell();
    host.emitLive({ type: 'message', room_id: null, message: { ...msg(400, { media: 'video', sdp: 'offer' }), timestamp: Date.now() } });
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-accept]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-accept]')!.click();
    await vi.waitFor(() => expect({ sent: host.used('call_signal').length, ended: text('[data-call-ended]') }).toEqual({ sent: 1, ended: '' }));
    const pc = FakePc.made[0]; pc.connect();
    await vi.waitFor(() => expect($('[data-call-panel="live"]')).not.toBeNull());
    const video = $('[data-call-media="local"]');
    pc.state('disconnected');
    await vi.waitFor(() => expect(text('[data-call-title]')).toContain('Reconnecting…'));
    expect($('[data-call-media="local"]')).toBe(video);
    expect($('[data-call-mute]')).not.toBeNull();
    expect($('[data-call-hangup]')).not.toBeNull();
    pc.connect();
    await vi.waitFor(() => expect($('[data-call-panel="live"]')).not.toBeNull());
    expect(host.used('call_signal').map(c => c.args!.kind)).toEqual([401]);
  });

  it.each([['NotAllowedError', /permission.*denied/i], ['NotFoundError', /no.*microphone/i]])('shows a clear %s capture error and enables another call', async (name, message) => {
    const host = stubHost();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => { throw new DOMException('capture failed', name as string); } } });
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    ring('audio');
    await vi.waitFor(() => expect(text('[data-call-ended]')).toMatch(message as RegExp));
    expect(host.used('call_signal')).toHaveLength(0);
    expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false);
  });

  it('a contact whose node does not take calls cannot be rung', async () => {
    const host = stubHost({ call_quote: () => ({ ...QUOTE, offer_msat: null, offer_max_routing_fee_msat: 0, call_total_msat: null }) });
    await openShell();
    await vi.waitFor(() => expect($('[data-call="audio"]')!.getAttribute('title')).toMatch(/gave no call price\. They may be offline/));
    expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(true);
    expect(host.used('call_signal')).toHaveLength(0);
  });

  it('an offline contact is offline, not a node that does not take calls, and back online their price is read again', async () => {
    let connected = false;
    const host = stubHost({
      peers_list: () => [{ node_id: A, addr: null, label: 'Maya', connected, fingerprint: null }],
      call_quote: () => connected ? QUOTE : ({ ...QUOTE, offer_msat: null, offer_max_routing_fee_msat: 0, call_total_msat: null }),
    });
    await openShell();
    await vi.waitFor(() => expect($('[data-call="audio"]')!.getAttribute('title')).toBe('Maya is offline, so you can’t call them right now.'));
    expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(true);
    connected = true;
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false), { timeout: 20_000 });
    expect($('[data-call="audio"]')!.getAttribute('title')).not.toMatch(/offline|does not take calls/);
    expect(host.used('call_quote').length).toBeGreaterThan(1);
  }, 30_000);

  it('a missed call from an offline contact: Call back says offline, and once they are back it reads the price again and rings', async () => {
    let connected = false;
    const host = stubHost({
      messages_list: () => [],
      peers_list: () => [{ node_id: A, addr: null, label: 'Maya', connected, fingerprint: null }],
      call_quote: () => connected ? QUOTE : ({ ...QUOTE, offer_msat: null, offer_max_routing_fee_msat: 0, call_total_msat: null }),
    });
    await openShell();
    host.emitLive({ type: 'message', room_id: null, message: msg(400, { media: 'audio', sdp: 'offer' }) });
    host.emitLive({ type: 'message', room_id: null, message: msg(403, { reason: 'hangup' }) });
    await vi.waitFor(() => expect($('[data-missed-call] [data-call-back]')).not.toBeNull());
    await vi.waitFor(() => expect($('[data-call-back]')!.getAttribute('title')).toBe('Maya is offline, so you can’t call them right now.'));
    expect($<HTMLButtonElement>('[data-call-back]')!.disabled).toBe(true);
    connected = true;
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-back]')!.disabled).toBe(false), { timeout: 20_000 });
    expect($('[data-call-back]')!.getAttribute('title')).not.toMatch(/offline|does not take calls/);
    expect(host.used('call_quote').length).toBeGreaterThan(2);
  }, 30_000);

  it.each(['price', 'refusal'] as const)('a %s read while they were offline, answering after the read on their return, changes nothing', async (late) => {
    const STALE = 'Their node did not answer in time.';
    let connected = false;
    let answerOffline: () => void = () => {};
    const host = stubHost({
      peers_list: () => [{ node_id: A, addr: null, label: 'Maya', connected, fingerprint: null }],
      call_quote: () => {
        if (connected) return QUOTE;
        return new Promise((resolve, reject) => {
          answerOffline = () => late === 'price'
            ? resolve({ ...QUOTE, offer_msat: null, offer_max_routing_fee_msat: 0, call_total_msat: null })
            : reject({ code: 'price_quote_unavailable', message: STALE });
        });
      },
    });
    await openShell();
    await vi.waitFor(() => expect(host.used('call_quote').length).toBeGreaterThan(0));
    connected = true;
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false), { timeout: 20_000 });
    const online = $('[data-call="audio"]')!.getAttribute('title');
    answerOffline();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false);
    expect($('[data-call="audio"]')!.getAttribute('title')).toBe(online);
  }, 30_000);

  it('says an offline contact in Danish too', async () => {
    stubHost({
      peers_list: () => [{ node_id: A, addr: null, label: 'Maya', connected: false, fingerprint: null }],
      call_quote: () => ({ ...QUOTE, offer_msat: null, offer_max_routing_fee_msat: 0, call_total_msat: null }),
    });
    setLanguagePref('da');
    await openShell();
    await vi.waitFor(() => expect($('[data-call="audio"]')!.getAttribute('title')).toBe('Maya er offline, så du kan ikke ringe til dem lige nu.'));
  });

  it('puts the cost in the accessible names and lets the caller cancel before paying', async () => {
    const host = stubHost();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => new Promise<MediaStream>(() => {}) } });
    await openShell();
    await vi.waitFor(() => expect($('[data-call="audio"]')!.getAttribute('aria-label')).toBe('Call Maya, up to 42 sats'));
    expect($('[data-call="video"]')!.getAttribute('aria-label')).toBe('Video call Maya, up to 42 sats');
    expect($('[data-call="audio"]')!.getAttribute('title')).toMatch(/No STUN server is set/);
    ring('audio');
    await vi.waitFor(() => expect($('[data-call-panel="calling"]')).not.toBeNull());
    const cancel = $<HTMLButtonElement>('[data-call-hangup]')!;
    expect(cancel.disabled).toBe(false);
    expect(cancel.textContent?.trim()).toBe('Cancel');
    cancel.click();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect(host.used('call_signal')).toHaveLength(0);
  });

  it('closing the shell during a call ends it without a paid hangup', async () => {
    const host = stubHost({ messages_list: () => [] });
    await openShell();
    host.emitLive({ type: 'message', room_id: null, message: { id: 'o', kind: 400, sender: A, recipient: OWN, timestamp: Date.now(), plaintext: JSON.stringify({ v: 1, call_id: ID, media: 'audio', sdp: 'v=0 offer' }), payment_amount_msat: 10_000 } });
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-accept]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-accept]')!.click();
    await vi.waitFor(() => expect(host.used('call_signal')).toHaveLength(1));
    FakePc.made[0].connect();
    await vi.waitFor(() => expect($('[data-call-panel="live"]')).not.toBeNull());
    dispose!();
    dispose = undefined;
    await new Promise((r) => setTimeout(r, 50));
    expect(host.used('call_signal').map((c) => c.args!.kind)).toEqual([401]);
    expect(FakePc.made[0].closed).toBe(true);
  });

  it('the call pane\'s "no STUN server" note opens Settings → General → Calls', async () => {
    stubHost();
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    ring('audio');
    await vi.waitFor(() => expect($('[data-call-network-note]')).not.toBeNull());
    expect(text('[data-call-network-note]')).toContain('Settings → General → Calls');
    $<HTMLButtonElement>('[data-call-settings-link]')!.click();
    await vi.waitFor(() => expect($('[data-settings]')?.classList.contains('open')).toBe(true));
    expect($('[data-tab="general"]')!.getAttribute('aria-selected')).toBe('true');
    expect($('[data-stun-input]')).not.toBeNull();
  });

  it('offline during a live call shows an offline note in the call panel (display only); online removes it', async () => {
    const host = stubHost({ messages_list: () => [] });
    await openShell();
    host.emitLive({ type: 'message', room_id: null, message: { id: 'o', kind: 400, sender: A, recipient: OWN, timestamp: Date.now(), plaintext: JSON.stringify({ v: 1, call_id: ID, media: 'audio', sdp: 'v=0 offer' }), payment_amount_msat: 10_000 } });
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-accept]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-accept]')!.click();
    await vi.waitFor(() => expect(host.used('call_signal')).toHaveLength(1));
    FakePc.made[0].connect();
    await vi.waitFor(() => expect($('[data-call-panel="live"]')).not.toBeNull());
    window.dispatchEvent(new Event('offline'));
    await vi.waitFor(() => expect(text('[data-call-offline]')).toBe('You are offline. The call reconnects by itself if your network comes back in time.'));
    expect($('[data-call-panel="live"]')).not.toBeNull();
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect($('[data-call-offline]')).toBeNull());
    expect(host.used('call_signal')).toHaveLength(1);
  });

  it('a build whose webview has no media devices ends the call with "This build cannot use the microphone yet", nothing paid', async () => {
    const host = stubHost();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    ring('audio');
    await vi.waitFor(() => expect(text('[data-call-ended]')).toBe('This build cannot use the microphone yet. Nothing was paid.'));
    expect(host.used('call_signal')).toHaveLength(0);
  });

  it('H2: hanging up a call we placed asks the host to end it once (op_end_call), with no hangup paid by the app', async () => {
    const host = stubHost();
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    ring('audio');
    await vi.waitFor(() => expect($('[data-call-hangup]')).not.toBeNull());
    await vi.waitFor(() => expect(host.used('call_signal')).toHaveLength(1));
    $<HTMLButtonElement>('[data-call-hangup]')!.click();
    await vi.waitFor(() => expect(host.used('op_end_call')).toHaveLength(1));
    const callId = host.used('call_signal')[0].args!.plaintext as string;
    expect(host.used('op_end_call')[0].args).toEqual({ call_id: JSON.parse(callId).call_id });
    expect(host.used('call_signal').map((c) => c.args!.kind)).toEqual([400]);
    // "Ending the call at your node…" while it runs; nothing more once it is ended.
    await vi.waitFor(() => expect($('[data-call-close]')).toBeNull());
    expect(host.used('op_end_call')).toHaveLength(1);
  });

  it.each([null, ID])('unresolved call index is visible and owner repair uses only the host binding: %s', async (repaired) => {
    const index = 'a'.repeat(64);
    let reviewed = false;
    const host = stubHost({
      op_list: () => ({ operations: [], skipped: 1, has_more: false,
        unresolved_calls: reviewed && repaired ? [] : [{ index_id: index, acknowledged: reviewed, hangup_cap_msat: 5000 }] }),
      op_repair_call_index: () => { reviewed = true; return repaired; },
    });
    await openShell();
    await vi.waitFor(() => expect($('[data-call-repair]')).not.toBeNull());
    expect(text('[data-call-repairs]')).toContain('Unresolved call record');
    expect(text('[data-call-repair]')).toContain('up to 5 sats');
    expect(host.used('op_end_call')).toHaveLength(0);
    $<HTMLButtonElement>('[data-call-repair]')!.click();
    await vi.waitFor(() => expect(host.used('op_repair_call_index').length).toBeGreaterThanOrEqual(1));
    expect(host.used('op_repair_call_index')[0].args).toEqual({ index_id: index });
    if (repaired) {
      await vi.waitFor(() => expect(host.used('op_end_call')).toHaveLength(1));
      expect(host.used('op_end_call')[0].args).toEqual({ call_id: ID, max_msat: 5000 });
      await vi.waitFor(() => expect(text('[data-call-repair-result]')).toContain('ended'));
    } else {
      await vi.waitFor(() => expect(text('[data-call-repair-result]')).toContain('still blocked'));
      expect(host.used('op_end_call')).toHaveLength(0);
      expect($('[data-call-repair]')).not.toBeNull();
    }
    expect(host.used('call_signal')).toHaveLength(0);
  });

  it.each(['price_changed', 'payment_unknown'])('repair keeps its owner action when ending returns %s', async (code) => {
    const index = 'b'.repeat(64);
    const host = stubHost({
      op_list: () => ({ operations: [], skipped: 0, has_more: false, unresolved_calls: [{ index_id: index, acknowledged: false, hangup_cap_msat: 5000 }] }),
      op_repair_call_index: () => ID,
      op_end_call: () => { throw { code, message: 'End not confirmed.' }; },
    });
    await openShell();
    await vi.waitFor(() => expect($('[data-call-repair]')).not.toBeNull());
    $<HTMLButtonElement>('[data-call-repair]')!.click();
    await vi.waitFor(() => expect(text('[data-call-repair-result]')).toContain(code === 'payment_unknown' ? 'not known yet' : 'Couldn’t end the call'));
    expect(host.used('op_repair_call_index')).toHaveLength(1);
    expect($('[data-call-again]')).toBeNull();
    expect($<HTMLButtonElement>('[data-call-repair]')!.disabled).toBe(false);
    $<HTMLButtonElement>('[data-call-repair]')!.click();
    await vi.waitFor(() => expect(host.used('op_end_call')).toHaveLength(2));
    expect(host.used('call_signal')).toHaveLength(0);
  });

  it('repair without a verified saved price checks metadata without paying a hangup', async () => {
    let repaired = false;
    const host = stubHost({
      op_list: () => ({ operations: [], skipped: 0, has_more: false, unresolved_calls: [{ index_id: 'c'.repeat(64), acknowledged: false, hangup_cap_msat: repaired ? 6000 : null }] }),
      op_repair_call_index: () => { repaired = true; return ID; },
    });
    await openShell();
    await vi.waitFor(() => expect($('[data-call-repair]')).not.toBeNull());
    expect(text('[data-call-repair]')).toBe('Check repair / acknowledge');
    $<HTMLButtonElement>('[data-call-repair]')!.click();
    await vi.waitFor(() => expect(text('[data-call-repair-result]')).toContain('Review the saved limit'));
    expect(host.used('op_end_call')).toHaveLength(0);
    await vi.waitFor(() => expect(text('[data-call-repair]')).toContain('up to 6 sats'));
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-repair]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-repair]')!.click();
    await vi.waitFor(() => expect(host.used('op_end_call')).toHaveLength(1));
    expect(host.used('op_end_call')[0].args).toEqual({ call_id: ID, max_msat: 6000 });
  });

  it('recovery End call offers a priced Call again only after host closure', async () => {
    let offers = 0;
    let close!: (r: unknown) => void;
    const host = stubHost({
      call_signal: (args) => {
        if (++offers > 1) throw { code: 'call_admission_open', message: 'generic', operation_id: 'original' };
        return { operation_id: 'original', message_id: 'sig', kind: args!.kind, amount_msat: 10000, total_msat: 15000, max_routing_fee_msat: 5000, delivered: true, accepted: true, sent_at_ms: Date.now() };
      },
      op_end_call: () => new Promise(r => { close = r; }),
    });
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    ring('audio');
    await vi.waitFor(() => expect(host.used('call_signal')).toHaveLength(1));
    const id = JSON.parse(host.used('call_signal')[0].args!.plaintext as string).call_id;
    host.emitLive({ type: 'message', room_id: null, message: msg(401, { call_id: id, sdp: 'answer' }) });
    await vi.waitFor(() => expect(FakePc.made[0].remote).not.toBeNull());
    FakePc.made[0].connect(); FakePc.made[0].state('failed');
    await vi.waitFor(() => expect(text('[data-call-error]')).toBe('Your last call is still closing. End it, then call again.'));
    expect(text('[data-call-hangup]')).toBe('End call');
    $<HTMLButtonElement>('[data-call-hangup]')!.click();
    await vi.waitFor(() => expect(host.used('op_end_call')).toHaveLength(1));
    expect(host.used('op_end_call')[0].args).toEqual({ call_id: id });
    expect($('[data-call-again]')).toBeNull();
    close({ op_id: 'end', kind: 'call_hangup', peer: A, call_id: id, state: 'settled', cap_msat: 6000, paid_msat: 1000, message_id: 'end' });
    await vi.waitFor(() => expect($('[data-call-again]')).not.toBeNull());
    $<HTMLButtonElement>('[data-call-again]')!.click();
    await vi.waitFor(() => expect(text('[data-call-again-confirm]')).toContain('Ring'));
    expect(host.used('call_signal')).toHaveLength(2); // merely offering another call never pays
  });

  it('H2: "a call to Maya is still closing", never a silent block; End that call ends the one the host holds', async () => {
    const earlier = 'c'.repeat(32);
    const host = stubHost({
      call_signal: () => { throw { code: 'call_admission_open', message: 'End the existing call before starting another admission. Nothing was paid.', operation_id: 'op-old' }; },
      op_list: () => ({ operations: [
        { op_id: 'op-other', kind: 'message', peer: A, call_id: null, state: 'settled', cap_msat: 1, paid_msat: 1, message_id: 'm' },
        { op_id: 'op-old', kind: 'call_offer', peer: A, call_id: earlier, state: 'settled', cap_msat: 15_000, paid_msat: 10_000, message_id: 'o' },
      ], skipped: 0, has_more: false }),
    });
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    ring('audio');
    await vi.waitFor(() => expect(text('[data-call-ended]')).toBe('A call to Maya is still closing at your node. Nothing was paid for this one. End it to call again.'));
    expect(host.used('op_end_call')).toHaveLength(0);
    $<HTMLButtonElement>('[data-call-end-stuck]')!.click();
    await vi.waitFor(() => expect(text('[data-call-close]')).toBe('The earlier call is ended. You can call them again.'));
    expect(host.used('op_list').some(c => c.args?.peer === A)).toBe(true);
    expect(host.used('op_end_call').map((c) => c.args)).toEqual([{ call_id: earlier }]);
    expect($('[data-call-end-stuck]')).toBeNull();
  });

  it('H2: an end the host could not confirm says "check pending result"; a refused one offers to try again', async () => {
    let reply: () => unknown = () => { throw { code: 'spend_unknown', message: 'Outcome unknown.' }; };
    const host = stubHost({ op_end_call: () => reply() });
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    ring('audio');
    await vi.waitFor(() => expect(host.used('call_signal')).toHaveLength(1));
    $<HTMLButtonElement>('[data-call-hangup]')!.click();
    await vi.waitFor(() => expect($('[data-call-close="unknown"]')).not.toBeNull());
    expect(text('[data-call-close]')).toContain('Check pending result');
    expect($('[data-call-close-retry]')).toBeNull();
    $<HTMLButtonElement>('[data-call-dismiss]')!.click();
    reply = () => { throw { code: 'price_changed', message: 'Price changed.' }; };
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    ring('audio');
    await vi.waitFor(() => expect(host.used('call_signal')).toHaveLength(2));
    $<HTMLButtonElement>('[data-call-hangup]')!.click();
    await vi.waitFor(() => expect($('[data-call-close="refused"]')).not.toBeNull());
    reply = () => ({ op_id: 'e', kind: 'call_hangup', peer: A, call_id: ID, state: 'settled', cap_msat: 6000, paid_msat: 6000, message_id: 'h' });
    $<HTMLButtonElement>('[data-call-close-retry]')!.click();
    await vi.waitFor(() => expect($('[data-call-close]')).toBeNull());
    expect(host.used('op_end_call')).toHaveLength(3);
  });

  it('H2: a node without call operations refuses the offer up front; the card says an update is needed and nothing was paid', async () => {
    const host = stubHost({ call_signal: () => { throw { code: 'call_needs_node_upgrade', message: 'Upgrade your node before making calls: it cannot track call payments and admission safely. Nothing was paid.' }; } });
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    ring('audio');
    await vi.waitFor(() => expect(text('[data-call-ended]')).toBe('Your node needs an update before paid calls work. Nothing was paid.'));
    expect(host.used('op_end_call')).toHaveLength(0);
    expect($('[data-call-close]')).toBeNull();
  });

  it('the STUN server is an owner setting, validated, with a note that it contacts that server', async () => {
    stubHost();
    await openShell();
    $<HTMLButtonElement>('[data-profile]')!.click();
    $<HTMLButtonElement>('[data-open-settings]')!.click();
    $<HTMLButtonElement>('[data-tab="general"]')!.click();
    await vi.waitFor(() => expect($('[data-call-settings]')).not.toBeNull());
    expect(text('[data-stun-note]')).toMatch(/No STUN server: calls contact no third party/);
    const input = $<HTMLInputElement>('[data-stun-input]')!;
    input.value = 'turn:relay.example.org';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    $<HTMLButtonElement>('[data-stun-save]')!.click();
    await vi.waitFor(() => expect(text('[data-stun-error]')).toMatch(/TURN relays are not supported/));
    // A typed turn: entry is refused and changes nothing.
    expect(localStorage.getItem('bitsov.stun')).toBeNull();
    expect(text('[data-stun-note]')).toMatch(/No STUN server/);
    input.value = 'stun:own-node.example:3478';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    $<HTMLButtonElement>('[data-stun-save]')!.click();
    await vi.waitFor(() => expect(text('[data-stun-note]')).toBe('Server you chose: own-node.example:3478. That server sees your IP when you place or take a call.'));
    // The next call uses it.
    ring('audio');
    await vi.waitFor(() => expect(FakePc.made).toHaveLength(1));
    expect(FakePc.made[0].config.iceServers).toEqual([{ urls: 'stun:own-node.example:3478' }]);
    $<HTMLButtonElement>('[data-stun-clear]')!.click();
    await vi.waitFor(() => expect(text('[data-stun-note]')).toMatch(/STUN is turned off/));
  });

  const overviewWith = (extra: Record<string, unknown>) => () => ({ node_id: OWN, status: 'ok', version: 'api v2', connected_peers: 1, e2ee_sessions: 1, pending_deliveries: 0,
    lightning_available: true, block_height: 1, uptime_secs: 1, lightning_backend: 'ldk', chain_backend: 'esplora', read_at: Date.now(), ...extra });

  it('uses the node\'s own STUN responder by default (never a third party); the owner can turn it off and back on', async () => {
    const own = 'stun:mynode.example.org:3478';
    stubHost({ node_overview: overviewWith({ stun_source: 'own', stun_port: 3478, stun_url: own }) });
    await openShell();
    $<HTMLButtonElement>('[data-profile]')!.click();
    $<HTMLButtonElement>('[data-open-settings]')!.click();
    $<HTMLButtonElement>('[data-tab="general"]')!.click();
    await vi.waitFor(() => expect($('[data-stun-note]')?.getAttribute('data-stun-using')).toBe('own'));
    expect(text('[data-stun-note]')).toMatch(/your own node \(stun:mynode\.example\.org:3478\).*No third party.*This is the default\./);
    expect(localStorage.getItem('bitsov.stun')).toBeNull();
    expect($('[data-stun-own]')).toBeNull();
    // The Call button's tooltip says the same (no "No STUN server is set").
    expect($('[data-call="audio"]')!.getAttribute('title')).toContain(`Uses your own node (${own}) to find a route.`);
    expect($('[data-call="audio"]')!.getAttribute('title')).not.toContain('No STUN server');
    // A call uses it with no setting saved.
    ring('audio');
    await vi.waitFor(() => expect(FakePc.made).toHaveLength(1));
    expect(FakePc.made[0].config.iceServers).toEqual([{ urls: own }]);
    $<HTMLButtonElement>('[data-call-hangup]')!.click();
    // Turn off: no STUN at all, and it stays off.
    $<HTMLButtonElement>('[data-stun-clear]')!.click();
    await vi.waitFor(() => expect($('[data-stun-note]')?.getAttribute('data-stun-using')).toBe('off'));
    expect(localStorage.getItem('bitsov.stun')).toBe('off');
    expect($('[data-call="audio"]')!.getAttribute('title')).toContain('STUN is turned off');
    $<HTMLButtonElement>('[data-call-dismiss]')?.click();
    ring('audio');
    await vi.waitFor(() => expect(FakePc.made).toHaveLength(2));
    expect(FakePc.made[1].config.iceServers).toEqual([]);
    $<HTMLButtonElement>('[data-call-hangup]')!.click();
    // Back on: "Use my node" fills the field; Save uses it.
    $<HTMLButtonElement>('[data-stun-own]')!.click();
    await vi.waitFor(() => expect($<HTMLInputElement>('[data-stun-input]')!.value).toBe(own));
    $<HTMLButtonElement>('[data-stun-save]')!.click();
    await vi.waitFor(() => expect($('[data-stun-note]')?.getAttribute('data-stun-using')).toBe('own'));
  });

  it('Off survives a reload (stored), and the owner\'s own server beats the node default', async () => {
    const own = 'stun:mynode.example.org:3478';
    stubHost({ node_overview: overviewWith({ stun_source: 'own', stun_port: 3478, stun_url: own }) });
    await openShell();
    $<HTMLButtonElement>('[data-profile]')!.click();
    $<HTMLButtonElement>('[data-open-settings]')!.click();
    $<HTMLButtonElement>('[data-tab="general"]')!.click();
    await vi.waitFor(() => expect($('[data-stun-note]')?.getAttribute('data-stun-using')).toBe('own'));
    $<HTMLButtonElement>('[data-stun-clear]')!.click();
    await vi.waitFor(() => expect($('[data-stun-note]')?.getAttribute('data-stun-using')).toBe('off'));
    expect(localStorage.getItem('bitsov.stun')).toBe('off');
    // A real reload: fresh module state reads the stored choice; the node default does not come back.
    vi.resetModules();
    const fresh = await import('../src/control/prefs');
    fresh.setNodeStun(own, 'own');
    expect(fresh.stunOff()).toBe(true);
    expect(fresh.effectiveStun()).toBe('');
    // Control: with nothing stored, a fresh module falls back to the node default (so the read above is real).
    localStorage.removeItem('bitsov.stun');
    vi.resetModules();
    const clean = await import('../src/control/prefs');
    clean.setNodeStun(own, 'own');
    expect(clean.stunOff()).toBe(false);
    expect(clean.effectiveStun()).toBe(own);
    localStorage.setItem('bitsov.stun', 'off');
    dispose!(); dispose = undefined; mount.remove();
    await openShell();
    $<HTMLButtonElement>('[data-profile]')!.click();
    $<HTMLButtonElement>('[data-open-settings]')!.click();
    $<HTMLButtonElement>('[data-tab="general"]')!.click();
    await vi.waitFor(() => expect($('[data-stun-note]')?.getAttribute('data-stun-using')).toBe('off'));
    // The owner's own server beats the node default.
    const input = $<HTMLInputElement>('[data-stun-input]')!;
    input.value = 'stun:other.example:3478';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    $<HTMLButtonElement>('[data-stun-save]')!.click();
    await vi.waitFor(() => expect($('[data-stun-note]')?.getAttribute('data-stun-using')).toBe('other'));
    ring('audio');
    await vi.waitFor(() => expect(FakePc.made).toHaveLength(1));
    expect(FakePc.made[0].config.iceServers).toEqual([{ urls: 'stun:other.example:3478' }]);
  });

  it.each([undefined, 3478, 5349])('uses the configured STUN server with honest bilingual labels (own port %s)', async (port) => {
    const url = 'stun:chosen.example.org:5349';
    stubHost({ node_overview: overviewWith({ stun_source: 'configured', stun_port: port, stun_url: url }) });
    await openShell();
    $<HTMLButtonElement>('[data-profile]')!.click();
    $<HTMLButtonElement>('[data-open-settings]')!.click();
    $<HTMLButtonElement>('[data-tab="general"]')!.click();
    const en = 'Server you chose: chosen.example.org:5349. That server sees your IP when you place or take a call.';
    const da = 'Server, du har valgt: chosen.example.org:5349. Den server ser din IP-adresse, når du foretager eller modtager et opkald.';
    await vi.waitFor(() => expect(text('[data-stun-note]')).toBe(en));
    expect($('[data-stun-note]')?.getAttribute('data-stun-using')).toBe('configured');
    expect($('[data-stun-own]')).toBeNull();
    expect($('[data-stun-own-hint]')).toBeNull();
    expect(localStorage.getItem('bitsov.stun')).toBeNull();
    for (const [lang, label] of [['da', da], ['en', en]] as const) {
      setLanguagePref(lang);
      await vi.waitFor(() => expect(text('[data-stun-note]')).toBe(label));
      expect($('[data-call="audio"]')!.getAttribute('title')).toContain(label);
      expect(text('[data-call-settings]')).not.toMatch(/No third party|ingen tredjepart|your own node|din egen node/i);
      $<HTMLButtonElement>('[data-call="audio"]')!.click();
      expect(text('[data-call-confirm-box]')).toContain(label);
      $<HTMLButtonElement>('[data-call-confirm-cancel]')!.click();
    }
    ring('audio');
    await vi.waitFor(() => expect(FakePc.made).toHaveLength(1));
    expect(FakePc.made[0].config.iceServers).toEqual([{ urls: url }]);
  });

  it.each([
    { source: undefined, url: 'stun:node.example.org:3478' },
    { source: null, url: 'stun:node.example.org:3478' },
    { source: undefined, url: undefined },
    { source: null, url: undefined },
  ])('ignores node STUN without a source and keeps the warning (%j)', async ({ source, url }) => {
    // The host drops an unclassified URL; cover that projected shape too.
    stubHost({ node_overview: overviewWith({ stun_source: source, stun_port: 3478, stun_url: url }) });
    await openShell();
    expect($('[data-call="audio"]')!.getAttribute('title')).toContain('No STUN server is set');
    $<HTMLButtonElement>('[data-profile]')!.click();
    $<HTMLButtonElement>('[data-open-settings]')!.click();
    $<HTMLButtonElement>('[data-tab="general"]')!.click();
    await vi.waitFor(() => expect($('[data-stun-note]')?.getAttribute('data-stun-using')).toBe('none'));
    expect(text('[data-stun-note]')).toMatch(/No STUN server: calls contact no third party/);
    expect($('[data-stun-own]')).toBeNull();
    expect($('[data-stun-own-hint]')).toBeNull();
    ring('audio');
    await vi.waitFor(() => expect(FakePc.made).toHaveLength(1));
    expect(FakePc.made[0].config.iceServers).toEqual([]);
    expect($('[data-call-network-note]')).not.toBeNull();
  });

  it('labels own STUN in Danish in Settings and the call-cost line', async () => {
    stubHost({ node_overview: overviewWith({ stun_source: 'own', stun_port: 3478, stun_url: 'stun:node.example.org:3478' }) });
    await openShell();
    $<HTMLButtonElement>('[data-profile]')!.click();
    $<HTMLButtonElement>('[data-open-settings]')!.click();
    $<HTMLButtonElement>('[data-tab="general"]')!.click();
    setLanguagePref('da');
    await vi.waitFor(() => expect(text('[data-stun-note]')).toContain('din egen node'));
    expect($('[data-call="audio"]')!.getAttribute('title')).toContain('din egen node');
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    expect(text('[data-call-confirm-box]')).toContain('din egen node');
  });

  it('an unusable answer from their app is not a connectivity failure: no relay advice', async () => {
    const host = stubHost();
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    ring('audio');
    await vi.waitFor(() => expect(host.used('call_signal')).toHaveLength(1));
    await vi.waitFor(() => expect($('[data-call-panel="ringing"]')).not.toBeNull());
    const callId = JSON.parse(host.used('call_signal')[0].args!.plaintext as string).call_id as string;
    FakePc.made[0].setRemoteDescription = async () => { throw new Error('bad sdp'); };
    host.emitLive({ type: 'message', room_id: null, message: { id: 'ans', kind: 401, sender: A, recipient: OWN, timestamp: Date.now(), plaintext: JSON.stringify({ v: 1, call_id: callId, sdp: 'v=0 junk' }), payment_amount_msat: 1000 } });
    await vi.waitFor(() => expect(text('[data-call-ended]')).toBe('Their answer could not be used.'));
    expect($('[data-call-no-relay]')).toBeNull();
  });

  it('a failed call says that some networks need a relay your node does not offer yet (no money claim)', async () => {
    stubHost();
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    ring('audio');
    await vi.waitFor(() => expect(FakePc.made).toHaveLength(1));
    FakePc.made[0].state('closed');
    await vi.waitFor(() => expect($('[data-call-no-relay]')).not.toBeNull());
    expect(text('[data-call-no-relay]')).toBe('Some networks need a relay to connect a call, and your node does not offer one yet.');
    expect(text('[data-call-no-relay]')).not.toMatch(/paid/i);
  });

  it('never offers a malformed or relay URL, and explains a responder without a public address', async () => {
    stubHost({ node_overview: overviewWith({ stun_source: 'own', stun_port: 3478, stun_url: 'turn:mynode.example.org:3478' }) });
    await openShell();
    $<HTMLButtonElement>('[data-profile]')!.click();
    $<HTMLButtonElement>('[data-open-settings]')!.click();
    $<HTMLButtonElement>('[data-tab="general"]')!.click();
    await vi.waitFor(() => expect($('[data-stun-own-hint]')).not.toBeNull());
    expect($('[data-stun-own]')).toBeNull();
    expect(text('[data-stun-own-hint]')).toMatch(/UDP port 3478, but it has no public address set/);
  });

  it('shows nothing about an own responder when the node runs none', async () => {
    stubHost();
    await openShell();
    $<HTMLButtonElement>('[data-profile]')!.click();
    $<HTMLButtonElement>('[data-open-settings]')!.click();
    $<HTMLButtonElement>('[data-tab="general"]')!.click();
    await vi.waitFor(() => expect($('[data-call-settings]')).not.toBeNull());
    expect($('[data-stun-own]')).toBeNull();
    expect($('[data-stun-own-hint]')).toBeNull();
  });

  // Call end states: one plain cause per end, no protocol text in the chat, never a card gone without its end.
  const boundHost = (over: Record<string, Reply> = {}) => stubHost({
    call_signal: (args) => ({ operation_id: args!.kind === 400 ? 'op-400' : null, message_id: 'sig', kind: args!.kind, amount_msat: 10_000, total_msat: 15_000, max_routing_fee_msat: 5000, delivered: true, accepted: true, sent_at_ms: Date.now() }),
    ...over,
  });

  it.each([
    ['en', 'hangup', 'No answer'], ['da', 'hangup', 'Intet svar'],
    ['en', 'timeout', 'No answer'], ['en', 'declined', 'Declined'], ['da', 'declined', 'Afvist'], ['en', 'busy', 'Busy'],
  ] as const)('their side ending our ringing call (%s, %s) says "%s"; only an explicit decline says declined', async (lang, reason, said) => {
    const host = boundHost();
    await openShell();
    setLanguagePref(lang);
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    ring('audio');
    await vi.waitFor(() => expect($('[data-call-panel="ringing"]')).not.toBeNull());
    const callId = JSON.parse(host.used('call_signal')[0].args!.plaintext as string).call_id as string;
    host.emitLive({ type: 'message', room_id: null, message: { ...msg(403, { call_id: callId, reason }), admission_operation_id: 'op-400' } });
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect(text('[data-call-ended]')).toBe(said);
  });

  it.each(['en', 'da'] as const)('our own ring running out says No answer, never Hung up (%s)', async (lang) => {
    boundHost();
    await openShell();
    setLanguagePref(lang);
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    ring('audio');
    await vi.waitFor(() => expect($('[data-call-panel="ringing"]')).not.toBeNull());
    await vi.advanceTimersByTimeAsync(RING_MS + 1);
    vi.useRealTimers();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect(text('[data-call-ended]')).toBe(lang === 'en' ? 'No answer' : 'Intet svar');
    expect(text('[data-call-panel]')).not.toMatch(/Hung up|Lagt på/);
  });

  it.each([
    ['en', 'The connection to Maya was lost.', /The direct connection closed\./],
    ['da', 'Forbindelsen til Maya blev afbrudt.', /Den direkte forbindelse blev lukket\./],
  ] as const)('a lost connection ends with one plain cause that never blames money; the technical words only under a closed Details (%s)', async (lang, said, technical) => {
    stubHost();
    await liveCall();
    setLanguagePref(lang);
    FakePc.made[0].state('closed');
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect(text('[data-call-ended]')).toBe(said);
    expect(text('[data-call-ended]')).not.toMatch(/sats|paid|budget|betal|brugt/i);
    const details = $<HTMLDetailsElement>('[data-call-end-detail]')!;
    expect(details.open).toBe(false);
    expect(details.textContent).toMatch(technical);
  });

  it.each([
    ['en', 'da', 'Forbindelsen til Maya blev afbrudt.', /The direct connection closed\./],
    ['da', 'en', 'The connection to Maya was lost.', /Den direkte forbindelse blev lukket\./],
  ] as const)('changing the language on a lost-connection ended card (%s to %s) re-words the cause; the technical words stay under Details', async (from, to, said, technical) => {
    stubHost();
    await liveCall();
    setLanguagePref(from);
    FakePc.made[0].state('closed');
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    setLanguagePref(to);
    await vi.waitFor(() => expect(text('[data-call-ended]')).toBe(said));
    expect($<HTMLDetailsElement>('[data-call-end-detail]')!.open).toBe(false);
    expect($('[data-call-end-detail]')!.textContent).toMatch(technical);
  });

  it.each([['en', 'da', 'Opkaldet kunne ikke besvares.'], ['da', 'en', 'The call could not be answered.']] as const)('changing the language after a refused answer (%s to %s) re-words the line; the host text stays only under Details', async (from, to, said) => {
    const RAW = 'host: answer_dispatch_refused (op 7)';
    const host = stubHost({ messages_list: () => [], call_signal: () => { throw { code: 'node', message: RAW }; } });
    await openShell();
    setLanguagePref(from);
    host.emitLive({ type: 'message', room_id: null, message: msg(400, { media: 'audio', sdp: 'offer' }) });
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-accept]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-accept]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect(text('[data-call-ended]')).not.toContain(RAW);
    setLanguagePref(to);
    await vi.waitFor(() => expect(text('[data-call-ended]')).toBe(said));
    expect($<HTMLDetailsElement>('[data-call-end-detail]')!.open).toBe(false);
    expect(text('[data-call-end-detail]')).toContain(RAW);
  });

  it.each([['en', 'da', /Intet blev betalt\.$/, /Nothing was paid/], ['da', 'en', /Nothing was paid\.$/, /Intet blev betalt/]] as const)('changing the language after a refused microphone (%s to %s) re-words the line', async (from, to, now, before) => {
    stubHost();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); } } });
    await openShell();
    setLanguagePref(from);
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    ring('audio');
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect(text('[data-call-ended]')).toMatch(before);
    setLanguagePref(to);
    await vi.waitFor(() => expect(text('[data-call-ended]')).toMatch(now));
    expect(text('[data-call-ended]')).not.toMatch(before);
  });

  it.each([['en', 'Reconnecting…', 'Live'], ['da', 'Forbinder igen…', 'I gang']] as const)('frozen media on a live call shows Reconnecting, then Live again (%s)', async (lang, said, live) => {
    stubHost();
    await liveCall();
    setLanguagePref(lang);
    const pc = FakePc.made[0] as unknown as { oninterruption?: (endsAt: number | null) => void };
    pc.oninterruption!(Date.now() + 27_000);
    await vi.waitFor(() => expect($('[data-call-panel="reconnecting"]')).not.toBeNull());
    expect(text('[data-call-title]')).toBe(said);
    expect($('[data-call-reconnecting]')).not.toBeNull();
    expect($('[data-call-hangup]')).not.toBeNull();
    pc.oninterruption!(null);
    await vi.waitFor(() => expect($('[data-call-panel="live"]')).not.toBeNull());
    expect(text('[data-call-title]')).toBe(live);
  });

  it('an answered incoming call that ended keeps its card, with the reason and Call again', async () => {
    const host = stubHost({ messages_list: () => [] });
    await openShell();
    host.emitLive({ type: 'message', room_id: null, message: msg(400, { media: 'audio', sdp: 'offer' }) });
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-accept]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-accept]')!.click();
    await vi.waitFor(() => expect(FakePc.made).toHaveLength(1));
    FakePc.made[0].connect();
    await vi.waitFor(() => expect($('[data-call-panel="live"]')).not.toBeNull());
    FakePc.made[0].state('closed');
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect(text('[data-call-ended]')).toBe('The connection to Maya was lost.');
    expect($('[data-call-again]')).not.toBeNull();
  });

  it('call-control payloads never render in the chat, old history included; each call is one system line', async () => {
    const t0 = Date.now() - 60 * 60_000;
    const call = (id: string, kind: number, at: number, body: Record<string, unknown>, sender = A) =>
      ({ id, kind, sender, recipient: sender === A ? OWN : A, timestamp: t0 + at, plaintext: JSON.stringify(body), payment_amount_msat: 1000 });
    stubHost({ messages_list: (args) => (args!.peer === A ? [
      { id: 'chat-1', kind: 0, sender: A, recipient: OWN, timestamp: t0 - 1000, plaintext: 'hello', payment_amount_msat: 2000 },
      call('offer', 400, 0, { v: 1, call_id: ID, media: 'video', sdp: 'v=0' }, OWN),
      call('answer', 401, 5_000, { v: 1, call_id: ID, sdp: 'v=0' }),
      // An older app stored its minute receipts as ordinary messages.
      call('old-receipt-0', 0, 6_000, { call_id: ID, seq: 0 }, OWN),
      call('old-receipt-1', 0, 66_000, { call_id: ID, seq: 1 }, OWN),
      call('block-2', 404, 126_000, { call_id: ID, seq: 2 }, OWN),
      call('bye', 403, 5_000 + 8 * 60_000, { v: 1, call_id: ID, reason: 'hangup' }),
      { id: 'chat-2', kind: 0, sender: OWN, recipient: A, timestamp: t0 + 9 * 60_000, plaintext: 'talk soon', payment_amount_msat: 2000 },
    ] : []) });
    await openShell();
    await vi.waitFor(() => expect($('[data-message="chat-2"]')).not.toBeNull());
    const chat = $('[data-message="chat-1"]')!.closest('.stream, [data-stream], main') ?? mount;
    expect(chat.textContent).not.toContain('{"call_id"');
    expect(chat.textContent).not.toContain('"seq"');
    for (const id of ['offer', 'answer', 'old-receipt-0', 'old-receipt-1', 'block-2', 'bye']) expect($(`[data-message="${id}"]`)).toBeNull();
    const lines = mount.querySelectorAll('[data-call-line]');
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent).toMatch(/^Video call · 8 min · /);
    expect(lines[0].textContent).not.toMatch(/sats/);
  });
});

describe('iOS Live call audio and background video', () => {
  const flushAudio = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

  it.each(['hangup', 'closed', 'endLocal'] as const)('owns audio only while Live, releases on %s', async (ending) => {
    const audioSession = vi.fn(async (_live: boolean) => {});
    const { e } = engine({ audioSession });
    expect(audioSession).not.toHaveBeenCalled();
    await e.place(A, 'audio', QUOTE);
    expect(audioSession).not.toHaveBeenCalled();
    const pc = FakePc.made[FakePc.made.length - 1];
    pc.connect();
    await flushAudio();
    expect(audioSession.mock.calls).toEqual([[true]]);
    pc.connect();
    if (ending === 'closed') pc.state('closed');
    else await e[ending]();
    await flushAudio();
    expect(audioSession.mock.calls).toEqual([[true], [false]]);
  });

  it('serializes a pending activation before end and never revives the call', async () => {
    let finish!: () => void;
    const audioSession = vi.fn((live: boolean) => live ? new Promise<void>(resolve => { finish = resolve; }) : Promise.resolve());
    const { e } = engine({ audioSession });
    await e.place(A, 'audio', QUOTE);
    FakePc.made[FakePc.made.length - 1].connect();
    await flushAudio();
    e.endLocal();
    finish();
    await flushAudio();
    expect(audioSession.mock.calls).toEqual([[true], [false]]);
    expect(e.view().phase).toBe('ended');
  });

  it('reports activation failure without sending or paying anything else', async () => {
    const audioSession = vi.fn(async () => { throw new Error('Audio unavailable'); });
    const { e, sent } = engine({ audioSession });
    await e.place(A, 'audio', QUOTE);
    FakePc.made[FakePc.made.length - 1].connect();
    await flushAudio();
    expect(e.view()).toMatchObject({ phase: 'live', error: expect.stringMatching(/background audio/i) });
    expect(sent.map(s => s.kind)).toEqual([400]);
    e.endLocal();
    await flushAudio();
  });

  it.each(['disconnect', 'peer repair'] as const)('holds audio through %s while Live and releases only after end', async (repair) => {
    const audioSession = vi.fn(async (_live: boolean) => {});
    const { e } = engine({ audioSession });
    await e.place(A, 'audio', QUOTE);
    await e.receive(msg(401, { sdp: 'answer' }), OWN);
    const pc = FakePc.made[FakePc.made.length - 1];
    pc.connect();
    await flushAudio();
    if (repair === 'disconnect') pc.state('disconnected');
    else await e.receive(msg(402, { candidate: '', sdp_mid: 'bitsov-restart-v1' }), OWN);
    await flushAudio();
    expect(e.view().phase).toBe('reconnecting');
    expect(audioSession.mock.calls).toEqual([[true]]);
    expect(pc.closed).toBe(false);
    expect(pc.tracks[0].stop).not.toHaveBeenCalled();
    pc.connect();
    await flushAudio();
    expect(e.view().phase).toBe('live');
    expect(audioSession.mock.calls).toEqual([[true]]);
    e.endLocal();
    await flushAudio();
    expect(e.view().phase).toBe('ended');
    expect(audioSession.mock.calls).toEqual([[true], [false]]);
    expect(pc.tracks[0].stop).toHaveBeenCalledOnce();
    pc.connect();
    await flushAudio();
    expect(audioSession.mock.calls).toEqual([[true], [false]]);
  });

  it.each([false, true])('recovery timeout releases audio only if the call was Live (%s)', async (wasLive) => {
    vi.useFakeTimers();
    try {
      const audioSession = vi.fn(async (_live: boolean) => {});
      const { e } = engine({ audioSession });
      await e.place(A, 'audio', QUOTE);
      await e.receive(msg(401, { sdp: 'answer' }), OWN);
      const pc = FakePc.made[FakePc.made.length - 1];
      if (wasLive) pc.connect();
      await flushAudio();
      pc.state('disconnected');
      await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_MS - 1);
      expect(e.view().phase).toBe('reconnecting');
      expect(audioSession.mock.calls).toEqual(wasLive ? [[true]] : []);
      expect(pc.tracks[0].stop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(e.view()).toMatchObject({ phase: 'ended', reason: 'failed' });
      expect(audioSession.mock.calls).toEqual(wasLive ? [[true], [false]] : []);
      expect(pc.closed).toBe(true);
      expect(pc.tracks[0].stop).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('keeps callee audio inactive until Live and releases on peer hangup', async () => {
    const audioSession = vi.fn(async (_live: boolean) => {});
    const { e } = engine({ audioSession });
    await e.receive(msg(400, { media: 'audio', sdp: 'offer' }), OWN);
    await flushAudio();
    expect(e.view().phase).toBe('incoming');
    expect(audioSession).not.toHaveBeenCalled();
    await e.accept(QUOTE);
    await flushAudio();
    expect(e.view().phase).toBe('connecting');
    expect(audioSession).not.toHaveBeenCalled();
    const pc = FakePc.made[FakePc.made.length - 1];
    pc.connect();
    await flushAudio();
    expect(e.view().phase).toBe('live');
    expect(audioSession.mock.calls).toEqual([[true]]);
    await e.receive(msg(403, { reason: 'hangup' }), OWN);
    await flushAudio();
    expect(e.view()).toMatchObject({ phase: 'ended', reason: 'hangup' });
    expect(audioSession.mock.calls).toEqual([[true], [false]]);
    expect(pc.tracks[0].stop).toHaveBeenCalledOnce();
    e.dismiss();
    await flushAudio();
    expect(e.view().phase).toBe('idle');
    expect(audioSession.mock.calls).toEqual([[true], [false]]);
  });

  it('stops background video, preserves audio and does not send or restart camera on return', async () => {
    const local = stream(true);
    const mic = local.getAudioTracks()[0];
    const camera = local.getVideoTracks()[0];
    const { e, sent } = engine({ getUserMedia: async () => local });
    await e.place(A, 'video', QUOTE);
    const pc = FakePc.made[FakePc.made.length - 1];
    pc.connect();
    e.setBackgrounded(true);
    await flushAudio();
    expect(camera.stop).toHaveBeenCalledOnce();
    expect(mic.stop).not.toHaveBeenCalled();
    expect(mic.enabled).toBe(true);
    expect(pc.senders.find(s => s.replaced.length)?.track).toBeNull();
    expect(e.view()).toMatchObject({ phase: 'live', camera: false });
    e.setBackgrounded(false);
    expect(e.view().camera).toBe(false);
    expect(sent.map(s => s.kind)).toEqual([400]);
    e.endLocal();
  });

  it('discards a camera acquisition that completes after backgrounding', async () => {
    const local = stream(true);
    const fresh = stream(true, false);
    let finish!: (s: MediaStream) => void;
    const getUserMedia = vi.fn().mockResolvedValueOnce(local).mockImplementationOnce(() => new Promise<MediaStream>(resolve => { finish = resolve; }));
    const { e } = engine({ getUserMedia });
    await e.place(A, 'video', QUOTE);
    FakePc.made[FakePc.made.length - 1].connect();
    await e.toggleCamera();
    const enabling = e.toggleCamera();
    await flushAudio();
    e.setBackgrounded(true);
    finish(fresh);
    await enabling;
    expect(fresh.getVideoTracks()[0].stop).toHaveBeenCalledOnce();
    expect(e.view().camera).toBe(false);
    e.endLocal();
  });
});

describe('iOS camera requests invalidated by a background interval', () => {
  it('does not accept a pre-background camera request after returning', async () => {
    const local = stream(true);
    const fresh = stream(true, false);
    let finish!: (s: MediaStream) => void;
    const getUserMedia = vi.fn().mockResolvedValueOnce(local).mockImplementationOnce(() => new Promise<MediaStream>(resolve => { finish = resolve; }));
    const { e } = engine({ getUserMedia });
    await e.place(A, 'video', QUOTE);
    FakePc.made[FakePc.made.length - 1].connect();
    await e.toggleCamera();
    const enabling = e.toggleCamera();
    await Promise.resolve();
    e.setBackgrounded(true);
    e.setBackgrounded(false);
    finish(fresh);
    await enabling;
    expect(fresh.getVideoTracks()[0].stop).toHaveBeenCalledOnce();
    expect(e.view().camera).toBe(false);
    e.endLocal();
  });

  it('does not mark a stopped track as camera-on after a pending replacement and hide/show', async () => {
    const local = stream(true);
    const fresh = stream(true, false);
    const { e } = engine({ getUserMedia: vi.fn().mockResolvedValueOnce(local).mockResolvedValueOnce(fresh) });
    await e.place(A, 'video', QUOTE);
    const pc = FakePc.made[FakePc.made.length - 1];
    pc.connect();
    await e.toggleCamera();
    let finish!: () => void;
    const sender = pc.senders.find(s => s.replaced.length)!;
    sender.replaceTrack = async (track) => {
      if (track) await new Promise<void>(resolve => { finish = resolve; });
      sender.track = track;
    };
    const enabling = e.toggleCamera();
    for (let i = 0; i < 6; i++) await Promise.resolve();
    e.setBackgrounded(true);
    e.setBackgrounded(false);
    finish();
    await enabling;
    expect(e.view().camera).toBe(false);
    expect(sender.track).toBeNull();
    e.endLocal();
  });
});

it('keeps initial video capture off if it resolves after background and return', async () => {
  const local = stream(true);
  const camera = local.getVideoTracks()[0];
  let finish!: (s: MediaStream) => void;
  const { e } = engine({ getUserMedia: () => new Promise<MediaStream>(resolve => { finish = resolve; }) });
  const placing = e.place(A, 'video', QUOTE);
  await Promise.resolve();
  e.setBackgrounded(true);
  e.setBackgrounded(false);
  finish(local);
  await placing;
  expect(camera.stop).toHaveBeenCalledOnce();
  expect(e.view().camera).toBe(false);
  // The sender survives so an explicit later camera action can replace it.
  expect(FakePc.made[FakePc.made.length - 1].senders).toHaveLength(2);
  e.endLocal();
});
