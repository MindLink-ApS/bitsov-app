import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import type { PairingView } from '../src/onboarding/pairing';
import type { BudgetView, LiveEvent, Message, PriceQuote, SendReceipt, SpendView } from '../src/control/types';
import {
  admitRoom, leaveRoom, localRooms, makeRoster, newMsgId, newRoom, parseRoomChat, planLegs, planTotal, rememberRoom, resetRooms, roomChatText, roomIdOf, roomOf,
  roomRefusalWords, roomThread, sendRoom, SKIP, verifyRoom,
  type LegPlan, type MemberInfo, type RoomBinding,
} from '../src/control/room';
import { resetContactsForTests, setPetname } from '../src/control/petnames';

const OWN = '1'.repeat(64);
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const D = 'd'.repeat(64);
const SALT = '07'.repeat(16);
const MSG = '00112233445566778899aabbccddeeff';
/** A room as the genome builds it: sorted roster, a salt, and the id that commits to both. */
const bind = async (roster: string[], salt = SALT): Promise<RoomBinding> => ({ id: await roomIdOf(roster, salt), roster, salt });
const quote = (peer_msat: number): PriceQuote => ({ kind: 0, own_msat: 1000, peer_msat, peer_age_secs: 30, peer_stale: false, max_routing_fee_msat: 500 });
const ok: MemberInfo = { contact: true, connected: true, rooms: true, session: true };
const receipt = (recipient: string, max: number, n = 1): SendReceipt => ({
  message_id: `r${n}`, recipient, is_room: false, delivered: true, accepted: true, amount_msat: max - 500, total_msat: max, max_routing_fee_msat: 500, sent_at_ms: Date.now(),
});

