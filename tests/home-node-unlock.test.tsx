import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import { LockedNode, RememberUnlock } from '../src/onboarding/LockedNode';

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.removeItem(REMEMBERED); });
// The Touch ID-first layout is for a device that has a password remembered.
const REMEMBERED = 'bitsov.unlock.remembered.v1';
const rememberedDevice = () => localStorage.setItem(REMEMBERED, '1');
const buttonNamed = (root: ParentNode, text: string) =>
  [...root.querySelectorAll('button')].find(b => b.textContent === text);
const typePassword = (root: ParentNode, value: string) => {
  const input = root.querySelector<HTMLInputElement>('#node-unlock-password')!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input;
};
it('shows a locked node without onboarding or money controls, and unlocks only on a click', async () => {
  rememberedDevice();
  let locked = true;
  const calls: string[] = [];
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke: (cmd: string) => {
    calls.push(cmd);
    if (cmd === 'node_status') return Promise.resolve({ ready: !locked, node_id: 'ab'.repeat(32), error: null, locked, typed_unlock_supported: true, remember_offer: !locked });
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
  dispose = render(() => <LockedNode mobile typedUnlockSupported onUnlock={async () => {}} />, mount);
  expect(mount.querySelector('[data-locked-badge]')?.textContent).toBe('Node locked');
  expect([...mount.querySelectorAll('button')].some(
    button => button.textContent === 'Unlock with biometrics',
  )).toBe(true);
  expect(mount.querySelector('input[type="password"]')).toBeNull();
});

it('does not offer typing without the host capability', () => {
  const mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <LockedNode onUnlock={async () => {}} onUnlockWithPassword={async () => {}} />, mount);
  expect(buttonNamed(mount, 'Type your node password instead')).toBeUndefined();
  expect(mount.querySelector('input[type="password"]')).toBeNull();
  expect(mount.textContent).not.toContain('Remember on this phone');
});

it('lets an Android owner type the node password, then clears the field', async () => {
  rememberedDevice();
  const typed: string[] = [];
  const mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <LockedNode mobile typedUnlockSupported onUnlock={async () => {}} onUnlockWithPassword={async (password) => { typed.push(password); }} />, mount);
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
  rememberedDevice();
  const onUnlockWithPassword = vi.fn(async () => {});
  const mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <LockedNode mobile typedUnlockSupported onUnlock={async () => {}} onUnlockWithPassword={onUnlockWithPassword} />, mount);
  buttonNamed(mount, 'Type your node password instead')!.click();
  buttonNamed(mount, 'Unlock with password')!.click();
  await vi.waitFor(() => expect(mount.querySelector('[role="alert"]')?.textContent).toBe('Type the password you chose for your home node.'));
  expect(onUnlockWithPassword).not.toHaveBeenCalled();
});

it('opens the typed password form after a failed biometric unlock on Android', async () => {
  const mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <LockedNode mobile typedUnlockSupported onUnlock={() => Promise.reject('Android encrypted storage refused the home-node item: device key is not valid on this device')} onUnlockWithPassword={async () => {}} />, mount);
  buttonNamed(mount, 'Unlock with biometrics')!.click();
  await vi.waitFor(() => expect(mount.querySelector('#node-unlock-password')).not.toBeNull());
  expect(mount.querySelector('[role="alert"]')?.textContent).toContain('device key is not valid');
});

