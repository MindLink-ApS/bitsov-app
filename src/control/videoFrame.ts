/**
 * The node-routed video wire format, inside "bitsov media payload v1"
 * (`mediaFrame.ts`). A video payload never reaches the audio engine:
 * `parsePayload` answers null for these types, so an app without video ignores
 * them and its jitter buffer never sees them.
 *
 * Every video payload has the layout the sealed media format puts inside its
 * ciphertext:
 *
 *   type u8 | stream_seq u32 BE | len u16 BE | body (len bytes) | zero padding
 *
 * Today this travels in the clear, and **the nodes can read it**. Sealing later
 * wraps these same bytes as `0x11 | epoch u8 | counter u32 BE | ciphertext |
 * tag 16` without changing anything inside: that is the reserved sealing slot.
 * A payload is therefore limited to `MAX_INNER_BYTES`, which leaves room for
 * those 22 bytes of the 4096 the node carries and is a multiple of the sealed
 * format's 128-byte padding.
 *
 * Types: `0x20` one fragment of one encoded video frame; `0x38` the codecs this
 * app decodes and its tier; `0x39` please send a key frame; `0x3A` the
 * receiver's report; `0x3B` camera state. `0x10`, `0x11`, `0x30` and `0x32` stay
 * reserved for keys and sealing, and `0x21` to `0x2F` and `0x3C` to `0x3F` for
 * later video types.
 */
import { MAX_PAYLOAD, SEQ_BYTES } from './mediaFrame';

/** Reserved for the sealed form of a payload; no app sends these yet. */
export const PAYLOAD_REVEAL = 0x10;
export const PAYLOAD_SEALED = 0x11;
/** What sealing adds around the inner bytes: 6 bytes of header and a 16-byte tag. */
export const SEAL_OVERHEAD = 22;
/** The sealed form pads the inner bytes to a multiple of this. */
export const SEAL_PADDING = 128;

export const VIDEO_FRAGMENT = 0x20;
export const VIDEO_HELLO = 0x38;
export const VIDEO_KEY_REQUEST = 0x39;
export const VIDEO_REPORT = 0x3a;
export const VIDEO_STATE = 0x3b;

/** Largest inner payload: fits the node's cap once sealed, and needs no padding when full. */
export const MAX_INNER_BYTES = Math.floor((MAX_PAYLOAD - SEAL_OVERHEAD) / SEAL_PADDING) * SEAL_PADDING;
export const INNER_HEADER_BYTES = 7;
export const FRAGMENT_HEADER_BYTES = 14;
export const MAX_FRAGMENT_DATA = MAX_INNER_BYTES - INNER_HEADER_BYTES - FRAGMENT_HEADER_BYTES;
/** Fragments one frame may have: far above any frame the tiers produce. */
export const MAX_FRAGMENTS = 128;

export const CODEC_H264 = 0x01;
export const CODEC_VP8 = 0x02;
export type VideoCodecId = typeof CODEC_H264 | typeof CODEC_VP8;

export const FRAGMENT_KEY_FLAG = 0x01;

export type Inner = { type: number; streamSeq: number; body: Uint8Array };

export type Fragment = {
  frameId: number;
  index: number;
  count: number;
  key: boolean;
  codec: number;
  /** Capture time on the sender's clock, milliseconds, wrapping at 2^32. */
  captureMs: number;
  data: Uint8Array;
};

export type EncodedFrame = { frameId: number; key: boolean; codec: VideoCodecId; captureMs: number; data: Uint8Array };

export type VideoHello = { decodes: number; tier: number };
/** `delayMs`: how far the last second's lowest arrival delay sits above the lowest in the last minute: a queue building on the path. */
export type VideoReport = { complete: number; lost: number; waitingForKey: boolean; delayMs: number };
export type VideoState = { camera: boolean; paused: boolean };

const u32 = (value: number) => value >>> 0;

