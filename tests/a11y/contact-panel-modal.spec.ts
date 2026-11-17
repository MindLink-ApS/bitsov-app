import { test } from '@playwright/test';
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
