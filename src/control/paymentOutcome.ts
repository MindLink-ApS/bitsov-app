/**
 * Host error codes proving that this attempt did not dispatch payment.
 * Preflight failures and proven node refusals share this classification with
 * the shell tally and deferred call cleanup. Call-rule refusals depend on
 * money_post_with's HTTP/kind/room checks and fresh-operation/retry guard.
 * Unknown codes stay uncertain, including transport failures, paid delivery
 * errors, budget_unreadable, and app_not_ready after accounting fails.
 */
const PROVEN_UNPAID = new Set([
  'owner_only', 'owner_contact_unavailable', 'owner_contact_expired', 'sponsor_owner_approval_required',
  'price_changed', 'price_cap_unavailable', 'price_quote_unavailable', 'peer_not_ready', 'room_unreachable', 'invalid', 'retry_unavailable',
  'spend_refused', 'not_ready', 'not_dispatched', 'price_cap_exceeded', 'readmission_capped', 'readmission_quoted', 'operation_mismatch', 'retry_needs_admission',
  'call_id_used', 'call_busy', 'call_signal_in_flight', 'call_signal_invalid', 'call_not_live',
  'grant_ended', 'grant_per_call', 'grant_exhausted', 'grant_recipient', 'grant_unpriced', 'grant_paused', 'grant_failures_pending', 'grant_rate_limited',
  'grant_velocity', 'grant_ledger', 'grant_refused', 'grant_first_contact', 'grant_readmission', 'grant_no_envelope', 'grant_unknown', 'grant_messaging',
  'spend_locked', 'spend_expired', 'budget_needed', 'budget_paused', 'budget_exhausted', 'ceiling_exhausted', 'budget_ledger_full', 'first_contact',
  'call_needs_node_upgrade', 'call_admission_open', 'call_identity_changed',
  // M6 call minutes: refused by the host before paying, or by the node under its grant / not dispatched.
  'call_block_not_due', 'call_reservation_closed', 'call_price_changed', 'call_liquidity_insufficient', 'call_liquidity_unavailable',
  'call_no_consent', 'call_no_reservation', 'call_hold_above_consent', 'call_hold_unconfirmed', 'call_hold_changed', 'call_minutes_unpayable',
  'call_offer_price_above_consent', 'call_offer_hold_above_consent', 'call_hangup_unpayable',
  'call_hangup_above_message_max',
]);
export const provenUnpaid = (code: string) => PROVEN_UNPAID.has(code);

/**
 * What a result says, as two separate facts. A payment can be known while the
 * host still holds its record, and that record blocks every other paid action.
 * `paymentKnown`: paid or not is settled. `fenceCleared`: this result holds no
 * record at the host, so it blocks nothing.
 */
export type PaymentFacts = { paymentKnown: boolean; fenceCleared: boolean };

const CLEAR: PaymentFacts = { paymentKnown: true, fenceCleared: true };
const HELD: PaymentFacts = { paymentKnown: true, fenceCleared: false };
const UNKNOWN: PaymentFacts = { paymentKnown: false, fenceCleared: false };

/** Paid and refused for good: the host accounts it and clears its record. */
const PAID_AND_CLOSED = 'failed_paid';
/** Paid, not delivered: the host keeps the record until a delivery, "Stop retrying" or End. */
const PAID_AND_HELD = new Set(['payment_settled_undelivered', 'undelivered_pending']);

/** The host's refusal of a send. A proven-unpaid refusal leaves no record that holds anything. */
export function sendFacts(code: string): PaymentFacts {
  if (provenUnpaid(code) || code === PAID_AND_CLOSED) return CLEAR;
  return PAID_AND_HELD.has(code) ? HELD : UNKNOWN;
}

/**
 * The answer to "Check pending result". Any success settles it; so does a payment
 * the check found refused for good, though the host answers that with an error.
 * Any other failure says nothing about the record, whatever its code.
 */
export function checkFacts(outcome: { ok: true } | { ok: false; error: { code: string } }): PaymentFacts {
  if (outcome.ok || outcome.error.code === PAID_AND_CLOSED) return CLEAR;
  return PAID_AND_HELD.has(outcome.error.code) ? HELD : UNKNOWN;
}
