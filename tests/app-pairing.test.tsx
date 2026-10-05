import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import type { PairingView } from '../src/onboarding/pairing';

// The shell against a stubbed host: mock command replies only, no node, no network.

const failed: PairingView = {
  state: 'failed',
  scopes: [],
  short_code: null,
  code_from_node: false,
  reason: 'the node refused /pair/confirm (401): pairing proof did not verify',
  remote: false, bootstrap: null,
};
const paired: PairingView = {
  ...failed,
  state: 'paired',
  scopes: ['read', 'receive'],
  short_code: 'ABCD-EFGH',
  code_from_node: true,
  reason: null,
};

describe('app shell pairing wiring', () => {
  let dispose: (() => void) | undefined;
  let mount: HTMLElement | undefined;

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    mount?.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('Reconnect recovers an already-paired remote connection instead of polling only', async () => {
    let recovered = false;
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: (cmd: string) => {
      if (cmd === 'node_status') return Promise.resolve({ ready: recovered, node_id: 'ef'.repeat(32), error: recovered ? null : 'remote handshake limit or endpoint unavailable' });
      if (cmd === 'pairing_status') return Promise.resolve({ ...paired, remote: true });
      if (cmd === 'pairing_retry') { recovered = true; return Promise.resolve({ ...paired, remote: true }); }
      return Promise.reject(new Error('not available'));
    } });
    mount = document.createElement('div'); document.body.appendChild(mount);
    dispose = render(() => <App />, mount);
    await vi.waitFor(() => expect(mount!.textContent).toContain('Reconnect'));
    Array.from(mount.querySelectorAll('button')).find(b => b.textContent === 'Reconnect')!.click();
    await vi.waitFor(() => expect(mount!.querySelector('[data-gate="g6-remote-trust"]')).not.toBeNull());
  });

  it('keeps a warm remote composer mounted throughout retry hints and recovery', async () => {
    vi.useFakeTimers();
    const nodeId = 'ef'.repeat(32);
    const peer = 'ab'.repeat(32);
    let status = { ready: true, node_id: nodeId, error: null as string | null, retry_after_secs: null as number | null };
    localStorage.setItem(`bitsov.trust.v1.remote.${nodeId}`, 'accepted');
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: (cmd: string) => {
      if (cmd === 'node_status') return Promise.resolve(status);
      if (cmd === 'pairing_status') return Promise.resolve({ ...paired, remote: true });
      if (cmd === 'peers_list') return Promise.resolve([{ node_id: peer, addr: null, label: 'Peer', connected: true, fingerprint: peer }]);
      if (cmd === 'messages_list') return Promise.resolve([]);
      return Promise.reject(new Error('not available'));
    } });
    mount = document.createElement('div'); document.body.appendChild(mount);
    dispose = render(() => <App />, mount);
    await vi.advanceTimersByTimeAsync(500);
    const composer = mount.querySelector('[data-composer-bar]');
    expect(composer).not.toBeNull();
    let onboardingMounted = false;
    const observer = new MutationObserver(() => { onboardingMounted ||= !!mount!.querySelector('[data-ob-head]'); });
    observer.observe(mount, { childList: true, subtree: true });
    try {
      for (const remaining of [42, 40, null]) {
        status = { ...status, ready: remaining === null, retry_after_secs: remaining, error: remaining ? 'remote handshake limit or endpoint unavailable' : null };
        await vi.advanceTimersByTimeAsync(1500);
        expect(mount.querySelector('[data-composer-bar]')).toBe(composer);
        expect(mount.querySelector('[data-ob-head]')).toBeNull();
        expect(mount.textContent).not.toContain('Node stopped');
        if (remaining) expect(mount.textContent).toContain(`waiting ${remaining} s`);
      }
      expect(onboardingMounted).toBe(false);
    } finally { observer.disconnect(); }
  });

  it.each(['revoked', 'identity changed', 'setup reset', 'trust reset'] as const)('returns a warm shell to onboarding when %s', async (change) => {
    vi.useFakeTimers();
    let nodeId = 'ef'.repeat(32);
    let view = { ...paired, remote: true };
    localStorage.setItem(`bitsov.trust.v1.remote.${nodeId}`, 'accepted');
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: (cmd: string) => {
      if (cmd === 'node_status') return Promise.resolve({ ready: true, node_id: nodeId, error: null });
      if (cmd === 'pairing_status') return Promise.resolve(view);
      return Promise.reject(new Error('not available'));
    } });
    mount = document.createElement('div'); document.body.appendChild(mount);
    dispose = render(() => <App />, mount);
    await vi.advanceTimersByTimeAsync(500);
    expect(mount.querySelector('[data-first-run]')).toBeNull();
    if (change === 'revoked') view = { ...view, state: 'failed', reason: 'pairing revoked' };
    if (change === 'identity changed') {
      nodeId = 'cd'.repeat(32);
      localStorage.setItem(`bitsov.trust.v1.remote.${nodeId}`, 'accepted');
    }
    if (change === 'setup reset') view = { ...view, bootstrap: 'identity-free' };
    if (change === 'trust reset') localStorage.clear();
    await vi.advanceTimersByTimeAsync(1500);
    expect(mount.querySelector('[data-ob-head]')).not.toBeNull();
    if (change === 'revoked') expect(mount.querySelector('[data-pairing="failed"]')).not.toBeNull();
  });

  it.each([
    ['different node', 'cd'.repeat(32), false],
    ['different connection mode', 'ab'.repeat(32), true],
  ] as const)('requires a fresh trust disclosure for a %s', async (_case, nodeId, remote) => {
    localStorage.setItem(`bitsov.trust.v1.local.${'ab'.repeat(32)}`, 'accepted');
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: (cmd: string) => {
      if (cmd === 'node_status') return Promise.resolve({ ready: true, node_id: nodeId, error: null });
      if (cmd === 'pairing_status') return Promise.resolve({ ...paired, remote });
      return Promise.reject(new Error('not available'));
    } });
    mount = document.createElement('div'); document.body.appendChild(mount);
    dispose = render(() => <App />, mount);
    await vi.waitFor(() => expect(mount!.querySelector(`[data-gate="g6-${remote ? 'remote' : 'local'}-trust"]`)).not.toBeNull());
  });

  it.each([
    ['identity-free', true],
    ['with an identity', false],
] as const)('the first-run surface offers restore only when it can happen (%s)', async (_, bootstrap) => {
    vi.stubGlobal('__TAURI_INTERNALS__', {
      invoke: (cmd: string) => {
        if (cmd === 'node_status') return Promise.resolve({ ready: true, node_id: 'ab'.repeat(33), error: null });
        if (cmd === 'pairing_status') return Promise.resolve({ ...paired, bootstrap: bootstrap ? 'identity-free' : null });
        return Promise.reject(new Error(`unexpected ${cmd}`));
      },
    });
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => <App />, mount);
    // The whole first-run surface: stage header, pairing panel and the G6 IdentityGate.
    await vi.waitFor(() => expect(mount!.querySelector('[data-gate="g6-local-trust"]')).not.toBeNull());
    expect(mount.querySelector('[data-ob-head="trust"]')).not.toBeNull();
    const text = mount.textContent ?? '';
    if (bootstrap) {
      expect(mount.querySelector('[data-restore-open]')).toBeNull();
      expect(text).not.toContain('Restore an existing identity');
      expect(text).not.toContain('restore it now');
      expect(text).toContain('not available on this node yet');
      // The blocked stage says so in words, not only as a pip.
      expect(mount.querySelector('[data-step="identity"] .step-status:not(.sr-only)')?.textContent).toBe('waiting on a genome release');
    } else {
      expect(mount.querySelector('[data-restore-open]')?.textContent).toContain('Restore an existing identity');
      expect(text).toContain('restore it now');
    }
  });

  it.each([false, true])('renders the actual connection and trust boundary (remote=%s)', async (remote) => {
    const calls: string[] = [];
    vi.stubGlobal('__TAURI_INTERNALS__', {
      invoke: (cmd: string) => {
        calls.push(cmd);
        if (cmd === 'node_status') return Promise.resolve({ ready: true, node_id: 'ab'.repeat(33), error: null });
        if (cmd === 'pairing_status') return Promise.resolve({ ...paired, remote });
        return Promise.reject(new Error(`unexpected ${cmd}`));
      },
    });
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => <App />, mount);
    await vi.waitFor(() => expect(mount!.querySelector('[data-pairing="paired"]')).not.toBeNull());

    const selected = mount.querySelector('[role="radio"][aria-checked="true"]');
    expect(selected?.getAttribute('data-target')).toBe(remote ? 'cloud' : 'local');
    const panel = mount.querySelector('[data-pairing="paired"]')!;
    const gate = mount.querySelector(`[data-gate="g6-${remote ? 'remote' : 'local'}-trust"]`)!;
    expect(gate).not.toBeNull();
    if (remote) {
      expect(panel.textContent).toContain('paired with a remote node over a pinned encrypted connection');
      expect(panel.textContent).toContain("local proxy only accepts this app’s credential");
      expect(panel.textContent).not.toContain('Loopback authenticated');
      expect(panel.textContent).not.toContain('file-backed on this Mac');
      expect(gate.textContent).toContain('keys live on the remote machine');
      expect(gate.textContent).toContain('VM host');
      expect(gate.textContent).toContain('can spend what you deposit');
      expect(gate.textContent).toContain('Only fund a node whose host you trust');
      expect(mount.querySelector('[data-gate="g6-local-trust"]')).toBeNull();
      expect(mount.querySelector('[data-step="identity"]')?.getAttribute('data-status')).toBe('done');
      expect(mount.querySelector('[data-step="fund"]')?.getAttribute('data-status')).toBe('active');
      expect(mount.textContent).not.toContain('This app connects to the node on this Mac.');
    } else {
      expect(panel.textContent).toContain('Loopback authenticated. Ordinary pairing is file-backed on this Mac.');
      expect(gate.textContent).toContain('This node trusts every program on this computer.');
      expect(gate.textContent).toContain('127.0.0.1');
      expect(mount.querySelector('[data-step="identity"]')?.getAttribute('data-status')).toBe('active');
    }
    // Knowing the identity must not bypass the funding disclosure.
    expect(calls).not.toContain('fund_state');
    // Location choices remain interactive after the host selects the running mode.
    mount.querySelector<HTMLButtonElement>('[data-target="network"]')!.click();
    expect(mount.querySelector('[data-target="network"]')?.getAttribute('aria-checked')).toBe('true');
  });

  it.each(['delayed', 'failed'] as const)('withholds trust acceptance while the first pairing reply is %s', async (reply) => {
    let resolvePairing!: (value: PairingView) => void;
    const response = new Promise<PairingView>((resolve) => { resolvePairing = resolve; });
    let requestedPairing = false;
    const calls: string[] = [];
    vi.stubGlobal('__TAURI_INTERNALS__', {
      invoke: (cmd: string) => {
        calls.push(cmd);
        if (cmd === 'node_status') return Promise.resolve({ ready: true, node_id: 'ab'.repeat(33), error: null });
        if (cmd === 'pairing_status') {
          requestedPairing = true;
          return reply === 'delayed' ? response : Promise.reject(new Error('host unavailable'));
        }
        return Promise.reject(new Error(`unexpected ${cmd}`));
      },
    });
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => <App />, mount);
    await vi.waitFor(() => expect(requestedPairing).toBe(true));
    expect(mount.querySelector('[data-gate]')).toBeNull();
    expect(mount.textContent).not.toContain('I understand — continue to funding');
    expect(calls).not.toContain('fund_state');

    if (reply === 'delayed') {
      resolvePairing({ ...paired, remote: true });
      await vi.waitFor(() => expect(mount!.querySelector('[data-gate="g6-remote-trust"]')).not.toBeNull());
      expect(mount.querySelector('[data-gate="g6-local-trust"]')).toBeNull();
      expect(calls).not.toContain('fund_state');
    }
  });

  it('does not treat an early local startup snapshot as the final connection mode', async () => {
    let statusReads = 0;
    let pairingReads = 0;
    let resolvePairing!: (value: PairingView) => void;
    const response = new Promise<PairingView>((resolve) => { resolvePairing = resolve; });
    vi.stubGlobal('__TAURI_INTERNALS__', {
      invoke: (cmd: string) => {
        if (cmd === 'node_status') {
          const ready = ++statusReads > 1;
          return Promise.resolve({ ready, node_id: ready ? 'ab'.repeat(33) : null, error: null });
        }
        if (cmd === 'pairing_status') {
          return ++pairingReads === 1 ? Promise.resolve({ ...paired, state: 'starting', remote: false }) : response;
        }
        return Promise.reject(new Error(`unexpected ${cmd}`));
      },
    });
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => <App />, mount);
    await vi.waitFor(() => expect(pairingReads).toBe(2), { timeout: 2500 });
    expect(mount.querySelector('[data-gate]')).toBeNull();
    expect(mount.textContent).not.toContain('I understand — continue to funding');
    resolvePairing({ ...paired, remote: true });
    await vi.waitFor(() => expect(mount!.querySelector('[data-gate="g6-remote-trust"]')).not.toBeNull());
  });

  it('shows a pairing failure instead of the start spinner, and retries through the host', async () => {
    let pairing = failed;
    const calls: string[] = [];
    vi.stubGlobal('__TAURI_INTERNALS__', {
      invoke: (cmd: string) => {
        calls.push(cmd);
        if (cmd === 'node_status') return Promise.resolve({ ready: false, node_id: null, error: null });
        if (cmd === 'pairing_status') return Promise.resolve(pairing);
        if (cmd === 'pairing_retry') {
          pairing = paired;
          return Promise.resolve(paired);
        }
        return Promise.reject(new Error(`unexpected ${cmd}`));
      },
    });

    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => <App />, mount);

    await vi.waitFor(() => {
      expect(mount!.querySelector('[data-pairing="failed"]')).not.toBeNull();
    });
    expect(mount.textContent).toContain('pairing proof did not verify');
    expect(mount.textContent).not.toContain('Starting your node');

    mount.querySelector<HTMLButtonElement>('[data-pairing="failed"] button')!.click();
    await vi.waitFor(() => {
      expect(mount!.querySelector('[data-pairing="paired"]')).not.toBeNull();
    });
    expect(calls).toContain('pairing_retry');
    expect(calls).not.toContain('fund_state');
  });
});
