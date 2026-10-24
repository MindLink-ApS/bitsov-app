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

// One test per theme: init scripts accumulate on a page, so each theme gets its own fresh page.
async function setTheme(page: Page, theme: 'dark' | 'light') {
  await page.addInitScript((t) => {
    try { localStorage.setItem('bitsov.theme', t); } catch { /* private mode */ }
  }, theme);
}

for (const theme of ['dark', 'light'] as const) {
  test(`onboarding, inbox, and welcome stay free of serious axe violations (${theme})`, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    await setTheme(page, theme);
    for (const url of ['/?sample=first-run', '/?sample', '/?sample&peers=0']) {
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      await expect(page.locator('html'), `${theme} ${url}`).toHaveAttribute('data-theme', theme);
      const bad = await serious(page);
      expect(bad.map((v) => ({
        id: v.id,
        html: v.nodes.map((n) => n.html.slice(0, 180)),
      })), `${theme} ${url}`).toEqual([]);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      expect(overflow, `${theme} ${url}`).toBe(false);
    }
    expect(pageErrors).toEqual([]);
  });
}

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
  // The table cells reset `font`; the figures keep their body size and tabular numerals.
  const fig = await page.locator('.settings-modal.open .energy .energy-fig').first().evaluate((el) => {
    const cs = getComputedStyle(el);
    const token = getComputedStyle(document.documentElement).getPropertyValue('--t-md').trim();
    // Computed font-size is always px. The token has been a rem since Dynamic Type.
    const probe = document.createElement('span');
    probe.style.fontSize = token;
    el.append(probe);
    const md = getComputedStyle(probe).fontSize;
    probe.remove();
    return { size: cs.fontSize, md, numeric: cs.fontVariantNumeric };
  });
  expect(fig.size).toBe(fig.md);
  expect(fig.numeric).toContain('tabular-nums');
  expect(energyViolations.map((v) => v.nodes.map((n) => n.failureSummary).join('\n'))).toEqual([]);
});

test('light wallet custody pill meets contrast', async ({ page }) => {
  await setTheme(page, 'light');
  await page.goto('/?sample');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
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
