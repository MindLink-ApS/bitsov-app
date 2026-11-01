import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCallAudio, SILENT_FRAMES } from '../src/control/callAudio';

/** The capture path reports a microphone that delivers only digital silence (a phone OS silenced it). */

class FakeNode {
  port = { postMessage: vi.fn(), onmessage: null as ((event: { data: unknown }) => void) | null };
  gain = { value: 1 };
  onprocessorerror: (() => void) | null = null;
  connect<T>(next: T) { return next; }
  disconnect() {}
}
class FakeWorkletNode extends FakeNode {
  static made: { name: string; node: FakeWorkletNode }[] = [];
  constructor(_ctx: unknown, name: string) { super(); FakeWorkletNode.made.push({ name, node: this }); }
}
class FakeContext {
  sampleRate = 48_000;
  currentTime = 0;
  destination = new FakeNode();
  audioWorklet = { addModule: async () => {} };
  async resume() {}
  async close() {}
  createMediaStreamSource() { return new FakeNode(); }
  createGain() { return new FakeNode(); }
}
const capture = () => [...FakeWorkletNode.made].reverse().find((m) => m.name === 'bitsov-call-capture')!.node;
const zeros = () => capture().port.onmessage?.({ data: { type: 'frame', pcm: new Float32Array(960) } });
/** A quiet room: a noise floor far below speech, never exact zero. */
const quiet = () => capture().port.onmessage?.({ data: { type: 'frame', pcm: new Float32Array(960).map((_, i) => (i % 7 - 3) * 1e-5) } });

beforeEach(() => {
  FakeWorkletNode.made = [];
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
});
afterEach(() => { vi.unstubAllGlobals(); });

async function engine() {
  const reports: boolean[] = [];
  const audio = createCallAudio({
    stream: { getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] } as unknown as MediaStream,
    transport: { send: () => {} },
    audioContext: () => new FakeContext() as unknown as AudioContext,
    workletUrl: 'worklet.js',
    opus: false,
    onSilence: (silent) => reports.push(silent),
  });
  await audio.ready;
  return { audio, reports };
}

describe('call audio: a silenced microphone', () => {
  it('reports silence after SILENT_FRAMES of exact zeros, and sound again at the first non-zero frame', async () => {
    const { reports } = await engine();
    for (let i = 0; i < SILENT_FRAMES - 1; i++) zeros();
    expect(reports).toEqual([]);
    zeros();
    expect(reports).toEqual([true]);
    zeros();
    expect(reports).toEqual([true]);
    quiet();
    expect(reports).toEqual([true, false]);
  });

  it('a quiet room or quiet speech is never silence', async () => {
    const { reports } = await engine();
    for (let i = 0; i < SILENT_FRAMES * 3; i++) quiet();
    expect(reports).toEqual([]);
  });

  it('zeros broken by any sound start counting again', async () => {
    const { reports } = await engine();
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < SILENT_FRAMES - 1; i++) zeros();
      quiet();
    }
    expect(reports).toEqual([]);
  });

  it('our own mute is no evidence', async () => {
    const { audio, reports } = await engine();
    audio.setMuted(true);
    for (let i = 0; i < SILENT_FRAMES * 2; i++) zeros();
    expect(reports).toEqual([]);
  });
});
