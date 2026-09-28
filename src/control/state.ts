// Control-center state as pure functions over plain data, so the rules are
// testable without a window: which track a live message belongs to, how history
// and live traffic merge, what a send would cost and on what basis, and how
// fresh the node's figures are.

import { ago, sats, satUnit, shortId } from './format';
import type {
  ActionError,
  AdmissionPrice,
  Undelivered,
  BudgetView,
  Artifact,
  Delivery,
  LinkState,
  LiveEvent,
  Message,
  NodeOverview,
  Peer,
  PriceQuote,
  RoomQuote,
  SendReceipt,
  SpendView,
  TrackRef,
} from './types';

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

/** The node floors every message payment at one sat. */
export const MIN_PAYMENT_MSAT = 1000;

/** First contact pays the recipient's admission price, which the node caps here. */
export const ADMISSION_MAX_MSAT = 100_000;

/**
 * What one text message on this track costs before it is sent. The recipient
 * sets the price; when the node has not cached the peer's table the figure is
 * this node's own price, labelled as an estimate — never passed off as theirs.
 * A room costs the sum of each member's own price, from `room_quote`.
 */
export function costToSend(
  track: TrackRef,
  quote: PriceQuote | null,
  opts: { name?: string; room?: RoomQuote | null; nowMs?: number } = {},
): Cost | null {
  if (track.kind === 'peer') {
    if (!quote) return null;
    if (quote.peer_msat !== null && !quote.peer_stale) {
      const age = quote.peer_age_secs ?? 0;
      const when = ago((opts.nowMs ?? Date.now()) - age * 1000, opts.nowMs ?? Date.now());
      return {
        msat: Math.max(quote.peer_msat, MIN_PAYMENT_MSAT),
        basis: quote.peer_stale
          ? `${opts.name ?? 'Their'} price, from a stale table (${when})`
          : `${opts.name ?? 'Their'} price, updated ${when}`,
        estimate: quote.peer_stale,
      };
    }
    return {
      msat: Math.max(quote.own_msat, MIN_PAYMENT_MSAT),
      basis: quote.peer_stale ? 'Estimate from your own price; the peer table is stale' : `Estimate from your own price; ${opts.name ?? 'this peer'} has not shared theirs yet`,
      estimate: true,
    };
  }
  if (track.kind === 'room') {
    const room = opts.room;
    if (!room) return null;
    const n = room.members.length;
    const own = room.members.filter((m) => !m.advertised).length;
    return {
      msat: room.total_msat,
      basis:
        `${n} ${n === 1 ? 'member' : 'members'}, each paid their own price` +
        (own > 0 ? `; ${own} estimated from yours` : ''),
      estimate: room.estimate,
    };
  }
  return null;
}

/** Any rejection from the host, as an action error. */
export function asActionError(e: unknown): ActionError {
  if (e && typeof e === 'object' && 'code' in e && 'message' in e) {
    const { code, message, undelivered, admission, pending_id } = e as ActionError;
    const out: ActionError = { code, message: String(message) };
    if (typeof pending_id === 'string' && pending_id) out.pending_id = pending_id;
    if (undelivered && msat(undelivered.paid_msat)) out.undelivered = { paid_msat: undelivered.paid_msat, retry: undelivered.retry === true };
    if (admission && msat(admission.admission_msat) && msat(admission.message_msat) && msat(admission.total_msat)
      && admission.total_msat === admission.admission_msat + admission.message_msat) {
      out.admission = { admission_msat: admission.admission_msat, message_msat: admission.message_msat, total_msat: admission.total_msat, quoted: admission.quoted === true };
    }
    return out;
  }
  return { code: 'node', message: typeof e === 'string' ? e : String((e as Error)?.message ?? e) };
}

const msat = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;

/**
 * Paid, not delivered (node 502 `payment_settled_send_incomplete`). Never "not
 * sent", never "send again": a second send could pay twice.
 */
