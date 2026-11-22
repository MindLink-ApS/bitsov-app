// Call audio loopback under bursty delivery: the real capture worklet, a
// model of the host uplink queue (50 frames, drop-oldest, `seq` assigned when
// the socket writes), an order-keeping delivery model (main-thread wakeups
// batched on either side, link stalls, a stalled socket, clock drift), and the
// real playout worklet with its adaptive jitter buffer. Opus is not in the
// loop (Node has no WebCodecs); the frames travel as PCM.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CAPTURE_PROCESSOR,
  PLAYOUT_PROCESSOR,
  type CaptureMessage,
  type PlayoutMessage,
  type PlayoutReport,
} from '../src/control/callAudioShared';
import type { JitterStats } from '../src/control/jitterBuffer';

const RATE = 48_000;
const QUANTUM = 128;
const QUEUE_FRAMES = 50;
const AMPLITUDE = 0.5;
// Not a multiple of 50 Hz: two frames spliced out of order show as a step.
const TONE = 437.3;
const CLEAN_STEP = AMPLITUDE * 2 * Math.PI * TONE / RATE;
/** A click: a step between samples over three times the clean tone's largest. */
const CLICK = 3 * CLEAN_STEP;

type Port<In, Out> = { onmessage: ((event: { data: In }) => void) | null; postMessage: (message: Out, transfer?: Transferable[]) => void };
type Processor<In, Out> = { port: Port<In, Out>; process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean };
type Capture = Processor<never, CaptureMessage>;
type Playout = Processor<PlayoutMessage, PlayoutReport>;

let CaptureProcessor: new () => Capture;
let PlayoutProcessor: new () => Playout;

beforeAll(async () => {
  const registered = new Map<string, new () => unknown>();
  vi.stubGlobal('sampleRate', RATE);
  vi.stubGlobal('AudioWorkletProcessor', class { port = { onmessage: null, postMessage() {} }; });
  vi.stubGlobal('registerProcessor', (name: string, processor: new () => unknown) => registered.set(name, processor));
  await import('../src/control/callAudioWorklet');
  CaptureProcessor = registered.get(CAPTURE_PROCESSOR) as new () => Capture;
  PlayoutProcessor = registered.get(PLAYOUT_PROCESSOR) as new () => Playout;
});

afterAll(() => vi.unstubAllGlobals());

type Scenario = {
  seconds: number;
  /** Sender capture clock against the receiver's, in ppm. */
  driftPpm?: number;
  /** Extra delay (ms) before a frame captured at `t` reaches the host queue: the sender's main thread. */
  senderMain?: (t: number) => number;
  /** Windows [start, end) in ms where the host socket cannot write. */
  socketStalls?: [number, number][];
  /** When a frame that left the host at `t` becomes visible to the playout worklet. */
  receiverWake?: (t: number) => number;
};

type Result = { clicksPerMin: number; dropoutsPerMin: number; hostDropped: number; stats: JitterStats };

