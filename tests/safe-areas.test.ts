import { afterEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const css = readFileSync(join(__dirname, '../src/styles.css'), 'utf8');

// Happy DOM has no device safe area. Substitute only env() values; the real
// stylesheet selectors, cascade and custom-property inheritance still run.
const style = document.createElement('style');
style.textContent = css.replace(/env\(safe-area-inset-(top|right|bottom|left)(?:,\s*0px)?\)/g,
  (_, edge: string) => ({ top: '59px', right: '47px', bottom: '34px', left: '47px' })[edge]!);
document.head.append(style);
afterEach(() => { delete document.documentElement.dataset.platform; document.body.innerHTML = ''; });

it.each(['ios', 'android'])('applies device inset variables to %s surfaces', platform => {
  document.documentElement.dataset.platform = platform;
  document.body.innerHTML = '<main class="cc"><footer class="composer"></footer></main><section class="wallet-page"></section>';
  const root = getComputedStyle(document.documentElement);
  expect(root.getPropertyValue('--safe-area-top').trim()).toBe('59px');
  expect(root.getPropertyValue('--safe-area-bottom').trim()).toBe('34px');
  for (const selector of ['.cc', '.wallet-page']) {
    const computed = getComputedStyle(document.querySelector(selector)!);
    expect(computed.paddingTop).toBe('59px');
    expect(computed.paddingRight).toBe('47px');
    expect(computed.paddingBottom).toBe('34px');
    expect(computed.paddingLeft).toBe('47px');
  }
  // The shell owns the inset once; its composer keeps ordinary spacing.
  expect(getComputedStyle(document.querySelector('.composer')!).paddingBottom).toBe('16px');
});

it.each(['desktop', undefined])('does not apply device insets to %s', platform => {
  if (platform) document.documentElement.dataset.platform = platform;
  document.body.innerHTML = '<main class="cc"></main><section class="wallet-page"></section>';
  expect(getComputedStyle(document.documentElement).getPropertyValue('--safe-area-top')).toBe('');
  for (const selector of ['.cc', '.wallet-page']) {
    expect(getComputedStyle(document.querySelector(selector)!).paddingTop).not.toBe('59px');
    expect(getComputedStyle(document.querySelector(selector)!).paddingBottom).not.toBe('34px');
  }
});
