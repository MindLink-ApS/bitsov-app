import { t as tr } from '../i18n';
import type { CallView } from './call';
import { STOP_MESSAGE } from './callMinutes';

/**
 * Why a call ended, as one plain line for the ended card, and the host's or
 * node's own words (often protocol English) for Details only.
 *
 * Money is named only on money evidence: a budget or limit the node reported,
 * or the node's own `unpaid` end. A lost link, their box refusing a minute or
 * an unknown error never reads as "out of money".
 */
export type CallEndLine = { text: string; detail: string | null };

/** Transport closures the engine words technically; the card says the connection was lost instead. */
const TRANSPORT = ['caTheNodeMediaLinkClosed', 'caTheDirectConnectionClosed', 'caTheConnectionWasLostCheckThatBothAppsHave', 'caTheCallCouldNotConnect', 'caTheConnectionWasLost'] as const;

export function callEndLine(v: CallView, name: string): CallEndLine {
  const extra = (text: string, ...more: (string | null | undefined)[]): CallEndLine => {
    const detail = more.filter((m): m is string => !!m && m !== text).join(' ');
    return { text, detail: detail || null };
  };
  if (v.stuck) return { text: tr('uiACallToIsStillClosingAtYour', name), detail: null };
  const stop = v.minutes?.stop;
  // A limit the owner set: the evidence is the node's own limit code.
  const limit = stop?.limit?.code;
  if (limit === 'budget_exhausted') return extra(tr('caCallEndedContactLimit'), stop?.detail);
  if (limit === 'ceiling_exhausted') return extra(tr('caCallEndedTotalLimit'), stop?.detail);
  if (limit === 'grant_exhausted') return extra(tr('caCallEndedGrantLimit'), stop?.detail);
  // Their box refusing a minute, a price or hold change, an unknown result: the stop's own plain words.
  // A stop that appends the node's text to its plain sentence keeps only the sentence; the text goes under Details.
  if (stop) {
    const plain = STOP_MESSAGE[stop.code]();
    if (!stop.detail && stop.message !== plain && stop.message.startsWith(plain)) return extra(plain, stop.message.slice(plain.length).trim());
    return extra(stop.message, stop.detail);
  }
  switch (v.reason) {
    case 'declined': return extra(tr('callDeclined'), v.error);
    case 'busy': return extra(tr('callBusy'), v.error);
    case 'timeout': return extra(tr('callNoAnswer'), v.error);
    case 'hangup': return extra(tr('callHungUp'), v.error);
    case 'unpaid': return extra(v.error ?? tr('caCallEndedUnpaid'));
    case 'failed': {
      const transport = v.error === null || TRANSPORT.some((key) => tr(key) === v.error);
      if (!transport) return extra(v.error!);
      return extra(v.liveAt === null ? tr('caCallEndCouldNotConnect', name) : tr('caCallEndConnectionLost', name), v.error);
    }
    default: return extra(v.error ?? tr('callEnded'));
  }
}
