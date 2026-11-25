/**
 * M6 P3: a plain-text record of one ended call, for the owner to copy and
 * paste next to the node's journal. Display only: it reads the call view the
 * app already holds and asks the host for nothing.
 *
 * Every value is shape-checked and written as "unknown" otherwise, so an odd
 * string in the state never reaches the clipboard. Error messages, endpoints,
 * tickets, keys, invoices and preimages are never part of it. The lines are
 * the app's own figures, not the node's: amounts are receipt ceilings and the
 * node's reservation as last read.
 */
import { version as packageVersion } from '../../package.json';
import type { CallView } from './call';
import { audioStatsLines, type AudioStatRow } from './callAudioStats';

const UNKNOWN = 'unknown';
const CALL_ID = /^[0-9a-f]{32}$/;
const NODE_ID = /^[0-9a-f]{64}$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
/** Times outside 2020..2100 are not a real clock reading. */
const MIN_MS = Date.UTC(2020, 0, 1);
const MAX_MS = Date.UTC(2100, 0, 1);
const HANGUP_REASONS = new Set(['hangup', 'declined', 'busy', 'timeout', 'failed', 'unpaid']);
const STOP_CODES = new Set(['unpaid', 'node_ended', 'payment_failed', 'budget_limit', 'payment_unknown', 'price_changed', 'hold_refused']);
const PAYMENT_STOPS = new Set(['payment_failed', 'budget_limit', 'payment_unknown', 'price_changed', 'hold_refused']);

const msat = (n: unknown) => (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? String(n) : UNKNOWN);
const count = msat;
const time = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n >= MIN_MS && n < MAX_MS ? new Date(n).toISOString() : null);
const CODECS = new Set(['opus', 'mulaw']);
/** Codecs as a list in the order first used; "none" when the engine sent or heard no audio. */
const codecs = (list: unknown) => {
  if (!Array.isArray(list)) return UNKNOWN;
  const named = list.filter((c): c is string => typeof c === 'string' && CODECS.has(c));
  return named.length === list.length ? (named.length ? named.join(',') : 'none') : UNKNOWN;
};
const rate = (n: unknown) => (typeof n === 'number' && Number.isInteger(n) && n >= 8_000 && n <= 384_000 ? String(n) : UNKNOWN);
const pick = (value: unknown, allowed: Set<string>) => (typeof value === 'string' && allowed.has(value) ? value : null);
/** The peer's node id, shortened (first and last 8 hex), never the full key. */
const shortNode = (id: unknown) => (typeof id === 'string' && NODE_ID.test(id) ? `${id.slice(0, 8)}…${id.slice(-8)}` : UNKNOWN);

export const appVersion = (v: unknown = packageVersion) => (typeof v === 'string' && VERSION.test(v) ? v : UNKNOWN);

/**
 * Why the call ended, from the app's own state: a payment stop first (its
 * code, never its message), then the node's paid-duration cap (every minute
 * of the hold paid), then the hangup reason.
 */
export function endReason(view: CallView): string {
  const stop = pick(view.minutes?.stop?.code, STOP_CODES);
  const reason = pick(view.reason, HANGUP_REASONS);
  if (stop && PAYMENT_STOPS.has(stop)) return stop;
  const hold = view.minutes?.reservation;
  const cap = hold?.max_call_minutes;
  const blocks = view.minutes?.blocks;
  if (typeof cap === 'number' && Number.isSafeInteger(cap) && cap > 0 && typeof blocks === 'number' && blocks >= cap) return 'duration_cap';
  if (stop === 'unpaid' || reason === 'unpaid') return 'unpaid';
  if (stop === 'node_ended') return 'node_ended';
  return reason ?? UNKNOWN;
}

export type CallReportInput = {
  view: CallView;
  /** M6: audio went through both nodes. */
  routed: boolean;
  /** When this device showed the call as ended (app clock). */
  endedAt: number | null;
  version?: unknown;
  /** Local per-5 s audio figures for this call, if the app kept any (numbers only). */
  audioRows?: readonly AudioStatRow[];
};

/** The report, line by line, in a fixed order. Keys stay English so it lines up with the node's journal. */
export function callReportLines({ view, routed, endedAt, version, audioRows }: CallReportInput): string[] {
  const m = view.minutes;
  const hold = m?.reservation ?? null;
  const start = time(view.liveAt);
  const end = time(endedAt);
  const duration = start && end && endedAt! >= view.liveAt! ? String(Math.round((endedAt! - view.liveAt!) / 1000)) : UNKNOWN;
  const closed = hold ? (hold.closed === true ? 'yes' : hold.closed === false ? 'no' : UNKNOWN) : UNKNOWN;
  return [
    'BitSov call report',
    'app record; compare with the node journal',
    `app_version: ${appVersion(version)}`,
    `call_id: ${typeof view.callId === 'string' && CALL_ID.test(view.callId) ? view.callId : UNKNOWN}`,
    // The node may name this call by another id; the app holds none of its own for it.
    `node_call_id: ${UNKNOWN}`,
    `direction: ${view.outgoing === true ? 'outgoing' : view.outgoing === false ? 'incoming' : UNKNOWN}`,
    `peer: ${shortNode(view.peer)}`,
    `media: ${view.media === 'audio' || view.media === 'video' ? view.media : UNKNOWN}`,
    `media_path: ${routed ? 'node-routed' : 'app-to-app'}`,
    // Which codec carried the audio (Opus, or the mu-law fallback), and the audio context's rate.
    `audio_codec_sent: ${view.audio ? codecs(view.audio.sent) : UNKNOWN}`,
    `audio_codec_received: ${view.audio ? codecs(view.audio.received) : UNKNOWN}`,
    `audio_context_hz: ${view.audio ? rate(view.audio.contextRate) : UNKNOWN}`,
    'clock: this device',
    `start_time: ${start ?? UNKNOWN}`,
    `end_time: ${end ?? UNKNOWN}`,
    `duration_s: ${duration}`,
    `end_reason: ${view.phase === 'ended' ? endReason(view) : UNKNOWN}`,
    `hangup_reason: ${pick(view.reason, HANGUP_REASONS) ?? UNKNOWN}`,
    `minutes_stop: ${pick(m?.stop?.code, STOP_CODES) ?? 'none'}`,
    // The offer's own receipt is folded into the signal total; the app keeps no separate figure for it.
    `offer_receipt_msat: ${UNKNOWN}`,
    `signal_receipts_up_to_msat: ${msat(view.paidMsat)}`,
    `blocks_paid: ${m ? count(m.blocks) : UNKNOWN}`,
    'block_receipts: count and sum only; seq, amount and time of each are in the node journal',
    `sum_of_receipts_msat: ${m ? msat(m.receiptsMsat) : UNKNOWN}`,
    `reserved_msat: ${hold ? msat(hold.reserved_msat) : UNKNOWN}`,
    `spent_msat: ${hold ? msat(hold.spent_msat) : UNKNOWN}`,
    `released_msat: ${hold ? msat(hold.released_msat) : UNKNOWN}`,
    `still_held_msat: ${hold ? msat(hold.remaining_msat) : UNKNOWN}`,
    `reservation_closed: ${closed}`,
    `max_call_minutes: ${hold ? count(hold.max_call_minutes) : UNKNOWN}`,
    ...audioStatsLines(audioRows ?? []),
  ];
}

export const callReport = (input: CallReportInput) => callReportLines(input).join('\n');
