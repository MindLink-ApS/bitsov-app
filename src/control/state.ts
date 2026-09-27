// Control-center state as pure functions over plain data, so the rules are
// testable without a window: which track a live message belongs to, how history
// and live traffic merge, what a send would cost and on what basis, and how
// fresh the node's figures are.

import { ago, sats, satUnit, shortId } from './format';
import type { LinkState, LiveEvent, Message, NodeOverview, Peer, PriceQuote, TrackRef } from './types';

export type Threads = Record<string, Message[]>;
export type Unread = Record<string, number>;

export const trackKey = (t: TrackRef): string =>
  t.kind === 'peer' || t.kind === 'room' ? `${t.kind}:${t.id.toLowerCase()}` : t.kind;

export const peerName = (peer: Peer | undefined, id: string): string =>
  peer?.label?.trim() || shortId(id);

/** History + live, deduplicated by id, oldest first. */
export function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const m of existing) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
}

/** The track a live message belongs to. Broadcasts have no track. */
export function trackOf(message: Message, roomId: string | null, ownId: string): TrackRef | null {
  if (roomId) return { kind: 'room', id: roomId.toLowerCase() };
  if (message.recipient === 'broadcast') return null;
  const own = ownId.toLowerCase();
  const counterpart = message.sender.toLowerCase() === own ? message.recipient : message.sender;
  return { kind: 'peer', id: counterpart.toLowerCase() };
}

export const isOutgoing = (m: Message, ownId: string) => m.sender.toLowerCase() === ownId.toLowerCase();

/**
 * Fold one live event into the threads. A message for a track that is not open
 * bumps its unread count; the open track stays at zero.
 */
export function applyLive(
  threads: Threads,
  unread: Unread,
  openKey: string | null,
  event: LiveEvent,
  ownId: string,
): { threads: Threads; unread: Unread; key: string | null } {
  if (event.type !== 'message') return { threads, unread, key: null };
  const track = trackOf(event.message, event.room_id, ownId);
  if (!track) return { threads, unread, key: null };
  const key = trackKey(track);
  const before = threads[key] ?? [];
  const after = mergeMessages(before, [event.message]);
  const isNew = after.length > before.length;
  const bump = isNew && key !== openKey && !isOutgoing(event.message, ownId);
  return {
    threads: { ...threads, [key]: after },
    unread: bump ? { ...unread, [key]: (unread[key] ?? 0) + 1 } : unread,
    key,
  };
}

export type Cost = {
  msat: number;
  /** Plain-language source of the figure, shown under it. */
  basis: string;
  /** True when the figure is not the recipient's own advertised price. */
  estimate: boolean;
};

/**
 * What one text message on this track costs before it is sent. The recipient
 * sets the price; when the node has not cached the peer's table the figure is
 * this node's own price, labelled as an estimate — never passed off as theirs.
 */
export function costToSend(
  track: TrackRef,
  quote: PriceQuote | null,
  opts: { name?: string; members?: number; nowMs?: number } = {},
): Cost | null {
  if (!quote) return null;
  if (track.kind === 'peer') {
    if (quote.peer_msat !== null) {
      const age = quote.peer_age_secs ?? 0;
      const when = ago((opts.nowMs ?? Date.now()) - age * 1000, opts.nowMs ?? Date.now());
      return {
        msat: quote.peer_msat,
        basis: quote.peer_stale
          ? `${opts.name ?? 'Their'} price, from a stale table (${when})`
          : `${opts.name ?? 'Their'} price, updated ${when}`,
        estimate: quote.peer_stale,
      };
    }
    return {
      msat: quote.own_msat,
      basis: `Estimate from your own price; ${opts.name ?? 'this peer'} has not shared theirs yet`,
      estimate: true,
    };
  }
  if (track.kind === 'room') {
    const n = Math.max(0, opts.members ?? 0);
    return {
      msat: quote.own_msat * n,
      basis: `Estimate: ${n} ${n === 1 ? 'member' : 'members'} × ${sats(quote.own_msat)} ${satUnit(quote.own_msat)}, each paid separately`,
      estimate: true,
    };
  }
  return null;
}

/** Figures older than this are marked stale in the panels. */
export const STALE_AFTER_MS = 60_000;

export function freshness(readAt: number | null, nowMs: number): { label: string; stale: boolean } {
  if (readAt === null) return { label: 'Not read yet', stale: true };
  return { label: `Read ${ago(readAt, nowMs)}`, stale: nowMs - readAt > STALE_AFTER_MS };
}

export type Pill = { tone: 'ok' | 'warn' | 'err' | 'idle'; text: string; live: boolean };

/** The rail's node pill: one glance at whether this seat is connected to its node. */
export function nodePill(input: {
  ready: boolean;
  error: string | null;
  overview: NodeOverview | null;
  link: LinkState | null;
  nowMs: number;
}): Pill {
  if (input.error) return { tone: 'err', text: 'Node stopped', live: false };
  if (!input.ready) return { tone: 'idle', text: 'Starting node', live: false };
  if (!input.overview) return { tone: 'ok', text: 'Node running', live: false };
  if (freshness(input.overview.read_at, input.nowMs).stale) {
    return { tone: 'warn', text: 'Node not answering', live: false };
  }
  if (input.link === 'open') return { tone: 'ok', text: 'Node live', live: true };
  return { tone: 'warn', text: 'Node up, live feed reconnecting', live: false };
}
