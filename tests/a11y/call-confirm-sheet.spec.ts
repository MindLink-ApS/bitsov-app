import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// The Ring confirmation on a phone: whatever the text size, Cancel and Ring are
// on screen inside the safe area and not covered, without scrolling. A long
// confirmation scrolls inside its sheet. Measured insets as in safe-areas.spec.ts.
const raw = readFileSync('src/styles.css', 'utf8').replaceAll("url('./assets/", "url('/src/assets/");
const PHONES = [
  { width: 320, height: 568, top: 20, right: 0, bottom: 0, left: 0 },
  { width: 393, height: 852, top: 59, right: 0, bottom: 34, left: 0 },
];
type Phone = typeof PHONES[number];
const withInsets = (phone: Phone) => raw.replace(/env\(safe-area-inset-(top|right|bottom|left)(?:,\s*0px)?\)/g,
  (_, edge: 'top' | 'right' | 'bottom' | 'left') => `${phone[edge]}px`);

// The node-routed confirmation, the longest one: price, minutes price, the hold, Details, network note.
const ROUTED = {
  en: ['Call Maya?', 'Up to 21 sats. Nothing is paid until you press Ring.', 'Then 10 sats a minute, plus up to 5 sats routing a minute, paid by your node while the call runs.',
    'Your node sets aside at most 3 600 sats for the minutes and gives back what is not used. If it would need more, it does not ring and nothing is paid. You confirm before the first minute is paid.',
    'Details', 'Calls use the network server chosen in Settings.', 'Cancel', 'Ring'],
  da: ['Ring til Maya?', 'Højst 21 sats. Intet betales, før du trykker Ring.', 'Derefter 10 sats pr. minut plus højst 5 sats i routing pr. minut, betalt af din node, mens opkaldet varer.',
    'Din node reserverer højst 3 600 sats til minutterne og giver det ubrugte tilbage. Skulle den bruge mere, ringer den ikke op, og der betales intet. Du bekræfter, før det første minut betales.',
    'Detaljer', 'Opkald bruger den netværksserver, der er valgt i Indstillinger.', 'Annullér', 'Ring'],
} as const;

async function inReach(page: Page, phone: Phone, selector: string) {
  const r = await page.locator(selector).evaluate((el) => {
    const b = el.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, height: b.height, own: !!hit && (hit === el || el.contains(hit)) };
  });
  expect(r.top).toBeGreaterThanOrEqual(phone.top - 0.5);
  expect(r.bottom).toBeLessThanOrEqual(phone.height - phone.bottom + 0.5);
  expect(r.left).toBeGreaterThanOrEqual(phone.left - 0.5);
  expect(r.right).toBeLessThanOrEqual(phone.width - phone.right + 0.5);
  expect(r.height).toBeGreaterThanOrEqual(44);
  // Nothing covers it: a tap at its centre lands on it.
  expect(r.own).toBe(true);
}

for (const phone of PHONES) for (const lang of ['en', 'da'] as const) for (const root of [16, 32, 53]) {
  test(`routed Ring confirmation keeps Cancel and Ring in reach: ${phone.width}x${phone.height}, ${lang}, ${root}px text`, async ({ page }) => {
    await page.setViewportSize({ width: phone.width, height: phone.height });
    const t = ROUTED[lang];
    await page.route('http://sheet.test/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.startsWith('/src/assets/')) return route.fulfill({ path: join(process.cwd(), path) });
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html lang="${lang}" data-platform="ios"><head>
        <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
        <style>${withInsets(phone)}</style><style>html[data-platform="ios"] { font-size: ${root}px; } *, *::before, *::after { animation: none !important; transition: none !important; }</style></head>
        <body><div class="track-head"><strong>Maya</strong><div class="call-buttons"><button type="button" class="soft call-button icon-btn" aria-label="Call">c</button>
        <div class="call-confirm" role="dialog" data-call-confirm-box="audio"><p class="call-confirm-text"><strong>${t[0]}</strong> <span class="hint">${t[1]}</span></p>
        <p class="hint">${t[2]}</p><p class="hint">${t[3]}</p><details class="quiet-detail"><summary>${t[4]}</summary><p class="hint">…</p></details><p class="hint">${t[5]}</p>
        <div class="call-confirm-actions"><button type="button" class="soft" data-call-confirm-cancel>${t[6]}</button><button type="button" class="primary soft money" data-call-confirm="audio">${t[7]}</button></div>
        </div></div></div></body></html>` });
    });
    await page.goto('http://sheet.test/');
    await page.evaluate(async () => { await Promise.all([...document.fonts].map((f) => f.load().catch(() => null))); await document.fonts.ready; });
    expect(await page.evaluate(() => document.fonts.check('16px Inter'))).toBe(true);
    await inReach(page, phone, '[data-call-confirm-cancel]');
    await inReach(page, phone, '[data-call-confirm="audio"]');
    const box = await page.locator('[data-call-confirm-box]').evaluate((el) => {
      const b = el.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, scrolls: el.scrollHeight > el.clientHeight + 1, overflowY: getComputedStyle(el).overflowY };
    });
    expect(box.top).toBeGreaterThanOrEqual(phone.top - 0.5);
    expect(box.bottom).toBeLessThanOrEqual(phone.height - phone.bottom + 0.5);
    // A confirmation taller than the screen scrolls inside its sheet; every word stays reachable.
    if (box.scrolls) expect(box.overflowY).toBe('auto');
  });
}

// The real shell (sample data): the sheet is placed by the app's own layout, not a fixture.
for (const phone of PHONES) for (const root of [17, 53]) {
  test(`app: Call opens a confirmation with Cancel and Ring in reach at ${phone.width}x${phone.height}, ${root}px text`, async ({ page }) => {
    await page.setViewportSize({ width: phone.width, height: phone.height });
    await page.goto('/?sample');
    await page.evaluate(() => { document.documentElement.dataset.platform = 'ios'; });
    await page.addStyleTag({ content: withInsets(phone) });
    await page.addStyleTag({ content: `html[data-platform='ios'] { font-size: ${root}px; } *, *::before, *::after { animation: none !important; transition: none !important; }` });
    await page.evaluate(() => document.fonts.ready);
    const call = page.locator('[data-call="audio"]');
    await expect(call).toBeEnabled({ timeout: 15_000 });
    await call.click();
    await expect(page.locator('[data-call-confirm-box="audio"]')).toBeVisible();
    await inReach(page, phone, '[data-call-confirm-cancel]');
    await inReach(page, phone, '[data-call-confirm="audio"]');
  });
}
