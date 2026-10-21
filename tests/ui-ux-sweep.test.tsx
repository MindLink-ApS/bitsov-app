import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { render } from 'solid-js/web';
import { WelcomeHome } from '../src/control/WelcomeHome';

// Locks the cosmetic fixes from docs/qa/UIUX-SWEEP-2026-10-20.md.
// Behaviour that was left alone (stream tab order, MindLink hub copy, peer names) is not asserted here.

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.innerHTML = '';
});

const css = () => readFileSync('src/styles.css', 'utf8');
const line = (source: string, prefix: string) => source.split('\n').find((l) => l.startsWith(prefix));

it('does not say the whole app lacks a camera', () => {
  const mount = document.createElement('div');
  document.body.append(mount);
  dispose = render(
    () => (
      <WelcomeHome
        overview={null}
        moneyBlocked={false}
        walletReady={false}
        onShare={() => {}}
        onAddContact={() => {}}
        onAddSats={() => {}}
      />
    ),
    mount,
  );
  expect(mount.textContent).toContain('Camera scanning is not available for profile cards.');
  expect(mount.textContent).not.toContain('not available in this app');
});

it('keeps the sweep contrast, token, and focus fixes', () => {
  const source = css();
  expect(line(source, '.attach.soft:hover')).toContain('color: var(--ink)');
  expect(line(source, '.attach.soft:hover')).not.toContain('accent-ink');
  expect(line(source, '.touchid-check')).toContain('color: var(--bg)');
  expect(line(source, '.amount-field .amount-input:focus-visible')).toContain('outline: 2px solid var(--accent)');
  expect(line(source, '.node-target-card.selected {')).toContain('border-color: var(--ink)');
  expect(line(source, '.connection-card')).toContain('border-radius: var(--r-control)');
  expect(source).toContain('.rail .track-link { width: max-content; }');
  expect(source).toContain("html[data-theme='light'] .target-badge.honest { color: #6b4c00; }");
  expect(source).toContain("html[data-theme='light'] .contact-pill.ok");
  expect(source).toContain('--t-hero: 64px');
  expect(line(source, '.wallet-total')).toContain('font-size: var(--t-hero)');
  expect(readFileSync('index.html', 'utf8')).toContain('rel="icon"');
  expect(readFileSync('src/control/Shell.tsx', 'utf8')).toContain('1 sat = 1,000');
});
