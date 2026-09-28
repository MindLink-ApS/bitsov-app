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

function stubHost() {
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
    file_price: () => 3000,
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
      expect(cmd).toMatch(/^(node_status|pairing_status|node_overview|peers_list|rooms_list|room_members|messages_list|price_quote|payments_overview|fund_state|spend_status|budget_status|file_price|room_quote|live_link|plugin:event\|(un)?listen)$/);
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
    await vi.waitFor(() => expect(mount.querySelector('[data-send]')?.textContent).toBe('Approve daily budget'));
    click('[data-track="new"]');
    await vi.waitFor(() => expect(mount.querySelector('[data-new-track]')?.textContent).toContain('introduction, not admission'));
    click('[data-track="ai"]');
    await vi.waitFor(() => expect(mount.querySelector('[data-ai-track]')?.textContent).toContain('Ask about your own node'));
    expect(mount.querySelector('[data-ai-policy]')?.textContent).toContain('Nothing leaves this computer');
  });
});
