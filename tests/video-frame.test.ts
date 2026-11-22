/** Node-routed video wire format: golden bytes, the reserved sealing slot, and reassembly. */
import { describe, expect, it } from 'vitest';
import { MAX_PAYLOAD, parsePayload, encodeFrame } from '../src/control/mediaFrame';
import {
  CODEC_H264, FRAGMENT_HEADER_BYTES, GAP_TIMEOUT_MS, INNER_HEADER_BYTES, MAX_FRAGMENTS, MAX_FRAGMENT_DATA, MAX_INNER_BYTES, MAX_PENDING_FRAMES,
  PAYLOAD_SEALED, Reassembler, SEAL_OVERHEAD, SEAL_PADDING, VIDEO_FRAGMENT, VIDEO_HELLO, VIDEO_KEY_REQUEST, VIDEO_REPORT, VIDEO_STATE,
  encodeFragment, encodeInner, fragmentFrame, helloBody, isVideoFrame, isVideoPayload, parseFragment, parseHello, parseInner, parseReport, parseState, reportBody, stateBody,
  type Fragment,
} from '../src/control/videoFrame';

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

function fragment(frameId: number, index: number, count: number, key = false, data: Uint8Array = Uint8Array.of(frameId & 0xff, index)): Fragment {
  return { frameId, index, count, key, codec: CODEC_H264, captureMs: 1000 + frameId, data };
}
const whole = (frameId: number, key = false) => fragment(frameId, 0, 1, key);

describe('video payload layout', () => {
  it('has the exact bytes the format promises', () => {
    const payload = encodeFragment(0x01020304, { frameId: 0x0a0b0c0d, index: 1, count: 2, key: true, codec: CODEC_H264, captureMs: 0x11223344, data: Uint8Array.of(0xde, 0xad) });
    expect(hex(payload)).toBe('20' + '01020304' + '0010' + '0a0b0c0d' + '0001' + '0002' + '01' + '01' + '11223344' + 'dead');
    expect(INNER_HEADER_BYTES).toBe(7);
    expect(FRAGMENT_HEADER_BYTES).toBe(14);
  });

  it('round trips every control body', () => {
    expect(parseHello(helloBody({ decodes: 3, tier: 1 }))).toEqual({ decodes: 3, tier: 1 });
    expect(parseReport(reportBody({ complete: 15, lost: 2, waitingForKey: true, delayMs: 300 }))).toEqual({ complete: 15, lost: 2, waitingForKey: true, delayMs: 300 });
    expect(parseReport(reportBody({ complete: 1e6, lost: 0, waitingForKey: false, delayMs: 1e6 }))).toMatchObject({ complete: 0xffff, delayMs: 0xffff });
    expect(parseState(stateBody({ camera: false, paused: true }))).toEqual({ camera: false, paused: true });
    expect(parseHello(new Uint8Array(1))).toBeNull();
    expect(parseReport(new Uint8Array(6))).toBeNull();
    expect(parseState(new Uint8Array(0))).toBeNull();
    for (const type of [VIDEO_FRAGMENT, VIDEO_HELLO, VIDEO_KEY_REQUEST, VIDEO_REPORT, VIDEO_STATE]) {
      const inner = parseInner(encodeInner(type, 7, Uint8Array.of(9)));
      expect(inner?.type).toBe(type);
      expect(inner?.streamSeq).toBe(7);
      expect([...(inner?.body ?? [])]).toEqual([9]);
    }
  });

  it('ignores padding and refuses what does not hold together', () => {
    const padded = new Uint8Array(128);
    padded.set(encodeInner(VIDEO_STATE, 1, Uint8Array.of(1)));
    expect([...(parseInner(padded)?.body ?? [])]).toEqual([1]);
    expect(parseInner(new Uint8Array(6))).toBeNull();
    const short = encodeInner(VIDEO_STATE, 1, new Uint8Array(4)).subarray(0, 9);
    expect(parseInner(short)).toBeNull();
    expect(parseInner(Uint8Array.of(0x02, 0, 0, 0, 0, 0, 0))).toBeNull();
    expect(parseFragment(new Uint8Array(FRAGMENT_HEADER_BYTES))).toBeNull();
    const body = (index: number, count: number) => {
      const out = new Uint8Array(FRAGMENT_HEADER_BYTES + 1);
      const view = new DataView(out.buffer);
      view.setUint16(4, index);
      view.setUint16(6, count);
      return out;
    };
    expect(parseFragment(body(0, 1))).not.toBeNull();
    expect(parseFragment(body(0, 0))).toBeNull();
    expect(parseFragment(body(1, 1))).toBeNull();
    expect(parseFragment(body(0, MAX_FRAGMENTS + 1))).toBeNull();
  });

  it('never lands on an audio type: the audio engine and an app without video ignore all of it', () => {
    for (const type of [VIDEO_FRAGMENT, VIDEO_HELLO, VIDEO_KEY_REQUEST, VIDEO_REPORT, VIDEO_STATE, PAYLOAD_SEALED]) {
      expect(parsePayload(Uint8Array.of(type, 1, 2, 3))).toBeNull();
    }
    for (const audio of [0x00, 0x01, 0x02]) expect(isVideoPayload(Uint8Array.of(audio, 1))).toBe(false);
    // Reserved for keys and sealing: not video.
    for (const reserved of [0x10, 0x11, 0x30, 0x31, 0x32, 0x37]) expect(isVideoPayload(Uint8Array.of(reserved))).toBe(false);
    expect(isVideoFrame(encodeFrame(9, encodeInner(VIDEO_HELLO, 0, helloBody({ decodes: 1, tier: 0 }))))).toBe(true);
    expect(isVideoFrame(encodeFrame(9, Uint8Array.of(0x02, 1)))).toBe(false);
    expect(isVideoFrame(Uint8Array.of(0, 0, 0, 1))).toBe(false);
  });
});

