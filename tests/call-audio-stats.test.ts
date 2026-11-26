import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCallAudio } from '../src/control/callAudio';
import {
  AudioStatsRecorder, AudioStatsStore, LevelMeter, MAX_CALLS, MAX_ROWS_PER_CALL, QUANTUM, ROW_COLUMNS, audioStatsLines,
  formatRow, jitterDelta, micSettings, type AudioStatRow, type RowExtras,
} from '../src/control/callAudioStats';
import { parseQueueStats } from '../src/control/mediaBridge';
import { callReportLines } from '../src/control/callReport';
import { IDLE } from '../src/control/call';
import type { JitterStats } from '../src/control/jitterBuffer';

const jb = (patch: Partial<JitterStats> = {}): JitterStats => ({ received: 0, played: 0, late: 0, lost: 0, duplicates: 0, underruns: 0, resets: 0, skipped: 0, target: 3, depth: 2, ...patch });
const MIC = micSettings({ getSettings: () => ({ sampleRate: 48000, channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: true, latency: 0.01 }) });
const extras = (patch: Partial<RowExtras> = {}): RowExtras => ({ codec: 'opus', mic: MIC, jitter: jb(), host: { uplinkDropped: 0, downlinkDropped: 0 }, ...patch });
const frame = (value: number, n = 960) => new Float32Array(n).fill(value);

describe('LevelMeter', () => {
  it('reports peak and rms in tenths of dBFS, and counts clipped samples', () => {
    const m = new LevelMeter();
    const f = new Float32Array(960);
    f.fill(0.5);
    f[0] = -1;
    f[1] = 1;
    m.push(f);
    const level = m.take();
    expect(level.samples).toBe(960);
    expect(level.peakDb10).toBe(0);
    expect(level.clipped).toBe(2);
    // rms is about 0.5 => about -6 dBFS
    expect(level.rmsDb10).toBeGreaterThan(-65);
    expect(level.rmsDb10).toBeLessThan(-55);
  });

  it('floors digital silence at -120 dBFS and resets after take', () => {
    const m = new LevelMeter();
    m.push(frame(0));
    expect(m.take()).toMatchObject({ peakDb10: -1200, rmsDb10: -1200, clipped: 0 });
    expect(m.take().samples).toBe(0);
  });

  it('counts all-zero render quanta inside a frame, including the short last block', () => {
    const m = new LevelMeter();
    const f = new Float32Array(960); // 7 full blocks of 128 and one of 64
    f[3 * QUANTUM + 5] = 0.1; // block 3 is not zero
    f[959] = 0.1; // the short last block is not zero
    m.push(f, true);
    const level = m.take();
    expect(level.quanta).toBe(8);
    expect(level.zeroQuanta).toBe(6);
  });

  it('does not count quanta for playout levels', () => {
    const m = new LevelMeter();
    m.push(frame(0));
    expect(m.take().quanta).toBe(0);
  });
});

describe('micSettings', () => {
  it('keeps only known numbers and booleans, never ids or labels', () => {
    const s = micSettings({ getSettings: () => ({ deviceId: 'abc', groupId: 'g', label: 'x', sampleRate: 44100, echoCancellation: 'yes', autoGainControl: false, latency: 0.0123 }) });
    expect(s).toEqual({ sampleRate: 44100, sampleSize: null, channelCount: null, latencyMs: 12, echoCancellation: null, noiseSuppression: null, autoGainControl: false });
    expect(JSON.stringify(s)).not.toMatch(/abc|label/);
  });
  it('survives a missing or throwing track', () => {
    expect(micSettings(undefined).sampleRate).toBeNull();
    expect(micSettings({ getSettings: () => { throw new Error('stopped'); } }).sampleRate).toBeNull();
  });
});

describe('jitterDelta', () => {
  it('differences the running counters and keeps target and depth as they are', () => {
    const d = jitterDelta(jb({ received: 350, played: 300, lost: 7, late: 4, target: 5, depth: 4 }), jb({ received: 250, played: 200, lost: 2, late: 1 }));
    expect(d).toMatchObject({ received: 100, played: 100, lost: 5, late: 3, target: 5, depth: 4 });
  });
  it('never goes negative if the buffer was reset', () => {
    expect(jitterDelta(jb({ received: 5 }), jb({ received: 90 })).received).toBe(0);
  });
});

