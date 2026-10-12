import { createSignal, Show } from 'solid-js';
import { softenError } from './userFacing';

/** Calm error line; technical detail only behind a tap when present. */
export function SoftError(props: {
  message: string;
  /** Marks the block for tests / selectors (e.g. discover-error, intro-unavailable). */
  data?: string;
  class?: string;
  summary?: string;
  detailNote?: string;
  onReconnect?: () => void | Promise<void>;
}) {
  const soft = () => softenError(props.message);
  const [reconnecting, setReconnecting] = createSignal(false);
  const reconnect = async () => {
    if (reconnecting()) return;
    setReconnecting(true);
    try { await props.onReconnect?.(); }
    finally { setReconnecting(false); }
  };
  const summary = () => soft().money ? soft().summary : props.summary ?? soft().summary;
  const detail = () => soft().detail ?? (props.summary && !soft().money ? props.message : null);
  return (
    <div class={props.class ?? 'soft-error'} data-soft-error={props.data ?? ''}>
      <p
        class="err-note"
        role="alert"
        data-soft-summary
        data-discover-error={props.data === 'discover-error' ? soft().summary : undefined}
        data-intro-unavailable={props.data === 'intro-unavailable' ? soft().summary : undefined}
        data-fd-edit-error={props.data === 'fd-edit-error' ? soft().summary : undefined}
        data-door-error={props.data === 'door-error' ? soft().summary : undefined}
      >
        {summary()}
      </p>
      <Show when={props.onReconnect && !soft().money}>
        {/* The way forward is a real button, not a quiet link. */}
        <button type="button" class="soft" data-soft-reconnect disabled={reconnecting()} onClick={() => void reconnect()}>{reconnecting() ? 'Reconnecting…' : 'Reconnect'}</button>
      </Show>
      <Show when={detail()}>
        {(d) => (
          <details class="quiet-detail" data-soft-detail>
            <summary>Details</summary>
            <p class="hint">{d()}</p>
            <Show when={props.detailNote}><p class="hint">{props.detailNote}</p></Show>
          </details>
        )}
      </Show>
    </div>
  );
}
