import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { INITIAL_PAIRING } from '../src/onboarding/pairing';

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const tick = async () => { for (let i = 0; i < 70; i++) await Promise.resolve(); };
const button = (text: string) => [...document.querySelectorAll('button')].find(b => b.textContent?.includes(text))!;
function mount(platform: string, existing = false, legacy = false) {
  vi.useFakeTimers();
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(platform);
  const state = { connected: existing, approved: false, trusted: false, locked: false, inbox: 'bitsov://pair/synthetic' as string | null };
  const actions: unknown[] = [];
  const invoke = vi.fn(async (cmd: string, args?: any) => {
    if (cmd === 'node_status') return { phone_setup: !existing, locked: state.locked, ready: state.connected && !state.locked, node_id: state.connected ? 'ab'.repeat(32) : null, error: null };
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
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
  dispose = render(() => <App />, document.body);
  return { state, actions, invoke };
}
describe.each(['iPhone', 'Android'])('%s first-run onboarding', platform => {
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
it('resumes a saved second-device enrollment without consuming a replacement link', async () => {
  vi.useFakeTimers();
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone');
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