describe('AudioStatsRecorder', () => {
  it('aggregates one row and starts the next from zero', () => {
    const r = new AudioStatsRecorder(1000);
    r.captured(frame(0.25));
    r.captured(frame(1));
    r.played(frame(0.1));
    r.received('opus'); r.received('opus'); r.received('pcmu');
    for (const t of [1000, 1020, 1040, 1160, 1180, 1330]) r.arrived(t);
    for (const t of [1020, 1040, 1100]) r.tick(t);
    const row = r.close(6000, extras({ jitter: jb({ received: 100, played: 96, lost: 4, target: 4 }), host: { uplinkDropped: 2, downlinkDropped: 1 } }));
    expect(row).toMatchObject({ fromMs: 0, toMs: 5000, partial: false, codec: 'opus', rxOpus: 2, rxPcmu: 1 });
    expect(row.capture).toMatchObject({ samples: 1920, clipped: 960, zeroQuanta: 0 });
    expect(row.playout).toMatchObject({ samples: 960, clipped: 0 });
    expect(row.gaps).toEqual({ count: 5, maxMs: 150, late: 2, stalls: 2 });
    expect(row.loopGapMs).toBe(60);
    expect(row.jitter).toMatchObject({ received: 100, lost: 4, target: 4 });
    expect(row.host).toEqual({ uplinkDropped: 2, downlinkDropped: 1 });

    const next = r.close(11000, extras({ jitter: jb({ received: 180, played: 176, lost: 4 }), host: { uplinkDropped: 2, downlinkDropped: 4 } }));
    expect(next).toMatchObject({ fromMs: 5000, toMs: 10000, rxOpus: 0, rxPcmu: 0 });
    expect(next.capture.samples).toBe(0);
    expect(next.jitter).toMatchObject({ received: 80, lost: 0 });
    expect(next.host).toEqual({ uplinkDropped: 0, downlinkDropped: 3 });
    // The gap across the row boundary is measured against the last arrival of the old row.
    r.arrived(1340);
    expect(r.close(16000, extras()).gaps).toMatchObject({ count: 1, maxMs: 10 });
  });

  it('counts no setup time as a main-thread gap, and still catches a real gap after it', () => {
    // The timer only starts once the audio graph is up, 3 s after the recorder.
    const r = new AudioStatsRecorder(0);
    r.startTicking(3000);
    r.tick(3020); r.tick(3040);
    expect(r.close(5000, extras()).loopGapMs).toBe(20);
    const stalled = new AudioStatsRecorder(0);
    stalled.startTicking(3000);
    stalled.tick(3020); stalled.tick(3400);
    expect(stalled.close(5000, extras()).loopGapMs).toBe(380);
  });

  it('records the longest main-thread gap, across row boundaries', () => {
    const r = new AudioStatsRecorder(0);
    r.tick(20); r.tick(40);
    r.close(5000, extras());
    r.tick(5400);
    expect(r.close(10000, extras()).loopGapMs).toBe(5360);
  });

  it('records mute times as offsets and sums the muted time per row', () => {
    const r = new AudioStatsRecorder(100);
    r.setMuted(true, 1100);
    r.setMuted(true, 1200); // no change, no event
    r.setMuted(false, 2100);
    r.setMuted(true, 4100);
    const first = r.close(5100, extras());
    expect(first.mute).toEqual([[1000, 1], [2000, 0], [4000, 1]]);
    expect(first.mutedMs).toBe(1000 + 1000);
    // Still muted into the next row: the muted time carries over, the old events do not.
    const second = r.close(10100, extras());
    expect(second.mute).toEqual([]);
    expect(second.mutedMs).toBe(5000);
  });

  it('keeps jitter and host as unavailable when they could not be read, and flags a partial row', () => {
    const r = new AudioStatsRecorder(0);
    const row = r.close(1800, extras({ jitter: null, host: null }), true);
    expect(row).toMatchObject({ partial: true, jitter: null, host: null, toMs: 1800 });
    expect(formatRow(row).split(',')[ROW_COLUMNS.indexOf('jb_lost')]).toBe('u');
    expect(formatRow(row).split(',')[ROW_COLUMNS.indexOf('host_up_drop')]).toBe('u');
  });

  it('caps the mute events kept per row', () => {
    const r = new AudioStatsRecorder(0);
    for (let i = 0; i < 100; i++) r.setMuted(i % 2 === 0, i * 10);
    expect(r.close(5000, extras()).mute.length).toBeLessThanOrEqual(16);
  });
});

