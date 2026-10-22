import { afterEach, describe, expect, it } from 'vitest';
import { APPROVAL_ERROR_CODES, approvalReason, refusalText, secondsLeft, shortKey, termLines, type ApprovalView } from '../src/control/ownerApproval';

const base = (request: ApprovalView['request']): ApprovalView => ({
  op_id: '0f8e2b7a-1c3d-4e5f-8a9b-0c1d2e3f4a5b', node: 'n', client_id: 'c1', client_pubkey: 'ab'.repeat(32), epoch: 3,
  grant_op: null, request, nonce: '00'.repeat(16), expires_at: 1_000_300, approval_message: 'bitsov-approval-v1\n…', status: 'pending', owner_action: null,
});
const A = 'a'.repeat(64);

describe('owner approval contract helpers', () => {
  it('spend grant terms come only from the node’s structured request', () => {
    expect(termLines(base({ kind: 'spend_grant', terms: { budget_msat: 500_000, per_call_max_msat: 10_000, window_secs: 600 } }))).toEqual([
      'Let this app spend', 'Budget: up to 500 sats', 'Each payment: up to 10 sats', 'For: 10 min', 'To: any contact, within the budget',
    ]);
    expect(termLines(base({ kind: 'spend_grant', terms: { budget_msat: 1000, per_call_max_msat: 1000, window_secs: 86_400, recipient: A } }), () => 'Maya'))
      .toEqual(['Let this app spend', 'Budget: up to 1 sat', 'Each payment: up to 1 sat', 'For: 24 h', `Only to: Maya (aaaaaa…aaaaaa)`]);
  });
  it('first contact terms', () => {
    expect(termLines(base({ kind: 'first_contact', terms: { recipient: A, max_total_msat: 14_000, budget_msat: 50_000 } }))).toEqual([
      'Let this app message someone new', 'To: aaaaaa…aaaaaa', 'First message: up to 14 sats', 'Contact budget: up to 50 sats',
    ]);
  });
  it('the Touch ID reason is the terms plus the requesting app, nothing else', () => {
    expect(approvalReason(base({ kind: 'first_contact', terms: { recipient: A, max_total_msat: 14_000 } })))
      .toBe('Let this app message someone new · To: aaaaaa…aaaaaa · First message: up to 14 sats · Requested by app ababab…ababab');
  });
  it('every approval refusal has its own words, and none of them claims success', () => {
    const texts = APPROVAL_ERROR_CODES.map((c) => refusalText(c, { remaining_msat: 2000 }));
    expect(new Set(texts).size).toBe(APPROVAL_ERROR_CODES.length);
    for (const t of texts) expect(t).not.toMatch(/^approved|has been approved|is approved|\bapproved it\b/i);
    expect(refusalText('approval_budget_exceeded', { remaining_msat: 2000 })).toContain('(2 sats left)');
    expect(refusalText('approval_off', { reason: 'seed_password_not_typed' })).toContain('password is typed at the node');
  });
  it('expiry counts down from the node’s expires_at', () => {
    const v = base({ kind: 'first_contact', terms: { recipient: A, max_total_msat: 1 } });
    expect(secondsLeft(v, 1_000_000_000)).toBe(300);
    expect(secondsLeft(v, 1_000_400_000)).toBe(0);
    expect(shortKey('ABCDEF')).toBe('abcdef');
  });
});

import { asActionError } from '../src/control/state';
describe('host refusals keep only what the screens may use', () => {
  it('keeps a known approvals-off reason and a real remaining amount, drops anything else', () => {
    expect(asActionError({ code: 'approval_off', message: 'off', reason: 'seed_password_not_typed' })).toEqual({ code: 'approval_off', message: 'off', reason: 'seed_password_not_typed' });
    expect(asActionError({ code: 'approval_off', message: 'off', reason: '<b>anything</b>' })).toEqual({ code: 'approval_off', message: 'off' });
    expect(asActionError({ code: 'approval_budget_exceeded', message: 'over', remaining_msat: 2000 })).toEqual({ code: 'approval_budget_exceeded', message: 'over', remaining_msat: 2000 });
    expect(asActionError({ code: 'approval_budget_exceeded', message: 'over', remaining_msat: -1 })).toEqual({ code: 'approval_budget_exceeded', message: 'over' });
  });
});

