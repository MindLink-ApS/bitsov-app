/**
 * Node-routed media as the call engine sees it (M6 A1).
 *
 * `call.ts` drives one `RTCPeerConnection`-shaped object per call: it adds
 * the microphone tracks, asks for an offer or answer, applies the peer's
 * description, and watches `connectionState`. This adapter answers that same
 * surface without WebRTC: the "SDP" is a placeholder carrying a marker, and
 * once both descriptions are in place it opens the host-owned media socket
 * for the call id and its counterparty and streams audio through
 * `callAudio.ts`. The call reports `connected` only once the node link is
 * open AND the audio graph is ready; an audio graph that cannot be built,
 * or a fatal audio error later in the call, closes the link and ends the
 * call. Signalling (kinds 400-403, paid through
 * the node) is untouched. M6 A2: the node admits the media socket only once
 * the call's first minute (block 0) is paid, so with `admitted` set the
 * socket opens only after the node reports that; a call never paid in time
 * ends with `endDetail` `not_paid`.
 *
 * Nothing here contacts a STUN or TURN server, gathers candidates, or opens
 * a direct path to the peer app: the connection state follows the node link.
 */
import type { CallAudio, CallAudioDiagnostics, MediaTransport } from './callAudio';
import type { CallVideo, VideoTransport } from './callVideo';
import type { CallSeal, MediaBridge, MediaLink } from './mediaBridge';
import { isVideoFrame } from './videoFrame';

export const NODE_ROUTED_MARKER = 'a=x-bitsov-media:node-routed-v1';
const CALL_ATTRIBUTE = 'a=x-bitsov-call:';
/** The key exchange's attribute. The host reads it; only public values ride here. */
const SEAL_ATTRIBUTE = 'a=x-bitsov-e2e:';
/** A closed node link may come back (the host reconnects); after this long the call ends. */
export const LINK_GRACE_MS = 30_000;
/** A node link down this long (frozen or lost media) is said as Reconnecting on the card. Display only. */
export const MEDIA_FROZEN_MS = 3_000;
/** How often an open link is checked for frames still arriving. */
const FRAME_WATCH_MS = 500;

/** The placeholder description that tells an M6 app "meet me at the node". */
export function nodeRoutedSdp(type: 'offer' | 'answer', callId: string | null, sealAttribute?: string | null): string {
  return [
    'v=0',
    'o=bitsov 0 0 IN IP4 0.0.0.0',
    's=bitsov-node-routed-audio',
    't=0 0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 0',
    'c=IN IP4 0.0.0.0',
    NODE_ROUTED_MARKER,
    ...(sealAttribute ? [sealAttribute] : []),
    `${CALL_ATTRIBUTE}${callId ?? ''}`,
    `a=${type === 'offer' ? 'sendrecv' : 'sendrecv'}`,
  ].join('\r\n') + '\r\n';
}

export const isNodeRoutedSdp = (sdp: string | null | undefined) =>
  typeof sdp === 'string' && sdp.split(/\r?\n/).includes(NODE_ROUTED_MARKER);

/** `refused`: the node refused the media socket for good (401 or 403), as opposed to a drop or an audio failure. */
export type MediaSessionEvent = { callId: string; state: 'open' | 'closed'; at: number; refused?: boolean };
/** How the host words a node's refusal of the media socket for this pairing's authority. */
const AUTH_REFUSED = /refused the media socket \((401|403)\)/;

/**
 * What the call label may say, on a build with sealing on.
 * `setting_up`: a key exchange is under way and nothing goes out in the clear.
 * `sealed`: a frame from the far side authenticated under this call's keys.
 * That says nothing about who is on the far side.
 * `not_sealed`: the other app said it cannot seal, so both nodes can hear it.
 */
export type SealState = 'setting_up' | 'sealed' | 'not_sealed';

/** The refusal `call.ts` shows when a key exchange is present and wrong. */
export const SEAL_REFUSED = 'CallSealRefused';
/** This side offered sealing and the answer did not agree: the call ends, nothing goes out unsealed. */
export const SEAL_NOT_AGREED = 'CallSealNotAgreed';
/** A host seal failure ends the link with a detail that starts like this. */
const SEAL_DETAIL = /^seal_/;
export const SEAL_ENDED = 'seal_ended';

