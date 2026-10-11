/**
 * 1:1 calls (regtest prototype). Media runs peer to peer over WebRTC in this
 * webview and never touches the node. By default no ICE server is contacted:
 * host candidates only, so calls connect on one network (or a VPN). Calls
 * across NAT need a STUN server the owner chooses in Settings (for example one
 * run on their own node later); the app ships none. Signalling is four paid
 * UKM kinds through the node: the offer (400) is the per-call admission at
 * the callee's `call_msat`; answer (401), ICE (402) and hangup (403) pay the
 * realtime price. Each signal is one `call_signal` host command: same budget,
 * approval and journaled exactly-once path as a message. ICE is gathered
 * before the offer/answer is sent (vanilla ICE), so a call normally costs
 * one offer and one hangup for the caller, one answer for the callee.
 */
import { asActionError } from './state';
import { amount } from './format';
import type { ActionError, CallQuote, CallReceipt, Message, NodeGrantSummary } from './types';

export const CALL_OFFER = 400;
export const CALL_ANSWER = 401;
export const CALL_ICE = 402;
export const CALL_HANGUP = 403;
/** How long an offer rings before either side gives up (genome: 60 s). */
export const RING_MS = 60_000;
/** Bound the renderer wait; the host journal still owns any unresolved payment. */
export const SIGNAL_TIMEOUT_MS = 30_000;
/** How long to wait for ICE gathering before sending what we have. */
export const GATHER_MS = 3_000;
/** A permission prompt may never settle; release the call after this wait. */
export const MEDIA_TIMEOUT_MS = 15_000;
const MEDIA_ERROR = 'Camera/microphone not available — check System Settings → Privacy';

function mediaError(error: unknown, media: CallMedia): string {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
  const devices = media === 'video' ? 'microphone or camera' : 'microphone';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return `Permission to use the ${devices} was denied — allow access in System Settings → Privacy & Security`;
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return `No ${devices} was found — connect a device and try again`;
  if (name === 'NotReadableError' || name === 'TrackStartError') return `The ${devices} is unavailable or in use — close other apps and try again`;
  return MEDIA_ERROR;
}

/** How long a dropped connection may take to come back before the call ends. */
export const DISCONNECT_GRACE_MS = 10_000;
/** 1:1 recovery includes gathering and paid signalling; meetings keep their own grace. */
export const RECONNECT_GRACE_MS = 30_000;
const RESTART_DELAY_MS = 2_000;
// App-to-app conventions within the node's existing v1 schema. A new admission
// is required: the node deliberately rejects repeated 400/401 for one call id.
const RESTART_REQUEST_MID = 'bitsov-restart-v1';
const RESTART_ATTRIBUTE = 'a=x-bitsov-restart-of:';
const restartParent = (sdp: string) => sdp.split(/\r?\n/).find(line => line.startsWith(RESTART_ATTRIBUTE))?.slice(RESTART_ATTRIBUTE.length);
const withoutRestart = (sdp: string) => sdp.split(/\r?\n/).filter(line => !line.startsWith(RESTART_ATTRIBUTE)).join('\r\n');
/** How long an accepted call may stay 'connecting' before it ends. */
export const CONNECT_TIMEOUT_MS = 30_000;

/**
 * The owner's STUN server, if any: `stun:host` or `stun:host:port` (IPv6 in
 * brackets). No TURN (a relay would carry media), no credentials, nothing else.
 */
export function stunServer(url: string | null | undefined): RTCIceServer[] {
  const v = (url ?? '').trim();
  return /^stun:(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9.-]*[a-z0-9])?)(:\d{1,5})?$/i.test(v) ? [{ urls: v }] : [];
}

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
  /** 400 only: this call is one leg of a mesh meeting (see meeting.ts). */
  meeting?: { id: string; roster: string[] };
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

/** Ordinary admission ceiling: offer and one hangup. 1:1 recovery can add one more. */
export const callCost = (q: CallQuote) => q.call_total_msat;
/** What one answer/ICE/hangup costs at most, all-in. */
export const signalCost = (q: CallQuote) => q.signal_msat + q.signal_max_routing_fee_msat;

export type CallState = 'idle' | 'ringing' | 'connecting' | 'live' | 'reconnecting' | 'ended';
/** Detailed card phase; consumers can use CallView.state for the shared lifecycle. */
export type Phase = CallState | 'calling' | 'incoming';
const callState = (phase: Phase): CallState => phase === 'calling' ? 'connecting' : phase === 'incoming' ? 'ringing' : phase;

