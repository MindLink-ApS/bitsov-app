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
