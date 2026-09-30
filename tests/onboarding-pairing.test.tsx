import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { Onboarding } from '../src/onboarding/Onboarding';
import { onboardingSteps, type NodeStatus, type PairingView } from '../src/onboarding/pairing';
import type { DeviceView } from '../src/control/types';

const starting: PairingView = {
  state: 'starting',
  scopes: [],
  short_code: null,
  code_from_node: false,
  reason: null,
  bootstrap: null,
};
const pending: PairingView = { ...starting, state: 'pending' };
const paired: PairingView = {
  ...starting,
  state: 'paired',
  scopes: ['read', 'receive'],
  short_code: 'ABCD-EFGH',
  code_from_node: true,
};
const failed: PairingView = {
  ...starting,
  state: 'failed',
  reason: 'the node refused /pair/request (409): pairing is closed',
};
const fallback: PairingView = { ...starting, state: 'fallback' };

const booting: NodeStatus = { ready: false, node_id: null, error: null };
const ready: NodeStatus = { ready: true, node_id: 'ab'.repeat(33), error: null };

describe('onboarding steps', () => {
  it('orders the first run: start node, pair, identity, fund', () => {
    const steps = onboardingSteps(booting, starting, false);
    expect(steps.map((s) => s.id)).toEqual(['node', 'pair', 'identity', 'fund']);
    expect(steps.map((s) => s.status)).toEqual(['active', 'todo', 'todo', 'todo']);
  });

  it('pending: node done, pairing active', () => {
    expect(onboardingSteps(booting, pending, false).map((s) => s.status)).toEqual([
      'done',
      'active',
      'todo',
      'todo',
    ]);
  });

  it('paired + identity ready: identity active until the trust gate is accepted', () => {
    expect(onboardingSteps(ready, paired, false).map((s) => s.status)).toEqual([
      'done',
      'done',
      'active',
      'todo',
    ]);
    expect(onboardingSteps(ready, paired, true).map((s) => s.status)).toEqual([
      'done',
      'done',
      'done',
      'active',
    ]);
  });

  it('failed pairing blocks everything after it', () => {
    expect(onboardingSteps(booting, failed, false).map((s) => s.status)).toEqual([
      'done',
      'failed',
      'todo',
      'todo',
    ]);
  });

  it('fallback counts as authenticated, not as paired', () => {
    const steps = onboardingSteps(ready, fallback, false);
    expect(steps[1].status).toBe('skipped');
    expect(steps[2].status).toBe('active');
  });

  it('an identity-free node blocks the identity step on the genome tag', () => {
    const steps = onboardingSteps(booting, { ...paired, bootstrap: 'bootstrap' }, false);
    expect(steps[2].status).toBe('blocked');
  });

  it('a node start error fails the first step', () => {
    const steps = onboardingSteps({ ...booting, error: 'node did not become healthy' }, starting, false);
    expect(steps[0].status).toBe('failed');
  });
});

