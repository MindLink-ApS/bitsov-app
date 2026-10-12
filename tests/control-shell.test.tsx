import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
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
    setShowLegacyRoomsUi(true);
  });

  afterEach(() => {
    setShowLegacyRoomsUi(false);
    dispose?.();
    dispose = undefined;
    mount?.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const start = () => {
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => <App />, mount);
  };
  const click = (sel: string) => mount.querySelector<HTMLElement>(sel)!.click();

  async function openChat() {
    start();
    await vi.waitFor(() => expect([...mount.querySelectorAll('button')].some((b) => b.textContent?.includes('I understand'))).toBe(true));
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
    await vi.waitFor(() => expect(mount.querySelector('[data-message="m1"]')).not.toBeNull());
  }

  it.each([false, true])('animates new ids once, keeping rows through echoes, refreshes and navigation (reduced motion: %s)', async (reduced) => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduced && query === '(prefers-reduced-motion: reduce)' }));
    const { emitLive } = stubHost();
    await openChat();
    const history = mount.querySelector('[data-message="m1"]')!;
    expect(history.classList.contains('fresh')).toBe(false);
    const message = { id: 'new', kind: 0, sender: A, recipient: OWN, timestamp: Date.now(), plaintext: 'just arrived', payment_amount_msat: 2000 };
    emitLive({ type: 'message', room_id: null, message });
    await vi.waitFor(() => expect(mount.querySelector('[data-message="new"]')).not.toBeNull());
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
    await vi.waitFor(() => expect(mount.querySelector('[data-message="new"]')).not.toBeNull());
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
    await vi.waitFor(() => expect(mount.querySelector('[data-gate="g6-local-trust"]')).not.toBeNull());
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
    await vi.waitFor(() => expect(mount.textContent).toContain('I understand'));
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
    await vi.waitFor(() => expect(mount.querySelector('[data-spend-ask-again]')).not.toBeNull());
    click('[data-spend-ask-again]');
    await vi.waitFor(() => expect(mount.textContent).toContain('/pair/elevation-request failed (404)'));
    await new Promise((resolve) => setTimeout(resolve, 3200));
    expect(mount.textContent).toContain('/pair/elevation-request failed (404)');
    reject = false;
    click('[data-spend-ask-again]');
    await vi.waitFor(() => expect(mount.textContent).not.toContain('/pair/elevation-request failed (404)'));
  });

  it('relaunches into the real shell with rc8 rooms after accepting trust for this node', async () => {
    stubHost({ node_overview: () => ({ node_id: OWN, capabilities: ['room_binding_v1'], money_ready: true }) });
    start();
    await vi.waitFor(() => expect(mount.textContent).toContain('I understand'));
    expect(mount.querySelector('.rail')?.textContent).not.toContain('does not support rooms');
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
    await vi.waitFor(() => expect(mount.querySelector('[data-first-run]')).toBeNull());
    dispose?.(); mount.remove();
    start();
    await vi.waitFor(() => expect(mount.querySelector('[data-first-run]')).toBeNull());
    await vi.waitFor(() => expect(mount.querySelector('.rail')?.textContent).toContain('New room'));
    expect(mount.querySelector('.rail')?.textContent).not.toContain('Available after setup');
  });

  it('keeps the acknowledged shell mounted through a transient node-status failure', async () => {
    let failed = false;
    stubHost({ node_status: () => { if (failed) throw new Error('temporarily unavailable'); return { ready: true, node_id: OWN, error: null }; } });
    start();
    await vi.waitFor(() => expect(mount.textContent).toContain('I understand'));
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
    await vi.waitFor(() => expect(mount.querySelector('[data-first-run]')).toBeNull());
    const shell = mount.querySelector('.cc');
    failed = true;
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(mount.querySelector('.cc')).toBe(shell);
    failed = false;
    await new Promise((resolve) => setTimeout(resolve, 1600));
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
    await vi.waitFor(() => expect(mount.querySelector('[data-gate] + button, .primary')).not.toBeNull());
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();

    await vi.waitFor(() => expect(mount.querySelector('[data-spend-lapse="lost"]')).not.toBeNull());
    expect(mount.querySelector('[data-spend-lapse]')?.textContent).toContain('restarted');
    expect(calls.some((c) => c.cmd === 'spend_request')).toBe(false);

    // A double click asks once.
    click('[data-spend-ask-again]');
    click('[data-spend-ask-again]');
    await vi.waitFor(() => expect(mount.querySelector('[data-approval="pending"] [data-owner-action]')?.textContent).toBe(cmd));
    expect(mount.querySelector('[data-approval="pending"]')?.textContent).toContain('short code');
    expect(calls.filter((c) => c.cmd === 'spend_request')).toHaveLength(1);
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
    await vi.waitFor(() => expect(mount.querySelector('[data-gate] + button, .primary')).not.toBeNull());
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();

    await vi.waitFor(() => expect(mount.querySelector('[data-touch-approval]')).not.toBeNull());
    const box = mount.querySelector('[data-touch-approval]')!.textContent!;
    expect(box).toContain('200 sats a day');
    expect(box).toContain('at most 2 sats per message');
    expect(mount.querySelector('[data-touch-peer]')?.textContent).toBe(`${A.slice(0, 8)}…${A.slice(-8)}`);
    // Petname plus the short key, visible on the line; never the node's claimed label.
    expect(box).toContain(`Approve Maya (node ${A.slice(0, 8)}…${A.slice(-8)}) with Touch ID.`);
    expect(box).not.toContain('Bank Support');
    // Above the capsule, so the terms read before Send.
    const line = mount.querySelector('[data-touch-approval]')!;
    const bar = mount.querySelector('[data-composer-bar]')!;
    expect(line.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await vi.waitFor(() => expect(mount.querySelector('[data-send]')?.textContent).toBe('Approve with Touch ID'));
    expect(calls.some((c) => c.cmd === 'relation_approve' || c.cmd === 'spend_request')).toBe(false);

    // Send in the composer is the Touch ID tap; the line above it only states the terms.
    expect(mount.querySelector('[data-touch-approval] button')).toBeNull();
    click('[data-send]');
    await vi.waitFor(() => expect(calls.filter((c) => c.cmd === 'relation_approve')).toHaveLength(1));
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
    await vi.waitFor(() => expect(mount.querySelector('[data-gate] + button, .primary')).not.toBeNull());
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();

    await vi.waitFor(() => expect(mount.querySelector('[data-send]')?.textContent).toBe('Approve with Touch ID'));
    expect(mount.querySelector('[data-touch-approval]')).not.toBeNull();
    click('[data-send]');
    await vi.waitFor(() => expect(calls.filter((c) => c.cmd === 'relation_approve')).toHaveLength(1));
    expect(calls.find((c) => c.cmd === 'relation_approve')!.args).toMatchObject({ peer: A });
    expect(calls.some((c) => c.cmd === 'message_send')).toBe(false);
    // With the envelope in place, Send is back.
    await vi.waitFor(() => expect(mount.querySelector('[data-send]')?.textContent).toMatch(/^Send/));
    expect(mount.querySelector('[data-touch-approval]')).toBeNull();
  });

  it('says Touch ID approvals are off, and why, while the node runs from a plaintext recovery phrase', async () => {
    const msg = 'Encrypt your recovery phrase to enable Touch ID approvals. On the node\'s computer: stop the node, run `konsensus seed encrypt --config <path>` once, then start it again and type the password.';
    stubHost({
      device_key_status: () => ({ available: true, state: 'off', fingerprint: null, owner_action: null, expires_at_ms: null,
        off_reason: 'seed_not_encrypted', off_message: msg }),
    });
    start();
    await vi.waitFor(() => expect(mount.querySelector('[data-gate] + button, .primary')).not.toBeNull());
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();

    // The spend bar only points to Settings → Node, where the reason is spelled out.
    await vi.waitFor(() => expect(mount.querySelector('[data-device-settings-hint="off"]')?.textContent).toContain('Touch ID approvals are off.'));
    click('[data-device-settings-link]');
    await vi.waitFor(() => expect(mount.querySelector('[data-panel="node"] [data-device-off="seed_not_encrypted"]')).not.toBeNull());
    expect(mount.querySelector('[data-device-off]')?.textContent).toContain('Encrypt your recovery phrase to enable Touch ID approvals');
    expect(mount.querySelector('[data-device-register]')).toBeNull();
    expect(mount.querySelector('[data-touch-approval]')).toBeNull();
  });

  it.each(['none', 'pending', 'lapsed'])('hides at-node device setup on a local node (%s)', async (state) => {
    stubHost({ device_key_status: () => ({ available: true, state, fingerprint: '3F9A', owner_action: 'konsensus device approve --op dd01', expires_at_ms: Date.now() + 600_000 }) });
    start();
    await vi.waitFor(() => expect(mount.querySelector('[data-gate]')).not.toBeNull());
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('I understand'))!.click();
    await vi.waitFor(() => expect(mount.querySelector('[data-spend]')).not.toBeNull());
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
      await vi.waitFor(() => expect(mount.querySelector('[data-gate] + button, .primary')).not.toBeNull());
      [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
      await vi.waitFor(() => expect(mount.querySelector('[data-profile]')).not.toBeNull());
      await new Promise((r) => setTimeout(r, 200));
      return host;
    }

    it('shows a badge and an entry; the list approves with the exact message shown', async () => {
      const { calls } = await open({});
      await vi.waitFor(() => expect(mount.querySelector('[data-approvals-badge]')?.textContent).toBe('2'));
      click('[data-profile]');
      await vi.waitFor(() => expect(mount.querySelector('[data-approvals-count]')?.textContent).toBe('2'));
      click('[data-open-approvals]');
      await vi.waitFor(() => expect(mount.querySelectorAll('[data-owner-approval]')).toHaveLength(2));
      mount.querySelector<HTMLButtonElement>('[data-owner-approval="op-a"] [data-approval-approve]')!.click();
      await vi.waitFor(() => expect(calls.some((c) => c.cmd === 'owner_approval_approve')).toBe(true));
      const call = calls.find((c) => c.cmd === 'owner_approval_approve')!;
      expect(call.args).toEqual({ opId: 'op-a', approvalMessage: 'bitsov-approval-v1\nop=op-a' });
    });

    it.each(['read_only_pairing', 'ai_pairing', 'seed_password_not_typed'])('a pairing the node does not let approve (%s) sees no list, badge or Approve', async (reason) => {
      const { calls } = await open({ approvals: reason });
      await vi.waitFor(() => expect(calls.some((c) => c.cmd === 'owner_device_keys')).toBe(true));
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
      await vi.waitFor(() => expect(mount.querySelector('[data-gate] + button, .primary')).not.toBeNull());
      [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
      await vi.waitFor(() => expect(mount.querySelector('[data-owner-action]')).not.toBeNull());
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
      await vi.waitFor(() => expect(mount.querySelector('[data-panel="node"]')).not.toBeNull());
      expect(mount.querySelector<HTMLTextAreaElement>('[data-composer] textarea')!.value).toBe('kept draft');
      expect(calls.some((c) => c.cmd === 'message_send' || c.cmd === 'device_key_register')).toBe(false);
      click('[data-spend-cancel-visible]');
      await vi.waitFor(() => expect(calls.some((c) => c.cmd === 'spend_cancel')).toBe(true));
    });

    it('on the invite page the offer says what is true for invites, not "press Send"', async () => {
      await open(true, none);
      click('[data-track="new"]');
      // The invite page has several actions (invites, starter bitcoin): the neutral line is true for all.
      await vi.waitFor(() => expect(mount.querySelector('[data-touch-id-stays-text="spend"]')?.textContent).toContain('Nothing is paid until you press it again after approval'));
      expect(mount.querySelector('[data-touch-id-stays-text="spend"]')!.textContent).not.toMatch(/press Send|Create invite/);
    });

    it('in Pay mode the composer does not promise "press Send": the neutral line shows', async () => {
      await open(true, none);
      click('[data-composer-mode="pay"]');
      await vi.waitFor(() => expect(mount.querySelector('[data-touch-id-stays-text="spend"]')?.textContent).toContain('Nothing is paid until you press it again after approval'));
      expect(mount.querySelector('[data-touch-id-stays-text="spend"]')!.textContent).not.toMatch(/press Send/);
    });

    it('promises no command at the node only when the node says it can (owner_device_approval_v1)', async () => {
      await open(true, none);
      const today = mount.querySelector('[data-touch-id-first]')!.textContent!;
      expect(today).toContain('Your node does not yet accept Touch ID approvals in place of its command');
      expect(today).not.toContain('without a command at the node');
      dispose?.(); mount?.remove(); vi.unstubAllGlobals();
      await open(true, none, ['owner_device_approval_v1']);
      await vi.waitFor(() => expect(mount.querySelector('[data-touch-id-first]')!.textContent).toContain('one Touch ID tap approves a contact here, without a command at the node'));
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

  it('shows the one-time owner command for this Mac, and a pending request can be cancelled', async () => {
    const cmd = 'konsensus device approve --op dd01 --config /Users/owner/node/konsensus.toml';
    const { calls } = stubHost({
      pairing_status: () => ({ ...paired, remote: true }),
      device_key_status: () => ({ available: true, state: 'pending', fingerprint: '3F9A-12C4', owner_action: cmd, expires_at_ms: Date.now() + 600_000 }),
      device_key_cancel: () => ({ available: true, state: 'none', fingerprint: null, owner_action: null, expires_at_ms: null }),
      spend_status: () => ({ state: 'pending', lapse: null, basis: null, open_until_ms: null, window_ms: 600_000,
        pending: { op_id: 'ab01', expires_at_ms: Date.now() + 600_000, owner_action: 'konsensus grant --op ab01', owner_can_grant: true } }),
      spend_cancel: () => ({ state: 'locked', lapse: null, basis: null, open_until_ms: null, pending: null, window_ms: 600_000 }),
    });
    start();
    await vi.waitFor(() => expect(mount.querySelector('[data-gate] + button, .primary')).not.toBeNull());
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();

    // The spend bar says it is waiting and links to Settings → Node, where the owner step lives.
    await vi.waitFor(() => expect(mount.querySelector('[data-device-settings-hint="pending"]')).not.toBeNull());
    expect(mount.querySelector('[data-spend] [data-device-owner-action]')).toBeNull();
    click('[data-device-settings-link]');
    await vi.waitFor(() => expect(mount.querySelector('[data-panel="node"] [data-device-owner-action]')?.textContent).toBe(cmd));
    expect(mount.querySelector('[data-device-fingerprint]')?.textContent).toBe('3F9A-12C4');
    click('[data-device-cancel]');
    await vi.waitFor(() => expect(calls.some((c) => c.cmd === 'device_key_cancel')).toBe(true));

    await vi.waitFor(() => expect(mount.querySelector('[data-spend-cancel]')).not.toBeNull());
    click('[data-spend-cancel]');
    await vi.waitFor(() => expect(calls.some((c) => c.cmd === 'spend_cancel')).toBe(true));
  });

  it('opens the shell after the gate: tracks, live stream, cost before send, nothing spent unasked', async () => {
    const { calls, emitLive } = stubHost();
    start();
    await vi.waitFor(() => expect(mount.querySelector('[data-gate] + button, .primary')).not.toBeNull());
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();

    // Rail lists the node's peers and rooms; the first connected peer opens.
    await vi.waitFor(() => expect(mount.querySelector(`[data-track="peer:${A}"]`)?.getAttribute('aria-current')).toBe('true'));
    expect(mount.querySelector(`[data-track="room:${ROOM}"]`)?.textContent).toContain('Mexico build');
    await vi.waitFor(() => expect(mount.querySelector('[data-stream]')?.textContent).toContain('hello from Maya'));

    // The composer shows Maya's advertised price before anything can be sent.
    await vi.waitFor(() => expect(mount.querySelector('[data-cost-msat]')?.getAttribute('data-cost-msat')).toBe('2000'));
    expect(mount.querySelector('[data-cost]')?.textContent).toContain('Maya’s price');
    // Until the owner approves, the one action on screen is the approval itself.
    await vi.waitFor(() => expect(mount.querySelector('[data-send]')?.textContent).toBe('Send'));
    expect(mount.querySelector('[data-spend="locked"]')?.textContent).toContain('never saved');

    // A live message for the open track lands in the stream; one for another peer counts unread.
    emitLive({ type: 'link', state: 'open', detail: null });
    emitLive({ type: 'message', room_id: null, message: { id: 'm2', kind: 0, sender: A, recipient: OWN, timestamp: 1_725_000_100_000, plaintext: 'live one', payment_amount_msat: 2000 } });
    emitLive({ type: 'message', room_id: null, message: { id: 'm3', kind: 0, sender: B, recipient: OWN, timestamp: 1_725_000_200_000, plaintext: 'from B', payment_amount_msat: 1000 } });
    await vi.waitFor(() => expect(mount.querySelector('[data-stream]')?.textContent).toContain('live one'));
    await vi.waitFor(() => expect(mount.querySelector(`[data-track="peer:${B}"] .badge`)?.textContent).toBe('1'));
    expect(mount.querySelector('[data-stream]')?.textContent).not.toContain('from B');

    // A room costs each member's own price, summed; an unconnected member blocks the send.
    click(`[data-track="room:${ROOM}"]`);
    await vi.waitFor(() => expect(mount.querySelector('[data-cost-msat]')?.getAttribute('data-cost-msat')).toBe('3000'));
    expect(mount.querySelector('[data-cost]')?.textContent).toContain('2 members, each paid their own price; 1 estimated from yours');
    expect(mount.querySelector('[data-room-blocked]')?.textContent).toContain('Not every member is a connected peer');

    // Wallet: the one combined balance, never split into invented figures.
    click('[data-tab="wallet"]');
    await vi.waitFor(() => expect(mount.querySelector('[data-balance]')?.textContent).toContain('52,500'));
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
      expect(cmd).toMatch(/^(node_status|pairing_status|trust_acknowledge|node_overview|peers_list|rooms_list|room_members|messages_list|price_quote|payments_overview|fund_state|spend_status|device_key_status|budget_status|file_price|call_quote|room_quote|live_link|plugin:event\|(un)?listen)$/);
    }
    expect(calls.find((c) => c.cmd === 'plugin:event|listen')?.args?.event).toBe('node-live');

    // Regression: each 1.5 s host poll hands App a fresh status object. That must
    // not tear down and re-register the live listener (it once did, every poll).
    const polls = () => calls.filter((c) => c.cmd === 'node_status').length;
    const seen = polls();
    await vi.waitFor(() => expect(polls()).toBeGreaterThanOrEqual(seen + 2), { timeout: 4000 });
    expect(calls.filter((c) => c.cmd === 'plugin:event|listen')).toHaveLength(1);
    expect(calls.filter((c) => c.cmd === 'plugin:event|unlisten')).toHaveLength(0);
  }, 10_000);

  it('shows the link as live when the socket opened before the shell subscribed', async () => {
    const { calls, host } = stubHost();
    host.link = 'open';
    start();
    await vi.waitFor(() => expect(mount.querySelector('[data-gate] + button, .primary')).not.toBeNull());
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();

    // No link event is pushed by the test: the state comes only from the replay
    // the shell asks for after subscribing.
    await vi.waitFor(() => expect(mount.querySelector('.node-pill .what')?.textContent).toBe('Node live'));
    expect(mount.querySelector('[data-pill]')?.getAttribute('data-pill')).toBe('ok');
    const listenAt = calls.findIndex((c) => c.cmd === 'plugin:event|listen');
    const replayAt = calls.findIndex((c) => c.cmd === 'live_link');
    expect(listenAt).toBeGreaterThanOrEqual(0);
    expect(replayAt).toBeGreaterThan(listenAt);
    click('[data-tab="node"]');
    await vi.waitFor(() => expect(mount.querySelector('[data-link]')?.getAttribute('data-link')).toBe('open'));
  });

  it('runs on sample data with no host at all', async () => {
    start();
    await vi.waitFor(() => expect(mount.querySelector('[data-sample]')).not.toBeNull());
    await vi.waitFor(() => expect(mount.querySelector('[data-stream]')?.textContent).toContain('Morning.'));
    expect(mount.querySelector('[data-mode="sample"]')).not.toBeNull();
    await vi.waitFor(() => expect(mount.querySelector('[data-send]')?.textContent).toBe('Send'));
    click('[data-track="new"]');
    await vi.waitFor(() => expect(mount.querySelector('[data-new-track]')?.textContent).toContain('Share your node id'));
    expect(mount.querySelector('[data-new-track]')?.textContent).toContain('Browse');
    expect(mount.querySelector('[data-intro-mine]')).toBeNull();
    expect(mount.querySelector('[data-intro-open]')).toBeNull();
    click('[data-track="ai"]');
    await vi.waitFor(() => expect(mount.querySelector('[data-ai-track]')?.textContent).toContain('Ask about your own node'));
    expect(mount.querySelector('[data-ai-policy]')?.textContent).toContain('Nothing leaves this computer');
  });
});
