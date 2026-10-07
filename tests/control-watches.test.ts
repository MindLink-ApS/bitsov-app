import { hostSource } from '../src/control/source';
import { afterEach, expect, it, vi } from 'vitest';
import { pollWatchBatch, statusWatchSamples, watchPoller, watchSamples } from '../src/control/watches';

it('projects only role-allowlisted scalars, never bodies, identities or action data', () => {
  const samples = watchSamples({ ready: true, locked: false, overview: { money_ready: false },
    wallet: { balance_msat: 9000000, channels: [{ channel_id: 'secret' }] }, unread: { 'peer:secret': 2 }, paymentFailures: 1 });
  expect(samples).toEqual({ node: { locked: false, offline: false, money_ready: false, channels: 1 },
    wallet: { balance_msat: 9000000, payment_failures: 1 }, inbox: { unread: 2 } });
  expect(JSON.stringify(samples)).not.toContain('secret');
  expect(watchSamples({ ready: false, locked: true, overview: { money_ready: false }, wallet: { balance_msat: 8, channels: [] }, unread: {}, paymentFailures: 0 }).wallet!.balance_msat).toBeUndefined();
});

it('polls only when ticked and open, coalesces in-flight polls, ignores late results after close', async () => {
  let resolve!: (value: unknown) => void;
  const invoke = vi.fn(() => new Promise(done => { resolve = done; }));
  const receive = vi.fn();
  const poller = watchPoller(invoke, receive);
  await poller.tick(false, {});
  expect(invoke).not.toHaveBeenCalled();
  const pending = poller.tick(true, { inbox: { unread: 2 } });
  await poller.tick(true, { inbox: { unread: 3 } });
  expect(invoke).toHaveBeenCalledTimes(1);
  poller.close();
  resolve({ inbox: [] });
  await pending;
  await poller.tick(true, { inbox: { unread: 4 } });
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(receive).not.toHaveBeenCalled();
});


afterEach(() => vi.unstubAllGlobals());
it('watch transport calls only the guarded data operation, never reads, models, spend or send', async () => {
  const calls: { command: string; args: unknown }[] = [];
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args: unknown) => {
    calls.push({ command, args });
    return { revision: 'generation', notices: [] };
  } });
  const revisions = {};
  await pollWatchBatch(hostSource, statusWatchSamples(false, true, {}), revisions);
  expect(calls).toEqual(['node', 'wallet', 'inbox'].map(assistant => ({ command: 'ai_read', args: {
    assistant, watch: { revision: null, sample: assistant === 'node' ? { locked: true, offline: false } : {} },
  } })));
  expect(revisions).toEqual({ node: 'generation', wallet: 'generation', inbox: 'generation' });
});

it('one unavailable thread cannot discard another assistant’s successfully saved notice', async () => {
  const update = { revision: 'new', notices: [{ at: 10, rule: 'unread' as const, text: 'Unread count rose.' }] };
  const result = await pollWatchBatch({ aiWatchPoll: async a => {
    if (a === 'node') throw new Error('Sealing failed');
    return update;
  } }, { node: {}, inbox: { unread: 3 } }, {});
  expect(result.failed).toBe(true);
  expect(result.updates.inbox).toEqual(update);
});