describe('room chat format', () => {
  let room: RoomBinding;
  beforeAll(async () => { room = await bind([OWN, A, B]); });
  it('the id is the genome’s: SHA-256 of the domain, the roster size, each sorted member and the salt', async () => {
    // konsensus-core payloads::room::the_room_id_commits_to_the_roster_and_salt: nodes [1;32],[2;32],[3;32], salt [7;16].
    const node = (b: number) => b.toString(16).padStart(2, '0').repeat(32);
    expect(await roomIdOf([node(1), node(2), node(3)], '07'.repeat(16))).toBe('ae52d5b56fbe295723d99bf99eded3910ed3fcffe4ee8daf054edc479a0e9be6');
    const one = await newRoom(OWN, [B, A]);
    const two = await newRoom(OWN, [A, B]);
    expect(one.roster).toEqual([OWN, A, B]);
    expect(one.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(one.id).not.toBe(two.id);
    expect(await verifyRoom(one)).toBe(true);
  });
  it('a room id names exactly one roster and salt: any other is not that room', async () => {
    expect(await verifyRoom(room)).toBe(true);
    expect(await verifyRoom({ ...room, roster: [OWN, A, C] })).toBe(false);
    expect(await verifyRoom({ ...room, roster: [OWN, A] })).toBe(false);
    expect(await verifyRoom({ ...room, roster: [OWN, A, B, C] })).toBe(false);
    expect(await verifyRoom({ ...room, salt: '08'.repeat(16) })).toBe(false);
    expect(await verifyRoom({ ...room, id: 'ab'.repeat(32) })).toBe(false);
  });
  it('round-trips exactly the binding the node checks, with one msg id', () => {
    const pt = roomChatText(room, MSG, 'hello');
    expect(JSON.parse(pt)).toEqual({ v: 1, room: { id: room.id, roster: [OWN, A, B], salt: SALT }, msg: MSG, text: 'hello' });
    expect(parseRoomChat(0, pt)).toEqual({ room, msg: MSG, text: 'hello' });
    expect(newMsgId()).toMatch(/^[0-9a-f]{32}$/);
    expect(newMsgId()).not.toBe(newMsgId());
  });
  it('is as strict as the node: unknown fields, a missing salt or msg, unsorted or oversized rosters, bad ids, other kinds and empty text are not room chats', () => {
    const chat = (over: Record<string, unknown>, r: Record<string, unknown> = room) => JSON.stringify({ v: 1, room: r, msg: MSG, text: 'x', ...over });
    const bad = [
      chat({ extra: 1 }),
      chat({}, { ...room, name: 'n' }),
      chat({}, { id: room.id, roster: room.roster }),
      chat({}, { ...room, salt: '07' }),
      chat({}, { ...room, id: room.id.slice(0, 32) }),
      chat({}, { ...room, id: room.id.toUpperCase() }),
      chat({}, { ...room, roster: [A, OWN] }),
      chat({}, { ...room, roster: [OWN, A, B, C, D] }),
      chat({}, { ...room, roster: [OWN] }),
      chat({ v: 2 }),
      chat({ text: '' }),
      chat({ msg: 'ABC' }),
      chat({ msg: MSG.toUpperCase() }),
      JSON.stringify({ v: 1, room, text: 'x' }),
      'plain words',
    ];
    for (const pt of bad) expect(parseRoomChat(0, pt), pt).toBeNull();
    // Unicode space is not JSON whitespace: the genome's parser refuses it too.
    expect(parseRoomChat(0, `\u00a0${roomChatText(room, MSG, 'x')}`)).toBeNull();
    expect(parseRoomChat(400, roomChatText(room, MSG, 'x'))).toBeNull();
  });
  it('legal JSON whitespace around the binding is still a room chat, as the genome reads it', () => {
    const pt = roomChatText(room, MSG, 'hello');
    for (const ws of [' ', '\n', '\t', '\r\n ', '  \n\t']) {
      expect(parseRoomChat(0, `${ws}${pt}`), JSON.stringify(ws)).toEqual({ room, msg: MSG, text: 'hello' });
      expect(parseRoomChat(0, `${ws}${pt}${ws}`), JSON.stringify(ws)).not.toBeNull();
    }
  });
  it('a chat counts only when its roster holds the sender and us', async () => {
    const m = (sender: string, r: RoomBinding): Message => ({ id: 'm', kind: 0, sender, recipient: OWN, timestamp: 1, plaintext: roomChatText(r, MSG, 'x'), payment_amount_msat: 0 });
    const withA = await bind([OWN, A]);
    expect(roomOf(m(A, withA), OWN)).not.toBeNull();
    expect(roomOf(m(C, withA), OWN)).toBeNull();
    expect(roomOf(m(A, await bind([A, B])), OWN)).toBeNull();
  });
  it('a roster is us and the picks, lowercase, deduplicated and sorted', () => {
    expect(makeRoster(OWN, [B, A.toUpperCase(), B])).toEqual([OWN, A, B]);
  });
  it('our copies of one message (same msg) are one entry, however far apart they were sent, wherever they came from', () => {
    const mine = (id: string, recipient: string, timestamp: number, msg = MSG, over: Partial<Message> = {}): Message =>
      ({ id, kind: 0, sender: OWN, recipient, timestamp, plaintext: roomChatText(room, msg, 'x'), payment_amount_msat: recipient === A ? 2000 : 3000, ...over });
    // Leg by leg, the second resent much later: one entry, at its newest copy.
    const legs = roomThread([mine('1', A, 1000), mine('2', B, 600_000)], OWN);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ timestamp: 600_000, paidMsat: 5000, ids: ['1', '2'] });
    expect(legs[0].copies.map((c) => c.recipient)).toEqual([A, B]);
    // The same words twice are two messages.
    expect(roomThread([mine('1', A, 1000), mine('3', A, 1001, 'ff'.repeat(16))], OWN)).toHaveLength(2);
    // The node's entry (recipient = the room, every copy) and a copy-less echo of one copy: still one entry, two copies.
    const entry = mine('2', room.id, 600_000, MSG, { payment_amount_msat: 5000, copies: [{ recipient: A, id: '1', payment_amount_msat: 2000 }, { recipient: B, id: '2', payment_amount_msat: 3000 }] });
    const both = roomThread([entry, mine('1', A, 1000)], OWN);
    expect(both).toHaveLength(1);
    expect(both[0]).toMatchObject({ paidMsat: 5000, timestamp: 600_000 });
    expect(both[0].copies).toHaveLength(2);
    // Theirs: one entry per sender, at what it paid us.
    const theirs: Message = { id: 'in', kind: 0, sender: A, recipient: OWN, timestamp: 5, plaintext: roomChatText(room, MSG, 'hey'), payment_amount_msat: 2000 };
    expect(roomThread([theirs, mine('1', A, 1000)], OWN).map((e) => [e.sender, e.text, e.paidMsat])).toEqual([[A, 'hey', 2000], [OWN, 'x', 2000]]);
  });
  it('a member’s node refusing our paid copy reads as a sentence, never a code', () => {
    for (const code of ['room_binding_invalid', 'room_sender_not_member', 'room_recipient_not_member', 'room_binding_unsupported', 'room_member_no_session']) {
      const words = roomRefusalWords(`${code}: invalid room binding: room id does not commit to this roster and salt`);
      expect(words).toMatch(/^[A-Z].*\.$/);
      expect(words).not.toMatch(/room_|commit/);
    }
    expect(roomRefusalWords('price too high')).toBeNull();
    expect(roomRefusalWords(null)).toBeNull();
  });
});

describe('room cost preview', () => {
  const info = (map: Record<string, MemberInfo | undefined>) => (p: string) => map[p];
  it('each member pays their own chat price and its fee ceiling; the total is their sum', () => {
    const legs = planLegs([OWN, A, B], OWN, info({ [A]: ok, [B]: ok }), { [A]: quote(2000), [B]: quote(3000) });
    expect(legs).toEqual([
      { peer: A, state: 'pay', msat: 2500, estimate: false },
      { peer: B, state: 'pay', msat: 3500, estimate: false },
    ]);
    expect(planTotal(legs)).toBe(6000);
  });
  it('a member not connected, without the advert, or without a session is skipped and not charged', () => {
    const legs = planLegs([OWN, A, B, C], OWN, info({
      [A]: { ...ok, connected: false }, [B]: { ...ok, rooms: false }, [C]: { ...ok, session: false },
    }), { [A]: quote(2000), [B]: quote(2000), [C]: quote(2000) });
    expect(legs.map((l) => (l.state === 'skip' ? l.reason : l.state))).toEqual([SKIP.connected, SKIP.update, SKIP.session]);
    expect(planTotal(legs)).toBeNull();
  });
  it('no total while a price is still being read', () => {
    expect(planTotal(planLegs([OWN, A, B], OWN, () => ok, { [A]: quote(2000) }))).toBeNull();
  });
});