/** Whether a payload (no `seq`) is on the video path. */
export function isVideoPayload(payload: Uint8Array): boolean {
  const type = payload[0];
  return type !== undefined && ((type >= 0x20 && type <= 0x2f) || (type >= 0x38 && type <= 0x3f));
}

/** Whether a whole frame (`seq` + payload) as the host delivers it is on the video path. */
export const isVideoFrame = (bytes: Uint8Array) => bytes.length > SEQ_BYTES && isVideoPayload(bytes.subarray(SEQ_BYTES));

export function encodeInner(type: number, streamSeq: number, body: Uint8Array): Uint8Array {
  if (INNER_HEADER_BYTES + body.length > MAX_INNER_BYTES) throw new RangeError('video_payload_too_large');
  const out = new Uint8Array(INNER_HEADER_BYTES + body.length);
  const view = new DataView(out.buffer);
  out[0] = type;
  view.setUint32(1, u32(streamSeq), false);
  view.setUint16(5, body.length, false);
  out.set(body, INNER_HEADER_BYTES);
  return out;
}

/** The inner bytes of a payload, or null when they do not hold together. Bytes after `len` are padding. */
export function parseInner(payload: Uint8Array): Inner | null {
  if (payload.length < INNER_HEADER_BYTES || !isVideoPayload(payload)) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const len = view.getUint16(5, false);
  if (INNER_HEADER_BYTES + len > payload.length) return null;
  return { type: payload[0], streamSeq: view.getUint32(1, false), body: payload.subarray(INNER_HEADER_BYTES, INNER_HEADER_BYTES + len) };
}

export function encodeFragment(streamSeq: number, fragment: Fragment): Uint8Array {
  const body = new Uint8Array(FRAGMENT_HEADER_BYTES + fragment.data.length);
  const view = new DataView(body.buffer);
  view.setUint32(0, u32(fragment.frameId), false);
  view.setUint16(4, fragment.index, false);
  view.setUint16(6, fragment.count, false);
  body[8] = fragment.key ? FRAGMENT_KEY_FLAG : 0;
  body[9] = fragment.codec;
  view.setUint32(10, u32(fragment.captureMs), false);
  body.set(fragment.data, FRAGMENT_HEADER_BYTES);
  return encodeInner(VIDEO_FRAGMENT, streamSeq, body);
}

export function parseFragment(body: Uint8Array): Fragment | null {
  if (body.length <= FRAGMENT_HEADER_BYTES) return null;
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const index = view.getUint16(4, false);
  const count = view.getUint16(6, false);
  if (count === 0 || count > MAX_FRAGMENTS || index >= count) return null;
  return {
    frameId: view.getUint32(0, false),
    index,
    count,
    key: (body[8] & FRAGMENT_KEY_FLAG) !== 0,
    codec: body[9],
    captureMs: view.getUint32(10, false),
    data: body.subarray(FRAGMENT_HEADER_BYTES),
  };
}

/** One encoded frame as payloads, numbered from `firstSeq`. Refuses a frame too big to carry. */
export function fragmentFrame(frame: EncodedFrame, firstSeq: number): Uint8Array[] {
  const count = Math.max(1, Math.ceil(frame.data.length / MAX_FRAGMENT_DATA));
  if (frame.data.length === 0 || count > MAX_FRAGMENTS) throw new RangeError('video_frame_too_large');
  const out: Uint8Array[] = [];
  for (let index = 0; index < count; index++) {
    const start = index * MAX_FRAGMENT_DATA;
    out.push(encodeFragment(firstSeq + index, {
      frameId: frame.frameId,
      index,
      count,
      key: frame.key,
      codec: frame.codec,
      captureMs: frame.captureMs,
      data: frame.data.subarray(start, Math.min(start + MAX_FRAGMENT_DATA, frame.data.length)),
    }));
  }
  return out;
}

export const helloBody = (hello: VideoHello) => Uint8Array.of(hello.decodes & 0xff, hello.tier & 0xff);
export const parseHello = (body: Uint8Array): VideoHello | null => (body.length >= 2 ? { decodes: body[0], tier: body[1] } : null);

