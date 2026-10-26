import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCallAudio, OPUS_FALLBACK_FRAMES, OPUS_REHELLO_FRAMES } from '../src/control/callAudio';
import type { MediaBridge, MediaLink } from '../src/control/mediaBridge';
import { CAP_OPUS, CAP_PCMU, PAYLOAD_HELLO, PAYLOAD_OPUS, PAYLOAD_PCMU, audioPayload, encodeFrame, helloPayload } from '../src/control/mediaFrame';
import { createNodeRoutedConnection, nodeRoutedSdp } from '../src/control/nodeRoutedConnection';

/** Mid-call audio failures: Opus falls back to mu-law where it can, and the call ends where it cannot. */

class FakeNode {
  port = { postMessage: vi.fn(), onmessage: null as ((event: { data: unknown }) => void) | null };
  gain = { value: 1 };
  onprocessorerror: (() => void) | null = null;
  connect<T>(next: T) { return next; }
  disconnect() {}
}
class FakeWorkletNode extends FakeNode {
  static made: { name: string; node: FakeWorkletNode }[] = [];
  constructor(_ctx: unknown, name: string) { super(); FakeWorkletNode.made.push({ name, node: this }); }
}
const worklet = (name: string) => [...FakeWorkletNode.made].reverse().find((m) => m.name === name)!.node;
class FakeContext {
  sampleRate = 48_000;
  currentTime = 0;
  destination = new FakeNode();
  audioWorklet = { addModule: async () => {} };
  async resume() {}
  async close() {}
  createMediaStreamSource() { return new FakeNode(); }
  createGain() { return new FakeNode(); }
}

type CodecState = 'unconfigured' | 'configured' | 'closed';
class FakeEncoder {
  static made: FakeEncoder[] = [];
  static isConfigSupported = async () => ({ supported: true });
  state: CodecState = 'unconfigured';
  encoded = 0;
  throwOnEncode = false;
  constructor(readonly init: { output: (chunk: { byteLength: number; copyTo: (b: Uint8Array) => void }) => void; error: (e: Error) => void }) { FakeEncoder.made.push(this); }
  configure() { this.state = 'configured'; }
  encode() {
    if (this.throwOnEncode) throw new Error('encode failed');
    this.encoded++;
    this.init.output({ byteLength: 3, copyTo: (b) => b.set([9, 9, 9]) });
  }
  close() { this.state = 'closed'; }
  /** What WebCodecs does on an internal error: close, then report. */
  crash() { this.state = 'closed'; this.init.error(new Error('EncodingError')); }
}
class FakeDecoder {
  static made: FakeDecoder[] = [];
  static isConfigSupported = async () => ({ supported: true });
  state: CodecState = 'unconfigured';
  decoded = 0;
  throwOnDecode = false;
  constructor(readonly init: { output: (audio: unknown) => void; error: (e: Error) => void }) { FakeDecoder.made.push(this); }
  configure() { this.state = 'configured'; }
  decode() {
    if (this.throwOnDecode) throw new Error('decode failed');
    this.decoded++;
  }
  close() { this.state = 'closed'; }
  crash() { this.state = 'closed'; this.init.error(new Error('DecodingError')); }
}
class FakeAudioData { constructor(_init: unknown) {} close() {} }
class FakeChunk { constructor(_init: unknown) {} }

const stream = () => ({ getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] }) as unknown as MediaStream;
const capture = () => worklet('bitsov-call-capture');
const playout = () => worklet('bitsov-call-playout');
/** One 20 ms capture frame from the worklet. */
const speak = () => capture().port.onmessage?.({ data: { type: 'frame', pcm: new Float32Array(960) } });
const frame = (seq: number, payload: Uint8Array) => encodeFrame(seq, payload);
const opusFrame = (seq: number) => frame(seq, audioPayload('opus', Uint8Array.of(1, 2, 3)));
const pcmuFrame = (seq: number) => frame(seq, audioPayload('pcmu', new Uint8Array(160).fill(0xff)));
const hellos = (sent: Uint8Array[]) => sent.filter((p) => p[0] === PAYLOAD_HELLO).map((p) => p[1]);
const playedFrames = () => playout().port.postMessage.mock.calls.filter(([m]) => (m as { type: string }).type === 'frame').length;

