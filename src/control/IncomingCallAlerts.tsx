import { createEffect, onCleanup } from 'solid-js';
import { t } from '../i18n';
import type { CallView } from './call';
import ringUrl from '../assets/incoming-ring.wav';

/** Local media playback uses the system output volume and mute setting. */
export function IncomingCallAlerts(props: { view: CallView; waiting: CallView[]; nameOf: (peer: string) => string }) {
  const sounds = new Map<string, HTMLAudioElement>();
  const heardWaiting = new Set<string>();
  const incoming = () => [props.view, ...props.waiting].filter(v => v.phase === 'incoming' && !v.silenced && v.callId && v.peer);
  const stop = (id: string) => {
    const audio = sounds.get(id);
    if (audio) { audio.pause(); audio.currentTime = 0; sounds.delete(id); }
  };
  createEffect(() => {
    const calls = incoming();
    for (const id of sounds.keys()) if (!calls.some(v => `${v.peer}:${v.callId}` === id)) stop(id);
    for (const call of calls) {
      const id = `${call.peer}:${call.callId}`;
      const waiting = call !== props.view;
      if (sounds.has(id) || (waiting && heardWaiting.has(id))) continue;
      const audio = new Audio(ringUrl);
      audio.loop = !waiting;
      audio.volume = waiting ? 0.25 : 0.7;
      sounds.set(id, audio);
      if (waiting) heardWaiting.add(id);
      // A denied browser autoplay never interrupts signalling or hides the card.
      void audio.play().catch(() => {});
    }
  });
  onCleanup(() => { for (const id of sounds.keys()) stop(id); });
  return <span class="sr-only" role="alert" aria-live="assertive" aria-atomic="true" data-incoming-announcement>
    {incoming().map(v => t('notificationCall', props.nameOf(v.peer!))).join('. ')}
  </span>;
}

/** Ringback cadence: a soft 425 Hz tone, 1 s on and 4 s off, as on a European phone line. */
export const RINGBACK_HZ = 425;
export const RINGBACK_ON_MS = 1_000;
export const RINGBACK_PERIOD_MS = 5_000;
const RINGBACK_GAIN = 0.06;

type Ctx = Pick<AudioContext, 'createOscillator' | 'createGain' | 'destination' | 'currentTime' | 'resume' | 'close'>;

/**
 * While our outgoing call rings (their node took the offer), a soft
 * repeating ringback on this device only: generated here, played to the
 * local output, never sent into the call. It stops on connect, end, cancel
 * or timeout (any phase other than ringing). A webview that refuses audio
 * (autoplay, no AudioContext) only stays silent; the call goes on as before.
 */
export function OutgoingRingback(props: { view: CallView; audioContext?: () => Ctx }) {
  let ctx: Ctx | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let playing: string | null = null;
  const beep = () => {
    if (!ctx) return;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t0 = ctx.currentTime;
      osc.frequency.value = RINGBACK_HZ;
      // Short ramps: no click at the start or end of each tone.
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(RINGBACK_GAIN, t0 + 0.05);
      gain.gain.setValueAtTime(RINGBACK_GAIN, t0 + RINGBACK_ON_MS / 1000 - 0.05);
      gain.gain.linearRampToValueAtTime(0, t0 + RINGBACK_ON_MS / 1000);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + RINGBACK_ON_MS / 1000);
    } catch { /* No audio here: the ring stays silent. */ }
  };
  const stop = () => {
    clearInterval(timer);
    timer = undefined;
    playing = null;
    const c = ctx;
    ctx = null;
    if (c) void Promise.resolve().then(() => c.close()).catch(() => {});
  };
  createEffect(() => {
    const v = props.view;
    const id = v.outgoing && v.phase === 'ringing' && !v.silenced && v.callId ? `${v.peer}:${v.callId}` : null;
    if (id === playing) return;
    stop();
    if (!id) return;
    try {
      ctx = props.audioContext ? props.audioContext() : new AudioContext();
    } catch { return; }
    playing = id;
    // A context the webview keeps suspended (autoplay) never interrupts the call.
    void Promise.resolve().then(() => ctx?.resume()).catch(() => {});
    beep();
    timer = setInterval(beep, RINGBACK_PERIOD_MS);
  });
  onCleanup(stop);
  return null;
}