describe('the reserved sealing slot', () => {
  const seal = (inner: Uint8Array) => {
    // The sealed form of #format: header, ciphertext the size of the padded inner bytes, tag.
    const padded = Math.ceil(inner.length / SEAL_PADDING) * SEAL_PADDING;
    return new Uint8Array(6 + padded + 16);
  };

  it('leaves room for the sealed form of the largest fragment inside the node cap', () => {
    expect(SEAL_OVERHEAD).toBe(22);
    expect(MAX_INNER_BYTES % SEAL_PADDING).toBe(0);
    expect(MAX_INNER_BYTES).toBe(3968);
    const largest = encodeFragment(1, { frameId: 1, index: 0, count: 1, key: true, codec: CODEC_H264, captureMs: 0, data: new Uint8Array(MAX_FRAGMENT_DATA) });
    expect(largest.length).toBe(MAX_INNER_BYTES);
    expect(seal(largest).length).toBeLessThanOrEqual(MAX_PAYLOAD);
    expect(() => encodeFragment(1, { frameId: 1, index: 0, count: 1, key: true, codec: CODEC_H264, captureMs: 0, data: new Uint8Array(MAX_FRAGMENT_DATA + 1) })).toThrow();
  });

  it('reads the padded inner bytes the same as the clear ones, so sealing changes nothing inside', () => {
    const clear = encodeFragment(5, fragment(7, 0, 1, true, new Uint8Array(100).fill(3)));
    const padded = new Uint8Array(Math.ceil(clear.length / SEAL_PADDING) * SEAL_PADDING);
    padded.set(clear);
    expect(parseFragment(parseInner(padded)!.body)).toEqual(parseFragment(parseInner(clear)!.body));
  });
});

