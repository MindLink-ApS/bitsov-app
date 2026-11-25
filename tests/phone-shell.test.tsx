import { afterEach, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
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
afterEach(() => { dispose?.(); document.body.innerHTML = ''; FakePc.made = []; vi.restoreAllMocks(); vi.unstubAllGlobals(); setLanguagePref('en'); });
class FakePc {
  static made: FakePc[] = [];
  iceGatheringState = 'complete';
  connectionState = 'new';
  iceConnectionState = 'new';
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  localDescription: { type: string; sdp: string } | null = null;
  async createOffer() { return { type: 'offer', sdp: 'v=0 offer' }; }
  async createAnswer() { return { type: 'answer', sdp: 'v=0 answer' }; }
  async setLocalDescription(d: { type: string; sdp: string }) { this.localDescription = d; }
  async setRemoteDescription() {}
  async addIceCandidate() {}
  addTrack() { return { replaceTrack: async () => {} }; }
  addEventListener() {}
  removeEventListener() {}
  close() {}
  connect() { this.connectionState = 'connected'; this.onconnectionstatechange?.(); }
  constructor() { FakePc.made.push(this); }
}

async function mount({ platform = 'iPhone', narrow = true, history = false, oldHistory = false, live = true, offline = false, repair = false, peersError = false } = {}) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(platform);
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  vi.stubGlobal('RTCPeerConnection', FakePc);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] }) } });
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: narrow, media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  const source = sampleSource({ firstLiveMs: 1e9 });
  let emit: (event: LiveEvent) => void = () => {};
  source.onLive = async handler => { emit = handler; return () => {}; };
  const overview = source.nodeOverview;
  source.nodeOverview = async () => { const value = await overview(); return { ...value, capabilities: [...(value.capabilities ?? []), 'front_door_v1', 'room_binding_v1', 'starter_channel_request_v1'], network: 'signet' }; };
  const [connected, setConnected] = createSignal(live);
  const reconnect = vi.fn();
  if (peersError) source.peers = async () => { throw new Error('Contacts unavailable'); };
  if (repair) source.opList = async () => ({ operations: [], skipped: 0, has_more: false, unresolved_calls: [{ index_id: 'c'.repeat(64), acknowledged: false, hangup_cap_msat: 5000 }] });
  const messages = source.messages;
  source.messages = vi.fn(async (id, before) => (history || (oldHistory && before !== undefined)) ? [{ id: 'past-call', sender: id, recipient: SAMPLE_OWN_ID, kind: 400, plaintext: '{}', timestamp: 1000, payment_amount_msat: 1000 }, ...await messages(id, before)] : (await messages(id, before)).filter(m => m.kind < 400 || m.kind > 403));
  dispose = render(() => <ControlCenter source={source} active ready live={connected()} offline={offline ? <OfflineNode remote onRetry={reconnect} /> : undefined} onReconnect={reconnect} error={null} ownId={SAMPLE_OWN_ID} firstRun={null} />, document.body);
  await tick();
  return { emit, setConnected, source, reconnect };
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
it('returns to the live call from Wallet when the on-call pill is tapped', async () => {
  const receipt = { message_id: 'm1', kind: 401, amount_msat: 10_000, total_msat: 15_000, max_routing_fee_msat: 5_000, delivered: true, accepted: true, sent_at_ms: 0 };
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone');
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  vi.stubGlobal('RTCPeerConnection', FakePc);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] }) } });
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  const source = sampleSource();
  const pairing = await source.pairingStatus();
  source.pairingStatus = async () => ({ ...pairing, scopes: [...pairing.scopes, 'spend'] });
  source.spendStatus = async () => ({ state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 600_000, pending: null, window_ms: 600_000 });
  const signal = vi.spyOn(source, 'callSignal').mockResolvedValue(receipt);
  let emit: (event: LiveEvent) => void = () => {};
  source.onLive = async handler => { emit = handler; return () => {}; };
  dispose = render(() => <ControlCenter source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={null} />, document.body);
  await tick();
  const peer = (await source.peers())[0].node_id;
  await click('[data-phone-list] [data-track^="peer:"]');
  emit({ type: 'message', room_id: null, message: {
    id: 'phone-pill-offer', kind: 400, sender: peer, recipient: SAMPLE_OWN_ID,
    timestamp: Date.now(), payment_amount_msat: 10_000,
    plaintext: JSON.stringify({ v: 1, call_id: '0123456789abcdef0123456789abcdef', media: 'audio', sdp: 'v=0 offer' }),
  } });
  await vi.waitFor(() => expect(document.querySelector('[data-call-panel="incoming"]')).not.toBeNull());
  // Accept stays off until the call price has been read (main's Accept flow).
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-call-accept]')?.disabled).toBe(false));
  await click('[data-call-accept]');
  await vi.waitFor(() => expect(signal).toHaveBeenCalled());
  await vi.waitFor(() => expect(document.querySelector('[data-on-call], [data-call-panel="connecting"], [data-call-panel="live"]')).not.toBeNull());
  expect(document.querySelector('[data-phone-status]')?.hasAttribute('inert')).toBe(false);
  await click('[data-phone-tab="wallet"]');
  expect(visible('[data-wallet-page]')).toHaveLength(1);
  await click('[data-on-call]');
  expect(visible('[data-composer]')).toHaveLength(1);
});

it('shows disabled hints for Share and Add sats when the node cannot offer them yet', async () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone');
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  const source = sampleSource({ firstLiveMs: 1e9 });
  const overview = source.nodeOverview;
  source.nodeOverview = async () => {
    const value = await overview();
    return { ...value, capabilities: (value.capabilities ?? []).filter(c => c !== 'front_door_v1'), money_ready: false };
  };
  dispose = render(() => <ControlCenter source={source} active ready live error={null} ownId={SAMPLE_OWN_ID} firstRun={null} />, document.body);
  await tick();
  await click('[data-phone-tab="you"]');
  expect(document.querySelector('[data-phone-share]')?.hasAttribute('disabled')).toBe(true);
  expect(document.querySelector('[data-phone-you] .hint')?.textContent).toBe('Profile cards are not available on this node yet.');
  await click('[data-phone-tab="wallet"]');
  expect(document.querySelector('[data-phone-add-sats]')?.hasAttribute('disabled')).toBe(true);
  expect(document.querySelector('[data-wallet-page] .hint')?.textContent).toBe('Your node’s wallet is not ready yet.');
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
it.each([[744, true], [767, true], [768, false], [1024, false]])('an iPad window %ipx wide uses the phone tabs: %s', async (width, tabs) => {
  // The real query, answered for this window width: tablets split from 768 px on.
  const answer = (query: string) => { const m = /max-width:\s*(\d+)px/.exec(query); return m ? width <= Number(m[1]) : false; };
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPad');
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: answer(query), media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
  const { createRoot } = await import('solid-js');
  const { createPhoneLayout } = await import('../src/control/PhoneShell');
  createRoot((done) => { expect(createPhoneLayout()()).toBe(tabs); done(); });
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
