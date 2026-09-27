import type { JSX } from 'solid-js';
import { sourceText, type Source } from './source';

/** Where the rows below came from. Text only, from a closed set of strings. */
export function SourceLabel(props: { source: Source }): JSX.Element {
  const text = () => sourceText(props.source);
  return (
    <p
      class="source-label"
      classList={{ 'source-mock': props.source.kind === 'mock' }}
      data-testid="source-label"
      data-source={props.source.kind}
      data-reason={props.source.kind === 'mock' ? props.source.reason : undefined}
    >
      <strong class="source-title">{text().title}</strong>
      <span class="source-detail">{text().detail}</span>
    </p>
  );
}
