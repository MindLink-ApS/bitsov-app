import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// The phone shell reuses rail and card classes. These overrides keep the
// vertical page, the status row, and the tab bar from inheriting the
// horizontal-rail and viewport-bottom rules.
const css = readFileSync(join(__dirname, '../src/styles.css'), 'utf8');

afterEach(() => {
  document.head.querySelectorAll('style').forEach(style => style.remove());
  document.body.innerHTML = '';
  delete document.documentElement.dataset.platform;
  delete document.documentElement.dataset.keyboardOpen;
  document.documentElement.style.removeProperty('--visible-height');
  document.documentElement.style.removeProperty('--s-1');
});

describe('phone shell layout after the bottom tabs', () => {
  it('shows the chat-list New action with its label, not the rail’s 44px plus', () => {
    expect(css).toMatch(/\.phone-chat-list \.rail-foot \.new-track \{[^}]*width:\s*100%[^}]*min-height:\s*44px[^}]*font-size:\s*var\(--t-md\)/);
    expect(css).toMatch(/\.phone-chat-list \.rail-foot \.new-track::before \{ content: none; \}/);
    expect(css).toMatch(/\.phone-chat-list \.rail-foot \.mode-tag \{ display: inline; \}/);
  });

  it('lets the phone status pill use the row, including on iOS', () => {
    expect(css).toMatch(/html\[data-platform='ios'\] \.phone-status \.node-pill \{ width: 100%; max-width: 100%; \}/);
    expect(css).toMatch(/\.phone-status \.on-call-pill \{ white-space: normal; max-width: 100%; \}/);
  });

  it('lifts call and meeting cards above the tab bar and shrinks them to fit', () => {
    expect(css).toMatch(/:not\(\[data-keyboard-open='true'\]\) \.cc\[data-phone-shell='true'\] :is\(\.call-panel, \.meeting-panel\) \{\s*bottom: calc\(44px \+ var\(--s-1\) \+ max\(var\(--s-1\), env\(safe-area-inset-bottom, 0px\)\) \+ var\(--s-3\)\);/);
    expect(css).toMatch(/:is\(\.meeting-panel, \.call-panel\[data-call-panel\]\) \{\s*max-height: calc\(100dvh - max\(var\(--s-4\), env\(safe-area-inset-top, 0px\)\) - 44px - var\(--s-1\) - max\(var\(--s-1\), env\(safe-area-inset-bottom, 0px\)\) - var\(--s-3\)\);/);
  });

  it('keeps offline Retry and call repair in the status row without a nested scroller', () => {
    expect(css).toMatch(/\.phone-status \.call-repairs \{ max-height: none; overflow: visible; \}/);
    expect(css).toMatch(/\.phone-status:has\(\[data-node-offline\], \[data-call-repairs\]\) \{\s*max-height: calc\(var\(--visible-height, 100dvh\) - env\(safe-area-inset-top, 0px\) - 44px - var\(--s-1\) - max\(var\(--s-1\), env\(safe-area-inset-bottom, 0px\)\) - 72px\);/);
    expect(css).toMatch(/\.phone-status \.node-offline button \{ width: 100%; \}/);
  });

  it('reserves the conversation and composer when the node drops while the keyboard is open', () => {
    expect(css).toMatch(/html\[data-keyboard-open='true'\] \.phone-status:has\(\[data-node-offline\], \[data-call-repairs\]\) \{\s*max-height: max\(0px, calc\(var\(--visible-height, 100dvh\) - var\(--safe-area-top, env\(safe-area-inset-top, 0px\)\) - var\(--safe-area-bottom, env\(safe-area-inset-bottom, 0px\)\) - 44px - 56px - 48px - 172px\)\);/);
  });

  it('keeps a focused composer on screen when the node disconnects', () => {
    // Happy DOM substitutes custom properties and env(), and leaves max() in
    // the computed value. It does not match :has() together with an ancestor,
    // so the keyboard-open rule is read back from the sheet and evaluated
    // against the measured iPhone viewport.
    const style = document.createElement('style');
    style.textContent = css.replace(/env\(safe-area-inset-(top|right|bottom|left)(?:,\s*0px)?\)/g,
      (_, edge: string) => ({ top: '59px', right: '0px', bottom: '34px', left: '0px' })[edge]!);
    document.head.append(style);
    document.documentElement.dataset.platform = 'ios';
    document.documentElement.dataset.keyboardOpen = 'false';
    document.documentElement.style.setProperty('--s-1', '4px');
    document.documentElement.style.setProperty('--visible-height', '852px');
    document.body.innerHTML = `<div id="root"><div class="cc" data-phone-shell="true">
      <header class="phone-status" data-phone-status><section data-node-offline></section></header>
      <section class="track"></section>
    </div></div>`;
    const status = document.querySelector('.phone-status')!;
    expect(getComputedStyle(status).maxHeight).toBe('calc(852px - 59px - 44px - 4px - max(4px, 34px) - 72px)');
    expect(852 - 59 - 44 - 4 - Math.max(4, 34) - 72).toBe(639);

    document.documentElement.dataset.keyboardOpen = 'true';
    document.documentElement.style.setProperty('--visible-height', '456px');
    const sheets = [...document.styleSheets];
    const sheet = sheets[sheets.length - 1]!;
    const openRule = [...sheet.cssRules].find(rule => rule.cssText.includes("html[data-keyboard-open='true'] .phone-status:has"));
    expect(openRule?.cssText).toContain('max(0px, calc(var(--visible-height, 100dvh) - var(--safe-area-top, 59px) - var(--safe-area-bottom, 34px) - 44px - 56px - 48px - 172px))');
    expect(getComputedStyle(document.documentElement).getPropertyValue('--safe-area-bottom').trim()).toBe('0px');
    // Visual viewport 456px, top inset 59px, bottom inset cleared while typing.
    const thread = 44 + 56 + 48 + 172;
    const cap = Math.max(0, 456 - 59 - 0 - thread);
    const shell = 456 - 59;
    expect(cap).toBe(77);
    expect(shell - cap).toBeGreaterThanOrEqual(thread);
    // Capping against 100dvh (852px) instead of the visible height exceeds the shell.
    expect(852 - 59 - 44 - 4 - Math.max(4, 34) - 72).toBeGreaterThan(shell);
  });

  it('wraps wallet chip rows on a phone and under 480px', () => {
    expect(css).toMatch(/@media \(max-width: 480px\) \{\s*\.wallet-top, \.wallet-actions, \.wallet-tabs, \.wallet-filters \.modes \{ flex-wrap: wrap; max-width: 100%; \}/);
    expect(css).toMatch(/\.cc\[data-phone-shell='true'\] :is\(\.wallet-top, \.wallet-actions, \.wallet-tabs, \.wallet-filters \.modes\) \{\s*flex-wrap: wrap;\s*max-width: 100%;/);
  });
});
