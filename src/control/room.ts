/**
 * Rooms MVP (genome `room_binding_v1`, docs/protocol/ROOMS.md). A room is a
 * fixed roster of 2 to 4 nodes: you and up to 3 contacts, chosen once. It is
 * ordinary paid 1:1 chat whose encrypted text carries a room binding:
 *
 *   {"v":1,"room":{"id":"<64 hex>","roster":["<node id>", ...sorted],"salt":"<32 hex>"},"msg":"<32 hex>","text":"..."}
 *
 * The id commits to the roster and salt (`roomIdOf`), so it names exactly one
 * roster; `msg` is the same on every member's copy of one message.
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
import type { ActionError, Message, PriceQuote, RoomCopy, SendReceipt } from './types';

/** The node's `/status` and a peer's Hello both list this. */
export const ROOM_CAPABILITY = 'room_binding_v1';
/** You included (genome `MAX_ROOM_MEMBERS`). */
export const MAX_MEMBERS = 4;
/** Room thread page size (`?room=`), in whole messages. */
export const ROOM_PAGE = 50;
const NODE_ID = /^[0-9a-f]{64}$/;
const ROOM_ID = /^[0-9a-f]{64}$/;
/** Salt (16 bytes) and message id: 32 lowercase hex. */
const HEX16 = /^[0-9a-f]{32}$/;
const ROOM_ID_DOMAIN = 'bitsov/room-id/v1\u0000';

export type RoomBinding = { id: string; roster: string[]; salt: string };
export type RoomChat = { room: RoomBinding; msg: string; text: string };

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

const validBinding = (room: unknown): room is RoomBinding => {
  if (!room || typeof room !== 'object' || Array.isArray(room) || !exactKeys(room, ['id', 'roster', 'salt'])) return false;
  const { id, roster, salt } = room as Record<string, unknown>;
  return typeof id === 'string' && ROOM_ID.test(id) && validRoster(roster) && typeof salt === 'string' && HEX16.test(salt);
};

/**
 * The room chat a message carries, or `null` for anything else. As strict as
 * the node on shape (unknown fields refused); `verifyRoom` checks the id.
 */
export function parseRoomChat(kind: number, plaintext: string | null): RoomChat | null {
  // The genome's rule: leading whitespace is allowed, then one JSON object.
  if (kind !== 0 || !plaintext || !plaintext.trimStart().startsWith('{')) return null;
  let v: unknown;
  try {
    v = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v) || !exactKeys(v, ['v', 'room', 'msg', 'text'])) return null;
  const { v: version, room, msg, text } = v as Record<string, unknown>;
  if (version !== 1 || typeof text !== 'string' || text.length === 0 || typeof msg !== 'string' || !HEX16.test(msg)) return null;
  if (!validBinding(room)) return null;
  return { room: { id: room.id, roster: [...room.roster], salt: room.salt }, msg, text };
}

/** The plaintext of one room message: the same for every member's copy. */
export const roomChatText = (room: RoomBinding, msg: string, text: string): string =>
  JSON.stringify({ v: 1, room: { id: room.id, roster: room.roster, salt: room.salt }, msg, text });

/** You and the picked contacts, lowercase, deduplicated, sorted. */
export function makeRoster(own: string, picks: string[]): string[] {
  return [...new Set([own, ...picks].map((id) => id.toLowerCase()))].sort();
}

const toHex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
function randomHex(n: number): string {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/**
 * Genome `room_id`: SHA-256("bitsov/room-id/v1\0" ‖ u8(len) ‖ roster[0] ‖ … ‖ salt),
 * each node id as its 32 bytes and the salt as its 16, in lowercase hex.
 */
export async function roomIdOf(roster: string[], salt: string): Promise<string> {
  const parts = [new TextEncoder().encode(ROOM_ID_DOMAIN), Uint8Array.of(roster.length), ...roster.map(fromHex), fromHex(salt)];
  const pre = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => (pre.set(p, at), at + p.length), 0);
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', pre)));
}

