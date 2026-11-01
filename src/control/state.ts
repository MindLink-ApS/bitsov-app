import { t as tr } from '../i18n';
import { t, possessive } from '../i18n';
import { MONEY_NOT_READY, readinessLine } from './readiness';
import { feeCeiling } from './format';
// Control-center state as pure functions over plain data, so the rules are
// testable without a window: which track a live message belongs to, how history
// and live traffic merge, what a send would cost and on what basis, and how
// fresh the node's figures are.

import { ago, sats, satUnit, shortId } from './format';
import { contactRevision, petnameOf } from './petnames';
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
  NodeGrantSummary,
  NodeOverview,
  Peer,
  PriceQuote,
  RoomQuote,
  FileReceipt,
  SendReceipt,
  SpendView,
  TrackRef,
} from './types';

export type Threads = Record<string, Message[]>;
export type Unread = Record<string, number>;

export const trackKey = (t: TrackRef): string =>
  t.kind === 'peer' || t.kind === 'room' || t.kind === 'bound' || t.kind === 'assistant' ? `${t.kind}:${t.id.toLowerCase()}` : t.kind;

/**
 * Display name for a contact: the owner's local petname, else Unnamed contact plus a short id.
 * Remote profile names live in {@link claimedName} only — never as the rail title.
 */
export const peerName = (peer: Peer | undefined, id: string): string => {
  contactRevision();
  const pet = petnameOf(id);
  if (pet) return pet;
  return t('extraUnnamedContact', shortId(id));
};

/** Remote-supplied name (peer label / profile card). Suggestion only — never truth. */
export const claimedName = (peer: Peer | undefined): string | null => {
  const n = peer?.label?.trim();
  return n || null;
};

/** History + live, deduplicated by id, oldest first. */
export function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const m of existing) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
}

/** Porch protocol payloads belong to the page reader, never to a conversation. */
export const isPorchKind = (kind: number): boolean => kind === 500 || kind === 501 || kind === 510;

/** The track a live message belongs to. Broadcasts and Porch traffic have no chat track. */
export function trackOf(message: Message, roomId: string | null, ownId: string): TrackRef | null {
  if (isPorchKind(message.kind)) return null;
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
 * The parts of a peer message ceiling, for display only. Returned only when the
 * peer's own fresh price plus the routing allowance is exactly the ceiling the
 * composer shows; any other case (estimate, stale table, door or readmission
 * price, rooms) has no breakdown, so nothing is shown rather than a guess.
 */
export function priceBreakdown(
  quote: PriceQuote | null,
  ceilingMsat: number | null,
): { priceMsat: number; routingMsat: number; ceilingMsat: number } | null {
  if (!quote || ceilingMsat === null || quote.peer_msat === null || quote.peer_stale) return null;
  const routing = quote.max_routing_fee_msat;
  if (!Number.isSafeInteger(quote.peer_msat) || quote.peer_msat < 0) return null;
  if (routing === undefined || !Number.isSafeInteger(routing) || routing < 0) return null;
  const price = Math.max(quote.peer_msat, MIN_PAYMENT_MSAT);
  if (price + routing !== ceilingMsat) return null;
  return { priceMsat: price, routingMsat: routing, ceilingMsat };
}

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
        msat: Math.max(quote.peer_msat, MIN_PAYMENT_MSAT) + (quote.max_routing_fee_msat ?? 0),
        basis: opts.name === undefined
          ? t('extraTheirPriceUpdated', when, feeCeiling(quote.max_routing_fee_msat ?? 0))
          : t('extraPriceUpdated', possessive(opts.name), when, feeCeiling(quote.max_routing_fee_msat ?? 0)),
        estimate: quote.peer_stale,
      };
    }
    return {
      msat: Math.max(quote.own_msat, MIN_PAYMENT_MSAT) + (quote.max_routing_fee_msat ?? 0),
      basis: (quote.peer_stale ? t('extraEstimateFromYourOwnPriceThePeerTable') : t('extraEstimateFromYourOwnPriceHasNotShared', opts.name ?? t('extraThisPeer'))) + `; ${feeCeiling(quote.max_routing_fee_msat ?? 0)}`,
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
        t('extraEachPaidTheirOwnPrice', n, n === 1 ? t('member') : t('members')) +
        (own > 0 ? t('extraEstimatedFromYours', own) : '') + t('extraAcrossAllMembers', feeCeiling(room.max_routing_fee_msat ?? 0)),
      estimate: room.estimate,
    };
  }
  return null;
}

