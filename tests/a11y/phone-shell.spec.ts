import { test, expect, type Page } from '@playwright/test';
const preview = '/docs/ui/u5-phone-shell/harness/preview.html';
async function installLiveCallFixture(page: Page) {
  // Replace only the transport at module load. Never press Call/Pay/Approve.
  await page.route('**/src/control/call.ts', async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace('function createCallEngine(deps) {', 'function createRealCallEngine(deps) {');
    expect(body).toContain('function createRealCallEngine(deps) {');
    await route.fulfill({ response, body: body + `
      import { phoneLiveCall } from '/tests/fixtures/phone-live-call.ts';
      export function createCallEngine(deps) { return phoneLiveCall(createRealCallEngine, deps); }
    ` });
  });
}
async function expectRingNavigationBlocked(page: Page) {
  const incoming = page.locator('[data-call-panel="incoming"]');
  await expect(page.locator('[data-phone-tabs]')).toHaveAttribute('inert');
  await expect(page.locator('[data-phone-status]')).toHaveAttribute('inert');
  expect(await page.evaluate(async () => {
    // @ts-expect-error Browser module served by Vite.
    const { visibleBackDestination } = await import('/src/ios/edgeBack.ts');
    return visibleBackDestination();
  })).toBeNull();
  await incoming.locator('[data-ios-back="call"]').click();
  await expect(incoming).toBeVisible();
  expect(await page.evaluate(() => (window as any).phoneCall.engine.view().phase)).toBe('incoming');
}
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

for (const lang of ['en', 'da']) {
  test(`${lang}: Live call survives Wallet and You, pill and edge Back; capture mid-call Wallet`, async ({ page }) => {
    await installLiveCallFixture(page);
    await page.goto(`${preview}?scene=list&lang=${lang}`);
    const peer = await page.locator('[data-phone-list] [data-track^="peer:"]').first().getAttribute('data-track');
    await page.evaluate(peer => (window as any).phoneCall.start(peer), peer!.slice(5));
    const panel = page.locator('[data-call-panel="live"]');
    const pill = page.locator('[data-phone-status] [data-on-call="live"]');
    await expect(panel).toBeVisible();
    await page.evaluate(() => (window as any).callPlayback = document.querySelector('[data-call-media="remote"]'));
    for (const tab of ['wallet', 'you']) {
      await page.locator(`[data-phone-tab="${tab}"]`).click();
      await expect(page.locator(tab === 'wallet' ? '[data-wallet-page]' : '[data-phone-you]')).toBeVisible();
      await expect(panel).toBeHidden();
      await expect(pill).toBeVisible();
      expect(await page.evaluate(() => ({ phase: (window as any).phoneCall.engine.view().phase,
        sessions: (window as any).phoneCall.sessions,
        playback: (window as any).callPlayback === document.querySelector('[data-call-media="remote"]'),
        stream: !!(window as any).callPlayback.srcObject }))).toEqual({ phase: 'live', sessions: [true], playback: true, stream: true });
      if (tab === 'wallet') {
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: `docs/ui/u5-phone-shell/webkit-${lang}-mid-call-wallet.png`, animations: 'disabled' });
      }
      await pill.click();
      await expect(panel).toBeVisible();
      await expect(panel).toBeFocused();
    }
    await page.evaluate(async () => {
      // @ts-expect-error Browser module served by Vite.
      const { visibleBackDestination } = await import('/src/ios/edgeBack.ts');
      const next = visibleBackDestination();
      if (next?.route !== 'call') throw new Error('Expected call Back');
      next.back();
    });
    await expect(panel).toBeHidden();
    await pill.click(); await expect(panel).toBeVisible();
    expect(await page.evaluate(() => (window as any).phoneCall.sessions)).toEqual([true]);
  });
}
test('landscape status stays within a quarter of the viewport with stacked recovery notices', async ({ page }) => {
  await page.setViewportSize({ width: 852, height: 393 });
  await page.goto(`${preview}?scene=offline`);
  const status = page.locator('[data-phone-status]');
  await expect(status).toBeVisible();
  for (const fontSize of ['17px', '53px']) {
    await page.evaluate(size => document.documentElement.style.fontSize = size, fontSize);
    expect((await status.boundingBox())!.height).toBeLessThanOrEqual(393 * .25 + 1);
    await expect(page.locator('[data-phone-tabs]')).toBeInViewport();
  }
});

