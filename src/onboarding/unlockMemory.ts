/**
 * Whether this device has a node password remembered behind Touch ID /
 * fingerprint, as far as the renderer has seen. UI default only: it decides
 * which unlock path is offered first, never whether one works (the host and the
 * node decide that). Set when Remember succeeds or a biometric unlock succeeds;
 * cleared when the host reports `no-password`. Holds no secret.
 *
 * Fallback only: when `node_status.password_remembered` is a boolean (the
 * host's prompt-free Keychain / Keystore check), LockedNode follows the host
 * and mirrors its answer here.
 */
const KEY = 'bitsov.unlock.remembered.v1';

export function unlockRemembered(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

export function setUnlockRemembered(remembered: boolean): void {
  try {
    if (remembered) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch { /* private mode: the default stays typed-first */ }
}
