/**
 * M6 A1 flag gating: with node-routed audio on (the M6 build profile), the
 * shell never constructs an RTCPeerConnection, hides video and meetings, and
 * labels the call as routed through both nodes. The other call tests pin
 * VITE_CALL_MEDIA=webrtc (vitest.config.ts) to exercise the kept lab path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import { setLanguagePref } from '../src/i18n';
import { resetContactsForTests, setPetname } from '../src/control/petnames';
import { callMediaPath, nodeRoutedAudio } from '../src/control/callFlags';
import { createCallEngine, type CallDeps } from '../src/control/call';
import { nodeRoutedSdp } from '../src/control/nodeRoutedConnection';
import type { CallQuote, SpendView } from '../src/control/types';
import type { PairingView as OnboardingPairingView } from '../src/onboarding/pairing';

const OWN = '1'.repeat(64);
const A = 'a'.repeat(64);
const ID = '0123456789abcdef0123456789abcdef';
// M6 A2: a node-routed call needs the callee's per-minute price to agree to, from a session whose node reserves the minutes.
const QUOTE: CallQuote = { offer_msat: 10_000, offer_max_routing_fee_msat: 5_000, signal_msat: 1_000, signal_max_routing_fee_msat: 5_000, call_total_msat: 21_000,
  block_msat: 10_000, block_max_routing_fee_msat: 5_000, reservation_max_msat: 3_600_000, minutes_payable: true };

class FakePc {
  static made = 0;
  constructor() { FakePc.made++; }
}

type Reply = (args?: Record<string, unknown>) => unknown;

const paired: OnboardingPairingView = { state: 'paired', scopes: ['read', 'receive', 'spend'], node_id: OWN, expires_at_ms: Date.now() + 3_600_000 } as unknown as OnboardingPairingView;

function stubHost() {
  resetContactsForTests();
  setPetname(A, 'Maya');
  const calls: { cmd: string; args?: unknown }[] = [];
  const callbacks = new Map<number, (e: unknown) => void>();
  const mediaIndices = new Map<number, number>();
  const spending: SpendView = { state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 600_000, pending: null, window_ms: 600_000 };
  // M6 A2: the node reports the first minute paid, so it admits the media socket; ending the call closes the reservation.
  let ended = false;
  const status = (args: Record<string, unknown> | undefined) => ({
    id: args!.call_id, state: ended ? 'ended' : 'live', direction: 'outgoing', paid_until_ms: Date.now() + 60_000, next_block_seq: 1,
    next_block_due_ms: Date.now() + 40_000,
    reservation: { reserved_msat: 3_600_000, spent_msat: 15_000, remaining_msat: 3_585_000, per_block_msat: 10_000, per_block_fee_msat: 5_000, max_call_minutes: 240, released_msat: 0, closed: ended },
  });
  const REPLIES: Record<string, Reply> = {
    node_status: () => ({ ready: true, node_id: OWN, error: null }),
    trust_acknowledge: () => true,
    pairing_status: () => paired,
    node_overview: () => ({ node_id: OWN, status: 'ok', version: 'api v2', connected_peers: 1, e2ee_sessions: 1, pending_deliveries: 0,
      lightning_available: true, block_height: 1, uptime_secs: 1, lightning_backend: 'ldk', chain_backend: 'esplora', read_at: Date.now(), capabilities: ['call_meeting_v1'] }),
    peers_list: () => [{ node_id: A, addr: null, label: 'Maya', connected: true, fingerprint: null, meetings: true }],
    rooms_list: () => [],
    messages_list: () => [],
    price_quote: () => ({ kind: 0, own_msat: 1000, peer_msat: 2000, peer_age_secs: 30, max_routing_fee_msat: 0, peer_stale: false }),
    payments_overview: () => ({ balance_msat: 1_000_000, lightning_outbound_msat: 500_000, channels: [] }),
    fund_state: () => null,
    spend_status: () => spending,
    budget_status: () => null,
    call_quote: () => QUOTE,
    call_signal: (args) => {
      if (args?.kind === 400) ended = false;
      return { message_id: 'sig', kind: (args as { kind: number }).kind, amount_msat: 10_000, total_msat: 15_000, max_routing_fee_msat: 5000, delivered: true, accepted: true, sent_at_ms: Date.now() };
    },
    call_status: (args) => status(args),
    call_hold: (args) => status(args),
    call_block: () => ({ message_id: 'blk', kind: 404, amount_msat: 10_000, total_msat: 15_000, max_routing_fee_msat: 5_000, delivered: true, accepted: true, sent_at_ms: Date.now() }),
    op_end_call: (args) => (ended = true, { op_id: 'end', kind: 'call_hangup', peer: A, call_id: (args as { call_id: string }).call_id, state: 'settled', cap_msat: 6_000, paid_msat: 6_000, message_id: 'hangup' }),
    op_list: () => ({ operations: [], skipped: 0, has_more: false }),
    live_link: () => null,
    call_media_open: () => null,
    call_media_send: () => null,
    call_media_close: () => null,
    call_seal_offer: () => `a=x-bitsov-e2e:1 commit=${'ab'.repeat(32)} caps=00000001 sas=01`,
    call_seal_accept: () => true,
    call_seal_cancel: () => null,
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
    used: (cmd: string) => calls.filter((c) => c.cmd === cmd),
    emitLive: (payload: unknown) => {
      const listen = calls.find((c) => c.cmd === 'plugin:event|listen');
      callbacks.get((listen!.args as { handler: number }).handler)!({ event: 'node-live', id: 1, payload });
    },
    /** Deliver a host media channel message in order (the renderer's Channel is the `on_frame` arg): link
     *  transitions arrive as parsed JSON objects, frames as ArrayBuffers, exactly as Tauri delivers them. */
    media: (message: unknown, session = -1) => {
      const opens = calls.filter((c) => c.cmd === 'call_media_open');
      const open = opens[session < 0 ? opens.length + session : session];
      const channel = (open!.args as { on_frame: { id: number } }).on_frame;
      const index = mediaIndices.get(channel.id) ?? 0;
      mediaIndices.set(channel.id, index + 1);
      callbacks.get(channel.id)!({ message, index });
    },
  };
}

