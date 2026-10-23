import { t as tr } from '../i18n';
import { For, type JSX } from 'solid-js';
import { copyPlainText } from './copy';
import { rowsText, type SitRow } from './rows';

/**
 * Sealed list of fixture rows: question id plus answer or `Unavailable`.
 * Values render as text nodes and are never parsed as HTML. The only control
 * is Copy.
 */
export function SitRows(props: { rows: SitRow[] }): JSX.Element {
  return (
    <section class="assistant-seal">
      <ol class="assistant-output sit-rows" data-testid="sit-rows">
        <For each={props.rows}>
          {(row) => (
            <li class="sit-row" data-testid="sit-row">
              <span class="sit-id">{row.id}</span>
              <span
                class="sit-answer"
                classList={{ 'sit-unavailable': row.answer === 'Unavailable' }}
              >
                {row.answer === 'Unavailable' ? tr('caUnavailable487') : row.answer}
              </span>
            </li>
          )}
        </For>
      </ol>
      <button
        type="button"
        class="assistant-copy"
        onClick={() => {
          void copyPlainText(rowsText(props.rows)).catch(() => {});
        }}
      >
        {tr('caCopy')}</button>
    </section>
  );
}