beforeEach(() => {
  FakeWorkletNode.made = [];
  FakeEncoder.made = [];
  FakeDecoder.made = [];
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
  vi.stubGlobal('AudioEncoder', FakeEncoder);
  vi.stubGlobal('AudioDecoder', FakeDecoder);
  vi.stubGlobal('AudioData', FakeAudioData);
  vi.stubGlobal('EncodedAudioChunk', FakeChunk);
});
afterEach(() => { vi.unstubAllGlobals(); });

/** An engine whose HELLO exchange is done: both sides offer Opus, so both send Opus. */
async function opusCall() {
  const sent: Uint8Array[] = [];
  const errors: string[] = [];
  const audio = createCallAudio({
    stream: stream(),
    transport: { send: (p) => { sent.push(p); } },
    audioContext: () => new FakeContext() as unknown as AudioContext,
    workletUrl: 'worklet.js',
    onError: (m) => errors.push(m),
  });
  await audio.ready;
  expect(hellos(sent)).toEqual([CAP_PCMU | CAP_OPUS]);
  audio.feed(frame(0, helloPayload(CAP_PCMU | CAP_OPUS)));
  speak();
  expect(audio.codecs().sending).toBe('opus');
  expect(sent[sent.length - 1][0]).toBe(PAYLOAD_OPUS);
  return { audio, sent, errors, encoder: FakeEncoder.made[FakeEncoder.made.length - 1], decoder: FakeDecoder.made[FakeDecoder.made.length - 1] };
}

describe('call audio: Opus failing mid-call', () => {
  it('a decoder error withdraws Opus with a fresh HELLO and plays the peer’s mu-law that follows', async () => {
    const { audio, sent, errors, decoder } = await opusCall();
    audio.feed(opusFrame(1));
    expect(decoder.decoded).toBe(1);
    decoder.crash();
    // The peer learns at once that we no longer decode Opus.
    expect(hellos(sent)).toEqual([CAP_PCMU | CAP_OPUS, CAP_PCMU | CAP_OPUS, CAP_PCMU]);
    expect(audio.codecs().localCaps).toBe(CAP_PCMU);
    // Opus already in flight is a gap marker, not a crash.
    audio.feed(opusFrame(2));
    // The peer re-chooses per frame: mu-law from here on, and it plays.
    const before = playedFrames();
    audio.feed(pcmuFrame(3));
    expect(playedFrames()).toBe(before + 1);
    // We stop sending Opus too: both sides are on mu-law.
    speak();
    expect(sent[sent.length - 1][0]).toBe(PAYLOAD_PCMU);
    expect(errors).toEqual([]);
  });

  it('a decoder that throws on decode falls back the same way', async () => {
    const { audio, sent, errors, decoder } = await opusCall();
    decoder.throwOnDecode = true;
    audio.feed(opusFrame(1));
    expect(hellos(sent).slice(-1)).toEqual([CAP_PCMU]);
    expect(audio.codecs().localCaps).toBe(CAP_PCMU);
    expect(errors).toEqual([]);
  });

  it('when the peer keeps sending Opus anyway, the HELLO is repeated and then the engine reports a fatal error once', async () => {
    const { audio, sent, errors, decoder } = await opusCall();
    decoder.crash();
    const after = hellos(sent).length;
    for (let seq = 1; seq < OPUS_FALLBACK_FRAMES; seq++) audio.feed(opusFrame(seq));
    expect(errors).toEqual([]);
    expect(hellos(sent).length - after).toBe(Math.floor((OPUS_FALLBACK_FRAMES - 1) / OPUS_REHELLO_FRAMES));
    audio.feed(opusFrame(OPUS_FALLBACK_FRAMES));
    audio.feed(opusFrame(OPUS_FALLBACK_FRAMES + 1));
    expect(errors).toEqual(['peer_kept_sending_opus']);
  });

  it('an encoder error sends mu-law from the next frame; an encoder that throws loses no frame', async () => {
    const { audio, sent, errors, encoder } = await opusCall();
    encoder.crash();
    speak();
    expect(sent[sent.length - 1][0]).toBe(PAYLOAD_PCMU);
    expect(audio.codecs().sending).toBe('pcmu');

    const second = await opusCall();
    second.encoder.throwOnEncode = true;
    const count = second.sent.length;
    speak();
    // The frame that failed to encode still went out, as mu-law.
    expect(second.sent.length).toBe(count + 1);
    expect(second.sent[second.sent.length - 1][0]).toBe(PAYLOAD_PCMU);
    expect(errors).toEqual([]);
    expect(second.errors).toEqual([]);
  });

  it('a crashed playout or capture worklet is fatal', async () => {
    for (const node of [playout, capture]) {
      const { errors } = await opusCall();
      node().onprocessorerror?.();
      node().onprocessorerror?.();
      expect(errors).toHaveLength(1);
    }
  });
});

