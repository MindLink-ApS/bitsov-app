import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import { LockedNode, RememberUnlock } from '../src/onboarding/LockedNode';

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const buttonNamed = (root: ParentNode, text: string) =>
  [...root.querySelectorAll('button')].find(b => b.textContent === text);
const typePassword = (root: ParentNode, value: string) => {
  const input = root.querySelector<HTMLInputElement>('#node-unlock-password')!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input;
};
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

it('never offers a typed password on desktop', () => {
  const mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <LockedNode onUnlock={async () => {}} onUnlockWithPassword={async () => {}} />, mount);
  expect(buttonNamed(mount, 'Type your node password instead')).toBeUndefined();
  expect(mount.querySelector('input[type="password"]')).toBeNull();
  expect(mount.textContent).not.toContain('Remember on this phone');
});

it('lets an Android owner type the node password, then clears the field', async () => {
  const typed: string[] = [];
  const mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <LockedNode mobile onUnlock={async () => {}} onUnlockWithPassword={async (password) => { typed.push(password); }} />, mount);
  expect(mount.querySelector('input[type="password"]')).toBeNull();
  buttonNamed(mount, 'Type your node password instead')!.click();
  const input = typePassword(mount, 'correct horse');
  expect(input.type).toBe('password');
  expect(mount.textContent).toContain('Your node checks it. This phone keeps it only in memory, unless you then choose to remember it here behind your fingerprint.');
  buttonNamed(mount, 'Unlock with password')!.click();
  await vi.waitFor(() => expect(typed).toEqual(['correct horse']));
  expect(input.value).toBe('');
});

it('refuses an empty typed password without calling the host', async () => {
  const onUnlockWithPassword = vi.fn(async () => {});
  const mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <LockedNode mobile onUnlock={async () => {}} onUnlockWithPassword={onUnlockWithPassword} />, mount);
  buttonNamed(mount, 'Type your node password instead')!.click();
  buttonNamed(mount, 'Unlock with password')!.click();
  await vi.waitFor(() => expect(mount.querySelector('[role="alert"]')?.textContent).toBe('Type the password you chose for your home node.'));
  expect(onUnlockWithPassword).not.toHaveBeenCalled();
});

it('opens the typed password form after a failed biometric unlock on Android', async () => {
  const mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <LockedNode mobile onUnlock={() => Promise.reject('Android encrypted storage refused the home-node item: device key is not valid on this device')} onUnlockWithPassword={async () => {}} />, mount);
  buttonNamed(mount, 'Unlock with biometrics')!.click();
  await vi.waitFor(() => expect(mount.querySelector('#node-unlock-password')).not.toBeNull());
  expect(mount.querySelector('[role="alert"]')?.textContent).toContain('device key is not valid');
});

it('offers to remember the accepted password behind a fingerprint, once', async () => {
  const choices: boolean[] = [];
  const onDone = vi.fn();
  const mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <RememberUnlock onChoose={async (remember) => { choices.push(remember); }} onDone={onDone} />, mount);
  expect(mount.textContent).toContain('Unlocked. Remember the password on this phone?');
  expect(mount.textContent).toContain('only opens with your fingerprint');
  expect(mount.textContent).toContain('If the fingerprints on this phone change, the saved copy stops opening. Type the password once more and choose Remember to replace it.');
  expect(mount.querySelector('input')).toBeNull();
  buttonNamed(mount, 'Remember on this phone (fingerprint)')!.click();
  await vi.waitFor(() => expect(mount.querySelector('[data-remember-saved]')?.textContent).toBe('Saved on this phone. Next time, unlock with your fingerprint.'));
  expect(choices).toEqual([true]);
  expect(onDone).not.toHaveBeenCalled();
  buttonNamed(mount, 'Close')!.click();
  expect(onDone).toHaveBeenCalledOnce();
});

it('keeps the offer after a cancelled fingerprint and closes on Not now', async () => {
  const choices: boolean[] = [];
  const onDone = vi.fn();
  const mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <RememberUnlock onChoose={async (remember) => {
    choices.push(remember);
    if (remember) throw 'Android encrypted storage refused the home-node item: device key approval was cancelled';
  }} onDone={onDone} />, mount);
  buttonNamed(mount, 'Remember on this phone (fingerprint)')!.click();
  await vi.waitFor(() => expect(mount.querySelector('[role="alert"]')?.textContent).toContain('cancelled'));
  expect(buttonNamed(mount, 'Remember on this phone (fingerprint)')).toBeDefined();
  buttonNamed(mount, 'Not now')!.click();
  await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce());
  expect(choices).toEqual([true, false]);
});

it('on Android, unlocks with a typed password and asks to remember it after the node unlocks', async () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 15)');
  let locked = true;
  const calls: Array<[string, unknown]> = [];
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke: (cmd: string, args?: unknown) => {
    calls.push([cmd, args]);
    if (cmd === 'node_status') return Promise.resolve({ ready: !locked, node_id: 'ab'.repeat(32), error: null, locked });
    if (cmd === 'pairing_status') return Promise.resolve({ state: 'paired', remote: true, scopes: ['read'], bootstrap: null });
    if (cmd === 'node_unlock_password') { locked = false; return Promise.resolve(); }
    if (cmd === 'node_unlock_remember') return Promise.resolve();
    return Promise.reject('unavailable');
  }});
  const mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <App />, mount);
  await vi.waitFor(() => expect(buttonNamed(mount, 'Unlock with biometrics')).toBeDefined());
  buttonNamed(mount, 'Type your node password instead')!.click();
  typePassword(mount, 'correct horse');
  buttonNamed(mount, 'Unlock with password')!.click();
  await vi.waitFor(() => expect(mount.querySelector('[data-node-locked]')).toBeNull());
  expect(calls.filter(([cmd]) => cmd === 'node_unlock_password').map(([, args]) => args)).toEqual([{ password: 'correct horse' }]);
  expect(calls.map(([cmd]) => cmd)).not.toContain('node_unlock');
  expect(calls.map(([cmd]) => cmd)).not.toContain('node_unlock_remember');
  buttonNamed(mount, 'Remember on this phone (fingerprint)')!.click();
  await vi.waitFor(() => expect(mount.querySelector('[data-remember-saved]')).not.toBeNull());
  const remembered = calls.filter(([cmd]) => cmd === 'node_unlock_remember').map(([, args]) => args);
  expect(remembered).toEqual([{ remember: true }]);
  expect(JSON.stringify(remembered)).not.toContain('correct horse');
});
