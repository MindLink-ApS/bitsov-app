import { For } from 'solid-js';

/** Row-major order is the node's order; never sort or transform SAS words. */
export function PairWords(props: { words: string[] }) {
  return <ol class="pair-words" aria-label="Comparison words">
    <For each={props.words}>{word => <li data-pair-word>{word}</li>}</For>
  </ol>;
}
