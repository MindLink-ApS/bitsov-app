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
  let mediaIndex = 0;
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
    call_signal: (args) => ({ message_id: 'sig', kind: (args as { kind: number }).kind, amount_msat: 10_000, total_msat: 15_000, max_routing_fee_msat: 5000, delivered: true, accepted: true, sent_at_ms: Date.now() }),
    call_status: (args) => status(args),
    call_hold: (args) => status(args),
    call_block: () => ({ message_id: 'blk', kind: 404, amount_msat: 10_000, total_msat: 15_000, max_routing_fee_msat: 5_000, delivered: true, accepted: true, sent_at_ms: Date.now() }),
    op_end_call: (args) => (ended = true, { op_id: 'end', kind: 'call_hangup', peer: A, call_id: (args as { call_id: string }).call_id, state: 'settled', cap_msat: 6_000, paid_msat: 6_000, message_id: 'hangup' }),
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
    used: (cmd: string) => calls.filter((c) => c.cmd === cmd),
    emitLive: (payload: unknown) => {
      const listen = calls.find((c) => c.cmd === 'plugin:event|listen');
      callbacks.get((listen!.args as { handler: number }).handler)!({ event: 'node-live', id: 1, payload });
    },
    /** Deliver a host media channel message in order (the renderer's Channel is the `on_frame` arg): link
     *  transitions arrive as parsed JSON objects, frames as ArrayBuffers, exactly as Tauri delivers them. */
    media: (message: unknown) => {
      const opens = calls.filter((c) => c.cmd === 'call_media_open');
      const open = opens[opens.length - 1];
      const channel = (open!.args as { on_frame: { id: number } }).on_frame;
      callbacks.get(channel.id)!({ message, index: mediaIndex++ });
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

  it('places a call through the host media socket: no RTCPeerConnection, the node label, live on the host’s open', async () => {
    const host = stubHost();
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    $<HTMLButtonElement>('[data-call-confirm="audio"]')?.click();
    await vi.waitFor(() => expect($('[data-call-panel="ringing"]')).not.toBeNull());
    expect($('[data-call-route="node"]')?.textContent).toBe('Encrypted between your node and theirs — both nodes can hear it');
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

  it('a node refusal on the media socket ends the call instead of leaving it ringing', async () => {
    const host = stubHost();
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
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

  it('shows the label in Danish too', async () => {
    stubHost();
    setLanguagePref('da');
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    $<HTMLButtonElement>('[data-call-confirm="audio"]')?.click();
    await vi.waitFor(() => expect($('[data-call-route="node"]')).not.toBeNull());
    expect($('[data-call-route="node"]')?.textContent).toBe('Krypteret mellem din node og deres — begge noder kan høre opkaldet');
  });
});
