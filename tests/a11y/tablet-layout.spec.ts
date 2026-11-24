import { expect, test, type Page } from '@playwright/test';
import { PHONE_SHELL_PREVIEW } from './phoneShellPreview';

// iPad-sized windows, through the phone-shell preview page. An iPad is an iOS platform; above 680 px
// wide it gets the desktop rail, below it the phone tabs (src/control/PhoneShell.tsx). On a touch
// screen every visible control is a 44 px touch target of its own (no overlapping tap layers);
// with a mouse the rail keeps its compact rows and Send its compact size.
const IPAD_UA =
  'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const SIZES = [
  { name: 'portrait', width: 744, height: 1133 },
  { name: 'portrait', width: 768, height: 1024 },
  { name: 'landscape', width: 1024, height: 768 },
  { name: 'portrait', width: 820, height: 1180 },
  { name: 'landscape', width: 1180, height: 820 },
  { name: 'portrait', width: 1024, height: 1366 },
  { name: 'landscape', width: 1366, height: 1024 },
] as const;

async function open(page: Page, width: number, height: number, lang: 'en' | 'da') {
  await page.setViewportSize({ width, height });
  // The preview page runs the app's control center with a stub runtime
  // and data-platform=ios (preview.tsx beside it).
  await page.goto(`${PHONE_SHELL_PREVIEW}?scene=list&lang=${lang}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
}

/**
 * Problems with the controls as touch targets: under 44 px either way, not hit at their own
 * centre (something else would take the tap), or overlapping another visible control's box.
 * Collapsed groups are opened first; controls scrolled under a sticky edge are checked again once
 * scrolled into view. Text links
 * inside a sentence (p, li, a hint, a message stamp) are text, not targets.
 */
const targetProblems = (page: Page) => page.evaluate(() => {
  // Open every collapsed group first, so its rows are measured too.
  for (const d of document.querySelectorAll('details')) d.open = true;
  const controls = [...document.querySelectorAll<HTMLElement>('button, a[href], summary, [role="button"]')]
    .filter((el) => el.checkVisibility({ visibilityProperty: true }))
    .filter((el) => !(el.matches('button.link, a[href]') && el.closest('p, li, .hint, .stamp')));
  const label = (el: HTMLElement) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ').join('.')} '${(el.textContent ?? '').trim().slice(0, 18)}'`;
  const hitAtCentre = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
    const hit = document.elementFromPoint(x, y);
    return !!hit && (hit === el || el.contains(hit));
  };
  const problems: string[] = [];
  for (const el of controls) {
    const r = el.getBoundingClientRect();
    if (r.width < 44 || r.height < 44) problems.push(`${label(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  // Pass 1, as laid out: the controls a finger can reach now must not overlap each other.
  const visible = controls.filter(hitAtCentre).map((el) => ({ el, r: el.getBoundingClientRect() }));
  for (let a = 0; a < visible.length; a++) for (let b = a + 1; b < visible.length; b++) {
    const p = visible[a], q = visible[b];
    if (p.el.contains(q.el) || q.el.contains(p.el)) continue;
    const w = Math.min(p.r.right, q.r.right) - Math.max(p.r.left, q.r.left);
    const h = Math.min(p.r.bottom, q.r.bottom) - Math.max(p.r.top, q.r.top);
    if (w > 0.5 && h > 0.5) problems.push(`${label(p.el)} overlaps ${label(q.el)}`);
  }
  // Pass 2: every other control, once scrolled into view, is hit at its own centre.
  for (const el of controls.filter((el) => !visible.some((v) => v.el === el))) {
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    if (!hitAtCentre(el)) problems.push(`${label(el)} is covered at its centre`);
  }
  return problems;
});

test.describe('touch', () => {
  test.use({ userAgent: IPAD_UA, hasTouch: true, isMobile: true });
  for (const size of SIZES) {
    for (const lang of ['en', 'da'] as const) {
      test(`iPad ${size.name} ${size.width}x${size.height}, ${lang}: fits, keeps the message box in view, and every control is a 44 px target`, async ({ page }) => {
        await open(page, size.width, size.height, lang);
        expect(await page.evaluate(() => document.documentElement.dataset.platform)).toBe('ios');
        expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'a touch screen').toBe(true);

        // Nothing scrolls sideways.
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, 'horizontal overflow in px').toBeLessThanOrEqual(1);

        // Open the first chat; its message box is whole and on screen.
        await page.locator('[data-track^="peer:"]').first().click();
        const composer = page.locator('section.track .composer').first();
        await expect(composer).toBeVisible();
        const box = await composer.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(size.width + 1);
        expect(box!.y + box!.height).toBeLessThanOrEqual(size.height + 1);

        // Every visible control, rail and open chat alike, is a 44 px touch target of its own:
        // hit at its centre and overlapping no other control.
        expect(await targetProblems(page)).toEqual([]);

        // A short contact name keeps a 44 px wide title button.
        const title = page.locator('section.track .track-head > .track-title-btn').first();
        await title.locator('h1').evaluate((h) => { h.textContent = 'Al'; });
        expect((await title.boundingBox())!.width, 'short title width').toBeGreaterThanOrEqual(44);
      });
    }
  }
});

test.describe('mouse', () => {
  test.use({ hasTouch: false, isMobile: false });
  test('1024x768 with a mouse: the rail keeps its compact rows', async ({ page }) => {
    await open(page, 1024, 768, 'en');
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(false);
    const row = await page.locator('.rail .track-link').first().boundingBox();
    expect(row).not.toBeNull();
    expect(row!.height).toBeLessThan(44);
    await page.locator('[data-track^="peer:"]').first().click();
    const send = await page.locator('[data-composer-bar] .send-btn').first().boundingBox();
    expect(send!.height).toBeLessThan(44);
  });
});
