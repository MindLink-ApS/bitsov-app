import { afterEach, expect, it, vi } from 'vitest';
import { createSignal, Show } from 'solid-js';
import { OfflineNode } from '../src/control/OfflineNode';
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
afterEach(() => { dispose?.(); document.body.innerHTML = ''; delete document.documentElement.dataset.keyboardOpen; vi.restoreAllMocks(); vi.unstubAllGlobals(); setLanguagePref('en'); });
async function mount({ platform = 'iPhone', narrow = true, history = false, oldHistory = false, live = true, offline = false, repair = false, peersError = false } = {}) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(platform);
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: narrow, media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  const source = sampleSource();
  let emit: (event: LiveEvent) => void = () => {};
  source.onLive = async handler => { emit = handler; return () => {}; };
  const overview = source.nodeOverview;
  source.nodeOverview = async () => { const value = await overview(); return { ...value, capabilities: [...(value.capabilities ?? []), 'room_binding_v1', 'starter_channel_request_v1'], network: 'signet' }; };
  const [connected, setConnected] = createSignal(live);
  const [disconnected, setDisconnected] = createSignal(offline);
  const reconnect = vi.fn();
  if (peersError) source.peers = async () => { throw new Error('Contacts unavailable'); };
  if (repair) source.opList = async () => ({ operations: [], skipped: 0, has_more: false, unresolved_calls: [{ index_id: 'c'.repeat(64), acknowledged: false, hangup_cap_msat: 5000 }] });
  const messages = source.messages;
  source.messages = vi.fn(async (id, before) => (history || (oldHistory && before !== undefined)) ? [{ id: 'past-call', sender: id, recipient: SAMPLE_OWN_ID, kind: 400, plaintext: '{}', timestamp: 1000, payment_amount_msat: 1000 }, ...await messages(id, before)] : (await messages(id, before)).filter(m => m.kind < 400 || m.kind > 403));
  dispose = render(() => <ControlCenter source={source} active ready live={connected()} offline={compact => <Show when={disconnected()}><OfflineNode compact={compact} remote onRetry={reconnect} /></Show>} onReconnect={reconnect} error={null} ownId={SAMPLE_OWN_ID} firstRun={null} />, document.body);
  await tick();
  return { emit, setConnected, setDisconnected, source, reconnect };
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
it.each([{ platform: 'Macintosh', narrow: true }, { platform: 'iPad', narrow: false }])('preserves the existing shell for $platform at narrow=$narrow', async options => {
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

it('shows offline Retry on the phone landing list', async () => {
  const { reconnect } = await mount({ offline: true, live: false });
  expect(visible('[data-phone-list]')).toHaveLength(1);
  expect(visible('[data-node-offline] button')).toHaveLength(1);
  await click('[data-node-offline] button');
  expect(reconnect).toHaveBeenCalledOnce();
});
it.each(['iPhone', 'Android'])('keeps the %s composer mounted through disconnect and keyboard dismissal, with recovery in a sheet', async platform => {
  const { setConnected, setDisconnected, reconnect } = await mount({ platform });
  await click('[data-phone-list] [data-track^="peer:"]');
  const composer = document.querySelector('[data-composer]')!;
  const input = composer.querySelector('textarea')!;
  input.value = 'Unsent draft';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
  document.documentElement.dataset.keyboardOpen = 'true';
  setConnected(false); setDisconnected(true); await tick();

  for (const keyboardOpen of ['true', 'false']) {
    document.documentElement.dataset.keyboardOpen = keyboardOpen;
    await tick();
    expect(visible('[data-composer]')).toEqual([composer]);
    expect(input.value).toBe('Unsent draft');
    expect(input.getAttribute('aria-label')).toMatch(/Message/);
    expect(visible('[data-node-offline]')).toHaveLength(0);
    expect(visible('.track [data-offline-banner]')).toHaveLength(1);
  }
  const banner = document.querySelector<HTMLButtonElement>('[data-offline-banner]')!;
  expect(banner.textContent).toContain('Your node is offline');
  expect(banner.textContent).toContain('Retry now');
  expect(banner.getAttribute('aria-haspopup')).toBe('dialog');
  banner.focus(); banner.click(); await tick();
  const sheet = document.querySelector('dialog[open][data-offline-sheet]');
  expect(sheet).not.toBeNull();
  expect(sheet?.querySelector('[data-node-offline]')).not.toBeNull();
  expect(document.querySelector('[data-composer]')).toBe(composer);
  expect(visibleBackDestination()).toBeNull();
  await click('[data-offline-sheet] [data-node-offline] button');
  expect(reconnect).toHaveBeenCalledOnce();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick();
  expect(document.querySelector('[data-offline-sheet]')).toBeNull();
  expect(document.activeElement).toBe(banner);
  expect(visible('[data-composer]')).toEqual([composer]);
  expect(input.value).toBe('Unsent draft');

  await click('[data-phone-tab="wallet"]');
  expect(visible('[data-phone-status] [data-node-offline]')).toHaveLength(1);
  expect(visible('[data-offline-banner]')).toHaveLength(0);
  await click('[data-phone-tab="chats"]');
  expect(visible('[data-composer]')).toEqual([composer]);
  expect(input.value).toBe('Unsent draft');
  expect(visible('.track [data-offline-banner]')).toHaveLength(1);
  await click('[data-ios-back="thread"]');
  expect(visible('[data-phone-status] [data-node-offline]')).toHaveLength(1);
  expect(visible('[data-offline-banner]')).toHaveLength(0);
  await click('[data-phone-list] [data-track="discover"]');
  expect(visible('[data-phone-status] [data-node-offline]')).toHaveLength(1);
});

it('removes the recovery sheet when the node reconnects without replacing the composer', async () => {
  const { setConnected, setDisconnected } = await mount({ offline: true, live: false });
  await click('[data-phone-list] [data-track^="peer:"]');
  const composer = document.querySelector('[data-composer]');
  await click('[data-offline-banner]');
  expect(document.querySelector('dialog[open][data-offline-sheet]')).not.toBeNull();
  setConnected(true); setDisconnected(false); await tick();
  expect(document.querySelector('[data-offline-sheet]')).toBeNull();
  expect(document.querySelector('[data-offline-banner]')).toBeNull();
  expect(visible('[data-composer]')).toEqual([composer]);
});
it('keeps recovery usable and focus contained without native modal dialog support', async () => {
  // Happy DOM exposes these methods through getters; model an older WebKit.
  const dialogPrototype = HTMLDialogElement.prototype as unknown as { showModal: undefined; close: undefined };
  vi.spyOn(dialogPrototype, 'showModal', 'get').mockReturnValue(undefined);
  vi.spyOn(dialogPrototype, 'close', 'get').mockReturnValue(undefined);
  await mount({ offline: true, live: false });
  await click('[data-phone-list] [data-track^="peer:"]');
  const composer = document.querySelector('[data-composer]');
  await click('[data-offline-banner]');
  const sheet = document.querySelector<HTMLElement>('[data-offline-sheet][role="dialog"][aria-modal="true"]')!;
  expect(sheet).not.toBeNull();
  const buttons = [...sheet.querySelectorAll<HTMLButtonElement>('button')];
  expect(document.activeElement).toBe(buttons[0]);
  buttons[buttons.length - 1].focus();
  buttons[buttons.length - 1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(buttons[0]);
  document.querySelector<HTMLTextAreaElement>('[data-composer] textarea')!.focus();
  expect(sheet.contains(document.activeElement)).toBe(true);
  await click('[data-phone-tab="you"]');
  expect(visible('[data-phone-you]')).toHaveLength(0);
  buttons[0].click(); await tick();
  expect(document.querySelector('[data-offline-sheet]')).toBeNull();
  expect(visible('[data-composer]')).toEqual([composer]);
  expect(document.activeElement).toBe(document.querySelector('[data-offline-banner]'));
});
it('shows unresolved call repair rows on the phone landing list', async () => {
  await mount({ repair: true });
  expect(visible('[data-call-repairs]')).toHaveLength(1);
  expect(visible('[data-call-repairs]')[0].textContent).toContain('Repair and end');
});
it('shows contacts failure and Reconnect instead of an empty contacts list', async () => {
  const { reconnect } = await mount({ peersError: true });
  expect(visible('[data-phone-list] [data-soft-summary]')[0]?.textContent).toBe('We could not load your contacts.');
  expect(document.querySelector('[data-phone-list]')?.textContent).not.toContain('No contacts yet');
  await click('[data-phone-list] [data-soft-reconnect]');
  expect(reconnect).toHaveBeenCalledOnce();
});
it('tapping the current Chats tab returns to the list', async () => {
  await mount(); await click('[data-phone-list] [data-track^="peer:"]');
  await click('[data-phone-tab="chats"]');
  expect(visible('[data-phone-list]')).toHaveLength(1);
  expect(visible('[data-composer]')).toHaveLength(0);
});
it('keeps the phone shell on a landscape iPhone wider than 680px', async () => {
  await mount({ platform: 'iPhone', narrow: false });
  expect(visible('[data-phone-tabs]')).toHaveLength(1);
  expect(document.querySelector('.rail')).toBeNull();
});
it.each([
  ['data-approval', 'pending'], ['data-phone-onboarding', 'words'], ['data-phone-onboarding', 'fingerprint'],
  ['data-ai-card', 'disclosure'], ['role', 'dialog'],
])('blocks tabs and edge Back for %s=%s', async (attribute, value) => {
  await mount(); await click('[data-phone-list] [data-track^="peer:"]');
  const sheet = document.createElement('div'); sheet.setAttribute(attribute, value);
  sheet.setAttribute('data-state', 'preview'); document.body.append(sheet); await tick();
  expect(visibleBackDestination()).toBeNull();
  await click('[data-phone-tab="you"]');
  expect(visible('[data-phone-you]')).toHaveLength(0);
  sheet.remove(); await tick();
  expect(visibleBackDestination()?.route).toBe('thread');
});
it('stops the startup has-call check at the first match and reuses it after reconnect', async () => {
  const { source, setConnected } = await mount({ history: true });
  expect(source.messages).toHaveBeenCalledTimes(1);
  setConnected(false); await tick(); setConnected(true); await tick();
  expect(visible('[data-phone-tab="calls"]')).toHaveLength(1);
  expect(source.messages).toHaveBeenCalledTimes(1);
});
it('caches a no-call result across reconnects and updates it on a new call event', async () => {
  const { source, setConnected, emit } = await mount();
  const reads = vi.mocked(source.messages).mock.calls.length;
  setConnected(false); await tick(); setConnected(true); await tick();
  expect(source.messages).toHaveBeenCalledTimes(reads);
  expect(visible('[data-phone-tab="calls"]')).toHaveLength(0);
  emit({ type: 'message', room_id: null, message: { id: 'call-event', sender: 'a'.repeat(66), recipient: SAMPLE_OWN_ID, kind: 403, plaintext: '{}', timestamp: Date.now(), payment_amount_msat: 1000 } }); await tick();
  expect(visible('[data-phone-tab="calls"]')).toHaveLength(1);
  expect(source.messages).toHaveBeenCalledTimes(reads);
});

it('finds a call missed during a link gap without rescanning old negative history', async () => {
  const { source, emit } = await mount();
  const messages = source.messages;
  const peer = (await source.peers())[0].node_id;
  emit({ type: 'link', state: 'closed', detail: null }); await tick();
  source.messages = vi.fn(async (id, before) => id === peer && before === undefined
    ? [{ id: 'missed-call', sender: peer, recipient: SAMPLE_OWN_ID, kind: 403, plaintext: '{}', timestamp: Date.now(), payment_amount_msat: 1000 }]
    : messages(id, before));
  emit({ type: 'link', state: 'open', detail: null }); await tick();
  expect(visible('[data-phone-tab="calls"]')).toHaveLength(1);
  expect(source.messages).toHaveBeenCalledTimes(1);
});
it('only checks the newest page of unchanged negative history after a link gap', async () => {
  const { source, emit } = await mount();
  vi.mocked(source.messages).mockClear();
  emit({ type: 'link', state: 'closed', detail: null }); await tick();
  emit({ type: 'link', state: 'open', detail: null }); await tick();
  expect(visible('[data-phone-tab="calls"]')).toHaveLength(0);
  expect(vi.mocked(source.messages).mock.calls.length).toBe((await source.peers()).length);
  expect(vi.mocked(source.messages).mock.calls.every(([, before]) => before === undefined)).toBe(true);
});
