import { beforeAll, describe, expect, it } from 'vitest';
import { JitterBuffer, MAX_DEPTH, MIN_DEPTH } from '../src/control/jitterBuffer';

const frame = (n: number) => Float32Array.of(n);
const value = (pull: { frame: Float32Array | null }) => (pull.frame ? pull.frame[0] : null);

type StallPlan = { seconds: number; stallEveryMs: number; stallMs: number; stallsUntilMs?: number };

/** Small deterministic PRNG so the arrival jitter is the same on every run. */
function prng(seed: number) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 0x1_0000_0000;
  };
}

/**
 * Arrival time (ms) of each 20 ms frame over an in-order (TCP) link: 2-6 ms of
 * network jitter, and every `stallEveryMs` a stall of `stallMs` during which
 * nothing arrives, released as one burst when it ends.
 */
function arrivals(plan: StallPlan): number[] {
  const random = prng(7);
  const out: number[] = [];
  let previous = 0;
  const frames = (plan.seconds * 1000) / 20;
  for (let n = 0; n < frames; n++) {
    let at = n * 20 + 2 + random() * 4;
    const phase = at % plan.stallEveryMs;
    const stallStart = at - phase + plan.stallEveryMs / 2;
    const until = plan.stallsUntilMs ?? Infinity;
    if (at >= stallStart && at < stallStart + plan.stallMs && stallStart < until) at = stallStart + plan.stallMs;
    at = Math.max(at, previous);
    previous = at;
    out.push(at);
  }
  return out;
}

/**
 * Drive the buffer on a 1 ms clock: frames arrive per `arrivals`, playout
 * pulls every 20 ms (offset 10 ms). A discontinuity is any point where what
 * plays does not continue what played before: audio stopping, audio
 * resuming, or frames skipped. Counted from the first played frame.
 */
function simulateStalls(jb: JitterBuffer<Float32Array>, plan: StallPlan) {
  const times = arrivals(plan);
  let next = 0;
  let playing = false;
  let begun = false;
  let discontinuities = 0;
  let underrunEvents = 0;
  let lastSkipped = 0;
  let maxDepth = 0;
  let maxTarget = 0;
  const end = plan.seconds * 1000;
  for (let t = 0; t < end; t++) {
    while (next < times.length && times[next] <= t) { jb.insert(next, frame(next)); next++; }
    if (t % 20 !== 10) continue;
    const pulled = jb.pull();
    const stats = jb.stats();
    const skippedNow = stats.skipped > lastSkipped;
    lastSkipped = stats.skipped;
    if (pulled.frame) {
      if (begun && (!playing || skippedNow)) discontinuities++;
      playing = true;
      begun = true;
    } else {
      if (playing) {
        discontinuities++;
        if (pulled.reason === 'underrun') underrunEvents++;
      }
      playing = false;
    }
    maxDepth = Math.max(maxDepth, stats.depth);
    maxTarget = Math.max(maxTarget, stats.target);
  }
  const stats = jb.stats();
  return { discontinuities, underrunEvents, skipped: stats.skipped, maxDepth, maxTarget, finalTarget: stats.target, finalDepth: stats.depth };
}

