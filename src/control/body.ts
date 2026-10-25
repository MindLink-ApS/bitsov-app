import { t as tr } from '../i18n';
// The organism view (O1): the node's physiology as pure functions over real
// readings. Nothing here is simulated. Every figure is a sum or a count of
// loaded tracks, `/ws` events, host refusals, the B2 budget view and `/status`,
// and, when the node advertises them, its own energy read (N1, `energy_v1`) and
// membrane events (N2, `membrane_v1`). An organ with no source says so instead
// of showing a zero. Evidence (N3) is not readable yet; see
// docs/CONTROL_CENTER_ORGANISM.md.

import { isOutgoing, trackOf, trackKey, type Threads } from './state';
import type { ActionError, BudgetView, DoorCard, EnergyBucket, EnergyRead, LiveEvent, MembraneEvent, Message, NodeOverview } from './types';

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
  /** `tracks`: summed here from what the app read (v1). `node`: the node's own ledger (N1). */
  source: 'tracks' | 'node';
  /** 24 hourly buckets from N1, oldest first; a missing hour is a gap. Null before N1. */
  bars: { start_ms: number; bucket_ms: number; buckets: EnergyBucket[] } | null;
  /** N1 hit its row limit: totals are a floor. */
  truncated: boolean;
};

/** Node capabilities the organism view can use, from `/status`. */
export function organismCaps(overview: NodeOverview | null): { energy: boolean; membrane: boolean } {
  const caps = overview?.capabilities ?? [];
  return { energy: caps.includes('energy_v1'), membrane: caps.includes('membrane_v1') };
}

const fromTotals = (t: EnergyRead['totals']): Energy => ({ in_msat: t.in_msat, out_msat: t.out_msat, acts_in: t.in_count, acts_out: t.out_count });

/**
 * Metabolism from the node's own ledger (N1): node-wide, every counterparty,
 * not only the tracks this app opened. The 24 h read gives rows and bars; the
 * 1 h read gives the hour.
 */
export function nodeMetabolism(hour: EnergyRead, day: EnergyRead): Metabolism {
  const rows: EnergyRow[] = day.counterparties.map((c) => ({
    key: `${c.kind}:${c.id}`,
    kind: c.kind,
    id: c.id,
    last_at: 0,
    in_msat: c.in_msat,
    out_msat: c.out_msat,
    acts_in: c.in_count,
    acts_out: c.out_count,
  }));
  rows.sort((a, b) => b.in_msat + b.out_msat - (a.in_msat + a.out_msat) || a.key.localeCompare(b.key));
  return {
    hour: fromTotals(hour.totals),
    day: fromTotals(day.totals),
    rows,
    tracks_read: 0,
    source: 'node',
    bars: { start_ms: day.as_of_ms - 24 * HOUR_MS, bucket_ms: day.bucket_ms, buckets: day.buckets },
    truncated: hour.truncated || day.truncated,
  };
}

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
  return { hour, day, rows: sorted, tracks_read: tracksRead, source: 'tracks', bars: null, truncated: false };
}

// ---- membrane -----------------------------------------------------------------

/** Why one of our sends did not cross: their door, their price, or our own setpoint. */
export type OutboundKind = 'door' | 'price' | 'setpoint';

/** A refusal is outbound (one of the above) or `inbound`: someone refused at our own door (N2). */
export type RefusalKind = OutboundKind | 'inbound';

export type MembraneEntry =
  | {
      seq: number;
      at: number;
      verdict: 'admitted';
      /** Set when the admission was seen as a `/ws` message (v1); the node's own event has none. */
      message_id: string | null;
      /** Verified by the node before it was delivered: a settled payment admitted it. */
      sender: string;
      paid_msat: number | null;
      /** The sender is not in this node's contacts. Never added automatically. */
      first_contact: boolean;
      track: string | null;
      /** The node's own event sequence (N2), for de-duplication. */
      node_seq?: number;
    }
  | {
      seq: number;
      at: number;
      verdict: 'refused';
      kind: RefusalKind;
      /** The recipient's node reason, the host's code, or the node's gate code (N2). */
      code: string;
      detail: string;
      track: string | null;
      /** Inbound only, and only when the node verified the sender before refusing. */
      sender?: string | null;
      /** Inbound: the price the gate stated, and what the envelope carried. */
      required_msat?: number | null;
      paid_msat?: number | null;
      node_seq?: number;
    }
  | {
      seq: number;
      at: number;
      /**
       * Our node paid a contact's admission again after a reconnect (genome
       * #85/#86: a connection starts unpaid). Money left, from their signed quote.
       */
      verdict: 'readmitted';
      counterparty: string;
      paid_msat: number | null;
      /** The contact's budget cap it was paid under; null for the owner's key. */
      cap_msat: number | null;
      track: string;
      node_seq: number;
    };

