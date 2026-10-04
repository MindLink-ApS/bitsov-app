// Screenshot every direction mock (design/mocks/mock.html) into design/mocks/shots/.
//   PLAYWRIGHT_DIR=/path/to/node_modules/playwright node scripts/design/capture-mocks.cjs [A B ...]
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_DIR || 'playwright');
const mocks = path.join(__dirname, '..', '..', 'design', 'mocks');
const out = path.join(mocks, 'shots');
fs.mkdirSync(out, { recursive: true });
const ids = process.argv.slice(2).length ? process.argv.slice(2) : ['A', 'B', 'C', 'D', 'E', 'F'];
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  for (const d of ids) {
    for (const s of ['onboarding', 'chat', 'wallet']) {
      for (const t of ['light', 'dark']) {
        await page.goto(`file://${mocks}/mock.html?d=${d}&s=${s}&t=${t}`, { waitUntil: 'networkidle' });
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: path.join(out, `${d}-${s}-${t}.png`) });
      }
    }
  }
  await browser.close();
  console.log('done', ids.join(','));
})();