it('offers to remember the accepted password behind a fingerprint, once', async () => {
  const choices: boolean[] = [];
  const onDone = vi.fn();
  const mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <RememberUnlock mobile onChoose={async (remember) => { choices.push(remember); }} onDone={onDone} />, mount);
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
  dispose = render(() => <RememberUnlock mobile onChoose={async (remember) => {
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

it.each(['Android', 'Mac'])('on %s, unlocks with a typed password and asks to remember it after the node unlocks', async (platform) => {
  rememberedDevice();
  const mobile = platform === 'Android';
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(mobile ? 'Mozilla/5.0 (Linux; Android 15)' : 'Mozilla/5.0 (Macintosh)');
  let locked = true;
  const calls: Array<[string, unknown]> = [];
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke: (cmd: string, args?: unknown) => {
    calls.push([cmd, args]);
    if (cmd === 'node_status') return Promise.resolve({ ready: !locked, node_id: 'ab'.repeat(32), error: null, locked, typed_unlock_supported: true, remember_offer: !locked });
    if (cmd === 'pairing_status') return Promise.resolve({ state: 'paired', remote: true, scopes: ['read'], bootstrap: null });
    if (cmd === 'node_unlock_password') { locked = false; return Promise.resolve(); }
    if (cmd === 'node_unlock_remember') return Promise.resolve();
    return Promise.reject('unavailable');
  }});
  const mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <App />, mount);
  await vi.waitFor(() => expect(buttonNamed(mount, mobile ? 'Unlock with biometrics' : 'Unlock with Touch ID')).toBeDefined());
  buttonNamed(mount, 'Type your node password instead')!.click();
  typePassword(mount, 'correct horse');
  buttonNamed(mount, 'Unlock with password')!.click();
  await vi.waitFor(() => expect(mount.querySelector('[data-node-locked]')).toBeNull());
  expect(calls.filter(([cmd]) => cmd === 'node_unlock_password').map(([, args]) => args)).toEqual([{ password: 'correct horse' }]);
  expect(calls.map(([cmd]) => cmd)).not.toContain('node_unlock');
  expect(calls.map(([cmd]) => cmd)).not.toContain('node_unlock_remember');
  buttonNamed(mount, mobile ? 'Remember on this phone (fingerprint)' : 'Remember on this Mac (Touch ID)')!.click();
  await vi.waitFor(() => expect(mount.querySelector('[data-remember-saved]')).not.toBeNull());
  const remembered = calls.filter(([cmd]) => cmd === 'node_unlock_remember').map(([, args]) => args);
  expect(remembered).toEqual([{ remember: true }]);
  expect(JSON.stringify(remembered)).not.toContain('correct horse');
});

it.each(['saved', 'cancelled'])('keeps Remember mounted across a status poll while a save is pending and then %s', async (outcome) => {
  let hostOffer = true;
  let tick: (() => void) | undefined;
  vi.spyOn(window, 'setInterval').mockImplementation((handler) => {
    tick = handler as () => void;
    return 1 as unknown as ReturnType<typeof setInterval>;
  });
  let finishSave!: () => void;
  const save = new Promise<void>((resolve, reject) => {
    finishSave = () => {
      if (outcome === 'saved') resolve();
      else { hostOffer = true; reject('Touch ID was cancelled.'); }
    };
  });
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke: (cmd: string) => {
    if (cmd === 'node_status') return Promise.resolve({ ready: true, node_id: 'ab'.repeat(32), error: null, remember_offer: hostOffer });
    if (cmd === 'pairing_status') return Promise.resolve({ state: 'paired', remote: true, scopes: ['read'], bootstrap: null });
    if (cmd === 'node_unlock_remember') { hostOffer = false; return save; }
    return Promise.reject('unavailable');
  }});
  const mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <App />, mount);
  await vi.waitFor(() => expect(buttonNamed(mount, 'Remember on this Mac (Touch ID)')).toBeDefined());
  const dialog = mount.querySelector('[data-remember-unlock]');
  buttonNamed(mount, 'Remember on this Mac (Touch ID)')!.click();
  tick!();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(mount.querySelector('[data-remember-unlock]')).toBe(dialog);
  finishSave();
  await vi.waitFor(() => expect(mount.textContent).toContain(outcome === 'saved' ? 'Saved on this Mac' : 'Touch ID was cancelled.'));
  tick!();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(mount.querySelector('[data-remember-unlock]')).toBe(dialog);
  if (outcome === 'saved') {
    buttonNamed(mount, 'Close')!.click();
    expect(mount.querySelector('[data-remember-unlock]')).toBeNull();
  }
});

it('dismisses an idle Remember offer when the host expires it', async () => {
  let hostOffer = true;
  let tick: (() => void) | undefined;
  vi.spyOn(window, 'setInterval').mockImplementation((handler) => { tick = handler as () => void; return 1 as unknown as ReturnType<typeof setInterval>; });
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke: (cmd: string) => {
    if (cmd === 'node_status') return Promise.resolve({ ready: true, node_id: 'ab'.repeat(32), error: null, remember_offer: hostOffer });
    if (cmd === 'pairing_status') return Promise.resolve({ state: 'paired', remote: true, scopes: ['read'], bootstrap: null });
    return Promise.reject('unavailable');
  }});
  const mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <App />, mount);
  await vi.waitFor(() => expect(mount.querySelector('[data-remember-unlock]')).not.toBeNull());
  hostOffer = false;
  tick!();
  await vi.waitFor(() => expect(mount.querySelector('[data-remember-unlock]')).toBeNull());
});


