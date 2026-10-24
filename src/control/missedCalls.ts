import { createEffect, createSignal, on } from 'solid-js';
import type { CallMedia } from './call';

export type MissedCall = { id: string; callId: string; peer: string; at: number; media: CallMedia; type: 'missed-call'; unread: boolean };

/** Local call history, scoped to the paired node. Never contains SDP or media. */
export function createMissedCalls(owner: () => string) {
  const [records, setRecords] = createSignal<MissedCall[]>([]);
  let scope = '';
  const key = () => `bitsov.missed-calls.${scope}`;
  const save = () => { if (scope) try { localStorage.setItem(key(), JSON.stringify(records())); } catch { /* Keep session history. */ } };
  createEffect(on(owner, id => {
    scope = id.toLowerCase();
    let rows: MissedCall[] = [];
    try {
      const stored: unknown = scope ? JSON.parse(localStorage.getItem(key()) ?? '[]') : [];
      if (Array.isArray(stored)) rows = stored.filter((r): r is MissedCall => r && r.type === 'missed-call' &&
        typeof r.id === 'string' && typeof r.callId === 'string' && typeof r.peer === 'string' &&
        Number.isFinite(r.at) && ['audio', 'video'].includes(r.media) && typeof r.unread === 'boolean');
    } catch { /* A damaged local record must not block incoming calls. */ }
    setRecords(rows);
  }));
  return {
    records,
    add(call: { callId: string; peer: string; at: number; media: CallMedia }, visible = false) {
      if (records().some(r => r.callId === call.callId && r.peer === call.peer)) return;
      setRecords(rows => [...rows, { ...call, id: `missed:${call.peer}:${call.callId}`, type: 'missed-call', unread: !visible }]);
      save();
    },
    read(peer: string) {
      setRecords(rows => rows.map(r => r.peer === peer && r.unread ? { ...r, unread: false } : r));
      save();
    },
    unread() {
      const counts: Record<string, number> = {};
      for (const r of records()) if (r.unread) counts[`peer:${r.peer}`] = (counts[`peer:${r.peer}`] ?? 0) + 1;
      return counts;
    },
  };
}
