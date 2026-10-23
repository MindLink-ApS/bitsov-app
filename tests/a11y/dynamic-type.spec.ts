import { expect, test, type Page } from '@playwright/test';

async function openPreview(page: Page, url: string) {
  await page.goto(url);
  // These tests measure settled layout. Offscreen probe animations can remain
  // pending in WebKit even with reduced motion, so disable motion explicitly.
  await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
  const scene = new URL(url, 'http://fixture').searchParams.get('scene')!;
  const ready: Record<string, string> = {
    chat: '[data-composer]', wallet: '[data-balance-total]',
    'first-spend': '[data-first-spend-amount]',
    settings: '[data-settings][aria-hidden="false"]', approval: '[data-owner-approval-sheet]',
  };
  // The native preview opens scenes asynchronously. Wait for the actual scene,
  // and fonts, not a fixed delay that races a cold CI server.
  await expect(page.locator(ready[scene])).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

// 53px is the system root measured at AX5 in the native WKWebView JSON.
// This emulates that root for fast regressions; capture.py applies the OS setting.
for (const lang of ['en', 'da']) for (const scene of ['chat', 'wallet', 'first-spend', 'settings', 'approval']) {
  test(`AX5 money and approval text is complete: ${lang} ${scene}`, async ({ page }) => {
    await openPreview(page, `/docs/ui/u2b-dynamic-type/harness/preview.html?lang=${lang}&scene=${scene}`);
    await page.addStyleTag({content: 'html[data-platform="ios"] { font-size: 53px; }'});
    const result = await page.evaluate(() => (window as any).dynamicTypeGeometry());
    expect(result.elements.length).toBeGreaterThan(0);
    expect(result.failures).toEqual([]);
    for (const mark of result.minimums) expect(parseFloat(mark.font)).toBeGreaterThanOrEqual(15);
    for (const amount of result.elements.filter((el: any) => el.class.split(' ').includes('sats'))) {
      expect(amount.whiteSpace).toBe('nowrap');
    }
    if (scene === 'first-spend') {
      // Emulate the measured native keyboard viewport, including its resize event.
      await page.evaluate(() => {
        Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 482 });
        window.visualViewport!.dispatchEvent(new Event('resize'));
      });
      await page.locator('[data-first-spend-amount]').fill('1250.5');
      await expect.poll(async () => page.locator('[data-first-spend-allow]').evaluate(el => {
        const r = el.getBoundingClientRect();
        return r.height > 0 && r.top >= 0 && r.bottom <= visualViewport!.height;
      })).toBe(true);
      const editing = await page.evaluate(() => (window as any).dynamicTypeGeometry());
      expect(editing.failures).toEqual([]);
      expect(await page.locator('[data-first-spend-keyboard-daily]').innerText()).toContain('1\u202f250\u202f500 msat');
    }
  });
}
for (const platform of ['desktop', 'android']) test(`${platform} retains the original type and spacing`, async ({ page }) => {
  await openPreview(page, `/docs/ui/u2b-dynamic-type/harness/preview.html?scene=chat&platform=${platform}`);
  const sizes = await page.evaluate(() => {
    const probe = document.createElement('span'); probe.style.cssText = 'font-size:var(--t-xs);padding:var(--s-2)'; document.body.append(probe);
    const hero = document.createElement('span'); hero.className = 'wallet-total'; document.body.append(hero);
    return { hero: getComputedStyle(hero).fontSize, body: getComputedStyle(document.body).fontSize, small: getComputedStyle(probe).fontSize, space: getComputedStyle(probe).paddingTop };
  });
  expect(sizes).toEqual({hero:'64px', body:'14px', small:'11.5px', space:'8px'});
});

for (const lang of ['en', 'da']) test(`AX5 maximum safe wallet amount fits: ${lang}`, async ({ page }) => {
  await openPreview(page, `/docs/ui/u2b-dynamic-type/harness/preview.html?scene=wallet&lang=${lang}&large-balance=1`);
  await page.addStyleTag({content: 'html[data-platform="ios"] { font-size: 53px; }'});
  await page.locator('[data-balance-total="9007199254740991"]').waitFor();
  const result = await page.evaluate(() => (window as any).dynamicTypeGeometry());
  expect(result.failures).toEqual([]);
});

