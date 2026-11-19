import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createRoot, createSignal, Show } from 'solid-js';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID, SAMPLE_PEERS } from '../src/control/sample';
import { resetContactsForTests } from '../src/control/petnames';
import { createCallQuitGuard, type ClosableWindow } from '../src/control/quitGuard';
import { amount, shortId, shownTotal, shownTotalFigure } from '../src/control/format';
import { AmountWithExact } from '../src/control/ExactAmount';
import { hangupOverMessageCapCopy } from '../src/control/call';
import type { CallQuote } from '../src/control/types';
import { SettledPayment } from '../src/control/SettledPayment';
import { QuitConfirm } from '../src/control/QuitConfirm';
import { ringBudgetText } from '../src/control/ringBudget';
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
  ['en', 'You are in a call with Maya. Closing BitSov drops the call. Close anyway?'],
  ['da', 'Du er i et opkald med Maya. Hvis du lukker BitSov, afbrydes opkaldet. Luk alligevel?'],
] as const)('says the %s quit question plainly', (locale, text) => {
  setLanguagePref(locale);
  expect(t('quitDuringCall', 'Maya')).toBe(text);
});

// Review round 1: rounding direction is chosen per site; parts add up; the quit dialog is a real modal.
it.each(['en', 'da'] as const)('rounds money in down and costs up, and never hides a small receipt (%s)', (locale) => {
  setLanguagePref(locale);
  const about = locale === 'da' ? 'ca.' : 'about';
  expect(amount(1500, 'down')).toBe(`${about} 1 sat`);
  expect(amount(1999, 'down')).toBe(`${about} 1 sat`);
  expect(amount(1500, 'up')).toBe(`${about} 2 sats`);
  expect(amount(2000, 'down')).toBe('2 sats');
  expect(amount(500, 'down')).toBe(locale === 'da' ? 'under 1 sat' : 'less than 1 sat');
  expect(amount(0, 'down')).toBe('0 sats');
});

it('shows a total that its rounded parts add up to, never below the real total', () => {
  // 1 sat + up to 1.25 sats: parts 1 + about 2, total about 3.
  expect(shownTotal(2250, [1000, 1250])).toBe('about 3 sats');
  // 1.5 + 1.5: each part shows about 2, so the total shows about 4, not 3.
  expect(shownTotal(3000, [1500, 1500])).toBe('about 4 sats');
  expect(shownTotal(3000, [1000, 2000])).toBe('3 sats');
  // Parts that do not add up to the total: the total alone, rounded up.
  expect(shownTotal(3100, [1000, 2000])).toBe('about 4 sats');
});

it('shows a received amount rounded down, with the exact amount one tap away', () => {
  mount = document.createElement('div');
  document.body.appendChild(mount);
  dispose = render(() => <SettledPayment direction="received" msat={1500} />, mount);
  expect($('.settled-amount').textContent).toBe('about 1 sat');
  expect($('[data-settled-exact] summary').textContent).toBe('Details');
  expect($('[data-settled-exact]').textContent).toBe('Detailsexactly 1.5 sats');
});

it.each([
  ['en', 'Close and drop the call', /Clos(e|ing) BitSov/],
  ['da', 'Luk og afbryd opkaldet', /lukker BitSov/],
] as const)('%s quit copy says what the button does: close the app, and the call drops', (locale, button, question) => {
  setLanguagePref(locale);
  expect(t('quitCloseAndDrop')).toBe(button);
  expect(t('quitDuringCall', 'Maya')).toMatch(question);
  expect(t('quitDuringCall', 'Maya')).not.toMatch(/End it|quit\?/);
});

it.each(['en', 'da'] as const)('says an unknown fee amount truthfully and calmly in %s', (locale) => {
  for (const key of ['uiNetworkFeeNotReported', 'uiNetworkFeeNotReported502', 'extraNetworkFeeUnknown'] as const) {
    expect(copy[locale][key]).toMatch(locale === 'da' ? /beløb ukendt/ : /amount unknown/);
    expect(copy[locale][key]).not.toMatch(/not reported|not disclosed|ikke oplyst/);
  }
});

