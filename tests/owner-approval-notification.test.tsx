import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { OwnerApprovalSheets } from '../src/control/OwnerApprovalSheet';
import { approvalMemory } from '../src/control/OwnerApprovals';
import type { ApprovalView } from '../src/control/ownerApproval';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLanguagePref } from '../src/i18n';
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
afterEach(() => { dispose?.(); vi.restoreAllMocks(); setLanguagePref('en'); });
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
