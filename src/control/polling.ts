import { untrack } from 'solid-js';
import type { Source } from './source';

// Only reads used by background refreshes. Money actions retain their original
// dispatch path and are never queued, coalesced or automatically retried here.
const reads = new Set<keyof Source>([
  'nodeOverview', 'peers', 'rooms', 'roomMembers', 'messages', 'roomThread',
  'wallet', 'priceQuote', 'spendStatus', 'budgetStatus', 'deviceKeyStatus',
  'energy', 'membrane', 'fundState', 'invoiceStatus', 'filePrice', 'roomQuote', 'callQuote',
]);

/** Share two read slots across panels, including nested/multi-span reads. */
export function pollingSource(get: () => Source, live: () => boolean, enabled: () => boolean = () => true) {
  let running = 0;
  let closed = false;
  const waiting: { run: () => void; cancel: () => void }[] = [];
  const pending = new Map<string, Promise<unknown>>();
  const pump = () => untrack(() => {
    while (!closed && live() && running < 2 && waiting.length) waiting.shift()!.run();
  });
  const source = new Proxy({} as Source, {
    get(_target, key: keyof Source) {
      const target = get();
      const value = target[key];
      if (typeof value !== 'function') return value;
      if (!reads.has(key) || !enabled()) return value.bind(target);
      return (...args: unknown[]) => {
        const id = JSON.stringify([key, ...args]);
        const existing = pending.get(id);
        if (existing) return existing;
        if (closed) return Promise.reject(new Error('Shell closed'));
        const result = new Promise<unknown>((resolve, reject) => {
          waiting.push({
            cancel: () => reject(new Error('Shell closed')),
            run: () => {
              // A refresh after a mutation must not reuse an in-flight snapshot.
              // Only calls still waiting to start can share the same read.
              pending.delete(id);
              running++;
              const finish = () => { running--; pump(); };
              try {
                Promise.resolve(Reflect.apply(value, target, args)).then(
                  value => { finish(); resolve(value); },
                  error => { finish(); reject(error); },
                );
              } catch (error) { finish(); reject(error); }
            },
          });
        });
        pending.set(id, result);
        pump();
        return result;
      };
    },
  });
  return {
    source,
    resume: pump,
    close: () => { closed = true; waiting.splice(0).forEach(job => job.cancel()); },
  };
}
