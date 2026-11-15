import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Your own picture on a video call. Rendered with the real stylesheet and its
// bundled fonts, with a real portrait or landscape camera stream (or the camera
// off), at phone widths and default, 200% and AX5 text sizes. The tile and its
// words stay inside the video area, never cropped or cut off.
const ORIGIN = 'http://tile.test';
const css = readFileSync('src/styles.css', 'utf8').replaceAll("url('./assets/", "url('/src/assets/");
const LABELS = {
  en: { on: 'You', off: 'You · Camera off' },
  da: { on: 'Dig', off: 'Dig · Kamera slukket' },
} as const;
const CAMERAS = { portrait: [180, 320], landscape: [320, 180], off: null } as const;

async function open(page: Page, lang: 'en' | 'da', root: number, camera: keyof typeof CAMERAS) {
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/src/assets/')) return route.fulfill({ path: join(process.cwd(), path) });
    const off = camera === 'off';
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="${lang}" data-platform="ios"><head>
      <meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style>
      <style>html[data-platform="ios"] { font-size: ${root}px; } *, *::before, *::after { animation: none !important; transition: none !important; }</style></head>
      <body><aside class="call-panel" data-call-panel="live"><div class="call-videos">
        <video class="call-video remote"></video>
        <div class="call-self" data-call-self ${off ? 'data-camera-off' : ''}>
          <video class="call-video local" autoplay playsinline muted></video>
          <span class="call-self-label" data-call-self-label>${LABELS[lang][off ? 'off' : 'on']}</span>
        </div>
      </div></aside></body></html>` });
  });
  await page.goto(`${ORIGIN}/`);
  await page.evaluate(async () => {
    await Promise.all([...document.fonts].map((face) => face.load().catch(() => null)));
    await document.fonts.ready;
  });
  expect(await page.evaluate(() => document.fonts.check('16px Inter'))).toBe(true);
  const size = CAMERAS[camera];
  if (size) {
    // A real stream with loaded metadata, so the video has the camera's own shape.
    const shape = await page.evaluate(async ([w, h]) => {
      const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
      const draw = canvas.getContext('2d')!;
      const paint = () => { draw.fillStyle = '#4a7'; draw.fillRect(0, 0, w, h); };
      paint(); const timer = setInterval(paint, 30);
      const video = document.querySelector<HTMLVideoElement>('[data-call-media], .call-video.local')!;
      video.srcObject = canvas.captureStream(30);
      await new Promise<void>((resolve) => { if (video.videoWidth) resolve(); else video.addEventListener('loadedmetadata', () => resolve(), { once: true }); });
      clearInterval(timer);
      return [video.videoWidth, video.videoHeight];
    }, size as unknown as [number, number]);
    expect(shape).toEqual(size);
  }
}

for (const width of [320, 393]) for (const lang of ['en', 'da'] as const) for (const root of [16, 32, 53]) for (const camera of Object.keys(CAMERAS) as (keyof typeof CAMERAS)[]) {
  test(`own picture stays whole: ${width}px, ${lang}, ${root}px text, camera ${camera}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 852 });
    await open(page, lang, root, camera);
    const g = await page.evaluate(() => {
      const box = (sel: string) => document.querySelector(sel)!.getBoundingClientRect().toJSON();
      const label = document.querySelector<HTMLElement>('[data-call-self-label]')!;
      const tile = document.querySelector<HTMLElement>('[data-call-self]')!;
      return {
        videos: box('.call-videos'), tile: box('[data-call-self]'), label: box('[data-call-self-label]'),
        labelCut: label.scrollWidth > label.clientWidth + 1,
        tileCutAcross: tile.scrollWidth > tile.clientWidth + 1,
        tileScrollsDown: tile.scrollHeight > tile.clientHeight + 1,
        tileOverflowY: getComputedStyle(tile).overflowY,
      };
    });
    const within = (inner: DOMRect, outer: DOMRect) => {
      expect(inner.left).toBeGreaterThanOrEqual(outer.left - 0.5);
      expect(inner.right).toBeLessThanOrEqual(outer.right + 0.5);
      expect(inner.top).toBeGreaterThanOrEqual(outer.top - 0.5);
      expect(inner.bottom).toBeLessThanOrEqual(outer.bottom + 0.5);
    };
    // The tile is never cropped by the video area, whatever the camera's shape.
    within(g.tile, g.videos);
    expect(g.labelCut).toBe(false);
    expect(g.tileCutAcross).toBe(false);
    if (camera === 'off') {
      // The words are the tile: at the largest sizes the rest is reached by scrolling, never cut off.
      if (g.tileScrollsDown) expect(g.tileOverflowY).toBe('auto');
      else within(g.label, g.tile);
    } else {
      within(g.label, g.tile);
      // Your own picture never covers most of theirs.
      expect(g.tile.width).toBeLessThanOrEqual(g.videos.width * 0.31);
    }
  });
}
