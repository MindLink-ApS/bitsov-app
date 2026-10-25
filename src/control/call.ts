import { t as tr } from '../i18n';
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
import { appPlatform, type AppPlatform } from '../platform';
import { provenUnpaid } from './paymentOutcome';
import { asActionError } from './state';
import { amount } from './format';
import type { ActionError, CallQuote, CallReceipt, Message, NodeGrantSummary, OpView } from './types';

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
const MEDIA_ERROR = () => tr('caCameraMicrophoneNotAvailableCheckSystemSettingsPrivacy');
/** The webview exposes no navigator.mediaDevices at all (e.g. a build without media access). */
export const NO_MEDIA_DEVICES = 'MediaDevicesUnavailable';

/** Where this platform's owner allows the microphone and camera. */
const permissionPlace = (platform: AppPlatform) =>
  platform === 'ios' ? tr('caSettingsBitSov') : platform === 'android' ? tr('caSettingsAppsBitSovPermissions') : tr('caSystemSettingsPrivacySecurity');

export function mediaError(error: unknown, media: CallMedia, platform: AppPlatform = appPlatform()): string {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
  const devices = media === 'video' ? tr('caMicrophoneOrCamera') : tr('caMicrophone');
  if (name === NO_MEDIA_DEVICES) return media === 'video' ? tr('caThisBuildCannotUseTheMicrophoneOrCameraYet') : tr('caThisBuildCannotUseTheMicrophoneYet');
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return tr('caPermissionToUseTheWasDeniedAllowAccessIn', devices, permissionPlace(platform));
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return tr('caNoWasFoundConnectADeviceAndTryAgain', devices);
  if (name === 'NotReadableError' || name === 'TrackStartError') return tr('caTheIsUnavailableOrInUseCloseOtherApps', devices);
  return platform === 'desktop' ? MEDIA_ERROR() : tr('caCameraMicrophoneNotAvailableCheck', permissionPlace(platform));
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
  /** Stop the alert immediately while a requested decline obtains its quote. */
  silenced?: boolean;
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
  /**
   * Signals whose payment outcome is not known (spend_unknown /
   * payment_unknown, including a 30 s timeout), and the sum of their caps.
   * Never cleared by ending the call: the ended panel must say so.
   */
  unknownCount: number;
  unknownMsat: number;
  /**
   * Signals still in flight (sent to the host, not settled yet), and the sum
   * of their caps. Each moves into paid or unknown (or drops, proven unpaid)
   * when it settles, even after the call ended.
   */
  pendingCount: number;
  pendingMsat: number;
  /** Candidate types only: never expose addresses from the stats report. */
  connection: { local: string; remote: string } | null;
  reason: HangupReason | null;
  /** A refusal to show (nothing was paid for the refused step). */
  error: string | null;
  /**
   * The browser reports no network (display only). Never read by the call's
   * own logic: recovery stays ICE-driven (restart after its delay, or ended
   * after the grace), whatever this says.
   */
  offline: boolean;
  /** Display only: while reconnecting, when the call ends if the connection has not come back. */
  dropAt: number | null;
  /** Display only: this call has used its one recovery attempt (a restart offer, or a restart request or answer). */
  recoveryUsed: boolean;
  /** Display only: the one recovery was already used when this drop began, so none is tried this time. */
  recoveryUsedBefore: boolean;
  /** Display only: why a recovery could not start (recoveryRefused), apart from any other error (a camera, a hangup). */
  recoveryError: string | null;
  /** H2: ending this call's own admissions at the host; null when none was ours. */
  close: CallClose | null;
  /** H2: an earlier call to this peer is still open at the host (`call_admission_open`). */
  stuck: { opId: string | null } | null;
};

/** `closed`: the host ended it (or nothing was owed); `unknown`: check pending result; `refused`: still open. */
export type CallClose = { status: 'closing' | 'closed' | 'unknown' | 'refused'; message: string | null };

const CLOSE_UNKNOWN = () => tr('caEndingTheCallTheResultIsNotKnownYet');
/** What one `op_end_call` answer means for the owner. A failed read never says "ended". */
export function closeOutcome(r: Outcome<OpView>): CallClose {
  if (r.ok) return r.value.state === 'dispatching' || r.value.state === 'unknown'
    ? { status: 'unknown', message: CLOSE_UNKNOWN() } : { status: 'closed', message: null };
  switch (r.error.code) {
    // Nothing of this call is recorded at the host: nothing is open.
    case 'call_not_found': return { status: 'closed', message: null };
    case 'spend_unknown': case 'payment_unknown': return { status: 'unknown', message: CLOSE_UNKNOWN() };
    case 'price_changed': case 'price_cap_exceeded':
      return { status: 'refused', message: tr('caCouldnTEndTheCallTheirNodeNowAsks') };
    default: return { status: 'refused', message: tr('caCouldnTEndTheCall', r.error.message) };
  }
}
const CLOSE_RANK = { closed: 0, closing: 1, refused: 2, unknown: 3 } as const;
/**
 * Their hangup, bound by the host to one exact admission (`confirmed`, its
 * wire call id): the host closes that admission itself on that evidence, so it
 * is not ended from here. Every other admission of ours is still ended.
 */
