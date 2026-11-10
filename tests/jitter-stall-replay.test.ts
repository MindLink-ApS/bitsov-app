import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PLAYOUT_PROCESSOR, type PlayoutMessage, type PlayoutReport } from '../src/control/callAudioShared';
import type { JitterStats } from '../src/control/jitterBuffer';
import trace from './fixtures/call-stall-arrivals.json';

const RATE = 48_000;
const SIZE = 960;
const QUANTUM = 128;
// A 0.5-amplitude 220 Hz tone changes by at most 0.0144 per sample.
const MAX_STEP = 0.045;

type Processor = {
  port: {
    onmessage: ((event: { data: PlayoutMessage }) => void) | null;
    postMessage: (report: PlayoutReport) => void;
  };
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
};

describe('fixed TCP arrival replay', () => {
  let Playout: new () => Processor;
  let run: ReturnType<typeof replay>;

  beforeAll(async () => {
    const registered = new Map<string, new () => Processor>();
    vi.stubGlobal('sampleRate', RATE);
    vi.stubGlobal('AudioWorkletProcessor', class {
      port = { onmessage: null, postMessage() {} };
    });
    vi.stubGlobal('registerProcessor', (name: string, processor: new () => Processor) => {
      registered.set(name, processor);
    });
    await import('../src/control/callAudioWorklet');
    Playout = registered.get(PLAYOUT_PROCESSOR)!;
    run = replay();
  });

  afterAll(() => vi.unstubAllGlobals());

  /** Run-length encoded arrival gaps, including same-time burst delivery. */
  function replay() {
    const times: number[] = [];
    let time = 0;
    for (const segment of trace.segments) {
      for (let i = 0; i < segment.frames; i++) {
        time += segment.gapMs;
        times.push(time);
      }
    }

    const processor = new Playout();
    let report: JitterStats;
    processor.port.postMessage = (message) => { report = message.stats; };
    const send = (message: PlayoutMessage) => processor.port.onmessage!({ data: message });
    const stats = () => { send({ type: 'stats' }); return report; };
    const output = new Float32Array(QUANTUM);
    let next = 0;
    let playing = false;
    let begun = false;
    let maxDepthMs = 0;
    let maxStep = 0;
    let previous = 0;
    const gaps: number[] = [];
    const resumes: number[] = [];
    const boundarySteps = new Map<number, number>();
    const targetChanges: { at: number; targetMs: number }[] = [];
    let before = stats();
    const observe = (now: number) => {
      const current = stats();
      maxDepthMs = Math.max(maxDepthMs, current.depth * trace.frameMs);
      if (targetChanges[targetChanges.length - 1]?.targetMs !== current.target * trace.frameMs) {
        targetChanges.push({ at: now, targetMs: current.target * trace.frameMs });
      }
      return current;
    };

    for (let start = 0; start < trace.durationMs * RATE / 1000; start += QUANTUM) {
      const now = start * 1000 / RATE;
      while (next < times.length && times[next] <= now) {
        const pcm = new Float32Array(SIZE);
        for (let i = 0; i < SIZE; i++) {
          pcm[i] = 0.5 * Math.sin(2 * Math.PI * 220 * (next * SIZE + i) / RATE);
        }
        send({ type: 'frame', seq: next++, pcm });
        observe(now); // Check the queue after every insert, including within bursts.
      }
      processor.process([], [[output]]);
      const current = observe(now);
      const boundary = Math.ceil(start / SIZE) * SIZE;
      if (current.underruns > before.underruns) {
        if (playing) gaps.push(boundary);
        playing = false;
      } else if (current.played > before.played) {
        if (begun && !playing) resumes.push(boundary);
        playing = true;
        begun = true;
      }
      for (let i = 0; i < output.length; i++) {
        const step = Math.abs(output[i] - previous);
        maxStep = Math.max(maxStep, step);
        if ((start + i) % SIZE === 0) boundarySteps.set(start + i, step);
        previous = output[i];
      }
      before = current;
    }
    return { gaps, resumes, boundarySteps, maxDepthMs, maxStep, targetChanges, final: stats() };
  }

  it('recovers from the 300 ms burst without an underrun loop at repeated 100 ms gaps', () => {
    expect(run.gaps).toHaveLength(1);
    expect(run.resumes).toHaveLength(1);
    const gapMs = run.gaps[0] * 1000 / RATE;
    const resumeMs = run.resumes[0] * 1000 / RATE;
    expect(gapMs).toBeGreaterThan(1000);
    expect(gapMs).toBeLessThan(1300);
    expect(resumeMs).toBeGreaterThanOrEqual(1300);
    expect(resumeMs).toBeLessThanOrEqual(1500);
    expect(run.final.underruns).toBeLessThanOrEqual(20);
    expect(run.final.lost).toBe(0);
    expect(run.final.played).toBeGreaterThan(1700);
  });

  it('never queues more than 200 ms, even between individual burst inserts', () => {
    expect(run.maxDepthMs).toBeGreaterThan(60);
    expect(run.maxDepthMs).toBeLessThanOrEqual(200);
  });

  it('bounds a 300 ms burst arriving before the first playout pull', () => {
    const processor = new Playout();
    let report: JitterStats;
    processor.port.postMessage = (message) => { report = message.stats; };
    let maxDepthMs = 0;
    for (let seq = 0; seq < 15; seq++) {
      processor.port.onmessage!({ data: { type: 'frame', seq, pcm: new Float32Array(SIZE).fill((seq + 1) / 20) } });
      processor.port.onmessage!({ data: { type: 'stats' } });
      maxDepthMs = Math.max(maxDepthMs, report!.depth * 20);
    }
    expect(maxDepthMs).toBeLessThanOrEqual(200);
    const output = new Float32Array(QUANTUM);
    processor.process([], [[output]]);
    expect(output.some((sample) => sample > 0)).toBe(true);
    processor.process([], [[output]]);
    // Retain frames 10..14; the first frame's value is 11/20 after the fade.
    expect(output[QUANTUM - 1]).toBeCloseTo(0.55, 6);
  });

  it('eases the target back to 60 ms after calm', () => {
    expect(run.targetChanges.some(({ targetMs }) => targetMs === 160)).toBe(true);
    const calm = run.targetChanges.filter(({ at }) => at > 7100);
    expect(calm.map(({ targetMs }) => targetMs)).toEqual([140, 120, 100, 80, 60]);
    expect(calm[0].at).toBeGreaterThanOrEqual(17_000);
    for (let i = 1; i < calm.length; i++) {
      expect(calm[i].at - calm[i - 1].at).toBeGreaterThanOrEqual(1900);
    }
    expect(run.final.target * trace.frameMs).toBe(60);
  });

  it('keeps every sample step small at gap, resume, and render-quantum boundaries', () => {
    expect(run.maxStep).toBeLessThanOrEqual(MAX_STEP);
    expect(run.gaps.length + run.resumes.length).toBe(2);
    for (const boundary of [...run.gaps, ...run.resumes]) {
      expect(run.boundarySteps.get(boundary)).toBeLessThanOrEqual(MAX_STEP);
    }
  });
});
