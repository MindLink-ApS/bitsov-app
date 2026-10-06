import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalOwnerCeremony, type OwnerApi } from '../src/onboarding/LocalOwnerCeremony';
const phrase = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
const pending = () => ({ ceremony_id: 'c'.repeat(32), node_id: 'a'.repeat(64), mnemonic: phrase, backup_check: [0, 4, 9], expires_at: 9999999999 });
let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); document.body.innerHTML = ''; });
const tick = async () => { await new Promise(r => setTimeout(r, 0)); };
const click = async (text: string) => { [...document.querySelectorAll('button')].find(b => b.textContent === text)!.click(); await tick(); };
function mount(overrides: Partial<OwnerApi> = {}) {
  const api: OwnerApi = { create: vi.fn(async () => pending()), cancel: vi.fn(async () => {}), finalize: vi.fn(async () => {}), reconcile: vi.fn(async () => {}), ...overrides };
  dispose = render(() => <LocalOwnerCeremony api={api} onComplete={() => {}} />, document.body);
  return api;
}
it('shows once, removes phrase before asking for three words and clears inputs on submit', async () => {
  let submitted: string[] = [];
  const api = mount({ finalize: vi.fn(async words => { submitted = [...words]; }) });
  await click('Create identity');
  expect(document.body.textContent).toContain('abandon');
  await click('I wrote it down');
  expect(document.body.textContent).not.toContain('abandon');
  expect([...document.querySelectorAll('label')].map(l => l.textContent)).toEqual(['Word 1', 'Word 5', 'Word 10']);
  const inputs = [...document.querySelectorAll('input')];
  ['abandon', 'above', 'abuse'].forEach((w, i) => { inputs[i].value = w; inputs[i].dispatchEvent(new Event('input', { bubbles: true })); });
  await click('Confirm backup with Touch ID');
  expect(submitted).toEqual(['abandon', 'above', 'abuse']);
  expect(document.querySelectorAll('input').length).toBe(0);
});
it('clears phrase on failed cancel but does not claim cancellation', async () => {
  mount({ cancel: vi.fn(async () => { throw 'Cancellation unconfirmed'; }) });
  await click('Create identity'); await click('Cancel setup');
  expect(document.body.textContent).not.toContain('abandon');
  expect(document.body.textContent).toContain('Cancellation unconfirmed');
  expect(document.body.textContent).not.toContain('Setup cancelled');
});
it('a lost finalize is reconciled explicitly, never automatically retried', async () => {
  const api = mount({ finalize: vi.fn(async () => { throw 'Outcome unknown; check the node'; }) });
  await click('Create identity'); await click('I wrote it down');
  await click('Confirm backup with Touch ID');
  expect(api.finalize).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain('Outcome unknown');
  await click('Check node and continue');
  expect(api.reconcile).toHaveBeenCalledTimes(1);
  expect(api.finalize).toHaveBeenCalledTimes(1);
});
it('clears the phrase on expiry and on unmount, including a late create response', async () => {
  const api = mount({ create: vi.fn(async () => ({ ...pending(), expires_at: Date.now() / 1000 + 0.05 })) });
  await click('Create identity');
  expect(document.body.textContent).toContain('abandon');
  await new Promise(r => setTimeout(r, 70));
  expect(document.body.textContent).not.toContain('abandon');
  expect(document.body.textContent).toContain('Setup time expired');
  expect(api.finalize).not.toHaveBeenCalled();
  dispose!();
  let resolve!: (value: ReturnType<typeof pending>) => void;
  const late = mount({ create: vi.fn(() => new Promise<ReturnType<typeof pending>>(r => { resolve = r; })) });
  await click('Create identity'); dispose!();
  const response = pending(); resolve(response); await tick();
  expect(response.mnemonic).toBe('');
  expect(late.cancel).toHaveBeenCalledWith('c'.repeat(32));
});