test('the actual expanded in-call Pay form blocks navigation until Cancel', async ({ page }) => {
  await installLiveCallFixture(page);
  await page.route('**/src/control/Shell.tsx', async route => {
    const response = await route.fetch();
    // Seed the existing form when Live arrives, without pressing Pay. All
    // transport remains the read-only fixture; production handlers are unchanged.
    const original = await response.text();
    const marker = 'const [expanded, setExpanded] = createSignal(false);';
    expect(original).toContain(marker);
    const body = original.replace(marker, marker + `
      createEffect(() => { if (props.view.phase === 'live') setExpanded(true); });
    `);
    await route.fulfill({ response, body });
  });
  await page.goto(`${preview}?scene=list`);
  const peer = await page.locator('[data-phone-list] [data-track^="peer:"]').first().getAttribute('data-track');
  await page.evaluate(peer => (window as any).phoneCall.start(peer), peer!.slice(5));
  const payment = page.locator('[data-in-call-pay]');
  await expect(payment).toHaveAttribute('data-swipe-money', 'true');
  await expect(payment.locator('.pay-flow')).toBeVisible();
  await expect(page.locator('[data-phone-tabs]')).toHaveAttribute('inert');
  await expect(page.locator('[data-phone-status]')).toHaveAttribute('inert');
  expect(await page.evaluate(async () => {
    // @ts-expect-error Browser module served by Vite.
    const { visibleBackDestination } = await import('/src/ios/edgeBack.ts');
    return visibleBackDestination();
  })).toBeNull();
  await page.locator('[data-phone-tab="wallet"]').evaluate((el: HTMLButtonElement) => el.click());
  await expect(page.locator('[data-wallet-page]')).toHaveCount(0);
  await payment.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('[data-phone-tab="wallet"]').click();
  await expect(page.locator('[data-wallet-page]')).toBeVisible();
  expect(await page.evaluate(() => (window as any).phoneCall.sessions)).toEqual([true]);
});

for (const mode of ['pay', 'file']) {
  for (const action of ['accept', 'decline']) {
    test(`incoming ring above ${mode}: ${action} preserves the pending composer without sending`, async ({ page }) => {
      await installLiveCallFixture(page);
      await page.route('**/src/control/Shell.tsx', async route => {
        const response = await route.fetch();
        const original = await response.text();
        // Seed the real composer without pressing Pay. All handlers stay real.
        const marker = 'const [mode, setMode] = createSignal("message");';
        expect(original).toContain(marker);
        await route.fulfill({ response, body: original.replace(marker, `const [mode, setMode] = createSignal("${mode === 'pay' ? 'pay' : 'message'}");`) });
      });
      await page.route('**/docs/ui/u5-phone-shell/harness/preview.tsx', async route => {
        const response = await route.fetch();
        const original = await response.text();
        const marker = 'const forbid = () => {';
        expect(original).toContain(marker);
        await route.fulfill({ response, body: original.replace(marker,
          'window.composerWrites = []; const forbid = () => { window.composerWrites.push("forbidden write");') });
      });
      await page.goto(`${preview}?scene=chat`);
      if (mode === 'file') {
        await page.locator('[data-composer-plus]').click();
        const choosing = page.waitForEvent('filechooser');
        await page.locator('[data-composer-mode="file"]').click();
        await (await choosing).setFiles({ name: 'pending.txt', mimeType: 'text/plain', buffer: Buffer.from('Pending file draft') });
      }
      // Disable the ring pulse so WebKit's stability check can hit-test the controls.
      await page.addStyleTag({ content: '[data-call-panel], [data-call-accept] { animation: none !important; transition: none !important; }' });
      const composer = page.locator(`[data-composer-panel="${mode}"]`);
      await expect(composer).toBeVisible();
      if (mode === 'pay') {
        await composer.getByRole('tab', { name: 'Direct', exact: true }).click();
        await composer.locator('[data-pay-note]').fill('Pending payment draft');
        await composer.locator('[data-pay-pubkey]').fill('02' + 'a'.repeat(64));
        await composer.locator('[data-pay-amount]').fill('123');
      }
      if (mode === 'file') await composer.locator('[data-file-choose]').focus();
      await composer.evaluate(el => {
        (window as any).pendingComposer = el;
        (window as any).composerFocus = document.activeElement;
      });
      const peer = await page.locator('[data-phone-list] [data-track^="peer:"]').last().getAttribute('data-track');
      await page.evaluate(peer => (window as any).phoneCall.ring(peer), peer!.slice(5));
      const incoming = page.locator('[data-call-panel="incoming"]');
      await expect(incoming).toBeVisible();
      await expect(incoming).toBeFocused();
      for (const selector of ['[data-call-accept]', '[data-call-decline]']) {
        const button = incoming.locator(selector);
        await expect(button).toBeEnabled();
        await button.click({ trial: true }); // Proves hit-testing/focusability; does not act.
      }
      await expect(page.locator('.track')).toHaveAttribute('inert');
      await expectRingNavigationBlocked(page);
      await page.locator(`[data-call-${action}]`).click();
      await expect.poll(() => page.evaluate(() => (window as any).phoneCall.engine.view().phase)).toBe(action === 'accept' ? 'connecting' : 'ended');
      await expect(composer).toBeVisible();
      await expect(page.locator('.track')).not.toHaveAttribute('inert');
      expect(await composer.evaluate(el => el === (window as any).pendingComposer)).toBe(true);
      await expect.poll(() => page.evaluate(() => document.activeElement === (window as any).composerFocus)).toBe(true);
      if (mode === 'pay') {
        await expect(composer.locator('[data-pay-note]')).toHaveValue('Pending payment draft');
        await expect(composer.locator('[data-pay-pubkey]')).toHaveValue('02' + 'a'.repeat(64));
        await expect(composer.locator('[data-pay-amount]')).toHaveValue('123');
      } else {
        await expect(composer.locator('[data-file-chip]')).toContainText('pending.txt');
        expect(await page.locator('[data-file-input]').evaluate((el: HTMLInputElement) => el.files?.[0]?.size)).toBe(18);
      }
      expect(await page.evaluate(() => (window as any).composerWrites)).toEqual([]);
      await expect(page.locator('[data-phone-tabs]')).toHaveAttribute('inert');
    });
  }
}