describe('room send', () => {
  const pay = (peer: string, msat: number): LegPlan => ({ peer, state: 'pay', msat, estimate: false });
  it('sends each paid leg in turn, capped at its shown price; skipped members are never sent to', async () => {
    const send = vi.fn(async (peer: string, _pt: string, max: number) => ({ ok: true as const, value: receipt(peer, max) }));
    const out = await sendRoom([pay(A, 2500), { peer: B, state: 'skip', reason: SKIP.session }, pay(C, 3500)], 'pt', send);
    expect(send.mock.calls.map((c) => [c[0], c[2]])).toEqual([[A, 2500], [C, 3500]]);
    expect(out.map((o) => [o.state, o.paidMsat])).toEqual([['sent', 2500], ['skipped', 0], ['sent', 3500]]);
  });
  it('a refusal before paying stops only that member', async () => {
    const send = vi.fn(async (peer: string, _pt: string, max: number) => (peer === A
      ? { ok: false as const, error: { code: 'price_changed' as const, message: 'Their price went up.' } }
      : { ok: true as const, value: receipt(peer, max) }));
    const out = await sendRoom([pay(A, 2500), pay(B, 3500)], 'pt', send);
    expect(out.map((o) => [o.state, o.paidMsat])).toEqual([['failed', 0], ['sent', 3500]]);
  });
  it('an unknown outcome stops the rest (counted as possibly paid), and so does a paid message not delivered', async () => {
    const unknown = await sendRoom([pay(A, 2500), pay(B, 3500)], 'pt', async () => ({ ok: false, error: { code: 'spend_unknown', message: 'unknown' } }));
    expect(unknown.map((o) => [o.state, o.paidMsat])).toEqual([['unknown', 2500], ['stopped', 0]]);
    const send = vi.fn(async () => ({ ok: false as const, error: { code: 'payment_settled_undelivered' as const, message: 'paid, not delivered', undelivered: { paid_msat: 2100 } as never } }));
    const undelivered = await sendRoom([pay(A, 2500), pay(B, 3500)], 'pt', send);
    expect(send).toHaveBeenCalledTimes(1);
    // The node reports what reached them (2,100), not the routing fee: the bound stays the confirmed all-in cap.
    expect(undelivered.map((o) => [o.state, o.paidMsat, o.principalMsat])).toEqual([['undelivered', 2500, 2100], ['stopped', 0, undefined]]);
    const refused = await sendRoom([pay(A, 2500)], 'pt', async () => ({ ok: false, error: { code: 'failed_paid', message: 'refused', undelivered: { paid_msat: 2100 } as never } }));
    expect(refused.map((o) => [o.state, o.paidMsat, o.principalMsat])).toEqual([['refused', 2500, 2100]]);
  });
  it('a re-admission above the confirmed cap is refused for that member only, with nothing paid', async () => {
    const send = vi.fn(async (peer: string, _pt: string, max: number) => (peer === A
      ? { ok: false as const, error: { code: 'readmission_capped' as const, message: 'Not sent - nothing was paid. They reconnected and ask to be admitted again.' } }
      : { ok: true as const, value: receipt(peer, max) }));
    const out = await sendRoom([pay(A, 2500), pay(B, 3500)], 'pt', send);
    expect(send.mock.calls.map((c) => [c[0], c[2]])).toEqual([[A, 2500], [B, 3500]]);
    expect(out.map((o) => [o.state, o.paidMsat])).toEqual([['failed', 0], ['sent', 3500]]);
  });
});

describe('rooms on this device', () => {
  beforeEach(() => resetRooms());
  it('a known id with another roster is not that room; a chat’s room is kept only once its id checks; leaving hides it here only', async () => {
    const room = await bind([OWN, A]);
    expect(rememberRoom(room, 1)).not.toBeNull();
    expect(rememberRoom({ ...room, roster: [OWN, B] }, 2)).toBeNull();
    expect(rememberRoom({ ...room, salt: '08'.repeat(16) }, 2)).toBeNull();
    expect(await admitRoom({ id: 'ab'.repeat(32), roster: [OWN, B], salt: SALT })).toBeNull();
    expect(await admitRoom(await bind([OWN, B]))).not.toBeNull();
    expect(localRooms().map((r) => r.roster)).toEqual([[OWN, B], [OWN, A]]);
    leaveRoom(room.id);
    expect(localRooms().map((r) => r.roster)).toEqual([[OWN, B]]);
    expect(rememberRoom(room)?.left).toBe(true);
  });
});

// ---- the shell ----------------------------------------------------------

const paired: PairingView = { state: 'paired', scopes: ['read', 'receive'], short_code: 'ABCD-EFGH', code_from_node: true, reason: null, remote: false, bootstrap: null };
const budget = (over: Partial<BudgetView> = {}): BudgetView => ({
  paused: false, waiting_for_owner: false, ceiling_msat: 500_000, max_daily_msat: 100_000_000, spent_msat: 0, unsettled_msat: 0,
  preset: 'careful', presets: [{ id: 'careful', contact_msat: 50_000, room_msat: 100_000, ceiling_msat: 500_000 }],
  rows: [A, B, C, D].map((target) => ({ target, room: false, limit_msat: 50_000, spent_msat: 0 })),
  autopay: { state: 'open', open_until_ms: Date.now() + 86_400_000, ceiling_msat: 500_000, basis: 'node_grant' },
  window_ms: 600_000, node_grant: null,
  ...over,
});
const overview = (capabilities: string[]) => ({
  node_id: OWN, status: 'ok', version: 'api v2', connected_peers: 3, e2ee_sessions: 2, pending_deliveries: 0,
  lightning_available: true, block_height: 1, uptime_secs: 1, lightning_backend: 'ldk', chain_backend: 'esplora', read_at: Date.now(), capabilities,
});
const peer = (node_id: string, label: string, over: Record<string, unknown> = {}) => ({ node_id, addr: null, label, connected: true, fingerprint: null, meetings: false, rooms: true, session: true, ...over });
const PRICES: Record<string, number> = { [A]: 2000, [B]: 3000, [C]: 4000, [D]: 5000 };

