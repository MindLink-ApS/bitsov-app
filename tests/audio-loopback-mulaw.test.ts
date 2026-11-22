// Mu-law call audio, end to end in one process: the real capture worklet
// cuts a steady tone into frames, the real call audio engine (Opus off, as
// on a webview without WebCodecs) resamples and mu-law encodes them, a
// second engine decodes and resamples them back, and the real playout
// worklet plays them. Delivery is ideal, so any click is the codec path's own.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCallAudio, type CallAudio } from '../src/control/callAudio';
import {
  CAPTURE_PROCESSOR,
  PLAYOUT_PROCESSOR,
  type CaptureMessage,
  type PlayoutMessage,
  type PlayoutReport,
} from '../src/control/callAudioShared';
import { CAP_PCMU, PAYLOAD_PCMU, encodeFrame, helloPayload } from '../src/control/mediaFrame';

const QUANTUM = 128;
const AMPLITUDE = 0.5;
// Not a multiple of 50 Hz: a step at a frame edge cannot hide in phase.
const TONE = 437.3;

type Port<In, Out> = { onmessage: ((event: { data: In }) => void) | null; postMessage: (message: Out, transfer?: Transferable[]) => void };
type Processor<In, Out> = { port: Port<In, Out>; process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean };
type Capture = Processor<never, CaptureMessage>;
type Playout = Processor<PlayoutMessage, PlayoutReport>;

let CaptureProcessor: new () => Capture;
let PlayoutProcessor: new () => Playout;

beforeAll(async () => {
  const registered = new Map<string, new () => unknown>();
  vi.stubGlobal('sampleRate', 48_000);
  vi.stubGlobal('AudioWorkletProcessor', class { port = { onmessage: null, postMessage() {} }; });
  vi.stubGlobal('registerProcessor', (name: string, processor: new () => unknown) => registered.set(name, processor));
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
  await import('../src/control/callAudioWorklet');
  CaptureProcessor = registered.get(CAPTURE_PROCESSOR) as new () => Capture;
  PlayoutProcessor = registered.get(PLAYOUT_PROCESSOR) as new () => Playout;
});
afterAll(() => vi.unstubAllGlobals());

/** Graph nodes for the engine: only the worklet ports matter here. */
class FakeNode {
  port: { postMessage: (message: PlayoutMessage) => void; onmessage: ((event: { data: CaptureMessage }) => void) | null } = { postMessage: () => {}, onmessage: null };
  gain = { value: 1 };
  onprocessorerror: (() => void) | null = null;
  connect<T>(next: T) { return next; }
  disconnect() {}
}
let made: { name: string; node: FakeNode }[] = [];
class FakeWorkletNode extends FakeNode {
  constructor(_ctx: unknown, name: string) { super(); made.push({ name, node: this }); }
}
const contextAt = (rate: number) => () => ({
  sampleRate: rate,
  currentTime: 0,
  destination: new FakeNode(),
  audioWorklet: { addModule: async () => {} },
  resume: async () => {},
  close: async () => {},
  createMediaStreamSource: () => new FakeNode(),
  createGain: () => new FakeNode(),
}) as unknown as AudioContext;
const stream = () => ({ getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] }) as unknown as MediaStream;

beforeEach(() => { made = []; });

/** An engine with Opus off and its two worklet nodes. */
async function engine(rate: number, send: (payload: Uint8Array) => void) {
  const before = made.length;
  const audio: CallAudio = createCallAudio({ stream: stream(), transport: { send }, audioContext: contextAt(rate), workletUrl: 'worklet.js', opus: false });
  await audio.ready;
  const nodes = made.slice(before);
  return { audio, capture: nodes.find((m) => m.name === CAPTURE_PROCESSOR)!.node, playout: nodes.find((m) => m.name === PLAYOUT_PROCESSOR)!.node };
}

/** Clicks per minute (steps over three times the clean tone's largest) and the output level. */
async function muLawLoop(rate: number, seconds: number) {
  vi.stubGlobal('sampleRate', rate);
  const capture = new CaptureProcessor();
  const playout = new PlayoutProcessor();
  // Sender: its HELLO goes nowhere; audio frames are numbered as the host would.
  let seq = 0;
  const wire: Uint8Array[] = [];
  const sender = await engine(rate, (payload) => { if (payload[0] === PAYLOAD_PCMU) wire.push(encodeFrame(seq++, payload)); });
  // The receiver's HELLO is answered, so the sender stops repeating its own.
  sender.audio.feed(encodeFrame(0, helloPayload(CAP_PCMU)));
  const receiver = await engine(rate, () => {});
  receiver.playout.port.postMessage = (message) => playout.port.onmessage!({ data: message });
  capture.port.postMessage = (message) => sender.capture.port.onmessage!({ data: message });

  const clean = (AMPLITUDE * 2 * Math.PI * TONE) / rate;
  const output = new Float32Array(QUANTUM);
  const total = seconds * rate;
  let previous = 0;
  let clicks = 0;
  let lastClick = -Infinity;
  let energy = 0;
  let counted = 0;
  for (let k = 0; k < total; k += QUANTUM) {
    const input = Float32Array.from({ length: QUANTUM }, (_, i) => AMPLITUDE * Math.sin((2 * Math.PI * TONE * (k + i)) / rate));
    capture.process([[input]], [[new Float32Array(QUANTUM)]]);
    for (const frame of wire.splice(0)) receiver.audio.feed(frame);
    playout.process([], [[output]]);
    // The jitter buffer fills for the first 100 ms; judge the steady state.
    if (k < rate / 5) { previous = output[QUANTUM - 1]; continue; }
    for (let i = 0; i < QUANTUM; i++) {
      // Steps closer than 5 ms count as one click.
      if (Math.abs(output[i] - previous) > 3 * clean) { if (k + i - lastClick > rate * 0.005) clicks++; lastClick = k + i; }
      previous = output[i];
      energy += output[i] * output[i];
      counted++;
    }
  }
  // What the call report will say: mu-law each way, at the context's rate.
  expect(sender.audio.diagnostics?.()).toEqual({ sent: ['mulaw'], received: [], contextRate: rate });
  expect(receiver.audio.diagnostics?.()).toEqual({ sent: [], received: ['mulaw'], contextRate: rate });
  await sender.audio.close();
  await receiver.audio.close();
  return { clicksPerMin: clicks / (seconds / 60), level: Math.sqrt(energy / counted) / (AMPLITUDE / Math.SQRT2) };
}

describe('mu-law call audio loopback', () => {
  it.each([48_000, 44_100])('plays a steady tone without clicks with the audio context at %i Hz', async (rate) => {
    const result = await muLawLoop(rate, 20);
    // The tone came through at its own level (not silence, not clipped)...
    expect(result.level).toBeGreaterThan(0.95);
    expect(result.level).toBeLessThan(1.05);
    // ...and without a step at every 20 ms frame edge.
    expect(result.clicksPerMin).toBe(0);
  });
});
