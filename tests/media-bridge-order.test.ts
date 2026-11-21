import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostMediaBridge, MEDIA_ORDER_HEADER } from '../src/control/mediaBridge';

type Sent = { cmd: string; args: unknown; options?: { headers?: Record<string, string> } };

function stubHost(openGate?: Promise<void>) {
  const sent: Sent[] = [];
  let callbacks = 0;
  vi.stubGlobal('__TAURI_INTERNALS__', {
    transformCallback: () => ++callbacks,
    invoke: (cmd: string, args?: unknown, options?: Sent['options']) => {
      sent.push({ cmd, args, options });
      return cmd === 'call_media_open' && openGate ? openGate.then(() => null) : Promise.resolve(null);
    },
  });
  return {
    sends: () => sent.filter((s) => s.cmd === 'call_media_send'),
    counts: () => sent.filter((s) => s.cmd === 'call_media_send').map((s) => Number(s.options?.headers?.[MEDIA_ORDER_HEADER])),
    opens: () => sent.filter((s) => s.cmd === 'call_media_open').map((s) => s.args as Record<string, unknown>),
  };
}

afterEach(() => vi.unstubAllGlobals());

// The count is shared by every bridge the app makes, so these tests read it
// relative to the base each open passes rather than from zero.
describe('host media bridge uplink order', () => {
  it('numbers every send in the order it was handed over, from the base its open passed, raw bytes unchanged', async () => {
    const host = stubHost();
    const bridge = hostMediaBridge();
    await bridge.open('call-1', 'a'.repeat(64), () => {}, () => {});
    const base = host.opens()[0].send_base as number;
    const frames = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])];
    for (const frame of frames) bridge.send(frame);
    expect(host.sends().map((s) => s.args)).toEqual(frames);
    expect(host.counts()).toEqual([base, base + 1, base + 2]);
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
    const [first, second] = host.opens().map((args) => args.send_base as number);
    expect(host.counts()).toEqual([first, second]);
    expect(second).toBe(first + 1);
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
    const bases = host.opens().map((args) => args.send_base as number);
    expect(bases).toEqual([bases[0], bases[0] + 2, bases[0] + 3]);
    expect(host.counts()).toEqual([bases[0], bases[0] + 1, bases[0] + 2, bases[0] + 3]);
  });

  it('a new bridge for the next call keeps counting above every send of the bridge before it', async () => {
    const host = stubHost();
    const first = hostMediaBridge();
    await first.open('call-1', 'a'.repeat(64), () => {}, () => {});
    first.send(new Uint8Array([1]));
    first.send(new Uint8Array([2]));
    await first.close();
    // The app makes one bridge per connection: the next call's comes fresh.
    const next = hostMediaBridge();
    await next.open('call-2', 'b'.repeat(64), () => {}, () => {});
    const [, base] = host.opens().map((args) => args.send_base as number);
    expect(Math.max(...host.counts())).toBeLessThan(base);
  });

  it('a send made while the socket is still opening is not sent and takes no count, so the new call waits for no gap', async () => {
    let opened!: () => void;
    const host = stubHost(new Promise<void>((resolve) => { opened = resolve; }));
    const bridge = hostMediaBridge();
    const opening = bridge.open('call-1', 'a'.repeat(64), () => {}, () => {});
    bridge.send(new Uint8Array([0]));
    expect(host.sends()).toEqual([]);
    opened();
    await opening;
    bridge.send(new Uint8Array([1]));
    expect(host.counts()).toEqual([host.opens()[0].send_base]);
  });
});
