import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Ember 2.0: primary actions are neutral; orange (`money`) marks only the actions
// that move or authorise sats. Source-level so a new button cannot silently
// inherit orange, and a money action cannot silently lose it.

const read = (f: string) => readFileSync(join(__dirname, '../src', f), 'utf8');

/** Every <button …> opening tag in a file, braces-aware (onClick arrows contain '>'). */
function buttons(src: string): string[] {
  const out: string[] = [];
  let i = src.indexOf('<button');
  while (i >= 0) {
    let j = i + 7;
    let depth = 0;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    out.push(src.slice(i, j + 1));
    i = src.indexOf('<button', j);
  }
  return out;
}

const classes = (tag: string) => (/class="([^"]*)"/.exec(tag)?.[1] ?? '').split(/\s+/);
const tagWith = (file: string, hook: string) => {
  // Primary buttons only: a link-styled twin (e.g. a text 'raise' link) is not a fill.
  const found = buttons(read(file)).filter((t) => new RegExp(`${hook}(\\s|>|=)`).test(t) && classes(t).includes('primary'));
  expect(found.length, `${file} ${hook}`).toBeGreaterThan(0);
  return found;
};

const MONEY: [string, string][] = [
  ['control/Shell.tsx', 'data-send'], ['control/Shell.tsx', 'data-send-in-chat'], ['control/Shell.tsx', 'data-pay-confirm'],
  ['control/Shell.tsx', 'data-request-pay'], ['control/Shell.tsx', 'data-call-accept'], ['control/Shell.tsx', 'data-meeting-invite'],
  ['control/Shell.tsx', 'data-meeting-join'], ['control/Shell.tsx', 'data-budget-raise'], ['control/Shell.tsx', 'data-budget-raise-total'],
  ['control/Shell.tsx', 'data-resume'], ['control/Shell.tsx', 'data-starter-approve'],
  ['control/Porch.tsx', 'data-porch-confirm'], ['control/RoomPanel.tsx', 'data-room-confirm'], ['control/RoomPanel.tsx', 'data-send'],
  ['control/WalletPage.tsx', 'data-wallet-go="receive"'], ['control/WalletPage.tsx', 'data-receive-create'],
  ['control/WalletPage.tsx', 'data-send-review'], ['control/WalletPage.tsx', 'data-wallet-confirm'],
];
const NEUTRAL: [string, string][] = [
  ['control/Shell.tsx', 'data-open-wallet-page'], ['control/Shell.tsx', 'data-door-continue'],
  ['control/RoomPanel.tsx', 'data-room-create'], ['control/RoomPanel.tsx', 'data-room-leave-yes'],
  ['control/Discover.tsx', 'data-discover-knock'], ['control/Discover.tsx', 'data-fd-publish'],
  ['control/ContactPanel.tsx', 'data-contact-verify-start'], ['control/AiTrack.tsx', 'data-ai-prefill'],
  ['control/BodyPanel.tsx', 'data-info-close'],
];

describe('money buttons', () => {
  it.each(MONEY)('%s %s is a money action', (file, hook) => {
    for (const tag of tagWith(file, hook)) expect(classes(tag), tag.slice(0, 120)).toContain('money');
  });
  it.each(NEUTRAL)('%s %s stays neutral', (file, hook) => {
    for (const tag of tagWith(file, hook)) expect(classes(tag), tag.slice(0, 120)).not.toContain('money');
  });
  it('the send button and Add sats are money; onboarding actions are not', () => {
    expect(buttons(read('control/Shell.tsx')).some((t) => classes(t).includes('send-btn') && classes(t).includes('money'))).toBe(true);
    expect(buttons(read('control/WelcomeHome.tsx')).filter((t) => classes(t).includes('money'))).toHaveLength(1);
    expect(buttons(read('onboarding/Onboarding.tsx')).some((t) => classes(t).includes('money'))).toBe(false);
  });
  it('styles .primary neutral and .primary.money orange', () => {
    const css = read('styles.css');
    expect(css).toMatch(/\n\.primary \{ background: var\(--action-bg\); color: var\(--action-ink\);/);
    expect(css).toMatch(/\n\.primary\.money \{ background: var\(--money\);/);
  });
});
