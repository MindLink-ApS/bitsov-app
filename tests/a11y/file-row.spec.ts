import { test, expect } from '@playwright/test';

// The file button's longer label reflows inside the composer at phone widths,
// in both languages and denominations, instead of being clipped by its panel.
const preview = '/docs/ui/u5-phone-shell/harness/preview.html';
for (const [scene, lang, denom, width] of ['budget-open', 'spend-open'].flatMap((scene) => ['en', 'da'].flatMap((lang) => ['sats', 'btc'].flatMap((denom) =>
  [320, 360, 375, 390, 480].map((width) => [scene, lang, denom, width] as const))))) {
      test(`${scene} ${lang} ${denom} ${width}: the file button stays inside its row`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.addInitScript((value) => localStorage.setItem('bitsov.denom', value), denom);
        await page.goto(`${preview}?scene=${scene}&lang=${lang}`);
        await page.locator('[data-track^="peer:"]').first().click();
        await page.locator('[data-composer-mode="file"]').evaluate((el: HTMLElement) => el.click());
        await page.locator('[data-file-input]').setInputFiles({ name: 'hi.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
        const send = page.locator('[data-composer] [data-send]');
        await expect(send).toBeVisible();
        const row = page.locator('[data-composer] .composer-main.file-row');
        const panel = page.locator('[data-composer]');
        await expect(send).toContainText(lang === 'da' ? 'højst' : 'up to');
        const [button, box, outer] = [(await send.boundingBox())!, (await row.boundingBox())!, (await panel.boundingBox())!];
        expect(button.x + button.width).toBeLessThanOrEqual(box.x + box.width);
        expect(button.x).toBeGreaterThanOrEqual(box.x);
        expect(box.x + box.width).toBeLessThanOrEqual(outer.x + outer.width + 0.5);
        expect(outer.x + outer.width).toBeLessThanOrEqual(width);
        expect(await send.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      });
}
