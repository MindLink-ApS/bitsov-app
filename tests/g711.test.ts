import { describe, expect, it } from 'vitest';
import { decodeMuLaw, encodeMuLaw, muLawDecodeSample, muLawEncodeSample, PCMU_FRAME, PCMU_RATE } from '../src/control/g711';
import { Framer, frameSamples } from '../src/control/pcm';
// Sample-rate conversion: tests/pcm-resampler.test.ts.

describe('G.711 mu-law', () => {
  it('matches the reference companding at known points', () => {
    // Silence and the extremes, as every PCMU implementation produces them.
    expect(muLawEncodeSample(0)).toBe(0xff);
    expect(muLawEncodeSample(-1)).toBe(0x7f);
    expect(muLawEncodeSample(32767)).toBe(0x80);
    expect(muLawEncodeSample(-32768)).toBe(0x00);
    expect(muLawDecodeSample(0xff)).toBe(0);
    expect(muLawDecodeSample(0x80)).toBe(32124);
    expect(muLawDecodeSample(0x00)).toBe(-32124);
  });

  it('round-trips every byte value', () => {
    for (let byte = 0; byte < 256; byte++) {
      // 0x7f is "negative zero": it decodes to 0, which encodes as 0xff. Every other code is its own fixed point.
      expect(muLawEncodeSample(muLawDecodeSample(byte))).toBe(byte === 0x7f ? 0xff : byte);
    }
  });

  it('round-trips a sine within companding error and keeps the frame length', () => {
    const pcm = new Float32Array(PCMU_FRAME);
    for (let i = 0; i < pcm.length; i++) pcm[i] = 0.6 * Math.sin((2 * Math.PI * 440 * i) / PCMU_RATE);
    const bytes = encodeMuLaw(pcm);
    expect(bytes.length).toBe(PCMU_FRAME);
    const back = decodeMuLaw(bytes);
    expect(back.length).toBe(PCMU_FRAME);
    let worst = 0;
    for (let i = 0; i < pcm.length; i++) worst = Math.max(worst, Math.abs(back[i] - pcm[i]));
    // 8-bit log companding: about 3 % of full scale at the loud end, far less near zero.
    expect(worst).toBeLessThan(0.04);
    expect(Math.abs(back[0])).toBeLessThan(0.002);
  });

  it('clamps out-of-range input instead of wrapping', () => {
    const bytes = encodeMuLaw(Float32Array.of(2, -2, 1, -1));
    expect(bytes[0]).toBe(bytes[2]);
    expect(bytes[1]).toBe(bytes[3]);
    expect(muLawEncodeSample(40_000)).toBe(0x80);
  });
});

describe('PCM helpers', () => {
  it('cuts 20 ms frames at any context rate', () => {
    expect(frameSamples(48_000)).toBe(960);
    expect(frameSamples(44_100)).toBe(882);
    expect(frameSamples(8_000)).toBe(160);
  });

  it('the framer hands out whole frames and keeps the remainder', () => {
    const framer = new Framer(4);
    expect(framer.push(Float32Array.of(1, 2, 3))).toEqual([]);
    expect(framer.pending).toBe(3);
    const frames = framer.push(Float32Array.of(4, 5, 6, 7, 8, 9));
    expect(frames.map((f) => [...f])).toEqual([[1, 2, 3, 4], [5, 6, 7, 8]]);
    expect(framer.pending).toBe(1);
  });
});
