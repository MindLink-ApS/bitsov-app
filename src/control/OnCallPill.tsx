import { createEffect, createSignal, onCleanup, Show } from 'solid-js';
import type { CallView } from './call';
import { duration } from './voice';

/** One word per call state, the same in the pill and the call panel's title. */
export const CALL_STATE_WORD: Record<CallView['phase'], string> = {
  idle: '', calling: 'Calling', ringing: 'Ringing', incoming: 'Incoming call', connecting: 'Connecting',
  live: 'Live', reconnecting: 'Reconnecting…', ended: 'Call ended',
};

/**
 * The call's state wherever the owner is in the app: Calling, Ringing,
 * Connecting, Live mm:ss, Reconnecting… or Call ended (until the card is
 * closed). An incoming call has its own ring card. Reads the call snapshot;
 * owns only a display clock (live only), never media or signalling.
 */
export function OnCallPill(props: { view: CallView; onReturn: () => void }) {
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (props.view.phase !== 'live') return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => window.clearInterval(timer));
  });
  const shown = () => props.view.phase !== 'idle' && props.view.phase !== 'incoming';
  const text = () => {
    const word = CALL_STATE_WORD[props.view.phase];
    return props.view.phase === 'live' && props.view.liveAt !== null
      ? `${word} · ${duration(Math.max(0, now() - props.view.liveAt)).padStart(5, '0')}`
      : word;
  };
  return <Show when={shown()}>
    <button type="button" class="on-call-pill" data-on-call={props.view.phase} aria-label={`${CALL_STATE_WORD[props.view.phase]} · Return to call`} onClick={props.onReturn}>
      <span class="dot" aria-hidden="true" />
      <span>{text()}</span>
    </button>
  </Show>;
}
