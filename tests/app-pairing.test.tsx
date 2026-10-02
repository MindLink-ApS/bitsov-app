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
      expect(mount.textContent).not.toContain('The app connects to your sovereign node on this Mac.');
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
