import { t as tr } from '../i18n';
import { createSignal, Show } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { BoxIllustration } from '../onboarding/BoxIllustration';

/** Connection recovery only; retry uses the existing host pairing path. */
export function OfflineNode(props: {
  remote: boolean;
  lastSeen?: number | null;
  retryAfterSecs?: number | null;
  onRetry: () => void | Promise<void>;
  /** 1 when this card is the page (first run with setup hidden); 2 under another page heading. */
  level?: 1 | 2;
}) {
  const [busy, setBusy] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const retry = async () => {
    if (busy()) return;
    setBusy(true);
    setFailed(false);
    try { await props.onRetry(); }
    catch { setFailed(true); }
    finally { setBusy(false); }
  };
  return <section class="node-offline" data-node-offline aria-label={tr('caNodeOffline')}>
    <BoxIllustration offline />
    <Dynamic component={props.level === 1 ? 'h1' : 'h2'} data-offline-title>{tr('caYourNodeIsOffline')}</Dynamic>
    <p>{tr('caWeCanTReachItRightNowBitSovKeeps')}</p>
    <p class="hint">{tr('caLastSeen')}{' '}<Show when={props.lastSeen != null} fallback={tr('caUnknownLower')}>
      <time dateTime={new Date(props.lastSeen!).toISOString()}>{new Date(props.lastSeen!).toLocaleString()}</time>
    </Show></p>
    <ul>
      <li>{props.remote ? tr('caCheckThatTheComputerOrServerRunningYourNode') : tr('caCheckThatYourNodeIsRunningOnThisComputer')}</li>
      <li>{tr('caCheckThisDeviceSNetworkConnection')}</li>
      <li>{tr('caAfterARestartGiveYourNodeAMomentTo')}</li>
    </ul>
    <Show when={props.retryAfterSecs}>
      <p class="hint" data-remote-retry>{tr('caRemoteConnectionUnavailableWaiting')}{' '}{props.retryAfterSecs}{' '}{tr('caSBeforeRetrying')}</p>
    </Show>
    <Show when={failed()}><p role="status">{tr('caStillUnavailableCheckTheConnectionAndTryAgain')}</p></Show>
    <button type="button" class="primary" disabled={busy()} onClick={() => void retry()}>{busy() ? tr('caRetrying') : tr('caRetryNow')}</button>
  </section>;
}
