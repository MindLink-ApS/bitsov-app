/**
 * Calls on a node that advertises the newer call capabilities, and on one
 * that does not:
 * - `call_reply_free_v1`, on our node and on the caller's: Accept sends the
 *   answer, and Decline the declined hangup, as a free reply (zero cap, no
 *   grant, no spend request). Anything less keeps today's paths: a paid
 *   Accept, and Decline as the local Ignore. A reply shown as free is never
 *   retried paid, and an unknown delivery stays unknown.
 * - `call_continuity_v1`: a call admitted near the end of the box approval
 *   goes on after it; without it, the approval must outlast the call.
 * - Ready for calls only with a live grant that can carry a call.
 * - On a node without continuity, a call cut when its approval ran out says so.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLanguagePref } from '../src/i18n';
import { createCallEngine, type CallDeps, type CallView } from '../src/control/call';
import { callEndLine } from '../src/control/callEnd';
import { callContinuity, callReadiness, freeReplies, standingAllowance } from '../src/control/callCapabilities';
import type { ActionError, CallQuote, CallReceipt, Message, NodeGrantSummary, Peer } from '../src/control/types';

const OWN = '1'.repeat(64);
const A = 'a'.repeat(64);
const ID = '0123456789abcdef0123456789abcdef';
const QUOTE: CallQuote = { offer_msat: 10_000, offer_max_routing_fee_msat: 5_000, signal_msat: 1_000, signal_max_routing_fee_msat: 5_000, call_total_msat: 21_000 };
const CLI = /konsensus\s|--op\b|--config\b|Terminal|\bCLI\b|owner_action/;

class FakePc {
  iceGatheringState = 'complete';
  connectionState = 'new';
  iceConnectionState = 'new';
  localDescription: { type: string; sdp: string } | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  ontrack: ((e: unknown) => void) | null = null;
  async getStats() { return new Map(); }
  addTrack() { return { track: null, replaceTrack: async () => {} }; }
  async createOffer() { return { type: 'offer', sdp: 'v=0 offer' }; }
  async createAnswer() { return { type: 'answer', sdp: 'v=0 answer' }; }
  async setLocalDescription(d: { type: string; sdp: string }) { this.localDescription = d; }
  async setRemoteDescription() {}
  async addIceCandidate() {}
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
const stream = () => {
  const tracks = [{ kind: 'audio', enabled: true, stop: vi.fn() }];
  return { getTracks: () => tracks, getAudioTracks: () => tracks, getVideoTracks: () => [], addTrack: () => {}, removeTrack: () => {} } as unknown as MediaStream;
};

type Sent = { kind: number; body: Record<string, unknown>; max: number };
type FreeSent = { peer: string; kind: number; body: Record<string, unknown> };
type Outcome<T> = { ok: true; value: T } | { ok: false; error: ActionError };
const FREE: CallReceipt = { message_id: 'r1', kind: 403, amount_msat: 0, total_msat: 0, max_routing_fee_msat: 0, delivered: true, accepted: true, sent_at_ms: 0 };

function engine(over: Partial<CallDeps> & { free?: boolean; reply?: (kind: number) => Promise<Outcome<CallReceipt>> } = {}) {
  const sent: Sent[] = [];
  const freeSent: FreeSent[] = [];
  const views: CallView[] = [];
  const spendRequests: string[] = [];
  const { free, reply, ...deps } = over;
  const e = createCallEngine({
    quote: async () => ({ ok: true, value: QUOTE }),
    signal: async (_peer, kind, plaintext, max) => {
      sent.push({ kind, body: JSON.parse(plaintext), max });
      return { ok: true, value: { message_id: 'm', kind, amount_msat: 1_000, total_msat: 6_000, max_routing_fee_msat: 5_000, delivered: true, accepted: true, sent_at_ms: 0 } };
    },
    authorize: async () => true,
    getUserMedia: async () => stream(),
    peerConnection: () => new FakePc() as unknown as RTCPeerConnection,
    now: () => 1_000,
    onView: (v) => views.push(v),
    onStreams: () => {},
    onBudgetNeeded: () => { spendRequests.push('budget'); },
    freeReply: () => free === true,
    sendFree: async (peer, kind, plaintext) => {
      freeSent.push({ peer, kind, body: JSON.parse(plaintext) });
      return reply ? reply(kind) : { ok: true, value: { ...FREE, kind } };
    },
    ...deps,
  });
  return { e, sent, freeSent, views, spendRequests, last: () => views[views.length - 1] };
}

const offer = (): Message => ({ id: 'in-400', kind: 400, sender: A, recipient: OWN, timestamp: 0,
  plaintext: JSON.stringify({ v: 1, call_id: ID, media: 'audio', sdp: 'offer' }), payment_amount_msat: 1_000 });

afterEach(() => { setLanguagePref('en'); vi.useRealTimers(); });

describe('which call capabilities count (P22)', () => {
  const peer = (over: Partial<Peer>): Peer => ({ node_id: A, addr: null, label: null, connected: true, fingerprint: null, ...over });
  const OWN_CAPS: [string, readonly string[] | null | undefined][] = [
    ['missing', undefined], ['empty (rc24)', []], ['continuity only', ['call_continuity_v1']], ['free replies', ['call_reply_free_v1']],
    ['a near name', ['call_reply_free_v2', 'call_reply_free']], ['allowance only', ['standing_allowance_v1']],
    ['everything', ['call_continuity_v1', 'call_reply_free_v1', 'standing_allowance_v1']],
  ];
  const PEERS: [string, Peer | null | undefined][] = [
    ['unknown', undefined], ['free, connected', peer({ free_replies: true })], ['free, offline', peer({ free_replies: true, connected: false })],
    ['legacy (rc24)', peer({})], ['flag absent', peer({ free_replies: undefined })],
  ];
  it.each(OWN_CAPS.flatMap(([o, caps]) => PEERS.map(([p, who]) => [o, p, caps, who] as const)))(
    'own node %s × caller %s: free only when both advertise it; continuity is our node’s alone', (_o, _p, caps, who) => {
      const ownFree = !!caps?.includes('call_reply_free_v1');
      const peerFree = who?.connected === true && who.free_replies === true;
      expect(freeReplies(caps, who)).toBe(ownFree && peerFree);
      expect(callContinuity(caps)).toBe(!!caps?.includes('call_continuity_v1'));
      expect(standingAllowance(caps)).toBe(!!caps?.includes('standing_allowance_v1'));
    });
});

describe('ready for calls only with a live grant (A6)', () => {
  const NOW = 1_790_000_000_000;
  const grant = (minutesLeft: number, remaining = 2_000_000): NodeGrantSummary => ({
    budget_msat: 2_000_000, remaining_msat: remaining, per_call_max_msat: 700_000, expires_at_ms: NOW + minutesLeft * 60_000, envelopes: null });
  it.each([
    ['no grant', null, false, { ready: false, reason: 'no_grant' }],
    ['an expired grant', grant(-1), true, { ready: false, reason: 'no_grant' }],
    ['a used-up grant', grant(600, 0), true, { ready: false, reason: 'no_grant' }],
    ['a whole day, legacy node', grant(1_440), false, { ready: true }],
    ['a whole day, continuity node', grant(1_440), true, { ready: true }],
    ['5 minutes left, legacy node', grant(5), false, { ready: false, reason: 'window_short', minutesLeft: 5 }],
    ['5 minutes left, continuity node', grant(5), true, { ready: true }],
    ['240 minutes left with an unknown limit, legacy node', grant(240), false, { ready: false, reason: 'window_short', minutesLeft: 240 }],
    ['a grant that allows no call payment', { ...grant(1_440), call_per_payment_max_msat: 0 }, true, { ready: false, reason: 'call_limit' }],
    ['a grant whose only per-call limit is zero', { ...grant(1_440), per_call_max_msat: 0 }, true, { ready: false, reason: 'call_limit' }],
    ['a relation grant (each contact’s envelope binds)', { ...grant(1_440), per_call_max_msat: 0, call_per_payment_max_msat: null, envelopes: { [A]: NOW + 86_400_000 } }, true, { ready: true }],
  ] as const)('%s', (_name, g, continuity, expected) => {
    expect(callReadiness({ grant: g, now: NOW, continuity })).toEqual(expected);
  });
  it('a standing allowance advertised alone is no proof of a live allowance or of funds: not ready', () => {
    expect(standingAllowance(['standing_allowance_v1'])).toBe(true);
    expect(callReadiness({ grant: null, now: NOW, continuity: true })).toEqual({ ready: false, reason: 'no_grant' });
  });
});

describe('Decline and Accept with free replies (A4)', () => {
  it('on a legacy node or caller, Decline is the local Ignore: nothing is posted, paid or requested', async () => {
    const t = engine({ free: false });
    await t.e.receive(offer(), OWN);
    await t.e.refuse();
    expect(t.sent).toEqual([]);
    expect(t.freeSent).toEqual([]);
    expect(t.spendRequests).toEqual([]);
    expect(t.last().phase).toBe('idle');
  });

  it('with free replies on both nodes, Decline posts one free declined hangup bound to the call, and says they were told', async () => {
    const authorize = vi.fn(async () => true);
    const t = engine({ free: true, authorize });
    await t.e.receive(offer(), OWN);
    await t.e.refuse();
    expect(t.freeSent).toEqual([{ peer: A, kind: 403, body: { v: 1, call_id: ID, reason: 'declined' } }]);
    expect(t.sent).toEqual([]);
    expect(authorize).not.toHaveBeenCalled();
    expect(t.spendRequests).toEqual([]);
    expect(t.last()).toMatchObject({ phase: 'ended', reason: 'declined', paidMsat: 0, pendingCount: 0, unknownCount: 0, freeDecline: 'delivered' });
    expect(callEndLine(t.last(), 'Maya').text).toBe('Declined. They were told, and it cost nothing.');
    setLanguagePref('da');
    expect(callEndLine(t.last(), 'Maya').text).toBe('Afvist. Den anden fik besked, og det kostede intet.');
  });

  it.each([
    ['refused by the node', { ok: false, error: { code: 'call_reply_not_sent', message: 'Your node did not send this reply for free, so it was not sent. Nothing was paid.' } as ActionError }, 'not_sent',
      'Declined here, but they were not told, so their phone keeps ringing until the call times out. Nothing was paid.',
      'Afvist her, men den anden fik ikke besked, så det ringer hos dem, til opkaldet udløber. Intet blev betalt.'],
    ['an unknown delivery', { ok: false, error: { code: 'call_reply_unknown', message: 'unknown' } as ActionError }, 'unknown',
      'Declined here. It is not known yet whether they were told. Nothing was paid.',
      'Afvist her. Det vides endnu ikke, om den anden fik besked. Intet blev betalt.'],
    ['written to their node but not accepted', { ok: true, value: { ...FREE, delivered: true, accepted: false } }, 'unknown',
      'Declined here. It is not known yet whether they were told. Nothing was paid.',
      'Afvist her. Det vides endnu ikke, om den anden fik besked. Intet blev betalt.'],
    ['sent but not yet delivered', { ok: true, value: { ...FREE, delivered: false, accepted: false } }, 'unknown',
      'Declined here. It is not known yet whether they were told. Nothing was paid.',
      'Afvist her. Det vides endnu ikke, om den anden fik besked. Intet blev betalt.'],
  ] as const)('a free Decline %s is never retried paid, and says only what is known', async (_name, outcome, state, en, da) => {
    const t = engine({ free: true, reply: async () => outcome as Outcome<CallReceipt> });
    await t.e.receive(offer(), OWN);
    await t.e.refuse();
    await t.e.refuse();
    expect(t.freeSent).toHaveLength(1);
    expect(t.sent).toEqual([]);
    expect(t.last()).toMatchObject({ phase: 'ended', reason: 'declined', paidMsat: 0, unknownCount: 0, freeDecline: state });
    expect(callEndLine(t.last(), 'Maya').text).toBe(en);
    setLanguagePref('da');
    expect(callEndLine(t.last(), 'Maya').text).toBe(da);
  });

  it('a free Decline whose host call never returns is unknown, never paid', async () => {
    vi.useFakeTimers();
    const t = engine({ free: true, reply: () => new Promise(() => {}) });
    await t.e.receive(offer(), OWN);
    const declining = t.e.refuse();
    await vi.advanceTimersByTimeAsync(60_000);
    await declining;
    expect(t.sent).toEqual([]);
    expect(t.last().freeDecline).toBe('unknown');
  });

  it('with free replies on both nodes, Accept sends a free answer and never a paid one', async () => {
    const t = engine({ free: true });
    await t.e.receive(offer(), OWN);
    await t.e.accept(QUOTE);
    expect(t.freeSent.map((s) => [s.kind, s.body.call_id, typeof s.body.sdp])).toEqual([[401, ID, 'string']]);
    expect(t.sent).toEqual([]);
    expect(t.last()).toMatchObject({ paidMsat: 0, pendingCount: 0, unknownCount: 0 });
  });

  it.each([
    ['no price could be read', async () => ({ ok: false, error: { code: 'call_price_unknown', message: 'no price' } as ActionError }), QUOTE],
    ['the live price rose', async () => ({ ok: true, value: { ...QUOTE, signal_msat: QUOTE.signal_msat + 1 } }), QUOTE],
    ['the price never answers', () => new Promise<Outcome<CallQuote>>(() => {}), QUOTE],
    ['no price was shown', async () => ({ ok: true, value: QUOTE }), null],
  ] as const)('a free Accept does not depend on the price: %s, and it still answers free', async (_name, quote, shown) => {
    const t = engine({ free: true, quote: quote as CallDeps['quote'] });
    await t.e.receive(offer(), OWN);
    await t.e.accept(shown);
    expect(t.freeSent.map((s) => [s.kind, s.body.call_id])).toEqual([[401, ID]]);
    expect(t.sent).toEqual([]);
    expect(t.last()).toMatchObject({ phase: 'connecting', error: null, paidMsat: 0 });
  });

  /** The callee's media: connected, then failed, as when the network drops. */
  const drop = (pc: FakePc) => {
    pc.connectionState = 'connected'; pc.onconnectionstatechange?.();
    pc.connectionState = 'failed'; pc.onconnectionstatechange?.();
  };
  /** A price that never answers for the free Accept, then `later` for every read after it. */
  const pricedLater = (later: () => Promise<Outcome<CallQuote>>) => {
    let reads = 0;
    return () => reads++ === 0 ? new Promise<Outcome<CallQuote>>(() => {}) : later();
  };

  it('End of a call answered free, whose price never came, reads it then and sends the hangup: the caller ends too', async () => {
    vi.useFakeTimers();
    const t = engine({ free: true, quote: pricedLater(async () => ({ ok: true, value: QUOTE })) });
    await t.e.receive(offer(), OWN);
    await t.e.accept(QUOTE);
    await t.e.hangup();
    expect(t.sent.map((s) => [s.kind, s.body.call_id, s.body.reason, s.max])).toEqual([[403, ID, 'hangup', 6_000]]);
    expect(t.last()).toMatchObject({ phase: 'ended', reason: 'hangup', hangupUnsent: false });
    // The caller's side of the same call ends on that hangup.
    const caller = engine({ free: false, newCallId: () => ID,
      signal: async (_peer, kind) => ({ ok: true, value: { operation_id: 'offer-op', message_id: 'm', kind, amount_msat: 10_000, total_msat: 15_000, max_routing_fee_msat: 5_000, delivered: true, accepted: true, sent_at_ms: 0 } }) });
    await caller.e.place(A, 'audio', QUOTE);
    await caller.e.receive({ id: 'in-401', kind: 401, sender: A, recipient: OWN, timestamp: 0, plaintext: JSON.stringify({ v: 1, call_id: ID, sdp: 'answer' }), payment_amount_msat: 0 }, OWN);
    // Their node binds the hangup it received to this call's admission.
    await caller.e.receive({ id: 'in-403', kind: 403, sender: A, recipient: OWN, timestamp: 0, plaintext: JSON.stringify(t.sent[0].body), payment_amount_msat: 1_000, admission_operation_id: 'offer-op' }, OWN);
    expect(caller.last().phase).toBe('ended');
  });

  it.each([
    ['refused', async () => ({ ok: false, error: { code: 'call_price_unknown', message: 'no price' } as ActionError })],
    ['never answers', () => new Promise<Outcome<CallQuote>>(() => {})],
  ] as const)('End of a call answered free when its price is %s says they may still be on the line; nothing is paid', async (_name, later) => {
    vi.useFakeTimers();
    const t = engine({ free: true, quote: pricedLater(later as () => Promise<Outcome<CallQuote>>) });
    await t.e.receive(offer(), OWN);
    await t.e.accept(QUOTE);
    const ending = t.e.hangup();
    await vi.advanceTimersByTimeAsync(60_000);
    await ending;
    expect(t.sent).toEqual([]);
    expect(t.last()).toMatchObject({ phase: 'ended', reason: 'hangup', hangupUnsent: true, paidMsat: 0 });
    expect(callEndLine(t.last(), 'Maya').text).toBe('Hung up here, but they could not be told: their call price could not be read. They may still be on the line until the call ends by itself. Nothing was paid for it.');
    setLanguagePref('da');
    expect(callEndLine(t.last(), 'Maya').text).toMatch(/^Lagt på her/);
  });

  it.each([
    ['read then', async () => ({ ok: true, value: QUOTE }) as Outcome<CallQuote>, true],
    ['unreadable', async () => ({ ok: false, error: { code: 'call_price_unknown', message: 'no price' } as ActionError }) as Outcome<CallQuote>, false],
  ] as const)('a dropped call answered free asks the caller to reconnect when its price is %s', async (_name, later, sends) => {
    vi.useFakeTimers();
    const pcs: FakePc[] = [];
    const t = engine({ free: true, quote: pricedLater(later), peerConnection: () => { const pc = new FakePc(); pcs.push(pc); return pc as unknown as RTCPeerConnection; } });
    await t.e.receive(offer(), OWN);
    await t.e.accept(QUOTE);
    drop(pcs[0]);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sent.map((s) => [s.kind, s.body.sdp_mid])).toEqual(sends ? [[402, 'bitsov-restart-v1']] : []);
    if (!sends) expect(t.last().recoveryError).toBe('Their call price could not be read, so this was not sent. Nothing was paid.');
    t.e.endLocal();
  });

  it.each([
    ['approved', true, [[402, 'bitsov-restart-v1']]],
    ['refused', false, []],
  ] as const)('a call answered free asks before a paid reconnect even on a node that keeps calls: %s', async (_name, later, sends) => {
    vi.useFakeTimers();
    const pcs: FakePc[] = [];
    let approved = true;
    const authorize = vi.fn(async () => approved);
    const t = engine({ free: true, authorize, callContinuity: () => true, quote: pricedLater(async () => ({ ok: true, value: QUOTE }) as Outcome<CallQuote>),
      peerConnection: () => { const pc = new FakePc(); pcs.push(pc); return pc as unknown as RTCPeerConnection; } });
    await t.e.receive(offer(), OWN);
    await t.e.accept(QUOTE);
    approved = later;
    authorize.mockClear();
    drop(pcs[0]);
    await vi.advanceTimersByTimeAsync(0);
    // The free answer consented to no spending: the paid reconnect request asks first.
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(t.sent.map((s) => [s.kind, s.body.sdp_mid])).toEqual(sends);
    t.e.endLocal();
  });

  it('a refused ask after a free answer keeps the reconnect: once approved, the next drop sends it once', async () => {
    vi.useFakeTimers();
    const pcs: FakePc[] = [];
    let approved = true;
    const authorize = vi.fn(async () => approved);
    const t = engine({ free: true, authorize, callContinuity: () => true, quote: pricedLater(async () => ({ ok: true, value: QUOTE }) as Outcome<CallQuote>),
      peerConnection: () => { const pc = new FakePc(); pcs.push(pc); return pc as unknown as RTCPeerConnection; } });
    await t.e.receive(offer(), OWN);
    await t.e.accept(QUOTE);
    approved = false;
    drop(pcs[0]);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sent).toEqual([]);
    expect(t.last().recoveryUsed).toBe(false);
    approved = true;
    drop(pcs[0]);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sent.map((s) => [s.kind, s.body.sdp_mid])).toEqual([[402, 'bitsov-restart-v1']]);
    expect(t.last().recoveryUsed).toBe(true);
    t.e.endLocal();
  });

  it('an ask left open when a call ends does not block the next call\'s reconnect, and its late answer sends nothing', async () => {
    vi.useFakeTimers();
    const pcs: FakePc[] = [];
    const pending: ((ok: boolean) => void)[] = [];
    let holdAsks = false;
    const authorize = vi.fn(() => holdAsks ? new Promise<boolean>((r) => { pending.push(r); }) : Promise.resolve(true));
    const t = engine({ free: true, authorize, callContinuity: () => true, quote: pricedLater(async () => ({ ok: true, value: QUOTE }) as Outcome<CallQuote>),
      peerConnection: () => { const pc = new FakePc(); pcs.push(pc); return pc as unknown as RTCPeerConnection; } });
    await t.e.receive(offer(), OWN);
    await t.e.accept(QUOTE);
    // The first call drops and its reconnect ask stays open; then the call ends.
    holdAsks = true;
    drop(pcs[0]);
    await vi.advanceTimersByTimeAsync(0);
    expect(pending).toHaveLength(1);
    t.e.endLocal();
    await vi.advanceTimersByTimeAsync(0);
    // A second call on the same engine drops: it asks for its own reconnect at once.
    holdAsks = false;
    const before = t.sent.length;
    await t.e.receive({ ...offer(), id: 'in-400-2', plaintext: JSON.stringify({ v: 1, call_id: 'c'.repeat(32), media: 'audio', sdp: 'offer' }) }, OWN);
    await t.e.accept(QUOTE);
    const asked = authorize.mock.calls.length;
    drop(pcs[pcs.length - 1]);
    await vi.advanceTimersByTimeAsync(0);
    expect(authorize.mock.calls.length).toBe(asked + 1);
    expect(t.sent.slice(before).filter((s) => s.kind === 402)).toHaveLength(1);
    // The first call's late approval changes nothing: no second request, the new call's recovery used once.
    pending[0](true);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sent.slice(before).filter((s) => s.kind === 402)).toHaveLength(1);
    expect(t.last().recoveryUsed).toBe(true);
    t.e.endLocal();
  });

  it('a paid call whose reconnect approval is refused keeps the reconnect: once approved, the next drop sends it once', async () => {
    vi.useFakeTimers();
    const pcs: FakePc[] = [];
    let approved = true;
    const authorize = vi.fn(async () => approved);
    const t = engine({ authorize, peerConnection: () => { const pc = new FakePc(); pcs.push(pc); return pc as unknown as RTCPeerConnection; } });
    await t.e.receive(offer(), OWN);
    await t.e.accept(QUOTE);
    const answered = t.sent.length;
    approved = false;
    drop(pcs[0]);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sent.slice(answered)).toEqual([]);
    expect(t.last().recoveryUsed).toBe(false);
    approved = true;
    drop(pcs[0]);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sent.slice(answered).map((s) => [s.kind, s.body.sdp_mid])).toEqual([[402, 'bitsov-restart-v1']]);
    expect(t.last().recoveryUsed).toBe(true);
    t.e.endLocal();
  });

  it('a paid call refused approval for the caller\'s restart keeps the recovery: a later offer, once approved, is answered once', async () => {
    vi.useFakeTimers();
    let approved = true;
    const authorize = vi.fn(async () => approved);
    const pcs: FakePc[] = [];
    const t = engine({ authorize, peerConnection: () => { const pc = new FakePc(); pcs.push(pc); return pc as unknown as RTCPeerConnection; } });
    await t.e.receive(offer(), OWN);
    await t.e.accept(QUOTE);
    pcs[0].connectionState = 'connected'; pcs[0].onconnectionstatechange?.();
    const answered = t.sent.filter((s) => s.kind === 401).length;
    approved = false;
    const restartOffer = (n: string): Message => ({ id: `in-400-${n}`, kind: 400, sender: A, recipient: OWN, timestamp: 0, payment_amount_msat: 1_000,
      plaintext: JSON.stringify({ v: 1, call_id: n.repeat(32), media: 'audio', sdp: `v=0 offer\r\na=x-bitsov-restart-of:${ID}\r\n` }) });
    await t.e.receive(restartOffer('e'), OWN);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sent.filter((s) => s.kind === 401)).toHaveLength(answered);
    expect(t.last().recoveryUsed).toBe(false);
    approved = true;
    await t.e.receive(restartOffer('f'), OWN);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sent.filter((s) => s.kind === 401)).toHaveLength(answered + 1);
    expect(t.last().recoveryUsed).toBe(true);
    t.e.endLocal();
  });

  it('a call answered free asks before it pays to answer the caller\'s restart, and pays nothing when refused', async () => {
    vi.useFakeTimers();
    let approved = true;
    const authorize = vi.fn(async () => approved);
    const pcs: FakePc[] = [];
    const t = engine({ free: true, authorize, callContinuity: () => true, quote: pricedLater(async () => ({ ok: true, value: QUOTE }) as Outcome<CallQuote>),
      peerConnection: () => { const pc = new FakePc(); pcs.push(pc); return pc as unknown as RTCPeerConnection; } });
    await t.e.receive(offer(), OWN);
    await t.e.accept(QUOTE);
    pcs[0].connectionState = 'connected'; pcs[0].onconnectionstatechange?.();
    approved = false;
    authorize.mockClear();
    await t.e.receive({ id: 'in-400-r', kind: 400, sender: A, recipient: OWN, timestamp: 0, payment_amount_msat: 1_000,
      plaintext: JSON.stringify({ v: 1, call_id: 'e'.repeat(32), media: 'audio', sdp: `v=0 offer\r\na=x-bitsov-restart-of:${ID}\r\n` }) }, OWN);
    await vi.advanceTimersByTimeAsync(0);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(t.sent.filter((s) => s.kind === 401)).toEqual([]);
    t.e.endLocal();
  });

  it('a refused ask on the caller\'s restart keeps the recovery: a later offer, once approved, is answered once', async () => {
    vi.useFakeTimers();
    let approved = true;
    let release!: (ok: boolean) => void;
    let held = false;
    const authorize = vi.fn(() => held ? new Promise<boolean>((r) => { release = r; }) : Promise.resolve(approved));
    const pcs: FakePc[] = [];
    const t = engine({ free: true, authorize, callContinuity: () => true, quote: pricedLater(async () => ({ ok: true, value: QUOTE }) as Outcome<CallQuote>),
      peerConnection: () => { const pc = new FakePc(); pcs.push(pc); return pc as unknown as RTCPeerConnection; } });
    await t.e.receive(offer(), OWN);
    await t.e.accept(QUOTE);
    pcs[0].connectionState = 'connected'; pcs[0].onconnectionstatechange?.();
    approved = false;
    authorize.mockClear();
    const restartOffer = (n: string): Message => ({ id: `in-400-${n}`, kind: 400, sender: A, recipient: OWN, timestamp: 0, payment_amount_msat: 1_000,
      plaintext: JSON.stringify({ v: 1, call_id: n.repeat(32), media: 'audio', sdp: `v=0 offer\r\na=x-bitsov-restart-of:${ID}\r\n` }) });
    // Refused: nothing answered, and the one recovery is still unused.
    await t.e.receive(restartOffer('e'), OWN);
    await vi.advanceTimersByTimeAsync(0);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(t.sent.filter((s) => s.kind === 401)).toEqual([]);
    expect(t.last().recoveryUsed).toBe(false);
    // While a second ask is pending, a duplicate offer neither asks again nor spends the recovery.
    held = true;
    const first = t.e.receive(restartOffer('f'), OWN);
    const dup = t.e.receive(restartOffer('f'), OWN);
    await vi.advanceTimersByTimeAsync(0);
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(t.last().recoveryUsed).toBe(false);
    // Approved: answered exactly once, and only now is the recovery spent.
    release(true);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([first, dup]);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sent.filter((s) => s.kind === 401)).toHaveLength(1);
    expect(t.last().recoveryUsed).toBe(true);
    t.e.endLocal();
  });

  /** A price for the free Accept that never answers, then one the test answers by hand. */
  const pricedByHand = () => {
    let reads = 0;
    let answer!: (q: Outcome<CallQuote>) => void;
    const quote = () => reads++ === 0 ? new Promise<Outcome<CallQuote>>(() => {}) : new Promise<Outcome<CallQuote>>((r) => { answer = r; });
    return { quote, answer: (q: Outcome<CallQuote>) => answer(q) };
  };
  const otherOffer = (): Message => ({ id: 'in-400-b', kind: 400, sender: A, recipient: OWN, timestamp: 0,
    plaintext: JSON.stringify({ v: 1, call_id: 'b'.repeat(32), media: 'audio', sdp: 'offer' }), payment_amount_msat: 1_000 });

  it.each([
    ['Close is pressed', async (t: ReturnType<typeof engine>) => { t.e.dismiss(); }],
    ['a new call rings', async (t: ReturnType<typeof engine>) => { await t.e.receive(otherOffer(), OWN); }],
    ['a waiting call is accepted', async (t: ReturnType<typeof engine>) => { await t.e.receive(otherOffer(), OWN); await t.e.acceptWaiting(`${A}:${'b'.repeat(32)}`, QUOTE); }],
  ] as const)('the hangup of a call answered free is owed while its price is read: when %s, the card stays and the hangup still goes', async (_name, meanwhile) => {
    const price = pricedByHand();
    const t = engine({ free: true, quote: price.quote });
    await t.e.receive(offer(), OWN);
    await t.e.accept(QUOTE);
    const ending = t.e.hangup();
    await Promise.resolve();
    expect(t.last()).toMatchObject({ phase: 'ended', callId: ID, pendingCount: 1 });
    await meanwhile(t);
    expect(t.e.view()).toMatchObject({ phase: 'ended', callId: ID });
    price.answer({ ok: true, value: QUOTE });
    await ending;
    expect(t.sent.map((s) => [s.kind, s.body.call_id])).toEqual([[403, ID]]);
    expect(t.e.view()).toMatchObject({ callId: ID, pendingCount: 0, pendingMsat: 0, hangupUnsent: false });
  });

  it('when the price of that owed hangup cannot be read, the card says so and only then can be closed', async () => {
    const price = pricedByHand();
    const t = engine({ free: true, quote: price.quote });
    await t.e.receive(offer(), OWN);
    await t.e.accept(QUOTE);
    const ending = t.e.hangup();
    await Promise.resolve();
    t.e.dismiss();
    price.answer({ ok: false, error: { code: 'call_price_unknown', message: 'no price' } as ActionError });
    await ending;
    expect(t.sent).toEqual([]);
    expect(t.e.view()).toMatchObject({ phase: 'ended', callId: ID, pendingCount: 0, hangupUnsent: true });
    t.e.dismiss();
    expect(t.e.view().phase).toBe('idle');
  });

  it('a reconnect whose price cannot be read spends nothing: the next drop, priced, asks exactly once', async () => {
    vi.useFakeTimers();
    let reads = 0;
    const quote = () => {
      reads++;
      if (reads === 1) return new Promise<Outcome<CallQuote>>(() => {});
      if (reads === 2) return Promise.resolve({ ok: false, error: { code: 'call_price_unknown', message: 'no price' } as ActionError } as Outcome<CallQuote>);
      return Promise.resolve({ ok: true, value: QUOTE } as Outcome<CallQuote>);
    };
    const pcs: FakePc[] = [];
    const t = engine({ free: true, quote, peerConnection: () => { const pc = new FakePc(); pcs.push(pc); return pc as unknown as RTCPeerConnection; } });
    await t.e.receive(offer(), OWN);
    await t.e.accept(QUOTE);
    drop(pcs[0]);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sent).toEqual([]);
    expect(t.last().recoveryUsed).toBe(false);
    drop(pcs[0]);
    drop(pcs[0]);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sent.map((s) => s.kind)).toEqual([402]);
    expect(t.last().recoveryUsed).toBe(true);
    t.e.endLocal();
  });

  it('Ring to someone else while the hangup of a call answered free is priced leaves that card, says so, and rings nobody', async () => {
    const price = pricedByHand();
    const t = engine({ free: true, quote: price.quote });
    await t.e.receive(offer(), OWN);
    await t.e.accept(QUOTE);
    const ending = t.e.hangup();
    await Promise.resolve();
    await t.e.place('c'.repeat(64), 'audio', QUOTE);
    expect(t.e.view()).toMatchObject({ phase: 'ended', callId: ID, error: 'Your last call is still being ended. Call again in a moment. Nothing was sent or paid.' });
    price.answer({ ok: false, error: { code: 'call_price_unknown', message: 'no price' } as ActionError });
    await ending;
    expect(t.sent).toEqual([]);
    expect(t.e.view()).toMatchObject({ callId: ID, hangupUnsent: true, pendingCount: 0 });
  });

  /** Reads answered in turn: the first (the free Accept's) never, then each of `outcomes`, then a price. */
  const pricedInTurn = (...outcomes: ('fail' | 'hand')[]) => {
    let reads = 0;
    const hands: ((q: Outcome<CallQuote>) => void)[] = [];
    const quote = () => {
      const n = reads++;
      if (n === 0) return new Promise<Outcome<CallQuote>>(() => {});
      const o = outcomes[n - 1];
      if (o === 'fail') return Promise.resolve({ ok: false, error: { code: 'call_price_unknown', message: 'no price' } as ActionError } as Outcome<CallQuote>);
      if (o === 'hand') return new Promise<Outcome<CallQuote>>((r) => { hands.push(r); });
      return Promise.resolve({ ok: true, value: QUOTE } as Outcome<CallQuote>);
    };
    return { quote, hands, reads: () => reads };
  };
  const freeCall = async (quote: CallDeps['quote']) => {
    const pcs: FakePc[] = [];
    const t = engine({ free: true, quote, peerConnection: () => { const pc = new FakePc(); pcs.push(pc); return pc as unknown as RTCPeerConnection; } });
    await t.e.receive(offer(), OWN);
    await t.e.accept(QUOTE);
    return { ...t, pcs };
  };

  it('a reconnect asked for while its price is read is kept, and a failed read is retried while the drop lasts: one request, and the refusal is cleared', async () => {
    vi.useFakeTimers();
    const price = pricedInTurn('hand');
    const t = await freeCall(price.quote);
    drop(t.pcs[0]);
    await vi.advanceTimersByTimeAsync(0);
    // A second failure while the first read is still out: kept, not dropped.
    t.pcs[0].connectionState = 'failed'; t.pcs[0].onconnectionstatechange?.();
    price.hands[0]({ ok: false, error: { code: 'call_price_unknown', message: 'no price' } as ActionError });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sent).toEqual([]);
    expect(t.last()).toMatchObject({ recoveryUsed: false, recoveryError: 'Their call price could not be read, so this was not sent. Nothing was paid.' });
    // No new connection event comes: the backoff reads again by itself.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.sent.map((s) => s.kind)).toEqual([402]);
    expect(t.last()).toMatchObject({ recoveryUsed: true, recoveryError: null, error: null });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.sent.map((s) => s.kind)).toEqual([402]);
    t.e.endLocal();
  });

  it('price reads for one drop are bounded: after the backoff runs out nothing more is read or sent', async () => {
    vi.useFakeTimers();
    const price = pricedInTurn('fail', 'fail', 'fail', 'fail', 'fail', 'fail');
    const t = await freeCall(price.quote);
    drop(t.pcs[0]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(price.reads()).toBe(1 + 4);
    expect(t.sent).toEqual([]);
    expect(t.last().recoveryUsed).toBe(false);
    t.e.endLocal();
  });

  it('a restart offer on a connection that is still up, whose price never reads, is read four times and then no more', async () => {
    vi.useFakeTimers();
    const price = pricedInTurn(...Array<'fail'>(20).fill('fail'));
    const t = await freeCall(price.quote);
    t.pcs[0].connectionState = 'connected'; t.pcs[0].onconnectionstatechange?.();
    await t.e.receive({ id: 'in-400-r', kind: 400, sender: A, recipient: OWN, timestamp: 0,
      plaintext: JSON.stringify({ v: 1, call_id: 'e'.repeat(32), media: 'audio', sdp: `v=0 offer\r\na=x-bitsov-restart-of:${ID}\r\n` }), payment_amount_msat: 1_000 }, OWN);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(price.reads() - 1).toBe(4);
    expect(t.sent).toEqual([]);
    expect(t.last().recoveryUsed).toBe(false);
    t.e.endLocal();
  });

  it('a real heal gives the next drop its own bounded price reads', async () => {
    vi.useFakeTimers();
    const price = pricedInTurn(...Array<'fail'>(20).fill('fail'));
    const t = await freeCall(price.quote);
    // Within the 30 s the drop is given: the read, and three retries 2, 5 and 10 s apart.
    drop(t.pcs[0]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(price.reads() - 1).toBe(4);
    expect(t.last().phase).toBe('reconnecting');
    // The media comes back, then drops again.
    drop(t.pcs[0]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(price.reads() - 1).toBe(8);
    expect(t.sent).toEqual([]);
    t.e.endLocal();
  });

  it('a restart offer from the caller whose price cannot be read leaves the recovery unused; the retry answers it once', async () => {
    vi.useFakeTimers();
    const price = pricedInTurn('fail');
    const t = await freeCall(price.quote);
    t.pcs[0].connectionState = 'connected'; t.pcs[0].onconnectionstatechange?.();
    const restartId = 'e'.repeat(32);
    const restartOffer = (): Message => ({ id: `in-400-r-${Math.random()}`, kind: 400, sender: A, recipient: OWN, timestamp: 0,
      plaintext: JSON.stringify({ v: 1, call_id: restartId, media: 'audio', sdp: `v=0 offer\r\na=x-bitsov-restart-of:${ID}\r\n` }), payment_amount_msat: 1_000 });
    await t.e.receive(restartOffer(), OWN);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sent).toEqual([]);
    expect(t.last().recoveryUsed).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.sent.map((s) => [s.kind, s.body.call_id])).toEqual([[401, restartId]]);
    expect(t.last().recoveryUsed).toBe(true);
    await t.e.receive(restartOffer(), OWN);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sent).toHaveLength(1);
    t.e.endLocal();
  });

  it('the paid Accept keeps its checks: a risen price, or none shown, answers nothing', async () => {
    const risen = engine({ free: false, quote: async () => ({ ok: true, value: { ...QUOTE, signal_msat: QUOTE.signal_msat + 1 } }) });
    await risen.e.receive(offer(), OWN);
    await risen.e.accept(QUOTE);
    expect(risen.sent).toEqual([]);
    expect(risen.last().phase).toBe('ended');
    const unshown = engine({ free: false });
    await unshown.e.receive(offer(), OWN);
    await unshown.e.accept(null);
    expect(unshown.sent).toEqual([]);
    expect(unshown.last().phase).toBe('incoming');
  });

  it('a refused free Accept ends the answer and is not retried paid', async () => {
    const t = engine({ free: true, reply: async () => ({ ok: false, error: { code: 'call_reply_not_free', message: 'This reply cannot go out for free: your node or theirs does not take free call replies. Nothing was sent or paid.' } as ActionError }) });
    await t.e.receive(offer(), OWN);
    await t.e.accept(QUOTE);
    expect(t.freeSent).toHaveLength(1);
    expect(t.sent).toEqual([]);
    expect(t.last()).toMatchObject({ phase: 'ended', paidMsat: 0 });
  });

  it('on a legacy node or caller, Accept keeps the paid answer at the price shown', async () => {
    const t = engine({ free: false });
    await t.e.receive(offer(), OWN);
    await t.e.accept(QUOTE);
    expect(t.freeSent).toEqual([]);
    expect(t.sent.map((s) => [s.kind, s.max])).toEqual([[401, 6_000]]);
  });
});

