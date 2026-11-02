import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INITIAL_PILL_STATUS,
  NOT_ANSWERING_AFTER_MISSES,
  NOT_ANSWERING_AFTER_MS,
  nodePill,
  pillStatusAfter,
  type PillStatus,
} from '../src/control/state';
import type { NodeOverview } from '../src/control/types';

const OWN = '1'.repeat(64);
const POLL_MS = 1500;
const overview = (read_at: number): NodeOverview => ({
  node_id: OWN,
  status: 'ok',
  version: 'api v2',
  connected_peers: 1,
  e2ee_sessions: 0,
  pending_deliveries: 0,
  lightning_available: true,
  block_height: 1,
  uptime_secs: 1,
  lightning_backend: 'ldk',
  chain_backend: 'esplora',
  read_at,
});

type Read = { ready: boolean; error: string | null; locked?: boolean; retry_after_secs?: number | null };
const good: Read = { ready: true, error: null };
const timeout: Read = { ready: false, error: 'remote request timed out' };
const unreachable: Read = { ready: false, error: 'remote node unreachable' };

/** The pill as the shell renders it, with the overview read when the shell opened. */
function pillFor(held: PillStatus, opts: { remote?: boolean; overviewAt?: number } = {}) {
  return nodePill({
    remote: opts.remote ?? true,
    ready: held.ready,
    error: held.error,
    quiet: held.quiet,
    statusChecked: true,
    overview: overview(opts.overviewAt ?? Date.now()),
    link: 'open',
    nowMs: Date.now(),
  });
}

describe('status pill hysteresis', () => {
  let held: PillStatus;
  /** One status poll: wait the poll interval, then fold the read. */
  const poll = (read: Read, refused = false) => {
    vi.advanceTimersByTime(POLL_MS);
    held = pillStatusAfter(held, read, refused, Date.now());
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-01T12:00:00Z'));
    held = INITIAL_PILL_STATUS;
  });
  afterEach(() => vi.useRealTimers());

  it('uses 3 misses spanning at least 5 s', () => {
    expect(NOT_ANSWERING_AFTER_MISSES).toBe(3);
    expect(NOT_ANSWERING_AFTER_MS).toBe(5_000);
  });

  it('first load is unchanged: still connecting until the node answers', () => {
    expect(pillFor(held).text).toBe('Connecting to remote node');
    expect(pillFor(held, { remote: false }).text).toBe('Starting node');
    poll(timeout);
    expect(pillFor(held).text).toBe('Connecting to remote node');
    poll({ ready: false, error: null });
    expect(pillFor(held).text).toBe('Connecting to remote node');
    poll(good);
    expect(pillFor(held)).toEqual({ tone: 'ok', text: 'Connected to your node', live: true });
  });

  it('one failed check leaves the pill OK', () => {
    poll(good);
    poll(timeout);
    expect(held.checks.misses).toBe(1);
    expect(pillFor(held)).toEqual({ tone: 'ok', text: 'Connected to your node', live: true });
    poll(good);
    poll(unreachable);
    poll(good);
    expect(pillFor(held).tone).toBe('ok');
  });

  it('3 failures in a row are not enough before 5 s have passed', () => {
    poll(good);
    poll(timeout);
    poll(timeout);
    poll(timeout); // three misses, but only 3 s since the first
    expect(held.checks.misses).toBe(3);
    expect(pillFor(held).tone).toBe('ok');
  });

  it('3 failures spanning at least 5 s say the node is not answering', () => {
    poll(good);
    poll(timeout); // first miss at t
    poll(unreachable);
    poll(timeout);
    poll(timeout); // t + 4.5 s
    expect(pillFor(held).tone).toBe('ok');
    poll(timeout); // t + 6 s, fifth miss
    expect(pillFor(held)).toEqual({ tone: 'warn', text: 'Node not answering', live: false });
    // Local seats use the same words for a confirmed silence.
    expect(pillFor(held, { remote: false }).text).toBe('Node not answering');
  });

  it('one good check is OK again', () => {
    poll(good);
    for (let i = 0; i < 5; i++) poll(timeout);
    expect(pillFor(held).text).toBe('Node not answering');
    poll(good);
    expect(held.checks.misses).toBe(0);
    expect(pillFor(held)).toEqual({ tone: 'ok', text: 'Connected to your node', live: true });
    // The count starts over: a fresh single miss does not flip it back.
    poll(timeout);
    expect(pillFor(held).tone).toBe('ok');
  });

  it('a locked node, a refused pairing, a cooldown or a stopped node show at once', () => {
    const before = Date.now();
    poll(good);
    held = pillStatusAfter(held, { ready: false, error: 'remote unavailable', locked: true }, false, Date.now());
    expect(held).toMatchObject({ ready: false, error: 'remote unavailable', quiet: false });
    expect(pillFor(held).text).toBe('Remote connection unavailable');

    held = pillStatusAfter(INITIAL_PILL_STATUS, good, false, Date.now());
    held = pillStatusAfter(held, unreachable, true, Date.now());
    expect(pillFor(held).text).toBe('Remote connection unavailable');

    held = pillStatusAfter(INITIAL_PILL_STATUS, good, false, Date.now());
    held = pillStatusAfter(held, { ready: false, error: 'remote timed out', retry_after_secs: 30 }, false, Date.now());
    expect(held.error).toBe('remote timed out');

    held = pillStatusAfter(INITIAL_PILL_STATUS, good, false, Date.now());
    held = pillStatusAfter(held, { ready: false, error: 'sidecar exited' }, false, Date.now());
    expect(pillFor(held, { remote: false })).toEqual({ tone: 'err', text: 'Node stopped', live: false });
    // No time passed for any of these.
    expect(Date.now() - before).toBe(POLL_MS);
  });

  it('a host cooldown still wins in the pill', () => {
    poll(good);
    const pill = nodePill({ remote: true, retryAfterSecs: 12, ready: held.ready, error: held.error, quiet: held.quiet, statusChecked: true, overview: null, link: 'open', nowMs: Date.now() });
    expect(pill.text).toBe('Remote connection · waiting 12 s');
  });

  it('a late overview read alone does not say not answering while the node answers', () => {
    poll(good);
    vi.advanceTimersByTime(5 * 60_000);
    poll(good);
    expect(pillFor(held, { overviewAt: Date.now() - 5 * 60_000 }).tone).toBe('ok');
    // Without the status poll's answer the overview's age still decides.
    expect(nodePill({ ready: true, error: null, overview: overview(Date.now() - 5 * 60_000), link: 'open', nowMs: Date.now() }).text)
      .toBe('Node not answering');
  });
});
