import { describe, expect, it } from 'vitest';
import { sats, satUnit } from '../src/control/format';
import { sampleRequest } from '../src/control/source';
import {
  applyLive,
  costToSend,
  freshness,
  mergeMessages,
  nodePill,
  trackKey,
  trackOf,
  STALE_AFTER_MS,
} from '../src/control/state';
import type { LiveEvent, Message, NodeOverview, PriceQuote } from '../src/control/types';

const OWN = '1'.repeat(64);
const A = 'a'.repeat(64);
const ROOM = '0f8e2b7a-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
const m = (id: string, sender: string, recipient: string, timestamp: number): Message => ({
  id,
  kind: 0,
  sender,
  recipient,
  timestamp,
  plaintext: id,
  payment_amount_msat: 1000,
});
const live = (message: Message, room_id: string | null = null): LiveEvent => ({ type: 'message', message, room_id });

describe('sats display', () => {
  it('keeps msat precision instead of rounding a price', () => {
    expect(sats(1000)).toBe('1');
    expect(sats(4242)).toBe('4.242');
    expect(sats(1500)).toBe('1.5');
    expect(sats(482_500_000)).toBe('482,500');
    expect(satUnit(1000)).toBe('sat');
    expect(satUnit(2000)).toBe('sats');
    expect(satUnit(1500)).toBe('sats');
  });
});

describe('tracks and live traffic', () => {
  it('files a message under the counterpart, or the room', () => {
    expect(trackOf(m('1', A, OWN, 1), null, OWN)).toEqual({ kind: 'peer', id: A });
    expect(trackOf(m('2', OWN, A.toUpperCase(), 1), null, OWN)).toEqual({ kind: 'peer', id: A });
    expect(trackOf(m('3', A, ROOM, 1), ROOM.toUpperCase(), OWN)).toEqual({ kind: 'room', id: ROOM });
    expect(trackOf(m('4', A, 'broadcast', 1), null, OWN)).toBeNull();
  });

  it('merges history and live traffic once each, oldest first', () => {
    const merged = mergeMessages([m('b', A, OWN, 20), m('a', A, OWN, 10)], [m('b', A, OWN, 20), m('c', A, OWN, 30)]);
    expect(merged.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('counts unread only for closed tracks and only for inbound, new messages', () => {
    const key = trackKey({ kind: 'peer', id: A });
    let s = applyLive({}, {}, null, live(m('1', A, OWN, 1)), OWN);
    expect(s.key).toBe(key);
    expect(s.unread[key]).toBe(1);
    s = applyLive(s.threads, s.unread, null, live(m('1', A, OWN, 1)), OWN);
    expect(s.unread[key]).toBe(1); // replayed after a reconnect: not new
    s = applyLive(s.threads, s.unread, null, live(m('2', OWN, A, 2)), OWN);
    expect(s.unread[key]).toBe(1); // our own send echoed back
    s = applyLive(s.threads, s.unread, key, live(m('3', A, OWN, 3)), OWN);
    expect(s.unread[key]).toBe(1); // open track
    expect(s.threads[key].map((x) => x.id)).toEqual(['1', '2', '3']);
  });

  it('ignores status frames in the stream', () => {
    const s = applyLive({}, {}, null, { type: 'delivery', message_id: 'x', status: 'delivered', reason: null }, OWN);
    expect(s.key).toBeNull();
    expect(s.threads).toEqual({});
  });
});

describe('cost to send', () => {
  const quote = (over: Partial<PriceQuote> = {}): PriceQuote => ({
    kind: 0,
    own_msat: 1000,
    peer_msat: null,
    peer_age_secs: null,
    peer_stale: false,
    ...over,
  });
  const now = 1_000_000_000;

  it("uses the peer's advertised price when the node has it", () => {
    const c = costToSend({ kind: 'peer', id: A }, quote({ peer_msat: 2000, peer_age_secs: 240 }), { name: 'Maya’s', nowMs: now })!;
    expect(c.msat).toBe(2000);
    expect(c.estimate).toBe(false);
    expect(c.basis).toBe('Maya’s price, updated 4 min ago');
  });

  it('never passes our own price off as theirs', () => {
    const c = costToSend({ kind: 'peer', id: A }, quote(), { nowMs: now })!;
    expect(c.msat).toBe(1000);
    expect(c.estimate).toBe(true);
    expect(c.basis).toMatch(/^Estimate from your own price/);
  });

  it('flags a stale peer table as an estimate', () => {
    const c = costToSend({ kind: 'peer', id: A }, quote({ peer_msat: 3000, peer_age_secs: 86400, peer_stale: true }), { nowMs: now })!;
    expect(c.estimate).toBe(true);
    expect(c.basis).toContain('stale');
  });

  it('prices a room message per member, paid separately', () => {
    const c = costToSend({ kind: 'room', id: ROOM }, quote(), { members: 3 })!;
    expect(c.msat).toBe(3000);
    expect(c.basis).toBe('Estimate: 3 members × 1 sat, each paid separately');
  });

  it('has no cost for tracks that send nothing, or before a quote', () => {
    expect(costToSend({ kind: 'ai' }, quote())).toBeNull();
    expect(costToSend({ kind: 'peer', id: A }, null)).toBeNull();
  });
});

describe('node pill and freshness', () => {
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
  const now = 10_000_000;

  it('marks figures older than a minute stale', () => {
    expect(freshness(now - 10_000, now)).toEqual({ label: 'Read 10s ago', stale: false });
    expect(freshness(now - STALE_AFTER_MS - 1, now).stale).toBe(true);
    expect(freshness(null, now).stale).toBe(true);
  });

  it('says what the seat can rely on right now', () => {
    const base = { ready: true, error: null, overview: overview(now), link: 'open' as const, nowMs: now };
    expect(nodePill(base)).toEqual({ tone: 'ok', text: 'Node live', live: true });
    expect(nodePill({ ...base, link: 'closed' }).tone).toBe('warn');
    expect(nodePill({ ...base, overview: overview(now - 5 * 60_000) }).text).toBe('Node not answering');
    expect(nodePill({ ...base, ready: false, overview: null }).text).toBe('Starting node');
    expect(nodePill({ ...base, error: 'boom' }).tone).toBe('err');
  });
});

describe('dev sample mode', () => {
  it('turns on without a host, or on request in dev only', () => {
    expect(sampleRequest('', false, false)).toBe('shell');
    expect(sampleRequest('?sample=first-run', false, true)).toBe('first-run');
    expect(sampleRequest('?mock', true, true)).toBe('shell');
    expect(sampleRequest('', true, true)).toBeNull();
    expect(sampleRequest('?sample', true, false)).toBeNull(); // a release inside the host never samples
  });
});
