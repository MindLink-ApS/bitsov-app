import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';
import { visibleBackDestination } from '../src/ios/edgeBack';
import type { LiveEvent } from '../src/control/types';
import { setLanguagePref } from '../src/i18n';
let dispose: (() => void) | undefined;
const tick = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const click = async (selector: string) => {
  const button = document.querySelector<HTMLButtonElement>(selector);
  expect(button, selector).not.toBeNull(); button!.click(); await tick();
};
const visible = (selector: string) => [...document.querySelectorAll(selector)].filter(el => !el.closest('[hidden], [inert], [aria-hidden="true"]'));
afterEach(() => { dispose?.(); document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals(); setLanguagePref('en'); });
async function mount({ platform = 'iPhone', narrow = true, history = false, oldHistory = false, live = true } = {}) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(platform);
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: narrow, media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  const source = sampleSource();
  let emit: (event: LiveEvent) => void = () => {};
  source.onLive = async handler => { emit = handler; return () => {}; };
  const overview = source.nodeOverview;
  source.nodeOverview = async () => { const value = await overview(); return { ...value, capabilities: [...(value.capabilities ?? []), 'room_binding_v1', 'starter_channel_request_v1'], network: 'signet' }; };
  const messages = source.messages;
  source.messages = async (id, before) => (history || (oldHistory && before !== undefined)) ? [{ id: 'past-call', sender: id, recipient: SAMPLE_OWN_ID, kind: 400, plaintext: '{}', timestamp: 1000, payment_amount_msat: 1000 }, ...await messages(id, before)] : (await messages(id, before)).filter(m => m.kind < 400 || m.kind > 403);
  dispose = render(() => <ControlCenter source={source} active ready live={live} error={null} ownId={SAMPLE_OWN_ID} firstRun={null} />, document.body);
  await tick();
  return { emit };
}
it.each(['iPhone', 'Android'])('starts %s on Chats, pushes a conversation and returns through the existing edge Back destination', async platform => {
  await mount({ platform });
  expect(visible('[data-phone-tabs] button').map(el => el.textContent)).toEqual(['Chats', 'Wallet', 'You']);
  expect(visible('[data-composer]')).toHaveLength(0);
  expect(visibleBackDestination()).toBeNull();
  await click('[data-phone-list] [data-track^="peer:"]');
  expect(visible('[data-composer]')).toHaveLength(1);
  expect(visibleBackDestination()?.route).toBe('thread');
  visibleBackDestination()!.back(); await tick();
  expect(visible('[data-phone-list]')).toHaveLength(1);
  expect(visible('[data-composer]')).toHaveLength(0);
});
it('routes Wallet and You, retaining funding, sharing, settings, devices and every rail destination', async () => {
  await mount();
  for (const selector of ['[data-track="discover"]', '[data-track="porch"]', '[data-assistants]', '[data-room-new]', '[data-track="new"]']) expect(visible(selector).length, selector).toBeGreaterThan(0);
  await click('[data-phone-tab="wallet"]');
  expect(visible('[data-wallet-page]')).toHaveLength(1);
  expect(visible('[data-phone-status]')).toHaveLength(1);
  await click('[data-phone-add-sats]');
  expect(visible('[data-wallet-receive]')).toHaveLength(1);
  await click('[data-phone-tab="you"]');
  expect(visible('[data-phone-you]')).toHaveLength(1);
  expect(visible('[data-wallet-page]')).toHaveLength(0);
  await click('[data-phone-share]');
  expect(document.querySelector('[data-tab="frontdoor"]')?.getAttribute('aria-selected')).toBe('true');
  await click('[data-settings-close]');
  await click('[data-phone-settings]');
  expect(visible('[data-settings]')).toHaveLength(1);
  await click('[data-settings-close]');
  await click('[data-phone-devices]');
  expect(document.querySelector('[data-tab="devices"]')?.getAttribute('aria-selected')).toBe('true');
});
it('only adds Calls when read history contains a call and opens its conversation without calling', async () => {
  await mount({ history: true });
  expect(visible('[data-phone-tabs] button').map(el => el.textContent)).toEqual(['Chats', 'Calls', 'Wallet', 'You']);
  await click('[data-phone-tab="calls"]');
  expect(visible('[data-phone-calls]')).toHaveLength(1);
  await click('[data-phone-calls] button');
  expect(visible('[data-composer]')).toHaveLength(1);
});
it('keeps connection status and the money-blocked notice visible on every phone tab', async () => {
  await mount({ live: false });
  for (const tab of ['chats', 'wallet', 'you']) {
    await click(`[data-phone-tab="${tab}"]`);
    expect(visible('[data-phone-status]')).toHaveLength(1);
    expect(visible('[data-money-notice]')).toHaveLength(1);
  }
});
it.each([{ platform: 'Macintosh', narrow: true }, { platform: 'iPhone', narrow: false }])('preserves the existing shell for $platform at narrow=$narrow', async options => {
  await mount(options);
  expect(document.querySelector('[data-phone-tabs]')).toBeNull();
  expect(visible('[data-composer]')).toHaveLength(1);
});
it('uses Danish copy for phone navigation', async () => {
  setLanguagePref('da'); await mount();
  expect(visible('[data-phone-tabs] button').map(el => el.textContent)).toEqual(['Chats', 'Tegnebog', 'Dig']);
});
it('returns from Wallet on Escape without leaving a blank Wallet tab', async () => {
  await mount(); await click('[data-phone-tab="wallet"]');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick();
  expect(visible('[data-phone-list]')).toHaveLength(1);
  expect(document.querySelector('[data-phone-tab="chats"]')?.getAttribute('aria-current')).toBe('page');
});
it('keeps a phone money panel above navigation until it closes', async () => {
  await mount(); await click('[data-phone-list] [data-track^="peer:"]');
  const panel = document.createElement('div'); panel.setAttribute('data-composer-panel', 'pay');
  document.querySelector('[data-composer]')!.append(panel);
  await tick();
  await click('[data-phone-tab="you"]');
  expect(visible('[data-composer-panel="pay"]')).toHaveLength(1);
  expect(visible('[data-phone-you]')).toHaveLength(0);
  panel.remove(); await tick(); await click('[data-phone-tab="you"]');
  expect(visible('[data-phone-you]')).toHaveLength(1);
});