const track = () => ({ kind: 'audio', enabled: true, stop: vi.fn() }) as unknown as MediaStreamTrack;

/** The least Web Audio the engine needs: a context whose worklet loads and whose nodes connect. */
class FakeAudioNode {
  port = { postMessage: vi.fn(), onmessage: null as unknown };
  gain = { value: 1 };
  connect<T>(next: T) { return next; }
  disconnect() {}
}
class FakeAudioContext {
  static made: FakeAudioContext[] = [];
  sampleRate = 48_000;
  currentTime = 0;
  destination = new FakeAudioNode();
  audioWorklet = { addModule: async () => {} };
  closed = false;
  constructor() { FakeAudioContext.made.push(this); }
  async resume() {}
  async close() { this.closed = true; }
  createMediaStreamSource() { return new FakeAudioNode(); }
  createGain() { return new FakeAudioNode(); }
}
const stream = () => {
  const tracks = [track()];
  return { getTracks: () => tracks, getAudioTracks: () => tracks, getVideoTracks: () => [], addTrack: () => {}, removeTrack: () => {} } as unknown as MediaStream;
};

describe('call media flag', () => {
  it('node-routed audio is the build default; only the exact lab value turns it off', () => {
    expect(callMediaPath({})).toBe('node');
    expect(callMediaPath({ VITE_CALL_MEDIA: 'node' })).toBe('node');
    expect(callMediaPath({ VITE_CALL_MEDIA: 'webrtc' })).toBe('webrtc');
    expect(callMediaPath({ VITE_CALL_MEDIA: 'WebRTC' })).toBe('node');
    expect(nodeRoutedAudio({})).toBe(true);
    expect(nodeRoutedAudio({ VITE_CALL_MEDIA: 'webrtc' })).toBe(false);
  });

  it('the engine names the node link, not a direct connection, when a routed transport closes', async () => {
    const views: string[] = [];
    let conn: { onconnectionstatechange: (() => void) | null; connectionState: string; localDescription: unknown } | undefined;
    const deps: CallDeps = {
      routed: true,
      quote: async () => ({ ok: true, value: QUOTE }),
      signal: async (_peer, kind) => ({ ok: true, value: { message_id: 'm', kind, amount_msat: 1, total_msat: 1, max_routing_fee_msat: 0, delivered: true, accepted: true, sent_at_ms: 0 } }),
      getUserMedia: async () => stream(),
      peerConnection: () => {
        conn = { connectionState: 'new', onconnectionstatechange: null, localDescription: null };
        return Object.assign(conn, {
          iceGatheringState: 'complete', iceConnectionState: 'new',
          addTrack: () => ({}), createOffer: async () => ({ type: 'offer', sdp: 'x' }), createAnswer: async () => ({ type: 'answer', sdp: 'x' }),
          setLocalDescription: async (d: { sdp: string }) => { conn!.localDescription = d; },
          setRemoteDescription: async () => {}, addIceCandidate: async () => {}, getStats: async () => new Map(), close: () => {}, restartIce: () => {},
          addEventListener: () => {}, removeEventListener: () => {},
        }) as unknown as RTCPeerConnection;
      },
      now: () => 1000,
      onView: (v) => { if (v.error) views.push(v.error); },
      onStreams: () => {},
      newCallId: () => ID,
    };
    const engine = createCallEngine(deps);
    await engine.place(A, 'audio', QUOTE);
    conn!.connectionState = 'closed';
    conn!.onconnectionstatechange?.();
    expect(views[views.length - 1]).toMatch(/through your node/);
    expect(views[views.length - 1]).not.toMatch(/direct connection/);
  });
});

