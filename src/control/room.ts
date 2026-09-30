/**
 * Rooms MVP (genome `room_binding_v1`, docs/protocol/ROOMS.md). A room is a
 * fixed roster of 2 to 4 nodes: you and up to 3 contacts, chosen once. It is
 * ordinary paid 1:1 chat whose encrypted text carries a room binding:
 *
 *   {"v":1,"room":{"id":"<32 hex>","roster":["<node id>", ...sorted]},"text":"..."}
 *
 * Sending is one ordinary paid 1:1 message ("leg") per other member, one at a
 * time, each capped at exactly the price the owner was shown (the meetings
 * pattern): the host's own budget, window, journal and exactly-once rules
 * apply to every leg, and the node refuses a leg it cannot bind before paying.
 * A member whose node lacks the advert, or with no E2EE session, is skipped
 * and never charged. Leaving is local: the room is hidden on this device.
 */
import { createRoot, createSignal } from 'solid-js';
import { costToSend } from './state';
import type { ActionError, Message, PriceQuote, SendReceipt } from './types';

/** The node's `/status` and a peer's Hello both list this. */
export const ROOM_CAPABILITY = 'room_binding_v1';
/** You included (genome `MAX_ROOM_MEMBERS`). */
export const MAX_MEMBERS = 4;
const NODE_ID = /^[0-9a-f]{64}$/;
const ROOM_ID = /^[0-9a-f]{32}$/;

export type RoomBinding = { id: string; roster: string[] };
export type RoomChat = { room: RoomBinding; text: string };

/** 2 to 4 lowercase node ids, strictly ascending (so every member sees the same roster). */
export function validRoster(roster: unknown): roster is string[] {
  return Array.isArray(roster)
    && roster.length >= 2 && roster.length <= MAX_MEMBERS
    && roster.every((id, i) => typeof id === 'string' && NODE_ID.test(id) && (i === 0 || roster[i - 1] < id));
}

const exactKeys = (o: object, keys: string[]) => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => own.includes(k));
};

/**
 * The room chat a message carries, or `null` for anything else. As strict as
 * the node (unknown fields refused), which already refused a bad binding
 * before this app could see it.
 */
export function parseRoomChat(kind: number, plaintext: string | null): RoomChat | null {
  if (kind !== 0 || !plaintext || plaintext[0] !== '{') return null;
  let v: unknown;
  try {
    v = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v) || !exactKeys(v, ['v', 'room', 'text'])) return null;
  const { v: version, room, text } = v as { v: unknown; room: unknown; text: unknown };
  if (version !== 1 || typeof text !== 'string' || text.length === 0) return null;
  if (!room || typeof room !== 'object' || Array.isArray(room) || !exactKeys(room, ['id', 'roster'])) return null;
  const { id, roster } = room as { id: unknown; roster: unknown };
  if (typeof id !== 'string' || !ROOM_ID.test(id) || !validRoster(roster)) return null;
  return { room: { id, roster: [...roster] }, text };
}

/** The plaintext of one room chat: the same for every member. */
export const roomChatText = (room: RoomBinding, text: string): string =>
  JSON.stringify({ v: 1, room: { id: room.id, roster: room.roster }, text });

/** You and the picked contacts, lowercase, deduplicated, sorted. */
export function makeRoster(own: string, picks: string[]): string[] {
  return [...new Set([own, ...picks].map((id) => id.toLowerCase()))].sort();
}

export function newRoomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A room chat, as the owner sees it. Only a chat whose roster holds its sender and us counts. */
export function roomOf(m: Message, own: string): RoomChat | null {
  const chat = parseRoomChat(m.kind, m.plaintext);
  const me = own.toLowerCase();
  if (!chat || !chat.room.roster.includes(m.sender.toLowerCase()) || !chat.room.roster.includes(me)) return null;
  return chat;
}

/**
 * Our own copies of one room chat, one per member: shown once. Copies share
 * the text and were sent within a minute of each other, one leg at a time.
 */
