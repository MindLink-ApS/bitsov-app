import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Narrow and phone layouts: + New and You (wallet, profile, settings) stay
// reachable, nothing opens off screen, and every phone tap target is at least
// 44 px. Measured with scripts/design/capture-phone.cjs (TAPS=1) at 360 and
// 390 px: no sideways page scroll and no target under 44 × 44.
const css = readFileSync(join(__dirname, '../src/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
/** Every `{…}` body of the given @media query, in source order. */
function blocks(query: string): string[] {
  const out: string[] = [];
  for (let at = css.indexOf(query); at >= 0; at = css.indexOf(query, at + 1)) {
    let depth = 0;
    let i = css.indexOf('{', at);
    const start = i;
    for (; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) break;
    }
    out.push(css.slice(start, i));
  }
  return out;
}
const rule = (b: string, selector: string) => {
  const m = b.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
  return m ? m[1] : '';
};
// The narrow block that pins the rail foot (an older 680 px block sets up the strip itself).
const narrow = blocks('@media (max-width: 680px)').find((b) => /\.rail-foot\s*\{[^}]*sticky/.test(b)) ?? '';
const phone = blocks('@media (max-width: 480px)')[0] ?? '';

describe('narrow layout (top strip)', () => {
  it('pins + New and You at the strip’s right edge, at least 44 px', () => {
    expect(rule(narrow, '.rail-foot')).toMatch(/position:\s*sticky/);
    expect(rule(narrow, '.rail-foot')).toMatch(/right:\s*0/);
    expect(rule(narrow, '.rail-foot .new-track')).toMatch(/min-height:\s*44px/);
    expect(rule(narrow, '.profile-avatar')).toMatch(/min-width:\s*44px/);
    expect(rule(narrow, '.profile-avatar')).toMatch(/min-height:\s*44px/);
    // + New is never hidden: it is the only way to the node-id QR, the intro card and starter bitcoin.
    expect(css).not.toMatch(/\.new-track\s*\{[^}]*display:\s*none/);
  });
  it('opens the You menu down from the bar, inside the screen, with 44 px rows', () => {
    const m = rule(narrow, '.avatar-menu');
    expect(m).toMatch(/position:\s*fixed/);
    expect(m).toMatch(/bottom:\s*auto/);
    expect(m).toMatch(/top:\s*calc\(var\(--bar-h\)/);
    expect(m).toMatch(/calc\(100vw/);
    expect(rule(narrow, '.avatar-menu-item')).toMatch(/min-height:\s*44px/);
  });
});

describe('phone layout', () => {
  it('stacks the budget approval; each choice is 44 px', () => {
    expect(rule(phone, '.approval.slim-approval')).toMatch(/flex-direction:\s*column/);
    expect(rule(phone, '.approval.slim-approval .presets')).toMatch(/flex-direction:\s*column/);
    expect(rule(phone, '.approval.slim-approval .chip')).toMatch(/min-height:\s*44px/);
  });
  it('keeps settings tabs on one scrolling row', () => {
    const t = rule(phone, '.settings-head .tabs');
    expect(t).toMatch(/flex-wrap:\s*nowrap/);
    expect(t).toMatch(/overflow-x:\s*auto/);
  });
  it('makes every button, tab and disclosure at least 44 px', () => {
    expect(phone).toMatch(/button:not\(\.link\), summary, \[role='tab'\], \[role='radio'\], \[role='menuitem'\] \{ min-height: 44px; \}/);
    expect(rule(phone, 'button:not(.link)')).toMatch(/min-width:\s*44px/);
  });
  it('gives the message text its own row', () => {
    expect(rule(phone, '.signal-bar > textarea')).toMatch(/flex:\s*1 1 100%/);
  });
});
