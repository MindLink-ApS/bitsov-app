import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';

const css = readFileSync('src/styles.css', 'utf8').replaceAll("url('./assets/", "url('/src/assets/");
const geometries = [
  { width: 375, height: 667, top: 0, right: 0, bottom: 0, left: 0 },
  { width: 430, height: 932, top: 59, right: 0, bottom: 34, left: 0 },
  { width: 932, height: 430, top: 0, right: 59, bottom: 21, left: 59 },
  // Also exercise the <=680px top-strip menu in landscape.
  { width: 667, height: 375, top: 0, right: 59, bottom: 21, left: 59 },
];
type Geometry = typeof geometries[number];

async function applyInsets(page: Page, geometry: Geometry, platform = 'ios') {
  await page.evaluate(value => { document.documentElement.dataset.platform = value; }, platform);
  const substituted = css.replace(/env\(safe-area-inset-(top|right|bottom|left)(?:,\s*0px)?\)/g,
    (_, edge: 'top' | 'right' | 'bottom' | 'left') => `${geometry[edge]}px`);
  expect(substituted).not.toContain('env(safe-area-inset-');
  await page.addStyleTag({ content: substituted });
  await page.evaluate(() => document.fonts.ready);
}

async function settle(element: Locator) {
  await element.evaluate(async el => {
    await Promise.all(el.getAnimations().map(animation => animation.finished));
  });
}

async function insideSafeArea(element: Locator, geometry: Geometry) {
  await settle(element);
  const rect = (await element.boundingBox())!;
  expect(rect).not.toBeNull();
  expect(rect.x).toBeGreaterThanOrEqual(geometry.left);
  expect(rect.x + rect.width).toBeLessThanOrEqual(geometry.width - geometry.right);
  expect(rect.y).toBeGreaterThanOrEqual(geometry.top);
  expect(rect.y + rect.height).toBeLessThanOrEqual(geometry.height - geometry.bottom);
}

async function reachable(element: Locator, panel: Locator, geometry: Geometry) {
  await element.scrollIntoViewIfNeeded();
  await insideSafeArea(element, geometry);
  const rect = (await element.boundingBox())!;
  const card = (await panel.boundingBox())!;
  expect(rect.y).toBeGreaterThanOrEqual(card.y);
  expect(rect.y + rect.height).toBeLessThanOrEqual(card.y + card.height);
  expect(await element.evaluate(el => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return hit === el || el.contains(hit);
  })).toBe(true);
}

for (const geometry of geometries) {
  const size = `${geometry.width}x${geometry.height}`;
  test(`You menu respects safe edges ${size}`, async ({ page }, info) => {
    await page.setViewportSize(geometry);
    await page.goto('/?sample', { waitUntil: 'networkidle' });
    await applyInsets(page, geometry);
    await page.locator('.profile-avatar').click();
    const menu = page.locator('.avatar-menu');
    await expect(menu).toBeVisible();
    await insideSafeArea(menu, geometry);
    for (const item of await menu.getByRole('menuitem').all()) {
      await reachable(item, menu, geometry);
    }
    await page.screenshot({ path: info.outputPath(`you-menu-${size}.png`) });
  });

  test(`12-contact planner and primary actions remain reachable ${size}`, async ({ page }, info) => {
    await page.setViewportSize(geometry);
    // Sample data has no node/host calls. Open the planner, never invite anyone.
    await page.goto('/?sample&peers=12', { waitUntil: 'networkidle' });
    await applyInsets(page, geometry);
    await page.locator('[data-call="meeting"]').click();
    const panel = page.locator('[data-meeting-panel="planning"]');
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-meeting-pick]')).toHaveCount(12);
    await insideSafeArea(panel, geometry);
    // Sample mode has no meeting capability, so focus lands on Cancel and
    // scrolls to the bottom. Both ends of the panel must remain reachable.
    await panel.locator('header').scrollIntoViewIfNeeded();
    await insideSafeArea(panel.locator('header'), geometry);
    expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`planner-${size}-top.png`) });
    for (const pick of await panel.locator('[data-meeting-pick]').all()) {
      await reachable(pick, panel, geometry);
    }
    for (const selector of ['[data-meeting-invite]', '[data-meeting-invite-video]', '[data-meeting-cancel]']) {
      await reachable(panel.locator(selector), panel, geometry);
    }
    await page.screenshot({ path: info.outputPath(`planner-${size}-actions.png`) });
  });

  test(`call card and actions stay inside safe edges ${size}`, async ({ page }, info) => {
    await page.setViewportSize(geometry);
    await page.goto('/tests/fixtures/safe-areas.html?surface=call');
    await applyInsets(page, geometry);
    const panel = page.locator('.call-panel');
    await insideSafeArea(panel, geometry);
    await insideSafeArea(panel.locator('header'), geometry);
    expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    // Inert fixture: inspect/scroll only; no call or payment action is invoked.
    await expect(panel.locator('.call-actions button')).toHaveCount(2);
    for (const action of await panel.locator('.call-actions button').all()) {
      await action.scrollIntoViewIfNeeded();
      await insideSafeArea(action, geometry);
    }
    await page.screenshot({ path: info.outputPath(`call-${size}.png`) });
  });
}

// A real DOM regression test: Happy DOM drops max() in inset declarations,
// so check the resolved offset in the browser with the production stylesheet.
for (const platform of ['ios', 'android', 'desktop', undefined]) {
  test(`DOM You menu right inset is platform gated (${platform ?? 'unset'})`, async ({ page }) => {
    const geometry = geometries[3];
    await page.setViewportSize(geometry);
    await page.goto('/?sample', { waitUntil: 'networkidle' });
    await applyInsets(page, geometry, platform);
    if (!platform) await page.evaluate(() => { delete document.documentElement.dataset.platform; });
    await page.locator('.profile-avatar').click();
    const menu = page.locator('.avatar-menu');
    await settle(menu);
    const mobile = platform === 'ios' || platform === 'android';
    expect(await menu.evaluate(el => getComputedStyle(el).right)).toBe(mobile ? '59px' : '12px');
    const bounds = (await menu.boundingBox())!;
    expect(bounds.x + bounds.width).toBe(mobile ? 608 : 655);
  });
}

for (const width of [375, 667, 932, 1280]) {
  test(`desktop You menu geometry is unchanged at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 667 });
    await page.goto('/?sample', { waitUntil: 'networkidle' });
    await page.locator('.profile-avatar').click();
    const menu = page.locator('.avatar-menu');
    await settle(menu);
    const before = await menu.boundingBox();
    await applyInsets(page, { width, height: 667, top: 0, right: 59, bottom: 21, left: 59 }, 'desktop');
    await settle(menu);
    expect(await menu.boundingBox()).toEqual(before);
    if (width <= 680) expect(await menu.evaluate(el => getComputedStyle(el).right)).toBe('12px');
  });
}
