/**
 * Names and message shapes shared by the call audio engine (main thread) and
 * its AudioWorklet processors. Kept apart from the worklet module so the main
 * bundle never executes `registerProcessor`.
 */
import type { JitterStats } from './jitterBuffer';

export const CAPTURE_PROCESSOR = 'bitsov-call-capture';
export const PLAYOUT_PROCESSOR = 'bitsov-call-playout';

/** Capture worklet -> main thread: one 20 ms frame of mono PCM at the context rate. */
export type CaptureMessage = { type: 'frame'; pcm: Float32Array };

/** Main thread -> playout worklet. */
export type PlayoutMessage =
  | { type: 'frame'; seq: number; pcm: Float32Array }
  /** A frame that carried no audio (a HELLO) but took a seq. */
  | { type: 'marker'; seq: number }
  | { type: 'stats' }
  | { type: 'reset' };

/** Playout worklet -> main thread. */
export type PlayoutReport = { type: 'stats'; stats: JitterStats };

/** The limiter's ceiling: -1 dBFS. Audio that stays below it passes unchanged. */
export const LIMIT_CEILING = 0.891;
/** How fast the limiter lets the level back up after a loud stretch. */
export const LIMIT_RELEASE_SECONDS = 0.1;

/**
 * A peak limiter with instant attack: it follows the signal's peak, and when
 * the peak is above the ceiling it scales the audio down so it never passes
 * the ceiling, then eases back up over about 100 ms once it is quiet again.
 * It changes the level, not the waveform, so a loud voice comes out quieter
 * instead of clipped into harsh, crackling edges at full scale. Audio that
 * never reaches the ceiling is left bit for bit as it was.
 */
export class PeakLimiter {
  private envelope = 0;
  private readonly release: number;

  constructor(rate: number) {
    this.release = Math.exp(-1 / (LIMIT_RELEASE_SECONDS * rate));
  }

  /** Limits `pcm` in place and returns it. Not-finite samples become silence. */
  process(pcm: Float32Array): Float32Array {
    let envelope = this.envelope;
    for (let i = 0; i < pcm.length; i++) {
      const v = pcm[i];
      if (!Number.isFinite(v)) { pcm[i] = 0; continue; }
      const a = v < 0 ? -v : v;
      // The peak so far, decaying; never below this sample.
      const decayed = envelope * this.release;
      envelope = a > decayed ? a : decayed;
      if (envelope > LIMIT_CEILING) pcm[i] = v * (LIMIT_CEILING / envelope);
    }
    this.envelope = envelope;
    return pcm;
  }
}
