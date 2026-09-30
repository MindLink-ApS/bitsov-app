import { Show } from 'solid-js';
import { softenError } from './userFacing';

/** Calm error line; technical detail only behind a tap when present. */
export function SoftError(props: {
  message: string;
  /** Marks the block for tests / selectors (e.g. discover-error, intro-unavailable). */
  data?: string;
  class?: string;
}) {
  const soft = () => softenError(props.message);
  return (
    <div class={props.class ?? 'soft-error'} data-soft-error={props.data ?? ''}>
      <p
        class="err-note"
        data-soft-summary
        data-discover-error={props.data === 'discover-error' ? soft().summary : undefined}
        data-intro-unavailable={props.data === 'intro-unavailable' ? soft().summary : undefined}
        data-fd-edit-error={props.data === 'fd-edit-error' ? soft().summary : undefined}
        data-door-error={props.data === 'door-error' ? soft().summary : undefined}
      >
        {soft().summary}
      </p>
      <Show when={soft().detail}>
        {(d) => (
          <details class="quiet-detail" data-soft-detail>
            <summary>Details</summary>
            <p class="hint">{d()}</p>
          </details>
        )}
      </Show>
    </div>
  );
}
