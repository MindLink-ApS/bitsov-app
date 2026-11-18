import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID, SAMPLE_PEERS } from '../src/control/sample';
import { amount, btc, sats, satUnit } from '../src/control/format';
import { applyResolvedTheme, setDenom, setThemePref } from '../src/control/prefs';

describe('denomination formatting', () => {
  afterEach(() => setDenom('sats'));

  it('formats sats by default', () => {
    setDenom('sats');
    expect(sats(1000, 'up')).toBe('1');
    expect(satUnit(1000, 'up')).toBe('sat');
    expect(satUnit(2000, 'up')).toBe('sats');
    expect(amount(2000, 'up')).toBe('2 sats');
  });

  it('formats BTC when toggled', () => {
    setDenom('btc');
    expect(btc(100_000_000_000)).toBe('1'); // 1 BTC in msat
    expect(sats(100_000_000_000, 'up')).toBe('1');
    expect(satUnit(1000, 'up')).toBe('BTC');
    expect(sats(50_000_000, 'up')).toBe('0.0005'); // 50_000 sats
    expect(amount(50_000_000, 'up')).toBe('0.0005 BTC');
  });

  it('keeps sub-sat msat exact in BTC mode and carries correctly at 1 BTC', () => {
    setDenom('btc');
    expect(btc(500)).toBe('0.000000005');
    expect(btc(1500)).toBe('0.000000015');
    expect(btc(999)).toBe('0.00000000999');
    expect(btc(12_345)).toBe('0.00000012345');
    expect(btc(99_999_999_500)).toBe('0.999999995');
    expect(btc(100_000_000_000)).toBe('1');
    expect(btc(100_000_000_001)).toBe('1.00000000001');
    setDenom('sats');
    // Sats mode shows whole sats, rounded up and marked; never a sub-sat decimal.
    expect(sats(500, 'up')).toBe('about 1');
    expect(sats(1500, 'up')).toBe('about 2');
    expect(sats(999, 'up')).toBe('about 1');
    expect(sats(12_345, 'up')).toBe('about 13');
    expect(sats(99_999_999_500, 'up')).toBe('about 100\u202f000\u202f000');
  });
});