/** The attribute lines of a description. More than one is invalid. */
function sealLines(sdp: string | null | undefined): string[] {
  return typeof sdp === 'string' ? sdp.split(/\r?\n/).filter((line) => line.startsWith(SEAL_ATTRIBUTE)) : [];
}

const sealRefused = () => Object.assign(new Error(), { name: SEAL_REFUSED });
const sealNotAgreed = () => Object.assign(new Error(), { name: SEAL_NOT_AGREED });

/**
 * One label for the screen, many connections over time: each connection gets
 * its own setter, and only the newest one may still change the label. A
 * replaced call's late answer from the host is ignored.
 */
export function sealLabelScope(set: (state: SealState | null, words?: string[]) => void) {
  let generation = 0;
  return () => {
    const mine = ++generation;
    set(null);
    return (state: SealState, words?: string[]) => { if (mine === generation) set(state, words); };
  };
}

export type NodeRoutedDeps = {
  /** The wire call id of the call this connection serves (set by the engine before it opens media). */
  callId: () => string | null;
  /** The call's counterparty (64-hex node id); the node admits the socket only for this pair. */
  peer: () => string | null;
  bridge: MediaBridge;
  /** Builds the audio engine; it calls `onFatal` when it can no longer carry audio. */
  audio: (stream: MediaStream, transport: MediaTransport, onFatal: () => void) => CallAudio;
  /**
   * A video call also opens the video path on the same socket (flag
   * `VITE_CALL_VIDEO`). Absent, or `null` from `build` on an audio call, and
   * the call is an audio call in every byte. Nothing video does can end a call.
   */
  video?: { build: (transport: VideoTransport, track: MediaStreamTrack | null) => CallVideo | null; camera: (engine: CallVideo, track: MediaStreamTrack | null) => void };
  /**
   * The node media session for `callId` opened, or closed for good (fatal
   * audio, the node ended the link, the reconnect grace ran out, or the call
   * closed), once each. Paying does not start on `open`: the node admits the
   * session only after the first minute is paid, so paying starts at the
   * answer. On `closed` the shell ends the call, which stops its minutes.
   */
  onSession?: (event: MediaSessionEvent) => void;
  /**
   * M6 A2: resolves true once the node reports the call live and its first
   * minute paid (the socket would be refused before that), false if the call
   * ended or the window ran out. `closed` tells the wait to stop early.
   */
  admitted?: (callId: string, peer: string, closed: () => boolean) => Promise<boolean>;
  /** Present only on a build with sealing on. Without it nothing here differs from a build without the code. */
  seal?: CallSeal;
  /** The label's input. Called only when `seal` is present. */
  onSeal?: (state: SealState, words?: string[]) => void;
  now?: () => number;
  linkGraceMs?: number;
};

type Description = { type: string; sdp?: string };

/** A stream with no tracks, for an engine that never added one. */
function emptyStream(): MediaStream {
  try {
    const stream = new MediaStream();
    if (typeof stream.getTracks === 'function') return stream;
  } catch { /* No MediaStream in this environment. */ }
  return { getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] } as unknown as MediaStream;
}
type Handler = (() => void) | null;

/** The subset of RTCPeerConnection that `call.ts` uses, backed by the node link. */
export class NodeRoutedConnection {
  readonly routed = true as const;
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  readonly iceGatheringState: RTCIceGatheringState = 'complete';
  readonly signalingState: RTCSignalingState = 'stable';
  localDescription: Description | null = null;
  remoteDescription: Description | null = null;
  ontrack: ((event: { streams: MediaStream[]; track: MediaStreamTrack | null }) => void) | null = null;
  onconnectionstatechange: Handler = null;
  oniceconnectionstatechange: Handler = null;
  onicecandidate: Handler = null;
  /** Why the node link ended for good, when the engine needs to say so (`not_paid`). */
  endDetail: string | null = null;
  /**
   * Display only: the open link has been down for `MEDIA_FROZEN_MS` (`endsAt`: when its grace ends the call),
   * or it came back (`null`). Nothing here restarts, signals or pays.
   */
  oninterruption: ((endsAt: number | null) => void) | null = null;

