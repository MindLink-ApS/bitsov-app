// Offline node screen (#198): a remote box that does not answer (with a
// retry delay) and a local node that refuses connections. Stubbed host, dev
// server on :1420.
//   OUT=design/after/x PLAYWRIGHT_DIR=... node scripts/design/capture-offline.cjs
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_DIR || 'playwright');
const BASE = process.env.BASE || 'http://localhost:1420';
const OUT = process.env.OUT || path.join(__dirname, '..', '..', 'design', 'after');
fs.mkdirSync(OUT, { recursive: true });
const cases = [
  ['offline-box', { ready: false, node_id: null, error: 'remote unavailable', retry_after_secs: 20 }, true],
  ['offline-local', { ready: false, node_id: null, error: 'connection refused' }, false],
];
(async () => {
  const browser = await chromium.launch();
  for (const width of [1280, 390]) {
    for (const theme of ['dark', 'light']) {
      for (const [name, status, remote] of cases) {
        const ctx = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 820 }, colorScheme: theme, deviceScaleFactor: width === 390 ? 2 : 1 });
        await ctx.addInitScript(([t, status, remote]) => {
          try { localStorage.setItem('bitsov.theme', t); } catch {}
          const pairing = { remote, state: 'paired', scopes: ['read', 'receive'], short_code: 'ABCD-EFGH', code_from_node: true, reason: null, bootstrap: null };
          window.__TAURI_INTERNALS__ = {
            invoke: (cmd) => {
              if (cmd === 'node_status') return Promise.resolve(status);
              if (cmd === 'pairing_status') return Promise.resolve(pairing);
              if (cmd === 'trust_acknowledged') return Promise.resolve(true);
              return Promise.reject(new Error('stub: ' + cmd));
            },
            transformCallback: () => 0,
          };
        }, [theme, status, remote]);
        const page = await ctx.newPage();
        await page.goto(BASE + '/', { waitUntil: 'networkidle' });
        await page.waitForTimeout(900);
        await page.screenshot({ path: path.join(OUT, `${name}-${width}-${theme}.png`) });
        await ctx.close();
      }
    }
  }
  await browser.close();
  console.log('done');
})();
