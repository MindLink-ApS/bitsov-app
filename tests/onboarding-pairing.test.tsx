import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { Onboarding, onboardingStage } from '../src/onboarding/Onboarding';
import { onboardingSteps, type NodeStatus, type PairingView } from '../src/onboarding/pairing';
import type { DeviceView } from '../src/control/types';

const starting: PairingView = {
  state: 'starting',
  scopes: [],
  short_code: null,
  code_from_node: false,
  reason: null,
  remote: false, bootstrap: null,
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

  it('only completes remote identity when the host has confirmed it', () => {
    const remote = { ...paired, remote: true };
    expect(onboardingSteps(ready, remote, false).map((s) => s.status)).toEqual(['done', 'done', 'done', 'active']);
    expect(onboardingSteps({ ...ready, node_id: null }, remote, false)[2].status).toBe('active');
    expect(onboardingSteps(booting, remote, false)[2].status).toBe('todo');
    expect(onboardingSteps(ready, { ...remote, bootstrap: 'bootstrap' }, false)[2].status).toBe('active');
    expect(onboardingSteps(ready, { ...remote, state: 'failed' }, false)[2].status).toBe('todo');
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

  it('a local bootstrap node opens the identity step for restore', () => {
    const steps = onboardingSteps(booting, { ...paired, bootstrap: 'bootstrap' }, false);
    expect(steps[2].status).toBe('active');
  });

  it('a node start error fails the first step', () => {
    const steps = onboardingSteps({ ...booting, error: 'node did not become healthy' }, starting, false);
    expect(steps[0].status).toBe('failed');
  });
});

describe('phone onboarding has no local-node step', () => {
  let dispose: (() => void) | undefined;
  let mount: HTMLElement | undefined;
  afterEach(() => { dispose?.(); dispose = undefined; mount?.remove(); mount = undefined; });
  const nodeDown: NodeStatus = { ready: false, node_id: null, error: 'sidecar not available' };

  it('a phone has no "Start din boks" step, so a local-node error never reads as a failed stage', () => {
    const steps = onboardingSteps(nodeDown, starting, false, true);
    expect(steps.map(s => s.id)).toEqual(['pair', 'identity', 'fund']);
    expect(steps.some(s => s.status === 'failed')).toBe(false);
    expect(steps[0].status).toBe('active');
    expect(onboardingStage(steps)).toBe('node');
  });

  it('once paired to a remote node the phone moves past the node stage', () => {
    const steps = onboardingSteps(ready, { ...paired, remote: true }, false, true);
    expect(steps.find(s => s.id === 'pair')!.status).toBe('done');
    expect(onboardingStage(steps)).not.toBe('node');
  });

  it('a computer keeps its "Start din boks" step and its failure', () => {
    const steps = onboardingSteps(nodeDown, starting, false);
    expect(steps[0]).toMatchObject({ id: 'node', status: 'failed' });
  });

  it('the phone stepper renders no failed stage while the local node is down', () => {
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => (
      <Onboarding status={() => nodeDown} pairing={() => starting} trustAck={() => false} onRetry={() => {}} phone />
    ), mount);
    expect(mount.querySelector('.stepper [data-step="node"]')).toBeNull();
    expect(mount.querySelector('.stepper [data-status="failed"]')).toBeNull();
    expect(mount.querySelector('.stepper')!.textContent).not.toContain('failed');
    expect(mount.querySelector('.stepper [data-step="pair"]')!.classList.contains('joined')).toBe(false);
  });

  it('every <details> in phone and computer onboarding has an explicit summary', () => {
    for (const phone of [true, false]) {
      mount = document.createElement('div');
      document.body.appendChild(mount);
      dispose = render(() => (
        <Onboarding status={() => booting} pairing={() => starting} trustAck={() => false} onRetry={() => {}} phone={phone} />
      ), mount);
      const details = [...mount.querySelectorAll('details')];
      // Neither device may hide the home-node choice behind a disclosure.
      expect(mount.querySelector('[data-target="network"]')!.closest('details')).toBeNull();
      for (const d of details) {
        const summary = d.querySelector(':scope > summary');
        expect(summary, d.outerHTML.slice(0, 80)).not.toBeNull();
        expect(summary!.textContent!.trim().length + (summary!.getAttribute('aria-label')?.length ?? 0)).toBeGreaterThan(0);
      }
      dispose(); dispose = undefined; mount.remove();
    }
  });
});

