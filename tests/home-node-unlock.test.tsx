import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import { LockedNode } from '../src/onboarding/LockedNode';

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); document.body.innerHTML = ''; vi.unstubAllGlobals(); });
it('shows a locked node without onboarding or money controls, and unlocks only on a click', async () => {
  let locked = true;
  const calls: string[] = [];
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke: (cmd: string) => {
    calls.push(cmd);
    if (cmd === 'node_status') return Promise.resolve({ ready: !locked, node_id: 'ab'.repeat(32), error: null, locked });
    if (cmd === 'pairing_status') return Promise.resolve({ state: 'paired', remote: true, scopes: ['read'], bootstrap: null });
    if (cmd === 'node_unlock') { locked = false; return Promise.resolve(); }
    return Promise.reject('unavailable');
  }});
  const mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <App />, mount);
  await vi.waitFor(() => expect(mount.textContent).toContain('Locked after a restart. Unlock to receive.'));
  expect(mount.textContent).toContain('While locked, payments to you fail and open channels are not watched. Unlock within a day.');
  expect(mount.querySelector('input[type="password"]')).toBeNull();
  expect(calls).not.toContain('node_unlock');
  expect(calls).not.toContain('device_key_status');
  const button = [...mount.querySelectorAll('button')].find(b => b.textContent === 'Unlock with Touch ID')!;
  button.click();
  await vi.waitFor(() => expect(mount.querySelector('[data-node-locked]')).toBeNull());
  expect(calls.filter(c => c === 'node_unlock')).toHaveLength(1);
});

it('shows passive host failures on a locked node without requesting credentials', async () => {
  const calls: string[] = [];
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke: (cmd: string) => {
    calls.push(cmd);
    if (cmd === 'node_status') return Promise.resolve({ ready: false, node_id: 'ab'.repeat(32), error: 'Your node is still starting.', locked: true });
    if (cmd === 'pairing_status') return Promise.resolve({ state: 'paired', remote: true, scopes: ['read'], bootstrap: null });
    return Promise.reject('unavailable');
  }});
  const mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <App />, mount);
  await vi.waitFor(() => expect(mount.querySelector('[role="alert"]')?.textContent).toContain('still starting'));
  expect(calls).not.toContain('node_unlock');
});

it('shows the locked badge and biometric unlock action on mobile', () => {
  const mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <LockedNode mobile onUnlock={async () => {}} />, mount);
  expect(mount.querySelector('[data-locked-badge]')?.textContent).toBe('Node locked');
  expect([...mount.querySelectorAll('button')].some(
    button => button.textContent === 'Unlock with biometrics',
  )).toBe(true);
  expect(mount.querySelector('input[type="password"]')).toBeNull();
});
