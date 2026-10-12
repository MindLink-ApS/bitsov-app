import { afterEach, describe, expect, it, vi } from 'vitest';
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
  source.send = vi.fn(async (recipient) => ({ message_id: 'sent-touch-first', recipient, is_room: false, delivered: true, amount_msat: 14000, sent_at_ms: Date.now() }));
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
  // The send completed: the message is in the stream and the box is clear.
  await vi.waitFor(() => expect(mount.querySelector('[data-message="sent-touch-first"]')).not.toBeNull());
  await vi.waitFor(() => expect(element<HTMLTextAreaElement>('[data-composer] textarea').value).toBe(''));
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
  source.send = vi.fn(async (recipient) => ({ message_id: 'never', recipient, is_room: false, delivered: true, amount_msat: 14000, sent_at_ms: Date.now() }));
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
  source.send = vi.fn(async (recipient) => ({ message_id: 'never', recipient, is_room: false, delivered: true, amount_msat: 14000, sent_at_ms: Date.now() }));
  mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <ControlCenter remote source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
  await vi.waitFor(() => expect(element('[data-budget="waiting"] [data-touch-id-first]')).not.toBeNull());
  expect(element('[data-touch-id-stays-text="budget"]').textContent).toContain('Nothing is sent until you press Send after approval');
  expect(element<HTMLDetailsElement>('[data-budget="waiting"] details[data-other-ways]').open).toBe(false);
  // The spend bar's own "not set up" pointer is not said a second time.
  expect(mount.querySelector('[data-device-settings-hint]')).toBeNull();
  expect(source.send).not.toHaveBeenCalled();
});