const peerEnd = (confirmed: string) => ({ record: false, confirmed }) as const;

export const RECOVERY_CLOSING = 'Your last call is still closing. End it, then call again.';

export const IDLE: CallView = {
  silenced: false,
  phase: 'idle', state: 'idle', peer: null, callId: null, media: 'audio', outgoing: false,
  liveAt: null, muted: false, camera: false, paidMsat: 0, unknownCount: 0, unknownMsat: 0, pendingCount: 0, pendingMsat: 0, connection: null, reason: null, error: null, offline: false,
  close: null, stuck: null, dropAt: null, recoveryUsed: false, recoveryUsedBefore: false, recoveryError: null,
};

type Outcome<T> = { ok: true; value: T } | { ok: false; error: ActionError };

export type CallDeps = {
  /** Report local teardown by exact admission. Host keeps cleanup pending. No send. */
  closeAdmission?: (operationId: string, peer: string, callId: string) => Promise<void>;
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
  onWaiting?: (calls: CallView[]) => void;
  onMissed?: (call: { callId: string; peer: string; media: CallMedia; at: number }) => void;
  /** iOS only: local session policy, never a signal or payment. */
  audioSession?: (live: boolean) => Promise<void>;
  onStreams: (local: MediaStream | null, remote: MediaStream | null) => void;
  newCallId?: () => string;
  /** Read at each call: the owner's STUN setting, `[]` (host only) by default. */
  iceServers?: () => RTCIceServer[];
  /** Something else (a meeting) holds the mic: an incoming offer rings out. */
  busy?: () => boolean;
  /** H2 `op_end_call`: end one of our admissions (by its wire call id). Absent: hangups are paid here, as before H2. */
  endCall?: (callId: string) => Promise<Outcome<OpView>>;
  /** The call id of the host's open admission `opId` to `peer` (from `op_list`); null if not found. */
  stuckCall?: (peer: string, opId: string | null) => Promise<string | null>;
  /**
   * Optional display classification override. By default the tally shares
   * the host's proven-unpaid error classification with the shell.
   */
  provenUnpaid?: (code: string) => boolean;
};

/**
 * Calls `offline` / `online` on the browser's network events, and the matching
 * one on a connection type change (navigator.connection, where it exists).
 * Returns the remover.
 */
export function watchNetwork(offline: () => void, online: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const conn = (navigator as Navigator & { connection?: EventTarget }).connection;
  const changed = () => { if (navigator.onLine === false) offline(); else online(); };
  window.addEventListener('offline', offline);
  window.addEventListener('online', online);
  conn?.addEventListener?.('change', changed);
  return () => {
    window.removeEventListener('offline', offline);
    window.removeEventListener('online', online);
    conn?.removeEventListener?.('change', changed);
  };
}

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

type IncomingOffer = { callId: string; peer: string; media: CallMedia; at: number; sdp: string };

export type CallEngine = ReturnType<typeof createCallEngine>;

