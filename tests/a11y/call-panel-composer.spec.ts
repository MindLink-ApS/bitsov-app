import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// The call card and the message composer, in the real app with sample data. The card is held at
// "Calling…" (below). The live card is that same card given what a live video call adds (the
// picture, Mute and Camera before Hang up): its height is what matters. With the card showing,
// Send, + and the microphone are each on top at their centre, Hang up is on top and in view, and
// the card never overlaps the composer.

// Placing a call asks for the microphone first. Headless browsers have none (Linux WebKit refuses
// at once) and the call would end before its card shows, so every run, Chrome and WebKit, gets the
// same fake one. With a microphone the call goes on to its offer, which sample data refuses: the
// call ends at once in WebKit, after the network wait in Chrome. So the offer is kept in the
// making, and the card stays at "Calling…" for as long as it is measured, with no timer racing it.
const FAKE_MEDIA = fileURLToPath(new URL('../fixtures/fake-media-init.js', import.meta.url));
test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: FAKE_MEDIA });
  await page.addInitScript(() => {
    const never = () => new Promise<never>(() => {});
    if (window.RTCPeerConnection) { RTCPeerConnection.prototype.createOffer = never; return; }
    // A browser build without WebRTC: just enough of a connection to reach the offer.
    (window as { RTCPeerConnection?: unknown }).RTCPeerConnection = class extends EventTarget {
      connectionState = 'new'; iceConnectionState = 'new'; iceGatheringState = 'new';
      addTrack() { return { replaceTrack: async () => {} }; }
      createOffer = never;
      close() {}
    };
  });
});

type Box = { left: number; top: number; right: number; bottom: number };
const SEND = '[data-composer-bar] .send-btn';
const PLUS = '[data-composer-plus]';
const MIC = '[data-voice-record]';

const boxOf = (page: Page, sel: string): Promise<Box> => page.locator(sel).first().evaluate((el) => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
});
const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
/** What the browser hit-tests at the centre of `sel`: true when it is `sel` itself or inside it. */
const onTop = (page: Page, sel: string) => page.locator(sel).first().evaluate((el) => {
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
  return !!hit && (hit === el || el.contains(hit));
});

async function composerClear(page: Page, state: string) {
  const panel = page.locator('[data-call-panel]').first();
  await expect(panel).toBeVisible();
  const card = await boxOf(page, '[data-call-panel]');
  for (const sel of [SEND, PLUS, MIC]) {
    expect.soft(await onTop(page, sel), `${state}: ${sel} is on top at its centre`).toBe(true);
    expect.soft(overlaps(card, await boxOf(page, sel)), `${state}: the card does not overlap ${sel}`).toBe(false);
  }
  expect.soft(overlaps(card, await boxOf(page, '[data-composer-bar]')), `${state}: the card does not overlap the composer`).toBe(false);
}

async function hangUpReachable(page: Page, state: string) {
  const hangup = page.locator('[data-call-hangup]');
  await expect(hangup).toBeVisible();
  expect.soft(await onTop(page, '[data-call-hangup]'), `${state}: hang up is on top at its centre`).toBe(true);
  const h = await boxOf(page, '[data-call-hangup]');
  const view = page.viewportSize()!;
  expect.soft(h.top, `${state}: hang up is in the window`).toBeGreaterThanOrEqual(0);
  expect.soft(h.bottom, `${state}: hang up is in the window`).toBeLessThanOrEqual(view.height);
  // In view inside the card too, not scrolled out of a tall card.
  const card = await boxOf(page, '[data-call-panel]');
  expect.soft(h.top).toBeGreaterThanOrEqual(card.top - 0.5);
  expect.soft(h.bottom).toBeLessThanOrEqual(card.bottom + 0.5);
  for (const sel of [SEND, PLUS, MIC]) expect.soft(overlaps(h, await boxOf(page, sel)), `${state}: hang up is not over ${sel}`).toBe(false);
}

/** The calling card with what a live video call adds before Hang up. */
const makeLive = (page: Page) => page.evaluate(() => {
  const panel = document.querySelector<HTMLElement>('[data-call-panel]')!;
  panel.dataset.callPanel = 'live';
  const actions = panel.querySelector<HTMLElement>('.call-actions')!;
  const videos = document.createElement('div');
  videos.className = 'call-videos';
  videos.innerHTML = '<div class="call-self" data-call-self><span class="call-self-label" data-call-self-label>You</span></div>';
  actions.before(videos);
  for (const [name, attr] of [['Camera', 'data-call-camera'], ['Mute', 'data-call-mute']]) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'soft'; b.textContent = name; b.setAttribute(attr, '');
    actions.prepend(b);
  }
});

