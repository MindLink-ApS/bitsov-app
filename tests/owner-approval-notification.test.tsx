import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { OwnerApprovalSheets } from '../src/control/OwnerApprovalSheet';
import { approvalMemory, approveOwnerRequest } from '../src/control/OwnerApprovals';
import type { ApprovalView } from '../src/control/ownerApproval';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLanguagePref } from '../src/i18n';
import * as i18n from '../src/i18n';
import { createApprovalNotifications } from '../src/control/ownerApprovalNotification';

const native = vi.hoisted(() => ({
  isTauri: vi.fn(), isPermissionGranted: vi.fn(), requestPermission: vi.fn(), sendNotification: vi.fn(), onAction: vi.fn(), registerActionTypes: vi.fn(),
  isFocused: vi.fn(), show: vi.fn(), unminimize: vi.fn(), setFocus: vi.fn(), unregister: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: native.isTauri }));
vi.mock('@tauri-apps/plugin-notification', () => native);
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main', ...native }) }));
let click: (event: { actionId: string; notification: { id: number } }) => void;
let dispose: (() => void) | undefined;
beforeEach(() => {
  vi.resetAllMocks();
  native.isFocused.mockResolvedValue(false);
  native.isPermissionGranted.mockResolvedValue(true);
  native.requestPermission.mockResolvedValue('granted');
  native.onAction.mockImplementation(async cb => { click = cb; return { unregister: native.unregister }; });
});
afterEach(() => { dispose?.(); vi.unstubAllEnvs(); vi.restoreAllMocks(); setLanguagePref('en'); });
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function setup() {
  const review = vi.fn();
  const notifications = createApprovalNotifications(review);
  dispose = notifications.dispose;
  return { ...notifications, review };
}
it('does nothing on launch and never notifies focused arrivals or repeats them later', async () => {
  const n = setup(); await flush();
  expect(native.isPermissionGranted).not.toHaveBeenCalled();
  native.isFocused.mockResolvedValue(true);
  n.update(['a']); await flush();
  native.isFocused.mockResolvedValue(false);
  n.update(['a']); await flush();
  expect(native.sendNotification).not.toHaveBeenCalled();
  expect(native.requestPermission).not.toHaveBeenCalled();
});
it.each(['en', 'da'] as const)('sends one generic %s notification per background request, with no sensitive payload', async lang => {
  setLanguagePref(lang); const n = setup();
  n.update(['memo-secret-trip-code-500000']); await flush();
  n.update(['memo-secret-trip-code-500000']); await flush();
  expect(native.sendNotification).toHaveBeenCalledTimes(1);
  expect(native.sendNotification).toHaveBeenCalledWith({ id: expect.any(Number), title: 'BitSov', actionTypeId: 'bitsov-owner-approval',
    body: lang === 'en' ? 'An app is asking for your approval' : 'En app beder om din godkendelse' });
  expect(JSON.stringify(native.sendNotification.mock.calls)).not.toMatch(/secret|trip|500000/);
});
it('opens the clicked request and restores the window, even with multiple arrivals', async () => {
  const n = setup(); n.update(['a', 'b']); await flush();
  const id = native.sendNotification.mock.calls[1][0].id;
  click({ actionId: 'tap', notification: { id } }); await flush();
  expect(n.review).toHaveBeenCalledWith('b');
  expect(native.show).toHaveBeenCalledOnce();
  expect(native.unminimize).toHaveBeenCalledOnce();
  expect(native.setFocus).toHaveBeenCalledOnce();
});
it('sanitizes localized notification and action text with the approval display rules', async () => {
  const translate = i18n.t;
  vi.spyOn(i18n, 't').mockImplementation((key, ...args) => {
    if (key === 'ownerApprovalNotification') return '\u202eAn app\n is asking · Approval： yes';
    if (key === 'ownerApprovalReview') return 'Review\u0000 · Request: now';
    return translate(key, ...args);
  });
  const n = setup(); n.update(['private-request']); await flush();
  expect(native.sendNotification).toHaveBeenCalledWith(expect.objectContaining({
    body: 'An app is asking / Approval= yes',
  }));
  expect(native.registerActionTypes).toHaveBeenCalledWith([{ id: 'bitsov-owner-approval', actions: [{
    id: 'review', title: 'Review / Request= now',
  }] }]);
});

