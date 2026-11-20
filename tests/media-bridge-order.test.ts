import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostMediaBridge, MEDIA_ORDER_HEADER } from '../src/control/mediaBridge';

type Sent = { cmd: string; args: unknown; options?: { headers?: Record<string, string> } };

function stubHost() {
  const sent: Sent[] = [];
  let callbacks = 0;
  vi.stubGlobal('__TAURI_INTERNALS__', {
    transformCallback: () => ++callbacks,
    invoke: (cmd: string, args?: unknown, options?: Sent['options']) => {
      sent.push({ cmd, args, options });
      return Promise.resolve(null);
    },
  });
  return {
    sends: () => sent.filter((s) => s.cmd === 'call_media_send'),
    opens: () => sent.filter((s) => s.cmd === 'call_media_open').map((s) => s.args as Record<string, unknown>),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('host media bridge uplink order', () => {
  it('numbers every send in the order it was handed over, raw bytes unchanged', async () => {
    const host = stubHost();
    const bridge = hostMediaBridge();
    await bridge.open('call-1', 'a'.repeat(64), () => {}, () => {});
    const frames = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])];
    for (const frame of frames) bridge.send(frame);
    const sends = host.sends();
    expect(sends.map((s) => s.args)).toEqual(frames);
    expect(sends.map((s) => s.options?.headers?.[MEDIA_ORDER_HEADER])).toEqual(['0', '1', '2']);
  });

  it('keeps counting across a new socket, so a late send from the old one counts lower', async () => {
    const host = stubHost();
    const bridge = hostMediaBridge();
    await bridge.open('call-1', 'a'.repeat(64), () => {}, () => {});
    bridge.send(new Uint8Array([1]));
    await bridge.close();
    bridge.send(new Uint8Array([9]));
    await bridge.open('call-1', 'a'.repeat(64), () => {}, () => {});
    bridge.send(new Uint8Array([2]));
    expect(host.sends().map((s) => s.options?.headers?.[MEDIA_ORDER_HEADER])).toEqual(['0', '1']);
  });

  it('passes its current count to each open, and the count never resets', async () => {
    const host = stubHost();
    const bridge = hostMediaBridge();
    await bridge.open('call-1', 'a'.repeat(64), () => {}, () => {});
    bridge.send(new Uint8Array([1]));
    bridge.send(new Uint8Array([2]));
    await bridge.close();
    await bridge.open('call-2', 'b'.repeat(64), () => {}, () => {});
    bridge.send(new Uint8Array([3]));
    await bridge.close();
    await bridge.open('call-2', 'b'.repeat(64), () => {}, () => {});
    bridge.send(new Uint8Array([4]));
    expect(host.opens().map((args) => args.send_base)).toEqual([0, 2, 3]);
    expect(host.sends().map((s) => s.options?.headers?.[MEDIA_ORDER_HEADER])).toEqual(['0', '1', '2', '3']);
  });
});
