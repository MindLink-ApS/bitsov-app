import { expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { MediaView } from '../src/control/CallMedia';

vi.mock('../src/platform', () => ({ appPlatform: () => 'ios' }));
it('keeps iOS remote video audio on an independent audio-only playback element', () => {
  const audio = { kind: 'audio' } as MediaStreamTrack;
  const stream = new MediaStream([audio, { kind: 'video' } as MediaStreamTrack]);
  const root = document.createElement('div');
  const dispose = render(() => <MediaView stream={stream} video muted={false} kind="remote" />, root);
  const video = root.querySelector('video')!;
  const playback = root.querySelector('audio')!;
  expect(playback).not.toBeNull();
  expect(video.muted).toBe(true);
  expect(playback.muted).toBe(false);
  expect((playback.srcObject as MediaStream).getAudioTracks()).toEqual([audio]);
  expect((playback.srcObject as MediaStream).getVideoTracks()).toEqual([]);
  expect(video.srcObject).toBe(stream);
  dispose();
  expect(video.srcObject).toBeNull();
  expect(playback.srcObject).toBeNull();
});

it('does not play local microphone audio back to the caller', () => {
  const root = document.createElement('div');
  const dispose = render(() => <MediaView stream={null} video muted kind="local" />, root);
  expect(root.querySelector('audio')).toBeNull();
  expect(root.querySelector('video')!.muted).toBe(true);
  dispose();
});
