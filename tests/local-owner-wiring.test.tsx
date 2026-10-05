import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import App from '../src/App';
let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); document.body.innerHTML = ''; vi.unstubAllGlobals(); });
function mount(local: boolean, remote = false, ready = false, trusted = false) {
  const id = 'ab'.repeat(32);
  if (trusted) localStorage.setItem(`bitsov.trust.v1.local.${id}`, 'accepted');
  const calls: string[] = [];
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke: (command: string) => {
    calls.push(command);
    if (command === 'node_status') return Promise.resolve({ ready, node_id: ready ? id : null, error: null, local_owner: local,
      owner_warning: ready ? 'Owner device not enrolled. Enroll through the owner console.' : null });
    if (command === 'pairing_status') return Promise.resolve({ state: 'paired', remote, scopes: ready ? ['read','receive'] : ['identity'], bootstrap: ready ? null : 'bootstrap', short_code: null, reason: null });
    return Promise.reject('unavailable');
  } });
  dispose = render(() => <App />, document.body);
  return calls;
}
it.each([[false,false], [true,true]])('does not offer local creation while off or remote (%s,%s)', async (local, remote) => {
  const calls = mount(local, remote);
  await vi.waitFor(() => expect(calls).toContain('pairing_status'));
  expect(document.querySelector('[data-local-owner]')).toBeNull();
  expect(calls.some(c => c.startsWith('local_owner_'))).toBe(false);
});
it('offers the dedicated owner screen only for local bootstrap without contradictory legacy copy', async () => {
  mount(true);
  await vi.waitFor(() => expect(document.querySelector('[data-local-owner]')).not.toBeNull());
  expect(document.body.textContent).not.toContain('Creating a new identity from this screen is not available yet');
  expect(document.querySelector('[data-restore-open]')).toBeNull();
});
it.each([false, true])('shows owner enrollment warning while ready, including after trust acceptance (%s)', async trusted => {
  mount(true, false, true, trusted);
  await vi.waitFor(() => expect(document.querySelector('[data-owner-warning]')?.textContent).toContain('Owner device not enrolled'));
  expect(document.body.textContent).toContain('owner console');
});
