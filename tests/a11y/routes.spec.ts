import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// Cheap local check for the sample shell. `scrollable-region-focusable` is
// disabled on purpose: the chat stream is a finding (docs/qa/UIUX-SWEEP-2026-10-20.md)
// and giving it a tab stop would change keyboard order.

async function serious(page: Page, include?: string) {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).disableRules(['scrollable-region-focusable']);
  if (include) builder = builder.include(include);
  const result = await builder.analyze();
  return result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
}

test('onboarding, inbox, and welcome stay free of serious axe violations', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  for (const theme of ['dark', 'light'] as const) {
    await page.addInitScript((t) => {
      try { localStorage.setItem('bitsov.theme', t); } catch { /* private mode */ }
    }, theme);
    for (const url of ['/?sample=first-run', '/?sample', '/?sample&peers=0']) {
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      const bad = await serious(page);
      expect(bad.map((v) => ({
        id: v.id,
        html: v.nodes.map((n) => n.html.slice(0, 180)),
      })), `${theme} ${url}`).toEqual([]);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      expect(overflow, `${theme} ${url}`).toBe(false);
    }
  }
  expect(pageErrors).toEqual([]);
});

test('emoji picker and the body energy table are valid aria', async ({ page }) => {
  await page.goto('/?sample');
  await page.getByRole('button', { name: 'Emoji' }).click();
  await expect(page.locator('[data-emoji-picker]')).toBeVisible();
  expect((await serious(page, '[data-emoji-picker]')).map((v) => v.id)).toEqual([]);

  await page.getByRole('button', { name: 'You: wallet, profile and settings' }).click();
  await page.getByRole('menuitem').nth(1).click();
  await page.locator('[data-tab="body"]').click();
  const energy = page.locator('.settings-modal.open .energy');
  await expect(energy).toBeVisible();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.settings-modal.open')!).opacity === '1');
  const energyViolations = await serious(page, '.settings-modal.open .energy');
  expect(energyViolations.map((v) => v.nodes.map((n) => n.failureSummary).join('\n'))).toEqual([]);
});

test('light wallet custody pill meets contrast', async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem('bitsov.theme', 'light'); } catch { /* private mode */ }
  });
  await page.goto('/?sample');
  await page.getByRole('button', { name: 'You: wallet, profile and settings' }).click();
  await page.getByRole('menuitem').first().click();
  const pill = page.locator('.wallet-page [data-custody]');
  await expect(pill).toBeVisible();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.wallet-page')!).opacity === '1');
  const pillViolations = await serious(page, '.wallet-page [data-custody]');
  expect(pillViolations.map((v) => v.nodes.map((n) => n.failureSummary).join('\n'))).toEqual([]);
});

test('phone rail labels are not ellipsized', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?sample');
  const clipped = await page.locator('.rail .name').evaluateAll((els) =>
    els
      .filter((el) => el instanceof HTMLElement && el.scrollWidth > el.clientWidth + 1)
      .map((el) => (el.textContent ?? '').trim()),
  );
  expect(clipped).toEqual([]);
});
