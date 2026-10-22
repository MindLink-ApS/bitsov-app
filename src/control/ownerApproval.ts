/**
 * Owner approval from an enrolled owner device (node owner-approval-v1,
 * capability `owner_device_approval_v1`, node #303). Renderer contract only:
 * the host (src-tauri) implements the four commands below against the node's
 * /api/v1 routes; the renderer never signs, never builds a request body for
 * the node itself, and never sees a token.
 *
 * Host commands (Source methods → Tauri invoke names):
 *   approvalRequest(request)        → owner_approval_request   POST /pair/approval-request (local or remote router; any pairing;
 *                                     breaker_reset only with OWNER_DEVICE_BREAKER_RESET, terms {}: resets the requester's own grant)
 *   approvalStatus(opId)            → owner_approval_status    GET  /pair/approval/{op_id} (only the requester, same epoch)
 *   approvalsPending()              → owner_approvals_pending  GET  /pair/approvals/pending?approver_key_id=<this device's key> (remote/Noise only)
 *   approvalApprove(opId, message)  → owner_approval_approve   POST /pair/approval/{op_id}/approve (remote/Noise only)
 *   deviceKeys()                    → owner_device_keys        GET  /pair/device-keys
 *
 * approvalApprove: the host MUST
 *   1. read the op again over this device's session and refuse (code
 *      `approval_changed`) unless its approval_message is byte-identical to
 *      `message` (the terms the owner was shown are the terms signed);
 *   2. refuse (`approval_self`) if the op's client_id is this pairing's own;
 *   3. show the Touch ID prompt with `approvalReason(view)` as its reason;
 *   4. ECDSA P-256/SHA-256 sign the exact UTF-8 bytes of approval_message (no
 *      trailing newline), DER hex, with this pairing's owner-approved device
 *      key, and POST {approver_key_id, signature}.
 *
 * Host error mapping (ActionError.code; message is the node's error text, sanitized):
 *   403 + reason seed_not_encrypted | seed_password_not_typed | owner_key_unavailable → approval_off (reason kept)
 *   403 otherwise (not owner / AI / read-only / revoked / no Noise / self / consumed / bad signature / binding mismatch / no live grant) → approval_forbidden
 *   409 {code: budget_exceeded, reason, remaining_msat}                     → approval_budget_exceeded (remaining_msat kept)
 *   409 otherwise                                                           → approval_expired
 *   404                                                                     → approval_unknown
 *   429                                                                     → approval_rate_limited
 *   400                                                                     → approval_invalid
 *   500 (persistence; the request is still pending)                         → approval_unsaved
 *   Touch ID / key: the existing device_* codes. Transport: `node`.
 */

import { appPlatform, type AppPlatform } from '../platform';

export const OWNER_DEVICE_APPROVAL = 'owner_device_approval_v1';
/** Sub-flag (node #304): device-approved resets of this pairing's tripped spend breaker. Offer resets only with it. */
export const OWNER_DEVICE_BREAKER_RESET = 'owner_device_approval_breaker_reset_v1';
/** Node requests expire 300 s after creation; there is no decline or cancel endpoint. */
export const APPROVAL_LIFETIME_SECS = 300;

export type SpendGrantTerms = {
  budget_msat: number;
  per_call_max_msat: number;
  /** 60..86400 */
  window_secs: number;
  /** 64-hex node id; absent means any recipient within the budget. */
  recipient?: string;
};
export type FirstContactTerms = {
  /** 64-hex node id */
  recipient: string;
  /** 1..100000 */
  max_total_msat: number;
  budget_msat?: number;
};
/** What tripped this pairing's spend grant. Only grant_paused needs a reset; the others recover with time. */
export type BreakerTrip = 'grant_paused' | 'rate_limit_minute' | 'rate_limit_hour' | 'velocity_limit';
/** The node's breaker state for a grant (all counts u64; `paused` is the failure pause). */
export type BreakerStatus = {
  limits: { max_payments_per_minute: number; max_payments_per_hour: number; max_consecutive_failures: number; max_msat_per_10_minutes: number };
  payments_last_minute: number;
  payments_last_hour: number;
  reserved_msat_last_10_minutes: number;
  consecutive_failures: number;
  unresolved_payments: number;
  paused: boolean;
};
/** The node's snapshot of the requesting pairing's grant: ApprovalView.breaker_reset (read-only). */
export type BreakerSnapshot = {
  /** BreakerTrip values; any other string is shown as the node wrote it. */
  tripped: string[];
  breakers: BreakerStatus;
  budget_msat: number;
  remaining_msat: number;
  per_call_max_msat: number;
  /** unix seconds */
  grant_expires_at: number;
  /** device resets of this grant in the last 24 h (the node allows 3) */
  resets_last_day: number;
  state_digest: string;
};
/** What the app sends, and what the node shows back in ApprovalView.request (unchanged). breaker_reset takes no numbers. */
export type ApprovalRequest =
  | { kind: 'spend_grant'; terms: SpendGrantTerms }
  | { kind: 'first_contact'; terms: FirstContactTerms }
  | { kind: 'breaker_reset'; terms: Record<string, never> };

