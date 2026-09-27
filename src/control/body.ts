// The organism view (O1 v1): the node's physiology as pure functions over data
// the app already holds. Nothing here is simulated. Every figure is a sum or a
// count of real readings — loaded tracks, `/ws` events, host refusals, the B2
// budget view, `/status` — and an organ with no source says so instead of
// showing a zero. Node-wide energy (N1), inbound refusals (N2) and evidence
// (N3) are not readable yet; see docs/O1_NODE_FOLLOWUPS.md and docs/CONTROL_CENTER_ORGANISM.md.

import { isOutgoing, trackOf, trackKey, type Threads } from './state';
import type { ActionError, BudgetView, LiveEvent, Message, NodeOverview } from './types';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// ---- metabolism ---------------------------------------------------------------

export type Energy = { in_msat: number; out_msat: number; acts_in: number; acts_out: number };

export type EnergyRow = Energy & { key: string; kind: 'peer' | 'room'; id: string; last_at: number };

export type Metabolism = {
  hour: Energy;
  day: Energy;
  /** Per peer or room over 24 h, most energy first. */
  rows: EnergyRow[];
  /** Tracks whose history the app has read; the rest are not counted. */
  tracks_read: number;
};

const none = (): Energy => ({ in_msat: 0, out_msat: 0, acts_in: 0, acts_out: 0 });

const add = (e: Energy, out: boolean, msat: number) => {
  if (out) {
    e.out_msat += msat;
    e.acts_out += 1;
  } else {
    e.in_msat += msat;
    e.acts_in += 1;
  }
};

/**
 * Sats that crossed in the tracks this app has read, by the message's own
 * timestamp. An outgoing room echo carries one member's share, so what the
 * send actually paid (`paid`, from its receipt) wins when the app has it.
 * Unpaid messages carried no energy and are not acts.
 */
export function metabolism(threads: Threads, ownId: string, nowMs: number, paid: Record<string, number> = {}): Metabolism {
  const hour = none();
  const day = none();
  const rows = new Map<string, EnergyRow>();
  let tracksRead = 0;
  for (const [key, messages] of Object.entries(threads)) {
    const [kind, id] = key.split(':') as ['peer' | 'room', string];
    if ((kind !== 'peer' && kind !== 'room') || !id) continue;
    tracksRead += 1;
    for (const m of messages) {
      const out = isOutgoing(m, ownId);
      const msat = (out ? paid[m.id] : undefined) ?? m.payment_amount_msat ?? 0;
      if (msat <= 0) continue;
      // The shell clock ticks every few seconds, so a message that just arrived
      // (or a sender's clock a little ahead) reads as now, not as not-yet.
      const age = Math.max(0, nowMs - m.timestamp);
      if (age > DAY_MS) continue;
      add(day, out, msat);
      if (age <= HOUR_MS) add(hour, out, msat);
      const row = rows.get(key) ?? { key, kind, id, last_at: 0, ...none() };
      add(row, out, msat);
      row.last_at = Math.max(row.last_at, m.timestamp);
      rows.set(key, row);
    }
  }
  const sorted = [...rows.values()].sort(
    (a, b) => b.in_msat + b.out_msat - (a.in_msat + a.out_msat) || b.last_at - a.last_at || a.key.localeCompare(b.key),
  );
  return { hour, day, rows: sorted, tracks_read: tracksRead };
}

// ---- membrane -----------------------------------------------------------------

/** Why one of our sends did not cross: their door, their price, or our own setpoint. */
export type OutboundKind = 'door' | 'price' | 'setpoint';

export type MembraneEntry =
  | {
      seq: number;
      at: number;
      verdict: 'admitted';
      message_id: string;
      /** Verified by the node before it was delivered: a settled payment admitted it. */
      sender: string;
      paid_msat: number | null;
      /** The sender is not in this node's contacts. Never added automatically. */
      first_contact: boolean;
      track: string | null;
    }
  | {
      seq: number;
      at: number;
      verdict: 'refused';
      kind: OutboundKind;
      /** The recipient's node reason or the host's code, shown as given. */
      code: string;
      detail: string;
      track: string | null;
    };

