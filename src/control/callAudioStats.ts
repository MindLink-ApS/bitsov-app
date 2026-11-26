/**
 * Local per-call audio statistics: one row of plain numbers per five seconds
 * of a node-routed call, to help work out why a call sounded choppy.
 *
 * Numbers only. No audio samples, no message content, no device ids or
 * labels are ever read into a row. Rows stay in this process's memory (a few
 * calls, capped) and leave the machine only when the owner copies the call
 * report. Nothing here changes how audio is captured, encoded, buffered or
 * played; the engine only feeds it what it already holds.
 */
import type { JitterStats } from './jitterBuffer';

/** One row covers this long. */
export const ROW_MS = 5_000;
/** Samples per Web Audio render quantum; the zero-run check works in blocks of this size. */
export const QUANTUM = 128;
/** Arrival gaps longer than this (two frame periods plus slack) count as late. */
export const GAP_LATE_MS = 60;
/** Arrival gaps longer than this count as a stall. */
export const GAP_STALL_MS = 100;
/** Levels below this are reported as the floor (-120 dBFS). */
const FLOOR_DB10 = -1200;
/** Mute transitions kept per row. */
const MAX_MUTE_EVENTS = 16;
/** Rows kept per call (one hour) and calls kept. */
export const MAX_ROWS_PER_CALL = 720;
export const MAX_CALLS = 5;

/** Peak, RMS and clipped-sample figures for one stretch of audio. */
export type Level = {
  samples: number;
  /** Peak as dBFS in tenths (-312 is -31.2 dBFS); floor -1200. */
  peakDb10: number;
  rmsDb10: number;
  /** Samples at or beyond full scale. */
  clipped: number;
};

export type CaptureLevel = Level & {
  /** Render-quantum blocks that were exactly zero (counted within each 20 ms frame). */
  zeroQuanta: number;
  quanta: number;
};

/** The microphone track's settings, reduced to known numeric and boolean fields. */
export type MicSettings = {
  sampleRate: number | null;
  sampleSize: number | null;
  channelCount: number | null;
  /** Seconds, as the track reports it, in milliseconds. */
  latencyMs: number | null;
  echoCancellation: boolean | null;
  noiseSuppression: boolean | null;
  autoGainControl: boolean | null;
};

export type HostQueueStats = { uplinkDropped: number; downlinkDropped: number };

export type Gaps = {
  /** Arrivals measured (one fewer than frames seen). */
  count: number;
  maxMs: number;
  /** Gaps over GAP_LATE_MS and over GAP_STALL_MS. */
  late: number;
  stalls: number;
};

export type JitterDelta = {
  received: number;
  played: number;
  late: number;
  lost: number;
  duplicates: number;
  underruns: number;
  resets: number;
  skipped: number;
  /** Instantaneous, at the end of the row. */
  target: number;
  depth: number;
};

export type AudioStatRow = {
  /** Milliseconds from the start of the call audio to the start and end of this row. */
  fromMs: number;
  toMs: number;
  /** The row was closed by the end of the call, before a full period. */
  partial: boolean;
  codec: 'opus' | 'pcmu';
  /** Frames received per codec in this row. */
  rxOpus: number;
  rxPcmu: number;
  mic: MicSettings;
  capture: CaptureLevel;
  playout: Level;
  jitter: JitterDelta | null;
  /** Frames the host dropped from its queues in this row; null if the host could not be asked. */
  host: HostQueueStats | null;
  gaps: Gaps;
  /** Longest stretch the main thread ran no timer, in ms (a 20 ms timer, so ~20 is healthy). */
  loopGapMs: number;
  /** Time spent muted in this row, and each transition as [ms since start, 1 muted | 0 unmuted]. */
  mutedMs: number;
  mute: [number, 0 | 1][];
};

const toDb10 = (amplitude: number): number => (amplitude <= 0 ? FLOOR_DB10 : Math.max(FLOOR_DB10, Math.round(200 * Math.log10(amplitude))));

/** Accumulates peak, sum of squares and clipping across frames without keeping any sample. */
export class LevelMeter {
  samples = 0;
  peak = 0;
  sumSq = 0;
  clipped = 0;
  zeroQuanta = 0;
  quanta = 0;

