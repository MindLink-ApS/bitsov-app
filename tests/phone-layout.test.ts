import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Phone (< 480 px): wallet, profile and settings stay one tap away, nothing
// opens off screen, and approvals and settings fit the width. Pinned here so a
// later desktop change cannot quietly take them away. Measured with
// scripts/design/capture-phone.cjs at 360 and 390 px (no sideways page scroll).
const css = readFileSync(join(__dirname, '../src/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
function phone(): string {
  const at = css.indexOf('@media (max-width: 480px)');
  expect(at).toBeGreaterThan(-1);
  let depth = 0;
  let i = css.indexOf('{', at);
  const start = i;
  for (; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) break;
  }
  return css.slice(start, i);
}
const rule = (block: string, selector: string) => {
  const m = block.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
  return m ? m[1] : '';
};

describe('phone layout', () => {
  const p = phone();
  it('keeps You (wallet, profile, settings) pinned in view on the top strip', () => {
    expect(rule(p, '.rail-foot')).toMatch(/position:\s*sticky/);
    expect(rule(p, '.rail-foot')).toMatch(/right:\s*0/);
  });
  it('opens the You menu down from the bar, inside the screen', () => {
    const m = rule(p, '.avatar-menu');
    expect(m).toMatch(/position:\s*fixed/);
    expect(m).toMatch(/bottom:\s*auto/);
    expect(m).toMatch(/calc\(100vw/);
  });
  it('stacks the budget approval and its choices', () => {
    expect(rule(p, '.approval.slim-approval')).toMatch(/flex-direction:\s*column/);
    expect(rule(p, '.approval.slim-approval .presets')).toMatch(/flex-direction:\s*column/);
  });
  it('keeps settings tabs on one scrolling row', () => {
    const t = rule(p, '.settings-head .tabs');
    expect(t).toMatch(/flex-wrap:\s*nowrap/);
    expect(t).toMatch(/overflow-x:\s*auto/);
  });
});
