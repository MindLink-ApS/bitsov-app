import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { DeviceApprovals } from '../src/onboarding/DeviceApprovals';
import { Onboarding } from '../src/onboarding/Onboarding';
import type { DeviceView } from '../src/control/types';
import type { NodeStatus, PairingView } from '../src/onboarding/pairing';

let dispose: (() => void) | undefined;
let mount: HTMLElement;
afterEach(() => { dispose?.(); dispose = undefined; mount?.remove(); });
const view = (state: DeviceView['state'], over: Partial<DeviceView> = {}): DeviceView =>
  ({ available: true, state, fingerprint: state === 'pending' ? 'fp-abcd' : null, owner_action: state === 'pending' ? 'konsensus device approve fp-abcd' : null, expires_at_ms: null, ...over });
const show = (jsx: () => unknown) => { mount = document.createElement('div'); document.body.appendChild(mount); dispose = render(jsx as never, mount); return mount; };

describe('Touch ID approvals section', () => {
  it('offers setup in one tap and starts registration', async () => {
    const onRegister = vi.fn(async () => {});
    const el = show(() => <DeviceApprovals remote device={view('none')} onRegister={onRegister} onCancel={async () => {}} />);
    const button = el.querySelector<HTMLButtonElement>('[data-device-register]')!;
    expect(button.textContent).toBe('Set up Touch ID approvals');
    button.click();
    await vi.waitFor(() => expect(onRegister).toHaveBeenCalledTimes(1));
  });

  it('shows the owner approval step while pending, and the on state only where asked', () => {
    let el = show(() => <DeviceApprovals remote device={view('pending')} onRegister={async () => {}} onCancel={async () => {}} />);
    expect(el.querySelector('[data-device-fingerprint]')?.textContent).toBe('fp-abcd');
    dispose?.(); mount.remove();
    el = show(() => <DeviceApprovals remote device={view('registered')} onRegister={async () => {}} onCancel={async () => {}} />);
    expect(el.querySelector('[data-device-approvals]')).toBeNull();
    dispose?.(); mount.remove();
    el = show(() => <DeviceApprovals remote device={view('registered')} showRegistered onRegister={async () => {}} onCancel={async () => {}} />);
    expect(el.querySelector('[data-device-approvals-on]')?.textContent).toContain('Touch ID approvals are on for this Mac');
  });

  it('shows nothing without a Secure Enclave or before the host reports a state', () => {
    let el = show(() => <DeviceApprovals remote device={view('none', { available: false })} onRegister={async () => {}} onCancel={async () => {}} />);
    expect(el.querySelector('[data-device-approvals]')).toBeNull();
    dispose?.(); mount.remove();
    el = show(() => <DeviceApprovals remote device={null} onRegister={async () => {}} onCancel={async () => {}} />);
    expect(el.querySelector('[data-device-approvals]')).toBeNull();
  });

  it('says why setup did not start, in place', async () => {
    const el = show(() => <DeviceApprovals remote device={view('none')} onRegister={async () => { throw 'The node is locked.'; }} onCancel={async () => {}} />);
    el.querySelector<HTMLButtonElement>('[data-device-register]')!.click();
    await vi.waitFor(() => expect(el.querySelector('[role="alert"]')?.textContent).toBe('The node is locked.'));
  });
});

describe('onboarding offers Touch ID approvals right after pairing', () => {
  const ready: NodeStatus = { ready: true, node_id: 'ab'.repeat(33), error: null };
  const paired: PairingView = { remote: true, state: 'paired', scopes: ['read', 'receive'], short_code: null, code_from_node: false, reason: null, bootstrap: null };
  const starting: PairingView = { ...paired, state: 'starting' };
  const onboarding = (pairing: PairingView, status: NodeStatus) => show(() => (
    <Onboarding status={() => status} pairing={() => pairing} trustAck={() => false} onRetry={() => {}}
      device={() => view('none')} onRegisterDevice={async () => {}} onCancelDevice={async () => {}} />
  ));

  it('appears once paired, and Not now hides it', () => {
    const el = onboarding(paired, ready);
    expect(el.querySelector('[data-device-approvals="none"]')).not.toBeNull();
    el.querySelector<HTMLButtonElement>('[data-device-approvals-skip]')!.click();
    expect(el.querySelector('[data-device-approvals]')).toBeNull();
  });

  it('is not offered before the app is paired', () => {
    const el = onboarding(starting, { ready: false, node_id: null, error: null });
    expect(el.querySelector('[data-device-approvals]')).toBeNull();
  });
});

describe('Settings → Node holds Touch ID approvals', () => {
  afterEach(() => { try { localStorage.removeItem('bitsov.sample_device'); } catch { /* none */ } });
  it('offers setup there, and registering moves it to the owner approval step', async () => {
    const { ControlCenter } = await import('../src/control/Shell');
    const { sampleSource, SAMPLE_OWN_ID } = await import('../src/control/sample');
    const source = sampleSource({ firstLiveMs: 1e9 });
    show(() => <ControlCenter source={source} remote active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />);
    await vi.waitFor(() => expect(mount.querySelector('[data-tab="node"]')).not.toBeNull());
    (mount.querySelector('[data-tab="node"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(mount.querySelector('[data-panel="node"] [data-device-approvals]')).not.toBeNull());
    // The sample device starts unregistered.
    mount.querySelector<HTMLButtonElement>('[data-panel="node"] [data-device-register]')!.click();
    await vi.waitFor(() => expect(mount.querySelector('[data-panel="node"] [data-device-fingerprint]')?.textContent).toBe('3F9A-12C4-77B0-E51D'));
  });
});

describe('a local node gets no at-the-node registration (docs/ONBOARDING_PAIRING.md)', () => {
  it('shows nothing to set up, only an off reason when the host gives one', () => {
    let el = show(() => <DeviceApprovals remote={false} device={view('none')} onRegister={async () => {}} onCancel={async () => {}} />);
    expect(el.querySelector('[data-device-approvals]')).toBeNull();
    dispose?.(); mount.remove();
    el = show(() => <DeviceApprovals remote={false} device={view('pending')} onRegister={async () => {}} onCancel={async () => {}} />);
    expect(el.querySelector('[data-device-owner-action]')).toBeNull();
    dispose?.(); mount.remove();
    el = show(() => <DeviceApprovals remote={false} device={view('off', { off_reason: 'seed_not_encrypted', off_message: 'Encrypt your recovery phrase first.' })} onRegister={async () => {}} onCancel={async () => {}} />);
    expect(el.querySelector('[data-device-off="seed_not_encrypted"]')?.textContent).toContain('Encrypt your recovery phrase first.');
    expect(el.querySelector('[data-device-register]')).toBeNull();
  });

  it('onboarding on a local node does not offer setup', () => {
    const ready: NodeStatus = { ready: true, node_id: 'ab'.repeat(33), error: null };
    const local: PairingView = { remote: false, state: 'paired', scopes: ['read', 'receive'], short_code: null, code_from_node: false, reason: null, bootstrap: null };
    const el = show(() => (
      <Onboarding status={() => ready} pairing={() => local} trustAck={() => false} onRetry={() => {}}
        device={() => view('none')} onRegisterDevice={async () => {}} onCancelDevice={async () => {}} />
    ));
    expect(el.querySelector('[data-device-approvals]')).toBeNull();
  });
});