/** A new room of you and the picks: a fresh salt, so the same people twice are two rooms. */
export async function newRoom(own: string, picks: string[]): Promise<RoomBinding> {
  const roster = makeRoster(own, picks);
  const salt = randomHex(16);
  return { id: await roomIdOf(roster, salt), roster, salt };
}

/** A new message id: one per logical room message, on every member's copy. */
export const newMsgId = (): string => randomHex(16);

const verified = new Map<string, Promise<boolean>>();
/** The id commits to this roster and salt (as every member's node checks). */
export function verifyRoom(room: RoomBinding): Promise<boolean> {
  if (!validBinding(room)) return Promise.resolve(false);
  const key = `${room.id}/${room.roster.join()}/${room.salt}`;
  let v = verified.get(key);
  if (!v) {
    v = roomIdOf(room.roster, room.salt).then((id) => id === room.id, () => false);
    verified.set(key, v);
  }
  return v;
}

/** Hex ids by code point (as the node sorts them), not by locale. */
const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const sameRoom = (a: RoomBinding, b: RoomBinding) =>
  a.id === b.id && a.salt === b.salt && a.roster.join() === b.roster.join();

/** A room chat, as the owner sees it. Only a chat whose roster holds its sender and us counts. */
export function roomOf(m: Message, own: string): RoomChat | null {
  const chat = parseRoomChat(m.kind, m.plaintext);
  const me = own.toLowerCase();
  if (!chat || !chat.room.roster.includes(m.sender.toLowerCase()) || !chat.room.roster.includes(me)) return null;
  return chat;
}

/** One logical room message: a member's chat to us, or ours with every member's copy. */
export type RoomEntry = {
  key: string;
  sender: string;
  /** Its newest copy's time (where the node's thread places it). */
  timestamp: number;
  msg: string;
  text: string;
  /** Ours: each member's copy. Theirs: empty. */
  copies: RoomCopy[];
  /** Ours: the sum of the copies; theirs: what it paid us. */
  paidMsat: number;
  /** Every message id behind this entry. */
  ids: string[];
};

/**
 * The thread as messages, not copies: our per-member copies of one message
 * (same `msg`) are one entry, whether they came from the node's `?room=`
 * thread (`copies`) or one leg at a time (a send, a live event).
 */