export function roomThread(messages: Message[], own: string): Message[] {
  const me = own.toLowerCase();
  const out: Message[] = [];
  let last: Message | null = null;
  for (const m of [...messages].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))) {
    const mine = m.sender.toLowerCase() === me;
    if (mine && last && last.sender.toLowerCase() === me && last.plaintext === m.plaintext && m.timestamp - last.timestamp < 60_000) continue;
    out.push(m);
    last = m;
  }
  return out;
}

// ---- rooms on this device --------------------------------------------------

export type LocalRoom = RoomBinding & {
  /** Unix ms: created here, or first seen. */
  at: number;
  /** Left: hidden here. Nobody was told; their chats to it stay hidden. */
  left?: boolean;
};

const STORE_KEY = 'bitsov.rooms.v1';

function load(): Record<string, LocalRoom> {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(STORE_KEY) ?? '{}') as Record<string, LocalRoom>;
    const out: Record<string, LocalRoom> = {};
    for (const [id, r] of Object.entries(raw ?? {})) {
      if (r && r.id === id && ROOM_ID.test(id) && validRoster(r.roster) && typeof r.at === 'number') {
        out[id] = { id, roster: [...r.roster], at: r.at, ...(r.left ? { left: true } : {}) };
      }
    }
    return out;
  } catch {
    return {};
  }
}

const store = createRoot(() => {
  const [rooms, setRooms] = createSignal<Record<string, LocalRoom>>(load());
  return { rooms, setRooms };
});

function save(next: Record<string, LocalRoom>) {
  store.setRooms(next);
  try {
    globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(next));
  } catch {
    /* private mode: kept for this session */
  }
}

/** Rooms shown on this device, newest first. */
export const localRooms = (): LocalRoom[] =>
  Object.values(store.rooms()).filter((r) => !r.left).sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));

export const localRoom = (id: string): LocalRoom | undefined => store.rooms()[id];

/**
 * Remember a room (created here, or a chat for it arrived). A room is its id
 * and roster: a chat naming a known id with another roster is not this room.
 * Returns the room, or `null` when that chat does not belong here.
 */
export function rememberRoom(room: RoomBinding, at = Date.now()): LocalRoom | null {
  const known = store.rooms()[room.id];
  if (known) return known.roster.join() === room.roster.join() ? known : null;
  const next = { id: room.id, roster: [...room.roster], at };
  save({ ...store.rooms(), [room.id]: next });
  return next;
}

/** Leave: local only. The room is hidden here and nothing is sent. */
export function leaveRoom(id: string) {
  const r = store.rooms()[id];
  if (r) save({ ...store.rooms(), [id]: { ...r, left: true } });
}

/** Tests only. */
export function resetRooms() {
  save({});
}

// ---- cost preview ----------------------------------------------------------

/** What the app knows about one member before sending. */
export type MemberInfo = { contact: boolean; connected: boolean; rooms: boolean; session: boolean };

export type LegPlan =
  | { peer: string; state: 'pay'; msat: number; estimate: boolean }
  | { peer: string; state: 'skip'; reason: string }
  | { peer: string; state: 'reading' };

export const SKIP = {
  contact: 'Not in your contacts. Not charged.',
  connected: 'Not connected right now. Not charged.',
  update: 'Their node needs an update for rooms. Not charged.',
  session: 'No secure session yet: message them once first. Not charged.',
  price: 'Could not read their price. Not charged.',
} as const;

/**
 * One leg per other member: what it may pay (their chat price and its fee
 * ceiling, exactly what the composer shows for them), or why it is skipped.
 */
export function planLegs(
  roster: string[],
  own: string,
  info: (peer: string) => MemberInfo | undefined,
  quotes: Record<string, PriceQuote | null | undefined>,
): LegPlan[] {
  const me = own.toLowerCase();
  return roster.filter((p) => p !== me).map((peer): LegPlan => {
    const i = info(peer);
    if (!i?.contact) return { peer, state: 'skip', reason: SKIP.contact };
    if (!i.connected) return { peer, state: 'skip', reason: SKIP.connected };
    if (!i.rooms) return { peer, state: 'skip', reason: SKIP.update };
    if (!i.session) return { peer, state: 'skip', reason: SKIP.session };
    const q = quotes[peer];
    if (q === undefined) return { peer, state: 'reading' };
    const cost = q ? costToSend({ kind: 'peer', id: peer }, q) : null;
    if (!cost) return { peer, state: 'skip', reason: SKIP.price };
    return { peer, state: 'pay', msat: cost.msat, estimate: cost.estimate };
  });
}

