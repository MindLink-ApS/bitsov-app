import { afterEach, expect, it } from 'vitest';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';
import { setLanguagePref } from '../src/i18n';
import { setDenom } from '../src/control/prefs';
import { readFileSync } from 'node:fs';
const styles = readFileSync('src/styles.css', 'utf8');

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); document.body.innerHTML = ''; setLanguagePref('en'); setDenom('sats'); });

// Inspect text nodes rather than parent textContent: a wrapping paragraph may
// legitimately contain a nowrap amount span. Check actual app CSS inheritance.
function assertAmountsCannotBreak() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!/\d\u2009\d/.test(node.textContent ?? '')) continue;
    expect(getComputedStyle(node.parentElement!).whiteSpace, node.parentElement!.outerHTML).toBe('nowrap');
  }
}

it.each(['en', 'da'] as const)('keeps every rendered %s amount non-breaking across shell panels and denominations', async lang => {
  setLanguagePref(lang);
  const style = document.createElement('style'); style.textContent = styles; document.head.append(style);
  const unmount = render(() => <ControlCenter source={sampleSource()} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={null} />, document.body);
  dispose = () => { unmount(); style.remove(); };
  const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
  const press = async (selector: string) => { document.querySelector<HTMLButtonElement>(selector)!.click(); await settle(); assertAmountsCannotBreak(); };
  await settle();
  for (const unit of ['sats', 'btc'] as const) {
    setDenom(unit); await settle(); assertAmountsCannotBreak();
    for (const tab of ['general', 'body', 'node', 'devices', 'budget', 'frontdoor', 'wallet']) await press(`[data-tab="${tab}"]`);
    await press('[data-open-wallet-page]');
    for (const tab of ['activity', 'channels', 'receive', 'send']) await press(`[data-wallet-tab="${tab}"]`);
    await press('[data-wallet-close]');
  }
});
