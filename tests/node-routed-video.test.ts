/**
 * The connection with video in the build: a video call opens the video path and
 * sorts frames to the right engine; an audio call, on a build with or without
 * video, stays an audio call in every byte and every host call.
 */
import { describe, expect, it, vi } from 'vitest';
import type { CallAudio, MediaTransport } from '../src/control/callAudio';
import type { CallVideo, VideoTransport } from '../src/control/callVideo';
import { parseLinkMessage, type MediaBridge, type MediaLink } from '../src/control/mediaBridge';
import { createNodeRoutedConnection } from '../src/control/nodeRoutedConnection';
import { encodeFrame } from '../src/control/mediaFrame';
import { encodeInner, helloBody, VIDEO_HELLO } from '../src/control/videoFrame';

const ID = '0123456789abcdef0123456789abcdef';
const PEER = 'a'.repeat(64);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function bridge() {
  const opens: unknown[][] = [];
  const sent: Uint8Array[] = [];
  const sentVideo: Uint8Array[] = [];
  let frame: ((f: Uint8Array) => void) | null = null;
  let link: ((l: MediaLink) => void) | null = null;
  let closed = 0;
  const b: MediaBridge = {
    open: async (...args) => { opens.push(args); frame = args[2]; link = args[3]; },
    send: (p) => { sent.push(p); },
    sendVideo: async (p) => { sentVideo.push(p); return 2; },
    close: async () => { closed++; },
  };
  return { b, opens, sent, sentVideo, frame: (f: Uint8Array) => frame?.(f), link: (l: MediaLink) => link?.(l), closed: () => closed };
}

function audioEngine() {
  const fed: Uint8Array[] = [];
  const made: { transport: MediaTransport; closed: boolean }[] = [];
  const audio = (_s: MediaStream, transport: MediaTransport): CallAudio => {
    const entry = { transport, closed: false };
    made.push(entry);
    return { ready: Promise.resolve(), feed: (f) => { fed.push(f); }, setMuted: () => {}, codecs: () => ({ sending: 'pcmu', localCaps: 1, peerCaps: null }), stats: async () => null, close: async () => { entry.closed = true; } };
  };
  return { audio, fed, made };
}

function videoEngine() {
  const fed: Uint8Array[] = [];
  const state = { closed: false, resets: 0, limits: [] as unknown[], transport: null as VideoTransport | null, tracks: [] as (MediaStreamTrack | null)[] };
  const engine = { ready: Promise.resolve(), feed: (f: Uint8Array) => { fed.push(f); }, setSource: () => {}, linkReset: () => { state.resets++; }, setNodeLimits: (limits: unknown) => { state.limits.push(limits); }, stats: () => ({}), status: () => ({}), close: () => { state.closed = true; } } as unknown as CallVideo;
  return {
    fed, state, engine,
    deps: {
      build: (transport: VideoTransport, track: MediaStreamTrack | null) => { state.transport = transport; state.tracks.push(track); return engine; },
      camera: (_e: CallVideo, track: MediaStreamTrack | null) => { state.tracks.push(track); },
    },
  };
}

async function connect(deps: { b: MediaBridge; audio: ReturnType<typeof audioEngine>['audio']; video?: ReturnType<typeof videoEngine>['deps'] | { build: () => null; camera: () => void } }) {
  const conn = createNodeRoutedConnection({ callId: () => ID, peer: () => PEER, bridge: deps.b, audio: deps.audio, video: deps.video as never }) as unknown as {
    addTrack: (t: MediaStreamTrack, s: MediaStream) => { replaceTrack: (t: MediaStreamTrack | null) => Promise<void> };
    createOffer: () => Promise<RTCSessionDescriptionInit>;
    setLocalDescription: (d: RTCSessionDescriptionInit) => Promise<void>;
    setRemoteDescription: (d: RTCSessionDescriptionInit) => Promise<void>;
    close: () => void;
    connectionState: string;
  };
  return conn;
}

const stream = { getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] } as unknown as MediaStream;
const audioTrack = { kind: 'audio' } as MediaStreamTrack;
const cameraTrack = { kind: 'video' } as MediaStreamTrack;
const opusFrame = encodeFrame(3, Uint8Array.of(0x02, 1, 2, 3));
const videoFrame = encodeFrame(9, encodeInner(VIDEO_HELLO, 0, helloBody({ decodes: 1, tier: 0 })));

async function negotiate(conn: Awaited<ReturnType<typeof connect>>) {
  await conn.setLocalDescription(await conn.createOffer());
  await conn.setRemoteDescription({ type: 'answer', sdp: 'v=0\r\na=x-bitsov-media:node-routed-v1\r\n' });
  await tick();
}

describe('the link message', () => {
  it('carries the node limits when they are whole, and is the same as ever without them', () => {
    expect(parseLinkMessage({ link: 'open', detail: null })).toEqual({ link: 'open', detail: null });
    expect(parseLinkMessage({ link: 'open', detail: null, limits: { messages: 160, bytes: 262144 } })).toEqual({ link: 'open', detail: null, limits: { messages: 160, bytes: 262144 } });
    expect(parseLinkMessage({ link: 'open', detail: null, limits: { messages: '160', bytes: 1 } })).toEqual({ link: 'open', detail: null });
    expect(parseLinkMessage({ link: 'open', detail: null, limits: { bytes: 1 } })).toEqual({ link: 'open', detail: null });
  });
});

