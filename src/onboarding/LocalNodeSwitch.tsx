import { createEffect, createSignal, on, Show } from 'solid-js';
import { SoftError } from '../control/SoftError';

/** Only changes the next startup; the live connection and trust stay remote. */
export function LocalNodeSwitch(props: { onForget: () => Promise<void>; disabled?: boolean; remoteRevision?: number }) {
  const [busy, setBusy] = createSignal(false);
  const [forgotten, setForgotten] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  createEffect(on(() => props.remoteRevision, () => {
    setForgotten(false);
    setError(null);
  }));
  const forget = async () => {
    if (busy() || forgotten() || props.disabled) return;
    setBusy(true);
    setError(null);
    try {
      await props.onForget();
      setForgotten(true);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  return <div class="local-node-switch">
    <button type="button" class="quiet" data-use-local disabled={busy() || forgotten() || props.disabled} onClick={() => void forget()}>
      {busy() ? 'Forgetting remote link…' : 'Use this Mac instead'}
    </button>
    <p class="hint">This Mac’s node is a separate wallet. Funds and contacts stay on the remote node.</p>
    <Show when={forgotten()}>
      <p class="hint" role="status">Saved remote link forgotten. Restart BitSov to use this Mac. Your current connection stays unchanged until you quit.</p>
    </Show>
    <Show when={error()}><SoftError message={error()!} /></Show>
  </div>;
}
