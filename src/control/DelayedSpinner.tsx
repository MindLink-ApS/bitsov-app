import { t as tr } from '../i18n';
import { createSignal, onCleanup, onMount, Show } from 'solid-js';

/** Mount only while loading. Fast operations never flash a spinner. */
export function DelayedSpinner(props: { small?: boolean }) {
  const [visible, setVisible] = createSignal(false);
  onMount(() => {
    const timer = setTimeout(() => setVisible(true), 600);
    onCleanup(() => clearTimeout(timer));
  });
  return <Show when={visible()}><span class={props.small ? 'spinner small' : 'spinner'} role="status" aria-label={tr('caLoading')} /></Show>;
}
