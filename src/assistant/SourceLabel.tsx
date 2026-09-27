import { createSignal, onCleanup, Show, type JSX } from 'solid-js';
import {
  freshnessText,
  sourceText,
  summarize,
  type Freshness,
  type Source,
} from './source';

/** How often the age on a live label is redrawn. Not a fetch. */
const TICK_MS = 1000;

/**
 * Where the rows below came from and, for live rows, how old the read is.
 * Text only, from a closed set of strings. The age ticks from the window's
 * monotonic clock; nothing here reads the node or asks the host.
 */
export function SourceLabel(props: {
  source: Source;
  freshness?: Freshness | null;
  now?: () => number;
}): JSX.Element {
  const text = () => sourceText(props.source);
  const clock = props.now ?? (() => performance.now());
  const opened = clock();
  const [openMs, setOpenMs] = createSignal(0);
  if (props.source.kind === 'live') {
    const timer = setInterval(() => setOpenMs(clock() - opened), TICK_MS);
    onCleanup(() => clearInterval(timer));
  }
  const summary = () => summarize(props.freshness ?? null, openMs());
  const live = () => props.source.kind === 'live';
  return (
    <p
      class="source-label"
      classList={{
        'source-mock': props.source.kind === 'mock',
        'source-stale': live() && summary().state === 'stale',
      }}
      data-testid="source-label"
      data-source={props.source.kind}
      data-reason={props.source.kind === 'mock' ? props.source.reason : undefined}
    >
      <strong class="source-title">{text().title}</strong>
      <span class="source-detail">{text().detail}</span>
      <Show when={live()}>
        <span
          class="source-freshness"
          data-testid="source-freshness"
          data-freshness={summary().state}
        >
          {freshnessText(summary())}
        </span>
      </Show>
    </p>
  );
}