/** In memory only, never persisted or exported; the oldest entries fall off. */
export const MEMBRANE_KEEP = 200;

let membraneSeq = 0;

const keep = (log: MembraneEntry[], entry: MembraneEntry) => [entry, ...log].slice(0, MEMBRANE_KEEP);

/**
 * Fold one `/ws` event into the membrane. An inbound message is an admission
 * (the node delivers only what a settled payment admitted); a delivery the
 * recipient's node rejected is an outbound refusal at their door.
 */
export function membraneLive(
  log: MembraneEntry[],
  event: LiveEvent,
  ctx: { ownId: string; contacts: Set<string>; threads: Threads; nowMs: number },
): MembraneEntry[] {
  if (event.type === 'message') {
    if (isOutgoing(event.message, ctx.ownId)) return log;
    // `/ws` can repeat a message after a reconnect: one message, one admission.
    if (log.some((e) => e.verdict === 'admitted' && e.message_id === event.message.id)) return log;
    const sender = event.message.sender.toLowerCase();
    const track = trackOf(event.message, event.room_id, ctx.ownId);
    return keep(log, {
      seq: ++membraneSeq,
      at: ctx.nowMs,
      verdict: 'admitted',
      message_id: event.message.id,
      sender,
      paid_msat: event.message.payment_amount_msat,
      first_contact: !ctx.contacts.has(sender),
      track: track ? trackKey(track) : null,
    });
  }
  if (event.type === 'delivery' && event.status === 'rejected') {
    return keep(log, {
      seq: ++membraneSeq,
      at: ctx.nowMs,
      verdict: 'refused',
      kind: 'door',
      code: 'rejected',
      detail: event.reason ?? 'no reason given',
      track: trackOfMessage(ctx.threads, event.message_id),
    });
  }
  return log;
}

function trackOfMessage(threads: Threads, id: string): string | null {
  for (const [key, messages] of Object.entries(threads)) {
    if (messages.some((m: Message) => m.id === id)) return key;
  }
  return null;
}

/** Which host refusals are the membrane's business. Asks (first contact, approval) are not refusals. */
export function outboundKind(e: ActionError): OutboundKind | null {
  if (e.code === 'price_changed' || e.code === 'price_cap_exceeded') return 'price';
  if (['budget_paused', 'budget_exhausted', 'ceiling_exhausted'].includes(e.code)) return 'setpoint';
  if (e.code.startsWith('grant_') && e.code !== 'grant_unknown') return 'setpoint';
  return null;
}

/** Fold a refused send in, if it is a refusal and not a question for the owner. */
export function membraneRefused(log: MembraneEntry[], error: ActionError, track: string | null, nowMs: number): MembraneEntry[] {
  const kind = outboundKind(error);
  if (!kind) return log;
  return keep(log, { seq: ++membraneSeq, at: nowMs, verdict: 'refused', kind, code: error.code, detail: error.message, track });
}

export type MembraneSummary = {
  admitted: number;
  admitted_msat: number;
  first_contacts: number;
  refused: number;
  refused_by: Record<OutboundKind, number>;
  last_at: number | null;
};

export function membraneSummary(log: MembraneEntry[]): MembraneSummary {
  const s: MembraneSummary = { admitted: 0, admitted_msat: 0, first_contacts: 0, refused: 0, refused_by: { door: 0, price: 0, setpoint: 0 }, last_at: null };
  for (const e of log) {
    s.last_at = Math.max(s.last_at ?? 0, e.at);
    if (e.verdict === 'admitted') {
      s.admitted += 1;
      s.admitted_msat += e.paid_msat ?? 0;
      if (e.first_contact) s.first_contacts += 1;
    } else {
      s.refused += 1;
      s.refused_by[e.kind] += 1;
    }
  }
  return s;
}

