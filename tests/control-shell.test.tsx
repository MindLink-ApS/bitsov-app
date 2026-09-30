import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import type { PairingView } from '../src/onboarding/pairing';

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
  bootstrap: null,
};

type Call = { cmd: string; args: Record<string, unknown> | undefined };

function stubHost(overrides: Record<string, (args?: Record<string, unknown>) => unknown> = {}) {
  const calls: Call[] = [];
  const callbacks = new Map<number, (e: unknown) => void>();
  // The host's socket state (`live_link`). Opening it here emits nothing, like a
  // bridge that connected before the shell subscribed.
  const host = { link: null as 'connecting' | 'open' | 'closed' | null };
  const REPLIES: Record<string, (args?: Record<string, unknown>) => unknown> = {
    node_status: () => ({ ready: true, node_id: OWN, error: null }),
    pairing_status: () => paired,
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
        ? { kind: 0, own_msat: 1000, peer_msat: 2000, peer_age_secs: 60, peer_stale: false }
        : { kind: 0, own_msat: 1000, peer_msat: null, peer_age_secs: null, peer_stale: false },
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

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    mount?.remove();
    vi.unstubAllGlobals();
  });

  const start = () => {
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => <App />, mount);
  };
  const click = (sel: string) => mount.querySelector<HTMLElement>(sel)!.click();

  it('keeps first run in the centre track and reads nothing before the trust gate', async () => {
    const { calls } = stubHost();
    start();
    await vi.waitFor(() => expect(mount.querySelector('[data-gate="g6-local-trust"]')).not.toBeNull());
    expect(mount.querySelector('[data-first-run]')).not.toBeNull();
    expect(mount.querySelector('.rail')).not.toBeNull();
    expect(mount.querySelector('[data-panel="wallet"]')).toBeNull();
    expect(new Set(calls.map((c) => c.cmd))).toEqual(new Set(['node_status', 'pairing_status']));
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
    });
    start();
    await vi.waitFor(() => expect(mount.querySelector('[data-gate] + button, .primary')).not.toBeNull());
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();

    await vi.waitFor(() => expect(mount.querySelector('[data-touch-approval]')).not.toBeNull());
    const box = mount.querySelector('[data-touch-approval]')!.textContent!;
    expect(box).toContain('200 sats a day');
    expect(box).toContain('at most 2 sats per message');
    expect(mount.querySelector('[data-touch-peer]')?.textContent).toBe(`${A.slice(0, 8)}…${A.slice(-8)}`);
    await vi.waitFor(() => expect(mount.querySelector('[data-send]')?.textContent).toBe('Approve with Touch ID'));
    expect(calls.some((c) => c.cmd === 'relation_approve' || c.cmd === 'spend_request')).toBe(false);

    click('[data-touch-approve]');
    await vi.waitFor(() => expect(calls.filter((c) => c.cmd === 'relation_approve')).toHaveLength(1));
    const args = calls.find((c) => c.cmd === 'relation_approve')!.args!;
    expect(args).toMatchObject({ peer: A, budget_msat: null, per_act_max_msat: 2000 });
    expect(calls.some((c) => c.cmd === 'spend_request')).toBe(false);
  });

  it('shows the one-time owner command for this Mac, and a pending request can be cancelled', async () => {
    const cmd = 'konsensus device approve --op dd01 --config /Users/owner/node/konsensus.toml';
    const { calls } = stubHost({
      device_key_status: () => ({ available: true, state: 'pending', fingerprint: '3F9A-12C4', owner_action: cmd, expires_at_ms: Date.now() + 600_000 }),
      device_key_cancel: () => ({ available: true, state: 'none', fingerprint: null, owner_action: null, expires_at_ms: null }),
      spend_status: () => ({ state: 'pending', lapse: null, basis: null, open_until_ms: null, window_ms: 600_000,
        pending: { op_id: 'ab01', expires_at_ms: Date.now() + 600_000, owner_action: 'konsensus grant --op ab01', owner_can_grant: true } }),
      spend_cancel: () => ({ state: 'locked', lapse: null, basis: null, open_until_ms: null, pending: null, window_ms: 600_000 }),
    });
    start();
    await vi.waitFor(() => expect(mount.querySelector('[data-gate] + button, .primary')).not.toBeNull());
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();

    await vi.waitFor(() => expect(mount.querySelector('[data-device-owner-action]')?.textContent).toBe(cmd));
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
    await vi.waitFor(() => expect(mount.querySelector('[data-send]')?.textContent).toBe('Approve spending'));
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
      expect(cmd).toMatch(/^(node_status|pairing_status|node_overview|peers_list|rooms_list|room_members|messages_list|price_quote|payments_overview|fund_state|spend_status|device_key_status|budget_status|file_price|call_quote|room_quote|live_link|plugin:event\|(un)?listen)$/);
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
    await vi.waitFor(() => expect(mount.querySelector('[data-send]')?.textContent).toBe('Approve app all-in limit'));
    click('[data-track="new"]');
    await vi.waitFor(() => expect(mount.querySelector('[data-new-track]')?.textContent).toContain('introduction, not admission'));
    click('[data-track="ai"]');
    await vi.waitFor(() => expect(mount.querySelector('[data-ai-track]')?.textContent).toContain('Ask about your own node'));
    expect(mount.querySelector('[data-ai-policy]')?.textContent).toContain('Nothing leaves this computer');
  });
});
