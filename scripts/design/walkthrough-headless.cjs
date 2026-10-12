// Headless scenario walkthrough: every user scenario the renderer can play
// without a node, timed in headless Chromium. Sample mode (?sample) for the
// running app, a stubbed host for first run, offline, unlock and pairing.
// No window, no node, no network beyond the dev server, no money.
//
// It measures the UI only:
//   feedback = click → first DOM change anywhere (MutationObserver)
//   done     = click → the scenario's end state
// Sample mode answers instantly (AI reads add a fixed 350 ms), so node,
// Lightning and peer time are NOT in these numbers; the scorecard adds the
// traced round trips next to them and says "unmeasured" for the rest.
//   OUT=design/ux/walkthrough PLAYWRIGHT_DIR=... node scripts/design/walkthrough-headless.cjs
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_DIR || 'playwright');
const BASE = process.env.BASE || 'http://localhost:1420';
const OUT = process.env.OUT || path.join(__dirname, '..', '..', 'design', 'ux', 'walkthrough');
const RUNS = Number(process.env.RUNS || 5);
fs.mkdirSync(OUT, { recursive: true });

/** Run `act` in the page and time first DOM change and `done()` (both in ms from the act). */
async function measure(page, act, done, timeout = 8000) {
  return page.evaluate(async ({ act, done, timeout }) => {
    const run = new Function(act);
    const finished = new Function(`return (${done});`);
    let first = null;
    const t0 = performance.now();
    const mo = new MutationObserver(() => { if (first === null) first = performance.now() - t0; });
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    run();
    let end = null;
    while (performance.now() - t0 < timeout) {
      if (finished()) { end = performance.now() - t0; break; }
      await new Promise((r) => requestAnimationFrame(() => r()));
    }
    mo.disconnect();
    // An end state reached in the click's own frame is also its first feedback.
    if (first === null || (end !== null && end < first)) first = end;
    return { feedback: first === null ? null : Math.round(first), done: end === null ? null : Math.round(end) };
  }, { act, done, timeout });
}

const $ = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const click = (sel) => `${$(sel)}.click();`;
const clickText = (sel, text) => `[...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.textContent.includes(${JSON.stringify(text)})).click();`;
const fill = (sel, value) => `(() => { const e = ${$(sel)}; e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('input', { bubbles: true })); })();`;

/** Host stub for the not-yet-running states. */
const stubHost = ([status, pairing, extra]) => {
  window.__stub = { status, pairing, extra };
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd, args) => {
      const s = window.__stub;
      if (cmd === 'node_status') return Promise.resolve(s.status);
      if (cmd === 'pairing_status') return Promise.resolve(s.pairing);
      if (cmd === 'device_key_status') return Promise.resolve({ available: true, state: 'none', fingerprint: null, owner_action: null, expires_at_ms: null });
      if (cmd in (s.extra || {})) return Promise.resolve(typeof s.extra[cmd] === 'function' ? s.extra[cmd](args) : s.extra[cmd]);
      return Promise.reject(new Error('stub: ' + cmd));
    },
    transformCallback: () => 0,
  };
};
const PAIRED = { remote: false, state: 'paired', scopes: ['read', 'receive'], short_code: 'ABCD-EFGH', code_from_node: true, reason: null, bootstrap: null };

