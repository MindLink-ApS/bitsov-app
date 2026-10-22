import { createUniqueId, Show, type JSX } from 'solid-js';

/** Every disabled primary explains itself visibly and to assistive technology. */
export function PrimaryAction(props: { disabledReason?: string; onClick: () => void; children: JSX.Element }) {
  const why = createUniqueId();
  return <div class="phone-primary">
    <button type="button" class="primary" disabled={!!props.disabledReason}
      aria-describedby={props.disabledReason ? why : undefined} onClick={props.onClick}>{props.children}</button>
    <Show when={props.disabledReason}><p id={why} class="why" role="status">{props.disabledReason}</p></Show>
  </div>;
}
