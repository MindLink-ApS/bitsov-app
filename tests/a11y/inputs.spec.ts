import { expect, test, type Page, type TestInfo } from '@playwright/test';

const editable = 'input:not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="range"]):not([type="color"]):not([readonly]), textarea:not([readonly]), select';

async function checkInputs(page: Page, info: TestInfo, surface: string, required: string) {
  await expect(page.locator(required).first()).toBeVisible();
  const fields = page.locator(editable).filter({ visible: true });
  expect(await fields.count(), surface).toBeGreaterThan(0);
  for (const field of await fields.all()) {
    const result = await field.evaluate(el => ({
      label: el.getAttribute('aria-label') ?? el.outerHTML.slice(0, 160),
      size: parseFloat(getComputedStyle(el).fontSize),
    }));
    expect(result.size, `${surface}: ${result.label}`).toBeGreaterThanOrEqual(16);
  }
  await page.screenshot({ path: info.outputPath(`${surface}.png`), fullPage: true });
}

for (const theme of ['light', 'dark'] as const) {
  test(`phone inputs keep readable text (${theme})`, async ({ page }, info) => {
    await page.addInitScript(t => localStorage.setItem('bitsov.theme', t), theme);
    await page.goto('/?sample', { waitUntil: 'networkidle' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await checkInputs(page, info, 'composer', '.composer textarea');

    await page.locator('[data-composer-plus]').click();
    await page.locator('[data-composer-mode="pay"]').click();
    await checkInputs(page, info, 'invoice', '[data-pay-invoice]');
    await page.getByRole('tab', { name: 'Direct', exact: true }).click();
    await checkInputs(page, info, 'amount', '.amount-input');
    await page.locator('[data-composer-close]').click();

    await page.getByRole('button', { name: 'Contact Maya', exact: true }).click();
    await checkInputs(page, info, 'contact', '[data-contact-petname]');
    await page.locator('[data-contact-close]').click();

    await page.getByRole('button', { name: 'You: wallet, profile and settings' }).click();
    await page.getByRole('menuitem').first().click();
    await page.locator('[data-wallet-tab="send"]').click();
    await checkInputs(page, info, 'wallet-send', '[data-send-to]');
    await page.locator('[data-wallet-tab="receive"]').click();
    await checkInputs(page, info, 'wallet-receive', '[data-receive-memo]');
    await page.locator('[data-wallet-close]').click();

    await page.getByRole('button', { name: 'You: wallet, profile and settings' }).click();
    await page.getByRole('menuitem').nth(1).click();
    await page.locator('[data-tab="frontdoor"]').click();
    await checkInputs(page, info, 'settings-profile', '[data-fd-edit-name]');
    await page.locator('[data-tab="general"]').click();
    await checkInputs(page, info, 'settings-general', '[data-stun-input]');
    await page.locator('[data-settings-close]').click();

    await page.locator('[data-rail-advanced] > summary').click();
    await page.locator('[data-track="discover"]').click();
    await checkInputs(page, info, 'link', '[data-discover-paste]');

    await page.locator('[data-track="ai"]').click();
    await checkInputs(page, info, 'assistant-composer', '[data-ai-input]');

    // Cover native control types (including search, which has no current app
    // surface) and the smaller CSS variants without adding a production fixture.
    await page.evaluate(() => {
      document.getElementById('root')!.innerHTML = `
        <main class="panel">
          <h1>Input styles</h1>
          <label class="field">Search<input type="search" placeholder="Search"></label>
          <label class="field">Password<input type="password" value="sample"></label>
          <label class="field">Email<input type="email" value="sample@example.test"></label>
          <label class="field">Telephone<input type="tel" value="12345"></label>
          <label class="field">URL<input type="url" placeholder="Paste a link"></label>
          <label class="field">Number<input type="number" value="42"></label>
          <label class="field">Duration<select><option>24 hours</option></select></label>
          <div class="ai-own-port"><label>Port<input value="1234"></label></div>
          <div class="ai-composer-main"><textarea aria-label="Assistant message">Hello</textarea></div>
          <div class="add-device"><textarea aria-label="Pairing ticket">Example link</textarea></div>
        </main>`;
    });
    await checkInputs(page, info, 'control-variants', 'input[type="search"]');
    await page.setViewportSize({ width: 956, height: 440 });
    await checkInputs(page, info, 'landscape-controls', 'input[type="search"]');
    for (const field of await page.locator(editable).all()) {
      await field.focus();
      expect(await field.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      Object.assign(window, { __BITSOV_SIT_ROWS__: [['q01', 'Sample node status']] });
    });
    await page.goto('/assistant.html', { waitUntil: 'networkidle' });
    await checkInputs(page, info, 'assistant-select', '.ask-select');
  });
}

test.describe('desktop', () => {
  test.use({ isMobile: false, hasTouch: false });

  test('keeps compact fields and large amounts', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.goto('/?sample', { waitUntil: 'networkidle' });
    const composer = page.locator('.composer textarea');
    await expect(composer).toBeVisible();
    expect(await composer.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBe(14);
    await page.locator('[data-composer-plus]').click();
    await page.locator('[data-composer-mode="pay"]').click();
    await page.getByRole('tab', { name: 'Direct', exact: true }).click();
    expect(await page.locator('.amount-input').evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBe(32);
  });
});
