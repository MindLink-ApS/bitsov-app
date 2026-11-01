import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import { ControlCenter, TouchApproval } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';
import { OwnerApprovals } from '../src/control/OwnerApprovals';
import type { ApprovalView } from '../src/control/ownerApproval';
import { RememberUnlock, LockedNode } from '../src/onboarding/LockedNode';
import { AddDevice, JoinDevice } from '../src/onboarding/AddDevice';
import { appPlatform, deviceWord, deviceWords, isMobilePlatform } from '../src/platform';
import { cameraQrScannerAvailable } from '../src/cameraQrScanner';
import { Onboarding } from '../src/onboarding/Onboarding';
import { mobileQrScannerAvailable } from '../src/pairingScanner';
import { phoneCopy } from '../src/onboarding/phoneCopy';

const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const IPAD = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const MACINTOSH = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';
let dispose: (() => void) | undefined;
let mount: HTMLElement;
function show(ui: () => any) {
  mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(ui, mount);
}
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => mount.querySelector<T>(selector)!;
const cleanCopy = (element: Element = mount) => expect(element.textContent).not.toMatch(/\bMac\b|Touch ID|Android|Keystore|desktop|this computer|your fingerprint/);
afterEach(() => { dispose?.(); mount?.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// Exercise the actual Tauri + navigator detection, including iPadOS's desktop UA.
describe.each([
  ['Android', ANDROID, 'phone', 'android'],
  ['iPhone', IPHONE, 'phone', 'ios'],
  ['iPad', IPAD, 'iPad', 'ios'],
  ['iPad (desktop UA)', MACINTOSH, 'iPad', 'ios'],
] as const)('%s mobile copy', (label, userAgent, device, platform) => {
  const namedDevice = platform === 'android' ? 'phone' : label.startsWith('iPad') ? 'iPad' : 'iPhone';
  beforeEach(() => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
    vi.spyOn(navigator, 'maxTouchPoints', 'get').mockReturnValue(5);
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: () => Promise.reject('unused host command') });
  });

  it('detects mobile and enables the native scanner on both mobile platforms', () => {
    expect(appPlatform()).toBe(platform);
    expect(isMobilePlatform()).toBe(true);
    expect(deviceWord()).toBe(device);
    expect(deviceWords().device).toBe(namedDevice);
    expect(mobileQrScannerAvailable()).toBe(true);
    expect(cameraQrScannerAvailable(userAgent, { getUserMedia: vi.fn() })).toBe(false);
  });

  it.each(['starting', 'pending', 'paired'] as const)('enrolled onboarding uses mobile copy while %s', state => {
    show(() => <Onboarding status={() => ({ ready: state === 'paired', node_id: 'ab'.repeat(32), error: null })}
      pairing={() => ({ state, remote: true, scopes: ['read'], bootstrap: null, short_code: 'AB-CD', code_from_node: true, reason: null })}
      trustAck={() => false} onRetry={() => {}}
      device={() => ({ available: true, state: 'registered', fingerprint: 'AB-CD', owner_action: null, expires_at_ms: null })} />);
    cleanCopy();
    if (device === 'iPad') expect(mount.textContent).not.toMatch(/this phone|iPhone/);
    expect(mount.textContent).toMatch(/Biometric/);
  });

  it.each(['none', 'pending'] as const)('spending setup uses mobile copy with device %s', async state => {
    const source = sampleSource({ firstLiveMs: 1e9 });
    source.deviceKeyStatus = async () => ({ available: true, state, fingerprint: 'AB-CD', owner_action: null, expires_at_ms: null });
    source.budgetStatus = async () => { throw new Error('budget API unavailable'); };
    source.spendStatus = async () => ({ state: 'pending', lapse: null, basis: null, open_until_ms: null, window_ms: 600000,
      pending: { op_id: 'ab01', expires_at_ms: Date.now() + 600000, owner_action: 'konsensus grant --op ab01', owner_can_grant: true } });
    show(() => <ControlCenter source={source} remote active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />);
    await vi.waitFor(() => expect($('[data-track^="peer:"]')).not.toBeNull());
    $<HTMLButtonElement>('[data-track^="peer:"]').click();
    const selector = state === 'none' ? '[data-touch-id-first]' : '[data-device-settings-hint]';
    await vi.waitFor(() => expect($(selector)).not.toBeNull());
    cleanCopy($(selector));
    expect($(selector).textContent).toMatch(/biometric/i);
    if (state === 'none') expect($(selector).textContent).toContain(`Approve on this ${device} with biometrics`);
  });

  it('Remember uses biometric wording even when only the platform prop is supplied', async () => {
    show(() => <RememberUnlock platform={platform} onChoose={async () => {}} onDone={() => {}} />);
    expect(mount.textContent).toContain(`Remember the password on this ${namedDevice}`);
    expect(mount.textContent).toContain('Then set up biometric approvals again');
    expect($('[data-remember-yes]').textContent).toContain('(biometrics)');
    cleanCopy();
    $<HTMLButtonElement>('[data-remember-yes]').click();
    await vi.waitFor(() => expect($('[data-remember-saved]')?.textContent).toContain(`Saved on this ${namedDevice}`));
    cleanCopy();
  });

  it('locked enrollment instructions use the platform even without a mobile prop', () => {
    show(() => <LockedNode platform={platform} state="not-enrolled" onUnlock={async () => {}} />);
    expect(mount.textContent).toContain(`This ${namedDevice} is not an approved owner device yet`);
    expect(mount.textContent).toContain('Set up biometric approvals');
    cleanCopy();
  });

  it('App wires typed unlock to a mobile Remember offer', async () => {
    let locked = true;
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: (cmd: string) => {
      if (cmd === 'node_status') return Promise.resolve({ ready: !locked, node_id: 'ab'.repeat(32), error: null, locked, typed_unlock_supported: true, remember_offer: !locked });
      if (cmd === 'pairing_status') return Promise.resolve({ state: 'paired', remote: true, scopes: ['read'], bootstrap: null });
      if (cmd === 'node_unlock_password') { locked = false; return Promise.resolve(); }
      return Promise.reject('unavailable');
    } });
    show(() => <App />);
    await vi.waitFor(() => expect($('#node-unlock-password')).not.toBeNull());
    cleanCopy($('[data-node-locked]'));
    const input = $<HTMLInputElement>('#node-unlock-password');
    input.value = 'test password'; input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    input.closest('form')!.requestSubmit();
    await vi.waitFor(() => expect($('[data-remember-unlock]')).not.toBeNull());
    cleanCopy($('[data-remember-unlock]'));
    expect($('[data-remember-unlock]').textContent).toContain(`this ${namedDevice}`);
  });

  it('App routes saved first-run tickets through phoneCopy without an unavailable error or reconnect button', async () => {
    const message = "This box isn't set up yet. Finish setup on a Mac, then add this phone.";
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: (cmd: string) => {
      if (cmd === 'node_status') return Promise.resolve({ phone_setup: true, ready: false, node_id: null, error: message, connection_error: { kind: 'unclaimed', detail: message } });
      if (cmd === 'pairing_status') return Promise.resolve({ state: 'starting', remote: false, scopes: [], bootstrap: null });
      return Promise.reject('unavailable');
    } });
    show(() => <App />);
    await vi.waitFor(() => expect(mount.textContent).toContain("This box isn't set up yet"));
    expect($('[data-phone-onboarding="error"] h1').textContent).toBe("This box isn't set up yet");
    expect(mount.textContent).toContain(phoneCopy.en.unclaimedLine);
    expect($('[data-first-run]')).toBeNull();
    expect(mount.textContent).not.toContain('Your node is unavailable');
    expect(Array.from(mount.querySelectorAll('button')).some(b => b.textContent === 'Reconnect')).toBe(false);
  });

  it('App preserves device-specific first-run guidance outside the new phone setup flow', async () => {
    const message = "This box isn't set up yet. Finish setup on a Mac, then add this phone.";
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: (cmd: string) => {
      if (cmd === 'node_status') return Promise.resolve({ phone_setup: false, ready: false, node_id: null, error: message });
      if (cmd === 'pairing_status') return Promise.resolve({ state: 'starting', remote: false, scopes: [], bootstrap: null });
      return Promise.reject('unavailable');
    } });
    show(() => <App />);
    const shown = device === 'iPad'
      ? "This box isn't set up yet. Finish setup on a Mac, then add this iPad."
      : "This box isn't set up yet. Finish setup on a Mac, then add this phone.";
    await vi.waitFor(() => expect($('.state.error [role="status"]')?.textContent).toBe(shown));
    expect($('[data-phone-onboarding]')).toBeNull();
    if (device === 'iPad') expect(mount.textContent).not.toContain('this phone');
    expect(mount.textContent).not.toContain('Your node is unavailable');
    expect(Array.from(mount.querySelectorAll('button')).some(b => b.textContent === 'Reconnect')).toBe(false);
  });

  it('first-run ticket review names the device and still blocks import', async () => {
    const save = vi.fn();
    show(() => <Onboarding status={() => ({ ready: false, node_id: null, error: null })}
      pairing={() => ({ state: 'starting', remote: false, scopes: [], bootstrap: null, short_code: null, code_from_node: false, reason: null })}
      trustAck={() => false} onRetry={() => {}} phone mobile selectedTarget="network"
      onPreviewRemote={async () => ({ endpoint: 'box:9737', node_id_fingerprint: '22…22', first_run: true })}
      onImportRemote={save} initialPairingLink="bitsov://pair/test" />);
    const form = $<HTMLFormElement>('form[data-remote-access]');
    form.requestSubmit();
    const shown = device === 'iPad'
      ? "This box isn't set up yet. Finish setup on a Mac, then add this iPad."
      : "This box isn't set up yet. Finish setup on a Mac, then add this phone.";
    await vi.waitFor(() => expect($('[data-pairing-preview]')?.textContent).toBe(shown));
    if (device === 'iPad') expect(mount.textContent).not.toContain('this phone');
    expect(form.querySelector('button[type="submit"]')).toBeNull();
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    expect(save).not.toHaveBeenCalled();
  });

  it('App pairing names the device in first run and the incoming-link dialog, with a native scanner on both mobile platforms', async () => {
    let link: string | null = 'bitsov://pair/test-ticket';
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: (cmd: string) => {
      if (cmd === 'pairing_link_take') { const pending = link; link = null; return Promise.resolve(pending); }
      if (cmd === 'node_status') return Promise.resolve({ ready: false, node_id: null, error: null });
      if (cmd === 'pairing_status') return Promise.resolve({ state: 'starting', remote: true, scopes: [], bootstrap: null });
      return Promise.reject('unavailable');
    } });
    show(() => <App />);
    await vi.waitFor(() => expect($('[data-review-pairing]')).not.toBeNull());
    expect(mount.textContent).toContain(`Connect this ${device} to your box`);
    expect($('[data-target="local"]')).toBeNull();
    expect($('[data-step="node"]')).toBeNull();
    expect(mount.textContent).not.toMatch(/This Mac|Use this Mac instead|Start local node/);
    $<HTMLButtonElement>('[data-review-pairing]').click();
    const dialog = $('[data-pairing-link-screen]');
    expect(dialog.getAttribute('aria-label')).toBe(`Pair this ${device} with your box`);
    expect(dialog.querySelector('h1')?.textContent).toBe(`Pair this ${device} with your box`);
    expect(dialog.textContent).toContain(`does not pair this ${device}`);
    expect(!!dialog.querySelector('[data-scan-pairing-qr]')).toBe(true);
    cleanCopy(dialog);
    if (device === 'iPad') expect(dialog.textContent).not.toMatch(/this phone|iPhone/);
  });

  it('Settings wires mobile approvals, including pending device naming', async () => {
    show(() => <ControlCenter source={sampleSource({ firstLiveMs: 1e9 })} remote active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />);
    await vi.waitFor(() => expect($('[data-tab="node"]')).not.toBeNull());
    $<HTMLButtonElement>('[data-tab="node"]').click();
    await vi.waitFor(() => expect($('[data-device-register]')).not.toBeNull());
    cleanCopy($('[data-device-approvals]'));
    expect($('[data-device-register]').textContent).toBe('Set up biometric approvals');
    $<HTMLButtonElement>('[data-device-register]').click();
    await vi.waitFor(() => expect($('[data-device-fingerprint]')?.textContent).toBe('3F9A-12C4-77B0-E51D'));
    expect($('[data-device-approvals]').textContent).toContain(`this ${namedDevice}`);
    cleanCopy($('[data-device-approvals]'));
  });

  it('contact and owner approval cards use biometrics and the correct device', () => {
    const approval: ApprovalView = {
      op_id: 'op-1', node: 'n', client_id: 'client', client_pubkey: 'cd'.repeat(32), epoch: 4, grant_op: 'g',
      request: { kind: 'first_contact', terms: { recipient: 'a'.repeat(64), max_total_msat: 14000, budget_msat: 50000 } },
      nonce: '11'.repeat(16), expires_at: Date.now() / 1000 + 200, approval_message: 'test message', status: 'pending', owner_action: null,
    };
    show(() => <>
      <TouchApproval peer={'a'.repeat(64)} name="Maya" priceMsat={2000} actions={{ approveContact: async () => {} } as never} />
      <OwnerApprovals approvals={[approval]} now={Date.now()} approve={vi.fn()} />
    </>);
    expect($('[data-approval-message] summary').textContent).toBe(`Exact message your ${device} signs`);
    expect($('[data-touch-approval]').textContent).toContain('with biometrics');
    cleanCopy();
  });

  it('AddDevice and JoinDevice avoid desktop approval instructions', async () => {
    const waiting = { words: ['one', 'two', 'three', 'four'], expires_at: Date.now() / 1000 + 200 };
    show(() => <>
      <AddDevice api={async () => ({ state: 'ticket', uri: '', expires_at: waiting.expires_at, pending: [{ ...waiting, op_id: 'op', name: 'new device' }] })} />
      <JoinDevice api={async () => ({ state: 'waiting', ...waiting })} />
    </>);
    await vi.waitFor(() => expect($('[data-add-device]').textContent).toContain('Approve with biometrics'));
    await vi.waitFor(() => expect($('[data-join-device]').textContent).toContain('approve there with biometrics'));
    cleanCopy();
  });
});
