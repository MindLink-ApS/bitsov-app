import { describe, expect, it } from 'vitest';
import { JitterBuffer, MAX_DEPTH, MIN_DEPTH } from '../src/control/jitterBuffer';

const frame = (n: number) => Float32Array.of(n);
const value = (pull: { frame: Float32Array | null }) => (pull.frame ? pull.frame[0] : null);

describe('jitter buffer', () => {
  it('prebuffers 60 ms (3 frames) then plays in order', () => {
    const jb = new JitterBuffer<Float32Array>();
    expect(jb.pull().reason).toBe('waiting');
    jb.insert(10, frame(10));
    jb.insert(11, frame(11));
    expect(jb.pull().reason).toBe('waiting');
    jb.insert(12, frame(12));
    expect(value(jb.pull())).toBe(10);
    expect(value(jb.pull())).toBe(11);
    expect(value(jb.pull())).toBe(12);
    expect(jb.stats()).toMatchObject({ played: 3, lost: 0, late: 0, target: MIN_DEPTH });
  });

  it('reorders frames that arrive out of order', () => {
    const jb = new JitterBuffer<Float32Array>();
    jb.insert(2, frame(2));
    jb.insert(1, frame(1));
    jb.insert(3, frame(3));
    jb.insert(0, frame(0));
    expect([value(jb.pull()), value(jb.pull()), value(jb.pull()), value(jb.pull())]).toEqual([0, 1, 2, 3]);
    expect(jb.stats().lost).toBe(0);
  });

  it('conceals a lost frame and keeps going', () => {
    const jb = new JitterBuffer<Float32Array>();
    for (const seq of [0, 1, 2, 3]) if (seq !== 1) jb.insert(seq, frame(seq));
    expect(value(jb.pull())).toBe(0);
    const gap = jb.pull();
    expect(gap.reason).toBe('lost');
    expect(gap.frame).toBeNull();
    expect(value(jb.pull())).toBe(2);
    expect(value(jb.pull())).toBe(3);
    expect(jb.stats().lost).toBe(1);
  });

  it('drops a frame that arrives after its slot and raises the target up to 120 ms', () => {
    const jb = new JitterBuffer<Float32Array>();
    for (const seq of [0, 1, 2, 3]) jb.insert(seq, frame(seq));
    jb.pull(); jb.pull();
    expect(jb.insert(0, frame(0))).toBe('late');
    expect(jb.stats().target).toBe(MIN_DEPTH + 1);
    for (let i = 0; i < 10; i++) jb.insert(1, frame(1));
    expect(jb.stats().target).toBe(MAX_DEPTH);
    expect(jb.stats().late).toBe(11);
    expect(value(jb.pull())).toBe(2);
  });

  it('ignores duplicates', () => {
    const jb = new JitterBuffer<Float32Array>();
    jb.insert(0, frame(0));
    expect(jb.insert(0, frame(0))).toBe('duplicate');
    expect(jb.stats().duplicates).toBe(1);
  });

  it('holds the playhead through an underrun, then skips ahead when a burst arrives', () => {
    const jb = new JitterBuffer<Float32Array>();
    for (const seq of [0, 1, 2]) jb.insert(seq, frame(seq));
    for (let i = 0; i < 3; i++) jb.pull();
    expect(jb.pull().reason).toBe('underrun');
    expect(jb.pull().reason).toBe('underrun');
    // A 400 ms burst lands at once: play from the newest target window, not from 3.
    for (let seq = 3; seq < 23; seq++) jb.insert(seq, frame(seq));
    const stats = jb.stats();
    expect(stats.underruns).toBe(2);
    expect(stats.depth).toBeLessThanOrEqual(MIN_DEPTH + 2);
    expect(stats.skipped).toBeGreaterThan(0);
    expect(value(jb.pull())).toBe(23 - stats.depth);
  });

  it('skips non-audio markers without a gap', () => {
    const jb = new JitterBuffer<Float32Array>();
    jb.insert(0, frame(0));
    jb.insert(1, null);
    jb.insert(2, frame(2));
    expect(value(jb.pull())).toBe(0);
    expect(value(jb.pull())).toBe(2);
    expect(jb.stats().lost).toBe(0);
  });

  it('restarts on a seq jump and across the u32 wrap', () => {
    const jb = new JitterBuffer<Float32Array>();
    for (const seq of [0xfffffffe, 0xffffffff, 0]) jb.insert(seq, frame(seq % 7));
    expect([value(jb.pull()), value(jb.pull()), value(jb.pull())]).toEqual([0xfffffffe % 7, 0xffffffff % 7, 0]);
    expect(jb.insert(5000, frame(1))).toBe('reset');
    expect(jb.stats().resets).toBe(1);
    jb.insert(5001, frame(2)); jb.insert(5002, frame(3));
    expect(value(jb.pull())).toBe(1);
  });

  it('relaxes the target after a long clean run', () => {
    const jb = new JitterBuffer<Float32Array>({ minDepth: 2, maxDepth: 4 });
    for (const seq of [0, 1, 2, 3]) jb.insert(seq, frame(seq));
    jb.pull(); jb.pull();
    jb.insert(0, frame(0));
    expect(jb.stats().target).toBe(3);
    let seq = 4;
    for (let i = 0; i < 520; i++) { jb.insert(seq++, frame(1)); jb.pull(); }
    expect(jb.stats().target).toBe(2);
    expect(jb.stats().depth).toBeLessThanOrEqual(2);
  });
});
