/**
 * AudioWorklet processors for node-routed call audio (M6 A1). Loaded by
 * `callAudio.ts` through Vite's `?worker&url` so it ships as a same-origin
 * script under the app's CSP.
 *
 * Capture: cuts the microphone into 20 ms frames and posts them to the main
 * thread, which encodes and sends. Playout: keeps the jitter buffer on the
 * audio thread (immune to main-thread timer throttling), conceals gaps by
 * fading the last good frame out, crossfades real audio back in, and renders
 * straight into the output.
 */
import { JitterBuffer } from './jitterBuffer';
import { frameSamples } from './pcm';
import { CAPTURE_PROCESSOR, PLAYOUT_PROCESSOR, PeakLimiter, type CaptureMessage, type PlayoutMessage, type PlayoutReport } from './callAudioShared';

// AudioWorkletGlobalScope: not in lib.dom, declared here for the type-check.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;

class CaptureProcessor extends AudioWorkletProcessor {
  private readonly size = frameSamples(sampleRate);
  private buffer = new Float32Array(this.size);
  private fill = 0;

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    // The output stays silent; it exists only to keep the node in the graph.
    for (const channel of outputs[0] ?? []) channel.fill(0);
    const input = inputs[0]?.[0];
    if (!input) return true;
    let offset = 0;
    while (offset < input.length) {
      const take = Math.min(this.size - this.fill, input.length - offset);
      this.buffer.set(input.subarray(offset, offset + take), this.fill);
      this.fill += take;
      offset += take;
      if (this.fill === this.size) {
        const message: CaptureMessage = { type: 'frame', pcm: this.buffer };
        this.port.postMessage(message, [this.buffer.buffer]);
        this.buffer = new Float32Array(this.size);
        this.fill = 0;
      }
    }
    return true;
  }
}

/** Conceal at most this many consecutive missing frames (60 ms) before going silent. */
const CONCEAL_FRAMES = 3;
/** Crossfade length where real audio resumes after a gap or a skip. */
const FADE_SECONDS = 0.005;

/**
 * Playout renders 20 ms frames into 128-sample render quanta. Every buffer is
 * allocated up front; `process()` and the frame path allocate nothing.
 *
 * Concealment never steps the waveform: it plays the last good frame
 * mirrored (reversed, then forward, then reversed...), so each copy starts on
 * the sample the previous one ended on, under a linear fade to silence over
 * `CONCEAL_FRAMES`. When real audio comes back, or frames were skipped, the
 * new frame is crossfaded in from what concealment would have played next
 * (silence once it has faded out), so the resume is not a step either.
 */
class PlayoutProcessor extends AudioWorkletProcessor {
  private readonly size = frameSamples(sampleRate);
  private readonly jitter = new JitterBuffer<Float32Array>();
  private readonly out = new Float32Array(this.size);
  private readonly next = new Float32Array(this.size);
  private readonly fade = Math.max(1, Math.min(this.size, Math.round(sampleRate * FADE_SECONDS)));
  private readonly ramp = new Float32Array(this.fade);
  private readonly limiter = new PeakLimiter(sampleRate);
  private current: Float32Array = this.out;
  private offset = this.size;
  private last: Float32Array | null = null;
  /** Frames since the last real one (capped just past `CONCEAL_FRAMES`). */
  private concealed = CONCEAL_FRAMES + 1;

  constructor() {
    super();
    for (let i = 0; i < this.fade; i++) this.ramp[i] = 0.5 - 0.5 * Math.cos((Math.PI * (i + 1)) / (this.fade + 1));
    this.port.onmessage = (event: MessageEvent<PlayoutMessage>) => {
      const message = event.data;
      switch (message.type) {
        case 'frame': this.jitter.insert(message.seq, message.pcm); break;
        case 'marker': this.jitter.insert(message.seq, null); break;
        // The old stream's tail fades out through concealment instead of cutting off.
        case 'reset': this.jitter.reset(); break;
        case 'stats': {
          const report: PlayoutReport = { type: 'stats', stats: this.jitter.stats() };
          this.port.postMessage(report);
          break;
        }
      }
    };
  }

  /** Concealment frame `k` (1-based) after the last real frame, into `into`. */
  private conceal(into: Float32Array, k: number) {
    const last = this.last;
    if (!last || k > CONCEAL_FRAMES || last.length !== this.size) {
      into.fill(0);
      return;
    }
    const n = this.size;
    const total = CONCEAL_FRAMES * n;
    const base = (k - 1) * n;
    const reversed = k % 2 === 1;
    for (let i = 0; i < n; i++) {
      const gain = 1 - (base + i + 1) / total;
      into[i] = (reversed ? last[n - 1 - i] : last[i]) * gain;
    }
  }

  private nextFrame(): Float32Array {
    const pulled = this.jitter.pull();
    const frame = pulled.frame;
    if (frame) {
      const resume = this.concealed > 0 || pulled.jump;
      const missed = this.concealed;
      this.concealed = 0;
      if (!resume || frame.length !== this.size) {
        this.last = frame;
        return frame;
      }
      // What concealment would have played next is what the listener's ear
      // is following; fade from it into the new frame.
      this.conceal(this.next, missed + 1);
      this.last = frame;
      const out = this.out;
      for (let i = 0; i < this.fade; i++) out[i] = frame[i] * this.ramp[i] + this.next[i] * (1 - this.ramp[i]);
      for (let i = this.fade; i < this.size; i++) out[i] = frame[i];
      return out;
    }
    if (this.concealed <= CONCEAL_FRAMES) this.concealed++;
    this.conceal(this.out, this.concealed);
    return this.out;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0]?.[0];
    if (!output) return true;
    let written = 0;
    while (written < output.length) {
      if (this.offset >= this.current.length) {
        this.current = this.nextFrame();
        this.offset = 0;
      }
      const source = this.current;
      const take = Math.min(output.length - written, source.length - this.offset);
      for (let i = 0; i < take; i++) output[written + i] = source[this.offset + i];
      this.offset += take;
      written += take;
    }
    // Nothing over -1 dBFS reaches the speakers: there is no other gain stage after this.
    this.limiter.process(output);
    for (let channel = 1; channel < (outputs[0]?.length ?? 0); channel++) outputs[0][channel].set(output);
    return true;
  }
}

registerProcessor(CAPTURE_PROCESSOR, CaptureProcessor);
registerProcessor(PLAYOUT_PROCESSOR, PlayoutProcessor);
