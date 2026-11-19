import { expect, test, type Page } from '@playwright/test';

// The incoming and outgoing call sheet in the real app (sample data, the real
// stylesheet and fonts), on a desktop window and a phone-sized one, in English
// and Danish, at default and doubled text size, with reduced motion. The person
// is the dialog's name, the two choices are big and fully visible, nothing
// spills sideways, focus and Escape behave, and the ringing card stays still.
// The sample node cannot ring anyone: its call signal is held open, so an
// outgoing call stays at Calling, and an incoming offer is fed in as a live event.
const PATCH = `
const __sample = sampleSource;
sampleSource = (opts) => {
  const s = __sample({ ...opts, firstLiveMs: 1e9 });
  const onLive = s.onLive;
  s.onLive = (h) => { window.__live = h; return onLive(h); };
  s.callSignal = () => new Promise(() => {});
  s.pairingStatus = async () => ({ state: 'paired', scopes: ['read', 'receive', 'spend'], short_code: 'ABCD-EFGH', code_from_node: true, reason: null, remote: false, bootstrap: null });
  s.spendStatus = async () => ({ state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 600000, pending: null, window_ms: 600000 });
  window.__incoming = () => window.__live({ type: 'message', room_id: null, message: { id: 'ring-' + Date.now(), kind: 400, sender: 'a'.repeat(64), recipient: SAMPLE_OWN_ID,
    timestamp: Date.now(), plaintext: JSON.stringify({ v: 1, call_id: '0123456789abcdef0123456789abcdef', media: 'audio', sdp: 'v=0 offer' }), payment_amount_msat: 10000 } });
  return s;
};`;

const COPY = {
  en: { incoming: 'Incoming audio call', calling: 'Calling…', answer: 'Answer', decline: 'Decline', cancel: 'Cancel', quiet: 'Ringtone off. You can still answer or decline.' },
  da: { incoming: 'Indgående lydopkald', calling: 'Ringer op…', answer: 'Besvar', decline: 'Afvis', cancel: 'Annuller', quiet: 'Ringetonen er slået fra. Du kan stadig svare eller afvise.' },
} as const;
const SIZES = [['desktop', 1280, 800], ['phone', 360, 740]] as const;

async function open(page: Page, lang: 'en' | 'da', width: number, height: number, rootPx?: number) {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(([l, root]) => {
    try { localStorage.setItem('bitsov.language', l as string); } catch { /* private mode */ }
    // A silent stand-in microphone: the sheet is what is tested here, not capture.
    const ctx = new AudioContext();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ctx.createMediaStreamDestination().stream, enumerateDevices: async () => [] } });
    if (root) document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = `${root}px`; });
  }, [lang, rootPx ?? 0] as const);
  await page.route('**/src/control/sample.ts*', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()) + PATCH });
  });
  await page.goto('/?sample', { waitUntil: 'networkidle' });
  await page.waitForFunction('typeof window.__incoming === "function"');
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
}

/** Nothing in the sheet runs off to the side, and the given controls are whole and inside the window. */
async function fits(page: Page, sheet: string, controls: string[]) {
  const g = await page.locator(sheet).evaluate((el, sels) => {
    const r = el.getBoundingClientRect();
    return {
      panel: r.toJSON(), across: el.scrollWidth <= el.clientWidth + 1, vw: innerWidth,
      controls: sels.map((s) => { const c = el.querySelector(s)!; const b = c.getBoundingClientRect(); return { sel: s, box: b.toJSON(), cut: c.scrollWidth > c.clientWidth + 1 }; }),
    };
  }, controls);
  expect(g.across).toBe(true);
  expect(g.panel.left).toBeGreaterThanOrEqual(0);
  expect(g.panel.right).toBeLessThanOrEqual(g.vw);
  for (const c of g.controls) {
    expect(c.cut, c.sel).toBe(false);
    expect(c.box.height, c.sel).toBeGreaterThanOrEqual(48);
    expect(c.box.left, c.sel).toBeGreaterThanOrEqual(g.panel.left);
    expect(c.box.right, c.sel).toBeLessThanOrEqual(g.panel.right);
  }
  return g;
}

test.use({ isMobile: false, hasTouch: false });

