import { waitFor } from './helpers/fake-clock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import { setLanguagePref } from '../src/i18n';
import type { PairingView } from '../src/onboarding/pairing';
import { resetContactsForTests, setPetname } from '../src/control/petnames';
import { setShowLegacyRoomsUi } from '../src/control/Shell';

// The control center against a stubbed host (command replies + one `node-live`
// listener) and against dev sample data. No node, no network.

const OWN = '1'.repeat(64);
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const ROOM = '0f8e2b7a-1c3d-4e5f-8a9b-0c1d2e3f4a5b';

const paired: PairingView = {
  state: 'paired',
  scopes: ['read', 'receive'],
  short_code: 'ABCD-EFGH',
  code_from_node: true,
  reason: null,
  remote: false, bootstrap: null,
};

type Call = { cmd: string; args: Record<string, unknown> | undefined };

function stubHost(overrides: Record<string, (args?: Record<string, unknown>) => unknown> = {}) {
  resetContactsForTests();
  setPetname(A, 'Maya');
  const calls: Call[] = [];
  let trustedNode: string | null = null;
  const callbacks = new Map<number, (e: unknown) => void>();
  // The host's socket state (`live_link`). Opening it here emits nothing, like a
  // bridge that connected before the shell subscribed.
  const host = { link: null as 'connecting' | 'open' | 'closed' | null };
  const REPLIES: Record<string, (args?: Record<string, unknown>) => unknown> = {
    node_status: () => ({ ready: true, node_id: OWN, error: null }),
    trust_acknowledge: (args) => { trustedNode = args!.node_id as string; return true; },
    pairing_status: () => ({ ...paired, trust_acknowledged_node_id: trustedNode }),
    node_overview: () => ({
      node_id: OWN, status: 'ok', version: 'api v2', connected_peers: 1, e2ee_sessions: 2,
      pending_deliveries: 0, lightning_available: true, block_height: 860123, uptime_secs: 60,
      lightning_backend: 'ldk', chain_backend: 'esplora', read_at: Date.now(),
    }),
    peers_list: () => [
      { node_id: A, addr: '127.0.0.1:9735', label: 'Maya', connected: true, fingerprint: 'aaaaaaaa' },
      { node_id: B, addr: '127.0.0.1:9736', label: null, connected: false, fingerprint: 'bbbbbbbb' },
    ],
    rooms_list: () => [{ id: ROOM, name: 'Mexico build', created_by: OWN, created_at: null }],
    room_members: () => [OWN, A, B],
    messages_list: (args) =>
      args?.peer === A
        ? [{ id: 'm1', kind: 0, sender: A, recipient: OWN, timestamp: 1_725_000_000_000, plaintext: 'hello from Maya', payment_amount_msat: 2000 }]
        : [],
    price_quote: (args) =>
      args?.peer === A
        ? { kind: 0, own_msat: 1000, peer_msat: 2000, peer_age_secs: 60, max_routing_fee_msat: 0, peer_stale: false }
        : { kind: 0, own_msat: 1000, peer_msat: null, peer_age_secs: null, max_routing_fee_msat: 0, peer_stale: false },
    payments_overview: () => ({
      balance_msat: 52_500_000,
      lightning_outbound_msat: 500_000,
      channels: [{ channel_id: 'c1', peer_pubkey: '02' + 'cd'.repeat(32), capacity_msat: 700_000, local_balance_msat: 500_000, remote_balance_msat: 200_000, active: true }],
    }),
    fund_state: () => null,
    spend_status: () => ({ state: 'locked', basis: null, open_until_ms: null, pending: null, window_ms: 600_000 }),
    file_price: () => ({ principal_msat: 3000, max_routing_fee_msat: 5000, total_msat: 8000 }),
    room_quote: () => ({
      room_id: ROOM,
      members: [
        { node_id: A, msat: 2000, advertised: true, connected: true },
        { node_id: B, msat: 1000, advertised: false, connected: false },
      ],
      total_msat: 3000,
      unreachable: [B],
      estimate: true,
    }),
    live_link: () => {
      if (host.link) emitLive({ type: 'link', state: host.link, detail: null });
      return host.link;
    },
    'plugin:event|listen': () => 1,
    'plugin:event|unlisten': () => null,
    ...overrides,
  };
  vi.stubGlobal('__TAURI_INTERNALS__', {
    transformCallback: (cb: (e: unknown) => void) => {
      const id = callbacks.size + 1;
      callbacks.set(id, cb);
      return id;
    },
    invoke: (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      const reply = REPLIES[cmd];
      return reply ? Promise.resolve(reply(args)) : Promise.reject(new Error(`unexpected ${cmd}`));
    },
  });
  vi.stubGlobal('__TAURI_EVENT_PLUGIN_INTERNALS__', { unregisterListener: () => {} });
  const emitLive = (payload: unknown) => {
    const listen = calls.find((c) => c.cmd === 'plugin:event|listen');
    const handler = callbacks.get(listen!.args!.handler as number)!;
    handler({ event: 'node-live', id: 1, payload });
  };
  return { calls, emitLive, host };
}

