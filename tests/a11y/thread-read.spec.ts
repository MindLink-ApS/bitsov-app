import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1200, height: 800 }, isMobile: false, hasTouch: false });

for (const [language, warning] of [
  ['en', 'These messages could not be read yet. They show once your box is ready.'],
  ['da', 'Beskederne kunne ikke hentes endnu. De vises, når din boks er klar.'],
] as const) {
  test(`a not_ready history notice stays visible with a long cached chat (${language})`, async ({ page }) => {
    await page.addInitScript(language => localStorage.setItem('bitsov.language', language), language);
    await page.route('**/src/control/sample.ts*', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: await response.text() + `
        const originalSampleSource = sampleSource;
        sampleSource = (opts) => {
          const source = originalSampleSource({ ...opts, firstLiveMs: 1e9 });
          const peer = 'a'.repeat(64);
          const history = Array.from({ length: 80 }, (_, i) => ({
            id: 'history-' + i, kind: 0, sender: peer, recipient: SAMPLE_OWN_ID,
            timestamp: 1725000000000 + i * 1000,
            plaintext: 'Earlier message ' + i, payment_amount_msat: null,
          }));
          source.messages = async (id) => {
            if (id.toLowerCase() !== peer) return [];
            if (window.historyPending) return new Promise((resolve, reject) => { window.rejectHistory = reject; });
            return history;
          };
          return source;
        };
      ` });
    });
    await page.goto('/?sample');
    const messages = page.locator('[data-stream] [data-message]');
    await expect(messages).toHaveCount(80);
    await page.evaluate('window.historyPending = true');
    await page.locator('[data-track="peer:' + 'b'.repeat(64) + '"]').click();
    await page.locator('[data-track="peer:' + 'a'.repeat(64) + '"]').click();
    await page.waitForFunction('typeof window.rejectHistory === "function"');
    const stream = page.locator('[data-stream]');
    expect(await stream.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    await stream.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await page.evaluate('window.rejectHistory({ code: "not_ready", message: "" })');
    const notice = page.locator('[data-thread-not-read]');
    await expect(notice).toHaveText(warning);
    await expect(notice).toHaveAttribute('role', 'status');
    const uncovered = () => notice.evaluate(el => {
      const r = el.getBoundingClientRect();
      return [r.top + 1, r.bottom - 1].every(y => {
        const hit = document.elementFromPoint(r.left + r.width / 2, y);
        return hit === el || el.contains(hit);
      });
    });
    expect(await uncovered()).toBe(true);
    await expect(notice).toBeInViewport({ ratio: 1 });
    await stream.evaluate(el => { el.scrollTop = 0; });
    expect(await uncovered()).toBe(true);
    await expect(notice).toBeInViewport({ ratio: 1 });
    await expect(messages).toHaveCount(80);
  });
}