// Each scenario: [id, label, url, setup(page) before the timed act, act JS, done JS, stub?]
const scenarios = [
  ['boot-first-run', 'First run: app start → setup on screen', 'first-run', null, null, null],
  ['boot-app', 'Running app: start → chat ready', 'app', null, null, null],
  ['send', 'Send a message (sample; approval card first)', '?sample',
    async (p) => { await p.waitForSelector('[data-composer] textarea'); await p.evaluate(fill('[data-composer] textarea', 'walkthrough message')); await p.waitForTimeout(300); },
    click('[data-send]'),
    `!!document.querySelector('[data-composer-note]')?.textContent || [...document.querySelectorAll('.msg.out .bubble')].some((b) => b.textContent === 'walkthrough message') || !!document.querySelector('[data-approval]')`],
  ['approve-budget', 'Approve the daily budget (one tap)', '?sample',
    async (p) => { await p.waitForSelector('[data-preset]'); },
    click('[data-preset="everyday"]'),
    `document.querySelector('[data-preset="everyday"]')?.getAttribute('aria-checked') === 'true'`],
  ['contact', 'Open a contact', '?sample', async (p) => { await p.waitForSelector('[data-contact-open]'); }, click('[data-contact-open]'), `!!document.querySelector('[data-contact-panel], .contact-panel, [aria-label^="Contact"] h2')`],
  ['switch-chat', 'Switch to another chat', '?sample', async (p) => { await p.waitForSelector('[data-track^="peer:"]'); },
    `document.querySelectorAll('[data-track^="peer:"]')[1].click();`, `document.querySelectorAll('[data-track^="peer:"]')[1].getAttribute('aria-current') === 'true' && !!document.querySelector('[data-composer] textarea')`],
  ['call', 'Start a call (sample: no peer media)', '?sample', async (p) => { await p.waitForFunction(() => !document.querySelector('[data-call="audio"]')?.disabled); }, click('[data-call="audio"]'), `!!document.querySelector('[data-call-panel]')`],
  ['more-pay', 'Composer: More → Pay', '?sample', async (p) => { await p.waitForSelector('[aria-label="More: attach, pay, request"]'); await p.click('[aria-label="More: attach, pay, request"]'); }, click('[data-composer-mode="pay"]'), `!!document.querySelector('[data-pay-invoice], [data-composer][data-mode="pay"]')`],
  ['request', 'Request: amount → Create invoice → QR', '?sample',
    async (p) => { await p.click('[aria-label="More: attach, pay, request"]'); await p.click('[data-composer-mode="request"]'); await p.waitForSelector('[data-composer][data-mode="request"]'); await p.fill('[data-request-amount]', '21'); await p.waitForTimeout(200); },
    click('[data-send]'), `!!document.querySelector('[data-artifact="invoice"]')`],
  ['file', 'Attach a file → price shown', '?sample',
    async (p) => { await p.click('[aria-label="More: attach, pay, request"]'); const [chooser] = await Promise.all([p.waitForEvent('filechooser'), p.click('[data-composer-mode="file"]')]); await chooser.setFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') }); },
    `void 0;`, `!!document.querySelector('[data-composer][data-mode="file"]') && (document.querySelector('[data-composer]')?.textContent || '').includes('note.txt')`],
  ['wallet', 'You → Wallet', '?sample', async (p) => { await p.click('[aria-label="You: wallet, profile and settings"]'); await p.waitForSelector('[data-open-wallet]'); }, click('[data-open-wallet]'), `!!document.querySelector('[data-wallet-page]')`],
  ['wallet-receive', 'Wallet → Receive tab', '?sample', async (p) => { await p.click('[aria-label="You: wallet, profile and settings"]'); await p.click('[data-open-wallet]'); await p.waitForSelector('[data-wallet-tab]'); }, `document.querySelectorAll('[data-wallet-tab]')[2].click();`, `document.querySelectorAll('[data-wallet-tab]')[2].getAttribute('aria-selected') === 'true'`],
  ['settings', 'You → Profile and settings', '?sample', async (p) => { await p.click('[aria-label="You: wallet, profile and settings"]'); await p.waitForSelector('[data-open-settings]'); }, click('[data-open-settings]'), `!!document.querySelector('.settings-head')`],
  ['devices', 'Settings → Devices (add a device)', '?sample', async (p) => { await p.click('[aria-label="You: wallet, profile and settings"]'); await p.click('[data-open-settings]'); await p.waitForSelector('[data-tab="devices"]'); }, click('[data-tab="devices"]'), `document.querySelector('[data-tab="devices"]').getAttribute('aria-selected') === 'true'`],
  ['ai-open', 'Open Ask your node', '?sample', async (p) => { await p.waitForSelector('[data-track="ai"]'); }, click('[data-track="ai"]'), `!!document.querySelector('.ai-hero-card')`],
  ['ai-ask', 'Ask your node: a suggested question → answer', '?sample', async (p) => { await p.click('[data-track="ai"]'); await p.waitForSelector('.ai-hero-card'); }, `document.querySelector('.ai-hero-card').click();`, `!!document.querySelector('[data-ai-answer]:not([data-ai-answer="reading"])')`],
  ['new', '+ New (node id, intro card, starter bitcoin)', '?sample', async (p) => { await p.waitForSelector('[data-track="new"]'); }, click('[data-track="new"]'), `document.querySelector('[data-track="new"]').getAttribute('aria-current') === 'true'`],
  // Stubbed host: the not-yet-running states.
  ['offline', 'Offline: Retry now → back', 'stub-offline', async (p) => { await p.waitForSelector('[data-node-offline] button'); },
    `window.__stub.status = { ready: false, node_id: null, error: null }; window.__stub.extra.pairing_retry = window.__stub.pairing; document.querySelector('[data-node-offline] button').click();`, `!document.querySelector('[data-node-offline]')`],
  ['unlock', 'Unlock with typed password', 'stub-locked', async (p) => { await p.waitForSelector('[data-node-locked] input[type="password"]'); await p.fill('[data-node-locked] input[type="password"]', 'chosen password'); },
    `window.__stub.extra.node_unlock_password = () => { window.__stub.status = { ready: true, node_id: 'ab'.repeat(33), error: null }; return null; }; [...document.querySelectorAll('[data-node-locked] button')].find((b) => /Unlock with password/.test(b.textContent)).click();`, `!document.querySelector('[data-node-locked]')`],
  ['pair-review', 'Paste a pairing link → Review', 'stub-remote', async (p) => {
    const adv = p.locator('.node-target-advanced > summary'); if (await adv.isVisible()) await adv.click();
    await p.click('[data-target="network"]'); await p.fill('[data-remote-access] input', 'bitsov://pair/eyJ2IjoxfQ_sample'); },
    `[...document.querySelectorAll('[data-remote-access] button')].find((b) => /Review pairing ticket/.test(b.textContent)).click();`, `!!document.querySelector('[data-remote-preview], [data-remote-access] [role="alert"], [data-remote-access] .err-note')`],
];

const stubs = {
  'first-run': [{ ready: false, node_id: null, error: null }, { ...PAIRED, state: 'pairing' }, {}],
  'stub-offline': [{ ready: false, node_id: null, error: 'connection refused' }, PAIRED, {}],
  'stub-locked': [{ ready: false, node_id: 'ab'.repeat(33), error: null, locked: true, typed_unlock_supported: true, unlock_state: 'ready' }, PAIRED, {}],
  'stub-remote': [{ ready: true, node_id: 'ab'.repeat(33), error: null }, PAIRED, { remote_access_preview: () => ({ endpoint: '203.0.113.7:8443', fingerprint: 'cafe'.repeat(8), hosted_by: null }) }],
};

const median = (xs) => { const v = xs.filter((x) => x !== null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };

(async () => {
  const browser = await chromium.launch();
  const results = [];
  for (const [id, label, url, setup, act, done] of scenarios) {
    const runs = [];
    let error = '';
    for (let i = 0; i < RUNS; i++) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, colorScheme: 'dark' });
      if (stubs[url]) await ctx.addInitScript(stubHost, stubs[url]);
      const page = await ctx.newPage();
      try {
        const target = stubs[url] ? '/' : url === 'app' ? '/?sample' : '/' + url;
        await page.goto(BASE + target, { waitUntil: 'domcontentloaded' });
        if (id.startsWith('boot-')) {
          await page.waitForSelector(id === 'boot-app' ? '[data-composer] textarea' : '.onboarding h1', { timeout: 15000 });
          const t = await page.evaluate(() => Math.round(performance.now()));
          runs.push({ feedback: null, done: t });
        } else {
          await page.waitForLoadState('networkidle');
          await page.waitForTimeout(400);
          await setup(page);
          runs.push(await measure(page, act, done));
        }
        if (i === 0) await page.screenshot({ path: path.join(OUT, `${id}.png`) });
      } catch (e) { error = String(e).split('\n')[0]; runs.push({ feedback: null, done: null }); }
      await ctx.close();
    }
    const r = { id, label, runs: RUNS, feedback_ms: median(runs.map((x) => x.feedback)), done_ms: median(runs.map((x) => x.done)), ok: runs.every((x) => x.done !== null), error };
    results.push(r);
    console.log(`${r.ok ? 'PASS' : 'FAIL'} ${id.padEnd(15)} feedback ${String(r.feedback_ms ?? '-').padStart(5)} ms · done ${String(r.done_ms ?? '-').padStart(5)} ms ${r.error}`);
  }
  await browser.close();
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ at: new Date().toISOString(), base: BASE, runs_each: RUNS, viewport: '1280x820', results }, null, 2));
})();
