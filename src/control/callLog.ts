import { createEffect, createSignal, on } from 'solid-js';
import type { CallMedia, CallView } from './call';

export type CallLogOutcome = 'connected' | 'no_answer' | 'declined' | 'busy' | 'ended_early' | 'failed' | 'not_through' | 'you_declined';
export type CallLogRecord = {
  id: string; callId: string | null; peer: string; at: number; media: CallMedia; type: 'call-log';
  direction: 'in' | 'out'; outcome: CallLogOutcome; durationMs?: number;
};

const OUTCOMES: readonly string[] = ['connected', 'no_answer', 'declined', 'busy', 'ended_early', 'failed', 'not_through', 'you_declined'];
const KEEP = 500;

/**
 * What an ended call adds to its chat, read from the call's own view. It says
 * what happened to the call and nothing about money: amounts belong to the
 * ledger. A missed incoming call has its own record (`missedCalls`); one you
 * accepted that never connected is logged here.
 */
export function callLogEntry(prev: CallView, next: CallView, now: number): Omit<CallLogRecord, 'id' | 'type'> | null {
  if (next.phase !== 'ended' || !next.peer) return null;
  if (prev.phase === 'ended' && (next.callId !== null || (prev.error === next.error && prev.peer === next.peer))) return null;
  const base = { callId: next.callId, peer: next.peer.toLowerCase(), at: now, media: next.media };
  // Refused before any call existed: the card said why.
  if (prev.phase === 'idle' || prev.phase === 'ended') return next.error ? { ...base, direction: 'out', outcome: 'not_through' } : null;
  const direction = prev.outgoing ? 'out' : 'in';
  if (prev.liveAt !== null) return { ...base, direction, outcome: 'connected', durationMs: Math.max(0, now - prev.liveAt) };
  if (direction === 'in') {
    // Still ringing: only your own decline; a missed call has its own record.
    if (prev.phase === 'incoming') return next.reason === 'declined' ? { ...base, direction, outcome: 'you_declined' } : null;
    // Accepted, then it never connected: a refusal said why, anything else could not connect.
    return { ...base, direction, outcome: next.reason === null && next.error ? 'not_through' : 'failed' };
  }
  if (next.reason === 'declined') return { ...base, direction, outcome: 'declined' };
  if (next.reason === 'busy') return { ...base, direction, outcome: 'busy' };
  if (next.reason === 'timeout') return { ...base, direction, outcome: 'no_answer' };
  if (next.reason === 'hangup') return { ...base, direction, outcome: 'ended_early' };
  if (next.reason === null && next.error) return { ...base, direction, outcome: 'not_through' };
  return { ...base, direction, outcome: 'failed' };
}

/** This device's record of calls, scoped to the paired node. Never contains SDP, media or amounts. */
export function createCallLog(owner: () => string) {
  const [records, setRecords] = createSignal<CallLogRecord[]>([]);
  let scope = '';
  const key = () => `bitsov.call-log.${scope}`;
  const save = () => { if (scope) try { localStorage.setItem(key(), JSON.stringify(records())); } catch { /* Keep session history. */ } };
  createEffect(on(owner, id => {
    scope = id.toLowerCase();
    let rows: CallLogRecord[] = [];
    try {
      const stored: unknown = scope ? JSON.parse(localStorage.getItem(key()) ?? '[]') : [];
      if (Array.isArray(stored)) rows = stored.filter((r): r is CallLogRecord => r && r.type === 'call-log' &&
        typeof r.id === 'string' && typeof r.peer === 'string' && Number.isFinite(r.at) &&
        ['audio', 'video'].includes(r.media) && ['in', 'out'].includes(r.direction) && OUTCOMES.includes(r.outcome));
    } catch { /* A damaged local record must not block calls. */ }
    setRecords(rows);
  }));
  return {
    records,
    add(entry: Omit<CallLogRecord, 'id' | 'type'>) {
      const id = `call-log:${entry.peer}:${entry.callId ?? entry.at}`;
      if (records().some(r => r.id === id)) return;
      setRecords(rows => [...rows, { ...entry, id, type: 'call-log' as const }].slice(-KEEP));
      save();
    },
  };
}