for (const lang of ['en', 'da']) test(`iOS default wallet keeps its 64px headline: ${lang}`, async ({ page }) => {
  await openPreview(page, `/docs/ui/u2b-dynamic-type/harness/preview.html?scene=wallet&lang=${lang}`);
  await page.addStyleTag({ content: 'html[data-platform="ios"] { font-size: 17px; }' });
  await expect(page.locator('.wallet-total')).toHaveCSS('font-size', '64px');
});

for (const lang of ['en', 'da']) test(`AX5 connection status is fully visible: ${lang}`, async ({ page }) => {
  await openPreview(page, `/docs/ui/u2b-dynamic-type/harness/preview.html?scene=chat&lang=${lang}`);
  await page.addStyleTag({ content: 'html[data-platform="ios"] { font-size: 53px; }' });
  const pill = page.locator('.node-pill .what');
  await expect(pill).toBeVisible();
  expect(await pill.evaluate(el => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  await expect(pill).toHaveCSS('white-space', 'normal');
  const wordLines = await pill.evaluate(el => {
    const text = el.firstChild!;
    return [...text.textContent!.matchAll(/\S+/g)].map(match => {
      const range = document.createRange(); range.setStart(text, match.index!); range.setEnd(text, match.index! + match[0].length);
      return new Set([...range.getClientRects()].map(r => r.top)).size;
    });
  });
  expect(wordLines.every(lines => lines === 1)).toBe(true);
});

test('AX5 receipt preserves digit runs in a narrow flex row', async ({ page }) => {
  await openPreview(page, '/docs/ui/u2b-dynamic-type/harness/preview.html?scene=chat');
  await page.addStyleTag({ content: 'html[data-platform="ios"] { font-size: 53px; }' });
  const lines = await page.evaluate(() => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;width:240px';
    const receipt = document.createElement('span'); receipt.className = 'money-text';
    receipt.textContent = 'paid 1234567890123 sats · network fee 123456 sats';
    const sibling = document.createElement('span'); sibling.style.cssText = 'width:100px;flex-shrink:0';
    row.append(receipt, sibling); document.body.append(row);
    const text = receipt.firstChild!;
    return [...text.textContent!.matchAll(/[0-9]+/g)].map(match => {
      const range = document.createRange(); range.setStart(text, match.index!); range.setEnd(text, match.index! + match[0].length);
      return new Set([...range.getClientRects()].map(r => r.top)).size;
    });
  });
  expect(lines).toEqual([1, 1]);
});

for (const lang of ['en', 'da']) for (const rootSize of [17, 53]) for (const fallback of [false, true]) test(`keyboard actions stay still while Allow enables: ${lang} ${rootSize}px fallback=${fallback}`, async ({ page }) => {
  await openPreview(page, `/docs/ui/u2b-dynamic-type/harness/preview.html?scene=first-spend&lang=${lang}`);
  await page.addStyleTag({ content: `html[data-platform="ios"] { font-size: ${rootSize}px; }` });
  if (fallback) {
    // Activate the shipped legacy rules on modern WebKit. This verifies their
    // layout, not execution on an older OS (native evidence uses iOS 27).
    const css = await page.evaluate(() => [...document.styleSheets].flatMap(sheet => [...sheet.cssRules])
      .filter(rule => rule instanceof CSSSupportsRule && rule.conditionText === 'not (container-type: inline-size)')
      .map(rule => [...(rule as CSSSupportsRule).cssRules].map(child => child.cssText).join('\n')).join('\n'));
    expect(css).not.toBe('');
    await page.addStyleTag({ content: css });
  }
  const input = page.locator('[data-first-spend-amount]');
  await expect(input).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 482 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await input.focus();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const measure = () => page.evaluate(() => ({
    scroll: document.querySelector('[data-first-spend-sheet]')!.scrollTop,
    actions: [...document.querySelectorAll('[data-first-spend-allow], [data-first-spend-cancel]')].map(el => {
      const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height };
    }),
  }));
  const before = await measure();
  expect(before.actions[0].top).toBeGreaterThanOrEqual(0);
  expect(before.actions[0].bottom).toBeLessThanOrEqual(482);
  if (rootSize === 17) expect(before.actions[1].bottom).toBeLessThanOrEqual(482);
  await expect(page.locator('[data-first-spend-allow]')).toBeDisabled();
  for (const value of ['1250', '1250.5', '1250']) {
    await input.fill(value);
    await expect(page.locator('[data-first-spend-allow]')).toBeEnabled();
    expect(await measure()).toEqual(before);
  }
});