describe('the call with the real audio engine: no silent live call', () => {
  const ID = '0123456789abcdef0123456789abcdef';
  const PEER = 'a'.repeat(64);

  function bridge() {
    let onFrame: ((frame: Uint8Array) => void) | null = null;
    let onLink: ((link: MediaLink) => void) | null = null;
    let closed = 0;
    const b: MediaBridge = {
      open: async (_c, _p, f, l) => { onFrame = f; onLink = l; },
      send: () => {},
      close: async () => { closed++; },
    };
    return { b, frame: (f: Uint8Array) => onFrame?.(f), link: (l: MediaLink) => onLink?.(l), closed: () => closed };
  }

  async function liveCall(onClose: () => void = () => {}) {
    const br = bridge();
    const sessions: string[] = [];
    const conn = createNodeRoutedConnection({
      callId: () => ID,
      peer: () => PEER,
      bridge: br.b,
      audio: (s, transport, onFatal) => createCallAudio({ stream: s, transport, audioContext: () => Object.assign(new FakeContext(), { close: async () => onClose() }) as unknown as AudioContext, workletUrl: 'w.js', onError: onFatal }),
      onSession: (e) => sessions.push(e.state),
    });
    const states: string[] = [];
    conn.onconnectionstatechange = () => states.push(conn.connectionState);
    await conn.setLocalDescription(await conn.createOffer());
    await conn.setRemoteDescription({ type: 'answer', sdp: nodeRoutedSdp('answer', ID) });
    br.link({ link: 'open', detail: null });
    await vi.waitFor(() => expect(conn.connectionState).toBe('connected'));
    br.frame(frame(0, helloPayload(CAP_PCMU | CAP_OPUS)));
    return { conn, br, states, sessions };
  }

  it('a decoder error the peer never honours ends the connected call and closes the socket and the audio graph', async () => {
    let audioClosed = false;
    const { conn, br, states, sessions } = await liveCall(() => { audioClosed = true; });
    FakeDecoder.made[0].crash();
    for (let seq = 1; seq <= OPUS_FALLBACK_FRAMES; seq++) br.frame(opusFrame(seq));
    expect(states).toEqual(['connecting', 'connected', 'closed']);
    expect(br.closed()).toBe(1);
    await vi.waitFor(() => expect(audioClosed).toBe(true));
    // The engine closes the connection on `closed`; the media session is reported over.
    conn.close();
    expect(sessions).toEqual(['open', 'closed']);
  });

  it('a decoder error the peer honours keeps the call live on mu-law', async () => {
    const { conn, br, states } = await liveCall();
    FakeDecoder.made[0].crash();
    br.frame(opusFrame(1));
    for (let seq = 2; seq < 2 + OPUS_FALLBACK_FRAMES; seq++) br.frame(pcmuFrame(seq));
    expect(states).toEqual(['connecting', 'connected']);
    expect(conn.connectionState).toBe('connected');
    conn.close();
  });

  it('a crashed worklet mid-call ends the call', async () => {
    const { br, states } = await liveCall();
    playout().onprocessorerror?.();
    expect(states).toEqual(['connecting', 'connected', 'closed']);
    expect(br.closed()).toBe(1);
  });
});
