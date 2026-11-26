import { describe, expect, it, vi } from 'vitest';
import type { CallAudio, MediaTransport } from '../src/control/callAudio';
import type { MediaBridge, MediaLink } from '../src/control/mediaBridge';
import { frameBytes, isFrameMessage, parseLinkMessage, unavailableMediaBridge } from '../src/control/mediaBridge';
import { createNodeRoutedConnection, isNodeRoutedSdp, nodeRoutedSdp, NODE_ROUTED_MARKER } from '../src/control/nodeRoutedConnection';
import { AudioStatsRecorder, audioStats, micSettings } from '../src/control/callAudioStats';

const ID = '0123456789abcdef0123456789abcdef';
const PEER = 'a'.repeat(64);
/** Let queued microtasks (an already-resolved `ready`) run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeBridge() {
  const sent: Uint8Array[] = [];
  let onFrame: ((frame: Uint8Array) => void) | null = null;
  let onLink: ((link: MediaLink) => void) | null = null;
  const opened: { callId: string; peer: string }[] = [];
  let closed = 0;
  const bridge: MediaBridge = {
    open: async (callId, peer, frame, link) => { opened.push({ callId, peer }); onFrame = frame; onLink = link; },
    send: (payload) => { sent.push(payload); },
    close: async () => { closed++; },
  };
  return { bridge, sent, opened, closed: () => closed, link: (l: MediaLink) => onLink?.(l), frame: (f: Uint8Array) => onFrame?.(f) };
}

type ReadyMode = 'ready' | 'pending' | 'failing';
function fakeAudio(mode: ReadyMode = 'ready') {
  const made: { stream: MediaStream; transport: MediaTransport; fed: Uint8Array[]; muted: boolean[]; closed: boolean; resolve: () => void; reject: () => void; fatal: () => void }[] = [];
  const audio = (stream: MediaStream, transport: MediaTransport, fatal: () => void): CallAudio => {
    let resolve!: () => void;
    let reject!: () => void;
    const ready = new Promise<void>((ok, no) => { resolve = ok; reject = () => no(new Error('no audio graph')); });
    ready.catch(() => undefined);
    const entry = { stream, transport, fed: [] as Uint8Array[], muted: [] as boolean[], closed: false, resolve, reject, fatal };
    made.push(entry);
    if (mode === 'ready') resolve();
    if (mode === 'failing') reject();
    return {
      ready,
      feed: (f) => { entry.fed.push(f); },
      setMuted: (m) => { entry.muted.push(m); },
      codecs: () => ({ sending: 'pcmu', localCaps: 1, peerCaps: null }),
      diagnostics: () => ({ sent: ['mulaw'], received: ['opus'], contextRate: 48_000 }),
      stats: async () => null,
      close: async () => { entry.closed = true; },
    };
  };
  return { audio, made };
}

const stream = () => ({ getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] }) as unknown as MediaStream;

describe('node-routed connection (the engine’s RTCPeerConnection surface)', () => {
  it('gives the audio engine a statistics sink filed under this call id, and the host queue read through the bridge', async () => {
    const b = fakeBridge();
    const queue = { uplinkDropped: 3, downlinkDropped: 1 };
    b.bridge.stats = async () => queue;
    const a = fakeAudio();
    const id = 'fedcba9876543210fedcba9876543210';
    const conn = createNodeRoutedConnection({ callId: () => id, peer: () => PEER, bridge: b.bridge, audio: a.audio });
    conn.addTrack({ kind: 'audio' } as MediaStreamTrack, stream());
    await conn.setLocalDescription(await conn.createOffer());
    await conn.setRemoteDescription({ type: 'answer', sdp: nodeRoutedSdp('answer', id) });
    const transport = a.made[0].transport;
    expect(await transport.queueStats?.()).toEqual(queue);
    const row = new AudioStatsRecorder(0).close(5_000, { codec: 'pcmu', mic: micSettings(null), jitter: null, host: null });
    transport.report?.(row);
    expect(audioStats.rows(id)).toEqual([row]);
    expect(audioStats.rows(ID)).toEqual([]);
  });

  it('describes itself with the marker and never gathers candidates', async () => {
    const sdp = nodeRoutedSdp('offer', ID);
    expect(isNodeRoutedSdp(sdp)).toBe(true);
    expect(sdp).toContain(`a=x-bitsov-call:${ID}`);
    expect(isNodeRoutedSdp('v=0\r\na=ice-ufrag:x')).toBe(false);
    expect(isNodeRoutedSdp(null)).toBe(false);
    expect(sdp.includes(NODE_ROUTED_MARKER)).toBe(true);
    const b = fakeBridge();
    const a = fakeAudio();
    const conn = createNodeRoutedConnection({ callId: () => ID, peer: () => PEER, bridge: b.bridge, audio: a.audio });
    expect(conn.iceGatheringState).toBe('complete');
    expect((await conn.createOffer()).sdp).toContain(NODE_ROUTED_MARKER);
    expect((await conn.createAnswer()).type).toBe('answer');
    await expect(conn.addIceCandidate({ candidate: 'x' })).resolves.toBeUndefined();
    expect((await conn.getStats()).size).toBe(0);
    // No audio engine yet: nothing to report.
    expect((conn as unknown as { audioDiagnostics: () => unknown }).audioDiagnostics()).toBeNull();
  });

  it('caller: opens the node link for the call and its counterparty only after the node-routed answer, goes live when the host says open', async () => {
    const b = fakeBridge();
    const a = fakeAudio();
    const sessions: unknown[] = [];
    const conn = createNodeRoutedConnection({ callId: () => ID, peer: () => PEER, bridge: b.bridge, audio: a.audio, onSession: (e) => sessions.push(e), now: () => 1000 });
    const states: string[] = [];
    conn.onconnectionstatechange = () => states.push(conn.connectionState);
    conn.addTrack({ kind: 'audio' } as MediaStreamTrack, stream());
    await conn.setLocalDescription(await conn.createOffer());
    expect(b.opened).toEqual([]);
    await conn.setRemoteDescription({ type: 'answer', sdp: nodeRoutedSdp('answer', ID) });
    expect(b.opened).toEqual([{ callId: ID, peer: PEER }]);
    expect(states).toEqual(['connecting']);
    await tick();
    b.link({ link: 'connecting', detail: null });
    b.link({ link: 'open', detail: null });
    expect(states).toEqual(['connecting', 'connected']);
    expect(conn.iceConnectionState).toBe('connected');
    expect(sessions).toEqual([{ callId: ID, state: 'open', at: 1000 }]);
    // Downlink frames reach the audio engine; uplink payloads reach the bridge.
    b.frame(Uint8Array.of(0, 0, 0, 1, 1, 0xff));
    expect(a.made[0].fed).toHaveLength(1);
    a.made[0].transport.send(Uint8Array.of(1, 2));
    expect(b.sent).toHaveLength(1);
    // The call report reads the engine's codecs through the connection.
    expect((conn as unknown as { audioDiagnostics: () => unknown }).audioDiagnostics()).toEqual({ sent: ['mulaw'], received: ['opus'], contextRate: 48_000 });
    conn.close();
    expect(a.made[0].closed).toBe(true);
    expect(b.closed()).toBe(1);
    expect(sessions).toHaveLength(2);
    expect(sessions[1]).toMatchObject({ state: 'closed' });
  });

  it('passes the owner’s mute to the audio engine, also when it was set before the engine was built', async () => {
    const b = fakeBridge();
    const a = fakeAudio();
    const conn = createNodeRoutedConnection({ callId: () => ID, peer: () => PEER, bridge: b.bridge, audio: a.audio }) as unknown as { setMuted: (m: boolean) => void } & RTCPeerConnection;
    conn.setMuted(true);
    await conn.setLocalDescription(await conn.createOffer());
    await conn.setRemoteDescription({ type: 'answer', sdp: nodeRoutedSdp('answer', ID) });
    expect(a.made[0].muted).toEqual([true]);
    conn.setMuted(false);
    expect(a.made[0].muted).toEqual([true, false]);
  });

  it('refuses a direct-media answer so the engine ends the call with nothing more paid', async () => {
    const b = fakeBridge();
    const conn = createNodeRoutedConnection({ callId: () => ID, peer: () => PEER, bridge: b.bridge, audio: fakeAudio().audio });
    await conn.setLocalDescription(await conn.createOffer());
    await expect(conn.setRemoteDescription({ type: 'answer', sdp: 'v=0\r\na=ice-ufrag:abc' })).rejects.toMatchObject({ name: 'PeerMediaNotNodeRouted' });
    expect(b.opened).toEqual([]);
  });

  it('callee: takes any offer, answers node-routed, and opens once its answer is set', async () => {
    const b = fakeBridge();
    const conn = createNodeRoutedConnection({ callId: () => ID, peer: () => PEER, bridge: b.bridge, audio: fakeAudio().audio });
    await conn.setRemoteDescription({ type: 'offer', sdp: 'v=0\r\na=ice-ufrag:old-app' });
    expect(b.opened).toEqual([]);
    const answer = await conn.createAnswer();
    expect(isNodeRoutedSdp(answer.sdp)).toBe(true);
    await conn.setLocalDescription(answer);
    expect(b.opened).toEqual([{ callId: ID, peer: PEER }]);
  });

  it('a dropped link rides out the host reconnect, then closes after the grace; a refusal closes at once', async () => {
    vi.useFakeTimers();
    try {
      const b = fakeBridge();
      const conn = createNodeRoutedConnection({ callId: () => ID, peer: () => PEER, bridge: b.bridge, audio: fakeAudio().audio, linkGraceMs: 1000 });
      const states: string[] = [];
      conn.onconnectionstatechange = () => states.push(conn.connectionState);
      await conn.setLocalDescription(await conn.createOffer());
      await conn.setRemoteDescription({ type: 'answer', sdp: nodeRoutedSdp('answer', ID) });
      await vi.advanceTimersByTimeAsync(0);
      b.link({ link: 'open', detail: null });
      b.link({ link: 'closed', detail: 'dropped' });
      expect(conn.connectionState).toBe('connected');
      await vi.advanceTimersByTimeAsync(500);
      b.link({ link: 'open', detail: null });
      await vi.advanceTimersByTimeAsync(2000);
      expect(conn.connectionState).toBe('connected');
      b.link({ link: 'closed', detail: 'dropped' });
      await vi.advanceTimersByTimeAsync(1001);
      expect(conn.connectionState).toBe('closed');

      const c = fakeBridge();
      const refused = createNodeRoutedConnection({ callId: () => ID, peer: () => PEER, bridge: c.bridge, audio: fakeAudio().audio });
      await refused.setLocalDescription(await refused.createOffer());
      await refused.setRemoteDescription({ type: 'answer', sdp: nodeRoutedSdp('answer', ID) });
      c.link({ link: 'ended', detail: 'the node refused the media socket (404)' });
      expect(refused.connectionState).toBe('closed');
    } finally { vi.useRealTimers(); }
  });

  it('without a call id or a counterparty the link fails instead of opening a socket for nothing', async () => {
    for (const deps of [{ callId: () => null, peer: () => PEER }, { callId: () => ID, peer: () => null }]) {
      const b = fakeBridge();
      const conn = createNodeRoutedConnection({ ...deps, bridge: b.bridge, audio: fakeAudio().audio });
      await conn.setLocalDescription(await conn.createOffer());
      await conn.setRemoteDescription({ type: 'answer', sdp: nodeRoutedSdp('answer', null) });
      expect(conn.connectionState).toBe('failed');
      expect(b.opened).toEqual([]);
    }
  });

  it('is connected only once the node link is open AND the audio graph is ready, in either order', async () => {
    const b = fakeBridge();
    const a = fakeAudio('pending');
    const conn = createNodeRoutedConnection({ callId: () => ID, peer: () => PEER, bridge: b.bridge, audio: a.audio });
    await conn.setLocalDescription(await conn.createOffer());
    await conn.setRemoteDescription({ type: 'answer', sdp: nodeRoutedSdp('answer', ID) });
    b.link({ link: 'open', detail: null });
    expect(conn.connectionState).toBe('connecting');
    a.made[0].resolve();
    await tick();
    expect(conn.connectionState).toBe('connected');

    const c = fakeBridge();
    const d = fakeAudio('pending');
    const other = createNodeRoutedConnection({ callId: () => ID, peer: () => PEER, bridge: c.bridge, audio: d.audio });
    await other.setLocalDescription(await other.createOffer());
    await other.setRemoteDescription({ type: 'answer', sdp: nodeRoutedSdp('answer', ID) });
    d.made[0].resolve();
    await tick();
    expect(other.connectionState).toBe('connecting');
    c.link({ link: 'open', detail: null });
    expect(other.connectionState).toBe('connected');
  });

  it('an audio graph that cannot be built closes the socket and ends the call instead of a silent live call', async () => {
    const b = fakeBridge();
    const a = fakeAudio('failing');
    const sessions: unknown[] = [];
    const conn = createNodeRoutedConnection({ callId: () => ID, peer: () => PEER, bridge: b.bridge, audio: a.audio, onSession: (e) => sessions.push(e) });
    const states: string[] = [];
    conn.onconnectionstatechange = () => states.push(conn.connectionState);
    await conn.setLocalDescription(await conn.createOffer());
    await conn.setRemoteDescription({ type: 'answer', sdp: nodeRoutedSdp('answer', ID) });
    await tick();
    expect(states).toEqual(['connecting', 'closed']);
    expect(a.made[0].closed).toBe(true);
    expect(b.closed()).toBe(1);
    // A late link open changes nothing: the call is over.
    b.link({ link: 'open', detail: null });
    expect(conn.connectionState).toBe('closed');
    expect(sessions).toEqual([]);
  });
});

describe('fatal audio errors after connect', () => {
  it('end the live call: audio engine and socket closed, no silent connected state', async () => {
    const b = fakeBridge();
    const a = fakeAudio();
    const sessions: unknown[] = [];
    const conn = createNodeRoutedConnection({ callId: () => ID, peer: () => PEER, bridge: b.bridge, audio: a.audio, onSession: (e) => sessions.push(e) });
    const states: string[] = [];
    conn.onconnectionstatechange = () => states.push(conn.connectionState);
    await conn.setLocalDescription(await conn.createOffer());
    await conn.setRemoteDescription({ type: 'answer', sdp: nodeRoutedSdp('answer', ID) });
    await tick();
    b.link({ link: 'open', detail: null });
    expect(conn.connectionState).toBe('connected');
    a.made[0].fatal();
    expect(states).toEqual(['connecting', 'connected', 'closed']);
    expect(a.made[0].closed).toBe(true);
    expect(b.closed()).toBe(1);
    // Frames and a reopened link after the failure change nothing.
    b.frame(Uint8Array.of(0, 0, 0, 1, 1, 0xff));
    expect(a.made[0].fed).toHaveLength(0);
    b.link({ link: 'open', detail: null });
    expect(conn.connectionState).toBe('closed');
    a.made[0].fatal();
    expect(b.closed()).toBe(1);
  });
});

describe('the media session ends once, for every way it ends', () => {
  async function live(sessions: { state: string }[], opts: { linkGraceMs?: number } = {}) {
    const b = fakeBridge();
    const a = fakeAudio();
    const conn = createNodeRoutedConnection({ callId: () => ID, peer: () => PEER, bridge: b.bridge, audio: a.audio, onSession: (e) => sessions.push(e), ...opts });
    await conn.setLocalDescription(await conn.createOffer());
    await conn.setRemoteDescription({ type: 'answer', sdp: nodeRoutedSdp('answer', ID) });
    // The audio graph's `ready` settles on the microtask queue (real or fake timers alike).
    for (let i = 0; i < 5; i++) await Promise.resolve();
    b.link({ link: 'open', detail: null });
    expect(conn.connectionState).toBe('connected');
    return { b, a, conn };
  }

  it('fatal audio closes the session (so the call’s minutes stop), once, before the engine closes it', async () => {
    const sessions: { state: string; callId?: string }[] = [];
    const { a, conn } = await live(sessions);
    a.made[0].fatal();
    expect(sessions).toEqual([{ callId: ID, state: 'open', at: expect.any(Number) }, { callId: ID, state: 'closed', at: expect.any(Number) }]);
    a.made[0].fatal();
    conn.close();
    expect(sessions.map((e) => e.state)).toEqual(['open', 'closed']);
  });

  it('the node ending the link, or the reconnect grace running out, closes it once too', async () => {
    const ended: { state: string }[] = [];
    const first = await live(ended);
    first.b.link({ link: 'ended', detail: 'the node closed the media session' });
    first.conn.close();
    expect(ended.map((e) => e.state)).toEqual(['open', 'closed']);
    vi.useFakeTimers();
    try {
      const lapsed: { state: string }[] = [];
      const second = await live(lapsed, { linkGraceMs: 1000 });
      second.b.link({ link: 'closed', detail: 'dropped' });
      expect(lapsed.map((e) => e.state)).toEqual(['open']);
      await vi.advanceTimersByTimeAsync(1001);
      second.conn.close();
      expect(lapsed.map((e) => e.state)).toEqual(['open', 'closed']);
    } finally { vi.useRealTimers(); }
  });

  it('a session that never opened reports nothing when it ends', async () => {
    const sessions: unknown[] = [];
    const b = fakeBridge();
    const a = fakeAudio();
    const conn = createNodeRoutedConnection({ callId: () => ID, peer: () => PEER, bridge: b.bridge, audio: a.audio, onSession: (e) => sessions.push(e) });
    await conn.setLocalDescription(await conn.createOffer());
    await conn.setRemoteDescription({ type: 'answer', sdp: nodeRoutedSdp('answer', ID) });
    await tick();
    a.made[0].fatal();
    conn.close();
    expect(sessions).toEqual([]);
  });
});

describe('media bridge helpers', () => {
  it('parses link messages as the host sends them (parsed JSON objects), JSON text, and byte frames', () => {
    // Tauri hands an `InvokeResponseBody::Json` channel payload to the page already parsed.
    expect(parseLinkMessage({ link: 'open', detail: null })).toEqual({ link: 'open', detail: null });
    expect(parseLinkMessage({ link: 'ended', detail: 'the node refused the media socket (403)' })).toEqual({ link: 'ended', detail: 'the node refused the media socket (403)' });
    expect(parseLinkMessage({ link: 'closed' })).toEqual({ link: 'closed', detail: null });
    expect(parseLinkMessage({ link: 'weird', detail: null })).toBeNull();
    expect(parseLinkMessage({ detail: 'x' })).toBeNull();
    expect(parseLinkMessage('{"link":"open","detail":null}')).toEqual({ link: 'open', detail: null });
    expect(parseLinkMessage('not json')).toBeNull();
    expect(parseLinkMessage(null)).toBeNull();
    expect(parseLinkMessage([1, 2])).toBeNull();
    expect(isFrameMessage([1, 2, 3])).toBe(true);
    expect(isFrameMessage(Uint8Array.of(4).buffer)).toBe(true);
    expect(isFrameMessage(Uint8Array.of(5))).toBe(true);
    expect(isFrameMessage({ link: 'open' })).toBe(false);
    expect(isFrameMessage('text')).toBe(false);
    expect([...frameBytes([1, 2, 3])]).toEqual([1, 2, 3]);
    expect([...frameBytes(Uint8Array.of(4).buffer)]).toEqual([4]);
    expect([...frameBytes(Uint8Array.of(5))]).toEqual([5]);
  });

  it('the no-host bridge ends the link at once', async () => {
    const links: MediaLink[] = [];
    await unavailableMediaBridge().open(ID, PEER, () => {}, (l) => links.push(l));
    expect(links.map((l) => l.link)).toEqual(['ended']);
  });
});