describe('formatting', () => {
  const row = (): AudioStatRow => {
    const r = new AudioStatsRecorder(0);
    r.captured(frame(0.5));
    r.setMuted(true, 1500);
    return r.close(5000, extras());
  };
  it('has one field per column, only numbers, flags and short tokens', () => {
    const fields = formatRow(row()).split(',');
    expect(fields).toHaveLength(ROW_COLUMNS.length);
    expect(fields[ROW_COLUMNS.indexOf('codec')]).toBe('opus');
    expect(fields[ROW_COLUMNS.indexOf('mic_echo')]).toBe('1');
    expect(fields[ROW_COLUMNS.indexOf('mic_noise')]).toBe('0');
    expect(fields[ROW_COLUMNS.indexOf('mute_events')]).toBe('1500on');
    expect(formatRow(row())).toMatch(/^[0-9a-z,\- ]+$/);
  });
  it('writes nothing for a call without rows', () => {
    expect(audioStatsLines([])).toEqual([]);
    expect(audioStatsLines([row()])).toHaveLength(3);
  });
});

describe('AudioStatsStore', () => {
  const rowAt = (i: number): AudioStatRow => new AudioStatsRecorder(0).close(i, extras());
  it('keeps rows per call, caps rows and calls, and ignores a missing call id', () => {
    const store = new AudioStatsStore();
    store.add(null, rowAt(1));
    for (let i = 0; i < MAX_ROWS_PER_CALL + 5; i++) store.add('a', rowAt(i));
    expect(store.rows('a')).toHaveLength(MAX_ROWS_PER_CALL);
    expect(store.rows('a')[0].toMs).toBe(5);
    for (let i = 0; i < MAX_CALLS; i++) store.add(`c${i}`, rowAt(i));
    expect(store.rows('a')).toHaveLength(0);
    expect(store.rows('c0')).toHaveLength(1);
    expect(store.rows(null)).toHaveLength(0);
  });
});

describe('the call report', () => {
  it('is unchanged without rows and carries them after the last field when there are some', () => {
    const view = { ...IDLE, phase: 'ended' as const, state: 'ended' as const };
    const base = callReportLines({ view, routed: true, endedAt: null });
    expect(callReportLines({ view, routed: true, endedAt: null, audioRows: [] })).toEqual(base);
    const row = new AudioStatsRecorder(0).close(5000, extras());
    const lines = callReportLines({ view, routed: true, endedAt: null, audioRows: [row] });
    expect(lines.slice(0, base.length)).toEqual(base);
    expect(lines.slice(base.length).map((l) => l.split(':')[0])).toEqual(['audio_stats', 'audio_stats_columns', 'audio_stats_row']);
  });
});

describe('parseQueueStats', () => {
  it('accepts two counts and nothing else', () => {
    expect(parseQueueStats({ uplink_dropped: 3, downlink_dropped: 0 })).toEqual({ uplinkDropped: 3, downlinkDropped: 0 });
    expect(parseQueueStats({ uplink_dropped: -1, downlink_dropped: 0 })).toBeNull();
    expect(parseQueueStats({ uplink_dropped: '3', downlink_dropped: 0 })).toBeNull();
    expect(parseQueueStats(null)).toBeNull();
  });
});

class FakeNode {
  port = { postMessage: vi.fn(), onmessage: null as ((event: { data: unknown }) => void) | null };
  gain = { value: 1 };
  onprocessorerror: (() => void) | null = null;
  connect<T>(next: T) { return next; }
  disconnect() {}
}
class FakeWorkletNode extends FakeNode {
  static made: { name: string; node: FakeWorkletNode }[] = [];
  constructor(_ctx: unknown, name: string) { super(); FakeWorkletNode.made.push({ name, node: this }); }
}
class FakeContext {
  sampleRate = 48_000;
  currentTime = 0;
  destination = new FakeNode();
  audioWorklet = { addModule: async () => {} };
  async resume() {}
  async close() {}
  createMediaStreamSource() { return new FakeNode(); }
  createGain() { return new FakeNode(); }
}

