import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';

// UI-E2E finding: on a node whose wallet backend has no deposit address (only
// embedded LDK has one), the deposit panel said "Waiting for the node to produce
// a deposit address…" forever. It must say what the node answered instead.

const OWN = '1'.repeat(64);
const REASON = 'Funding address not available — this endpoint requires an embedded LDK backend.';

function stubHost(address?: string, money?: { ready: boolean; starts: number }) {
  const replies: Record<string, () => unknown> = {
    node_status: () => ({ ready: true, node_id: OWN, error: null }),
    pairing_status: () => ({
      state: 'paired', scopes: ['read', 'receive'], short_code: 'ABCD-EFGH',
      code_from_node: true, reason: null, remote: false, bootstrap: null,
    }),
    node_overview: () => ({
      money_ready: money?.ready,
      node_id: OWN, status: 'ok', version: 'api v2', connected_peers: 0, e2ee_sessions: 0,
      pending_deliveries: 0, lightning_available: true, block_height: 1, uptime_secs: 1,
      lightning_backend: 'mock', chain_backend: 'mock', read_at: Date.now(),
    }),
    peers_list: () => [],
    rooms_list: () => [],
    payments_overview: () => ({ balance_msat: 0, lightning_outbound_msat: 0, channels: [] }),
    fund_start: () => { if (money) money.starts++; return null; },
    fund_state: () => money ? null : ({
      current_step: 'awaiting_funding', tier: 'full', funding_address: null,
      funding_amount_sats_required: 0, funding_amount_sats_received: 0, funding_evidence: null, funded: false,
    }),
    spend_status: () => ({ state: 'locked', basis: null, open_until_ms: null, pending: null, window_ms: 600_000 }),
    'plugin:event|listen': () => 1,
    'plugin:event|unlisten': () => null,
  };
  vi.stubGlobal('__TAURI_INTERNALS__', {
    transformCallback: () => 1,
    invoke: (cmd: string) => {
      if (cmd === 'funding_address' && address) return Promise.resolve({ address });
      if (cmd === 'funding_address') return Promise.reject(`/payments/funding-address: HTTP 400: ${REASON}`);
      const reply = replies[cmd];
      return reply ? Promise.resolve(reply()) : Promise.reject(new Error(`unexpected ${cmd}`));
    },
  });
  vi.stubGlobal('__TAURI_EVENT_PLUGIN_INTERNALS__', { unregisterListener: () => {} });
}

describe('deposit panel without a deposit address', () => {
  let dispose: (() => void) | undefined;
  let mount: HTMLElement;

  afterEach(() => {
    dispose?.();
    mount?.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('blocks funding while money is unavailable and restores it on the status poll', async () => {
    vi.useFakeTimers();
    const money = { ready: false, starts: 0 };
    stubHost(undefined, money);
    mount = document.createElement('div'); document.body.appendChild(mount);
    dispose = render(() => <App />, mount);
    await vi.waitFor(() => expect([...mount.querySelectorAll('button')].some((b) => b.textContent?.includes('I understand'))).toBe(true));
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
    await vi.waitFor(() => expect(mount.querySelector('[data-tab="wallet"]')).not.toBeNull());
    (mount.querySelector('[data-tab="wallet"]') as HTMLButtonElement).click();
    const button = () => [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Get a deposit address');
    await vi.waitFor(() => expect(button()).toBeDefined());
    expect(button()!.disabled).toBe(true);
    button()!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(money.starts).toBe(0);
    money.ready = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(button()!.disabled).toBe(false);
    expect(money.starts).toBe(0);
  });

  it("shows the node's reason instead of waiting forever", async () => {
    stubHost();
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => <App />, mount);
    await vi.waitFor(() =>
      expect([...mount.querySelectorAll('button')].some((b) => b.textContent?.includes('I understand'))).toBe(true),
    );
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
    const walletTab = () => [...mount.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === 'Wallet');
    await vi.waitFor(() => expect(walletTab()).toBeDefined());
    walletTab()!.click();
    await vi.waitFor(() => expect(mount.querySelector('[data-deposit-error]')?.textContent).toContain('embedded LDK'));
    expect(mount.textContent).not.toContain('Waiting for the node to produce a deposit address');
  });

  it('renders the address and a QR when the funding fixture supplies one', async () => {
    const address = 'bcrt1qfixture000000000000000000000000000000000';
    stubHost(address);
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => <App />, mount);
    await vi.waitFor(() =>
      expect([...mount.querySelectorAll('button')].some((b) => b.textContent?.includes('I understand'))).toBe(true),
    );
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
    const walletTab = () => [...mount.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === 'Wallet');
    await vi.waitFor(() => expect(walletTab()).toBeDefined());
    walletTab()!.click();
    await vi.waitFor(() => expect(mount.querySelector('code.address')?.textContent).toBe(address));
    expect(mount.querySelector('svg.qr[aria-label="Deposit address as a QR code"]')).not.toBeNull();
    expect(mount.querySelector('[data-deposit-error]')).toBeNull();
  });

});
