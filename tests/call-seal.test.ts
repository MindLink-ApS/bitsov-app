/**
 * Sealing in the renderer: only the attributes pass through here, the host
 * owns keys and frames. Off by default, and with it off nothing differs from a
 * build without the code. With it on, the label never says more than the call
 * has shown, and a wrong exchange never falls back to an unsealed call.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallAudio, MediaTransport } from '../src/control/callAudio';
import { createCallEngine, mediaError, type CallDeps } from '../src/control/call';
import { sealedAudio } from '../src/control/callFlags';
import { hostCallSeal, hostMediaBridge, parseLinkMessage, type CallSeal, type MediaBridge, type MediaLink } from '../src/control/mediaBridge';
import {
  createNodeRoutedConnection,
  nodeRoutedSdp,
  NodeRoutedConnection,
  SEAL_ENDED,
  SEAL_REFUSED,
  type SealState,
} from '../src/control/nodeRoutedConnection';
import { callSealFlag } from '../vite.config';
import { t as tr, setLanguagePref } from '../src/i18n';
import type { CallQuote } from '../src/control/types';

const ID = '0123456789abcdef0123456789abcdef';
const PEER = 'a'.repeat(64);
const OFFER_LINE = `a=x-bitsov-e2e:1 commit=${'ab'.repeat(32)} caps=00000001 sas=01`;
const ANSWER_LINE = `a=x-bitsov-e2e:1 key=${'cd'.repeat(32)} nonce=${'ef'.repeat(16)} caps=00000001`;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeBridge() {
  const sent: Uint8Array[] = [];
  let onLink: ((link: MediaLink) => void) | null = null;
  const opened: { callId: string; peer: string; sealed: boolean | undefined; args: number }[] = [];
  const bridge: MediaBridge = {
    open: async (...args) => {
      const [callId, peer, , link, sealed] = args;
      opened.push({ callId, peer, sealed, args: args.length });
      onLink = link;
    },
    send: (payload) => { sent.push(payload); },
    close: async () => {},
  };
  return { bridge, sent, opened, link: (l: MediaLink) => onLink?.(l) };
}

const audio = (_stream: MediaStream, _transport: MediaTransport): CallAudio => ({
  ready: Promise.resolve(),
  feed: () => {},
  setMuted: () => {},
  codecs: () => ({ sending: 'pcmu', localCaps: 1, peerCaps: null }),
  stats: async () => null,
  close: async () => {},
});

function fakeSeal(over: Partial<CallSeal> = {}) {
  const calls: string[] = [];
  const seal: CallSeal = {
    offer: async () => { calls.push('offer'); return OFFER_LINE; },
    answer: async (_call, _peer, line) => { calls.push(`answer ${line}`); return ANSWER_LINE; },
    accept: async (_call, line) => { calls.push(`accept ${line}`); return true; },
    cancel: async () => { calls.push('cancel'); },
    ...over,
  };
  return { seal, calls };
}

function sealedConnection(seal: CallSeal) {
  const b = fakeBridge();
  const states: SealState[] = [];
  const conn = new NodeRoutedConnection({ callId: () => ID, peer: () => PEER, bridge: b.bridge, audio, seal, onSeal: (s) => states.push(s) });
  return { conn, b, states };
}

const sdpWith = (type: 'offer' | 'answer', ...lines: string[]) => {
  const base = nodeRoutedSdp(type, ID);
  return base + lines.map((line) => `${line}\r\n`).join('');
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setLanguagePref('en');
});

describe('the build flag', () => {
  it('is off unless the exact value is set, and never on the lab path', () => {
    expect(sealedAudio({})).toBe(false);
    for (const value of ['', '1', 'true', 'Sealed', 'sealed ', 'off']) expect(sealedAudio({ VITE_CALL_SEAL: value })).toBe(false);
    expect(sealedAudio({ VITE_CALL_SEAL: 'sealed' })).toBe(true);
    expect(sealedAudio({ VITE_CALL_SEAL: 'sealed', VITE_CALL_MEDIA: 'webrtc' })).toBe(false);
    expect(callSealFlag({})).toBe('off');
    expect(callSealFlag({ VITE_CALL_SEAL: 'true' })).toBe('off');
    expect(callSealFlag({ VITE_CALL_SEAL: 'sealed' })).toBe('sealed');
  });
});

describe('with the flag off, the renderer sends what it sent before sealing existed', () => {
  it('the same description, byte for byte', () => {
    expect(nodeRoutedSdp('offer', ID)).toBe(
      'v=0\r\no=bitsov 0 0 IN IP4 0.0.0.0\r\ns=bitsov-node-routed-audio\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 0\r\nc=IN IP4 0.0.0.0\r\n'
      + 'a=x-bitsov-media:node-routed-v1\r\na=x-bitsov-call:0123456789abcdef0123456789abcdef\r\na=sendrecv\r\n',
    );
    expect(nodeRoutedSdp('answer', ID)).toBe(nodeRoutedSdp('offer', ID));
  });

  it('the same offer, answer and media open, with no seal to call', async () => {
    const b = fakeBridge();
    const conn = createNodeRoutedConnection({ callId: () => ID, peer: () => PEER, bridge: b.bridge, audio });
    const offer = await conn.createOffer();
    expect(offer.sdp).toBe(nodeRoutedSdp('offer', ID));
    expect((await conn.createAnswer()).sdp).toBe(nodeRoutedSdp('answer', ID));
    await conn.setLocalDescription(offer);
    // A peer's answer carrying the attribute changes nothing here: this build ignores it.
    await conn.setRemoteDescription({ type: 'answer', sdp: sdpWith('answer', ANSWER_LINE) });
    await tick();
    expect(b.opened[0].sealed).toBeUndefined();
  });

  it('an offer carrying the attribute gets today’s answer: this build ignores it', async () => {
    const b = fakeBridge();
    const conn = createNodeRoutedConnection({ callId: () => ID, peer: () => PEER, bridge: b.bridge, audio });
    await conn.setRemoteDescription({ type: 'offer', sdp: sdpWith('offer', OFFER_LINE) });
    const answer = await conn.createAnswer();
    expect(answer.sdp).toBe(nodeRoutedSdp('answer', ID));
    await conn.setLocalDescription(answer);
    await tick();
    expect(b.opened[0].sealed).toBeUndefined();
  });

  it('the same host call: `call_media_open` carries the same three arguments', async () => {
    const calls: { cmd: string; args: Record<string, unknown> }[] = [];
    vi.stubGlobal('__TAURI_INTERNALS__', {
      transformCallback: () => 1,
      invoke: (cmd: string, args: Record<string, unknown>) => { calls.push({ cmd, args }); return Promise.resolve(null); },
    });
    await hostMediaBridge().open(ID, PEER, () => {}, () => {});
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('call_media_open');
    expect(Object.keys(calls[0].args).sort()).toEqual(['call_id', 'on_frame', 'peer']);
    calls.length = 0;
    await hostMediaBridge().open(ID, PEER, () => {}, () => {}, true);
    expect(calls[0].args).toMatchObject({ call_id: ID, peer: PEER, sealed: true });
  });

  it('the seal commands are only reached through a seal', async () => {
    const calls: { cmd: string; args: unknown }[] = [];
    vi.stubGlobal('__TAURI_INTERNALS__', {
      transformCallback: () => 1,
      invoke: (cmd: string, args: unknown) => { calls.push({ cmd, args }); return Promise.resolve(null); },
    });
    const seal = hostCallSeal();
    expect(calls).toHaveLength(0);
    await seal.offer(ID, PEER);
    await seal.answer(ID, PEER, OFFER_LINE);
    await seal.accept(ID, ANSWER_LINE);
    await seal.cancel(ID);
    expect(calls).toEqual([
      { cmd: 'call_seal_offer', args: { call_id: ID, peer: PEER } },
      { cmd: 'call_seal_answer', args: { call_id: ID, peer: PEER, offer: OFFER_LINE } },
      { cmd: 'call_seal_accept', args: { call_id: ID, answer: ANSWER_LINE } },
      { cmd: 'call_seal_cancel', args: { call_id: ID } },
    ]);
  });
});

describe('the caller', () => {
  it('offers the attribute, accepts the answer, opens the socket sealed, and the label follows the host', async () => {
    const { seal, calls } = fakeSeal();
    const { conn, b, states } = sealedConnection(seal);
    const offer = await conn.createOffer();
    expect(offer.sdp!.split('\r\n').filter((line) => line === OFFER_LINE)).toHaveLength(1);
    expect(states).toEqual(['setting_up']);
    await conn.setLocalDescription(offer);
    expect(b.opened).toHaveLength(0);
    await conn.setRemoteDescription({ type: 'answer', sdp: sdpWith('answer', ANSWER_LINE) });
    await tick();
    expect(calls).toEqual(['offer', `accept ${ANSWER_LINE}`]);
    expect(b.opened).toEqual([{ callId: ID, peer: PEER, sealed: true, args: 5 }]);
    // An open socket says nothing about the seal: only an authenticated frame does.
    b.link({ link: 'open', detail: null });
    await tick();
    expect(states).toEqual(['setting_up']);
    b.link({ link: 'sealed', detail: null });
    expect(states).toEqual(['setting_up', 'sealed']);
  });

  it('shows a peer that cannot seal, and opens the socket unsealed only then', async () => {
    const { seal, calls } = fakeSeal();
    const { conn, b, states } = sealedConnection(seal);
    await conn.setLocalDescription(await conn.createOffer());
    await conn.setRemoteDescription({ type: 'answer', sdp: nodeRoutedSdp('answer', ID) });
    await tick();
    expect(states).toEqual(['setting_up', 'not_sealed']);
    expect(calls).toEqual(['offer', 'cancel']);
    expect(b.opened[0].sealed).toBeUndefined();
  });

  it('shows the same when the answer says it lacks the capability', async () => {
    const { seal } = fakeSeal({ accept: async () => false });
    const { conn, b, states } = sealedConnection(seal);
    await conn.setLocalDescription(await conn.createOffer());
    await conn.setRemoteDescription({ type: 'answer', sdp: sdpWith('answer', ANSWER_LINE) });
    await tick();
    expect(states[states.length - 1]).toBe('not_sealed');
    expect(b.opened[0].sealed).toBeUndefined();
  });

  it('refuses a wrong answer: no socket opens, never unsealed', async () => {
    const { seal } = fakeSeal({ accept: async () => { throw new Error('seal_invalid_attribute'); } });
    const { conn, b, states } = sealedConnection(seal);
    await conn.setLocalDescription(await conn.createOffer());
    await expect(conn.setRemoteDescription({ type: 'answer', sdp: sdpWith('answer', ANSWER_LINE) })).rejects.toMatchObject({ name: SEAL_REFUSED });
    await tick();
    expect(b.opened).toHaveLength(0);
    expect(states).not.toContain('not_sealed');
  });

  it('refuses two attributes in one answer', async () => {
    const { seal, calls } = fakeSeal();
    const { conn, b } = sealedConnection(seal);
    await conn.setLocalDescription(await conn.createOffer());
    await expect(conn.setRemoteDescription({ type: 'answer', sdp: sdpWith('answer', ANSWER_LINE, ANSWER_LINE) })).rejects.toMatchObject({ name: SEAL_REFUSED });
    expect(calls).toEqual(['offer']);
    expect(b.opened).toHaveLength(0);
  });

  it('a sealed call makes one offer: it does not restart', async () => {
    const { seal, calls } = fakeSeal();
    const { conn } = sealedConnection(seal);
    await conn.createOffer();
    await expect(conn.createOffer({ iceRestart: true })).rejects.toMatchObject({ name: SEAL_REFUSED });
    expect(calls).toEqual(['offer']);
  });

  it('a host that cannot make an offer stops the call before anything is paid', async () => {
    const { seal } = fakeSeal({ offer: async () => { throw new Error('seal_disabled'); } });
    const { conn, states } = sealedConnection(seal);
    await expect(conn.createOffer()).rejects.toMatchObject({ name: SEAL_REFUSED });
    expect(states).toEqual([]);
  });
});

describe('the callee', () => {
  it('answers an offer with the attribute and waits sealed', async () => {
    const { seal, calls } = fakeSeal();
    const { conn, b, states } = sealedConnection(seal);
    await conn.setRemoteDescription({ type: 'offer', sdp: sdpWith('offer', OFFER_LINE) });
    const answer = await conn.createAnswer();
    expect(answer.sdp).toContain(ANSWER_LINE);
    expect(calls).toEqual([`answer ${OFFER_LINE}`]);
    await conn.setLocalDescription(answer);
    await tick();
    expect(b.opened).toEqual([{ callId: ID, peer: PEER, sealed: true, args: 5 }]);
    expect(states).toEqual(['setting_up']);
  });

  it('an offer with no attribute comes from an app that cannot seal: shown, and answered as today', async () => {
    const { seal, calls } = fakeSeal();
    const { conn, b, states } = sealedConnection(seal);
    await conn.setRemoteDescription({ type: 'offer', sdp: nodeRoutedSdp('offer', ID) });
    const answer = await conn.createAnswer();
    expect(answer.sdp).toBe(nodeRoutedSdp('answer', ID));
    expect(calls).toEqual([]);
    expect(states).toEqual(['not_sealed']);
    await conn.setLocalDescription(answer);
    await tick();
    expect(b.opened[0].sealed).toBeUndefined();
  });

  it('an offer without the capability is shown the same way', async () => {
    const { seal } = fakeSeal({ answer: async () => null });
    const { conn, states } = sealedConnection(seal);
    await conn.setRemoteDescription({ type: 'offer', sdp: sdpWith('offer', OFFER_LINE) });
    expect((await conn.createAnswer()).sdp).toBe(nodeRoutedSdp('answer', ID));
    expect(states).toEqual(['not_sealed']);
  });

  it('answers once: a repeated or different offer never replaces the exchange or the label', async () => {
    const { seal, calls } = fakeSeal();
    const { conn, states } = sealedConnection(seal);
    await conn.setRemoteDescription({ type: 'offer', sdp: sdpWith('offer', OFFER_LINE) });
    await conn.createAnswer();
    await conn.setRemoteDescription({ type: 'offer', sdp: nodeRoutedSdp('offer', ID) });
    await expect(conn.createAnswer()).rejects.toMatchObject({ name: SEAL_REFUSED });
    expect(calls).toEqual([`answer ${OFFER_LINE}`]);
    expect(states).toEqual(['setting_up']);
  });

  it('a wrong offer is refused, and so are two', async () => {
    const wrong = sealedConnection(fakeSeal({ answer: async () => { throw new Error('seal_invalid_attribute'); } }).seal);
    await wrong.conn.setRemoteDescription({ type: 'offer', sdp: sdpWith('offer', OFFER_LINE) });
    await expect(wrong.conn.createAnswer()).rejects.toMatchObject({ name: SEAL_REFUSED });
    const two = sealedConnection(fakeSeal().seal);
    await two.conn.setRemoteDescription({ type: 'offer', sdp: sdpWith('offer', OFFER_LINE, OFFER_LINE) });
    await expect(two.conn.createAnswer()).rejects.toMatchObject({ name: SEAL_REFUSED });
  });
});

describe('the end of a sealed call', () => {
  it('a host seal failure ends the call and names why', async () => {
    const { seal } = fakeSeal();
    const { conn, b } = sealedConnection(seal);
    await conn.setLocalDescription(await conn.createOffer());
    await conn.setRemoteDescription({ type: 'answer', sdp: sdpWith('answer', ANSWER_LINE) });
    await tick();
    b.link({ link: 'ended', detail: 'seal_no_authentic_frames' });
    expect(conn.endDetail).toBe(SEAL_ENDED);
    expect(conn.connectionState).toBe('closed');
  });

  it('any other end is not a seal failure', async () => {
    const { seal } = fakeSeal();
    const { conn, b } = sealedConnection(seal);
    await conn.setLocalDescription(await conn.createOffer());
    await conn.setRemoteDescription({ type: 'answer', sdp: sdpWith('answer', ANSWER_LINE) });
    await tick();
    b.link({ link: 'ended', detail: 'the node refused the media socket (403)' });
    expect(conn.endDetail).toBeNull();
  });

  it('closing drops what the host holds for that call', async () => {
    const { seal, calls } = fakeSeal();
    const { conn } = sealedConnection(seal);
    await conn.createOffer();
    conn.close();
    expect(calls).toEqual(['offer', 'cancel']);
  });

  it('the host’s report parses, and the engine says why the call ended', async () => {
    expect(parseLinkMessage({ link: 'sealed', detail: null })).toEqual({ link: 'sealed', detail: null });
    const QUOTE: CallQuote = { offer_msat: 10_000, offer_max_routing_fee_msat: 5_000, signal_msat: 1_000, signal_max_routing_fee_msat: 5_000, call_total_msat: 21_000,
      block_msat: 10_000, block_max_routing_fee_msat: 5_000, reservation_max_msat: 3_600_000, minutes_payable: true };
    const errors: string[] = [];
    let conn: { onconnectionstatechange: (() => void) | null; connectionState: string; endDetail: string | null; localDescription: unknown } | undefined;
    const track = { kind: 'audio', enabled: true, stop: () => {} } as unknown as MediaStreamTrack;
    const media = { getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [], addTrack: () => {}, removeTrack: () => {} } as unknown as MediaStream;
    const deps: CallDeps = {
      routed: true,
      quote: async () => ({ ok: true, value: QUOTE }),
      signal: async (_peer, kind) => ({ ok: true, value: { message_id: 'm', kind, amount_msat: 1, total_msat: 1, max_routing_fee_msat: 0, delivered: true, accepted: true, sent_at_ms: 0 } }),
      getUserMedia: async () => media,
      peerConnection: () => {
        conn = { connectionState: 'new', onconnectionstatechange: null, endDetail: null, localDescription: null };
        return Object.assign(conn, {
          iceGatheringState: 'complete', iceConnectionState: 'new',
          addTrack: () => ({}), createOffer: async () => ({ type: 'offer', sdp: 'x' }), createAnswer: async () => ({ type: 'answer', sdp: 'x' }),
          setLocalDescription: async (d: { sdp: string }) => { conn!.localDescription = d; },
          setRemoteDescription: async () => {}, addIceCandidate: async () => {}, getStats: async () => new Map(), close: () => {}, restartIce: () => {},
          addEventListener: () => {}, removeEventListener: () => {},
        }) as unknown as RTCPeerConnection;
      },
      now: () => 1000,
      onView: (v) => { if (v.error) errors.push(v.error); },
      onStreams: () => {},
      newCallId: () => ID,
    };
    await createCallEngine(deps).place(PEER, 'audio', QUOTE);
    conn!.endDetail = SEAL_ENDED;
    conn!.connectionState = 'closed';
    conn!.onconnectionstatechange?.();
    expect(errors[errors.length - 1]).toBe(tr('caCallSealEnded'));
    expect(errors[errors.length - 1]).toMatch(/Nothing was sent unsealed/);
  });

  it('a refused key exchange gets its own words, not a microphone error', () => {
    expect(mediaError({ name: SEAL_REFUSED }, 'audio')).toBe(tr('caCallSealRefused'));
  });
});

describe('the words', () => {
  const KEYS = ['caCallSealSettingUp', 'caCallSealed', 'caCallNotSealed', 'caCallSealEnded', 'caCallSealRefused'] as const;

  it('claim no check and no review, in either language', () => {
    for (const language of ['en', 'da'] as const) {
      setLanguagePref(language);
      for (const key of KEYS) {
        const text = tr(key).toLowerCase();
        expect(text, key).not.toMatch(/verif|review|audit|checked|proven|private|end-to-end|end to end|guarantee/);
        expect(text, key).not.toMatch(/verific|gennemg|revider|tjekket|bevist|privat|ende-til-ende|garant/);
      }
    }
  });

  it('say what the seal does not cover, in both languages', () => {
    setLanguagePref('en');
    expect(tr('caCallSealed')).toMatch(/unless one of them is attacking the call/);
    expect(tr('caCallSealed')).toMatch(/who is on the other end/);
    expect(tr('caCallSealed')).toMatch(/who called whom, when and for how long/);
    expect(tr('caCallNotSealed')).toMatch(/Both boxes can hear it/);
    setLanguagePref('da');
    expect(tr('caCallSealed')).toMatch(/medmindre en af dem angriber opkaldet/);
    expect(tr('caCallSealed')).toMatch(/hvem der er i den anden ende/);
    expect(tr('caCallNotSealed')).toMatch(/Begge bokse kan høre det/);
  });
});
