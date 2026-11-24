import { expect, test, type Page } from '@playwright/test';
import { PHONE_SHELL_PREVIEW } from './phoneShellPreview';

// A phone on its side, through the phone-shell preview page. When the status header wraps to
// several lines (long text, larger fonts), the open chat must still reach Send, + and the
// microphone, with room to spare. The status header is held to 20% of the height; the bottom tabs stay, except in the
// shortest windows (360 px or less), where they step aside while a chat is open.
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
test.use({ userAgent: IPHONE_UA, hasTouch: true, isMobile: true });

const SEND = '[data-composer-bar] .send-btn';
const PLUS = '[data-composer-plus]';
const MIC = '[data-voice-record]';
const BACK = '[data-ios-back="thread"]';
const TABS = '[data-phone-tabs]';

async function open(page: Page, width: number, height: number, lang: 'en' | 'da') {
  await page.setViewportSize({ width, height });
  await page.goto(`${PHONE_SHELL_PREVIEW}?scene=spend-open&lang=${lang}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
}

/**
 * Makes the status pill's own text long enough to wrap over at least three lines, as a long
 * status or larger fonts do (the header then reaches its height limit and scrolls).
 */
async function wrapPill(page: Page) {
  const what = page.locator('.phone-status .node-pill .what').first();
  await expect(what).toBeVisible();
  const lines = await what.evaluate((el) => {
    const text = el.textContent ?? '';
    el.textContent = Array(20).fill(text).join(' · ');
    const style = getComputedStyle(el);
    const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
    return el.getBoundingClientRect().height / line;
  });
  expect(lines, 'the status text wraps to at least three lines').toBeGreaterThanOrEqual(3);
}

/** On screen, and the browser hit-tests `sel` itself (or something inside it) at its centre. */
const reachable = (page: Page, sel: string) => page.locator(sel).first().evaluate((el) => {
  const r = el.getBoundingClientRect();
  if (r.top < 0 || r.left < 0 || r.bottom > innerHeight + 0.5 || r.right > innerWidth + 0.5) return false;
  const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
  return !!hit && (hit === el || el.contains(hit));
});

const SIZES = [
  { name: 'iPhone 8', width: 667, height: 375 },
  { name: 'iPhone SE', width: 568, height: 320 },
  { name: 'iPhone 15', width: 852, height: 393 },
] as const;

for (const size of SIZES) {
  for (const lang of ['en', 'da'] as const) {
    test(`${size.name} landscape ${size.width}x${size.height}, ${lang}: with a wrapped status, Send, + and the microphone stay reachable`, async ({ page }) => {
      await open(page, size.width, size.height, lang);
      // On the chat list the tabs are there.
      await expect(page.locator(TABS)).toBeVisible();

      await page.locator('[data-phone-list] [data-track^="peer:"]').first().click();
      await expect(page.locator(SEND)).toBeVisible();
      await wrapPill(page);
      for (const sel of [SEND, PLUS, MIC, BACK]) {
        expect.soft(await reachable(page, sel), `${sel} is on screen and on top at its centre`).toBe(true);
      }
      // Room to spare, since fonts differ by system: the whole message bar shows inside the
      // composer (which shrinks and scrolls when short) with at least 16 px below it.
      const spare = await page.locator('section.track .composer').first().evaluate((composer) => {
        const bar = composer.querySelector('[data-composer-bar]')!.getBoundingClientRect();
        const box = composer.getBoundingClientRect();
        return Math.min(box.bottom, innerHeight) - bar.bottom;
      });
      expect.soft(spare, 'space below the message bar').toBeGreaterThanOrEqual(16);
      // The tabs stay where there is room for them, and are on top where they show.
      if (size.height > 360) expect.soft(await reachable(page, `${TABS} [data-phone-tab="chats"]`), 'Chats tab reachable').toBe(true);
      else await expect(page.locator(TABS)).toBeHidden();

      // Back to the list: the tabs are there.
      await page.locator(BACK).click();
      await expect(page.locator(TABS)).toBeVisible();
    });
  }
}

test('portrait 375x667: an open chat keeps the bottom tabs', async ({ page }) => {
  await open(page, 375, 667, 'en');
  await page.locator('[data-phone-list] [data-track^="peer:"]').first().click();
  await expect(page.locator(SEND)).toBeVisible();
  await expect(page.locator(TABS)).toBeVisible();
  for (const sel of [SEND, PLUS, MIC]) expect.soft(await reachable(page, sel), `${sel} reachable`).toBe(true);
});
