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
  test(`${lang}: a long reason on an unsent message stays on screen`, async ({ page }) => {
    await page.goto(`${preview}?scene=list&lang=${lang}`);
    await page.locator('[data-phone-list] [data-track^="peer:"]').first().click();
    await page.waitForSelector('[data-stream]');
    const box = await page.evaluate(() => {
      const card = document.createElement('article');
      card.className = 'msg out unsent';
      card.innerHTML = '<div class="bubble">hi</div><div class="stamp"><span class="sats" data-unsent-reason>Ikke sendt · intet betalt · Beløbet ændrede sig under ventetiden på godkendelse, og endnu mere tekst.</span></div>';
      document.querySelector('[data-stream]')!.append(card);
      const r = card.querySelector('[data-unsent-reason]')!.getBoundingClientRect();
      return { left: r.left, right: r.right, width: window.innerWidth };
    });
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(box.width);
  });
  test(`${lang}: a tall composer stays inside the screen and its end can be reached`, async ({ page }) => {
    await page.setViewportSize({ width: 402, height: 874 });
    await page.goto(`${preview}?scene=list&lang=${lang}`);
    await page.locator('[data-phone-list] [data-track^="peer:"]').first().click();
    await page.waitForSelector('[data-composer-bar]');
    // As tall as the first-contact limits get, without needing a real first contact.
    await page.evaluate(() => { const tall = document.createElement('div'); tall.style.cssText = 'height:900px;flex:none'; document.querySelector('.composer')!.prepend(tall); });
    const end = await page.locator('.composer').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      return { bottom: el.getBoundingClientRect().bottom, bar: el.querySelector('[data-composer-bar]')!.getBoundingClientRect().bottom };
    });
    expect(end.bottom).toBeLessThanOrEqual(874);
    expect(end.bar).toBeLessThanOrEqual(874);
  });
  for (const platform of ['ios', 'android']) {
    test(`${lang}: the + menu is not clipped by the composer on ${platform}`, async ({ page }) => {
      await page.goto(`${preview}?scene=list&lang=${lang}`);
      await page.locator('[data-phone-list] [data-track^="peer:"]').first().click();
      await page.waitForSelector('[data-composer-bar]');
      await page.evaluate((p) => { document.documentElement.dataset.platform = p; }, platform);
      await page.locator('[data-composer-plus]').click();
      const onTop = await page.locator('[data-composer-mode="pay"]').evaluate((el) => {
        const r = el.getBoundingClientRect();
        return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el;
      });
      expect(onTop).toBe(true);
    });
  }
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
  await page.screenshot({ path: 'docs/ui/u5-phone-shell/webkit-landscape-list.png' });
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

// The file button's longer label reflows inside the composer at phone widths,
// in both languages and denominations, instead of being clipped by its panel.
for (const [scene, lang, denom, width] of ['budget-open', 'spend-open'].flatMap((scene) => ['en', 'da'].flatMap((lang) => ['sats', 'btc'].flatMap((denom) =>
  [320, 360, 375, 390, 480].map((width) => [scene, lang, denom, width] as const))))) {
      test(`${scene} ${lang} ${denom} ${width}: the file button stays inside its row`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.addInitScript((value) => localStorage.setItem('bitsov.denom', value), denom);
        await page.goto(`${preview}?scene=${scene}&lang=${lang}`);
        await page.locator('[data-track^="peer:"]').first().click();
        await page.locator('[data-composer-mode="file"]').evaluate((el: HTMLElement) => el.click());
        await page.locator('[data-file-input]').setInputFiles({ name: 'hi.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
        const send = page.locator('[data-composer] [data-send]');
        await expect(send).toBeVisible();
        const row = page.locator('[data-composer] .composer-main.file-row');
        const panel = page.locator('[data-composer]');
        await expect(send).toContainText(lang === 'da' ? 'højst' : 'up to');
        await page.waitForTimeout(400); // The phone shell's slide has settled.
        const [button, box, outer] = [(await send.boundingBox())!, (await row.boundingBox())!, (await panel.boundingBox())!];
        // Half a pixel for sub-pixel rounding between browsers.
        expect(button.x + button.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
        expect(button.x).toBeGreaterThanOrEqual(box.x - 0.5);
        expect(box.x + box.width).toBeLessThanOrEqual(outer.x + outer.width + 0.5);
        expect(outer.x + outer.width).toBeLessThanOrEqual(width + 0.5);
        expect(await send.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      });
}