export function undeliveredCopy(u: Undelivered): { title: string; body: string } {
  const paid = `${sats(u.paid_msat)} ${satUnit(u.paid_msat)}`;
  return {
    title: `Paid ${paid} · not delivered yet`,
    body: u.retry
      ? 'Payment settled, message not yet delivered. Do not send it again. Retry delivery pays nothing new: your node re-sends the proof it already paid for. If anything is still due (this message’s price, or admission again after a reconnect), it stops before paying and asks you first, with the price.'
      : 'Payment settled, message not yet delivered. Do not send it again: that could pay twice. Check the pending result before sending anything else.',
  };
}

/** The approval a paid, undelivered message needs once Retry delivery paid nothing new. Nothing is paid until the owner approves. */
export function admissionCopy(a: AdmissionPrice): { body: string; action: string } {
  const s = (m: number) => `${sats(m)} ${satUnit(m)}`;
  return {
    body: a.quoted
      ? `Delivering it needs a new payment. Their price: ${s(a.admission_msat)} to be admitted again, then ${s(a.message_msat)} for this message. If your node is still admitted, it pays only the message.`
      : `Delivering it needs a new payment: this message’s ${s(a.message_msat)}, and about ${s(a.admission_msat)} (what admission cost before) if the contact asks for it again. Your node refuses before paying if the real price is higher.`,
    action: `Approve up to ${s(a.total_msat)} and retry`,
  };
}

/** Errors that mean "the owner must approve (again)", not "the send failed". */
export const needsApproval = (e: ActionError) =>
  e.code === 'spend_locked' || e.code === 'spend_expired';

/** The host stopped a message on a budget rule: explain in the composer, not as a failed send. */
export const isBudgetStop = (e: ActionError) =>
  ['budget_paused', 'budget_exhausted', 'ceiling_exhausted', 'first_contact', 'budget_needed'].includes(e.code) || isGrantStop(e);

/** A G1 node refused under its spend grant before any payment. Nothing was sent. */
export const isGrantStop = (e: ActionError) => e.code.startsWith('grant_');

/** Where one track stands against its budget and the daily total, before sending. */
export type BudgetStand =
  | { kind: 'unknown' }
  | { kind: 'paused' }
  | { kind: 'waiting' }
  | { kind: 'off' }
  | { kind: 'first'; suggest: number; ceiling: number; again?: boolean }
  | { kind: 'contact_used'; limit: number; spent: number; raiseTo: number | null }
  | { kind: 'total_used'; ceiling: number; spent: number; raiseTo: number | null }
  | { kind: 'ok'; limit: number; spent: number; ceiling: number; totalSpent: number };

/**
 * `readmit`: the node asked the owner's OK to admit this known contact again
 * after a reconnect (its grant does not budget them yet). The door card comes
 * back once, with their budget as it stands.
 */
export function budgetStand(view: BudgetView | null, target: string, room: boolean, costMsat: number | null, readmit = false): BudgetStand {
  if (!view) return { kind: 'unknown' };
  if (view.paused) return { kind: 'paused' };
  if (view.waiting_for_owner) return { kind: 'waiting' };
  if (view.autopay.state !== 'open') return { kind: 'off' };
  const cost = costMsat ?? 0;
  const ceiling = Math.min(view.autopay.ceiling_msat ?? 0, view.ceiling_msat);
  const row = view.rows.find((r) => r.target === target.toLowerCase() && r.room === room);
  const preset = view.presets.find((p) => p.id === view.preset) ?? view.presets[0];
  if (!row || row.limit_msat === null) {
    const suggest = Math.min(Math.max(room ? preset?.room_msat ?? 0 : preset?.contact_msat ?? 0, cost), ceiling);
    return { kind: 'first', suggest, ceiling };
  }
  if (readmit && !room) return { kind: 'first', suggest: Math.min(row.limit_msat, ceiling), ceiling, again: true };
  if (row.spent_msat + cost > row.limit_msat) {
    const want = Math.max(row.limit_msat * 2, row.spent_msat + cost);
    return { kind: 'contact_used', limit: row.limit_msat, spent: row.spent_msat, raiseTo: want <= ceiling ? want : ceiling > row.limit_msat ? ceiling : null };
  }
  if (view.spent_msat + cost > ceiling) {
    const want = Math.min(Math.max(ceiling * 2, view.spent_msat + cost), view.max_daily_msat);
    return { kind: 'total_used', ceiling, spent: view.spent_msat, raiseTo: want > ceiling ? want : null };
  }
  return { kind: 'ok', limit: row.limit_msat, spent: row.spent_msat, ceiling, totalSpent: view.spent_msat };
}

