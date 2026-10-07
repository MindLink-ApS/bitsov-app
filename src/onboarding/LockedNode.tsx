import { usePairingActivity } from '../pairingActivity';
import { createSignal, Show } from 'solid-js';
import { hideLockedHubTrust, HubTrustInfo, lockedHubTrustHidden } from '../control/HubTrust';

export function LockedNode(props: {
  onUnlock: () => Promise<void>;
  /** Android only: unlock with a password typed on this phone. */
  onUnlockWithPassword?: (password: string) => Promise<void>;
  hostError?: string | null;
  mobile?: boolean;
}) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [typing, setTyping] = createSignal(false);
  const [password, setPassword] = createSignal('');
  usePairingActivity(() => busy() || typing());
  const canType = () => !!props.mobile && !!props.onUnlockWithPassword;
  const unlock = async () => {
    if (busy()) return;
    setBusy(true); setError(null);
    try { await props.onUnlock(); }
    catch (e) {
      setError(typeof e === 'string' ? e : `Unlock did not complete. Try again when ${props.mobile ? 'biometrics are' : 'Touch ID is'} available.`);
      if (canType()) setTyping(true);
    }
    finally { setBusy(false); }
  };
  const unlockTyped = async (event: Event) => {
    event.preventDefault();
    if (busy() || !props.onUnlockWithPassword) return;
    // Read once and clear: the password stays in this component only for the call.
    const value = password();
    setPassword('');
    if (!value) { setError('Type the password you chose for your home node.'); return; }
    setBusy(true); setError(null);
    try { await props.onUnlockWithPassword(value); }
    catch (e) { setError(typeof e === 'string' ? e : 'Unlock did not complete. Check the password and try again.'); }
    finally { setBusy(false); }
  };
  return <div class="locked-node">
    <section class="panel" data-node-locked aria-live="polite">
      <span class="target-badge honest" data-locked-badge>Node locked</span>
      <h2>Locked after a restart. Unlock to receive.</h2>
      <p>Your node restarted (for example after a power cut). It cannot read your keys until you unlock it from this device. Tap Unlock - it takes a few seconds.</p>
      <button disabled={busy()} onClick={() => void unlock()}>{busy() ? 'Unlocking…' : props.mobile ? 'Unlock with biometrics' : 'Unlock with Touch ID'}</button>
      <Show when={canType()}>
        <Show
          when={typing()}
          fallback={<button class="link" data-unlock-type-open disabled={busy()} onClick={() => { setError(null); setTyping(true); }}>Type your node password instead</button>}
        >
          <form class="panel" data-unlock-typed onSubmit={(event) => void unlockTyped(event)}>
            <label for="node-unlock-password">Node password</label>
            <input
              id="node-unlock-password"
              type="password"
              autocomplete="off"
              autocapitalize="none"
              autocorrect="off"
              spellcheck={false}
              disabled={busy()}
              value={password()}
              onInput={(e) => setPassword(e.currentTarget.value)}
            />
            <p class="hint">Your node checks it. This phone keeps it only in memory, unless you then choose to remember it here behind your fingerprint.</p>
            <div class="row">
              <button type="submit" class="primary" disabled={busy()}>{busy() ? 'Unlocking…' : 'Unlock with password'}</button>
              <button type="button" class="link" disabled={busy()} onClick={() => { setPassword(''); setTyping(false); setError(null); }}>Cancel</button>
            </div>
          </form>
        </Show>
      </Show>
      <p class="hint">While locked, payments to you fail and open channels are not watched. Unlock within a day.</p>
      <Show when={error() || props.hostError}><p role="alert">{error() || props.hostError}</p></Show>
    </section>
    <HubTrustInfo level={2} initiallyOpen={!lockedHubTrustHidden()} onHide={hideLockedHubTrust} />
  </div>;
}

/**
 * Android, after a typed-password unlock the node accepted. The host already
 * holds that password; the renderer only answers yes or no. Rendered outside
 * LockedNode, which unmounts as soon as the node reports unlocked.
 */
export function RememberUnlock(props: {
  onChoose: (remember: boolean) => Promise<void>;
  onDone: () => void;
}) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [saved, setSaved] = createSignal(false);
  const choose = async (remember: boolean) => {
    if (busy()) return;
    setBusy(true); setError(null);
    try {
      await props.onChoose(remember);
      if (remember) setSaved(true);
      else props.onDone();
    } catch (e) {
      setError(typeof e === 'string' ? e : 'The password was not saved. Nothing changed on this phone.');
    } finally { setBusy(false); }
  };
  return <section class="panel" data-remember-unlock aria-live="polite">
    <Show
      when={!saved()}
      fallback={<>
        <p data-remember-saved>Saved on this phone. Next time, unlock with your fingerprint.</p>
        <button class="link" onClick={() => props.onDone()}>Close</button>
      </>}
    >
      <h2>Unlocked. Remember the password on this phone?</h2>
      <p>BitSov encrypts it with a key in this phone’s secure hardware that only opens with your fingerprint. Next time, unlock with your fingerprint instead of typing it.</p>
      <p class="hint">If the fingerprints on this phone change, the saved copy stops opening. Type the password once more and choose Remember to replace it.</p>
      <div class="row">
        <button class="primary" data-remember-yes disabled={busy()} onClick={() => void choose(true)}>{busy() ? 'Waiting for your fingerprint…' : 'Remember on this phone (fingerprint)'}</button>
        <button class="link" data-remember-no disabled={busy()} onClick={() => void choose(false)}>Not now</button>
      </div>
      <Show when={error()}><p role="alert">{error()}</p></Show>
    </Show>
  </section>;
}
