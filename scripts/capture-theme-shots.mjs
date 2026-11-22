#!/usr/bin/env node
/**
 * Capture light + dark THEME MOCK screenshots (palette / tokens only — not a live
 * app render). Builds a static demo page with src/styles.css variables, then
 * writes HTML under docs/control-center/theme-shots/ and PNGs when Playwright is
 * available via scripts/ui-e2e/render.mjs.
 *
 *   node scripts/capture-theme-shots.mjs
 */
import { mkdirSync, writeFileSync, cpSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'docs', 'control-center', 'theme-shots');
const evidence = join(out, '_evidence');
const snaps = join(evidence, 'snapshots');

rmSync(evidence, { recursive: true, force: true });
mkdirSync(snaps, { recursive: true });

const css = await import('node:fs').then((fs) => fs.readFileSync(join(root, 'src', 'styles.css'), 'utf8'));

function page(theme) {
  return `<!doctype html><html lang="en" data-theme="${theme}" style="color-scheme:${theme}"><head><meta charset="utf-8"/><style>${css}
body{margin:0;font-family:system-ui,sans-serif}
.demo{display:grid;grid-template-columns:240px 1fr;height:100vh;background:var(--bg);color:var(--ink)}
.demo-rail{background:var(--sunk);padding:16px;border-right:1px solid var(--line);display:flex;flex-direction:column;gap:12px}
.demo-chat{display:flex;flex-direction:column;align-items:center;padding:24px;gap:16px}
.demo-col{width:min(720px,100%);display:flex;flex-direction:column;gap:12px}
.bubble{background:var(--surface);padding:10px 14px;border-radius:16px;max-width:80%}
.composer-main{display:flex;gap:8px;align-items:center;background:var(--surface);border-radius:22px;padding:8px}
.attach{width:34px;height:34px;border-radius:50%;border:none;background:var(--raised)}
.primary.soft{background:var(--accent);color:var(--accent-ink);border:none;border-radius:999px;padding:8px 16px}
.profile{margin-top:auto;display:flex;gap:8px;align-items:center;background:var(--surface);border-radius:12px;padding:8px}
.avatar{width:28px;height:28px;border-radius:50%;background:var(--accent);color:var(--accent-ink);display:grid;place-items:center;font-size:11px;font-weight:700}
</style></head><body>
<div class="demo" data-theme-shot="${theme}">
  <aside class="demo-rail">
    <div class="mark" style="font-family:Georgia,serif;font-size:18px;font-weight:650">Bit<span style="color:var(--accent)">Sov</span></div>
    <div style="font-size:12px;color:var(--muted)">Robin</div>
    <div style="font-size:12px;color:var(--muted)">Mexico build</div>
    <div class="profile"><span class="avatar">11</span><span style="font-size:12.5px;color:var(--muted)">You · settings</span></div>
  </aside>
  <main class="demo-chat">
    <div class="demo-col">
      <div class="bubble" style="align-self:flex-start">Morning. Ready when you are.</div>
      <div class="bubble" style="align-self:flex-end;background:var(--raised)">Sending the brief.</div>
      <div class="composer-main">
        <button class="attach">+</button>
        <span style="flex:1;color:var(--muted);font-size:13.5px;padding:0 6px">Message Robin</span>
        <button class="primary soft">Send · 2 sats</button>
      </div>
      <p style="font-size:12px;color:var(--faint);margin:0">MOCK theme shot (${theme}) — palette only, not a live app render. Profile settings hold Body, Node, Wallet, Budget, and BTC/sats.</p>
    </div>
  </main>
</div>
</body></html>`;
}

for (const theme of ['light', 'dark']) {
  const name = `01-${theme}`;
  writeFileSync(join(snaps, `${name}.html`), page(theme));
  writeFileSync(join(snaps, `${name}.json`), JSON.stringify({ width: 1280, height: 800, scheme: theme }));
}

const require = createRequire(import.meta.url);
let playwrightModule = process.env.PLAYWRIGHT_MODULE;
if (!playwrightModule) {
  try {
    playwrightModule = dirname(require.resolve('playwright/package.json'));
  } catch {
    try {
      playwrightModule = dirname(createRequire('/usr/local/lib/node_modules/playwright/package.json').resolve('playwright/package.json'));
    } catch { /* none */ }
  }
}

if (playwrightModule) {
  const r = spawnSync(process.execPath, [join(root, 'scripts/ui-e2e/render.mjs'), evidence], {
    env: { ...process.env, PLAYWRIGHT_MODULE: playwrightModule },
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.warn('render.mjs failed; keeping HTML snapshots');
  } else {
    for (const theme of ['light', 'dark']) {
      const src = join(snaps, `01-${theme}.png`);
      if (existsSync(src)) cpSync(src, join(out, `theme-${theme}.png`));
    }
  }
} else {
  console.warn('Playwright not found; wrote HTML snapshots only');
}

for (const theme of ['light', 'dark']) {
  cpSync(join(snaps, `01-${theme}.html`), join(out, `theme-${theme}.html`));
}

console.log('theme shots →', out);
console.log(readdirSync(out).join('\n'));
