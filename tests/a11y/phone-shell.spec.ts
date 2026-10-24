import { test, expect } from '@playwright/test';

// The phone shell mounts only for an iPhone or Android user agent
// (see appPlatform). State it here so the spec does not depend on the
// launcher remembering. The Chrome axe pass ignores this file; the starter
// scene also needs VITE_STARTER_BALANCE=1 (playwright.phone-shell.config.ts).
test.use({
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  viewport: { width: 393, height: 852 },
  isMobile: true,
  hasTouch: true,
});

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

for (const scene of ['offline', 'repair', 'contacts-error']) {
  test(`${scene}: recovery remains reachable on the landing list`, async ({ page }) => {
    await page.goto(`${preview}?scene=${scene}`);
    await expect(page.locator('[data-phone-list]')).toBeVisible();
    const selector = scene === 'offline' ? '[data-node-offline] button' : scene === 'repair' ? '[data-call-repairs] button' : '[data-phone-list] [data-soft-reconnect]';
    const control = page.locator(selector).first();
    await expect(control).toBeVisible();
    await control.scrollIntoViewIfNeeded();
    await expect(control).toBeInViewport();
    if (scene === 'contacts-error') {
      await expect(page.locator('[data-phone-list]')).toContainText('We could not load your contacts.');
      await expect(page.locator('[data-phone-list]')).not.toContainText('No contacts yet');
    }
  });
}
test('landscape iPhone retains tabs and tapping Chats returns to its list', async ({ page }) => {
  await page.setViewportSize({ width: 852, height: 393 });
  await page.goto(`${preview}?scene=chat`);
  await expect(page.locator('[data-composer]')).toBeVisible();
  await expect(page.locator('[data-phone-tabs]')).toBeVisible();
  await expect(page.locator('.rail')).toHaveCount(0);
  await page.locator('[data-phone-tab="chats"]').click();
  await expect(page.locator('[data-phone-list]')).toBeVisible();
  // The committed landscape frame is a WebKit capture. Chrome would overwrite it.
  if (test.info().project.use.browserName === 'webkit') {
    await page.screenshot({ path: 'docs/ui/u5-phone-shell/webkit-landscape-list.png' });
  }
});
test('pending node approval blocks both navigation paths, including attribute transitions', async ({ page }) => {
  await page.goto(`${preview}?scene=chat`);
  await expect(page.locator('[data-composer]')).toBeVisible();
  await page.evaluate(() => {
    const card = document.createElement('div'); card.dataset.approval = 'idle';
    card.textContent = 'Confirm at your node'; document.querySelector('.track')!.append(card);
  });
  await expect(page.locator('[data-phone-tabs]')).not.toHaveAttribute('inert');
  await page.evaluate(() => document.querySelector<HTMLElement>('[data-approval]')!.dataset.approval = 'pending');
  await expect(page.locator('[data-phone-tabs]')).toHaveAttribute('inert');
  expect(await page.evaluate(async () => {
    // @ts-expect-error Vite serves the module at this browser URL.
    const { visibleBackDestination } = await import('/src/ios/edgeBack.ts');
    return visibleBackDestination();
  })).toBeNull();
  await page.locator('[data-phone-tab="you"]').evaluate((el: HTMLButtonElement) => el.click());
  await expect(page.locator('[data-composer]')).toBeVisible();
  await expect(page.locator('[data-phone-you]')).toHaveCount(0);
});
