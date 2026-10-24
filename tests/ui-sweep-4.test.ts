import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The phone shell reuses rail and card classes. These overrides keep the
// vertical page, the status row, and the tab bar from inheriting the
// horizontal-rail and viewport-bottom rules.
const css = readFileSync(join(__dirname, '../src/styles.css'), 'utf8');

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
    expect(css).toMatch(/\.phone-status:has\(\[data-node-offline\], \[data-call-repairs\]\)/);
    expect(css).toMatch(/\.phone-status \.node-offline button \{ width: 100%; \}/);
  });

  it('wraps wallet chip rows on a phone and under 480px', () => {
    expect(css).toMatch(/@media \(max-width: 480px\) \{\s*\.wallet-top, \.wallet-actions, \.wallet-tabs, \.wallet-filters \.modes \{ flex-wrap: wrap; max-width: 100%; \}/);
    expect(css).toMatch(/\.cc\[data-phone-shell='true'\] :is\(\.wallet-top, \.wallet-actions, \.wallet-tabs, \.wallet-filters \.modes\) \{\s*flex-wrap: wrap;\s*max-width: 100%;/);
  });
});