/** Only typed peer refusals (or the host's canonical quote error) get this copy. */
export function peerNotReadyMessage(error: unknown, name: string): string | null {
  let reason: unknown;
  if (error && typeof error === 'object' && 'code' in error && error.code === 'peer_not_ready') {
    reason = 'reason' in error ? error.reason : undefined;
  } else if (typeof error === 'string' && error.startsWith('peer_not_ready:')) {
    reason = error.slice('peer_not_ready:'.length);
  }
  return reason === 'chain_unavailable' || reason === 'not_synced'
    ? t('extraSNodeIsnTReadyToReceiveYet', possessive(name))
    : null;
}

/** Any rejection from the host, as an action error. */
export function asActionError(e: unknown): ActionError {
  if (e === MONEY_NOT_READY) return { code: 'not_ready', message: MONEY_NOT_READY };
  if (e && typeof e === 'object' && 'code' in e && 'message' in e) {
    const { code, message, undelivered, admission, pending_id, reason, remaining_msat, operation_id } = e as ActionError;
    // A raw node refusal with start flags (owner approvals off) is never shown as-is.
    const plain = /owner_approval_unavailable/.test(String(message)) ? tr('caOwnerApprovalUnavailable') : String(message);
    const out: ActionError = { code, message: code === 'not_ready' ? MONEY_NOT_READY : plain };
    if (typeof pending_id === 'string' && pending_id) out.pending_id = pending_id;
    if (typeof operation_id === 'string' && operation_id) out.operation_id = operation_id;
    // Owner approval refusals: only the node's known reasons, and an amount that is one.
    if (typeof reason === 'string' && APPROVAL_OFF_REASONS.has(reason)) out.reason = reason;
    if (msat(remaining_msat)) out.remaining_msat = remaining_msat;
    if (undelivered && msat(undelivered.paid_msat)) out.undelivered = { paid_msat: undelivered.paid_msat, retry: undelivered.retry === true };
    if (admission && msat(admission.admission_msat) && msat(admission.message_msat) && msat(admission.total_msat)
      && msat(admission.max_routing_fee_msat ?? 0)
      && admission.total_msat === admission.admission_msat + admission.message_msat + (admission.max_routing_fee_msat ?? 0)) {
      out.admission = { admission_msat: admission.admission_msat, message_msat: admission.message_msat, max_routing_fee_msat: admission.max_routing_fee_msat ?? 0, total_msat: admission.total_msat, quoted: admission.quoted === true };
    }
    return out;
  }
  return { code: 'node', message: typeof e === 'string' ? e : String((e as Error)?.message ?? e) };
}

const msat = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const APPROVAL_OFF_REASONS = new Set(['seed_not_encrypted', 'seed_password_not_typed', 'owner_key_unavailable']);

/**
 * Paid, not delivered (node 502 `payment_settled_send_incomplete`). Never "not
 * sent", never "send again": a second send could pay twice.
 */
export function undeliveredCopy(u: Undelivered): { title: string; body: string; detail: string } {
  const paid = `${sats(u.paid_msat)} ${satUnit(u.paid_msat)}`;
  return {
    title: t('undeliveredTitle', paid),
    body: t(u.retry ? 'undeliveredRetryBody' : 'undeliveredStopBody'),
    detail: t(u.retry ? 'undeliveredRetryDetail' : 'undeliveredStopDetail'),
  };
}

