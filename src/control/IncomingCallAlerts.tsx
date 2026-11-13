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