function run(scenario: Scenario): Result {
  const total = scenario.seconds * RATE;
  // 1. Capture: the real worklet, at the sender's clock.
  const capture = new CaptureProcessor();
  const captured: { pcm: Float32Array; t: number }[] = [];
  const senderRate = RATE * (1 + (scenario.driftPpm ?? 0) / 1e6);
  let sample = 0;
  capture.port.postMessage = (message) => captured.push({ pcm: message.pcm, t: (sample * 1000) / senderRate });
  for (sample = 0; sample < total; sample += QUANTUM) {
    const input = new Float32Array(QUANTUM);
    for (let i = 0; i < QUANTUM; i++) input[i] = AMPLITUDE * Math.sin(2 * Math.PI * TONE * (sample + i) / RATE);
    capture.process([[input]], [[new Float32Array(QUANTUM)]]);
  }
  // 2. Sender main thread hands frames to the host queue, in order.
  let handed = 0;
  const toHost = captured.map((frame) => {
    handed = Math.max(handed, frame.t + (scenario.senderMain?.(frame.t) ?? 0));
    return { pcm: frame.pcm, t: handed };
  });
  // 3. Host uplink queue: drop-oldest at 50; `seq` assigned at the socket write.
  const stalls = scenario.socketStalls ?? [];
  const stalled = (t: number) => stalls.some(([start, end]) => t >= start && t < end);
  const queue: Float32Array[] = [];
  const wire: { seq: number; pcm: Float32Array; t: number }[] = [];
  let seq = 0;
  let hostDropped = 0;
  const flush = (t: number) => {
    while (queue.length && !stalled(t)) wire.push({ seq: seq++, pcm: queue.shift()!, t });
  };
  for (const frame of toHost) {
    queue.push(frame.pcm);
    if (queue.length > QUEUE_FRAMES) { queue.shift(); hostDropped++; }
    flush(frame.t);
  }
  flush(Infinity);
  // 4. The receiving main thread delivers in order, at its wakeups.
  let lastWake = 0;
  const arrivals = wire.map((frame) => {
    lastWake = Math.max(lastWake, scenario.receiverWake ? scenario.receiverWake(frame.t) : frame.t);
    return { ...frame, t: lastWake };
  });
  // 5. Playout: the real worklet, one quantum at a time.
  const playout = new PlayoutProcessor();
  let stats: JitterStats | undefined;
  playout.port.postMessage = (report) => { stats = report.stats; };
  const output = new Float32Array(QUANTUM);
  let previous = 0;
  let clicks = 0;
  let lastClick = -Infinity;
  let quiet = 0;
  let dropouts = 0;
  let started = false;
  let next = 0;
  for (let k = 0; k < total; k += QUANTUM) {
    const now = (k * 1000) / RATE;
    while (next < arrivals.length && arrivals[next].t <= now) {
      const frame = arrivals[next++];
      playout.port.onmessage!({ data: { type: 'frame', seq: frame.seq, pcm: frame.pcm } });
    }
    playout.process([], [[output]]);
    let energy = 0;
    for (let i = 0; i < QUANTUM; i++) energy += output[i] * output[i];
    // A dropout: two or more quiet quanta, then sound again.
    if (Math.sqrt(energy / QUANTUM) > 0.2) { started = true; if (quiet >= 2) dropouts++; quiet = 0; } else if (started) quiet++;
    for (let i = 0; i < QUANTUM; i++) {
      // Steps closer than 5 ms count as one click.
      if (Math.abs(output[i] - previous) > CLICK) { if (k + i - lastClick > RATE * 0.005) clicks++; lastClick = k + i; }
      previous = output[i];
    }
  }
  playout.port.onmessage!({ data: { type: 'stats' } });
  const minutes = scenario.seconds / 60;
  return { clicksPerMin: clicks / minutes, dropoutsPerMin: dropouts / minutes, hostDropped, stats: stats! };
}

/** Main-thread wakeups bunched to every `period` ms. */
const batched = (period: number) => (t: number) => Math.ceil(t / period) * period;
/** A link stall: nothing arrives for `ms` in the middle of every `every` ms; the backlog lands at its end. */
const stallEvery = (every: number, ms: number) => (t: number) => {
  const start = Math.floor(t / every) * every + every / 2;
  return t >= start && t < start + ms ? start + ms : t;
};

describe('call audio loopback under bursty delivery', () => {
  it('plays a steady tone without clicks or dropouts when nothing is in the way', () => {
    const result = run({ seconds: 60 });
    expect(result.clicksPerMin).toBe(0);
    expect(result.dropoutsPerMin).toBe(0);
    expect(result.stats.underruns).toBe(0);
  });

  it.each([50, 100, 150])('gives no clicks when the receiving main thread wakes every %i ms', (period) => {
    const result = run({ seconds: 60, receiverWake: batched(period) });
    expect(result.clicksPerMin).toBe(0);
    if (period <= 100) expect(result.dropoutsPerMin).toBe(0);
    expect(result.dropoutsPerMin).toBeLessThanOrEqual(1);
  });

  it('gives no clicks when the sending main thread hands frames over every 100 ms', () => {
    const result = run({ seconds: 60, senderMain: (t) => Math.ceil(t / 100) * 100 - t });
    expect(result.clicksPerMin).toBe(0);
    expect(result.dropoutsPerMin).toBe(0);
  });

  it.each([
    [5000, 120],
    [1000, 120],
    [10_000, 300],
  ])('gives no clicks through a link stall every %i ms lasting %i ms', (every, ms) => {
    const result = run({ seconds: 60, receiverWake: stallEvery(every, ms) });
    expect(result.clicksPerMin).toBe(0);
    if (ms <= 120) expect(result.dropoutsPerMin).toBeLessThanOrEqual(1);
  });

  it('gives no clicks through 1.5 s socket stalls that overflow the host queue', () => {
    const stalls = Array.from({ length: 4 }, (_, i) => [15_000 + i * 30_000, 16_500 + i * 30_000] as [number, number]);
    const result = run({ seconds: 120, socketStalls: stalls });
    expect(result.hostDropped).toBeGreaterThan(0);
    expect(result.clicksPerMin).toBe(0);
  });

  it.each([200, -200])('gives no clicks with the sender clock %i ppm off over ten minutes', (driftPpm) => {
    const result = run({ seconds: 600, driftPpm });
    expect(result.clicksPerMin).toBe(0);
    expect(result.dropoutsPerMin).toBeLessThanOrEqual(0.1);
  });
});