export function roomThread(messages: Message[], own: string): RoomEntry[] {
  const me = own.toLowerCase();
  const groups = new Map<string, RoomEntry & { copyMap: Map<string, RoomCopy> }>();
  for (const m of messages) {
    const chat = roomOf(m, me);
    if (!chat) continue;
    const sender = m.sender.toLowerCase();
    const key = `${sender}:${chat.msg}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, sender, timestamp: m.timestamp, msg: chat.msg, text: chat.text, copies: [], paidMsat: 0, ids: [], copyMap: new Map() };
      groups.set(key, g);
    }
    g.timestamp = Math.max(g.timestamp, m.timestamp);
    if (!g.ids.includes(m.id)) g.ids.push(m.id);
    if (sender !== me) {
      g.paidMsat = m.payment_amount_msat ?? 0;
      continue;
    }
    const copies = m.copies?.length ? m.copies : NODE_ID.test(m.recipient.toLowerCase()) && m.recipient.toLowerCase() !== chat.room.id
      ? [{ recipient: m.recipient.toLowerCase(), id: m.id, payment_amount_msat: m.payment_amount_msat }] : [];
    for (const c of copies) {
      g.copyMap.set(c.id, { ...c, recipient: c.recipient.toLowerCase() });
      if (!g.ids.includes(c.id)) g.ids.push(c.id);
    }
  }
  return [...groups.values()]
    .map(({ copyMap, ...g }) => {
      const copies = [...copyMap.values()].sort((a, b) => byCode(a.recipient, b.recipient) || byCode(a.id, b.id));
      return { ...g, copies, paidMsat: g.sender === me ? copies.reduce((t, c) => t + (c.payment_amount_msat ?? 0), 0) : g.paidMsat };
    })
    .sort((a, b) => a.timestamp - b.timestamp || byCode(a.key, b.key));
}

/**
 * Why a member's node refused a room message after it was paid (its
 * `MessageReject` reason starts with the code), in plain words; `null` when
 * the reason is not a room refusal.
 */
export function roomRefusalWords(reason: string | null | undefined): string | null {
  const code = (reason ?? '').split(':')[0].trim();
  switch (code) {
    case 'room_binding_invalid': return 'Their node could not match this room’s details, so it refused the message.';
    case 'room_sender_not_member': return 'Their node does not list you in this room, so it refused the message.';
    case 'room_recipient_not_member': return 'Their node is not in this room’s member list, so it refused the message.';
    case 'room_binding_unsupported': return 'Their node cannot take room messages yet.';
    case 'room_member_no_session': return 'There was no secure session with them.';
    default: return null;
  }
}

// ---- rooms on this device --------------------------------------------------

export type LocalRoom = RoomBinding & {
  /** Unix ms: created here, or first seen. */
  at: number;
  /** Left: hidden here. Nobody was told; their chats to it stay hidden. */
  left?: boolean;
};

/** v2: ids that commit to roster and salt (v1 rooms are not rooms any node accepts). */
const STORE_KEY = 'bitsov.rooms.v2';

function load(): Record<string, LocalRoom> {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(STORE_KEY) ?? '{}') as Record<string, LocalRoom>;
    const out: Record<string, LocalRoom> = {};
    for (const [id, r] of Object.entries(raw ?? {})) {
      const room = r ? { id: r.id, roster: r.roster, salt: r.salt } : null;
      if (r && r.id === id && validBinding(room) && typeof r.at === 'number') {
        out[id] = { id, roster: [...r.roster], salt: r.salt, at: r.at, ...(r.left ? { left: true } : {}) };
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
  Object.values(store.rooms()).filter((r) => !r.left).sort((a, b) => b.at - a.at || byCode(a.id, b.id));

export const localRoom = (id: string): LocalRoom | undefined => store.rooms()[id];

/**
 * Remember a room whose id was verified (created here, or `verifyRoom`). A
 * known id with another roster or salt is not that room: `null`.
 */
export function rememberRoom(room: RoomBinding, at = Date.now()): LocalRoom | null {
  const known = store.rooms()[room.id];
  if (known) return sameRoom(known, room) ? known : null;
  if (!validBinding(room)) return null;
  const next = { id: room.id, roster: [...room.roster], salt: room.salt, at };
  save({ ...store.rooms(), [room.id]: next });
  return next;
}

/** Remember a room a chat named, only once its id is checked against its roster and salt. */
export async function admitRoom(room: RoomBinding, at = Date.now()): Promise<LocalRoom | null> {
  const known = store.rooms()[room.id];
  if (known) return sameRoom(known, room) ? known : null;
  return (await verifyRoom(room)) ? rememberRoom(room, at) : null;
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
  /** Paid but not delivered, or refused after payment: what reached them, without the network fee. */
  principalMsat?: number;
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
      // The node reports what reached them, not the routing fee: the bound is the confirmed all-in cap.
      out.push({ peer: leg.peer, state: 'refused', paidMsat: leg.msat, principalMsat: e.undelivered?.paid_msat, note: e.message, error: e });
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
      // Paid-undelivered reports what reached them, without the routing fee, and
      // unknown may have paid: both are counted at the confirmed all-in cap.
      paidMsat: paidUndelivered || unknown ? leg.msat : 0,
      ...(paidUndelivered && e.undelivered ? { principalMsat: e.undelivered.paid_msat } : {}),
      note: e.message,
      error: e,
    });
    stop = 'Not sent: the room send stopped at an earlier member. Not charged.';
  }
  return out;
}
