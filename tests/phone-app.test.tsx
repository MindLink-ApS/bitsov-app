import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { INITIAL_PAIRING, type ConnectionError } from '../src/onboarding/pairing';
import { setLanguagePref } from '../src/i18n';

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); setLanguagePref('system'); });
const tick = async () => { for (let i = 0; i < 70; i++) await Promise.resolve(); };
const button = (text: string) => [...document.querySelectorAll('button')].find(b => b.textContent?.includes(text))!;
type PhoneState = { connected: boolean; approved: boolean; trusted: boolean; locked: boolean; inbox: string | null };
type Extra = Record<string, (args: any, state: PhoneState) => unknown>;
function mount(platform: string, existing = false, legacy = false, connection_error?: ConnectionError, opts: { link?: boolean; extra?: Extra } = {}) {
  vi.useFakeTimers();
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(platform);
  const state: PhoneState = { connected: existing, approved: false, trusted: false, locked: false, inbox: connection_error || opts.link === false ? null : 'bitsov://pair/synthetic' as string | null };
  const actions: unknown[] = [];
  const invoke = vi.fn(async (cmd: string, args?: any) => {
    if (opts.extra?.[cmd]) return opts.extra[cmd](args, state);
    if (cmd === 'node_status') return { phone_setup: !existing, locked: state.locked, ready: state.connected && !state.locked, node_id: state.connected ? 'ab'.repeat(32) : null, error: null, connection_error };
    if (cmd === 'open_app_settings' || cmd === 'open_tailscale') return;
    if (cmd === 'pairing_status') return { ...INITIAL_PAIRING, remote: state.connected, state: state.connected ? 'paired' : 'starting' };
    if (cmd === 'pairing_link_take') { const link = state.inbox; state.inbox = null; return link; }
    if (cmd === 'remote_access_preview') return { first_run: false, second_device: !legacy, endpoint: 'box:443', node_id_fingerprint: 'abcd' };
    if (cmd === 'remote_access_connect') { state.connected = true; return { restart_required: false }; }
    if (cmd === 'device_key_status') return { available: !legacy, delegation_supported: !legacy, second_device: !legacy, state: state.approved ? 'registered' : 'none' };
    if (cmd === 'join_device') {
      actions.push(args.input);
      if (state.approved) return { state: 'done', second_device: true };
      return args.input.action === 'status' ? { state: 'idle', second_device: true } : { state: 'waiting', second_device: true, words: ['one', 'two', 'three', 'four'], expires_at: Date.now()/1000 + 300 };
    }
    if (cmd === 'trust_acknowledge') { state.trusted = true; return true; }
    throw new Error('unavailable');
  });
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke, transformCallback: () => 1 });
  vi.stubGlobal('__TAURI_EVENT_PLUGIN_INTERNALS__', { unregisterListener: () => {} });
  dispose = render(() => <App />, document.body);
  return { state, actions, invoke };
}
describe.each(['iPhone', 'Android'])('%s first-run onboarding', platform => {
  it.each([
    ['local_network', 'Open Settings', 'open_app_settings'],
    ['tailscale', 'Open Tailscale', 'open_tailscale'],
  ] as const)('wires %s recovery to a fixed host command without destination input', async (kind, label, command) => {
    const { invoke } = mount(platform, false, false, { kind, detail: '' });
    await tick();
    button(label).click(); await tick();
    expect(invoke.mock.calls.filter(([cmd]) => cmd.startsWith('open_')).map(([cmd, args]) => [cmd, args])).toEqual([[command, {}]]);
  });
  it('consumes the cold link, joins code-free, then still requires trust', async () => {
    const { state, actions } = mount(platform);
    await tick(); await vi.advanceTimersByTimeAsync(1500); await tick();
    expect(document.querySelector('[data-phone-onboarding]')).not.toBeNull();
    expect(document.querySelector('[data-pairing-link-banner]')).toBeNull();
    expect(actions).toContainEqual({ action: 'start_second' });
    expect(document.querySelector('[data-gate]')).toBeNull();
    state.approved = true;
    await vi.advanceTimersByTimeAsync(1500); await tick();
    button('Open BitSov').click(); await tick();
    expect(document.querySelector('[data-gate="g6-remote-trust"]')).not.toBeNull();
    expect(state.trusted).toBe(false);
    expect(document.querySelector('[data-phone-trust]')).not.toBeNull();
    expect(document.querySelector<HTMLDetailsElement>('.phone-options')!.open).toBe(false);
    expect(document.querySelectorAll('button.primary')).toHaveLength(1);
    button('I understand').click(); await tick();
    expect(state.trusted).toBe(true);
  });
  it('holds a legacy cold link at comparison before connecting, then still requires trust', async () => {
    const { state, actions } = mount(platform, false, true);
    await tick(); await vi.advanceTimersByTimeAsync(1500); await tick();
    expect(document.querySelector('[data-phone-onboarding="fingerprint"]')).not.toBeNull();
    expect(state.connected).toBe(false);
    button('They match').click(); await tick();
    expect(state.connected).toBe(true);
    await vi.advanceTimersByTimeAsync(1500); await tick();
    expect(actions).toHaveLength(0);
    button('Open BitSov').click(); await tick();
    expect(document.querySelector('[data-phone-trust]')).not.toBeNull();
    expect(state.trusted).toBe(false);
  });
  it('keeps the words ceremony mounted while the box requires unlocking', async () => {
    const { state } = mount(platform); await tick(); await vi.advanceTimersByTimeAsync(1500); await tick();
    const ceremony = document.querySelector('[data-phone-onboarding="words"]')!;
    expect(ceremony).not.toBeNull();
    state.locked = true; await vi.advanceTimersByTimeAsync(1500); await tick();
    expect(ceremony.isConnected).toBe(true);
    expect(ceremony.closest('[hidden]')).not.toBeNull();
    expect(document.querySelector('[data-node-locked]')).not.toBeNull();
    state.locked = false; await vi.advanceTimersByTimeAsync(1500); await tick();
    expect(document.querySelector('[data-phone-onboarding="words"]')).toBe(ceremony);
    expect(ceremony.closest('[hidden]')).toBeNull();
  });
  it('keeps an already-paired phone on the explicit incoming-link review path', async () => {
    const { invoke } = mount(platform, true); await tick();
    expect(document.querySelector('[data-phone-onboarding]')).toBeNull();
    expect(document.querySelector('[data-pairing-link-banner]')).not.toBeNull();
    expect(invoke.mock.calls.some(([cmd]) => cmd === 'remote_access_connect')).toBe(false);
  });
});
it.each(['iPhone', 'Android'])('%s resumes a saved second-device enrollment without consuming a replacement link', async platform => {
  vi.useFakeTimers();
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(platform);
  let imports = 0;
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (cmd: string) => {
    if (cmd === 'node_status') return { phone_setup: true, ready: true, node_id: 'ab'.repeat(32), error: null };
    if (cmd === 'pairing_status') return { ...INITIAL_PAIRING, remote: true, state: 'paired' };
    if (cmd === 'device_key_status') return { available: true, delegation_supported: true, second_device: true, state: 'pending' };
    if (cmd === 'join_device') return { state: 'waiting', second_device: true, words: ['one', 'two', 'three', 'four'], expires_at: Date.now()/1000 + 300 };
    if (cmd === 'pairing_link_take') return 'bitsov://pair/replacement';
    if (cmd === 'remote_access_connect') imports++;
    throw new Error('unavailable');
  } });
  dispose = render(() => <App />, document.body); await tick();
  expect(document.querySelector('[data-phone-onboarding="words"]')).not.toBeNull();
  expect(imports).toBe(0);
  expect(document.querySelector('[data-pairing-link-banner]')).toBeNull();
});
it('waits for the saved-descriptor decision before consuming a cold link', async () => {
  vi.useFakeTimers();
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Android');
  let initialized = false, imports = 0;
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (cmd: string) => {
    if (cmd === 'node_status') return { phone_setup: initialized ? false : null, ready: false, node_id: null, error: null };
    if (cmd === 'pairing_status') return { ...INITIAL_PAIRING, remote: initialized };
    if (cmd === 'pairing_link_take') return 'bitsov://pair/replacement';
    if (cmd === 'remote_access_connect') imports++;
    throw new Error('unavailable');
  } });
  dispose = render(() => <App />, document.body); await tick();
  expect(document.querySelector('[data-phone-onboarding]')).toBeNull();
  expect(imports).toBe(0);
  initialized = true;
  await vi.advanceTimersByTimeAsync(1500); await tick();
  expect(document.querySelector('[data-phone-onboarding]')).toBeNull();
  expect(document.querySelector('[data-pairing-link-banner]')).not.toBeNull();
  expect(imports).toBe(0);
});