/** In memory only, never persisted or exported; the oldest entries fall off. */
export const MEMBRANE_KEEP = 200;

let membraneSeq = 0;

// A ring read may finish after newer live events. Order before truncating so
// backfill cannot displace current events; preserve each entry's local identity.
const keep = (log: MembraneEntry[], entry: MembraneEntry) => [entry, ...log]
  .sort((a, b) => b.at - a.at
    || (b.node_seq ?? 0) - (a.node_seq ?? 0)
    || b.seq - a.seq)
  .slice(0, MEMBRANE_KEEP);

/**
 * Fold one `/ws` event into the membrane. An inbound message is an admission
 * (the node delivers only what a settled payment admitted); a delivery the
 * recipient's node rejected is an outbound refusal at their door.
 */
export function membraneLive(
  log: MembraneEntry[],
  event: LiveEvent,
  ctx: { ownId: string; contacts: Set<string>; threads: Threads; nowMs: number; nodeMembrane?: boolean },
): MembraneEntry[] {
  if (event.type === 'message') {
    // With N2 the node reports its own admissions; counting the message too would double them.
    if (ctx.nodeMembrane) return log;
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
      detail: event.reason ?? tr('caNoReasonGiven'),
      track: trackOfMessage(ctx.threads, event.message_id),
    });
  }
  return log;
}

/** Plain words for the node's gate codes (N2). Unknown codes are shown as given. */
export const GATE_WORDS: Record<string, string> = {
  get settled() { return tr('caSettled'); },
  get unpaid() { return tr('caUnpaid'); },
  get insufficient_payment() { return tr('caPaidTooLittle'); },
  get not_settled() { return tr('caPaymentNotSettled'); },
  get settlement_mismatch() { return tr('caPaymentDidNotMatch'); },
  get settlement_unavailable() { return tr('caCouldNotCheckPayment'); },
  get proof_reused() { return tr('caPaymentAlreadyUsed'); },
  get replay() { return tr('caReplay'); },
  get stale() { return tr('caStale'); },
  get bad_signature() { return tr('caBadSignature'); },
  get invalid_envelope() { return tr('caMalformed'); },
  get invite_only() { return tr('caInviteOnly'); },
  get not_priceable() { return tr('caNoPriceForThisKind'); },
  get node_error() { return tr('caNodeCouldNotDecide'); },
  // A reconnect starts every connection unpaid (genome #86): the peer asked
  // for a paid invoice first and was told to pay its way in again.
  get admission_required() { return tr('caAskedToPayAdmissionAgain'); },
  // The node's quote window: a second admission quote came too soon.
  get admission_rate_limited() { return tr('caAskedAgainTooSoon'); },
  // Outbound: we paid a contact's admission again after a reconnect.
  get readmission() { return tr('caAdmittedAgainAfterAReconnect'); },
};

export const gateWords = (code: string) => GATE_WORDS[code] ?? code.replace(/_/g, ' ');

/**
 * Fold one of the node's own membrane events (N2) in. Inbound decisions only:
 * this app already records its own refused sends with their track, and the
 * node's copy of those would count them twice. A refusal names a sender only
 * when the node verified it; an admitted stranger is flagged, never added.
 */