for (const tab of ['wallet', 'you']) {
  for (const action of ['accept', 'decline']) {
    test(`incoming ring on ${tab}: ${action} preserves the tab or opens the call`, async ({ page }) => {
      await installLiveCallFixture(page);
      await page.goto(`${preview}?scene=${tab}`);
      const underlay = page.locator(tab === 'wallet' ? '[data-wallet-page]' : '[data-phone-you]');
      await expect(underlay).toBeVisible();
      const opener = page.locator(tab === 'wallet' ? '[data-activity-direction="out"]' : '[data-phone-settings]');
      if (tab === 'wallet') await opener.click();
      else await opener.focus();
      await underlay.evaluate(el => { (window as any).ringUnderlay = el; (window as any).ringFocus = document.activeElement; });
      await page.addStyleTag({ content: '[data-call-panel], [data-call-accept] { animation: none !important; transition: none !important; }' });
      const peer = await page.locator('[data-phone-list] [data-track^="peer:"]').last().getAttribute('data-track');
      await page.evaluate(peer => (window as any).phoneCall.ring(peer), peer!.slice(5));
      const incoming = page.locator('[data-call-panel="incoming"]');
      await expect(incoming).toBeVisible();
      await expect(incoming).toBeFocused();
      await expect(underlay).toHaveAttribute('inert');
      for (const selector of ['[data-call-accept]', '[data-call-decline]']) {
        await expect(incoming.locator(selector)).toBeEnabled();
        await incoming.locator(selector).click({ trial: true });
      }
      await expectRingNavigationBlocked(page);
      await page.locator(`[data-call-${action}]`).click();
      await expect.poll(() => page.evaluate(() => (window as any).phoneCall.engine.view().phase)).toBe(action === 'accept' ? 'connecting' : 'ended');
      if (action === 'accept') {
        await expect(page.locator('[data-call-panel="connecting"]')).toBeVisible();
        await expect(page.locator('[data-call-panel="connecting"]')).toBeFocused();
        await expect(page.locator('[data-phone-tab="chats"]')).toHaveAttribute('aria-current', 'page');
      } else {
        await expect(page.locator('[data-call-panel]')).toBeHidden();
        await expect(underlay).toBeVisible();
        await expect(underlay).not.toHaveAttribute('inert');
        expect(await underlay.evaluate(el => el === (window as any).ringUnderlay)).toBe(true);
        await expect(page.locator(`[data-phone-tab="${tab}"]`)).toHaveAttribute('aria-current', 'page');
        if (tab === 'wallet') await expect(opener).toHaveAttribute('aria-checked', 'true');
        await expect.poll(() => page.evaluate(() => document.activeElement === (window as any).ringFocus)).toBe(true);
      }
    });
  }
}

