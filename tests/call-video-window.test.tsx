/**
 * The call's video window: full screen (button, double-click, Esc), a call
 * window that moves and resizes within bounds, your own picture movable
 * between corners; the outgoing ringback; and the microphone access screen.
 * Presentation only: no media, signal or payment is involved here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { setLanguagePref } from '../src/i18n';
import { CallVideoStage, maxPanelWidth } from '../src/control/CallVideoStage';
import { OutgoingRingback, RINGBACK_HZ, RINGBACK_PERIOD_MS } from '../src/control/IncomingCallAlerts';
import { MicAccessNote } from '../src/control/MicAccessNote';
import { IDLE, type CallView } from '../src/control/call';
import { escapeDepth } from '../src/control/escapeStack';

let root: HTMLDivElement;
let dispose: (() => void) | null = null;
const $ = <T extends Element = HTMLElement>(s: string) => root.querySelector<T>(s);
const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
  setLanguagePref('en');
});
afterEach(() => {
  dispose?.();
  dispose = null;
  root.remove();
  vi.restoreAllMocks();
});

function stage() {
  const panel = document.createElement('aside');
  panel.className = 'call-panel';
  // Where the stylesheet puts it: bottom right, 340 wide.
  panel.getBoundingClientRect = () => ({ left: window.innerWidth - 340, top: window.innerHeight - 400, right: window.innerWidth, bottom: window.innerHeight, width: 340, height: 400, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  root.appendChild(panel);
  dispose = render(() => <CallVideoStage panel={() => panel} cameraOff={false}
    remote={<video data-call-media="remote" class="call-video remote" />}
    self={<span data-call-self-label>You</span>} />, panel);
  return panel;
}

describe('the call video window', () => {
  it('goes full screen on the button and on a double-click, and leaves it again', async () => {
    let fullscreen: Element | null = null;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreen });
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => true });
    const request = vi.fn(async function (this: Element) { fullscreen = this; document.dispatchEvent(new Event('fullscreenchange')); });
    const exit = vi.fn(async () => { fullscreen = null; document.dispatchEvent(new Event('fullscreenchange')); });
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: request });
    Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit });
    try {
      stage();
      const button = $<HTMLButtonElement>('[data-call-fullscreen-toggle]')!;
      expect(button.getAttribute('aria-label')).toBe('Full screen');
      expect(button.getAttribute('aria-pressed')).toBe('false');
      button.click();
      await vi.waitFor(() => expect(button.getAttribute('aria-pressed')).toBe('true'));
      expect(request.mock.contexts[0]).toBe($('[data-call-stage]'));
      expect(button.getAttribute('aria-label')).toBe('Exit full screen');
      // Esc in the webview leaves full screen by itself: the window follows the event.
      fullscreen = null;
      document.dispatchEvent(new Event('fullscreenchange'));
      await vi.waitFor(() => expect(button.getAttribute('aria-pressed')).toBe('false'));
      // A double-click on their picture is the same request; on your own picture it is not.
      $('[data-call-self]')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      expect(request).toHaveBeenCalledTimes(1);
      $('[data-call-media="remote"]')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(button.getAttribute('aria-pressed')).toBe('true'));
      $('[data-call-media="remote"]')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
      expect(button.getAttribute('aria-pressed')).toBe('false');
    } finally {
      delete (HTMLElement.prototype as { requestFullscreen?: unknown }).requestFullscreen;
      delete (document as { exitFullscreen?: unknown }).exitFullscreen;
      delete (document as { fullscreenElement?: unknown }).fullscreenElement;
      delete (document as { fullscreenEnabled?: unknown }).fullscreenEnabled;
    }
  });

  it('fills the window where element full screen is refused, and Esc leaves it', async () => {
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: () => Promise.reject(new TypeError('not allowed')) });
    try {
      stage();
      const depth = escapeDepth();
      $<HTMLButtonElement>('[data-call-fullscreen-toggle]')!.click();
      await vi.waitFor(() => expect($('[data-call-stage]')!.getAttribute('data-call-fullscreen')).toBe('window'));
      expect(escapeDepth()).toBe(depth + 1);
      expect($<HTMLButtonElement>('[data-call-move]')!.hidden).toBe(true);
      key(document.body, 'Escape');
      await vi.waitFor(() => expect($('[data-call-stage]')!.hasAttribute('data-call-fullscreen')).toBe(false));
      expect(escapeDepth()).toBe(depth);
    } finally {
      delete (HTMLElement.prototype as { requestFullscreen?: unknown }).requestFullscreen;
    }
  });

  it('moves and resizes the call window with the keyboard, within the window, and resets after the call', () => {
    const panel = stage();
    const move = $('[data-call-move]')!;
    key(move, 'ArrowLeft');
    key(move, 'ArrowUp');
    expect(panel.style.right).toBe('24px');
    expect(panel.style.bottom).toBe('24px');
    for (let i = 0; i < 1000; i++) key(move, 'ArrowRight');
    expect(panel.style.right).toBe('0px');
    const size = $('[data-call-resize]')!;
    expect(size.getAttribute('role')).toBe('slider');
    key(size, 'ArrowLeft');
    expect(parseFloat(panel.style.width)).toBeGreaterThan(340);
    expect(size.getAttribute('aria-valuenow')).toBe(String(parseFloat(panel.style.width)));
    // Never wider than 70% of the window: the chat stays usable beside it.
    for (let i = 0; i < 100; i++) key(size, 'ArrowLeft');
    expect(parseFloat(panel.style.width)).toBe(maxPanelWidth(window.innerWidth));
    expect(parseFloat(panel.style.width)).toBeLessThanOrEqual(Math.max(280, window.innerWidth * 0.7));
    dispose!();
    dispose = null;
    expect(panel.style.width).toBe('');
    expect(panel.style.right).toBe('');
    expect(panel.hasAttribute('data-call-window-moved')).toBe(false);
  });

  it('moves the call window by dragging its handle', () => {
    const panel = stage();
    const move = $('[data-call-move]')!;
    move.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 500, clientY: 500, button: 0 }));
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 400, clientY: 450 }));
    window.dispatchEvent(new MouseEvent('pointerup', {}));
    expect(panel.style.right).toBe('100px');
    expect(panel.style.bottom).toBe('50px');
  });

  it('moves your own picture between corners with the keyboard', () => {
    stage();
    const self = $('[data-call-self]')!;
    expect(self.getAttribute('data-corner')).toBe('br');
    expect(self.getAttribute('tabindex')).toBe('0');
    key(self, 'ArrowLeft');
    expect(self.getAttribute('data-corner')).toBe('bl');
    key(self, 'ArrowUp');
    expect(self.getAttribute('data-corner')).toBe('tl');
    key(self, 'Enter');
    expect(self.getAttribute('data-corner')).toBe('tr');
  });

  it('names every control in Danish too', () => {
    setLanguagePref('da');
    stage();
    expect($('[data-call-fullscreen-toggle]')!.getAttribute('aria-label')).toBe('Fuld skærm');
    expect($('[data-call-move]')!.getAttribute('aria-label')).toBe('Flyt opkaldsvinduet (piletaster)');
    expect($('[data-call-resize]')!.getAttribute('aria-label')).toBe('Opkaldsvinduets størrelse (piletaster)');
    expect($('[data-call-self]')!.getAttribute('aria-label')).toBe('Dit billede: tryk for at flytte det til et andet hjørne');
    expect($('[data-call-stage]')!.getAttribute('aria-label')).toMatch(/Dobbeltklik for fuld skærm/);
  });
});

describe('the outgoing ringback', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function fakeContext() {
    const oscillators: { frequency: { value: number }; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn> }[] = [];
    const param = () => ({ setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() });
    const ctx = {
      currentTime: 0,
      destination: {},
      createOscillator: vi.fn(() => { const o = { frequency: { value: 0 }, start: vi.fn(), stop: vi.fn(), connect: vi.fn() }; oscillators.push(o); return o; }),
      createGain: vi.fn(() => ({ gain: param(), connect: vi.fn() })),
      resume: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    return { ctx, oscillators };
  }
  const outgoing = (phase: CallView['phase']): CallView => ({ ...IDLE, phase, outgoing: true, peer: 'a'.repeat(64), callId: '0'.repeat(32) });

  it('rings softly while their side rings, and stops on connect', async () => {
    const { ctx, oscillators } = fakeContext();
    const [view, setView] = createSignal<CallView>(outgoing('calling'));
    dispose = render(() => <OutgoingRingback view={view()} audioContext={() => ctx as never} />, root);
    // Calling (the offer not taken yet): no ringback.
    expect(oscillators).toHaveLength(0);
    setView(outgoing('ringing'));
    expect(oscillators).toHaveLength(1);
    expect(oscillators[0].frequency.value).toBe(RINGBACK_HZ);
    await vi.advanceTimersByTimeAsync(RINGBACK_PERIOD_MS * 2);
    expect(oscillators).toHaveLength(3);
    setView(outgoing('connecting'));
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RINGBACK_PERIOD_MS * 3);
    expect(oscillators).toHaveLength(3);
  });

  it.each(['ended', 'idle', 'live'] as const)('stops when the call goes %s (end, cancel, timeout)', async (phase) => {
    const { ctx, oscillators } = fakeContext();
    const [view, setView] = createSignal<CallView>(outgoing('ringing'));
    dispose = render(() => <OutgoingRingback view={view()} audioContext={() => ctx as never} />, root);
    expect(oscillators).toHaveLength(1);
    setView(phase === 'idle' ? IDLE : { ...outgoing(phase), reason: phase === 'ended' ? 'timeout' : null });
    await vi.advanceTimersByTimeAsync(RINGBACK_PERIOD_MS * 3);
    expect(oscillators).toHaveLength(1);
    expect(ctx.close).toHaveBeenCalled();
  });

  it('never rings for an incoming call, and a webview without audio stays silent', async () => {
    const { ctx, oscillators } = fakeContext();
    dispose = render(() => <OutgoingRingback view={{ ...outgoing('ringing'), outgoing: false }} audioContext={() => ctx as never} />, root);
    expect(oscillators).toHaveLength(0);
    dispose();
    const refused = { ...fakeContext().ctx, resume: vi.fn(async () => { throw new DOMException('autoplay', 'NotAllowedError'); }) };
    expect(() => { dispose = render(() => <OutgoingRingback view={outgoing('ringing')} audioContext={() => refused as never} />, root); }).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    dispose!();
    expect(() => { dispose = render(() => <OutgoingRingback view={outgoing('ringing')} audioContext={() => { throw new Error('no audio'); }} />, root); }).not.toThrow();
  });
});

describe('the microphone access screen', () => {
  it('says plainly, in both languages, how to give access, and that nothing was sent or paid', () => {
    dispose = render(() => <MicAccessNote media="audio" />, root);
    expect($('[data-call-permission-title]')!.textContent).toBe('Give BitSov access to the microphone');
    expect($('[data-call-permission-nothing]')!.textContent).toBe('Nothing was sent or paid.');
    expect($('[data-call-permission]')!.getAttribute('role')).toBe('alert');
    dispose();
    setLanguagePref('da');
    dispose = render(() => <MicAccessNote media="video" />, root);
    expect($('[data-call-permission-title]')!.textContent).toBe('Giv BitSov adgang til mikrofonen og kameraet');
    expect($('[data-call-permission-steps]')!.textContent).toMatch(/slå Mikrofon og Kamera til for BitSov/);
    expect($('[data-call-permission-nothing]')!.textContent).toBe('Intet blev sendt eller betalt.');
  });

  it('opens the settings where the platform has a fixed way there', async () => {
    const open = vi.fn(async () => {});
    dispose = render(() => <MicAccessNote media="audio" openSettings={open} />, root);
    $<HTMLButtonElement>('[data-call-permission-open]')!.click();
    expect(open).toHaveBeenCalledTimes(1);
    expect($('[data-call-permission-open]')!.textContent).toBe('Open Settings');
  });
});
