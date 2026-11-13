/**
 * Adaptive jitter buffer for node-routed call audio (M6 A1).
 *
 * Frames are 20 ms each and arrive with a wrapping u32 `seq`. The buffer
 * reorders by `seq`, conceals lost frames (the caller fills the slot), drops
 * frames that arrive after their slot was played, and keeps the playout delay
 * between 60 and 120 ms: late arrivals raise the target depth one frame at a
 * time, a long clean run lowers it again.
 *
 * Dependency-free so the same class runs inside the playout AudioWorklet
 * (`callAudioWorklet.ts`) and in vitest.
 */
import { nextSeq, seqDiff } from './mediaFrame';

export const FRAME_MS = 20;
/** Default target depth: 3 frames = 60 ms. */
export const MIN_DEPTH = 3;
/** Ceiling for the adaptive target: 6 frames = 120 ms. */
export const MAX_DEPTH = 6;
/** A frame this far ahead of the playhead (2 s) means the stream restarted. */
const RESET_AHEAD = 100;
/** Frames this far behind the playhead are not merely late; they belong to an old stream. */
const RESET_BEHIND = -100;
/** Lower the target after this many clean pulls (10 s at 20 ms). */
const RELAX_AFTER = 500;

export type InsertResult = 'buffered' | 'duplicate' | 'late' | 'reset';
export type PullReason = 'frame' | 'waiting' | 'lost' | 'underrun';
export type Pull<T> = { frame: T | null; reason: PullReason };

export type JitterStats = {
  received: number;
  played: number;
  late: number;
  lost: number;
  duplicates: number;
  underruns: number;
  resets: number;
  /** Frames skipped to pull the delay back down after a burst. */
  skipped: number;
  /** Current target depth in frames. */
  target: number;
  /** Frames waiting right now. */
  depth: number;
};

export type JitterOptions = { minDepth?: number; maxDepth?: number };

export class JitterBuffer<T> {
  private frames = new Map<number, T | null>();
  private playhead = 0;
  private started = false;
  private target: number;
  private readonly minDepth: number;
  private readonly maxDepth: number;
  private cleanPulls = 0;
  private counters = { received: 0, played: 0, late: 0, lost: 0, duplicates: 0, underruns: 0, resets: 0, skipped: 0 };

  constructor(options: JitterOptions = {}) {
    this.minDepth = Math.max(1, options.minDepth ?? MIN_DEPTH);
    this.maxDepth = Math.max(this.minDepth, options.maxDepth ?? MAX_DEPTH);
    this.target = this.minDepth;
  }

  /** Newest buffered seq relative to the playhead, as a count of frames (0 when empty). */
  private depth(): number {
    let newest = -1;
    for (const seq of this.frames.keys()) {
      const d = seqDiff(seq, this.playhead);
      if (d > newest) newest = d;
    }
    return newest + 1;
  }

  private restart(seq: number) {
    this.frames.clear();
    this.playhead = seq;
    this.started = false;
    this.cleanPulls = 0;
  }

  /**
   * Offer a frame. `null` marks a non-audio frame (a HELLO) that took a `seq`
   * but no playout time: it keeps the sequence continuous without a gap.
   */
  insert(seq: number, frame: T | null): InsertResult {
    this.counters.received++;
    // While prebuffering, the oldest frame seen so far is where playout starts.
    if (!this.started && (this.frames.size === 0 || (seqDiff(seq, this.playhead) < 0 && seqDiff(seq, this.playhead) > RESET_BEHIND))) {
      this.playhead = seq;
    }
    const distance = seqDiff(seq, this.playhead);
    if (distance >= RESET_AHEAD || distance <= RESET_BEHIND) {
      this.counters.resets++;
      this.restart(seq);
      this.frames.set(seq, frame);
      return 'reset';
    }
    if (distance < 0) {
      this.counters.late++;
      this.cleanPulls = 0;
      if (this.target < this.maxDepth) this.target++;
      return 'late';
    }
    if (this.frames.has(seq)) {
      this.counters.duplicates++;
      return 'duplicate';
    }
    this.frames.set(seq, frame);
    // A burst after an underrun can pile up far past the target: skip ahead
    // so the delay does not stay inflated for the rest of the call.
    if (this.started) this.trim(this.target + 2);
    return 'buffered';
  }

  /** Drop frames from the playhead until at most `keep` frames remain ahead. */
  private trim(keep: number) {
    while (this.depth() > keep) {
      if (this.frames.delete(this.playhead)) this.counters.skipped++;
      this.playhead = nextSeq(this.playhead);
    }
  }

  /** Discard non-audio markers at the playhead; they take no playout time. */
  private skipMarkers() {
    while (this.frames.has(this.playhead) && this.frames.get(this.playhead) === null) {
      this.frames.delete(this.playhead);
      this.playhead = nextSeq(this.playhead);
    }
  }

  /** The next 20 ms of audio, or why there is none. Call once per frame period. */
  pull(): Pull<T> {
    if (!this.started) {
      if (this.depth() < this.target) return { frame: null, reason: 'waiting' };
      this.started = true;
    }
    this.skipMarkers();
    const frame = this.frames.get(this.playhead);
    if (frame !== undefined && frame !== null) {
      this.frames.delete(this.playhead);
      this.playhead = nextSeq(this.playhead);
      this.counters.played++;
      this.relax();
      return { frame, reason: 'frame' };
    }
    if (this.frames.size === 0) {
      // Nothing newer has arrived either: hold the playhead so the stream
      // resumes in order when frames come back.
      this.counters.underruns++;
      this.cleanPulls = 0;
      return { frame: null, reason: 'underrun' };
    }
    // Newer frames are waiting, so this slot's frame is lost (or will be late).
    this.playhead = nextSeq(this.playhead);
    this.counters.lost++;
    this.cleanPulls = 0;
    return { frame: null, reason: 'lost' };
  }

  /** After a long clean run, lower the target one frame and let the depth follow. */
  private relax() {
    this.cleanPulls++;
    if (this.cleanPulls < RELAX_AFTER || this.target <= this.minDepth) return;
    this.cleanPulls = 0;
    this.target--;
    this.trim(this.target);
  }

  stats(): JitterStats {
    return { ...this.counters, target: this.target, depth: this.depth() };
  }

  /** Forget everything; the next frame starts a new stream. */
  reset() {
    this.restart(0);
    this.frames.clear();
    this.target = this.minDepth;
  }
}
