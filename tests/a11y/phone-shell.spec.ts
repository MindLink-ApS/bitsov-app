import { test, expect } from '@playwright/test';
const preview = '/docs/ui/u5-phone-shell/harness/preview.html';
for (const lang of ['en', 'da']) {
  test(`${lang}: phone navigation, reachable entries and safe-area geometry`, async ({ page }) => {
    await page.goto(`${preview}?scene=list&lang=${lang}`);
    const tabs = page.locator('[data-phone-tabs]');
    await expect(tabs).toBeVisible();
    await expect(page.locator('.rail')).toHaveCount(0);
    await page.locator('[data-phone-list] [data-track^="peer:"]').first().click();
    await expect(page.locator('[data-composer]')).toBeVisible();
    await page.locator('[data-ios-back="thread"]').click();
    await expect(page.locator('[data-phone-list]')).toBeVisible();
    await page.locator('[data-phone-tab="wallet"]').click();
    await expect(page.locator('[data-wallet-page]')).toBeVisible();
    await expect(page.locator('[data-phone-status]')).toBeVisible();
    await page.locator('[data-phone-add-sats]').click();
    await expect(page.locator('[data-wallet-receive]')).toBeVisible();
    await page.locator('[data-phone-tab="you"]').click();
    await page.locator('[data-phone-share]').click();
    await expect(page.locator('[data-tab="frontdoor"]')).toHaveAttribute('aria-selected', 'true');
    await page.locator('[data-settings-close]').click();
    await page.locator('[data-phone-devices]').click();
    await expect(page.locator('[data-tab="devices"]')).toHaveAttribute('aria-selected', 'true');
    await page.locator('[data-settings-close]').click();
    const bounds = await tabs.boundingBox();
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(852);
  });
  test(`${lang}: first-spend is in the top layer above the tabs, with edge Back blocked`, async ({ page }) => {
    await page.goto(`${preview}?scene=first-spend&lang=${lang}`);
    await expect(page.locator('[data-first-spend-scrim]')).toBeVisible();
    expect(await page.locator('[data-first-spend-scrim]').evaluate(el => el.matches(':modal'))).toBe(true);
    const top = await page.locator('[data-phone-tabs]').evaluate(el => {
      const r = el.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('[data-first-spend-scrim]') !== null;
    });
    expect(top).toBe(true);
  });
  test(`${lang}: AX5 Allow stays visible while the keyboard hides phone tabs`, async ({ page }) => {
    await page.goto(`${preview}?scene=first-spend&lang=${lang}`);
    const tabs = page.locator('[data-phone-tabs]');
    await expect(tabs).toBeVisible();
    await expect(page.locator('[data-first-spend-sheet]')).toBeVisible();
    await page.addStyleTag({ content: 'html[data-platform="ios"] { font-size: 53px; }' });
    await page.locator('.first-spend-options summary').click();
    await page.locator('[data-first-spend-custom]').click();
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 482 });
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    await page.locator('[data-first-spend-amount]').fill('1250.5');
    await expect(tabs).toBeHidden();
    await expect(page.locator('[data-first-spend-allow]')).toBeEnabled();
    await expect.poll(async () => page.locator('[data-first-spend-allow]').evaluate(el => {
      const r = el.getBoundingClientRect();
      return r.height > 0 && r.top >= 0 && r.bottom <= visualViewport!.height;
    })).toBe(true);
    await expect(page.locator('[data-first-spend-keyboard-daily]')).toContainText('1\u202f250\u202f500 msat');
    await page.evaluate(() => {
      delete (window.visualViewport as any).height;
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    await expect(tabs).toBeVisible();
  });
}
test('AX5-equivalent text keeps phone labels inside the viewport', async ({ page }) => {
  for (const scene of ['list', 'chat', 'wallet', 'you', 'first-spend']) {
    await page.goto(`${preview}?scene=${scene}&lang=da`);
    await page.locator('[data-phone-tabs]').waitFor();
    await page.evaluate(() => document.documentElement.style.fontSize = '53px');
    await page.waitForTimeout(700);
    const result = await page.evaluate(() => (window as any).phoneGeometry());
    expect(result.failures).toEqual([]);
  }
});
test('keyboard state hides tabs and restores the same route after dismissal', async ({ page }) => {
  await page.goto(`${preview}?scene=chat`);
  await expect(page.locator('[data-composer]')).toBeVisible();
  await page.evaluate(() => document.documentElement.dataset.keyboardOpen = 'true');
  await expect(page.locator('[data-phone-tabs]')).toBeHidden();
  await expect(page.locator('[data-phone-status]')).toBeVisible();
  await page.evaluate(() => document.documentElement.dataset.keyboardOpen = 'false');
  await expect(page.locator('[data-phone-tabs]')).toBeVisible();
  await expect(page.locator('[data-composer]')).toBeVisible();
});
test('starter remains reachable when flagged and blocks swipe Back', async ({ page }) => {
  await page.goto(`${preview}?scene=starter`);
  await expect(page.locator('[data-starter-balance]')).toBeVisible();
  await expect(page.locator('[data-wallet-close]')).toBeVisible();
  expect(await page.locator('[data-phone-tabs]').evaluate(el => {
    const r = el.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('[data-wallet-page]') !== null;
  })).toBe(true);
  await page.locator('[data-wallet-close]').click();
  await expect(page.locator('[data-starter-entry]')).toBeVisible();
});
