import { afterEach, describe, expect, it, vi } from 'vitest';
import { keyboardLayout, installKeyboardViewport } from '../src/ios/keyboard';
import { backRoute, edgeSwipe, installEdgeBack, type BackRoute } from '../src/ios/edgeBack';

const full = { layoutHeight: 852, height: 852, offsetTop: 0, scale: 1 };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });
describe('keyboard layout', () => {
  it.each([
    [full, { height: 852, top: 0, bottom: 0, keyboard: false }],
    [{ ...full, height: 508 }, { height: 508, top: 0, bottom: 344, keyboard: true }],
    [{ ...full, height: 508, offsetTop: 40 }, { height: 508, top: 40, bottom: 304, keyboard: true }],
    [{ ...full, height: 880, offsetTop: -12 }, { height: 852, top: 0, bottom: 0, keyboard: false }],
    [{ layoutHeight: 393, height: 217, offsetTop: 0, scale: 1 }, { height: 217, top: 0, bottom: 176, keyboard: true }],
  ])('fits the visible viewport without double subtracting its offset', (input, expected) => {
    expect(keyboardLayout(input)).toEqual(expected);
  });
  it('ignores pinch zoom and invalid viewport samples', () => {
    expect(keyboardLayout({ ...full, height: 426, scale: 2 })).toBeNull();
    expect(keyboardLayout({ ...full, height: 0 })).toBeNull();
    expect(keyboardLayout({ ...full, height: NaN })).toBeNull();
  });
  it('tracks keyboard dismissal even after blur, and releases its listeners', () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(456);
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(852);
    const viewport = Object.assign(new EventTarget(), { height: 456, offsetTop: 396, scale: 1 });
    vi.stubGlobal('visualViewport', viewport);
    const stop = installKeyboardViewport();
    expect(document.documentElement.style.getPropertyValue('--visible-height')).toBe('456px');
    expect(document.documentElement.style.getPropertyValue('--visible-top')).toBe('396px');
    viewport.height = 852; viewport.offsetTop = 0; viewport.dispatchEvent(new Event('resize'));
    expect(document.documentElement.style.getPropertyValue('--keyboard-inset')).toBe('0px');
    expect(document.documentElement.dataset.keyboardOpen).toBe('false');
    stop();
    viewport.height = 508; viewport.dispatchEvent(new Event('resize'));
    expect(document.documentElement.style.getPropertyValue('--visible-height')).toBe('');
  });
});

describe('swipe routing', () => {
  it.each([
    [[], null], [['thread'], 'thread'], [['thread', 'settings'], 'settings'],
    [['settings', 'settings-page', 'thread'], 'settings-page'],
    [['thread', 'wallet'], 'wallet'],
    [['thread', 'contact'], 'contact'],
  ] as [BackRoute[], BackRoute | null][])('takes one visible level back: %j', (routes, expected) => {
    expect(backRoute({ routes, money: false, approval: false, call: false, modal: false })).toBe(expected);
  });
  it.each(['money', 'approval', 'call', 'modal'] as const)('never leaves a %s surface, even with a route behind it', blocker => {
    expect(backRoute({ routes: ['thread', 'settings-page', 'wallet'], money: false, approval: false, call: false, modal: false, [blocker]: true })).toBeNull();
  });
  it.each([
    [8, 200, 100, 204, 300, true], [35, 200, 140, 200, 300, false],
    [8, 200, 20, 200, 300, false], [8, 200, 100, 280, 300, false],
    [8, 200, 100, 200, 1400, false], [8, 200, -90, 200, 300, false],
  ])('recognizes an intentional edge gesture', (x, y, endX, endY, elapsed, expected) => {
    expect(edgeSwipe({ x, y }, { x: endX, y: endY }, elapsed)).toBe(expected);
  });
  it('rechecks blockers on release and cancels a gesture when the route changes', () => {
    let current: BackRoute | null = 'thread'; let navigations = 0;
    const stop = installEdgeBack(() => current ? { route: current, back: () => { navigations++; } } : null);
    const touch = (type: string, x: number) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(e, { touches: type === 'touchend' ? [] : [{ identifier: 1, clientX: x, clientY: 200 }], changedTouches: [{ identifier: 1, clientX: x, clientY: 200 }] });
      document.dispatchEvent(e);
    };
    touch('touchstart', 5); current = null; touch('touchend', 110);
    expect(navigations).toBe(0);
    current = 'thread'; touch('touchstart', 5); current = 'settings'; touch('touchend', 110);
    expect(navigations).toBe(0);
    touch('touchstart', 5); touch('touchmove', 80); touch('touchend', 110);
    expect(navigations).toBe(1);
    touch('touchstart', 5); touch('touchcancel', 100); touch('touchend', 110);
    expect(navigations).toBe(1);
    stop(); touch('touchstart', 5); touch('touchend', 110);
    expect(navigations).toBe(1);
  });
});

it('pins the last message on composer focus and scrolls a sheet input inside its own region', () => {
  vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(852);
  vi.stubGlobal('visualViewport', Object.assign(new EventTarget(), { height: 456, offsetTop: 0, scale: 1 }));
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { callback(0); return 1; });
  document.body.innerHTML = '<section class="track"><div class="stream"></div><form class="composer"><textarea></textarea></form></section><section style="overflow-y:auto"><input></section>';
  const stream = document.querySelector<HTMLElement>('.stream')!;
  Object.defineProperty(stream, 'scrollHeight', { value: 900 });
  const stop = installKeyboardViewport();
  document.querySelector('textarea')!.focus();
  expect(stream.scrollTop).toBe(900);
  const input = document.querySelector('input')!;
  const sheet = input.parentElement!;
  Object.defineProperty(sheet, 'scrollHeight', { value: 700 });
  Object.defineProperty(sheet, 'clientHeight', { value: 350 });
  vi.spyOn(sheet, 'getBoundingClientRect').mockReturnValue({ top: 60, bottom: 410 } as DOMRect);
  vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({ top: 500, bottom: 544 } as DOMRect);
  input.focus();
  expect(sheet.scrollTop).toBe(146);
  expect(document.documentElement.scrollTop).toBe(0);
  stop();
});

it('keeps a nearby primary reachable with its input when both fit the scroll region', () => {
  vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(852);
  vi.stubGlobal('visualViewport', Object.assign(new EventTarget(), { height: 456, offsetTop: 0, scale: 1 }));
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { callback(0); return 1; });
  document.body.innerHTML = '<div style="overflow-y:auto"><form><input><button type="submit">Continue</button></form></div>';
  const form = document.querySelector('div')!;
  const input = document.querySelector('input')!;
  const button = document.querySelector('button')!;
  Object.defineProperty(form, 'scrollHeight', { value: 700 });
  Object.defineProperty(form, 'clientHeight', { value: 350 });
  vi.spyOn(form, 'getBoundingClientRect').mockReturnValue({ top: 60, bottom: 410 } as DOMRect);
  vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({ top: 500, bottom: 544, height: 44 } as DOMRect);
  vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({ top: 570, bottom: 614, height: 44 } as DOMRect);
  const stop = installKeyboardViewport(); input.focus();
  expect(form.scrollTop).toBe(216);
  stop();
});
