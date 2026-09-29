import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';
import { btc, sats, satUnit } from '../src/control/format';
import { applyResolvedTheme, setDenom, setThemePref } from '../src/control/prefs';

describe('denomination formatting', () => {
  afterEach(() => setDenom('sats'));

  it('formats sats by default', () => {
    setDenom('sats');
    expect(sats(1000)).toBe('1');
    expect(satUnit(1000)).toBe('sat');
    expect(satUnit(2000)).toBe('sats');
  });

  it('formats BTC when toggled', () => {
    setDenom('btc');
    expect(btc(100_000_000_000)).toBe('1'); // 1 BTC in msat
    expect(sats(100_000_000_000)).toBe('1');
    expect(satUnit(1000)).toBe('BTC');
    expect(sats(50_000_000)).toBe('0.0005'); // 50_000 sats
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

  it('keeps the main view to sidebar + chat; settings open from the profile avatar', async () => {
    start();
    await vi.waitFor(() => expect(mount.querySelector('[data-profile]')).not.toBeNull());
    expect(mount.querySelector('[data-settings]')?.classList.contains('open')).toBe(false);
    expect(mount.querySelector('.cc')!.className).not.toMatch(/context-w/);
    (mount.querySelector('[data-profile]') as HTMLButtonElement).click();
    expect(mount.querySelector('[data-settings]')?.classList.contains('open')).toBe(true);
    expect(mount.querySelector('[data-panel="display"]')).not.toBeNull();
    expect(mount.querySelector('[data-theme-toggle]')).not.toBeNull();
    expect(mount.querySelector('[data-denom-toggle]')).not.toBeNull();
  });

  it('applies light and dark theme from settings', async () => {
    start();
    await vi.waitFor(() => expect(mount.querySelector('[data-profile]')).not.toBeNull());
    (mount.querySelector('[data-profile]') as HTMLButtonElement).click();
    (mount.querySelector('[data-theme-option="light"]') as HTMLButtonElement).click();
    expect(document.documentElement.dataset.theme).toBe('light');
    (mount.querySelector('[data-theme-option="dark"]') as HTMLButtonElement).click();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('puts attach inside the message composer; Pay and Request are small actions', async () => {
    start();
    await vi.waitFor(() => expect(mount.querySelector('[data-composer]')).not.toBeNull());
    expect(mount.querySelector('[data-attach]')).not.toBeNull();
    expect(mount.querySelector('[data-composer-mode="pay"]')?.classList.contains('composer-action')).toBe(true);
    expect(mount.querySelector('[data-composer-mode="request"]')?.classList.contains('composer-action')).toBe(true);
    expect(mount.querySelector('[data-composer-mode="file"]')?.classList.contains('composer-action')).toBe(true);
    (mount.querySelector('[data-attach]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(mount.querySelector('[data-file-input]')).not.toBeNull());
  });
});