describe('the shell with node-routed audio on (M6 build profile)', () => {
  let dispose: (() => void) | undefined;
  let mount: HTMLElement;
  beforeEach(() => {
    vi.stubEnv('VITE_CALL_MEDIA', 'node');
    // Tauri 2 sets window.isTauri; the shell picks the host media bridge on it.
    vi.stubGlobal('isTauri', true);
    FakePc.made = 0;
    FakeAudioContext.made = [];
    vi.stubGlobal('RTCPeerConnection', FakePc);
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('AudioWorkletNode', FakeAudioNode);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => stream() } });
  });
  afterEach(() => {
    setLanguagePref('en');
    dispose?.();
    dispose = undefined;
    mount?.remove();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const $ = <T extends Element = HTMLElement>(sel: string) => mount.querySelector<T>(sel);
  async function openShell() {
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => <App />, mount);
    await vi.waitFor(() => expect([...mount.querySelectorAll('button')].some((b) => b.textContent?.includes('I understand'))).toBe(true));
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
    await vi.waitFor(() => expect($(`[data-track="peer:${A}"]`)?.getAttribute('aria-current')).toBe('true'));
  }

  it('offers an audio call only, never video or a meeting', async () => {
    stubHost();
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    expect($('[data-call="video"]')).toBeNull();
    expect($('[data-call="meeting"]')).toBeNull();
    expect($('[data-meeting-panel]')).toBeNull();
  });

  it('before Ring, the minutes hold is one short plain promise; the full rules wait behind Details, in English and Danish', async () => {
    const host = stubHost();
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($('[data-call-reservation-max]')).not.toBeNull());
    const hold = $('[data-call-reservation-max]')!.textContent!;
    expect(hold).toMatch(/^Your node sets aside at most .+? for the minutes and gives back what is not used\. If it would need more, it does not ring and nothing is paid\. You confirm before the first minute is paid\.$/);
    const amount = hold.match(/at most (.+?) for the minutes/)![1];
    const detail = $<HTMLDetailsElement>('[data-call-reservation-detail]')!;
    expect(detail.open).toBe(false);
    // Nothing of the old paragraph is lost: it is behind Details, with the same amount.
    expect(detail.querySelector('p')!.textContent).toContain(`a hold of at most ${amount} (4 hours, the most a node allows)`);
    expect(detail.querySelector('p')!.textContent).toContain('nothing is paid');
    try {
      setLanguagePref('da');
      expect($('[data-call-reservation-max]')!.textContent).toBe(`Din node reserverer højst ${amount} til minutterne og giver det ubrugte tilbage. Skulle den bruge mere, ringer den ikke op, og der betales intet. Du bekræfter, før det første minut betales.`);
      expect(detail.querySelector('summary')!.textContent).toBe('Detaljer');
    } finally { setLanguagePref('en'); }
    expect(host.used('call_signal')).toHaveLength(0);
  });

  it('places a call through the host media socket: no RTCPeerConnection, the node label, live on the host’s open', async () => {
    const host = stubHost();
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-confirm="audio"]')?.click();
    await vi.waitFor(() => expect($('[data-call-panel="ringing"]')).not.toBeNull());
    expect($('[data-call-route="node"]')?.textContent).toBe('The call goes through your box and theirs. Both boxes can hear it.');
    // The offer went out with the node-routed marker, so an M6 peer joins at its node.
    const offer = host.used('call_signal').find((c) => (c.args as { kind: number }).kind === 400)!;
    expect(JSON.parse((offer.args as { plaintext: string }).plaintext).sdp).toContain('a=x-bitsov-media:node-routed-v1');
    expect(host.used('call_media_open')).toHaveLength(0);
    expect(FakePc.made).toBe(0);
    // STUN and recovery notes are about the direct path: not shown.
    expect($('[data-call-recovery-note]')).toBeNull();
    expect($('[data-call-network-note]')).toBeNull();
  });

  it('their node-routed answer opens the host media socket for the call id; the call is live once the host reports the link open', async () => {
    const host = stubHost();
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-confirm="audio"]')?.click();
    await vi.waitFor(() => expect($('[data-call-panel="ringing"]')).not.toBeNull());
    const offer = host.used('call_signal').find((c) => (c.args as { kind: number }).kind === 400)!;
    const callId = JSON.parse((offer.args as { plaintext: string }).plaintext).call_id as string;
    host.emitLive({ type: 'message', room_id: null, message: { id: 'ans', kind: 401, sender: A, recipient: OWN, timestamp: Date.now(), plaintext: JSON.stringify({ v: 1, call_id: callId, sdp: nodeRoutedSdp('answer', callId) }), payment_amount_msat: 1000 } });
    await vi.waitFor(() => expect(host.used('call_media_open')).toHaveLength(1));
    // The node admits the socket only for (peer, call_id): both travel to the host.
    expect(host.used('call_media_open')[0].args).toMatchObject({ call_id: callId, peer: A });
    expect($('[data-call-panel="connecting"]')).not.toBeNull();
    // The audio graph is up (HELLO went out through the host) before the link opens.
    await vi.waitFor(() => expect(host.used('call_media_send').length).toBeGreaterThan(0));
    expect(host.used('call_media_send')[0].args).toBeInstanceOf(Uint8Array);
    host.media({ link: 'connecting', detail: null });
    host.media({ link: 'open', detail: null });
    await vi.waitFor(() => expect($('[data-call-panel="live"]')).not.toBeNull());
    expect($('[data-call-route="node"]')).not.toBeNull();
    expect(FakePc.made).toBe(0);
    expect(FakeAudioContext.made).toHaveLength(1);
    // Hang up: the host ends the admission and the media socket closes with the call.
    $<HTMLButtonElement>('[data-call-hangup]')!.click();
    await vi.waitFor(() => expect(host.used('call_media_close').length).toBeGreaterThan(0));
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    await vi.waitFor(() => expect(FakeAudioContext.made[0].closed).toBe(true));
  });

  it('with sealing off, no seal command runs and the label and the offer are as they were', async () => {
    const host = stubHost();
    await routedLive(host);
    for (const cmd of ['call_seal_offer', 'call_seal_answer', 'call_seal_accept', 'call_seal_cancel']) expect(host.used(cmd)).toHaveLength(0);
    expect($('[data-call-route="node"]')?.textContent).toBe('The call goes through your box and theirs. Both boxes can hear it.');
    expect($('[data-call-route="node"]')?.hasAttribute('data-call-seal')).toBe(false);
    const offer = host.used('call_signal').find((c) => (c.args as { kind: number }).kind === 400)!;
    expect(JSON.parse((offer.args as { plaintext: string }).plaintext).sdp).not.toContain('x-bitsov-e2e');
    expect(Object.keys(host.used('call_media_open')[0].args as object).sort()).toEqual(['call_id', 'on_frame', 'peer']);
  });

  /** Rings Maya on a sealing build and delivers an answer with these extra SDP lines. */
  async function sealedRing(host: ReturnType<typeof stubHost>, answerLines: string[]) {
    vi.stubEnv('VITE_CALL_SEAL', 'sealed');
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-confirm="audio"]')?.click();
    await vi.waitFor(() => expect($('[data-call-panel="ringing"]')).not.toBeNull());
    expect($('[data-call-route="node"]')?.getAttribute('data-call-seal')).toBe('setting_up');
    const offer = host.used('call_signal').find((c) => (c.args as { kind: number }).kind === 400)!;
    const { call_id: callId, sdp } = JSON.parse((offer.args as { plaintext: string }).plaintext) as { call_id: string; sdp: string };
    expect(sdp).toContain('a=x-bitsov-e2e:1 commit=');
    const answer = nodeRoutedSdp('answer', callId) + answerLines.map((line) => `${line}\r\n`).join('');
    host.emitLive({ type: 'message', room_id: null, message: { id: 'ans', kind: 401, sender: A, recipient: OWN, timestamp: Date.now(), plaintext: JSON.stringify({ v: 1, call_id: callId, sdp: answer }), payment_msat: null, status: 'delivered' } });
    return callId;
  }

  it('with sealing on, the label says sealed only after the host reports an authenticated frame', async () => {
    const host = stubHost();
    const callId = await sealedRing(host, [`a=x-bitsov-e2e:1 key=${'cd'.repeat(32)} nonce=${'ef'.repeat(16)} caps=00000001`]);
    await vi.waitFor(() => expect(host.used('call_media_open')).toHaveLength(1));
    expect(host.used('call_media_open')[0].args).toMatchObject({ call_id: callId, peer: A, sealed: true });
    host.media({ link: 'open', detail: null });
    await vi.waitFor(() => expect($('[data-call-panel="live"]')).not.toBeNull());
    expect($('[data-call-route="node"]')?.getAttribute('data-call-seal')).toBe('setting_up');
    expect($('[data-call-route="node"]')?.textContent).toBe('Sealing this call. Nothing goes out unsealed.');
    host.media({ link: 'sealed', detail: null });
    await vi.waitFor(() => expect($('[data-call-route="node"]')?.getAttribute('data-call-seal')).toBe('sealed'));
    expect($('[data-call-route="node"]')?.textContent).toMatch(/unless one of them is attacking the call/);
    expect($('[data-call-route="node"]')?.textContent).not.toMatch(/Both boxes can hear it/);
  });

  it('with sealing on, an answer that cannot be sealed ends the call before any audio, and blames no side', async () => {
    const host = stubHost();
    await sealedRing(host, []);
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect($('[data-call-ended]')?.textContent).toBe('This call could not be sealed, so it was ended. Nothing was said unsealed.');
    expect(host.used('call_media_open')).toHaveLength(0);
    expect(host.used('call_media_send')).toHaveLength(0);
    expect(host.used('call_seal_cancel').length).toBeGreaterThan(0);
    expect($('[data-call-words]')).toBeNull();
  });

  it('with sealing on, a call that cannot stay sealed ends and says so', async () => {
    const host = stubHost();
    await sealedRing(host, [`a=x-bitsov-e2e:1 key=${'cd'.repeat(32)} nonce=${'ef'.repeat(16)} caps=00000001`]);
    await vi.waitFor(() => expect(host.used('call_media_open')).toHaveLength(1));
    host.media({ link: 'open', detail: null });
    await vi.waitFor(() => expect($('[data-call-panel="live"]')).not.toBeNull());
    host.media({ link: 'ended', detail: 'seal_no_authentic_frames' });
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect($('[data-call-ended]')?.textContent).toBe('The call could not stay sealed, so it ended. Nothing was sent unsealed. A minute already issued may still settle.');
  });

  const comparisonWords = () => [...mount.querySelectorAll('[data-call-words] [data-pair-word]')].map(el => el.textContent);
  const sealAnswer = `a=x-bitsov-e2e:1 key=${'cd'.repeat(32)} nonce=${'ef'.repeat(16)} caps=00000001`;

  it('shows exactly four comparison words in host order outside Details, without logging them or enabling video', async () => {
    const logs = ['log', 'info', 'warn', 'error', 'debug', 'trace'].map(method => vi.spyOn(console, method as 'log').mockImplementation(() => {}));
    const host = stubHost();
    await sealedRing(host, [sealAnswer]);
    await vi.waitFor(() => expect(host.used('call_media_open')).toHaveLength(1));
    host.media({ link: 'open', detail: null });
    await vi.waitFor(() => expect($('[data-call-panel="live"]')).not.toBeNull());
    expect(comparisonWords()).toEqual([]);
    host.media({ link: 'sealed_words', detail: null, words: ['zebra', 'acoustic', 'velvet', 'anchor'] });
    expect(comparisonWords()).toEqual([]);
    host.media({ link: 'sealed', detail: null });
    host.media({ link: 'sealed_words', detail: null, words: ['zebra', 'acoustic', 'velvet', 'anchor'] });
    await vi.waitFor(() => expect(comparisonWords()).toEqual(['zebra', 'acoustic', 'velvet', 'anchor']));
    expect($('[data-call-words] ol')?.getAttribute('aria-label')).toBe('Comparison words');
    expect($('[data-call-words]')?.closest('details')).toBeNull();
    expect($('[data-call-words] p')?.textContent).toMatch(/compare all four words in order.*separate trusted channel.*before speaking privately/i);
    expect($('[data-call="video"]')).toBeNull();
    expect($('[data-call-camera]')).toBeNull();
    const logged = JSON.stringify(logs.flatMap(log => log.mock.calls));
    for (const word of ['zebra', 'acoustic', 'velvet', 'anchor']) expect(logged).not.toContain(word);
  });

  it('clears ended words, ignores an old channel, and shows the next call’s words only after its seal', async () => {
    const host = stubHost();
    const firstId = await sealedRing(host, [sealAnswer]);
    await vi.waitFor(() => expect(host.used('call_media_open')).toHaveLength(1));
    host.media({ link: 'open', detail: null });
    host.media({ link: 'sealed', detail: null });
    host.media({ link: 'sealed_words', detail: null, words: ['zebra', 'acoustic', 'velvet', 'anchor'] });
    await vi.waitFor(() => expect(comparisonWords()).toHaveLength(4));
    $<HTMLButtonElement>('[data-call-hangup]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect(comparisonWords()).toEqual([]);
    $<HTMLButtonElement>('[data-call-dismiss]')!.click();
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-confirm="audio"]')?.click();
    await vi.waitFor(() => expect($('[data-call-panel="ringing"]')).not.toBeNull());
    const offers = host.used('call_signal').filter(c => (c.args as { kind: number }).kind === 400);
    const offer = offers[offers.length - 1];
    const { call_id: secondId } = JSON.parse((offer.args as { plaintext: string }).plaintext);
    expect(secondId).not.toBe(firstId);
    expect(comparisonWords()).toEqual([]);
    host.media({ link: 'sealed_words', detail: null, words: ['zebra', 'acoustic', 'velvet', 'anchor'] }, 0);
    expect(comparisonWords()).toEqual([]);
    host.emitLive({ type: 'message', room_id: null, message: { id: 'next-answer', kind: 401, sender: A, recipient: OWN, timestamp: Date.now(), plaintext: JSON.stringify({ v: 1, call_id: secondId, sdp: nodeRoutedSdp('answer', secondId, sealAnswer) }), payment_msat: null, status: 'delivered' } });
    await vi.waitFor(() => expect(host.used('call_media_open')).toHaveLength(2));
    host.media({ link: 'open', detail: null });
    await vi.waitFor(() => expect($('[data-call-panel="live"]')).not.toBeNull());
    expect(comparisonWords()).toEqual([]);
    host.media({ link: 'sealed', detail: null });
    host.media({ link: 'sealed_words', detail: null, words: ['yellow', 'orbit', 'timber', 'cactus'] });
    await vi.waitFor(() => expect(comparisonWords()).toEqual(['yellow', 'orbit', 'timber', 'cactus']));
    host.media({ link: 'ended', detail: 'seal_no_authentic_frames' });
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    host.media({ link: 'sealed_words', detail: null, words: ['yellow', 'orbit', 'timber', 'cactus'] });
    expect(comparisonWords()).toEqual([]);
  });

  it('shows no words when sealing is off or fails, even if a channel carries words', async () => {
    const host = stubHost();
    await routedLive(host);
    host.media({ link: 'sealed_words', detail: null, words: ['zebra', 'acoustic', 'velvet', 'anchor'] });
    expect(comparisonWords()).toEqual([]);
    host.media({ link: 'ended', detail: 'seal_bad_reveal' });
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect(comparisonWords()).toEqual([]);
  });

  it('keeps the not-sealed label without words for an incoming call without sealing', async () => {
    vi.stubEnv('VITE_CALL_SEAL', 'sealed');
    const host = stubHost();
    await openShell();
    host.emitLive({ type: 'message', room_id: null, message: { id: 'unsealed-offer', kind: 400, sender: A, recipient: OWN, timestamp: Date.now(), plaintext: JSON.stringify({ v: 1, call_id: ID, media: 'audio', sdp: nodeRoutedSdp('offer', ID) }), payment_msat: null, status: 'delivered' } });
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-accept]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-accept]')!.click();
    await vi.waitFor(() => expect(host.used('call_media_open')).toHaveLength(1));
    host.media({ link: 'open', detail: null });
    await vi.waitFor(() => expect($('[data-call-panel="live"]')).not.toBeNull());
    expect($('[data-call-route="node"]')?.getAttribute('data-call-seal')).toBe('not_sealed');
    expect($('[data-call-route="node"]')?.textContent).toMatch(/^Not sealed:/);
    host.media({ link: 'sealed_words', detail: null, words: ['zebra', 'acoustic', 'velvet', 'anchor'] });
    expect(comparisonWords()).toEqual([]);
    expect($('[data-call-route="node"]')?.getAttribute('data-call-seal')).toBe('not_sealed');
  });

  it('a node refusal on the media socket ends the call instead of leaving it ringing', async () => {
    const host = stubHost();
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-confirm="audio"]')?.click();
    await vi.waitFor(() => expect($('[data-call-panel="ringing"]')).not.toBeNull());
    const offer = host.used('call_signal').find((c) => (c.args as { kind: number }).kind === 400)!;
    const callId = JSON.parse((offer.args as { plaintext: string }).plaintext).call_id as string;
    host.emitLive({ type: 'message', room_id: null, message: { id: 'ans', kind: 401, sender: A, recipient: OWN, timestamp: Date.now(), plaintext: JSON.stringify({ v: 1, call_id: callId, sdp: nodeRoutedSdp('answer', callId) }), payment_amount_msat: 1000 } });
    await vi.waitFor(() => expect(host.used('call_media_open')).toHaveLength(1));
    host.media({ link: 'ended', detail: 'the node refused the media socket (403)' });
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect($('[data-call-ended]')?.textContent).toBe('The call audio link through your node closed.');
  });

  /** Rings Maya and brings the call live through the host media socket. */
  async function routedLive(host: ReturnType<typeof stubHost>, atRinging?: () => void) {
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-confirm="audio"]')?.click();
    await vi.waitFor(() => expect($('[data-call-panel="ringing"]')).not.toBeNull());
    atRinging?.();
    const offer = host.used('call_signal').find((c) => (c.args as { kind: number }).kind === 400)!;
    const callId = JSON.parse((offer.args as { plaintext: string }).plaintext).call_id as string;
    host.emitLive({ type: 'message', room_id: null, message: { id: 'ans', kind: 401, sender: A, recipient: OWN, timestamp: Date.now(), plaintext: JSON.stringify({ v: 1, call_id: callId, sdp: nodeRoutedSdp('answer', callId) }), payment_amount_msat: 1000 } });
    await vi.waitFor(() => expect(host.used('call_media_open')).toHaveLength(1));
    host.media({ link: 'open', detail: null });
    await vi.waitFor(() => expect($('[data-call-panel="live"]')).not.toBeNull());
  }

  it('a short live card: no Pay button or Lightning-address note while the call lasts; the contact can be paid again after it ends', async () => {
    const host = stubHost();
    await routedLive(host, () => expect($('[data-call-pay]')).toBeNull());
    // The peer reports no Lightning address: before, a disabled Pay and an "unavailable" note showed here.
    expect($('[data-call-pay]')).toBeNull();
    expect($('[data-call-panel]')!.textContent).not.toMatch(/Lightning payment address/);
    // The short card: name, timer, mute, hang up.
    expect($('[data-call-panel] .who')?.textContent).toBe('Maya');
    expect($('[data-call-duration]')).not.toBeNull();
    expect($('[data-call-mute]')).not.toBeNull();
    expect($('[data-call-hangup]')).not.toBeNull();
    $<HTMLButtonElement>('[data-call-hangup]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect($('[data-call-pay]')).toBeNull();
    // After the call, the chat's own Pay (the + menu below the messages) is there as before.
    expect([...mount.querySelectorAll('[role="menuitem"]')].some((b) => b.textContent === 'Pay')).toBe(true);
  });

  it('the routing line stays visible outside the closed Details disclosure, and both are gone once the call ends', async () => {
    const host = stubHost();
    await routedLive(host);
    const details = $<HTMLDetailsElement>('[data-call-panel] [data-call-details]')!;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')?.textContent).toBe('Details');
    expect(details.querySelector('[data-call-route="node"]')).toBeNull();
    expect($('[data-call-panel] [data-call-route="node"]')?.textContent).toBe('The call goes through your box and theirs. Both boxes can hear it.');
    expect($('[data-call-panel]')!.querySelectorAll('[data-call-route]')).toHaveLength(1);
    $<HTMLButtonElement>('[data-call-hangup]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect($('[data-call-details]')).toBeNull();
    expect($('[data-call-route]')).toBeNull();
  });

  it('Danish: the routing line says both boxes can hear the call, outside Detaljer', async () => {
    const host = stubHost();
    setLanguagePref('da');
    await routedLive(host);
    const details = $<HTMLDetailsElement>('[data-call-panel] [data-call-details]')!;
    expect(details.querySelector('summary')?.textContent).toBe('Detaljer');
    expect(details.querySelector('[data-call-route="node"]')).toBeNull();
    expect($('[data-call-panel] [data-call-route="node"]')?.textContent).toBe('Opkaldet går gennem din boks og deres. Begge bokse kan høre det.');
    expect($('[data-call-panel]')!.textContent).not.toMatch(/Betal|Lightning-betalingsadresse/);
  });

  it('shows the label in Danish too', async () => {
    stubHost();
    setLanguagePref('da');
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-confirm="audio"]')?.click();
    await vi.waitFor(() => expect($('[data-call-route="node"]')).not.toBeNull());
    expect($('[data-call-route="node"]')?.textContent).toBe('Opkaldet går gennem din boks og deres. Begge bokse kan høre det.');
  });
});
