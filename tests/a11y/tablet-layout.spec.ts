import { expect, test, type Page } from '@playwright/test';
import { PHONE_SHELL_PREVIEW } from './phoneShellPreview';

// iPad-sized windows, through the phone-shell preview page. An iPad is an iOS platform; above 680 px
// wide it gets the desktop rail, below it the phone tabs (src/control/PhoneShell.tsx). On a touch
// screen every visible control is a 44 px touch target (its own box, or a larger invisible tap
// area drawn by ::after); with a mouse the rail keeps its compact rows.
const IPAD_UA =
  'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const SIZES = [
  { name: 'portrait', width: 768, height: 1024 },
  { name: 'landscape', width: 1024, height: 768 },
  { name: 'portrait', width: 820, height: 1180 },
  { name: 'landscape', width: 1180, height: 820 },
] as const;

async function open(page: Page, width: number, height: number, lang: 'en' | 'da') {
  await page.setViewportSize({ width, height });
  // The preview page runs the app's control center with a stub runtime
  // and data-platform=ios (preview.tsx beside it).
  await page.goto(`${PHONE_SHELL_PREVIEW}?scene=list&lang=${lang}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
}

/** Visible controls whose tap area (box or larger ::after) is under 44 px either way. */
const smallTargets = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('button, a[href], summary, [role="button"]')]
  .filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden')
  .map((el) => {
    const r = el.getBoundingClientRect();
    const after = getComputedStyle(el, '::after');
    const extra = after.content !== 'none' && after.position === 'absolute'
      ? { w: parseFloat(after.width) || 0, h: parseFloat(after.height) || 0 } : { w: 0, h: 0 };
    return { el, w: Math.max(r.width, extra.w), h: Math.max(r.height, extra.h) };
  })
  .filter(({ w, h }) => w > 0 && h > 0 && (w < 44 || h < 44))
  .map(({ el, w, h }) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ').join('.')} '${(el.textContent ?? '').trim().slice(0, 18)}' ${Math.round(w)}x${Math.round(h)}`));

test.describe('touch', () => {
  test.use({ userAgent: IPAD_UA, hasTouch: true, isMobile: true });
  for (const size of SIZES) {
    for (const lang of ['en', 'da'] as const) {
      test(`iPad ${size.name} ${size.width}x${size.height}, ${lang}: fits, keeps the message box in view, and every control is a 44 px target`, async ({ page }) => {
        await open(page, size.width, size.height, lang);
        expect(await page.evaluate(() => document.documentElement.dataset.platform)).toBe('ios');
        expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'a touch screen').toBe(true);

        // Nothing scrolls sideways.
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, 'horizontal overflow in px').toBeLessThanOrEqual(1);

        // Open the first chat; its message box is whole and on screen.
        await page.locator('[data-track^="peer:"]').first().click();
        const composer = page.locator('section.track .composer').first();
        await expect(composer).toBeVisible();
        const box = await composer.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(size.width + 1);
        expect(box!.y + box!.height).toBeLessThanOrEqual(size.height + 1);

        // Every visible control, rail and open chat alike, is a 44 px touch target.
        expect(await smallTargets(page)).toEqual([]);
      });
    }
  }
});

test.describe('mouse', () => {
  test.use({ hasTouch: false, isMobile: false });
  test('1024x768 with a mouse: the rail keeps its compact rows', async ({ page }) => {
    await open(page, 1024, 768, 'en');
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(false);
    const row = await page.locator('.rail .track-link').first().boundingBox();
    expect(row).not.toBeNull();
    expect(row!.height).toBeLessThan(44);
  });
});
