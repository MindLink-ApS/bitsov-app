/**
 * The renderer's view of the node-routed media socket (M6 A1). The Rust
 * host owns the socket, exactly like `/ws`: it connects over loopback (or
 * the loopback proxy of the paired remote-access tunnel), presents the
 * token, assigns `seq`, and bridges binary frames through one Tauri channel.
 * The renderer opens no network socket of its own (Gate G2; the CSP has no
 * network connect-src).
 *
 * Downlink: the channel carries raw frames (seq + payload) as binary and
 * link transitions as JSON text. Uplink: one `call_media_send` per payload,
 * raw bytes, no JSON.
 */
import { Channel, invoke } from '@tauri-apps/api/core';

export type MediaLinkState = 'connecting' | 'open' | 'closed' | 'ended';
export type MediaLink = { link: MediaLinkState; detail: string | null };

export type MediaBridge = {
  open: (callId: string, onFrame: (frame: Uint8Array) => void, onLink: (link: MediaLink) => void) => Promise<void>;
  send: (payload: Uint8Array) => void;
  close: () => Promise<void>;
};

type ChannelMessage = ArrayBuffer | Uint8Array | number[] | string;

export function parseLinkMessage(text: string): MediaLink | null {
  try {
    const value = JSON.parse(text) as { link?: unknown; detail?: unknown };
    if (!['connecting', 'open', 'closed', 'ended'].includes(value.link as string)) return null;
    return { link: value.link as MediaLinkState, detail: typeof value.detail === 'string' ? value.detail : null };
  } catch {
    return null;
  }
}

/** Frames arrive as an ArrayBuffer on desktop; some mobile IPC paths deliver a byte array. */
export function frameBytes(message: ArrayBuffer | Uint8Array | number[]): Uint8Array {
  if (message instanceof Uint8Array) return message;
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  return Uint8Array.from(message);
}

/** The host-owned socket, through Tauri commands. */
export function hostMediaBridge(): MediaBridge {
  let current: Channel<ChannelMessage> | null = null;
  return {
    open: async (callId, onFrame, onLink) => {
      const channel = new Channel<ChannelMessage>();
      channel.onmessage = (message) => {
        if (current !== channel) return;
        if (typeof message === 'string') {
          const link = parseLinkMessage(message);
          if (link) onLink(link);
          return;
        }
        onFrame(frameBytes(message));
      };
      current = channel;
      await invoke<void>('call_media_open', { call_id: callId, on_frame: channel });
    },
    send: (payload) => {
      if (!current) return;
      void invoke<void>('call_media_send', payload).catch(() => undefined);
    },
    close: async () => {
      if (!current) return;
      current = null;
      await invoke<void>('call_media_close').catch(() => undefined);
    },
  };
}

/** No host (browser dev mode, sample data): the link ends at once, so the call does. */
export function unavailableMediaBridge(): MediaBridge {
  return {
    open: async (_callId, _onFrame, onLink) => { onLink({ link: 'ended', detail: 'no_host_media_bridge' }); },
    send: () => {},
    close: async () => {},
  };
}