it('counts incoming messages as unread while their conversation is behind another tab', async () => {
  const { emit } = await mount();
  const button = document.querySelector<HTMLButtonElement>('[data-phone-list] [data-track^="peer:"]')!;
  const peer = button.dataset.track!.slice(5);
  button.click(); await tick(); await click('[data-phone-tab="you"]');
  emit({ type: 'message', room_id: null, message: { id: 'background-message', sender: peer, recipient: SAMPLE_OWN_ID, kind: 0, plaintext: 'New while on You', timestamp: Date.now(), payment_amount_msat: 1000 } });
  await tick();
  expect(button.querySelector('.badge')?.textContent).toBe('1');
  await click('[data-phone-tab="chats"]');
  expect(button.querySelector('.badge')).toBeNull();
});

it('discovers call history older than the newest message page', async () => {
  await mount({ oldHistory: true });
  expect(visible('[data-phone-tab="calls"]')).toHaveLength(1);
});
it.each(['data-first-spend-scrim', 'data-owner-approval-sheet', 'data-starter-balance'])('keeps edge Back and the tabs behind %s', async attribute => {
  await mount(); await click('[data-phone-list] [data-track^="peer:"]');
  const sheet = document.createElement('div'); sheet.setAttribute(attribute, ''); document.body.append(sheet); await tick();
  expect(visibleBackDestination()).toBeNull();
  await click('[data-phone-tab="you"]');
  expect(visible('[data-phone-you]')).toHaveLength(0);
  sheet.remove(); await tick();
  expect(visibleBackDestination()?.route).toBe('thread');
});