for (const surface of ['wallet-review', 'you-approval']) {
  for (const action of ['accept', 'decline']) {
    test(`incoming ring with ${surface}: ${action} retains the pending surface without writes`, async ({ page }) => {
      await installLiveCallFixture(page);
      await page.route('**/docs/ui/u5-phone-shell/harness/preview.tsx', async route => {
        const response = await route.fetch();
        const original = await response.text();
        expect(original).toContain('const forbid = () => {');
        expect(original).toContain('if (key === "onLive")');
        await route.fulfill({ response, body: original
          .replace('const forbid = () => {', 'window.composerWrites = []; const forbid = () => { window.composerWrites.push("forbidden write");')
          .replace('if (key === "onLive")', `if (key === 'spendStatus') return async () => ({ state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 600000, pending: null, window_ms: 600000 }); if (key === 'onLive')`) });
      });
      if (surface === 'wallet-review') {
        await page.route('**/src/control/Shell.tsx', async route => {
          const response = await route.fetch();
          const original = await response.text();
          const marker = 'const [walletTab, setWalletTab] = createSignal(null);';
          expect(original).toContain(marker);
          // Seed the destination, without pressing Send. Review remains read-only.
          await route.fulfill({ response, body: original.replace(marker, 'const [walletTab, setWalletTab] = createSignal("send");')
            .replace('const [phoneTab, setPhoneTab] = createSignal("chats");', 'const [phoneTab, setPhoneTab] = createSignal("wallet");') });
        });
      }
      await page.goto(`${preview}?scene=${surface === 'wallet-review' ? 'wallet' : 'you'}`);
      if (surface === 'wallet-review') {
        await expect(page.locator('[data-phone-tab="wallet"]')).toHaveAttribute('aria-current', 'page');
        await page.locator('[data-send-to]').fill('02' + 'a'.repeat(64));
        await page.locator('[data-send-amount]').fill('123');
        await page.locator('[data-send-memo]').fill('Pending Wallet payment');
        await expect(page.locator('[data-send-review]')).toHaveText('Review');
        await page.locator('[data-send-review]').click();
      } else {
        await expect(page.locator('[data-phone-you]')).toBeVisible();
        await page.locator('[data-phone-devices]').click();
      }
      const pending = page.locator(surface === 'wallet-review' ? '[data-wallet-review]' : '[data-settings]');
      await expect(pending).toBeVisible();
      const before = await pending.textContent();
      await pending.evaluate(el => { (window as any).pendingSurface = el; });
      await page.addStyleTag({ content: '[data-call-panel], [data-call-accept] { animation: none !important; transition: none !important; }' });
      const peer = await page.locator('[data-phone-list] [data-track^="peer:"]').last().getAttribute('data-track');
      await page.evaluate(peer => (window as any).phoneCall.ring(peer), peer!.slice(5));
      const incoming = page.locator('[data-call-panel="incoming"]');
      await expect(incoming).toBeVisible();
      await expect(incoming).toBeFocused();
      await expectRingNavigationBlocked(page);
      await page.locator(`[data-call-${action}]`).click();
      await expect.poll(() => page.evaluate(() => (window as any).phoneCall.engine.view().phase)).toBe(action === 'accept' ? 'connecting' : 'ended');
      await expect(page.locator('[data-call-panel]')).toBeHidden();
      await expect(pending).toBeVisible();
      expect(await pending.evaluate(el => el === (window as any).pendingSurface)).toBe(true);
      expect(await pending.textContent()).toBe(before);
      await expect(page.locator('[data-phone-tabs]')).toHaveAttribute('inert');
      await expect(page.locator('[data-phone-status]')).toHaveAttribute('inert');
      expect(await page.evaluate(() => (window as any).composerWrites)).toEqual([]);
    });
  }
}
