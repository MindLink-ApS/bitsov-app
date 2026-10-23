import { t } from '../i18n';
import { createSignal, Show } from 'solid-js';

/** Shown only after the supervised node refuses its existing data directory. */
export function InitializationRepair(props: { priceFloor?: boolean; repairing: boolean; onConfirm: () => Promise<void> }) {
  const [declined, setDeclined] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const working = () => busy() || props.repairing;
  const confirm = async () => {
    if (working()) return;
    setBusy(true); setError(null);
    try { await props.onConfirm(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  return <section class="panel disclosure" data-initialization-repair aria-busy={working()}>
    <h1>{t('obUpdateNeeded')}</h1>
    <Show when={props.priceFloor} fallback={<>
    <p>This node found an existing identity without the NODE_INITIALIZED marker. Older versions, including v0.3.0-rc7, did not write this marker. An interrupted setup can also cause this.</p>
    <p>With your permission, BitSov will ask the node to mark this data directory as initialized, then start it. The repair writes only the marker; it does not replace your identity. Starting the newer node may apply database migrations that cannot be undone by an older version. Keep a backup of your node data before continuing.</p>
    <p>No repair runs unless you agree. After a successful repair, this prompt is no longer needed for this data directory.</p>
    <details><summary>Repair command</summary><code>konsensus repair mark-initialized --config &lt;this node’s config&gt; --confirm</code></details>
    </>}>
      <p>Your node now charges at least 1 sat per page read; the old setting was 0.05 sat.</p>
      <p>With your permission, BitSov will raise this page price to 1 sat, keep a backup of your settings, and start your node.</p>
    </Show>
    <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
    <Show when={!declined()} fallback={<>
      <p>{t('obNodeRemainsStopped')}</p>
      <button class="quiet" data-repair-review onClick={() => setDeclined(false)}>{t('obReviewUpdate')}</button>
    </>}>
      <button class="primary" data-repair-consent disabled={working()} onClick={() => void confirm()}>{working() ? t('obUpdatingNode') : 'I agree — update and start my node'}</button>
      <button class="quiet" data-repair-decline disabled={working()} onClick={() => setDeclined(true)}>Not now</button>
    </Show>
  </section>;
}
