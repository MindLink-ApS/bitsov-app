import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Ember 2.0 tokens: text meets WCAG AA on every surface it
// sits on, in both themes, and the bundled faces are the only fonts loaded.

const css = readFileSync(join(__dirname, '../src/styles.css'), 'utf8');

function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const block = css.slice(start, css.indexOf('}', start));
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})/g)) out[m[1]] = m[2];
  return out;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const dark = tokens(':root');
const themes = { dark, light: { ...dark, ...tokens("html[data-theme='light']") } };

describe('design tokens', () => {
  it.each(Object.entries(themes))('text meets AA on every surface in the %s theme', (_, t) => {
    for (const surface of ['--bg', '--surface', '--raised', '--sunk']) {
      for (const text of ['--ink', '--muted', '--accent']) {
        expect(contrast(t[text], t[surface]), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
      // Faint carries small text (timestamps, hints at 11.5–12.5 px): full AA too.
      expect(contrast(t['--faint'], t[surface]), `--faint on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(t['--accent-ink'], t['--accent']), 'ink on the send button').toBeGreaterThanOrEqual(4.5);
    // Faint stays visibly quieter than muted, so the hierarchy survives the AA lift.
    expect(contrast(t['--faint'], t['--bg'])).toBeLessThan(contrast(t['--muted'], t['--bg']) - 1);
    expect(contrast(t['--bubble-in-ink'], t['--bubble-in-bg']), 'incoming bubble').toBeGreaterThanOrEqual(4.5);
    expect(contrast(t['--bubble-out-ink'], t['--bubble-out-bg']), 'outgoing bubble').toBeGreaterThanOrEqual(4.5);
    expect(contrast(t['--accent'], t['--ember']), 'price on its ember tint').toBeGreaterThanOrEqual(4.5);
    for (const state of ['--ok', '--warn', '--err']) {
      expect(contrast(t[state], t['--bg']), `${state} on --bg`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('bundles its fonts and loads nothing from a font host', () => {
    const urls = [...css.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(u.startsWith('./assets/fonts/'), u).toBe(true);
      expect(existsSync(join(__dirname, '../src', u)), u).toBe(true);
    }
    expect(existsSync(join(__dirname, '../third_party/fonts/OFL-Inter.txt'))).toBe(true);
    expect(existsSync(join(__dirname, '../third_party/fonts/OFL-InstrumentSerif.txt'))).toBe(true);
    expect(css).not.toMatch(/@import|fonts\.googleapis|fonts\.gstatic/);
  });

  it('keeps the outgoing bubble neutral: orange is for sats, not for whose message it is', () => {
    for (const t of Object.values(themes)) expect(t['--bubble-out-bg']).not.toBe(t['--accent']);
  });
});

describe('G6 disclosure edge', () => {
  it('no later panel rule overrides the trust disclosure border', () => {
    const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(plain).toMatch(/\.disclosure\s*\{[^}]*border-left:\s*3px solid var\(--money\)/);
    // A bare `.panel { border… }` after the disclosure rule would win the cascade.
    const after = plain.slice(plain.search(/\.disclosure\s*\{/));
    expect(after).not.toMatch(/(^|\n)\.panel\s*\{[^}]*\bborder\s*:/);
  });
});
