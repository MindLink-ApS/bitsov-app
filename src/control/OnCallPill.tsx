import { t } from '../i18n';
import { createEffect, createSignal, onCleanup, Show } from 'solid-js';
import type { CallView } from './call';
import { duration } from './voice';

/** One word per call state, the same in the pill and the call panel's title. */
export const CALL_STATE_WORD: Record<CallView['phase'], string> = {
  idle: '',
  get calling() { return t('callCalling'); }, get ringing() { return t('callRinging'); },
  get incoming() { return t('callIncoming'); }, get connecting() { return t('callConnecting'); },
  get live() { return t('callLive'); }, get reconnecting() { return t('callReconnecting'); }, get ended() { return t('callEnded'); },
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
    // Live: the duration. Reconnecting: the seconds left before the call ends (only when known).
    if (props.view.phase !== 'live' && !(props.view.phase === 'reconnecting' && props.view.dropAt !== null)) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => window.clearInterval(timer));
  });
  const shown = () => props.view.phase !== 'idle' && props.view.phase !== 'incoming';
  const text = () => {
    // The browser reports no network (display only, #238): said on the pill too.
    const word = CALL_STATE_WORD[props.view.phase] + (props.view.offline ? t('uiOffline504') : '');
    if (props.view.phase === 'reconnecting' && props.view.dropAt !== null) return `${word} · ${Math.max(0, Math.ceil((props.view.dropAt - now()) / 1000))} s`;
    return props.view.phase === 'live' && props.view.liveAt !== null
      ? `${word} · ${duration(Math.max(0, now() - props.view.liveAt)).padStart(5, '0')}`
      : word;
  };
  return <Show when={shown()}>
    <button type="button" class="on-call-pill" data-on-call={props.view.phase} aria-label={t('uiReturnToCall', CALL_STATE_WORD[props.view.phase])} onClick={props.onReturn}>
      <span class="dot" aria-hidden="true" />
      <span>{text()}</span>
    </button>
  </Show>;
}