describe('pairing panel', () => {
  let dispose: (() => void) | undefined;
  let mount: HTMLElement | undefined;

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    mount?.remove();
    mount = undefined;
  });

  const show = (
    pairing: PairingView,
    status: NodeStatus = booting,
    onRetry = () => {},
    device: DeviceView | null = null,
  ) => {
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(
      () => (
        <Onboarding
          status={() => status}
          pairing={() => pairing}
          trustAck={() => false}
          onRetry={onRetry}
          device={() => device}
        />
      ),
      mount,
    );
    return mount;
  };

  it('pending shows progress and no code yet', () => {
    const el = show(pending);
    const panel = el.querySelector('[data-pairing="pending"]');
    expect(panel?.textContent).toContain('Pairing this app with your node');
    expect(el.querySelector('[data-short-code]')).toBeNull();
  });

  it('paired shows read + receive and the code as a tripwire, not a control', () => {
    const el = show(paired, ready);
    const panel = el.querySelector('[data-pairing="paired"]')!;
    expect(panel.textContent).toContain('read + receive');
    const code = el.querySelector('[data-short-code]')!;
    expect(code.textContent).toContain('ABCD-EFGH');
    expect(code.textContent).toContain('matches what your node printed');
    expect(panel.textContent).toContain('tripwire');
    expect(panel.textContent).not.toMatch(/secur(e|es) (your|the) pairing|prevents/i);
    expect(panel.textContent).toContain('cannot spend');
    expect(panel.textContent).toContain('cannot replace a live identity');
    expect(panel.textContent).toContain('owner CLI');
    expect(panel.textContent).toContain('Less exposure, not solved local security');
  });

  it('a code the app could not match against node output is not labelled as matching', () => {
    const el = show({ ...paired, code_from_node: false }, ready);
    const code = el.querySelector('[data-short-code]')!;
    expect(code.textContent).toContain('ABCD-EFGH');
    expect(code.textContent).not.toContain('matches what your node printed');
    expect(code.textContent).toContain('compare it with what your node printed');
  });

  it('failed shows the reason and a retry, and never claims a fallback', () => {
    const onRetry = vi.fn();
    const el = show(failed, booting, onRetry);
    const panel = el.querySelector('[data-pairing="failed"]')!;
    expect(panel.textContent).toContain('pairing is closed');
    expect(panel.textContent).toContain('did not fall back');
    const retry = panel.querySelector('button')!;
    retry.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(el.querySelector('[data-pairing="paired"]')).toBeNull();
  });

  it('fallback explains the rc7 node and does not claim pairing scopes', () => {
    const el = show(fallback, ready);
    const panel = el.querySelector('[data-pairing="fallback"]')!;
    expect(panel.textContent).toContain('v0.3.0-rc7');
    expect(panel.textContent).toContain('/auth/local');
    expect(panel.textContent).not.toContain('read + receive');
    expect(el.querySelector('[data-short-code]')).toBeNull();
  });

  it('identity-free node says create/restore waits on the genome tag', () => {
    const el = show({ ...paired, scopes: ['read', 'receive', 'identity'], bootstrap: 'bootstrap' });
    const panel = el.querySelector('[data-pairing="paired"]')!;
    expect(panel.textContent).toContain('read + receive + identity');
    expect(el.textContent).toContain('identity-free');
    expect(el.textContent).toContain('genome release');
  });

  it('renders 3 honest node location choices: local active, network and cloud disabled Coming soon', () => {
    const el = show(starting, booting);
    const local = el.querySelector<HTMLButtonElement>('[data-target="local"]')!;
    const network = el.querySelector<HTMLButtonElement>('[data-target="network"]')!;
    const cloud = el.querySelector<HTMLButtonElement>('[data-target="cloud"]')!;

    expect(local).not.toBeNull();
    expect(network).not.toBeNull();
    expect(cloud).not.toBeNull();

    expect(local.disabled).toBe(false);
    expect(local.classList.contains('selected')).toBe(true);
    expect(local.textContent).toContain('This computer');
    expect(local.textContent).toContain('Run your sovereign node directly on this Mac');

    expect(network.disabled).toBe(true);
    expect(network.getAttribute('aria-disabled')).toBe('true');
    expect(network.textContent).toContain('A node on my network');
    expect(network.textContent).toContain('Coming soon');
    expect(network.textContent).toContain(
      'Connecting to a home server on your local network is coming soon; today the app connects to the node on this Mac.',
    );

    expect(cloud.disabled).toBe(true);
    expect(cloud.getAttribute('aria-disabled')).toBe('true');
    expect(cloud.textContent).toContain('A cloud node');
    expect(cloud.textContent).toContain('Coming soon');
    expect(cloud.textContent).toContain(
      'Hosted cloud nodes and remote signing are coming soon; today the app connects to the node on this Mac.',
    );

    // Simulated scan spinners and fake address inputs are removed
    expect(el.querySelector('.spinner')).toBeNull();
    expect(el.querySelector('input[type="text"]')).toBeNull();
  });

  it('describes pairing honestly without Touch ID / Secure Enclave claims when device key is not registered', () => {
    const el = show(paired, ready, () => {}, {
      available: true,
      state: 'none',
      fingerprint: null,
      owner_action: null,
      expires_at_ms: null,
    });
    const panel = el.querySelector('[data-pairing="paired"]')!;
    expect(panel.querySelector('[data-device-badge="none"]')?.textContent).toBe('App paired');
    expect(panel.querySelector('[data-device-badge="registered"]')).toBeNull();
    expect(panel.textContent).not.toContain('Touch ID Enrolled');
    expect(panel.textContent).not.toContain('Secure Enclave');
    expect(panel.textContent).not.toContain('Touch ID approves every payment');
    expect(panel.textContent).toContain('Loopback authenticated. Ordinary pairing is file-backed on this Mac.');
    expect(el.textContent).toContain('The app connects to your sovereign node on this Mac.');
    expect(el.textContent).not.toContain('Touch ID on this Mac can approve a contact or budget.');
  });

  it('claims Touch ID Enrolled and Secure Enclave only when device key is registered', () => {
    const enrolledDevice: DeviceView = {
      available: true,
      state: 'registered',
      fingerprint: 'fp-1234',
      owner_action: null,
      expires_at_ms: null,
    };
    const el = show(paired, ready, () => {}, enrolledDevice);
    const panel = el.querySelector('[data-pairing="paired"]')!;
    expect(panel.querySelector('[data-device-badge="registered"]')?.textContent).toBe(
      'Touch ID Enrolled · Secure Enclave',
    );
    expect(panel.textContent).toContain(
      'Loopback authenticated. Touch ID on this Mac can approve a contact or budget; it does not sign every payment.',
    );
    expect(panel.textContent).not.toContain('Touch ID approves every payment');
    expect(el.textContent).toContain('Touch ID on this Mac can approve a contact or budget.');
  });

  it('never infers Touch ID enrollment from pairing alone', () => {
    // Paired with no device prop / null device must not show the enclave badge.
    const el = show(paired, ready);
    const panel = el.querySelector('[data-pairing="paired"]')!;
    expect(panel.querySelector('[data-device-badge="registered"]')).toBeNull();
    expect(panel.textContent).toContain('App paired');
    expect(panel.textContent).not.toContain('Touch ID Enrolled');
    expect(panel.textContent).not.toContain('Secure Enclave');
  });

  it('pending pairing stays distinct from device registration', () => {
    const unenrolled = show(pending, booting, () => {}, null);
    const unenrolledPanel = unenrolled.querySelector('[data-pairing="pending"]')!;
    expect(unenrolledPanel.textContent).toContain(
      'Establishing an authenticated pairing between this app and your node.',
    );
    expect(unenrolledPanel.textContent).not.toContain('Secure Enclave');
    expect(unenrolledPanel.textContent).not.toContain('Registering');

    const enrolledDevice: DeviceView = {
      available: true,
      state: 'registered',
      fingerprint: 'fp-1234',
      owner_action: null,
      expires_at_ms: null,
    };
    const enrolled = show(pending, booting, () => {}, enrolledDevice);
    const enrolledPanel = enrolled.querySelector('[data-pairing="pending"]')!;
    expect(enrolledPanel.textContent).toContain(
      'Establishing an authenticated pairing between this app and your node.',
    );
    expect(enrolledPanel.textContent).toContain(
      'Touch ID approvals are already set up on this Mac; pairing does not create that key.',
    );
    expect(enrolledPanel.textContent).not.toContain('Registering Secure Enclave');
  });
});
