import { expect, test } from '@playwright/test';

for (const width of [320, 393]) for (const lang of ['en', 'da']) for (const action of ['approve', 'close']) {
  test(`waiting Accept is reachable after ${action}: ${width}px ${lang}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width, height: 640 });
    await page.goto(`/tests/fixtures/waiting-approval.html?lang=${lang}`);
    await page.locator('[data-fixture-ring]').click();
    await page.locator('[data-waiting-calls] [data-call-spend-approve]').click();
    const approve = page.locator('[data-call-approve]');
    await expect(approve).toBeFocused();
    // The primary caller hangs up while the waiting call's approval is open.
    await page.locator('[data-fixture-end]').evaluate((el: HTMLButtonElement) => el.click());
    await expect(page.locator('[data-call-panel="ended"]')).toBeVisible();
    if (action === 'approve') await approve.click();
    else await page.locator('[data-call-approval]').getByRole('button', { name: lang === 'da' ? 'Luk' : 'Close', exact: true }).click();
    await expect(page.locator('[data-call-approval-open]')).toHaveCount(0);
    const accept = page.locator('[data-waiting-calls] [data-call-accept]');
    await expect(accept).toBeEnabled();
    await expect(accept).toBeFocused();
    await expect(accept).toBeInViewport();
    expect(await accept.evaluate(el => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    })).toBe(true);
    await accept.click({ trial: true });
  });
}
