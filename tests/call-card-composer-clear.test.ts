import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keepCallCardOverComposer } from '../src/control/Shell';

// A keyboard focus pan moves the visible part of the page (visualViewport.offsetTop)
// without changing its height: the composer moves, nothing resizes. The call card's
// clearance must follow that move too, or the card covers Send.
describe('the call card clearance above the open chat composer', () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    stop = undefined;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const setUp = () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number);
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
    const viewport = Object.assign(new EventTarget(), { height: 482, offsetTop: 120, width: 360 });
    vi.stubGlobal('visualViewport', viewport);
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    document.body.innerHTML = '<div class="cc"><section class="track"><div class="composer"></div></section></div>';
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 740 });
    const composer = document.querySelector<HTMLElement>('.composer')!;
    let top = 431;
    composer.getClientRects = () => [{}] as unknown as DOMRectList;
    composer.getBoundingClientRect = () => ({ top, bottom: top + 60, left: 0, right: 360, width: 360, height: 60 } as DOMRect);
    return { viewport, moveTo: (y: number) => { top = y; } };
  };
  const clear = () => document.documentElement.style.getPropertyValue('--call-composer-clear');

  it('is read again when only the visible part scrolls (a keyboard pan), not only on resize', () => {
    const { viewport, moveTo } = setUp();
    stop = keepCallCardOverComposer();
    expect(clear()).toBe('309px');
    moveTo(311);
    viewport.offsetTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(50);
    expect(clear()).toBe('429px');
  });

  it('stops listening to the viewport when the card closes', () => {
    const { viewport, moveTo } = setUp();
    stop = keepCallCardOverComposer();
    stop();
    stop = undefined;
    expect(clear()).toBe('');
    moveTo(100);
    viewport.dispatchEvent(new Event('scroll'));
    viewport.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(50);
    expect(clear()).toBe('');
  });
});

// jsdom does not apply the stylesheet, so read the rule: only the floating card pins its actions
// to its foot. A waiting-call card in the stack is short and keeps them in place.
describe('the call card actions pinned to its foot', () => {
  it('apply to the floating card only, not to waiting-call cards', () => {
    const css = readFileSync(join(__dirname, '..', 'src', 'styles.css'), 'utf8');
    const sticky = [...css.matchAll(/([^{}]*\.call-actions)\s*\{[^}]*position:\s*sticky/g)].map((m) => m[1].trim().split('\n').pop()!.trim());
    expect(sticky).toEqual(['.call-panel[data-call-panel]:not(.waiting-calls .call-panel) > .call-actions']);
  });
});
