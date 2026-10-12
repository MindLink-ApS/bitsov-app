import { JoinDevice, type JoinInput, type JoinView } from './AddDevice';
import { createSignal, Match, Show, Switch } from 'solid-js';
import type { DeviceView } from '../control/types';
import { PendingApproval } from './LockedNode';
import { usePairingActivity } from '../pairingActivity';

/**
 * Touch ID (or phone biometric) approvals: one section with one action, used in
 * onboarding after pairing and in Settings → Node. Registering asks the node for
 * an owner approval; nothing is approved here. Shows nothing when this device
 * has no Secure Enclave / Keystore or the host has not reported a state yet.
 * A local node gets no at-the-node registration or CLI approval ceremony
 * (docs/ONBOARDING_PAIRING.md): it only shows the off reason, when given.
 */
export function DeviceApprovals(props: {
  device: DeviceView | null;
  joinDevice?: (input: JoinInput) => Promise<JoinView>;
  mobile?: boolean;
  onRegister: () => Promise<unknown>;
  onCancel: () => Promise<unknown>;
  /** Onboarding offers "Not now"; Settings does not. */
  onSkip?: () => void;
  /** Settings shows the on state; onboarding hides once registered. */
  showRegistered?: boolean;
  /** Registration exists only for a remote node. */
  remote: boolean;
}) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  usePairingActivity(busy);
  const what = () => (props.mobile ? 'biometric approvals' : 'Touch ID approvals');
  const run = async (action: () => Promise<unknown>) => {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try { await action(); }
    catch (e) { setError(typeof e === 'string' ? e : `Could not start ${what()} setup. Try again when your node is unlocked.`); }
    finally { setBusy(false); }
  };
  const state = () => {
    const s = props.device?.available ? props.device.state : null;
    // Local node: nothing to register; only an off reason is worth saying.
    return props.remote || s === 'off' ? s : null;
  };
  const joining = () => props.remote && props.device?.delegation_supported && props.joinDevice && ['none','pending','lapsed'].includes(state() ?? '');
  return (
    <Show when={!joining()} fallback={<JoinDevice api={input => props.joinDevice!(input)} mobile={props.mobile} />}>
    <Show when={state() && state() !== 'unavailable' && (state() !== 'registered' || props.showRegistered)}>
      <section class="panel device-approvals" data-device-approvals={state()!}>
        <h2>{props.mobile ? 'Approve payments with your fingerprint' : 'Approve payments with Touch ID'}</h2>
        <Switch>
          <Match when={state() === 'registered'}>
            <p class="ok-note" data-device-approvals-on>
              {props.mobile ? 'Biometric approvals are on for this phone.' : 'Touch ID approvals are on for this Mac.'}
            </p>
            <Show when={props.device?.owner_device_count === 1}>
              <p class="hint" role="status">This is your only owner device. Add and keep a second one so you can approve devices if this one is lost. A phone should not be your only owner device.</p>
            </Show>
          </Match>
          <Match when={state() === 'off'}>
            <p class="hint" data-device-off={props.device?.off_reason ?? 'off'}>
              <strong>{props.mobile ? 'Biometric approvals are off.' : 'Touch ID approvals are off.'}</strong> {props.device?.off_message}
            </p>
          </Match>
          <Match when={state() === 'pending' && props.device}>
            {(d) => <PendingApproval pending={d()} mobile={props.mobile} onCancel={() => run(props.onCancel).then(() => undefined)} />}
          </Match>
          <Match when={state() === 'none' || state() === 'lapsed'}>
            <p class="hint">
              {state() === 'lapsed' ? `Your last ${props.mobile ? 'biometric' : 'Touch ID'} setup request lapsed. ` : ''}
              One {props.mobile ? 'fingerprint' : 'Touch ID'} tap approves a contact’s payments on this {props.mobile ? 'phone' : 'Mac'},
              instead of approving each one at your node. Setup asks your node’s owner to approve this {props.mobile ? 'phone' : 'Mac'} once.
            </p>
            <div class="form-actions">
              <button type="button" class="primary" data-device-register disabled={busy()} onClick={() => void run(props.onRegister)}>
                {busy() ? 'Starting…' : props.mobile ? 'Set up biometric approvals' : 'Set up Touch ID approvals'}
              </button>
              <Show when={props.onSkip}>
                <button type="button" class="quiet" data-device-approvals-skip disabled={busy()} onClick={() => props.onSkip!()}>Not now</button>
              </Show>
            </div>
          </Match>
        </Switch>
        <Show when={error()}><p class="err-note" role="alert">{error()}</p></Show>
      </section>
    </Show>
    </Show>
  );
}