it('offers typed unlock on a capable Mac, clears a wrong password and shows the reported budget', async () => {
  const mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <LockedNode typedUnlockSupported state="no-password" attemptsLeft={17}
    onUnlock={async () => {}} onUnlockWithPassword={async () => { throw 'Unlock failed.'; }} />, mount);
  const input = typePassword(mount, 'wrong password');
  buttonNamed(mount, 'Unlock with password')!.click();
  await vi.waitFor(() => expect(mount.querySelector('[role="alert"]')?.textContent).toContain('Unlock failed'));
  expect(input.value).toBe('');
  expect(mount.textContent).toContain('17 attempts left');
  expect(mount.textContent).toContain('only in memory');
  expect(mount.textContent).not.toContain('phone');
});

it('can cancel the automatically opened no-password form', async () => {
  const mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <LockedNode typedUnlockSupported state="no-password" onUnlock={async () => {}} onUnlockWithPassword={async () => {}} />, mount);
  typePassword(mount, 'clear on cancel');
  buttonNamed(mount, 'Cancel')!.click();
  expect(mount.querySelector('input[type="password"]')).toBeNull();
  buttonNamed(mount, 'Type your node password instead')!.click();
  expect(mount.querySelector<HTMLInputElement>('input')!.value).toBe('');
});

it('opens the Mac password form after a missing or invalidated Keychain item', async () => {
  const mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <LockedNode typedUnlockSupported state="ready" onUnlock={async () => { throw 'Keychain access was cancelled or unavailable (-25300).'; }} onUnlockWithPassword={async () => {}} />, mount);
  buttonNamed(mount, 'Unlock with Touch ID')!.click();
  await vi.waitFor(() => expect(mount.querySelector('#node-unlock-password')).not.toBeNull());
  expect(mount.textContent).not.toContain('attempts left');
});

it('explains enrollment before unlock without offering a password bypass', () => {
  const mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <LockedNode typedUnlockSupported state="not-enrolled" onUnlock={async () => {}} onUnlockWithPassword={async () => {}} />, mount);
  expect(mount.textContent).toContain('This Mac is not an approved owner device yet');
  expect(mount.textContent).toContain('another approved owner device');
  expect(mount.textContent).toContain('--owner-control');
  expect(buttonNamed(mount, 'Set up Touch ID approvals')?.disabled).toBe(true);
  expect(buttonNamed(mount, 'Unlock with Touch ID')).toBeUndefined();
  expect(mount.querySelector('input')).toBeNull();
});

it('shows the pending fingerprint, both finish paths, and Cancel', async () => {
  const cancel = vi.fn(async () => {});
  const mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <LockedNode state="pending-approval" pending={{ fingerprint: 'AB-CD', owner_action: 'konsensus device approve --op ab12' }} onCancel={cancel} onUnlock={async () => {}} />, mount);
  expect(mount.textContent).toContain('AB-CD');
  expect(mount.textContent).toContain('At the box');
  expect(mount.textContent).toContain('konsensus device approve --op ab12');
  expect(mount.textContent).toContain('From another owner device');
  expect(mount.textContent).toContain('unlocked');
  buttonNamed(mount, 'Cancel')!.click();
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
});

it('offers Remember on this Mac only as an explicit choice', async () => {
  const choices: boolean[] = [];
  const mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <RememberUnlock onChoose={async choice => { choices.push(choice); }} onDone={() => {}} />, mount);
  expect(choices).toEqual([]);
  expect(mount.textContent).not.toContain('phone');
  buttonNamed(mount, 'Remember on this Mac (Touch ID)')!.click();
  await vi.waitFor(() => expect(choices).toEqual([true]));
  expect(mount.querySelector('[data-remember-saved]')?.textContent).toContain('Saved on this Mac');
});

it('defaults to the typed password until a password is remembered on this device', () => {
  const mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <LockedNode typedUnlockSupported state="ready" onUnlock={async () => {}} onUnlockWithPassword={async () => {}} />, mount);
  // The form is open and is the primary path; Touch ID is only a secondary link.
  expect(mount.querySelector('#node-unlock-password')).not.toBeNull();
  expect(buttonNamed(mount, 'Unlock with password')?.className).toContain('primary');
  const saved = mount.querySelector('[data-unlock-saved-path]')!;
  expect(saved.textContent).toContain('Chose Remember on this Mac before?');
  expect(saved.querySelector('button')?.className).toBe('link');
  expect([...mount.querySelectorAll('button')].filter((b) => b.textContent === 'Unlock with Touch ID')).toHaveLength(1);
});

