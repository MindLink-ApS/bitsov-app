/**
 * The node-routed media wire format (M6 A1).
 *
 * Each binary message on the node's `/calls/:call_id/media` socket is one
 * frame: `seq` (u32, big-endian) followed by the payload bytes. The node
 * forwards frames opaquely to the peer node, which delivers them to the other
 * app. The Rust host assigns `seq` on the way up and validates the shape on
 * the way down (`src-tauri/src/control/media.rs` mirrors this module).
 *
 * The payload is the app's own "bitsov media payload v1": a type byte, then
 * type-specific bytes. Two apps agree on a codec in band: each sends HELLO
 * with the codecs it can decode; a sender uses Opus only once the peer has
 * said it decodes Opus, and mu-law until then.
 */

export const SEQ_BYTES = 4;
/** Largest payload either side accepts; the host refuses anything bigger. */
export const MAX_PAYLOAD = 1500;
/** `seq` wraps at 2^32 like the node's u32. */
export const SEQ_MODULUS = 0x1_0000_0000;

export const PAYLOAD_HELLO = 0x00;
export const PAYLOAD_PCMU = 0x01;
export const PAYLOAD_OPUS = 0x02;

export const CAP_PCMU = 0x01;
export const CAP_OPUS = 0x02;

export type Codec = 'pcmu' | 'opus';
export type MediaFrame = { seq: number; payload: Uint8Array };
export type Payload =
  | { type: 'hello'; caps: number }
  | { type: 'audio'; codec: Codec; data: Uint8Array };

/** Frame bytes for `seq` and `payload`. */
export function encodeFrame(seq: number, payload: Uint8Array): Uint8Array {
  if (!Number.isInteger(seq) || seq < 0 || seq >= SEQ_MODULUS) throw new RangeError('seq_out_of_range');
  if (payload.length > MAX_PAYLOAD) throw new RangeError('payload_too_large');
  const out = new Uint8Array(SEQ_BYTES + payload.length);
  new DataView(out.buffer).setUint32(0, seq, false);
  out.set(payload, SEQ_BYTES);
  return out;
}

/** The frame in `bytes`, or null when it is not one (too short, too large). */
export function decodeFrame(bytes: Uint8Array): MediaFrame | null {
  if (bytes.length < SEQ_BYTES || bytes.length - SEQ_BYTES > MAX_PAYLOAD) return null;
  const seq = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
  return { seq, payload: bytes.subarray(SEQ_BYTES) };
}

/** Signed distance from `b` to `a` on the u32 circle (positive: `a` is newer). */
export function seqDiff(a: number, b: number): number {
  return ((((a - b) % SEQ_MODULUS) + SEQ_MODULUS + 0x8000_0000) % SEQ_MODULUS) - 0x8000_0000;
}

export const nextSeq = (seq: number) => (seq + 1) % SEQ_MODULUS;

export function helloPayload(caps: number): Uint8Array {
  return Uint8Array.of(PAYLOAD_HELLO, caps & 0xff);
}

export function audioPayload(codec: Codec, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + data.length);
  out[0] = codec === 'opus' ? PAYLOAD_OPUS : PAYLOAD_PCMU;
  out.set(data, 1);
  return out;
}

/** The typed payload, or null for anything this version does not understand. */
export function parsePayload(payload: Uint8Array): Payload | null {
  if (payload.length === 0) return null;
  switch (payload[0]) {
    case PAYLOAD_HELLO:
      return payload.length >= 2 ? { type: 'hello', caps: payload[1] } : null;
    case PAYLOAD_PCMU:
      return payload.length > 1 ? { type: 'audio', codec: 'pcmu', data: payload.subarray(1) } : null;
    case PAYLOAD_OPUS:
      return payload.length > 1 ? { type: 'audio', codec: 'opus', data: payload.subarray(1) } : null;
    default:
      return null;
  }
}

/**
 * The codec to send with. Opus only when this app can encode it and the peer
 * has said it decodes it; mu-law is the floor every app decodes.
 */
export function chooseCodec(localCaps: number, peerCaps: number | null): Codec {
  return (localCaps & CAP_OPUS) !== 0 && peerCaps !== null && (peerCaps & CAP_OPUS) !== 0 ? 'opus' : 'pcmu';
}
