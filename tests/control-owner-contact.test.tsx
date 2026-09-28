import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID, SAMPLE_PRESETS } from '../src/control/sample';
import type { OwnerContactApproval, BudgetView } from '../src/control/types';

let dispose: (() => void) | undefined;
let mount: HTMLElement;
afterEach(() => { dispose?.(); mount?.remove(); });
const A = 'a'.repeat(64), B = 'b'.repeat(64);
const element = <T extends HTMLElement = HTMLElement>(s: string) => mount.querySelector<T>(s)!;
const type = (text: string) => {
  const input = element<HTMLTextAreaElement>('[data-composer] textarea');
  input.value = text; input.dispatchEvent(new Event('input', { bubbles: true }));
};

async function start(beforeSend?: (source: ReturnType<typeof sampleSource>, approval: OwnerContactApproval) => void) {
  const source = sampleSource({ firstLiveMs: 1e9 });
  const budget: BudgetView = {
    paused: false, waiting_for_owner: false, preset: 'careful',
    autopay: { state: 'open', open_until_ms: Date.now() + 861400000, ceiling_msat: 500000, basis: 'node_grant' },
    ceiling_msat: 500000, spent_msat: 0, unsettled_msat: 0, rows: [],
    presets: SAMPLE_PRESETS, window_ms: 861400000, max_daily_msat: 100000000, node_grant: null,
  };
  source.budgetStatus = async () => ({ ...budget });
  const approval: OwnerContactApproval = {
    id: 'request-one', ready: false, expires_at_ms: Date.now() + 60000,
    request: { client_id: 'c1', grant_op_id: 'ab12', recipient: A, max_total_msat: 14000, contact_budget_msat: 50000 },
    owner_command: `konsensus approve first-contact --client 'c1' --op 'ab12' --to '${A}' --max-msat '14000' --contact-budget-msat '50000'`,
  };
  source.firstContactRequest = vi.fn(async () => approval);
  source.firstContactStatus = vi.fn(async () => approval);
  source.firstContactCancel = vi.fn(async () => {});
  source.send = vi.fn(async (recipient) => ({ message_id: 'sent-one', recipient, is_room: false, delivered: true, amount_msat: 14000, sent_at_ms: Date.now() }));
  mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <ControlCenter source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
  await vi.waitFor(() => expect(element('[data-door-quote]')?.getAttribute('data-door-quote')).toBe('14000'));
  beforeSend?.(source, approval);
  type('hello with an owner approval');
  element<HTMLButtonElement>('[data-send]').click();
  if (!beforeSend) await vi.waitFor(() => expect(element('[data-contact-approval]')).not.toBeNull());
  return { source, approval };
}

it('shows a copyable exact owner handoff, waits, then sends only once after approval', async () => {
  const { source, approval } = await start();
  expect(source.send).not.toHaveBeenCalled();
  expect(element<HTMLTextAreaElement>('[data-contact-owner-command]').value).toBe(approval.owner_command);
  expect(JSON.parse(element('[data-contact-approval]').getAttribute('data-contact-request')!)).toEqual(approval.request);
  expect(element<HTMLButtonElement>('[data-send]').disabled).toBe(true);
  expect(source.firstContactRequest).toHaveBeenCalledWith(A, 14000, 50000);
  source.firstContactStatus = vi.fn(async () => ({ ...approval, ready: true }));
  await vi.waitFor(() => expect(source.send).toHaveBeenCalledTimes(1), { timeout: 2500 });
  expect(source.send).toHaveBeenCalledWith(A, false, 'hello with an owner approval', 14000, undefined, 50000);
  await vi.waitFor(() => expect(element<HTMLTextAreaElement>('[data-composer] textarea').value).toBe(''));
  expect(element('[data-contact-approval]')).toBeNull();
});

it.each(['cancel', 'edit', 'switch'] as const)('ignores a late approval after %s', async (action) => {
  const { source, approval } = await start();
  let finish!: (value: OwnerContactApproval) => void;
  source.firstContactStatus = vi.fn(() => new Promise<OwnerContactApproval>(resolve => { finish = resolve; }));
  await vi.waitFor(() => expect(finish).toBeDefined(), { timeout: 2500 });
  if (action === 'cancel') element<HTMLButtonElement>('[data-contact-cancel]').click();
  if (action === 'edit') type('a different draft');
  if (action === 'switch') element<HTMLButtonElement>(`[data-track="peer:${B}"]`).click();
  finish({ ...approval, ready: true });
  await vi.waitFor(() => expect(source.firstContactCancel).toHaveBeenCalledWith(approval.id));
  expect(source.send).not.toHaveBeenCalled();
  expect(element('[data-contact-approval]')).toBeNull();
  if (action === 'edit') expect(element<HTMLTextAreaElement>('[data-composer] textarea').value).toBe('a different draft');
});

it('keeps approval pending across unchanged budget refreshes', async () => {
  const { source } = await start();
  await vi.waitFor(() => expect(source.firstContactStatus).toHaveBeenCalledTimes(4), { timeout: 4800 });
  expect(element('[data-contact-approval]')).not.toBeNull();
  expect(source.firstContactCancel).not.toHaveBeenCalled();
  expect(source.send).not.toHaveBeenCalled();
}, 6000);

it('discards a late owner request after the contact budget changes', async () => {
  let finish!: (value: OwnerContactApproval) => void;
  const { source, approval } = await start(source => {
    source.firstContactRequest = vi.fn(() => new Promise<OwnerContactApproval>(resolve => { finish = resolve; }));
  });
  await vi.waitFor(() => expect(finish).toBeDefined());
  const choices = [...mount.querySelectorAll<HTMLButtonElement>('[data-first-budget]')];
  choices.find(button => button.getAttribute('aria-checked') === 'false')!.click();
  finish(approval);
  await vi.waitFor(() => expect(source.firstContactCancel).toHaveBeenCalledWith(approval.id));
  expect(element('[data-contact-approval]')).toBeNull();
  expect(source.send).not.toHaveBeenCalled();
});