describe('jitter buffer', () => {
  it('prebuffers 60 ms (3 frames) then plays in order', () => {
    const jb = new JitterBuffer<Float32Array>();
    expect(jb.pull().reason).toBe('waiting');
    jb.insert(10, frame(10));
    jb.insert(11, frame(11));
    expect(jb.pull().reason).toBe('waiting');
    jb.insert(12, frame(12));
    expect(value(jb.pull())).toBe(10);
    expect(value(jb.pull())).toBe(11);
    expect(value(jb.pull())).toBe(12);
    expect(jb.stats()).toMatchObject({ played: 3, lost: 0, late: 0, target: MIN_DEPTH });
  });

  it('reorders frames that arrive out of order', () => {
    const jb = new JitterBuffer<Float32Array>();
    jb.insert(2, frame(2));
    jb.insert(1, frame(1));
    jb.insert(3, frame(3));
    jb.insert(0, frame(0));
    expect([value(jb.pull()), value(jb.pull()), value(jb.pull()), value(jb.pull())]).toEqual([0, 1, 2, 3]);
    expect(jb.stats().lost).toBe(0);
  });

  it('conceals a lost frame and keeps going', () => {
    const jb = new JitterBuffer<Float32Array>();
    for (const seq of [0, 1, 2, 3]) if (seq !== 1) jb.insert(seq, frame(seq));
    expect(value(jb.pull())).toBe(0);
    const gap = jb.pull();
    expect(gap.reason).toBe('lost');
    expect(gap.frame).toBeNull();
    expect(value(jb.pull())).toBe(2);
    expect(value(jb.pull())).toBe(3);
    expect(jb.stats().lost).toBe(1);
  });

  it('drops a frame that arrives after its slot and raises the target up to its ceiling', () => {
    const jb = new JitterBuffer<Float32Array>();
    for (const seq of [0, 1, 2, 3]) jb.insert(seq, frame(seq));
    jb.pull(); jb.pull();
    expect(jb.insert(0, frame(0))).toBe('late');
    expect(jb.stats().target).toBe(MIN_DEPTH + 1);
    for (let i = 0; i < 10; i++) jb.insert(1, frame(1));
    expect(jb.stats().target).toBe(MAX_DEPTH);
    expect(jb.stats().late).toBe(11);
    expect(value(jb.pull())).toBe(2);
  });

  it('ignores duplicates', () => {
    const jb = new JitterBuffer<Float32Array>();
    jb.insert(0, frame(0));
    expect(jb.insert(0, frame(0))).toBe('duplicate');
    expect(jb.stats().duplicates).toBe(1);
  });

  it('holds the playhead through an underrun, then skips ahead when a burst arrives', () => {
    const jb = new JitterBuffer<Float32Array>();
    for (const seq of [0, 1, 2]) jb.insert(seq, frame(seq));
    for (let i = 0; i < 3; i++) jb.pull();
    expect(jb.pull().reason).toBe('underrun');
    expect(jb.pull().reason).toBe('underrun');
    // A 400 ms burst lands at once: play from the newest target window, not from 3.
    for (let seq = 3; seq < 23; seq++) jb.insert(seq, frame(seq));
    const stats = jb.stats();
    expect(stats.underruns).toBe(2);
    expect(stats.depth).toBeLessThanOrEqual(stats.target + 2);
    expect(stats.skipped).toBeGreaterThan(0);
    expect(value(jb.pull())).toBe(23 - stats.depth);
  });

  it('skips non-audio markers without a gap', () => {
    const jb = new JitterBuffer<Float32Array>();
    jb.insert(0, frame(0));
    jb.insert(1, null);
    jb.insert(2, frame(2));
    expect(value(jb.pull())).toBe(0);
    expect(value(jb.pull())).toBe(2);
    expect(jb.stats().lost).toBe(0);
  });

  it('restarts on a seq jump and across the u32 wrap', () => {
    const jb = new JitterBuffer<Float32Array>();
    for (const seq of [0xfffffffe, 0xffffffff, 0]) jb.insert(seq, frame(seq % 7));
    expect([value(jb.pull()), value(jb.pull()), value(jb.pull())]).toEqual([0xfffffffe % 7, 0xffffffff % 7, 0]);
    expect(jb.insert(5000, frame(1))).toBe('reset');
    expect(jb.stats().resets).toBe(1);
    jb.insert(5001, frame(2)); jb.insert(5002, frame(3));
    expect(value(jb.pull())).toBe(1);
  });

  it('relaxes the target after a long clean run', () => {
    const jb = new JitterBuffer<Float32Array>({ minDepth: 2, maxDepth: 4 });
    for (const seq of [0, 1, 2, 3]) jb.insert(seq, frame(seq));
    jb.pull(); jb.pull();
    jb.insert(0, frame(0));
    expect(jb.stats().target).toBe(3);
    let seq = 4;
    for (let i = 0; i < 520; i++) { jb.insert(seq++, frame(1)); jb.pull(); }
    expect(jb.stats().target).toBe(2);
    expect(jb.stats().depth).toBeLessThanOrEqual(2);
  });

  it('deepens after an underrun and holds playout until refilled', () => {
    const jb = new JitterBuffer<Float32Array>();
    for (const seq of [0, 1, 2]) jb.insert(seq, frame(seq));
    for (let i = 0; i < 3; i++) jb.pull();
    expect(jb.pull().reason).toBe('underrun');
    expect(jb.stats().target).toBe(MIN_DEPTH + 1);
    // One frame is back, but playout waits for the deeper target instead of
    // playing it and underrunning again straight after.
    jb.insert(3, frame(3));
    expect(jb.pull().reason).toBe('underrun');
    for (let seq = 4; seq < 3 + jb.stats().target; seq++) jb.insert(seq, frame(seq));
    expect(value(jb.pull())).toBe(3);
  });

  it('sizes the target from an arrival gap, within its ceiling', () => {
    const jb = new JitterBuffer<Float32Array>();
    let seq = 0;
    for (; seq < 3; seq++) jb.insert(seq, frame(seq));
    for (let i = 0; i < 50; i++) { jb.pull(); jb.insert(seq, frame(seq)); seq++; }
    expect(jb.stats().target).toBe(MIN_DEPTH);
    // Five pulls with no arrival: a 100 ms stall.
    for (let i = 0; i < 5; i++) jb.pull();
    jb.insert(seq, frame(seq));
    expect(jb.stats().target).toBe(6);
    for (let i = 0; i < 40; i++) jb.pull();
    jb.insert(seq + 1, frame(0));
    expect(jb.stats().target).toBe(MAX_DEPTH);
  });

  it('flags a skip so the player can crossfade over it', () => {
    const jb = new JitterBuffer<Float32Array>();
    for (let seq = 0; seq < 3; seq++) jb.insert(seq, frame(seq));
    expect(jb.pull().jump).toBe(false);
    for (let seq = 3; seq < 20; seq++) jb.insert(seq, frame(seq));
    const next = jb.pull();
    expect(next.jump).toBe(true);
    expect(jb.pull().jump).toBe(false);
  });

  it('flags a skip that only crosses absent slots', () => {
    const jb = new JitterBuffer<Float32Array>();
    for (let seq = 5; seq < 8; seq++) jb.insert(seq, frame(seq));
    for (let seq = 5; seq < 8; seq++) expect(jb.pull().jump).toBe(false);
    // The newest frame arrives first and trims the window past empty slots 8..14.
    jb.insert(20, frame(20));
    for (const seq of [17, 15, 19, 16, 18]) jb.insert(seq, frame(seq));
    expect(jb.stats().skipped).toBe(0);
    const next = jb.pull();
    expect(value(next)).toBe(15);
    expect(next.jump).toBe(true);
    expect(jb.pull().jump).toBe(false);
  });

  describe('TCP stall simulation (120 ms every 5 s, 60 s)', () => {
    const stalls = { seconds: 60, stallEveryMs: 5000, stallMs: 120 };

    it('adapts after the first stall: no further underruns or discarded frames', () => {
      const run = simulateStalls(new JitterBuffer<Float32Array>(), stalls);
      // The first stall is unavoidable at the 60 ms start depth; each one after
      // it must play through.
      expect(run.underrunEvents).toBe(1);
      expect(run.discontinuities).toBeLessThanOrEqual(2);
      expect(run.skipped).toBe(0);
      expect(run.maxTarget).toBeLessThanOrEqual(MAX_DEPTH);
    });

    it('keeps queued audio within the target plus headroom', () => {
      const run = simulateStalls(new JitterBuffer<Float32Array>(), stalls);
      expect(run.maxDepth).toBeLessThanOrEqual(MAX_DEPTH + 2);
      expect(run.maxDepth * 20).toBeLessThanOrEqual(200);
    });

    it('eases back to the 60 ms target once the link is calm', () => {
      const run = simulateStalls(new JitterBuffer<Float32Array>(), { seconds: 60, stallEveryMs: 5000, stallMs: 120, stallsUntilMs: 20_000 });
      expect(run.finalTarget).toBe(MIN_DEPTH);
      expect(run.finalDepth).toBeLessThanOrEqual(MIN_DEPTH + 1);
    });
  });
});