  private stream: MediaStream | null = null;
  private audio: CallAudio | null = null;
  private video: CallVideo | null = null;
  private videoTrack: MediaStreamTrack | null = null;
  private opened = false;
  private closed = false;
  private wasOpen = false;
  /** `onSession` closed was emitted for this session (exactly once). */
  private sessionEnded = false;
  /** The node refused the media socket (401/403) when the link ended. */
  private refused = false;
  /** The node link is up (the host said `open`); `connected` also needs `audioReady`. */
  private linkOpen = false;
  private audioReady = false;
  /** The owner's own mute, kept for an audio engine built later. */
  private muted = false;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  private frozenTimer: ReturnType<typeof setTimeout> | undefined;
  private interrupted = false;
  /** When the last media frame arrived; null until the first one (a call that never had media is not "frozen"). */
  private lastFrameAt: number | null = null;
  /** Checks, while the link is open, that frames keep arriving. */
  private frameWatch: ReturnType<typeof setInterval> | undefined;
  /** The current stall comes from frames stopping on an open link (not from the link closing). */
  private frameStall = false;
  private readonly now: () => number;
  /** This connection made its offer or answer. Never a second: a seal does not restart. */
  private sealOffered = false;
  /** This connection has a key exchange, and its media socket must be sealed. */
  private sealing = false;
  private sealAuthenticated = false;
  /** The call id the host's key exchange is held under. */
  private sealCallId: string | null = null;

