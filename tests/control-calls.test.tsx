import { sampleSource } from '../src/control/sample';
import { setStunPref, setDenom } from '../src/control/prefs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import type { PairingView } from '../src/onboarding/pairing';
import { resetContactsForTests, setPetname } from '../src/control/petnames';
import type { BudgetView, CallQuote, CallReceipt, LiveEvent, Message, SpendView } from '../src/control/types';
import { CONNECT_TIMEOUT_MS, createCallEngine, mediaError, NO_MEDIA_DEVICES, RECONNECT_GRACE_MS, isCallKind, newCallId, parseSignal, RING_MS, stunServer, type CallDeps, type CallView } from '../src/control/call';

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
    const accepting = e.accept();
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
    const declining = e.decline();
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
    void stuck.e.decline();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stuck.views.some((v) => v.phase === 'ended')).toBe(false);

    const { e, views, sent } = engine({ signal: () => new Promise(() => {}) });
    await e.receive(msg(400, { media: 'audio', sdp: 'offer' }), OWN);
    void e.decline();
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
    const declining = e.decline();
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
    await callee.e.accept();
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

  it('a callee-only failure requests one restart and caller ignores duplicate requests', async () => {
    const incoming = engine();
    await incoming.e.receive(msg(400, { media: 'audio', sdp: 'offer' }), OWN);
    await incoming.e.accept();
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
    const accepting = e.accept();
    await vi.advanceTimersByTimeAsync(0);
    FakePc.made[0].connect();
    await e.receive(msg(400, { call_id: 'e'.repeat(32), media: 'audio', sdp: `restart\r\na=x-bitsov-restart-of:${ID}\r\n` }), OWN);
    expect(answers).toBe(2);
    finish({ ok: true, value: { total_msat: 6000 } as CallReceipt });
    await accepting;
    expect(e.view().state).toBe('reconnecting');
    e.endLocal();
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

  it.each(['authorization', 'remaining grant', 'per-call grant'] as const)('keeps a connected caller live when recovery is refused by %s', async (refusal) => {
    let recovering = false;
    const { e, sent, views } = engine({
      authorize: async () => !recovering || refusal !== 'authorization',
      grant: () => recovering ? {
        expires_at_ms: 3_600_000, budget_msat: 21_000,
        remaining_msat: refusal === 'remaining grant' ? 0 : 21_000,
        per_call_max_msat: refusal === 'per-call grant' ? 0 : 21_000,
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
    await e.accept();
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

  it('honors a peer hangup on the recovery id before the offer receipt arrives', async () => {
    let finish!: (r: Awaited<ReturnType<CallDeps['signal']>>) => void;
    const { e } = engine({ signal: async (_peer, kind, plaintext) => {
      if (kind === 400 && JSON.parse(plaintext).call_id !== ID) return new Promise(resolve => { finish = resolve; });
      return { ok: true, value: { total_msat: 1 } as CallReceipt };
    } });
    await e.place(A, 'audio', QUOTE);
    await e.receive(msg(401, { sdp: 'answer' }), OWN);
    const pc = FakePc.made[0]; pc.connect(); pc.state('failed');
    await vi.advanceTimersByTimeAsync(0);
    await e.receive(msg(403, { call_id: 'e'.repeat(32), reason: 'hangup' }), OWN);
    expect(e.view()).toMatchObject({ phase: 'ended', reason: 'hangup' });
    expect(pc.closed).toBe(true);
    expect(pc.tracks[0].stop).toHaveBeenCalledOnce();
    finish({ ok: true, value: { total_msat: 15000 } as CallReceipt });
    await vi.advanceTimersByTimeAsync(0);
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
      await (direction === 'incoming' ? e.accept() : e.place(A, 'video', QUOTE));
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
    const accepting = e.accept();
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
    const declining = e.decline();
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
    const accepting = e.accept();
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
    const accepting = e.accept();
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

  it('Codex #238 (1): offline/online while their answer is still being applied: one 400, as on main', async () => {
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

  it('Codex #238 (2): live → ICE disconnected → offline → online → ICE back in 100 ms: one 400, as on main', async () => {
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
    const pending = direction === 'outgoing' ? e.place(A, 'video', QUOTE) : e.accept();
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
    expect(last().error).toMatch(/does not take calls/);
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
    await Promise.all([e.accept(), e.accept()]);
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
    await e.decline();
    expect(sent.map((s) => [s.kind, s.body.reason])).toEqual([[403, 'declined']]);
    expect(last()).toMatchObject({ phase: 'ended', reason: 'declined' });
  });

  it('ignores its own echo, other calls, junk, and a second caller while busy', async () => {
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
    await b.e.accept();
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
    dispose?.();
    dispose = undefined;
    mount?.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const $ = <T extends Element = HTMLElement>(sel: string) => mount.querySelector<T>(sel);
  const text = (sel: string) => $(sel)?.textContent ?? '';
  async function openShell() {
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => <App />, mount);
    await vi.waitFor(() => expect([...mount.querySelectorAll('button')].some((b) => b.textContent?.includes('I understand'))).toBe(true));
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
    await vi.waitFor(() => expect($(`[data-track="peer:${A}"]`)?.getAttribute('aria-current')).toBe('true'));
  }

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
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-approval]')).not.toBeNull());
    expect($('[data-call-panel="calling"]')).toBeNull();
    expect(capture).not.toHaveBeenCalled();
    expect(host.used('call_signal')).toHaveLength(0);
    $<HTMLButtonElement>('[data-call-approve]')!.click();
    await vi.waitFor(() => expect(host.used('spend_request')).toHaveLength(1));
    expect(host.used('call_signal')).toHaveLength(0);
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
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
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
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
      $<HTMLButtonElement>('[data-call="video"]')!.click();
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
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-approval]')).not.toBeNull());
    expect(text('[data-call-approval]')).toContain(typeof error === 'string' ? error : error.message);
    expect(capture).not.toHaveBeenCalled();
    expect(host.used('call_signal')).toEqual([]);
  });

  it('labels a six-sat maximum as a cap and retains the selected ICE route', async () => {
    stubHost({ call_signal: (args) => ({ message_id: 'sig', kind: args!.kind, amount_msat: 1000, total_msat: 6000, max_routing_fee_msat: 5000, delivered: true, accepted: true, sent_at_ms: Date.now() }) });
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
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

  it.each([
    ['per-call cap', 500_000, 50_000_000],
    ['remaining budget', 50_000_000, 500_000],
  ])('refuses the full call ceiling against the grant %s before media or signalling', async (_reason, cap, remaining) => {
    const capture = vi.spyOn(navigator.mediaDevices, 'getUserMedia');
    const host = stubHost({
      call_quote: () => ({ ...QUOTE, call_total_msat: 21_205_000 }),
      budget_status: () => ({ ...openBudget(), node_grant: {
        expires_at_ms: Date.now() + 3600_000, budget_msat: 50_000_000,
        remaining_msat: remaining, per_call_max_msat: cap,
      } }),
    });
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect(text('[data-call-ended]')).toMatch(/owner.*approve/i));
    expect(text('[data-call-ended]')).toContain('21,205 sats');
    expect(text('[data-call-ended]')).toContain('500 sats');
    expect(capture).not.toHaveBeenCalled();
    expect(FakePc.made).toHaveLength(0);
    expect(host.used('call_signal')).toHaveLength(0);
    expect(host.used('budget_approve')).toHaveLength(0);
  });

  it('dials when the full ceiling equals both grant limits', async () => {
    const host = stubHost({ budget_status: () => ({ ...openBudget(), node_grant: {
      expires_at_ms: Date.now() + 3600_000, budget_msat: 21_000,
      remaining_msat: 21_000, per_call_max_msat: 21_000,
    } }) });
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ringing"]')).not.toBeNull());
    expect(host.used('call_signal')).toHaveLength(1);
    expect(host.used('call_signal')[0].args).toMatchObject({ kind: 400, max_msat: 15_000 });
  });

  it('shows a bounded node timeout in the shell and releases media', async () => {
    const host = stubHost({ call_signal: () => new Promise(() => {}) });
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    vi.useFakeTimers();
    try {
      $<HTMLButtonElement>('[data-call="audio"]')!.click();
      await vi.advanceTimersByTimeAsync(30_001);
      expect(text('[data-call-ended]')).toMatch(/node did not answer.*outcome is unknown/i);
      expect($('[data-call-panel="calling"]')).toBeNull();
      expect(FakePc.made[0].closed).toBe(true);
      expect(host.used('call_signal')).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it('shows a host spend refusal and ends the call in the shell', async () => {
    stubHost({ call_signal: () => { throw { code: 'spend_refused', message: 'token lacks required scope: spend' }; } });
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect(text('[data-call-ended]')).toBe('token lacks required scope: spend'));
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
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect(land).toBeDefined());
    $<HTMLButtonElement>('[data-call-hangup]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect($('[data-call-paid]')!.getAttribute('data-call-paid')).toBe('pending');
    expect(text('[data-call-paid]')).toBe('A payment for this call is still settling: up to 15 sats. The total updates when it finishes. Media was not billed.');
    expect($('[data-call-paid="nothing"]')).toBeNull();
    land({ message_id: 'sig', kind: 400, amount_msat: 10_000, total_msat: 15_000, max_routing_fee_msat: 5000, delivered: true, accepted: true, sent_at_ms: Date.now() });
    await vi.waitFor(() => expect($('[data-call-paid]')!.getAttribute('data-call-paid')).toBe('settled'));
    expect(text('[data-call-paid]')).toMatch(/^This call paid up to 15 sats:/);
  });

  it('declining never shows "paid nothing", even for a moment, while its hangup is owed; Close waits for it', async () => {
    let land!: (r: unknown) => void;
    const host = stubHost({ messages_list: () => [], call_signal: () => new Promise((resolve) => { land = resolve; }) });
    await openShell();
    const seen: string[] = [];
    // Every paid line ever inserted, even one replaced in the same tick.
    const watch = new MutationObserver((records) => records.forEach((r) => r.addedNodes.forEach((n) => {
      if (!(n instanceof Element)) return;
      [n, ...n.querySelectorAll('[data-call-paid]')].forEach((el) => { if (el.hasAttribute('data-call-paid')) seen.push(el.getAttribute('data-call-paid')!); });
    })));
    watch.observe(mount, { subtree: true, childList: true, attributes: true, characterData: true });
    host.emitLive({ type: 'message', room_id: null, message: { id: 'live-offer', kind: 400, sender: A, recipient: OWN, timestamp: Date.now(), plaintext: JSON.stringify({ v: 1, call_id: ID, media: 'audio', sdp: 'v=0 offer' }), payment_amount_msat: 10_000 } });
    await vi.waitFor(() => expect($('[data-call-decline]')).not.toBeNull());
    $<HTMLButtonElement>('[data-call-decline]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    await vi.waitFor(() => expect(land).toBeDefined());
    expect(text('[data-call-paid]')).toBe('A payment for this call is still settling: up to 6 sats. The total updates when it finishes. Media was not billed.');
    expect($<HTMLButtonElement>('[data-call-dismiss]')!.disabled).toBe(true);
    land({ message_id: 'sig', kind: 403, amount_msat: 1_000, total_msat: 6_000, max_routing_fee_msat: 5000, delivered: true, accepted: true, sent_at_ms: Date.now() });
    await vi.waitFor(() => expect($('[data-call-paid]')?.getAttribute('data-call-paid')).toBe('settled'));
    expect($<HTMLButtonElement>('[data-call-dismiss]')!.disabled).toBe(false);
    watch.disconnect();
    expect(seen).toContain('pending');
    expect(seen).not.toContain('nothing');
  });

  it('a hangup lost in transport (not proven unpaid) is said as not known, not as paid nothing', async () => {
    stubHost({ call_signal: (args) => {
      if (args!.kind === 403) throw 'connection lost';
      return { message_id: 'sig', kind: args!.kind, amount_msat: 10_000, total_msat: 15_000, max_routing_fee_msat: 5000, delivered: true, accepted: true, sent_at_ms: Date.now() };
    } });
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ringing"]')).not.toBeNull());
    $<HTMLButtonElement>('[data-call-hangup]')!.click();
    await vi.waitFor(() => expect($('[data-call-paid]')?.getAttribute('data-call-paid')).toBe('unknown'));
    expect(text('[data-call-paid]')).toMatch(/^This call paid up to 15 sats\. One signal’s result is not known yet/);
  });

  it('an ended call with an unknown hangup says so, and never folds it into what was paid', async () => {
    stubHost({ call_signal: (args) => {
      if (args!.kind === 403) throw { code: 'spend_unknown', message: 'The payment outcome is unknown.' };
      return { message_id: 'sig', kind: args!.kind, amount_msat: 10_000, total_msat: 15_000, max_routing_fee_msat: 5000, delivered: true, accepted: true, sent_at_ms: Date.now() };
    } });
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
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
    expect(host.used('call_signal')).toHaveLength(0);
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
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
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="calling"]')).not.toBeNull());
    const note = $('[data-call-panel] [data-call-network-note]');
    if (stun) expect(note).toBeNull();
    else expect(note?.textContent).toMatch(/calls may not connect across networks/i);
    expect(mount.querySelectorAll('[data-call-network-note]').length).toBe(stun ? 0 : 1);
    $<HTMLButtonElement>('[data-call-hangup]')!.click();
  });

  it('rings on a live offer with the answer price, and never adds call signals to the thread', async () => {
    const host = stubHost({ messages_list: () => [] });
    await openShell();
    host.emitLive({ type: 'message', room_id: null, message: { id: 'live-offer', kind: 400, sender: A, recipient: OWN, timestamp: Date.now(), plaintext: JSON.stringify({ v: 1, call_id: ID, media: 'audio', sdp: 'v=0 offer' }), payment_amount_msat: 10_000 } });
    await vi.waitFor(() => expect($('[data-call-panel="incoming"]')).not.toBeNull());
    expect(text('[data-call-title]')).toBe('Incoming call');
    await vi.waitFor(() => expect(text('[data-call-accept]')).toBe('Accept · 6 sats'));
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

  it('shows Reconnecting… and keeps video and controls mounted through a network blip', async () => {
    // Media playback is a browser boundary; these streams are track-owning fakes.
    vi.spyOn(HTMLMediaElement.prototype, 'srcObject', 'set').mockImplementation(() => {});
    const host = stubHost({ messages_list: () => [] });
    await openShell();
    host.emitLive({ type: 'message', room_id: null, message: { ...msg(400, { media: 'video', sdp: 'offer' }), timestamp: Date.now() } });
    await vi.waitFor(() => expect($('[data-call-accept]')).not.toBeNull());
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
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect(text('[data-call-ended]')).toMatch(message as RegExp));
    expect(host.used('call_signal')).toHaveLength(0);
    expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false);
  });

  it('a contact whose node does not take calls cannot be rung', async () => {
    const host = stubHost({ call_quote: () => ({ ...QUOTE, offer_msat: null, offer_max_routing_fee_msat: 0, call_total_msat: null }) });
    await openShell();
    await vi.waitFor(() => expect($('[data-call="audio"]')!.getAttribute('title')).toMatch(/does not take calls yet/));
    expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(true);
    expect(host.used('call_signal')).toHaveLength(0);
  });

  it('puts the cost in the accessible names and lets the caller cancel before paying', async () => {
    const host = stubHost();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => new Promise<MediaStream>(() => {}) } });
    await openShell();
    await vi.waitFor(() => expect($('[data-call="audio"]')!.getAttribute('aria-label')).toBe('Call Maya, up to 42 sats'));
    expect($('[data-call="video"]')!.getAttribute('aria-label')).toBe('Video call Maya, up to 42 sats');
    expect($('[data-call="audio"]')!.getAttribute('title')).toMatch(/No STUN server is set/);
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
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
    await vi.waitFor(() => expect($('[data-call-accept]')).not.toBeNull());
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
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
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
    await vi.waitFor(() => expect($('[data-call-accept]')).not.toBeNull());
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
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect(text('[data-call-ended]')).toBe('This build cannot use the microphone yet. Nothing was paid.'));
    expect(host.used('call_signal')).toHaveLength(0);
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
    await vi.waitFor(() => expect(text('[data-stun-note]')).toMatch(/own-node\.example:3478 .*sees your IP address/));
    // The next call uses it.
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect(FakePc.made).toHaveLength(1));
    expect(FakePc.made[0].config.iceServers).toEqual([{ urls: 'stun:own-node.example:3478' }]);
    $<HTMLButtonElement>('[data-stun-clear]')!.click();
    await vi.waitFor(() => expect(text('[data-stun-note]')).toMatch(/STUN is turned off/));
  });

  const overviewWith = (extra: Record<string, unknown>) => () => ({ node_id: OWN, status: 'ok', version: 'api v2', connected_peers: 1, e2ee_sessions: 1, pending_deliveries: 0,
    lightning_available: true, block_height: 1, uptime_secs: 1, lightning_backend: 'ldk', chain_backend: 'esplora', read_at: Date.now(), ...extra });

  it('uses the node\'s own STUN responder by default (never a third party); the owner can turn it off and back on', async () => {
    const own = 'stun:mynode.example.org:3478';
    stubHost({ node_overview: overviewWith({ stun_port: 3478, stun_url: own }) });
    await openShell();
    $<HTMLButtonElement>('[data-profile]')!.click();
    $<HTMLButtonElement>('[data-open-settings]')!.click();
    $<HTMLButtonElement>('[data-tab="general"]')!.click();
    await vi.waitFor(() => expect($('[data-stun-note]')?.getAttribute('data-stun-using')).toBe('own'));
    expect(text('[data-stun-note]')).toMatch(/your own node \(stun:mynode\.example\.org:3478\).*No third party.*This is the default\./);
    expect(localStorage.getItem('bitsov.stun')).toBeNull();
    expect($('[data-stun-own]')).toBeNull();
    // The Call button's tooltip says the same (no "No STUN server is set").
    expect($('[data-call="audio"]')!.getAttribute('title')).toContain(`Uses the STUN server ${own} to find a route.`);
    expect($('[data-call="audio"]')!.getAttribute('title')).not.toContain('No STUN server');
    // A call uses it with no setting saved.
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect(FakePc.made).toHaveLength(1));
    expect(FakePc.made[0].config.iceServers).toEqual([{ urls: own }]);
    $<HTMLButtonElement>('[data-call-hangup]')!.click();
    // Turn off: no STUN at all, and it stays off.
    $<HTMLButtonElement>('[data-stun-clear]')!.click();
    await vi.waitFor(() => expect($('[data-stun-note]')?.getAttribute('data-stun-using')).toBe('off'));
    expect(localStorage.getItem('bitsov.stun')).toBe('off');
    expect($('[data-call="audio"]')!.getAttribute('title')).toContain('STUN is turned off');
    $<HTMLButtonElement>('[data-call-dismiss]')?.click();
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
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
    stubHost({ node_overview: overviewWith({ stun_port: 3478, stun_url: own }) });
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
    fresh.setNodeStun(own);
    expect(fresh.stunOff()).toBe(true);
    expect(fresh.effectiveStun()).toBe('');
    // Control: with nothing stored, a fresh module falls back to the node default (so the read above is real).
    localStorage.removeItem('bitsov.stun');
    vi.resetModules();
    const clean = await import('../src/control/prefs');
    clean.setNodeStun(own);
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
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect(FakePc.made).toHaveLength(1));
    expect(FakePc.made[0].config.iceServers).toEqual([{ urls: 'stun:other.example:3478' }]);
  });

  it('an unusable answer from their app is not a connectivity failure: no relay advice', async () => {
    const host = stubHost();
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
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
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect(FakePc.made).toHaveLength(1));
    FakePc.made[0].state('closed');
    await vi.waitFor(() => expect($('[data-call-no-relay]')).not.toBeNull());
    expect(text('[data-call-no-relay]')).toBe('Some networks need a relay to connect a call, and your node does not offer one yet.');
    expect(text('[data-call-no-relay]')).not.toMatch(/paid/i);
  });

  it('never offers a malformed or relay URL, and explains a responder without a public address', async () => {
    stubHost({ node_overview: overviewWith({ stun_port: 3478, stun_url: 'turn:mynode.example.org:3478' }) });
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
});
