import { describe, expect, it } from 'vitest';
import { pollingSource } from '../src/control/polling';
import { sampleSource } from '../src/control/sample';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

describe('remote read queue', () => {
  it('a refresh after a mutation never adopts a snapshot already in flight', async () => {
    const old = deferred<Awaited<ReturnType<ReturnType<typeof sampleSource>['wallet']>>>();
    const source = sampleSource();
    const wallet = await source.wallet();
    let calls = 0;
    source.wallet = () => ++calls === 1 ? old.promise : Promise.resolve({ ...wallet, balance_msat: 42 });
    const queue = pollingSource(() => source, () => true);
    const before = queue.source.wallet();
    const after = queue.source.wallet();
    expect((await after).balance_msat).toBe(42);
    old.resolve({ ...wallet, balance_msat: 1 });
    expect((await before).balance_msat).toBe(1);
    queue.close();
  });

  it('holds queued reads during a cooldown and bounds quotes as well as panels', async () => {
    const source = sampleSource();
    const wallet = await source.wallet();
    const first = deferred<typeof wallet>();
    const second = deferred<typeof wallet>();
    let live = true;
    let calls = 0;
    source.wallet = () => ++calls === 1 ? first.promise : second.promise;
    const queue = pollingSource(() => source, () => live);
    const a = queue.source.wallet();
    const b = queue.source.wallet();
    let quoteDone = false;
    const quote = queue.source.filePrice().then(value => { quoteDone = true; return value; });
    live = false;
    first.resolve(wallet); second.resolve(wallet);
    await Promise.all([a, b]);
    expect(quoteDone).toBe(false);
    live = true;
    queue.resume();
    expect((await quote).total_msat).toBeGreaterThan(0);
    queue.close();
  });
});
