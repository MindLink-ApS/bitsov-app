import { t as tr } from '../i18n';
import { createSignal, type JSX, onCleanup, onMount, Show } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { BoxIllustration } from '../onboarding/BoxIllustration';
import { onEscape } from './escapeStack';

/** Connection recovery only; retry uses the existing host pairing path. */
export function OfflineNode(props: {
  remote: boolean;
  lastSeen?: number | null;
  retryAfterSecs?: number | null;
  onRetry: () => void | Promise<void>;
  /** 1 when this card is the page (first run with setup hidden); 2 under another page heading. */
  level?: 1 | 2;
  compact?: boolean;
}) {
  const [expanded, setExpanded] = createSignal(false);
  let banner: HTMLButtonElement | undefined;
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
  const recovery = () => <section class="node-offline" data-node-offline aria-label={tr('caNodeOffline')}>
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
  return <Show when={props.compact} fallback={recovery()}>
    <button ref={banner} type="button" class="offline-banner" data-offline-banner
      aria-haspopup="dialog" aria-expanded={expanded()} onClick={() => setExpanded(true)}>
      <span>{tr('caYourNodeIsOffline')}</span><span> · {tr('caRetryNow')}</span>
    </button>
    <Show when={expanded()}>
      <OfflineRecoverySheet onClose={() => setExpanded(false)} returnFocus={() => banner}>
        {recovery()}
      </OfflineRecoverySheet>
    </Show>
  </Show>;
}

/** Use the native top layer when available; iOS 15.0–15.3 needs a fixed overlay. */
function OfflineRecoverySheet(props: { children: JSX.Element; onClose: () => void; returnFocus: () => HTMLElement | undefined }) {
  let dialog!: HTMLDialogElement;
  let closeButton!: HTMLButtonElement;
  onMount(() => {
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else {
      dialog.setAttribute('open', '');
      // Older WebKit has no native focus containment. Allow a later modal
      // (such as an incoming pairing review) to take focus above this one.
      const keepFocus = (event: FocusEvent) => {
        const target = event.target as HTMLElement;
        if (!dialog.contains(target) && !target.closest('dialog[open], [aria-modal="true"]')) closeButton.focus();
      };
      document.addEventListener('focusin', keepFocus);
      onCleanup(() => document.removeEventListener('focusin', keepFocus));
    }
    closeButton.focus();
    onCleanup(onEscape(props.onClose));
    onCleanup(() => {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
      queueMicrotask(() => { const opener = props.returnFocus(); if (opener?.isConnected) opener.focus(); });
    });
  });
  return <dialog ref={dialog} class="offline-recovery-scrim" data-offline-sheet role="dialog" aria-modal="true" aria-label={tr('caYourNodeIsOffline')}
    onCancel={e => { e.preventDefault(); props.onClose(); }}
    onKeyDown={e => {
      if (e.key !== 'Tab') return;
      const controls = [...dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const first = controls[0]; const last = controls[controls.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }}
    onClick={e => { if (e.target === e.currentTarget) props.onClose(); }}>
    <div class="offline-recovery-sheet">
      <button ref={closeButton} type="button" class="quiet" autofocus onClick={props.onClose}>{tr('uiClose')}</button>
      {props.children}
    </div>
  </dialog>;
}
