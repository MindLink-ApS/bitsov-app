import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import type { PairingView } from '../src/onboarding/pairing';
import type { BudgetView, CallQuote, CallReceipt, LiveEvent, Message, SpendView } from '../src/control/types';
import { createCallEngine, isCallKind, newCallId, parseSignal, RING_MS, type CallDeps, type CallView } from '../src/control/call';

const OWN = '1'.repeat(64);
const A = 'a'.repeat(64);
const ID = '0123456789abcdef0123456789abcdef';
const QUOTE: CallQuote = { offer_msat: 10_000, offer_max_routing_fee_msat: 5_000, signal_msat: 1_000, signal_max_routing_fee_msat: 5_000, call_total_msat: 21_000 };

/** A stand-in RTCPeerConnection: records what the engine asks of it. */
class FakePc {
  static made: FakePc[] = [];
  iceGatheringState = 'complete';
  connectionState = 'new';
  localDescription: { type: string; sdp: string } | null = null;
  remote: { type: string; sdp: string } | null = null;
  tracks: MediaStreamTrack[] = [];
  candidates: unknown[] = [];
  closed = false;
  ontrack: ((e: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  constructor(public config: RTCConfiguration) { FakePc.made.push(this); }
  addTrack(t: MediaStreamTrack) { this.tracks.push(t); }
  async createOffer() { return { type: 'offer', sdp: 'v=0 offer' }; }
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
function stream(video = false) {
  const tracks = [track('audio'), ...(video ? [track('video')] : [])];
  return {
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
  const e = createCallEngine({
    quote: async () => ({ ok: true, value: QUOTE }),
    signal: async (peer, kind, plaintext, max) => {
      sent.push({ peer, kind, body: JSON.parse(plaintext), max });
      return { ok: true, value: { message_id: `m${++n}`, kind, amount_msat: kind === 400 ? 10_000 : 1_000, total_msat: kind === 400 ? 15_000 : 6_000, max_routing_fee_msat: 5_000, delivered: true, accepted: true, sent_at_ms: 0 } satisfies CallReceipt };
    },
    getUserMedia: async (c) => { media.push(c); return stream(!!c.video); },
    peerConnection: (config) => new FakePc(config) as unknown as RTCPeerConnection,
    now: () => 1_000,
    onView: (v) => views.push(v),
    onStreams: () => {},
    newCallId: () => ID,
    ...over,
  });
  return { e, sent, views, media, last: () => views[views.length - 1] };
}

const msg = (kind: number, body: Record<string, unknown>, sender = A): Message => ({
  id: `in-${kind}-${Math.random()}`, kind, sender, recipient: OWN, timestamp: 0, plaintext: JSON.stringify({ v: 1, call_id: ID, ...body }), payment_amount_msat: 1000,
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

  it('places one paid offer at the quoted all-in, with STUN only, then goes live and hangs up once', async () => {
    const { e, sent, media, last } = engine();
    await Promise.all([e.place(A, 'audio', QUOTE), e.place(A, 'audio', QUOTE)]);
    expect(media).toEqual([{ audio: true, video: false }]);
    expect(FakePc.made).toHaveLength(1);
    expect(FakePc.made[0].config.iceServers).toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);
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
    expect(last()).toMatchObject({ phase: 'ended', reason: 'hangup', paidMsat: 21_000 });
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
    const { e, sent, last } = engine();
    await e.receive(msg(400, { media: 'video', sdp: 'v=0 offer' }), OWN);
    expect(last()).toMatchObject({ phase: 'incoming', peer: A, media: 'video', outgoing: false });
    await Promise.all([e.accept(), e.accept()]);
    expect(sent).toEqual([{ peer: A, kind: 401, body: { v: 1, call_id: ID, sdp: 'v=0 answer' }, max: 6_000 }]);
    expect(FakePc.made[0].remote).toEqual({ type: 'offer', sdp: 'v=0 offer' });
    FakePc.made[0].connect();
    e.toggleCamera();
    expect(FakePc.made[0].tracks[1].enabled).toBe(false);
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

// ---- the shell: price before calling, ring card, thread stays chat-only ----

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

describe('calls in the shell', () => {
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

  it('shows the all-in call price before calling, then pays one offer at that ceiling', async () => {
    const host = stubHost();
    await openShell();
    await vi.waitFor(() => expect(text('[data-call="audio"]')).toBe('Call · 21 sats'));
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
    expect(text('[data-call-paid]')).toMatch(/Paid 15 sats/);
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
    $<HTMLButtonElement>('[data-call-mute]')!.click();
    await vi.waitFor(() => expect(text('[data-call-mute]')).toBe('Unmute'));
    $<HTMLButtonElement>('[data-call-hangup]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect(host.used('call_signal').map((c) => c.args!.kind)).toEqual([401, 403]);
  });

  it('a contact whose node does not take calls cannot be rung', async () => {
    const host = stubHost({ call_quote: () => ({ ...QUOTE, offer_msat: null, offer_max_routing_fee_msat: 0, call_total_msat: null }) });
    await openShell();
    await vi.waitFor(() => expect($('[data-call="audio"]')!.getAttribute('title')).toMatch(/does not take calls yet/));
    expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(true);
    expect(host.used('call_signal')).toHaveLength(0);
  });
});
