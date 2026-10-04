// Onboarding stages against a stubbed host (no node): node-location choice,
// pairing in progress, a remote choice with the pairing-link form, and the
// trust stage. Dev-only; needs the vite dev server on :1420.
//   OUT=design/after/x PLAYWRIGHT_DIR=... node scripts/design/capture-onboarding.cjs
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_DIR || 'playwright');
const BASE = process.env.BASE || 'http://localhost:1420';
const OUT = process.env.OUT || path.join(__dirname, '..', '..', 'design', 'after');
fs.mkdirSync(OUT, { recursive: true });

const pairing = (state, extra = {}) => ({ remote: false, state, scopes: state === 'paired' ? ['read', 'receive'] : [], short_code: null, code_from_node: false, reason: null, bootstrap: null, ...extra });
const stages = {
  'ob-1-starting': { status: { ready: false, node_id: null, error: null }, pairing: pairing('starting') },
  'ob-2-pairing': { status: { ready: true, node_id: 'ab'.repeat(33), error: null }, pairing: pairing('pending') },
  'ob-3-remote-choice': { status: { ready: false, node_id: null, error: null }, pairing: pairing('starting'), click: '[data-target="cloud"]' },
  'ob-4-trust': { status: { ready: true, node_id: 'ab'.repeat(33), error: null }, pairing: pairing('paired', { short_code: 'ABCD-EFGH', code_from_node: true }) },
  'ob-5-failed': { status: { ready: true, node_id: 'ab'.repeat(33), error: null }, pairing: pairing('failed', { reason: 'the node refused /pair/request (409): pairing is closed' }) },
};

(async () => {
  const browser = await chromium.launch();
  for (const theme of ['dark', 'light']) {
    for (const [name, st] of Object.entries(stages)) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, colorScheme: theme });
      await ctx.addInitScript(([t, st]) => {
        try { localStorage.setItem('bitsov.theme', t); } catch {}
        window.__TAURI_INTERNALS__ = {
          invoke: (cmd) => {
            if (cmd === 'node_status') return Promise.resolve(st.status);
            if (cmd === 'pairing_status') return Promise.resolve(st.pairing);
            if (cmd === 'device_key_status') return Promise.resolve({ available: true, state: 'none', fingerprint: null, owner_action: null, expires_at_ms: null });
            return Promise.reject(new Error('stub: ' + cmd));
          },
          transformCallback: () => 0,
        };
      }, [theme, st]);
      const page = await ctx.newPage();
      await page.goto(BASE + '/', { waitUntil: 'networkidle' });
      await page.waitForTimeout(900);
      if (st.click) { await page.click(st.click); await page.waitForTimeout(400); }
      await page.screenshot({ path: path.join(OUT, `${name}-${theme}.png`) });
      await ctx.close();
    }
  }
  await browser.close();
  console.log('done');
})();
