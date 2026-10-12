import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// The setup steps sit in a boxless wrapper (display: contents) so offline can
// hide them without unmounting. The first-run column rule must reach through
// it, or every setup panel loses its width (measured: 508 / 984 px instead of
// 560 at 1280; see scripts/design/first-run-widths.cjs and the JSONs in
// design/after/onboarding-polish).
const css = readFileSync(join(__dirname, '../src/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
it('sizes the setup panels inside the wrapper exactly like direct first-run children', () => {
  const rule = css.match(/\.first-run > \*, \.first-run > \.setup-steps > \* \{([^}]*)\}/);
  expect(rule?.[1]).toMatch(/width:\s*100%/);
  expect(rule?.[1]).toMatch(/max-width:\s*560px/);
  expect(css).toMatch(/\.first-run > \.setup-steps \{ display: contents; \}/);
  expect(css).toMatch(/\.first-run > \.setup-steps\[hidden\] \{ display: none; \}/);
});
