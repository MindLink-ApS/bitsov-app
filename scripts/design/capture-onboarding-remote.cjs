// Onboarding trust stage with the home-node choice open and a pairing link
// typed (the layout from the dry run). Stubbed host, dev server on :1420.
//   OUT=design/after/x PLAYWRIGHT_DIR=... node scripts/design/capture-onboarding-remote.cjs
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_DIR || 'playwright');
const BASE = process.env.BASE || 'http://localhost:1420';
const OUT = process.env.OUT || path.join(__dirname, '..', '..', 'design', 'after');
fs.mkdirSync(OUT, { recursive: true });
const status = { ready: true, node_id: 'ab'.repeat(33), error: null };
const pairing = { remote: false, state: 'paired', scopes: ['read', 'receive'], short_code: 'ABCD-EFGH', code_from_node: true, reason: null, bootstrap: null };
// Compact mode shows both pills without the fold; open it only when it is there.
const openAdvanced = async (p) => { const s = p.locator('.node-target-advanced > summary'); if (await s.isVisible()) await s.click(); };
const shots = [
  ['ob-r1-trust-local', async () => {}],
  ['ob-r2-advanced-open', async (p) => { await openAdvanced(p); }],
  ['ob-r3-home-chosen', async (p) => { await openAdvanced(p); await p.click('[data-target="network"]'); }],
  ['ob-r4-link-typed', async (p) => {
    await openAdvanced(p); await p.click('[data-target="network"]');
    await p.fill('[data-remote-access] input', 'bitsov://pair/abcDEF123');
    await p.locator('[data-remote-access]').scrollIntoViewIfNeeded();
  }],
];
(async () => {
  const browser = await chromium.launch();
  for (const theme of ['dark', 'light']) {
    for (const [name, act] of shots) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, colorScheme: theme });
      await ctx.addInitScript(([t, status, pairing]) => {
        try { localStorage.setItem('bitsov.theme', t); } catch {}
        window.__TAURI_INTERNALS__ = {
          invoke: (cmd) => {
            if (cmd === 'node_status') return Promise.resolve(status);
            if (cmd === 'pairing_status') return Promise.resolve(pairing);
            if (cmd === 'device_key_status') return Promise.resolve({ available: true, state: 'none', fingerprint: null, owner_action: null, expires_at_ms: null });
            return Promise.reject(new Error('stub: ' + cmd));
          },
          transformCallback: () => 0,
        };
      }, [theme, status, pairing]);
      const page = await ctx.newPage();
      await page.goto(BASE + '/', { waitUntil: 'networkidle' });
      await page.waitForTimeout(900);
      try { await act(page); } catch (e) { console.log(name, 'step failed:', String(e).split('\n')[0]); }
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(OUT, `${name}-${theme}.png`) });
      await ctx.close();
    }
  }
  await browser.close();
  console.log('done');
})();