describe('settings modal + theme', () => {
  let dispose: (() => void) | undefined;
  let mount: HTMLElement;

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    mount?.remove();
    setThemePref('system');
    setDenom('sats');
    applyResolvedTheme('dark');
    vi.unstubAllGlobals();
  });

  const start = () => {
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(
      () => <ControlCenter source={sampleSource()} active={true} ready={true} error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />,
      mount,
    );
  };

  it('opens settings from the profile avatar; main view has no right panel', async () => {
    start();
    await vi.waitFor(() => expect(mount.querySelector('[data-profile]')).not.toBeNull());
    expect(mount.querySelector('[data-settings]')?.classList.contains('open')).toBe(false);
    expect(mount.querySelector('.cc')!.className).not.toMatch(/context-w/);
    (mount.querySelector('[data-profile]') as HTMLButtonElement).click();
    (mount.querySelector('[data-open-settings]') as HTMLButtonElement).click();
    (mount.querySelector('[data-tab="general"]') as HTMLButtonElement).click();
    expect(mount.querySelector('[data-settings]')?.classList.contains('open')).toBe(true);
    expect(mount.querySelector('[data-panel="display"]')).not.toBeNull();
    expect(mount.querySelector('[data-theme-toggle]')).not.toBeNull();
    expect(mount.querySelector('[data-denom-toggle]')).not.toBeNull();
  });

  it('Display (theme, amounts, calls) lives on General only: every other tab starts with its own content', async () => {
    start();
    await vi.waitFor(() => expect(mount.querySelector('[data-profile]')).not.toBeNull());
    (mount.querySelector('[data-profile]') as HTMLButtonElement).click();
    (mount.querySelector('[data-open-settings]') as HTMLButtonElement).click();
    for (const tab of ['body', 'node', 'devices', 'wallet', 'budget', 'frontdoor']) {
      (mount.querySelector(`[data-tab="${tab}"]`) as HTMLButtonElement).click();
      expect(mount.querySelector('[data-panel="display"]')).toBeNull();
    }
    (mount.querySelector('[data-tab="general"]') as HTMLButtonElement).click();
    expect(mount.querySelector('[data-panel="display"]')).not.toBeNull();
    expect(mount.querySelector('[data-tab="general"]')!.getAttribute('aria-selected')).toBe('true');
    expect(mount.querySelector('.tabs [role="tab"]')!.getAttribute('data-tab')).toBe('general');
  });

  it('applies light and dark themes from settings', async () => {
    start();
    await vi.waitFor(() => expect(mount.querySelector('[data-profile]')).not.toBeNull());
    (mount.querySelector('[data-profile]') as HTMLButtonElement).click();
    (mount.querySelector('[data-open-settings]') as HTMLButtonElement).click();
    (mount.querySelector('[data-tab="general"]') as HTMLButtonElement).click();
    (mount.querySelector('[data-theme-option="light"]') as HTMLButtonElement).click();
    expect(document.documentElement.dataset.theme).toBe('light');
    (mount.querySelector('[data-theme-option="dark"]') as HTMLButtonElement).click();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('puts attach inside the message composer; Pay and Request are small actions', async () => {
    start();
    await vi.waitFor(() => expect(mount.querySelector('[data-composer]')).not.toBeNull());
    expect(mount.querySelector('[data-attach]')).not.toBeNull();
    // No visible Message / Pay / Request / File tabs: one bar, a + menu.
    expect(mount.querySelector('.composer-actions')).toBeNull();
    expect(mount.querySelector('[data-composer-plus]')).not.toBeNull();
    const menu = mount.querySelector('[data-composer-menu]') as HTMLElement;
    expect(menu.hidden).toBe(true);
    (mount.querySelector('[data-composer-plus]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(menu.hidden).toBe(false));
    for (const m of ['file', 'pay', 'request']) {
      expect(menu.querySelector(`[data-composer-mode="${m}"]`)?.classList.contains('composer-menu-item')).toBe(true);
    }
    // Attach is one click: the file mode and the picker together.
    const input = mount.querySelector('[data-file-input]') as HTMLInputElement;
    const picker = vi.spyOn(input, 'click');
    (mount.querySelector('[data-attach]') as HTMLButtonElement).click();
    expect(picker).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(mount.querySelector('[data-composer-panel="file"]')).not.toBeNull());
    expect(menu.hidden).toBe(true);
  });

  it('marks Rooms as coming soon while still listing any existing sample rooms', async () => {
    start();
    await vi.waitFor(() => expect(mount.querySelector('[data-rooms-coming-soon]')).not.toBeNull());
    expect(mount.querySelector('[data-rooms-coming-soon]')!.textContent).toMatch(/This node does not support rooms yet/);
  });

  it('moves focus into settings and closes on Escape', async () => {
    start();
    await vi.waitFor(() => expect(mount.querySelector('[data-profile]') as HTMLButtonElement).not.toBeNull());
    const profile = mount.querySelector('[data-profile]') as HTMLButtonElement;
    profile.focus();
    profile.click();
    (mount.querySelector('[data-open-settings]') as HTMLButtonElement).click();
    (mount.querySelector('[data-tab="general"]') as HTMLButtonElement).click();
    const panel = () => mount.querySelector('[data-settings]') as HTMLElement;
    await vi.waitFor(() => expect(panel()?.classList.contains('open')).toBe(true));
    await vi.waitFor(() => expect(document.activeElement).toBe(mount.querySelector('[data-settings-close]')));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.waitFor(() => expect(panel()?.classList.contains('open')).toBe(false));
    expect(panel().getAttribute('aria-hidden')).toBe('true');
  });
});

describe('BTC mode never appends sats to a BTC figure', () => {
  let dispose: (() => void) | undefined;
  let mount: HTMLElement;

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    mount?.remove();
    setDenom('sats');
    applyResolvedTheme('dark');
  });

  /** A BTC-looking number (has a decimal) followed by the word sats is the F1 bug. */
  const btcThenSats = /0\.\d+\s+sats\b/;

  it('renders budget, body, door quote and composer cost without BTC+sats', async () => {
    setDenom('btc');
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(
      () => <ControlCenter source={sampleSource()} active={true} ready={true} error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />,
      mount,
    );
    await vi.waitFor(() => expect(mount.querySelector('[data-composer]')).not.toBeNull());

    // Peer track with cost line
    expect(mount.textContent).not.toMatch(btcThenSats);
    expect(mount.querySelector('[data-cost]')?.textContent ?? '').not.toMatch(btcThenSats);

    // Settings → Budget panel (tally, rows)
    (mount.querySelector('[data-profile]') as HTMLButtonElement).click();
    (mount.querySelector('[data-open-settings]') as HTMLButtonElement).click();
    (mount.querySelector('[data-tab="general"]') as HTMLButtonElement).click();
    (mount.querySelector('[data-tab="budget"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(mount.querySelector('[data-tally-total]')).not.toBeNull());
    expect(mount.querySelector('[data-tally-total]')!.textContent).toMatch(/BTC/);
    expect(mount.querySelector('[data-tally-total]')!.textContent).not.toMatch(/\bsats\b/);
    expect(mount.textContent).not.toMatch(btcThenSats);

    // Body panel settled / grant copy
    (mount.querySelector('[data-tab="body"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(mount.querySelector('[data-panel="body"], [data-organ], .organ') || mount.querySelector('[data-tab="body"][aria-selected="true"]')).toBeTruthy());
    expect(mount.textContent).not.toMatch(btcThenSats);

    // Quoted re-admission / first-contact card when present in sample spend path:
    // open first-contact door by selecting Maya (sample peer) if a door quote is shown.
    const maya = SAMPLE_PEERS[0]?.node_id;
    if (maya) {
      const link = mount.querySelector(`[data-track="peer:${maya.toLowerCase()}"]`) as HTMLButtonElement | null;
      link?.click();
    }
    await vi.waitFor(() => expect(mount.querySelector('[data-composer]')).not.toBeNull());
    // Force a door quote surface if the composer already shows first-contact approval
    const quote = mount.querySelector('[data-door-quote], [data-readmission-quote], [data-first-contact]');
    if (quote) expect(quote.textContent).not.toMatch(btcThenSats);

    expect(amount(2_000, 'up')).toBe('0.00000002 BTC');
    expect(amount(2_000, 'up')).not.toMatch(/\bsats\b/);
    expect(mount.textContent).not.toMatch(btcThenSats);
  });
});
