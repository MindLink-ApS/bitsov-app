import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';
import { MONEY_NOT_READY } from '../src/control/readiness';
import type { PaymentReceipt } from '../src/control/types';

let dispose: (() => void) | undefined;
let mount: HTMLElement;
afterEach(() => { dispose?.(); mount?.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const input = (selector: string, value: string) => {
  const field = mount.querySelector<HTMLInputElement>(selector)!;
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
};

it.each([false, true])('clears successfully paid unchanged inputs, intervening offline=%s', async (outage) => {
  vi.useFakeTimers();
  const source = sampleSource({ firstLiveMs: 1e9 });
  const base = await source.nodeOverview();
  let ready = true;
  source.nodeOverview = async () => ({ ...base, money_ready: ready, read_at: Date.now() });
  source.spendStatus = async () => ({ state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 600_000, pending: null, window_ms: 600_000 });
  let complete!: (receipt: PaymentReceipt) => void;
  source.keysend = vi.fn(() => new Promise<PaymentReceipt>((resolve) => { complete = resolve; }));
  mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <ControlCenter source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
  await vi.waitFor(() => expect(mount.querySelector('[data-send]')).not.toBeNull());
  mount.querySelector<HTMLButtonElement>('[data-composer-mode="pay"]')!.click();
  [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Direct')!.click();
  input('[data-pay-pubkey]', '02' + '11'.repeat(32));
  input('[data-pay-amount]', '10');
  expect(mount.querySelector<HTMLButtonElement>('[data-send]')!.disabled).toBe(false);
  mount.querySelector<HTMLButtonElement>('[data-send]')!.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(source.keysend).not.toHaveBeenCalled();
  mount.querySelector<HTMLButtonElement>('[data-pay-confirm]')!.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(source.keysend).toHaveBeenCalledTimes(1);
  if (outage) {
    ready = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mount.querySelector('[data-money-notice]')).not.toBeNull();
  }
  complete({ method: 'keysend', amount_msat: 10_000, max_routing_fee_msat: 5_000, status: 'settled', paid_at_ms: Date.now() });
  await vi.advanceTimersByTimeAsync(0);
  expect(mount.querySelector('[data-artifact="payment"]')).not.toBeNull();
  ready = true;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(mount.querySelector('[data-money-notice]')).toBeNull();
  const amount = mount.querySelector<HTMLInputElement>('[data-pay-amount]')!;
  expect(amount.value, 'a successful payment should clear unchanged submitted inputs').toBe('');
  expect(mount.querySelector<HTMLButtonElement>('[data-send]')!.disabled).toBe(true);
});

it.each([false, true])('funding-address refusal joins the shared readiness notice, last status ready=%s', async (lastReady) => {
  vi.useFakeTimers();
  let ready = lastReady;
  let addressReady = false;
  let addressCalls = 0;
  let stateCalls = 0;
  const own = '1'.repeat(64);
  const replies: Record<string, () => unknown> = {
    node_status: () => ({ ready: true, node_id: own, error: null }),
    pairing_status: () => ({ state: 'paired', scopes: ['read', 'receive'], short_code: null, code_from_node: true, reason: null, bootstrap: null }),
    node_overview: () => ({ money_ready: ready, node_id: own, status: 'ok', version: 'api v2', connected_peers: 0, e2ee_sessions: 0, pending_deliveries: 0, lightning_available: lastReady, block_height: null, uptime_secs: 1, lightning_backend: 'ldk', chain_backend: 'esplora', read_at: Date.now() }),
    peers_list: () => [], rooms_list: () => [],
    payments_overview: () => ({ balance_msat: 0, lightning_outbound_msat: 0, channels: [] }),
    fund_state: () => { stateCalls++; return ({ current_step: 'connecting', tier: 'light', funding_address: null, funding_amount_sats_required: null, funding_amount_sats_received: 0, funding_evidence: null, funded: false }); },
    spend_status: () => ({ state: 'locked', basis: null, open_until_ms: null, pending: null, window_ms: 600_000 }),
    'plugin:event|listen': () => 1,
    'plugin:event|unlisten': () => null,
  };
  vi.stubGlobal('__TAURI_INTERNALS__', {
    transformCallback: () => 1,
    invoke: (cmd: string) => {
      if (cmd === 'funding_address') {
        addressCalls++;
        if (addressReady) return Promise.resolve({ address: 'bcrt1qrecoveredaddress' });
        ready = false;
        return Promise.reject(MONEY_NOT_READY);
      }
      const reply = replies[cmd];
      return reply ? Promise.resolve(reply()) : Promise.reject(new Error(`unexpected ${cmd}`));
    },
  });
  vi.stubGlobal('__TAURI_EVENT_PLUGIN_INTERNALS__', { unregisterListener: () => {} });
  mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <App />, mount);
  await vi.waitFor(() => expect([...mount.querySelectorAll('button')].some((b) => b.textContent?.includes('I understand'))).toBe(true));
  [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
  await vi.waitFor(() => expect(mount.querySelector('[data-tab="wallet"]')).not.toBeNull());
  mount.querySelector<HTMLButtonElement>('[data-tab="wallet"]')!.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(mount.textContent).toContain('Deposit to your node');
  expect(mount.querySelectorAll('[data-money-notice]'), 'funding refusal must mark money unavailable immediately').toHaveLength(1);
  expect(mount.querySelector('[data-deposit-error]'), 'readiness must not appear as a second deposit failure').toBeNull();
  if (lastReady) expect(addressCalls).toBeGreaterThan(0);
  else expect(addressCalls).toBe(0);
  const blockedAddressCalls = addressCalls;
  const previousStateCalls = stateCalls;
  await vi.advanceTimersByTimeAsync(6000);
  expect(stateCalls).toBeGreaterThan(previousStateCalls);
  expect(addressCalls).toBe(blockedAddressCalls);
  ready = true; addressReady = true;
  await vi.advanceTimersByTimeAsync(10000);
  expect(mount.querySelector('[data-money-notice]')).toBeNull();
  expect(mount.querySelector('code.address')?.textContent).toBe('bcrt1qrecoveredaddress');
  expect(addressCalls).toBeGreaterThan(blockedAddressCalls);
  const recoveredAddressCalls = addressCalls;
  await vi.advanceTimersByTimeAsync(6000);
  expect(addressCalls).toBe(recoveredAddressCalls);
});

it.each(['message', 'pay', 'request', 'file'] as const)('cleans up successful %s across offline recovery but preserves edited inputs', async (mode) => {
  for (const edited of [false, true]) {
    vi.useFakeTimers();
    const source = sampleSource({ firstLiveMs: 1e9 });
    const base = await source.nodeOverview();
    let ready = true;
    source.nodeOverview = async () => ({ ...base, money_ready: ready, read_at: Date.now() });
    source.spendStatus = async () => ({ state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 600_000, pending: null, window_ms: 600_000 });
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    source.send = vi.fn(async (recipient, is_room) => {
      await pending;
      return { message_id: 'sent', recipient, is_room, delivered: true, amount_msat: 2000, sent_at_ms: Date.now() };
    });
    source.pay = vi.fn(async (): Promise<PaymentReceipt> => {
      await pending;
      return { method: 'invoice', status: 'settled', amount_msat: 10000, paid_at_ms: Date.now() };
    });
    source.invoiceAmount = async (bolt11) => ({ amount_msat: 10000, network: 'testnet', payee: `02${'ab'.repeat(32)}`, expires_at_ms: Date.now() + 3600000, bolt11: bolt11.trim().toLowerCase(), payment_hash: '00'.repeat(32), description: null });
    source.invoiceCreate = vi.fn(async (amount_msat, note) => {
      await pending;
      return { bolt11: 'lntb100n1result', amount_msat, note, expires_at_ms: Date.now() + 3600000 };
    });
    source.fileSend = vi.fn(async (recipient, filename) => {
      await pending;
      return { message_id: 'file', recipient, filename, size_bytes: 3, delivered: true, amount_msat: 3000, sent_at_ms: Date.now() };
    });
    const call = { message: source.send, pay: source.pay, request: source.invoiceCreate, file: source.fileSend }[mode];
    mount = document.createElement('div'); document.body.appendChild(mount);
    dispose = render(() => <ControlCenter source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
    await vi.waitFor(() => expect(mount.querySelector('[data-send]')).not.toBeNull());
    mount.querySelector<HTMLButtonElement>(`[data-composer-mode="${mode}"]`)!.click();
    const selector = { message: '[data-composer] textarea', pay: '[data-pay-invoice]', request: '[data-request-amount]', file: '[data-file-input]' }[mode];
    const fill = (replacement: boolean) => {
      if (mode === 'file') {
        const field = mount.querySelector<HTMLInputElement>(selector)!;
        Object.defineProperty(field, 'files', { configurable: true, value: [new File(['abc'], replacement ? 'new.txt' : 'sent.txt')] });
        field.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        input(selector, mode === 'request' ? (replacement ? '20' : '10') : replacement ? 'new draft' : 'submitted draft');
      }
    };
    fill(false);
    await vi.waitFor(() => expect(mount.querySelector<HTMLButtonElement>('[data-send]')!.disabled).toBe(false));
    mount.querySelector<HTMLButtonElement>('[data-send]')!.click();
    if (mode === 'pay') {
      await vi.waitFor(() => expect(mount.querySelector('[data-pay-confirm]')).not.toBeNull());
      expect(call).not.toHaveBeenCalled();
      mount.querySelector<HTMLButtonElement>('[data-pay-confirm]')!.click();
    }
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    ready = false;
    await vi.advanceTimersByTimeAsync(10000);
    expect(mount.querySelector('[data-money-notice]')).not.toBeNull();
    if (edited) fill(true);
    // Exercise a completion arriving after recovery, in addition to the
    // keysend case whose successful completion arrives while still offline.
    ready = true;
    await vi.advanceTimersByTimeAsync(10000);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    if (mode !== 'file') {
      expect(mount.querySelector<HTMLInputElement>(selector)!.value).toBe(edited ? (mode === 'request' ? '20' : 'new draft') : '');
    }
    expect(mount.querySelector<HTMLButtonElement>('[data-send]')!.disabled).toBe(!edited);
    expect(call).toHaveBeenCalledTimes(1);
    dispose(); dispose = undefined; mount.remove();
    vi.useRealTimers();
  }
});
