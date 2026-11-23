import { expect, test } from '@playwright/test';
import { PHONE_SHELL_PREVIEW } from './phoneShellPreview';

// iPad-sized windows, through the phone-shell preview page. An iPad is an iOS platform; above 680 px wide it gets the
// desktop rail, below it the phone tabs (src/control/PhoneShell.tsx). These checks
// hold for both: nothing is wider than the screen, the open chat's message box
// is on screen, and the platform is iOS. Touch targets under 44 px are reported
// as annotations, not failures, until a tablet layout decision is made.
const IPAD_UA =
  'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

test.use({ userAgent: IPAD_UA, hasTouch: true, isMobile: true });

const SIZES = [
  { name: 'portrait', width: 820, height: 1180 },
  { name: 'landscape', width: 1180, height: 820 },
] as const;

for (const size of SIZES) {
  for (const lang of ['en', 'da'] as const) {
    test(`iPad ${size.name} ${size.width}x${size.height}, ${lang}: fits the screen and keeps the message box in view`, async ({ page }, info) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      // The phone-shell preview page runs the app's control center with a stub runtime
      // and data-platform=ios (preview.tsx beside it).
      await page.goto(`${PHONE_SHELL_PREVIEW}?scene=list&lang=${lang}`, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);

      expect(await page.evaluate(() => document.documentElement.dataset.platform)).toBe('ios');

      // Nothing scrolls sideways.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, 'horizontal overflow in px').toBeLessThanOrEqual(1);

      // Open the first chat; its message box is whole and on screen.
      const chat = page.locator('[data-track^="peer:"]').first();
      await chat.click();
      const composer = page.locator('section.track .composer').first();
      await expect(composer).toBeVisible();
      const box = await composer.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(size.width + 1);
      expect(box!.y + box!.height).toBeLessThanOrEqual(size.height + 1);

      // Findings only: visible controls smaller than a 44 px touch target.
      const small = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('button, a[href], summary, [role="button"]')]
        .filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden')
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44))
        .map(({ el, r }) => `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ')[0] : ''} ${Math.round(r.width)}x${Math.round(r.height)}`));
      info.annotations.push({ type: 'touch targets under 44px', description: `${small.length}: ${small.slice(0, 12).join(', ')}` });
    });
  }
}
