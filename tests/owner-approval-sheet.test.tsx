import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { approvalMemory, approveOwnerRequest, OwnerApprovals } from '../src/control/OwnerApprovals';
import { OwnerApprovalSheets } from '../src/control/OwnerApprovalSheet';
import { setLanguagePref } from '../src/i18n';
import type { ApprovalView } from '../src/control/ownerApproval';

const NOW = 1_800_000_000_000;
const request = (id = 'a'): ApprovalView => ({ op_id: id, node: 'n', client_id: 'phone', client_pubkey: 'cd'.repeat(32),
  epoch: 4, grant_op: null, request: { kind: 'spend_grant', terms: { budget_msat: 2_000_000, per_call_max_msat: 10_000, window_secs: 600 } },
  nonce: '11'.repeat(16), expires_at: NOW / 1000 + 300, approval_message: `exact signed bytes\n${id}`, status: 'pending', owner_action: null });
let dispose: () => void;
let mount: HTMLDivElement;
afterEach(() => { dispose?.(); mount?.remove(); setLanguagePref('en'); vi.useRealTimers(); });
const $ = (s: string) => mount.querySelector<HTMLElement>(s)!;
function setup(initial: ApprovalView[] = []) {
  const [approvals, setApprovals] = createSignal(initial);
  const [now, setNow] = createSignal(NOW);
  const [blocked, setBlocked] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const memory = approvalMemory();
  const approve = vi.fn(async () => ({ ok: true as const, value: { ...request(), status: 'consumed' as const } }));
  mount = document.createElement('div'); document.body.append(mount);
  dispose = render(() => <><button data-opener>Outside</button>
    <OwnerApprovals approvals={approvals()} now={now()} memory={memory} approve={approve} onReview={memory.setReview} />
    <OwnerApprovalSheets approvals={approvals()} now={now()} memory={memory} approve={approve} blocked={blocked()} error={error()} />
  </>, mount);
  return { setApprovals, setNow, setBlocked, setError, approve, memory };
}
const tick = () => new Promise<void>(r => queueMicrotask(r));
describe.each(['en', 'da'] as const)('owner approval sheet (%s)', lang => {
  it('opens on arrival with exact biometric terms, requester, one primary and queue count', async () => {
    setLanguagePref(lang); const s = setup();
    s.setApprovals([request(), request('b')]); await tick();
    expect(mount.querySelectorAll('[data-owner-approval-sheet]')).toHaveLength(1);
    expect($('[data-owner-approval-sheet]').textContent).toContain('Budget: up to 2\u202f000 sats');
    expect($('[data-owner-approval-sheet]').textContent).toContain('cdcdcd…cdcdcd');
    expect($('[data-owner-approval-queue]').textContent).toBe(lang === 'en' ? '1 of 2' : '1 af 2');
    expect($('[data-owner-approval-sheet] .primary').textContent).toBe(lang === 'en' ? 'Approve with Touch ID' : 'Godkend med Touch ID');
    expect($('[data-owner-sheet-terms]').getAttribute('lang')).toBe('en');
    expect(s.approve).not.toHaveBeenCalled();
  });
  it.each(['not-now', 'Escape', 'scrim', 'close'])('%s grants nothing, preserves the list, restores focus and can reopen', async kind => {
    setLanguagePref(lang); const s = setup(); $('[data-opener]').focus();
    s.setApprovals([request()]); await tick();
    if (kind === 'not-now') $('[data-owner-sheet-dismiss]').click();
    else if (kind === 'Escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    else if (kind === 'scrim') $('[data-owner-sheet-scrim]').click();
    else ($('[data-owner-sheet-scrim]') as HTMLDialogElement).close();
    await tick();
    expect($('[data-owner-approval-sheet]')).toBeNull();
    expect(document.activeElement).toBe($('[data-opener]'));
    expect($('[data-owner-approval="a"]')).not.toBeNull();
    $('[data-approval-review]').click(); await tick();
    expect($('[data-owner-approval-sheet]')).not.toBeNull();
    expect(s.approve).not.toHaveBeenCalled();
  });
  it('closes on expiry with a plain localized line', async () => {
    setLanguagePref(lang); const s = setup([request()]); await tick();
    s.setNow(NOW + 301_000); await tick();
    expect($('[data-owner-approval-sheet]')).toBeNull();
    expect($('[data-owner-sheet-status]').textContent).toContain(lang === 'en' ? 'This request expired.' : 'Anmodningen er udløbet.');
    expect(s.approve).not.toHaveBeenCalled();
  });
});
it('keeps a stable single sheet as arrivals and dismissals advance the queue; polls do not reopen deferred requests', async () => {
  const s = setup([request()]); await tick();
  s.setApprovals([request('b'), request()]); await tick();
  expect($('[data-owner-approval-sheet]').getAttribute('data-owner-approval-sheet')).toBe('a');
  $('[data-owner-sheet-dismiss]').click(); await tick();
  expect($('[data-owner-approval-sheet]').getAttribute('data-owner-approval-sheet')).toBe('b');
  $('[data-owner-sheet-dismiss]').click(); await tick();
  s.setApprovals([request(), request('b')]); await tick();
  expect($('[data-owner-approval-sheet]')).toBeNull();
  expect(s.approve).not.toHaveBeenCalled();
});
it('waits for an existing sheet and traps focus once it opens', async () => {
  const s = setup(); s.setBlocked(true); s.setApprovals([request()]); await tick();
  expect($('[data-owner-approval-sheet]')).toBeNull(); s.setBlocked(false); await tick();
  const sheet = $('[data-owner-approval-sheet]');
  $('[data-opener]').focus(); expect(sheet.contains(document.activeElement)).toBe(true);
  $('[data-owner-sheet-dismiss]').focus();
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(sheet.querySelector('summary'));
});
it('closes on withdrawal, and distinguishes an unreadable list from withdrawal', async () => {
  const s = setup([request()]); await tick(); s.setError('Cannot read'); s.setApprovals([]); await tick();
  expect($('[data-owner-approval-sheet]')).toBeNull();
  expect($('[data-owner-sheet-status]').textContent).toContain('Cannot read');
  s.setError(null); s.setApprovals([request('b')]); await tick(); s.setApprovals([]); await tick();
  expect($('[data-owner-sheet-status]').textContent).toContain('This request is no longer waiting');
  expect(s.approve).not.toHaveBeenCalled();
});
it('submits only the original op id and signed message through the existing approval path', async () => {
  const s = setup([request()]); await tick(); $('[data-owner-sheet-approve]').click(); await tick();
  expect(s.approve).toHaveBeenCalledExactlyOnceWith('a', 'exact signed bytes\na');
});
it('restores the original opener after dismissing the whole queue', async () => {
  const s = setup(); $('[data-opener]').focus(); s.setApprovals([request(), request('b')]); await tick();
  $('[data-owner-sheet-dismiss]').click(); await tick(); $('[data-owner-sheet-dismiss]').click(); await tick();
  expect(document.activeElement).toBe($('[data-opener]'));
});
it('counts every pending request, including deferred and reopened requests', async () => {
  const s = setup([request(), request('b')]); await tick(); $('[data-owner-sheet-dismiss]').click(); await tick();
  expect($('[data-owner-approval-queue]').textContent).toBe('1 of 2');
  $('[data-owner-sheet-dismiss]').click(); await tick();
  $('[data-approval-review]').click(); await tick();
  expect($('[data-owner-approval-queue]').textContent).toBe('1 of 2');
});
it('resets the expiry explanation when the next queued request opens', async () => {
  const s = setup([request(), { ...request('b'), expires_at: NOW / 1000 + 600 }]); await tick();
  s.setNow(NOW + 301_000); await tick();
  expect($('[data-owner-approval-sheet]').getAttribute('data-owner-approval-sheet')).toBe('b');
  expect($('[data-owner-sheet-status]')).toBeNull();
  expect($('[data-owner-approval-sheet]').textContent).not.toContain('This request expired.');
});
it('ignores a queued native close event from the previous dialog', async () => {
  setup([request(), request('b')]); await tick();
  const old = $('[data-owner-sheet-scrim]'); $('[data-owner-sheet-dismiss]').click(); await tick();
  old.dispatchEvent(new Event('close')); await tick();
  expect($('[data-owner-approval-sheet]')?.getAttribute('data-owner-approval-sheet')).toBe('b');
});
describe.each(['en', 'da'] as const)('in-flight approval (%s)', lang => {
  it.each(['not-now', 'Escape', 'scrim', 'cancel', 'close'])('blocks %s and shows the result on its own request', async kind => {
    setLanguagePref(lang); const s = setup([request(), request('b')]); await tick();
    let finish!: (v: { ok: true; value: ApprovalView & { status: 'consumed' } }) => void;
    s.approve.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const approval = approveOwnerRequest({ approvals: [request()], now: NOW, approve: s.approve }, s.memory, request());
    await tick();
    const dialog = $('[data-owner-sheet-scrim]') as HTMLDialogElement;
    expect(($('[data-owner-sheet-dismiss]') as HTMLButtonElement).disabled).toBe(true);
    expect($('[data-owner-approval-sheet]').textContent).toContain(lang === 'en' ? 'Waiting for Touch ID…' : 'Venter på Touch ID…');
    expect($('[data-owner-approval-sheet]').textContent).not.toContain(lang === 'en' ? 'Not now grants nothing' : 'Ikke nu giver ingen tilladelse');
    if (kind === 'not-now') $('[data-owner-sheet-dismiss]').click();
    else if (kind === 'Escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    else if (kind === 'scrim') dialog.click();
    else if (kind === 'cancel') {
      const event = new Event('cancel', { cancelable: true }); dialog.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
    } else dialog.close();
    await tick();
    expect($('[data-owner-approval-sheet]')?.getAttribute('data-owner-approval-sheet')).toBe('a');
    expect(dialog.open).toBe(true);
    finish({ ok: true, value: { ...request(), status: 'consumed' } }); await approval; await tick();
    expect($('[data-owner-approval-sheet]')?.getAttribute('data-owner-approval-sheet')).toBe('a');
    expect($('[data-owner-approval-sheet]').textContent).toContain(lang === 'en' ? 'Approved.' : 'Godkendt.');
    expect($('[data-owner-sheet-approve]')).toBeNull();
    expect($('[data-owner-sheet-dismiss]').textContent).toBe(lang === 'en' ? 'Dismiss' : 'Luk');
    $('[data-owner-sheet-dismiss]').click(); await tick();
    expect($('[data-owner-approval-sheet]')?.getAttribute('data-owner-approval-sheet')).toBe('b');
    expect($('[data-owner-approval-sheet]').textContent).not.toContain(lang === 'en' ? 'Approved.' : 'Godkendt.');
  });
});
it('clears the bottom status after five seconds', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const s = setup([request()]); await tick(); s.setApprovals([]); await tick();
  expect($('[data-owner-sheet-status]')).not.toBeNull();
  vi.advanceTimersByTime(5_000); await tick();
  expect($('[data-owner-sheet-status]')).toBeNull();
});
it.each([false, true])('yields to a later dialog and resumes the same request (busy=%s)', async busy => {
  const s = setup([request(), request('b')]); await tick();
  if (busy) s.memory.setBusy('a');
  const other = document.createElement('dialog');
  const input = document.createElement('input'); other.append(input); document.body.append(other);
  try {
    other.showModal(); input.focus(); await tick(); await tick();
    expect($('[data-owner-approval-sheet]')).toBeNull();
    expect(document.activeElement).toBe(input);
    if (busy) {
      s.memory.setSaid({ a: { ok: true, text: 'Approved.' } }); s.memory.setBusy(null);
    }
    other.close(); await tick(); await tick();
    expect($('[data-owner-approval-sheet]')?.getAttribute('data-owner-approval-sheet')).toBe('a');
    if (busy) expect($('[data-owner-approval-sheet]').textContent).toContain('Approved.');
  } finally { other.remove(); }
});
it('suspends for a newly blocked flow and resumes without skipping its request', async () => {
  const s = setup([request(), request('b')]); await tick(); s.setBlocked(true); await tick();
  expect($('[data-owner-approval-sheet]')).toBeNull();
  s.setBlocked(false); await tick();
  expect($('[data-owner-approval-sheet]')?.getAttribute('data-owner-approval-sheet')).toBe('a');
});
it('keeps a failed Touch ID result visible if the request expires during approval', async () => {
  const s = setup([request()]); await tick();
  s.memory.setBusy('a'); s.setNow(NOW + 301_000); await tick();
  s.memory.setSaid({ a: { ok: false, text: 'This request expired. Nothing was approved.' } });
  s.memory.setBusy(null); await tick();
  expect($('[data-owner-approval-sheet]').textContent).toContain('This request expired. Nothing was approved.');
  expect(($('[data-owner-sheet-approve]') as HTMLButtonElement).disabled).toBe(true);
});