describe('onboarding stages (3 focused steps)', () => {
  it('maps the four host steps onto node, identity and fund', () => {
    expect(onboardingStage(onboardingSteps(booting, starting, false))).toBe('node');
    expect(onboardingStage(onboardingSteps(booting, pending, false))).toBe('node');
    expect(onboardingStage(onboardingSteps(ready, failed, false))).toBe('node');
    expect(onboardingStage(onboardingSteps(ready, paired, false))).toBe('identity');
    expect(onboardingStage(onboardingSteps(ready, fallback, false))).toBe('identity');
    expect(onboardingStage(onboardingSteps(ready, { ...paired, bootstrap: 'identity-free' }, false))).toBe('identity');
    expect(onboardingStage(onboardingSteps(ready, paired, true))).toBe('fund');
  });
});

describe('pairing panel', () => {
  let dispose: (() => void) | undefined;
  let mount: HTMLElement | undefined;

  it.each([true, false])('first-run box preview on phone=%s gates import', async phone => {
    const save = vi.fn();
    mount = document.createElement('div'); document.body.appendChild(mount);
    dispose = render(() => <Onboarding status={() => booting} pairing={() => starting}
      trustAck={() => false} onRetry={() => {}} selectedTarget="network" phone={phone}
      onPreviewRemote={async () => ({ endpoint: 'box:9737', node_id_fingerprint: '22…22', first_run: true })}
      onImportRemote={save} initialPairingLink="bitsov://pair/test" />, mount);
    const form = mount.querySelector<HTMLFormElement>('form')!;
    form.requestSubmit();
    await vi.waitFor(() => expect(mount!.querySelector('[data-pairing-preview]')).not.toBeNull());
    const message = "This box isn't set up yet. Finish setup on a Mac, then add this phone.";
    if (phone) {
      expect(mount.textContent).toContain(message);
      expect(Array.from(form.querySelectorAll('button')).some(b => b.textContent === 'Use this box')).toBe(false);
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
      expect(save).not.toHaveBeenCalled();
    } else {
      expect(mount.textContent).not.toContain(message);
      expect(form.querySelector('button[type="submit"]')?.textContent).toBe('Use this box');
    }
  });

  it('shows connecting without restart instructions after a mobile import', async () => {
    mount = document.createElement('div'); document.body.appendChild(mount);
    dispose = render(() => <Onboarding status={() => booting} pairing={() => starting}
      trustAck={() => false} onRetry={() => {}} phone
      onPreviewRemote={async () => ({ endpoint: 'home:9737', node_id_fingerprint: 'ab…cd', first_run: false })}
      onImportRemote={async () => ({ endpoint: 'home:9737', node_id_fingerprint: 'ab…cd', restart_required: false })}
      initialPairingLink="bitsov://pair/test" />, mount);
    const form = mount.querySelector<HTMLFormElement>('form')!;
    form.requestSubmit();
    await vi.waitFor(() => expect(mount!.querySelector('[data-pairing-preview]')).not.toBeNull());
    form.requestSubmit();
    await vi.waitFor(() => expect(mount!.querySelector('[data-import-result]')).not.toBeNull());
    expect(mount.textContent).toContain('Connecting to your box…');
    expect(mount.textContent).not.toMatch(/Restart BitSov|next app start/);
  });

  it('previews the exact ticket before confirmation and invalidates the preview after editing', async () => {
    const preview = vi.fn().mockResolvedValue({ endpoint: 'review.example:4242', node_id_fingerprint: '12345678…abcdef12' });
    const save = vi.fn().mockResolvedValue({ endpoint: 'review.example:4242', node_id_fingerprint: '12345678…abcdef12', restart_required: true });
    mount = document.createElement('div'); document.body.appendChild(mount);
    dispose = render(() => <Onboarding status={() => booting} pairing={() => starting}
      trustAck={() => false} onRetry={() => {}} selectedTarget="network"
      onPreviewRemote={preview} onImportRemote={save} />, mount);
    const input = mount.querySelector<HTMLInputElement>('input')!;
    const form = mount.querySelector<HTMLFormElement>('form')!;
    const type = (link: string) => { input.value = link; input.dispatchEvent(new InputEvent('input', { bubbles: true })); };
    type('bitsov://pair/reviewed');
    form.requestSubmit();
    await vi.waitFor(() => expect(mount!.querySelector('[data-pairing-preview]')?.textContent).toContain('review.example:4242'));
    expect(mount.textContent).toContain('12345678…abcdef12');
    expect(save).not.toHaveBeenCalled();
    type('bitsov://pair/edited');
    expect(mount.querySelector('[data-pairing-preview]')).toBeNull();
    form.requestSubmit();
    await vi.waitFor(() => expect(preview).toHaveBeenLastCalledWith('bitsov://pair/edited'));
    expect(save).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(mount!.querySelector('[data-pairing-preview]')).not.toBeNull());
    form.requestSubmit();
    await vi.waitFor(() => expect(save).toHaveBeenCalledExactlyOnceWith('bitsov://pair/edited'));
  });

  it('fails closed on a refused preview without importing', async () => {
    const save = vi.fn();
    mount = document.createElement('div'); document.body.appendChild(mount);
    dispose = render(() => <Onboarding status={() => booting} pairing={() => starting}
      trustAck={() => false} onRetry={() => {}} selectedTarget="network"
      initialPairingLink="bitsov://pair/expired"
      onPreviewRemote={async () => { throw new Error('This pairing link expired.'); }} onImportRemote={save} />, mount);
    mount.querySelector<HTMLFormElement>('form')!.requestSubmit();
    await vi.waitFor(() => expect(mount!.textContent).toContain('This pairing link expired.'));
    expect(mount.querySelector('[data-pairing-preview]')).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  const submitReview = async (form: HTMLFormElement) => {
    form.requestSubmit();
    await vi.waitFor(() => expect(form.querySelector('[data-pairing-preview], [data-soft-summary]')).not.toBeNull());
    if (form.querySelector('[data-pairing-preview]')) form.requestSubmit();
  };

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
        <Onboarding onPreviewRemote={async () => ({ endpoint: 'home:4242', node_id_fingerprint: 'ab…cd' })}
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

  it('remote pending describes connecting instead of local file pairing', () => {
    const el = show({ ...pending, remote: true });
    expect(el.textContent).toContain('Connecting to your box…');
    expect(el.textContent).not.toContain('challenge the node wrote there');
    expect(el.querySelector('[data-pairing="failed"]')).toBeNull();
  });

  it('pending shows progress and no code yet', () => {
    const el = show(pending);
    const panel = el.querySelector('[data-pairing="pending"]');
    expect(panel?.textContent).toContain('Pairing this app with your box');
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

  it.each(['none', 'registered'] as const)('uses remote pairing copy with device state %s', (state) => {
    const el = show({ ...paired, remote: true }, ready, () => {}, {
      available: true, state, fingerprint: state === 'registered' ? 'fp-1234' : null,
      owner_action: null, expires_at_ms: null,
    });
    const panel = el.querySelector('[data-pairing="paired"]')!;
    expect(panel.textContent).toContain('pinned encrypted connection');
    expect(panel.textContent).toContain("local proxy only accepts this app’s credential");
    expect(panel.textContent).not.toContain('Loopback authenticated');
    expect(panel.textContent).not.toContain('file-backed on this Mac');
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
    expect(panel.textContent).toContain('older node');
    expect(panel.textContent).not.toContain('bundled node');
    expect(panel.textContent).toContain('/auth/local');
    expect(panel.textContent).not.toContain('read + receive');
    expect(el.querySelector('[data-short-code]')).toBeNull();
  });

  it('identity-free node describes local restore', () => {
    const el = show({ ...paired, scopes: ['read', 'receive', 'identity'], bootstrap: 'bootstrap' });
    const panel = el.querySelector('[data-pairing="paired"]')!;
    expect(panel.textContent).toContain('read + receive + identity');
    expect(el.textContent).toContain('identity-free');
    expect(el.textContent).toContain('restore an existing identity');
  });

  it('a fresh computer shows "Joining from another device?" without opening Advanced; it opens the scan-or-paste form', () => {
    const el = show(starting, booting);
    const join = el.querySelector('[data-join-from-device]')!;
    expect(join.textContent).toBe('Joining from another device? Scan or paste its ticket');
    expect(el.querySelector('[data-remote-access]')).toBeNull();
    el.querySelector<HTMLButtonElement>('[data-join-open]')!.click();
    expect(el.querySelector('[data-remote-access]')).not.toBeNull();
    expect(el.querySelector('[data-target="network"]')!.getAttribute('aria-checked')).toBe('true');
  });

  it('a phone never shows the "Joining from another device?" link (its first run is the scan-or-paste path)', () => {
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => (
      <Onboarding onPreviewRemote={async () => ({ endpoint: 'home:4242', node_id_fingerprint: 'ab…cd' })}
        status={() => booting} pairing={() => starting} trustAck={() => false} onRetry={() => {}} mobile />
    ), mount);
    expect(mount.querySelector('[data-join-from-device]')).toBeNull();
  });

  it('on a phone (the app\'s mobile signal) there is no This Mac: connect to your node, scan or paste, no "Use this Mac instead"', () => {
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => (
      <Onboarding onPreviewRemote={async () => ({ endpoint: 'home:4242', node_id_fingerprint: 'ab…cd' })}
        status={() => booting} pairing={() => starting} trustAck={() => false} onRetry={() => {}}
        selectedTarget="network" onForgetRemote={async () => {}} onScanRemote={async () => 'bitsov://pair/x'} mobile />
    ), mount);
    expect(mount.querySelector('[data-target="local"]')).toBeNull();
    expect(mount.querySelector('h1')!.textContent).toBe('Connect this phone to your box');
    const node = mount.querySelector<HTMLButtonElement>('[data-target="network"]')!;
    expect(node.textContent).toContain('Your box');
    expect(node.textContent).toContain('connect this phone');
    // No <details> on a phone: WebKit would add its own OS-language summary ("Flere oplysninger").
    expect(mount.querySelector('details.node-target-advanced')).toBeNull();
    expect(mount.querySelector('.node-target-advanced summary')).toBeNull();
    expect(mount.querySelector('[data-target="network"]')).not.toBeNull();
    expect(mount.querySelector('[data-remote-access]')).not.toBeNull();
    expect(mount.textContent).not.toMatch(/Use this Mac instead|separate wallet|Keys on this Mac|this Mac must stay awake/);
  });

  it('on an iPhone (phone set, no Android scanner) there is no This Mac either', () => {
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => (
      <Onboarding onPreviewRemote={async () => ({ endpoint: 'home:4242', node_id_fingerprint: 'ab…cd' })}
        status={() => booting} pairing={() => starting} trustAck={() => false} onRetry={() => {}}
        selectedTarget="network" onForgetRemote={async () => {}} phone />
    ), mount);
    expect(mount.querySelector('[data-target="local"]')).toBeNull();
    expect(mount.querySelector('h1')!.textContent).toBe('Connect this phone to your box');
    expect(mount.textContent).not.toMatch(/Use this Mac instead|Keys on this Mac/);
  });

  it('on an iPhone with no target given, the node card is selected and the scan-or-paste form is already open', () => {
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => (
      <Onboarding onPreviewRemote={async () => ({ endpoint: 'home:4242', node_id_fingerprint: 'ab…cd' })}
        status={() => booting} pairing={() => starting} trustAck={() => false} onRetry={() => {}} phone />
    ), mount);
    expect(mount.querySelector('[data-target="local"]')).toBeNull();
    expect(mount.querySelector('[data-target="network"]')!.getAttribute('aria-checked')).toBe('true');
    expect(mount.querySelector('[data-remote-access]')).not.toBeNull();
  });

  it('a computer offers both node locations without an Advanced disclosure', () => {
    const el = show(starting, booting);
    expect(el.querySelector('[data-target="local"]')).not.toBeNull();
    expect(el.querySelector('h1')!.textContent).toBe('Where should your box run?');
    expect(el.querySelector('[data-target="network"] strong')!.textContent).toBe('A box at home (Pi/Umbrel)');
    expect(el.querySelector('[data-target="network"]')!.closest('details')).toBeNull();
  });

  it('an iPhone (phone set, no Android mobile flag) never shows the "Joining from another device?" link', () => {
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => (
      <Onboarding onPreviewRemote={async () => ({ endpoint: 'home:4242', node_id_fingerprint: 'ab…cd' })}
        status={() => booting} pairing={() => starting} trustAck={() => false} onRetry={() => {}} selectedTarget="local" phone />
    ), mount);
    // Even with a local target forced, the phone gate (not the Android-only mobile flag) hides the link.
    expect(mount.querySelector('[data-join-from-device]')).toBeNull();
  });

  it('explains local-only use and lets an owner choose an existing home node directly', () => {
    const el = show(starting, booting);
    const local = el.querySelector<HTMLButtonElement>('[data-target="local"]')!;
    expect(local.getAttribute('aria-checked')).toBe('true');
    expect(local.textContent).toContain('awake and BitSov must stay open');
    // Said at the fork: a node on this Mac is for this Mac only (no box or sticker assumed).
    expect(local.querySelector('[data-local-only]')!.textContent).toBe('Only this Mac can use this box. A phone can join a box at home or a separately configured Mac that stays on.');
    const home = el.querySelector<HTMLButtonElement>('[data-target="network"]')!;
    expect(home.parentElement).toBe(local.parentElement);
    expect(home.closest('details')).toBeNull();
    expect(el.querySelector('[data-target="cloud"]')).toBeNull();
    expect(el.querySelector('[data-remote-access]')).toBeNull();
    home.click();
    expect(home.getAttribute('aria-checked')).toBe('true');
    expect(local.getAttribute('aria-checked')).toBe('false');
    expect(el.querySelector('[data-remote-access]')).not.toBeNull();
  });

  it('once the node is up, both locations are one row of pills and the pairing actions sit side by side', () => {
    const el = show(paired, ready);
    const section = el.querySelector('.node-target-section')!;
    expect(section.classList.contains('compact')).toBe(true);
    // Compact: no fold to open, both choices are real radios in the same row.
    expect(section.querySelector('[data-target="network"]')!.closest('details')).toBeNull();
    expect([...section.querySelectorAll('[role="radio"]')].map((r) => r.getAttribute('data-target'))).toEqual(['local', 'network']);
    el.querySelector<HTMLButtonElement>('[data-target="network"]')!.click();
    const form = el.querySelector('[data-remote-access]')!;
    expect(form.querySelector('.form-actions > button[type="submit"]')).not.toBeNull();
    const input = form.querySelector<HTMLInputElement>('input')!;
    input.value = 'bitsov://pair/abc';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    expect(form.querySelector('.form-actions > [data-cancel-pairing-review]')).not.toBeNull();
  });

  it('enables the internal test node only with the explicit runtime flag', () => {
    localStorage.setItem('bitsov.test-nodes', '1');
    try {
      const el = show(starting, booting);
      const cloud = el.querySelector<HTMLButtonElement>('[data-target="cloud"]')!;
      expect(cloud.textContent).toContain('Test node someone else runs (internal)');
      expect(cloud.textContent).toContain('Not your keys');
      cloud.click();
      expect(el.querySelector('[data-remote-access]')).not.toBeNull();
    } finally { localStorage.removeItem('bitsov.test-nodes'); }
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
    expect(el.textContent).toContain('This app connects to the box on this Mac.');
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
      'Establishing an authenticated pairing between this app and your box.',
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
      'Establishing an authenticated pairing between this app and your box.',
    );
    expect(enrolledPanel.textContent).toContain(
      'Touch ID approvals are already set up on this Mac; pairing does not create that key.',
    );
    expect(enrolledPanel.textContent).not.toContain('Registering Secure Enclave');
  });

  it('keeps restart guidance current across save, forget, and save again', async () => {
    let finishForget!: () => void;
    mount = document.createElement('div'); document.body.appendChild(mount);
    dispose = render(() => <Onboarding onPreviewRemote={async () => ({ endpoint: 'home:4242', node_id_fingerprint: 'ab…cd' })} status={() => booting} pairing={() => starting}
      trustAck={() => false} onRetry={() => {}} selectedTarget="network"
      onForgetRemote={() => new Promise<void>(resolve => { finishForget = resolve; })}
      onImportRemote={async () => ({ endpoint: 'home:4242', node_id_fingerprint: 'ab…cd', restart_required: true })} />, mount);
    const save = async () => {
      const input = mount!.querySelector<HTMLInputElement>('input')!;
      input.value = 'bitsov://pair/example';
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await submitReview(mount!.querySelector<HTMLFormElement>('form')!);
    };
    await save();
    await vi.waitFor(() => expect(mount!.textContent).toContain('Restart BitSov to connect'));
    mount.querySelector<HTMLButtonElement>('[data-use-local]')!.click();
    expect(mount.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    finishForget();
    await vi.waitFor(() => expect(mount!.textContent).toContain('Restart BitSov to use this Mac'));
    expect(mount.textContent).not.toContain('Restart BitSov to connect');
    await save();
    await vi.waitFor(() => expect(mount!.textContent).toContain('Restart BitSov to connect'));
    expect(mount.textContent).not.toContain('Restart BitSov to use this Mac');
    expect(mount.querySelector<HTMLButtonElement>('[data-use-local]')!.disabled).toBe(false);
  });

  it('shows the remote Node ID short fingerprint without echoing the pairing link', async () => {
    const link = 'bitsov://pair/secret-pairing-material';
    const onImportRemote = vi.fn().mockResolvedValue({
      endpoint: 'node.example:4242',
      node_id_fingerprint: '01234567…89abcdef',
      restart_required: true,
    });
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(
      () => (
        <Onboarding onPreviewRemote={async () => ({ endpoint: 'home:4242', node_id_fingerprint: 'ab…cd' })}
          status={() => booting}
          pairing={() => starting}
          trustAck={() => false}
          onRetry={() => {}}
          selectedTarget="network"
          onImportRemote={onImportRemote}
        />
      ),
      mount,
    );

    const input = mount.querySelector<HTMLInputElement>('#remote-pairing-link')!;
    input.value = link;
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await submitReview(mount.querySelector<HTMLFormElement>('[data-remote-access]')!);

    await vi.waitFor(() => {
      expect(mount!.textContent).toContain('Node ID fingerprint: 01234567…89abcdef');
    });
    expect(onImportRemote).toHaveBeenCalledWith(link);
    expect(input.value).toBe('');
    expect(mount.textContent).not.toContain(link);
  });

  it('prefills a scanned QR link and waits for confirmation before importing', async () => {
    const link = 'bitsov://pair/scanned-secret-material';
    const onImportRemote = vi.fn().mockResolvedValue({
      endpoint: 'home.example:4242',
      node_id_fingerprint: 'fedcba98…76543210',
      restart_required: true,
    });
    const onScanRemote = vi.fn().mockResolvedValue(link);
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(
      () => (
        <Onboarding onPreviewRemote={async () => ({ endpoint: 'home:4242', node_id_fingerprint: 'ab…cd' })}
          status={() => booting}
          pairing={() => starting}
          trustAck={() => false}
          onRetry={() => {}}
          selectedTarget="network"
          onImportRemote={onImportRemote}
          onScanRemote={onScanRemote}
        />
      ),
      mount,
    );

    mount.querySelector<HTMLButtonElement>('[data-scan-pairing-qr]')!.click();

    const input = mount.querySelector<HTMLInputElement>('#remote-pairing-link')!;
    await vi.waitFor(() => expect(input.value).toBe(link));
    expect(onImportRemote).not.toHaveBeenCalled();
    expect(mount.textContent).toContain('camera');
    await submitReview(mount.querySelector<HTMLFormElement>('[data-remote-access]')!);
    await vi.waitFor(() => expect(mount!.textContent).toContain('Your box home.example:4242 saved.'));
    expect(onScanRemote).toHaveBeenCalledTimes(1);
    expect(onImportRemote).toHaveBeenCalledWith(link);
    expect(mount.textContent).not.toContain(link);
  });

  it.each(['paste', 'scan', 'deep link'])('rejects unrelated input from %s without importing or displaying it', async (path) => {
    const link = 'https://unrelated.example/private-ticket';
    const onImportRemote = vi.fn();
    mount = document.createElement('div'); document.body.appendChild(mount);
    dispose = render(() => <Onboarding onPreviewRemote={async () => ({ endpoint: 'home:4242', node_id_fingerprint: 'ab…cd' })} status={() => booting} pairing={() => starting}
      trustAck={() => false} onRetry={() => {}} selectedTarget="network"
      initialPairingLink={path === 'deep link' ? link : undefined}
      onScanRemote={async () => link} onImportRemote={onImportRemote} />, mount);
    if (path === 'paste') {
      const input = mount.querySelector<HTMLInputElement>('#remote-pairing-link')!;
      input.value = link;
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await submitReview(mount.querySelector<HTMLFormElement>('[data-remote-access]')!);
    } else if (path === 'scan') {
      mount.querySelector<HTMLButtonElement>('[data-scan-pairing-qr]')!.click();
    }
    await vi.waitFor(() => expect(mount!.textContent).toContain('Use a bitsov://pair/ pairing ticket from your node.'));
    expect(onImportRemote).not.toHaveBeenCalled();
    expect(mount.textContent).not.toContain(link);
    expect(mount.querySelector<HTMLInputElement>('#remote-pairing-link')!.value).toBe('');
  });

  it.each(['paste', 'scan', 'deep link'])('surfaces the authoritative host ticket refusal after confirming %s', async (path) => {
    const link = 'bitsov://pair/eyJ2IjoxfQ';
    const onImportRemote = vi.fn().mockRejectedValue(new Error('This pairing link expired. Request a new ticket from your node.'));
    mount = document.createElement('div'); document.body.appendChild(mount);
    dispose = render(() => <Onboarding onPreviewRemote={async () => ({ endpoint: 'home:4242', node_id_fingerprint: 'ab…cd' })} status={() => booting} pairing={() => starting}
      trustAck={() => false} onRetry={() => {}} selectedTarget="network"
      initialPairingLink={path === 'deep link' ? link : undefined}
      onScanRemote={async () => link} onImportRemote={onImportRemote} />, mount);
    const input = mount.querySelector<HTMLInputElement>('#remote-pairing-link')!;
    if (path === 'paste') {
      input.value = link;
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    } else if (path === 'scan') {
      mount.querySelector<HTMLButtonElement>('[data-scan-pairing-qr]')!.click();
    }
    await vi.waitFor(() => expect(input.value).toBe(link));
    expect(onImportRemote).not.toHaveBeenCalled();
    await submitReview(mount.querySelector<HTMLFormElement>('[data-remote-access]')!);
    await vi.waitFor(() => expect(mount!.textContent).toContain('This pairing link expired.'));
    expect(onImportRemote).toHaveBeenCalledExactlyOnceWith(link);
    expect(mount.querySelector('[data-import-result]')).toBeNull();
    expect(input.value).toBe(link);
    expect(mount.querySelector('[data-pairing-preview]')).not.toBeNull();
  });

  it('keeps paste usable after scan cancellation without exposing native errors', async () => {
    const onImportRemote = vi.fn().mockResolvedValue({ endpoint: 'home:4242', node_id_fingerprint: 'ab…cd', restart_required: true });
    mount = document.createElement('div'); document.body.appendChild(mount);
    dispose = render(() => <Onboarding onPreviewRemote={async () => ({ endpoint: 'home:4242', node_id_fingerprint: 'ab…cd' })} status={() => booting} pairing={() => starting}
      trustAck={() => false} onRetry={() => {}} selectedTarget="network"
      onScanRemote={async () => { throw new Error('cancelled: bitsov://pair/private-ticket'); }}
      onImportRemote={onImportRemote} />, mount);
    mount.querySelector<HTMLButtonElement>('[data-scan-pairing-qr]')!.click();
    await vi.waitFor(() => expect(mount!.textContent).toContain('paste the link instead'));
    expect(mount.textContent).not.toContain('private-ticket');
    const input = mount.querySelector<HTMLInputElement>('#remote-pairing-link')!;
    expect(input.disabled).toBe(false);
    input.value = 'bitsov://pair/pasted-ticket';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await submitReview(mount.querySelector<HTMLFormElement>('[data-remote-access]')!);
    await vi.waitFor(() => expect(mount!.textContent).toContain('Your box home:4242 saved.'));
  });

  const importWith = async (result: () => Promise<unknown>, pairing: PairingView = starting) => {
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => <Onboarding onPreviewRemote={async () => ({ endpoint: 'home:4242', node_id_fingerprint: 'ab…cd' })} status={() => booting} pairing={() => pairing}
      trustAck={() => false} onRetry={() => {}} selectedTarget="network"
      onForgetRemote={async () => {}} onImportRemote={result as never} />, mount);
    const input = mount.querySelector<HTMLInputElement>('#remote-pairing-link')!;
    input.value = 'bitsov://pair/ticket';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await submitReview(mount.querySelector<HTMLFormElement>('[data-remote-access]')!);
    return mount;
  };
  const badge = () => mount!.querySelector('.node-target-card[data-target="network"] .target-badge')!;

  it('old link without a label: confirmation and home-node badge stay as before', async () => {
    const el = await importWith(async () => ({ endpoint: 'home:4242', node_id_fingerprint: 'ab…cd', restart_required: true }));
    await vi.waitFor(() => expect(el.querySelector('[data-import-result]')).not.toBeNull());
    expect(el.querySelector('[data-import-result]')!.textContent).toBe(
      'Your box home:4242 saved. Node ID fingerprint: ab…cd. Restart BitSov to connect.',
    );
    expect(el.querySelector('[data-hosted-by]')).toBeNull();
    expect(badge().textContent).toBe('Pairing link');
  });

  it('new ticket: shows "hosted by" in the confirmation and the home-node badge, then forget clears it', async () => {
    const el = await importWith(async () => ({ endpoint: 'home:4242', node_id_fingerprint: 'ab…cd', hosted_by: "Home Pi", restart_required: true }));
    await vi.waitFor(() => expect(el.querySelector('[data-import-result]')).not.toBeNull());
    expect(el.querySelector('[data-import-result]')!.textContent).toBe(
      "Your box home:4242 (hosted by Home Pi) saved. Node ID fingerprint: ab…cd. Restart BitSov to connect.",
    );
    expect(badge().textContent).toBe("Hosted by Home Pi");
    expect(badge().getAttribute('title')).toBe("Hosted by Home Pi");
    el.querySelector<HTMLButtonElement>('[data-use-local]')!.click();
    await vi.waitFor(() => expect(badge().textContent).toBe('Pairing link'));
  });

  it('shows the running remote node label on the home-node badge', () => {
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => <Onboarding onPreviewRemote={async () => ({ endpoint: 'home:4242', node_id_fingerprint: 'ab…cd' })} status={() => booting} pairing={() => ({ ...pending, remote: true, hosted_by: 'Basement box' })}
      trustAck={() => false} onRetry={() => {}} />, mount);
    expect(badge().textContent).toBe('Hosted by Basement box');
  });

  it('renders an odd, maximum-length label as escaped text inside a bidi isolate', async () => {
    const label = '<img src=x onerror="alert(1)">' + '𝔅'.repeat(33) + '…';
    const el = await importWith(async () => ({ endpoint: 'home:4242', node_id_fingerprint: 'ab…cd', hosted_by: label, restart_required: true }));
    await vi.waitFor(() => expect(el.querySelector('[data-import-result]')).not.toBeNull());
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('[data-import-result] bdi[data-hosted-by]')!.textContent).toBe(label);
    expect(badge().querySelector('bdi')!.textContent).toBe(label);
    expect(badge().classList.contains('hosted-by')).toBe(true);
  });

  it('asks for a fresh link without the expired-ticket command and saves nothing', async () => {
    const message = "This pairing link expired 2 h ago. Run konsensus pair-ticket on your node for a new one, and check that this Mac's clock is right.";
    const el = await importWith(() => Promise.reject(message));
    await vi.waitFor(() => expect(el.querySelector('[data-soft-summary]')?.textContent).toContain('new pairing link'));
    expect(el.textContent).not.toContain('konsensus ');
    expect(el.querySelector('[data-import-result]')).toBeNull();
    expect(badge().textContent).toBe('Pairing link');
  });
  it('shows one decision per stage and keeps every host step addressable', () => {
    const first = show(starting, booting);
    expect(first.querySelector('[data-ob-head="node"] h1')?.textContent).toBe('Where should your box run?');
    expect(first.querySelector('.node-target-section.compact')).toBeNull();
    expect([...first.querySelectorAll('[data-step]')].map((s) => s.getAttribute('data-step'))).toEqual(['node', 'pair', 'identity', 'fund']);
    // Three visible stage labels; pairing is announced but not a separate stage.
    const visible = [...first.querySelectorAll('.stepper .step-label:not(.sr-only)')].map((s) =>
      [...s.childNodes].filter((n) => !(n instanceof HTMLElement && n.classList.contains('sr-only'))).map((n) => n.textContent).join(''));
    expect(visible).toEqual(['Your box', 'Your identity', 'Add sats (optional)']);
    dispose?.();
    mount?.remove();

    const later = show(paired, ready);
    // The heading is named like its step.
    expect(later.querySelector('[data-ob-head="trust"] h1')?.textContent).toBe('Your identity');
    expect(later.querySelector('.node-target-section.compact')).not.toBeNull();
    // Still a real choice once compact.
    expect(later.querySelectorAll('[role="radio"]').length).toBe(2);
  });
  it('describes bootstrap restore and keeps the access scopes in view', () => {
    const el = show({ ...paired, bootstrap: 'identity-free' }, ready);
    const head = el.querySelector('[data-ob-head="trust"]')!;
    expect(head.textContent).not.toContain('restore it now');
    expect(head.textContent).toContain('Restore your existing identity on this Mac');
    const access = el.querySelector('[data-pairing="paired"] .pairing-access')!;
    expect(access.textContent).toContain('read + receive');
    expect(access.closest('details')).toBeNull();
    dispose?.();
    mount?.remove();

    const normal = show(paired, ready);
    expect(normal.querySelector('[data-ob-head="trust"]')!.textContent).toContain('restore it now');
  });
});
