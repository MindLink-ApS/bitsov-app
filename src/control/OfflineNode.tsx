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
  return <section class="node-offline" data-node-offline aria-label="Node offline">
    <BoxIllustration offline />
    <Dynamic component={props.level === 1 ? 'h1' : 'h2'} data-offline-title>Your node is offline</Dynamic>
    <p>We can’t reach it right now. BitSov keeps trying. New messages can’t be sent until your node is back; ones already sent may still complete.</p>
    <p class="hint">Last seen: <Show when={props.lastSeen != null} fallback="unknown">
      <time dateTime={new Date(props.lastSeen!).toISOString()}>{new Date(props.lastSeen!).toLocaleString()}</time>
    </Show></p>
    <ul>
      <li>{props.remote ? 'Check that the computer or server running your node is on and connected to the network.' : 'Check that your node is running on this computer.'}</li>
      <li>Check this device’s network connection.</li>
      <li>After a restart, give your node a moment to reconnect.</li>
    </ul>
    <Show when={props.retryAfterSecs}>
      <p class="hint" data-remote-retry>Remote connection unavailable · waiting {props.retryAfterSecs} s before retrying.</p>
    </Show>
    <Show when={failed()}><p role="status">Still unavailable. Check the connection and try again.</p></Show>
    <button type="button" class="primary" disabled={busy()} onClick={() => void retry()}>{busy() ? 'Retrying…' : 'Retry now'}</button>
  </section>;
}
