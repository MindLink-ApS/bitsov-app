import { expect, test } from '@playwright/test';

// The desktop rail puts a small hint after some entries ("read-only", "cards & pages · paid").
// The hint may shorten; the entry's own name must stay whole, in both languages.
test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

for (const lang of ['en', 'da'] as const) {
  test(`${lang}: rail names next to a hint are not cut`, async ({ page }) => {
    await page.addInitScript((l) => {
      try { localStorage.setItem('bitsov.language', l); } catch { /* private mode */ }
    }, lang);
    await page.goto('/?sample', { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    const names = await page.locator('.rail .track-link:has(.meta) .name').evaluateAll((els) =>
      els.map((el) => ({ text: el.textContent, cut: el.scrollWidth > el.clientWidth + 1 })));
    expect(names.length).toBeGreaterThan(4);
    expect(names.filter((n) => n.cut).map((n) => n.text)).toEqual([]);
  });
}