it('keeps keyboard focus inside the quit dialog and gives it back on Stay', async () => {
  mount = document.createElement('div');
  document.body.appendChild(mount);
  const [open, setOpen] = createSignal(false);
  const stay = vi.fn(() => setOpen(false));
  const close = vi.fn();
  dispose = render(() => <>
    <div data-behind><button type="button" data-opener>Hang up</button></div>
    <Show when={open()}><QuitConfirm name="Maya" onStay={stay} onClose={close} /></Show>
  </>, mount);
  $<HTMLButtonElement>('[data-opener]').focus();
  setOpen(true);
  await Promise.resolve();
  expect(document.activeElement?.hasAttribute('data-quit-stay')).toBe(true);
  expect($('[data-behind]').hasAttribute('inert')).toBe(true);
  expect($('[data-quit-confirm]').closest('[inert]')).toBeNull();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(stay).toHaveBeenCalledTimes(1);
  await Promise.resolve();
  expect($('[data-quit-confirm]')).toBeNull();
  expect($('[data-behind]').hasAttribute('inert')).toBe(false);
  expect(document.activeElement?.hasAttribute('data-opener')).toBe(true);
  expect(close).not.toHaveBeenCalled();
});

it('opens the quit question as a native modal, above a spending sheet that is already open', async () => {
  mount = document.createElement('div');
  document.body.appendChild(mount);
  const [open, setOpen] = createSignal(false);
  const stay = vi.fn(() => setOpen(false));
  dispose = render(() => <>
    <dialog data-sheet><button type="button">Allow</button></dialog>
    <Show when={open()}><QuitConfirm name="Maya" onStay={stay} onClose={vi.fn()} /></Show>
  </>, mount);
  const sheet = $<HTMLDialogElement>('[data-sheet]');
  sheet.showModal();
  setOpen(true);
  await Promise.resolve();
  const layer = $<HTMLElement>('[data-quit-layer]');
  // Only a native modal opened later than the sheet sits above it; an ordinary element stays underneath.
  expect(layer.tagName).toBe('DIALOG');
  expect((layer as HTMLDialogElement).open).toBe(true);
  expect(layer.getAttribute('role')).toBe('alertdialog');
  expect(document.activeElement?.hasAttribute('data-quit-stay')).toBe(true);
  expect(sheet.open, 'the sheet behind is left as it was').toBe(true);
  // The dialog's own cancel (Escape at the platform level) means Stay.
  layer.dispatchEvent(new Event('cancel', { cancelable: true }));
  expect(stay).toHaveBeenCalledTimes(1);
  await Promise.resolve();
  expect($('[data-quit-layer]')).toBeNull();
  expect(sheet.open).toBe(true);
  sheet.close();
});

// What is left to spend rounds down: never show more remaining than exists.
it('shows a remaining budget rounded down: 1.5 sats left is about 1, never about 2', () => {
  setLanguagePref('en');
  const text = ringBudgetText('Maya', { leftMsat: 1500, holdMsat: 3500 });
  expect(text).toContain('only about 1 sat left');
  // The hold is the most the call may cost: it still rounds up.
  expect(text).toContain('holds up to about 4 sats');
  expect(text).not.toContain('about 2');
});

it('rounds every remaining/left budget figure down at its display site', () => {
  const sources = ['Shell.tsx', 'BodyPanel.tsx', 'call.ts', 'ringBudget.tsx']
    .map((f) => readFileSync(join(__dirname, '../src/control', f), 'utf8')).join('\n');
  // A call's minutes hold (h().remaining_msat) is still held against this call: a cost ceiling, so it rounds up.
  const up = sources.match(/(?<!h\(\)\.)(remaining_msat|leftMsat|left\(\)\.(total|contact!?)|liveGrantRemaining\(\)!?)( \?\? 0)?, 'up'/g) ?? [];
  expect(up).toEqual([]);
  expect(sources.match(/(remaining_msat|leftMsat|left\(\)\.(total|contact!?)|liveGrantRemaining\(\)!?)( \?\? 0)?, 'down'/g)?.length ?? 0).toBeGreaterThanOrEqual(8);
});

