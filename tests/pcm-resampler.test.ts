import { describe, expect, it } from 'vitest';
import { SequencedResampler, StreamResampler } from '../src/control/pcm';

/** Frame-by-frame sample-rate conversion for the mu-law path: one stream, not one frame at a time. */

const AMPLITUDE = 0.5;
const FRAME_MS = 20;

const tone = (freq: number, rate: number, from: number, length: number) =>
  Float32Array.from({ length }, (_, i) => AMPLITUDE * Math.sin((2 * Math.PI * freq * (from + i)) / rate));

/** Push `frames` 20 ms frames of a tone through one resampler; returns each output frame. */
function stream(resampler: StreamResampler, freq: number, frames: number): Float32Array[] {
  const size = (resampler.from * FRAME_MS) / 1000;
  return Array.from({ length: frames }, (_, k) => resampler.push(tone(freq, resampler.from, k * size, size)));
}

/** Largest sample-to-sample step at frame edges and inside frames, after the first `skip` frames. */
function steps(frames: Float32Array[], skip = 2) {
  let edge = 0;
  let inside = 0;
  for (let k = skip; k < frames.length; k++) {
    const frame = frames[k];
    edge = Math.max(edge, Math.abs(frame[0] - frames[k - 1][frames[k - 1].length - 1]));
    for (let i = 1; i < frame.length; i++) inside = Math.max(inside, Math.abs(frame[i] - frame[i - 1]));
  }
  return { edge, inside };
}

const join = (frames: Float32Array[]) => {
  const out = new Float32Array(frames.reduce((n, f) => n + f.length, 0));
  let at = 0;
  for (const f of frames) { out.set(f, at); at += f.length; }
  return out;
};

/** SNR (dB) of `got` against the tone it should be, delayed by `delay` output samples. */
function snr(got: Float32Array, freq: number, rate: number, delay: number, skip: number) {
  let signal = 0;
  let noise = 0;
  for (let i = skip; i < got.length; i++) {
    const want = AMPLITUDE * Math.sin((2 * Math.PI * freq * (i - delay)) / rate);
    signal += want * want;
    noise += (got[i] - want) ** 2;
  }
  return 10 * Math.log10(signal / noise);
}

const rms = (x: Float32Array, skip = 0) => Math.sqrt(x.subarray(skip).reduce((s, v) => s + v * v, 0) / (x.length - skip));

describe('stream resampler', () => {
  it.each([
    [8_000, 48_000],
    [48_000, 8_000],
    [8_000, 44_100],
    [44_100, 8_000],
  ])('turns each 20 ms frame at %i Hz into one 20 ms frame at %i Hz', (from, to) => {
    const frames = stream(new StreamResampler(from, to), 437.3, 20);
    for (const frame of frames) expect(frame.length).toBe((to * FRAME_MS) / 1000);
  });

  it('leaves no step at frame edges going up from 8 kHz to 48 kHz', () => {
    const { edge, inside } = steps(stream(new StreamResampler(8_000, 48_000), 437.3, 200));
    // The clean tone's largest step at 48 kHz; mu-law aside, nothing should exceed it by much.
    const clean = (AMPLITUDE * 2 * Math.PI * 437.3) / 48_000;
    expect(inside).toBeLessThan(clean * 1.05);
    expect(edge).toBeLessThan(clean * 1.05);
    expect(edge).toBeLessThanOrEqual(inside * 1.05);
  });

  it('leaves no step at frame edges going down from 48 kHz to 8 kHz', () => {
    const { edge, inside } = steps(stream(new StreamResampler(48_000, 8_000), 437.3, 200));
    expect(edge).toBeLessThanOrEqual(inside * 1.05);
  });

  it('keeps a 1 kHz tone clean from 8 kHz to 48 kHz', () => {
    const resampler = new StreamResampler(8_000, 48_000);
    const out = join(stream(resampler, 1_000, 100));
    const delay = (resampler.delay * 48_000) / 8_000;
    expect(snr(out, 1_000, 48_000, delay, 960)).toBeGreaterThan(50);
  });

  it('keeps a 1 kHz tone clean through 48 kHz -> 8 kHz -> 48 kHz', () => {
    const down = new StreamResampler(48_000, 8_000);
    const up = new StreamResampler(8_000, 48_000);
    const out = join(stream(down, 1_000, 100).map((frame) => up.push(frame)));
    const delay = down.delay + (up.delay * 48_000) / 8_000;
    expect(snr(out, 1_000, 48_000, delay, 2 * 960)).toBeGreaterThan(45);
  });

  it('filters out what would alias going down: a 6 kHz tone at 48 kHz is gone at 8 kHz', () => {
    const out = join(stream(new StreamResampler(48_000, 8_000), 6_000, 50));
    // Without a low-pass it folds to 2 kHz; at -40 dB or better it is inaudible next to speech.
    expect(rms(out, 160) / (AMPLITUDE / Math.SQRT2)).toBeLessThan(0.01);
  });

  it('starts a fresh stream on reset, and carries state across frames otherwise', () => {
    const frameA = tone(437.3, 8_000, 0, 160);
    const frameB = tone(437.3, 8_000, 160, 160);
    const fresh = new StreamResampler(8_000, 48_000).push(frameB);
    const reused = new StreamResampler(8_000, 48_000);
    reused.push(frameA);
    const continued = reused.push(frameB);
    // Continuing: frame B's output starts with frame A's tail.
    expect([...continued]).not.toEqual([...fresh]);
    reused.reset();
    expect([...reused.push(frameB)]).toEqual([...fresh]);
  });
});

describe('sequenced resampler', () => {
  it('continues on seq + 1 and restarts on a gap, a reorder or a rate change', () => {
    const frames = Array.from({ length: 4 }, (_, k) => tone(437.3, 8_000, k * 160, 160));
    const fresh = (frame: Float32Array, to = 48_000) => [...new StreamResampler(8_000, to).push(frame)];
    const seqd = new SequencedResampler();
    expect([...seqd.push(7, frames[0], 8_000, 48_000)]).toEqual(fresh(frames[0]));
    expect([...seqd.push(8, frames[1], 8_000, 48_000)]).not.toEqual(fresh(frames[1]));
    // Seq 9 was lost: 10 starts over.
    expect([...seqd.push(10, frames[3], 8_000, 48_000)]).toEqual(fresh(frames[3]));
    // A late 9 after 10 starts over too.
    expect([...seqd.push(9, frames[2], 8_000, 48_000)]).toEqual(fresh(frames[2]));
    expect([...seqd.push(10, frames[3], 8_000, 44_100)]).toEqual(fresh(frames[3], 44_100));
    // The u32 seq wraps.
    const wrap = new SequencedResampler();
    wrap.push(0xffff_ffff, frames[0], 8_000, 48_000);
    expect([...wrap.push(0, frames[1], 8_000, 48_000)]).not.toEqual(fresh(frames[1]));
  });
});