/** A budget in the recipient's own price as the unit: "about 25 messages". */
export function messagesWorth(budgetMsat: number, priceMsat: number | null): string | null {
  if (!priceMsat || priceMsat <= 0) return null;
  const n = Math.floor(budgetMsat / priceMsat);
  return `${n} message${n === 1 ? '' : 's'}`;
}

export type Deliveries = Record<string, Delivery>;

/** A send's first status, from the node's reply. */
export const deliveryFromReceipt = (r: { delivered: boolean }): Delivery =>
  r.delivered ? { status: 'sent', reason: null } : { status: 'queued', reason: null };

/** Fold a `/ws` delivery event in. The recipient's node decides; its reason is shown as sent. */
export function applyDelivery(deliveries: Deliveries, event: LiveEvent): Deliveries {
  if (event.type !== 'delivery') return deliveries;
  const status = event.status === 'delivered' ? 'delivered' : event.status === 'rejected' ? 'rejected' : null;
  if (!status) return deliveries;
  return { ...deliveries, [event.message_id]: { status, reason: status === 'rejected' ? event.reason ?? 'no reason given' : null } };
}

/** The message a send just produced, shown until `/ws` echoes the real one. */
export function sentMessage(receipt: SendReceipt, ownId: string, plaintext: string): Message {
  return {
    id: receipt.message_id,
    kind: 0,
    sender: ownId,
    recipient: receipt.recipient,
    timestamp: receipt.sent_at_ms,
    plaintext,
    payment_amount_msat: receipt.amount_msat,
  };
}

export type StreamItem = { type: 'message'; at: number; message: Message } | { type: 'artifact'; at: number; artifact: Artifact };

/** How far back a first-contact door card reaches for the message it admitted (sender clocks drift). */
const DOOR_REACH_MS = 10 * 60_000;

/** Messages and this track's artifacts, in time order. */
export function streamItems(messages: Message[], artifacts: Artifact[]): StreamItem[] {
  // A first contact's door card stands just before the stranger's first message
  // near it, whichever clock (theirs on the message, the node's on the card) is earlier.
  const sortAt = (a: Artifact) => {
    if (a.type !== 'door' || a.door.side !== 'in' || a.door.verdict !== 'admitted') return a.at;
    const sender = a.door.sender;
    const theirs = messages.filter((m) => m.sender.toLowerCase() === sender && Math.abs(m.timestamp - a.at) <= DOOR_REACH_MS).map((m) => m.timestamp);
    return Math.min(a.at, ...theirs) - 0.5;
  };
  const items: (StreamItem & { key: number })[] = [
    ...messages.map((message) => ({ type: 'message' as const, at: message.timestamp, key: message.timestamp, message })),
    ...artifacts.map((artifact) => ({ type: 'artifact' as const, at: artifact.at, key: sortAt(artifact), artifact })),
  ];
  return items.sort((a, b) => a.key - b.key).map(({ key: _key, ...item }) => item as StreamItem);
}

/** The composer's spend line. */
export function spendLine(view: SpendView | null, nowMs: number): { open: boolean; text: string } {
  if (!view) return { open: false, text: 'Checking spending approval…' };
  switch (view.state) {
    case 'open': {
      const left = Math.max(0, Math.ceil(((view.open_until_ms ?? nowMs) - nowMs) / 60_000));
      return { open: left > 0, text: `Spending approved, ${left} min left` };
    }
    case 'pending':
      return { open: false, text: 'Waiting for your approval at the node' };
    case 'unavailable':
      return { open: false, text: 'This node cannot grant spending to the app' };
    case 'expired':
      return { open: false, text: 'Spending approval expired' };
    default:
      return { open: false, text: 'Spending needs your approval' };
  }
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
