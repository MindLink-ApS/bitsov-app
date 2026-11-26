import { t as tr } from '../i18n';
import { createSignal, onCleanup, onMount, Show } from 'solid-js';

/**
 * Mount only while loading. Fast operations never flash a spinner.
 * `class` replaces the spinner's own look; `decorative` marks an icon beside
 * text that already says what is happening (hidden from assistive tech).
 */
export function DelayedSpinner(props: { small?: boolean; class?: string; decorative?: boolean }) {
  const [visible, setVisible] = createSignal(false);
  onMount(() => {
    const timer = setTimeout(() => setVisible(true), 600);
    onCleanup(() => clearTimeout(timer));
  });
  return (
    <Show when={visible()}>
      <Show when={props.decorative} fallback={<span class={props.class ?? (props.small ? 'spinner small' : 'spinner')} role="status" aria-label={tr('caLoading')} />}>
        <span class={props.class ?? 'spinner'} aria-hidden="true" data-delayed-spinner />
      </Show>
    </Show>
  );
}
