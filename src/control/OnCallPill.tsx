import { createEffect, createSignal, onCleanup, Show } from 'solid-js';
import type { CallView } from './call';
import { duration } from './voice';

/** Reads the call snapshot; owns only a display clock, never media or signalling. */
export function OnCallPill(props: { view: CallView; onReturn: () => void }) {
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (props.view.phase !== 'live') return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => window.clearInterval(timer));
  });
  return <Show when={props.view.phase === 'live'}>
    <button type="button" class="on-call-pill" data-on-call aria-label="On call · Return to call" onClick={props.onReturn}>
      <span class="dot" aria-hidden="true" />
      <span>On call<Show when={props.view.liveAt !== null}> · {duration(Math.max(0, now() - props.view.liveAt!)).padStart(5, '0')}</Show></span>
    </button>
  </Show>;
}
