import { t as tr } from '../i18n';
import type { CallView } from './call';
import { STOP_MESSAGE } from './callMinutes';

/**
 * Why a call ended, as one plain line for the ended card, and the host's or
 * node's own words (often protocol English) for Details only.
 *
 * The line is worded from structured causes (the end reason, the minutes stop
 * code and limit code) in the current language, so changing the language
 * re-words it and never moves raw text out of Details. Money is named only on
 * money evidence: a budget or limit the node reported, or an `unpaid` end.
 */
export type CallEndLine = { text: string; detail: string | null };

const FREE_DECLINE = {
  sending: 'caDeclineFreeSending', delivered: 'caDeclineFreeDelivered', not_sent: 'caDeclineFreeNotSent', unknown: 'caDeclineFreeUnknown',
} as const;

export function callEndLine(v: CallView, name: string): CallEndLine {
  const extra = (text: string, ...more: (string | null | undefined)[]): CallEndLine => {
    const detail = more.filter((m): m is string => !!m && m !== text).join(' ');
    return { text, detail: detail || null };
  };
  if (v.stuck) return { text: tr('uiACallToIsStillClosingAtYour', name), detail: null };
  const stop = v.minutes?.stop;
  // Cut after the box approval ran out, on a node that does not keep the call: said as that, not as a minute or a link.
  if (v.budgetEnded) return extra(tr('caCallEndedBudgetRanOut'), stop?.raw);
  // A free Decline: only what is known of its delivery. It was never paid.
  if (v.reason === 'declined' && v.freeDecline) return extra(tr(FREE_DECLINE[v.freeDecline]), v.error);
  // A limit the owner set: the evidence is the node's own limit code.
  const limit = stop?.limit?.code;
  if (limit === 'budget_exhausted') return extra(tr('caCallEndedContactLimit'), stop?.raw);
  if (limit === 'ceiling_exhausted') return extra(tr('caCallEndedTotalLimit'), stop?.raw);
  if (limit === 'grant_exhausted') return extra(tr('caCallEndedGrantLimit'), stop?.raw);
  // Their box refusing a minute, a price or hold change, an unknown result: worded from the stop's code.
  if (stop) return extra(stop.theirBox ? tr('caMinutesTheirBoxStopped') : STOP_MESSAGE[stop.code](), stop.raw);
  // A sealed call that could not stay (or become) sealed: its own plain words, never "connection lost".
  if (v.errorKey) return extra(tr(v.errorKey));
  // An end without a reason that the engine worded: worded again now, with the host's own words under Details.
  if (v.endWords) return extra(v.endWords(), v.endRaw);
  switch (v.reason) {
    case 'declined': return extra(tr('callDeclined'), v.error);
    case 'busy': return extra(tr('callBusy'), v.error);
    case 'timeout': return extra(tr('callNoAnswer'), v.error);
    case 'hangup': return extra(tr('callHungUp'), v.error);
    // The node's own unpaid end: before the call went live, its first minute was not paid in time.
    case 'unpaid': return extra(v.liveAt === null ? tr('caMinutesNotPaidInTime') : tr('caCallEndedUnpaid'));
    // A connectivity end: the connection was lost, or never made. The engine's own words go under Details.
    case 'failed': return extra(v.liveAt === null ? tr('caCallEndCouldNotConnect', name) : tr('caCallEndConnectionLost', name), v.error);
    // An end nobody worded: a plain generic line; whatever was said goes under Details.
    default: return v.error === null ? extra(tr('callEnded')) : extra(tr('caCallEndStopped'), v.error);
  }
}
