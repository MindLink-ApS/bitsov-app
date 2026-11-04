/**
 * The video engine over fake WebCodecs: nothing is sent until the peer says it
 * takes video, frames fragment and reassemble end to end, key frame requests
 * recover from loss, backpressure steps down, and no failure reaches the call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFrame } from '../src/control/mediaFrame';
import { createCallVideo, chooseVideoCodec, KEY_MIN_INTERVAL_MS, type CallVideo, type VideoSource } from '../src/control/callVideo';
import {
  CODEC_H264, CODEC_VP8, MAX_FRAGMENT_DATA, VIDEO_FRAGMENT, VIDEO_HELLO, VIDEO_KEY_REQUEST, VIDEO_REPORT, VIDEO_STATE,
  encodeInner, helloBody, parseFragment, parseInner, parseHello, parseState, reportBody, stateBody,
} from '../src/control/videoFrame';
import { DEPTH_HIGH } from '../src/control/videoRate';

type Encoded = { type: 'key' | 'delta'; timestamp: number; data: Uint8Array };

class FakeFrame {
  closed = false;
  displayWidth = 320;
  displayHeight = 240;
  constructor(public timestamp: number) {}
  close() { this.closed = true; }
}

const world = {
  encoders: [] as FakeEncoder[],
  decoders: [] as FakeDecoder[],
  encodeSize: 800,
  supported: new Set(['avc1.42E01F', 'vp8']),
  encodeThrows: false,
};

class FakeEncoder {
  state = 'unconfigured';
  encodeQueueSize = 0;
  config: VideoEncoderConfig | null = null;
  keys: boolean[] = [];
  constructor(public init: { output: (chunk: unknown) => void; error: (e: unknown) => void }) { world.encoders.push(this); }
  static async isConfigSupported(config: VideoEncoderConfig) { return { supported: world.supported.has(config.codec), config }; }
  configure(config: VideoEncoderConfig) { this.config = config; this.state = 'configured'; }
  encode(frame: FakeFrame, options?: { keyFrame?: boolean }) {
    if (world.encodeThrows) throw new Error('encoder broke');
    const key = options?.keyFrame === true;
    this.keys.push(key);
    const data = new Uint8Array(key ? world.encodeSize * 4 : world.encodeSize).fill(key ? 0xaa : 0xbb);
    this.init.output({ type: key ? 'key' : 'delta', timestamp: frame.timestamp, byteLength: data.length, copyTo: (out: Uint8Array) => out.set(data) });
  }
  close() { this.state = 'closed'; }
}

class FakeDecoder {
  state = 'unconfigured';
  decodeQueueSize = 0;
  config: VideoDecoderConfig | null = null;
  chunks: Encoded[] = [];
  constructor(public init: { output: (frame: unknown) => void; error: (e: unknown) => void }) { world.decoders.push(this); }
  static async isConfigSupported(config: VideoDecoderConfig) { return { supported: world.supported.has(config.codec), config }; }
  configure(config: VideoDecoderConfig) { this.config = config; this.state = 'configured'; }
  decode(chunk: Encoded) {
    this.chunks.push(chunk);
    this.init.output(new FakeFrame(chunk.timestamp));
  }
  close() { this.state = 'closed'; }
}

class FakeChunk {
  type: string; timestamp: number; data: Uint8Array;
  constructor(init: { type: string; timestamp: number; data: Uint8Array }) { this.type = init.type; this.timestamp = init.timestamp; this.data = init.data; }
}

function source(): VideoSource & { grabs: number; closed: boolean } {
  const s = {
    grabs: 0,
    closed: false,
    grab: (_step: unknown, timestamp: number) => { s.grabs++; return new FakeFrame(timestamp) as unknown as VideoFrame; },
    close: () => { s.closed = true; },
  };
  return s;
}

function canvas() {
  const drawn: unknown[] = [];
  return { drawn, canvas: { width: 0, height: 0, getContext: () => ({ drawImage: (frame: unknown) => drawn.push(frame) }) } as unknown as HTMLCanvasElement };
}

function start(overrides: { depth?: () => number; src?: VideoSource | null } = {}) {
  const sent: Uint8Array[] = [];
  const c = canvas();
  const statuses: unknown[] = [];
  const src = overrides.src === undefined ? source() : overrides.src;
  const video = createCallVideo({
    transport: { send: (payload) => { sent.push(payload); return overrides.depth?.() ?? 0; } },
    source: src,
    canvas: c.canvas,
    now: () => Date.now(),
    onStatus: (s) => statuses.push(s),
  });
  return { video, sent, drawn: c.drawn, statuses, src: src as ReturnType<typeof source> };
}

const kinds = (sent: Uint8Array[]) => sent.map((p) => p[0]);
const ofType = (sent: Uint8Array[], type: number) => sent.filter((p) => p[0] === type);
const frameOf = (payload: Uint8Array, seq = 0) => encodeFrame(seq, payload);
const peerHello = (decodes = CODEC_H264 | CODEC_VP8, tier = 0) => frameOf(encodeInner(VIDEO_HELLO, 0, helloBody({ decodes, tier })));

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
  world.encoders = [];
  world.decoders = [];
  world.encodeSize = 800;
  world.supported = new Set(['avc1.42E01F', 'vp8']);
  world.encodeThrows = false;
  vi.stubGlobal('VideoEncoder', FakeEncoder);
  vi.stubGlobal('VideoDecoder', FakeDecoder);
  vi.stubGlobal('VideoFrame', FakeFrame);
  vi.stubGlobal('EncodedVideoChunk', FakeChunk);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const live: CallVideo[] = [];
afterEach(() => { for (const v of live.splice(0)) v.close(); });
async function ready(overrides: Parameters<typeof start>[0] = {}) {
  const t = start(overrides);
  live.push(t.video);
  await vi.advanceTimersByTimeAsync(0);
  await t.video.ready;
  return t;
}

describe('negotiation', () => {
  it('sends only its hello until the peer answers, and captures nothing', async () => {
    const t = await ready();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(new Set(kinds(t.sent))).toEqual(new Set([VIDEO_HELLO]));
    expect(t.sent.length).toBeGreaterThanOrEqual(3);
    expect(t.src.grabs).toBe(0);
    expect(world.encoders.length).toBe(0);
    expect(parseHello(parseInner(t.sent[0])!.body)).toEqual({ decodes: CODEC_H264 | CODEC_VP8, tier: 0 });
  });

  it('starts with a key frame once the peer says it decodes, and stops repeating its hello', async () => {
    const t = await ready();
    t.video.feed(peerHello());
    await vi.advanceTimersByTimeAsync(200);
    expect(world.encoders[0].config).toMatchObject({ codec: 'avc1.42E01F', width: 320, height: 240, framerate: 15, bitrate: 280_000, latencyMode: 'realtime', avc: { format: 'annexb' } });
    expect(world.encoders[0].keys[0]).toBe(true);
    expect(world.encoders[0].keys[1]).toBe(false);
    const fragments = ofType(t.sent, VIDEO_FRAGMENT);
    expect(fragments.length).toBeGreaterThan(0);
    const first = parseFragment(parseInner(fragments[0])!.body)!;
    expect(first).toMatchObject({ frameId: 0, index: 0, key: true, codec: CODEC_H264 });
    const hellos = ofType(t.sent, VIDEO_HELLO).length;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(ofType(t.sent, VIDEO_HELLO).length).toBe(hellos);
  });

  it('a peer that decodes nothing gets no video', async () => {
    const t = await ready();
    t.video.feed(peerHello(0));
    await vi.advanceTimersByTimeAsync(500);
    expect(ofType(t.sent, VIDEO_FRAGMENT).length).toBe(0);
    expect(t.video.status().peerVideo).toBe(false);
  });

  it('takes VP8 when the far side has only that, and each direction chooses for itself', async () => {
    expect(chooseVideoCodec(CODEC_H264 | CODEC_VP8, CODEC_VP8)).toBe(CODEC_VP8);
    expect(chooseVideoCodec(CODEC_H264 | CODEC_VP8, CODEC_H264 | CODEC_VP8)).toBe(CODEC_H264);
    expect(chooseVideoCodec(CODEC_H264, CODEC_VP8)).toBeNull();
    const t = await ready();
    t.video.feed(peerHello(CODEC_VP8));
    await vi.advanceTimersByTimeAsync(200);
    expect(world.encoders[0].config?.codec).toBe('vp8');
    expect(world.encoders[0].config?.avc).toBeUndefined();
  });

  it('uses the lower tier of the two sides, whichever learned first', async () => {
    const HIGH = { messages: 160, bytes: 262_144 };
    // My node allows it; theirs does not.
    const t = await ready();
    t.video.setNodeLimits(HIGH);
    t.video.feed(peerHello(CODEC_H264, 0));
    await vi.advanceTimersByTimeAsync(200);
    expect(world.encoders[0].config).toMatchObject({ width: 320, height: 240 });
    // Theirs does; mine does not.
    const u = await ready();
    u.video.setNodeLimits({ messages: 100, bytes: 65_536 });
    u.video.feed(peerHello(CODEC_H264, 1));
    await vi.advanceTimersByTimeAsync(200);
    expect(world.encoders[1].config).toMatchObject({ width: 320, height: 240 });
    // Both do, my handshake after their hello: the picture steps up at once, and they hear it.
    const both = await ready();
    both.video.feed(peerHello(CODEC_H264, 1));
    await vi.advanceTimersByTimeAsync(200);
    expect(world.encoders[2].config).toMatchObject({ width: 320, height: 240 });
    both.sent.length = 0;
    both.video.setNodeLimits(HIGH);
    expect(world.encoders[2].config).toMatchObject({ width: 640, height: 360, framerate: 30, bitrate: 1_200_000 });
    expect(parseHello(parseInner(ofType(both.sent, VIDEO_HELLO)[0])!.body)?.tier).toBe(1);
    // Saying the same again changes nothing.
    both.sent.length = 0;
    both.video.setNodeLimits(HIGH);
    expect(ofType(both.sent, VIDEO_HELLO).length).toBe(0);
  });

  it('no WebCodecs: says so, sends no video, and does not throw', async () => {
    vi.stubGlobal('VideoEncoder', undefined);
    const t = await ready();
    expect(t.video.status().failed).toBe(true);
    t.video.feed(peerHello());
    await vi.advanceTimersByTimeAsync(500);
    expect(ofType(t.sent, VIDEO_FRAGMENT).length).toBe(0);
  });
});

describe('end to end through the wire format', () => {
  const pair = async () => {
    const a = await ready();
    const b = await ready();
    const pump = (from: { sent: Uint8Array[] }, to: CallVideo, drop?: (payload: Uint8Array) => boolean) => {
      for (const payload of from.sent.splice(0)) if (!drop?.(payload)) to.feed(frameOf(payload));
    };
    pump(a, b.video);
    pump(b, a.video);
    return { a, b, pump };
  };

  it('a frame larger than one fragment arrives whole and is drawn', async () => {
    const { a, b, pump } = await pair();
    world.encodeSize = MAX_FRAGMENT_DATA * 2;
    await vi.advanceTimersByTimeAsync(140);
    expect(ofType(a.sent, VIDEO_FRAGMENT).length).toBeGreaterThan(2);
    pump(a, b.video);
    await vi.advanceTimersByTimeAsync(0);
    const decoder = world.decoders[world.decoders.length - 1];
    expect(decoder.config).toMatchObject({ codec: 'avc1.42E01F', optimizeForLatency: true });
    expect(decoder.chunks[0].type).toBe('key');
    expect(decoder.chunks[0].data.length).toBe(MAX_FRAGMENT_DATA * 2 * 4);
    expect(b.drawn.length).toBeGreaterThan(0);
    expect(b.video.stats().rendered).toBe(b.drawn.length);
  });

  it('a lost frame freezes the picture until a requested key frame, which comes within the limit', async () => {
    const { a, b, pump } = await pair();
    await vi.advanceTimersByTimeAsync(140);
    pump(a, b.video);
    const before = b.video.stats().decoded;
    expect(before).toBeGreaterThan(0);
    // Next frame vanishes; the ones after it arrive.
    await vi.advanceTimersByTimeAsync(70);
    a.sent.splice(0);
    await vi.advanceTimersByTimeAsync(140);
    pump(a, b.video);
    const stuck = b.video.stats().decoded;
    await vi.advanceTimersByTimeAsync(300);
    expect(b.video.stats().reassembly.lost).toBe(1);
    expect(b.video.stats().reassembly.waitingForKey).toBe(true);
    expect(ofType(b.sent, VIDEO_KEY_REQUEST).length).toBeGreaterThan(0);
    pump(b, a.video);
    a.sent.splice(0);
    expect(a.video.stats().keyRequestsReceived).toBeGreaterThan(0);
    expect(b.video.stats().decoded).toBe(stuck);
    await vi.advanceTimersByTimeAsync(KEY_MIN_INTERVAL_MS);
    pump(a, b.video);
    await vi.advanceTimersByTimeAsync(0);
    expect(b.video.stats().reassembly.waitingForKey).toBe(false);
    expect(b.video.stats().decoded).toBeGreaterThan(stuck);
  });

  it('key frame requests are answered at most once a second, however many come', async () => {
    const { a, b } = await pair();
    await vi.advanceTimersByTimeAsync(1_100);
    const request = frameOf(encodeInner(VIDEO_KEY_REQUEST, 1, new Uint8Array(0)));
    // The second encoder is the one this side made: the peer answered first.
    const encoder = world.encoders[1];
    for (let i = 0; i < 30; i++) {
      a.video.feed(request);
      await vi.advanceTimersByTimeAsync(100);
    }
    const keys = encoder.keys.filter(Boolean).length;
    expect(keys).toBeLessThanOrEqual(5);
    expect(keys).toBeGreaterThanOrEqual(3);
    expect(b.video.stats().decodeErrors).toBe(0);
  });

  it('junk on the wire costs nothing', async () => {
    const { a } = await pair();
    for (const junk of [new Uint8Array(0), Uint8Array.of(1, 2, 3), frameOf(Uint8Array.of(VIDEO_FRAGMENT)), frameOf(encodeInner(VIDEO_FRAGMENT, 1, new Uint8Array(3))), frameOf(encodeInner(VIDEO_REPORT, 1, new Uint8Array(1))), frameOf(encodeInner(VIDEO_STATE, 1, new Uint8Array(0)))]) {
      expect(() => a.video.feed(junk)).not.toThrow();
    }
  });
});

describe('when video cannot keep up', () => {
  it('skips frames at once when the host queue backs up, and steps down only if it lasts', async () => {
    let depth = 0;
    const t = await ready({ depth: () => depth });
    t.video.feed(peerHello());
    await vi.advanceTimersByTimeAsync(200);
    expect(world.encoders[0].config?.framerate).toBe(15);
    // One key frame's worth: frames are skipped, the ladder stays.
    depth = DEPTH_HIGH + 1;
    await vi.advanceTimersByTimeAsync(70);
    expect(t.video.stats().skipped).toBe(0);
    await vi.advanceTimersByTimeAsync(140);
    expect(t.video.stats().skipped).toBeGreaterThan(0);
    depth = 0;
    await vi.advanceTimersByTimeAsync(1_100);
    expect(world.encoders[0].config?.framerate).toBe(15);
    const clean = t.video.stats().stepChanges;
    expect(clean).toBe(0);
    // It lasts: the host keeps answering full.
    depth = DEPTH_HIGH + 4;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(world.encoders[0].config?.framerate).toBeLessThan(15);
    expect(t.video.stats().stepChanges).toBeGreaterThan(0);
    // Far from sending at the old rate meanwhile.
    expect(t.video.stats().skipped).toBeGreaterThan(5);
  });

  it('tells the card when the other side never answers, and a late answer still turns video on', async () => {
    const t = await ready();
    await vi.advanceTimersByTimeAsync(4_500);
    expect(t.video.status().peerVideo).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.video.status().peerVideo).toBe(false);
    t.video.feed(peerHello());
    expect(t.video.status().peerVideo).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(ofType(t.sent, VIDEO_FRAGMENT).length).toBeGreaterThan(0);
  });

  it('two bad reports step down, reconfigures with a key frame, and a clean run climbs back', async () => {
    const t = await ready();
    t.video.feed(peerHello());
    await vi.advanceTimersByTimeAsync(200);
    const report = (complete: number, lost: number) => frameOf(encodeInner(VIDEO_REPORT, 1, reportBody({ complete, lost, waitingForKey: lost > 0 })));
    t.video.feed(report(10, 2));
    expect(world.encoders[0].config?.framerate).toBe(15);
    t.video.feed(report(10, 2));
    expect(world.encoders[0].config).toMatchObject({ framerate: 10, bitrate: 180_000 });
    const keysBefore = world.encoders[0].keys.filter(Boolean).length;
    await vi.advanceTimersByTimeAsync(1_200);
    expect(world.encoders[0].keys.filter(Boolean).length).toBe(keysBefore + 1);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(world.encoders[0].config?.framerate).toBe(15);
  });

  it('below the lowest step it pauses capture, tells the peer, and resumes later', async () => {
    const t = await ready();
    t.video.feed(peerHello());
    await vi.advanceTimersByTimeAsync(200);
    const bad = frameOf(encodeInner(VIDEO_REPORT, 1, reportBody({ complete: 5, lost: 5, waitingForKey: true })));
    for (let i = 0; i < 6; i++) t.video.feed(bad);
    expect(t.video.status().sendingPaused).toBe(true);
    const lastState = ofType(t.sent, VIDEO_STATE).pop()!;
    expect(parseState(parseInner(lastState)!.body)).toEqual({ camera: true, paused: true });
    const grabs = t.src.grabs;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.src.grabs).toBe(grabs);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.video.status().sendingPaused).toBe(false);
    expect(t.src.grabs).toBeGreaterThan(grabs);
  });

  it('skips a frame while the encoder is behind instead of queueing it', async () => {
    const t = await ready();
    t.video.feed(peerHello());
    await vi.advanceTimersByTimeAsync(200);
    world.encoders[0].encodeQueueSize = 3;
    const grabs = t.src.grabs;
    await vi.advanceTimersByTimeAsync(200);
    expect(t.src.grabs).toBe(grabs);
    expect(t.video.stats().skipped).toBeGreaterThan(0);
  });
});

describe('camera on and off', () => {
  it('off stops capture and tells the peer; on starts again with a key frame', async () => {
    const t = await ready();
    t.video.feed(peerHello());
    await vi.advanceTimersByTimeAsync(200);
    const first = t.src;
    t.video.setSource(null);
    expect(first.closed).toBe(true);
    expect(parseState(parseInner(ofType(t.sent, VIDEO_STATE).pop()!)!.body)).toMatchObject({ camera: false });
    const fragments = ofType(t.sent, VIDEO_FRAGMENT).length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ofType(t.sent, VIDEO_FRAGMENT).length).toBe(fragments);
    const keys = world.encoders[0].keys.filter(Boolean).length;
    const again = source();
    t.video.setSource(again);
    await vi.advanceTimersByTimeAsync(200);
    expect(again.grabs).toBeGreaterThan(0);
    expect(world.encoders[0].keys.filter(Boolean).length).toBe(keys + 1);
    expect(parseState(parseInner(ofType(t.sent, VIDEO_STATE).pop()!)!.body)).toMatchObject({ camera: true });
  });

  it('shows the peer camera state', async () => {
    const t = await ready();
    t.video.feed(frameOf(encodeInner(VIDEO_STATE, 1, stateBody({ camera: false, paused: false }))));
    expect(t.video.status().peerCamera).toBe(false);
    expect(t.statuses.length).toBeGreaterThan(0);
  });

  it('a call with no camera still receives and draws', async () => {
    const t = await ready({ src: null });
    t.video.feed(peerHello());
    await vi.advanceTimersByTimeAsync(200);
    expect(world.encoders.length).toBe(0);
    expect(ofType(t.sent, VIDEO_FRAGMENT).length).toBe(0);
    const fragment = encodeInner(VIDEO_FRAGMENT, 0, parseInner(makeKeyFragment())!.body);
    t.video.feed(frameOf(fragment));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.drawn.length).toBe(1);
  });
});

function makeKeyFragment() {
  const body = new Uint8Array(14 + 3);
  const view = new DataView(body.buffer);
  view.setUint32(0, 5);
  view.setUint16(4, 0);
  view.setUint16(6, 1);
  body[8] = 1;
  body[9] = CODEC_H264;
  view.setUint32(10, 123);
  return encodeInner(VIDEO_FRAGMENT, 0, body);
}

describe('lining up with the audio', () => {
  it('holds each picture for the audio delay, draws every one in order, whatever the frame rate', async () => {
    const drawn: { captureMs: number; at: number }[] = [];
    const c = canvas();
    const video = createCallVideo({ transport: { send: () => 0 }, source: null, canvas: c.canvas, now: () => Date.now(), audioDelayMs: () => 70, onRender: (_f, captureMs, at) => drawn.push({ captureMs, at }) });
    live.push(video);
    await vi.advanceTimersByTimeAsync(0);
    await video.ready;
    video.feed(peerHello());
    // 30 frames a second is faster than the hold: a held picture must not lose its turn to the next.
    const start = Date.now();
    for (let id = 0; id < 30; id++) {
      const capture = Date.now() % 0x1_0000_0000;
      video.feed(frameOf(fragmentFor(id, id === 0, capture)));
      await vi.advanceTimersByTimeAsync(33);
    }
    await vi.advanceTimersByTimeAsync(200);
    expect(drawn.length).toBe(30);
    expect(drawn[1].at - start).toBeGreaterThanOrEqual(33 + 70);
    for (let i = 1; i < drawn.length; i++) expect(drawn[i].captureMs).toBeGreaterThan(drawn[i - 1].captureMs);
    for (const d of drawn) expect(d.at % 0x1_0000_0000 - d.captureMs).toBeLessThanOrEqual(71);
  });

  it('draws at once with no audio delay, and only the newest of pictures that are all due', async () => {
    const t = await ready({ src: null });
    t.video.feed(peerHello());
    t.video.feed(frameOf(fragmentFor(0, true, Date.now() % 0x1_0000_0000)));
    t.video.feed(frameOf(fragmentFor(1, false, Date.now() % 0x1_0000_0000)));
    expect(t.video.stats().rendered).toBe(2);
    expect(t.video.stats().decoded).toBe(2);
  });
});

function fragmentFor(frameId: number, key: boolean, captureMs: number) {
  const body = new Uint8Array(14 + 3);
  const view = new DataView(body.buffer);
  view.setUint32(0, frameId);
  view.setUint16(6, 1);
  body[8] = key ? 1 : 0;
  body[9] = CODEC_H264;
  view.setUint32(10, captureMs);
  return encodeInner(VIDEO_FRAGMENT, frameId, body);
}

describe('failure never reaches the call', () => {
  it('an encoder that throws or errors stops video and reports it, nothing else', async () => {
    const t = await ready();
    t.video.feed(peerHello());
    await vi.advanceTimersByTimeAsync(200);
    world.encodeThrows = true;
    await vi.advanceTimersByTimeAsync(200);
    expect(t.video.status().failed).toBe(true);
    const fragments = ofType(t.sent, VIDEO_FRAGMENT).length;
    await vi.advanceTimersByTimeAsync(500);
    expect(ofType(t.sent, VIDEO_FRAGMENT).length).toBe(fragments);
    // Receiving still works.
    t.video.feed(frameOf(makeKeyFragment()));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.drawn.length).toBe(1);
  });

  it('a decoder error asks for a key frame and starts again', async () => {
    const t = await ready();
    t.video.feed(peerHello());
    t.video.feed(frameOf(makeKeyFragment()));
    await vi.advanceTimersByTimeAsync(0);
    const before = ofType(t.sent, VIDEO_KEY_REQUEST).length;
    world.decoders[0].init.error(new Error('decoder broke'));
    expect(t.video.stats().decodeErrors).toBe(1);
    expect(ofType(t.sent, VIDEO_KEY_REQUEST).length).toBe(before + 1);
    expect(t.video.stats().reassembly.waitingForKey).toBe(true);
  });

  it('a transport that throws costs nothing', async () => {
    const src = source();
    const v = createCallVideo({ transport: { send: () => { throw new Error('no session'); } }, source: src, canvas: canvas().canvas, now: () => Date.now() });
    live.push(v);
    await vi.advanceTimersByTimeAsync(1_500);
    await v.ready;
    expect(() => v.feed(peerHello())).not.toThrow();
  });

  it('close stops everything and frees the decoded picture', async () => {
    const t = await ready();
    t.video.feed(peerHello());
    await vi.advanceTimersByTimeAsync(200);
    t.video.close();
    const count = t.sent.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.sent.length).toBe(count);
    expect(t.src.closed).toBe(true);
    expect(world.encoders[0].state).toBe('closed');
  });
});