type Reply = (args?: Record<string, unknown>) => unknown;
function stubHost(overrides: Record<string, Reply> = {}) {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const callbacks = new Map<number, (e: unknown) => void>();
  const spend: SpendView = { state: 'locked', basis: null, open_until_ms: null, pending: null, window_ms: 600_000 };
  let n = 0;
  const REPLIES: Record<string, Reply> = {
    node_status: () => ({ ready: true, node_id: OWN, error: null }),
    pairing_status: () => paired,
    node_overview: () => overview(['room_binding_v1']),
    peers_list: () => [
      peer(A, 'Maya'),
      peer(B, 'Jon'),
      peer(C, 'Lee', { rooms: false }),
      peer(D, 'Ana', { session: false }),
    ],
    rooms_list: () => [],
    messages_list: () => [],
    room_thread: () => [],
    price_quote: (args) => quote(PRICES[args!.peer as string] ?? 1000),
    payments_overview: () => ({ balance_msat: 1_000_000, lightning_outbound_msat: 500_000, channels: [] }),
    fund_state: () => null,
    file_price: () => ({ principal_msat: 3000, max_routing_fee_msat: 5000, total_msat: 8000 }),
    spend_status: () => spend,
    budget_status: () => budget(),
    message_send: (args) => receipt(args!.recipient as string, args!.max_msat as number, ++n),
    live_link: () => null,
    'plugin:event|listen': () => 1,
    'plugin:event|unlisten': () => null,
    ...overrides,
  };
  vi.stubGlobal('__TAURI_INTERNALS__', {
    transformCallback: (cb: (e: unknown) => void) => { const id = callbacks.size + 1; callbacks.set(id, cb); return id; },
    invoke: (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      const reply = REPLIES[cmd];
      if (!reply) return Promise.reject(new Error(`unexpected ${cmd}`));
      try { return Promise.resolve(reply(args)); } catch (e) { return Promise.reject(e); }
    },
  });
  vi.stubGlobal('__TAURI_EVENT_PLUGIN_INTERNALS__', { unregisterListener: () => {} });
  return {
    used: (cmd: string) => calls.filter((c) => c.cmd === cmd),
    emitLive: (payload: LiveEvent) => {
      const listen = calls.find((c) => c.cmd === 'plugin:event|listen');
      callbacks.get(listen!.args!.handler as number)!({ event: 'node-live', id: 1, payload });
    },
  };
}

