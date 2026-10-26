import { describe, expect, it, vi } from 'vitest';
import type { CallAudio, MediaTransport } from '../src/control/callAudio';
import type { MediaBridge, MediaLink } from '../src/control/mediaBridge';
import { frameBytes, parseLinkMessage, unavailableMediaBridge } from '../src/control/mediaBridge';
import { createNodeRoutedConnection, isNodeRoutedSdp, nodeRoutedSdp, NODE_ROUTED_MARKER } from '../src/control/nodeRoutedConnection';

const ID = '0123456789abcdef0123456789abcdef';

function fakeBridge() {
  const sent: Uint8Array[] = [];
  let onFrame: ((frame: Uint8Array) => void) | null = null;
  let onLink: ((link: MediaLink) => void) | null = null;
  const opened: string[] = [];
  let closed = 0;
  const bridge: MediaBridge = {
    open: async (callId, frame, link) => { opened.push(callId); onFrame = frame; onLink = link; },
    send: (payload) => { sent.push(payload); },
    close: async () => { closed++; },
  };
  return { bridge, sent, opened, closed: () => closed, link: (l: MediaLink) => onLink?.(l), frame: (f: Uint8Array) => onFrame?.(f) };
}

function fakeAudio() {
  const made: { stream: MediaStream; transport: MediaTransport; fed: Uint8Array[]; closed: boolean }[] = [];
  const audio = (stream: MediaStream, transport: MediaTransport): CallAudio => {
    const entry = { stream, transport, fed: [] as Uint8Array[], closed: false };
    made.push(entry);
    return {
      ready: Promise.resolve(),
      feed: (f) => { entry.fed.push(f); },
      setMuted: () => {},
      codecs: () => ({ sending: 'pcmu', localCaps: 1, peerCaps: null }),
      stats: async () => null,
      close: async () => { entry.closed = true; },
    };
  };
  return { audio, made };
}

const stream = () => ({ getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] }) as unknown as MediaStream;