  constructor(private readonly deps: NodeRoutedDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** The engine's mic stream; the sender stub keeps its camera code harmless. */
  addTrack(track: MediaStreamTrack, stream?: MediaStream): RTCRtpSender {
    this.stream = stream ?? this.stream;
    if (track.kind === 'video' && this.deps.video) {
      this.videoTrack = track;
      // Camera off and on come back through the engine's sender; the video engine follows.
      return { track, replaceTrack: async (next: MediaStreamTrack | null) => this.setVideoTrack(next) } as unknown as RTCRtpSender;
    }
    return { track, replaceTrack: async () => undefined } as unknown as RTCRtpSender;
  }

  private setVideoTrack(track: MediaStreamTrack | null) {
    this.videoTrack = track;
    if (this.video) this.deps.video?.camera(this.video, track);
  }

  async createOffer(_options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    const seal = this.deps.seal;
    if (!seal) return { type: 'offer', sdp: nodeRoutedSdp('offer', this.deps.callId()) };
    const callId = this.deps.callId();
    const peer = this.deps.peer();
    if (!callId || !peer || this.sealOffered) throw sealRefused();
    this.sealOffered = true;
    this.sealCallId = callId;
    const attribute = await seal.offer(callId, peer).catch(() => { throw sealRefused(); });
    // Closed while the host worked: this call is over, so nothing of it may change any label.
    if (this.closed) { void seal.cancel(callId); throw sealRefused(); }
    this.sealing = true;
    this.deps.onSeal?.('setting_up');
    return { type: 'offer', sdp: nodeRoutedSdp('offer', callId, attribute) };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    const seal = this.deps.seal;
    if (!seal) return { type: 'answer', sdp: nodeRoutedSdp('answer', this.deps.callId()) };
    const callId = this.deps.callId();
    const peer = this.deps.peer();
    const lines = sealLines(this.remoteDescription?.sdp);
    // One exchange per connection: a repeated or different offer never replaces it.
    if (lines.length > 1 || !callId || !peer || this.sealOffered) throw sealRefused();
    this.sealOffered = true;
    if (lines.length === 0) {
      this.deps.onSeal?.('not_sealed');
      return { type: 'answer', sdp: nodeRoutedSdp('answer', callId) };
    }
    this.sealCallId = callId;
    const attribute = await seal.answer(callId, peer, lines[0]).catch(() => { throw sealRefused(); });
    if (this.closed) { void seal.cancel(callId); throw sealRefused(); }
    if (attribute === null) {
      this.deps.onSeal?.('not_sealed');
      return { type: 'answer', sdp: nodeRoutedSdp('answer', callId) };
    }
    this.sealing = true;
    this.deps.onSeal?.('setting_up');
    return { type: 'answer', sdp: nodeRoutedSdp('answer', callId, attribute) };
  }

  async setLocalDescription(description: Description): Promise<void> {
    this.localDescription = description;
    this.maybeOpen();
  }

  /**
   * An offer from any app is accepted (ours answers node-routed; a pre-M6
   * caller then fails on its side). An answer must be node-routed: a direct
   * media answer is refused, which ends the call as "their answer could not
   * be used" with nothing more paid.
   */
  async setRemoteDescription(description: Description): Promise<void> {
    if (description.type === 'answer' && !isNodeRoutedSdp(description.sdp)) {
      // Never shown: the engine says "their answer could not be used" in the owner's language.
      throw Object.assign(new Error(), { name: 'PeerMediaNotNodeRouted' });
    }
    if (description.type === 'answer' && this.deps.seal && this.sealing) await this.acceptAnswer(description);
    this.remoteDescription = description;
    this.maybeOpen();
  }

  /**
   * The caller reads the answer. This side offered sealing, so an answer that
   * does not agree (no attribute, or no capability) ends the call like a wrong
   * one: nothing is sent unsealed, and no side is named as the cause.
   */
  private async acceptAnswer(description: Description) {
    const seal = this.deps.seal!;
    const callId = this.deps.callId();
    const lines = sealLines(description.sdp);
    if (lines.length > 1 || !callId) throw sealRefused();
    if (lines.length === 0) {
      void seal.cancel(callId);
      throw sealNotAgreed();
    }
    const sealed = await seal.accept(callId, lines[0]).catch(() => { throw sealRefused(); });
    if (this.closed) { void seal.cancel(callId); throw sealRefused(); }
    if (!sealed) {
      void seal.cancel(callId);
      throw sealNotAgreed();
    }
  }

  /**
   * The owner muted or unmuted the microphone (the engine also disables the
   * track). The audio engine sends silence while muted and does not count
   * it as a silenced microphone; unmuting starts a fresh observation.
   */
  setMuted(muted: boolean): void {
    this.muted = muted;
    this.audio?.setMuted(muted);
  }

  async addIceCandidate(_candidate: RTCIceCandidateInit): Promise<void> {}
  restartIce(): void {}
  async getStats(): Promise<RTCStatsReport> { return new Map() as unknown as RTCStatsReport; }
  /** For the call report: which codecs carried this call's audio, and the context rate. Null without an engine. */
  audioDiagnostics(): CallAudioDiagnostics | null { return this.audio?.diagnostics?.() ?? null; }
  addEventListener(): void {}
  removeEventListener(): void {}

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopWatching();
    const audio = this.audio;
    this.audio = null;
    void audio?.close();
    this.closeVideo();
    if (this.opened) {
      void this.deps.bridge.close();
      this.endSession();
    }
    if (this.deps.seal && this.sealCallId) void this.deps.seal.cancel(this.sealCallId);
    this.connectionState = 'closed';
    this.iceConnectionState = 'closed';
  }

  private closeVideo() {
    const video = this.video;
    this.video = null;
    video?.close();
  }

  private setState(state: RTCPeerConnectionState) {
    if (this.closed || this.connectionState === state) return;
    this.connectionState = state;
    this.iceConnectionState = state === 'connecting' ? 'checking' : state === 'connected' ? 'connected' : state === 'failed' ? 'failed' : state === 'closed' ? 'closed' : 'new';
    this.onconnectionstatechange?.();
    this.oniceconnectionstatechange?.();
  }

