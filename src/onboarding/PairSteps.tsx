import { For } from 'solid-js';

const STEPS = ['Scan or paste the ticket', 'Enter the claim code', 'Compare the four words'];

/**
 * Where adding a device stands, the same three steps on both devices.
 * `current`: 0-based index of the step in progress; STEPS.length when done.
 * Display only: the panels' own state decides what is shown and done.
 */
export function PairSteps(props: { current: number }) {
  const state = (i: number) => (i < props.current ? 'done' : i === props.current ? 'current' : 'todo');
  return <ol class="pair-steps" data-pair-steps={props.current >= STEPS.length ? 'done' : String(props.current + 1)} aria-label="Adding a device">
    <For each={STEPS}>{(label, i) => (
      <li data-step-state={state(i())} aria-current={state(i()) === 'current' ? 'step' : undefined}>
        <span class="pair-step-n" aria-hidden="true">{state(i()) === 'done' ? '✓' : i() + 1}</span>
        <span>{label}</span>
      </li>
    )}</For>
  </ol>;
}
