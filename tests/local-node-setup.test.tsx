import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import { INITIAL_PAIRING } from '../src/onboarding/pairing';

let dispose: (() => void) | undefined;
let mount: HTMLElement;
afterEach(() => { dispose?.(); mount?.remove(); vi.unstubAllGlobals(); localStorage.clear(); });
function show(invoke: (cmd: string, args?: unknown) => Promise<unknown>) {
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
  mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <App />, mount);
}
const setupCalls = (invoke: ReturnType<typeof vi.fn>) =>
  invoke.mock.calls.filter(([cmd]) => cmd === 'node_setup_local');

it('a fresh Mac shows the choice and creates a node only after the explicit confirm', async () => {
  let needed = true;
  const invoke = vi.fn(async (cmd: string, _args?: unknown) => {
    if (cmd === 'node_status') return { ready: false, node_id: null, error: null, local_setup_needed: needed };
    if (cmd === 'pairing_status') return INITIAL_PAIRING;
    if (cmd === 'node_setup_local') { needed = false; return; }
    throw new Error('unavailable');
  });
  show(invoke);
  await vi.waitFor(() => expect(mount.querySelector('[data-local-setup]')).not.toBeNull());
  // Both routes are offered; nothing pretends a node is starting.
  expect(mount.querySelector('[data-target="local"]')).not.toBeNull();
  expect(mount.querySelector('[data-target="network"]')).not.toBeNull();
  expect(mount.textContent).toContain('Nothing has been created yet.');
  expect(mount.textContent).toContain('recovery phrase and wallet');
  expect(mount.textContent).not.toContain('Starting your node');
  // Waiting, polling and choosing a route are not consent.
  await new Promise(resolve => setTimeout(resolve, 1700));
  mount.querySelector<HTMLButtonElement>('[data-target="network"]')!.click();
  await vi.waitFor(() => expect(mount.querySelector('[data-local-setup]')).toBeNull());
  mount.querySelector<HTMLButtonElement>('[data-target="local"]')!.click();
  await vi.waitFor(() => expect(mount.querySelector('[data-local-setup]')).not.toBeNull());
  expect(setupCalls(invoke)).toHaveLength(0);

  mount.querySelector<HTMLButtonElement>('[data-local-setup-confirm]')!.click();
  await vi.waitFor(() => expect(mount.querySelector('[data-local-setup]')).toBeNull());
  expect(setupCalls(invoke)).toHaveLength(1);
  expect(setupCalls(invoke)[0][1]).toEqual({ confirmed: true });
});

it('keeps the choice open after a failed setup and never retries on its own', async () => {
  const invoke = vi.fn(async (cmd: string, _args?: unknown) => {
    if (cmd === 'node_status') return { ready: false, node_id: null, error: null, local_setup_needed: true };
    if (cmd === 'pairing_status') return INITIAL_PAIRING;
    if (cmd === 'node_setup_local') throw new Error('node init failed (exit Some(1))');
    throw new Error('unavailable');
  });
  show(invoke);
  await vi.waitFor(() => expect(mount.querySelector('[data-local-setup-confirm]')).not.toBeNull());
  mount.querySelector<HTMLButtonElement>('[data-local-setup-confirm]')!.click();
  await vi.waitFor(() => expect(mount.querySelector('[data-local-setup] [role="alert"]')).not.toBeNull());
  await new Promise(resolve => setTimeout(resolve, 1700));
  expect(setupCalls(invoke)).toHaveLength(1);
  expect(mount.querySelector<HTMLButtonElement>('[data-local-setup-confirm]')!.disabled).toBe(false);
});

it('an existing install never shows the choice', async () => {
  const invoke = vi.fn(async (cmd: string, _args?: unknown) => {
    if (cmd === 'node_status') return { ready: false, node_id: null, error: null };
    if (cmd === 'pairing_status') return INITIAL_PAIRING;
    throw new Error('unavailable');
  });
  show(invoke);
  await vi.waitFor(() => expect(mount.querySelector('[data-target="local"]')).not.toBeNull());
  await new Promise(resolve => setTimeout(resolve, 1700));
  expect(mount.querySelector('[data-local-setup]')).toBeNull();
  expect(setupCalls(invoke)).toHaveLength(0);
});
