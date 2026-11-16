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
  'call_needs_node_upgrade', 'call_needs_contact', 'call_admission_open', 'call_identity_changed',
  // M6 call minutes: refused by the host before paying, or by the node under its grant / not dispatched.
  'call_block_not_due', 'call_reservation_closed', 'call_price_changed', 'call_liquidity_insufficient', 'call_liquidity_unavailable',
  'call_no_consent', 'call_no_reservation', 'call_hold_above_consent', 'call_hold_unconfirmed', 'call_hold_changed', 'call_minutes_unpayable',
  'call_offer_price_above_consent', 'call_offer_hold_above_consent', 'call_hangup_unpayable',
  'call_hangup_above_message_max', 'call_price_unknown', 'call_minutes_above_hold',
]);
export const provenUnpaid = (code: string) => PROVEN_UNPAID.has(code);
