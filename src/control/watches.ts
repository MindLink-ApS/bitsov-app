import type { AssistantId } from './assistants';
export type WatchRule = 'locked' | 'offline' | 'channels' | 'money_ready' | 'balance_drop' | 'payment_failed' | 'unread';
export type WatchNotice = { at: number; rule: WatchRule; text: string };
export type WatchUpdate = { revision: string; notices: WatchNotice[] | null };
export type WatchUpdates = Partial<Record<AssistantId, WatchUpdate>>;
export type WatchSample = { locked?: boolean; offline?: boolean; money_ready?: boolean; channels?: number;
  balance_msat?: number; payment_failures?: number; unread?: number };
export type WatchSamples = Partial<Record<AssistantId, WatchSample>>;
export const WATCHES: Record<AssistantId, { rule: WatchRule; label: string }[]> = {
  node: [{ rule: 'locked', label: 'Locked for more than 5 minutes' }, { rule: 'offline', label: 'Offline for more than 5 minutes' },
    { rule: 'channels', label: 'Channel count changed' }, { rule: 'money_ready', label: 'Money not ready' }],
  wallet: [{ rule: 'balance_drop', label: 'Balance dropped by more than 1,000 sats' }, { rule: 'payment_failed', label: 'Payment failed' }],
  inbox: [{ rule: 'unread', label: 'Unread count rose' }],
};
/** Counts/status only, from existing reads. No bodies, labels, IDs, or action objects. */
export function watchSamples(input: { ready: boolean; locked: boolean; overview: { money_ready?: boolean | null } | null;
  wallet: { balance_msat: number; channels: unknown[] } | null; unread: Record<string, number>; paymentFailures: number }): WatchSamples {
  const fresh = input.ready && !input.locked;
  return {
    node: { locked: input.locked, offline: !input.ready && !input.locked,
      ...(fresh && input.overview?.money_ready != null ? { money_ready: input.overview.money_ready } : {}),
      ...(fresh && input.wallet ? { channels: input.wallet.channels.length } : {}) },
    wallet: { ...(fresh && input.wallet ? { balance_msat: input.wallet.balance_msat } : {}), payment_failures: input.paymentFailures },
    inbox: { unread: Object.values(input.unread).reduce((sum, n) => sum + n, 0) },
  };
}
/** Driven by the existing status poll; owns no timer, transport, or action source. */
export function watchPoller<T>(invoke: (samples: WatchSamples) => Promise<T>, receive: (value: T) => void) {
  let closed = false;
  let pending = false;
  return {
    async tick(open: boolean, samples: WatchSamples) {
      if (closed || !open || pending) return;
      pending = true;
      try { const result = await invoke(samples); if (!closed) receive(result); }
      finally { pending = false; }
    },
    close() { closed = true; },
  };
}

/** Node status remains observable while the locked screen has unmounted the shell. */
export function statusWatchSamples(ready: boolean, locked: boolean, cached: WatchSamples): WatchSamples {
  return {
    node: { ...(ready && !locked ? cached.node : {}), locked, offline: !ready && !locked },
    wallet: ready && !locked ? cached.wallet ?? {} : {},
    inbox: ready && !locked ? cached.inbox ?? {} : {},
  };
}
export async function pollWatchBatch(source: { aiWatchPoll(a: AssistantId, sample: WatchSample, revision: string | null): Promise<WatchUpdate | null> },
  samples: WatchSamples, revisions: Partial<Record<AssistantId, string>>) {
  const updates: WatchUpdates = {};
  const settled = await Promise.allSettled((Object.keys(samples) as AssistantId[]).map(async id => {
    const update = await source.aiWatchPoll(id, samples[id]!, revisions[id] ?? null);
    if (update) { revisions[id] = update.revision; if (update.notices) updates[id] = update; }
  }));
  return { updates, failed: settled.some(r => r.status === 'rejected') };
}
