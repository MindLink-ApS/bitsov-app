import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createRoot, createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID, SAMPLE_PEERS } from '../src/control/sample';
import { resetContactsForTests } from '../src/control/petnames';
import { createCallQuitGuard, type ClosableWindow } from '../src/control/quitGuard';
import { shortId } from '../src/control/format';
import { copy, setLanguagePref, t } from '../src/i18n';

let dispose: (() => void) | undefined;
let mount: HTMLElement;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  mount?.remove();
  resetContactsForTests();
  vi.restoreAllMocks();
  localStorage.removeItem('bitsov.language');
  setLanguagePref('en');
});
const $ = <T extends HTMLElement = HTMLElement>(s: string) => mount.querySelector<T>(s)!;
const maya = SAMPLE_PEERS[0].node_id;

async function openMaya(source = sampleSource({ firstLiveMs: 1e9 })) {
  mount = document.createElement('div');
  document.body.appendChild(mount);
  dispose = render(() => <ControlCenter source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
  await vi.waitFor(() => expect($(`[data-track="peer:${maya}"]`)).not.toBeNull());
  $<HTMLButtonElement>(`[data-track="peer:${maya}"]`).click();
  await vi.waitFor(() => expect($('[data-contact-open]')).not.toBeNull());
  return source;
}

// P0-7: Danish OS → Danish UI, unless the owner chose a language.
it('declares Danish in the macOS bundle, so the webview can report a Danish OS language', () => {
  const plist = readFileSync(join(__dirname, '../src-tauri/Info.plist'), 'utf8');
  const localizations = plist.match(/<key>CFBundleLocalizations<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? '';
  expect(localizations).toContain('<string>da</string>');
  expect(localizations).toContain('<string>en</string>');
});

it.each([
  ['da-DK', null, 'da'],
  ['da', null, 'da'],
  ['en-US', null, 'en'],
  ['da-DK', 'en', 'en'],
  ['en-US', 'da', 'da'],
] as const)('starts on an OS reporting %s with stored choice %s in %s', async (locale, stored, expected) => {
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(locale);
  if (stored) localStorage.setItem('bitsov.language', stored);
  else localStorage.removeItem('bitsov.language');
  vi.resetModules();
  const fresh = await import('../src/i18n');
  expect(fresh.language()).toBe(expected);
});

// P1-4: no node key next to the name; it lives under Technical on the contact sheet.
it('keeps the node key out of the chat header and shows it under Technical on the contact sheet', async () => {
  await openMaya();
  const head = $('.track-head').textContent ?? '';
  expect(head).toContain('Maya');
  expect(head).not.toContain(shortId(maya));
  expect(head).not.toMatch(/[0-9a-f]{8}…[0-9a-f]{8}/);
  $<HTMLButtonElement>('[data-contact-open]').click();
  await vi.waitFor(() => expect($('[data-contact-panel="open"]')).not.toBeNull());
  expect($('[data-contact-technical] h3').textContent).toBe('Technical');
  expect($('[data-contact-node-key]').textContent).toBe(maya);
  setLanguagePref('da');
  expect($('[data-contact-technical] h3').textContent).toBe('Teknisk');
});

// P1-6: no cost line under a sent message; one tap shows it.
it('shows no cost under a sent message until it is tapped, and never says the fee is not reported', async () => {
  const source = sampleSource({ firstLiveMs: 1e9 });
  source.spendStatus = async () => ({ state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 600000, pending: null, window_ms: 600000 });
  source.priceQuote = async () => ({ kind: 0, own_msat: 9000, peer_msat: 1000, peer_age_secs: 30, peer_stale: false, max_routing_fee_msat: 5000 });
  source.send = vi.fn(async (recipient, isRoom) => ({ message_id: 'sent', recipient, is_room: isRoom, delivered: true, amount_msat: 1000, sent_at_ms: Date.now() }));
  await openMaya(source);
  const area = $<HTMLTextAreaElement>('[data-composer] textarea');
  area.value = 'hej';
  area.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.waitFor(() => expect($<HTMLButtonElement>('[data-send]').disabled).toBe(false));
  $<HTMLButtonElement>('[data-send]').click();
  await vi.waitFor(() => expect($('[data-message="sent"] .sats-meta')).not.toBeNull());
  const stamp = () => $('[data-message="sent"] .stamp').textContent ?? '';
  expect(stamp()).not.toMatch(/paid|sat|fee|not reported|not disclosed/i);
  const cost = $<HTMLButtonElement>('[data-message="sent"] .sats-meta');
  expect(cost.getAttribute('aria-label')).toBe('Show what this message cost');
  cost.click();
  expect(stamp()).toContain('paid 1 sat');
  expect(stamp()).not.toMatch(/not reported|not disclosed/);
  cost.click();
  expect(stamp()).not.toContain('paid');
});

it.each(['en', 'da'] as const)('never says a fee is "not disclosed" on a %s paid line', (locale) => {
  expect(copy[locale].uiNetworkFeeNotReported).not.toMatch(/not reported|not disclosed|ikke oplyst/);
});

// P1-9: calm and true: both boxes carry the call; nothing about a listener.
it.each([
  ['en', 'caNodeRoutedCallLabel', /your own box and theirs/],
  ['en', 'caNodeRoutedVideoLabel', /your own box and theirs/],
  ['da', 'caNodeRoutedCallLabel', /din egen boks og deres/],
  ['da', 'caNodeRoutedVideoLabel', /din egen boks og deres/],
] as const)('%s %s says the call goes through both boxes, calmly', (locale, key, both) => {
  const text = copy[locale][key];
  expect(text).toMatch(both);
  expect(text).not.toMatch(/Both boxes can|Begge bokse kan/);
  // Still true about what the two boxes can do.
  expect(text).toMatch(key === 'caNodeRoutedVideoLabel' ? /see and hear|se og høre/ : /hear|høre/);
});

// P1-19: closing the window during a live call asks first.
function fakeWindow() {
  let handler: ((event: { preventDefault(): void }) => void | Promise<void>) | null = null;
  const win: ClosableWindow & { destroyed: number; listening: () => boolean; close: () => Promise<boolean> } = {
    destroyed: 0,
    onCloseRequested: async (h) => { handler = h; return () => { handler = null; }; },
    destroy: async () => { win.destroyed += 1; },
    listening: () => handler !== null,
    // Mirrors the window API: the window closes unless the handler prevents it.
    close: async () => {
      if (!handler) { await win.destroy(); return true; }
      let prevented = false;
      await handler({ preventDefault: () => { prevented = true; } });
      if (!prevented) await win.destroy();
      return !prevented;
    },
  };
  return win;
}

it('asks "You are in a call with X" before closing during a live call, and only then', async () => {
  const win = fakeWindow();
  const [peer, setPeer] = createSignal<string | null>(null);
  await createRoot(async (stop) => {
    const guard = createCallQuitGuard(peer, () => win);
    await Promise.resolve();
    expect(win.listening()).toBe(false);
    setPeer('Maya');
    await vi.waitFor(() => expect(win.listening()).toBe(true));
    expect(await win.close()).toBe(false);
    expect(guard.asking()).toBe('Maya');
    expect(win.destroyed).toBe(0);
    guard.stay();
    expect(guard.asking()).toBeNull();
    expect(win.destroyed).toBe(0);
    await win.close();
    guard.quit();
    await vi.waitFor(() => expect(win.destroyed).toBe(1));
    setPeer(null);
    await vi.waitFor(() => expect(win.listening()).toBe(false));
    expect(await win.close()).toBe(true);
    stop();
  });
});

it.each([
  ['en', 'You are in a call with Maya. End it and quit?'],
  ['da', 'Du er i et opkald med Maya. Vil du afslutte det og lukke?'],
] as const)('says the %s quit question plainly', (locale, text) => {
  setLanguagePref(locale);
  expect(t('quitDuringCall', 'Maya')).toBe(text);
});
