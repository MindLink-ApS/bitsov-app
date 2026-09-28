// Render the DOM snapshots the in-window driver took into PNG screenshots and
// one webm walk-through. Offline: snapshots are self-contained (inline CSS,
// inline SVG/data: images) and every network request is blocked.
//
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright node render.mjs <evidence-dir>
import { readdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const evidence = process.argv[2];
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
const dir = join(evidence, 'snapshots');
const names = readdirSync(dir).filter((f) => f.endsWith('.html')).sort();
if (names.length === 0) process.exit(0);

// PLAYWRIGHT_CHROMIUM: an already-downloaded Chromium if this Playwright's own is missing.
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
const first = JSON.parse(readFileSync(join(dir, names[0].replace(/\.html$/, '.json')), 'utf8'));
const size = { width: first.width, height: first.height };
const context = await browser.newContext({
  viewport: size,
  colorScheme: first.scheme,
  recordVideo: { dir: evidence, size },
});
await context.route('**/*', (route) => (route.request().url().startsWith('data:') ? route.continue() : route.abort()));
const page = await context.newPage();
for (const name of names) {
  const meta = JSON.parse(readFileSync(join(dir, name.replace(/\.html$/, '.json')), 'utf8'));
  await page.setViewportSize({ width: meta.width, height: meta.height });
  await page.setContent(readFileSync(join(dir, name), 'utf8'), { waitUntil: 'load' });
  await page.addStyleTag({ content: '*{animation:none!important;transition:none!important}' });
  await page.screenshot({ path: join(dir, name.replace(/\.html$/, '.png')) });
  await page.waitForTimeout(1500); // dwell for the walk-through video
  console.log('rendered', name);
}
const video = page.video();
await context.close();
await browser.close();
if (video) renameSync(await video.path(), join(evidence, 'walkthrough.webm'));
