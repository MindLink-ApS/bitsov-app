// First-run column widths: every first-run panel (onboarding, trust, owner
// ceremony, repair) at 1280 and 390 px, against a stubbed host. Run on main
// and on a branch and diff the output: the setup-steps wrapper must not change them.
//   PLAYWRIGHT_DIR=... node scripts/design/first-run-widths.cjs > widths.json
const { chromium } = require(process.env.PLAYWRIGHT_DIR || 'playwright');
const BASE = 'http://localhost:1420';
const PAIRED = { remote: false, state: 'paired', scopes: ['read', 'receive'], short_code: 'ABCD-EFGH', code_from_node: true, reason: null, bootstrap: null };
const cases = {
  starting: [{ ready: false, node_id: null, error: null }, { ...PAIRED, state: 'pairing' }],
  trust: [{ ready: true, node_id: 'ab'.repeat(33), error: null }, PAIRED],
  ceremony: [{ ready: false, node_id: null, error: null }, { ...PAIRED, remote: true, bootstrap: 'bootstrap' }],
  repair: [{ ready: false, node_id: null, error: null, initialization_repair: 'required' }, PAIRED],
};
(async () => {
  const b = await chromium.launch(); const out = {};
  for (const [name, [status, pairing]] of Object.entries(cases)) for (const w of [1280, 390]) {
    const ctx = await b.newContext({ viewport: { width: w, height: 900 } });
    await ctx.addInitScript(([s, p]) => { window.__TAURI_INTERNALS__ = { invoke: (c) => c === 'node_status' ? Promise.resolve(s) : c === 'pairing_status' ? Promise.resolve(p) : c === 'device_key_status' ? Promise.resolve({ available: true, state: 'none' }) : Promise.reject(new Error(c)), transformCallback: () => 0 }; }, [status, pairing]);
    const page = await ctx.newPage(); await page.goto(BASE + '/', { waitUntil: 'networkidle' }); await page.waitForTimeout(900);
    out[`${name}@${w}`] = await page.evaluate(() => { const fr = document.querySelector('[data-first-run]'); if (!fr) return 'no first-run';
      const kids = [...fr.querySelectorAll(':scope > *, :scope > .setup-steps > *')].filter((e) => !e.classList.contains('setup-steps'));
      return kids.map((e) => `${e.tagName.toLowerCase()}.${(e.className || '').toString().split(' ')[0]}${e.dataset.remoteOwner !== undefined ? '[ceremony]' : ''}=${Math.round(e.getBoundingClientRect().width)}`).join(' '); });
    await ctx.close();
  }
  await b.close(); console.log(JSON.stringify(out, null, 1));
})();
