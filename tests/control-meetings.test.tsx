import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import type { PairingView } from '../src/onboarding/pairing';
import type { BudgetView, CallQuote, CallReceipt, LiveEvent, Message, SpendView } from '../src/control/types';
import { createCallEngine, RING_MS } from '../src/control/call';
import { createMeetingEngine, inviteCost, joinCost, validRoster, type MeetingDeps, type MeetingView } from '../src/control/meeting';

const OWN = '1'.repeat(64);
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const MID = 'f'.repeat(32);
const QUOTE: CallQuote = { offer_msat: 10_000, offer_max_routing_fee_msat: 5_000, signal_msat: 1_000, signal_max_routing_fee_msat: 5_000, call_total_msat: 21_000 };

class FakePc {
  static made: FakePc[] = [];
  iceGatheringState = 'complete';
  connectionState = 'new';
  localDescription: { type: string; sdp: string } | null = null;
  remote: { type: string; sdp: string } | null = null;
  tracks: MediaStreamTrack[] = [];
  closed = false;
  ontrack: ((e: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  constructor(public config: RTCConfiguration) { FakePc.made.push(this); }
  addTrack(t: MediaStreamTrack) { this.tracks.push(t); return { replaceTrack: async () => {} }; }
  async createOffer() { return { type: 'offer', sdp: 'v=0 offer' }; }
  async createAnswer() { return { type: 'answer', sdp: 'v=0 answer' }; }
  async setLocalDescription(d: { type: string; sdp: string }) { this.localDescription = d; }
  async setRemoteDescription(d: { type: string; sdp: string }) { this.remote = d; }
  async addIceCandidate() {}
  addEventListener() {}
  removeEventListener() {}
  close() { this.closed = true; }
  connect() { this.connectionState = 'connected'; this.onconnectionstatechange?.(); }
  state(s: string) { this.connectionState = s; this.onconnectionstatechange?.(); }
}

function track(kind: 'audio' | 'video') {
  return { kind, enabled: true, stop: vi.fn() } as unknown as MediaStreamTrack;
}
function stream(video = false) {
  const tracks = [track('audio'), ...(video ? [track('video')] : [])];
  return {
    addTrack: (t: MediaStreamTrack) => { tracks.push(t); },
    removeTrack: (t: MediaStreamTrack) => { tracks.splice(tracks.indexOf(t), 1); },
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
  } as unknown as MediaStream;
}

type Sent = { peer: string; kind: number; body: Record<string, unknown>; max: number };

function engine(over: Partial<MeetingDeps> = {}) {
  const sent: Sent[] = [];
  const views: MeetingView[] = [];
  const captures: MediaStream[] = [];
  let n = 0;
  let ids = 0;
  const e = createMeetingEngine({
    quote: async () => ({ ok: true, value: QUOTE }),
    signal: async (peer, kind, plaintext, max) => {
      sent.push({ peer, kind, body: JSON.parse(plaintext), max });
      return { ok: true, value: { message_id: `m${++n}`, kind, amount_msat: kind === 400 ? 10_000 : 1_000, total_msat: kind === 400 ? 15_000 : 6_000, max_routing_fee_msat: 5_000, delivered: true, accepted: true, sent_at_ms: 0 } satisfies CallReceipt };
    },
    getUserMedia: async (c) => { const s = stream(!!c.video); captures.push(s); return s; },
    peerConnection: (config) => new FakePc(config) as unknown as RTCPeerConnection,
    ownId: () => OWN,
    onView: (v) => views.push(v),
    onStreams: () => {},
    newCallId: () => (++ids).toString(16).padStart(32, '0'),
    newMeetingId: () => MID,
    ...over,
  });
  return { e, sent, views, captures, last: () => views[views.length - 1] };
}

const offer = (from: string, callId: string, roster: string[], id = MID): Message => ({
  id: `in-${Math.random()}`, kind: 400, sender: from, recipient: OWN, timestamp: 0, payment_amount_msat: 10_000,
  plaintext: JSON.stringify({ v: 1, call_id: callId, media: 'audio', sdp: 'v=0 offer', meeting: { id, roster } }),
});
const sig = (kind: number, from: string, callId: string, body: Record<string, unknown> = {}): Message => ({
  id: `in-${Math.random()}`, kind, sender: from, recipient: OWN, timestamp: 0, payment_amount_msat: 1_000,
  plaintext: JSON.stringify({ v: 1, call_id: callId, ...body }),
});
const cid = (n: number) => n.toString(16).padStart(32, '0');
const legOf = (v: MeetingView, peer: string) => v.legs.find((l) => l.peer === peer)!;

describe('meeting rules', () => {
  it('rosters are 2-4 distinct node ids; prices are shown before acting', () => {
    expect(validRoster([OWN, A])).toBe(true);
    expect(validRoster([OWN, A, B, C])).toBe(true);
    expect(validRoster([OWN, A, B, C, '2'.repeat(64)])).toBe(false);
    expect(validRoster([OWN])).toBe(false);
    expect(validRoster([OWN, A, A])).toBe(false);
    expect(validRoster([OWN, A.toUpperCase()])).toBe(false);
    expect(inviteCost([QUOTE, QUOTE])).toBe(42_000);
    expect(inviteCost([QUOTE, { ...QUOTE, offer_msat: null, call_total_msat: null }])).toBeNull();
    // Second of four: answer + hangup to the host, a call to each later one.
    expect(joinCost([A, OWN, B, C], OWN, { [A]: QUOTE, [B]: QUOTE, [C]: QUOTE })).toBe(12_000 + 42_000);
    expect(joinCost([A, B, OWN], OWN, { [A]: QUOTE, [B]: null })).toBeNull();
  });
});

describe('meeting engine', () => {
  beforeEach(() => { FakePc.made = []; });
  afterEach(() => { vi.useRealTimers(); });

  it('the host rings each invitee once, one paid offer at a time, with the roster; leaving pays one hangup per known leg', async () => {
    const { e, sent, captures, last } = engine();
    await Promise.all([e.invite([A, B], 'audio'), e.invite([A, B], 'audio')]);
    expect(captures).toHaveLength(1);
    expect(FakePc.made).toHaveLength(2);
    expect(FakePc.made.map((p) => p.config.iceServers)).toEqual([[], []]);
    expect(sent.map((s) => [s.peer, s.kind, s.max])).toEqual([[A, 400, 15_000], [B, 400, 15_000]]);
    expect(sent[0].body).toMatchObject({ call_id: cid(1), media: 'audio', meeting: { id: MID, roster: [OWN, A, B] } });
    expect(sent[1].body).toMatchObject({ call_id: cid(2), meeting: { id: MID, roster: [OWN, A, B] } });
    expect(last()).toMatchObject({ phase: 'active', paidMsat: 30_000 });
    expect(last().legs.map((l) => l.state)).toEqual(['ringing', 'ringing']);
    // A answers and connects; B has not answered yet.
    await e.receive(sig(401, A, cid(1), { sdp: 'v=0 answer' }), OWN);
    FakePc.made[0].connect();
    expect(legOf(last(), A).state).toBe('live');
    await Promise.all([e.leave(), e.leave()]);
    // A (live) and B (rung, paid offer) each get one hangup.
    expect(sent.slice(2).map((s) => [s.peer, s.kind, s.body.reason, s.max])).toEqual([[A, 403, 'hangup', 6_000], [B, 403, 'hangup', 6_000]]);
    expect(last()).toMatchObject({ phase: 'ended', paidMsat: 42_000 });
    expect(FakePc.made.every((p) => p.closed)).toBe(true);
    expect(captures[0].getTracks()[0].stop).toHaveBeenCalled();
  });

  it('one failing leg does not stop the others: no call price, or a refused payment, is "no link" and pays nothing', async () => {
    const { e, sent, last } = engine({
      quote: async (peer) => ({ ok: true, value: peer === B ? { ...QUOTE, offer_msat: null, call_total_msat: null } : QUOTE }),
      signal: async (peer, kind, plaintext, max) => {
        sent.push({ peer, kind, body: JSON.parse(plaintext), max });
        return peer === C
          ? { ok: false, error: { code: 'node', message: 'Calls go to contacts you have already paid. Nothing was paid.' } }
          : { ok: true, value: { message_id: 'm', kind, amount_msat: 10_000, total_msat: 15_000, max_routing_fee_msat: 5_000, delivered: true, accepted: true, sent_at_ms: 0 } };
      },
    });
    await e.invite([A, B, C], 'audio');
    expect(sent.map((s) => s.peer)).toEqual([A, C]);
    expect(last().legs.map((l) => l.state)).toEqual(['ringing', 'nolink', 'nolink']);
    expect(legOf(last(), B).error).toMatch(/does not take calls/);
    expect(legOf(last(), C).error).toMatch(/contacts you have already paid/);
    expect(last()).toMatchObject({ phase: 'active', paidMsat: 15_000 });
  });

  it('nobody reachable ends the meeting with nothing paid', async () => {
    const { e, sent, last } = engine({ quote: async () => ({ ok: true, value: { ...QUOTE, offer_msat: null, call_total_msat: null } }) });
    await e.invite([A], 'audio');
    expect(sent).toHaveLength(0);
    expect(last()).toMatchObject({ phase: 'ended', paidMsat: 0 });
    const alone = engine();
    await alone.e.invite([OWN], 'audio');
    expect(alone.last()).toMatchObject({ phase: 'ended', error: expect.stringMatching(/1 to 3 contacts/) });
    expect(alone.sent).toHaveLength(0);
  });

  it('an invite rings without paying; joining answers the host and rings the later participant', async () => {
    const { e, sent, last } = engine();
    const roster = [A, OWN, B];
    await e.receive(offer(A, cid(0xa1), roster), OWN);
    expect(last()).toMatchObject({ phase: 'invited', id: MID, roster });
    expect(legOf(last(), A)).toMatchObject({ state: 'incoming', outgoing: false });
    expect(legOf(last(), B)).toMatchObject({ state: 'waiting', outgoing: true });
    expect(sent).toHaveLength(0);
    await e.join();
    expect(sent.map((s) => [s.peer, s.kind, s.max])).toEqual([[A, 401, 6_000], [B, 400, 15_000]]);
    expect(sent[0].body).toEqual({ v: 1, call_id: cid(0xa1), sdp: 'v=0 answer' });
    expect(sent[1].body).toMatchObject({ meeting: { id: MID, roster } });
    expect(last().phase).toBe('active');
  });

  it('after joining, a leg from an earlier participant who joins later is answered without a click', async () => {
    const { e, sent, last } = engine();
    const roster = [A, B, OWN];
    await e.receive(offer(A, cid(0xa1), roster), OWN);
    await e.join();
    expect(sent.map((s) => [s.peer, s.kind])).toEqual([[A, 401]]);
    expect(legOf(last(), B).state).toBe('waiting');
    await e.receive(offer(B, cid(0xb1), roster), OWN);
    await vi.waitFor(() => expect(sent.map((s) => [s.peer, s.kind])).toEqual([[A, 401], [B, 401]]));
    expect(sent[1].body).toMatchObject({ call_id: cid(0xb1) });
  });

  it('ignores legs out of roster order, bad rosters, another meeting, a second leg per peer, and meetings while on a call', async () => {
    const { e, sent, views } = engine();
    await e.receive(offer(B, cid(1), [OWN, B]), OWN); // we are first: they may not ring us
    await e.receive(offer(A, cid(2), [A, OWN, B, C, '2'.repeat(64)]), OWN);
    await e.receive(offer(A, cid(3), [A, A, OWN]), OWN);
    await e.receive(offer(A, cid(4), [B, OWN]), OWN); // sender not in the roster
    await e.receive(sig(400, A, cid(5), { media: 'audio', sdp: 'v=0' }), OWN); // a plain 1:1 offer
    expect(views).toHaveLength(0);
    await e.receive(offer(A, cid(6), [A, OWN, B]), OWN);
    await e.receive(offer(A, cid(7), [A, OWN, B], 'e'.repeat(32)), OWN);
    await e.receive(offer(A, cid(8), [A, OWN, B]), OWN);
    expect(e.view().legs.find((l) => l.peer === A)).toMatchObject({ state: 'incoming' });
    expect(e.view().id).toBe(MID);
    expect(sent).toHaveLength(0);
    const onCall = engine({ busy: () => true });
    await onCall.e.receive(offer(A, cid(9), [A, OWN]), OWN);
    expect(onCall.views).toHaveLength(0);
  });

  it('the 1:1 engine never rings for a meeting leg, and stays quiet while a meeting holds the mic', async () => {
    const views: unknown[] = [];
    let busyNow = false;
    const calls = createCallEngine({
      quote: async () => ({ ok: true, value: QUOTE }),
      signal: async () => { throw new Error('no payment expected'); },
      getUserMedia: async () => stream(),
      peerConnection: (c) => new FakePc(c) as unknown as RTCPeerConnection,
      now: () => 0,
      onView: (v) => views.push(v),
      onStreams: () => {},
      busy: () => busyNow,
    });
    await calls.receive(offer(A, cid(1), [A, OWN]), OWN);
    expect(views).toHaveLength(0);
    busyNow = true;
    await calls.receive(sig(400, A, cid(2), { media: 'audio', sdp: 'v=0' }), OWN);
    await calls.place(A, 'audio', QUOTE);
    expect(views).toHaveLength(0);
  });

  it('declining pays one hangup per ringing leg; not joining in time pays nothing', async () => {
    const { e, sent, last } = engine();
    const roster = [A, B, OWN];
    await e.receive(offer(A, cid(0xa1), roster), OWN);
    await e.receive(offer(B, cid(0xb1), roster), OWN);
    await e.decline();
    expect(sent.map((s) => [s.peer, s.kind, s.body.reason])).toEqual([[A, 403, 'declined'], [B, 403, 'declined']]);
    expect(last()).toMatchObject({ phase: 'ended', error: 'Declined' });

    vi.useFakeTimers();
    const late = engine();
    await late.e.receive(offer(A, cid(0xa2), [A, OWN]), OWN);
    vi.advanceTimersByTime(RING_MS + 1);
    expect(late.last().phase).toBe('ended');
    expect(late.sent).toHaveLength(0);
  });

  it('their hangup ends only that leg; the last leg ending ends the meeting; closing the window pays nothing', async () => {
    const { e, sent, last } = engine();
    await e.invite([A, B], 'audio');
    await e.receive(sig(401, A, cid(1), { sdp: 'v=0 answer' }), OWN);
    await e.receive(sig(401, B, cid(2), { sdp: 'v=0 answer' }), OWN);
    FakePc.made.forEach((p) => p.connect());
    await e.receive(sig(403, A, cid(1), { reason: 'hangup' }), OWN);
    expect(last().phase).toBe('active');
    expect(last().legs.map((l) => l.state)).toEqual(['ended', 'live']);
    // A hangup for a call id that is not this leg's changes nothing.
    await e.receive(sig(403, B, cid(9), { reason: 'hangup' }), OWN);
    expect(legOf(last(), B).state).toBe('live');
    FakePc.made[1].state('failed');
    expect(last().phase).toBe('ended');
    expect(sent.filter((s) => s.kind === 403)).toHaveLength(0);

    const closing = engine();
    await closing.e.invite([A], 'audio');
    closing.e.endLocal();
    expect(closing.last().phase).toBe('ended');
    expect(closing.sent.map((s) => s.kind)).toEqual([400]);
  });

  it('leaving while a leg is still being placed cancels it: nothing more is sent', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { e, sent, last } = engine({ quote: async (peer) => { if (peer === B) await gate; return { ok: true, value: QUOTE }; } });
    const inviting = e.invite([A, B], 'audio');
    await vi.waitFor(() => expect(sent.map((s) => s.peer)).toEqual([A]));
    expect(legOf(last(), B).state).toBe('placing');
    // Media stops at once; the hangups queue behind the in-flight step.
    const leaving = e.leave();
    expect(last().phase).toBe('ended');
    release();
    await Promise.all([leaving, inviting]);
    // A's paid offer gets its hangup; B was never rung and costs nothing.
    expect(sent.map((s) => [s.peer, s.kind])).toEqual([[A, 400], [A, 403]]);
    expect(last().phase).toBe('ended');
  });
});

// ---- the shell: planner price, invite, incoming invite with a join price ----

const paired: PairingView = { state: 'paired', scopes: ['read', 'receive'], short_code: 'ABCD-EFGH', code_from_node: true, reason: null, bootstrap: null };
const openBudget = (): BudgetView => ({
  paused: false, waiting_for_owner: false, ceiling_msat: 500_000, max_daily_msat: 100_000_000, spent_msat: 0, unsettled_msat: 0,
  preset: 'careful', presets: [{ id: 'careful', contact_msat: 50_000, room_msat: 100_000, ceiling_msat: 500_000 }],
  rows: [{ target: A, room: false, limit_msat: 50_000, spent_msat: 0 }],
  autopay: { state: 'open', open_until_ms: Date.now() + 86_400_000, ceiling_msat: 500_000, basis: 'node_grant' },
  window_ms: 600_000, node_grant: null,
});

type Reply = (args?: Record<string, unknown>) => unknown;
function stubHost(overrides: Record<string, Reply> = {}) {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const callbacks = new Map<number, (e: unknown) => void>();
  const spend: SpendView = { state: 'locked', basis: null, open_until_ms: null, pending: null, window_ms: 600_000 };
  const REPLIES: Record<string, Reply> = {
    node_status: () => ({ ready: true, node_id: OWN, error: null }),
    pairing_status: () => paired,
    node_overview: () => ({ node_id: OWN, status: 'ok', version: 'api v2', connected_peers: 2, e2ee_sessions: 2, pending_deliveries: 0,
      lightning_available: true, block_height: 1, uptime_secs: 1, lightning_backend: 'ldk', chain_backend: 'esplora', read_at: Date.now() }),
    peers_list: () => [
      { node_id: A, addr: null, label: 'Maya', connected: true, fingerprint: null },
      { node_id: B, addr: null, label: 'Jon', connected: true, fingerprint: null },
    ],
    rooms_list: () => [],
    messages_list: () => [],
    price_quote: () => ({ kind: 0, own_msat: 1000, peer_msat: 2000, peer_age_secs: 30, peer_stale: false }),
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

describe('meetings in the shell', () => {
  let dispose: (() => void) | undefined;
  let mount: HTMLElement;
  beforeEach(() => {
    FakePc.made = [];
    vi.stubGlobal('RTCPeerConnection', FakePc);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async (c: MediaStreamConstraints) => stream(!!c.video) } });
  });
  afterEach(() => {
    dispose?.();
    dispose = undefined;
    mount?.remove();
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

  it('plans a meeting with the price for everyone picked, then rings each invitee once with the roster', async () => {
    const host = stubHost();
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="meeting"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call="meeting"]')!.click();
    await vi.waitFor(() => expect(text('[data-meeting-invite]')).toBe('Invite · 21 sats'));
    expect(host.used('call_signal')).toHaveLength(0);
    $<HTMLInputElement>(`[data-meeting-pick="${B}"]`)!.click();
    await vi.waitFor(() => expect(text('[data-meeting-invite]')).toBe('Invite · 42 sats'));
    expect($('[data-meeting-invite]')!.getAttribute('aria-label')).toMatch(/up to 42 sats/);
    expect(text('[data-meeting-note]')).toMatch(/not each other’s contacts will not hear each other/);
    $<HTMLButtonElement>('[data-meeting-invite]')!.click();
    await vi.waitFor(() => expect(host.used('call_signal')).toHaveLength(2));
    const legs = host.used('call_signal').map((c) => [c.args!.peer, c.args!.kind, c.args!.max_msat, JSON.parse(c.args!.plaintext as string).meeting.roster]);
    expect(legs).toEqual([[A, 400, 15_000, [OWN, A, B]], [B, 400, 15_000, [OWN, A, B]]]);
    await vi.waitFor(() => expect($('[data-meeting-panel="active"]')).not.toBeNull());
    expect($(`[data-meeting-leg="${A}"]`)!.getAttribute('data-leg-state')).toBe('ringing');
    // While in a meeting, 1:1 calls are off.
    expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(true);
    $<HTMLButtonElement>('[data-meeting-leave]')!.click();
    await vi.waitFor(() => expect($('[data-meeting-panel="ended"]')).not.toBeNull());
    await vi.waitFor(() => expect(host.used('call_signal').map((c) => c.args!.kind)).toEqual([400, 400, 403, 403]));
  });

  it('an invite shows who is in it and the join price; joining answers the host and rings the later one', async () => {
    const host = stubHost();
    await openShell();
    host.emitLive({ type: 'message', room_id: null, message: offer(A, cid(0xa1), [A, OWN, B]) });
    await vi.waitFor(() => expect($('[data-meeting-panel="invited"]')).not.toBeNull());
    // No 1:1 ring card for a meeting leg.
    expect($('[data-call-panel]')).toBeNull();
    expect(text('[data-meeting-panel="invited"] .who')).toBe('Maya invites you, with Jon');
    // Answer + hangup to Maya (2 x 6), a call to Jon (21).
    await vi.waitFor(() => expect(text('[data-meeting-join]')).toBe('Join · 33 sats'));
    expect(host.used('call_signal')).toHaveLength(0);
    $<HTMLButtonElement>('[data-meeting-join]')!.click();
    await vi.waitFor(() => expect(host.used('call_signal')).toHaveLength(2));
    expect(host.used('call_signal').map((c) => [c.args!.peer, c.args!.kind])).toEqual([[A, 401], [B, 400]]);
    expect(host.used('call_signal')[0].args!.max_msat).toBe(6_000);
  });
});
