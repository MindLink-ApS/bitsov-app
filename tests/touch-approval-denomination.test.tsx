import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'solid-js/web';
import { TouchApproval } from '../src/control/Shell';
import { setDenom } from '../src/control/prefs';

// Codex app#90: the daily allowance appended a literal "sats" to a number in
// the user's denomination, so BTC mode read "0.000002 sats" for 200 sats.
describe('Touch ID approval terms', () => {
  let dispose: (() => void) | undefined;
  let mount: HTMLElement;
  afterEach(() => {
    dispose?.();
    mount?.remove();
    setDenom('sats');
  });

  const show = () => {
    mount = document.createElement('div');
    document.body.appendChild(mount);
    const actions = { approveContact: async () => {} } as never;
    dispose = render(() => <TouchApproval peer={'a'.repeat(64)} name="Maya" priceMsat={2000} actions={actions} />, mount);
    return mount.querySelector('[data-touch-approval]')!.textContent!;
  };

  it('shows sats with sats', () => {
    setDenom('sats');
    const text = show();
    expect(mount.querySelector('[data-touch-budget]')?.textContent).toBe('200 sats');
    expect(mount.querySelector('[data-touch-per-act]')?.textContent).toBe('2 sats');
    expect(text).toContain('Up to 200 sats in total for up to 24 hours, at most 2 sats per message.');
    expect(text).not.toContain('a day');
  });

  it('shows BTC with BTC, the same 200 sats that get signed', () => {
    setDenom('btc');
    const text = show();
    expect(mount.querySelector('[data-touch-budget]')?.textContent).toBe('0.000002 BTC');
    expect(mount.querySelector('[data-touch-per-act]')?.textContent).toBe('0.00000002 BTC');
    expect(text).not.toMatch(/sats?\b/);
  });
});
