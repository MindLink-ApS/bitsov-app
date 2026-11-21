import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// jsdom does not apply the stylesheet, so read the rule itself: the green has to
// come from the theme's own "ok" colour (light and dark), with text in the page
// background colour so it stays readable in both themes.
const css = readFileSync(join(__dirname, '..', 'src', 'styles.css'), 'utf8');

describe('the incoming-call Answer button', () => {
  it('is green from the theme colour, readable, and at least 48 px tall', () => {
    const rule = css.match(/\.call-actions \.call-answer \{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/background:\s*var\(--ok\)/);
    expect(rule).toMatch(/color:\s*var\(--bg\)/);
    expect(rule).toMatch(/min-height:\s*48px/);
  });

  it('comes after the general money button rule, so the green wins', () => {
    expect(css.indexOf('.call-actions .call-answer {')).toBeGreaterThan(css.indexOf('.primary.money {'));
  });
});
