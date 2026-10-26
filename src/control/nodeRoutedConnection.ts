/**
 * Node-routed media as the call engine sees it (M6 A1).
 *
 * `call.ts` drives one `RTCPeerConnection`-shaped object per call: it adds
 * the microphone tracks, asks for an offer or answer, applies the peer's
 * description, and watches `connectionState`. This adapter answers that same
 * surface without WebRTC: the "SDP" is a placeholder carrying a marker, and
 * once both descriptions are in place it opens the host-owned media socket
 * for the call id and streams audio through `callAudio.ts`. Signalling
 * (kinds 400-403, paid through the node) is untouched.
 *
 * Nothing here contacts a STUN or TURN server, gathers candidates, or opens
 * a direct path to the peer app: the connection state follows the node link.
 */
import type { CallAudio, MediaTransport } from './callAudio';
import type { MediaBridge, MediaLink } from './mediaBridge';

export const NODE_ROUTED_MARKER = 'a=x-bitsov-media:node-routed-v1';
const CALL_ATTRIBUTE = 'a=x-bitsov-call:';
/** A closed node link may come back (the host reconnects); after this long the call ends. */
export const LINK_GRACE_MS = 30_000;

/** The placeholder description that tells an M6 app "meet me at the node". */
export function nodeRoutedSdp(type: 'offer' | 'answer', callId: string | null): string {
  return [
    'v=0',
    'o=bitsov 0 0 IN IP4 0.0.0.0',
    's=bitsov-node-routed-audio',
    't=0 0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 0',
    'c=IN IP4 0.0.0.0',
    NODE_ROUTED_MARKER,
    `${CALL_ATTRIBUTE}${callId ?? ''}`,
    `a=${type === 'offer' ? 'sendrecv' : 'sendrecv'}`,
  ].join('\r\n') + '\r\n';
}

export const isNodeRoutedSdp = (sdp: string | null | undefined) =>
  typeof sdp === 'string' && sdp.split(/\r?\n/).includes(NODE_ROUTED_MARKER);

export type MediaSessionEvent = { callId: string; state: 'open' | 'closed'; at: number };

export type NodeRoutedDeps = {
  /** The wire call id of the call this connection serves (set by the engine before it opens media). */
  callId: () => string | null;
  bridge: MediaBridge;
  audio: (stream: MediaStream, transport: MediaTransport) => CallAudio;
  /**
   * A2 hook (payment slice): the node media session for `callId` opened or
   * closed. Per-call or per-minute node payment attaches here; nothing is
   * paid by this slice.
   */
  onSession?: (event: MediaSessionEvent) => void;
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

  private stream: MediaStream | null = null;
  private audio: CallAudio | null = null;
  private opened = false;
  private closed = false;
  private wasOpen = false;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;

  constructor(private readonly deps: NodeRoutedDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** The engine's mic stream; the sender stub keeps its camera code harmless. */
  addTrack(track: MediaStreamTrack, stream?: MediaStream): RTCRtpSender {
    this.stream = stream ?? this.stream;
    return { track, replaceTrack: async () => undefined } as unknown as RTCRtpSender;
  }

  async createOffer(_options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: nodeRoutedSdp('offer', this.deps.callId()) };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: nodeRoutedSdp('answer', this.deps.callId()) };
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
    this.remoteDescription = description;
    this.maybeOpen();
  }

  async addIceCandidate(_candidate: RTCIceCandidateInit): Promise<void> {}
  restartIce(): void {}
  async getStats(): Promise<RTCStatsReport> { return new Map() as unknown as RTCStatsReport; }
  addEventListener(): void {}
  removeEventListener(): void {}

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.graceTimer);
    this.graceTimer = undefined;
    const audio = this.audio;
    this.audio = null;
    void audio?.close();
    if (this.opened) {
      void this.deps.bridge.close();
      const callId = this.deps.callId();
      if (this.wasOpen && callId) this.deps.onSession?.({ callId, state: 'closed', at: this.now() });
    }
    this.connectionState = 'closed';
    this.iceConnectionState = 'closed';
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
    if (!callId) { this.setState('failed'); return; }
    this.setState('connecting');
    const audio = this.deps.audio(this.stream ?? emptyStream(), { send: (payload) => this.deps.bridge.send(payload) });
    this.audio = audio;
    this.deps.bridge.open(callId, (frame) => { if (this.audio === audio) audio.feed(frame); }, (link) => this.onLink(link))
      .catch(() => this.onLink({ link: 'ended', detail: 'media_link_refused' }));
  }

  private onLink(link: MediaLink) {
    if (this.closed) return;
    switch (link.link) {
      case 'open': {
        clearTimeout(this.graceTimer);
        this.graceTimer = undefined;
        if (!this.wasOpen) {
          this.wasOpen = true;
          const callId = this.deps.callId();
          if (callId) this.deps.onSession?.({ callId, state: 'open', at: this.now() });
          // No `ontrack`: playout renders straight into the audio context, so
          // the engine keeps no remote stream and its media element stays idle.
        }
        this.setState('connected');
        break;
      }
      case 'closed':
        // The host reconnects on its own; the call stays live meanwhile.
        if (this.wasOpen && this.graceTimer === undefined) {
          this.graceTimer = setTimeout(() => { this.graceTimer = undefined; this.setState('closed'); }, this.deps.linkGraceMs ?? LINK_GRACE_MS);
        }
        break;
      case 'ended':
        // The node refused or dropped the media session for good.
        this.setState('closed');
        break;
      case 'connecting':
        break;
    }
  }
}

export function createNodeRoutedConnection(deps: NodeRoutedDeps): RTCPeerConnection {
  return new NodeRoutedConnection(deps) as unknown as RTCPeerConnection;
}
