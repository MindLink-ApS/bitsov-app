// Desktop QR scan, end to end in Chromium with a fake camera that shows a
// pairing QR drawn by our own encoder (src/qr.ts). Stubbed host, dev server
// on :1420. Captures the viewfinder and the filled-in pairing link.
//   OUT=design/after/qr-scan PLAYWRIGHT_DIR=... node scripts/design/capture-qr-scan.cjs
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { chromium } = require(process.env.PLAYWRIGHT_DIR || 'playwright');
const BASE = process.env.BASE || 'http://localhost:1420';
const OUT = process.env.OUT || path.join(__dirname, '..', '..', 'design', 'after', 'qr-scan');
const LINK = 'bitsov://pair/eyJ2IjoxLCJlbmRwb2ludCI6IjIwMy4wLjExMy43Ojg0NDMifQ_sample-ticket';
fs.mkdirSync(OUT, { recursive: true });

/** A Y4M clip: two seconds of an empty desk, then the QR held up (Chrome loops it). */
function y4m(matrix, w = 640, h = 480) {
  const quiet = 4;
  const n = matrix.length + quiet * 2;
  const scale = Math.floor(Math.min(w, h) * 0.8 / n);
  const x0 = Math.floor((w - n * scale) / 2);
  const y0 = Math.floor((h - n * scale) / 2);
  const blank = Buffer.alloc(w * h, 200);
  const qr = Buffer.alloc(w * h, 200);
  for (let y = 0; y < n * scale; y++) for (let x = 0; x < n * scale; x++) {
    const my = Math.floor(y / scale) - quiet;
    const mx = Math.floor(x / scale) - quiet;
    const dark = my >= 0 && mx >= 0 && my < matrix.length && mx < matrix.length && matrix[my][mx];
    qr[(y0 + y) * w + x0 + x] = dark ? 16 : 235;
  }
  const chroma = Buffer.alloc((w / 2) * (h / 2) * 2, 128);
  const parts = [Buffer.from(`YUV4MPEG2 W${w} H${h} F10:1 Ip A1:1 C420jpeg\n`)];
  for (let i = 0; i < 60; i++) parts.push(Buffer.from('FRAME\n'), i < 20 ? blank : qr, chroma);
  return Buffer.concat(parts);
}

const stub = ([t]) => {
  try { localStorage.setItem('bitsov.theme', t); } catch {}
  const status = { ready: true, node_id: 'ab'.repeat(33), error: null };
  const pairing = { remote: false, state: 'paired', scopes: ['read', 'receive'], short_code: 'ABCD-EFGH', code_from_node: true, reason: null, bootstrap: null };
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd) => {
      if (cmd === 'node_status') return Promise.resolve(status);
      if (cmd === 'pairing_status') return Promise.resolve(pairing);
      if (cmd === 'device_key_status') return Promise.resolve({ available: true, state: 'none', fingerprint: null, owner_action: null, expires_at_ms: null });
      return Promise.reject(new Error('stub: ' + cmd));
    },
    transformCallback: () => 0,
  };
};

(async () => {
  // Our encoder, through Vite: the same QR the add-device screen would show.
  const helper = await chromium.launch();
  const hp = await helper.newPage();
  await hp.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  const matrix = await hp.evaluate(async (link) => (await import('/src/qr.ts')).qrMatrix(link), LINK);
  await helper.close();
  const clip = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qr-cam-')), 'qr.y4m');
  fs.writeFileSync(clip, y4m(matrix));

  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${clip}`] });
  for (const theme of ['dark', 'light']) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, colorScheme: theme, permissions: ['camera'] });
    await ctx.addInitScript(stub, [theme]);
    const page = await ctx.newPage();
    const requests = [];
    page.on('request', (r) => { if (!r.url().startsWith(BASE)) requests.push(r.url()); });
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    const adv = page.locator('.node-target-advanced > summary');
    if (await adv.isVisible()) await adv.click();
    await page.click('[data-target="network"]');
    await page.locator('[data-scan-pairing-qr]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(OUT, `qr-1-button-${theme}.png`) });
    await page.click('[data-scan-pairing-qr]');
    await page.waitForSelector('[data-qr-scan] video');
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(OUT, `qr-2-viewfinder-${theme}.png`) });
    await page.waitForSelector('[data-qr-scan]', { state: 'detached', timeout: 15000 });
    const value = await page.inputValue('[data-remote-access] input');
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, `qr-3-filled-${theme}.png`) });
    console.log(theme, 'decoded:', value === LINK ? 'match' : `MISMATCH ${value}`, '| outside requests:', requests.length);
    await ctx.close();
  }
  await browser.close();
  console.log('done');
})();