describe('fragmenting and reassembling', () => {
  it('puts a large frame back byte for byte, in any order', () => {
    const data = Uint8Array.from({ length: MAX_FRAGMENT_DATA * 3 + 17 }, (_, i) => i % 251);
    const payloads = fragmentFrame({ frameId: 42, key: true, codec: CODEC_H264, captureMs: 5000, data }, 100);
    expect(payloads.length).toBe(4);
    payloads.forEach((p) => expect(p.length).toBeLessThanOrEqual(MAX_INNER_BYTES));
    expect(parseInner(payloads[2])?.streamSeq).toBe(102);
    const r = new Reassembler();
    const out = [3, 0, 2, 1].flatMap((i) => r.insert(parseFragment(parseInner(payloads[i])!.body)!, 10));
    expect(out.length).toBe(1);
    expect(out[0].frameId).toBe(42);
    expect(out[0].key).toBe(true);
    expect(out[0].captureMs).toBe(5000);
    expect(out[0].data).toEqual(data);
  });

  it('refuses a frame too big to carry and an empty one', () => {
    expect(() => fragmentFrame({ frameId: 1, key: true, codec: CODEC_H264, captureMs: 0, data: new Uint8Array(MAX_FRAGMENT_DATA * MAX_FRAGMENTS + 1) }, 0)).toThrow();
    expect(() => fragmentFrame({ frameId: 1, key: true, codec: CODEC_H264, captureMs: 0, data: new Uint8Array(0) }, 0)).toThrow();
  });

  it('delivers nothing before the first key frame', () => {
    const r = new Reassembler();
    expect(r.insert(whole(1), 0)).toEqual([]);
    expect(r.stats().waitingForKey).toBe(true);
    expect(r.insert(whole(2, true), 1).map((f) => f.frameId)).toEqual([2]);
    expect(r.stats().waitingForKey).toBe(false);
    expect(r.insert(whole(3), 2).map((f) => f.frameId)).toEqual([3]);
  });

  it('holds a frame that overtook another until the gap fills, in order', () => {
    const r = new Reassembler();
    r.insert(whole(1, true), 0);
    // Frame 2 is large and still arriving; small frame 3 rode past it.
    expect(r.insert(fragment(2, 0, 2), 1)).toEqual([]);
    expect(r.insert(whole(3), 2)).toEqual([]);
    expect(r.insert(fragment(2, 1, 2), 3).map((f) => f.frameId)).toEqual([2, 3]);
    expect(r.stats().lost).toBe(0);
  });

  it('counts a missing frame lost after the timeout, then waits for a key frame', () => {
    const r = new Reassembler();
    r.insert(whole(1, true), 0);
    expect(r.insert(whole(3), 10)).toEqual([]);
    expect(r.expire(10 + GAP_TIMEOUT_MS - 1)).toEqual([]);
    expect(r.stats().lost).toBe(0);
    expect(r.expire(10 + GAP_TIMEOUT_MS)).toEqual([]);
    expect(r.stats()).toMatchObject({ lost: 1, waitingForKey: true });
    // The late frame is no use now, nor are the deltas after it.
    expect(r.insert(whole(2), 300)).toEqual([]);
    expect(r.insert(whole(4), 301)).toEqual([]);
    expect(r.insert(whole(5, true), 302).map((f) => f.frameId)).toEqual([5]);
    expect(r.stats().waitingForKey).toBe(false);
    expect(r.insert(whole(6), 303).map((f) => f.frameId)).toEqual([6]);
  });

  it('a key frame ends the wait for anything before it', () => {
    const r = new Reassembler();
    r.insert(whole(1, true), 0);
    r.insert(fragment(2, 0, 3), 1);
    expect(r.insert(whole(9, true), 2).map((f) => f.frameId)).toEqual([9]);
    expect(r.insert(fragment(2, 1, 3), 3)).toEqual([]);
    expect(r.stats().pending).toBe(0);
  });

  it('wraps frame ids', () => {
    const r = new Reassembler();
    r.insert(whole(0xffffffff, true), 0);
    expect(r.insert(whole(0), 1).map((f) => f.frameId)).toEqual([0]);
    expect(r.insert(whole(1), 2).map((f) => f.frameId)).toEqual([1]);
  });

  it('drops duplicates, conflicts and junk within its bounds', () => {
    const r = new Reassembler();
    r.insert(whole(1, true), 0);
    expect(r.insert(whole(1, true), 1)).toEqual([]);
    r.insert(fragment(2, 0, 3), 2);
    r.insert(fragment(2, 0, 3), 3);
    expect(r.stats().pending).toBe(1);
    // A conflicting fragment count: the frame is given up, not trusted.
    r.insert(fragment(2, 1, 4), 4);
    expect(r.stats().pending).toBe(0);
    expect(r.stats().waitingForKey).toBe(true);
    // Far more unfinished frames than it keeps.
    for (let id = 100; id < 200; id++) r.insert(fragment(id, 0, 2, true), 5);
    expect(r.stats().pending).toBeLessThanOrEqual(MAX_PENDING_FRAMES);
    // Far more bytes than it keeps.
    const big = new Reassembler();
    for (let id = 0; id < 8; id++) for (let i = 0; i < 90; i++) big.insert(fragment(id, i, 128, true, new Uint8Array(MAX_FRAGMENT_DATA)), 1);
    expect(big.stats().discarded).toBeGreaterThan(0);
  });

  it('reset forgets everything and waits for a key frame', () => {
    const r = new Reassembler();
    r.insert(whole(1, true), 0);
    r.insert(fragment(2, 0, 2), 1);
    r.reset();
    expect(r.stats()).toMatchObject({ pending: 0, waitingForKey: true });
    expect(r.insert(whole(3), 2)).toEqual([]);
    expect(r.insert(whole(4, true), 3).map((f) => f.frameId)).toEqual([4]);
  });
});
