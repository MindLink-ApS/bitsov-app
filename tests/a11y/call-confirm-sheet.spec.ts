import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { appDa, appEn } from '../../src/appCopy';
import { controlDa, controlEn } from '../../src/controlCopy';

// The Ring confirmation on a phone: whatever the text size and platform, the
// whole confirmation wraps inside its sheet (nothing scrolls sideways), and
// Cancel and Ring stay on screen, inside the safe area, whole and uncovered,
// at the top and at the bottom of its scroll. Measured insets as in safe-areas.spec.ts.
const raw = readFileSync('src/styles.css', 'utf8').replaceAll("url('./assets/", "url('/src/assets/");
const PHONES = [
  { width: 320, height: 568, top: 20, right: 0, bottom: 0, left: 0 },
  { width: 393, height: 852, top: 59, right: 0, bottom: 34, left: 0 },
];
type Phone = typeof PHONES[number];
// 'none' is a narrow window with no platform: the width rule alone, no insets.
const PLATFORMS = ['ios', 'android', 'none'] as const;
type Platform = typeof PLATFORMS[number];
const safe = (phone: Phone, platform: Platform) => (platform === 'none' ? { ...phone, top: 0, right: 0, bottom: 0, left: 0 } : phone);
const withInsets = (phone: Phone) => raw.replace(/env\(safe-area-inset-(top|right|bottom|left)(?:,\s*0px)?\)/g,
  (_, edge: 'top' | 'right' | 'bottom' | 'left') => `${phone[edge]}px`);
const fill = (s: string, ...args: string[]) => args.reduce((out, a, i) => out.replaceAll(`{${i}}`, a), s);

// The node-routed confirmation as the app builds it (CallButtons + MinutesConsent), in the app's own words.
function confirmation(lang: 'en' | 'da') {
  const app = lang === 'en' ? appEn : appDa;
  const control = lang === 'en' ? controlEn : controlDa;
  const amount = (n: string) => `${n} sats`;
  return `<div class="call-confirm" role="dialog" data-call-confirm-box="audio">
    <p class="call-confirm-text"><strong>${app.uiCall} Robin?</strong> <span class="hint">${app.uiUpTo105} ${amount('21')}${app.uiNothingIsPaidUntilYouPressRing}</span></p>
    <p class="hint" data-call-minute-price>${fill(control.uiCallMinutePrice, amount('10'), amount('5'))}</p>
    <p class="hint" data-call-reservation-max>${fill(control.uiCallReservationShort, amount('3 600'))}</p>
    <details class="quiet-detail" data-call-reservation-detail><summary>${app.uiDetails}</summary><p class="hint">${fill(control.uiCallReservationMax, amount('3 600'))}</p></details>
    <details class="quiet-detail" data-call-stun-detail><summary>${app.uiDetails}</summary><p class="hint" data-call-stun-source>${app.uiNoSTUNServerIsSetSoCallsConnect}</p></details>
    <div class="call-confirm-actions"><button type="button" class="soft" data-call-confirm-cancel>${app.uiCancel}</button><button type="button" class="primary soft money" data-call-confirm="audio">${app.uiRing}</button></div>
  </div>`;
}

async function inReach(page: Page, phone: Phone, selector: string) {
  const r = await page.locator(selector).evaluate((el) => {
    const b = el.getBoundingClientRect();
    const sheet = el.closest('.call-confirm')?.getBoundingClientRect() ?? b;
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    const label = document.createRange(); label.selectNodeContents(el); const l = label.getBoundingClientRect();
    return { b: b.toJSON(), sheet: sheet.toJSON(), l: l.toJSON(), own: !!hit && (hit === el || el.contains(hit)), cut: el.scrollWidth > el.clientWidth + 1 };
  });
  for (const box of [r.b, r.l]) {
    expect(box.top).toBeGreaterThanOrEqual(Math.max(phone.top, r.sheet.top) - 0.5);
    expect(box.bottom).toBeLessThanOrEqual(Math.min(phone.height - phone.bottom, r.sheet.bottom) + 0.5);
    expect(box.left).toBeGreaterThanOrEqual(Math.max(phone.left, r.sheet.left) - 0.5);
    expect(box.right).toBeLessThanOrEqual(Math.min(phone.width - phone.right, r.sheet.right) + 0.5);
  }
  // The whole label sits inside its button.
  expect(r.l.left).toBeGreaterThanOrEqual(r.b.left - 0.5);
  expect(r.l.right).toBeLessThanOrEqual(r.b.right + 0.5);
  expect(r.cut).toBe(false);
  expect(r.b.height).toBeGreaterThanOrEqual(44);
  // Nothing covers it: a tap at its centre lands on it.
  expect(r.own).toBe(true);
}

