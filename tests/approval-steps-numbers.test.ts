import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(__dirname, '../src/styles.css'), 'utf8');
const rule = (selector: string) => css.split('\n').find((line) => line.startsWith(`${selector} {`)) ?? '';

it('the approval steps keep their 1-2-3 numbers', () => {
  // A flex or grid list turns its items into flex items, and the numbers go with them.
  const list = rule('.approval-steps');
  expect(list).not.toBe('');
  expect(list).not.toMatch(/display:\s*(flex|grid)/);
  expect(list).toContain('list-style: decimal');
  // The steps are still spaced apart.
  expect(rule('.approval-steps > li + li')).toContain('margin-top: var(--s-2)');
});