describe('control center shell', () => {
  let dispose: (() => void) | undefined;
  let mount: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    setShowLegacyRoomsUi(true);
  });

  afterEach(() => {
    setShowLegacyRoomsUi(false);
    dispose?.();
    dispose = undefined;
    mount?.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    setLanguagePref('en');
  });

  const start = () => {
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => <App />, mount);
  };
  const click = (sel: string) => mount.querySelector<HTMLElement>(sel)!.click();

  async function openChat() {
    start();
    await waitFor(() => expect([...mount.querySelectorAll('button')].some((b) => b.textContent?.includes('I understand'))).toBe(true));
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
    await waitFor(() => expect(mount.querySelector('[data-message="m1"]')).not.toBeNull());
  }

  it.each([false, true])('animates new ids once, keeping rows through echoes, refreshes and navigation (reduced motion: %s)', async (reduced) => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduced && query === '(prefers-reduced-motion: reduce)' }));
    const { emitLive } = stubHost();
    await openChat();
    const history = mount.querySelector('[data-message="m1"]')!;
    expect(history.classList.contains('fresh')).toBe(false);
    const message = { id: 'new', kind: 0, sender: A, recipient: OWN, timestamp: Date.now(), plaintext: 'just arrived', payment_amount_msat: 2000 };
    emitLive({ type: 'message', room_id: null, message });
    await waitFor(() => expect(mount.querySelector('[data-message="new"]')).not.toBeNull());
    const row = mount.querySelector('[data-message="new"]')!;
    expect(row.classList.contains('fresh')).toBe(!reduced);
    row.querySelector('.bubble')!.dispatchEvent(new Event('animationend', { bubbles: true }));
    expect(row.classList.contains('fresh')).toBe(false);
    emitLive({ type: 'message', room_id: null, message: { ...message, plaintext: 'updated echo' } });
    expect(mount.querySelector('[data-message="new"]')).toBe(row);
    expect(row.textContent).toContain('updated echo');
    expect(mount.querySelector('[data-message="m1"]')).toBe(history);
    emitLive({ type: 'message', room_id: null, message: { ...message, id: 'm1', timestamp: 1_725_000_000_000 } });
    expect(history.classList.contains('fresh')).toBe(false);
    click(`[data-track="peer:${B}"]`);
    click(`[data-track="peer:${A}"]`);
    await waitFor(() => expect(mount.querySelector('[data-message="new"]')).not.toBeNull());
    expect(mount.querySelector('[data-message="new"]')!.classList.contains('fresh')).toBe(false);
  });

  it('keeps Porch request, response and manifest history and live events out of chat and unread counts', async () => {
    const chat = { id: 'm1', kind: 0, sender: A, recipient: OWN, timestamp: 1, plaintext: '{"kind":500,"text":"ordinary chat"}', payment_amount_msat: 2000 };
    const porch = [500, 501, 510].flatMap((kind) => [
      { ...chat, id: `in-${kind}`, kind, plaintext: `private-porch-${kind}` },
      { ...chat, id: `out-${kind}`, kind, sender: OWN, recipient: A, plaintext: `private-porch-${kind}` },
    ]);
    const { emitLive } = stubHost({ messages_list: () => [chat, ...porch, { ...chat, id: 'file', kind: 200, plaintext: 'photo.png' }] });
    await openChat();
    expect(mount.querySelector('[data-stream]')!.textContent).toContain('ordinary chat');
    expect(mount.querySelector('[data-message="file"]')).not.toBeNull();
    expect(mount.querySelector('[data-stream]')!.textContent).not.toContain('private-porch');
    for (const m of porch) emitLive({ type: 'message', room_id: null, message: { ...m, id: `live-${m.id}` } });
    expect(mount.querySelector('[data-stream]')!.textContent).not.toContain('private-porch');
    click(`[data-track="peer:${B}"]`);
    for (const m of porch) emitLive({ type: 'message', room_id: null, message: { ...m, id: `unread-${m.id}` } });
    expect(mount.querySelector(`[data-track="peer:${A}"] .badge`)).toBeNull();
  });

  it('pauses warm polling during cooldown without restarting subscriptions or bursting on resume', async () => {
    vi.useFakeTimers();
    let retry: number | null = null;
    let running = 0;
    let peak = 0;
    const reads = ['node_overview', 'peers_list', 'rooms_list', 'payments_overview', 'price_quote', 'spend_status', 'budget_status', 'energy_read', 'membrane_read', 'file_price', 'room_quote', 'device_key_status'];
    const { calls } = stubHost({
      node_status: () => ({ ready: true, node_id: OWN, error: null, retry_after_secs: retry }),
      pairing_status: () => ({ ...paired, remote: true, trust_acknowledged_node_id: OWN }),
    });
    const host = (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ as unknown as { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
    const invoke = host.invoke;
    host.invoke = async (cmd, args) => {
      if (!reads.includes(cmd)) return invoke(cmd, args);
      running++; peak = Math.max(peak, running);
      try {
        await new Promise(resolve => setTimeout(resolve, 20));
        return await invoke(cmd, args);
      } finally { running--; }
    };
    start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(peak).toBeLessThanOrEqual(2);
    retry = 42;
    await vi.advanceTimersByTimeAsync(1600);
    const count = () => calls.filter(c => reads.includes(c.cmd)).length;
    const before = count();
    await vi.advanceTimersByTimeAsync(35_000);
    expect(count()).toBe(before);
    expect(calls.filter(c => c.cmd === 'plugin:event|listen')).toHaveLength(1);
    retry = null;
    await vi.advanceTimersByTimeAsync(1500);
    expect(count() - before).toBeLessThanOrEqual(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(count()).toBeGreaterThan(before);
    expect(peak).toBeLessThanOrEqual(2);
    expect(calls.filter(c => c.cmd === 'plugin:event|listen')).toHaveLength(1);
    expect(calls.filter(c => c.cmd === 'plugin:event|unlisten')).toHaveLength(0);
  });

  it('keeps first run in the centre track and reads nothing before the trust gate', async () => {
    const { calls } = stubHost();
    start();
    await waitFor(() => expect(mount.querySelector('[data-gate="g6-local-trust"]')).not.toBeNull());
    expect(mount.querySelector('[data-first-run]')).not.toBeNull();
    expect(mount.querySelector('.rail')).not.toBeNull();
    expect(mount.querySelector('[data-panel="wallet"]')).toBeNull();
    expect(new Set(calls.map((c) => c.cmd))).toEqual(new Set(['node_status', 'pairing_status', 'device_key_status']));
  });

  it('keeps a spend approval refusal across status polls, then clears it on retry', async () => {
    let reject = true;
    stubHost({ spend_status: () => ({ state: 'expired', lapse: 'lost', basis: null, open_until_ms: null, pending: null, window_ms: 600_000 }), spend_request: () => {
      if (reject) throw { code: 'node', message: '/pair/elevation-request failed (404)' };
      return { state: 'pending', basis: null, open_until_ms: null, window_ms: 600_000,
        pending: { op_id: 'op', expires_at_ms: Date.now() + 900_000, owner_action: 'grant op', owner_can_grant: true } };
    } });
    start();
    await waitFor(() => expect(mount.textContent).toContain('I understand'));
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
    await waitFor(() => expect(mount.querySelector('[data-spend-ask-again]')).not.toBeNull());
    click('[data-spend-ask-again]');
    await waitFor(() => expect(mount.textContent).toContain('/pair/elevation-request failed (404)'));
    await vi.advanceTimersByTimeAsync(3200);
    expect(mount.textContent).toContain('/pair/elevation-request failed (404)');
    reject = false;
    click('[data-spend-ask-again]');
    await waitFor(() => expect(mount.textContent).not.toContain('/pair/elevation-request failed (404)'));
  });

  it('relaunches into the real shell with rc8 rooms after accepting trust for this node', async () => {
    stubHost({ node_overview: () => ({ node_id: OWN, capabilities: ['room_binding_v1'], money_ready: true }) });
    start();
    await waitFor(() => expect(mount.textContent).toContain('I understand'));
    expect(mount.querySelector('.rail')?.textContent).not.toContain('does not support rooms');
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
    await waitFor(() => expect(mount.querySelector('[data-first-run]')).toBeNull());
    dispose?.(); mount.remove();
    start();
    await waitFor(() => expect(mount.querySelector('[data-first-run]')).toBeNull());
    await waitFor(() => expect(mount.querySelector('.rail')?.textContent).toContain('New room'));
    expect(mount.querySelector('.rail')?.textContent).not.toContain('Available after setup');
  });

  it('keeps the acknowledged shell mounted through a transient node-status failure', async () => {
    let failed = false;
    stubHost({ node_status: () => { if (failed) throw new Error('temporarily unavailable'); return { ready: true, node_id: OWN, error: null }; } });
    start();
    await waitFor(() => expect(mount.textContent).toContain('I understand'));
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
    await waitFor(() => expect(mount.querySelector('[data-first-run]')).toBeNull());
    const shell = mount.querySelector('.cc');
    failed = true;
    await vi.advanceTimersByTimeAsync(1600);
    expect(mount.querySelector('.cc')).toBe(shell);
    failed = false;
    await vi.advanceTimersByTimeAsync(1600);
    expect(mount.querySelector('.cc')).toBe(shell);
    expect(mount.querySelector('[data-first-run]')).toBeNull();
  });

  it('offers Ask again when the node lost the pending request in a restart', async () => {
    const cmd = "konsensus grant --op ab02 --config '/Users/owner/node/konsensus.toml'";
    const { calls } = stubHost({
      spend_status: () => ({ state: 'expired', lapse: 'lost', basis: null, open_until_ms: null, pending: null, window_ms: 600_000 }),
      spend_request: () => ({
        state: 'pending', lapse: null, basis: null, open_until_ms: null, window_ms: 600_000,
        pending: { op_id: 'ab02', expires_at_ms: Date.now() + 900_000, owner_action: cmd, owner_can_grant: true },
      }),
    });
    start();
    await waitFor(() => expect(mount.querySelector('[data-gate] + button, .primary')).not.toBeNull());
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();

    await waitFor(() => expect(mount.querySelector('[data-spend-lapse="lost"]')).not.toBeNull());
    expect(mount.querySelector('[data-spend-lapse]')?.textContent).toContain('restarted');
    expect(calls.some((c) => c.cmd === 'spend_request')).toBe(false);

    // A double click asks once.
    click('[data-spend-ask-again]');
    click('[data-spend-ask-again]');
    await waitFor(() => expect(mount.querySelector('[data-approval="pending"] [data-owner-action]')?.textContent).toBe(cmd));
    expect(mount.querySelector('[data-approval="pending"]')?.textContent).toContain('short code');
    expect(calls.filter((c) => c.cmd === 'spend_request')).toHaveLength(1);
  });

  it('the connection card: a Check now still out stays disabled after leaving the Node page and coming back', async () => {
    let hold = false;
    const waiting: (() => void)[] = [];
    const host = stubHost({
      node_status: () => {
        const ok = { ready: true, node_id: OWN, error: null };
        return hold ? new Promise((r) => { waiting.push(() => r(ok)); }) : ok;
      },
    });
    start();
    await waitFor(() => expect(mount.querySelector('[data-gate] + button, .primary')).not.toBeNull());
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
    await waitFor(() => expect(mount.querySelector<HTMLButtonElement>('[data-profile]')?.disabled).toBe(false));
    click('[data-profile]');
    await waitFor(() => expect(mount.querySelector('[data-open-settings]')).not.toBeNull());
    click('[data-open-settings]');
    await waitFor(() => expect(mount.querySelector('[data-tab="node"]')).not.toBeNull());
    click('[data-tab="node"]');
    await waitFor(() => expect(mount.querySelector('[data-connection-check]')).not.toBeNull());
    hold = true;
    click('[data-connection-check]');
    await waitFor(() => expect(mount.querySelector<HTMLButtonElement>('[data-connection-check]')!.disabled).toBe(true));
    // Node → General → Node: a fresh card, the same check still out.
    click('[data-tab="general"]');
    await waitFor(() => expect(mount.querySelector('[data-connection-card]')).toBeNull());
    click('[data-tab="node"]');
    await waitFor(() => expect(mount.querySelector('[data-connection-check]')).not.toBeNull());
    expect(mount.querySelector<HTMLButtonElement>('[data-connection-check]')!.disabled).toBe(true);
    expect(mount.querySelector('[data-connection-check]')!.textContent).toBe('Checking…');
    hold = false;
    waiting.splice(0).forEach((go) => go());
    await waitFor(() => expect(mount.querySelector<HTMLButtonElement>('[data-connection-check]')!.disabled).toBe(false));
    expect(host.calls.length).toBeGreaterThan(0);
  });

  it('the connection card (Settings → Node): Copy details carries no id, address, onion, ticket or token, and Check now reads only the node status', async () => {
    const TICKET = 'bitsov://pair/SECRETTICKET123';
    const TOKEN = 'tok_9f8e7d6c5b4a3921';
    const host = stubHost({
      // Sensitive values the host knows: none of them may reach the copied text.
      node_status: () => ({ ready: true, node_id: OWN, error: null, pairing_link: TICKET, token: TOKEN, address: '203.0.113.7:9735' }),
      node_overview: () => ({
        node_id: OWN, status: 'ok', version: 'api v2', connected_peers: 1, e2ee_sessions: 2, pending_deliveries: 0, lightning_available: true,
        block_height: 860123, uptime_secs: 60, lightning_backend: 'ldk', chain_backend: 'esplora', read_at: Date.now(),
        stun_source: 'own', stun_port: 3478, stun_url: 'stun:mynode.example.org:3478', onion: 'abcdefghijklmnop.onion',
      }),
    });
    let copied = '';
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => { copied = t; } } });
    start();
    await waitFor(() => expect(mount.querySelector('[data-gate] + button, .primary')).not.toBeNull());
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
    await waitFor(() => expect(mount.querySelector<HTMLButtonElement>('[data-profile]')?.disabled).toBe(false));
    click('[data-profile]');
    await waitFor(() => expect(mount.querySelector('[data-open-settings]')).not.toBeNull());
    click('[data-open-settings]');
    await waitFor(() => expect(mount.querySelector('[data-tab="node"]')).not.toBeNull());
    click('[data-tab="node"]');
    await waitFor(() => expect(mount.querySelector('[data-connection-card]')).not.toBeNull());
    await waitFor(() => expect(mount.querySelector('[data-connection-line="2"]')!.textContent).toMatch(/^Last status check: .+ · \d+ ms \(this app ↔ its host\)$/));
    expect(mount.querySelector('[data-connection-line="3"]')!.textContent).toBe('Calls · STUN: your own node');
    click('[data-connection-copy]');
    await waitFor(() => expect(copied).toContain('BitSov connection'));
    for (const secret of [OWN, A, B, TICKET, 'SECRETTICKET', TOKEN, '203.0.113.7', '127.0.0.1', '9735', '9736', 'mynode.example.org', '3478', 'abcdefghijklmnop', '.onion']) {
      expect(copied).not.toContain(secret);
    }
    // Patterns: no long hex id, no IPv4, no host:port, no onion, no pairing link, no token-looking string.
    expect(copied).not.toMatch(/[0-9a-f]{16,}/i);
    expect(copied).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
    // host:port (a clock time like 12:04:31 is not one): a dotted host name or localhost, then a port.
    expect(copied).not.toMatch(/\b(localhost|[a-z][a-z0-9-]*(\.[a-z0-9-]+)+):\d{2,5}\b/i);
    expect(copied).not.toMatch(/\.onion|bitsov:\/\/|tok_/i);
    // Check now: one node status read, nothing else.
    const count = (cmd: string) => host.calls.filter((c) => c.cmd === cmd).length;
    const before = { status: count('node_status'), pairing: count('pairing_status'), budget: count('budget_status'), spend: count('spend_status') };
    click('[data-connection-check]');
    await Promise.resolve(); await Promise.resolve();
    // One read, or none when a poll's read is already out (Check now then waits for that one).
    expect(count('node_status') - before.status).toBeLessThanOrEqual(1);
    expect({ pairing: count('pairing_status'), budget: count('budget_status'), spend: count('spend_status') }).toEqual({ pairing: before.pairing, budget: before.budget, spend: before.spend });
  });

  it('with this Mac registered, the composer approves one contact with Touch ID, terms first', async () => {
    const open = { state: 'open', lapse: null, basis: 'node_grant', open_until_ms: Date.now() + 600_000, pending: null, window_ms: 600_000 };
    const { calls } = stubHost({
      device_key_status: () => ({ available: true, state: 'registered', fingerprint: '3F9A-12C4', owner_action: null, expires_at_ms: null }),
      relation_approve: () => open,
      // The node's label for A is a self-claim that differs from the local petname (Maya).
      peers_list: () => [
        { node_id: A, addr: '127.0.0.1:9735', label: 'Bank Support', connected: true, fingerprint: 'aaaaaaaa' },
        { node_id: B, addr: '127.0.0.1:9736', label: null, connected: false, fingerprint: 'bbbbbbbb' },
      ],
    });
    start();
    await waitFor(() => expect(mount.querySelector('[data-gate] + button, .primary')).not.toBeNull());
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();

    await waitFor(() => expect(mount.querySelector('[data-touch-approval]')).not.toBeNull());
    const box = mount.querySelector('[data-touch-approval]')!.textContent!;
    expect(box).toContain('200 sats in total');
    expect(box).not.toContain('a day');
    expect(box).toContain('at most 2 sats per message');
    expect(mount.querySelector('[data-touch-peer]')?.textContent).toBe(`${A.slice(0, 8)}…${A.slice(-8)}`);
    // Petname plus the short key, visible on the line; never the node's claimed label.
    expect(box).toContain(`Approve Maya (node ${A.slice(0, 8)}…${A.slice(-8)}) with Touch ID.`);
    expect(box).not.toContain('Bank Support');
    // Above the capsule, so the terms read before Send.
    const line = mount.querySelector('[data-touch-approval]')!;
    const bar = mount.querySelector('[data-composer-bar]')!;
    expect(line.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() => expect(mount.querySelector('[data-send]')?.textContent).toBe('Approve with Touch ID'));
    expect(calls.some((c) => c.cmd === 'relation_approve' || c.cmd === 'spend_request')).toBe(false);

    // Send in the composer is the Touch ID tap; the line above it only states the terms.
    expect(mount.querySelector('[data-touch-approval] button')?.getAttribute('aria-expanded')).toBe('false');
    const draft = mount.querySelector<HTMLTextAreaElement>('[data-composer] textarea')!;
    draft.value = 'hello'; draft.dispatchEvent(new Event('input', { bubbles: true }));
    click('[data-send]');
    await waitFor(() => expect(calls.filter((c) => c.cmd === 'relation_approve')).toHaveLength(1));
    const args = calls.find((c) => c.cmd === 'relation_approve')!.args!;
    expect(args).toMatchObject({ peer: A, budget_msat: null, per_act_max_msat: 2000 });
    // No name of any kind goes to the host: the petname stays on this Mac.
    expect(Object.keys(args).sort()).toEqual(['budget_msat', 'peer', 'per_act_max_msat']);
    expect(JSON.stringify(calls.map((c) => c.args ?? {}))).not.toContain('Maya');
    expect(calls.some((c) => c.cmd === 'spend_request')).toBe(false);
  });

  it('a Touch ID window opened for another contact offers Touch ID here, not Send', async () => {
    const other = 'c'.repeat(64);
    const open = { state: 'open', lapse: null, basis: 'node_grant', open_until_ms: Date.now() + 600_000, pending: null, window_ms: 600_000 };
    const grant = (envelopes: Record<string, number>) => ({
      paused: false, waiting_for_owner: false, ceiling_msat: 500_000, max_daily_msat: 100_000_000, spent_msat: 0, unsettled_msat: 0,
      preset: 'careful', presets: [{ id: 'careful', contact_msat: 50_000, room_msat: 100_000, ceiling_msat: 500_000 }], rows: [],
      autopay: { state: 'off', open_until_ms: null, ceiling_msat: null, basis: null }, window_ms: 600_000,
      node_grant: { expires_at_ms: Date.now() + 86_400_000, budget_msat: 200_000, remaining_msat: 200_000, per_call_max_msat: 200_000, envelopes },
    });
    let envelopes: Record<string, number> = { [other]: Date.now() + 86_400_000 };
    const { calls } = stubHost({
      device_key_status: () => ({ available: true, state: 'registered', fingerprint: '3F9A-12C4', owner_action: null, expires_at_ms: null }),
      spend_status: () => open,
      budget_status: () => grant(envelopes),
      relation_approve: () => {
        envelopes = { ...envelopes, [A]: Date.now() + 86_400_000 };
        return open;
      },
    });
    start();
    await waitFor(() => expect(mount.querySelector('[data-gate] + button, .primary')).not.toBeNull());
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();

    await waitFor(() => expect(mount.querySelector('[data-send]')?.textContent).toBe('Approve with Touch ID'));
    expect(mount.querySelector('[data-touch-approval]')).not.toBeNull();
    const draft = mount.querySelector<HTMLTextAreaElement>('[data-composer] textarea')!;
    draft.value = 'hello'; draft.dispatchEvent(new Event('input', { bubbles: true }));
    click('[data-send]');
    await waitFor(() => expect(calls.filter((c) => c.cmd === 'relation_approve')).toHaveLength(1));
    expect(calls.find((c) => c.cmd === 'relation_approve')!.args).toMatchObject({ peer: A });
    expect(calls.some((c) => c.cmd === 'message_send')).toBe(false);
    // With the envelope in place, Send is back.
    await waitFor(() => expect(mount.querySelector('[data-send]')?.textContent).toMatch(/^Send/));
    expect(mount.querySelector('[data-touch-approval]')).toBeNull();
  });

  it('Touch ID has no identity to bind a continuation: the press approves, the words stay in the box, nothing is sent', async () => {
    const open = { state: 'open', lapse: null, basis: 'node_grant', open_until_ms: Date.now() + 600_000, pending: null, window_ms: 600_000, granted_op: 'cd34', armed_by_request: null };
    let envelopes: Record<string, number> = {};
    const grant = (envelopes: Record<string, number>) => ({
      paused: false, waiting_for_owner: false, ceiling_msat: 500_000, max_daily_msat: 100_000_000, spent_msat: 0, unsettled_msat: 0,
      preset: 'careful', presets: [{ id: 'careful', contact_msat: 50_000, room_msat: 100_000, ceiling_msat: 500_000 }], rows: [],
      autopay: { state: 'off', open_until_ms: null, ceiling_msat: null, basis: null }, window_ms: 600_000,
      node_grant: { expires_at_ms: Date.now() + 86_400_000, budget_msat: 200_000, remaining_msat: 200_000, per_call_max_msat: 200_000, envelopes },
    });
    const { calls } = stubHost({
      device_key_status: () => ({ available: true, state: 'registered', fingerprint: '3F9A-12C4', owner_action: null, expires_at_ms: null }),
      spend_status: () => open,
      budget_status: () => grant(envelopes),
      relation_approve: () => { envelopes = { [A]: Date.now() + 86_400_000 }; return open; },
      message_send: (args) => ({ message_id: 'sent-t', recipient: args!.recipient, is_room: false, delivered: true, amount_msat: 2000, sent_at_ms: Date.now() }),
    });
    start();
    await waitFor(() => expect(mount.querySelector('[data-gate] + button, .primary')).not.toBeNull());
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
    await waitFor(() => expect(mount.querySelector('[data-send]')?.textContent).toBe('Approve with Touch ID'));
    const area = mount.querySelector<HTMLTextAreaElement>('[data-composer] textarea')!;
    area.value = 'hello Maya';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    // The label promises only the approval.
    await waitFor(() => expect(mount.querySelector('[data-send]')?.textContent).toBe('Approve with Touch ID'));
    click('[data-send]');
    await waitFor(() => expect(calls.filter((c) => c.cmd === 'relation_approve')).toHaveLength(1));
    await waitFor(() => expect(mount.querySelector('[data-composer-note]')?.textContent).toBe('Approved. Press Send to send it.'));
    expect(mount.querySelector('[data-sending]')).toBeNull();
    expect(mount.querySelector<HTMLTextAreaElement>('[data-composer] textarea')!.value).toBe('hello Maya');
    await vi.advanceTimersByTimeAsync(300);
    expect(calls.some((c) => c.cmd === 'message_send')).toBe(false);
  });

  it('Touch ID A succeeds with its envelope read delayed, A ends and B opens between polls, B\'s envelope arrives: zero sends', async () => {
    const openV = { state: 'open', lapse: null, basis: 'node_grant', open_until_ms: Date.now() + 600_000, pending: null, window_ms: 600_000, granted_op: 'cd34', armed_by_request: null };
    let envelopes: Record<string, number> = {};
    const grant = (envelopes: Record<string, number>) => ({
      paused: false, waiting_for_owner: false, ceiling_msat: 500_000, max_daily_msat: 100_000_000, spent_msat: 0, unsettled_msat: 0,
      preset: 'careful', presets: [{ id: 'careful', contact_msat: 50_000, room_msat: 100_000, ceiling_msat: 500_000 }], rows: [],
      autopay: { state: 'off', open_until_ms: null, ceiling_msat: null, basis: null }, window_ms: 600_000,
      node_grant: { expires_at_ms: Date.now() + 86_400_000, budget_msat: 200_000, remaining_msat: 200_000, per_call_max_msat: 200_000, envelopes },
    });
    const { calls } = stubHost({
      device_key_status: () => ({ available: true, state: 'registered', fingerprint: '3F9A-12C4', owner_action: null, expires_at_ms: null }),
      spend_status: () => openV,
      budget_status: () => grant(envelopes),
      relation_approve: () => openV, // A approved; its envelope is not read yet
      message_send: (args) => ({ message_id: 'sent-t', recipient: args!.recipient, is_room: false, delivered: true, amount_msat: 2000, sent_at_ms: Date.now() }),
    });
    start();
    await waitFor(() => expect(mount.querySelector('[data-gate] + button, .primary')).not.toBeNull());
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
    await waitFor(() => expect(mount.querySelector('[data-send]')?.textContent).toBe('Approve with Touch ID'));
    const area = mount.querySelector<HTMLTextAreaElement>('[data-composer] textarea')!;
    area.value = 'hello Maya';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => expect(mount.querySelector('[data-send]')?.textContent).toBe('Approve with Touch ID'));
    click('[data-send]');
    await waitFor(() => expect(calls.filter((c) => c.cmd === 'relation_approve')).toHaveLength(1));
    // B's envelope (another approval) shows up on a later read.
    envelopes = { [A]: Date.now() + 86_400_000 };
    await vi.advanceTimersByTimeAsync(4000);
    expect(calls.some((c) => c.cmd === 'message_send')).toBe(false);
    expect(mount.querySelector('[data-sending]')).toBeNull();
  }, 20_000);

  // ---- Touch ID approve & send, bound to the envelope id relation_approve returned ----
  /** A host whose grant names envelope ids (relation_envelope_id_v1); `st` is the node's state, changed by the test. */
  function touchHost(st: {
    ids: Record<string, string | null> | null | undefined;
    envelopes: Record<string, number>;
    left?: Record<string, number>;
    perCall?: number;
    remaining?: number;
    spendOpen?: boolean;
    device?: string;
    grantUntil?: number;
    /** The budget read fails (the shell keeps the old grant and marks it stale). */
    budgetFail?: boolean;
    /** Autopay open with a row for A: messages go through the budget path. */
    budgetPath?: boolean;
    /** While set, relation_approve waits for it (Touch ID still being answered). */
    approveGate?: Promise<void> | null;
    /** While set, each send waits for it (a send still in flight ahead in the queue). */
    sendGate?: Promise<void> | null;
    approve: () => unknown;
  }) {
    const open = { state: 'open', lapse: null, basis: 'node_grant', open_until_ms: Date.now() + 600_000, pending: null, window_ms: 600_000, granted_op: 'cd34', armed_by_request: null };
    const locked = { state: 'locked', lapse: null, basis: null, open_until_ms: null, pending: null, window_ms: 600_000, granted_op: null, armed_by_request: null };
    const sent: string[] = [];
    const host = stubHost({
      device_key_status: () => ({ available: true, state: st.device ?? 'registered', fingerprint: '3F9A-12C4', owner_action: null, expires_at_ms: null }),
      spend_status: () => (st.spendOpen === false ? locked : open),
      budget_status: () => {
        if (st.budgetFail) throw { code: 'node', message: 'The budget could not be read.' };
        return {
        paused: false, waiting_for_owner: false, ceiling_msat: 500_000, max_daily_msat: 100_000_000, spent_msat: 0, unsettled_msat: 0,
        preset: 'careful', presets: [{ id: 'careful', contact_msat: 50_000, room_msat: 100_000, ceiling_msat: 500_000 }],
        rows: st.budgetPath ? [{ target: A, room: false, limit_msat: 50_000, spent_msat: 0, unsettled_msat: 0 }] : [],
        autopay: st.budgetPath
          ? { state: 'open', open_until_ms: Date.now() + 600_000, ceiling_msat: 500_000, basis: 'node_grant' }
          : { state: 'off', open_until_ms: null, ceiling_msat: null, basis: null },
        window_ms: 600_000,
        node_grant: {
          expires_at_ms: st.grantUntil ?? Date.now() + 86_400_000, budget_msat: 200_000, remaining_msat: st.remaining ?? 200_000, per_call_max_msat: st.perCall ?? 200_000,
          envelopes: st.envelopes,
          ...(st.ids === undefined ? {} : { envelope_id_by_recipient: st.ids }),
          ...(st.left ? { recipient_left_msat_by_recipient: st.left } : {}),
        },
        };
      },
      relation_approve: async () => {
        if (st.approveGate) await st.approveGate;
        return { ...(st.spendOpen === false ? locked : open), ...(st.approve() as object) };
      },
      message_send: async (args) => {
        sent.push(args!.plaintext as string);
        const n = sent.length;
        const gate = st.sendGate;
        if (gate) await gate;
        return { message_id: `sent-${n}`, recipient: args!.recipient, is_room: false, delivered: true, amount_msat: 2000, sent_at_ms: Date.now() };
      },
    });
    return { ...host, sent };
  }
  const DAY = 86_400_000;
  async function pressTouch(text = 'hello Maya') {
    start();
    await waitFor(() => expect(mount.querySelector('[data-gate] + button, .primary')).not.toBeNull());
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
    await waitFor(() => expect(mount.querySelector('[data-send]')?.textContent).toBe('Approve with Touch ID'));
    const area = mount.querySelector<HTMLTextAreaElement>('[data-composer] textarea')!;
    area.value = text;
    area.dispatchEvent(new Event('input', { bubbles: true }));
    // The label promises only the approval; the message waits in its bubble.
    await waitFor(() => expect(mount.querySelector('[data-send]')?.textContent).toBe('Approve with Touch ID'));
    click('[data-send]');
  }
  const unsentReason = () => mount.querySelector('[data-unsent-reason]')?.textContent ?? '';

  it.each([false, true])('Touch ID approve & send: receipt replaces sending (budget path %s)', async budgetPath => {
    const st = { budgetPath, ids: {} as Record<string, string | null>, envelopes: {} as Record<string, number>,
      approve: () => { st.ids = { [A]: 'env-1', [B]: 'env-b' }; st.envelopes = { [A]: Date.now() + DAY }; return { envelope_id: 'env-1' }; } };
    const host = touchHost(st);
    await pressTouch();
    await waitFor(() => expect(host.calls.filter((c) => c.cmd === 'relation_approve')).toHaveLength(1));
    await waitFor(() => expect(host.sent).toEqual(['hello Maya']));
    expect(mount.querySelector<HTMLTextAreaElement>('[data-composer] textarea')!.value).toBe('');
    await vi.advanceTimersByTimeAsync(3500);
    expect(host.sent).toEqual(['hello Maya']);
    expect(mount.querySelector('[data-sending]')).toBeNull();
    expect(mount.querySelector('[data-delivery="sent"]')?.textContent).toBe('Sent');
  }, 15_000);

  it.each(['en', 'da'] as const)('a delivery before the compose reply is preserved when the matching %s send settles', async lang => {
    let finish!: () => void;
    const st = { ids: {} as Record<string, string | null>, envelopes: {} as Record<string, number>,
      sendGate: new Promise<void>(resolve => { finish = resolve; }),
      approve: () => { st.ids = { [A]: 'env-1' }; st.envelopes = { [A]: Date.now() + DAY }; return { envelope_id: 'env-1' }; } };
    const host = touchHost(st);
    await pressTouch();
    await waitFor(() => expect(host.sent).toEqual(['hello Maya']));
    setLanguagePref(lang);
    expect(mount.querySelector('[data-sending]')).not.toBeNull();
    host.emitLive({ type: 'message', room_id: null, message: { id: 'sent-1', kind: 0, sender: OWN, recipient: A,
      timestamp: Date.now(), plaintext: 'hello Maya', payment_amount_msat: 2000 } });
    host.emitLive({ type: 'delivery', message_id: 'sent-1', status: 'delivered', reason: null });
    // Same-text echoes can belong to another device. The receipt establishes ownership.
    expect(mount.querySelector('[data-sending]')).not.toBeNull();
    expect(mount.querySelector('[data-sending-cap]')?.textContent).toContain('2');
    finish();
    await vi.advanceTimersByTimeAsync(3500);
    expect(mount.querySelector('[data-sending]')).toBeNull();
    expect(mount.querySelector('[data-message="sent-1"] [data-delivery="delivered"]')?.getAttribute('aria-label')).toBe(lang === 'en' ? 'Delivered' : 'Leveret');
    expect(mount.querySelectorAll('[data-message="sent-1"]')).toHaveLength(1);
  });

  it.each([
    ['no capability (null map)', null],
    ['an older host (no field)', undefined],
  ])('Touch ID with %s: the plain flow, the words stay, nothing is sent', async (_name, ids) => {
    const st = { ids, envelopes: {} as Record<string, number>, approve: () => { st.envelopes = { [A]: Date.now() + DAY }; return { envelope_id: 'env-1' }; } };
    const host = touchHost(st);
    await pressTouch();
    await waitFor(() => expect(mount.querySelector('[data-composer-note]')?.textContent).toBe('Approved. Press Send to send it.'));
    expect(mount.querySelector('[data-sending]')).toBeNull();
    expect(mount.querySelector<HTMLTextAreaElement>('[data-composer] textarea')!.value).toBe('hello Maya');
    await vi.advanceTimersByTimeAsync(300);
    expect(host.sent).toEqual([]);
  });

  it('Touch ID returning no envelope id: back to the box at once, nothing sent', async () => {
    const st = { ids: {} as Record<string, string | null>, envelopes: {} as Record<string, number>,
      approve: () => { st.ids = { [A]: 'env-1' }; st.envelopes = { [A]: Date.now() + DAY }; return { envelope_id: null }; } };
    const host = touchHost(st);
    await pressTouch();
    await waitFor(() => expect(mount.querySelector('[data-composer-note]')?.textContent).toBe('Approved. Press Send to send it.'));
    expect(mount.querySelector<HTMLTextAreaElement>('[data-composer] textarea')!.value).toBe('hello Maya');
    expect(mount.querySelector('[data-sending]')).toBeNull();
    await vi.advanceTimersByTimeAsync(300);
    expect(host.sent).toEqual([]);
  });

  it.each([
    ['another id (replaced)', { [A]: 'env-2' }],
    ['a null entry (legacy/unknown)', { [A]: null }],
    ['no entry for the contact', { [B]: 'env-b' }],
    ['a mixed-case key (read exact, lower-cased)', { [A.toUpperCase()]: 'env-1' }],
  ])('Touch ID: a fresh read with %s is stale: it needs Touch ID again, nothing sent', async (_name, after) => {
    const st = { ids: {} as Record<string, string | null>, envelopes: {} as Record<string, number>,
      approve: () => { st.ids = after; st.envelopes = { [A]: Date.now() + DAY }; return { envelope_id: 'env-1' }; } };
    const host = touchHost(st);
    await pressTouch();
    await waitFor(() => expect(unsentReason()).toContain('It needs Touch ID again. Press Send to ask.'));
    expect(mount.querySelector('[data-sending]')).toBeNull();
    await vi.advanceTimersByTimeAsync(300);
    expect(host.sent).toEqual([]);
  });

  it('Touch ID: a stale read still naming the old envelope does not end it; the fresh read with its own id sends once', async () => {
    // A's old envelope env-0 has ended (so the tap is Touch ID); the grant still names env-0 until the next read.
    const st = { ids: { [A]: 'env-0' } as Record<string, string | null>, envelopes: { [A]: Date.now() - 1000 } as Record<string, number>,
      approve: () => { st.ids = { [A]: 'env-1' }; st.envelopes = { [A]: Date.now() + DAY }; return { envelope_id: 'env-1' }; } };
    const host = touchHost(st);
    await pressTouch();
    await waitFor(() => expect(host.sent).toEqual(['hello Maya']));
    expect(unsentReason()).toBe('');
  });

  it.each([
    ['the contact\'s own remainder is short (the grant would cover)', { left: { [A]: 1000 } }, false],
    ['the per-call limit is short', { perCall: 1000 }, false],
    ['the whole grant\'s remainder is short', { remaining: 1000 }, false],
    ['the remainder map does not name the contact (grant-wide limits decide)', { left: { [B]: 0 } }, true],
    ['the contact\'s own remainder covers it', { left: { [A]: 2000 } }, true],
  ])('Touch ID cover: %s', async (_name, limits, sends) => {
    const st = { ids: {} as Record<string, string | null>, envelopes: {} as Record<string, number>, ...limits,
      approve: () => { st.ids = { [A]: 'env-1' }; st.envelopes = { [A]: Date.now() + DAY }; return { envelope_id: 'env-1' }; } };
    const host = touchHost(st);
    await pressTouch();
    if (sends) await waitFor(() => expect(host.sent).toEqual(['hello Maya']));
    else {
      await waitFor(() => expect(unsentReason()).toContain('It needs Touch ID again. Press Send to ask.'));
      await vi.advanceTimersByTimeAsync(300);
      expect(host.sent).toEqual([]);
    }
  });

  it('Touch ID cancelled with envelope ids: the waiting message ends, nothing sent', async () => {
    const st = { ids: {} as Record<string, string | null>, envelopes: {} as Record<string, number>,
      approve: () => { throw { code: 'device_cancelled', message: 'Touch ID was cancelled.' }; } };
    const host = touchHost(st);
    await pressTouch();
    await waitFor(() => expect(unsentReason()).toContain('It was not approved.'));
    expect(mount.querySelector('[data-sending]')).toBeNull();
    expect(host.sent).toEqual([]);
  });

  it('Touch ID: once seen, a read without the envelope lapses it, even if the same id shows again later', async () => {
    // The spending window stays shut, so the seen envelope waits instead of sending.
    const st = { ids: {} as Record<string, string | null>, envelopes: {} as Record<string, number>, spendOpen: false,
      approve: () => { st.ids = { [A]: 'env-1' }; st.envelopes = { [A]: Date.now() + DAY }; return { envelope_id: 'env-1' }; } };
    const host = touchHost(st);
    await pressTouch();
    await waitFor(() => expect(mount.querySelector('[data-sending="waiting"]')).not.toBeNull());
    await vi.advanceTimersByTimeAsync(500);
    expect(mount.querySelector('[data-sending="waiting"]')).not.toBeNull();
    // A partial read omits A; then A's env-1 is back and the window opens.
    st.ids = {};
    await waitFor(() => expect(unsentReason()).toContain('The approval was cancelled or lapsed before it went through.'), { timeout: 8000 });
    st.ids = { [A]: 'env-1' };
    st.spendOpen = true;
    await vi.advanceTimersByTimeAsync(4000);
    expect(host.sent).toEqual([]);
  }, 20_000);

  it('Touch ID: approvals on this Mac stopping while it waits ends it, nothing sent', async () => {
    const st = { ids: {} as Record<string, string | null>, envelopes: {} as Record<string, number>, spendOpen: false, device: 'registered',
      approve: () => { st.ids = { [A]: 'env-1' }; st.envelopes = { [A]: Date.now() + DAY }; return { envelope_id: 'env-1' }; } };
    const host = touchHost(st);
    await pressTouch();
    await waitFor(() => expect(mount.querySelector('[data-sending="waiting"]')).not.toBeNull());
    st.device = 'none';
    await waitFor(() => expect(unsentReason()).toContain('Touch ID approvals on this Mac stopped before it went through.'), { timeout: 20_000 });
    expect(host.sent).toEqual([]);
  }, 30_000);

  it('Touch ID: leaving the chat while it waits ends it (the #229 protections hold)', async () => {
    const st = { ids: {} as Record<string, string | null>, envelopes: {} as Record<string, number>, spendOpen: false,
      approve: () => { st.ids = { [A]: 'env-1' }; st.envelopes = { [A]: Date.now() + DAY }; return { envelope_id: 'env-1' }; } };
    const host = touchHost(st);
    await pressTouch();
    await waitFor(() => expect(mount.querySelector('[data-sending="waiting"]')).not.toBeNull());
    click(`[data-track="peer:${B}"]`);
    st.spendOpen = true;
    click(`[data-track="peer:${A}"]`);
    await waitFor(() => expect(unsentReason()).toContain('You left this chat before it was approved.'));
    await vi.advanceTimersByTimeAsync(3500);
    expect(host.sent).toEqual([]);
  }, 15_000);

  it('approved behind a send still in flight, then leaving the chat: it never sends when its turn comes', async () => {
    let release!: () => void;
    const st = {
      ids: { [A]: 'env-0' } as Record<string, string | null>, envelopes: { [A]: Date.now() + DAY } as Record<string, number>,
      sendGate: new Promise<void>((r) => { release = r; }) as Promise<void> | null,
      approve: () => { st.ids = { [A]: 'env-1' }; st.envelopes = { [A]: Date.now() + DAY }; return { envelope_id: 'env-1' }; },
    };
    const host = touchHost(st);
    start();
    await waitFor(() => expect(mount.querySelector('[data-gate] + button, .primary')).not.toBeNull());
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
    // Send 1 goes under A's live envelope env-0 and stays in flight.
    await waitFor(() => expect(mount.querySelector('[data-send]')?.textContent).toMatch(/^Send/));
    const area = () => mount.querySelector<HTMLTextAreaElement>('[data-composer] textarea')!;
    area().value = 'one';
    area().dispatchEvent(new Event('input', { bubbles: true }));
    click('[data-send]');
    await waitFor(() => expect(host.sent).toEqual(['one']));
    // env-0 ends: the next message is a Touch ID approve & send.
    st.envelopes = { [A]: Date.now() - 1000 };
    await waitFor(() => expect(mount.querySelector('[data-send]')?.textContent).toBe('Approve with Touch ID'), { timeout: 8000 });
    area().value = 'two';
    area().dispatchEvent(new Event('input', { bubbles: true }));
    click('[data-send]');
    await waitFor(() => expect(host.calls.filter((c) => c.cmd === 'relation_approve')).toHaveLength(1));
    // Approved and handed to the queue: its bubble is a plain "Sending", behind send 1.
    await waitFor(() => expect(mount.querySelectorAll('[data-sending=""]').length).toBe(2));
    click(`[data-track="peer:${B}"]`);
    st.sendGate = null;
    release();
    await vi.advanceTimersByTimeAsync(500);
    expect(host.sent).toEqual(['one']);
    click(`[data-track="peer:${A}"]`);
    await waitFor(() => expect(unsentReason()).toContain('You left this chat before it was sent.'));
  }, 20_000);

  /**
   * The queued-send reproduction: 'one' goes under A's live env-0 and stays in
   * flight; env-0 ends; 'two' is a Touch ID approve & send, approved (env-1)
   * and handed to the queue behind 'one'. Returns the release for 'one'.
   */
  async function twoHandedBehindOne(extra: Partial<Parameters<typeof touchHost>[0]> = {}) {
    let release!: () => void;
    const st: Parameters<typeof touchHost>[0] = {
      ids: { [A]: 'env-0' }, envelopes: { [A]: Date.now() + DAY },
      sendGate: new Promise<void>((r) => { release = r; }),
      approve: () => { st.ids = { [A]: 'env-1' }; st.envelopes = { [A]: Date.now() + DAY }; return { envelope_id: 'env-1' }; },
      ...extra,
    };
    const host = touchHost(st);
    start();
    await waitFor(() => expect(mount.querySelector('[data-gate] + button, .primary')).not.toBeNull());
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
    await waitFor(() => expect(mount.querySelector('[data-send]')?.textContent).toMatch(/^Send/));
    const area = () => mount.querySelector<HTMLTextAreaElement>('[data-composer] textarea')!;
    area().value = 'one';
    area().dispatchEvent(new Event('input', { bubbles: true }));
    click('[data-send]');
    await waitFor(() => expect(host.sent).toEqual(['one']));
    st.envelopes = { [A]: Date.now() - 1000 };
    await waitFor(() => expect(mount.querySelector('[data-send]')?.textContent).toBe('Approve with Touch ID'), { timeout: 8000 });
    area().value = 'two';
    area().dispatchEvent(new Event('input', { bubbles: true }));
    click('[data-send]');
    await waitFor(() => expect(host.calls.filter((c) => c.cmd === 'relation_approve')).toHaveLength(1));
    await waitFor(() => expect(mount.querySelectorAll('[data-sending=""]').length).toBe(2));
    const go = async () => { st.sendGate = null; release(); await vi.advanceTimersByTimeAsync(500); };
    return { st, host, go };
  }
  const budgetReads = (host: ReturnType<typeof touchHost>) => host.calls.filter((c) => c.cmd === 'budget_status').length;

  it('a queued approve & send never goes from a budget read known to be stale', async () => {
    const { st, host, go } = await twoHandedBehindOne();
    st.budgetFail = true;
    const reads = budgetReads(host);
    await waitFor(() => expect(budgetReads(host)).toBeGreaterThan(reads), { timeout: 6000 });
    await vi.advanceTimersByTimeAsync(100);
    await go();
    expect(host.sent).toEqual(['one']);
    await waitFor(() => expect(unsentReason()).toContain('It needs Touch ID again. Press Send to ask.'));
  }, 30_000);

  it('its envelope removed and then the same one restored while queued: cancelled for good', async () => {
    const { st, host, go } = await twoHandedBehindOne();
    st.ids = {};
    let reads = budgetReads(host);
    await waitFor(() => expect(budgetReads(host)).toBeGreaterThan(reads), { timeout: 6000 });
    await vi.advanceTimersByTimeAsync(100);
    st.ids = { [A]: 'env-1' };
    reads = budgetReads(host);
    await waitFor(() => expect(budgetReads(host)).toBeGreaterThan(reads), { timeout: 6000 });
    await vi.advanceTimersByTimeAsync(100);
    await go();
    expect(host.sent).toEqual(['one']);
    await waitFor(() => expect(unsentReason()).toContain('The approval was cancelled or lapsed before it went through.'));
  }, 30_000);

  it('Touch ID approvals off and on again on this Mac while queued: cancelled for good', async () => {
    const { st, host, go } = await twoHandedBehindOne();
    const deviceReads = () => host.calls.filter((c) => c.cmd === 'device_key_status').length;
    st.device = 'none';
    let reads = deviceReads();
    await waitFor(() => expect(deviceReads()).toBeGreaterThan(reads), { timeout: 20_000 });
    await vi.advanceTimersByTimeAsync(100);
    st.device = 'registered';
    reads = deviceReads();
    await waitFor(() => expect(deviceReads()).toBeGreaterThan(reads), { timeout: 20_000 });
    await vi.advanceTimersByTimeAsync(100);
    await go();
    expect(host.sent).toEqual(['one']);
    await waitFor(() => expect(unsentReason()).toContain('Touch ID approvals on this Mac stopped before it went through.'));
  }, 60_000);

  it('through the budget path (autopay open), leaving the chat before its turn never sends it', async () => {
    const { host, go } = await twoHandedBehindOne({ budgetPath: true });
    click(`[data-track="peer:${B}"]`);
    await go();
    expect(host.sent).toEqual(['one']);
    click(`[data-track="peer:${A}"]`);
    await waitFor(() => expect(unsentReason()).toContain('You left this chat before it was sent.'));
  }, 30_000);

  it('through the budget path, with nothing revoked, it sends once after the send ahead', async () => {
    const { host, go } = await twoHandedBehindOne({ budgetPath: true });
    await go();
    await waitFor(() => expect(host.sent).toEqual(['one', 'two']));
  }, 30_000);

  it('approvals on this Mac stop and come back while the Touch ID answer is still out: never sent', async () => {
    let answer!: () => void;
    const st: Parameters<typeof touchHost>[0] = {
      ids: {}, envelopes: {}, device: 'registered',
      approveGate: new Promise<void>((r) => { answer = r; }),
      approve: () => { st.ids = { [A]: 'env-1' }; st.envelopes = { [A]: Date.now() + DAY }; return { envelope_id: 'env-1' }; },
    };
    const host = touchHost(st);
    await pressTouch();
    await waitFor(() => expect(mount.querySelector('[data-sending="waiting"]')).not.toBeNull());
    const deviceReads = () => host.calls.filter((c) => c.cmd === 'device_key_status').length;
    st.device = 'none';
    let reads = deviceReads();
    await waitFor(() => expect(deviceReads()).toBeGreaterThan(reads), { timeout: 20_000 });
    await vi.advanceTimersByTimeAsync(100);
    st.device = 'registered';
    reads = deviceReads();
    await waitFor(() => expect(deviceReads()).toBeGreaterThan(reads), { timeout: 20_000 });
    await vi.advanceTimersByTimeAsync(100);
    // The delayed Touch ID answer arrives now, with a valid envelope: it must not bind again.
    st.approveGate = null;
    answer();
    await vi.advanceTimersByTimeAsync(3500);
    expect(host.sent).toEqual([]);
    expect(unsentReason()).toContain('Touch ID approvals on this Mac stopped before it went through.');
    expect(mount.querySelector('[data-sending]')).toBeNull();
  }, 60_000);

  it('a node grant that expires after its envelope was seen never sends, even once spending opens', async () => {
    const st = { ids: {} as Record<string, string | null>, envelopes: {} as Record<string, number>, spendOpen: false, grantUntil: undefined as number | undefined,
      approve: () => { st.ids = { [A]: 'env-1' }; st.envelopes = { [A]: Date.now() + DAY }; st.grantUntil = Date.now() + 1500; return { envelope_id: 'env-1' }; } };
    const host = touchHost(st);
    await pressTouch();
    await waitFor(() => expect(mount.querySelector('[data-sending="waiting"]')).not.toBeNull());
    await vi.advanceTimersByTimeAsync(2000);
    // The grant read now shows an expired grant; spending opens anyway.
    st.spendOpen = true;
    await waitFor(() => expect(unsentReason()).toContain('The approval was cancelled or lapsed before it went through.'), { timeout: 10_000 });
    await vi.advanceTimersByTimeAsync(3500);
    expect(host.sent).toEqual([]);
  }, 25_000);

  it('Touch ID: a node grant already expired on the first fresh read is stale: it needs Touch ID again', async () => {
    const st = { ids: {} as Record<string, string | null>, envelopes: {} as Record<string, number>, grantUntil: undefined as number | undefined,
      approve: () => { st.ids = { [A]: 'env-1' }; st.envelopes = { [A]: Date.now() + DAY }; st.grantUntil = Date.now() - 1; return { envelope_id: 'env-1' }; } };
    const host = touchHost(st);
    await pressTouch();
    await waitFor(() => expect(unsentReason()).toContain('It needs Touch ID again. Press Send to ask.'));
    await vi.advanceTimersByTimeAsync(300);
    expect(host.sent).toEqual([]);
  });

  it('Touch ID cancelled: the words stay in the box, no card, nothing sent', async () => {
    const open = { state: 'open', lapse: null, basis: 'node_grant', open_until_ms: Date.now() + 600_000, pending: null, window_ms: 600_000, granted_op: 'cd34', armed_by_request: null };
    const envelopes: Record<string, number> = {};
    const grant = (envelopes: Record<string, number>) => ({
      paused: false, waiting_for_owner: false, ceiling_msat: 500_000, max_daily_msat: 100_000_000, spent_msat: 0, unsettled_msat: 0,
      preset: 'careful', presets: [{ id: 'careful', contact_msat: 50_000, room_msat: 100_000, ceiling_msat: 500_000 }], rows: [],
      autopay: { state: 'off', open_until_ms: null, ceiling_msat: null, basis: null }, window_ms: 600_000,
      node_grant: { expires_at_ms: Date.now() + 86_400_000, budget_msat: 200_000, remaining_msat: 200_000, per_call_max_msat: 200_000, envelopes },
    });
    const { calls } = stubHost({
      device_key_status: () => ({ available: true, state: 'registered', fingerprint: '3F9A-12C4', owner_action: null, expires_at_ms: null }),
      spend_status: () => open,
      budget_status: () => grant(envelopes),
      relation_approve: () => { throw { code: 'device_cancelled', message: 'Touch ID was cancelled.' }; },
    });
    start();
    await waitFor(() => expect(mount.querySelector('[data-gate] + button, .primary')).not.toBeNull());
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
    await waitFor(() => expect(mount.querySelector('[data-send]')?.textContent).toBe('Approve with Touch ID'));
    const area = mount.querySelector<HTMLTextAreaElement>('[data-composer] textarea')!;
    area.value = 'hello Maya';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => expect(mount.querySelector('[data-send]')?.textContent).toBe('Approve with Touch ID'));
    click('[data-send]');
    await waitFor(() => expect(calls.filter((c) => c.cmd === 'relation_approve')).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(100);
    expect(mount.querySelector<HTMLTextAreaElement>('[data-composer] textarea')!.value).toBe('hello Maya');
    expect(mount.querySelector('[data-unsent]')).toBeNull();
    expect(mount.querySelector('[data-sending]')).toBeNull();
    expect(calls.some((c) => c.cmd === 'message_send')).toBe(false);
  });

  it('says Touch ID approvals are off, and why, while the node runs from a plaintext recovery phrase', async () => {
    const msg = 'Encrypt your recovery phrase to enable Touch ID approvals. On the node\'s computer: stop the node, run `konsensus seed encrypt --config <path>` once, then start it again and type the password.';
    stubHost({
      device_key_status: () => ({ available: true, state: 'off', fingerprint: null, owner_action: null, expires_at_ms: null,
        off_reason: 'seed_not_encrypted', off_message: msg }),
    });
    start();
    await waitFor(() => expect(mount.querySelector('[data-gate] + button, .primary')).not.toBeNull());
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();

    // The spend bar only points to Settings → Node, where the reason is spelled out.
    await waitFor(() => expect(mount.querySelector('[data-device-settings-hint="off"]')?.textContent).toContain('Touch ID approvals are off.'));
    click('[data-device-settings-link]');
    await waitFor(() => expect(mount.querySelector('[data-device-off="seed_not_encrypted"]')).not.toBeNull());
    expect(mount.querySelector('[data-device-off]')?.textContent).toContain('Ask whoever set up the box for help');
    expect(mount.querySelector('[data-device-off]')?.textContent).not.toContain('konsensus ');
    expect(mount.querySelector('[data-device-register]')).toBeNull();
    expect(mount.querySelector('[data-touch-approval]')).toBeNull();
  });

  it.each(['none', 'pending', 'lapsed'])('hides at-node device setup on a local node (%s)', async (state) => {
    stubHost({ device_key_status: () => ({ available: true, state, fingerprint: '3F9A', owner_action: 'konsensus device approve --op dd01', expires_at_ms: Date.now() + 600_000 }) });
    start();
    await waitFor(() => expect(mount.querySelector('[data-gate]')).not.toBeNull());
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('I understand'))!.click();
    await waitFor(() => expect(mount.querySelector('[data-spend]')).not.toBeNull());
    expect(mount.querySelector('[data-device-owner-action]')).toBeNull();
    expect(mount.querySelector('[data-device-register]')).toBeNull();
    expect(mount.textContent).not.toContain('Approve this Mac once at your node');
  });

  describe('owner approvals: this device approves other apps’ requests', () => {
    const pendingView = (op: string) => ({
      op_id: op, node: 'n', client_id: 'client-phone', client_pubkey: 'cd'.repeat(32), epoch: 4, grant_op: null,
      request: { kind: 'spend_grant', terms: { budget_msat: 500_000, per_call_max_msat: 10_000, window_secs: 600 } },
      nonce: '11'.repeat(16), expires_at: Math.floor(Date.now() / 1000) + 250, approval_message: `bitsov-approval-v1\nop=${op}`, status: 'pending', owner_action: null,
    });
    const overview = (capabilities: string[]) => () => ({ node_id: OWN, status: 'ok', version: 'api v2', connected_peers: 1, e2ee_sessions: 1, pending_deliveries: 0,
      lightning_available: true, block_height: 1, uptime_secs: 1, lightning_backend: 'ldk', chain_backend: 'esplora', read_at: Date.now(), capabilities });
    async function open(o: { remote?: boolean; capabilities?: string[]; approvals?: string }) {
      const host = stubHost({
        pairing_status: () => ({ ...paired, remote: o.remote ?? true }),
        node_overview: overview(o.capabilities ?? ['owner_device_approval_v1']),
        owner_device_keys: () => ({ device_approvals: o.approvals ?? 'enabled', owner_device_count: 2, device_keys: [] }),
        owner_approvals_pending: () => [pendingView('op-a'), pendingView('op-b')],
        owner_approval_approve: (args) => ({ ...pendingView(String(args!.opId)), status: 'consumed' }),
      });
      start();
      await waitFor(() => expect(mount.querySelector('[data-gate] + button, .primary')).not.toBeNull());
      [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
      await waitFor(() => expect(mount.querySelector('[data-profile]')).not.toBeNull());
      await vi.advanceTimersByTimeAsync(200);
      return host;
    }

    it('opens on arrival, defers without granting, and reopens from the list with the exact approval bytes', async () => {
      const { calls } = await open({});
      await waitFor(() => expect(mount.querySelector('[data-owner-approval-queue]')?.textContent).toBe('1 of 2'));
      expect(mount.querySelectorAll('[data-owner-approval-sheet]')).toHaveLength(1);
      click('[data-owner-sheet-dismiss]');
      await waitFor(() => expect(mount.querySelector('[data-owner-approval-sheet]')?.getAttribute('data-owner-approval-sheet')).toBe('op-b'));
      click('[data-owner-sheet-dismiss]');
      expect(calls.some(c => c.cmd === 'owner_approval_approve')).toBe(false);
      await waitFor(() => expect(mount.querySelector('[data-approvals-badge]')?.textContent).toBe('2'));
      click('[data-profile]');
      click('[data-open-approvals]');
      await waitFor(() => expect(mount.querySelectorAll('[data-owner-approval]')).toHaveLength(2));
      click('[data-owner-approval="op-a"] [data-approval-review]');
      await waitFor(() => expect(mount.querySelector('[data-owner-approval-sheet]')).not.toBeNull());
      expect(mount.querySelector('[data-settings-open="true"]')).toBeNull();
      click('[data-owner-sheet-approve]');
      await waitFor(() => expect(calls.some((c) => c.cmd === 'owner_approval_approve')).toBe(true));
      const call = calls.find((c) => c.cmd === 'owner_approval_approve')!;
      expect(call.args).toEqual({ opId: 'op-a', approvalMessage: 'bitsov-approval-v1\nop=op-a' });
    });

    it.each(['pending', 'keys'])('an unreadable %s read is said, never called withdrawn, and no stale Approve stays', async failedRead => {
      let fail = false;
      const host = stubHost({
        pairing_status: () => ({ ...paired, remote: true }),
        node_overview: overview(['owner_device_approval_v1']),
        owner_device_keys: () => { if (fail && failedRead === 'keys') throw { code: 'approval_forbidden', message: 'revoked' }; return { device_approvals: 'enabled', owner_device_count: 2, device_keys: [] }; },
        owner_approvals_pending: () => { if (fail) throw { code: 'approval_forbidden', message: 'revoked' }; return [pendingView('op-a')]; },
      });
      void host;
      start();
      await waitFor(() => expect(mount.querySelector('[data-gate] + button, .primary')).not.toBeNull());
      [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
      await waitFor(() => expect(mount.querySelector('[data-approvals-badge]')).not.toBeNull());
      fail = true;
      await waitFor(() => expect(mount.querySelector('[data-owner-sheet-status]')?.textContent).toContain('Your node refused'), { timeout: 15_000 });
      expect(mount.querySelector('[data-owner-approval-sheet]')).toBeNull();
      click('[data-profile]');
      click('[data-open-settings]');
      click('[data-tab="node"]');
      await waitFor(() => expect(mount.querySelector('[data-owner-approvals-error]')?.textContent).toContain('Your node refused'), { timeout: 15_000 });
      expect(mount.querySelector('[data-approval-approve]')).toBeNull();
      expect(mount.querySelector('[data-owner-approvals-empty]')).toBeNull();
      expect(mount.querySelector('[data-approvals-badge]')).toBeNull();
    }, 25_000);

    it('the very first discovery read failing in transport is said: "Couldn’t read your node’s approvals list"', async () => {
      stubHost({
        pairing_status: () => ({ ...paired, remote: true }),
        node_overview: overview(['owner_device_approval_v1']),
        owner_device_keys: () => { throw { code: 'node', message: 'connection lost' }; },
      });
      start();
      await waitFor(() => expect(mount.querySelector('[data-gate] + button, .primary')).not.toBeNull());
      [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
      await waitFor(() => expect(mount.querySelector('[data-profile]')).not.toBeNull());
      await waitFor(() => expect(mount.querySelector<HTMLButtonElement>('[data-profile]')!.disabled).toBe(false));
      click('[data-profile]');
      await waitFor(() => expect(mount.querySelector('[data-open-settings]')).not.toBeNull());
      click('[data-open-settings]');
      await waitFor(() => expect(mount.querySelector('[data-tab="node"]')).not.toBeNull());
      click('[data-tab="node"]');
      await waitFor(() => expect(mount.querySelector('[data-owner-approvals-error]')?.textContent).toContain('Couldn’t read your node’s approvals list'));
      expect(mount.querySelector('[data-owner-approvals-error]')!.textContent).not.toContain('Nothing was approved');
      expect(mount.querySelector('[data-approval-approve]')).toBeNull();
    });

    it('an approve still in flight survives Node → Body → Node: one call, no second Approve', async () => {
      let finish!: (v: unknown) => void;
      const host = stubHost({
        pairing_status: () => ({ ...paired, remote: true }),
        node_overview: overview(['owner_device_approval_v1']),
        owner_device_keys: () => ({ device_approvals: 'enabled', owner_device_count: 2, device_keys: [] }),
        owner_approvals_pending: () => [pendingView('op-a')],
        owner_approval_approve: () => new Promise((r) => { finish = r; }),
      });
      start();
      await waitFor(() => expect(mount.querySelector('[data-gate] + button, .primary')).not.toBeNull());
      [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
      await waitFor(() => expect(mount.querySelector('[data-approvals-badge]')).not.toBeNull());
      await waitFor(() => expect(mount.querySelector('[data-owner-sheet-approve]')).not.toBeNull());
      click('[data-owner-sheet-approve]');
      click('[data-owner-sheet-dismiss]');
      click('[data-profile]');
      click('[data-open-approvals]');
      await waitFor(() => expect(host.calls.filter((c) => c.cmd === 'owner_approval_approve')).toHaveLength(1));
      click('[data-tab="body"]');
      await waitFor(() => expect(mount.querySelector('[data-owner-approvals]')).toBeNull());
      click('[data-tab="node"]');
      await waitFor(() => expect(mount.querySelector('[data-approval-busy]')).not.toBeNull());
      expect(mount.querySelector<HTMLButtonElement>('[data-approval-approve]')!.disabled).toBe(true);
      mount.querySelector<HTMLButtonElement>('[data-approval-approve]')!.click();
      finish({ ...pendingView('op-a'), status: 'consumed' });
      await waitFor(() => expect(mount.querySelector('[data-approval-result="ok"]')).not.toBeNull());
      expect(host.calls.filter((c) => c.cmd === 'owner_approval_approve')).toHaveLength(1);
    });

    it('an outcome survives Node → Body → Node until Dismiss', async () => {
      stubHost({
        pairing_status: () => ({ ...paired, remote: true }),
        node_overview: overview(['owner_device_approval_v1']),
        owner_device_keys: () => ({ device_approvals: 'enabled', owner_device_count: 2, device_keys: [] }),
        owner_approvals_pending: () => [pendingView('op-a')],
        owner_approval_approve: () => { throw { code: 'approval_budget_exceeded', message: 'over', remaining_msat: 2000 }; },
      });
      start();
      await waitFor(() => expect(mount.querySelector('[data-gate] + button, .primary')).not.toBeNull());
      [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
      await waitFor(() => expect(mount.querySelector('[data-approvals-badge]')).not.toBeNull());
      await waitFor(() => expect(mount.querySelector('[data-owner-sheet-approve]')).not.toBeNull());
      click('[data-owner-sheet-approve]');
      await waitFor(() => expect(mount.querySelector('[data-owner-approval-sheet] [role="alert"]')).not.toBeNull());
      click('[data-owner-sheet-dismiss]');
      click('[data-profile]');
      click('[data-open-approvals]');
      await waitFor(() => expect(mount.querySelector('[data-approval-result="refused"]')?.textContent).toContain('(2 sats left)'));
      click('[data-tab="body"]');
      await waitFor(() => expect(mount.querySelector('[data-owner-approvals]')).toBeNull());
      click('[data-tab="node"]');
      await waitFor(() => expect(mount.querySelector('[data-approval-result="refused"]')?.textContent).toContain('(2 sats left)'));
    });

    it.each(['read_only_pairing', 'ai_pairing', 'seed_password_not_typed'])('a pairing the node does not let approve (%s) sees no list, badge or Approve', async (reason) => {
      const { calls } = await open({ approvals: reason });
      await waitFor(() => expect(calls.some((c) => c.cmd === 'owner_device_keys')).toBe(true));
      expect(calls.some((c) => c.cmd === 'owner_approvals_pending')).toBe(false);
      expect(mount.querySelector('[data-approvals-badge]')).toBeNull();
      click('[data-profile]');
      expect(mount.querySelector('[data-open-approvals]')).toBeNull();
      expect(mount.querySelector('[data-approval-approve]')).toBeNull();
    });

    it('an older node (no capability) or a node on this Mac: nothing is asked, today’s screens stay', async () => {
      const older = await open({ capabilities: [] });
      expect(older.calls.some((c) => c.cmd.startsWith('owner_'))).toBe(false);
      expect(mount.querySelector('[data-approvals-badge]')).toBeNull();
      dispose?.(); mount?.remove(); vi.unstubAllGlobals();
      const local = await open({ remote: false });
      expect(local.calls.some((c) => c.cmd.startsWith('owner_'))).toBe(false);
      expect(mount.querySelector('[data-owner-approvals]')).toBeNull();
    });
  });

  describe('Touch ID first where spending stalls on a node command', () => {
    const pendingSpend = () => ({ state: 'pending', lapse: null, basis: null, open_until_ms: null, window_ms: 600_000,
      pending: { op_id: 'ab01', expires_at_ms: Date.now() + 600_000, owner_action: 'konsensus grant --op ab01', owner_can_grant: true } });
    const none = { available: true, state: 'none', fingerprint: null, owner_action: null, expires_at_ms: null };
    async function open(remote: boolean, device: object, capabilities?: string[]) {
      const host = stubHost({
        pairing_status: () => ({ ...paired, remote }),
        device_key_status: () => device,
        spend_status: pendingSpend,
        ...(capabilities ? { node_overview: () => ({ node_id: OWN, status: 'ok', version: 'api v2', connected_peers: 1, e2ee_sessions: 1, pending_deliveries: 0,
          lightning_available: true, block_height: 1, uptime_secs: 1, lightning_backend: 'ldk', chain_backend: 'esplora', read_at: Date.now(), capabilities }) } : {}),
      });
      start();
      await waitFor(() => expect(mount.querySelector('[data-gate] + button, .primary')).not.toBeNull());
      [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
      await waitFor(() => expect(mount.querySelector('[data-owner-action]')).not.toBeNull());
      return host;
    }

    it('a remote node with Touch ID not set up: the offer leads, the command waits under Other ways, the draft stays', async () => {
      const { calls } = await open(true, none);
      const offer = mount.querySelector('[data-touch-id-first]')!;
      expect(offer).not.toBeNull();
      expect(offer.textContent).toContain('Approve on this Mac with Touch ID');
      expect(offer.textContent).toContain('your node’s owner approves this Mac one time');
      const other = offer.querySelector<HTMLDetailsElement>('details[data-other-ways]')!;
      expect(other.open).toBe(false);
      expect(other.querySelector('[data-owner-action]')?.textContent).toBe('konsensus grant --op ab01');
      // Not said twice in the spend bar.
      expect(mount.querySelector('[data-device-settings-hint]')).toBeNull();
      // What is true here stays in view: the draft waits for a press, and the request can be cancelled.
      expect(offer.querySelector('[data-touch-id-stays-text="spend"]')?.textContent).toContain('Nothing is sent until you press Send after approval');
      expect(offer.querySelector('[data-touch-id-stays] [data-spend-cancel-visible]')).not.toBeNull();
      const area = mount.querySelector<HTMLTextAreaElement>('[data-composer] textarea')!;
      area.value = 'kept draft'; area.dispatchEvent(new Event('input', { bubbles: true }));
      click('[data-touch-id-setup]');
      await waitFor(() => expect(mount.querySelector('[data-tab="devices"]')?.getAttribute('aria-selected')).toBe('true'));
      expect(mount.querySelector('[data-device-register]')).not.toBeNull();
      expect(mount.querySelector<HTMLTextAreaElement>('[data-composer] textarea')!.value).toBe('kept draft');
      expect(calls.some((c) => c.cmd === 'message_send' || c.cmd === 'device_key_register')).toBe(false);
      click('[data-spend-cancel-visible]');
      await waitFor(() => expect(calls.some((c) => c.cmd === 'spend_cancel')).toBe(true));
    });

    it('on the invite page the offer says what is true for invites, not "press Send"', async () => {
      await open(true, none);
      click('[data-track="new"]');
      // The invite page has several actions (invites, starter bitcoin): the neutral line is true for all.
      await waitFor(() => expect(mount.querySelector('[data-touch-id-stays-text="spend"]')?.textContent).toContain('Nothing is paid until you press it again after approval'));
      expect(mount.querySelector('[data-touch-id-stays-text="spend"]')!.textContent).not.toMatch(/press Send|Create invite/);
    });

    it('in Pay mode the composer does not promise "press Send": the neutral line shows', async () => {
      await open(true, none);
      click('[data-composer-mode="pay"]');
      await waitFor(() => expect(mount.querySelector('[data-touch-id-stays-text="spend"]')?.textContent).toContain('Nothing is paid until you press it again after approval'));
      expect(mount.querySelector('[data-touch-id-stays-text="spend"]')!.textContent).not.toMatch(/press Send/);
    });

    it('promises no command at the node only when the node says it can (owner_device_approval_v1)', async () => {
      await open(true, none);
      const today = mount.querySelector('[data-touch-id-first]')!.textContent!;
      expect(today).toContain('Your box does not yet accept Touch ID approvals, so for now the person who set it up approves at the box');
      expect(today).not.toContain('with nothing to do at the box');
      dispose?.(); mount?.remove(); vi.unstubAllGlobals();
      await open(true, none, ['owner_device_approval_v1']);
      await waitFor(() => expect(mount.querySelector('[data-touch-id-first]')!.textContent).toContain('one Touch ID tap approves a contact here, with nothing to do at the box'));
    });

    it('a lapsed setup says "again", not "one time"', async () => {
      await open(true, { ...none, state: 'lapsed' });
      const offer = mount.querySelector('[data-touch-id-first]')!;
      expect(offer.textContent).toContain('Your last setup request lapsed. Set it up again');
      expect(offer.textContent).not.toContain('one time');
    });

    it.each(['pending', 'unavailable', 'off'])('a Mac whose setup is %s keeps today’s card', async (state) => {
      await open(true, { ...none, state, available: state !== 'unavailable' });
      expect(mount.querySelector('[data-touch-id-first]')).toBeNull();
      expect(mount.querySelector('details[data-other-ways]')).toBeNull();
    });

    it('a local node (no registration there) keeps the command as it was', async () => {
      await open(false, none);
      expect(mount.querySelector('[data-touch-id-first]')).toBeNull();
      expect(mount.querySelector('details[data-other-ways]')).toBeNull();
    });

    it('a Mac already registered, or one setting up, is not offered it again', async () => {
      await open(true, { ...none, state: 'registered', fingerprint: '3F9A-12C4' });
      expect(mount.querySelector('[data-touch-id-first]')).toBeNull();
    });
  });

  it('shows plain owner approval guidance for this Mac, and a pending request can be cancelled', async () => {
    const cmd = 'konsensus device approve --op dd01 --config node.toml';
    const { calls } = stubHost({
      pairing_status: () => ({ ...paired, remote: true }),
      device_key_status: () => ({ available: true, state: 'pending', fingerprint: '3F9A-12C4', owner_action: cmd, expires_at_ms: Date.now() + 600_000 }),
      device_key_cancel: () => ({ available: true, state: 'none', fingerprint: null, owner_action: null, expires_at_ms: null }),
      spend_status: () => ({ state: 'pending', lapse: null, basis: null, open_until_ms: null, window_ms: 600_000,
        pending: { op_id: 'ab01', expires_at_ms: Date.now() + 600_000, owner_action: 'konsensus grant --op ab01', owner_can_grant: true } }),
      spend_cancel: () => ({ state: 'locked', lapse: null, basis: null, open_until_ms: null, pending: null, window_ms: 600_000 }),
    });
    start();
    await waitFor(() => expect(mount.querySelector('[data-gate] + button, .primary')).not.toBeNull());
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();

    // The spend bar says it is waiting and links to Settings → Node, where the owner step lives.
    await waitFor(() => expect(mount.querySelector('[data-device-settings-hint="pending"]')).not.toBeNull());
    expect(mount.querySelector('[data-spend] [data-device-owner-action]')).toBeNull();
    click('[data-device-settings-link]');
    await waitFor(() => expect(mount.querySelector('[data-pending-approval]')?.textContent).toContain('Ask whoever set up the box to help approve this device'));
    expect(mount.querySelector('[data-pending-approval]')?.textContent).not.toContain('konsensus ');
    expect(mount.querySelector('[data-device-fingerprint]')?.textContent).toBe('3F9A-12C4');
    click('[data-device-cancel]');
    await waitFor(() => expect(calls.some((c) => c.cmd === 'device_key_cancel')).toBe(true));

    await waitFor(() => expect(mount.querySelector('[data-spend-cancel]')).not.toBeNull());
    click('[data-spend-cancel]');
    await waitFor(() => expect(calls.some((c) => c.cmd === 'spend_cancel')).toBe(true));
  });

  it('opens the shell after the gate: tracks, live stream, cost before send, nothing spent unasked', async () => {
    const { calls, emitLive } = stubHost();
    start();
    await waitFor(() => expect(mount.querySelector('[data-gate] + button, .primary')).not.toBeNull());
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();

    // Rail lists the node's peers and rooms; the first connected peer opens.
    await waitFor(() => expect(mount.querySelector(`[data-track="peer:${A}"]`)?.getAttribute('aria-current')).toBe('true'));
    expect(mount.querySelector(`[data-track="room:${ROOM}"]`)?.textContent).toContain('Mexico build');
    await waitFor(() => expect(mount.querySelector('[data-stream]')?.textContent).toContain('hello from Maya'));

    // The composer shows Maya's advertised price before anything can be sent.
    await waitFor(() => expect(mount.querySelector('[data-cost-msat]')?.getAttribute('data-cost-msat')).toBe('2000'));
    expect(mount.querySelector('[data-cost]')?.textContent).toContain('Maya’s price');
    // Until the owner approves, the one action on screen is the approval itself.
    await waitFor(() => expect(mount.querySelector('[data-send]')?.textContent).toBe('Send'));
    expect(mount.querySelector('[data-spend="locked"]')?.textContent).toContain('never saved');

    // A live message for the open track lands in the stream; one for another peer counts unread.
    emitLive({ type: 'link', state: 'open', detail: null });
    emitLive({ type: 'message', room_id: null, message: { id: 'm2', kind: 0, sender: A, recipient: OWN, timestamp: 1_725_000_100_000, plaintext: 'live one', payment_amount_msat: 2000 } });
    emitLive({ type: 'message', room_id: null, message: { id: 'm3', kind: 0, sender: B, recipient: OWN, timestamp: 1_725_000_200_000, plaintext: 'from B', payment_amount_msat: 1000 } });
    await waitFor(() => expect(mount.querySelector('[data-stream]')?.textContent).toContain('live one'));
    await waitFor(() => expect(mount.querySelector(`[data-track="peer:${B}"] .badge`)?.textContent).toBe('1'));
    expect(mount.querySelector('[data-stream]')?.textContent).not.toContain('from B');

    // A room costs each member's own price, summed; an unconnected member blocks the send.
    click(`[data-track="room:${ROOM}"]`);
    await waitFor(() => expect(mount.querySelector('[data-cost-msat]')?.getAttribute('data-cost-msat')).toBe('3000'));
    expect(mount.querySelector('[data-cost]')?.textContent).toContain('2 members, each paid their own price; 1 estimated from yours');
    expect(mount.querySelector('[data-room-blocked]')?.textContent).toContain('Not every member is a connected peer');

    // Wallet: the one combined balance, never split into invented figures.
    click('[data-tab="wallet"]');
    await waitFor(() => expect(mount.querySelector('[data-balance]')?.textContent).toContain('52\u2009500'));
    expect(mount.querySelector('[data-panel="wallet"]')?.textContent).toContain('one figure');

    // Only reads and the spend-window status were used; nothing that spends or edits.
    const used = new Set(calls.map((c) => c.cmd));
    for (const cmd of used) {
      if (cmd === 'ai_read') {
        for (const call of calls.filter(c => c.cmd === cmd)) {
          expect(Object.keys(call.args!).sort()).toEqual(['assistant', 'watch']);
          expect(Object.keys(call.args!.watch as object).sort()).toEqual(['revision', 'sample']);
        }
        continue;
      }
      expect(cmd).toMatch(/^(node_status|pairing_status|trust_acknowledge|node_overview|peers_list|rooms_list|room_members|messages_list|price_quote|payments_overview|fund_state|spend_status|device_key_status|budget_status|file_price|call_quote|room_quote|op_list|live_link|plugin:event\|(un)?listen)$/);
    }
    expect(calls.find((c) => c.cmd === 'plugin:event|listen')?.args?.event).toBe('node-live');

    // Regression: each 1.5 s host poll hands App a fresh status object. That must
    // not tear down and re-register the live listener (it once did, every poll).
    const polls = () => calls.filter((c) => c.cmd === 'node_status').length;
    const seen = polls();
    await waitFor(() => expect(polls()).toBeGreaterThanOrEqual(seen + 2), { timeout: 4000 });
    expect(calls.filter((c) => c.cmd === 'plugin:event|listen')).toHaveLength(1);
    expect(calls.filter((c) => c.cmd === 'plugin:event|unlisten')).toHaveLength(0);
  }, 10_000);

  it('shows the link as live when the socket opened before the shell subscribed', async () => {
    const { calls, host } = stubHost();
    host.link = 'open';
    start();
    await waitFor(() => expect(mount.querySelector('[data-gate] + button, .primary')).not.toBeNull());
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();

    // No link event is pushed by the test: the state comes only from the replay
    // the shell asks for after subscribing.
    await waitFor(() => expect(mount.querySelector('.node-pill .what')?.textContent).toBe('Connected to your node'));
    expect(mount.querySelector('[data-pill]')?.getAttribute('data-pill')).toBe('ok');
    const listenAt = calls.findIndex((c) => c.cmd === 'plugin:event|listen');
    const replayAt = calls.findIndex((c) => c.cmd === 'live_link');
    expect(listenAt).toBeGreaterThanOrEqual(0);
    expect(replayAt).toBeGreaterThan(listenAt);
    click('[data-tab="node"]');
    await waitFor(() => expect(mount.querySelector('[data-link]')?.getAttribute('data-link')).toBe('open'));
  });

  it.each([[[], '[data-porch-node-off]'], [['porch_quote_v1'], '[data-porch-peers-failed]']] as const)('porch answers once the overview has, even when the contacts read failed (capabilities %j)', async (capabilities, shown) => {
    stubHost({
      node_overview: () => ({ node_id: OWN, status: 'ok', version: 'api v2', connected_peers: 0, e2ee_sessions: 0, pending_deliveries: 0,
        lightning_available: true, block_height: 1, uptime_secs: 1, lightning_backend: 'ldk', chain_backend: 'esplora', read_at: Date.now(), capabilities: [...capabilities] }),
      peers_list: () => { throw { code: 'node', message: 'contacts read failed' }; },
    });
    start();
    await waitFor(() => expect([...mount.querySelectorAll('button')].some((b) => b.textContent?.includes('I understand'))).toBe(true));
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
    await waitFor(() => expect(mount.querySelector('[data-track="porch"]')).not.toBeNull());
    click('[data-track="porch"]');
    await waitFor(() => expect(mount.querySelector(shown)).not.toBeNull());
    expect(mount.querySelector('[data-porch-waiting]')).toBeNull();
    expect(mount.querySelector('[data-porch-none]')).toBeNull();
  });

  it.each([
    ['en', 'We could not load your contacts.'],
    ['da', 'Vi kunne ikke hente dine kontakter.'],
  ] as const)('warns beside cached porch contacts after a failed refresh until recovery (%s)', async (lang, warning) => {
    const cached = { node_id: A, addr: '', label: 'Cached contact', connected: true, fingerprint: 'aaaaaaaa', porch: true };
    const added = { ...cached, node_id: B, label: 'New contact', fingerprint: 'bbbbbbbb' };
    let failed = false;
    let recovery: Promise<typeof cached[]> | null = null;
    stubHost({
      node_overview: () => ({ node_id: OWN, status: 'ok', version: 'api v2', connected_peers: 1, e2ee_sessions: 0, pending_deliveries: 0,
        lightning_available: true, block_height: 1, uptime_secs: 1, lightning_backend: 'ldk', chain_backend: 'esplora', read_at: Date.now(), capabilities: ['porch_quote_v1'] }),
      peers_list: () => {
        if (failed) throw { code: 'node', message: 'contacts refresh failed' };
        return recovery ?? [cached];
      },
      porch_cards: () => [],
      porch_quote: () => ({ principal_msat: 1000, max_routing_fee_msat: 0, total_msat: 1000 }),
    });
    await openChat();
    setLanguagePref(lang);
    click('[data-track="porch"]');
    await waitFor(() => expect(mount.querySelector(`[data-porch-peer="${A}"]`)).not.toBeNull());
    expect(mount.querySelector('[data-porch-peers-failed]')).toBeNull();

    failed = true;
    await vi.advanceTimersByTimeAsync(15_000);
    const notice = mount.querySelector('[data-porch-peers-failed]');
    expect(notice?.textContent).toBe(warning);
    expect(notice?.getAttribute('role')).toBe('status');
    expect(mount.querySelectorAll('[data-porch-peers-failed]')).toHaveLength(1);
    expect(mount.querySelector(`[data-porch-peer="${A}"]`)).not.toBeNull();
    expect(mount.querySelector('[data-porch-none]')).toBeNull();

    let finishRecovery!: (peers: typeof cached[]) => void;
    recovery = new Promise((resolve) => { finishRecovery = resolve; });
    failed = false;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mount.querySelector('[data-porch-peers-failed]')?.textContent).toBe(warning);
    expect(mount.querySelector(`[data-porch-peer="${A}"]`)).not.toBeNull();

    finishRecovery([cached, added]);
    await waitFor(() => expect(mount.querySelector(`[data-porch-peer="${B}"]`)).not.toBeNull());
    expect(mount.querySelector(`[data-porch-peer="${A}"]`)).not.toBeNull();
    expect(mount.querySelector('[data-porch-peers-failed]')).toBeNull();
    expect(mount.querySelector('[data-porch-none]')).toBeNull();
  });

  it('runs on sample data with no host at all', async () => {
    start();
    await waitFor(() => expect(mount.querySelector('[data-sample]')).not.toBeNull());
    await waitFor(() => expect(mount.querySelector('[data-stream]')?.textContent).toContain('Morning.'));
    expect(mount.querySelector('[data-mode="sample"]')).not.toBeNull();
    // The first Send opens the budget sheet.
    await waitFor(() => expect(mount.querySelector('[data-send]')?.textContent).toBe('Send'));
    click('[data-track="new"]');
    await waitFor(() => expect(mount.querySelector('[data-new-track]')?.textContent).toContain('Share your node id'));
    expect(mount.querySelector('[data-new-track]')?.textContent).toContain('Browse');
    expect(mount.querySelector('[data-intro-mine]')).toBeNull();
    expect(mount.querySelector('[data-intro-open]')).toBeNull();
    click('[data-track="ai"]');
    await waitFor(() => expect(mount.querySelector('[data-ai-track]')?.textContent).toContain('Ask about your own node'));
    expect(mount.querySelector('[data-ai-policy]')?.textContent).toContain('Nothing leaves this computer');
  });
});
