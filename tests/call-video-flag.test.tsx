/**
 * Node-routed video flag: off, the shell is the audio-only M6 card and a video
 * offer is answered as audio. On, a video call opens the video path on the same
 * socket and says plainly, in both languages, that the nodes can read it. An
 * audio call on that build still opens an audio session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import { setLanguagePref } from '../src/i18n';
import { resetContactsForTests, setPetname } from '../src/control/petnames';
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
  // A quote that never answers keeps an accepted call in connecting, before its video path is built.
  let heldQuote: Promise<CallQuote> | null = null;
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
    call_quote: () => heldQuote ?? QUOTE,
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
    holdQuotes: () => { heldQuote = new Promise<CallQuote>(() => {}); },
    resetEnded: () => { ended = false; },
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
const camera = () => ({ kind: 'video', enabled: true, stop: vi.fn() }) as unknown as MediaStreamTrack;
const constraintsSeen: MediaStreamConstraints[] = [];
const stream = (constraints: MediaStreamConstraints = { audio: true }) => {
  constraintsSeen.push(constraints);
  const audio = constraints.audio ? [track()] : [];
  const video = constraints.video ? [camera()] : [];
  const tracks = [...audio, ...video];
  return Object.assign(new MediaStream(), { getTracks: () => tracks, getAudioTracks: () => audio, getVideoTracks: () => video, addTrack: () => {}, removeTrack: () => {} });
};

describe('call video flag', () => {
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
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async (c: MediaStreamConstraints) => stream(c) } });
    constraintsSeen.length = 0;
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
    await vi.waitFor(() => expect([...mount.querySelectorAll('button')].some((b) => b.hasAttribute('data-trust-continue'))).toBe(true));
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.hasAttribute('data-trust-continue'))!.click();
    await vi.waitFor(() => expect($(`[data-track="peer:${A}"]`)?.getAttribute('aria-current')).toBe('true'));
  }

  const answer = (host: ReturnType<typeof stubHost>) => {
    const offer = host.used('call_signal').find((c) => (c.args as { kind: number }).kind === 400)!;
    const plain = JSON.parse((offer.args as { plaintext: string }).plaintext) as { call_id: string; media: string; sdp: string };
    host.emitLive({ type: 'message', room_id: null, message: { id: 'ans', kind: 401, sender: A, recipient: OWN, timestamp: Date.now(), plaintext: JSON.stringify({ v: 1, call_id: plain.call_id, sdp: nodeRoutedSdp('answer', plain.call_id) }), attachment: null, status: 'delivered' } });
    return plain;
  };

  async function placeVideo(host: ReturnType<typeof stubHost>) {
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="video"]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call="video"]')!.click();
    await vi.waitFor(() => expect($('[data-call-confirm="video"]')).not.toBeNull());
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="video"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-confirm="video"]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ringing"]')).not.toBeNull());
    return answer(host);
  }

  it('off by default: no video button, and no camera is asked for', async () => {
    const host = stubHost();
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    expect($('[data-call="video"]')).toBeNull();
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-confirm="audio"]')?.click();
    await vi.waitFor(() => expect($('[data-call-panel="ringing"]')).not.toBeNull());
    answer(host);
    await vi.waitFor(() => expect(host.used('call_media_open')).toHaveLength(1));
    expect(Object.keys(host.used('call_media_open')[0].args as object).sort()).toEqual(['call_id', 'on_frame', 'peer']);
    expect(constraintsSeen.every((c) => !c.video)).toBe(true);
    expect(host.used('call_media_video_send')).toHaveLength(0);
    expect($('[data-call-route="node"]')?.textContent).toBe('The call goes through your box and theirs. Both boxes can hear it.');
  });

  it('off: an incoming video offer rings and is answered as audio, camera untouched', async () => {
    const host = stubHost();
    await openShell();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    const callId = '0123456789abcdef0123456789abcdef';
    host.emitLive({ type: 'message', room_id: null, message: { id: 'off', kind: 400, sender: A, recipient: OWN, timestamp: Date.now(), plaintext: JSON.stringify({ v: 1, call_id: callId, media: 'video', sdp: nodeRoutedSdp('offer', callId) }), attachment: null, status: 'delivered' } });
    await vi.waitFor(() => expect($('[data-call-panel="incoming"]')).not.toBeNull());
    expect($('[data-call-title]')?.textContent).not.toMatch(/video/i);
    // The card says what will happen: an audio call, with no camera notice.
    expect($('[data-call-title]')?.textContent).toBe('Incoming audio call');
    expect($('[data-call-camera-notice]')).toBeNull();
    expect(constraintsSeen.every((c) => !c.video)).toBe(true);
  });

  describe('on', () => {
    beforeEach(() => { vi.stubEnv('VITE_CALL_VIDEO', 'node'); });

    it('a video call asks for the camera, opens the video path, and says the boxes can see it', async () => {
      const host = stubHost();
      await placeVideo(host);
      expect(constraintsSeen.some((c) => c.video === true)).toBe(true);
      expect($('[data-call-route="node"]')?.textContent).toBe('The call and its video go through your box and theirs. Both boxes can see and hear it.');
      await vi.waitFor(() => expect(host.used('call_media_open')).toHaveLength(1));
      expect((host.used('call_media_open')[0].args as { video: unknown }).video).toBe(true);
      host.media({ link: 'open', detail: null });
      await vi.waitFor(() => expect($('[data-call-panel="live"]')).not.toBeNull());
      // The label stays outside Details for the whole call.
      expect($('[data-call-details] [data-call-route="node"]')).toBeNull();
      expect($('[data-call-panel] [data-call-route="node"]')).not.toBeNull();
      // This environment has no WebCodecs: the card says so, the call goes on.
      await vi.waitFor(() => expect($('[data-call-video-status]')?.textContent).toBe("Video doesn't work on this device. The sound carries on."));
      expect($('[data-call-panel="live"]')).not.toBeNull();
      expect($('[data-call-camera]')).not.toBeNull();
      expect($('canvas[data-call-media="remote"]')).not.toBeNull();
    });

    it('says it in Danish too', async () => {
      const host = stubHost();
      setLanguagePref('da');
      await placeVideo(host);
      expect($('[data-call-route="node"]')?.textContent).toBe('Opkaldet og videoen går gennem din boks og deres. Begge bokse kan se og høre det.');
      await vi.waitFor(() => expect($('[data-call-video-status]')?.textContent).toBe('Video virker ikke på denne enhed. Lyden fortsætter.'));
    });

    it('never claims encryption, in either language', async () => {
      const host = stubHost();
      await placeVideo(host);
      expect($('[data-call-panel]')!.textContent).not.toMatch(/encrypt|private|secure/i);
      dispose?.();
      mount.remove();
      setLanguagePref('da');
      const again = stubHost();
      await placeVideo(again);
      expect($('[data-call-panel]')!.textContent).not.toMatch(/kryptere|krypteret|privat|sikker/i);
    });

    it('an audio call on this build is still an audio session with no video path', async () => {
      const host = stubHost();
      await openShell();
      await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
      $<HTMLButtonElement>('[data-call="audio"]')!.click();
      await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
      $<HTMLButtonElement>('[data-call-confirm="audio"]')?.click();
      await vi.waitFor(() => expect($('[data-call-panel="ringing"]')).not.toBeNull());
      answer(host);
      await vi.waitFor(() => expect(host.used('call_media_open')).toHaveLength(1));
      expect(Object.keys(host.used('call_media_open')[0].args as object).sort()).toEqual(['call_id', 'on_frame', 'peer']);
      expect(constraintsSeen.every((c) => !c.video)).toBe(true);
      expect(host.used('call_media_video_send')).toHaveLength(0);
      expect($('[data-call-route="node"]')?.textContent).toBe('The call goes through your box and theirs. Both boxes can hear it.');
    });


    it('the next call shows neither the last call\'s picture nor its video status', async () => {
      const host = stubHost();
      const first = await placeVideo(host);
      await vi.waitFor(() => expect(host.used('call_media_open')).toHaveLength(1));
      host.media({ link: 'open', detail: null });
      await vi.waitFor(() => expect($('[data-call-panel="live"]')).not.toBeNull());
      await vi.waitFor(() => expect($('[data-call-video-status]')).not.toBeNull());
      const earlier = $<HTMLCanvasElement>('canvas[data-call-media="remote"]')!;
      expect(earlier).not.toBeNull();
      $<HTMLButtonElement>('[data-call-hangup]')!.click();
      await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
      host.resetEnded();
      const next = 'fedcba9876543210fedcba9876543210';
      expect(next).not.toBe(first.call_id);
      host.emitLive({ type: 'message', room_id: null, message: { id: 'next-offer', kind: 400, sender: A, recipient: OWN, timestamp: Date.now(), plaintext: JSON.stringify({ v: 1, call_id: next, media: 'video', sdp: nodeRoutedSdp('offer', next) }), attachment: null, status: 'delivered' } });
      await vi.waitFor(() => expect($('[data-call-panel="incoming"]')).not.toBeNull());
      await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-accept]')?.disabled).toBe(false));
      host.holdQuotes();
      $<HTMLButtonElement>('[data-call-accept]')!.click();
      await vi.waitFor(() => expect($('[data-call-panel="connecting"]')).not.toBeNull());
      // The new call has no video path yet, so nothing of the last one may stand in for it.
      expect(host.used('call_media_open')).toHaveLength(1);
      expect($('canvas[data-call-media="remote"]')).not.toBe(earlier);
      expect(earlier.isConnected).toBe(false);
      expect($('[data-call-video-status]')).toBeNull();
    });

  });
});
