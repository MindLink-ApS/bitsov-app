import { t as tr } from '../i18n';
import { createEffect, type JSX } from 'solid-js';
import { copyPlainText } from './copy';

/**
 * Sealed display. Model text is assigned with `textContent` and is never parsed
 * as HTML. The only control is Copy.
 */
export function AssistantSurface(props: { text: string }): JSX.Element {
  const bind = (el: HTMLPreElement) => {
    createEffect(() => {
      el.textContent = props.text;
    });
  };

  return (
    <section class="assistant-seal">
      <pre class="assistant-output" data-testid="model-output" ref={bind} />
      <button
        type="button"
        class="assistant-copy"
        onClick={() => {
          void copyPlainText(props.text).catch(() => {});
        }}
      >
        {tr('caCopy')}</button>
    </section>
  );
}
