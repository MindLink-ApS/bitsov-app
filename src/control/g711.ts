/**
 * G.711 mu-law (PCMU), the fallback call codec when WebCodecs Opus is not
 * available in this webview. Pure TypeScript, no dependency: 8 kHz mono,
 * one byte per sample, so a 20 ms frame is 160 bytes.
 *
 * The companding follows ITU-T G.711 as implemented by every softphone: a
 * 0x84 bias, 8 segments, 4 mantissa bits, bits inverted on the wire.
 */

export const PCMU_RATE = 8000;
/** Samples per 20 ms frame at 8 kHz. */
export const PCMU_FRAME = 160;

const BIAS = 0x84;
const CLIP = 32_635;

/** One 16-bit linear sample to one mu-law byte. */
export function muLawEncodeSample(sample: number): number {
  let s = Math.max(-32_768, Math.min(32_767, Math.round(sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (s & mask) === 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** One mu-law byte back to a 16-bit linear sample. */
export function muLawDecodeSample(byte: number): number {
  const u = ~byte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const magnitude = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  return sign ? -magnitude : magnitude;
}

/** Float PCM in [-1, 1] (any length) to mu-law bytes. */
export function encodeMuLaw(pcm: Float32Array): Uint8Array {
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    const clamped = Math.max(-1, Math.min(1, pcm[i]));
    out[i] = muLawEncodeSample(clamped < 0 ? clamped * 32_768 : clamped * 32_767);
  }
  return out;
}

/** Mu-law bytes to float PCM in [-1, 1]. */
export function decodeMuLaw(bytes: Uint8Array): Float32Array {
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = muLawDecodeSample(bytes[i]) / 32_768;
  return out;
}
