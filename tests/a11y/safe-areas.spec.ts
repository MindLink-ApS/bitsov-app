import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// Browsers on the Mac have zero env() insets. Exercise the production cascade
// with measured portrait/landscape insets; native WKWebView evidence is in docs/ui.
// Inline CSS resolves URLs against the fixture, so retain Vite's font paths.
const css = readFileSync('src/styles.css', 'utf8').replaceAll("url('./assets/", "url('/src/assets/");
for (const geometry of [
  { width: 390, height: 844, top: 59, right: 0, bottom: 34, left: 0 },
  { width: 852, height: 393, top: 0, right: 59, bottom: 21, left: 59 },
]) {
  for (const surface of ['call', 'meeting']) {
    test(`safe ${surface} card and composer ${geometry.width}x${geometry.height}`, async ({ page }) => {
      await page.setViewportSize(geometry);
      await page.goto(`/tests/fixtures/safe-areas.html?surface=${surface}`);
      await page.addStyleTag({ content: css.replace(/env\(safe-area-inset-(top|right|bottom|left)(?:,\s*0px)?\)/g,
        (_, edge: 'top' | 'right' | 'bottom' | 'left') => `${geometry[edge]}px`) });
      await page.locator('.call-panel').evaluate(async el => {
        await Promise.all(el.getAnimations().map(animation => animation.finished));
      });
      await page.evaluate(() => document.fonts.ready);
      const card = await page.locator('.call-panel').boundingBox();
      expect(card!.x).toBeGreaterThanOrEqual(geometry.left);
      expect(card!.x + card!.width).toBeLessThanOrEqual(geometry.width - geometry.right);
      expect(card!.y).toBeGreaterThanOrEqual(geometry.top);
      expect(card!.y + card!.height).toBeLessThanOrEqual(geometry.height - geometry.bottom);
      const rail = await page.locator('.rail').boundingBox();
      expect(rail!.y).toBeGreaterThanOrEqual(geometry.top);
      const composer = await page.locator('.composer').boundingBox();
      expect(composer!.y + composer!.height).toBe(geometry.height - geometry.bottom);
      // No second inset added inside the composer after the shell reserves it.
      expect(await page.locator('.composer').evaluate(el => getComputedStyle(el).paddingBottom)).toBe('16px');
      expect(await page.locator('.call-panel').evaluate(el => getComputedStyle(el).overflowY)).toBe('auto');
    });
  }
}

for (const platform of ['ios', 'desktop']) {
  test(`scrolled settings header stays inside the ${platform} content area at 390x844`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/?sample');
    await page.evaluate(value => { document.documentElement.dataset.platform = value; }, platform);
    await page.addStyleTag({ content: css.replace(/env\(safe-area-inset-(top|right|bottom|left)(?:,\s*0px)?\)/g,
      (_, edge: string) => edge === 'top' ? '59px' : edge === 'bottom' ? '34px' : '0px') });
    await page.locator('.profile-avatar').click();
    await page.locator('.avatar-menu [role=menuitem]').nth(1).click();
    const modal = page.locator('.settings-modal.open');
    await expect(modal).toBeVisible();
    await modal.locator('[data-tab=node]').click();
    const bounds = (await modal.boundingBox())!;
    expect(bounds.y).toBe(platform === 'ios' ? 59 : 0);
    expect(bounds.y + bounds.height).toBe(platform === 'ios' ? 810 : 844);
    await modal.evaluate(el => { el.scrollTop = el.scrollHeight; });
    expect(await modal.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    await expect.poll(async () => (await modal.locator('.settings-head').boundingBox())!.y)
      .toBe(platform === 'ios' ? 59 : 20);
  });
}

for (const geometry of [
  { width: 390, height: 844, top: 59, right: 0, bottom: 34, left: 0 },
  { width: 852, height: 393, top: 0, right: 59, bottom: 20, left: 59 },
]) {
  for (const surface of ['locked', 'remember', 'banner', 'reviewing']) {
    test(`safe ${surface} content ${geometry.width}x${geometry.height}`, async ({ page }) => {
      await page.setViewportSize(geometry);
      await page.goto(`/tests/fixtures/safe-areas.html?surface=${surface}`);
      await page.addStyleTag({ content: css.replace(/env\(safe-area-inset-(top|right|bottom|left)(?:,\s*0px)?\)/g,
        (_, edge: 'top' | 'right' | 'bottom' | 'left') => `${geometry[edge]}px`) });
      for (const element of await page.locator('#root h2, #root button, #root [data-preview-content]').all()) {
        const rect = (await element.boundingBox())!;
        expect(rect.x).toBeGreaterThanOrEqual(geometry.left);
        expect(rect.x + rect.width).toBeLessThanOrEqual(geometry.width - geometry.right);
        expect(rect.y).toBeGreaterThanOrEqual(geometry.top);
      }
    });
  }
}
