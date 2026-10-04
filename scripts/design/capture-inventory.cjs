// Design inventory: walk the sample-mode app (no node, no host) and save a PNG
// per surface into design/inventory/. Dev-only tooling; needs the vite dev
// server on :1420 and Playwright resolvable via PLAYWRIGHT_DIR.
//   PLAYWRIGHT_DIR=/path/to/node_modules/playwright node scripts/design/capture-inventory.cjs
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_DIR || 'playwright');
const BASE = process.env.BASE || 'http://localhost:1420';
const OUT = process.env.OUT || path.join(__dirname, '..', '..', 'design', 'inventory');

const click = (page, sel) => page.locator(sel).first().click({ timeout: 3000 });
const text = (page, t) => page.getByText(t, { exact: false }).first().click({ timeout: 3000 });
const role = (page, r, name) => page.getByRole(r, { name }).first().click({ timeout: 3000 });

const steps = [
  ['01-onboarding-first-run', '?sample=first-run', async () => {}],
  ['02-onboarding-scrolled', '?sample=first-run', async (p) => { await p.locator('.track').first().evaluate((e) => e.scrollTo(0, 99999)); }],
  ['03-onboarding-cloud-choice', '?sample=first-run', async (p) => { await text(p, 'A cloud node'); }],
  ['05-welcome-home', '?sample&peers=0', async () => {}],
  ['10-chat-maya', '?sample', async () => {}],
  ['11-chat-emoji', '?sample', async (p) => { await role(p, 'button', 'Emoji'); }],
  ['12-chat-more-menu', '?sample', async (p) => { await role(p, 'button', 'More: attach, pay, request'); }],
  ['13-chat-cost-rules', '?sample', async (p) => { await click(p, '[data-composer-info] > summary'); }],
  ['14-chat-typed', '?sample', async (p) => { await p.getByPlaceholder('Message Maya').fill('Want to grab the deck before the call?'); }],
  ['15-chat-josh', '?sample', async (p) => { await text(p, 'Josh'); }],
  ['16-chat-unnamed', '?sample', async (p) => { await text(p, 'Unnamed contact'); }],
  ['17-chat-gamma', '?sample', async (p) => { await text(p, 'Gamma VM'); }],
  ['18-contact-panel', '?sample', async (p) => { await role(p, 'button', 'Contact Maya'); }],
  ['20-call-confirm', '?sample', async (p) => { await role(p, 'button', /^Call Maya/); }],
  ['21-video-confirm', '?sample', async (p) => { await role(p, 'button', /^Video call Maya/); }],
  ['22-meeting-plan', '?sample', async (p) => { await role(p, 'button', 'Start a meeting with Maya'); }],
  ['23-call-settings', '?sample', async (p) => { await role(p, 'button', 'Settings'); }],
  ['30-ai-ask-node', '?sample', async (p) => { await text(p, 'Ask your node'); }],
  ['31-browse-profiles', '?sample', async (p) => { await text(p, 'Profiles'); }],
  ['32-browse-porch', '?sample', async (p) => { await text(p, 'Porch'); }],
  ['33-new-menu', '?sample', async (p) => { await text(p, '+ New'); }],
  ['34-new-first', '?sample', async (p) => { await text(p, '+ New'); await p.getByRole('menuitem').first().click(); }],
  ['35-new-second', '?sample', async (p) => { await text(p, '+ New'); await p.getByRole('menuitem').nth(1).click(); }],
  ['36-node-pill', '?sample', async (p) => { await role(p, 'button', 'Node live'); }],
  ['40-you-menu', '?sample', async (p) => { await role(p, 'button', 'You: wallet, profile and settings'); }],
  ['41-wallet-page', '?sample', async (p) => { await role(p, 'button', 'You: wallet, profile and settings'); await p.getByRole('menuitem').first().click(); }],
  ['42-wallet-tab-2', '?sample', async (p) => { await role(p, 'button', 'You: wallet, profile and settings'); await p.getByRole('menuitem').first().click(); await p.locator('[data-wallet-tab]').nth(1).click(); }],
  ['43-wallet-tab-3', '?sample', async (p) => { await role(p, 'button', 'You: wallet, profile and settings'); await p.getByRole('menuitem').first().click(); await p.locator('[data-wallet-tab]').nth(2).click(); }],
  ['44-wallet-tab-4', '?sample', async (p) => { await role(p, 'button', 'You: wallet, profile and settings'); await p.getByRole('menuitem').first().click(); await p.locator('[data-wallet-tab]').nth(3).click(); }],
  ['45-wallet-tab-5', '?sample', async (p) => { await role(p, 'button', 'You: wallet, profile and settings'); await p.getByRole('menuitem').first().click(); await p.locator('[data-wallet-tab]').nth(4).click(); }],
  ['50-settings-body', '?sample', async (p) => { await role(p, 'button', 'You: wallet, profile and settings'); await p.getByRole('menuitem').nth(1).click(); }],
  ['51-settings-node', '?sample', async (p) => { await role(p, 'button', 'You: wallet, profile and settings'); await p.getByRole('menuitem').nth(1).click(); await click(p, '[data-tab="node"]'); }],
  ['52-settings-wallet', '?sample', async (p) => { await role(p, 'button', 'You: wallet, profile and settings'); await p.getByRole('menuitem').nth(1).click(); await click(p, '[data-tab="wallet"]'); }],
  ['53-settings-budget', '?sample', async (p) => { await role(p, 'button', 'You: wallet, profile and settings'); await p.getByRole('menuitem').nth(1).click(); await click(p, '[data-tab="budget"]'); }],
  ['54-settings-profile', '?sample', async (p) => { await role(p, 'button', 'You: wallet, profile and settings'); await p.getByRole('menuitem').nth(1).click(); await click(p, '[data-tab="frontdoor"]'); }],
  ['60-organism-v2', '?sample&organism=v2', async (p) => { await role(p, 'button', 'You: wallet, profile and settings'); await p.getByRole('menuitem').nth(1).click(); }],
];

(async () => {
  const only = process.argv[2];
  const browser = await chromium.launch();
  const results = [];
  for (const theme of ['dark', 'light']) {
    for (const [name, query, act] of steps) {
      if (only && !name.startsWith(only)) continue;
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1, colorScheme: theme });
      await ctx.addInitScript((t) => { try { localStorage.setItem('bitsov.theme', t); } catch {} }, theme);
      const page = await ctx.newPage();
      let ok = true, err = '';
      try {
        await page.goto(BASE + '/' + query, { waitUntil: 'networkidle' });
        await page.waitForTimeout(700);
        await act(page);
        await page.waitForTimeout(500);
      } catch (e) { ok = false; err = String(e).split('\n')[0]; }
      const file = `${name}-${theme}.png`;
      await page.screenshot({ path: path.join(OUT, file) });
      results.push({ file, ok, err });
      await ctx.close();
    }
  }
  await browser.close();
  for (const r of results) console.log(r.ok ? 'OK  ' : 'FAIL', r.file, r.err);
})();
