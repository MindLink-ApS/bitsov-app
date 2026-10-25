import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import { INITIAL_PAIRING } from '../src/onboarding/pairing';

let dispose: (() => void) | undefined;
let mount: HTMLElement;
afterEach(() => { dispose?.(); mount?.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); localStorage.clear(); });
function show(invoke: (cmd: string, args?: unknown) => Promise<unknown>) {
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
  mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <App />, mount);
}

it('waits for explicit repair consent, supports declining, and stops prompting after success', async () => {
  let repair = 'required';
  const invoke = vi.fn(async (cmd: string, _args?: unknown) => {
    if (cmd === 'node_status') return { ready: repair === 'none', node_id: null, error: null, initialization_repair: repair };
    if (cmd === 'pairing_status') return INITIAL_PAIRING;
    if (cmd === 'node_repair_initialized') { repair = 'none'; return; }
    throw new Error('unavailable');
  });
  show(invoke);
  await vi.waitFor(() => expect(mount.querySelector('[data-initialization-repair]')).not.toBeNull());
  expect(mount.textContent).toContain('setup was not recorded as complete');
  expect(mount.textContent).toContain('ask whoever set up the box for help');
  expect(mount.textContent).toContain('backup');
  expect(invoke.mock.calls.some(([cmd]) => cmd === 'node_repair_initialized')).toBe(false);
  mount.querySelector<HTMLButtonElement>('[data-repair-decline]')!.click();
  expect(invoke.mock.calls.some(([cmd]) => cmd === 'node_repair_initialized')).toBe(false);
  mount.querySelector<HTMLButtonElement>('[data-repair-review]')!.click();
  mount.querySelector<HTMLButtonElement>('[data-repair-consent]')!.click();
  await vi.waitFor(() => expect(mount.querySelector('[data-initialization-repair]')).toBeNull());
  expect(invoke.mock.calls.filter(([cmd]) => cmd === 'node_repair_initialized')).toHaveLength(1);
  expect(invoke.mock.calls.find(([cmd]) => cmd === 'node_repair_initialized')?.[1]).toEqual({ confirmed: true });
});

it('keeps a failed repair reviewable and never repeats it automatically', async () => {
  const invoke = vi.fn(async (cmd: string, _args?: unknown) => {
    if (cmd === 'node_status') return { ready: false, node_id: null, error: null, initialization_repair: 'required' };
    if (cmd === 'pairing_status') return INITIAL_PAIRING;
    if (cmd === 'node_repair_initialized') throw new Error('Repair failed; node remains stopped.');
    throw new Error('unavailable');
  });
  show(invoke);
  await vi.waitFor(() => expect(mount.querySelector('[data-repair-consent]')).not.toBeNull());
  mount.querySelector<HTMLButtonElement>('[data-repair-consent]')!.click();
  await vi.waitFor(() => expect(mount.textContent).toContain('Repair failed'));
  expect(invoke.mock.calls.filter(([cmd]) => cmd === 'node_repair_initialized')).toHaveLength(1);
  expect(mount.querySelector<HTMLButtonElement>('[data-repair-consent]')!.disabled).toBe(false);
});

it.each([false, true])('offers restore with mocked rc7/bootstrap status (bootstrap=%s)', async (bootstrap) => {
  const invoke = vi.fn(async (cmd: string, _args?: unknown) => {
    if (cmd === 'node_status') return { ready: !bootstrap, node_id: bootstrap ? null : 'aa'.repeat(32), error: null };
    if (cmd === 'pairing_status') return { ...INITIAL_PAIRING, state: bootstrap ? 'paired' : 'fallback', scopes: bootstrap ? ['read', 'receive', 'identity'] : [], bootstrap: bootstrap ? 'bootstrap' : null };
    if (cmd === 'identity_restore') return { node_id: 'bb'.repeat(32), restart_required: true, restarted: true };
    throw new Error('unavailable');
  });
  show(invoke);
  await vi.waitFor(() => expect(mount.querySelector('[data-restore-open]')).not.toBeNull());
  mount.querySelector<HTMLButtonElement>('[data-restore-open]')!.click();
  const input = mount.querySelector<HTMLInputElement>('#restore-phrase')!;
  input.value = 'abandon '.repeat(11) + 'about';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(invoke.mock.calls.some(([cmd]) => cmd === 'identity_restore')).toBe(true));
  expect(input.value).toBe('');
  if (bootstrap) expect(mount.textContent).not.toContain('I understand — continue to funding');
});

it('asks separately for the page price after marker repair, and sends no price consent on decline', async () => {
  let repair = 'required';
  const invoke = vi.fn(async (cmd: string, _args?: unknown) => {
    if (cmd === 'node_status') return { ready: repair === 'none', node_id: null, error: null, initialization_repair: repair };
    if (cmd === 'pairing_status') return INITIAL_PAIRING;
    if (cmd === 'node_repair_initialized') { repair = 'price_floor_required'; throw new Error('node sidecar terminated before becoming healthy'); }
    if (cmd === 'node_repair_price_floor') { repair = 'none'; return; }
    throw new Error('unavailable');
  });
  show(invoke);
  await vi.waitFor(() => expect(mount.querySelector('[data-repair-consent]')).not.toBeNull());
  mount.querySelector<HTMLButtonElement>('[data-repair-consent]')!.click();
  await vi.waitFor(() => expect(mount.textContent).toContain('at least 1 sat per page read'));
  expect(mount.textContent).toContain('0.05 sat');
  expect(mount.textContent).not.toContain('NODE_INITIALIZED');
  expect(mount.textContent).not.toContain('node sidecar terminated');
  expect(invoke.mock.calls.filter(([cmd]) => cmd === 'node_repair_price_floor')).toHaveLength(0);
  mount.querySelector<HTMLButtonElement>('[data-repair-decline]')!.click();
  expect(mount.textContent).toContain('Your node remains stopped');
  expect(invoke.mock.calls.filter(([cmd]) => cmd === 'node_repair_price_floor')).toHaveLength(0);
  mount.querySelector<HTMLButtonElement>('[data-repair-review]')!.click();
  mount.querySelector<HTMLButtonElement>('[data-repair-consent]')!.click();
  await vi.waitFor(() => expect(mount.querySelector('[data-initialization-repair]')).toBeNull());
  expect(invoke.mock.calls.filter(([cmd]) => cmd === 'node_repair_price_floor').map(([cmd, args]) => [cmd, args])).toEqual([['node_repair_price_floor', { confirmed: true }]]);
});
