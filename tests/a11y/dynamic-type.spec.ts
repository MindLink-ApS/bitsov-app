import { expect, test } from '@playwright/test';

// 53px is the system root measured at AX5 in the native WKWebView JSON.
// This emulates that root for fast regressions; capture.py applies the OS setting.
for (const lang of ['en', 'da']) for (const scene of ['chat', 'wallet', 'first-spend', 'settings', 'approval']) {
  test(`AX5 money and approval text is complete: ${lang} ${scene}`, async ({ page }) => {
    await page.goto(`/docs/ui/u2b-dynamic-type/harness/preview.html?lang=${lang}&scene=${scene}`);
    await page.addStyleTag({content: 'html[data-platform="ios"] { font-size: 53px; }'});
    await page.waitForTimeout(1000);
    const result = await page.evaluate(() => (window as any).dynamicTypeGeometry());
    expect(result.elements.length).toBeGreaterThan(0);
    expect(result.failures).toEqual([]);
    for (const mark of result.minimums) expect(parseFloat(mark.font)).toBeGreaterThanOrEqual(15);
    for (const amount of result.elements.filter((el: any) => el.class.split(' ').includes('sats'))) {
      expect(amount.whiteSpace).toBe('nowrap');
    }
    if (scene === 'first-spend') {
      // A short visible viewport complements XCTest's actual software keyboard.
      await page.evaluate(() => {
        document.documentElement.dataset.keyboardOpen = 'true';
        document.documentElement.style.setProperty('--visible-height', '430px');
      });
      await page.locator('[data-first-spend-amount]').fill('1250.5');
      const editing = await page.evaluate(() => (window as any).dynamicTypeGeometry());
      expect(editing.failures).toEqual([]);
      expect(await page.locator('[data-first-spend-keyboard-daily]').innerText()).toContain('1\u202f250\u202f500 msat');
    }
  });
}
for (const platform of ['desktop', 'android']) test(`${platform} retains the original type and spacing`, async ({ page }) => {
  await page.goto(`/docs/ui/u2b-dynamic-type/harness/preview.html?scene=chat&platform=${platform}`);
  const sizes = await page.evaluate(() => {
    const probe = document.createElement('span'); probe.style.cssText = 'font-size:var(--t-xs);padding:var(--s-2)'; document.body.append(probe);
    const hero = document.createElement('span'); hero.className = 'wallet-total'; document.body.append(hero);
    return { hero: getComputedStyle(hero).fontSize, body: getComputedStyle(document.body).fontSize, small: getComputedStyle(probe).fontSize, space: getComputedStyle(probe).paddingTop };
  });
  expect(sizes).toEqual({hero:'64px', body:'14px', small:'11.5px', space:'8px'});
});

for (const lang of ['en', 'da']) test(`AX5 maximum safe wallet amount fits: ${lang}`, async ({ page }) => {
  await page.goto(`/docs/ui/u2b-dynamic-type/harness/preview.html?scene=wallet&lang=${lang}&large-balance=1`);
  await page.addStyleTag({content: 'html[data-platform="ios"] { font-size: 53px; }'});
  await page.locator('[data-balance-total="9007199254740991"]').waitFor();
  const result = await page.evaluate(() => (window as any).dynamicTypeGeometry());
  expect(result.failures).toEqual([]);
});