export function membraneNode(log: MembraneEntry[], event: MembraneEvent, ctx: { contacts: Set<string> }): MembraneEntry[] {
  // `seq` restarts at 1 with every node run and carries no run id, so it
  // alone does not identify an event: a restarted node's seq 1 is new. The
  // node's own timestamp tells two runs' events apart.
  if (log.some((e) => e.node_seq === event.seq && e.at === event.at)) return log;
  // The one outbound event this app does not see itself: the node paid a
  // contact's admission again, inside the send, after a reconnect.
  if (event.direction === 'outbound' && event.verdict === 'admitted' && event.code === 'readmission' && event.counterparty) {
    const counterparty = event.counterparty.toLowerCase();
    return keep(log, {
      seq: ++membraneSeq,
      at: event.at,
      verdict: 'readmitted',
      counterparty,
      paid_msat: event.paid_msat,
      cap_msat: event.cap_msat,
      track: `peer:${counterparty}`,
      node_seq: event.seq,
    });
  }
  if (event.direction !== 'inbound') return log;
  const sender = event.counterparty?.toLowerCase() ?? null;
  const track = sender ? `peer:${sender}` : null;
  if (event.verdict === 'admitted' && sender) {
    return keep(log, {
      seq: ++membraneSeq,
      at: event.at,
      verdict: 'admitted',
      message_id: null,
      sender,
      paid_msat: event.paid_msat,
      first_contact: event.first_contact && !ctx.contacts.has(sender),
      track,
      node_seq: event.seq,
    });
  }
  if (event.verdict !== 'refused') return log;
  const need = event.required_msat !== null ? tr('caNeededMsat', event.required_msat) : '';
  return keep(log, {
    seq: ++membraneSeq,
    at: event.at,
    verdict: 'refused',
    kind: 'inbound',
    code: event.code,
    detail: [gateWords(event.code), need].filter(Boolean).join(' · '),
    track,
    sender,
    required_msat: event.required_msat,
    paid_msat: event.paid_msat,
    node_seq: event.seq,
  });
}

/** The node's ring, oldest first, folded into the log (N2 seed on open). */
export function membraneSeed(log: MembraneEntry[], events: MembraneEvent[], ctx: { contacts: Set<string> }): MembraneEntry[] {
  return [...events].sort((a, b) => a.seq - b.seq).reduce((acc, e) => membraneNode(acc, e, ctx), log);
}

/**
 * What the stream shows at the door for one membrane entry, and in which track:
 * a first contact admitted by payment, a verified sender refused at your door,
 * or your send refused at their price or door. Other entries stay in the Body panel.
 */
export function doorCard(entry: MembraneEntry, doorMsat: number | null): { track: string; at: number; card: DoorCard } | null {
  if (!entry.track || entry.verdict === 'readmitted') return null;
  if (entry.verdict === 'admitted') {
    if (!entry.first_contact) return null;
    return { track: entry.track, at: entry.at, card: { side: 'in', verdict: 'admitted', sender: entry.sender, paid_msat: entry.paid_msat, door_msat: doorMsat } };
  }
  if (entry.kind === 'inbound') {
    if (!entry.sender) return null;
    return {
      track: entry.track,
      at: entry.at,
      card: { side: 'in', verdict: 'refused', sender: entry.sender, code: entry.code, required_msat: entry.required_msat ?? null, paid_msat: entry.paid_msat ?? null },
    };
  }
  if (entry.kind === 'price' || (entry.kind === 'door' && entry.code === 'readmission_capped')) {
    return { track: entry.track, at: entry.at, card: { side: 'out', verdict: 'refused', code: entry.code, detail: entry.detail, cap_msat: null } };
  }
  return null;
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
  // Their door wants admission again; no price under the cap can pay it yet.
  if (e.code === 'readmission_capped') return 'door';
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
  refused_by: Record<RefusalKind, number>;
  /** Inbound refusals by the node's gate code (N2), e.g. `{ unpaid: 2, replay: 1 }`. */
  inbound_by: Record<string, number>;
  /** Admissions our node paid again after a reconnect, and what they cost. */
  readmitted: number;
  readmitted_msat: number;
  last_at: number | null;
};

export function membraneSummary(log: MembraneEntry[]): MembraneSummary {
  const s: MembraneSummary = { admitted: 0, admitted_msat: 0, first_contacts: 0, refused: 0, refused_by: { door: 0, price: 0, setpoint: 0, inbound: 0 }, inbound_by: {}, readmitted: 0, readmitted_msat: 0, last_at: null };
  for (const e of log) {
    s.last_at = Math.max(s.last_at ?? 0, e.at);
    if (e.verdict === 'readmitted') {
      s.readmitted += 1;
      s.readmitted_msat += e.paid_msat ?? 0;
    } else if (e.verdict === 'admitted') {
      s.admitted += 1;
      s.admitted_msat += e.paid_msat ?? 0;
      if (e.first_contact) s.first_contacts += 1;
    } else {
      s.refused += 1;
      s.refused_by[e.kind] += 1;
      if (e.kind === 'inbound') s.inbound_by[e.code] = (s.inbound_by[e.code] ?? 0) + 1;
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
  if (link === 'open') return { live: true, label: tr('callLive'), stale: false };
  if (lastAt === null) return { live: false, label: tr('caFeedDownNoReadingYet'), stale: true };
  return { live: false, label: tr('caFeedDownLastReading', ago(lastAt, nowMs)), stale: true };
}