// A closed Details still lays out its hidden content (WebKit keeps a box for it), so only what checkVisibility()
// reports as shown is measured; the sheet is then checked again with every Details open.
async function checkSheet(page: Page, phone: Phone) {
  await checkSheetOnce(page, phone);
  const sheet = page.locator('.call-confirm');
  const closed = await sheet.evaluate((el) => [...el.querySelectorAll('details')].filter((d) => !d.open).length);
  if (closed === 0) return;
  await sheet.evaluate((el) => { el.querySelectorAll('details').forEach((d) => { d.open = true; }); el.scrollTop = 0; });
  expect(await sheet.evaluate((el) => [...el.querySelectorAll('details p')].every((p) => p.checkVisibility()))).toBe(true);
  await checkSheetOnce(page, phone);
}

async function checkSheetOnce(page: Page, phone: Phone) {
  const sheet = page.locator('.call-confirm');
  const g = await sheet.evaluate((el) => {
    const b = el.getBoundingClientRect();
    const outside = [...el.querySelectorAll<HTMLElement>('p, strong, span, summary, button, .call-confirm-actions')]
      .filter((child) => child.checkVisibility())
      .filter((child) => { const c = child.getBoundingClientRect(); return c.left < b.left - 0.5 || c.right > b.right + 0.5; })
      .map((child) => child.outerHTML.slice(0, 60));
    return { b: b.toJSON(), sideways: el.scrollWidth > el.clientWidth + 1, outside, scrolls: el.scrollHeight > el.clientHeight + 1, overflowY: getComputedStyle(el).overflowY };
  });
  expect(g.b.top).toBeGreaterThanOrEqual(phone.top - 0.5);
  expect(g.b.bottom).toBeLessThanOrEqual(phone.height - phone.bottom + 0.5);
  expect(g.b.left).toBeGreaterThanOrEqual(phone.left - 0.5);
  expect(g.b.right).toBeLessThanOrEqual(phone.width - phone.right + 0.5);
  // Every word wraps inside the sheet: nothing to scroll sideways, nothing past its edges.
  expect(g.sideways).toBe(false);
  expect(g.outside).toEqual([]);
  if (g.scrolls) expect(g.overflowY).toBe('auto');
  // A sticky Cancel/Ring bar spans the sheet edge to edge (inside its border), so text never shows beside it.
  const bar = await sheet.evaluate((el) => {
    const a = el.querySelector<HTMLElement>('.call-confirm-actions')!;
    const b = el.getBoundingClientRect(), r = a.getBoundingClientRect();
    return { sticky: getComputedStyle(a).position === 'sticky', left: r.left - (b.left + el.clientLeft), right: (b.left + el.clientLeft + el.clientWidth) - r.right };
  });
  if (bar.sticky) {
    expect(Math.abs(bar.left)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(bar.right)).toBeLessThanOrEqual(0.5);
  }
  for (const end of ['top', 'bottom'] as const) {
    await sheet.evaluate((el, at) => { el.scrollTop = at === 'top' ? 0 : el.scrollHeight; el.scrollLeft = el.scrollWidth; }, end);
    expect(await sheet.evaluate((el) => el.scrollLeft)).toBe(0);
    await inReach(page, phone, '[data-call-confirm-cancel]');
    await inReach(page, phone, '[data-call-confirm="audio"]');
  }
  // Scrolled to the end, the last words sit above Cancel and Ring, not under them.
  const end = await sheet.evaluate((el) => {
    const actions = el.querySelector('.call-confirm-actions')!.getBoundingClientRect();
    const texts = [...el.querySelectorAll('p')].filter((p) => p.checkVisibility());
    return { lastBottom: texts[texts.length - 1].getBoundingClientRect().bottom, actionsTop: actions.top, firstTop: texts[0].getBoundingClientRect().top };
  });
  expect(end.lastBottom).toBeLessThanOrEqual(end.actionsTop + 0.5);
  await sheet.evaluate((el) => { el.scrollTop = 0; });
  const top = await sheet.evaluate((el) => ({ firstTop: el.querySelector('p')!.getBoundingClientRect().top, sheetTop: el.getBoundingClientRect().top }));
  expect(top.firstTop).toBeGreaterThanOrEqual(top.sheetTop - 0.5);
}