import { breakerSnapshot, needsReset } from '../src/control/ownerApproval';
describe('breaker reset (node #304)', () => {
  const breakers = { limits: { max_payments_per_minute: 10, max_payments_per_hour: 100, max_consecutive_failures: 3, max_msat_per_10_minutes: 200_000 },
    payments_last_minute: 0, payments_last_hour: 4, reserved_msat_last_10_minutes: 0, consecutive_failures: 3, unresolved_payments: 0, paused: true };
  const snap = { tripped: ['grant_paused', 'rate_limit_minute'], breakers, budget_msat: 500_000, per_call_max_msat: 10_000, remaining_msat: 120_000,
    grant_expires_at: 1_900_000_000, resets_last_day: 1, state_digest: 'ab'.repeat(16) };
  const reset = (breaker_reset?: object): ApprovalView =>
    ({ ...base({ kind: 'breaker_reset', terms: {} }), ...(breaker_reset ? { breaker_reset } : {}) } as ApprovalView);
  it('shows the node’s snapshot from the top-level breaker_reset; request stays {kind, terms: {}}', () => {
    const v = reset(snap);
    expect(v.request).toEqual({ kind: 'breaker_reset', terms: {} });
    const lines = termLines(v);
    expect(lines[0]).toBe('Reset this app’s paused spending');
    expect(lines[1]).toBe('Tripped: paused after failed payments, too many payments this minute');
    expect(lines[2]).toBe('Budget: up to 500 sats, 120 sats left');
    expect(lines[4]).toBe('Grant ends: 2030-03-17 17:46:40 UTC');
    expect(approvalReason(v)).toContain(' · Grant ends: 2030-03-17 17:46:40 UTC · ');
    expect(v.approval_message).toBe('bitsov-approval-v1\n…');
    expect(lines[5]).toBe('Device resets in the last day: 1 of 3');
  });
  it('says so when the node sent no snapshot (nothing is read from request.terms)', () => {
    expect(breakerSnapshot(reset())).toBeNull();
    expect(termLines(reset())[1]).toBe('Your node did not include the grant’s state');
  });
  it('keeps malformed grant expiry from crashing the approval view', () => {
    for (const grant_expires_at of [undefined, Number.MAX_SAFE_INTEGER]) {
      const v = reset({ ...snap, grant_expires_at });
      expect(termLines(v)).toContain('Grant ends: unavailable');
    }
  });
  it('only a failure pause needs a reset; rate and velocity limits recover with time', () => {
    expect(needsReset(['grant_paused'])).toBe(true);
    expect(needsReset(['rate_limit_minute', 'rate_limit_hour', 'velocity_limit'])).toBe(false);
  });
});

// Both suites consume these UTF-8 snapshots: formatting is independent of the
// app language, and never changes the node-owned signed approval_message.
import approvalFormat from './fixtures/owner-approval-format.json';
import { setLanguagePref } from '../src/i18n';
describe('host/renderer approval formatting parity', () => {
  afterEach(() => setLanguagePref('en'));
  it.each(['en', 'da'] as const)('matches the shared terms and biometric snapshots in %s', locale => {
    setLanguagePref(locale);
    for (const scenario of approvalFormat.scenarios) {
      const view = scenario.view as ApprovalView;
      expect(termLines(view)).toEqual(scenario.lines);
      expect(new TextEncoder().encode(approvalReason(view))).toEqual(new TextEncoder().encode(scenario.reason));
    }
    for (const { msat, text } of approvalFormat.amounts) {
      const view = base({ kind: 'first_contact', terms: { recipient: A, max_total_msat: msat, budget_msat: msat } });
      const lines = ['Let this app message someone new', 'To: aaaaaa…aaaaaa', `First message: up to ${text}`, `Contact budget: up to ${text}`];
      expect(termLines(view)).toEqual(lines);
      expect(approvalReason(view)).toBe(`${lines.join(' · ')} · Requested by app ababab…ababab`);
    }
  });
});
