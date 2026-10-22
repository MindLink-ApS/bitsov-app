import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';
import { visibleBackDestination } from '../src/ios/edgeBack';
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
