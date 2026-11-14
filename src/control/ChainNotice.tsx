import { Show } from 'solid-js';
import { t } from '../i18n';
import type { NodeOverview } from './types';

export function ChainNotice(props: { overview: NodeOverview | null }) {
  return (
    <Show when={props.overview?.chain_view?.explorer_default === true && props.overview.chain_view.trust_level === 'third_party'}>
      <aside class="hint money-notice" data-chain-notice>
        <p role="status">{t('chainPublicService')}</p>
        <details>
          <summary>{t('chainUseOwn')}</summary>
          <p>{t('chainUseOwnGuide')}</p>
        </details>
      </aside>
    </Show>
  );
}
