import { createEffect, onCleanup } from 'solid-js';
import { appPlatform } from '../platform';

function resume(el: HTMLMediaElement) {
  try {
    const started = el.play();
    if (started && typeof started.catch === 'function') started.catch(() => {});
  } catch { /* not playable here (e.g. no media support); autoplay still applies */ }
}

export function MediaView(props: { stream: MediaStream | null; video: boolean; muted: boolean; kind: 'local' | 'remote' }) {
  let el: HTMLMediaElement | undefined;
  let audio: HTMLAudioElement | undefined;
  // iOS can suspend video playback when locked. Keep the remote voice on a
  // separate audio-only stream and mute the video to avoid playing it twice.
  const separateAudio = appPlatform() === 'ios' && props.video && props.kind === 'remote';
  createEffect(() => {
    if (el) {
      el.srcObject = props.stream;
      // autoplay alone may not restart a player WebKit paused while hidden.
      if (props.stream) resume(el);
    }
    if (audio) audio.srcObject = props.stream ? new MediaStream(props.stream.getAudioTracks()) : null;
  });
  onCleanup(() => {
    if (el) el.srcObject = null;
    if (audio) audio.srcObject = null;
  });
  return props.video
    ? <>
        <video ref={(v) => { el = v; }} autoplay playsinline muted={separateAudio || props.muted} class={`call-video ${props.kind}`} data-call-media={props.kind} />
        {separateAudio && <audio ref={(a) => { audio = a; }} autoplay muted={props.muted} data-call-audio={props.kind} />}
      </>
    : <audio ref={(a) => { el = a; }} autoplay muted={props.muted} data-call-media={props.kind} />;
}