it('keeps Touch ID first only on a device with a remembered password', () => {
  rememberedDevice();
  const mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <LockedNode typedUnlockSupported state="ready" onUnlock={async () => {}} onUnlockWithPassword={async () => {}} />, mount);
  expect(mount.querySelector('#node-unlock-password')).toBeNull();
  expect(mount.querySelector('[data-unlock-saved-path]')).toBeNull();
  expect(buttonNamed(mount, 'Unlock with Touch ID')).toBeDefined();
});

it('learns: Remember or a working Touch ID unlock marks the device, no-password clears it', async () => {
  const mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <RememberUnlock onChoose={async () => {}} onDone={() => {}} />, mount);
  buttonNamed(mount, 'Remember on this Mac (Touch ID)')!.click();
  await vi.waitFor(() => expect(localStorage.getItem(REMEMBERED)).toBe('1'));
  dispose?.(); mount.remove();

  const locked = document.createElement('div'); document.body.appendChild(locked);
  dispose = render(() => <LockedNode typedUnlockSupported state="no-password" onUnlock={async () => {}} onUnlockWithPassword={async () => {}} />, locked);
  expect(localStorage.getItem(REMEMBERED)).toBeNull();
  dispose?.(); locked.remove();

  const again = document.createElement('div'); document.body.appendChild(again);
  dispose = render(() => <LockedNode typedUnlockSupported state="ready" onUnlock={async () => {}} onUnlockWithPassword={async () => {}} />, again);
  again.querySelector<HTMLButtonElement>('[data-unlock-saved-path] button')!.click();
  await vi.waitFor(() => expect(localStorage.getItem(REMEMBERED)).toBe('1'));
});

it('an older host without typed unlock keeps the single Touch ID button', () => {
  const mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <LockedNode onUnlock={async () => {}} />, mount);
  expect(buttonNamed(mount, 'Unlock with Touch ID')).toBeDefined();
  expect(mount.querySelector('[data-unlock-saved-path]')).toBeNull();
});

it('follows the host when it knows: a remembered item puts Touch ID first without a hint', () => {
  const mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <LockedNode typedUnlockSupported state="ready" passwordRemembered onUnlock={async () => {}} onUnlockWithPassword={async () => {}} />, mount);
  expect(mount.querySelector('#node-unlock-password')).toBeNull();
  expect(buttonNamed(mount, 'Unlock with Touch ID')).toBeDefined();
  expect(localStorage.getItem(REMEMBERED)).toBe('1');
});

it('follows the host when it knows: no item means typed first even with a stale hint', () => {
  rememberedDevice();
  const mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <LockedNode typedUnlockSupported state="ready" passwordRemembered={false} onUnlock={async () => {}} onUnlockWithPassword={async () => {}} />, mount);
  expect(mount.querySelector('#node-unlock-password')).not.toBeNull();
  expect(mount.querySelector('[data-unlock-saved-path]')).not.toBeNull();
  expect(localStorage.getItem(REMEMBERED)).toBeNull();
});

it('puts typed first after a failed read, keeping Touch ID as a link while the host still sees the item', () => {
  const mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <LockedNode typedUnlockSupported state="no-password" passwordRemembered onUnlock={async () => {}} onUnlockWithPassword={async () => {}} />, mount);
  expect(mount.querySelector('#node-unlock-password')).not.toBeNull();
  expect(buttonNamed(mount, 'Unlock with password')?.className).toContain('primary');
  expect(mount.querySelector('[data-unlock-saved-path] button')?.textContent).toBe('Unlock with Touch ID');
  expect(localStorage.getItem(REMEMBERED)).toBe('1');
});

it('falls back to the renderer hint when the host cannot tell', () => {
  rememberedDevice();
  const mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <LockedNode typedUnlockSupported state="ready" passwordRemembered={null} onUnlock={async () => {}} onUnlockWithPassword={async () => {}} />, mount);
  expect(mount.querySelector('#node-unlock-password')).toBeNull();
  expect(localStorage.getItem(REMEMBERED)).toBe('1');
});

it('passes the host password_remembered field from node_status to the locked screen', async () => {
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke: (cmd: string) => {
    if (cmd === 'node_status') return Promise.resolve({ ready: false, node_id: 'ab'.repeat(32), error: null, locked: true, typed_unlock_supported: true, unlock_state: 'ready', password_remembered: true });
    if (cmd === 'pairing_status') return Promise.resolve({ state: 'paired', remote: true, scopes: ['read'], bootstrap: null });
    return Promise.reject('unavailable');
  }});
  const mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <App />, mount);
  await vi.waitFor(() => expect(buttonNamed(mount, 'Unlock with Touch ID')).toBeDefined());
  expect(mount.querySelector('#node-unlock-password')).toBeNull();
});
