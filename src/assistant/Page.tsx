import { Show, type JSX } from 'solid-js';
import { AssistantSurface } from './Assistant';
import { AskPanel } from './AskPanel';
import { rowsAnswerer, type Answerer } from './ask';
import { SitRows } from './SitRows';
import { SourceLabel } from './SourceLabel';
import { EndpointBadge } from './EndpointBadge';
import { OWN_RULES } from './endpoint';
import { NO_ROWS_TEXT } from './rows';
import type { View } from './source';

/**
 * The whole window: which endpoint answers (always Own here), where the rows came from, a question box, and the rows.
 * Everything shown comes from `view`, which the host set before the page ran.
 */
export function AssistantPage(props: {
  view: View;
  answerer?: Answerer;
  now?: () => number;
}): JSX.Element {
  const clock = props.now ?? (() => performance.now());
  const opened = clock();
  const answerer = props.answerer ?? rowsAnswerer(props.view.rows);
  return (
    <main class="assistant-page">
      {/* This window has no model: the rules on this computer answer. */}
      <header class="assistant-head">
        <EndpointBadge provider={OWN_RULES} />
      </header>
      <SourceLabel source={props.view.source} freshness={props.view.freshness} now={clock} />
      <Show
        when={props.view.rows.length > 0}
        fallback={<AssistantSurface text={NO_ROWS_TEXT()} />}
      >
        <AskPanel
          rows={props.view.rows}
          source={props.view.source}
          freshness={props.view.freshness}
          answerer={answerer}
          openMs={() => clock() - opened}
        />
        <SitRows rows={props.view.rows} />
      </Show>
    </main>
  );
}
