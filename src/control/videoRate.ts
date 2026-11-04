/**
 * What video may cost on the node's caps, and how it steps down when it cannot
 * keep up. The node's caps per direction of one call are 100 messages and
 * 65,536 bytes per second by default, and an operator may raise them. Audio is
 * 50 messages a second and the node keeps a reservation for it (60 messages,
 * 12 KiB). Video gets at most what that leaves, and the host paces it under
 * that with a margin, because the node closes the socket past its budget and
 * a network stall can bunch packets into one of its one-second windows.
 */
export type VideoStep = { width: number; height: number; fps: number; bitrate: number };
export type VideoLimits = { bytes_per_second: number; messages_per_second: number };
export type VideoTier = 0 | 1;

export const TIER_DEFAULT: VideoTier = 0;
/** 256 KiB/s and 160 messages/s: both nodes of the call must be configured for it. Each app learns its own node's limits at the handshake and the other's tier from its hello. */
export const TIER_HIGH: VideoTier = 1;

/** The node's caps for each tier, and what it reserves for audio. */
export const NODE_CAPS: Record<VideoTier, { bytes: number; messages: number }> = {
  [TIER_DEFAULT]: { bytes: 64 * 1024, messages: 100 },
  [TIER_HIGH]: { bytes: 256 * 1024, messages: 160 },
};
export const RESERVED_BYTES = 12 * 1024;
export const RESERVED_MESSAGES = 60;
/** Share of what the reservation leaves that the pacer uses. */
export const PACER_MARGIN = 0.85;

export function pacerLimits(tier: VideoTier): VideoLimits {
  const caps = NODE_CAPS[tier];
  return {
    bytes_per_second: Math.floor((caps.bytes - RESERVED_BYTES) * PACER_MARGIN),
    messages_per_second: Math.floor((caps.messages - RESERVED_MESSAGES) * PACER_MARGIN),
  };
}

/** Steps from best to worst. Encoder bitrate stays under the pacer so a key frame finds room. */
const DEFAULT_STEPS: readonly VideoStep[] = [
  { width: 320, height: 240, fps: 15, bitrate: 280_000 },
  { width: 320, height: 240, fps: 10, bitrate: 180_000 },
  { width: 240, height: 180, fps: 7, bitrate: 100_000 },
];
const HIGH_STEPS: readonly VideoStep[] = [
  { width: 640, height: 360, fps: 30, bitrate: 1_200_000 },
  { width: 640, height: 360, fps: 20, bitrate: 800_000 },
  { width: 480, height: 270, fps: 15, bitrate: 450_000 },
  ...DEFAULT_STEPS,
];

/** The tier a node's limits carry; a node that said nothing is at the default. */
export function tierForLimits(limits: { messages: number; bytes: number } | null | undefined): VideoTier {
  const high = NODE_CAPS[TIER_HIGH];
  return limits && limits.messages >= high.messages && limits.bytes >= high.bytes ? TIER_HIGH : TIER_DEFAULT;
}

export const stepsFor = (tier: VideoTier): readonly VideoStep[] => (tier === TIER_HIGH ? HIGH_STEPS : DEFAULT_STEPS);

/** Fragments waiting in the host above which the sender skips frames and steps down. */
export const DEPTH_HIGH = 6;
/** Fragments lost in a report window, as a share of frames, that count as a bad window. */
export const LOSS_BAD = 0.05;
/** Bad windows in a row before stepping down. */
export const BAD_WINDOWS = 2;
/** How long things must stay clean before stepping back up. */
export const STEP_UP_AFTER_MS = 15_000;
/** How long a pause lasts before trying the lowest step again. */
export const PAUSE_MS = 20_000;

export type RateDecision = { step: VideoStep | null; changed: boolean; paused: boolean };

/**
 * The sender's ladder. Local backpressure (the host's queue) and the receiver's
 * reports both step it down; a run of clean time steps it up. Past the lowest
 * step, video pauses and audio carries on.
 */
export class VideoRateController {
  private index = 0;
  private paused = false;
  private badWindows = 0;
  private cleanSince: number;
  private pausedUntil = 0;
  private steps: readonly VideoStep[];

  constructor(tier: VideoTier, now: number) {
    this.steps = stepsFor(tier);
    this.cleanSince = now;
  }

  /** The peer's tier may be lower: the ladder never goes above what both can carry. */
  setTier(tier: VideoTier, now: number): RateDecision {
    const steps = stepsFor(tier);
    const previous = this.steps;
    const current = previous[this.index];
    this.steps = steps;
    this.cleanSince = now;
    if (steps === previous) return { step: this.step(), changed: false, paused: this.paused };
    // A new ladder starts at its top: the first windows will say if that is too much.
    this.index = 0;
    return { step: this.step(), changed: steps[0] !== current, paused: this.paused };
  }

  step(): VideoStep | null {
    return this.paused ? null : this.steps[this.index];
  }

  isPaused(): boolean {
    return this.paused;
  }

  private down(now: number): RateDecision {
    this.badWindows = 0;
    this.cleanSince = now;
    if (this.index + 1 < this.steps.length) {
      this.index++;
      return { step: this.steps[this.index], changed: true, paused: false };
    }
    this.paused = true;
    this.pausedUntil = now + PAUSE_MS;
    return { step: null, changed: true, paused: true };
  }

  /** The host's video queue is backing up. */
  onBackpressure(now: number): RateDecision {
    return this.paused ? { step: null, changed: false, paused: true } : this.down(now);
  }

  /** One report window from the receiver. */
  onReport(complete: number, lost: number, now: number): RateDecision {
    const total = complete + lost;
    const bad = lost > 0 && total > 0 && lost / total >= LOSS_BAD;
    if (this.paused) return { step: null, changed: false, paused: true };
    if (bad) {
      this.badWindows++;
      this.cleanSince = now;
      if (this.badWindows >= BAD_WINDOWS) return this.down(now);
      return { step: this.steps[this.index], changed: false, paused: false };
    }
    this.badWindows = 0;
    return this.tick(now);
  }

  /** Time passes: maybe resume from a pause or step back up. */
  tick(now: number): RateDecision {
    if (this.paused) {
      if (now < this.pausedUntil) return { step: null, changed: false, paused: true };
      this.paused = false;
      this.cleanSince = now;
      return { step: this.steps[this.index], changed: true, paused: false };
    }
    if (this.index > 0 && now - this.cleanSince >= STEP_UP_AFTER_MS) {
      this.index--;
      this.cleanSince = now;
      return { step: this.steps[this.index], changed: true, paused: false };
    }
    return { step: this.steps[this.index], changed: false, paused: false };
  }
}