describe('node-routed connection (the engine’s RTCPeerConnection surface)', () => {
  it('describes itself with the marker and never gathers candidates', async () => {
    const sdp = nodeRoutedSdp('offer', ID);
    expect(isNodeRoutedSdp(sdp)).toBe(true);
    expect(sdp).toContain(`a=x-bitsov-call:${ID}`);
    expect(isNodeRoutedSdp('v=0\r\na=ice-ufrag:x')).toBe(false);
    expect(isNodeRoutedSdp(null)).toBe(false);
    expect(sdp.includes(NODE_ROUTED_MARKER)).toBe(true);
    const b = fakeBridge();
    const a = fakeAudio();
    const conn = createNodeRoutedConnection({ callId: () => ID, bridge: b.bridge, audio: a.audio });
    expect(conn.iceGatheringState).toBe('complete');
    expect((await conn.createOffer()).sdp).toContain(NODE_ROUTED_MARKER);
    expect((await conn.createAnswer()).type).toBe('answer');
    await expect(conn.addIceCandidate({ candidate: 'x' })).resolves.toBeUndefined();
    expect((await conn.getStats()).size).toBe(0);
  });

  it('caller: opens the node link only after the node-routed answer, goes live when the host says open', async () => {
    const b = fakeBridge();
    const a = fakeAudio();
    const sessions: unknown[] = [];
    const conn = createNodeRoutedConnection({ callId: () => ID, bridge: b.bridge, audio: a.audio, onSession: (e) => sessions.push(e), now: () => 1000 });
    const states: string[] = [];
    conn.onconnectionstatechange = () => states.push(conn.connectionState);
    conn.addTrack({ kind: 'audio' } as MediaStreamTrack, stream());
    await conn.setLocalDescription(await conn.createOffer());
    expect(b.opened).toEqual([]);
    await conn.setRemoteDescription({ type: 'answer', sdp: nodeRoutedSdp('answer', ID) });
    expect(b.opened).toEqual([ID]);
    expect(states).toEqual(['connecting']);
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
    conn.close();
    expect(a.made[0].closed).toBe(true);
    expect(b.closed()).toBe(1);
    expect(sessions).toHaveLength(2);
    expect(sessions[1]).toMatchObject({ state: 'closed' });
  });

  it('refuses a direct-media answer so the engine ends the call with nothing more paid', async () => {
    const b = fakeBridge();
    const conn = createNodeRoutedConnection({ callId: () => ID, bridge: b.bridge, audio: fakeAudio().audio });
    await conn.setLocalDescription(await conn.createOffer());
    await expect(conn.setRemoteDescription({ type: 'answer', sdp: 'v=0\r\na=ice-ufrag:abc' })).rejects.toMatchObject({ name: 'PeerMediaNotNodeRouted' });
    expect(b.opened).toEqual([]);
  });

  it('callee: takes any offer, answers node-routed, and opens once its answer is set', async () => {
    const b = fakeBridge();
    const conn = createNodeRoutedConnection({ callId: () => ID, bridge: b.bridge, audio: fakeAudio().audio });
    await conn.setRemoteDescription({ type: 'offer', sdp: 'v=0\r\na=ice-ufrag:old-app' });
    expect(b.opened).toEqual([]);
    const answer = await conn.createAnswer();
    expect(isNodeRoutedSdp(answer.sdp)).toBe(true);
    await conn.setLocalDescription(answer);
    expect(b.opened).toEqual([ID]);
  });

  it('a dropped link rides out the host reconnect, then closes after the grace; a refusal closes at once', async () => {
    vi.useFakeTimers();
    try {
      const b = fakeBridge();
      const conn = createNodeRoutedConnection({ callId: () => ID, bridge: b.bridge, audio: fakeAudio().audio, linkGraceMs: 1000 });
      const states: string[] = [];
      conn.onconnectionstatechange = () => states.push(conn.connectionState);
      await conn.setLocalDescription(await conn.createOffer());
      await conn.setRemoteDescription({ type: 'answer', sdp: nodeRoutedSdp('answer', ID) });
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
      const refused = createNodeRoutedConnection({ callId: () => ID, bridge: c.bridge, audio: fakeAudio().audio });
      await refused.setLocalDescription(await refused.createOffer());
      await refused.setRemoteDescription({ type: 'answer', sdp: nodeRoutedSdp('answer', ID) });
      c.link({ link: 'ended', detail: 'the node refused the media socket (404)' });
      expect(refused.connectionState).toBe('closed');
    } finally { vi.useRealTimers(); }
  });

  it('without a call id the link fails instead of opening a socket for nothing', async () => {
    const b = fakeBridge();
    const conn = createNodeRoutedConnection({ callId: () => null, bridge: b.bridge, audio: fakeAudio().audio });
    await conn.setLocalDescription(await conn.createOffer());
    await conn.setRemoteDescription({ type: 'answer', sdp: nodeRoutedSdp('answer', null) });
    expect(conn.connectionState).toBe('failed');
    expect(b.opened).toEqual([]);
  });
});

describe('media bridge helpers', () => {
  it('parses link messages and byte arrays from the host channel', () => {
    expect(parseLinkMessage('{"link":"open","detail":null}')).toEqual({ link: 'open', detail: null });
    expect(parseLinkMessage('{"link":"ended","detail":"refused"}')).toEqual({ link: 'ended', detail: 'refused' });
    expect(parseLinkMessage('{"link":"weird"}')).toBeNull();
    expect(parseLinkMessage('not json')).toBeNull();
    expect([...frameBytes([1, 2, 3])]).toEqual([1, 2, 3]);
    expect([...frameBytes(Uint8Array.of(4).buffer)]).toEqual([4]);
    expect([...frameBytes(Uint8Array.of(5))]).toEqual([5]);
  });

  it('the no-host bridge ends the link at once', async () => {
    const links: MediaLink[] = [];
    await unavailableMediaBridge().open(ID, () => {}, (l) => links.push(l));
    expect(links.map((l) => l.link)).toEqual(['ended']);
  });
});
