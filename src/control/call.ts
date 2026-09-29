/**
 * 1:1 calls (regtest prototype). Media runs peer to peer over WebRTC in this
 * webview, STUN only, and never touches the node. Signalling is four paid
 * UKM kinds through the node: the offer (400) is the per-call admission at
 * the callee's `call_msat`; answer (401), ICE (402) and hangup (403) pay the
 * realtime price. Each signal is one `call_signal` host command: same budget,
 * approval and journaled exactly-once path as a message. ICE is gathered
 * before the offer/answer is sent (vanilla ICE), so a call normally costs
 * one offer and one hangup for the caller, one answer for the callee.
 */
import type { ActionError, CallQuote, CallReceipt, Message } from './types';

export const CALL_OFFER = 400;
export const CALL_ANSWER = 401;
export const CALL_ICE = 402;
export const CALL_HANGUP = 403;
/** How long an offer rings before either side gives up (genome: 60 s). */
export const RING_MS = 60_000;
/** How long to wait for ICE gathering before sending what we have. */
export const GATHER_MS = 3_000;
/** STUN only: no TURN relay, so no third party carries (or bills) media. */
export const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

export const isCallKind = (kind: number) => kind >= CALL_OFFER && kind <= CALL_HANGUP;

export type CallMedia = 'audio' | 'video';
export type HangupReason = 'hangup' | 'declined' | 'busy' | 'timeout' | 'failed';

export type Signal = {
  v: 1;
  call_id: string;
  media?: CallMedia;
  sdp?: string;
  candidate?: string;
  sdp_mid?: string | null;
  sdp_mline_index?: number | null;
  reason?: HangupReason;
};

const CALL_ID = /^[0-9a-f]{32}$/;
const REASONS: HangupReason[] = ['hangup', 'declined', 'busy', 'timeout', 'failed'];

