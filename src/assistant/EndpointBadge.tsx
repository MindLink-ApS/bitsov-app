import type { JSX } from 'solid-js';
import { endpointBadge, type BadgeInput } from './endpoint';
import type { Preset } from '../control/types';

/**
 * The persistent endpoint badge: which endpoint answers, who gets paid and
 * what leaves. Colour is never the only signal: the tier is written out.
 * Text only; it announces a change of endpoint politely.
 */
export function EndpointBadge(props: { provider: BadgeInput; previewed?: Preset | null }): JSX.Element {
  const badge = () => endpointBadge(props.provider, props.previewed ?? null);
  return (
    <p
      class="endpoint-badge"
      data-testid="endpoint-badge"
      data-tier={badge().tier}
      title={badge().text}
      aria-label={badge().text}
      aria-live="polite"
    >
      <span class="endpoint-tier">
        <span class="endpoint-dot" aria-hidden="true" />
        {badge().name}
      </span>
      <span class="endpoint-where">{badge().where}</span>
      <span class="endpoint-fact" data-endpoint-paid>{badge().paid}</span>
      <span class="endpoint-fact" data-endpoint-leaves>{badge().leaves}</span>
    </p>
  );
}