// Review round 2: what is allowed or returned rounds down; room headlines add up; receipts keep exact amounts.
it('says a grant allows about 1 sat per payment (1.5 sats), never about 2, while the cost still rounds up', () => {
  setLanguagePref('en');
  const text = hangupOverMessageCapCopy({ signal_msat: 1000, signal_max_routing_fee_msat: 1000 } as CallQuote, 1500);
  expect(text).toContain('can cost up to 2 sats, more than the about 1 sat per message payment');
  expect(text).not.toContain('about 2 sats per message');
});

it('rounds returned money and existing limits, budgets and grant caps down at their display sites', () => {
  const read = (f: string) => readFileSync(join(__dirname, '../src/control', f), 'utf8');
  const sources = ['Shell.tsx', 'BodyPanel.tsx', 'call.ts', 'sample.ts'].map(read).join('\n');
  const allowed = /(released_msat|per_call_max_msat|caps\(\)\.(message|call)|perPayment|recoveryLimit|MESSAGE_PAYMENT_CAP_MSAT|messagePerPaymentMax\([^)]*\) : 0|st\(\)\.(limit|ceiling)|ceiling_msat|g\(\)\.budget_msat|limit_msat|props\.limit|purse_msat|amount\(cap|book\.ceiling|fmtAmount\((limit|ceiling))/;
  const sites = sources.split('\n').flatMap((line) => line.match(/(fmtAmount|amount)\((?:[^()]|\([^()]*\))*?, '(up|down)'/g) ?? []);
  // A new limit being approved ("raise it to …") is a cost the owner signs, so it rounds up.
  const approving = (call: string) => call.includes('Math.min(props.budget.ceiling_msat * 2');
  const wrong = sites.filter((call) => allowed.test(call) && !approving(call) && call.endsWith("'up'"));
  expect(wrong).toEqual([]);
  expect(sites.filter((call) => allowed.test(call)).length).toBeGreaterThanOrEqual(20);
});

it('sums a room headline from the legs as shown: two 2.5-sat legs cost about 6, not 5', () => {
  setLanguagePref('en');
  expect(shownTotalFigure(5000, [2500, 2500], false)).toEqual({ figure: 'about 6', unit: 'sats' });
  expect(shownTotalFigure(5000, [2500, 2500], true)).toEqual({ figure: '≈ 6', unit: 'sats' });
  expect(shownTotalFigure(4000, [2000, 2000], false)).toEqual({ figure: '4', unit: 'sats' });
  const room = readFileSync(join(__dirname, '../src/control/RoomPanel.tsx'), 'utf8');
  expect(room).toContain('shownTotalFigure(total()!');
  expect(room).not.toMatch(/fmtAmount\(s\(\)\.outcomes\.reduce/);
});

it('keeps the exact amount one tap away for a rounded incoming amount or history row', () => {
  setLanguagePref('en');
  mount = document.createElement('div');
  document.body.appendChild(mount);
  dispose = render(() => <>
    <span data-a><AmountWithExact msat={1500} round="down" prefix="+" /></span>
    <span data-b><AmountWithExact msat={2000} round="down" /></span>
  </>, mount);
  expect($('[data-a] summary').textContent).toBe('+about 1 sat');
  expect($('[data-a] [data-exact-amount-value]').textContent).toBe('exactly 1.5 sats');
  expect($('[data-b]').textContent).toBe('2 sats');
  expect($('[data-b] details')).toBeNull();
  const read = (f: string) => readFileSync(join(__dirname, '../src/control', f), 'utf8');
  expect(read('WalletPage.tsx').match(/<AmountWithExact /g)?.length).toBe(4);
  expect(read('Shell.tsx')).toContain('<AmountWithExact msat={amount()} round="down" nowrap />');
});