/** The approval a paid, undelivered message needs once Retry delivery paid nothing new. Nothing is paid until the owner approves. */
export function admissionCopy(a: AdmissionPrice): { body: string; detail: string; action: string } {
  const s = (m: number) => `${sats(m)} ${satUnit(m)}`;
  return {
    body: t(a.quoted ? 'admissionQuotedBody' : 'admissionEstimatedBody', s(a.total_msat)),
    detail: a.quoted
      ? t('admissionQuotedDetail', s(a.admission_msat), s(a.message_msat), s(a.max_routing_fee_msat ?? 0), s(a.total_msat))
      : t('admissionEstimatedDetail', s(a.message_msat), s(a.admission_msat), s(a.max_routing_fee_msat ?? 0), s(a.total_msat)),
    action: t('admissionAction', s(a.total_msat)),
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
  | { kind: 'grant_limited' }
  | { kind: 'first'; suggest: number; ceiling: number; again?: boolean }
  | { kind: 'contact_used'; limit: number; spent: number; raiseTo: number | null }
  | { kind: 'total_used'; ceiling: number; spent: number; raiseTo: number | null }
  | { kind: 'ok'; limit: number; spent: number; ceiling: number; totalSpent: number };

/**
 * `readmit`: the node asked the owner's OK to admit this known contact again
 * after a reconnect (its grant does not budget them yet). The door card comes
 * back once, with their budget as it stands.
 */
/**
 * The grant's cap on each non-call payment (messages, files, rooms and
 * payments), as the host reports it: at most 6 sats, whatever per-payment
 * limit the owner signed. A summary without the field is read from the signed value.
 */
export const messagePerPaymentMax = (grant: NodeGrantSummary): number =>
  grant.message_per_payment_max_msat ?? grant.per_call_max_msat;

export function budgetStand(view: BudgetView | null, target: string, room: boolean, costMsat: number | null, readmit = false): BudgetStand {
  if (!view) return { kind: 'unknown' };
  if (view.paused) return { kind: 'paused' };
  if (view.waiting_for_owner) return { kind: 'waiting' };
  if (view.autopay.state !== 'open') return { kind: 'off' };
  const cost = costMsat ?? 0;
  const grant = view.node_grant;
  if (grant && (grant.remaining_msat === 0 || messagePerPaymentMax(grant) === 0 || cost > grant.remaining_msat || cost > messagePerPaymentMax(grant))) {
    return { kind: 'grant_limited' };
  }
  const ceiling = Math.min(view.autopay.ceiling_msat ?? 0, view.ceiling_msat);
  const row = view.rows.find((r) => r.target === target.toLowerCase() && r.room === room);
  const preset = view.presets.find((p) => p.id === view.preset) ?? view.presets[0];
  if (!row || row.limit_msat === null) {
    const suggest = Math.min(Math.max(room ? preset?.room_msat ?? 0 : preset?.contact_msat ?? 0, cost), ceiling);
    return { kind: 'first', suggest, ceiling };
  }
  if (readmit && !room) return { kind: 'first', suggest: Math.min(row.limit_msat, ceiling), ceiling, again: true };
  const rowAccounted = row.accounted_msat ?? row.spent_msat + (row.unsettled_msat ?? 0);
  const totalAccounted = view.accounted_msat ?? view.spent_msat + view.unsettled_msat;
  if (rowAccounted + cost > row.limit_msat) {
    const want = Math.max(row.limit_msat * 2, rowAccounted + cost);
    return { kind: 'contact_used', limit: row.limit_msat, spent: row.spent_msat, raiseTo: want <= ceiling ? want : ceiling > row.limit_msat ? ceiling : null };
  }
  if (totalAccounted + cost > ceiling) {
    const want = Math.min(Math.max(ceiling * 2, totalAccounted + cost), view.max_daily_msat);
    return { kind: 'total_used', ceiling, spent: view.spent_msat, raiseTo: want > ceiling ? want : null };
  }
  return { kind: 'ok', limit: row.limit_msat, spent: row.spent_msat, ceiling, totalSpent: view.spent_msat };
}

/** A budget in the recipient's own price as the unit: "about 25 messages". */
export function messagesWorth(budgetMsat: number, priceMsat: number | null): string | null {
  if (!priceMsat || priceMsat <= 0) return null;
  const n = Math.floor(budgetMsat / priceMsat);
  return tr(n === 1 ? 'caMessageOne' : 'caMessageMany', n);
}

export type Deliveries = Record<string, Delivery>;

/**
 * A send's first status, from the node's reply. Accepted (the recipient's node
 * stored it) is stronger than sent (handed over); queued is paid, not handed over.
 */
export const deliveryFromReceipt = (r: { delivered: boolean; accepted?: boolean; state?: string }): Delivery =>
  r.accepted || r.state === 'acked' ? { status: 'accepted', reason: null }
    : r.state === 'failed_paid' ? { status: 'rejected', reason: tr('caRefusedAfterPaymentDoNotSendItAgain') }
    : r.delivered ? { status: 'sent', reason: null } : { status: 'queued', reason: null };

/** Fold a `/ws` delivery event in. The recipient's node decides; its reason is shown as sent. */
export function applyDelivery(deliveries: Deliveries, event: LiveEvent): Deliveries {
  if (event.type !== 'delivery') return deliveries;
  const status = event.status === 'delivered' ? 'delivered' : event.status === 'rejected' ? 'rejected' : null;
  if (!status) return deliveries;
  return { ...deliveries, [event.message_id]: { status, reason: status === 'rejected' ? event.reason ?? tr('caNoReasonGiven') : null } };
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

/** A just-sent file, shown as a bubble until `/ws` / history echo it. KIND_FILE_REF = 200. */
export function sentFileMessage(receipt: FileReceipt, ownId: string): Message {
  return {
    id: receipt.message_id,
    kind: 200,
    sender: ownId,
    recipient: receipt.recipient,
    timestamp: receipt.sent_at_ms,
    plaintext: receipt.filename,
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
  // A live echo claimed by a message still sending shows once, as that bubble.
  const claimed = new Set(artifacts.flatMap((a) => (a.type === 'sending' ? (a.echoes ?? []).map((e) => e.id) : [])));
  if (claimed.size) messages = messages.filter((m) => !claimed.has(m.id));
  const items: (StreamItem & { key: number })[] = [
    ...messages.map((message) => ({ type: 'message' as const, at: message.timestamp, key: message.timestamp, message })),
    ...artifacts.map((artifact) => ({ type: 'artifact' as const, at: artifact.at, key: sortAt(artifact), artifact })),
  ];
  // Messages still sending stay last, in the order pressed, until they settle:
  // a settled message never jumps behind a later pending one.
  const pending = (i: StreamItem) => i.type === 'artifact' && i.artifact.type === 'sending';
  return items.sort((a, b) => Number(pending(a)) - Number(pending(b)) || a.key - b.key).map(({ key: _key, ...item }) => item as StreamItem);
}

/** The composer's spend line. */
export function spendLine(view: SpendView | null, nowMs: number): { open: boolean; text: string } {
  if (!view) return { open: false, text: t('extraCheckingSpendingApproval') };
  switch (view.state) {
    case 'open': {
      const left = Math.max(0, Math.ceil(((view.open_until_ms ?? nowMs) - nowMs) / 60_000));
      return { open: left > 0, text: t('extraSpendingApprovedMinLeft', left) };
    }
    case 'pending':
      return { open: false, text: t('extraWaitingForYourApprovalAtTheNode') };
    case 'unavailable':
      return { open: false, text: t('extraThisNodeCannotGrantSpendingToTheApp') };
    case 'expired':
      return { open: false, text: t('extraSpendingApprovalExpired') };
    default:
      return { open: false, text: t('extraSpendingNeedsYourApproval') };
  }
}

/** Figures older than this are marked stale in the panels. */
export const STALE_AFTER_MS = 60_000;

export function freshness(readAt: number | null, nowMs: number): { label: string; stale: boolean } {
  if (readAt === null) return { label: tr('caNotReadYet'), stale: true };
  return { label: tr('extraRead', ago(readAt, nowMs)), stale: nowMs - readAt > STALE_AFTER_MS };
}

export type Pill = { tone: 'ok' | 'warn' | 'err' | 'idle'; text: string; live: boolean };

/** The rail's node pill: one glance at whether this seat is connected to its node. */
export function nodePill(input: {
  remote?: boolean;
  /** A phone has no local node: until it is paired to a remote one it is simply not connected. */
  phone?: boolean;
  retryAfterSecs?: number | null;
  ready: boolean;
  error: string | null;
  overview: NodeOverview | null;
  link: LinkState | null;
  nowMs: number;
}): Pill {
  if (input.phone && !input.remote) return { tone: 'idle', text: t('uiConnectToYourNode'), live: false };
  if (input.retryAfterSecs) return { tone: 'warn', text: t('uiRemoteConnectionWaitingS', input.retryAfterSecs), live: false };
  if (input.remote && input.error) return { tone: 'warn', text: t('uiRemoteConnectionUnavailable'), live: false };
  if (input.remote && !input.ready) return { tone: 'idle', text: t('uiConnectingToRemoteNode'), live: false };
  if (input.error) return { tone: 'err', text: t('uiNodeStopped'), live: false };
  if (!input.ready) return { tone: 'idle', text: t('uiStartingNode'), live: false };
  if (!input.overview) return { tone: 'ok', text: t('uiNodeRunning'), live: false };
  if (freshness(input.overview.read_at, input.nowMs).stale) {
    return { tone: 'warn', text: t('uiNodeNotAnswering'), live: false };
  }
  if (input.overview.money_ready === false) return { tone: 'warn', text: readinessLine(input.overview, input.nowMs)!, live: input.link === 'open' };
  if (input.overview.money_ready === true && input.link === 'open') return { tone: 'ok', text: t('uiLocalOKMoneyReady'), live: true };
  if (input.link === 'open') return { tone: 'ok', text: t('uiConnectedToYourNode'), live: true };
  return { tone: 'warn', text: t('uiNodeUpLiveFeedReconnecting'), live: false };
}