describe('a call the box approval cut off (A7)', () => {
  const ending = (continuity: boolean, grantEnds: number, now: { t: number }) => {
    const t = engine({ free: false, now: () => now.t, callContinuity: () => continuity,
      grant: () => ({ budget_msat: 1, remaining_msat: 1, per_call_max_msat: 1, expires_at_ms: grantEnds, envelopes: null }) });
    return t;
  };
  it.each([
    ['en', 'The budget ran out during the call, so it ended.'],
    ['da', 'Budget udløb under opkaldet, så det sluttede.'],
  ] as const)('on a legacy node, media refused after the approval ended says the budget ran out (%s)', async (lang, said) => {
    const now = { t: 1_000 };
    const t = ending(false, 61_000, now);
    await t.e.receive(offer(), OWN);
    await t.e.accept(QUOTE);
    now.t = 120_000;
    t.e.mediaClosed(ID, { refused: true });
    setLanguagePref(lang);
    expect(t.last().budgetEnded).toBe(true);
    expect(callEndLine(t.last(), 'Maya').text).toBe(said);
    expect(callEndLine(t.last(), 'Maya').text).not.toMatch(/minute|minut/i);
  });
  it('a refusal before the approval ended, or on a continuity node, keeps the plain link-closed line', async () => {
    for (const [continuity, at] of [[false, 30_000], [true, 120_000]] as const) {
      const now = { t: 1_000 };
      const t = ending(continuity, 61_000, now);
      await t.e.receive(offer(), OWN);
      await t.e.accept(QUOTE);
      now.t = at;
      t.e.mediaClosed(ID, { refused: true });
      expect(t.last().budgetEnded).toBe(false);
      expect(callEndLine(t.last(), 'Maya').text).not.toMatch(/budget/i);
    }
  });
});

describe('no terminal text on the new call lines (P23)', () => {
  it.each(['en', 'da'] as const)('every new line is plain (%s)', async (lang) => {
    setLanguagePref(lang);
    const lines: string[] = [];
    for (const outcome of ['ok', 'refused', 'unknown'] as const) {
      const t = engine({ free: true, reply: async () => outcome === 'ok' ? { ok: true, value: FREE }
        : { ok: false, error: { code: outcome === 'refused' ? 'call_reply_not_sent' : 'call_reply_unknown', message: 'x' } as ActionError } });
      await t.e.receive(offer(), OWN);
      await t.e.refuse();
      lines.push(callEndLine(t.last(), 'Maya').text);
    }
    expect(lines.every((l) => l.length > 0 && !CLI.test(l))).toBe(true);
  });
});
