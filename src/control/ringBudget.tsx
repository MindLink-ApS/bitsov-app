/**
 * Display only: before Ring, say plainly when the box's budget for this
 * contact cannot hold the call.
 *
 * The node grant's per-contact remainder comes from the host's grant summary
 * (`recipient_left_msat_by_recipient`, lower-case keys; a contact without its
 * own budget is absent). The most a call may hold is the quote's reservation
 * ceiling (240 minutes at the shown per-minute price plus routing) plus the
 * offer. The node's own call limit is not known before Ring, so the line says
 * the box *may* turn the call down.
 *
 * Nothing here is sent anywhere or gates anything: Ring stays enabled and the
 * node remains the authority. An unknown remainder, an expired grant or a
 * quote without a ceiling shows nothing.
 */
import { Show } from 'solid-js';
import { t as tr } from '../i18n';
import { amount as fmtAmount } from './format';
import type { CallQuote, NodeGrantSummary } from './types';

export type RingBudgetShort = { leftMsat: number; holdMsat: number };

/** The most this call may hold, as shown before Ring (display only); null without a ceiling. */
export function callHoldCeilingMsat(q: CallQuote | null): number | null {
  if (!q || q.reservation_max_msat == null || q.offer_msat == null) return null;
  return q.reservation_max_msat + q.offer_msat + q.offer_max_routing_fee_msat;
}

/** The contact's remainder and the call's ceiling when the ceiling is higher; otherwise null. */
export function ringBudgetShort(grant: NodeGrantSummary | null, peer: string, q: CallQuote | null, now: number): RingBudgetShort | null {
  if (!grant || grant.expires_at_ms <= now) return null;
  const left = grant.recipient_left_msat_by_recipient?.[peer.toLowerCase()];
  if (typeof left !== 'number' || !Number.isFinite(left) || left < 0) return null;
  const hold = callHoldCeilingMsat(q);
  if (hold === null || hold <= left) return null;
  return { leftMsat: left, holdMsat: hold };
}

export const ringBudgetText = (name: string, s: RingBudgetShort) =>
  tr('uiRingContactBudgetShort', fmtAmount(s.leftMsat), name, fmtAmount(s.holdMsat));

/** The warning line in the call confirm; renders nothing unless the ceiling is above the remainder. */
export function RingBudgetNote(props: { grant: NodeGrantSummary | null; peer: string; name: string; quote: CallQuote | null; now?: number }) {
  const short = () => ringBudgetShort(props.grant, props.peer, props.quote, props.now ?? Date.now());
  return (
    <Show when={short()}>
      {(s) => <p class="hint" role="note" data-call-contact-budget-short>{ringBudgetText(props.name, s())}</p>}
    </Show>
  );
}
