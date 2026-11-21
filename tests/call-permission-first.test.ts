/**
 * The microphone (and the camera for video) is asked for on the tap of Call
 * or Accept, before anything goes out: no ring, no reservation, no paid
 * signal, no paid minute. A denied permission ends the attempt with nothing
 * sent or paid and says so, so the card can show how to give access.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCallEngine, type CallDeps, type CallView } from '../src/control/call';
import type { MinutesDeps } from '../src/control/callMinutes';
import { nodeRoutedSdp } from '../src/control/nodeRoutedConnection';
import type { ActionError, CallQuote, CallReceipt } from '../src/control/types';

const OWN = '1'.repeat(64);
const A = 'a'.repeat(64);
const ID = '0123456789abcdef0123456789abcdef';
const QUOTE: CallQuote = {
  offer_msat: 10_000, offer_max_routing_fee_msat: 5_000, signal_msat: 1_000, signal_max_routing_fee_msat: 5_000, call_total_msat: 21_000,
  block_msat: 10_000, block_max_routing_fee_msat: 5_000, reservation_max_msat: 240 * 15_000, minutes_payable: true,
};
type Outcome<T> = { ok: true; value: T } | { ok: false; error: ActionError };
const ok = <T,>(value: T): Outcome<T> => ({ ok: true, value });
const no = (): Outcome<never> => ({ ok: false, error: { code: 'node', message: 'none' } as ActionError });

const stream = () => {
  const tracks = [{ kind: 'audio', enabled: true, stop: vi.fn() }];
  return { getTracks: () => tracks, getAudioTracks: () => tracks, getVideoTracks: () => [], addTrack: () => {}, removeTrack: () => {} } as unknown as MediaStream;
};
const denied = () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));

function routed(getUserMedia: CallDeps['getUserMedia']) {
  const log: string[] = [];
  const views: CallView[] = [];
  const minutes: MinutesDeps = {
    status: vi.fn(async () => { log.push('call_status'); return no(); }),
    hold: vi.fn(async () => { log.push('call_hold'); return no(); }),
    pay: vi.fn(async () => { log.push('call_block'); return no(); }),
  };
  const deps: CallDeps = {
    routed: true,
    minutes,
    quote: async () => ok(QUOTE),
    signal: async (_peer, kind) => {
      log.push(`call_signal ${kind}`);
      return ok({ operation_id: `op-${kind}`, message_id: 'm', kind, amount_msat: 1, total_msat: 1, max_routing_fee_msat: 0, delivered: true, accepted: true, sent_at_ms: 0 } as CallReceipt);
    },
    getUserMedia: (c) => { log.push(`getUserMedia ${c.video ? 'video' : 'audio'}`); return getUserMedia(c); },
    peerConnection: () => {
      log.push('media_open');
      const conn = { connectionState: 'new', onconnectionstatechange: null, localDescription: null as unknown };
      return Object.assign(conn, {
        iceGatheringState: 'complete', iceConnectionState: 'new',
        addTrack: () => ({}), createOffer: async () => ({ type: 'offer', sdp: 'x' }), createAnswer: async () => ({ type: 'answer', sdp: 'x' }),
        setLocalDescription: async (d: unknown) => { conn.localDescription = d; },
        setRemoteDescription: async () => {}, addIceCandidate: async () => {}, getStats: async () => new Map(), close: () => {}, restartIce: () => {},
        addEventListener: () => {}, removeEventListener: () => {},
      }) as unknown as RTCPeerConnection;
    },
    now: () => Date.now(),
    onView: (v) => views.push(v),
    onStreams: () => {},
    newCallId: () => ID,
    endCall: async () => { log.push('op_end_call'); return ok({ op_id: 'end', kind: 'call_hangup', peer: A, call_id: ID, state: 'settled', cap_msat: 0, paid_msat: 0, message_id: null } as never); },
  };
  return { engine: createCallEngine(deps), log, minutes, last: () => views[views.length - 1] };
}
const offer = { id: 'off', kind: 400, sender: A, recipient: OWN, timestamp: 0, plaintext: JSON.stringify({ v: 1, call_id: ID, media: 'audio', sdp: nodeRoutedSdp('offer', ID) }), payment_amount_msat: 1 };

describe('microphone permission before anything is sent or paid', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_790_000_000_000); });
  afterEach(() => { vi.useRealTimers(); });

  it('Ring: a denied microphone sends 0 call_signal, pays 0 call_block, and reserves nothing', async () => {
    const e = routed(denied);
    await e.engine.place(A, 'audio', QUOTE);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(e.log).toEqual(['getUserMedia audio']);
    expect(e.log.filter((x) => x.startsWith('call_signal'))).toHaveLength(0);
    expect(e.log.filter((x) => x === 'call_block')).toHaveLength(0);
    expect(e.last()).toMatchObject({ phase: 'ended', mediaDenied: true, paidMsat: 0, pendingCount: 0, unknownCount: 0, minutes: null });
  });

  it('Accept: a denied microphone sends 0 call_signal and pays 0 call_block', async () => {
    const e = routed(denied);
    await e.engine.receive(offer, OWN);
    expect(e.last().phase).toBe('incoming');
    await e.engine.accept(QUOTE);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(e.log).toEqual(['getUserMedia audio']);
    expect(e.last()).toMatchObject({ phase: 'ended', mediaDenied: true, paidMsat: 0, pendingCount: 0, unknownCount: 0 });
  });

  it('a microphone that is there but busy is not a permission screen', async () => {
    const e = routed(() => Promise.reject(Object.assign(new Error('busy'), { name: 'NotReadableError' })));
    await e.engine.place(A, 'audio', QUOTE);
    expect(e.last()).toMatchObject({ phase: 'ended', mediaDenied: false });
  });

  it('Ring and Accept with permission: the microphone comes first, then the paid signal', async () => {
    const ring = routed(async () => stream());
    await ring.engine.place(A, 'audio', QUOTE);
    expect(ring.log.slice(0, 3)).toEqual(['getUserMedia audio', 'media_open', 'call_signal 400']);
    const answer = routed(async () => stream());
    await answer.engine.receive(offer, OWN);
    await answer.engine.accept(QUOTE);
    expect(answer.log.slice(0, 3)).toEqual(['getUserMedia audio', 'media_open', 'call_signal 401']);
  });
});
