/**
 * Small PCM helpers shared by the call audio engine: sample-rate conversion
 * between the webview's AudioContext rate and a codec rate, and a framer that
 * cuts an arbitrary stream of samples into fixed 20 ms frames.
 */

/** Samples in one 20 ms frame at `rate`. */
export const frameSamples = (rate: number) => Math.round(rate / 50);

/** Kaiser window shape: about -60 dB sidelobes. */
const KAISER_BETA = 6;
/** Filter half-width, in samples at the lower of the two rates (2 ms at 8 kHz). */
const HALF_WIDTH = 16;
/** Pass band edge as a fraction of the lower rate's Nyquist: 3.5 kHz at 8 kHz. */
const CUTOFF = 0.875;
/** Phase tables kept per resampler; rate pairs with more phases compute taps per sample. */
const MAX_CACHED_PHASES = 4096;

const gcd = (a: number, b: number): number => {
  while (b) [a, b] = [b, a % b];
  return a;
};

/** Modified Bessel function of the first kind, order 0 (for the Kaiser window). */
function besselI0(x: number): number {
  const q = (x * x) / 4;
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 64; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

/**
 * Sample-rate conversion for one continuous stream, frame after frame.
 *
 * Every output sample is a windowed-sinc interpolation (a low-pass at
 * `CUTOFF` of the lower rate's Nyquist) of the input around its exact
 * position, and the filter's history and phase carry over from one frame to
 * the next. A 20 ms frame in gives a 20 ms frame out, with nothing at the
 * frame edges: the output is the stream delayed by the filter's half-width,
 * not each frame converted on its own. Going down, the same low-pass removes
 * what would alias.
 *
 * `reset()` starts a new stream (a new call, a restart, or a gap in the
 * frames): the history before the next frame is its own start mirrored, so
 * a fresh stream starts on its first sample instead of from zero.
 */
export class StreamResampler {
  /** Output samples per `down` input samples. */
  private readonly up: number;
  private readonly down: number;
  /** Taps on each side of an output position, in input samples. */
  private readonly taps: number;
  /** Half-width of the window, in input samples. */
  private readonly reach: number;
  /** Normalised cutoff (1 = the input's Nyquist). */
  private readonly cutoff: number;
  private readonly norm: number;
  private readonly cache = new Map<number, Float32Array>();
  /** Input samples from absolute index `base` on. */
  private history = new Float32Array(0);
  private base = 0;
  private consumed = 0;
  private produced = 0;
  private started = false;

  constructor(readonly from: number, readonly to: number) {
    if (!(Number.isInteger(from) && from > 0 && Number.isInteger(to) && to > 0)) throw new RangeError('rate_out_of_range');
    const g = gcd(from, to);
    this.up = to / g;
    this.down = from / g;
    const lower = Math.min(from, to);
    this.reach = (HALF_WIDTH * from) / lower;
    this.taps = Math.ceil(this.reach);
    this.cutoff = (CUTOFF * lower) / from;
    this.norm = besselI0(KAISER_BETA);
  }

  /** The filter's delay, in input samples: output lags input by this much. */
  get delay() { return this.from === this.to ? 0 : this.taps; }

  /** Forget the stream: the next frame starts a new one. */
  reset() {
    this.history = new Float32Array(0);
    this.base = 0;
    this.consumed = 0;
    this.produced = 0;
    this.started = false;
  }

  /** Convert the next frame of the stream; returns this frame's share of the output. */
  push(input: Float32Array): Float32Array {
    if (this.from === this.to) return input;
    // An empty frame before any audio must not start the stream: the lead-in
    // would mirror silence instead of the first real samples.
    if (!this.started && input.length === 0) return new Float32Array(0);
    const K = this.taps;
    if (!this.started) {
      // Before the stream's first sample: its own start, mirrored.
      const lead = 2 * K;
      const primed = new Float32Array(lead + input.length);
      for (let j = 1; j <= lead; j++) primed[lead - j] = input[Math.min(j, input.length - 1)];
      primed.set(input, lead);
      this.history = primed;
      this.base = -lead;
      this.started = true;
    } else {
      const joined = new Float32Array(this.history.length + input.length);
      joined.set(this.history);
      joined.set(input, this.history.length);
      this.history = joined;
    }
    this.consumed += input.length;
    const target = Math.floor((this.consumed * this.up) / this.down);
    const out = new Float32Array(Math.max(0, target - this.produced));
    const history = this.history;
    for (let o = 0; o < out.length; o++) {
      const num = (this.produced + o) * this.down;
      const q = Math.floor(num / this.up);
      const phase = num - q * this.up;
      // Position q - K + phase/up; taps cover input q - 2K + 1 .. q.
      const weights = this.weights(phase);
      const start = q - 2 * K + 1 - this.base;
      let acc = 0;
      for (let j = 0; j < weights.length; j++) acc += weights[j] * history[start + j];
      out[o] = acc;
    }
    this.produced = Math.max(this.produced, target);
    // Keep only what the next output still needs.
    const nextQ = Math.floor((this.produced * this.down) / this.up);
    const keepFrom = nextQ - 2 * K + 1 - this.base;
    if (keepFrom > 0) {
      this.history = history.slice(Math.min(keepFrom, history.length));
      this.base += Math.min(keepFrom, history.length);
    }
    return out;
  }

  /** Taps for an output `phase / up` of a sample past position q - K, normalised to unity gain. */
  private weights(phase: number): Float32Array {
    const cached = this.cache.get(phase);
    if (cached) return cached;
    const K = this.taps;
    const frac = phase / this.up;
    const weights = new Float32Array(2 * K);
    let sum = 0;
    for (let j = 0; j < 2 * K; j++) {
      // Distance from the output position to tap j's input sample.
      const x = j - K + 1 - frac;
      const r = x / this.reach;
      if (Math.abs(r) >= 1) continue;
      const window = besselI0(KAISER_BETA * Math.sqrt(1 - r * r)) / this.norm;
      const y = this.cutoff * x;
      const sinc = y === 0 ? 1 : Math.sin(Math.PI * y) / (Math.PI * y);
      weights[j] = this.cutoff * sinc * window;
      sum += weights[j];
    }
    if (sum !== 0) for (let j = 0; j < weights.length; j++) weights[j] /= sum;
    if (this.up <= MAX_CACHED_PHASES) this.cache.set(phase, weights);
    return weights;
  }
}

/**
 * A received stream that arrives as numbered frames: frames that follow one
 * another (`seq` + 1) are converted as one stream; a gap, a reorder or a rate
 * change starts a new one, since there is no earlier audio to continue from.
 */
export class SequencedResampler {
  private resampler: StreamResampler | null = null;
  private last: number | null = null;

  push(seq: number, input: Float32Array, from: number, to: number): Float32Array {
    if (from === to) {
      this.reset();
      return input;
    }
    if (!this.resampler || this.resampler.from !== from || this.resampler.to !== to) this.resampler = new StreamResampler(from, to);
    else if (this.last === null || seq !== ((this.last + 1) >>> 0)) this.resampler.reset();
    this.last = seq;
    return this.resampler.push(input);
  }

  reset() {
    this.resampler?.reset();
    this.last = null;
  }
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
