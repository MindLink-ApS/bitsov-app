import { describe, expect, it } from 'vitest';
import { audioPayload, CAP_OPUS, CAP_PCMU, chooseCodec, decodeFrame, encodeFrame, helloPayload, MAX_PAYLOAD, nextSeq, parsePayload, seqDiff } from '../src/control/mediaFrame';

describe('media frames (seq u32 big-endian + payload)', () => {
  it('encodes and decodes the shape the node forwards', () => {
    const bytes = encodeFrame(0x01020304, Uint8Array.of(9, 8, 7));
    expect([...bytes]).toEqual([1, 2, 3, 4, 9, 8, 7]);
    const frame = decodeFrame(bytes)!;
    expect(frame.seq).toBe(0x01020304);
    expect([...frame.payload]).toEqual([9, 8, 7]);
    expect(decodeFrame(encodeFrame(0xffffffff, Uint8Array.of(1)))!.seq).toBe(0xffffffff);
  });

  it('refuses malformed frames and out-of-range seq', () => {
    expect(decodeFrame(Uint8Array.of(0, 0, 0))).toBeNull();
    expect(decodeFrame(new Uint8Array(4 + MAX_PAYLOAD + 1))).toBeNull();
    expect(decodeFrame(new Uint8Array(4 + MAX_PAYLOAD))).not.toBeNull();
    expect(() => encodeFrame(-1, Uint8Array.of(1))).toThrow(RangeError);
    expect(() => encodeFrame(2 ** 32, Uint8Array.of(1))).toThrow(RangeError);
    expect(() => encodeFrame(0, new Uint8Array(MAX_PAYLOAD + 1))).toThrow(RangeError);
  });

  it('decodes from an offset view of a larger buffer', () => {
    const bigger = new Uint8Array([0xaa, 0xaa, 0, 0, 0, 5, 1, 2]);
    const frame = decodeFrame(bigger.subarray(2))!;
    expect(frame.seq).toBe(5);
    expect([...frame.payload]).toEqual([1, 2]);
  });

  it('compares seq on the u32 circle', () => {
    expect(seqDiff(5, 3)).toBe(2);
    expect(seqDiff(3, 5)).toBe(-2);
    expect(seqDiff(0, 0xffffffff)).toBe(1);
    expect(seqDiff(0xffffffff, 0)).toBe(-1);
    expect(nextSeq(0xffffffff)).toBe(0);
  });
});

describe('media payloads (type byte + bytes)', () => {
  it('hello carries the decodable codecs; audio carries its codec', () => {
    expect(parsePayload(helloPayload(CAP_PCMU | CAP_OPUS))).toEqual({ type: 'hello', caps: 3 });
    const opus = parsePayload(audioPayload('opus', Uint8Array.of(1, 2)))!;
    expect(opus.type === 'audio' && opus.codec).toBe('opus');
    const pcmu = parsePayload(audioPayload('pcmu', Uint8Array.of(0xff)))!;
    expect(pcmu.type === 'audio' && [...pcmu.data]).toEqual([0xff]);
  });

  it('ignores unknown or truncated payloads', () => {
    expect(parsePayload(new Uint8Array(0))).toBeNull();
    expect(parsePayload(Uint8Array.of(0x00))).toBeNull();
    expect(parsePayload(Uint8Array.of(0x01))).toBeNull();
    expect(parsePayload(Uint8Array.of(0x7f, 1))).toBeNull();
  });

  it('sends Opus only when both sides have it, mu-law otherwise', () => {
    expect(chooseCodec(CAP_PCMU | CAP_OPUS, CAP_PCMU | CAP_OPUS)).toBe('opus');
    expect(chooseCodec(CAP_PCMU | CAP_OPUS, CAP_PCMU)).toBe('pcmu');
    expect(chooseCodec(CAP_PCMU, CAP_PCMU | CAP_OPUS)).toBe('pcmu');
    expect(chooseCodec(CAP_PCMU | CAP_OPUS, null)).toBe('pcmu');
  });
});