it.each(['not-now', 'Escape', 'scrim', 'cancel', 'close'])('a notification click during Touch ID keeps %s locked, then opens the clicked request', async kind => {
  native.isTauri.mockReturnValue(true);
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh');
  const now = Date.now();
  const request = (id: string): ApprovalView => ({ op_id: id, node: 'n', client_id: 'phone', client_pubkey: 'cd'.repeat(32), epoch: 4, grant_op: null,
    request: { kind: 'spend_grant', terms: { budget_msat: 2000, per_call_max_msat: 1000, window_secs: 600 } },
    nonce: '11'.repeat(16), expires_at: now / 1000 + 300, approval_message: `private signed bytes ${id}`, status: 'pending', owner_action: null });
  const approvals = [request('a'), request('b')];
  const memory = approvalMemory();
  let finish!: (value: { ok: true; value: ApprovalView }) => void;
  const approve = vi.fn(() => new Promise<{ ok: true; value: ApprovalView }>(resolve => { finish = resolve; }));
  const mount = document.createElement('div'); document.body.append(mount);
  const unmount = render(() => <OwnerApprovalSheets approvals={approvals} now={now} memory={memory} approve={approve} />, mount);
  dispose = () => { unmount(); mount.remove(); };
  await flush();
  const approval = approveOwnerRequest({ approvals, now, approve }, memory, approvals[0]);
  await flush();
  click({ actionId: 'tap', notification: { id: native.sendNotification.mock.calls[1][0].id } }); await flush();
  const dialog = mount.querySelector<HTMLDialogElement>('dialog')!;
  const dismiss = mount.querySelector<HTMLButtonElement>('[data-owner-sheet-dismiss]')!;
  expect(dismiss.disabled).toBe(true);
  expect(dialog.textContent).toContain('Waiting for Touch ID…');
  if (kind === 'not-now') dismiss.click();
  else if (kind === 'Escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  else if (kind === 'scrim') dialog.click();
  else if (kind === 'cancel') {
    const event = new Event('cancel', { cancelable: true }); dialog.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  } else dialog.close();
  await flush();
  expect(mount.querySelector('[data-owner-approval-sheet="a"]')).not.toBeNull();
  expect(dialog.open).toBe(true);
  expect(dismiss.disabled).toBe(true);
  finish({ ok: true, value: { ...approvals[0], status: 'consumed' } }); await approval; await flush();
  expect(mount.querySelector('[data-owner-approval-sheet="b"]')).not.toBeNull();
  expect(mount.textContent).not.toContain('Approved.');
  expect(document.querySelectorAll('dialog[open]')).toHaveLength(1);
  expect(approve).toHaveBeenCalledExactlyOnceWith('a', 'private signed bytes a');
});
it('quietly falls back on denied permission without asking repeatedly', async () => {
  native.isPermissionGranted.mockResolvedValue(false); native.requestPermission.mockResolvedValue('denied');
  const n = setup(); n.update(['a', 'b']); await flush(); n.update(['a', 'b', 'c']); await flush();
  expect(native.requestPermission).toHaveBeenCalledOnce();
  expect(native.sendNotification).not.toHaveBeenCalled();
});
it('rechecks focus after the permission await', async () => {
  native.isFocused.mockResolvedValueOnce(false).mockResolvedValue(true);
  const n = setup(); n.update(['a']); await flush();
  expect(native.sendNotification).not.toHaveBeenCalled();
});
it('ignores expired/withdrawn and unknown notification clicks', async () => {
  const n = setup(); n.update(['a']); await flush(); const id = native.sendNotification.mock.calls[0][0].id;
  n.update([]); click({ actionId: 'tap', notification: { id } }); click({ actionId: 'tap', notification: { id: -1 } }); await flush();
  expect(n.review).not.toHaveBeenCalled();
});
it('fails quietly if native access fails', async () => {
  native.isPermissionGranted.mockRejectedValue(new Error('unavailable'));
  const n = setup(); n.update(['a']); await flush(); expect(native.sendNotification).not.toHaveBeenCalled();
});
it('unregisters and suppresses queued work after disposal', async () => {
  const n = setup(); n.update(['a']); n.dispose(); await flush();
  expect(native.sendNotification).not.toHaveBeenCalled(); expect(native.unregister).toHaveBeenCalledOnce();
});
it('does not turn a focused arrival into a notification while an earlier request awaits permission', async () => {
  let grant!: (value: boolean) => void;
  native.isPermissionGranted.mockImplementationOnce(() => new Promise(resolve => { grant = resolve; }));
  const n = setup(); n.update(['a']); await flush();
  native.isFocused.mockResolvedValue(true); n.update(['a', 'b']); await flush();
  native.isFocused.mockResolvedValue(false); grant(true); await flush();
  expect(native.sendNotification).toHaveBeenCalledTimes(1);
});

it('registers a localized review action before delivery so the macOS backend waits for clicks', async () => {
  const n = setup(); n.update(['a']); await flush();
  expect(native.registerActionTypes).toHaveBeenCalledWith([{ id: 'bitsov-owner-approval', actions: [{ id: 'review', title: 'Review request' }] }]);
  expect(native.registerActionTypes.mock.invocationCallOrder[0]).toBeLessThan(native.sendNotification.mock.invocationCallOrder[0]);
  const id = native.sendNotification.mock.calls[0][0].id;
  click({ actionId: 'review', notification: { id } }); await flush();
  expect(n.review).toHaveBeenCalledWith('a');
});

it.each(['en', 'da'] as const)('keeps the real %s M1a sheet usable when notification permission is denied', async lang => {
  setLanguagePref(lang);
  native.isTauri.mockReturnValue(true);
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh');
  native.isPermissionGranted.mockResolvedValue(false);
  native.requestPermission.mockResolvedValue('denied');
  const now = Date.now();
  const request: ApprovalView = { op_id: 'a', node: 'n', client_id: 'phone', client_pubkey: 'cd'.repeat(32), epoch: 4, grant_op: null,
    request: { kind: 'spend_grant', terms: { budget_msat: 2000, per_call_max_msat: 1000, window_secs: 600 } },
    nonce: '11'.repeat(16), expires_at: now / 1000 + 300, approval_message: 'private signed bytes', status: 'pending', owner_action: null };
  const [approvals, setApprovals] = createSignal<ApprovalView[]>([]);
  const mount = document.createElement('div'); document.body.append(mount);
  const approve = vi.fn();
  const unmount = render(() => <OwnerApprovalSheets approvals={approvals()} now={now} memory={approvalMemory()} approve={approve} />, mount);
  dispose = () => { unmount(); mount.remove(); };
  await flush(); expect(native.requestPermission).not.toHaveBeenCalled();
  setApprovals([request]); await flush();
  expect(native.requestPermission).toHaveBeenCalledOnce();
  expect(native.sendNotification).not.toHaveBeenCalled();
  expect(mount.querySelector('[data-owner-approval-sheet="a"]')).not.toBeNull();
  expect(mount.querySelector('[data-owner-sheet-approve]')?.textContent).toBe(lang === 'en' ? 'Approve with Touch ID' : 'Godkend med Touch ID');
  expect(approve).not.toHaveBeenCalled();
});
it('can open the original notification after a transient list-read failure recovers', async () => {
  const n = setup(); n.update(['a']); await flush();
  const id = native.sendNotification.mock.calls[0][0].id;
  n.update([]); // Failed reads temporarily remove all known-live requests.
  click({ actionId: 'tap', notification: { id } }); await flush();
  expect(n.review).not.toHaveBeenCalled();
  n.update(['a']); await flush();
  click({ actionId: 'tap', notification: { id } }); await flush();
  expect(n.review).toHaveBeenCalledWith('a');
  expect(native.sendNotification).toHaveBeenCalledOnce();
});

it.each(['wallet', 'settings', 'starter', 'idle-wallet', 'idle-settings'] as const)('respects %s activity on notification review and presents the selected request when safe', async panel => {
  const { ControlCenter } = await import('../src/control/Shell');
  const { sampleSource, SAMPLE_OWN_ID } = await import('../src/control/sample');
  native.isTauri.mockReturnValue(true);
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh');
  const source = sampleSource();
  vi.stubEnv('VITE_STARTER_BALANCE', '1');
  const overview = await source.nodeOverview();
  source.nodeOverview = async () => ({ ...overview, network: 'signet', capabilities: ['owner_device_approval_v1', 'starter_channel_request_v1'] });
  source.deviceKeys = async () => ({ device_approvals: 'enabled', owner_device_count: 1, device_keys: [] });
  source.approvalsPending = async () => [{ op_id: 'selected-request', node: 'n', client_id: 'phone', client_pubkey: 'cd'.repeat(32), epoch: 4, grant_op: null,
    request: { kind: 'spend_grant', terms: { budget_msat: 2000000, per_call_max_msat: 1000, window_secs: 600 } },
    nonce: '11'.repeat(16), expires_at: Date.now() / 1000 + 300, approval_message: 'signed bytes', status: 'pending', owner_action: null }];
  const register = source.deviceKeyRegister;
  source.deviceKeyRegister = () => new Promise(resolve => { finish = () => { void register().then(resolve); }; });
  const invoiceCreate = source.invoiceCreate;
  let finish!: () => void;
  source.starterCurrent = async () => ({ state: 'not_requested', hub_configured: true });
  source.starterRequest = id => new Promise(resolve => { finish = () => resolve({ state: 'requested', hub_configured: true, request_id: id }); });
  source.invoiceCreate = (amount, note) => new Promise(resolve => { finish = () => { void invoiceCreate(amount, note).then(resolve); }; });
  const mount = document.createElement('div'); document.body.append(mount);
  const unmount = render(() => <ControlCenter source={source} active ready remote error={null} ownId={SAMPLE_OWN_ID} firstRun={null} />, mount);
  dispose = () => { unmount(); mount.remove(); };
  const press = (selector: string) => mount.querySelector<HTMLButtonElement>(selector)!.click();
  await vi.waitFor(() => expect(native.sendNotification).toHaveBeenCalledOnce());
  press('[data-owner-sheet-dismiss]');
  if (panel === 'idle-wallet' || panel === 'idle-settings') {
    press('[data-tab="wallet"]');
    if (panel === 'idle-wallet') press('[data-open-wallet-page]');
    await flush();
    click({ actionId: 'tap', notification: { id: native.sendNotification.mock.calls[0][0].id } }); await flush();
    await vi.waitFor(() => expect(mount.querySelector('[data-owner-approval-sheet="selected-request"]')).not.toBeNull());
    expect(mount.querySelector('[data-wallet-page]')).toBeNull();
    expect(mount.querySelector('[data-settings]')!.getAttribute('aria-hidden')).toBe('true');
    return;
  }
  if (panel === 'wallet') {
    press('[data-tab="wallet"]'); press('[data-open-wallet-page]'); press('[data-wallet-tab="receive"]');
    const input = mount.querySelector<HTMLInputElement>('[data-receive-amount]')!;
    input.value = '1250'; input.dispatchEvent(new Event('input', { bubbles: true }));
    press('[data-receive-create]'); await flush();
    expect(mount.querySelector<HTMLButtonElement>('[data-receive-create]')!.disabled).toBe(true);
  } else if (panel === 'starter') {
    press('[data-tab="wallet"]'); press('[data-open-wallet-page]'); await flush();
    press('[data-starter-entry]'); await flush(); press('[data-starter-balance] button.primary'); await flush();
    expect(mount.querySelector<HTMLButtonElement>('[data-starter-balance] button.primary')!.disabled).toBe(true);
  } else {
    press('[data-tab="devices"]'); await flush(); press('[data-device-register]'); await flush();
    expect(mount.querySelector<HTMLButtonElement>('[data-device-register]')!.disabled).toBe(true);
  }
  click({ actionId: 'tap', notification: { id: native.sendNotification.mock.calls[0][0].id } }); await flush();
  expect(mount.querySelector(panel !== 'settings' ? '[data-wallet-page]' : '[data-settings][aria-hidden="false"]')).not.toBeNull();
  expect(mount.querySelector('[data-owner-approval-sheet]')).toBeNull();
  finish(); await flush();
  if (panel === 'wallet') expect(mount.querySelector('[data-receive-invoice]')).not.toBeNull();
  if (panel === 'starter') press('[data-wallet-close]');
  press(panel !== 'settings' ? '[data-wallet-close]' : '[data-settings-close]'); await flush();
  await vi.waitFor(() => expect(mount.querySelector('[data-owner-approval-sheet="selected-request"]')).not.toBeNull());
});

it.each(['reconcile', 'connection'] as const)('preserves the %s check and its result when an approval notification is clicked', async check => {
  const { ControlCenter } = await import('../src/control/Shell');
  const { sampleSource, SAMPLE_OWN_ID } = await import('../src/control/sample');
  native.isTauri.mockReturnValue(true);
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh');
  const source = sampleSource({ firstLiveMs: 1e9 });
  const overview = await source.nodeOverview();
  source.nodeOverview = async () => ({ ...overview, capabilities: ['owner_device_approval_v1'] });
  source.deviceKeys = async () => ({ device_approvals: 'enabled', owner_device_count: 1, device_keys: [] });
  source.approvalsPending = async () => ['first-request', 'clicked-request'].map(op_id => ({
    op_id, node: 'n', client_id: 'phone', client_pubkey: 'cd'.repeat(32), epoch: 4, grant_op: null,
    request: { kind: 'spend_grant' as const, terms: { budget_msat: 2000000, per_call_max_msat: 1000, window_secs: 600 } },
    nonce: '11'.repeat(16), expires_at: Date.now() / 1000 + 300, approval_message: 'signed bytes', status: 'pending' as const, owner_action: null,
  }));
  const budget = await source.budgetStatus();
  source.budgetStatus = async () => ({ ...budget, unsettled_msat: check === 'reconcile' ? 2000 : 0 });
  let finish!: () => void;
  source.spendReconcile = async () => {
    await new Promise<void>(resolve => { finish = resolve; });
    return 'Previous action settled.';
  };
  const [answer, setAnswer] = createSignal<{ at: number; ms: number } | null>(null);
  const checkedAt = new Date(2026, 9, 22, 12, 4, 31).getTime();
  const onCheckNode = async () => {
    await new Promise<void>(resolve => { finish = resolve; });
    setAnswer({ at: checkedAt, ms: 85 });
  };
  const mount = document.createElement('div'); document.body.append(mount);
  // Deliberately leave the parent idle: the card's own pending promise must
  // register with the real settings scope, without the shell's checkingNode guard.
  const unmount = render(() => <ControlCenter source={source} active ready remote error={null} ownId={SAMPLE_OWN_ID}
    firstRun={null} onCheckNode={onCheckNode} checkingNode={false} nodeAnswer={answer()} />, mount);
  dispose = () => { unmount(); mount.remove(); };
  const press = (selector: string) => mount.querySelector<HTMLButtonElement>(selector)!.click();
  await vi.waitFor(() => expect(native.sendNotification).toHaveBeenCalledTimes(2));
  press('[data-owner-sheet-dismiss]');
  press(check === 'reconcile' ? '[data-tab="wallet"]' : '[data-tab="node"]');
  if (check === 'reconcile') press('[data-open-wallet-page]');
  const panel = check === 'reconcile' ? '[data-wallet-page]' : '[data-settings][aria-hidden="false"]';
  const button = `${panel} ${check === 'reconcile' ? '[data-spend-reconcile]' : '[data-connection-check]'}`;
  await vi.waitFor(() => expect(mount.querySelector(button)).not.toBeNull());
  press(button);
  expect(mount.querySelector<HTMLButtonElement>(button)!.disabled).toBe(true);
  click({ actionId: 'tap', notification: { id: native.sendNotification.mock.calls[1][0].id } }); await flush();
  expect(mount.querySelector(panel)).not.toBeNull();
  expect(mount.querySelector('[data-owner-approval-sheet]')).toBeNull();
  finish(); await flush();
  expect(mount.querySelector(panel)).not.toBeNull();
  expect(mount.querySelector<HTMLButtonElement>(button)!.disabled).toBe(false);
  expect(mount.querySelector(`${panel} ${check === 'reconcile' ? '[data-reconciliation]' : '[data-connection-line="2"]'}`)?.textContent)
    .toBe(check === 'reconcile' ? 'Previous action settled.' : `Last status check: ${new Date(checkedAt).toLocaleTimeString()} · 85 ms (this app ↔ its host)`);
  expect(mount.querySelector('[data-owner-approval-sheet]')).toBeNull();
  press(check === 'reconcile' ? '[data-wallet-close]' : '[data-settings-close]'); await flush();
  await vi.waitFor(() => expect(mount.querySelector('[data-owner-approval-sheet="clicked-request"]')).not.toBeNull());
});
