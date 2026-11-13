/**
 * Phones: a locked or backgrounded phone silences the app's microphone while
 * the call (and its paid minutes) would go on. With `stopWhenSilenced` the
 * engine hangs such a call up through its normal hangup after
 * SILENCED_GRACE_MS, unless the app comes back first. Desktop is unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCallEngine, SILENCED_GRACE_MS, type CallDeps, type CallView } from '../src/control/call';
import { setLanguagePref, t } from '../src/i18n';
import type { CallQuote, CallReceipt } from '../src/control/types';

const OWN = '1'.repeat(64);
const A = 'a'.repeat(64);
const ID = '0123456789abcdef0123456789abcdef';
const QUOTE: CallQuote = { offer_msat: 10_000, offer_max_routing_fee_msat: 5_000, signal_msat: 1_000, signal_max_routing_fee_msat: 5_000, call_total_msat: 21_000 };

class FakePc {
  static made: FakePc[] = [];
  iceGatheringState = 'complete';
  connectionState = 'new';
  iceConnectionState = 'new';
  localDescription: { type: string; sdp: string } | null = null;
  ontrack: ((e: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  closed = false;
  constructor() { FakePc.made.push(this); }
  addTrack() { return { replaceTrack: async () => {} }; }
  async getStats() { return new Map(); }
  async createOffer() { return { type: 'offer', sdp: 'v=0 offer' }; }
  async createAnswer() { return { type: 'answer', sdp: 'v=0 answer' }; }
  async setLocalDescription(d: { type: string; sdp: string }) { this.localDescription = d; }
  async setRemoteDescription() {}
  async addIceCandidate() {}
  restartIce() {}
  addEventListener() {}
  removeEventListener() {}
  close() { this.closed = true; }
  connect() { this.connectionState = 'connected'; this.onconnectionstatechange?.(); }
}

/** A microphone track the test can mute, unmute and end the way the OS does. */
class MicTrack extends EventTarget {
  kind = 'audio';
  enabled = true;
  muted = false;
  readyState: 'live' | 'ended' = 'live';
  stop = vi.fn(() => { this.readyState = 'ended'; });
  osMute(muted: boolean) { this.muted = muted; this.dispatchEvent(new Event(muted ? 'mute' : 'unmute')); }
  osEnd() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')); }
}

function setup(over: Partial<CallDeps> = {}) {
  const views: CallView[] = [];
  const sent: number[] = [];
  const ended: string[] = [];
  const mics: MicTrack[] = [];
  const e = createCallEngine({
    stopWhenSilenced: true,
    quote: async () => ({ ok: true, value: QUOTE }),
    signal: async (_peer, kind) => {
      sent.push(kind);
      return { ok: true, value: { operation_id: `op-${kind}`, message_id: `m${kind}`, kind, amount_msat: 1_000, total_msat: 6_000, max_routing_fee_msat: 5_000, delivered: true, accepted: true, sent_at_ms: 0 } satisfies CallReceipt };
    },
    endCall: async (callId) => {
      ended.push(callId);
      return { ok: true, value: { op_id: 'end', kind: 'call_hangup', peer: A, call_id: callId, state: 'settled', cap_msat: 6_000, paid_msat: 6_000, message_id: 'h' } as never };
    },
    getUserMedia: async () => {
      const mic = new MicTrack();
      mics.push(mic);
      const tracks = [mic as unknown as MediaStreamTrack];
      return { getTracks: () => tracks, getAudioTracks: () => tracks, getVideoTracks: () => [], addTrack: () => {}, removeTrack: () => {} } as unknown as MediaStream;
    },
    peerConnection: () => new FakePc() as unknown as RTCPeerConnection,
    now: () => Date.now(),
    onView: (v) => views.push(v),
    onStreams: () => {},
    newCallId: () => ID,
    ...over,
  });
  /** Place a call, get their answer and connect: Live. */
  const live = async () => {
    await e.place(A, 'audio', QUOTE);
    await e.receive({ id: 'ans', kind: 401, sender: A, recipient: OWN, timestamp: 0, plaintext: JSON.stringify({ v: 1, call_id: ID, sdp: 'v=0 answer' }), payment_amount_msat: 1 }, OWN);
    FakePc.made[FakePc.made.length - 1].connect();
    expect(e.view().phase).toBe('live');
  };
  return { e, views, sent, ended, mics, live, last: () => views[views.length - 1] };
}

beforeEach(() => { FakePc.made = []; vi.useFakeTimers(); vi.setSystemTime(1_790_000_000_000); setLanguagePref('en'); });
afterEach(() => { vi.useRealTimers(); setLanguagePref('system'); });

