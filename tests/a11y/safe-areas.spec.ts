import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// Browsers on the Mac have zero env() insets. Exercise the production cascade
// with measured portrait/landscape insets; native WKWebView evidence is in docs/ui.
// Inline CSS resolves URLs against the fixture, so retain Vite's font paths.
const css = readFileSync('src/styles.css', 'utf8').replaceAll("url('./assets/", "url('/src/assets/");
for (const geometry of [
  { width: 390, height: 844, top: 59, right: 0, bottom: 34, left: 0 },
  { width: 852, height: 393, top: 0, right: 59, bottom: 21, left: 59 },
]) {
  for (const surface of ['call', 'meeting']) for (const rootSize of [17, 53]) {
    test(`safe ${surface} card and composer ${geometry.width}x${geometry.height} at ${rootSize}px`, async ({ page }, info) => {
      await page.setViewportSize(geometry);
      await page.goto(`/tests/fixtures/safe-areas.html?surface=${surface}`);
      await page.addStyleTag({ content: css.replace(/env\(safe-area-inset-(top|right|bottom|left)(?:,\s*0px)?\)/g,
        (_, edge: 'top' | 'right' | 'bottom' | 'left') => `${geometry[edge]}px`) });
      // Desktop WebKit's -apple-system-body differs from WKWebView (13px on
      // macOS). Use the measured native Large/AX5 roots, not the host fallback.
      await page.addStyleTag({ content: `
        html[data-platform='ios'] { font-size: ${rootSize}px; }
        *, *::before, *::after { animation: none !important; transition: none !important; }
      ` });
      await page.locator('.call-panel').evaluate(async el => {
        await Promise.all(el.getAnimations().map(animation => animation.finished));
      });
      await page.evaluate(() => document.fonts.ready);
      const card = await page.locator('.call-panel').boundingBox();
      expect(card!.x).toBeGreaterThanOrEqual(geometry.left);
      expect(card!.x + card!.width).toBeLessThanOrEqual(geometry.width - geometry.right);
      expect(card!.y).toBeGreaterThanOrEqual(geometry.top);
      expect(card!.y + card!.height).toBeLessThanOrEqual(geometry.height - geometry.bottom);
      const rail = await page.locator('.rail').boundingBox();
      expect(rail!.y).toBeGreaterThanOrEqual(geometry.top);
      const composer = await page.locator('.composer').boundingBox();
      expect(composer!.y + composer!.height).toBe(geometry.height - geometry.bottom);
      expect(composer!.x).toBeGreaterThanOrEqual(geometry.left);
      expect(composer!.x + composer!.width).toBeLessThanOrEqual(geometry.width - geometry.right);
      expect(composer!.y).toBeGreaterThanOrEqual(geometry.top);
      // #322 preserves ~16px at Large and caps spacing at 24px at AX5.
      // No second safe inset inside the composer; allow only rem rounding.
      expect(await page.locator('.composer').evaluate(el => parseFloat(getComputedStyle(el).paddingBottom)))
        .toBeCloseTo(rootSize === 17 ? 16 : 24, 3);
      for (const control of await page.locator('.composer textarea, .composer button').all()) {
        const rect = (await control.boundingBox())!;
        expect(rect.x).toBeGreaterThanOrEqual(composer!.x);
        expect(rect.x + rect.width).toBeLessThanOrEqual(composer!.x + composer!.width);
        expect(rect.y).toBeGreaterThanOrEqual(composer!.y);
        expect(rect.y + rect.height).toBeLessThanOrEqual(composer!.y + composer!.height);
        expect(await control.evaluate(el => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight)).toBe(true);
      }
      expect(await page.locator('.call-panel').evaluate(el => getComputedStyle(el).overflowY)).toBe('auto');
      expect(await page.locator('.call-panel').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await info.attach('safe-area-geometry', {
        contentType: 'application/json',
        body: JSON.stringify({ geometry, rootSize, card, composer,
          composerControls: await page.locator('.composer textarea, .composer button').evaluateAll(elements =>
            elements.map(el => ({ tag: el.tagName, rect: el.getBoundingClientRect().toJSON(),
              client: [el.clientWidth, el.clientHeight], scroll: [el.scrollWidth, el.scrollHeight] }))),
        }, null, 2),
      });
      // Long cards may scroll, but every action/contact must fit in the card's
      // visible safe region when reached. The fixture is inert: never act.
      for (const control of await page.locator('.call-panel button, .call-panel label').all()) {
        await control.scrollIntoViewIfNeeded();
        const rect = (await control.boundingBox())!;
        expect(rect.x).toBeGreaterThanOrEqual(card!.x);
        expect(rect.x + rect.width).toBeLessThanOrEqual(card!.x + card!.width);
        expect(rect.y).toBeGreaterThanOrEqual(card!.y);
        expect(rect.y + rect.height).toBeLessThanOrEqual(card!.y + card!.height);
        expect(await control.evaluate(el => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight)).toBe(true);
      }
      await page.screenshot({ path: info.outputPath('safe-card-and-composer.png') });
    });
  }
}

for (const platform of ['ios', 'desktop']) {
  test(`scrolled settings header stays inside the ${platform} content area at 390x844`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/?sample');
    await page.evaluate(value => { document.documentElement.dataset.platform = value; }, platform);
    await page.addStyleTag({ content: css.replace(/env\(safe-area-inset-(top|right|bottom|left)(?:,\s*0px)?\)/g,
      (_, edge: string) => edge === 'top' ? '59px' : edge === 'bottom' ? '34px' : '0px') });
    await page.locator('.profile-avatar').click();
    await page.locator('.avatar-menu [role=menuitem]').nth(1).click();
    const modal = page.locator('.settings-modal.open');
    await expect(modal).toBeVisible();
    await modal.locator('[data-tab=node]').click();
    const bounds = (await modal.boundingBox())!;
    expect(bounds.y).toBe(platform === 'ios' ? 59 : 0);
    expect(bounds.y + bounds.height).toBe(platform === 'ios' ? 810 : 844);
    await modal.evaluate(el => { el.scrollTop = el.scrollHeight; });
    expect(await modal.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    await expect.poll(async () => (await modal.locator('.settings-head').boundingBox())!.y)
      .toBe(platform === 'ios' ? 59 : 20);
  });
}

for (const geometry of [
  { width: 390, height: 844, top: 59, right: 0, bottom: 34, left: 0 },
  { width: 852, height: 393, top: 0, right: 59, bottom: 20, left: 59 },
]) {
  for (const surface of ['locked', 'remember', 'banner', 'reviewing']) {
    test(`safe ${surface} content ${geometry.width}x${geometry.height}`, async ({ page }) => {
      await page.setViewportSize(geometry);
      await page.goto(`/tests/fixtures/safe-areas.html?surface=${surface}`);
      await page.addStyleTag({ content: css.replace(/env\(safe-area-inset-(top|right|bottom|left)(?:,\s*0px)?\)/g,
        (_, edge: 'top' | 'right' | 'bottom' | 'left') => `${geometry[edge]}px`) });
      for (const element of await page.locator('#root h2, #root button, #root [data-preview-content]').all()) {
        const rect = (await element.boundingBox())!;
        expect(rect.x).toBeGreaterThanOrEqual(geometry.left);
        expect(rect.x + rect.width).toBeLessThanOrEqual(geometry.width - geometry.right);
        expect(rect.y).toBeGreaterThanOrEqual(geometry.top);
      }
    });
  }
}
