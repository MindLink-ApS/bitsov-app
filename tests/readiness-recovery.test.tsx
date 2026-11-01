import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import { setLanguagePref } from '../src/i18n';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';
import { MONEY_NOT_READY } from '../src/control/readiness';
import type { PaymentReceipt } from '../src/control/types';

let dispose: (() => void) | undefined;
let mount: HTMLElement;
afterEach(() => { dispose?.(); mount?.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); setLanguagePref('system'); });
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
    trust_acknowledge: () => true,
    pairing_status: () => ({ state: 'paired', scopes: ['read', 'receive'], short_code: null, code_from_node: true, reason: null, remote: false, bootstrap: null }),
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
  await vi.waitFor(() => expect(mount.querySelector('[data-first-run]')).toBeNull());
  await vi.waitFor(() => expect(mount.querySelector('[data-tab="wallet"]')).not.toBeNull());
  mount.querySelector<HTMLButtonElement>('[data-tab="wallet"]')!.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(mount.textContent).toContain('Deposit to your box');
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
    if (mode !== 'message') mount.querySelector<HTMLButtonElement>(`[data-composer-mode="${mode}"]`)!.click();
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

async function openReceive(fundHandlers: Record<string, () => Promise<unknown>>) {
  vi.useFakeTimers();
  const own = '1'.repeat(64);
  const replies: Record<string, () => unknown> = {
    node_status: () => ({ ready: true, node_id: own, error: null }),
    trust_acknowledge: () => true,
    pairing_status: () => ({ state: 'paired', scopes: ['read', 'receive'], short_code: null, code_from_node: true, reason: null, remote: false, bootstrap: null }),
    node_overview: () => ({ money_ready: true, node_id: own, status: 'ok', version: 'api v2', connected_peers: 0, e2ee_sessions: 0, pending_deliveries: 0, lightning_available: true, block_height: null, uptime_secs: 1, lightning_backend: 'ldk', chain_backend: 'esplora', read_at: Date.now() }),
    peers_list: () => [], rooms_list: () => [],
    payments_overview: () => ({ balance_msat: 0, lightning_outbound_msat: 0, channels: [] }),
    spend_status: () => ({ state: 'locked', basis: null, open_until_ms: null, pending: null, window_ms: 600_000 }),
    'plugin:event|listen': () => 1,
    'plugin:event|unlisten': () => null,
  };
  vi.stubGlobal('__TAURI_INTERNALS__', {
    transformCallback: () => 1,
    invoke: (cmd: string) => {
      if (fundHandlers[cmd]) return fundHandlers[cmd]();
      const reply = replies[cmd];
      return reply ? Promise.resolve(reply()) : Promise.reject(new Error(`unexpected ${cmd}`));
    },
  });
  vi.stubGlobal('__TAURI_EVENT_PLUGIN_INTERNALS__', { unregisterListener: () => {} });
  mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <App />, mount);
  const continueButton = () => mount.querySelector<HTMLButtonElement>('[data-trust-continue]');
  await vi.waitFor(() => expect(continueButton()).not.toBeNull());
  continueButton()!.click();
  await vi.waitFor(() => expect(mount.querySelector('[data-first-run]')).toBeNull());
  await vi.waitFor(() => expect(mount.querySelector('[data-tab="wallet"]')).not.toBeNull());
  mount.querySelector<HTMLButtonElement>('[data-tab="wallet"]')!.click();
  await vi.advanceTimersByTimeAsync(0);
  return () => mount.querySelector('[data-panel="receive"]');
}

it.each([
  ['en', 'Could not read the deposit status from your node. BitSov tries again by itself every few seconds.'],
  ['da', 'Kunne ikke hente status for indbetalingen fra din node. BitSov prøver igen af sig selv med få sekunders mellemrum.'],
] as const)('a deposit-status read failure shows a plain message, with the raw error only behind Details (%s)', async (lang, expected) => {
  setLanguagePref(lang);
  const raw = 'Error: GET /onboarding/state returned 500: {"error":"internal"}';
  const receive = await openReceive({ fund_state: () => Promise.reject(raw) });
  await vi.waitFor(() => expect(receive()?.querySelector('[data-soft-summary]')).toBeTruthy());
  const summary = receive()!.querySelector('[data-soft-summary]')!.textContent!;
  expect(summary).toBe(expected);
  expect(summary).not.toContain('500');
  expect(receive()!.querySelector('[data-soft-detail]')?.textContent).toContain(raw);
  expect(receive()!.querySelector<HTMLDetailsElement>('[data-soft-detail]')!.open).toBe(false);
});

