import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

for (const lang of ['en', 'da']) {
  for (const theme of ['dark', 'light']) {
    test(`starter step at phone width: ${lang}, ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 390, height: 844 });
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`/tests/fixtures/starter-balance.html?lang=${lang}&theme=${theme}`, { waitUntil: 'networkidle' });
      await page.locator('[data-starter-entry]').click();
      const step = page.locator('[data-starter-balance]');
      await expect(step).toBeVisible();
      await expect(page.locator('.wallet-body button')).toHaveCount(1);
      await expect(page.locator('[data-wallet-go="send"]')).toHaveCount(0);
      await expect(step.getByRole('button')).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= 390)).toBe(true);
      const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(result.violations.filter(v => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`${lang}-${theme}-starter.png`) });
      await step.getByRole('button').click();
      await expect(step.getByRole('button')).toHaveCount(0);
      await expect(step).toContainText(lang === 'da' ? 'Anmodning sendt' : 'Requested');
      await page.locator('[data-wallet-close]').click();
      await expect(page.locator('[data-wallet-balance]')).toBeVisible();
      expect(errors).toEqual([]);
    });
  }
}