describe('playout worklet over the stall simulation', () => {
  const RATE = 48_000;
  const QUANTUM = 128;
  const SIZE = RATE / 50;
  type Processor = { port: { onmessage: ((event: { data: unknown }) => void) | null }; process: (i: Float32Array[][], o: Float32Array[][]) => boolean };
  let Playout: new () => Processor;

  beforeAll(async () => {
    const registered = new Map<string, new () => Processor>();
    const scope = globalThis as Record<string, unknown>;
    scope.sampleRate = RATE;
    scope.AudioWorkletProcessor = class { port = { onmessage: null, postMessage() {} }; };
    scope.registerProcessor = (name: string, processor: new () => Processor) => { registered.set(name, processor); };
    const { PLAYOUT_PROCESSOR } = await import('../src/control/callAudioShared');
    await import('../src/control/callAudioWorklet');
    Playout = registered.get(PLAYOUT_PROCESSOR)!;
  });

  /**
   * A continuous 220 Hz tone, cut into 20 ms frames and delivered on the
   * stall schedule, rendered through the real playout processor in 128-sample
   * quanta. A click is a sample step far beyond the tone's own largest step.
   */
  function render(plan: StallPlan) {
    const processor = new Playout();
    const times = arrivals(plan);
    const tone = (n: number) => 0.5 * Math.sin((2 * Math.PI * 220 * n) / RATE);
    const maxToneStep = 0.5 * 2 * Math.PI * 220 / RATE;
    const threshold = 3 * maxToneStep;
    const output = new Float32Array(QUANTUM);
    let next = 0;
    let previous = 0;
    let clicks = 0;
    let begun = false;
    const quanta = Math.floor((plan.seconds * RATE) / QUANTUM);
    for (let q = 0; q < quanta; q++) {
      const now = (q * QUANTUM * 1000) / RATE;
      while (next < times.length && times[next] <= now) {
        const pcm = new Float32Array(SIZE);
        for (let i = 0; i < SIZE; i++) pcm[i] = tone(next * SIZE + i);
        processor.port.onmessage!({ data: { type: 'frame', seq: next, pcm } });
        next++;
      }
      processor.process([], [[output]]);
      for (let i = 0; i < QUANTUM; i++) {
        if (output[i] !== 0) begun = true;
        if (begun && Math.abs(output[i] - previous) > threshold) clicks++;
        previous = output[i];
      }
    }
    return { clicks };
  }

  it('renders the stalls without clicks', () => {
    const { clicks } = render({ seconds: 60, stallEveryMs: 5000, stallMs: 120 });
    expect(clicks).toBe(0);
  });

  it('fades a gap in and out without a step even before the buffer has adapted', () => {
    // Long stalls past the 160 ms ceiling: every one still underruns.
    const { clicks } = render({ seconds: 30, stallEveryMs: 5000, stallMs: 400 });
    expect(clicks).toBe(0);
  });
});
