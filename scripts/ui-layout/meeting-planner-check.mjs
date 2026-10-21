#!/usr/bin/env node
/**
 * Rendered layout regression check (UI/UX audit 21 Oct, #271 review):
 * the meeting planner stays inside a 375 x 667 phone screen with 12 contacts,
 * and every participant checkbox can be reached (the top was at -174 px).
 *
 * Runs the Vite dev server with sample data (no node, no Tauri window) and a
 * headless Chromium through Playwright. Playwright is not a dependency of this
 * repo: set PLAYWRIGHT_MODULE=/path/to/node_modules/playwright, or have it
 * installed globally / in the npx cache.
 *
 *   npm run check:layout
 *   BITSOV_LAYOUT_URL=http://localhost:1420 npm run check:layout   # an already running dev server
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
  const require = createRequire(join(root, 'package.json'));
  try { return dirname(require.resolve('playwright/package.json')); } catch { /* not local */ }
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

const failures = [];
// Like scripts/ui-e2e-two-node.sh: PLAYWRIGHT_CHROMIUM picks a browser binary when the
// module's own build is not downloaded; otherwise Playwright's default is used.
async function launch() {
  try { return await chromium.launch(); } catch (e) {
    let exe = process.env.PLAYWRIGHT_CHROMIUM;
    if (!exe) {
      const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
      for (const d of (existsSync(cache) ? readdirSync(cache) : []).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
        const mac = join(cache, d, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
        const mac2 = join(cache, d, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
        exe = [mac, mac2].find((p) => existsSync(p));
        if (exe) break;
      }
    }
    if (!exe) throw e;
    return chromium.launch({ executablePath: exe });
  }
}
const browser = await launch();
try {
  for (const scheme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 375, height: 667 }, colorScheme: scheme, hasTouch: true });
    await page.goto(`${base}/?sample&peers=12`);
    await page.waitForSelector('[data-call="meeting"]:not([disabled])', { timeout: 15_000 });
    await page.click('[data-call="meeting"]');
    const panel = page.locator('[data-meeting-panel="planning"]');
    await panel.waitFor({ timeout: 5_000 });
    await page.waitForTimeout(400); // pop-in animation
    const box = await panel.boundingBox();
    const picks = await page.locator('[data-meeting-panel="planning"] [data-meeting-pick]').count();
    const where = `${scheme}: panel top ${Math.round(box.y)}, bottom ${Math.round(box.y + box.height)}, ${picks} picks`;
    console.log(where);
    if (picks < 12) failures.push(`${scheme}: expected 12 contacts in the planner, saw ${picks}`);
    if (box.y < 0) failures.push(`${scheme}: planner top is off screen (${Math.round(box.y)} px)`);
    if (box.y + box.height > 667 + 0.5) failures.push(`${scheme}: planner bottom is off screen (${Math.round(box.y + box.height)} px)`);
    // Every checkbox: scrolled into view inside the panel, it is the element under its own centre.
    for (let i = 0; i < picks; i++) {
      const pick = page.locator('[data-meeting-panel="planning"] [data-meeting-pick]').nth(i);
      await pick.scrollIntoViewIfNeeded();
      const b = await pick.boundingBox();
      const hit = await page.evaluate(([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return el?.closest('label')?.querySelector('[data-meeting-pick]')?.getAttribute('data-meeting-pick') ?? el?.getAttribute('data-meeting-pick') ?? null;
      }, [b.x + b.width / 2, b.y + b.height / 2]);
      const want = await pick.getAttribute('data-meeting-pick');
      if (b.y < 0 || b.y + b.height > 667 || hit !== want) failures.push(`${scheme}: contact ${i + 1} is not reachable (y ${Math.round(b.y)}, hit ${hit})`);
    }
    // Cancel stays reachable too.
    const cancel = page.locator('[data-meeting-cancel]');
    await cancel.scrollIntoViewIfNeeded();
    const c = await cancel.boundingBox();
    if (c.y < 0 || c.y + c.height > 667) failures.push(`${scheme}: Cancel is off screen`);
    await page.close();
  }
} finally {
  await browser.close();
  server?.kill();
}

if (failures.length) {
  console.error('FAIL\n' + failures.join('\n'));
  process.exit(1);
}
console.log('PASS: meeting planner fits 375 x 667 with 12 contacts; every checkbox and Cancel reachable');
