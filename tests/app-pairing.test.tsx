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
  bootstrap: null,
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
