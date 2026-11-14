import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

for (const language of ['en', 'da'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`chain notice and refused send remain accessible (${language}, ${theme})`, async ({ page }) => {
      await page.addInitScript(({ language, theme }) => {
        localStorage.setItem('bitsov.language', language);
        localStorage.setItem('bitsov.theme', theme);
      }, { language, theme });
      await page.route('**/src/control/sample.ts*', async route => {
        const response = await route.fetch();
        await route.fulfill({ response, body: await response.text() + `
          const originalSampleSource = sampleSource;
          sampleSource = (opts) => {
            const source = originalSampleSource(opts);
            const overview = source.nodeOverview;
            source.nodeOverview = async () => ({ ...await overview(), chain_view: { explorer_default: true, trust_level: 'third_party' } });
            source.spendStatus = async () => ({ state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 600000, pending: null, window_ms: 600000 });
            source.send = async () => { throw { code: 'not_ready', reason: 'chain_unavailable', message: 'upstream detail' }; };
            return source;
          };
        ` });
      });
      await page.goto('/?sample');
      if (await page.locator('[data-phone-status]').isVisible()) {
        await page.locator('[data-track]').first().click();
      }
      const notice = page.locator('[data-chain-notice]:visible');
      await expect(notice).toHaveCount(1);
      await expect(notice.getByRole('status')).toHaveText(language === 'en'
        ? 'Your box reads the chain from a public service.' : 'Din boks læser kæden fra en offentlig tjeneste.');
      const summary = notice.locator('summary');
      await summary.focus();
      await page.keyboard.press('Enter');
      await expect(notice.locator('details')).toHaveAttribute('open', '');
      await expect(notice).toContainText(language === 'en' ? 'Bitcoin Core or Electrum' : 'Bitcoin Core eller Electrum');
      expect(await notice.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      const checks = await new AxeBuilder({ page }).include('[data-chain-notice]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(checks.violations).toEqual([]);
      await summary.press('Enter');
      await page.locator('[data-composer] textarea').fill('hello');
      await page.locator('[data-send]').click();
      await expect(page.locator('.track')).toContainText(language === 'en'
        ? "Your box can't see the Bitcoin chain right now; nothing was paid; try again later."
        : 'Din boks kan ikke se Bitcoin-kæden lige nu; intet blev betalt; prøv igen senere.');
      await expect(page.locator('[data-composer] textarea')).toHaveValue('hello');
      await expect(page.locator('[data-money-notice]')).toHaveCount(0);
    });
  }
}
