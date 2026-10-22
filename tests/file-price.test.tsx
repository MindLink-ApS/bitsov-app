import { afterEach, expect, it } from 'vitest';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';

// Friction #10 (walkthrough 2026-10-12): with approval pending, the file
// composer said only "pays like a message". Its ceiling shows, as for messages.
let dispose: (() => void) | undefined;
let mount: HTMLElement;
afterEach(() => { dispose?.(); mount?.remove(); });

it('shows the file price in the file composer while approval is pending', async () => {
  const source = sampleSource({ firstLiveMs: 1e9 });
  source.filePrice = async () => ({ principal_msat: 3000, max_routing_fee_msat: 5000, total_msat: 8000 });
  mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <ControlCenter source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
  await new Promise((r) => setTimeout(r, 300));
  // Approval is off in sample data; setup is deferred until Send.
  expect(mount.querySelector('[data-budget-setup]')).toBeNull();
  mount.querySelector<HTMLButtonElement>('[aria-label="More: attach, pay, request"]')!.click();
  mount.querySelector<HTMLButtonElement>('[data-composer-mode="file"]')!.click();
  await new Promise((r) => setTimeout(r, 50));
  const price = mount.querySelector('[data-file-price]');
  expect(price?.getAttribute('data-file-price')).toBe('8000');
  expect(price?.textContent).toMatch(/up to 8 sats · includes max routing fee · files up to 1\.4 MB/);
  expect(mount.textContent).not.toContain('pays like a message');
});
