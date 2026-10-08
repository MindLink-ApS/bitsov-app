import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import App from '../src/App';

const node = 'ab'.repeat(32);
const legacyKey = `bitsov.trust.v1.remote.${node}`;
let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.useRealTimers(); });

function host(accepted: string | null = null) {
  const state = { node, accepted, fail: false };
  const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'peers_list') return [{ node_id: 'cd'.repeat(32), addr: null, label: 'Peer', connected: true }];
    if (cmd === 'messages_list') return [];
    if (cmd === 'node_status') return { ready: true, node_id: state.node, error: null };
    if (cmd === 'pairing_status') return {
      state: 'paired', remote: true, scopes: ['read'], bootstrap: null,
      short_code: null, code_from_node: false, reason: null,
      trust_acknowledged_node_id: state.accepted,
    };
    if (cmd === 'trust_acknowledge') {
      if (state.fail) throw new Error('Could not save trust acknowledgement.');
      expect(args).toMatchObject({ node_id: state.node, remote: true });
      state.accepted = state.node;
      return true;
    }
    throw new Error('unavailable');
  });
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
  return { state, invoke };
}
const mount = () => { dispose = render(() => <App />, document.body); };
const gate = () => document.querySelector('[data-gate="g6-remote-trust"]');
const accept = () => [...document.querySelectorAll('button')].find(b => b.textContent?.includes('I understand'))!.click();

it('reinstall with existing pairing and durable acknowledgement skips trust with empty webview storage', async () => {
  host(node);
  mount();
  await vi.waitFor(() => expect(document.querySelector('[data-composer-bar]')).not.toBeNull());
  expect(gate()).toBeNull();
});

it('a new node id asks again despite the previous durable acknowledgement', async () => {
  const { state } = host(node);
  state.node = 'cd'.repeat(32);
  mount();
  await vi.waitFor(() => expect(gate()).not.toBeNull());
  expect(document.querySelector('[data-composer-bar]')).toBeNull();
});

it('fresh install asks, and accepting survives a reinstall that clears localStorage', async () => {
  const { invoke } = host();
  mount();
  await vi.waitFor(() => expect(gate()).not.toBeNull());
  accept();
  await vi.waitFor(() => expect(gate()).toBeNull());
  expect(invoke).toHaveBeenCalledWith('trust_acknowledge', { node_id: node, remote: true, legacy: false }, undefined);
  dispose!(); document.body.innerHTML = ''; localStorage.clear();
  mount();
  await vi.waitFor(() => expect(document.querySelector('[data-composer-bar]')).not.toBeNull());
  expect(gate()).toBeNull();
});

it('migrates the matching legacy flag once, only removing it after the host saves it', async () => {
  const { invoke } = host();
  localStorage.setItem(legacyKey, 'accepted');
  mount();
  await vi.waitFor(() => expect(localStorage.getItem(legacyKey)).toBeNull());
  expect(invoke).toHaveBeenCalledWith('trust_acknowledge', { node_id: node, remote: true, legacy: true }, undefined);
  dispose!(); document.body.innerHTML = '';
  mount();
  await vi.waitFor(() => expect(document.querySelector('[data-composer-bar]')).not.toBeNull());
  expect(invoke.mock.calls.filter(([cmd]) => cmd === 'trust_acknowledge')).toHaveLength(1);
});

it('retains the legacy flag and stays gated when migration cannot be saved', async () => {
  const { state } = host(); state.fail = true;
  localStorage.setItem(legacyKey, 'accepted');
  mount();
  await vi.waitFor(() => expect(gate()).not.toBeNull());
  expect(localStorage.getItem(legacyKey)).toBe('accepted');
  expect(document.querySelector('[data-composer-bar]')).toBeNull();
});

it('shows a persistence failure and allows retry before opening funding', async () => {
  const { state } = host(); state.fail = true;
  mount();
  await vi.waitFor(() => expect(gate()).not.toBeNull());
  accept();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Could not save trust acknowledgement.'));
  expect(gate()).not.toBeNull();
  state.fail = false; accept();
  await vi.waitFor(() => expect(gate()).toBeNull());
});

it.each([false, true])('a late acknowledgement cannot accept a different node (migration=%s)', async legacy => {
  vi.useFakeTimers();
  const { state, invoke } = host();
  let finish!: (accepted: boolean) => void;
  const pending = new Promise<boolean>(resolve => { finish = resolve; });
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke: (cmd: string, args?: Record<string, unknown>) =>
    cmd === 'trust_acknowledge' ? pending : invoke(cmd, args),
  });
  if (legacy) localStorage.setItem(legacyKey, 'accepted');
  mount();
  await vi.advanceTimersByTimeAsync(1);
  if (!legacy) accept();
  state.node = 'ef'.repeat(32);
  await vi.advanceTimersByTimeAsync(1500);
  finish(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(gate()).not.toBeNull();
  expect(document.querySelector('[data-composer-bar]')).toBeNull();
});
