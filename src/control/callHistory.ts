import { CALL_ANSWER, CALL_HANGUP, CALL_OFFER, isCallTrafficKind, restartParent, type CallMedia } from './call';
import type { Message } from './types';

/**
 * Call control is never chat: the signals and paid minutes (kinds 400–404),
 * and any payload that names a call (`{"call_id":…}`, such as a minute
 * receipt an older app stored as an ordinary message).
 */
export function isCallControlMessage(m: Pick<Message, 'kind' | 'plaintext'>): boolean {
  if (isCallTrafficKind(m.kind)) return true;
  return callIdOf(m.plaintext) !== null;
}

function parse(plaintext: string | null): Record<string, unknown> | null {
  const text = plaintext?.trim();
  if (!text || text[0] !== '{') return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function callIdOf(plaintext: string | null): string | null {
  const value = parse(plaintext);
  return value && typeof value.call_id === 'string' ? value.call_id : null;
}

/** One line in the chat for one call: its kind and, when both ends are known, how long it ran. */
export type CallLine = { id: string; at: number; type: 'call-line'; callId: string; media: CallMedia; minutes: number | null };

/**
 * One line per call from a thread's call traffic. A recovery offer counts as
 * its parent call. Duration only from an answer and an end both in the thread;
 * no cost is claimed here (the history does not carry a settled amount).
 */
export function callLines(messages: Message[], skip: (callId: string) => boolean = () => false): CallLine[] {
  const parent = new Map<string, string>();
  const calls = new Map<string, { at: number; media: CallMedia; answeredAt: number | null; endedAt: number | null }>();
  const sorted = [...messages].filter(isCallControlMessage).sort((a, b) => a.timestamp - b.timestamp);
  for (const m of sorted) {
    const value = parse(m.plaintext);
    const raw = value && typeof value.call_id === 'string' ? value.call_id : null;
    if (!raw) continue;
    if (m.kind === CALL_OFFER && typeof value!.sdp === 'string') {
      const of = restartParent(value!.sdp);
      if (of) parent.set(raw, parent.get(of) ?? of);
    }
    const id = parent.get(raw) ?? raw;
    let call = calls.get(id);
    if (!call) {
      call = { at: m.timestamp, media: 'audio', answeredAt: null, endedAt: null };
      calls.set(id, call);
    }
    if (m.kind === CALL_OFFER && value!.media === 'video' && id === raw) call.media = 'video';
    if (m.kind === CALL_ANSWER && call.answeredAt === null) call.answeredAt = m.timestamp;
    if (m.kind === CALL_HANGUP) call.endedAt = m.timestamp;
  }
  const out: CallLine[] = [];
  for (const [callId, c] of calls) {
    if (skip(callId)) continue;
    const ran = c.answeredAt !== null && c.endedAt !== null && c.endedAt > c.answeredAt ? Math.round((c.endedAt - c.answeredAt) / 60_000) : null;
    out.push({ id: `call-line:${callId}`, at: c.at, type: 'call-line', callId, media: c.media, minutes: ran !== null && ran >= 1 ? ran : null });
  }
  return out;
}
