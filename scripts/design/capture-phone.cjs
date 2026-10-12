// Phone layout audit: the sample-mode app at phone widths (360 and 390 px),
// a PNG per surface plus an overflow report (page-level horizontal scroll and
// any element sticking out past the viewport outside a scroll container).
// Dev-only; vite dev server on :1420, Playwright via PLAYWRIGHT_DIR.
//   OUT=design/after/phone PLAYWRIGHT_DIR=... node scripts/design/capture-phone.cjs [prefix]
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_DIR || 'playwright');
const BASE = process.env.BASE || 'http://localhost:1420';
const OUT = process.env.OUT || path.join(__dirname, '..', '..', 'design', 'after', 'phone');
fs.mkdirSync(OUT, { recursive: true });

const click = (page, sel) => page.locator(sel).first().click({ timeout: 3000 });
const role = (page, r, name) => page.getByRole(r, { name }).first().click({ timeout: 3000 });
const you = (p) => role(p, 'button', 'You: wallet, profile and settings');
const settings = async (p) => { await you(p); await p.getByRole('menuitem').nth(1).click(); };
const wallet = async (p) => { await you(p); await p.getByRole('menuitem').first().click(); };

const steps = [
  ['01-onboarding', '?sample=first-run', async () => {}],
  ['10-chat', '?sample', async () => {}],
  ['11-chat-typed', '?sample', async (p) => { await p.getByPlaceholder('Message Maya').fill('Want to grab the deck before the call?'); }],
  ['12-chat-more', '?sample', async (p) => { await role(p, 'button', 'More: attach, pay, request'); }],
  ['13-chat-pay', '?sample', async (p) => { await role(p, 'button', 'More: attach, pay, request'); await p.getByRole('menuitem', { name: /Pay/ }).first().click(); }],
  ['14-contact', '?sample', async (p) => { await role(p, 'button', 'Contact Maya'); }],
  ['15-call-card', '?sample', async (p) => { await role(p, 'button', /^Call Maya/); }],
  ['16-you-menu', '?sample', you],
  ['20-wallet', '?sample', wallet],
  ['21-wallet-channels', '?sample', async (p) => { await wallet(p); await p.locator('[data-wallet-tab]').nth(1).click(); }],
  ['22-wallet-receive', '?sample', async (p) => { await wallet(p); await p.locator('[data-wallet-tab]').nth(2).click(); }],
  ['23-wallet-send', '?sample', async (p) => { await wallet(p); await p.locator('[data-wallet-tab]').nth(3).click(); }],
  ['30-settings', '?sample', settings],
  ['31-settings-node', '?sample', async (p) => { await settings(p); await click(p, '[data-tab="node"]'); }],
  ['32-settings-wallet', '?sample', async (p) => { await settings(p); await click(p, '[data-tab="wallet"]'); }],
  ['33-settings-budget', '?sample', async (p) => { await settings(p); await click(p, '[data-tab="budget"]'); }],
  ['34-settings-profile', '?sample', async (p) => { await settings(p); await click(p, '[data-tab="frontdoor"]'); }],
  ['35-devices', '?sample', async (p) => { await settings(p); await click(p, '[data-tab="devices"]'); }],
  ['40-ai', '?sample', async (p) => { await p.getByText('Ask your node').first().click({ timeout: 3000 }); }],
];

/** Elements wider than the viewport that are not inside a horizontal scroller. */
const overflow = () => {
  const vw = document.documentElement.clientWidth;
  const scrolls = (el) => { for (let n = el.parentElement; n; n = n.parentElement) { const s = getComputedStyle(n); if ((s.overflowX === 'auto' || s.overflowX === 'scroll' || s.overflowX === 'hidden') && n.scrollWidth > n.clientWidth + 1) return true; } return false; };
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (!r.width || getComputedStyle(el).visibility === 'hidden' || el.closest('details:not([open]) > :not(summary)')) continue;
    if ((r.right > vw + 1 || r.left < -1) && !scrolls(el)) {
      const id = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '') + [...el.attributes].filter((a) => a.name.startsWith('data-')).slice(0, 2).map((a) => `[${a.name}]`).join('');
      out.push(`${id} ${Math.round(r.left)}..${Math.round(r.right)}`);
    }
  }
  // Tap targets under 44 × 44 px (inline text links excepted), visible on screen.
  const small = [];
  for (const el of document.querySelectorAll('button, [role="tab"], [role="menuitem"], [role="radio"], a[href], summary')) {
    const r = el.getBoundingClientRect();
    if (!r.width || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > vw) continue;
    if (el.classList.contains('link') || el.closest('p, .hint, .stamp, details:not([open]) > :not(summary)')) continue;
    if (r.height < 43.5 || r.width < 43.5) small.push(`${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).slice(0, 2).join('.')} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 18)}" ${Math.round(r.width)}×${Math.round(r.height)}`);
  }
  return { pageScroll: document.scrollingElement.scrollWidth - vw, items: [...new Set(out)].slice(0, 12), small: [...new Set(small)].slice(0, 15) };
};

(async () => {
  const only = process.argv[2];
  const browser = await chromium.launch();
  const report = [];
  for (const width of (process.env.WIDTHS || '360,390').split(',').map(Number)) {
    for (const theme of ['dark']) {
      for (const [name, query, act] of steps) {
        if (only && !name.startsWith(only)) continue;
        const ctx = await browser.newContext({ viewport: { width, height: width === 360 ? 740 : 844 }, deviceScaleFactor: 2, colorScheme: theme, isMobile: true, hasTouch: true });
        await ctx.addInitScript((t) => { try { localStorage.setItem('bitsov.theme', t); } catch {} }, theme);
        const page = await ctx.newPage();
        let err = '';
        try {
          await page.goto(BASE + '/' + query, { waitUntil: 'networkidle' });
          await page.waitForTimeout(600);
          await act(page);
          await page.waitForTimeout(400);
        } catch (e) { err = String(e).split('\n')[0]; }
        const o = await page.evaluate(overflow);
        await page.screenshot({ path: path.join(OUT, `${name}-${width}.png`) });
        report.push({ name, width, err, ...o });
        await ctx.close();
      }
    }
  }
  await browser.close();
  for (const r of report) console.log(`${r.err ? 'FAIL' : r.pageScroll > 0 || r.items.length ? 'OVER' : 'ok  '} ${r.name}@${r.width} scroll=${r.pageScroll}${r.err ? ' ' + r.err : ''}${r.items.length ? '\n     ' + r.items.join('\n     ') : ''}${process.env.TAPS && r.small.length ? '\n     small: ' + r.small.join('\n            ') : ''}`);
})();