/** consumed = approved and used; there is no declined state. */
export type ApprovalStatus = 'pending' | 'consumed' | 'expired';

/** The node's ApprovalView, as the host passes it through (no field added or reshaped). */
export type ApprovalView = {
  op_id: string;
  node: string;
  client_id: string;
  client_pubkey: string;
  epoch: number;
  grant_op: string | null;
  request: ApprovalRequest;
  nonce: string;
  /** unix seconds */
  expires_at: number;
  /** The exact text the owner device signs; shown verbatim under the terms. */
  approval_message: string;
  status: ApprovalStatus;
  owner_action: string | null;
  /** breaker_reset only: the node's snapshot of the grant to reset (top level; absent otherwise). */
  breaker_reset?: BreakerSnapshot;
};

/** GET /pair/device-keys: whether this pairing can approve, and its owner devices. */
export type DeviceKeysView = {
  /** "enabled", or the reason approvals are off */
  device_approvals: string;
  owner_device_count: number;
  device_keys: { key_id: string; fingerprint: string; name: string | null; registered_at: number }[];
};

export const APPROVAL_ERROR_CODES = [
  'approval_off', 'approval_forbidden', 'approval_budget_exceeded', 'approval_expired', 'approval_unknown',
  'approval_rate_limited', 'approval_invalid', 'approval_unsaved', 'approval_changed', 'approval_self',
] as const;
export type ApprovalErrorCode = (typeof APPROVAL_ERROR_CODES)[number];

// ---- pure helpers the screens share (and the host uses for the Touch ID reason) ----

// Display only: never build or rewrite the node's signed approval_message.
// Match owner_approval.rs exactly in every app language: U+202F grouping,
// decimal dot, and up to three fractional digits from the integer msat.
const sats = (msat: number) => {
  const whole = Math.floor(msat / 1000).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f');
  const remainder = msat % 1000;
  const fraction = remainder ? `.${remainder.toString().padStart(3, '0').replace(/0+$/, '')}` : '';
  return `${whole}${fraction} ${msat === 1000 ? 'sat' : 'sats'}`;
};
const span = (secs: number) =>
  secs % 3600 === 0 ? `${secs / 3600} h` : secs % 60 === 0 ? `${secs / 60} min` : `${secs} s`;

// Match the host's Touch ID prompt regardless of locale or timezone.
const approvalDate = (seconds: number) => {
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime())
    ? date.toISOString().replace('T', ' ').replace('.000Z', ' UTC')
    : 'unavailable';
};

/** A short, readable fingerprint of a hex key or id (never a name the node did not give). */
export const shortKey = (hex: string) => {
  const h = hex.replace(/[^0-9a-f]/gi, '').toLowerCase();
  return h.length <= 12 ? h : `${h.slice(0, 6)}…${h.slice(-6)}`;
};

