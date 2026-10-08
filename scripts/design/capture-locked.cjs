// The locked-node screen after a power cut, with and without a password
// remembered on this device. Stubbed host, dev server on :1420.
//   OUT=design/after/x PLAYWRIGHT_DIR=... node scripts/design/capture-locked.cjs
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_DIR || 'playwright');
const BASE = process.env.BASE || 'http://localhost:1420';
const OUT = process.env.OUT || path.join(__dirname, '..', '..', 'design', 'after');
fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const browser = await chromium.launch();
  for (const theme of ['dark', 'light']) {
    for (const remembered of [false, true]) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, colorScheme: theme });
      await ctx.addInitScript(([t, r]) => {
        try { localStorage.setItem('bitsov.theme', t); if (r) localStorage.setItem('bitsov.unlock.remembered.v1', '1'); } catch {}
        window.__TAURI_INTERNALS__ = {
          invoke: (cmd) => {
            if (cmd === 'node_status') return Promise.resolve({ ready: false, locked: true, typed_unlock_supported: true, unlock_state: 'ready', node_id: 'ab'.repeat(32), error: null });
            if (cmd === 'pairing_status') return Promise.resolve({ remote: true, state: 'paired', scopes: ['read'], short_code: null, code_from_node: false, reason: null, bootstrap: null });
            return Promise.reject(new Error('stub: ' + cmd));
          },
          transformCallback: () => 0,
        };
      }, [theme, remembered]);
      const page = await ctx.newPage();
      await page.goto(BASE + '/', { waitUntil: 'networkidle' });
      await page.waitForTimeout(900);
      await page.screenshot({ path: path.join(OUT, `locked-${remembered ? 'remembered' : 'typed-first'}-${theme}.png`) });
      await ctx.close();
    }
  }
  await browser.close();
  console.log('done');
})();
