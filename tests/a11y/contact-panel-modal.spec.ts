import { expect, test } from '@playwright/test';
import { checkContactPanelModal } from './contact-panel-check';

// Desktop. The phone shell case lives in phone-shell.spec.ts.
test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

for (const lang of ['en', 'da'] as const) {
  test(`${lang}: the contact panel keeps focus and hides the chat behind it`, async ({ page }) => {
    await page.addInitScript((l) => {
      try { localStorage.setItem('bitsov.language', l); } catch { /* private mode */ }
    }, lang);
    await page.goto('/?sample', { waitUntil: 'networkidle' });
    await checkContactPanelModal(page, ['[data-send]', '[data-composer-plus]', '[data-call="audio"]', '.rail [data-track^="peer:"]', '[data-profile]']);
  });
}

// Under reduced motion every element gets a near-zero transition. The panel's
// inherited `visibility` must still switch at once, or Close refuses focus on open.
test('reduced motion: the contact panel still keeps focus and hides the chat behind it', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?sample', { waitUntil: 'networkidle' });
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
  await checkContactPanelModal(page, ['[data-send]', '[data-composer-plus]', '[data-call="audio"]', '.rail [data-track^="peer:"]', '[data-profile]']);
});

// Other code also makes parts of the window inert (Settings, Wallet, the first-spend
// sheet, phone sheets). The panel must never undo what another owner asked for, and
// a live region next to the panel may announce but its controls must not be reachable.
test('the contact panel leaves inert set by others alone and keeps live-region controls out of reach', async ({ page }) => {
  await page.goto('/?sample', { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    const add = (html: string) => {
      const d = document.createElement('div');
      d.innerHTML = html;
      const el = d.firstElementChild as HTMLElement;
      document.body.appendChild(el);
      return el;
    };
    add('<div data-fx-before><button>before</button></div>').inert = true;
    add('<div data-fx-during><button>during</button></div>');
    add('<div data-fx-release><button>release</button></div>').inert = true;
    add('<div role="status" data-fx-live>Saved <button data-fx-live-btn>Undo</button></div>');
    add('<div aria-live="polite" data-fx-live-late>Ready</div>');
  });
  const isInert = (sel: string) => page.locator(sel).evaluate((el) => el.closest('[inert]') !== null);
  const setInert = (sel: string, on: boolean) => page.locator(sel).evaluate((el, v) => { (el as HTMLElement).inert = v; }, on);

  const opener = page.locator('[data-contact-open]');
  await opener.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-contact-close]')).toBeFocused();

  // Another owner changes its mind while the panel is open.
  await setInert('[data-fx-during]', true);
  await setInert('[data-fx-release]', false);
  await page.locator('[data-fx-live-late]').evaluate((el) => {
    const b = document.createElement('button');
    b.dataset.fxLiveLateBtn = '';
    b.textContent = 'Open';
    el.appendChild(b);
  });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));

  // The panel is still modal: nothing behind it is reachable.
  for (const sel of ['[data-fx-before]', '[data-fx-during]', '[data-fx-release]', '[data-fx-live-btn]', '[data-fx-live-late-btn]']) {
    expect.soft(await isInert(sel), sel).toBe(true);
  }
  // Live regions themselves keep announcing.
  for (const sel of ['[data-fx-live]', '[data-fx-live-late]', '[data-send-live]']) expect.soft(await isInert(sel), sel).toBe(false);
  const reached: string[] = [];
  for (let i = 0; i < 24; i++) {
    await page.keyboard.press('Alt+Tab');
    const outside = await page.evaluate(() => {
      const el = document.activeElement;
      return el && el !== document.body && !el.closest('[data-contact-panel="open"]') ? el.outerHTML.slice(0, 120) : null;
    });
    if (outside && !reached.includes(outside)) reached.push(outside);
  }
  expect.soft(reached).toEqual([]);

  await page.locator('[data-contact-close]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-contact-panel="closed"]')).toHaveCount(1);
  await expect(opener).toBeFocused();
  // Owners that still want inert keep it; the one that let go gets its element back.
  expect.soft(await isInert('[data-fx-before]'), 'before').toBe(true);
  expect.soft(await isInert('[data-fx-during]'), 'during').toBe(true);
  expect.soft(await isInert('[data-fx-release]'), 'release').toBe(false);
  for (const sel of ['[data-fx-live-btn]', '[data-fx-live-late-btn]', '[data-send]']) expect.soft(await isInert(sel), sel).toBe(false);
});
