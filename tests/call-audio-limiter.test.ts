// The call audio limiter: nothing past -1 dBFS reaches the speakers or the
// encoder, and audio below that passes bit for bit.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCallAudio } from '../src/control/callAudio';
import {
  CAPTURE_PROCESSOR,
  LIMIT_CEILING,
  PLAYOUT_PROCESSOR,
  PeakLimiter,
  type CaptureMessage,
  type PlayoutMessage,
  type PlayoutReport,
} from '../src/control/callAudioShared';
import { decodeMuLaw } from '../src/control/g711';
import { parsePayload } from '../src/control/mediaFrame';

const RATE = 48_000;
const QUANTUM = 128;
const TONE = 437.3;
const tone = (amplitude: number, from: number, length: number) =>
  Float32Array.from({ length }, (_, i) => amplitude * Math.sin((2 * Math.PI * TONE * (from + i)) / RATE));
const peak = (pcm: Float32Array) => pcm.reduce((max, v) => Math.max(max, Math.abs(v)), 0);

type Port<In, Out> = { onmessage: ((event: { data: In }) => void) | null; postMessage: (message: Out, transfer?: Transferable[]) => void };
type Processor<In, Out> = { port: Port<In, Out>; process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean };
let PlayoutProcessor: new () => Processor<PlayoutMessage, PlayoutReport>;

class FakeNode {
  port: { postMessage: (message: PlayoutMessage) => void; onmessage: ((event: { data: CaptureMessage }) => void) | null } = { postMessage: () => {}, onmessage: null };
  gain = { value: 1 };
  onprocessorerror: (() => void) | null = null;
  connect<T>(next: T) { return next; }
  disconnect() {}
}
const made: { name: string; node: FakeNode }[] = [];
class FakeWorkletNode extends FakeNode {
  constructor(_ctx: unknown, name: string) { super(); made.push({ name, node: this }); }
}

beforeAll(async () => {
  const registered = new Map<string, new () => unknown>();
  vi.stubGlobal('sampleRate', RATE);
  vi.stubGlobal('AudioWorkletProcessor', class { port = { onmessage: null, postMessage() {} }; });
  vi.stubGlobal('registerProcessor', (name: string, processor: new () => unknown) => registered.set(name, processor));
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
  await import('../src/control/callAudioWorklet');
  PlayoutProcessor = registered.get(PLAYOUT_PROCESSOR) as new () => Processor<PlayoutMessage, PlayoutReport>;
});
afterAll(() => vi.unstubAllGlobals());

describe('the peak limiter', () => {
  it('leaves audio below -1 dBFS bit for bit as it was', () => {
    const input = tone(0.5, 0, RATE);
    const output = new PeakLimiter(RATE).process(Float32Array.from(input));
    expect(output).toEqual(input);
  });

  it('brings a tone past full scale down to the ceiling as a tone, not a clipped one', () => {
    const limiter = new PeakLimiter(RATE);
    const input = tone(1.4, 0, RATE);
    const output = limiter.process(Float32Array.from(input));
    expect(peak(output)).toBeLessThanOrEqual(LIMIT_CEILING + 1e-6);
    // After the first cycle the shape is the input's, scaled: no flat tops, no edges.
    const gain = LIMIT_CEILING / 1.4;
    for (let i = RATE / 100; i < input.length; i++) expect(Math.abs(output[i] - input[i] * gain)).toBeLessThan(0.01);
    // Once it is quiet again the level comes back within about half a second.
    const quiet = limiter.process(tone(0.3, RATE, RATE));
    const settled = quiet.subarray(RATE / 2);
    const reference = tone(0.3, RATE + RATE / 2, RATE / 2);
    expect(peak(settled) / peak(reference)).toBeGreaterThan(0.99);
  });

  it('turns a sample that is not a finite number into silence', () => {
    expect([...new PeakLimiter(RATE).process(new Float32Array([0.2, Number.NaN, Number.POSITIVE_INFINITY, -0.2]))]).toEqual([expect.closeTo(0.2, 6), 0, 0, expect.closeTo(-0.2, 6)]);
  });
});

/** Plays `frames` 20 ms frames of a tone through the real playout worklet; returns the output. */
function playout(amplitude: number, frames: number) {
  const processor = new PlayoutProcessor();
  const out: number[] = [];
  const quantum = new Float32Array(QUANTUM);
  let fed = 0;
  for (let k = 0; k < frames * 960; k += QUANTUM) {
    while (fed * 960 <= k + 960 && fed < frames) {
      processor.port.onmessage!({ data: { type: 'frame', seq: fed, pcm: tone(amplitude, fed * 960, 960) } });
      fed++;
    }
    processor.process([], [[quantum]]);
    out.push(...quantum);
  }
  return Float32Array.from(out);
}

describe('playout', () => {
  it('sends nothing past -1 dBFS to the speakers', () => {
    expect(peak(playout(1.4, 100))).toBeLessThanOrEqual(LIMIT_CEILING + 1e-6);
  });

  it('plays a normal level as it came', () => {
    const level = peak(playout(0.5, 100));
    expect(level).toBeGreaterThan(0.49);
    expect(level).toBeLessThanOrEqual(0.5);
  });
});

describe('capture', () => {
  it('limits a microphone past full scale before it is encoded', async () => {
    const sent: Uint8Array[] = [];
    const audio = createCallAudio({
      stream: { getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] } as unknown as MediaStream,
      transport: { send: (payload) => sent.push(payload) },
      audioContext: () => ({
        sampleRate: RATE, currentTime: 0, destination: new FakeNode(), audioWorklet: { addModule: async () => {} },
        resume: async () => {}, close: async () => {}, createMediaStreamSource: () => new FakeNode(), createGain: () => new FakeNode(),
      }) as unknown as AudioContext,
      workletUrl: 'worklet.js',
      opus: false,
    });
    await audio.ready;
    const capture = [...made].reverse().find((m) => m.name === CAPTURE_PROCESSOR)!.node;
    for (let f = 0; f < 50; f++) capture.port.onmessage!({ data: { type: 'frame', pcm: tone(1.4, f * 960, 960) } });
    const decoded = sent.map((p) => parsePayload(p)).filter((p) => p?.type === 'audio' && p.codec === 'pcmu').map((p) => decodeMuLaw((p as { data: Uint8Array }).data));
    expect(decoded.length).toBeGreaterThan(40);
    // Past the first frame (the limiter's first cycle), nothing reaches full scale:
    // mu-law's own clipping is never used.
    for (const pcm of decoded.slice(1)) expect(peak(pcm)).toBeLessThan(0.95);
    await audio.close();
  });
});
