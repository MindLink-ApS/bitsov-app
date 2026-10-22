import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 } });
for (const lang of ['en', 'da']) {
  for (const state of ['start', 'scanner', 'connecting', 'words', 'done', 'fingerprint', 'unclaimed', 'local_network', 'unreachable', 'busy', 'expired', 'clock', 'used', 'tailscale', 'claim_mismatch', 'other', 'camera', 'mismatch', 'approval_expired']) {
    test(`phone 390×844 ${lang} ${state}`, async ({ page }, testInfo) => {
      const errors: string[] = [];
      page.on('pageerror', e => errors.push(e.message));
      const fixtureState = state === 'mismatch' ? 'words' : state;
      await page.goto(`/tests/fixtures/phone-onboarding.html?lang=${lang}&state=${fixtureState}`, { waitUntil: 'networkidle' });
      if (['scanner', 'camera'].includes(state)) await page.locator('button.primary').click();
      if (state === 'mismatch') await page.getByRole('button', { name: lang === 'da' ? 'De er ikke ens' : "They don't match", exact: true }).click();
      const main = page.locator('[data-phone-onboarding]');
      await expect(main).toHaveAttribute('data-phone-onboarding', ['unclaimed', 'local_network', 'unreachable', 'busy', 'expired', 'clock', 'used', 'tailscale', 'claim_mismatch', 'other', 'camera', 'mismatch', 'approval_expired'].includes(state) ? 'error' : state);
      await expect(page.locator('.phone-options')).not.toHaveAttribute('open');
      await expect(page.locator('h1')).toBeVisible();
      expect((await page.locator('.phone-line').boundingBox())!.height).toBeLessThan(28);
      expect(await page.locator('button.primary:visible').count()).toBe(state === 'words' ? 0 : 1);
      for (const button of await page.locator('button.primary:disabled').all()) {
        const id = await button.getAttribute('aria-describedby');
        expect(id).toBeTruthy();
        await expect(page.locator(`[id="${id}"]`)).toBeVisible();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= 390)).toBe(true);
      const options = await page.locator('.phone-options').boundingBox();
      expect(options!.y + options!.height).toBeLessThanOrEqual(844);
      expect(errors).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`${lang}-${state}.png`) });
    });
  }
}

for (const lang of ['en', 'da']) {
  for (const state of ['trust', 'local_network', 'camera']) {
    test(`phone Android/trust 390×844 ${lang} ${state}`, async ({ page }, testInfo) => {
      await page.goto(`/tests/fixtures/phone-onboarding.html?lang=${lang}&platform=android&state=${state}`, { waitUntil: 'networkidle' });
      if (state === 'camera') await page.locator('button.primary').click();
      await expect(page.locator('h1')).toBeVisible();
      expect((await page.locator('.phone-line').boundingBox())!.height).toBeLessThan(28);
      await expect(page.locator('.phone-options')).not.toHaveAttribute('open');
      expect(await page.locator('button:visible').count()).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= 390)).toBe(true);
      if (state === 'local_network') await expect(page.locator('.phone-line')).toContainText(lang === 'en' ? 'Nearby devices' : 'Enheder i nærheden');
      await page.screenshot({ path: testInfo.outputPath(`${lang}-${state}.png`) });
    });
  }
}