describe('a build without the video path', () => {
  it('opens the socket with the same four arguments and feeds every frame to audio', async () => {
    const b = bridge();
    const a = audioEngine();
    const conn = await connect({ b: b.b, audio: a.audio });
    conn.addTrack(audioTrack, stream);
    // A camera track, if any, stays the inert sender it has always been.
    await conn.addTrack(cameraTrack, stream).replaceTrack(null);
    await negotiate(conn);
    expect(b.opens.length).toBe(1);
    expect(b.opens[0].length).toBe(4);
    expect(b.opens[0].slice(0, 2)).toEqual([ID, PEER]);
    b.frame(opusFrame);
    b.frame(videoFrame);
    expect(a.fed).toEqual([opusFrame, videoFrame]);
    expect(b.sentVideo).toEqual([]);
    a.made[0].transport.send(Uint8Array.of(0x02, 9));
    expect(b.sent).toEqual([Uint8Array.of(0x02, 9)]);
  });
});

describe('an audio call on a build that has video', () => {
  it('is the same as above when the engine declines: no video path, no video frames', async () => {
    const b = bridge();
    const a = audioEngine();
    const conn = await connect({ b: b.b, audio: a.audio, video: { build: () => null, camera: () => {} } });
    conn.addTrack(audioTrack, stream);
    await negotiate(conn);
    expect(b.opens[0].length).toBe(4);
    b.frame(opusFrame);
    expect(a.fed).toEqual([opusFrame]);
    expect(b.sentVideo).toEqual([]);
  });
});

describe('a video call', () => {
  it('opens the video path, sorts frames by type, and reaches the host on its own command', async () => {
    const b = bridge();
    const a = audioEngine();
    const v = videoEngine();
    const conn = await connect({ b: b.b, audio: a.audio, video: v.deps });
    conn.addTrack(audioTrack, stream);
    conn.addTrack(cameraTrack, stream);
    await negotiate(conn);
    expect(b.opens[0][4]).toBe(true);
    expect(v.state.tracks).toEqual([cameraTrack]);
    b.frame(opusFrame);
    b.frame(videoFrame);
    expect(a.fed).toEqual([opusFrame]);
    expect(v.fed).toEqual([videoFrame]);
    await v.state.transport?.send(Uint8Array.of(0x20, 1));
    expect(b.sentVideo).toEqual([Uint8Array.of(0x20, 1)]);
    expect(b.sent).toEqual([]);
  });

  it('the node limits from the link reach the video engine, and an open without them is left alone', async () => {
    const b = bridge();
    const a = audioEngine();
    const v = videoEngine();
    const conn = await connect({ b: b.b, audio: a.audio, video: v.deps });
    conn.addTrack(audioTrack, stream);
    await negotiate(conn);
    b.link({ link: 'open', detail: null });
    expect(v.state.limits).toEqual([]);
    b.link({ link: 'open', detail: null, limits: { messages: 160, bytes: 262144 } });
    expect(v.state.limits).toEqual([{ messages: 160, bytes: 262144 }]);
  });

  it('camera off and on through the engine sender reach the video engine', async () => {
    const b = bridge();
    const a = audioEngine();
    const v = videoEngine();
    const conn = await connect({ b: b.b, audio: a.audio, video: v.deps });
    conn.addTrack(audioTrack, stream);
    const sender = conn.addTrack(cameraTrack, stream);
    await negotiate(conn);
    await sender.replaceTrack(null);
    const fresh = { kind: 'video' } as MediaStreamTrack;
    await sender.replaceTrack(fresh);
    expect(v.state.tracks).toEqual([cameraTrack, null, fresh]);
  });

  it('a dropped link resets reassembly, and close ends the video engine with the audio', async () => {
    const b = bridge();
    const a = audioEngine();
    const v = videoEngine();
    const conn = await connect({ b: b.b, audio: a.audio, video: v.deps });
    conn.addTrack(audioTrack, stream);
    conn.addTrack(cameraTrack, stream);
    await negotiate(conn);
    b.link({ link: 'open', detail: null });
    await tick();
    b.link({ link: 'closed', detail: null });
    expect(v.state.resets).toBe(1);
    conn.close();
    expect(v.state.closed).toBe(true);
    expect(a.made[0].closed).toBe(true);
    expect(b.closed()).toBe(1);
    // After close nothing reaches either engine.
    const fedBefore = v.fed.length;
    b.frame(videoFrame);
    expect(v.fed.length).toBe(fedBefore);
  });

  it('a bridge with no video command falls back to an audio call', async () => {
    const b = bridge();
    const a = audioEngine();
    const v = videoEngine();
    delete b.b.sendVideo;
    const build = vi.spyOn(v.deps, 'build');
    const conn = await connect({ b: b.b, audio: a.audio, video: v.deps });
    conn.addTrack(audioTrack, stream);
    await negotiate(conn);
    expect(build).not.toHaveBeenCalled();
    expect(b.opens[0].length).toBe(4);
  });
});
