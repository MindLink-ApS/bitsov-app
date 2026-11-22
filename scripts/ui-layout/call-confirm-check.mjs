#!/usr/bin/env node
/**
 * Rendered layout regression check (UI/UX audit 21 Oct, #269 review): with a
 * 64-character unbroken petname, the paid-call confirm keeps Cancel and Ring
 * fully on screen, at 375 px and in a narrow desktop window.
 *
 * Runs the Vite dev server with sample data (no node, no Tauri window) and a
 * headless Chromium through Playwright, which is not a dependency of this repo:
 * PLAYWRIGHT_MODULE=/path/to/node_modules/playwright, or a global / npx-cache
 * install; PLAYWRIGHT_CHROMIUM=/path/to/chrome if the module's own build is
 * missing. Exits 2 when Playwright cannot be found.
 *
 *   node scripts/ui-layout/call-confirm-check.mjs
 *   BITSOV_LAYOUT_URL=http://localhost:1420 node scripts/ui-layout/call-confirm-check.mjs
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function findPlaywright() {
  if (process.env.PLAYWRIGHT_MODULE) return process.env.PLAYWRIGHT_MODULE;
  try { return dirname(createRequire(join(root, 'package.json')).resolve('playwright/package.json')); } catch { /* not local */ }
  const npx = join(homedir(), '.npm', '_npx');
  for (const d of existsSync(npx) ? readdirSync(npx) : []) {
    const p = join(npx, d, 'node_modules', 'playwright');
    if (existsSync(join(p, 'package.json'))) return p;
  }
  for (const p of ['/usr/local/lib/node_modules/playwright', '/opt/homebrew/lib/node_modules/playwright']) {
    if (existsSync(join(p, 'package.json'))) return p;
  }
  return null;
}

const pwPath = findPlaywright();
if (!pwPath) {
  console.error('SKIP-FAIL: Playwright not found. Set PLAYWRIGHT_MODULE=/path/to/node_modules/playwright.');
  process.exit(2);
}
const { chromium } = await import(pathToFileURL(join(pwPath, 'index.mjs')).href).catch(() => import(pathToFileURL(join(pwPath, 'index.js')).href));

async function launch() {
  try { return await chromium.launch(); } catch (e) {
    let exe = process.env.PLAYWRIGHT_CHROMIUM;
    if (!exe) {
      const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
      for (const d of (existsSync(cache) ? readdirSync(cache) : []).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
        exe = [
          join(cache, d, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
          join(cache, d, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        ].find((p) => existsSync(p));
        if (exe) break;
      }
    }
    if (!exe) throw e;
    return chromium.launch({ executablePath: exe });
  }
}

let server;
let base = process.env.BITSOV_LAYOUT_URL;
if (!base) {
  const port = String(14000 + Math.floor(Math.random() * 900));
  server = spawn(join(root, 'node_modules', '.bin', 'vite'), [], {
    cwd: root, env: { ...process.env, BITSOV_VITE_PORT: port }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = `http://localhost:${port}`;
  await new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error('vite did not start in 30 s')), 30_000);
    const seen = (b) => { if (String(b).includes(port)) { clearTimeout(t); ok(); } };
    server.stdout.on('data', seen);
    server.stderr.on('data', seen);
    server.on('exit', (c) => fail(new Error(`vite exited ${c}`)));
  });
}

const LONG = 'W'.repeat(64); // the petname maximum, no break opportunity
const failures = [];
const browser = await launch();
try {
  for (const [w, h] of [[375, 667], [700, 600]]) {
    for (const media of ['audio', 'video']) {
      const page = await browser.newPage({ viewport: { width: w, height: h } });
      await page.goto(`${base}/?sample`);
      await page.waitForSelector('[data-contact-open]', { timeout: 15_000 });
      // Give Robin a 64-character petname through the contact sheet.
      await page.click('[data-contact-open]');
      await page.fill('[data-contact-petname]', LONG);
      await page.press('[data-contact-petname]', 'Tab');
      await page.click('[data-contact-close]');
      await page.waitForSelector(`[data-call="${media}"]:not([disabled])`, { timeout: 15_000 });
      await page.click(`[data-call="${media}"]`);
      const box = page.locator(`[data-call-confirm-box="${media}"]`);
      await box.waitFor({ timeout: 5_000 });
      const text = await box.textContent();
      if (!text.includes(LONG)) failures.push(`${w}px ${media}: the confirm does not show the long petname`);
      for (const sel of ['[data-call-confirm-cancel]', `[data-call-confirm="${media}"]`, `[data-call-confirm-box="${media}"]`]) {
        const b = await page.locator(sel).boundingBox();
        const label = `${w}px ${media} ${sel}`;
        if (!b) { failures.push(`${label}: not rendered`); continue; }
        if (b.x < 0 || b.x + b.width > w + 0.5) failures.push(`${label}: off screen horizontally (x ${Math.round(b.x)}..${Math.round(b.x + b.width)})`);
        if (sel !== `[data-call-confirm-box="${media}"]`) {
          const hit = await page.evaluate(([x, y, s]) => document.elementFromPoint(x, y)?.closest(s) !== null, [b.x + b.width / 2, b.y + b.height / 2, sel]);
          if (!hit) failures.push(`${label}: covered or not tappable at its centre`);
        }
      }
      console.log(`${w}px ${media}: checked`);
      await page.close();
    }
  }
} finally {
  await browser.close();
  server?.kill();
}

if (failures.length) {
  console.error('FAIL\n' + failures.join('\n'));
  process.exit(1);
}
console.log('PASS: call confirm keeps Cancel and Ring on screen with a 64-character petname (375 and 700 px)');
