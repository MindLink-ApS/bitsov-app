import { createEffect, onCleanup } from 'solid-js';
import { t } from '../i18n';
import { shownPhase, type CallView } from './call';
import ringUrl from '../assets/incoming-ring.wav';

/**
 * The one owner of the incoming ringtone. Local media playback uses the system
 * output volume and mute setting. `quiet`: calls the owner quieted (Escape on
 * the ringing card) stop ringing here and stay on screen, still announced once.
 */
export function IncomingCallAlerts(props: { view: CallView; waiting: CallView[]; nameOf: (peer: string) => string; quiet?: (id: string) => boolean }) {
  const sounds = new Map<string, HTMLAudioElement>();
  const heardWaiting = new Set<string>();
  const incoming = () => [props.view, ...props.waiting].filter(v => v.phase === 'incoming' && !v.silenced && v.callId && v.peer);
  const ringing = () => incoming().filter(v => !props.quiet?.(`${v.peer}:${v.callId}`));
  const stop = (id: string) => {
    const audio = sounds.get(id);
    if (audio) { audio.pause(); audio.currentTime = 0; sounds.delete(id); }
  };
  createEffect(() => {
    const calls = ringing();
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

/** One short cue: tones of `ms` each, back to back with a short gap. */
export type CallCue = { hz: number[]; ms: number };
const CUE_GAIN = 0.05;
const CUE_GAP_MS = 60;
/** Connected (or back after a drop): two rising notes. */
export const CUE_CONNECTED: CallCue = { hz: [523, 659], ms: 110 };
/** The connection dropped: one low, quiet note, then silence while it tries again. */
export const CUE_INTERRUPTED: CallCue = { hz: [392], ms: 160 };
/** Ended, declined, no answer or failed: two falling notes. The card says which. */
export const CUE_ENDED: CallCue = { hz: [659, 440], ms: 130 };
/** Busy: three short beeps on one note. */
export const CUE_BUSY: CallCue = { hz: [480, 480, 480], ms: 120 };

/** Which cue, if any, a change of the card's state plays. Pure: each change plays at most one. */
export function cueFor(prev: { callId: string | null; phase: string } | null, v: CallView): CallCue | null {
  if (!v.callId || v.silenced) return null;
  const phase = shownPhase(v);
  const was = prev && prev.callId === v.callId ? prev.phase : null;
  if (phase === was) return null;
  if (phase === 'live' && (was === 'connecting' || was === 'reconnecting' || was === 'ringing')) return CUE_CONNECTED;
  if (phase === 'reconnecting' && was === 'live') return CUE_INTERRUPTED;
  if (phase === 'ended' && was !== null && was !== 'incoming') return v.reason === 'busy' ? CUE_BUSY : CUE_ENDED;
  return null;
}

/**
 * Short state cues on this device only, never sent into the call: connected,
 * dropped, ended and busy. One cue per change of state (no repeats on status
 * updates), none for an incoming call (its ringtone above owns that) and none
 * for a ringing outgoing call (the ringback owns that). A webview that refuses
 * audio only stays silent.
 */
export function CallCues(props: { view: CallView; audioContext?: () => Ctx }) {
  let prev: { callId: string | null; phase: string } | null = null;
  const contexts = new Set<Ctx>();
  const play = (cue: CallCue) => {
    let ctx: Ctx;
    try { ctx = props.audioContext ? props.audioContext() : new AudioContext(); } catch { return; }
    contexts.add(ctx);
    try {
      void Promise.resolve().then(() => ctx.resume()).catch(() => {});
      let at = ctx.currentTime;
      for (const hz of cue.hz) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = hz;
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(CUE_GAIN, at + 0.02);
        gain.gain.setValueAtTime(CUE_GAIN, at + cue.ms / 1000 - 0.02);
        gain.gain.linearRampToValueAtTime(0, at + cue.ms / 1000);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(at);
        osc.stop(at + cue.ms / 1000);
        at += (cue.ms + CUE_GAP_MS) / 1000;
      }
    } catch { /* No audio here: the cue stays silent. */ }
    const total = cue.hz.length * (cue.ms + CUE_GAP_MS) + 100;
    setTimeout(() => { contexts.delete(ctx); void Promise.resolve().then(() => ctx.close()).catch(() => {}); }, total);
  };
  createEffect(() => {
    const v = props.view;
    const cue = cueFor(prev, v);
    prev = { callId: v.callId, phase: shownPhase(v) };
    if (cue) play(cue);
  });
  onCleanup(() => { for (const c of contexts) void Promise.resolve().then(() => c.close()).catch(() => {}); contexts.clear(); });
  return null;
}