/** A received signal, checked the way the node checks it. Anything else is ignored. */
export function parseSignal(kind: number, plaintext: string | null): Signal | null {
  if (!isCallKind(kind) || !plaintext) return null;
  let s: Signal;
  try {
    s = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (!s || typeof s !== 'object' || s.v !== 1 || typeof s.call_id !== 'string' || !CALL_ID.test(s.call_id)) return null;
  switch (kind) {
    case CALL_OFFER:
      return (s.media === 'audio' || s.media === 'video') && typeof s.sdp === 'string' && s.sdp.length > 0 ? s : null;
    case CALL_ANSWER:
      return typeof s.sdp === 'string' && s.sdp.length > 0 ? s : null;
    case CALL_ICE:
      return typeof s.candidate === 'string' ? s : null;
    default:
      return s.reason === undefined || REASONS.includes(s.reason) ? s : null;
  }
}

export function newCallId(random: (a: Uint8Array) => Uint8Array = (a) => crypto.getRandomValues(a)): string {
  return [...random(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** What placing a call costs at most: offer and one hangup, all-in. */
export const callCost = (q: CallQuote) => q.call_total_msat;
/** What one answer/ICE/hangup costs at most, all-in. */
export const signalCost = (q: CallQuote) => q.signal_msat + q.signal_max_routing_fee_msat;

export type Phase = 'idle' | 'calling' | 'ringing' | 'incoming' | 'connecting' | 'live' | 'ended';

export type CallView = {
  phase: Phase;
  peer: string | null;
  callId: string | null;
  media: CallMedia;
  outgoing: boolean;
  /** When media started flowing. */
  liveAt: number | null;
  muted: boolean;
  camera: boolean;
  /** msat this side paid for this call's signals, all-in as reported. */
  paidMsat: number;
  reason: HangupReason | null;
  /** A refusal to show (nothing was paid for the refused step). */
  error: string | null;
};

export const IDLE: CallView = {
  phase: 'idle', peer: null, callId: null, media: 'audio', outgoing: false,
  liveAt: null, muted: false, camera: false, paidMsat: 0, reason: null, error: null,
};

type Outcome<T> = { ok: true; value: T } | { ok: false; error: ActionError };

export type CallDeps = {
  quote: (peer: string) => Promise<Outcome<CallQuote>>;
  signal: (peer: string, kind: number, plaintext: string, maxMsat: number) => Promise<Outcome<CallReceipt>>;
  getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>;
  peerConnection: (config: RTCConfiguration) => RTCPeerConnection;
  now: () => number;
  onView: (v: CallView) => void;
  onStreams: (local: MediaStream | null, remote: MediaStream | null) => void;
  newCallId?: () => string;
  /** Defaults to {@link ICE_SERVERS}; a loopback test passes `[]`. */
  iceServers?: RTCIceServer[];
};

/** Wait for ICE gathering to finish, or `ms`, whichever comes first. */
function gathered(pc: RTCPeerConnection, ms: number): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    const timer = setTimeout(done, ms);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

export type CallEngine = ReturnType<typeof createCallEngine>;

export function createCallEngine(deps: CallDeps) {
  let view: CallView = IDLE;
  let pc: RTCPeerConnection | null = null;
  let local: MediaStream | null = null;
  let remote: MediaStream | null = null;
  let quote: CallQuote | null = null;
  let offerSdp: string | null = null;
  let ringTimer: ReturnType<typeof setTimeout> | undefined;
  // Serialises user actions: a double click never pays twice.
  let busy = false;

  const set = (patch: Partial<CallView>) => {
    view = { ...view, ...patch };
    deps.onView(view);
  };
  const active = () => view.phase !== 'idle' && view.phase !== 'ended';

  const teardown = () => {
    clearTimeout(ringTimer);
    ringTimer = undefined;
    pc?.close();
    pc = null;
    local?.getTracks().forEach((t) => t.stop());
    local = null;
    remote = null;
    offerSdp = null;
    deps.onStreams(null, null);
  };
  const end = (reason: HangupReason | null, error: string | null = null) => {
    teardown();
    set({ phase: 'ended', reason, error });
  };

  const open = async (media: CallMedia) => {
    local = await deps.getUserMedia({ audio: true, video: media === 'video' });
    const conn = deps.peerConnection({ iceServers: deps.iceServers ?? ICE_SERVERS });
    pc = conn;
    local.getTracks().forEach((t) => conn.addTrack(t, local!));
    conn.ontrack = (e) => {
      remote = e.streams[0] ?? new MediaStream([e.track]);
      deps.onStreams(local, remote);
    };
    conn.onconnectionstatechange = () => {
      if (pc !== conn) return;
      if (conn.connectionState === 'connected' && view.phase !== 'live') {
        clearTimeout(ringTimer);
        set({ phase: 'live', liveAt: deps.now() });
      } else if (conn.connectionState === 'failed') {
        // The other side sees the same failure; ending locally pays nothing.
        end('failed', 'The direct connection failed (no TURN relay in this prototype).');
      }
    };
    deps.onStreams(local, null);
    return conn;
  };

  const pay = async (kind: number, body: Omit<Signal, 'v' | 'call_id'>, maxMsat: number) => {
    const r = await deps.signal(view.peer!, kind, JSON.stringify({ v: 1, call_id: view.callId!, ...body }), maxMsat);
    if (r.ok) set({ paidMsat: view.paidMsat + r.value.total_msat });
    return r;
  };

  const guarded = async (run: () => Promise<void>) => {
    if (busy) return;
    busy = true;
    try {
      await run();
    } finally {
      busy = false;
    }
  };

  return {
    view: () => view,

    /** Place a call. The price was shown before this is called. */
    place: (peer: string, media: CallMedia, q: CallQuote) => guarded(async () => {
      if (active()) return;
      if (q.offer_msat === null || q.call_total_msat === null) {
        set({ ...IDLE, phase: 'ended', peer, error: 'Their node does not take calls yet. Nothing was paid.' });
        return;
      }
      quote = q;
      const callId = (deps.newCallId ?? newCallId)();
      set({ ...IDLE, phase: 'calling', peer, callId, media, outgoing: true, camera: media === 'video' });
      let conn: RTCPeerConnection;
      try {
        conn = await open(media);
        await conn.setLocalDescription(await conn.createOffer());
        await gathered(conn, GATHER_MS);
      } catch {
        end(null, media === 'video' ? 'Camera or microphone not available. Nothing was paid.' : 'Microphone not available. Nothing was paid.');
        return;
      }
      if (view.callId !== callId) return;
      const r = await pay(CALL_OFFER, { media, sdp: conn.localDescription!.sdp }, q.offer_msat + q.offer_max_routing_fee_msat);
      if (view.callId !== callId) return;
      if (!r.ok) {
        end(null, r.error.message);
        return;
      }
      set({ phase: 'ringing' });
      // Unanswered: stop ringing locally. No hangup is paid for a call nobody took.
      ringTimer = setTimeout(() => { if (view.callId === callId && view.phase === 'ringing') end('timeout'); }, RING_MS);
    }),

    /** Accept the ringing call: one paid answer. */
    accept: () => guarded(async () => {
      if (view.phase !== 'incoming' || !offerSdp) return;
      const callId = view.callId;
      set({ phase: 'connecting' });
      const q = await deps.quote(view.peer!);
      if (!q.ok) { end(null, q.error.message); return; }
      quote = q.value;
      let conn: RTCPeerConnection;
      try {
        conn = await open(view.media);
        await conn.setRemoteDescription({ type: 'offer', sdp: offerSdp });
        await conn.setLocalDescription(await conn.createAnswer());
        await gathered(conn, GATHER_MS);
      } catch {
        end(null, 'Microphone not available. Nothing was paid.');
        return;
      }
      if (view.callId !== callId) return;
      const r = await pay(CALL_ANSWER, { sdp: conn.localDescription!.sdp }, signalCost(quote));
      if (!r.ok) end(null, r.error.message);
    }),

    /** Decline a ringing call: one paid hangup, so the caller stops ringing. */
    decline: () => guarded(async () => {
      if (view.phase !== 'incoming') return;
      const q = await deps.quote(view.peer!);
      if (q.ok) await pay(CALL_HANGUP, { reason: 'declined' }, signalCost(q.value));
      end('declined');
    }),

    /** Hang up: one paid hangup once the offer went out; before that, nothing to pay. */
    hangup: () => guarded(async () => {
      if (!active() || view.phase === 'incoming') return;
      if (view.phase !== 'calling' && quote) await pay(CALL_HANGUP, { reason: 'hangup' }, signalCost(quote));
      end('hangup');
    }),

    toggleMute: () => {
      if (!local) return;
      const muted = !view.muted;
      local.getAudioTracks().forEach((t) => { t.enabled = !muted; });
      set({ muted });
    },

    toggleCamera: () => {
      if (!local || view.media !== 'video') return;
      const camera = !view.camera;
      local.getVideoTracks().forEach((t) => { t.enabled = camera; });
      set({ camera });
    },

    /** Close the ended card. */
    dismiss: () => { if (view.phase === 'ended') set(IDLE); },

    /** A 400-403 the node forwarded (already paid, and admitted by its call registry). */
    receive: async (m: Message, ownId: string) => {
      if (m.sender.toLowerCase() === ownId.toLowerCase()) return;
      const s = parseSignal(m.kind, m.plaintext);
      if (!s) return;
      const peer = m.sender.toLowerCase();
      const ours = view.callId === s.call_id && view.peer === peer;
      switch (m.kind) {
        case CALL_OFFER:
          // Busy: let their ring time out rather than pay to say so.
          if (active()) return;
          offerSdp = s.sdp!;
          set({ ...IDLE, phase: 'incoming', peer, callId: s.call_id, media: s.media!, camera: s.media === 'video' });
          ringTimer = setTimeout(() => { if (view.callId === s.call_id && view.phase === 'incoming') end('timeout'); }, RING_MS);
          return;
        case CALL_ANSWER:
          if (!ours || view.phase !== 'ringing' || !pc) return;
          clearTimeout(ringTimer);
          set({ phase: 'connecting' });
          try {
            await pc.setRemoteDescription({ type: 'answer', sdp: s.sdp! });
          } catch {
            end('failed', 'Their answer could not be used.');
          }
          return;
        case CALL_ICE:
          if (ours && pc) await pc.addIceCandidate({ candidate: s.candidate!, sdpMid: s.sdp_mid ?? null, sdpMLineIndex: s.sdp_mline_index ?? null }).catch(() => undefined);
          return;
        default:
          if (ours && active()) end(s.reason ?? 'hangup');
      }
    },
  };
}
