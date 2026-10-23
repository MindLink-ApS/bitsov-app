import { t } from '../i18n';
import { For } from 'solid-js';

const STEPS = ['obScanPasteStep', 'obClaimStep', 'obCompareStep'] as const;

/**
 * Where adding a device stands, the same three steps on both devices.
 * `current`: 0-based index of the step in progress; STEPS.length when done;
 * null when the ticket ended (expired or used) with nothing in progress, so
 * no step claims to be current or done.
 * Display only: the panels' own state decides what is shown and done.
 */
export function PairSteps(props: { current: number | null; secondDevice?: boolean }) {
  const state = (i: number) => (props.current === null ? 'todo' : i < props.current ? 'done' : i === props.current ? 'current' : 'todo');
  const at = () => (props.current === null ? 'ended' : props.current >= STEPS.length ? 'done' : String(props.current + 1));
  return <ol class="pair-steps" data-pair-steps={at()} aria-label={props.current === null ? t('obTicketEndedLabel') : t('obAddingDeviceLabel')}>
    <For each={props.secondDevice ? [STEPS[0], 'obPrepareStep' as const, STEPS[2]] : STEPS}>{(label, i) => (
      <li data-step-state={state(i())} aria-current={state(i()) === 'current' ? 'step' : undefined}>
        <span class="pair-step-n" aria-hidden="true">{state(i()) === 'done' ? '✓' : i() + 1}</span>
        <span>{t(label)}</span>
      </li>
    )}</For>
  </ol>;
}
