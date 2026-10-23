import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';
import { installEdgeBack, visibleBackDestination } from '../src/ios/edgeBack';
let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const click = (selector: string) => document.querySelector<HTMLButtonElement>(selector)!.click();
async function mount() {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone');
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  // happy-dom has no layout; visible/hidden state still comes from real component attributes.
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  dispose = render(() => <ControlCenter source={sampleSource()} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={null} />, document.body);
  await tick();
}
it('uses the real thread Back button and returns to the contact list', async () => {
  await mount();
  expect(document.querySelector('[data-composer]')).not.toBeNull();
  expect(visibleBackDestination()?.route).toBe('thread');
  visibleBackDestination()!.back(); await tick();
  expect(document.querySelector('[data-composer]')).toBeNull();
  expect(document.querySelectorAll('[data-chat-list] button').length).toBeGreaterThan(0);
  click('[data-chat-list] button'); await tick();
  expect(document.querySelector('[data-composer]')).not.toBeNull();
  visibleBackDestination()!.back(); await tick();
  expect(visibleBackDestination()).toBeNull();
});
it('takes a settings sub-page to settings before closing settings', async () => {
  await mount(); click('[data-tab="general"]'); await tick();
  expect(visibleBackDestination()?.route).toBe('settings-page');
  visibleBackDestination()!.back(); await tick();
  expect(document.querySelector('[data-tab="body"]')?.getAttribute('aria-selected')).toBe('true');
  expect(visibleBackDestination()?.route).toBe('settings');
  visibleBackDestination()!.back(); await tick();
  expect(document.querySelector('[data-settings]')?.getAttribute('aria-hidden')).toBe('true');
});
it('blocks the underlying route for an approval, a money form, or a call arriving mid-gesture', async () => {
  await mount();
  for (const attrs of ['data-first-spend-scrim', 'data-composer-panel="pay"', 'data-swipe-call="true"', 'data-contact-approval="pending"', 'role="dialog"']) {
    const panel = document.createElement('div'); panel.innerHTML = `<section ${attrs}></section>`;
    document.body.append(panel);
    expect(visibleBackDestination()).toBeNull(); panel.remove();
  }
  expect(visibleBackDestination()?.route).toBe('thread');
});

it.each(['before', 'during'])('never navigates when an owner-approval sheet appears %s an edge swipe', async arrival => {
  await mount();
  // Exercise the explicit approval blocker without relying on the generic dialog guard.
  const sheet = document.createElement('div');
  sheet.setAttribute('data-owner-approval-sheet', 'request-a');
  const touch = (type: string, x: number) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    const point = { identifier: 1, clientX: x, clientY: 200 };
    Object.assign(event, { touches: type === 'touchend' ? [] : [point], changedTouches: [point] });
    document.dispatchEvent(event);
  };
  const stop = installEdgeBack();
  try {
    expect(visibleBackDestination()?.route).toBe('thread');
    if (arrival === 'before') document.body.append(sheet);
    touch('touchstart', 5);
    if (arrival === 'during') document.body.append(sheet);
    touch('touchmove', 80); touch('touchend', 110);
    expect(document.querySelector('[data-composer]')).not.toBeNull();
    expect(visibleBackDestination()).toBeNull();
    sheet.remove();
    touch('touchstart', 5); touch('touchmove', 80); touch('touchend', 110);
    await tick();
    expect(document.querySelector('[data-composer]')).toBeNull();
  } finally { stop(); sheet.remove(); }
});