for (const lang of ['en', 'da'] as const) for (const [form, width, height] of SIZES) {
  test(`incoming sheet, ${form} ${width}×${height}, ${lang}`, async ({ page }) => {
    const c = COPY[lang];
    await open(page, lang, width, height);
    await page.evaluate('window.__incoming()');
    const sheet = page.getByRole('dialog', { name: 'Maya' });
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute('data-call-panel', 'incoming');
    await expect(sheet.locator('[data-call-title]')).toHaveText(c.incoming);
    await expect(sheet).toBeFocused();
    const answer = sheet.getByRole('button', { name: c.answer, exact: true });
    const decline = sheet.getByRole('button', { name: c.decline, exact: true });
    await expect(answer).toBeEnabled();
    // Both choices are on screen without scrolling, whole, at least 48 px tall.
    await expect(answer).toBeInViewport({ ratio: 1 });
    await expect(decline).toBeInViewport({ ratio: 1 });
    const g = await fits(page, '[data-call-panel="incoming"]', ['[data-call-accept]', '[data-call-decline]']);
    // Green Answer, red Decline: different fills, each with its own word.
    const fills = await page.evaluate(() => ['[data-call-accept]', '[data-call-decline]'].map((s) => getComputedStyle(document.querySelector(s)!).backgroundColor));
    expect(fills[0]).not.toBe(fills[1]);
    // No price on the face of the card.
    expect(await sheet.evaluate((el) => {
      const copy = el.cloneNode(true) as Element;
      copy.querySelectorAll('details:not([open]) > :not(summary), .sr-only').forEach((n) => n.remove());
      return copy.textContent ?? '';
    })).not.toMatch(/\bsats?\b/i);
    // Reduced motion: the ringing card and Answer stay still.
    expect(await page.evaluate(() => ['[data-call-panel="incoming"]', '[data-call-accept]'].map((s) => getComputedStyle(document.querySelector(s)!).animationName))).toEqual(['none', 'none']);
    // A phone-sized window: the sheet fills the screen inside a 16 px edge.
    if (form === 'phone') {
      expect(Math.round(g.panel.left)).toBe(16);
      expect(Math.round(width - g.panel.right)).toBe(16);
      expect(g.panel.height).toBeGreaterThan(height * 0.8);
    }
    // Keyboard: Answer, then Decline (Option+Tab is WebKit's every-control Tab).
    await page.keyboard.press('Alt+Tab');
    await expect(answer).toBeFocused();
    await page.keyboard.press('Alt+Tab');
    await expect(decline).toBeFocused();
    // Escape quiets the ring; the sheet and both choices stay.
    await page.keyboard.press('Escape');
    await expect(sheet.locator('[data-call-ring-quiet]')).toHaveText(c.quiet);
    await expect(sheet).toHaveAttribute('data-call-panel', 'incoming');
    await expect(answer).toBeEnabled();
    await decline.click();
    await expect(page.locator('[data-call-panel="incoming"]')).toHaveCount(0);
  });

  test(`outgoing sheet, ${form} ${width}×${height}, ${lang}`, async ({ page }) => {
    const c = COPY[lang];
    await open(page, lang, width, height);
    await page.locator('[data-call="audio"]').first().click();
    const ring = page.locator('[data-call-confirm="audio"]');
    await expect(ring).toBeEnabled();
    await ring.click();
    const sheet = page.getByRole('dialog', { name: 'Maya' });
    await expect(sheet).toHaveAttribute('data-call-panel', 'calling');
    await expect(sheet.locator('[data-call-title]')).toHaveText(c.calling);
    const cancel = sheet.getByRole('button', { name: c.cancel, exact: true });
    await expect(cancel).toBeInViewport({ ratio: 1 });
    await fits(page, '[data-call-panel="calling"]', ['[data-call-hangup]']);
    // Escape never ends a call: it is still calling.
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveAttribute('data-call-panel', 'calling');
  });
}

for (const [form, width, height] of SIZES) {
  test(`doubled text: the incoming sheet scrolls rather than clipping, ${form}`, async ({ page }) => {
    await open(page, 'da', width, height, 32);
    await page.evaluate('window.__incoming()');
    const sheet = page.getByRole('dialog', { name: 'Maya' });
    await expect(sheet).toHaveAttribute('data-call-panel', 'incoming');
    const g = await sheet.evaluate((el) => ({
      across: el.scrollWidth <= el.clientWidth + 1,
      scrolls: el.scrollHeight <= el.clientHeight + 1 || getComputedStyle(el).overflowY === 'auto',
      bottom: el.getBoundingClientRect().bottom, vh: innerHeight,
    }));
    expect(g.across).toBe(true);
    expect(g.scrolls).toBe(true);
    expect(g.bottom).toBeLessThanOrEqual(g.vh);
    for (const sel of ['[data-call-accept]', '[data-call-decline]']) {
      await page.locator(sel).scrollIntoViewIfNeeded();
      await expect(page.locator(sel)).toBeInViewport({ ratio: 1 });
      expect(await page.locator(sel).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    }
  });
}