export function reportBody(report: VideoReport): Uint8Array {
  const out = new Uint8Array(7);
  const view = new DataView(out.buffer);
  view.setUint16(0, Math.min(report.complete, 0xffff), false);
  view.setUint16(2, Math.min(report.lost, 0xffff), false);
  out[4] = report.waitingForKey ? 1 : 0;
  view.setUint16(5, Math.min(Math.max(0, Math.round(report.delayMs)), 0xffff), false);
  return out;
}

export function parseReport(body: Uint8Array): VideoReport | null {
  if (body.length < 7) return null;
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  return { complete: view.getUint16(0, false), lost: view.getUint16(2, false), waitingForKey: body[4] === 1, delayMs: view.getUint16(5, false) };
}

export const stateBody = (state: VideoState) => Uint8Array.of((state.camera ? 1 : 0) | (state.paused ? 2 : 0));
export const parseState = (body: Uint8Array): VideoState | null => (body.length >= 1 ? { camera: (body[0] & 1) !== 0, paused: (body[0] & 2) !== 0 } : null);

/** Signed distance from `b` to `a` on the u32 circle (positive: `a` is newer). */
export function frameDiff(a: number, b: number): number {
  return (a - b) | 0;
}

/** How long a missing frame may keep the frames behind it waiting. */
export const GAP_TIMEOUT_MS = 200;
/** Frames being put together at once; beyond this the oldest is given up. */
export const MAX_PENDING_FRAMES = 16;
/** Bytes held for unfinished frames, against a peer or node sending junk. */
export const MAX_PENDING_BYTES = 1024 * 1024;

type Pending = {
  count: number;
  key: boolean;
  codec: number;
  captureMs: number;
  parts: (Uint8Array | undefined)[];
  received: number;
  bytes: number;
  firstAt: number;
  complete: boolean;
};

export type AssembledFrame = { frameId: number; key: boolean; codec: number; captureMs: number; data: Uint8Array; arrivedAt: number };
export type ReassemblerStats = { complete: number; delivered: number; lost: number; discarded: number; waitingForKey: boolean; pending: number };

/**
 * Puts fragments back into frames, in frame order. Frames depend on the ones
 * before them, so nothing is delivered after a loss until the next key frame.
 *
 * Fragments may arrive out of order: a small frame or a frame's small last
 * fragment rides the node's priority lane past larger ones. So a frame missing
 * in the middle only counts as lost after `GAP_TIMEOUT_MS`, or once a key frame
 * makes it irrelevant.
 *
 * Nothing here trusts the sender: fragments are bounded by frame, by frame
 * count and by bytes, and anything inconsistent is dropped.
 */
export class Reassembler {
  private readonly pending = new Map<number, Pending>();
  private pendingBytes = 0;
  /** The next frame to deliver; null until the first key frame sets it. */
  private next: number | null = null;
  private waitingForKey = true;
  /** When a frame behind `next` was first seen waiting for it. */
  private blockedSince: number | null = null;
  private complete = 0;
  private delivered = 0;
  private lost = 0;
  private discarded = 0;

  /** Add a fragment; returns the frames that can now go to the decoder, in order. */
  insert(fragment: Fragment, now: number): AssembledFrame[] {
    const id = fragment.frameId;
    if (this.next !== null && frameDiff(id, this.next) < 0) return this.expire(now);
    let frame = this.pending.get(id);
    if (!frame) {
      frame = { count: fragment.count, key: fragment.key, codec: fragment.codec, captureMs: fragment.captureMs, parts: new Array(fragment.count), received: 0, bytes: 0, firstAt: now, complete: false };
      this.pending.set(id, frame);
      this.bound();
      if (!this.pending.has(id)) return this.expire(now);
    }
    if (frame.count !== fragment.count || frame.key !== fragment.key || frame.codec !== fragment.codec) {
      this.discard(id);
      this.lose(now);
      return [];
    }
    if (!frame.complete && !frame.parts[fragment.index]) {
      frame.parts[fragment.index] = fragment.data;
      frame.received++;
      frame.bytes += fragment.data.length;
      this.pendingBytes += fragment.data.length;
      if (frame.received === frame.count) {
        frame.complete = true;
        this.complete++;
      }
      while (this.pendingBytes > MAX_PENDING_BYTES && this.pending.size > 0) this.discard(this.oldest());
    }
    return this.drain(now);
  }

