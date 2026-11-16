/**
 * Adaptive jitter buffer for node-routed call audio (M6 A1).
 *
 * Frames are 20 ms each and arrive with a wrapping u32 `seq`. The buffer
 * reorders by `seq`, conceals lost frames (the caller fills the slot), drops
 * frames that arrive after their slot was played, and adapts its target depth.
 *
 * The call transport is TCP, so frames arrive in order and almost never late:
 * what the link does instead is stall and then deliver a burst. The target
 * therefore follows three signals:
 * - an arrival gap (pulls that passed with no new frame) raises it to cover
 *   that gap plus one frame;
 * - an underrun raises it by one frame and holds playout until the buffer has
 *   refilled to the target, so the extra depth is actually built up;
 * - a frame that arrives after its slot raises it by one frame.
 * After a calm stretch the target steps back down one frame at a time.
 *
 * Bounds: the target stays between `MIN_DEPTH` (60 ms) and `MAX_DEPTH`
 * (160 ms). Queued audio never exceeds the target plus `HEADROOM` frames, so
 * at most 200 ms; anything beyond is skipped and the skip is flagged on the
 * next pull so the player can crossfade over it.
 *
 * Dependency-free so the same class runs inside the playout AudioWorklet
 * (`callAudioWorklet.ts`) and in vitest. `pull()` allocates nothing.
 */
import { nextSeq, seqDiff } from './mediaFrame';

export const FRAME_MS = 20;
/** Default target depth: 3 frames = 60 ms. */
export const MIN_DEPTH = 3;
/** Ceiling for the adaptive target: 8 frames = 160 ms. */
export const MAX_DEPTH = 8;
/** Frames allowed above the target before a burst is trimmed. */
export const HEADROOM = 2;
/** A frame this far ahead of the playhead (2 s) means the stream restarted. */
const RESET_AHEAD = 100;
/** Frames this far behind the playhead are not merely late; they belong to an old stream. */
const RESET_BEHIND = -100;
/** Lower the target after this many calm pulls (10 s at 20 ms). */
const RELAX_AFTER = 500;
/** Once easing down, take each further step after this many calm pulls (2 s). */
const RELAX_STEP = 100;

export type InsertResult = 'buffered' | 'duplicate' | 'late' | 'reset';
export type PullReason = 'frame' | 'waiting' | 'lost' | 'underrun';
/**
 * `jump` is true when frames were skipped right before this one, so it does
 * not continue the previous frame. The object is reused: read it before the
 * next `pull()`.
 */
