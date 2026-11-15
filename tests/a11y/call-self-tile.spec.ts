import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

// Your own picture on a video call: the "You" label, and "You · Camera off"
// when the camera is off, stay whole at default and enlarged text sizes.
// The tile is rendered with the real stylesheet; no app or server is needed.
const css = readFileSync('src/styles.css', 'utf8');
const LABELS = {
  en: { on: 'You', off: 'You · Camera off' },
  da: { on: 'Dig', off: 'Dig · Kamera slukket' },
} as const;

for (const lang of ['en', 'da'] as const) for (const root of [16, 32, 53]) for (const camera of ['on', 'off'] as const) {
  test(`own picture label is complete: ${lang}, ${root}px text, camera ${camera}`, async ({ page }) => {
    await page.setContent(`<!doctype html><html lang="${lang}" data-platform="ios"><head><style>${css}</style>
      <style>html[data-platform="ios"] { font-size: ${root}px; } *, *::before, *::after { animation: none !important; transition: none !important; }</style></head>
      <body><aside class="call-panel" data-call-panel="live"><div class="call-videos">
        <video class="call-video remote"></video>
        <div class="call-self" data-call-self ${camera === 'off' ? 'data-camera-off' : ''}>
          <video class="call-video local" muted></video>
          <span class="call-self-label" data-call-self-label>${LABELS[lang][camera]}</span>
        </div>
      </div></aside></body></html>`);
    const geometry = await page.evaluate(() => {
      const box = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
      const label = document.querySelector<HTMLElement>('[data-call-self-label]')!;
      const tile = document.querySelector<HTMLElement>('[data-call-self]')!;
      return {
        videos: box('.call-videos').toJSON(), tile: box('[data-call-self]').toJSON(), label: box('[data-call-self-label]').toJSON(),
        labelClipped: label.scrollWidth > label.clientWidth + 1,
        tileClipped: tile.scrollWidth > tile.clientWidth + 1 || tile.scrollHeight > tile.clientHeight + 1,
      };
    });
    expect(geometry.labelClipped).toBe(false);
    expect(geometry.tileClipped).toBe(false);
    // The label sits inside the tile, and the tile inside the video area.
    for (const [inner, outer] of [[geometry.label, geometry.tile], [geometry.tile, geometry.videos]] as const) {
      expect(inner.left).toBeGreaterThanOrEqual(outer.left - 0.5);
      expect(inner.right).toBeLessThanOrEqual(outer.right + 0.5);
      expect(inner.top).toBeGreaterThanOrEqual(outer.top - 0.5);
      expect(inner.bottom).toBeLessThanOrEqual(outer.bottom + 0.5);
    }
  });
}
