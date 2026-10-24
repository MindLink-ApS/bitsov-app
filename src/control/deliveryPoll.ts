import type { LiveEvent } from './types';

/** Read-only recovery for delivery events missed during a remote WS outage. */
export function deliveryPoller(deps: {
  read: (operationId: string, messageId: string) => Promise<LiveEvent | null>;
  apply: (event: Extract<LiveEvent, { type: 'delivery' }>) => void;
  connected: () => boolean;
  active: () => boolean;
}) {
  const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; until: number; reads: number; catchUp: boolean }>();
  const confirm = (id: string) => {
    const entry = pending.get(id);
    if (entry) clearTimeout(entry.timer);
    pending.delete(id);
  };
  return {
    confirm,
    catchUp() { for (const entry of pending.values()) entry.catchUp = true; },
    watch(operationId: string, messageId: string) {
      if (pending.has(messageId)) return;
      // Bound memory and queued work as well as each operation's lifetime.
      if (pending.size >= 32) confirm(pending.keys().next().value!);
      const entry = { timer: undefined as unknown as ReturnType<typeof setTimeout>, until: Date.now() + 60000, reads: 0, catchUp: false };
      const current = () => pending.get(messageId) === entry;
      const tick = async () => {
        if (!current()) return;
        if (Date.now() >= entry.until || entry.reads >= 12) { confirm(messageId); return; }
        // One initial check closes the receipt/subscription race even on an
        // open link. Further checks are only needed while events are unavailable.
        if (deps.active() && (entry.reads === 0 || entry.catchUp || !deps.connected())) {
          entry.reads++;
          entry.catchUp = false;
          try {
            const event = await deps.read(operationId, messageId);
            if (!current()) return;
            if (Date.now() < entry.until && event?.type === 'delivery' && event.message_id === messageId &&
                (event.status === 'delivered' || event.status === 'rejected')) {
              confirm(messageId);
              deps.apply(event);
              return;
            }
          } catch { /* No evidence: retain sent/queued, never retry a payment. */ }
        }
        if (current()) entry.timer = setTimeout(() => void tick(), 5000);
      };
      pending.set(messageId, entry);
      entry.timer = setTimeout(() => void tick(), 1000);
    },
    stop() { for (const id of pending.keys()) confirm(id); },
  };
}