  /** One frame. A single pass, no allocation. */
  push(pcm: Float32Array, countQuanta = false) {
    const n = pcm.length;
    let peak = this.peak;
    let sumSq = 0;
    let clipped = 0;
    let blockSum = 0;
    let blockLen = 0;
    for (let i = 0; i < n; i++) {
      const v = pcm[i];
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      if (a >= 1) clipped++;
      sumSq += v * v;
      if (countQuanta) {
        blockSum += a;
        if (++blockLen === QUANTUM || i === n - 1) {
          this.quanta++;
          if (blockSum === 0) this.zeroQuanta++;
          blockSum = 0;
          blockLen = 0;
        }
      }
    }
    this.samples += n;
    this.peak = peak;
    this.sumSq += sumSq;
    this.clipped += clipped;
  }

  take(): CaptureLevel {
    const rms = this.samples > 0 ? Math.sqrt(this.sumSq / this.samples) : 0;
    const level: CaptureLevel = {
      samples: this.samples,
      peakDb10: toDb10(this.peak),
      rmsDb10: toDb10(rms),
      clipped: this.clipped,
      zeroQuanta: this.zeroQuanta,
      quanta: this.quanta,
    };
    this.samples = 0;
    this.peak = 0;
    this.sumSq = 0;
    this.clipped = 0;
    this.zeroQuanta = 0;
    this.quanta = 0;
    return level;
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/** Keeps only the known numeric and boolean fields; never the device id, group id or label. */
export function micSettings(track: { getSettings?: () => unknown } | null | undefined): MicSettings {
  let s: Record<string, unknown> = {};
  try {
    const got = track?.getSettings?.();
    if (got && typeof got === 'object') s = got as Record<string, unknown>;
  } catch { /* a stopped track may throw */ }
  const latency = num(s.latency);
  return {
    sampleRate: num(s.sampleRate),
    sampleSize: num(s.sampleSize),
    channelCount: num(s.channelCount),
    latencyMs: latency === null ? null : Math.round(latency * 1000),
    echoCancellation: bool(s.echoCancellation),
    noiseSuppression: bool(s.noiseSuppression),
    autoGainControl: bool(s.autoGainControl),
  };
}

const diff = (now: number, before: number) => Math.max(0, now - before);

/** Between-row differences of the jitter buffer's running counters. */
export function jitterDelta(now: JitterStats, before: JitterStats | null): JitterDelta {
  const b = before;
  return {
    received: diff(now.received, b?.received ?? 0),
    played: diff(now.played, b?.played ?? 0),
    late: diff(now.late, b?.late ?? 0),
    lost: diff(now.lost, b?.lost ?? 0),
    duplicates: diff(now.duplicates, b?.duplicates ?? 0),
    underruns: diff(now.underruns, b?.underruns ?? 0),
    resets: diff(now.resets, b?.resets ?? 0),
    skipped: diff(now.skipped, b?.skipped ?? 0),
    target: now.target,
    depth: now.depth,
  };
}

/** What the engine reads at the end of a row. */
export type RowExtras = {
  codec: 'opus' | 'pcmu';
  mic: MicSettings;
  jitter: JitterStats | null;
  host: HostQueueStats | null;
};

/**
 * Collects the figures of the current row. The engine calls the feed methods
 * with what it already has; `close` turns the collected figures into a row
 * and starts the next. All clocks are passed in (milliseconds, monotonic).
 */
export class AudioStatsRecorder {
  private readonly capture = new LevelMeter();
  private readonly playout = new LevelMeter();
  private rowStart: number;
  private rxOpus = 0;
  private rxPcmu = 0;
  private lastArrival: number | null = null;
  private gaps: Gaps = { count: 0, maxMs: 0, late: 0, stalls: 0 };
  private lastTick: number;
  private loopGapMs = 0;
  private muted = false;
  private mutedSince: number | null = null;
  private mutedMs = 0;
  private mute: [number, 0 | 1][] = [];
  private prevJitter: JitterStats | null = null;
  private prevHost: HostQueueStats | null = null;

  constructor(private readonly origin: number) {
    this.rowStart = origin;
    this.lastTick = origin;
  }

  /** When the current row began (same clock as the rest). */
  rowStartedAt(): number { return this.rowStart; }

  /** One captured frame as the microphone delivered it (before any mute). */
  captured(pcm: Float32Array) { this.capture.push(pcm, true); }

  /** One decoded frame on its way to playout. */
  played(pcm: Float32Array) { this.playout.push(pcm); }

  /** One valid frame from the host (audio or HELLO), at time `now`. */
  arrived(now: number) {
    if (this.lastArrival !== null) {
      const gap = Math.max(0, now - this.lastArrival);
      this.gaps.count++;
      if (gap > this.gaps.maxMs) this.gaps.maxMs = gap;
      if (gap > GAP_LATE_MS) this.gaps.late++;
      if (gap > GAP_STALL_MS) this.gaps.stalls++;
    }
    this.lastArrival = now;
  }

  /** One audio frame received, by codec. */
  received(codec: 'opus' | 'pcmu') { if (codec === 'opus') this.rxOpus++; else this.rxPcmu++; }

  /** The main-thread timer fired at `now`. */
  /**
   * The 20 ms timer starts now. The gap clock starts here, not at
   * construction, so the engine's setup (context, worklet, codec probe) is
   * not counted as a main-thread stall.
   */
  startTicking(now: number) {
    this.lastTick = now;
  }

  tick(now: number) {
    const gap = Math.max(0, now - this.lastTick);
    if (gap > this.loopGapMs) this.loopGapMs = gap;
    this.lastTick = now;
  }

  /** The owner's own mute changed at `now`. */
  setMuted(muted: boolean, now: number) {
    if (muted === this.muted) return;
    this.muted = muted;
    if (this.mute.length < MAX_MUTE_EVENTS) this.mute.push([Math.round(now - this.origin), muted ? 1 : 0]);
    if (muted) this.mutedSince = now;
    else if (this.mutedSince !== null) { this.mutedMs += Math.max(0, now - this.mutedSince); this.mutedSince = null; }
  }

  /** Close the row at `now` and begin the next. */
  close(now: number, extras: RowExtras, partial = false): AudioStatRow {
    let mutedMs = this.mutedMs;
    if (this.mutedSince !== null) {
      mutedMs += Math.max(0, now - this.mutedSince);
      this.mutedSince = Math.max(this.mutedSince, now);
    }
    const jitter = extras.jitter ? jitterDelta(extras.jitter, this.prevJitter) : null;
    if (extras.jitter) this.prevJitter = extras.jitter;
    const host = extras.host ? {
      uplinkDropped: diff(extras.host.uplinkDropped, this.prevHost?.uplinkDropped ?? 0),
      downlinkDropped: diff(extras.host.downlinkDropped, this.prevHost?.downlinkDropped ?? 0),
    } : null;
    if (extras.host) this.prevHost = extras.host;
    const play = this.playout.take();
    const row: AudioStatRow = {
      fromMs: Math.round(this.rowStart - this.origin),
      toMs: Math.round(now - this.origin),
      partial,
      codec: extras.codec,
      rxOpus: this.rxOpus,
      rxPcmu: this.rxPcmu,
      mic: extras.mic,
      capture: this.capture.take(),
      playout: { samples: play.samples, peakDb10: play.peakDb10, rmsDb10: play.rmsDb10, clipped: play.clipped },
      jitter,
      host,
      gaps: this.gaps,
      loopGapMs: Math.round(this.loopGapMs),
      mutedMs: Math.round(mutedMs),
      mute: this.mute,
    };
    this.rowStart = now;
    this.rxOpus = 0;
    this.rxPcmu = 0;
    this.gaps = { count: 0, maxMs: 0, late: 0, stalls: 0 };
    // The gap across a row boundary is still a gap: keep lastArrival and lastTick.
    this.loopGapMs = 0;
    this.mutedMs = 0;
    this.mute = [];
    return row;
  }
}

/** In-memory rows per call id: a few recent calls, each capped. Never persisted. */
export class AudioStatsStore {
  private readonly calls = new Map<string, AudioStatRow[]>();

  add(callId: string | null, row: AudioStatRow) {
    if (!callId) return;
    let rows = this.calls.get(callId);
    if (!rows) {
      rows = [];
      this.calls.set(callId, rows);
      while (this.calls.size > MAX_CALLS) this.calls.delete(this.calls.keys().next().value as string);
    }
    rows.push(row);
    if (rows.length > MAX_ROWS_PER_CALL) rows.shift();
  }

  rows(callId: string | null): readonly AudioStatRow[] {
    return (callId && this.calls.get(callId)) || [];
  }

  clear() { this.calls.clear(); }
}

/** The app's own store, shared by the engine's sink and the call report. */
export const audioStats = new AudioStatsStore();

const n = (v: number | null): string => (v === null ? 'u' : String(v));
const b = (v: boolean | null): string => (v === null ? 'u' : v ? '1' : '0');

/** Column names for `formatRow`, in order. Kept beside the formatter so they cannot drift. */
export const ROW_COLUMNS = [
  't_from_ms', 't_to_ms', 'partial', 'codec', 'rx_opus', 'rx_pcmu',
  'mic_rate', 'mic_bits', 'mic_ch', 'mic_latency_ms', 'mic_echo', 'mic_noise', 'mic_agc',
  'cap_peak_db10', 'cap_rms_db10', 'cap_clipped', 'cap_zero_quanta', 'cap_quanta',
  'play_peak_db10', 'play_rms_db10', 'play_clipped',
  'jb_received', 'jb_played', 'jb_late', 'jb_lost', 'jb_dup', 'jb_underrun', 'jb_reset', 'jb_skipped', 'jb_target', 'jb_depth',
  'host_up_drop', 'host_down_drop',
  'gap_count', 'gap_max_ms', 'gap_late', 'gap_stall', 'loop_gap_ms',
  'muted_ms', 'mute_events',
] as const;

/** One row as a comma-separated line of numbers (`u` where a figure was unavailable). */
export function formatRow(r: AudioStatRow): string {
  const j = r.jitter;
  const h = r.host;
  const jv = (pick: (d: JitterDelta) => number) => (j ? String(pick(j)) : 'u');
  const fields = [
    r.fromMs, r.toMs, r.partial ? 1 : 0, r.codec, r.rxOpus, r.rxPcmu,
    n(r.mic.sampleRate), n(r.mic.sampleSize), n(r.mic.channelCount), n(r.mic.latencyMs),
    b(r.mic.echoCancellation), b(r.mic.noiseSuppression), b(r.mic.autoGainControl),
    r.capture.peakDb10, r.capture.rmsDb10, r.capture.clipped, r.capture.zeroQuanta, r.capture.quanta,
    r.playout.peakDb10, r.playout.rmsDb10, r.playout.clipped,
    jv((d) => d.received), jv((d) => d.played), jv((d) => d.late), jv((d) => d.lost), jv((d) => d.duplicates),
    jv((d) => d.underruns), jv((d) => d.resets), jv((d) => d.skipped), jv((d) => d.target), jv((d) => d.depth),
    h ? h.uplinkDropped : 'u', h ? h.downlinkDropped : 'u',
    r.gaps.count, Math.round(r.gaps.maxMs), r.gaps.late, r.gaps.stalls, r.loopGapMs,
    r.mutedMs, r.mute.map(([t, on]) => `${t}${on ? 'on' : 'off'}`).join(' ') || '-',
  ];
  return fields.join(',');
}

/** Report lines for a call's rows; empty when there are none. */
export function audioStatsLines(rows: readonly AudioStatRow[]): string[] {
  if (rows.length === 0) return [];
  return [
    'audio_stats: one row per 5 s, numbers only, this device; dB values are tenths of dBFS (-312 = -31.2); u = unavailable',
    `audio_stats_columns: ${ROW_COLUMNS.join(',')}`,
    ...rows.map((row) => `audio_stats_row: ${formatRow(row)}`),
  ];
}
