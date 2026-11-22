import { Show } from 'solid-js';
import { t } from '../i18n';
import type { NodeOverview } from './types';

/**
 * Where the box reads the Bitcoin network from, in plain words. A Settings → Node
 * fact only: it is not a warning and never sits over the chat or a call.
 */
export function ChainNotice(props: { overview: NodeOverview | null }) {
  return (
    <Show when={props.overview?.chain_view?.explorer_default === true && props.overview.chain_view.trust_level === 'third_party'}>
      <section class="chain-source" data-chain-notice>
        <h3>{t('chainSettingsTitle')}</h3>
        <p class="hint" role="status">{t('chainPublicService')}</p>
        <details>
          <summary>{t('chainUseOwn')}</summary>
          <p class="hint">{t('chainUseOwnGuide')}</p>
        </details>
      </section>
    </Show>
  );
}