// ---- homeostasis --------------------------------------------------------------

export type Setpoint = { target: string; room: boolean; limit_msat: number; spent_msat: number };

export type Homeostasis =
  | { state: 'unknown' }
  | { state: 'paused'; spent_msat: number; ceiling_msat: number; rows: Setpoint[] }
  | { state: 'waiting'; spent_msat: number; ceiling_msat: number; rows: Setpoint[] }
  /** No approval in force: paid sends ask each time. */
  | { state: 'none'; expired: boolean; rows: Setpoint[] }
  | {
      state: 'holding';
      spent_msat: number;
      ceiling_msat: number;
      unsettled_msat: number;
      until_ms: number | null;
      rows: Setpoint[];
      /** The node's own G1 grant around the app's setpoints, when it reports one. */
      grant: { remaining_msat: number; budget_msat: number; expires_at_ms: number } | null;
      /** Setpoints that are reached: the next message there rests until older spends pass 24 h. */
      reached: Setpoint[];
    };

/** B2 budgets as setpoints the body holds, inside the node's grant when G1 reports one. */
export function homeostasis(view: BudgetView | null): Homeostasis {
  if (!view) return { state: 'unknown' };
  const rows: Setpoint[] = view.rows
    .filter((r) => r.limit_msat !== null)
    .map((r) => ({ target: r.target, room: r.room, limit_msat: r.limit_msat!, spent_msat: r.spent_msat }))
    .sort((a, b) => b.spent_msat / b.limit_msat - a.spent_msat / a.limit_msat || b.spent_msat - a.spent_msat);
  const ceiling = Math.min(view.autopay.ceiling_msat ?? view.ceiling_msat, view.ceiling_msat);
  if (view.paused) return { state: 'paused', spent_msat: view.spent_msat, ceiling_msat: ceiling, rows };
  if (view.waiting_for_owner) return { state: 'waiting', spent_msat: view.spent_msat, ceiling_msat: ceiling, rows };
  if (view.autopay.state !== 'open') return { state: 'none', expired: view.autopay.state === 'expired', rows };
  const g = view.node_grant;
  return {
    state: 'holding',
    spent_msat: view.spent_msat,
    ceiling_msat: ceiling,
    unsettled_msat: view.unsettled_msat,
    until_ms: view.autopay.open_until_ms,
    rows,
    grant: g ? { remaining_msat: g.remaining_msat, budget_msat: g.budget_msat, expires_at_ms: g.expires_at_ms } : null,
    reached: rows.filter((r) => r.spent_msat >= r.limit_msat),
  };
}

// ---- nucleus ------------------------------------------------------------------

export type Nucleus = {
  node_id: string | null;
  block_height: number | null;
  chain_backend: string | null;
  read_at: number | null;
};

/** Keys (who this cell is), then the timechain (what time it is). */
export function nucleus(ownId: string | null, overview: NodeOverview | null): Nucleus {
  return {
    node_id: ownId || overview?.node_id || null,
    block_height: overview?.block_height ?? null,
    chain_backend: overview?.chain_backend ?? null,
    read_at: overview?.read_at ?? null,
  };
}

// ---- feed honesty -------------------------------------------------------------

export type Feed = { live: boolean; label: string; stale: boolean };

/**
 * Organs fed by `/ws` are current while the socket is open. When it is not,
 * they keep their last reading and say how old it is; they are never zeroed.
 */
export function feedState(link: 'connecting' | 'open' | 'closed' | null, lastAt: number | null, nowMs: number, ago: (t: number, n: number) => string): Feed {
  if (link === 'open') return { live: true, label: 'Live', stale: false };
  if (lastAt === null) return { live: false, label: 'Feed down, no reading yet', stale: true };
  return { live: false, label: `Feed down · last reading ${ago(lastAt, nowMs)}`, stale: true };
}