  private maybeOpen() {
    if (this.opened || this.closed || !this.localDescription || !this.remoteDescription) return;
    this.opened = true;
    const callId = this.deps.callId();
    const peer = this.deps.peer();
    if (!callId || !peer) { this.setState('failed'); return; }
    this.setState('connecting');
    let audio: CallAudio | null = null;
    // A fatal audio error mid-call (a codec that cannot recover, a crashed worklet) ends the call like a failed start.
    const onFatal = () => { if (audio && this.audio === audio) this.audioFailed(); };
    audio = this.deps.audio(this.stream ?? emptyStream(), { send: (payload) => this.deps.bridge.send(payload) }, onFatal);
    this.audio = audio;
    if (this.muted) audio.setMuted(true);
    audio.ready.then(
      () => { if (this.audio === audio && !this.closed) { this.audioReady = true; this.maybeConnected(); } },
      // No audio graph (no AudioContext, worklet refused): a silent "live" call is worse than an ended one.
      () => { if (this.audio === audio) this.audioFailed(); },
    );
    const sendVideo = this.deps.bridge.sendVideo;
    // Video is never sealed: a connection with a key exchange carries none.
    const video = this.deps.video && sendVideo && !this.sealing ? this.deps.video.build({ send: (payload) => sendVideo(payload) }, this.videoTrack) : null;
    this.video = video;
    const onFrame = (frame: Uint8Array) => {
      this.frameArrived();
      if (video && isVideoFrame(frame)) {
        if (this.video === video) video.feed(frame);
        return;
      }
      if (audio && this.audio === audio) audio.feed(frame);
    };
    const onLink = (link: MediaLink) => this.onLink(link);
    // Without video this is exactly the audio call's open, sealed or not.
    const open = () => (video
      ? this.deps.bridge.open(callId, peer, onFrame, onLink, undefined, true)
      : this.deps.bridge.open(callId, peer, onFrame, onLink, this.sealing || undefined))
      .catch(() => this.onLink({ link: 'ended', detail: 'media_link_refused' }));
    const admitted = this.deps.admitted;
    if (!admitted) { void open(); return; }
    // Opening before the first minute is paid would be refused and end the call.
    admitted(callId, peer, () => this.closed || this.audio !== audio).then((paid) => {
      if (this.closed || this.audio !== audio) return;
      if (paid) { void open(); return; }
      this.endDetail = 'not_paid';
      this.audioFailed();
    }, () => {
      if (this.closed || this.audio !== audio) return;
      this.endDetail = 'not_paid';
      this.audioFailed();
    });
  }

  /** Live only with both halves: the node link open and the audio graph ready. */
  private maybeConnected() {
    if (!this.linkOpen || !this.audioReady || this.closed) return;
    if (!this.wasOpen) {
      this.wasOpen = true;
      const callId = this.deps.callId();
      if (callId) this.deps.onSession?.({ callId, state: 'open', at: this.now() });
      // No `ontrack`: playout renders straight into the audio context, so
      // the engine keeps no remote stream and its media element stays idle.
    }
    this.setState('connected');
  }

  /**
   * The media session that was open is over for good: tell the shell once,
   * so the call's paid minutes stop (A2) even if the engine never acts on the
   * `closed` state. Nothing if it never opened.
   */
  private endSession() {
    if (!this.wasOpen || this.sessionEnded) return;
    this.sessionEnded = true;
    const callId = this.deps.callId();
    if (callId) this.deps.onSession?.({ callId, state: 'closed', at: this.now(), ...(this.refused ? { refused: true } : {}) });
  }

  /** The audio engine could not start, or broke mid-call: release it, close the socket, end the call. */
  private audioFailed() {
    if (this.closed) return;
    const audio = this.audio;
    this.audio = null;
    // No way back to `connected`: a late or reconnected link finds no audio.
    this.audioReady = false;
    this.linkOpen = false;
    this.stopWatching();
    void audio?.close();
    this.closeVideo();
    void this.deps.bridge.close();
    this.setState('closed');
    this.endSession();
  }

  /** The call is over here: no stall deadline, no frame watch. */
  private stopWatching() {
    this.clearStall(false);
    clearInterval(this.frameWatch);
    this.frameWatch = undefined;
  }