export type CallView = {
  phase: Phase;
  state: CallState;
  peer: string | null;
  callId: string | null;
  media: CallMedia;
  outgoing: boolean;
  /** When media started flowing. */
  liveAt: number | null;
  muted: boolean;
  camera: boolean;
  /** Sum of receipt ceilings (the host does not expose settled call fees). */
  paidMsat: number;
  /** Candidate types only: never expose addresses from the stats report. */
  connection: { local: string; remote: string } | null;
  reason: HangupReason | null;
  /** A refusal to show (nothing was paid for the refused step). */
  error: string | null;
};

export const IDLE: CallView = {
  phase: 'idle', state: 'idle', peer: null, callId: null, media: 'audio', outgoing: false,
  liveAt: null, muted: false, camera: false, paidMsat: 0, connection: null, reason: null, error: null,
};

type Outcome<T> = { ok: true; value: T } | { ok: false; error: ActionError };

export type CallDeps = {
  /** Check current spend permission and show the shell’s approval path before capture. */
  authorize?: () => Promise<boolean>;
  quote: (peer: string) => Promise<Outcome<CallQuote>>;
  /** Latest grant read by the shell; the host rechecks it before paying. */
  grant?: () => NodeGrantSummary | null;
  signal: (peer: string, kind: number, plaintext: string, maxMsat: number) => Promise<Outcome<CallReceipt>>;
  getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>;
  peerConnection: (config: RTCConfiguration) => RTCPeerConnection;
  now: () => number;
  onView: (v: CallView) => void;
  onStreams: (local: MediaStream | null, remote: MediaStream | null) => void;
  newCallId?: () => string;
  /** Read at each call: the owner's STUN setting, `[]` (host only) by default. */
  iceServers?: () => RTCIceServer[];
  /** Something else (a meeting) holds the mic: an incoming offer rings out. */
  busy?: () => boolean;
};