export function createCallEngine(deps: CallDeps) {
  let view: CallView = IDLE;
  let incomingAt = 0;
  const seenOffers = new Set<string>();
  // Each waiting card owns its own signalling tally and timeout, never the live media.
  const waiting = new Map<string, {
    view: () => CallView;
    receive: (m: Message, ownId: string) => Promise<void>;
    decline: () => Promise<void>;
    dismiss: () => void;
    endLocal: () => void;
    takeIncoming: () => IncomingOffer | null;
  }>();
  const publishWaiting = () => {
    for (const [key, call] of waiting) if (call.view().phase === 'idle') waiting.delete(key);
    deps.onWaiting?.([...waiting.values()].map(c => c.view()));
  };
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
  /** Display only: a refused recovery's text that a heal left showing, cleared when the next drop starts. */
  let healedRefusal: string | null = null;
  let diagnosticTimer: ReturnType<typeof setInterval> | undefined;
  let mediaGeneration = 0;
  const captures = new Set<() => void>();
  let cameraBusy = false;
  let actionGeneration = 0;
  let videoSender: RTCRtpSender | null = null;
  /** The call the owner cancelled while its offer was being prepared or paid. */
  let cancelled: string | null = null;
  /** Our admissions in this call (an offer once it went to the host, and each recovery offer). */
  let own: string[] = [];
  /** Ids `op_end_call` was asked for: each once, unless the owner asks again. */
  const closing = new Set<string>();
  /** Capture the actual host completion, independently of the renderer timeout. */
  const offersInFlight = new Map<string, Promise<Outcome<CallReceipt>>>();
  /** Per displayed call: ids whose end was refused, which the owner may ask again. Another call's answer never touches it. */
  const refusedClose = new Map<string, string[]>();
  /** Removes the network listeners of the current connection (display only). */
  let offNetwork: (() => void) | null = null;
  // Serialises user actions: a double click never pays twice.
  let busy = false;

  let audioLive = false;
  let audioQueue = Promise.resolve();
  let backgrounded = false;
  let videoGeneration = 0;
  const updateAudio = (live: boolean) => {
    if (!deps.audioSession || live === audioLive) return;
    audioLive = live;
    const callId = view.callId;
    // Preserve stop/start ordering if a native activation is still in flight.
    audioQueue = audioQueue.then(async () => {
      if (live && (!audioLive || view.callId !== callId)) return;
      await deps.audioSession!(live);
    }).catch(() => {
      if (view.callId === callId && live === audioLive) {
        // A local policy failure must not trigger a paid hangup or ICE restart.
        view = { ...view, error: live
          ? tr('caCouldNotUpdateBackgroundAudioKeepTheAppOpen')
          : tr('caCouldNotReleaseCallAudioCloseTheAppIf') };
        deps.onView(view);
      }
    });
  };

  const set = (patch: Partial<CallView>) => {
    view = { ...view, ...patch, state: callState(patch.phase ?? view.phase) };
    // Repair keeps the same media running. Hold its session until teardown,
    // but never acquire one for a connection that has not reached Live.
    updateAudio(pc !== null && (view.phase === 'live' ||
      (view.phase === 'reconnecting' && view.liveAt !== null)));
    deps.onView(view);
  };
  const active = () => view.phase !== 'idle' && view.phase !== 'ended';

  const teardown = () => {
    offNetwork?.();
    offNetwork = null;
    mediaGeneration++;
    actionGeneration++;
    busy = false;
    cameraBusy = false;
    wireId = null;
    pendingRestartId = null;
    admissions.clear();
    pendingPeerEnds.clear();
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
    updateAudio(false);
  };
  /** Ask the host to end each admission once; the worst answer is what the card says. */
  const closeAdmissions = async (ids: string[], callId: string | null) => {
    const endCall = deps.endCall;
    const todo = ids.filter((id) => !closing.has(id));
    if (!endCall || todo.length === 0) return;
    todo.forEach((id) => closing.add(id));
    if (view.callId === callId) set({ close: { status: 'closing', message: null } });
    let worst: CallClose = { status: 'closed', message: null };
    const refused: string[] = [];
    for (const id of todo) {
      const cap = quote ? signalCost(quote) : 0;
      if (view.callId === callId) owe(cap);
      // Snapshot overlap before awaiting endCall: either reply can arrive first.
      const offer = offersInFlight.get(id);
      const ask = async (): Promise<Outcome<OpView>> => {
        try { return await endCall(id); } catch (error) { return { ok: false, error: asActionError(error) }; }
      };
      let r = await ask();
      if (!r.ok && r.error.code === 'call_not_found' && offer) {
        const result = await offer;
        // Only positive non-dispatch evidence can avoid the second host check.
        // Paid/unknown errors and thrown IPC failures all retain cleanup intent.
        if (result.ok || !provenUnpaid(result.error.code)) r = await ask();
      }
      const c = closeOutcome(r);
      if (c.status === 'refused') refused.push(id);
      if (CLOSE_RANK[c.status] > CLOSE_RANK[worst.status]) worst = c;
      if (view.callId === callId) {
        const unknown = c.status === 'unknown' || (!r.ok && r.error.code !== 'call_not_found' && !provenUnpaid(r.error.code));
        set({ pendingCount: view.pendingCount - 1, pendingMsat: view.pendingMsat - cap,
          paidMsat: view.paidMsat + (r.ok && r.value.kind === 'call_hangup' ? r.value.paid_msat ?? 0 : 0),
          unknownCount: view.unknownCount + Number(unknown), unknownMsat: view.unknownMsat + (unknown ? cap : 0) });
      }
    }
    if (callId) {
      // Only this call's own entry: a late answer for call A never clears call B's "Try ending it again".
      const left = (refusedClose.get(callId) ?? []).filter((id) => !todo.includes(id)).concat(refused);
      if (left.length) refusedClose.set(callId, left); else refusedClose.delete(callId);
    }
    if (view.callId === callId) set({ close: worst });
  };
  const admissionOps = new Map<string, Map<string, string>>();
  /** Their hangup for one of our offers, waiting for that offer's receipt to bring the host-bound op id. */
  const pendingPeerEnds = new Map<string, { callId: string; reason: HangupReason }>();
  const closeAdmission = (operationId: string, peer: string, callId: string): Promise<void> =>
    deps.closeAdmission?.(operationId, peer, callId).catch(() => { /* Host preserves the fence on storage failure. */ }) ?? Promise.resolve();
  /** Local teardown validates identity only; op_end_call performs node-confirmed cleanup. */
  const end = (reason: HangupReason | null, error: string | null = null, opts: { record?: boolean; endAtHost?: boolean; confirmed?: string } = {}) => {
    if (view.phase === 'incoming' && !view.silenced && reason !== 'declined' && view.callId && view.peer) {
      deps.onMissed?.({ callId: view.callId, peer: view.peer, media: view.media, at: incomingAt });
    }
    const { record = true, endAtHost = true, confirmed } = opts;
    const peer = view.peer;
    const operations = [...(view.callId ? admissionOps.get(view.callId) ?? [] : [])];
    if (view.callId) admissionOps.delete(view.callId);
    // The admission the host confirmed closed (their bound hangup) is not ended again; the rest are.
    const ids = own.filter((id) => id !== confirmed);
    const callId = view.callId;
    own = [];
    teardown();
    healedRefusal = null;
    set({ phase: 'ended', reason, error, camera: false, muted: false, offline: false, dropAt: null, recoveryError: null });
    const recorded = record && peer ? Promise.all(operations.map(([operationId, wireCallId]) => closeAdmission(operationId, peer, wireCallId))) : Promise.resolve();
    if (endAtHost && ids.length) void recorded.then(() => closeAdmissions(ids, callId));
  };

  const acquireMedia = (constraints: MediaStreamConstraints): Promise<MediaStream> => new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      settled = true;
      clearTimeout(timer);
      captures.delete(cancel);
    };
    const cancel = () => { finish(); reject(new Error(MEDIA_ERROR())); };
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
    // Healed: the refusal stays said while live; it is remembered so the next drop starts without it.
    if (view.recoveryError !== null) { healedRefusal = view.recoveryError; set({ recoveryError: null }); }
    if (view.phase !== 'live') {
      clearTimeout(ringTimer);
      set({ phase: 'live', liveAt: view.liveAt ?? deps.now(), dropAt: null });
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
    set({ recoveryError: error });
    // A peer can request recovery after our transport has already healed;
    // refusing it will not trigger another connection-state event.
    reconcileConnection(conn);
  };

  const pauseVideo = () => {
    const stream = local;
    if (!stream || view.media !== 'video') return;
    stream.getVideoTracks().forEach((track) => { track.stop(); stream.removeTrack(track); });
    set({ camera: false });
    void videoSender?.replaceTrack(null).catch(() => { /* Capture is already off. */ });
    deps.onStreams(local, remote);
  };

  const open = async (media: CallMedia) => {
    const generation = mediaGeneration;
    const videoRequest = videoGeneration;
    const stream = await acquireMedia({ audio: true, video: media === 'video' });
    if (generation !== mediaGeneration) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error(MEDIA_ERROR());
    }
    local = stream;
    const conn = deps.peerConnection({ iceServers: deps.iceServers?.() ?? [] });
    pc = conn;
    stream.getTracks().forEach((t) => {
      const sender = conn.addTrack(t, stream);
      if (t.kind === 'video') videoSender = sender ?? null;
    });
    if (backgrounded || videoRequest !== videoGeneration) pauseVideo();
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
        end('failed', tr('caTheDirectConnectionClosed'));
      }
    };
    conn.onconnectionstatechange = () => connectionChanged(conn.connectionState);
    // WKWebView versions may report ICE failure before aggregate connectionState.
    conn.oniceconnectionstatechange = () => {
      const state = conn.iceConnectionState;
      if (state === 'failed' || state === 'disconnected' || state === 'closed') connectionChanged(state);
      else if ((state === 'connected' || state === 'completed') && conn.connectionState === 'connected') connectionChanged('connected');
    };
    // Network events are display only: they set view.offline for the call panel's note, and never
    // call reconnect()/restart() or touch anything those or the answer path read.
    offNetwork?.();
    offNetwork = watchNetwork(
      () => { if (pc === conn && active()) set({ offline: true }); },
      () => { if (pc === conn && view.offline) set({ offline: false }); },
    );
    deps.onStreams(local, null);
    return conn;
  };

  /**
   * The tally only: an owed signal (a hangup the engine has decided to send)
   * is pending from that moment, before the call ends, so the ended card
   * never says "paid nothing" while it is owed. Not published here: the
   * end() that follows publishes it. Its pay() is then passed `owed`.
   */
  const owe = (maxMsat: number) => {
    view = { ...view, pendingCount: view.pendingCount + 1, pendingMsat: view.pendingMsat + maxMsat };
  };

  const pay = async (kind: number, body: Omit<Signal, 'v' | 'call_id'>, maxMsat: number, targetId = wireId ?? view.callId, owner = { peer: view.peer, callId: view.callId }, owed = false) => {
    const { peer, callId } = owner;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<Outcome<CallReceipt>>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, error: {
        code: 'spend_unknown',
        message: tr('caTheNodeDidNotAnswerInTimeThePayment'),
      } }), SIGNAL_TIMEOUT_MS);
    });
    // The tally only: what reached this call's paid / unknown totals. A signal
    // is pending from before the race until it settles; then it moves (one
    // update) into paid, unknown, or nothing. Paid for certain without a
    // receipt counts at its cap ("up to"); anything else not proven unpaid is
    // unknown (count + cap). Never cleared by ending the call.
    const counted = view.callId === callId;
    if (counted && !owed) set({ pendingCount: view.pendingCount + 1, pendingMsat: view.pendingMsat + maxMsat });
    const tally = (outcome: Outcome<CallReceipt> | null, code: string) => {
      if (!counted || view.callId !== callId) return;
      const next: Partial<CallView> = { pendingCount: view.pendingCount - 1, pendingMsat: view.pendingMsat - maxMsat };
      if (outcome?.ok) next.paidMsat = view.paidMsat + outcome.value.total_msat;
      else if (code === 'payment_settled_undelivered' || code === 'failed_paid') next.paidMsat = view.paidMsat + maxMsat;
      else if (!(deps.provenUnpaid ?? provenUnpaid)(code)) {
        next.unknownCount = view.unknownCount + 1;
        next.unknownMsat = view.unknownMsat + maxMsat;
      }
      set(next);
    };
    let r: Outcome<CallReceipt>;
    try {
      const signal = Promise.resolve().then(() => deps.signal(peer!, kind,
        JSON.stringify({ v: 1, call_id: targetId!, ...body }), maxMsat))
        .catch((error): Outcome<CallReceipt> => ({ ok: false, error: asActionError(error) })).then(result => {
        const operationId = result.ok ? result.value.operation_id
          : result.error.operation_id;
        if (kind === CALL_OFFER && operationId && (result.ok || !provenUnpaid(result.error.code))) {
          if (view.callId !== callId || !active()) closeAdmission(operationId, peer!, targetId!);
          else {
            const operations = admissionOps.get(callId!) ?? new Map<string, string>();
            operations.set(operationId, targetId!);
            admissionOps.set(callId!, operations);
            const pendingEnd = pendingPeerEnds.get(operationId);
            if (pendingEnd?.callId === targetId) end(pendingEnd.reason, null, peerEnd(targetId!));
          }
        }
        return result;
      });
      if (kind === CALL_OFFER) {
        offersInFlight.set(targetId!, signal);
        void signal.then(() => offersInFlight.delete(targetId!));
      }
      r = await Promise.race([signal, timeout]);
    } catch (error) {
      // A rejection after dispatch may still have paid: counted, then rethrown unchanged.
      tally(null, asActionError(error).code);
      throw error;
    } finally { clearTimeout(timer); }
    tally(r, r.ok ? '' : r.error.code);
    return r;
  };

  const reconnect = (conn: RTCPeerConnection) => {
    if (pc !== conn || !active()) return;
    clearTimeout(ringTimer);
    set({ phase: 'reconnecting' });
    // Display only: when this drop ends the call, and whether its one recovery was already spent.
    // A new drop: an earlier drop's refused-recovery words (still the error) are not this drop's (display only).
    if (dropTimer === undefined) {
      set({ dropAt: deps.now() + RECONNECT_GRACE_MS, recoveryUsedBefore: view.recoveryUsed, ...(healedRefusal !== null && view.error === healedRefusal ? { error: null } : {}) });
      healedRefusal = null;
    }
    if (dropTimer === undefined) dropTimer = setTimeout(() => {
      if (pc === conn && !reconcileConnection(conn)) end('failed', view.error ?? tr('caTheConnectionWasLostCheckThatBothAppsHave'));
    }, RECONNECT_GRACE_MS);
  };

  const restart = async (conn: RTCPeerConnection) => {
    if (pc !== conn || !negotiated || !quote || restartAttempted || restartRequested) return;
    const q = quote;
    // Only the original caller creates offers, so simultaneous failure cannot
    // produce glare or two fresh admission charges. The callee can request it.
    if (!view.outgoing) restartRequested = true;
    else restartAttempted = true;
    set({ recoveryUsed: true });
    try {
      if (deps.authorize && !await deps.authorize()) {
        recoveryRefused(conn, tr('caCallRecoveryNeedsSpendingApproval'));
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
        recoveryRefused(conn, tr('caTheRemainingNodeGrantCannotCoverCallRecoveryAsk'));
        return;
      }
      const id = (deps.newCallId ?? newCallId)();
      if (admissions.has(id)) throw new Error(tr('caCouldNotAllocateAFreshCallIdForRecovery'));
      conn.restartIce?.();
      const offer = await conn.createOffer({ iceRestart: true });
      if (pc !== conn) return;
      await conn.setLocalDescription(offer);
      if (pc !== conn) return;
      await gathered(conn, GATHER_MS);
      if (pc !== conn) return;
      pendingRestartId = id;
      restartAnswerPending = true;
      own.push(id);
      const sdp = `${conn.localDescription!.sdp.trimEnd()}\r\n${RESTART_ATTRIBUTE}${view.callId}\r\n`;
      const r = await pay(CALL_OFFER, { media: view.media, sdp }, q.offer_msat + q.offer_max_routing_fee_msat, id);
      if (pc !== conn) return;
      if (r.ok) {
        wireId = id;
        admissions.add(id);
      } else {
        restartAnswerPending = false;
        if (provenUnpaid(r.error.code)) own = own.filter((call) => call !== id);
        recoveryRefused(conn, r.error.code === 'call_admission_open' ? RECOVERY_CLOSING : r.error.message);
      }
    } catch (error) {
      if (pc === conn) restartAnswerPending = false;
      recoveryRefused(conn, tr('caCallRecoveryFailed', asActionError(error).message));
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
    set({ recoveryUsed: true });
    try {
      if (deps.authorize && !await deps.authorize()) {
        recoveryRefused(conn, tr('caCallRecoveryNeedsSpendingApproval'));
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
      recoveryRefused(conn, tr('caCallRecoveryFailed', asActionError(error).message));
    }
  };

  /** Media is set up but not flowing yet: give up after a while (nothing paid). */
  const awaitConnect = (callId: string) => {
    clearTimeout(ringTimer);
    ringTimer = setTimeout(() => {
      if (view.callId === callId && view.phase === 'connecting') end('failed', tr('caTheCallCouldNotConnect'));
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

  /** Accept the ringing call: one paid answer. */
  const accept = () => guarded(async () => {
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
      end(null, tr('caNothingWasPaid', mediaError(error, view.media)));
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
  });

  return {
    view: () => view,
    /** Move an untouched waiting offer to the normal answer path after media is free. */
    acceptWaiting: async (id: string) => {
      if (active() || busy || deps.busy?.() || view.pendingCount || view.unknownCount || (view.close && view.close.status !== 'closed')) return;
      const offer = waiting.get(id)?.takeIncoming();
      if (!offer) return;
      quote = null;
      wireId = offer.callId;
      admissions.add(offer.callId);
      offerSdp = offer.sdp;
      incomingAt = offer.at;
      set({ ...IDLE, phase: 'incoming', peer: offer.peer, callId: offer.callId, media: offer.media, camera: offer.media === 'video' });
      ringTimer = setTimeout(() => { if (view.callId === offer.callId && view.phase === 'incoming') end('timeout'); }, Math.max(0, RING_MS - (deps.now() - incomingAt)));
      await accept();
    },
    /** Transfer without a hangup or missed record; only a pending offer is movable. */
    takeIncoming: (): IncomingOffer | null => {
      if (view.phase !== 'incoming' || view.silenced || busy || !view.callId || !view.peer || !offerSdp) return null;
      const offer = { callId: view.callId, peer: view.peer, media: view.media, at: incomingAt, sdp: offerSdp };
      teardown();
      set(IDLE);
      return offer;
    },
    declineWaiting: (id: string) => waiting.get(id)?.decline(),
    dismissWaiting: (id: string) => { waiting.get(id)?.dismiss(); },

    /** Place a call. The price was shown before this is called. */
    place: (peer: string, media: CallMedia, q: CallQuote) => guarded(async (claim) => {
      const generation = mediaGeneration;
      if (active() || deps.busy?.()) return;
      if (q.offer_msat === null || q.call_total_msat === null) {
        set({ ...IDLE, phase: 'ended', peer, error: tr('caTheirNodeDoesNotTakeCallsYetNothingWas') });
        return;
      }
      const grant = deps.grant?.();
      if (grant && (q.call_total_msat > grant.per_call_max_msat || q.call_total_msat > grant.remaining_msat)) {
        set({ ...IDLE, phase: 'ended', peer, error:
          tr('caThisCallNeedsUpToYourNodeGrantAllows', amount(q.call_total_msat), amount(grant.per_call_max_msat), amount(grant.remaining_msat), amount(q.call_total_msat)) });
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
      own = [];
      set({ ...IDLE, phase: 'calling', peer, callId, media, outgoing: true, camera: media === 'video' });
      let conn: RTCPeerConnection;
      try {
        conn = await open(media);
        if (cancelled === callId || view.callId !== callId || !active()) return;
        await conn.setLocalDescription(await conn.createOffer());
        await gathered(conn, GATHER_MS);
      } catch (error) {
        if (cancelled === callId || view.callId !== callId || !active()) return;
        end(null, tr('caNothingWasPaid', mediaError(error, view.media)));
        return;
      }
      // Cancelled before the offer went out: nothing is paid.
      if (cancelled === callId || view.callId !== callId || !active()) return;
      // From here the host may hold this admission: every end asks it to close it.
      own.push(callId);
      const r = await pay(CALL_OFFER, { media, sdp: conn.localDescription!.sdp }, q.offer_msat + q.offer_max_routing_fee_msat);
      // Cancelled while the offer was in flight: the mic is already off; the host ends it if it was paid.
      if (cancelled === callId || view.callId !== callId || !active()) return;
      if (!r.ok && r.error.code === 'call_needs_node_upgrade') {
        // Refused before dispatch (proven unpaid): no admission exists, nothing to end at the host.
        own = own.filter((id) => id !== callId);
        end(null, tr('caYourNodeNeedsAnUpdateBeforePaidCallsWork'));
        return;
      }
      if (!r.ok && r.error.code === 'call_admission_open') {
        // Refused before paying: an earlier call to them is still open at the host. Say so; never a silent block.
        own = own.filter((id) => id !== callId);
        end(null, tr('caAnEarlierCallToThemIsStillBeingEnded'));
        set({ stuck: { opId: r.error.operation_id ?? null } });
        return;
      }
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

    accept,

    /** Decline a ringing call: one paid hangup, so the caller stops ringing. */
    decline: () => guarded(async () => {
      if (view.phase !== 'incoming') return;
      set({ silenced: true });
      const owner = { peer: view.peer, callId: view.callId };
      const id = wireId;
      const generation = mediaGeneration;
      const q = await deps.quote(owner.peer!);
      if (mediaGeneration !== generation || view.callId !== owner.callId || view.phase !== 'incoming') return;
      if (q.ok) owe(signalCost(q.value));
      end('declined');
      if (q.ok) {
        try {
          const r = await pay(CALL_HANGUP, { reason: 'declined' }, signalCost(q.value), id, owner, true);
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
      const mine = new Set(deps.endCall ? own : []);
      const owner = { peer: view.peer, callId }; // Keep late cleanup bound to this peer.
      cancelled = callId;
      // Every hangup owed is pending before the call ends, not one by one as each is sent.
      if (notify) ids.filter(id => !mine.has(id)).forEach(() => owe(signalCost(notify)));
      const operationIds = [...(admissionOps.get(callId!) ?? [])];
      end('hangup', null, { record: !notify });
      if (notify) {
        for (const id of ids) {
          if (mine.has(id)) continue;
          try {
            const r = await pay(CALL_HANGUP, { reason: 'hangup' }, signalCost(notify), id, owner, true);
            if (!r.ok && view.callId === callId) set({ error: r.error.message });
          } catch (error) {
            if (view.callId === callId) set({ error: asActionError(error).message });
          }
        }
        // Without op_end_call (pre-H2 deps), record the closure after the paid hangup, as H2 does.
        if (!deps.endCall) for (const [operationId, wireCallId] of operationIds) void closeAdmission(operationId, owner.peer!, wireCallId);
      }
    },

    /** End without paying anything (the window is closing). The peer's side times out. */
    endLocal: () => {
      for (const call of waiting.values()) call.endLocal();
      // Also invalidate a preflight that has not entered Calling yet.
      if (!active()) { teardown(); return; }
      if (view.phase === 'calling') cancelled = view.callId;
      end('hangup', null, { endAtHost: false });
    },

    /** The owner asks again to end an admission the host refused to end. */
    closeAgain: async () => {
      const callId = view.callId;
      const ids = callId ? refusedClose.get(callId) : undefined;
      if (!callId || !ids?.length) return;
      refusedClose.delete(callId);
      ids.forEach((id) => closing.delete(id));
      await closeAdmissions(ids, callId);
    },

    /** `call_admission_open`: the owner ends the earlier call the host still holds. */
    endStuck: async () => {
      const stuck = view.stuck;
      const peer = view.peer;
      const callId = view.callId;
      if (!stuck || !peer || !deps.endCall || !deps.stuckCall || view.phase !== 'ended') return;
      set({ stuck: null, close: { status: 'closing', message: null } });
      let earlier: string | null = null;
      try { earlier = await deps.stuckCall(peer, stuck.opId); } catch { earlier = null; }
      if (view.callId !== callId) return;
      if (!earlier) {
        set({ close: { status: 'refused', message: tr('caCouldnTFindTheEarlierCallToEndCheck') } });
        return;
      }
      closing.delete(earlier);
      await closeAdmissions([earlier], callId);
      if (view.callId === callId && view.close?.status === 'closed') set({ close: { status: 'closed', message: tr('caTheEarlierCallIsEndedYouCanCallThem') } });
    },

    /** iOS visibility only: stop video capture, retain audio and transport.
     * Foregrounding never captures again without the owner's camera action. */
    setBackgrounded: (hidden: boolean) => {
      if (hidden && !backgrounded) videoGeneration++;
      backgrounded = hidden;
      if (hidden) pauseVideo();
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
      if (!stream || !sender || view.media !== 'video' || cameraBusy || backgrounded) return;
      cameraBusy = true;
      const videoRequest = videoGeneration;
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
          if (local !== stream || backgrounded || videoRequest !== videoGeneration) { track?.stop(); return; }
          if (!track) throw new DOMException(tr('caNoCamera'), 'NotFoundError');
          // Own the track before replaceTrack awaits, so hangup can stop it.
          stream.addTrack(track);
          await sender.replaceTrack(track);
          if (local !== stream) return;
          if (backgrounded || videoRequest !== videoGeneration) {
            // A hide/show interval invalidates this action even after return.
            // pauseVideo already stopped/removed its track; detach a late sender.
            await sender.replaceTrack(null);
            return;
          }
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
    /** Closing the ended card waits until nothing is still settling: the tally is never dropped unseen. */
    dismiss: () => { if (view.phase === 'ended' && view.pendingCount === 0) set(IDLE); },

    /** A 400-403 the node forwarded (already paid, and admitted by its call registry). */
    receive: async (m: Message, ownId: string): Promise<void> => {
      if (m.sender.toLowerCase() === ownId.toLowerCase()) return;
      const s = parseSignal(m.kind, m.plaintext);
      if (!s) return;
      const peer = m.sender.toLowerCase();
      const offerKey = `${peer}:${s.call_id}`;
      const queued = waiting.get(offerKey);
      if (queued) { await queued.receive(m, ownId); return; }
      const ours = (pendingRestartId ?? wireId) === s.call_id && view.peer === peer;
      switch (m.kind) {
        case CALL_OFFER:
          if (!s.meeting && view.peer === peer && restartParent(s.sdp!) === view.callId) {
            await answerRestart(s);
            return;
          }
          // A meeting leg belongs to the meeting engine. Ordinary offers always
          // get a visible card, including while another call holds the microphone.
          if (s.meeting || restartParent(s.sdp!) || seenOffers.has(offerKey)) return;
          seenOffers.add(offerKey);
          if (active() || deps.busy?.()) {
            const child = createCallEngine({ ...deps, busy: () => false, onWaiting: undefined,
              onView: publishWaiting, onStreams: () => {}, audioSession: undefined });
            waiting.set(offerKey, child);
            await child.receive(m, ownId);
            return;
          }
          incomingAt = deps.now();
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
            // Not a connectivity failure (no relay would help): no 'failed' reason, only the words.
            if (pc === conn) end(null, tr('caTheirAnswerCouldNotBeUsed'));
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
          if (view.peer === peer && (admissions.has(s.call_id) || pendingRestartId === s.call_id) && active()) {
            // Incoming calls have no outgoing admission. For our offers, only
            // the host's exact binding can end this generation of the card.
            if (view.outgoing) {
              if (!m.admission_operation_id) return;
              if (admissionOps.get(view.callId!)?.get(m.admission_operation_id) !== s.call_id) {
                // The host can finish dispatch before the renderer gets its
                // receipt. Apply this event only when that exact id arrives.
                pendingPeerEnds.set(m.admission_operation_id, { callId: s.call_id, reason: s.reason ?? 'hangup' });
                return;
              }
            }
            end(s.reason ?? 'hangup', null, peerEnd(s.call_id));
          }
      }
    },
  };
}