describe('rooms in the shell', () => {
  let AB: RoomBinding;
  let ABD: RoomBinding;
  beforeAll(async () => {
    AB = await bind(makeRoster(OWN, [A, B]));
    ABD = await bind(makeRoster(OWN, [A, B, D]));
  });
  let dispose: (() => void) | undefined;
  let mount: HTMLElement;
  beforeEach(() => {
    resetContactsForTests();
    resetRooms();
    setPetname(A, 'Maya');
    setPetname(B, 'Jon');
    setPetname(C, 'Lee');
    setPetname(D, 'Ana');
  });
  afterEach(() => {
    dispose?.();
    dispose = undefined;
    mount?.remove();
    vi.unstubAllGlobals();
    resetContactsForTests();
    resetRooms();
  });
  const $ = <T extends Element = HTMLElement>(sel: string) => mount.querySelector<T>(sel);
  const text = (sel: string) => $(sel)?.textContent ?? '';
  const click = (sel: string) => $<HTMLButtonElement>(sel)!.click();
  async function openShell() {
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => <App />, mount);
    await vi.waitFor(() => expect([...mount.querySelectorAll('button')].some((b) => b.textContent?.includes('I understand'))).toBe(true));
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
    await vi.waitFor(() => expect($(`[data-track="peer:${A}"]`)?.getAttribute('aria-current')).toBe('true'));
  }
  async function openRoom(...picks: string[]) {
    await vi.waitFor(() => expect($('[data-room-new]')).not.toBeNull());
    click('[data-room-new]');
    await vi.waitFor(() => expect($('[data-room-panel="new"]')).not.toBeNull());
    for (const p of picks) $<HTMLInputElement>(`[data-room-pick="${p}"]`)!.click();
    click('[data-room-create]');
    await vi.waitFor(() => expect($('[data-room-head]')).not.toBeNull());
  }
  const typeDraft = (value: string) => {
    const t = $<HTMLTextAreaElement>('[data-room-draft]')!;
    t.value = value;
    t.dispatchEvent(new InputEvent('input', { bubbles: true }));
  };

  it('keeps the coming-soon line (and no New room) while our node does not check room bindings', async () => {
    stubHost({ node_overview: () => overview(['call_meeting_v1']) });
    await openShell();
    await vi.waitFor(() => expect($('[data-rooms-coming-soon]')).not.toBeNull());
    expect(text('[data-rooms-coming-soon]')).toMatch(/Coming soon/);
    expect($('[data-room-new]')).toBeNull();
  });

  it('with the node advert, New room replaces the coming-soon line; only contacts whose node binds rooms (and who have a session) can be picked, up to 3', async () => {
    const E = '9'.repeat(64);
    const host = stubHost({
      peers_list: () => [peer(A, 'Maya'), peer(B, 'Jon'), peer(C, 'Lee', { rooms: false }), peer(D, 'Ana', { session: false }), peer(E, 'Bo', { connected: false }), peer('8'.repeat(64), 'Kim')],
    });
    setPetname(E, 'Bo');
    await openShell();
    await vi.waitFor(() => expect($('[data-room-new]')).not.toBeNull());
    expect($('[data-rooms-coming-soon]')).toBeNull();
    click('[data-room-new]');
    await vi.waitFor(() => expect($('[data-room-panel="new"]')).not.toBeNull());
    expect(text('[data-room-panel="new"]')).toMatch(/Maya/);
    expect(text(`[data-room-pick-note="${C}"]`)).toMatch(/needs update/);
    expect(text(`[data-room-pick-note="${D}"]`)).toMatch(/message them once first/);
    expect(text(`[data-room-pick-note="${E}"]`)).toMatch(/not connected/);
    for (const id of [C, D, E]) expect($<HTMLInputElement>(`[data-room-pick="${id}"]`)!.disabled).toBe(true);
    expect($<HTMLButtonElement>('[data-room-create]')!.disabled).toBe(true);
    $<HTMLInputElement>(`[data-room-pick="${A}"]`)!.click();
    $<HTMLInputElement>(`[data-room-pick="${B}"]`)!.click();
    $<HTMLInputElement>(`[data-room-pick="${'8'.repeat(64)}"]`)!.click();
    // A fourth member would exceed the roster of four.
    expect(text('[data-room-panel="new"] header')).toMatch(/up to 3 contacts/);
    click('[data-room-create]');
    await vi.waitFor(() => expect(text('[data-room-title]')).toMatch(/Maya, Jon/));
    expect(localRooms()[0].roster).toEqual(makeRoster(OWN, [A, B, '8'.repeat(64)]));
    // Creating is free and sends nothing.
    expect(host.used('message_send')).toHaveLength(0);
    expect($(`[data-track="bound:${localRooms()[0].id}"]`)).not.toBeNull();
  });

  it('the cost before Send is each member’s shown price, added up; the one confirm sends each leg capped at it, and skips (not charges) a member without a session', async () => {
    // Ana has no session (any more): skipped, not charged.
    const host = stubHost({ peers_list: () => [peer(A, 'Maya'), peer(B, 'Jon'), peer(D, 'Ana', { session: false })] });
    await openShell();
    await openRoom(A, B);
    const room = rememberRoom(ABD)!;
    click(`[data-track="bound:${room.id}"]`);
    await vi.waitFor(() => expect($(`[data-cost-msat]`)?.getAttribute('data-cost-msat')).toBe('6000'));
    expect($(`[data-room-cost-leg="${A}"]`)!.getAttribute('data-leg-msat')).toBe('2500');
    expect($(`[data-room-cost-leg="${B}"]`)!.getAttribute('data-leg-msat')).toBe('3500');
    expect($(`[data-room-cost-leg="${D}"]`)!.getAttribute('data-leg-plan')).toBe('skip');
    expect(text(`[data-room-cost-leg="${D}"]`)).toMatch(/No secure session.*Not charged/);
    expect(host.used('message_send')).toHaveLength(0);
  });

  it('Send opens a review and pays nothing; its one confirm sends each leg at its shown price, once', async () => {
    const host = stubHost({ peers_list: () => [peer(A, 'Maya'), peer(B, 'Jon'), peer(D, 'Ana', { session: false })] });
    await openShell();
    const room = rememberRoom(ABD)!;
    await vi.waitFor(() => expect($(`[data-track="bound:${ABD.id}"]`)).not.toBeNull());
    click(`[data-track="bound:${ABD.id}"]`);
    await vi.waitFor(() => expect($('[data-cost-msat]')?.getAttribute('data-cost-msat')).toBe('6000'));
    typeDraft('hello room');
    click('[data-send]');
    await vi.waitFor(() => expect($('[data-room-review]')).not.toBeNull());
    expect($('[data-room-review]')!.getAttribute('data-review-msat')).toBe('6000');
    expect($(`[data-review-leg="${A}"]`)!.getAttribute('data-review-leg-msat')).toBe('2500');
    expect($(`[data-review-leg="${D}"]`)!.getAttribute('data-review-leg-msat')).toBe('0');
    expect(host.used('message_send')).toHaveLength(0);
    click('[data-room-confirm]');
    // The review is consumed at dispatch.
    expect($('[data-room-confirm]')).toBeNull();
    await vi.waitFor(() => expect($('[data-room-send]')).not.toBeNull());
    const sent = host.used('message_send').map((c) => c.args!);
    expect(sent.map((a) => [a.recipient, a.is_room, a.max_msat])).toEqual([[A, false, 2500], [B, false, 3500]]);
    const bodies = sent.map((a) => JSON.parse(a.plaintext as string));
    for (const body of bodies) expect(body).toEqual({ v: 1, room: { id: ABD.id, roster: room.roster, salt: SALT }, msg: expect.stringMatching(/^[0-9a-f]{32}$/), text: 'hello room' });
    // One message: the same msg on every member's copy.
    expect(new Set(bodies.map((b) => b.msg)).size).toBe(1);
    expect($(`[data-room-leg="${D}"]`)!.getAttribute('data-leg-state')).toBe('skipped');
    expect(text(`[data-room-leg="${D}"]`)).toMatch(/not charged/);
    expect($('[data-room-send] [data-room-send-msat]')!.getAttribute('data-room-send-msat')).toBe('6000');
    // Our chat shows once in the room, and not as raw text in Maya's 1:1 thread.
    await vi.waitFor(() => expect(mount.querySelectorAll('[data-room-stream] .msg.out')).toHaveLength(1));
    expect(text('[data-room-stream] .msg.out .bubble')).toBe('hello room');
    expect($('[data-room-stream] .msg.out')!.getAttribute('data-room-copies')).toBe('2');
    expect(text('[data-room-stream] .msg.out [data-room-to]')).toMatch(/to Maya, Jon/);
    click(`[data-track="peer:${A}"]`);
    await vi.waitFor(() => expect($(`[data-track="peer:${A}"]`)?.getAttribute('aria-current')).toBe('true'));
    expect(mount.textContent).not.toMatch(/"roster"/);
  });

  it('a review is of the text it froze; Back, or leaving the room, withdraws it with nothing paid', async () => {
    const host = stubHost();
    await openShell();
    rememberRoom(AB);
    await vi.waitFor(() => expect($(`[data-track="bound:${AB.id}"]`)).not.toBeNull());
    click(`[data-track="bound:${AB.id}"]`);
    await vi.waitFor(() => expect($('[data-cost-msat]')).not.toBeNull());
    typeDraft('one');
    click('[data-send]');
    await vi.waitFor(() => expect(text('[data-review-text]')).toBe('one'));
    click('[data-room-back]');
    await vi.waitFor(() => expect($('[data-room-review]')).toBeNull());
    typeDraft('two');
    click('[data-send]');
    await vi.waitFor(() => expect(text('[data-review-text]')).toBe('two'));
    click(`[data-track="peer:${A}"]`);
    await vi.waitFor(() => expect($('[data-room-review]')).toBeNull());
    click(`[data-track="bound:${AB.id}"]`);
    await vi.waitFor(() => expect($('[data-room-draft]')).not.toBeNull());
    expect($('[data-room-review]')).toBeNull();
    expect(host.used('message_send')).toHaveLength(0);
  });

  it('with spending closed (a paused budget, no window) Send is off and the one-tap gate shows; nothing is paid', async () => {
    const host = stubHost({ budget_status: () => budget({ paused: true }) });
    await openShell();
    rememberRoom(AB);
    await vi.waitFor(() => expect($(`[data-track="bound:${AB.id}"]`)).not.toBeNull());
    click(`[data-track="bound:${AB.id}"]`);
    await vi.waitFor(() => expect($('[data-cost-msat]')).not.toBeNull());
    typeDraft('hi');
    expect($<HTMLButtonElement>('[data-send]')!.disabled).toBe(true);
    expect($('[data-room-composer] [data-spend]')).not.toBeNull();
    click('[data-send]');
    expect($('[data-room-review]')).toBeNull();
    expect(host.used('message_send')).toHaveLength(0);
  });

  it('a price raised after it was shown refuses that leg only, with nothing paid for it', async () => {
    const host = stubHost({
      message_send: (args) => {
        if (args!.recipient === A) throw { code: 'price_changed', message: 'Their price went up since it was shown. Nothing was paid.' };
        return receipt(args!.recipient as string, args!.max_msat as number);
      },
    });
    await openShell();
    rememberRoom(AB);
    await vi.waitFor(() => expect($(`[data-track="bound:${AB.id}"]`)).not.toBeNull());
    click(`[data-track="bound:${AB.id}"]`);
    await vi.waitFor(() => expect($('[data-cost-msat]')?.getAttribute('data-cost-msat')).toBe('6000'));
    typeDraft('hi');
    click('[data-send]');
    await vi.waitFor(() => expect($('[data-room-confirm]')).not.toBeNull());
    click('[data-room-confirm]');
    await vi.waitFor(() => expect($('[data-room-send]')).not.toBeNull());
    expect(host.used('message_send').map((c) => [c.args!.recipient, c.args!.max_msat])).toEqual([[A, 2500], [B, 3500]]);
    expect($(`[data-room-leg="${A}"]`)!.getAttribute('data-leg-state')).toBe('failed');
    expect(text(`[data-room-leg="${A}"]`)).toMatch(/Nothing was paid/);
    expect($('[data-room-send-msat]')!.getAttribute('data-room-send-msat')).toBe('3500');
  });

  it('a chat for a room arrives: the room appears with it, unread; it is not shown in the member’s 1:1 thread', async () => {
    const host = stubHost();
    await openShell();
    const plaintext = roomChatText(AB, MSG, 'hi all');
    host.emitLive({ type: 'message', room_id: null, message: { id: 'in1', kind: 0, sender: A, recipient: OWN, timestamp: Date.now(), plaintext, payment_amount_msat: 2000 } });
    await vi.waitFor(() => expect($(`[data-track="bound:${AB.id}"] .badge`)?.textContent).toBe('1'));
    expect(text(`[data-track="bound:${AB.id}"]`)).toMatch(/Maya, Jon/);
    expect(mount.textContent).not.toMatch(/hi all/);
    click(`[data-track="bound:${AB.id}"]`);
    await vi.waitFor(() => expect(text('[data-room-stream] .msg.in .bubble')).toBe('hi all'));
    expect(text('[data-room-stream] .msg.in .who')).toBe('Maya');
  });

  it('the thread is the node’s room thread (both directions, our copies as one message), paged by whole messages', async () => {
    const theirs = (i: number): Message => ({ id: `in${i}`, kind: 0, sender: A, recipient: OWN, timestamp: 10_000 + i, plaintext: roomChatText(AB, i.toString(16).padStart(32, '0'), `hi ${i}`), payment_amount_msat: 2000 });
    const ours: Message = {
      id: 'c2', kind: 0, sender: OWN, recipient: AB.id, timestamp: 5_000, plaintext: roomChatText(AB, MSG, 'first'), payment_amount_msat: 5000,
      copies: [{ recipient: B, id: 'c2', payment_amount_msat: 3000 }, { recipient: A, id: 'c1', payment_amount_msat: 2000 }],
    };
    const host = stubHost({
      room_thread: (args) => (args!.before == null ? Array.from({ length: 50 }, (_, i) => theirs(i)) : [ours]),
    });
    await openShell();
    rememberRoom(AB);
    await vi.waitFor(() => expect($(`[data-track="bound:${AB.id}"]`)).not.toBeNull());
    const before = host.used('messages_list').length;
    click(`[data-track="bound:${AB.id}"]`);
    await vi.waitFor(() => expect(mount.querySelectorAll('[data-room-stream] .msg.in')).toHaveLength(50));
    expect(host.used('room_thread')[0].args).toEqual({ room: AB.id, before: null, limit: 50 });
    // Not read member by member from their 1:1 histories.
    expect(host.used('messages_list')).toHaveLength(before);
    click('[data-room-earlier]');
    await vi.waitFor(() => expect($('[data-room-stream] .msg.out')).not.toBeNull());
    expect(host.used('room_thread')[1].args).toEqual({ room: AB.id, before: 10_000, limit: 50 });
    expect($('[data-room-earlier]')).toBeNull();
    expect(mount.querySelectorAll('[data-room-stream] .msg')).toHaveLength(51);
    expect($('[data-room-stream] .msg.out')!.getAttribute('data-room-copies')).toBe('2');
    expect(text('[data-room-stream] .msg.out [data-room-to]')).toMatch(/to Maya, Jon/);
    expect(text('[data-room-stream] .msg.out .bubble')).toBe('first');
    expect(host.used('message_send')).toHaveLength(0);
  });

  it('a member refused before paying reads as the host’s plain sentence, for that member only; the next member is still sent', async () => {
    const sentence = 'Not sent - nothing was paid. There is no secure session with them yet. Message them once in their own chat first; a room never pays a first contact.';
    const host = stubHost({
      message_send: (args) => {
        if (args!.recipient === A) throw { code: 'not_dispatched', message: sentence };
        return receipt(args!.recipient as string, args!.max_msat as number, 2);
      },
    });
    await openShell();
    rememberRoom(AB);
    await vi.waitFor(() => expect($(`[data-track="bound:${AB.id}"]`)).not.toBeNull());
    click(`[data-track="bound:${AB.id}"]`);
    await vi.waitFor(() => expect($('[data-cost-msat]')?.getAttribute('data-cost-msat')).toBe('6000'));
    typeDraft('hi');
    click('[data-send]');
    await vi.waitFor(() => expect($('[data-room-confirm]')).not.toBeNull());
    click('[data-room-confirm]');
    await vi.waitFor(() => expect($('[data-room-send]')).not.toBeNull());
    expect(host.used('message_send').map((c) => c.args!.recipient)).toEqual([A, B]);
    expect(text(`[data-room-leg="${A}"] [data-room-leg-note]`)).toBe(sentence);
    expect(text('[data-room-send]')).not.toMatch(/room_|not_dispatched/);
    expect($(`[data-room-leg="${B}"]`)!.getAttribute('data-leg-state')).toBe('sent');
  });

  it('a member’s node refusing our paid copy shows in the room as a sentence, for that member', async () => {
    const host = stubHost();
    await openShell();
    rememberRoom(AB);
    await vi.waitFor(() => expect($(`[data-track="bound:${AB.id}"]`)).not.toBeNull());
    click(`[data-track="bound:${AB.id}"]`);
    await vi.waitFor(() => expect($('[data-cost-msat]')?.getAttribute('data-cost-msat')).toBe('6000'));
    typeDraft('hi');
    click('[data-send]');
    await vi.waitFor(() => expect($('[data-room-confirm]')).not.toBeNull());
    click('[data-room-confirm]');
    await vi.waitFor(() => expect($('[data-room-stream] .msg.out')).not.toBeNull());
    const maya = host.used('message_send').findIndex((c) => c.args!.recipient === A);
    host.emitLive({ type: 'delivery', message_id: `r${maya + 1}`, status: 'rejected', reason: 'room_binding_invalid: invalid room binding: room id does not commit to this roster and salt' });
    await vi.waitFor(() => expect($(`[data-room-refused="${A}"]`)).not.toBeNull());
    expect(text(`[data-room-refused="${A}"]`)).toBe('Maya: Their node could not match this room’s details, so it refused the message. It was paid; do not send it again.');
    expect($(`[data-room-refused="${B}"]`)).toBeNull();
  });

  it('a paid, undelivered leg shows its confirmed all-in maximum, not only what reached them', async () => {
    const host = stubHost({
      message_send: (args) => {
        if (args!.recipient === A) throw { code: 'payment_settled_undelivered', message: 'Paid, not delivered yet.', undelivered: { paid_msat: 2100, retry: true } };
        return receipt(args!.recipient as string, args!.max_msat as number, 2);
      },
    });
    await openShell();
    rememberRoom(AB);
    await vi.waitFor(() => expect($(`[data-track="bound:${AB.id}"]`)).not.toBeNull());
    click(`[data-track="bound:${AB.id}"]`);
    await vi.waitFor(() => expect($('[data-cost-msat]')?.getAttribute('data-cost-msat')).toBe('6000'));
    typeDraft('hi');
    click('[data-send]');
    await vi.waitFor(() => expect($('[data-room-confirm]')).not.toBeNull());
    click('[data-room-confirm]');
    await vi.waitFor(() => expect($('[data-room-send]')).not.toBeNull());
    expect(host.used('message_send')).toHaveLength(1);
    expect($(`[data-room-leg="${A}"]`)!.getAttribute('data-leg-state')).toBe('undelivered');
    expect($('[data-room-send-msat]')!.getAttribute('data-room-send-msat')).toBe('2500');
    expect(text(`[data-room-leg="${A}"]`)).toMatch(/up to 2\.5 sats \(2\.1 sats to them, plus a network fee\)/);
    expect(text('[data-room-send] .kind')).toMatch(/up to 2\.5 sats in all/);
  });

  it('a room chat with legal leading JSON whitespace goes to its room, never the direct chat, and stays hidden after Leave', async () => {
    const host = stubHost();
    await openShell();
    const spaced = (text: string) => `\n  ${roomChatText(AB, MSG, text)}`;
    host.emitLive({ type: 'message', room_id: null, message: { id: 'w1', kind: 0, sender: A, recipient: OWN, timestamp: Date.now(), plaintext: spaced('spaced hello'), payment_amount_msat: 2000 } });
    await vi.waitFor(() => expect($(`[data-track="bound:${AB.id}"] .badge`)?.textContent).toBe('1'));
    // Maya's direct chat is open: the binding never shows there.
    expect(mount.textContent).not.toMatch(/spaced hello|"roster"/);
    click(`[data-track="bound:${AB.id}"]`);
    await vi.waitFor(() => expect(text('[data-room-stream] .msg.in .bubble')).toBe('spaced hello'));
    click('[data-room-leave]');
    click('[data-room-leave-yes]');
    await vi.waitFor(() => expect($(`[data-track="bound:${AB.id}"]`)).toBeNull());
    host.emitLive({ type: 'message', room_id: null, message: { id: 'w2', kind: 0, sender: A, recipient: OWN, timestamp: Date.now(), plaintext: spaced('after leave'), payment_amount_msat: 2000 } });
    click(`[data-track="peer:${A}"]`);
    await vi.waitFor(() => expect($(`[data-track="peer:${A}"]`)?.getAttribute('aria-current')).toBe('true'));
    await new Promise((r) => setTimeout(r, 30));
    expect(mount.textContent).not.toMatch(/after leave|"roster"/);
    expect($(`[data-track="bound:${AB.id}"]`)).toBeNull();
  });

  it('a chat naming a room id that does not commit to its roster never becomes a room', async () => {
    const host = stubHost();
    await openShell();
    const forged = { ...AB, roster: makeRoster(OWN, [A, C]) };
    host.emitLive({ type: 'message', room_id: null, message: { id: 'f1', kind: 0, sender: A, recipient: OWN, timestamp: Date.now(), plaintext: roomChatText(forged, MSG, 'sneaky'), payment_amount_msat: 2000 } });
    await new Promise((r) => setTimeout(r, 30));
    expect(localRooms()).toEqual([]);
    expect($(`[data-track="bound:${AB.id}"]`)).toBeNull();
    expect(mount.textContent).not.toMatch(/sneaky/);
  });

  it('Leave is local: nothing is sent, the room is hidden, and later chats to it stay hidden', async () => {
    const host = stubHost();
    await openShell();
    rememberRoom(AB);
    await vi.waitFor(() => expect($(`[data-track="bound:${AB.id}"]`)).not.toBeNull());
    click(`[data-track="bound:${AB.id}"]`);
    await vi.waitFor(() => expect($('[data-room-leave]')).not.toBeNull());
    click('[data-room-leave]');
    expect(text('[data-room-leave-confirm]')).toMatch(/this device only.*Nobody is told and nothing is paid/);
    click('[data-room-leave-yes]');
    await vi.waitFor(() => expect($(`[data-track="bound:${AB.id}"]`)).toBeNull());
    const plaintext = roomChatText(AB, MSG, 'still here?');
    host.emitLive({ type: 'message', room_id: null, message: { id: 'in2', kind: 0, sender: A, recipient: OWN, timestamp: Date.now(), plaintext, payment_amount_msat: 2000 } });
    await new Promise((r) => setTimeout(r, 20));
    expect($(`[data-track="bound:${AB.id}"]`)).toBeNull();
    expect(host.used('message_send')).toHaveLength(0);
  });
});
