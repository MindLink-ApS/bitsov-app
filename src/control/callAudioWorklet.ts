/**
 * AudioWorklet processors for node-routed call audio (M6 A1). Loaded by
 * `callAudio.ts` through Vite's `?worker&url` so it ships as a same-origin
 * script under the app's CSP.
 *
 * Capture: cuts the microphone into 20 ms frames and posts them to the main
 * thread, which encodes and sends. Playout: keeps the jitter buffer on the
 * audio thread (immune to main-thread timer throttling), conceals lost frames
 * by fading the last good one, and renders straight into the output.
 */
import { JitterBuffer } from './jitterBuffer';
import { frameSamples } from './pcm';
import { CAPTURE_PROCESSOR, PLAYOUT_PROCESSOR, type CaptureMessage, type PlayoutMessage, type PlayoutReport } from './callAudioShared';

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

/** Conceal at most this many consecutive missing frames before going silent. */
const CONCEAL_FRAMES = 3;

class PlayoutProcessor extends AudioWorkletProcessor {
  private readonly size = frameSamples(sampleRate);
  private readonly jitter = new JitterBuffer<Float32Array>();
  private current: Float32Array | null = null;
  private offset = 0;
  private last: Float32Array | null = null;
  private concealed = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<PlayoutMessage>) => {
      const message = event.data;
      switch (message.type) {
        case 'frame': this.jitter.insert(message.seq, message.pcm); break;
        case 'marker': this.jitter.insert(message.seq, null); break;
        case 'reset': this.jitter.reset(); this.current = null; this.last = null; break;
        case 'stats': {
          const report: PlayoutReport = { type: 'stats', stats: this.jitter.stats() };
          this.port.postMessage(report);
          break;
        }
      }
    };
  }

  private nextFrame(): Float32Array {
    const pulled = this.jitter.pull();
    if (pulled.frame) {
      this.last = pulled.frame;
      this.concealed = 0;
      return pulled.frame;
    }
    const out = new Float32Array(this.size);
    if (pulled.reason === 'waiting' || !this.last || this.concealed >= CONCEAL_FRAMES) return out;
    // Packet loss concealment: repeat the last good frame, fading it out.
    this.concealed++;
    const gain = 0.5 ** this.concealed;
    for (let i = 0; i < this.size; i++) out[i] = this.last[i] * gain;
    return out;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0]?.[0];
    if (!output) return true;
    let written = 0;
    while (written < output.length) {
      if (!this.current || this.offset >= this.current.length) {
        this.current = this.nextFrame();
        this.offset = 0;
      }
      const take = Math.min(output.length - written, this.current.length - this.offset);
      output.set(this.current.subarray(this.offset, this.offset + take), written);
      this.offset += take;
      written += take;
    }
    for (let channel = 1; channel < (outputs[0]?.length ?? 0); channel++) outputs[0][channel].set(output);
    return true;
  }
}

registerProcessor(CAPTURE_PROCESSOR, CaptureProcessor);
registerProcessor(PLAYOUT_PROCESSOR, PlayoutProcessor);
