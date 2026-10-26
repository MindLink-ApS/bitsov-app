/**
 * Small PCM helpers shared by the call audio engine: sample-rate conversion
 * between the webview's AudioContext rate and a codec rate, and a framer that
 * cuts an arbitrary stream of samples into fixed 20 ms frames.
 */

/** Samples in one 20 ms frame at `rate`. */
export const frameSamples = (rate: number) => Math.round(rate / 50);

/**
 * Convert `input` from `from` Hz to `to` Hz. Integer decimation averages each
 * window (a cheap anti-alias for speech); anything else interpolates
 * linearly. Good enough for a mu-law fallback; Opus never passes through here.
 */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || input.length === 0) return input;
  if (from > to && from % to === 0) {
    const step = from / to;
    const out = new Float32Array(Math.floor(input.length / step));
    for (let i = 0; i < out.length; i++) {
      let sum = 0;
      for (let k = 0; k < step; k++) sum += input[i * step + k];
      out[i] = sum / step;
    }
    return out;
  }
  const ratio = from / to;
  const out = new Float32Array(Math.round(input.length / ratio));
  const last = input.length - 1;
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const base = Math.min(last, Math.floor(pos));
    const next = Math.min(last, base + 1);
    const frac = pos - base;
    out[i] = input[base] * (1 - frac) + input[next] * frac;
  }
  return out;
}

/** Accumulates samples and hands out exactly `size`-sample frames. */
export class Framer {
  private buffer: Float32Array;
  private fill = 0;
  constructor(readonly size: number) {
    this.buffer = new Float32Array(size);
  }
  /** Push samples; returns every complete frame they completed, in order. */
  push(samples: Float32Array): Float32Array[] {
    const frames: Float32Array[] = [];
    let offset = 0;
    while (offset < samples.length) {
      const take = Math.min(this.size - this.fill, samples.length - offset);
      this.buffer.set(samples.subarray(offset, offset + take), this.fill);
      this.fill += take;
      offset += take;
      if (this.fill === this.size) {
        frames.push(this.buffer);
        this.buffer = new Float32Array(this.size);
        this.fill = 0;
      }
    }
    return frames;
  }
  /** Samples waiting for the next frame. */
  get pending() { return this.fill; }
}
