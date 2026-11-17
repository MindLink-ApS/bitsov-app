import { expect, type Page } from '@playwright/test';

// The contact panel covers the whole window. While it is open, Tab and screen
// readers must stay inside it: the chat, the rail and the phone tabs behind it
// are inert. Call panels and live announcements stay usable. Closing it gives
// everything back and returns focus to the contact name.
const inert = (page: Page, sel: string) => page.locator(sel).first().evaluate((el) => el.closest('[inert]') !== null);

export async function checkContactPanelModal(page: Page, behind: string[]) {
  const opener = page.locator('[data-contact-open]');
  await opener.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-contact-panel="open"]')).toBeVisible();
  await expect(page.locator('[data-contact-close]')).toBeFocused();
  for (const sel of behind) expect(await inert(page, sel), sel).toBe(true);
  for (const sel of ['[data-waiting-calls]', '[data-send-live]']) expect(await inert(page, sel), sel).toBe(false);
  // Option+Tab is WebKit's "every control" Tab. It never reaches a control outside the panel
  // (past the last one it may rest on the page itself before coming back round).
  for (let i = 0; i < 24; i++) {
    await page.keyboard.press('Alt+Tab');
    const outside = await page.evaluate(() => {
      const el = document.activeElement;
      return el && el !== document.body && !el.closest('[data-contact-panel="open"]') ? el.outerHTML.slice(0, 120) : null;
    });
    expect(outside).toBeNull();
  }
  await page.locator('[data-contact-close]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-contact-panel="closed"]')).toHaveCount(1);
  for (const sel of behind) expect(await inert(page, sel), sel).toBe(false);
  await expect(opener).toBeFocused();
}

