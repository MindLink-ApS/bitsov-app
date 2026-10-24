import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

for (const lang of ['en', 'da']) {
  test(`Details supports the full row, keyboard and accessible state (${lang})`, async ({ page }) => {
    await page.goto(`/tests/fixtures/touch-approval.html?lang=${lang}`, { waitUntil: 'networkidle' });
    const row = page.getByRole('button', { name: lang === 'da' ? 'Detaljer' : 'Details' });
    await expect(row).toHaveAttribute('aria-expanded', 'false');
    const box = (await row.boundingBox())!;
    const parent = (await page.locator('[data-touch-detail]').boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(parent.width - 1);
    // Far from the text and triangle: the entire row activates the disclosure.
    await row.click({ position: { x: box.width - 5, y: box.height / 2 } });
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    const panel = page.locator(`#${await row.getAttribute('aria-controls')}`);
    await expect(panel).toBeVisible();
    await row.focus();
    await page.keyboard.press('Space');
    await expect(row).toHaveAttribute('aria-expanded', 'false');
    await expect(panel).toBeHidden();
    await page.keyboard.press('Enter');
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    await expect(panel).toBeVisible();
    const result = await new AxeBuilder({ page }).include('[data-touch-detail]').analyze();
    expect(result.violations).toEqual([]);
  });
}