it.each([
  ['en', 'Could not read the deposit status from your node. BitSov will not check again by itself. Check that your node is running, then close and reopen BitSov.'],
  ['da', 'Kunne ikke hente status for indbetalingen fra din node. BitSov tjekker ikke igen af sig selv. Tjek at din node kører, og luk og åbn så BitSov igen.'],
] as const)('once the deposit is funded the poll stops, so a status-read failure gives a manual step, not a retry promise (%s)', async (lang, expected) => {
  setLanguagePref(lang);
  const raw = 'Error: GET /onboarding/state returned 500: {"error":"internal"}';
  const funded = { current_step: 'funded', tier: 'full', funding_address: 'bcrt1qfunded', funding_amount_sats_required: 50_000, funding_amount_sats_received: 50_000, funding_evidence: null, funded: true };
  // Only the first read after funding fails; that read belongs to this panel's own
  // start(). Later reads return funded, so any other mounted deposit panel settles
  // after one tick and stops reading, and a read by this panel would clear the error.
  let started = false;
  let failed = false;
  const fundState = vi.fn(() => {
    if (!started) return Promise.resolve(null);
    if (!failed) { failed = true; return Promise.reject(raw); }
    return Promise.resolve(funded);
  });
  const fundStart = vi.fn(() => { started = true; return Promise.resolve(funded); });
  const receive = await openReceive({ fund_state: fundState, fund_start: fundStart });
  await vi.waitFor(() => expect(receive()?.querySelector('[data-fund-start]')).toBeTruthy());
  receive()!.querySelector<HTMLButtonElement>('[data-fund-start]')!.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(fundStart).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(receive()?.querySelector('[data-soft-summary]')?.textContent).toBe(expected));
  expect(receive()!.querySelector('.funded')).not.toBeNull();
  // One tick lets any other mounted panel take its funded read and stop; this
  // panel adds no read of its own.
  const beforeTick = fundState.mock.calls.length;
  await vi.advanceTimersByTimeAsync(3_000);
  expect(fundState.mock.calls.length - beforeTick).toBeLessThanOrEqual(1);
  // From here no panel reads the deposit status again: five more ticks, no new read.
  const reads = fundState.mock.calls.length;
  await vi.advanceTimersByTimeAsync(15_000);
  expect(fundState).toHaveBeenCalledTimes(reads);
  const summary = receive()!.querySelector('[data-soft-summary]')!.textContent!;
  expect(summary).toBe(expected);
  expect(summary).not.toMatch(/every few seconds|få sekunders mellemrum/);
  expect(receive()!.querySelector('[data-soft-detail]')?.textContent).toContain(raw);
});

it.each([
  ['en', 'Could not get a deposit address. Check that your node is running, then try again.'],
  ['da', 'Kunne ikke hente en indbetalingsadresse. Tjek at din node kører, og prøv så igen.'],
] as const)('a failed deposit start shows a plain message, never a deposit address (%s)', async (lang, expected) => {
  setLanguagePref(lang);
  const raw = 'Error: POST /onboarding/start returned 502: {"error":"wallet"}';
  const fundStart = vi.fn(() => Promise.reject(raw));
  const receive = await openReceive({ fund_state: () => Promise.resolve(null), fund_start: fundStart });
  await vi.waitFor(() => expect(receive()?.querySelector('[data-fund-start]')).toBeTruthy());
  receive()!.querySelector<HTMLButtonElement>('[data-fund-start]')!.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(fundStart).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(receive()?.querySelector('[data-soft-summary]')?.textContent).toBe(expected));
  expect(receive()!.querySelector('[data-soft-summary]')!.textContent).not.toContain('502');
  expect(receive()!.querySelector('[data-soft-detail]')?.textContent).toContain(raw);
  expect(receive()!.querySelector<HTMLDetailsElement>('[data-soft-detail]')!.open).toBe(false);
  expect(receive()!.querySelector('code.address')).toBeNull();
  expect(receive()!.querySelector('[data-fund-start]')).not.toBeNull();
});