  /**
   * Media stopped at `since` (the link closed, or frames stopped on an open link): the call ends after the link's
   * grace unless media comes back, and past `MEDIA_FROZEN_MS` the card says Reconnecting. Nothing is restarted,
   * signalled or paid for it.
   */
  private startStall(since: number) {
    if (this.graceTimer !== undefined || this.closed) return;
    const grace = this.deps.linkGraceMs ?? LINK_GRACE_MS;
    const endsAt = since + grace;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = undefined;
      clearTimeout(this.frozenTimer);
      this.frozenTimer = undefined;
      clearInterval(this.frameWatch);
      this.frameWatch = undefined;
      this.setState('closed');
      this.endSession();
    }, Math.max(0, endsAt - this.now()));
    this.frozenTimer = setTimeout(() => {
      this.frozenTimer = undefined;
      if (this.closed || this.connectionState === 'closed' || this.graceTimer === undefined) return;
      this.interrupted = true;
      this.oninterruption?.(endsAt);
    }, Math.max(0, Math.min(since + MEDIA_FROZEN_MS, endsAt) - this.now()));
  }

  /** Media is back: no deadline, and the card is told once if it said Reconnecting. */
  private clearStall(say: boolean) {
    clearTimeout(this.graceTimer);
    this.graceTimer = undefined;
    clearTimeout(this.frozenTimer);
    this.frozenTimer = undefined;
    this.frameStall = false;
    if (this.interrupted) { this.interrupted = false; if (say) this.oninterruption?.(null); }
  }

  /** A frame arrived: media advances. The first one starts the open-link watch. */
  private frameArrived() {
    if (this.closed) return;
    this.lastFrameAt = this.now();
    if (this.frameStall) this.clearStall(true);
    if (this.frameWatch === undefined) {
      this.frameWatch = setInterval(() => {
        if (this.closed || this.connectionState === 'closed') { clearInterval(this.frameWatch); this.frameWatch = undefined; return; }
        // Only an open link that stopped carrying frames; a closed link has its own stall.
        if (!this.linkOpen || this.frameStall || this.graceTimer !== undefined || this.lastFrameAt === null) return;
        if (this.now() - this.lastFrameAt < MEDIA_FROZEN_MS) return;
        this.frameStall = true;
        this.startStall(this.lastFrameAt);
      }, FRAME_WATCH_MS);
    }
  }

  private onLink(link: MediaLink) {
    if (this.closed) return;
    switch (link.link) {
      case 'open': {
        // A reopened socket is not media: once frames have flowed, only a frame arriving again clears the stall,
        // and its deadline (counted from the last frame) stands meanwhile. Before any frame, the link is all there is.
        if (this.lastFrameAt === null) this.clearStall(true);
        else if (this.graceTimer !== undefined) this.frameStall = true;
        this.linkOpen = true;
        if (link.limits) this.video?.setNodeLimits(link.limits);
        this.maybeConnected();
        break;
      }
      case 'closed':
        this.linkOpen = false;
        this.video?.linkReset();
        // The host reconnects on its own; the call stays live meanwhile.
        if (this.wasOpen) {
          // A stall already running keeps its deadline; otherwise media stopped at the last frame (or now, if none came).
          this.frameStall = false;
          this.startStall(this.lastFrameAt ?? this.now());
        }
        break;
      case 'sealed':
        this.sealAuthenticated = true;
        this.deps.onSeal?.('sealed');
        break;
      case 'sealed_words':
        if (this.sealing && this.sealAuthenticated && this.connectionState !== 'closed') this.deps.onSeal?.('sealed', link.words);
        break;
      case 'ended':
        // The call could not stay sealed: say so. It does not go on in the clear.
        if (link.detail && SEAL_DETAIL.test(link.detail)) this.endDetail = SEAL_ENDED;
        if (link.detail && AUTH_REFUSED.test(link.detail)) this.refused = true;
        // The node refused or dropped the media session for good. A refusal
        // reaches the shell first, with its reason, before the generic close.
        this.stopWatching();
        if (this.refused) this.endSession();
        this.setState('closed');
        this.endSession();
        break;
      case 'connecting':
        break;
    }
  }
}

export function createNodeRoutedConnection(deps: NodeRoutedDeps): RTCPeerConnection {
  return new NodeRoutedConnection(deps) as unknown as RTCPeerConnection;
}
