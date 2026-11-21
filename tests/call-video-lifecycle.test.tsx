import { afterEach, describe, expect, it, vi } from 'vitest';
import { Show, createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { CallVideoStage, TAP_SLOP_PX } from '../src/control/CallVideoStage';
import { escapeDepth } from '../src/control/escapeStack';

let release: (() => void) | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
  release?.();
  release = undefined;
  host?.remove();
  vi.restoreAllMocks();
});

function mountStage() {
  host = document.createElement('aside');
  document.body.append(host);
  const panel = host;
  panel.getBoundingClientRect = () => {
    const width = parseFloat(panel.style.width) || 340;
    return { width, height: 400, right: window.innerWidth, bottom: window.innerHeight, left: window.innerWidth - width, top: window.innerHeight - 400 } as DOMRect;
  };
  const [active, setActive] = createSignal(true);
  release = render(() => <Show when={active()}><CallVideoStage panel={() => panel} cameraOff={false}
    remote={<video />} self={<span>You</span>} /></Show>, panel);
  const stage = panel.querySelector<HTMLElement>('[data-call-stage]')!;
  stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 340, height: 255, right: 340, bottom: 255 } as DOMRect);
  return { panel, setActive };
}

const pointer = (target: EventTarget, type: string, x: number, y: number) =>
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));

describe('the video stage after the call ends', () => {
  it.each(['data-call-move', 'data-call-resize', 'data-call-self'])('%s is released when its Show branch disappears', (handle) => {
    const { panel, setActive } = mountStage();
    const self = panel.querySelector<HTMLElement>('[data-call-self]')!;
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');
    pointer(panel.querySelector(`[${handle}]`)!, 'pointerdown', 500, 500);
    pointer(window, 'pointermove', 100, 100);
    if (handle === 'data-call-self') expect(self.dataset.corner).toBe('tl');
    else expect(panel.style.width).not.toBe('');
    const listeners = added.mock.calls.filter(([type]) => ['pointermove', 'pointerup', 'pointercancel'].includes(type));
    expect(listeners).toHaveLength(3);
    setActive(false);
    for (const [type, fn] of listeners) expect(removed.mock.calls.some(([t, f]) => t === type && f === fn)).toBe(true);
    pointer(window, 'pointermove', 300, 200);
    window.dispatchEvent(new Event('resize'));
    expect(panel.style.right).toBe('');
    expect(panel.style.bottom).toBe('');
    expect(panel.style.width).toBe('');
    expect(panel.hasAttribute('data-call-window-moved')).toBe(false);
    setActive(true);
    pointer(panel.querySelector('[data-call-move]')!, 'pointerdown', 500, 500);
    pointer(window, 'pointermove', 450, 450);
    expect(panel.style.right).toBe('50px');
    pointer(window, 'pointerup', 450, 450);
  });

  it.each(['pointerup', 'pointercancel'])('%s ends a live drag', (event) => {
    const { panel } = mountStage();
    pointer(panel.querySelector('[data-call-move]')!, 'pointerdown', 500, 500);
    pointer(window, 'pointermove', 450, 450);
    const geometry = panel.getAttribute('style');
    pointer(window, event, 450, 450);
    pointer(window, 'pointermove', 300, 300);
    expect(panel.getAttribute('style')).toBe(geometry);
  });

  it('releases every simultaneously active drag on disposal', () => {
    const { panel, setActive } = mountStage();
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');
    for (const handle of ['data-call-move', 'data-call-resize', 'data-call-self']) pointer(panel.querySelector(`[${handle}]`)!, 'pointerdown', 500, 500);
    const listeners = added.mock.calls.filter(([type]) => type.startsWith('pointer'));
    expect(listeners).toHaveLength(9);
    setActive(false);
    for (const [type, fn] of listeners) expect(removed.mock.calls.some(([t, f]) => t === type && f === fn)).toBe(true);
  });

  it('does not register an Escape handler when a pending fullscreen request rejects after disposal', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'requestFullscreen');
    let rejectRequest!: (reason: unknown) => void;
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
      configurable: true,
      value: () => new Promise<void>((_resolve, reject) => { rejectRequest = reject; }),
    });
    const depth = escapeDepth();
    try {
      const { panel, setActive } = mountStage();
      panel.querySelector<HTMLButtonElement>('[data-call-fullscreen-toggle]')!.click();
      setActive(false);
      expect(escapeDepth()).toBe(depth);
      rejectRequest(new TypeError('fullscreen unavailable'));
      await Promise.resolve();
      await Promise.resolve();
      expect(escapeDepth()).toBe(depth);
    } finally {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      if (descriptor) Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', descriptor);
      else delete (HTMLElement.prototype as { requestFullscreen?: unknown }).requestFullscreen;
    }
  });
});

describe('tapping your own picture', () => {
  const tap = (self: HTMLElement, wobble: number) => {
    pointer(self, 'pointerdown', 300, 230);
    pointer(window, 'pointermove', 300 + wobble, 230 - wobble);
    pointer(window, 'pointerup', 300 + wobble, 230 - wobble);
    self.click();
  };

  it('a tap with the usual small wobble still moves it to the next corner', () => {
    const { panel } = mountStage();
    const self = panel.querySelector<HTMLElement>('[data-call-self]')!;
    const before = self.dataset.corner;
    tap(self, 2);
    expect(self.dataset.corner).not.toBe(before);
    const second = self.dataset.corner;
    tap(self, Math.floor((TAP_SLOP_PX - 1) / Math.SQRT2));
    expect(self.dataset.corner).not.toBe(second);
  });

  it('a real drag places it where it was dropped, and the click after it does not cycle again', () => {
    const { panel } = mountStage();
    const self = panel.querySelector<HTMLElement>('[data-call-self]')!;
    pointer(self, 'pointerdown', 300, 230);
    pointer(window, 'pointermove', 40, 30);
    pointer(window, 'pointerup', 40, 30);
    self.click();
    expect(self.dataset.corner).toBe('tl');
  });

  it('a wobble alone never drags it to the corner under the finger', () => {
    const { panel } = mountStage();
    const self = panel.querySelector<HTMLElement>('[data-call-self]')!;
    // Pressed right at the middle: a small wobble across the centre lines must not jump corners mid-press.
    pointer(self, 'pointerdown', 170, 128);
    const at = self.dataset.corner;
    pointer(window, 'pointermove', 168, 126);
    expect(self.dataset.corner).toBe(at);
    pointer(window, 'pointerup', 168, 126);
  });
});