  /** Time passes: a gap may now count as lost. */
  expire(now: number): AssembledFrame[] {
    if (this.blockedSince !== null && now - this.blockedSince >= GAP_TIMEOUT_MS) {
      this.lose(now);
    }
    return this.drain(now);
  }

  /** The link came back after a drop: what was in flight is gone, and only a key frame continues. */
  reset(): void {
    this.pending.clear();
    this.pendingBytes = 0;
    this.next = null;
    this.waitingForKey = true;
    this.blockedSince = null;
  }

  stats(): ReassemblerStats {
    return { complete: this.complete, delivered: this.delivered, lost: this.lost, discarded: this.discarded, waitingForKey: this.waitingForKey, pending: this.pending.size };
  }

  private oldest(): number {
    let oldest: number | null = null;
    for (const id of this.pending.keys()) if (oldest === null || frameDiff(id, oldest) < 0) oldest = id;
    return oldest as number;
  }

  private bound() {
    while (this.pending.size > MAX_PENDING_FRAMES) this.discard(this.oldest());
  }

  private discard(id: number) {
    const frame = this.pending.get(id);
    if (!frame) return;
    this.pending.delete(id);
    this.pendingBytes -= frame.bytes;
    this.discarded++;
  }

  private lose(_now: number) {
    this.lost++;
    this.waitingForKey = true;
    this.blockedSince = null;
    // Everything still in hand depends on what was lost, except a key frame.
    for (const [id, frame] of [...this.pending]) if (!frame.key) this.discard(id);
  }

  private take(id: number, frame: Pending): AssembledFrame {
    const data = new Uint8Array(frame.bytes);
    let at = 0;
    for (const part of frame.parts) {
      data.set(part as Uint8Array, at);
      at += (part as Uint8Array).length;
    }
    this.pending.delete(id);
    this.pendingBytes -= frame.bytes;
    this.delivered++;
    return { frameId: id, key: frame.key, codec: frame.codec, captureMs: frame.captureMs, data, arrivedAt: frame.firstAt };
  }

  private drain(now: number): AssembledFrame[] {
    const out: AssembledFrame[] = [];
    // The newest complete key frame makes everything before it irrelevant.
    let key: number | null = null;
    for (const [id, frame] of this.pending) {
      if (frame.complete && frame.key && (key === null || frameDiff(id, key) > 0) && (this.next === null || frameDiff(id, this.next) >= 0)) key = id;
    }
    if (key !== null) {
      for (const id of [...this.pending.keys()]) {
        if (frameDiff(id, key) < 0) {
          if (this.next !== null && !this.waitingForKey) this.lost++;
          this.discard(id);
        }
      }
      const frame = this.pending.get(key) as Pending;
      out.push(this.take(key, frame));
      this.next = (key + 1) >>> 0;
      this.waitingForKey = false;
      this.blockedSince = null;
    }
    if (this.waitingForKey) {
      this.blockedSince = null;
      // A finished delta can never be decoded now: don't hold on to it.
      for (const [id, frame] of [...this.pending]) if (frame.complete && !frame.key) this.discard(id);
      return out;
    }
    for (;;) {
      const frame = this.pending.get(this.next as number);
      if (!frame || !frame.complete) break;
      out.push(this.take(this.next as number, frame));
      this.next = ((this.next as number) + 1) >>> 0;
    }
    const behind = this.pending.size > 0 && [...this.pending.entries()].some(([id, frame]) => frame.complete || frameDiff(id, this.next as number) > 0);
    const incomplete = this.pending.get(this.next as number);
    if (behind || incomplete) this.blockedSince ??= now;
    else this.blockedSince = null;
    return out;
  }
}