/** The terms as lines, from the node's structured request only (nothing inferred). */
export function termLines(view: ApprovalView, nameOf?: (id: string) => string | null): string[] {
  const who = (id: string) => {
    const n = nameOf?.(id);
    return n ? `${n} (${shortKey(id)})` : shortKey(id);
  };
  if (view.request.kind === 'spend_grant') {
    const t = view.request.terms;
    return [
      'Let this app spend',
      `Budget: up to ${sats(t.budget_msat)}`,
      `Each payment: up to ${sats(t.per_call_max_msat)}`,
      `For: ${span(t.window_secs)}`,
      t.recipient ? `Only to: ${who(t.recipient)}` : 'To: any contact, within the budget',
    ];
  }
  if (view.request.kind === 'breaker_reset') {
    const snap = breakerSnapshot(view);
    if (!snap) return ['Reset this app’s paused spending', 'Your node did not include the grant’s state'];
    return [
      'Reset this app’s paused spending',
      `Tripped: ${snap.tripped.length ? snap.tripped.map(tripText).join(', ') : 'nothing'}`,
      `Budget: up to ${sats(snap.budget_msat)}, ${sats(snap.remaining_msat)} left`,
      `Each payment: up to ${sats(snap.per_call_max_msat)}`,
      `Grant ends: ${approvalDate(snap.grant_expires_at)}`,
      `Device resets in the last day: ${snap.resets_last_day} of 3`,
    ];
  }
  const t = view.request.terms;
  return [
    'Let this app message someone new',
    `To: ${who(t.recipient)}`,
    `First message: up to ${sats(t.max_total_msat)}`,
    ...(t.budget_msat !== undefined ? [`Contact budget: up to ${sats(t.budget_msat)}`] : []),
  ];
}

/** The Touch ID reason: the terms in one line, plus the requesting app and expiry. */
export function approvalReason(view: ApprovalView): string {
  return `${termLines(view).join(' · ')} · Requested by app ${shortKey(view.client_pubkey)}`;
}

/** A breaker_reset view's snapshot (ApprovalView.breaker_reset); null when absent or malformed. */
export function breakerSnapshot(view: ApprovalView): BreakerSnapshot | null {
  if (view.request.kind !== 'breaker_reset') return null;
  const s = view.breaker_reset;
  return s && Array.isArray(s.tripped) && typeof s.remaining_msat === 'number' ? s : null;
}

const TRIP_TEXT: Record<BreakerTrip, string> = {
  grant_paused: 'paused after failed payments',
  rate_limit_minute: 'too many payments this minute',
  rate_limit_hour: 'too many payments this hour',
  velocity_limit: 'spending too fast',
};
export const tripText = (t: string) => TRIP_TEXT[t as BreakerTrip] ?? t;
/** Only a failure pause needs a reset; rate and velocity limits recover with time on their own. */
export const needsReset = (tripped: string[]) => tripped.includes('grant_paused');

export const secondsLeft = (view: ApprovalView, nowMs: number) => Math.max(0, Math.floor(view.expires_at - nowMs / 1000));

/** Owner-facing words for each refusal; `node` is the node's own (sanitized) text, kept for detail. */
/** The biometric this platform's approvals use: Touch ID on a Mac, biometrics on iOS and Android. */
const APPROVAL_BIOMETRIC: Record<AppPlatform, string> = { desktop: 'Touch ID', ios: 'The biometric check', android: 'The biometric check' };

export function refusalText(code: string, extra: { reason?: string; remaining_msat?: number } = {}, platform: AppPlatform = appPlatform()): string {
  switch (code) {
    case 'approval_off':
      return extra.reason === 'seed_password_not_typed'
        ? 'Approvals from your devices are off until the node’s password is typed at the node after its restart.'
        : extra.reason === 'seed_not_encrypted'
          ? 'Approvals from your devices are off: this node’s keys are not password-protected.'
          : 'Approvals from your devices are off on this node right now.';
    case 'approval_forbidden': return 'Your node refused this approval. Nothing was approved.';
    case 'approval_self': return 'This device made the request, so it cannot approve it. Approve it on your other owner device.';
    case 'approval_changed': return 'The request changed after it was shown. Nothing was signed. Look at it again.';
    case 'approval_budget_exceeded':
      return `Your node refused: this is over the remaining budget${extra.remaining_msat !== undefined ? ` (${sats(extra.remaining_msat)} left)` : ''}. Nothing was approved.`;
    case 'approval_expired': return 'This request expired. Nothing was approved. Ask again from the app that needs it.';
    case 'approval_unknown': return 'Your node no longer knows this request (it may have restarted). Nothing was approved.';
    case 'approval_rate_limited': return 'Too many approval requests just now. Wait a little and try again.';
    case 'approval_invalid': return 'Your node could not read this request. Nothing was approved.';
    case 'approval_unsaved': return 'Your node could not save the approval; the request is still waiting. Try again.';
    case 'device_cancelled': return `${APPROVAL_BIOMETRIC[platform]} was cancelled. Nothing was approved.`;
    default: return 'This did not complete. Nothing was approved.';
  }
}
