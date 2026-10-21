import { usePairingActivity } from '../pairingActivity';
import { createEffect, createSignal, Show } from 'solid-js';
import { setUnlockRemembered, unlockRemembered } from './unlockMemory';
import { hideLockedHubTrust, HubTrustInfo, lockedHubTrustHidden } from '../control/HubTrust';
import { appPlatform, deviceWords, isMobilePlatform, type AppPlatform } from '../platform';

/** Prefer the runtime platform; retain the legacy mobile prop for Android callers. */
const platformFor = (props: { platform?: AppPlatform; mobile?: boolean }) =>
  props.platform ?? (isMobilePlatform() ? appPlatform() : props.mobile ? 'android' : 'desktop');
const wordsFor = (props: { platform?: AppPlatform; mobile?: boolean }) => deviceWords(platformFor(props));

export function LockedNode(props: {
  onUnlock: () => Promise<void>;
  /** Available only when the host reports typed unlock support. */
  onUnlockWithPassword?: (password: string) => Promise<void>;
  hostError?: string | null;
  mobile?: boolean;
  /** Which device's words to use (Mac / iPhone / iPad / Android phone). */
  platform?: AppPlatform;
  typedUnlockSupported?: boolean;
  state?: 'ready' | 'no-password' | 'not-enrolled' | 'pending-approval';
  pending?: { fingerprint: string | null; owner_action: string | null } | null;
  onCancel?: () => Promise<void>;
  attemptsLeft?: number | null;
}) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [typing, setTyping] = createSignal(false);
  const [password, setPassword] = createSignal('');
  // Typed password first until this device has a password remembered behind
  // Touch ID: offering Touch ID before that only ends in "no password saved".
  const [remembered, setRemembered] = createSignal(unlockRemembered());
  createEffect(() => {
    if (props.state === 'no-password') {
      setUnlockRemembered(false);
      setRemembered(false);
      setTyping(true);
    }
    if (props.state === 'not-enrolled' || props.state === 'pending-approval') {
      setTyping(false);
      setPassword('');
    }
  });
  usePairingActivity(() => busy() || typing());
  const canType = () => !!props.typedUnlockSupported && !!props.onUnlockWithPassword;
  const typedFirst = () => canType() && !remembered();
  createEffect(() => { if (typedFirst() && props.state !== 'not-enrolled' && props.state !== 'pending-approval') setTyping(true); });
  const unlock = async () => {
    if (busy()) return;
    setBusy(true); setError(null);
    try {
      await props.onUnlock();
      // A biometric unlock that worked used a remembered password.
      setUnlockRemembered(true);
    }
    catch (e) {
      setError(typeof e === 'string' ? e : `Unlock did not complete. Try again when ${wordsFor(props).available} available.`);
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
    <section class="panel" data-node-locked data-unlock-state={props.state || 'ready'} aria-live="polite">
      <span class="target-badge honest" data-locked-badge>Node locked</span>
      <h2>Locked after a restart. Unlock to receive.</h2>
      <Show when={props.state === 'pending-approval' && props.pending}>
        {(pending) => <PendingApproval pending={pending()} mobile={props.mobile} platform={props.platform} onCancel={props.onCancel} />}
      </Show>
      <Show when={props.state === 'not-enrolled'}>
        <p>This {wordsFor(props).device} is not an approved owner device yet.</p>
        <p>Unlock the node first using another approved owner device, or at the box. For the first owner device, stop the locked service, start the node with <code>konsensus start --config &lt;path&gt; --owner-control</code>, and type its password at the box’s terminal.</p>
        <p>Once the node is unlocked, open Settings → {isMobilePlatform(platformFor(props)) ? 'Set up biometric approvals' : 'Set up Touch ID approvals'}. Compare the fingerprint and finish approval at the box, then restart the remote-unlock service.</p>
        <button disabled>{isMobilePlatform(platformFor(props)) ? 'Set up biometric approvals' : 'Set up Touch ID approvals'}</button>
        <p class="hint">Setup becomes available in Settings when the node is unlocked.</p>
      </Show>
      <Show when={props.state !== 'not-enrolled' && props.state !== 'pending-approval'}>
      <p>Your node restarted (for example after a power cut). It cannot read your keys until you unlock it from this device. {typedFirst() ? 'Type the password you chose for your node - it takes a few seconds.' : 'Tap Unlock - it takes a few seconds.'}</p>
      <Show when={!typedFirst()}>
        <button disabled={busy()} onClick={() => void unlock()}>{busy() ? 'Unlocking…' : wordsFor(props).unlockButton}</button>
      </Show>
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
            <p class="hint">Your node checks it. This {wordsFor(props).device} keeps it only in memory, unless you then choose to remember it here behind {wordsFor(props).biometric}.</p>
            <div class="row">
              <button type="submit" class="primary" disabled={busy()}>{busy() ? 'Unlocking…' : 'Unlock with password'}</button>
              <button type="button" class="link" disabled={busy()} onClick={() => { setPassword(''); setTyping(false); setError(null); }}>Cancel</button>
            </div>
          </form>
        </Show>
      </Show>
      <Show when={typedFirst()}>
        <p class="hint unlock-saved" data-unlock-saved-path>
          Chose Remember on this {wordsFor(props).device} before?{' '}
          <button type="button" class="link" disabled={busy()} onClick={() => void unlock()}>{busy() ? 'Unlocking…' : wordsFor(props).unlockButton}</button>
        </p>
      </Show>
      </Show>
      <Show when={error() && props.attemptsLeft != null}>
        <p data-unlock-attempts>{props.attemptsLeft} attempts left in the node’s process-wide unlock budget.</p>
      </Show>
      <p class="hint">While locked, payments to you fail and open channels are not watched. Unlock within a day.</p>
      <Show when={error() || props.hostError}><p role="alert">{error() || props.hostError}</p></Show>
    </section>
    <HubTrustInfo level={2} initiallyOpen={!lockedHubTrustHidden()} onHide={hideLockedHubTrust} />
  </div>;
}

const REMEMBER_TEXT = {
  phone: 'BitSov encrypts it with a key in this phone’s secure hardware that only opens with biometrics. Next time, unlock with biometrics instead of typing it.',
  iPhone: 'BitSov saves it on this iPhone, protected by biometrics. Next time, unlock with biometrics instead of typing it.',
  iPad: 'BitSov saves it on this iPad, protected by biometrics. Next time, unlock with biometrics instead of typing it.',
  Mac: 'BitSov saves it in this Mac’s Keychain, protected by Touch ID. Next time, unlock with Touch ID instead of typing it.',
} as const;
const REMEMBER_BUTTON = {
  phone: 'Remember on this phone (biometrics)',
  iPhone: 'Remember on this iPhone (biometrics)',
  iPad: 'Remember on this iPad (biometrics)',
  Mac: 'Remember on this Mac (Touch ID)',
} as const;

/**
 * After a typed-password unlock the node accepted. The host already
 * holds that password; the renderer only answers yes or no. Rendered outside
 * LockedNode, which unmounts as soon as the node reports unlocked.
 */
export function RememberUnlock(props: {
  mobile?: boolean;
  /** Which device's words to use (Mac / iPhone / iPad / Android phone). */
  platform?: AppPlatform;
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
      if (remember) { setUnlockRemembered(true); setSaved(true); }
      else props.onDone();
    } catch (e) {
      setError(typeof e === 'string' ? e : 'The password was not saved.');
    } finally { setBusy(false); }
  };
  return <section class="panel" data-remember-unlock aria-live="polite">
    <Show
      when={!saved()}
      fallback={<>
        <p data-remember-saved>Saved on this {wordsFor(props).device}. Next time, unlock with {wordsFor(props).biometric}.</p>
        <button class="link" onClick={() => props.onDone()}>Close</button>
      </>}
    >
      <h2>Unlocked. Remember the password on this {wordsFor(props).device}?</h2>
      <p>{REMEMBER_TEXT[wordsFor(props).device]}</p>
      <p class="hint">If the {platformFor(props) === 'android' ? 'enrolled biometrics' : platformFor(props) === 'ios' ? 'faces or fingerprints' : 'fingerprints'} on this {wordsFor(props).device} change, the saved copy stops opening. Type the password once more and choose Remember to replace it.</p>
      <p class="hint">If your device’s approval key also stops working, another approved owner device or the box must unlock the node first. Then set up {isMobilePlatform(platformFor(props)) ? 'biometric' : 'Touch ID'} approvals again before unlocking from this device.</p>
      <div class="row">
        <button class="primary" data-remember-yes disabled={busy()} onClick={() => void choose(true)}>{busy() ? 'Saving…' : REMEMBER_BUTTON[wordsFor(props).device]}</button>
        <button class="link" data-remember-no disabled={busy()} onClick={() => void choose(false)}>Not now</button>
      </div>
      <Show when={error()}><p role="alert">{error()}</p></Show>
    </Show>
  </section>;
}


