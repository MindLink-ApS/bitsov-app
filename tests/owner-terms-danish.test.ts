import { afterEach, expect, it } from 'vitest';
import { setLanguagePref } from '../src/i18n';
import { approvalReason, displayTermLines, termLines, type ApprovalView } from '../src/control/ownerApproval';
import { asActionError } from '../src/control/state';

const base = (request: ApprovalView['request']): ApprovalView => ({
  op_id: '0f8e2b7a-1c3d-4e5f-8a9b-0c1d2e3f4a5b', node: 'n', client_id: 'c1', client_pubkey: 'ab'.repeat(32), epoch: 3,
  grant_op: null, request, nonce: '00'.repeat(16), expires_at: 1_000_300, approval_message: 'bitsov-approval-v1\n…', status: 'pending', owner_action: null,
});
const A = 'a'.repeat(64);
afterEach(() => setLanguagePref('en'));

it('reads first-contact and spend terms in Danish, line for line, from the same fields', () => {
  setLanguagePref('da');
  const contact = base({ kind: 'first_contact', terms: { recipient: A, max_total_msat: 14_000, budget_msat: 50_000 } });
  expect(displayTermLines(contact, 'da', () => 'Maya')).toEqual([
    'Lad appen skrive til en ny kontakt', 'Til: Maya (aaaaaa…aaaaaa)', 'Første besked: højst 14 sats', 'Kontaktbudget: højst 50 sats',
  ]);
  const spend = base({ kind: 'spend_grant', terms: { budget_msat: 500_000, per_call_max_msat: 10_000, window_secs: 86_400 } });
  expect(displayTermLines(spend, 'da')).toEqual([
    'Lad appen betale', 'Budget: højst 500 sats', 'Hver betaling: højst 10 sats', 'Beskeder: højst 6 sats hver', 'I: 24 t', 'Til: alle kontakter, inden for budgettet',
  ]);
  expect(displayTermLines(contact, 'da').length).toBe(termLines(contact).length);
});

it('never changes the English terms the Touch ID reason and the host rely on', () => {
  setLanguagePref('da');
  const contact = base({ kind: 'first_contact', terms: { recipient: A, max_total_msat: 14_000 } });
  expect(displayTermLines(contact, 'en')).toEqual(termLines(contact));
  expect(approvalReason(contact)).toBe('Let this app message someone new · To: aaaaaa…aaaaaa · First message: up to 14 sats · Requested by app ababab…ababab');
});

it('never shows the raw "owner approvals off" refusal or its start flags', () => {
  setLanguagePref('da');
  const e = asActionError({ code: 'node', message: '/pair/elevation-request failed (409): owner_approval_unavailable: start with --owner-control' });
  expect(e.message).toBe('Din boks kan ikke godkende betalinger lige nu.');
  expect(e.code).toBe('node');
});