for (const platform of PLATFORMS) for (const phone of PHONES) for (const lang of ['en', 'da'] as const) for (const root of [16, 32, 53]) {
  test(`Ring confirmation wraps and keeps Cancel and Ring in reach: ${platform}, ${phone.width}x${phone.height}, ${lang}, ${root}px text`, async ({ page }) => {
    const area = safe(phone, platform);
    await page.setViewportSize({ width: phone.width, height: phone.height });
    await page.route('http://sheet.test/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.startsWith('/src/assets/')) return route.fulfill({ path: join(process.cwd(), path) });
      const rootRule = platform === 'none' ? `html { font-size: ${root}px; }` : `html[data-platform="${platform}"] { font-size: ${root}px; }`;
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html lang="${lang}"${platform === 'none' ? '' : ` data-platform="${platform}"`}><head>
        <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
        <style>${withInsets(area)}</style><style>${rootRule} *, *::before, *::after { animation: none !important; transition: none !important; }</style></head>
        <body><div class="track-head"><strong>Robin</strong><div class="call-buttons"><button type="button" class="soft call-button icon-btn" aria-label="Call">c</button>
        ${confirmation(lang)}</div></div></body></html>` });
    });
    await page.goto('http://sheet.test/');
    await page.evaluate(async () => { await Promise.all([...document.fonts].map((f) => f.load().catch(() => null))); await document.fonts.ready; });
    expect(await page.evaluate(() => document.fonts.check('16px Inter'))).toBe(true);
    await checkSheet(page, area);
  });
}

// The real shell (sample data): the sheet is placed by the app's own layout, not a fixture.
// Root sizes are the ones each platform really reaches. iOS Dynamic Type raises the root (U2b: 17px at Large,
// 53px at AX5). Android keeps the 16px rem basis and WebView enlarges text by text zoom, so it never runs at
// a 53px root; 17px and 32px cover its range here. A forced 53px root on Android widens the shell's top bar past
// a 320px screen before this sheet opens (on main as well), a separate shell issue outside this change.
const APP_ROOTS = { ios: [17, 53], android: [17, 32] } as const;
for (const platform of ['ios', 'android'] as const) for (const phone of PHONES) for (const root of APP_ROOTS[platform]) {
  test(`app: Call opens a confirmation with Cancel and Ring in reach: ${platform}, ${phone.width}x${phone.height}, ${root}px text`, async ({ page, browserName }) => {
    // The shell's Call button belongs to the app-to-app call UI, which needs VITE_CALL_MEDIA=webrtc. Only the
    // WebKit run (playwright.webkit.config.ts) builds the app that way; the Chrome a11y run keeps the product default.
    test.skip(browserName !== 'webkit', 'needs the WebKit run, where VITE_CALL_MEDIA=webrtc');
    await page.setViewportSize({ width: phone.width, height: phone.height });
    await page.goto('/?sample');
    await page.evaluate((value) => { document.documentElement.dataset.platform = value; }, platform);
    await page.addStyleTag({ content: withInsets(phone) });
    await page.addStyleTag({ content: `html[data-platform='${platform}'] { font-size: ${root}px; } *, *::before, *::after { animation: none !important; transition: none !important; }` });
    await page.evaluate(() => document.fonts.ready);
    // The page fits the screen before the sheet opens, so the sheet is measured against the screen itself.
    expect(await page.evaluate(() => innerWidth)).toBe(phone.width);
    const call = page.locator('[data-call="audio"]');
    await expect(call).toBeEnabled({ timeout: 15_000 });
    await call.click();
    await expect(page.locator('[data-call-confirm-box="audio"]')).toBeVisible();
    await checkSheet(page, phone);
  });
}

// iOS with the keyboard up: the layout viewport keeps its full height and the keyboard covers its foot, so the
// sheet follows the visible area the app measures (--keyboard-inset, --visible-height on the root, as set by
// src/ios/keyboard.ts) and Cancel and Ring stay above the keyboard.
const KEYBOARDS = [
  { ...PHONES[0], keyboard: 253 },
  { ...PHONES[1], keyboard: 336 },
];
for (const phone of KEYBOARDS) for (const root of [16, 32]) {
  test(`Ring confirmation stays above the iOS keyboard: ${phone.width}x${phone.height}, ${root}px text`, async ({ page }) => {
    const visible = phone.height - phone.keyboard;
    // The keyboard is the bottom edge now; the home-indicator inset is dropped while it is open.
    const area = { ...phone, bottom: phone.keyboard };
    await page.setViewportSize({ width: phone.width, height: phone.height });
    await page.route('http://sheet.test/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.startsWith('/src/assets/')) return route.fulfill({ path: join(process.cwd(), path) });
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html lang="en" data-platform="ios" data-keyboard-open="true"
        style="--visible-height: ${visible}px; --visible-top: 0px; --keyboard-inset: ${phone.keyboard}px"><head>
        <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
        <style>${withInsets(phone)}</style><style>html[data-platform="ios"] { font-size: ${root}px; } *, *::before, *::after { animation: none !important; transition: none !important; }</style></head>
        <body><div class="track-head"><strong>Robin</strong><div class="call-buttons"><button type="button" class="soft call-button icon-btn" aria-label="Call">c</button>
        ${confirmation('en')}</div></div></body></html>` });
    });
    await page.goto('http://sheet.test/');
    await page.evaluate(async () => { await Promise.all([...document.fonts].map((f) => f.load().catch(() => null))); await document.fonts.ready; });
    await checkSheet(page, area);
  });
}