/** Requesting device only. Approval remains at the box or an enrolled owner device. */
export function PendingApproval(props: {
  pending: { fingerprint: string | null; owner_action: string | null };
  mobile?: boolean;
  /** Which device's words to use (Mac / iPhone / iPad / Android phone). */
  platform?: AppPlatform;
  onCancel?: () => Promise<void>;
}) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const cancel = async () => {
    if (busy() || !props.onCancel) return;
    setBusy(true); setError(null);
    try { await props.onCancel(); }
    catch { setError('Could not cancel the request. Unlock the node first, then try again.'); }
    finally { setBusy(false); }
  };
  return <div class="approval" data-device="pending" data-pending-approval>
    <p>Compare this {wordsFor(props).device}’s fingerprint: <code data-device-fingerprint>{props.pending.fingerprint}</code></p>
    <p><strong>At the box</strong>: while the node is unlocked and running with <code>--owner-control</code>, run:</p>
    <code class="address" data-device-owner-action>{props.pending.owner_action}</code>
    <p>Check that the fingerprint matches, then type the short code shown by the node’s terminal. This command cannot approve a device while the node is locked or running in local-owner mode.</p>
    <p><strong>From another owner device</strong>: while the node is unlocked in local-owner mode, use an already approved owner device that supports approving another device. Compare this fingerprint before approving. This app version cannot perform that approval yet.</p>
    <button type="button" class="link" data-device-cancel disabled={busy() || !props.onCancel} onClick={() => void cancel()}>Cancel</button>
    <Show when={error()}><p role="alert">{error()}</p></Show>
  </div>;
}