async function ringFromHeader(page: Page) {
  await page.locator('[data-call=audio]').first().click();
  await page.locator('[data-call-confirm=audio]').click();
}

test.describe('desktop', () => {
  test.use({ isMobile: false, hasTouch: false });
  for (const lang of ['en', 'da'] as const) for (const [width, height] of [[1280, 800], [1280, 560], [820, 560]]) {
    test(`${lang} ${width}x${height}: the call card stays clear of Send, + and the microphone`, async ({ page }) => {
      await page.addInitScript((l) => { try { localStorage.setItem('bitsov.language', l); } catch { /* private mode */ } }, lang);
      await page.setViewportSize({ width, height });
      await page.goto('/?sample', { waitUntil: 'networkidle' });
      await page.locator('[data-track^="peer:"]').first().click();
      await expect(page.locator(SEND)).toBeVisible();
      // Sample data asks for spending approval first: the same card, with Approve.
      await ringFromHeader(page);
      await expect(page.locator('[data-call-approve]')).toBeVisible();
      await composerClear(page, 'approval');
      expect.soft(await onTop(page, '[data-call-approve]'), 'approval: Approve is on top at its centre').toBe(true);
      await page.locator('[data-call-approve]').click();
      await expect(page.locator('[data-call-approval]')).toHaveCount(0, { timeout: 10_000 });
      await ringFromHeader(page);
      await expect(page.locator('[data-call-panel="calling"]')).toBeVisible({ timeout: 10_000 });
      await composerClear(page, 'calling');
      await hangUpReachable(page, 'calling');
      await makeLive(page);
      await composerClear(page, 'live');
      await hangUpReachable(page, 'live');
    });
  }

  test('the call confirm keeps Tab inside it, and Escape closes it', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/?sample', { waitUntil: 'networkidle' });
    await page.locator('[data-track^="peer:"]').first().click();
    await page.locator('[data-call=audio]').first().click();
    const box = page.locator('[data-call-confirm-box]');
    const ring = page.locator('[data-call-confirm=audio]');
    const cancel = page.locator('[data-call-confirm-cancel]');
    // The cost line sits under a Details summary inside the confirm: Tab cycles Ring, Details, Cancel.
    const details = box.locator('summary');
    await expect(box).toBeVisible();
    await expect(details).toHaveCount(1);
    await expect(ring).toBeFocused();
    for (const next of [details, cancel, ring]) {
      await page.keyboard.press('Tab');
      await expect(box).toBeVisible();
      await expect(next).toBeFocused();
    }
    for (const previous of [cancel, details, ring, cancel]) {
      await page.keyboard.press('Shift+Tab');
      await expect(box).toBeVisible();
      await expect(previous).toBeFocused();
    }
    await page.keyboard.press('Escape');
    await expect(box).toHaveCount(0);
    await expect(page.locator('[data-call=audio]').first()).toBeFocused();
    // Nothing was placed.
    await expect(page.locator('[data-call-panel]')).toHaveCount(0);
  });
});

test.describe('phone shell', () => {
  test.use({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' });
  for (const lang of ['en', 'da'] as const) {
    test(`${lang} 360x740: the call card stays clear of Send, + and the microphone`, async ({ page }) => {
      // The phone preview refuses every approval, so its sample pairing already has the spend scope.
      await page.route('**/src/control/sample.ts*', async (route) => {
        const response = await route.fetch();
        await route.fulfill({ response, body: await response.text() + `
          const originalSampleSource = sampleSource;
          sampleSource = (opts) => {
            const source = originalSampleSource(opts);
            const pairing = source.pairingStatus;
            source.pairingStatus = async () => ({ ...await pairing(), scopes: ['read', 'receive', 'spend'] });
            return source;
          };
        ` });
      });
      await page.setViewportSize({ width: 360, height: 740 });
      await page.goto(`/docs/ui/u5-phone-shell/harness/preview.html?scene=spend-open&lang=${lang}`);
      await page.locator('[data-phone-list] [data-track^="peer:"]').first().click();
      await expect(page.locator(SEND)).toBeVisible();
      await ringFromHeader(page);
      await expect(page.locator('[data-call-panel="calling"]')).toBeVisible({ timeout: 10_000 });
      await composerClear(page, 'calling');
      await hangUpReachable(page, 'calling');
      await makeLive(page);
      await composerClear(page, 'live');
      await hangUpReachable(page, 'live');
    });
  }
});
