/**
 * The local preview is kept mounted while the camera is off and shown again
 * when it returns. MediaView asks the player to play whenever it gets a
 * stream, so a player WebKit paused meanwhile does not stay blank.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { MediaView } from '../src/control/CallMedia';

const fakeStream = () => ({ getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] } as unknown as MediaStream);

describe('MediaView resumes playback', () => {
  beforeEach(() => { vi.spyOn(HTMLMediaElement.prototype, 'srcObject', 'set').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ''; });

  it('plays when a stream is attached and again when it changes', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    const [stream, setStream] = createSignal<MediaStream | null>(null);
    const root = document.createElement('div'); document.body.append(root);
    render(() => <MediaView stream={stream()} video muted kind="local" />, root);
    expect(play).not.toHaveBeenCalled();
    setStream(fakeStream());
    expect(play).toHaveBeenCalledTimes(1);
    setStream(fakeStream());
    expect(play).toHaveBeenCalledTimes(2);
  });

  it('a refused play() is not an error', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.reject(new DOMException('no', 'NotAllowedError')));
    const root = document.createElement('div'); document.body.append(root);
    expect(() => render(() => <MediaView stream={fakeStream()} video muted kind="local" />, root)).not.toThrow();
    await Promise.resolve();
  });
});
