import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Ember 2.0 motion: every looping animation stops under reduced motion, and the
// global reduced-motion rule collapses every other animation and transition.
const css = readFileSync(join(__dirname, '../src/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function reducedBlocks(): string {
  const out: string[] = [];
  let at = css.indexOf('@media (prefers-reduced-motion: reduce)');
  while (at >= 0) {
    let depth = 0;
    let i = css.indexOf('{', at);
    const start = i;
    for (; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) break;
    }
    out.push(css.slice(start, i));
    at = css.indexOf('@media (prefers-reduced-motion: reduce)', i);
  }
  return out.join('\n');
}

describe('motion', () => {
  const reduced = reducedBlocks();

  it('collapses all animations and transitions under reduced motion', () => {
    expect(reduced).toMatch(/\*,\s*\*::before,\s*\*::after\s*\{[^}]*animation-duration:\s*0\.01ms !important/);
    expect(reduced).toMatch(/transition-duration:\s*0\.01ms !important/);
  });

  it('jumps reduced transitions to their end value, so inherited visibility is never briefly hidden', () => {
    expect(reduced).toMatch(/\*,\s*\*::before,\s*\*::after\s*\{[^}]*transition-timing-function:\s*step-start !important/);
  });

  it('turns off every infinite (ambient) animation explicitly', () => {
    const looping = [...css.matchAll(/([^{}]+)\{[^{}]*\binfinite\b[^{}]*\}/g)].map((m) => m[1].trim().split(',').map((s) => s.trim()));
    expect(looping.length).toBeGreaterThan(0);
    for (const selectors of looping) {
      const covered = selectors.some((sel) => reduced.includes(sel));
      expect(covered, selectors.join(', ')).toBe(true);
    }
  });

  it('keeps hover lifts still under reduced motion', () => {
    expect(reduced).toContain('.node-target-card:hover');
  });
});