// Reviewed phone copy, bound to literals rather than to the production strings.
const COPY = {
  en: {
    start: 'Connect to your box', words: 'Are the same 4 words on your computer?', open: 'Open BitSov',
    trust: 'Do you trust the host of this box?', trustSaveFailed: 'Could not save. Try again.',
    stateFailed: 'Could not read the deposit status from your node. BitSov tries again by itself every few seconds.',
    stateStopped: 'Could not read the deposit status from your node. BitSov will not check again by itself. Check that your node is running, then close and reopen BitSov.',
  },
  da: {
    start: 'Forbind til din boks', words: 'Står de samme 4 ord på din computer?', open: 'Åbn BitSov',
    trust: 'Stoler du på boksens vært?', trustSaveFailed: 'Kunne ikke gemme. Prøv igen.',
    stateFailed: 'Kunne ikke hente status for indbetalingen fra din node. BitSov prøver igen af sig selv med få sekunders mellemrum.',
    stateStopped: 'Kunne ikke hente status for indbetalingen fra din node. BitSov tjekker ikke igen af sig selv. Tjek at din node kører, og luk og åbn så BitSov igen.',
  },
} as const;
// Full phone user agents, so the app also takes its phone layout (Android needs "Mobile").
const PHONES = [
  ['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'],
  ['Android', 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'],
] as const;
const FUND_IPC = ['fund_state', 'fund_start', 'funding_address'];
const FUNDED = { current_step: 'funded', tier: 'full', funding_address: 'bcrt1qsynthetictrap', funding_amount_sats_required: 50_000, funding_amount_sats_received: 50_000, funding_evidence: null, funded: true };
// Deposit replies that would show a funded node if anything asked for them.
const fundedTrap: Extra = {
  fund_state: () => FUNDED,
  fund_start: () => FUNDED,
  funding_address: () => ({ address: 'bcrt1qsynthetictrap' }),
};
const fundCalls = (invoke: ReturnType<typeof mount>['invoke']) => invoke.mock.calls.filter(([cmd]) => FUND_IPC.includes(cmd));
const expectNoDepositUi = () => {
  expect(document.querySelector('[data-panel="receive"], [data-fund-start], code.address, .fund, [data-tab="wallet"]')).toBeNull();
  expect(document.body.textContent).not.toContain('bcrt1qsynthetictrap');
  expect(document.body.textContent).not.toMatch(/Fund your node|Indsæt penge på din node/);
};
const heading = () => document.querySelector('h1')?.textContent;
/** Five deposit-poll intervals (3 s each), long enough for any receive panel to read twice. */
const fivePollTicks = async () => { for (let i = 0; i < 5; i++) { await vi.advanceTimersByTimeAsync(3_000); await tick(); } };

describe.each(PHONES)('%s cold-unpaired deposit trap', (_name, platform) => {
  it.each(['en', 'da'] as const)('a phone with no pairing reads no deposit state and shows no deposit UI (%s)', async lang => {
    setLanguagePref(lang);
    const { invoke } = mount(platform, false, false, undefined, { link: false, extra: fundedTrap });
    await tick();
    expect(heading()).toBe(COPY[lang].start);
    await fivePollTicks();
    expect(heading()).toBe(COPY[lang].start);
    expect(document.querySelector('[data-phone-onboarding]')).not.toBeNull();
    expect(fundCalls(invoke)).toEqual([]);
    expectNoDepositUi();
    // The status poll itself kept running throughout.
    expect(invoke.mock.calls.filter(([cmd]) => cmd === 'node_status').length).toBeGreaterThanOrEqual(10);
  });
  it.each(['en', 'da'] as const)('enrollment and the trust step read no deposit state before the host is trusted (%s)', async lang => {
    setLanguagePref(lang);
    const { state, invoke, actions } = mount(platform, false, false, undefined, { extra: fundedTrap });
    await tick(); await vi.advanceTimersByTimeAsync(1500); await tick();
    expect(heading()).toBe(COPY[lang].words);
    await fivePollTicks();
    expect(heading()).toBe(COPY[lang].words);
    // Enrollment's own calls are allowed and did happen.
    expect(actions).toContainEqual({ action: 'start_second' });
    expect(fundCalls(invoke)).toEqual([]);
    expectNoDepositUi();
    state.approved = true;
    await vi.advanceTimersByTimeAsync(1500); await tick();
    button(COPY[lang].open).click(); await tick();
    expect(heading()).toBe(COPY[lang].trust);
    await fivePollTicks();
    expect(heading()).toBe(COPY[lang].trust);
    expect(state.trusted).toBe(false);
    expect(fundCalls(invoke)).toEqual([]);
    expectNoDepositUi();
  });
});

/** Enroll a phone and stop at the trust step. */
async function enrollToTrust(platform: string, lang: 'en' | 'da', extra: Extra) {
  setLanguagePref(lang);
  const phone = mount(platform, false, false, undefined, { extra });
  await tick(); await vi.advanceTimersByTimeAsync(1500); await tick();
  phone.state.approved = true;
  await vi.advanceTimersByTimeAsync(1500); await tick();
  button(COPY[lang].open).click(); await tick();
  expect(heading()).toBe(COPY[lang].trust);
  return phone;
}
const trustAction = () => document.querySelector<HTMLButtonElement>('[data-phone-trust] button.primary')!;
const trustAcks = (invoke: ReturnType<typeof mount>['invoke']) => invoke.mock.calls.filter(([cmd]) => cmd === 'trust_acknowledge').map(([, args]) => args.node_id);

describe.each(PHONES)('%s trust save in the app', (_name, platform) => {
  it.each(['en', 'da'] as const)('a refused trust save keeps the phone untrusted until a retry succeeds (%s)', async lang => {
    let replies = 0;
    const { invoke } = await enrollToTrust(platform, lang, {
      ...fundedTrap,
      // The host first answers "not saved", then fails, then saves.
      trust_acknowledge: () => { replies++; if (replies === 1) return false; if (replies === 2) throw new Error('synthetic save failure'); return true; },
    });
    for (const attempt of [1, 2]) {
      trustAction().click(); await tick();
      expect(trustAcks(invoke)).toHaveLength(attempt);
      expect(document.querySelector('[data-phone-trust] [role="alert"]')?.textContent).toBe(COPY[lang].trustSaveFailed);
      await vi.advanceTimersByTimeAsync(3_000); await tick();
      expect(heading()).toBe(COPY[lang].trust);
      expect(fundCalls(invoke)).toEqual([]);
      expectNoDepositUi();
    }
    trustAction().click(); await tick();
    expect(trustAcks(invoke)).toEqual(['ab'.repeat(32), 'ab'.repeat(32), 'ab'.repeat(32)]);
    expect(document.querySelector('[data-phone-trust]')).toBeNull();
  });
  it.each(['en', 'da'] as const)('a late trust save for one node does not accept the node that replaced it (%s)', async lang => {
    const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
    let nodeId = A;
    let statusFails = false;
    const pending: ((accepted: boolean) => void)[] = [];
    const { invoke } = await enrollToTrust(platform, lang, {
      ...fundedTrap,
      node_status: (_args, state) => {
        if (statusFails) throw new Error('synthetic status failure');
        return { phone_setup: true, locked: false, ready: state.connected, node_id: state.connected ? nodeId : null, error: null };
      },
      trust_acknowledge: () => new Promise<boolean>(resolve => { pending.push(resolve); }),
    });
    trustAction().click(); await tick();
    expect(trustAcks(invoke)).toEqual([A]);
    // The connection now reports another node before the save for A answers.
    nodeId = B;
    await vi.advanceTimersByTimeAsync(1500); await tick();
    pending[0](true); await tick();
    expect(heading()).toBe(COPY[lang].trust);
    expect(document.querySelector('[data-phone-trust] [role="alert"]')).toBeNull();
    // A missing identity keeps a warm shell open, so a misfiled acceptance for A
    // would show here: the trust step must stay.
    statusFails = true;
    await vi.advanceTimersByTimeAsync(1500); await tick();
    expect(document.querySelector('[data-phone-trust]')).not.toBeNull();
    statusFails = false;
    await vi.advanceTimersByTimeAsync(1500); await tick();
    expect(heading()).toBe(COPY[lang].trust);
    await fivePollTicks();
    expect(document.querySelector('[data-phone-trust]')).not.toBeNull();
    expect(fundCalls(invoke)).toEqual([]);
    expectNoDepositUi();
    // B needs its own explicit acknowledgement.
    trustAction().click(); await tick();
    expect(trustAcks(invoke)).toEqual([A, B]);
    pending[1](true); await tick();
    expect(document.querySelector('[data-phone-trust]')).toBeNull();
  });
});

const shellReplies = (own: string): Extra => ({
  node_overview: () => ({ money_ready: true, node_id: own, status: 'ok', version: 'api v2', connected_peers: 0, e2ee_sessions: 0, pending_deliveries: 0, lightning_available: true, block_height: null, uptime_secs: 1, lightning_backend: 'ldk', chain_backend: 'esplora', read_at: Date.now() }),
  peers_list: () => [], rooms_list: () => [],
  payments_overview: () => ({ balance_msat: 0, lightning_outbound_msat: 0, channels: [] }),
  spend_status: () => ({ state: 'locked', basis: null, open_until_ms: null, pending: null, window_ms: 600_000 }),
  'plugin:event|listen': () => 1,
  'plugin:event|unlisten': () => null,
});
/** Enroll, acknowledge trust, and open the receive panel the way a phone owner does: You → settings → Wallet. */
async function openPhoneReceive(platform: string, lang: 'en' | 'da', fund: Extra) {
  const phone = await enrollToTrust(platform, lang, { ...shellReplies('ab'.repeat(32)), ...fund });
  trustAction().click(); await tick();
  expect(document.querySelector('[data-phone-trust]')).toBeNull();
  // Trust alone reads no deposit state.
  expect(fundCalls(phone.invoke)).toEqual([]);
  document.querySelector<HTMLButtonElement>('[data-phone-tab="you"]')!.click(); await tick();
  document.querySelector<HTMLButtonElement>('[data-phone-settings]')!.click(); await tick();
  document.querySelector<HTMLButtonElement>('[data-tab="wallet"]')!.click();
  await vi.advanceTimersByTimeAsync(0); await tick();
  expect(document.querySelectorAll('[data-panel="receive"]')).toHaveLength(1);
  return { ...phone, receive: () => document.querySelector('[data-panel="receive"]')! };
}
const RAW_STATE_ERROR = 'Error: GET /onboarding/state returned 500: {"error":"internal"}';

describe.each(PHONES)('%s trusted receive panel', (_name, platform) => {
  it.each(['en', 'da'] as const)('once the deposit is funded the poll stops, so a status-read failure gives a manual step (%s)', async lang => {
    // Only the first read after funding fails; that read belongs to this panel's own
    // start(). Later reads return funded, so any other mounted deposit panel settles
    // after one tick and stops reading, and a read by this panel would clear the error.
    let started = false;
    let failed = false;
    const fundState = vi.fn(() => {
      if (!started) return null;
      if (!failed) { failed = true; throw RAW_STATE_ERROR; }
      return FUNDED;
    });
    const fundStart = vi.fn(() => { started = true; return FUNDED; });
    const { receive } = await openPhoneReceive(platform, lang, { fund_state: fundState, fund_start: fundStart });
    expect(receive().querySelector('[data-fund-start]')).not.toBeNull();
    receive().querySelector<HTMLButtonElement>('[data-fund-start]')!.click();
    await vi.advanceTimersByTimeAsync(0); await tick();
    expect(fundStart).toHaveBeenCalledTimes(1);
    expect(receive().querySelector('[data-soft-summary]')?.textContent).toBe(COPY[lang].stateStopped);
    expect(receive().querySelector('.funded')).not.toBeNull();
    // One tick lets any other mounted deposit panel take its funded read and stop;
    // this panel adds no read of its own.
    const beforeTick = fundState.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3_000); await tick();
    expect(fundState.mock.calls.length - beforeTick).toBeLessThanOrEqual(1);
    // From here nothing reads the deposit status again: five more ticks, no new read.
    const reads = fundState.mock.calls.length;
    await fivePollTicks();
    expect(fundState).toHaveBeenCalledTimes(reads);
    expect(fundStart).toHaveBeenCalledTimes(1);
    const summary = receive().querySelector('[data-soft-summary]')!.textContent!;
    expect(summary).toBe(COPY[lang].stateStopped);
    expect(summary).not.toMatch(/every few seconds|få sekunders mellemrum/);
    expect(receive().querySelector('[data-soft-detail]')?.textContent).toContain(RAW_STATE_ERROR);
    expect(receive().querySelector<HTMLDetailsElement>('[data-soft-detail]')!.open).toBe(false);
    expect(receive().querySelector('.funded')).not.toBeNull();
  });
  it.each(['en', 'da'] as const)('an unfunded status-read failure is retried on the next 3 s tick and clears without claiming funds (%s)', async lang => {
    const UNFUNDED = { current_step: 'awaiting_funds', tier: 'full', funding_address: 'bcrt1qsyntheticwaiting', funding_amount_sats_required: 50_000, funding_amount_sats_received: 0, funding_evidence: null, funded: false };
    let failing = true;
    const fundState = vi.fn(() => { if (failing) throw RAW_STATE_ERROR; return UNFUNDED; });
    const { receive } = await openPhoneReceive(platform, lang, { fund_state: fundState });
    expect(receive().querySelector('[data-soft-summary]')?.textContent).toBe(COPY[lang].stateFailed);
    expect(receive().querySelector('[data-soft-summary]')!.textContent).not.toContain('500');
    expect(receive().querySelector('[data-soft-detail]')?.textContent).toContain(RAW_STATE_ERROR);
    expect(receive().querySelector<HTMLDetailsElement>('[data-soft-detail]')!.open).toBe(false);
    expect(receive().querySelector('.funded')).toBeNull();
    failing = false;
    const before = fundState.mock.calls.length;
    // No read before the interval comes round...
    await vi.advanceTimersByTimeAsync(2_999); await tick();
    expect(fundState).toHaveBeenCalledTimes(before);
    expect(receive().querySelector('[data-soft-summary]')?.textContent).toBe(COPY[lang].stateFailed);
    // ...and a real read on the tick, whose unfunded answer clears the error.
    await vi.advanceTimersByTimeAsync(1); await tick();
    expect(fundState.mock.calls.length).toBeGreaterThan(before);
    expect(receive().querySelector('[data-soft-summary]')).toBeNull();
    expect(receive().querySelector('.funded')).toBeNull();
    expect(receive().querySelector('code.address')?.textContent).toContain('bcrt1qsyntheticwaiting');
    // Still unfunded, so it keeps reading on later ticks.
    const after = fundState.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3_000); await tick();
    expect(fundState.mock.calls.length).toBeGreaterThan(after);
    expect(receive().querySelector('.funded')).toBeNull();
  });
});
