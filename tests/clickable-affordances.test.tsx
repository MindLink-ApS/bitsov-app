import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';

let dispose: (() => void) | undefined;
let mount: HTMLElement;
afterEach(() => { dispose?.(); mount?.remove(); });

it('the node status pill reads as a button and opens Settings → Node', async () => {
  mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <ControlCenter source={sampleSource({ firstLiveMs: 1e9 })} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
  await vi.waitFor(() => expect(mount.querySelector('.node-pill .pill-chevron')).not.toBeNull());
  const pill = mount.querySelector<HTMLButtonElement>('.node-pill')!;
  expect(pill.getAttribute('aria-haspopup')).toBe('dialog');
  expect(pill.title).toContain('open node settings');
  // The chevron adds no words to the status text.
  expect(mount.querySelector('.node-pill .what')?.textContent).toBe('Node live');
  pill.click();
  await vi.waitFor(() => expect(mount.querySelector('[data-tab="node"]')?.getAttribute('aria-selected')).toBe('true'));
  expect(mount.querySelector('[data-panel="node"]')).not.toBeNull();
});

it('tabs have a hover fill and a distinct selected fill', () => {
  const css = readFileSync(join(__dirname, '../src/styles.css'), 'utf8');
  expect(css).toMatch(/\.tabs button:hover:not\(\[aria-selected='true'\]\) \{[^}]*background: var\(--raised\)/);
  expect(css).toMatch(/\.tabs button\[aria-selected='true'\] \{[^}]*background: var\(--line-strong\)[^}]*font-weight: 600/);
  expect(css).toMatch(/\.node-pill \{[^}]*cursor: pointer/);
});
