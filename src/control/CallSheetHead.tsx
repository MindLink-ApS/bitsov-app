import { Show } from 'solid-js';
import { t as tr } from '../i18n';
import { shownPhase, type CallView } from './call';
import { callEndLine } from './callEnd';
import { petnameOf } from './petnames';
import { duration } from './voice';

/**
 * The person on a call, as the owner named them: their local contact name, or
 * "Unknown contact". Never a name the other side sent, and never a key or id
 * (those stay under Details, for a deliberate check).
 */
export function callPersonName(peer: string | null): { name: string; known: boolean } {
  const pet = peer ? petnameOf(peer) : null;
  return pet ? { name: pet, known: true } : { name: tr('callUnknownContact'), known: false };
}

/** Up to two letters for the round avatar, from the owner's own name for them. */
export function callInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = (words.length > 1 ? [words[0], words[words.length - 1]] : words).map(w => [...w][0] ?? '');
  return letters.join('').toLocaleUpperCase();
}

/**
 * One short line under the name, as on a phone: what is happening now. The
 * audio or video word comes from the call's own media, which is already audio
 * when this build answers a video offer as audio. An ended call says why, in
 * the same plain words as before (the host's own words stay under Details).
 */
export function callStatusLine(v: CallView, name: string): string {
  const phase = shownPhase(v);
  const video = v.media === 'video';
  const tagged = (word: string) => (video ? `${word} · ${tr('callStatusVideo')}` : word);
  switch (phase) {
    case 'incoming': return tr(video ? 'callStatusIncomingVideo' : 'callStatusIncomingAudio');
    case 'calling': return tagged(tr('callStatusCalling'));
    case 'ringing': return tagged(tr('callStatusRinging'));
    case 'connecting': return tagged(tr('callStatusConnecting'));
    case 'live': return tr(video ? 'callStatusLiveVideo' : 'callStatusLive');
    case 'reconnecting': return tr('callStatusReconnecting');
    case 'ended': return v.mediaDenied ? tr('callEnded') : callEndLine(v, name).text;
    default: return '';
  }
}

/**
 * The top of the call sheet: a round avatar, the person's name as the
 * heading, and the status line. Display only; it reads the call snapshot.
 * The ids let the dialog take its accessible name and description from here.
 */
export function CallSheetHead(props: { view: CallView; name: string; known: boolean; nameId: string; statusId: string; now: number }) {
  const v = () => props.view;
  const timed = () => (v().phase === 'live' || v().phase === 'reconnecting') && v().liveAt !== null;
  return (
    <header class="call-head" data-call-head>
      <span class="call-avatar" data-call-avatar={props.known ? 'initials' : 'unknown'} aria-hidden="true">
        <Show when={props.known} fallback={
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
            <circle cx="12" cy="8.5" r="3.6" />
            <path d="M4.8 19.5c1.2-3.4 4-5.2 7.2-5.2s6 1.8 7.2 5.2" />
          </svg>
        }>{callInitials(props.name)}</Show>
      </span>
      <h2 class="call-name who" id={props.nameId} data-call-name><bdi>{props.name}</bdi></h2>
      <p class="call-status" id={props.statusId}>
        <span data-call-title data-call-ended={v().phase === 'ended' && !v().mediaDenied ? '' : undefined}>{callStatusLine(v(), props.name)}</span>
        <Show when={timed()}>
          {' · '}<span class="duration" data-call-duration>{duration(Math.max(0, props.now - v().liveAt!))}</span>
        </Show>
      </p>
      {/* Screen readers hear each change of state once, never the running clock. An incoming call is announced by its alert. */}
      <span class="sr-only" role="status" data-call-status-live>{v().phase === 'incoming' ? '' : callStatusLine(v(), props.name)}</span>
    </header>
  );
}
