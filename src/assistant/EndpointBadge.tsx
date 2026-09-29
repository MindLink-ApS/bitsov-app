import type { JSX } from 'solid-js';
import { endpointBadge, type BadgeInput } from './endpoint';
import type { Preset } from '../control/types';

/**
 * The persistent endpoint badge: which endpoint answers, who gets paid and
 * what leaves. Colour is never the only signal: the tier is written out.
 * Text only; a status region, so a change of endpoint is announced politely.
 */
export function EndpointBadge(props: { provider: BadgeInput; previewed?: Preset | null }): JSX.Element {
  const badge = () => endpointBadge(props.provider, props.previewed ?? null);
  return (
    <div
      class="endpoint-badge"
      role="status"
      aria-live="polite"
      aria-label={badge().text}
      data-testid="endpoint-badge"
      data-tier={badge().tier}
      title={badge().text}
    >
      <span class="endpoint-tier">
        <span class="endpoint-dot" aria-hidden="true" />
        {badge().name}
      </span>
      <span class="endpoint-where">{badge().where}</span>
      <span class="endpoint-fact" data-endpoint-paid>{badge().paid}</span>
      <span class="endpoint-fact" data-endpoint-leaves>{badge().leaves}</span>
    </div>
  );
}
