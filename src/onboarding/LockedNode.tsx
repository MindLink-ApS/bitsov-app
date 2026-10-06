import { createSignal, Show } from 'solid-js';
import { hideLockedHubTrust, HubTrustInfo, lockedHubTrustHidden } from '../control/HubTrust';

export function LockedNode(props: {
  onUnlock: () => Promise<void>;
  hostError?: string | null;
  mobile?: boolean;
}) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const unlock = async () => {
    if (busy()) return;
    setBusy(true); setError(null);
    try { await props.onUnlock(); }
    catch (e) { setError(typeof e === 'string' ? e : `Unlock did not complete. Try again when ${props.mobile ? 'biometrics are' : 'Touch ID is'} available.`); }
    finally { setBusy(false); }
  };
  return <div class="locked-node">
    <section class="panel" data-node-locked aria-live="polite">
      <span class="target-badge honest" data-locked-badge>Node locked</span>
      <h2>Locked after a restart. Unlock to receive.</h2>
      <p>Your node restarted (for example after a power cut). It cannot read your keys until you unlock it from this device. Tap Unlock - it takes a few seconds.</p>
      <button disabled={busy()} onClick={() => void unlock()}>{busy() ? 'Unlocking…' : props.mobile ? 'Unlock with biometrics' : 'Unlock with Touch ID'}</button>
      <p class="hint">While locked, payments to you fail and open channels are not watched. Unlock within a day.</p>
      <Show when={error() || props.hostError}><p role="alert">{error() || props.hostError}</p></Show>
    </section>
    <HubTrustInfo level={2} initiallyOpen={!lockedHubTrustHidden()} onHide={hideLockedHubTrust} />
  </div>;
}