describe('a phone call that is locked, backgrounded or silenced', () => {
  it('hidden: says when it ends, then hangs up through the normal hangup after the grace', async () => {
    const h = setup();
    await h.live();
    h.e.setBackgrounded(true);
    expect(h.e.view()).toMatchObject({ phase: 'live', stopped: { cause: 'background', endsAt: Date.now() + SILENCED_GRACE_MS } });
    await vi.advanceTimersByTimeAsync(SILENCED_GRACE_MS - 1);
    expect(h.e.view().phase).toBe('live');
    expect(h.ended).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.e.view()).toMatchObject({ phase: 'ended', reason: 'hangup', stopped: { cause: 'background', endsAt: null } });
    // The host ends our admission (its one paid hangup), exactly as the Hang up button does.
    expect(h.ended).toEqual([ID]);
    expect(h.mics[0].stop).toHaveBeenCalled();
    // Coming back afterwards shows the reason; nothing else happens.
    h.e.setBackgrounded(false);
    expect(h.e.view()).toMatchObject({ phase: 'ended', stopped: { cause: 'background', endsAt: null } });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(h.ended).toEqual([ID]);
  });

  it('back in view within the grace: the call goes on, and a later hide gets a full grace again', async () => {
    const h = setup();
    await h.live();
    h.e.setBackgrounded(true);
    await vi.advanceTimersByTimeAsync(SILENCED_GRACE_MS - 1_000);
    h.e.setBackgrounded(false);
    expect(h.e.view()).toMatchObject({ phase: 'live', stopped: null });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(h.e.view().phase).toBe('live');
    expect(h.ended).toEqual([]);
    h.e.setBackgrounded(true);
    await vi.advanceTimersByTimeAsync(SILENCED_GRACE_MS - 1);
    expect(h.e.view().phase).toBe('live');
    await vi.advanceTimersByTimeAsync(1);
    expect(h.e.view().phase).toBe('ended');
  });

  it('the microphone track ended: hangs up at once, it never comes back in this call', async () => {
    const h = setup();
    await h.live();
    h.mics[0].osEnd();
    expect(h.e.view()).toMatchObject({ phase: 'ended', reason: 'hangup', stopped: { cause: 'microphone', endsAt: null } });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.ended).toEqual([ID]);
  });

  it('the OS muted the microphone: ends after the grace, unless it is unmuted in time', async () => {
    const h = setup();
    await h.live();
    h.mics[0].osMute(true);
    expect(h.e.view().stopped).toMatchObject({ cause: 'microphone' });
    await vi.advanceTimersByTimeAsync(10_000);
    h.mics[0].osMute(false);
    expect(h.e.view()).toMatchObject({ phase: 'live', stopped: null });
    await vi.advanceTimersByTimeAsync(SILENCED_GRACE_MS);
    expect(h.e.view().phase).toBe('live');
    h.mics[0].osMute(true);
    await vi.advanceTimersByTimeAsync(SILENCED_GRACE_MS);
    expect(h.e.view()).toMatchObject({ phase: 'ended', stopped: { cause: 'microphone', endsAt: null } });
  });

  it('digital silence from the capture path counts; the owner’s own mute does not', async () => {
    const h = setup();
    await h.live();
    h.e.toggleMute();
    h.e.micSilent(true);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(h.e.view()).toMatchObject({ phase: 'live', muted: true, stopped: null });
    // Unmuting needs fresh evidence: the old report no longer counts.
    h.e.toggleMute();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(h.e.view()).toMatchObject({ phase: 'live', stopped: null });
    h.e.micSilent(true);
    expect(h.e.view().stopped).toMatchObject({ cause: 'microphone' });
    h.e.micSilent(false);
    expect(h.e.view().stopped).toBeNull();
    h.e.micSilent(true);
    await vi.advanceTimersByTimeAsync(SILENCED_GRACE_MS);
    expect(h.e.view().phase).toBe('ended');
  });

  it('a late timer: back in view after the deadline, the call ends at once instead of going on', async () => {
    const h = setup();
    await h.live();
    h.e.setBackgrounded(true);
    // The phone held the app's timers while it was hidden: the clock moved on, no timer ran.
    vi.setSystemTime(Date.now() + SILENCED_GRACE_MS + 10_000);
    expect(h.e.view().phase).toBe('live');
    h.e.setBackgrounded(false);
    expect(h.e.view()).toMatchObject({ phase: 'ended', reason: 'hangup', stopped: { cause: 'background', endsAt: null } });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.ended).toEqual([ID]);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(h.ended).toEqual([ID]);
  });

  it('a late timer: the microphone unmuted after the deadline still ends the call', async () => {
    const h = setup();
    await h.live();
    h.mics[0].osMute(true);
    vi.setSystemTime(Date.now() + SILENCED_GRACE_MS);
    h.mics[0].osMute(false);
    expect(h.e.view()).toMatchObject({ phase: 'ended', reason: 'hangup', stopped: { cause: 'microphone', endsAt: null } });
  });

  it('another cause during the grace keeps the first deadline, and the countdown shows it', async () => {
    const h = setup();
    await h.live();
    const endsAt = Date.now() + SILENCED_GRACE_MS;
    h.mics[0].osMute(true);
    expect(h.e.view().stopped).toEqual({ cause: 'microphone', endsAt });
    await vi.advanceTimersByTimeAsync(5_000);
    h.e.setBackgrounded(true);
    expect(h.e.view().stopped).toEqual({ cause: 'background', endsAt });
    await vi.advanceTimersByTimeAsync(10_000);
    h.e.setBackgrounded(false);
    expect(h.e.view().stopped).toEqual({ cause: 'microphone', endsAt });
    await vi.advanceTimersByTimeAsync(endsAt - Date.now() - 1);
    expect(h.e.view().phase).toBe('live');
    await vi.advanceTimersByTimeAsync(1);
    expect(h.e.view()).toMatchObject({ phase: 'ended', stopped: { cause: 'microphone', endsAt: null } });
  });

  it('a microphone already muted by the OS when the call starts counts, without a mute event', async () => {
    const h = setup({
      getUserMedia: async () => {
        const mic = new MicTrack();
        mic.muted = true;
        const tracks = [mic as unknown as MediaStreamTrack];
        return { getTracks: () => tracks, getAudioTracks: () => tracks, getVideoTracks: () => [], addTrack: () => {}, removeTrack: () => {} } as unknown as MediaStream;
      },
    });
    await h.live();
    expect(h.e.view().stopped).toMatchObject({ cause: 'microphone', endsAt: Date.now() + SILENCED_GRACE_MS });
    await vi.advanceTimersByTimeAsync(SILENCED_GRACE_MS);
    expect(h.e.view().phase).toBe('ended');
  });

  it('hidden while ringing: the grace starts at their answer, not before', async () => {
    const h = setup();
    await h.e.place(A, 'audio', QUOTE);
    expect(h.e.view().phase).toBe('ringing');
    h.e.setBackgrounded(true);
    await vi.advanceTimersByTimeAsync(SILENCED_GRACE_MS * 2);
    expect(h.e.view()).toMatchObject({ phase: 'ringing', stopped: null });
    await h.e.receive({ id: 'ans', kind: 401, sender: A, recipient: OWN, timestamp: 0, plaintext: JSON.stringify({ v: 1, call_id: ID, sdp: 'v=0 answer' }), payment_amount_msat: 1 }, OWN);
    expect(h.e.view()).toMatchObject({ phase: 'connecting', stopped: { cause: 'background' } });
    await vi.advanceTimersByTimeAsync(SILENCED_GRACE_MS);
    expect(h.e.view().phase).toBe('ended');
  });

  it('hanging up during the grace ends the call without a stop reason', async () => {
    const h = setup();
    await h.live();
    h.e.setBackgrounded(true);
    await h.e.hangup();
    expect(h.e.view()).toMatchObject({ phase: 'ended', stopped: null });
    await vi.advanceTimersByTimeAsync(SILENCED_GRACE_MS * 2);
    expect(h.ended).toEqual([ID]);
  });

  it('a new call starts with no stop from the last one', async () => {
    const h = setup();
    await h.live();
    h.mics[0].osEnd();
    h.e.dismiss();
    expect(h.e.view().stopped).toBeNull();
  });

  it('says why in English and Danish', () => {
    setLanguagePref('en');
    expect(t('caCallStoppedBackground')).toBe('The call stopped because the phone was locked or the app was closed. No more minutes are paid.');
    expect(t('caCallStoppingBackground', 12)).toBe('BitSov is not in view. The call ends in 12 s unless you come back.');
    setLanguagePref('da');
    expect(t('caCallStoppedBackground')).toBe('Opkaldet stoppede, fordi telefonen blev låst, eller appen blev lukket. Der betales ikke for flere minutter.');
    expect(t('caCallStoppedMicrophone')).toBe('Opkaldet stoppede, fordi telefonen slukkede mikrofonen. Der betales ikke for flere minutter.');
  });
});

describe('desktop', () => {
  it('is unaffected: hidden, muted or ended microphones never end the call from here', async () => {
    const h = setup({ stopWhenSilenced: undefined });
    await h.live();
    h.e.setBackgrounded(true);
    h.e.micSilent(true);
    h.mics[0].osMute(true);
    h.mics[0].osEnd();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.e.view()).toMatchObject({ phase: 'live', stopped: null });
    expect(h.ended).toEqual([]);
    expect(h.views.every((v) => v.stopped === null)).toBe(true);
  });
});