export type Pull<T> = { frame: T | null; reason: PullReason; jump: boolean };

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
  /** Newest buffered seq; meaningful only while `frames` is not empty. */
  private newest = 0;
  private started = false;
  /** After an underrun, playout waits until the depth is back at the target. */
  private rebuffering = false;
  /** Frames were skipped since the last played frame. */
  private jumped = false;
  private target: number;
  private readonly minDepth: number;
  private readonly maxDepth: number;
  private calmPulls = 0;
  private relaxAt = RELAX_AFTER;
  /** Pulls since the last fresh frame arrived: the arrival gap, in frames. */
  private sinceArrival = 0;
  private readonly result: Pull<T> = { frame: null, reason: 'waiting', jump: false };
  private counters = { received: 0, played: 0, late: 0, lost: 0, duplicates: 0, underruns: 0, resets: 0, skipped: 0 };

  constructor(options: JitterOptions = {}) {
    this.minDepth = Math.max(1, options.minDepth ?? MIN_DEPTH);
    this.maxDepth = Math.max(this.minDepth, options.maxDepth ?? MAX_DEPTH);
    this.target = this.minDepth;
  }

  /** Newest buffered seq relative to the playhead, as a count of frames (0 when empty). */
  private depth(): number {
    if (this.frames.size === 0) return 0;
    return Math.max(0, seqDiff(this.newest, this.playhead) + 1);
  }

  private restart(seq: number) {
    this.frames.clear();
    this.playhead = seq;
    this.started = false;
    this.rebuffering = false;
    this.jumped = false;
    this.sinceArrival = 0;
    this.disturbed();
  }

  /** Something went wrong on the link: start the calm count over. */
  private disturbed() {
    this.calmPulls = 0;
    this.relaxAt = RELAX_AFTER;
  }

  private raiseTo(depth: number) {
    const next = Math.min(this.maxDepth, depth);
    if (next > this.target) this.target = next;
  }

  private store(seq: number, frame: T | null) {
    if (this.frames.size === 0 || seqDiff(seq, this.newest) > 0) this.newest = seq;
    this.frames.set(seq, frame);
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
      this.store(seq, frame);
      return 'reset';
    }
    if (distance < 0) {
      this.counters.late++;
      this.disturbed();
      this.raiseTo(this.target + 1);
      return 'late';
    }
    if (this.frames.has(seq)) {
      this.counters.duplicates++;
      return 'duplicate';
    }
    this.store(seq, frame);
    if (this.started) {
      // `sinceArrival` pulls went by with nothing new: a stall of that many
      // frames. Cover it, with one frame to spare, next time.
      const gap = this.sinceArrival;
      // A stall can fit the deeper target without making the link calm.
      // Restart the easing interval when it consumes the minimum cushion.
      if (gap + 1 >= this.target || gap >= this.minDepth) {
        this.disturbed();
        this.raiseTo(gap + 1);
      }
    }
    // Bound bursts during prebuffering as well as active playout.
    this.trim(this.target + HEADROOM);
    this.sinceArrival = 0;
    return 'buffered';
  }

  /** Drop frames from the playhead until at most `keep` frames remain ahead. */
  private trim(keep: number) {
    while (this.depth() > keep) {
      if (this.frames.delete(this.playhead)) this.counters.skipped++;
      // Crossing an absent slot breaks waveform continuity just the same.
      this.jumped = true;
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

  private answer(frame: T | null, reason: PullReason, jump = false): Pull<T> {
    this.result.frame = frame;
    this.result.reason = reason;
    this.result.jump = jump;
    return this.result;
  }

  /** The next 20 ms of audio, or why there is none. Call once per frame period. */
  pull(): Pull<T> {
    if (this.sinceArrival < RESET_AHEAD) this.sinceArrival++;
    if (!this.started) {
      if (this.depth() < this.target) return this.answer(null, 'waiting');
      this.started = true;
      this.rebuffering = false;
    }
    if (this.rebuffering) {
      if (this.depth() < this.target) {
        this.counters.underruns++;
        return this.answer(null, 'underrun');
      }
      this.rebuffering = false;
    }
    this.skipMarkers();
    const frame = this.frames.get(this.playhead);
    if (frame !== undefined && frame !== null) {
      this.frames.delete(this.playhead);
      this.playhead = nextSeq(this.playhead);
      this.counters.played++;
      const jump = this.jumped;
      this.jumped = false;
      this.relax();
      return this.answer(frame, 'frame', jump);
    }
    if (this.frames.size === 0) {
      // Nothing newer has arrived either: hold the playhead so the stream
      // resumes in order, and refill to a deeper target before resuming.
      this.counters.underruns++;
      this.disturbed();
      this.raiseTo(this.target + 1);
      this.rebuffering = true;
      return this.answer(null, 'underrun');
    }
    // Newer frames are waiting, so this slot's frame is lost (or will be late).
    this.playhead = nextSeq(this.playhead);
    this.counters.lost++;
    this.disturbed();
    return this.answer(null, 'lost');
  }

  /** After a calm run, lower the target one frame and let the depth follow. */
  private relax() {
    this.calmPulls++;
    if (this.calmPulls < this.relaxAt || this.target <= this.minDepth) return;
    this.calmPulls = 0;
    this.relaxAt = RELAX_STEP;
    this.target--;
    this.trim(this.target);
  }

  stats(): JitterStats {
    return { ...this.counters, target: this.target, depth: this.depth() };
  }

  /** Forget everything; the next frame starts a new stream. */
  reset() {
    this.restart(0);
    this.target = this.minDepth;
  }
}
