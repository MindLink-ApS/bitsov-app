/**
 * The renderer's view of the node-routed media socket (M6 A1). The Rust
 * host owns the socket, exactly like `/ws`: it connects over loopback (or
 * the loopback proxy of the paired remote-access tunnel), presents the
 * token, assigns `seq`, and bridges binary frames through one Tauri channel.
 * The renderer opens no network socket of its own (Gate G2; the CSP has no
 * network connect-src).
 *
 * Downlink: the channel carries raw frames (seq + payload) as binary and
 * link transitions as JSON objects (`{ link, detail }`; Tauri hands a JSON
 * channel payload to the page already parsed). Uplink: one `call_media_send`
 * per payload, raw bytes, no JSON.
 */
import { Channel, invoke } from '@tauri-apps/api/core';

export type MediaLinkState = 'connecting' | 'open' | 'closed' | 'ended' | 'sealed' | 'sealed_words';
/** What the node allows per direction, per second. Only on the `open` of a video session. */
export type MediaNodeLimits = { messages: number; bytes: number };
export type MediaLink = { link: MediaLinkState; detail: string | null; limits?: MediaNodeLimits; words?: string[] };

export type MediaBridge = {
  /**
   * Open the host socket for `callId` with `peer`, the call's counterparty (the node admits only that pair).
   * `sealed`: this call's key exchange is done (sealing builds). `video`: open the video path too (video builds).
   * Never both: video is never sealed.
   */
  open: (callId: string, peer: string, onFrame: (frame: Uint8Array) => void, onLink: (link: MediaLink) => void, sealed?: boolean, video?: boolean) => Promise<void>;
  send: (payload: Uint8Array) => void;
  /** One video payload; resolves to how many fragments wait in the host. Only on a socket opened with `video`. */
  sendVideo?: (payload: Uint8Array) => Promise<number>;
  close: () => Promise<void>;
};

type ChannelMessage = ArrayBuffer | Uint8Array | number[] | string | { link?: unknown; detail?: unknown; limits?: unknown; words?: unknown };

const LINK_STATES: readonly string[] = ['connecting', 'open', 'closed', 'ended', 'sealed', 'sealed_words'];

/** A link transition as the host sends it: a parsed object, or JSON text from an older host. */
export function parseLinkMessage(message: unknown): MediaLink | null {
  let value: unknown = message;
  if (typeof message === 'string') {
    try { value = JSON.parse(message); } catch { return null; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { link, detail, limits, words } = value as { link?: unknown; detail?: unknown; limits?: { messages?: unknown; bytes?: unknown }; words?: unknown };
  if (typeof link !== 'string' || !LINK_STATES.includes(link)) return null;
  if (link === 'sealed_words') {
    if (!Array.isArray(words) || words.length !== 4 || !words.every(word => typeof word === 'string' && word.length > 0)) return null;
    return { link, detail: null, words };
  }
  const parsed: MediaLink = { link: link as MediaLinkState, detail: typeof detail === 'string' ? detail : null };
  if (limits && typeof limits.messages === 'number' && typeof limits.bytes === 'number') parsed.limits = { messages: limits.messages, bytes: limits.bytes };
  return parsed;
}

/** A binary channel message: an ArrayBuffer on desktop, a byte array on some mobile IPC paths. */
export const isFrameMessage = (message: unknown): message is ArrayBuffer | Uint8Array | number[] =>
  message instanceof ArrayBuffer || message instanceof Uint8Array || Array.isArray(message);

export function frameBytes(message: ArrayBuffer | Uint8Array | number[]): Uint8Array {
  if (message instanceof Uint8Array) return message;
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  return Uint8Array.from(message);
}

/** The host-owned socket, through Tauri commands. */
export function hostMediaBridge(): MediaBridge {
  let current: Channel<ChannelMessage> | null = null;
  return {
    open: async (callId, peer, onFrame, onLink, sealed, video) => {
      const channel = new Channel<ChannelMessage>();
      channel.onmessage = (message) => {
        if (current !== channel) return;
        if (isFrameMessage(message)) { onFrame(frameBytes(message)); return; }
        const link = parseLinkMessage(message);
        if (link) onLink(link);
      };
      current = channel;
      // Without `sealed` and `video` this is the same three arguments as a build without either.
      const args: Record<string, unknown> = { call_id: callId, peer, on_frame: channel };
      if (sealed) args.sealed = true;
      if (video) args.video = true;
      await invoke<void>('call_media_open', args);
    },
    send: (payload) => {
      if (!current) return;
      void invoke<void>('call_media_send', payload).catch(() => undefined);
    },
    sendVideo: (payload) => (current ? invoke<number>('call_media_video_send', payload).catch(() => 0) : Promise.resolve(0)),
    close: async () => {
      if (!current) return;
      current = null;
      await invoke<void>('call_media_close').catch(() => undefined);
    },
  };
}

/**
 * The call's key exchange, which lives in the host: the renderer only carries
 * the attributes, which hold public values. Keys never reach this side.
 */
export type CallSeal = {
  /** Caller: the attribute line for the offer. */
  offer: (callId: string, peer: string) => Promise<string>;
  /** Callee: the attribute line for the answer, or null when the offer says it cannot seal. */
  answer: (callId: string, peer: string, offer: string) => Promise<string | null>;
  /** Caller: true when the call is sealed, false when the answer says it cannot seal. */
  accept: (callId: string, answer: string) => Promise<boolean>;
  /** Drop whatever the host holds for this call's exchange. */
  cancel: (callId: string) => Promise<void>;
};

export function hostCallSeal(): CallSeal {
  return {
    offer: (callId, peer) => invoke<string>('call_seal_offer', { call_id: callId, peer }),
    answer: (callId, peer, offer) => invoke<string | null>('call_seal_answer', { call_id: callId, peer, offer }),
    accept: (callId, answer) => invoke<boolean>('call_seal_accept', { call_id: callId, answer }),
    cancel: (callId) => invoke<void>('call_seal_cancel', { call_id: callId }).catch(() => undefined),
  };
}

/** No host (browser dev mode, sample data): the link ends at once, so the call does. */
export function unavailableMediaBridge(): MediaBridge {
  return {
    open: async (_callId, _peer, _onFrame, onLink) => { onLink({ link: 'ended', detail: 'no_host_media_bridge' }); },
    send: () => {},
    close: async () => {},
  };
}
