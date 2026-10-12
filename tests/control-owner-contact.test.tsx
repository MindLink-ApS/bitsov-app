import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID, SAMPLE_PRESETS } from '../src/control/sample';
import type { OwnerContactApproval, BudgetView } from '../src/control/types';

let dispose: (() => void) | undefined;
let mount: HTMLElement;
afterEach(() => { dispose?.(); mount?.remove(); vi.useRealTimers(); });
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
  // Fake clock: four status polls in bounded steps, not a race against wall time.
  vi.useFakeTimers();
  const { source } = await start();
  const polls = () => vi.mocked(source.firstContactStatus).mock.calls.length;
  for (let step = 0; step < 40 && polls() < 4; step++) await vi.advanceTimersByTimeAsync(250);
  expect(source.firstContactStatus).toHaveBeenCalledTimes(4);
  expect(element('[data-contact-approval]')).not.toBeNull();
  expect(source.firstContactCancel).not.toHaveBeenCalled();
  expect(source.send).not.toHaveBeenCalled();
});

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

it.each(['request', 'approval'] as const)('offline cancels an undispatched %s even if it completes after recovery', async (stage) => {
  vi.useFakeTimers();
  let ready = true;
  let finish!: (value: OwnerContactApproval) => void;
  const { source, approval } = await start((source) => {
    const overview = source.nodeOverview;
    source.nodeOverview = async () => ({ ...await overview(), money_ready: ready });
    const deferred = vi.fn(() => new Promise<OwnerContactApproval>(resolve => { finish = resolve; }));
    if (stage === 'request') source.firstContactRequest = deferred;
    else source.firstContactStatus = deferred;
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(finish).toBeDefined();
  ready = false;
  await vi.advanceTimersByTimeAsync(10000);
  expect(element('[data-money-notice]')).not.toBeNull();
  ready = true;
  await vi.advanceTimersByTimeAsync(10000);
  finish({ ...approval, ready: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(source.firstContactCancel).toHaveBeenCalledWith(approval.id);
  expect(source.send).not.toHaveBeenCalled();
  expect(element('[data-contact-approval]')).toBeNull();
  expect(element<HTMLTextAreaElement>('[data-composer] textarea').value).toBe('hello with an owner approval');
});

it('clears an approved successful first-contact send completed while offline', async () => {
  vi.useFakeTimers();
  let ready = true;
  let finish!: () => void;
  const { source } = await start((source, approval) => {
    const overview = source.nodeOverview;
    source.nodeOverview = async () => ({ ...await overview(), money_ready: ready });
    source.firstContactStatus = vi.fn(async () => ({ ...approval, ready: true }));
    source.send = vi.fn(async recipient => {
      await new Promise<void>(resolve => { finish = resolve; });
      return { message_id: 'late-approved', recipient, is_room: false, delivered: true, amount_msat: 14000, sent_at_ms: Date.now() };
    });
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(source.send).toHaveBeenCalledTimes(1);
  ready = false;
  await vi.advanceTimersByTimeAsync(10000);
  expect(element('[data-money-notice]')).not.toBeNull();
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(element<HTMLTextAreaElement>('[data-composer] textarea').value).toBe('');
  ready = true;
  await vi.advanceTimersByTimeAsync(10000);
  expect(element<HTMLButtonElement>('[data-send]').disabled).toBe(true);
  expect(source.send).toHaveBeenCalledTimes(1);
});

it('waits with backoff and a countdown for remote approval beyond fifteen seconds', async () => {
  vi.useFakeTimers();
  const { source, approval } = await start((_source, approval) => {
    Object.assign(approval, { approval_window_secs: 300, expires_at_ms: Date.now() + 300000 });
  });
  await vi.advanceTimersByTimeAsync(20000);
  expect(element('[data-contact-countdown]')?.textContent).toMatch(/4:4\d/);
  expect(vi.mocked(source.firstContactStatus).mock.calls.length).toBeLessThan(10);
  expect(source.send).not.toHaveBeenCalled();
  expect(element<HTMLTextAreaElement>('[data-composer] textarea').value).toBe('hello with an owner approval');
  source.firstContactStatus = vi.fn(async () => ({ ...approval, ready: true }));
  await vi.advanceTimersByTimeAsync(10000);
  expect(source.send).toHaveBeenCalledTimes(1);
});

it.each(['deadline', 'expired'] as const)('remote %s retains the draft and offers a fresh quote without sending', async reason => {
  vi.useFakeTimers();
  const { source } = await start((source, approval) => {
    Object.assign(approval, { approval_window_secs: 30, expires_at_ms: Date.now() + 30000 });
    if (reason === 'expired') source.firstContactStatus = vi.fn(async () => { throw { code: 'owner_contact_expired', message: 'Approval expired. Nothing was sent.' }; });
  });
  await vi.advanceTimersByTimeAsync(31000);
  expect(source.send).not.toHaveBeenCalled();
  expect(element('[data-contact-approval]')).toBeNull();
  expect(element<HTMLTextAreaElement>('[data-composer] textarea').value).toBe('hello with an owner approval');
  expect(element('[data-contact-requote]')).not.toBeNull();
  element<HTMLButtonElement>('[data-contact-requote]').click();
  await vi.advanceTimersByTimeAsync(0);
  expect(source.send).not.toHaveBeenCalled();
  expect(element('[data-contact-requote]')).toBeNull();
});

it('stops at five minutes even if a status request is stuck, ignoring its late approval', async () => {
  vi.useFakeTimers();
  let finish!: (approval: OwnerContactApproval) => void;
  const { source, approval } = await start((source, approval) => {
    Object.assign(approval, { approval_window_secs: 300, expires_at_ms: Date.now() + 300000 });
    source.firstContactStatus = vi.fn(() => new Promise<OwnerContactApproval>(resolve => { finish = resolve; }));
  });
  await vi.advanceTimersByTimeAsync(299000);
  expect(element('[data-contact-approval]')).not.toBeNull();
  expect(source.send).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(element('[data-contact-requote]')).not.toBeNull();
  finish({ ...approval, ready: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(source.send).not.toHaveBeenCalled();
});

it('shows unavailable status honestly and stops polling without losing the draft', async () => {
  vi.useFakeTimers();
  const { source } = await start((source, approval) => {
    Object.assign(approval, { approval_window_secs: 300, expires_at_ms: Date.now() + 300000 });
    source.firstContactStatus = vi.fn(async () => { throw {
      code: 'owner_contact_unavailable', message: 'Remote contact approval status is not available: older node or owner control off. Nothing was sent.',
    }; });
  });
  await vi.advanceTimersByTimeAsync(10000);
  expect(mount.textContent).toContain('older node or owner control off');
  expect(source.firstContactStatus).toHaveBeenCalledTimes(1);
  expect(source.send).not.toHaveBeenCalled();
  expect(element<HTMLTextAreaElement>('[data-composer] textarea').value).toBe('hello with an owner approval');
});

it('offers a fresh quote if approval expires during the host send recheck', async () => {
  vi.useFakeTimers();
  const { source } = await start((source, approval) => {
    Object.assign(approval, { approval_window_secs: 300, expires_at_ms: Date.now() + 300000 });
    source.firstContactStatus = vi.fn(async () => ({ ...approval, ready: true }));
    source.send = vi.fn(async () => { throw { code: 'owner_contact_expired', message: 'Contact approval expired. Nothing was sent.' }; });
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(element('[data-contact-requote]')).not.toBeNull();
  expect(element<HTMLTextAreaElement>('[data-composer] textarea').value).toBe('hello with an owner approval');
  expect(source.send).toHaveBeenCalledTimes(1);
});

it('first contact on a remote node without Touch ID: the Touch ID offer leads, the owner command waits under Other ways', async () => {
  const source = sampleSource({ firstLiveMs: 1e9 });
  const budget: BudgetView = {
    paused: false, waiting_for_owner: false, preset: 'careful',
    autopay: { state: 'open', open_until_ms: Date.now() + 861400000, ceiling_msat: 500000, basis: 'node_grant' },
    ceiling_msat: 500000, spent_msat: 0, unsettled_msat: 0, rows: [],
    presets: SAMPLE_PRESETS, window_ms: 861400000, max_daily_msat: 100000000, node_grant: null,
  };
  source.budgetStatus = async () => ({ ...budget });
  source.deviceKeyStatus = async () => ({ available: true, state: 'none', fingerprint: null, owner_action: null, expires_at_ms: null });
  const approval: OwnerContactApproval = {
    id: 'request-two', ready: false, expires_at_ms: Date.now() + 60000,
    request: { client_id: 'c1', grant_op_id: 'ab12', recipient: A, max_total_msat: 14000, contact_budget_msat: 50000 },
    owner_command: `konsensus approve first-contact --client 'c1' --op 'ab12' --to '${A}' --max-msat '14000' --contact-budget-msat '50000'`,
  };
  source.firstContactRequest = vi.fn(async () => approval);
  source.firstContactStatus = vi.fn(async () => approval);
  source.firstContactCancel = vi.fn(async () => {});
  source.send = vi.fn();
  mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <ControlCenter remote source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
  await vi.waitFor(() => expect(element('[data-door-quote]')?.getAttribute('data-door-quote')).toBe('14000'));
  type('hello with Touch ID first');
  element<HTMLButtonElement>('[data-send]').click();
  await vi.waitFor(() => expect(element('[data-touch-id-first]')).not.toBeNull());
  const other = element<HTMLDetailsElement>('[data-touch-id-first] details[data-other-ways]');
  expect(other.open).toBe(false);
  expect(other.querySelector<HTMLTextAreaElement>('[data-contact-owner-command]')!.value).toBe(approval.owner_command);
  expect(element<HTMLTextAreaElement>('[data-composer] textarea').value).toBe('hello with Touch ID first');
  expect(source.send).not.toHaveBeenCalled();
  // What is true for a pending first contact stays in view: it sends by itself once approved, and Cancel stops it.
  const stays = element('[data-touch-id-first] [data-touch-id-stays-text="first-contact"]');
  expect(stays.textContent).toContain('This message sends automatically once your node’s owner approves this contact');
  expect(stays.querySelector('[data-contact-cancel-visible]')).not.toBeNull();
  expect(mount.textContent).not.toContain('press Send when you are ready');
  // Going to Touch ID setup leaves the wait running; when the owner approves, it sends, as the copy said.
  element<HTMLButtonElement>('[data-touch-id-setup]').click();
  source.firstContactStatus = vi.fn(async () => ({ ...approval, ready: true }));
  await vi.waitFor(() => expect(source.send).toHaveBeenCalledTimes(1), { timeout: 2500 });
});

it('first contact: Cancel in view stops the wait; nothing is sent', async () => {
  const source = sampleSource({ firstLiveMs: 1e9 });
  const budget: BudgetView = {
    paused: false, waiting_for_owner: false, preset: 'careful',
    autopay: { state: 'open', open_until_ms: Date.now() + 861400000, ceiling_msat: 500000, basis: 'node_grant' },
    ceiling_msat: 500000, spent_msat: 0, unsettled_msat: 0, rows: [],
    presets: SAMPLE_PRESETS, window_ms: 861400000, max_daily_msat: 100000000, node_grant: null,
  };
  source.budgetStatus = async () => ({ ...budget });
  source.deviceKeyStatus = async () => ({ available: true, state: 'none', fingerprint: null, owner_action: null, expires_at_ms: null });
  const approval: OwnerContactApproval = {
    id: 'request-three', ready: false, expires_at_ms: Date.now() + 60000,
    request: { client_id: 'c1', grant_op_id: 'ab12', recipient: A, max_total_msat: 14000, contact_budget_msat: 50000 },
    owner_command: 'konsensus approve first-contact …',
  };
  source.firstContactRequest = vi.fn(async () => approval);
  source.firstContactStatus = vi.fn(async () => approval);
  source.firstContactCancel = vi.fn(async () => {});
  source.send = vi.fn();
  mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <ControlCenter remote source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
  await vi.waitFor(() => expect(element('[data-door-quote]')?.getAttribute('data-door-quote')).toBe('14000'));
  type('stop this one');
  element<HTMLButtonElement>('[data-send]').click();
  await vi.waitFor(() => expect(element('[data-contact-cancel-visible]')).not.toBeNull());
  element<HTMLButtonElement>('[data-contact-cancel-visible]').click();
  await vi.waitFor(() => expect(source.firstContactCancel).toHaveBeenCalledWith('request-three'));
  expect(mount.querySelector('[data-touch-id-first]')).toBeNull();
  source.firstContactStatus = vi.fn(async () => ({ ...approval, ready: true }));
  await new Promise((r) => setTimeout(r, 1500));
  expect(source.send).not.toHaveBeenCalled();
});

it('the budget waiting card (remote, Touch ID not set up) leads with the offer and keeps its truth in view', async () => {
  const source = sampleSource({ firstLiveMs: 1e9 });
  const budget: BudgetView = {
    paused: false, waiting_for_owner: true, preset: 'careful',
    autopay: { state: 'off', open_until_ms: null, ceiling_msat: 500000, basis: 'node_grant' },
    ceiling_msat: 500000, spent_msat: 0, unsettled_msat: 0, rows: [],
    presets: SAMPLE_PRESETS, window_ms: 861400000, max_daily_msat: 100000000, node_grant: null,
  };
  source.budgetStatus = async () => ({ ...budget });
  source.deviceKeyStatus = async () => ({ available: true, state: 'none', fingerprint: null, owner_action: null, expires_at_ms: null });
  source.send = vi.fn();
  mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <ControlCenter remote source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
  await vi.waitFor(() => expect(element('[data-budget="waiting"] [data-touch-id-first]')).not.toBeNull());
  expect(element('[data-touch-id-stays-text="budget"]').textContent).toContain('Nothing is sent until you press Send after approval');
  expect(element<HTMLDetailsElement>('[data-budget="waiting"] details[data-other-ways]').open).toBe(false);
  // The spend bar's own "not set up" pointer is not said a second time.
  expect(mount.querySelector('[data-device-settings-hint]')).toBeNull();
  expect(source.send).not.toHaveBeenCalled();
});