/** The sum Send may pay (each leg at most its shown price), or `null` while reading or when nobody can be paid. */
export function planTotal(legs: LegPlan[]): number | null {
  if (legs.some((l) => l.state === 'reading')) return null;
  const paid = legs.filter((l): l is Extract<LegPlan, { state: 'pay' }> => l.state === 'pay');
  return paid.length === 0 ? null : paid.reduce((s, l) => s + l.msat, 0);
}

// ---- sending ---------------------------------------------------------------

export type LegOutcome = {
  peer: string;
  state: 'sent' | 'skipped' | 'refused' | 'failed' | 'undelivered' | 'unknown' | 'stopped';
  /** At most this was paid, all-in (a sent leg's fee ceiling included); 0 when nothing was. */
  paidMsat: number;
  note: string | null;
  receipt?: SendReceipt;
  error?: ActionError;
};

type Outcome<T> = { ok: true; value: T } | { ok: false; error: ActionError };

/**
 * Refused before anything was paid, for this member only: the next member
 * may still be sent to. Anything else (unknown outcome, a paid message not
 * delivered, a closed window, a paused or spent daily budget) stops the rest.
 */
const MEMBER_ONLY = new Set<string>([
  'not_dispatched', 'price_changed', 'price_cap_exceeded', 'first_contact', 'budget_exhausted',
  'grant_recipient', 'grant_first_contact', 'grant_readmission', 'readmission_capped', 'readmission_quoted', 'invalid',
]);

/**
 * Send one room chat: each paid leg in turn, capped at its shown price. The
 * plan is the one the owner confirmed; it is not re-read here.
 */
export async function sendRoom(
  legs: LegPlan[],
  plaintext: string,
  send: (peer: string, plaintext: string, maxMsat: number) => Promise<Outcome<SendReceipt>>,
): Promise<LegOutcome[]> {
  const out: LegOutcome[] = [];
  let stop: string | null = null;
  for (const leg of legs) {
    if (leg.state !== 'pay') {
      out.push({ peer: leg.peer, state: 'skipped', paidMsat: 0, note: leg.state === 'skip' ? leg.reason : SKIP.price });
      continue;
    }
    if (stop) {
      out.push({ peer: leg.peer, state: 'stopped', paidMsat: 0, note: stop });
      continue;
    }
    const r = await send(leg.peer, plaintext, leg.msat);
    if (r.ok) {
      const paid = r.value.total_msat ?? r.value.amount_msat + (r.value.max_routing_fee_msat ?? 0);
      out.push({ peer: leg.peer, state: 'sent', paidMsat: paid, note: null, receipt: r.value });
      continue;
    }
    const e = r.error;
    if (e.code === 'failed_paid') {
      // Paid, then refused by their node: only this member, and never resent.
      out.push({ peer: leg.peer, state: 'refused', paidMsat: e.undelivered?.paid_msat ?? leg.msat, note: e.message, error: e });
      continue;
    }
    if (MEMBER_ONLY.has(e.code)) {
      out.push({ peer: leg.peer, state: 'failed', paidMsat: 0, note: e.message, error: e });
      continue;
    }
    const paidUndelivered = e.code === 'payment_settled_undelivered';
    const unknown = e.code === 'spend_unknown' || e.code === 'payment_unknown';
    out.push({
      peer: leg.peer,
      state: paidUndelivered ? 'undelivered' : unknown ? 'unknown' : 'failed',
      // Unknown may have paid: counted at its cap, never as "not charged".
      paidMsat: paidUndelivered ? e.undelivered?.paid_msat ?? leg.msat : unknown ? leg.msat : 0,
      note: e.message,
      error: e,
    });
    stop = 'Not sent: the room send stopped at an earlier member. Not charged.';
  }
  return out;
}
