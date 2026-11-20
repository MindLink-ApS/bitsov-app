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