describe('owner approval v1: first contact approved on the owner’s other device', () => {
  const budget: BudgetView = {
    paused: false, waiting_for_owner: false, preset: 'careful',
    autopay: { state: 'open', open_until_ms: Date.now() + 861400000, ceiling_msat: 500000, basis: 'node_grant' },
    ceiling_msat: 500000, spent_msat: 0, unsettled_msat: 0, rows: [],
    presets: SAMPLE_PRESETS, window_ms: 861400000, max_daily_msat: 100000000, node_grant: null,
  };
  const view = (over: Record<string, unknown> = {}) => ({
    op_id: 'op-fc', node: 'n', client_id: 'this-mac', client_pubkey: 'ef'.repeat(32), epoch: 1, grant_op: 'g-fc',
    request: { kind: 'first_contact', terms: { recipient: A, max_total_msat: 14000, budget_msat: 50000 } },
    nonce: '22'.repeat(16), expires_at: Math.floor(Date.now() / 1000) + 300, approval_message: 'm', status: 'pending', owner_action: 'konsensus approve …', ...over,
  });
  function setup(capable = true) {
    const source = sampleSource({ firstLiveMs: 1e9 });
    source.budgetStatus = async () => ({ ...budget });
    const overview = source.nodeOverview.bind(source);
    source.nodeOverview = async () => ({ ...await overview(), capabilities: capable ? ['owner_device_approval_v1'] : [] });
    source.firstContactRequest = vi.fn(async () => { throw new Error('the console request must not be used'); });
    source.firstContactCancel = vi.fn(async () => {});
    let status: Record<string, unknown> = view();
    source.approvalRequest = vi.fn(async () => view() as never);
    source.approvalStatus = vi.fn(async () => status as never);
    let grantReady = false;
    source.firstContactStatus = vi.fn(async (id: string) => ({ id, ready: grantReady, expires_at_ms: Date.now() + 120_000, owner_command: '',
      request: { client_id: 'this-mac', grant_op_id: id, recipient: A, max_total_msat: 14000, contact_budget_msat: 50000 } }) as never);
    source.send = vi.fn(async (recipient: string) => ({ message_id: 'sent-v1', recipient, is_room: false, delivered: true, amount_msat: 14000, sent_at_ms: Date.now() })) as never;
    mount = document.createElement('div'); document.body.appendChild(mount);
    dispose = render(() => <ControlCenter remote source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
    return { source, consume: (over: Record<string, unknown> = {}) => { status = view({ status: 'consumed', ...over }); }, grant: () => { grantReady = true; } };
  }
  const press = async (text: string) => {
    await vi.waitFor(() => expect(element('[data-door-quote]')?.getAttribute('data-door-quote')).toBe('14000'));
    type(text);
    element<HTMLButtonElement>('[data-send]').click();
  };

  it('asks the other device instead of the node console, then checks the grant and sends once', async () => {
    const { source, consume, grant } = setup();
    await press('hello via my phone');
    await vi.waitFor(() => expect(element('[data-owner-approval-wait="pending"]')).not.toBeNull());
    expect(source.approvalRequest).toHaveBeenCalledWith({ kind: 'first_contact', terms: { recipient: A, max_total_msat: 14000, budget_msat: 50000 } });
    expect(source.firstContactRequest).not.toHaveBeenCalled();
    expect(element('[data-owner-approval-wait]').textContent).toContain('Waiting for your approval on your other owner device');
    expect(element('[data-approval-wait-after]').textContent).toBe('This message sends when approved, exactly as you wrote it.');
    expect(element<HTMLButtonElement>('[data-send]').disabled).toBe(true);
    expect(source.send).not.toHaveBeenCalled();
    consume();
    await vi.waitFor(() => expect(element('[data-contact-approval="device-approved"]')).not.toBeNull(), { timeout: 4000 });
    await vi.waitFor(() => expect(source.firstContactStatus).toHaveBeenCalledWith('g-fc', A), { timeout: 4000 });
    expect(source.send).not.toHaveBeenCalled();
    grant();
    await vi.waitFor(() => expect(source.send).toHaveBeenCalledTimes(1), { timeout: 4000 });
    // Exactly the draft as it was at Send.
    expect(vi.mocked(source.send).mock.calls[0][2]).toBe('hello via my phone');
    await vi.waitFor(() => expect(mount.querySelector('[data-message="sent-v1"]')).not.toBeNull());
    await new Promise((r) => setTimeout(r, 1200));
    expect(source.send).toHaveBeenCalledTimes(1);
  }, 15_000);

  it('a refused request is said in plain words and nothing is sent', async () => {
    const { source } = setup();
    source.approvalRequest = vi.fn(async () => { throw { code: 'approval_off', message: 'x', reason: 'seed_password_not_typed' }; });
    await press('not today');
    await vi.waitFor(() => expect(element('[data-composer-note]')?.textContent).toContain('password is typed at the node'));
    expect(element<HTMLTextAreaElement>('[data-composer] textarea').value).toBe('not today');
    expect(source.send).not.toHaveBeenCalled();
  });

  it('editing the draft while waiting stops the wait here; nothing is sent', async () => {
    const { source, consume, grant } = setup();
    await press('changing my mind');
    await vi.waitFor(() => expect(element('[data-owner-approval-wait="pending"]')).not.toBeNull());
    type('changing my mind, edited');
    await vi.waitFor(() => expect(mount.querySelector('[data-owner-approval-wait]')).toBeNull());
    consume(); grant();
    await new Promise((r) => setTimeout(r, 2500));
    expect(source.send).not.toHaveBeenCalled();
  }, 10_000);

  it('approved but no grant to use: "Contact approval expired… Ask again", nothing sent', async () => {
    const { source, consume } = setup();
    await press('too late');
    await vi.waitFor(() => expect(element('[data-owner-approval-wait="pending"]')).not.toBeNull());
    consume({ grant_op: null });
    await vi.waitFor(() => expect(element('[data-composer-note]')?.textContent).toContain('Ask again'), { timeout: 4000 });
    expect(source.send).not.toHaveBeenCalled();
  }, 10_000);

  it('a request that expires before approval has a Dismiss; Send is free again', async () => {
    const { source } = setup();
    source.approvalStatus = vi.fn(async () => { throw { code: 'approval_expired', message: 'expired' }; });
    await press('waited too long');
    await vi.waitFor(() => expect(element('[data-approval-wait-dismiss]')).not.toBeNull(), { timeout: 4000 });
    expect(element<HTMLButtonElement>('[data-send]').disabled).toBe(true);
    element<HTMLButtonElement>('[data-approval-wait-dismiss]').click();
    await vi.waitFor(() => expect(element<HTMLButtonElement>('[data-send]').disabled).toBe(false));
    expect(mount.querySelector('[data-owner-approval-wait]')).toBeNull();
    expect(source.send).not.toHaveBeenCalled();
  }, 10_000);

  it('a node without owner_device_approval_v1 keeps today’s console request', async () => {
    const { source } = setup(false);
    source.firstContactRequest = vi.fn(async () => ({ id: 'old', ready: false, expires_at_ms: Date.now() + 60000, owner_command: 'konsensus approve first-contact …',
      request: { client_id: 'c1', grant_op_id: 'ab12', recipient: A, max_total_msat: 14000, contact_budget_msat: 50000 } }));
    source.firstContactStatus = vi.fn(async () => ({ id: 'old', ready: false, expires_at_ms: Date.now() + 60000, owner_command: 'konsensus approve first-contact …',
      request: { client_id: 'c1', grant_op_id: 'ab12', recipient: A, max_total_msat: 14000, contact_budget_msat: 50000 } }));
    await press('older node');
    await vi.waitFor(() => expect(mount.querySelector('[data-contact-owner-command]')).not.toBeNull());
    expect(source.approvalRequest).not.toHaveBeenCalled();
    expect(mount.querySelector('[data-owner-approval-wait]')).toBeNull();
  });
});

describe('spend breakers on the requesting app', () => {
  const budget: BudgetView = {
    paused: false, waiting_for_owner: false, preset: 'careful',
    autopay: { state: 'open', open_until_ms: Date.now() + 861400000, ceiling_msat: 500000, basis: 'node_grant' },
    ceiling_msat: 500000, spent_msat: 0, unsettled_msat: 0, rows: [{ target: A, room: false, limit_msat: 50_000, spent_msat: 0 }],
    presets: SAMPLE_PRESETS, window_ms: 861400000, max_daily_msat: 100000000, node_grant: null,
  };
  function setup(code: string, capabilities: string[]) {
    const source = sampleSource({ firstLiveMs: 1e9 });
    source.budgetStatus = async () => ({ ...budget });
    const overview = source.nodeOverview.bind(source);
    source.nodeOverview = async () => ({ ...await overview(), capabilities });
    source.send = vi.fn(async () => { throw { code, message: 'Your node refused under its spend grant.' }; }) as never;
    let consumed = false;
    const view = { op_id: 'op-br', node: 'n', client_id: 'this-mac', client_pubkey: 'ef'.repeat(32), epoch: 1, grant_op: null,
      request: { kind: 'breaker_reset', terms: {} }, nonce: '33'.repeat(16), expires_at: Math.floor(Date.now() / 1000) + 300,
      approval_message: 'kind:breaker_reset', status: 'pending', owner_action: 'konsensus grant reset …' };
    source.approvalRequest = vi.fn(async () => view as never);
    source.approvalStatus = vi.fn(async () => ({ ...view, status: consumed ? 'consumed' : 'pending' }) as never);
    mount = document.createElement('div'); document.body.appendChild(mount);
    dispose = render(() => <ControlCenter remote source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
    return { source, consume: () => { consumed = true; } };
  }
  const sendOnce = async () => {
    await vi.waitFor(() => expect(mount.querySelector('[data-composer] textarea')).not.toBeNull());
    type('a message');
    await vi.waitFor(() => expect(element<HTMLButtonElement>('[data-send]').disabled).toBe(false));
    element<HTMLButtonElement>('[data-send]').click();
  };
  const ALL = ['owner_device_approval_v1', 'owner_device_approval_breaker_reset_v1'];

  it('paused after failures: asks the other device to reset ({kind: breaker_reset, terms: {}}); nothing is sent after', async () => {
    const { source, consume } = setup('grant_paused', ALL);
    await sendOnce();
    await vi.waitFor(() => expect(element('[data-breaker="grant_paused"]')).not.toBeNull());
    expect(element('[data-breaker="grant_paused"]').textContent).toContain('only this pause needs a reset');
    element<HTMLButtonElement>('[data-breaker-reset]').click();
    await vi.waitFor(() => expect(element('[data-breaker] [data-owner-approval-wait="pending"]')).not.toBeNull());
    expect(source.approvalRequest).toHaveBeenCalledWith({ kind: 'breaker_reset', terms: {} });
    consume();
    await vi.waitFor(() => expect(element('[data-breaker-reset-done]')).not.toBeNull(), { timeout: 4000 });
    expect(element('[data-breaker-reset-done]').textContent).toContain('Nothing was sent; press Send again');
    expect(source.send).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('a reset request the node forgets has a Dismiss; the offer comes back', async () => {
    const { source } = setup('grant_paused', ALL);
    source.approvalStatus = vi.fn(async () => { throw { code: 'approval_unknown', message: 'gone' }; });
    await sendOnce();
    await vi.waitFor(() => expect(element('[data-breaker-reset]')).not.toBeNull());
    element<HTMLButtonElement>('[data-breaker-reset]').click();
    await vi.waitFor(() => expect(element('[data-breaker] [data-approval-wait-dismiss]')).not.toBeNull(), { timeout: 4000 });
    element<HTMLButtonElement>('[data-breaker] [data-approval-wait-dismiss]').click();
    await vi.waitFor(() => expect(element('[data-breaker-reset]')).not.toBeNull());
  }, 10_000);

  it('without the breaker-reset sub-flag: no reset offer, the owner resets at the node', async () => {
    const { source } = setup('grant_paused', ['owner_device_approval_v1']);
    await sendOnce();
    await vi.waitFor(() => expect(element('[data-breaker-at-node]')).not.toBeNull());
    expect(mount.querySelector('[data-breaker-reset]')).toBeNull();
    expect(source.approvalRequest).not.toHaveBeenCalled();
  });

  it.each([
    ['grant_rate_limited', '[data-breaker-recovers]', 'clears by itself'],
    ['grant_velocity', '[data-breaker-recovers]', 'clears by itself'],
    ['grant_failures_pending', '[data-breaker-pending]', 'A reset would not settle them'],
  ])('%s says what is true and offers no reset', async (code, sel, text) => {
    const { source } = setup(code, ALL);
    await sendOnce();
    await vi.waitFor(() => expect(element(sel)).not.toBeNull());
    expect(element(sel).textContent).toContain(text);
    expect(mount.querySelector('[data-breaker-reset]')).toBeNull();
    expect(source.approvalRequest).not.toHaveBeenCalled();
  });
});
