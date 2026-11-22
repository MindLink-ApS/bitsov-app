import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { setLanguagePref } from '../src/i18n';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';

let dispose: (() => void) | undefined;
let mount: HTMLDivElement;
afterEach(() => {
  dispose?.(); mount?.remove(); setLanguagePref('en');
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
describe.each([
  ['macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', true],
  ['Linux', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36', false],
  ['Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', false],
] as const)('%s desktop settings', (_host, userAgent, _macOS) => {
  beforeEach(() => {
    vi.stubGlobal('isTauri', true);
    vi.stubGlobal('__TAURI_INTERNALS__', {
      invoke: () => Promise.reject(new Error('unused native command')), transformCallback: () => 0,
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
    });
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
    vi.spyOn(navigator, 'maxTouchPoints', 'get').mockReturnValue(0);
    mount = document.createElement('div'); document.body.append(mount);
  });
  it.each(['en', 'da'] as const)('hides unavailable %s settings and keeps message notifications in the desktop shell', async lang => {
    setLanguagePref(lang);
    const source = sampleSource({ firstLiveMs: 1e9 });
    source.deviceKeyStatus = async () => ({ available: false, state: 'unavailable', fingerprint: null, owner_action: null, expires_at_ms: null });
    dispose = render(() => <ControlCenter source={source} remote active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={null} />, mount);
    await vi.waitFor(() => expect(mount.querySelector('[data-tab="general"]')).not.toBeNull());
    mount.querySelector<HTMLButtonElement>('[data-tab="general"]')!.click();
    // Message notifications are offered on every desktop; only the Mac adds calls.
    expect(mount.querySelector('[data-notification-settings]')).not.toBeNull();
    mount.querySelector<HTMLButtonElement>('[data-tab="node"]')!.click();
    await vi.waitFor(() => expect(mount.querySelector('[data-connection-card]')).not.toBeNull());
    expect(mount.querySelector('[data-device-approvals]')).toBeNull();
    expect(mount.querySelector('[data-device-register]')).toBeNull();
  });
});