/** Wait for ICE gathering to finish, or `ms`, whichever comes first. */
export function gathered(pc: RTCPeerConnection, ms: number): Promise<void> {
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
  // Public callId stays stable; each admission has its own node registry id.
  let wireId: string | null = null;
  // Route early answers without treating an in-flight offer as a paid admission.
  let pendingRestartId: string | null = null;
  const admissions = new Set<string>();
  let negotiated = false;
  let answerInFlight = false;
  let restartAttempted = false;
  let restartRequested = false;
  let restartAnswerPending = false;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let ringTimer: ReturnType<typeof setTimeout> | undefined;
  let dropTimer: ReturnType<typeof setTimeout> | undefined;
  let diagnosticTimer: ReturnType<typeof setInterval> | undefined;
  let mediaGeneration = 0;
  const captures = new Set<() => void>();
  let cameraBusy = false;
  let actionGeneration = 0;
  let videoSender: RTCRtpSender | null = null;
  /** The call the owner cancelled while its offer was being prepared or paid. */
  let cancelled: string | null = null;
  // Serialises user actions: a double click never pays twice.
  let busy = false;

  const set = (patch: Partial<CallView>) => {
    view = { ...view, ...patch, state: callState(patch.phase ?? view.phase) };
    deps.onView(view);
  };
  const active = () => view.phase !== 'idle' && view.phase !== 'ended';

  const teardown = () => {
    mediaGeneration++;
    actionGeneration++;
    busy = false;
    cameraBusy = false;
    wireId = null;
    pendingRestartId = null;
    admissions.clear();
    negotiated = false;
    answerInFlight = false;
    restartAttempted = false;
    restartRequested = false;
    restartAnswerPending = false;
    clearTimeout(restartTimer);
    restartTimer = undefined;
    captures.forEach((cancel) => cancel());
    clearInterval(diagnosticTimer);
    diagnosticTimer = undefined;
    clearTimeout(ringTimer);
    ringTimer = undefined;
    clearTimeout(dropTimer);
    dropTimer = undefined;
    videoSender = null;
    const oldPc = pc;
    pc = null;
    if (oldPc) {
      oldPc.ontrack = null;
      oldPc.onconnectionstatechange = null;
      oldPc.oniceconnectionstatechange = null;
    }
    // Release capture before any transport operation can fail.
    for (const track of new Set([...(local?.getTracks() ?? []), ...(remote?.getTracks() ?? [])])) {
      try { track.stop(); } catch { /* Continue releasing the other devices. */ }
    }
    try { oldPc?.close(); } catch { /* Already detached; capture is off. */ }
    local = null;
    remote = null;
    offerSdp = null;
    deps.onStreams(null, null);
  };
  const end = (reason: HangupReason | null, error: string | null = null) => {
    teardown();
    set({ phase: 'ended', reason, error, camera: false, muted: false });
  };

  const acquireMedia = (constraints: MediaStreamConstraints): Promise<MediaStream> => new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      settled = true;
      clearTimeout(timer);
      captures.delete(cancel);
    };
    const cancel = () => { finish(); reject(new Error(MEDIA_ERROR)); };
    const timer = setTimeout(cancel, MEDIA_TIMEOUT_MS);
    captures.add(cancel);
    // getUserMedia cannot be aborted. Stop any stream delivered after timeout/cancel.
    Promise.resolve().then(() => settled ? null : deps.getUserMedia(constraints)).then((stream) => {
      if (!stream) return;
      if (settled) { stream.getTracks().forEach((t) => t.stop()); return; }
      finish();
      resolve(stream);
    }, (error) => { if (!settled) { finish(); reject(error); } });
  });

  const readConnection = async (conn: RTCPeerConnection) => {
    try {
      const stats = await conn.getStats();
      if (pc !== conn) return;
      let pair: RTCIceCandidatePairStats | undefined;
      stats.forEach((stat) => {
        if (stat.type === 'transport' && stat.selectedCandidatePairId) pair = stats.get(stat.selectedCandidatePairId);
      });
      // Older WebKit reports the selected/nominated pair without a transport row.
      if (!pair) stats.forEach((stat) => {
        if (stat.type === 'candidate-pair' && (stat.selected || (stat.nominated && stat.state === 'succeeded'))) pair = stat;
      });
      if (!pair) return;
      const localType = stats.get(pair.localCandidateId)?.candidateType;
      const remoteType = stats.get(pair.remoteCandidateId)?.candidateType;
      const types = ['host', 'srflx', 'prflx', 'relay'];
      set({ connection: { local: types.includes(localType) ? localType : 'unknown', remote: types.includes(remoteType) ? remoteType : 'unknown' } });
    } catch { /* Diagnostics must never affect a call on webviews without stats. */ }
  };

  const connected = (conn: RTCPeerConnection) => {
    if (pc !== conn || !active()) return;
    void readConnection(conn);
    clearInterval(diagnosticTimer);
    diagnosticTimer = setInterval(() => { void readConnection(conn); }, 2_000);
    clearTimeout(dropTimer);
    dropTimer = undefined;
    clearTimeout(restartTimer);
    restartTimer = undefined;
    if (view.phase !== 'live') {
      clearTimeout(ringTimer);
      set({ phase: 'live', liveAt: view.liveAt ?? deps.now() });
    }
  };

  const reconcileConnection = (conn: RTCPeerConnection) => {
    // ICE can fail before WebKit updates the aggregate connection state.
    if (pc !== conn || conn.connectionState !== 'connected' ||
        ['failed', 'disconnected', 'closed'].includes(conn.iceConnectionState)) return false;
    connected(conn);
    return true;
  };

  const recoveryRefused = (conn: RTCPeerConnection, error: string) => {
    if (pc !== conn) return;
    set({ error });
    // A peer can request recovery after our transport has already healed;
    // refusing it will not trigger another connection-state event.
    reconcileConnection(conn);
  };

  const open = async (media: CallMedia) => {
    const generation = mediaGeneration;
    const stream = await acquireMedia({ audio: true, video: media === 'video' });
    if (generation !== mediaGeneration) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error(MEDIA_ERROR);
    }
    local = stream;
    const conn = deps.peerConnection({ iceServers: deps.iceServers?.() ?? [] });
    pc = conn;
    stream.getTracks().forEach((t) => {
      const sender = conn.addTrack(t, stream);
      if (t.kind === 'video') videoSender = sender ?? null;
    });
    conn.ontrack = (e) => {
      if (pc !== conn) return;
      remote = e.streams[0] ?? new MediaStream([e.track]);
      deps.onStreams(local, remote);
    };
    const connectionChanged = (state: string) => {
      if (pc !== conn) return;
      if (state === 'connected') {
        connected(conn);
      } else if (state === 'disconnected' || state === 'failed') {
        reconnect(conn);
        if (state === 'failed') void restart(conn);
        else if (restartTimer === undefined && !restartAttempted && !restartRequested) {
          restartTimer = setTimeout(() => { restartTimer = undefined; void restart(conn); }, RESTART_DELAY_MS);
        }
      } else if (state === 'closed') {
        end('failed', 'The direct connection closed.');
      }
    };
    conn.onconnectionstatechange = () => connectionChanged(conn.connectionState);
    // WKWebView versions may report ICE failure before aggregate connectionState.
    conn.oniceconnectionstatechange = () => {
      const state = conn.iceConnectionState;
      if (state === 'failed' || state === 'disconnected' || state === 'closed') connectionChanged(state);
      else if ((state === 'connected' || state === 'completed') && conn.connectionState === 'connected') connectionChanged('connected');
    };
    deps.onStreams(local, null);
    return conn;
  };

  const pay = async (kind: number, body: Omit<Signal, 'v' | 'call_id'>, maxMsat: number, targetId = wireId ?? view.callId, owner = { peer: view.peer, callId: view.callId }) => {
    const { peer, callId } = owner;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<Outcome<CallReceipt>>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, error: {
        code: 'spend_unknown',
        message: 'The node did not answer in time. The payment outcome is unknown; check the pending result before trying again.',
      } }), SIGNAL_TIMEOUT_MS);
    });
    let r: Outcome<CallReceipt>;
    try {
      r = await Promise.race([deps.signal(peer!, kind, JSON.stringify({ v: 1, call_id: targetId!, ...body }), maxMsat), timeout]);
    } finally { clearTimeout(timer); }
    if (r.ok && view.callId === callId) set({ paidMsat: view.paidMsat + r.value.total_msat });
    return r;
  };

  const reconnect = (conn: RTCPeerConnection) => {
    if (pc !== conn || !active()) return;
    clearTimeout(ringTimer);
    set({ phase: 'reconnecting' });
    if (dropTimer === undefined) dropTimer = setTimeout(() => {
      if (pc === conn && !reconcileConnection(conn)) end('failed', view.error ?? 'The connection was lost. Check that both apps have a reachable STUN server in Settings; some networks cannot connect without a relay.');
    }, RECONNECT_GRACE_MS);
  };

  const restart = async (conn: RTCPeerConnection) => {
    if (pc !== conn || !negotiated || !quote || restartAttempted || restartRequested) return;
    const q = quote;
    // Only the original caller creates offers, so simultaneous failure cannot
    // produce glare or two fresh admission charges. The callee can request it.
    if (!view.outgoing) restartRequested = true;
    else restartAttempted = true;
    try {
      if (deps.authorize && !await deps.authorize()) {
        recoveryRefused(conn, 'Call recovery needs spending approval.');
        return;
      }
      if (pc !== conn) return;
      if (!view.outgoing) {
        const r = await pay(CALL_ICE, { candidate: '', sdp_mid: RESTART_REQUEST_MID }, signalCost(q));
        if (!r.ok) recoveryRefused(conn, r.error.message);
        return;
      }
      if (q.offer_msat === null) { reconcileConnection(conn); return; }
      const grant = deps.grant?.();
      if (grant && q.call_total_msat !== null && (q.call_total_msat > grant.remaining_msat || q.call_total_msat > grant.per_call_max_msat)) {
        recoveryRefused(conn, 'The remaining node grant cannot cover call recovery. Ask the owner to increase the budget.');
        return;
      }
      const id = (deps.newCallId ?? newCallId)();
      if (admissions.has(id)) throw new Error('Could not allocate a fresh call id for recovery.');
      conn.restartIce?.();
      const offer = await conn.createOffer({ iceRestart: true });
      if (pc !== conn) return;
      await conn.setLocalDescription(offer);
      if (pc !== conn) return;
      await gathered(conn, GATHER_MS);
      if (pc !== conn) return;
      pendingRestartId = id;
      restartAnswerPending = true;
      const sdp = `${conn.localDescription!.sdp.trimEnd()}\r\n${RESTART_ATTRIBUTE}${view.callId}\r\n`;
      const r = await pay(CALL_OFFER, { media: view.media, sdp }, q.offer_msat + q.offer_max_routing_fee_msat, id);
      if (pc !== conn) return;
      if (r.ok) {
        wireId = id;
        admissions.add(id);
      } else {
        restartAnswerPending = false;
        recoveryRefused(conn, r.error.message);
      }
    } catch (error) {
      if (pc === conn) restartAnswerPending = false;
      recoveryRefused(conn, `Call recovery failed: ${asActionError(error).message}`);
    } finally {
      if (pc === conn) pendingRestartId = null;
    }
  };

  const answerRestart = async (signal: Signal) => {
    const conn = pc;
    if (!conn || !quote || !negotiated || view.outgoing || restartAttempted || !active() ||
        restartParent(signal.sdp!) !== view.callId || admissions.has(signal.call_id) || signal.media !== view.media) return;
    restartAttempted = true;
    reconnect(conn);
    try {
      if (deps.authorize && !await deps.authorize()) {
        recoveryRefused(conn, 'Call recovery needs spending approval.');
        return;
      }
      if (pc !== conn) return;
      wireId = signal.call_id;
      admissions.add(signal.call_id);
      await conn.setRemoteDescription({ type: 'offer', sdp: withoutRestart(signal.sdp!) });
      if (pc !== conn) return;
      const answer = await conn.createAnswer();
      if (pc !== conn) return;
      await conn.setLocalDescription(answer);
      if (pc !== conn) return;
      await gathered(conn, GATHER_MS);
      if (pc !== conn) return;
      const r = await pay(CALL_ANSWER, { sdp: conn.localDescription!.sdp }, signalCost(quote));
      if (!r.ok) recoveryRefused(conn, r.error.message);
    } catch (error) {
      recoveryRefused(conn, `Call recovery failed: ${asActionError(error).message}`);
    }
  };

  /** Media is set up but not flowing yet: give up after a while (nothing paid). */
  const awaitConnect = (callId: string) => {
    clearTimeout(ringTimer);
    ringTimer = setTimeout(() => {
      if (view.callId === callId && view.phase === 'connecting') end('failed', 'The call could not connect.');
    }, CONNECT_TIMEOUT_MS);
  };

  const guarded = async (run: (claim: (id: string | null) => void) => Promise<void>) => {
    if (busy) return;
    busy = true;
    const action = actionGeneration;
    let callId = view.callId;
    try {
      await run((id) => { callId = id; });
    } catch (error) {
      if (view.callId === callId && active()) end(null, asActionError(error).message);
    } finally {
      if (action === actionGeneration) busy = false;
    }
  };

  return {
    view: () => view,

    /** Place a call. The price was shown before this is called. */
    place: (peer: string, media: CallMedia, q: CallQuote) => guarded(async (claim) => {
      const generation = mediaGeneration;
      if (active() || deps.busy?.()) return;
      if (q.offer_msat === null || q.call_total_msat === null) {
        set({ ...IDLE, phase: 'ended', peer, error: 'Their node does not take calls yet. Nothing was paid.' });
        return;
      }
      const grant = deps.grant?.();
      if (grant && (q.call_total_msat > grant.per_call_max_msat || q.call_total_msat > grant.remaining_msat)) {
        set({ ...IDLE, phase: 'ended', peer, error:
          `This call needs up to ${amount(q.call_total_msat)}. Your node grant allows ${amount(grant.per_call_max_msat)} per call and has ${amount(grant.remaining_msat)} remaining. The owner would need to approve at least ${amount(q.call_total_msat)} per call and enough remaining budget for that ceiling. Nothing was sent or paid.` });
        return;
      }
      if (deps.authorize && !await deps.authorize()) return;
      if (generation !== mediaGeneration || active() || deps.busy?.()) return;
      quote = q;
      const callId = (deps.newCallId ?? newCallId)();
      cancelled = null;
      wireId = callId;
      admissions.add(callId);
      claim(callId);
      set({ ...IDLE, phase: 'calling', peer, callId, media, outgoing: true, camera: media === 'video' });
      let conn: RTCPeerConnection;
      try {
        conn = await open(media);
        if (cancelled === callId || view.callId !== callId || !active()) return;
        await conn.setLocalDescription(await conn.createOffer());
        await gathered(conn, GATHER_MS);
      } catch (error) {
        if (cancelled === callId || view.callId !== callId || !active()) return;
        end(null, `${mediaError(error, view.media)}. Nothing was paid.`);
        return;
      }
      // Cancelled before the offer went out: nothing is paid.
      if (cancelled === callId || view.callId !== callId || !active()) return;
      const r = await pay(CALL_OFFER, { media, sdp: conn.localDescription!.sdp }, q.offer_msat + q.offer_max_routing_fee_msat);
      // Cancelled while the offer was in flight: the mic is already off; send nothing more.
      if (cancelled === callId || view.callId !== callId || !active()) return;
      if (!r.ok) {
        end(null, r.error.message);
        return;
      }
      if (view.phase === 'calling' && !negotiated && !answerInFlight) {
        set({ phase: 'ringing' });
        // An answer can arrive before our offer's receipt; never regress it.
        ringTimer = setTimeout(() => { if (view.callId === callId && view.phase === 'ringing') end('timeout'); }, RING_MS);
      }
    }),

    /** Accept the ringing call: one paid answer. */
    accept: () => guarded(async () => {
      if (view.phase !== 'incoming' || !offerSdp) return;
      const callId = view.callId;
      if (deps.authorize && !await deps.authorize()) return;
      if (view.callId !== callId || view.phase !== 'incoming') return;
      clearTimeout(ringTimer);
      set({ phase: 'connecting' });
      awaitConnect(callId!);
      const q = await deps.quote(view.peer!);
      if (view.callId !== callId || !active()) return;
      if (!q.ok) { end(null, q.error.message); return; }
      quote = q.value;
      let conn: RTCPeerConnection;
      try {
        conn = await open(view.media);
        await conn.setRemoteDescription({ type: 'offer', sdp: offerSdp });
        await conn.setLocalDescription(await conn.createAnswer());
        await gathered(conn, GATHER_MS);
      } catch (error) {
        if (view.callId !== callId || !active()) return;
        end(null, `${mediaError(error, view.media)}. Nothing was paid.`);
        return;
      }
      if (view.callId !== callId || !active()) return;
      negotiated = true; // The peer may see the answer before our host receipt.
      const r = await pay(CALL_ANSWER, { sdp: conn.localDescription!.sdp }, signalCost(quote));
      if (view.callId !== callId || !active()) return;
      if (!r.ok) end(null, r.error.message);
      else {
        negotiated = true;
        if ((view.phase as Phase) === 'connecting') awaitConnect(callId!);
        else if ((view.phase as Phase) === 'reconnecting') void restart(conn);
      }
    }),

    /** Decline a ringing call: one paid hangup, so the caller stops ringing. */
    decline: () => guarded(async () => {
      if (view.phase !== 'incoming') return;
      const owner = { peer: view.peer, callId: view.callId };
      const id = wireId;
      const generation = mediaGeneration;
      const q = await deps.quote(owner.peer!);
      if (mediaGeneration !== generation || view.callId !== owner.callId || view.phase !== 'incoming') return;
      end('declined');
      if (q.ok) {
        try {
          const r = await pay(CALL_HANGUP, { reason: 'declined' }, signalCost(q.value), id, owner);
          if (!r.ok && view.callId === owner.callId) set({ error: r.error.message });
        } catch (error) {
          if (view.callId === owner.callId) set({ error: asActionError(error).message });
        }
      }
    }),

    /**
     * Hang up: one paid hangup once the offer went out. While calling it
     * cancels at once (not serialised behind the offer): the mic stops now;
     * an offer not yet sent is never paid, one in flight is not followed by
     * anything else.
     */
    hangup: async () => {
      if (!active()) return;
      const callId = view.callId;
      const notify = view.phase !== 'calling' && view.phase !== 'incoming' && quote;
      const ids = [...admissions].reverse();
      const owner = { peer: view.peer, callId }; // Keep late cleanup bound to this peer.
      cancelled = callId;
      end('hangup');
      if (notify) {
        for (const id of ids) {
          try {
            const r = await pay(CALL_HANGUP, { reason: 'hangup' }, signalCost(notify), id, owner);
            if (!r.ok && view.callId === callId) set({ error: r.error.message });
          } catch (error) {
            if (view.callId === callId) set({ error: asActionError(error).message });
          }
        }
      }
    },

    /** End without paying anything (the window is closing). The peer's side times out. */
    endLocal: () => {
      // Also invalidate a preflight that has not entered Calling yet.
      if (!active()) { teardown(); return; }
      if (view.phase === 'calling') cancelled = view.callId;
      end('hangup');
    },

    toggleMute: () => {
      if (!local) return;
      const muted = !view.muted;
      local.getAudioTracks().forEach((t) => { t.enabled = !muted; });
      set({ muted });
    },

    /**
     * Camera off stops the video track (the camera light goes off); camera on
     * captures a fresh one and puts it back on the same sender.
     */
    toggleCamera: async () => {
      const stream = local;
      const sender = videoSender;
      if (!stream || !sender || view.media !== 'video' || cameraBusy) return;
      cameraBusy = true;
      let track: MediaStreamTrack | undefined;
      try {
        if (view.camera) {
          stream.getVideoTracks().forEach((t) => { t.stop(); stream.removeTrack(t); });
          set({ camera: false });
          await sender.replaceTrack(null);
        } else {
          const fresh = await acquireMedia({ video: true });
          track = fresh.getVideoTracks()[0];
          fresh.getTracks().forEach((t) => { if (t !== track) t.stop(); });
          if (local !== stream) { track?.stop(); return; }
          if (!track) throw new DOMException('No camera', 'NotFoundError');
          // Own the track before replaceTrack awaits, so hangup can stop it.
          stream.addTrack(track);
          await sender.replaceTrack(track);
          if (local !== stream) return;
          set({ camera: true, error: null });
        }
        if (local === stream) deps.onStreams(local, remote);
      } catch (error) {
        if (track) { track.stop(); stream.removeTrack(track); }
        if (local === stream) set({ camera: false, error: mediaError(error, 'video') });
      } finally {
        if (local === stream) cameraBusy = false;
      }
    },

    /** Close the ended card. */
    dismiss: () => { if (view.phase === 'ended') set(IDLE); },

    /** A 400-403 the node forwarded (already paid, and admitted by its call registry). */
    receive: async (m: Message, ownId: string) => {
      if (m.sender.toLowerCase() === ownId.toLowerCase()) return;
      const s = parseSignal(m.kind, m.plaintext);
      if (!s) return;
      const peer = m.sender.toLowerCase();
      const ours = (pendingRestartId ?? wireId) === s.call_id && view.peer === peer;
      switch (m.kind) {
        case CALL_OFFER:
          if (!s.meeting && view.peer === peer && restartParent(s.sdp!) === view.callId) {
            await answerRestart(s);
            return;
          }
          // A meeting leg belongs to the meeting engine. Busy: let their ring
          // time out rather than pay to say so.
          if (s.meeting || restartParent(s.sdp!) || active() || deps.busy?.()) return;
          quote = null;
          wireId = s.call_id;
          admissions.add(s.call_id);
          offerSdp = s.sdp!;
          set({ ...IDLE, phase: 'incoming', peer, callId: s.call_id, media: s.media!, camera: s.media === 'video' });
          ringTimer = setTimeout(() => { if (view.callId === s.call_id && view.phase === 'incoming') end('timeout'); }, RING_MS);
          return;
        case CALL_ANSWER: {
          if (!ours || !pc || !active() || answerInFlight || (!restartAnswerPending && (negotiated || !view.outgoing))) return;
          const conn = pc;
          const restarting = restartAnswerPending;
          // Claim the answer before awaiting, including duplicate live events.
          restartAnswerPending = false;
          answerInFlight = true;
          if (!restarting && view.phase !== 'reconnecting') {
            set({ phase: 'connecting' });
            awaitConnect(view.callId!);
          }
          try {
            await conn.setRemoteDescription({ type: 'answer', sdp: s.sdp! });
            if (pc === conn) {
              negotiated = true;
              answerInFlight = false;
              if (view.phase === 'reconnecting') void restart(conn);
            }
          } catch {
            if (pc === conn) end('failed', 'Their answer could not be used.');
          }
          return;
        }
        case CALL_ICE:
          if (ours && pc && s.candidate === '' && s.sdp_mid === RESTART_REQUEST_MID) {
            if (view.outgoing && !restartAttempted) { reconnect(pc); await restart(pc); }
            return;
          }
          if (ours && pc) await pc.addIceCandidate({ candidate: s.candidate!, sdpMid: s.sdp_mid ?? null, sdpMLineIndex: s.sdp_mline_index ?? null }).catch(() => undefined);
          return;
        default:
          if (view.peer === peer && (admissions.has(s.call_id) || pendingRestartId === s.call_id) && active()) end(s.reason ?? 'hangup');
      }
    },
  };
}