describe('the engine feeds the recorder', () => {
  beforeEach(() => { FakeWorkletNode.made = []; vi.useFakeTimers(); vi.stubGlobal('AudioWorkletNode', FakeWorkletNode); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('emits a row every five seconds and a partial one at close, and measures nothing without a sink', async () => {
    let now = 0;
    const rows: AudioStatRow[] = [];
    const sent: Uint8Array[] = [];
    const audio = createCallAudio({
      stream: { getTracks: () => [], getAudioTracks: () => [{ getSettings: () => ({ sampleRate: 48000, echoCancellation: false }) }], getVideoTracks: () => [] } as unknown as MediaStream,
      transport: { send: (p) => sent.push(p), queueStats: async () => ({ uplinkDropped: 1, downlinkDropped: 2 }) },
      audioContext: () => new FakeContext() as unknown as AudioContext,
      workletUrl: 'worklet.js',
      opus: false,
      onStats: (row) => rows.push(row),
      clock: () => now,
    });
    await audio.ready;
    // The 20 ms timer starts with the audio graph, not before it.
    expect(rows).toHaveLength(0);
    const capture = [...FakeWorkletNode.made].reverse().find((m) => m.name === 'bitsov-call-capture')!.node;
    const playout = [...FakeWorkletNode.made].reverse().find((m) => m.name === 'bitsov-call-playout')!.node;
    playout.port.postMessage.mockImplementation((message: { type: string }) => {
      if (message.type === 'stats') playout.port.onmessage?.({ data: { type: 'stats', stats: jb({ received: 50, played: 48, lost: 2 }) } });
    });
    capture.port.onmessage?.({ data: { type: 'frame', pcm: frame(0.3) } });
    audio.setMuted(true);
    now = 5000;
    await vi.advanceTimersByTimeAsync(5000);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partial: false, codec: 'pcmu', toMs: 5000 });
    expect(rows[0].mic).toMatchObject({ sampleRate: 48000, echoCancellation: false });
    expect(rows[0].capture.samples).toBe(960);
    expect(rows[0].jitter).toMatchObject({ received: 50, lost: 2 });
    expect(rows[0].host).toEqual({ uplinkDropped: 1, downlinkDropped: 2 });
    expect(rows[0].mute).toEqual([[0, 1]]);
    now = 8000;
    await audio.close();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ partial: true, fromMs: 5000, toMs: 8000, jitter: null });
  });

  it('does not count a slow audio setup as a main-thread gap', async () => {
    const rows: AudioStatRow[] = [];
    // The worklet takes 3 s to load; the clock follows the fake timers.
    const slow = () => Object.assign(new FakeContext(), { audioWorklet: { addModule: () => new Promise<void>((done) => setTimeout(done, 3000)) } });
    const audio = createCallAudio({
      stream: { getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] } as unknown as MediaStream,
      transport: { send: () => {} },
      audioContext: () => slow() as unknown as AudioContext,
      workletUrl: 'worklet.js',
      opus: false,
      onStats: (row) => rows.push(row),
      clock: () => Date.now(),
    });
    await vi.advanceTimersByTimeAsync(3000);
    await audio.ready;
    // One row: 5 s, plus the 500 ms the unanswered jitter read is given.
    await vi.advanceTimersByTimeAsync(5600);
    expect(rows).toHaveLength(1);
    expect(rows[0].loopGapMs).toBeLessThan(100);
    await audio.close();
  });

  it('does not touch the payloads sent or run any timer when no sink is given', async () => {
    const audio = createCallAudio({
      stream: { getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] } as unknown as MediaStream,
      transport: { send: () => {} },
      audioContext: () => new FakeContext() as unknown as AudioContext,
      workletUrl: 'worklet.js',
      opus: false,
    });
    await audio.ready;
    // Only the HELLO timer is pending.
    expect(vi.getTimerCount()).toBe(1);
    await audio.close();
  });
});
