import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import type { PairingView } from '../src/onboarding/pairing';
import { resetContactsForTests, setPetname } from '../src/control/petnames';
import { sampleInvoiceMsat, sampleSource, SAMPLE_OPEN_ROOM_ID, SAMPLE_ROOM_ID } from '../src/control/sample';
import type { LiveEvent, SpendView } from '../src/control/types';
import { setDenom } from '../src/control/prefs';
import { setShowLegacyRoomsUi } from '../src/control/Shell';

// Slice B: acting from the track against a stubbed host whose spend window is
// stateful, plus the dev sample source on its own. No node, no network.

const OWN = '1'.repeat(64);
const A = 'a'.repeat(64);
const ROOM = '0f8e2b7a-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
const WINDOW = 600_000;

const paired: PairingView = { state: 'paired', scopes: ['read', 'receive'], short_code: 'ABCD-EFGH', code_from_node: true, reason: null, remote: false, bootstrap: null };

type Call = { cmd: string; args: Record<string, unknown> | undefined };
type Reply = (args?: Record<string, unknown>) => unknown;

// A #227 host: views name the grant of an open window and the request that armed it (null when closed).
const view = (state: SpendView['state'], extra: Partial<SpendView> = {}): SpendView => ({
  state, basis: null, open_until_ms: null, pending: null, window_ms: WINDOW, granted_op: null, armed_by_request: null, ...extra,
});
/** The node granted request ab12: the window's grant op is the node's own (cd34), armed by ab12. */
const openView = (armedBy: string | null = 'ab12', grantedOp = 'cd34') =>
  view('open', { basis: 'node_grant', open_until_ms: Date.now() + WINDOW, granted_op: grantedOp, armed_by_request: armedBy });

function stubHost(overrides: Record<string, Reply> = {}) {
  resetContactsForTests();
  setPetname(A, 'Maya');
  const calls: Call[] = [];
  const callbacks = new Map<number, (e: unknown) => void>();
  const spend = { v: view('locked') };
  const REPLIES: Record<string, Reply> = {
    node_status: () => ({ ready: true, node_id: OWN, error: null }),
    trust_acknowledge: () => true,
    pairing_status: () => paired,
    node_overview: () => ({
      node_id: OWN, status: 'ok', version: 'api v2', connected_peers: 1, e2ee_sessions: 1, pending_deliveries: 0,
      lightning_available: true, block_height: 1, uptime_secs: 1, lightning_backend: 'ldk', chain_backend: 'esplora', read_at: Date.now(),
    }),
    peers_list: () => [{ node_id: A, addr: null, label: 'Maya', connected: true, fingerprint: null }],
    rooms_list: () => [{ id: ROOM, name: 'Mexico build', created_by: OWN, created_at: null }],
    room_members: () => [OWN, A],
    room_quote: () => ({ room_id: ROOM, members: [{ node_id: A, msat: 2000, advertised: true, connected: true }], total_msat: 2000, unreachable: [], estimate: false }),
    messages_list: () => [],
    price_quote: () => ({ kind: 0, own_msat: 1000, peer_msat: 2000, peer_age_secs: 30, max_routing_fee_msat: 0, peer_stale: false }),
    payments_overview: () => ({ balance_msat: 1_000_000, lightning_outbound_msat: 500_000, channels: [] }),
    fund_state: () => null,
    file_price: () => ({ principal_msat: 3000, max_routing_fee_msat: 5000, total_msat: 8000 }),
    spend_status: () => spend.v,
    spend_request: () => {
      spend.v = view('pending', { pending: { op_id: 'ab12', expires_at_ms: Date.now() + 900_000, owner_action: 'konsensus grant --op ab12', owner_can_grant: true } });
      return { ...spend.v, request_id: 'ab12' };
    },
    spend_lock: () => (spend.v = view('locked')),
    message_send: (args) => ({ message_id: 'sent-1', recipient: args!.recipient, is_room: args!.is_room, delivered: true, amount_msat: 2000, sent_at_ms: Date.now() }),
    invoice_amount: (args) =>
      String(args!.bolt11).startsWith('lntb10n')
        ? { amount_msat: 1000, network: 'testnet', payee: `02${'cd'.repeat(32)}`, expires_at_ms: Date.now() + 3_600_000, bolt11: String(args!.bolt11).trim().toLowerCase(), payment_hash: '07'.repeat(32), description: null }
        : Promise.reject({ code: 'invalid', message: 'that is not a Lightning invoice' }),
    payment_pay: (args) => ({ method: 'invoice', amount_msat: args!.amount_msat, status: 'settled', paid_at_ms: Date.now() }),
    payment_keysend: (args) => ({ method: 'keysend', amount_msat: args!.amount_msat, status: 'settled', paid_at_ms: Date.now() }),
    invoice_create: (args) => ({ bolt11: 'lntb210n1sample', amount_msat: args!.amount_msat, note: args!.note || null, expires_at_ms: Date.now() + 3_600_000 }),
    file_send: (args) => ({ message_id: 'file-1', recipient: args!.recipient, filename: args!.filename, size_bytes: 2, delivered: true, amount_msat: 3000, sent_at_ms: Date.now() }),
    invite_create: (args) => ({ invite_id: 'i1', invite_link: 'bitsov://invite/tok', invitee: args!.invitee, expires_at_ms: Date.now() + 86_400_000 }),
    live_link: () => null,
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
      if (!reply) return Promise.reject(new Error(`unexpected ${cmd}`));
      try {
        return Promise.resolve(reply(args));
      } catch (e) {
        return Promise.reject(e);
      }
    },
  });
  vi.stubGlobal('__TAURI_EVENT_PLUGIN_INTERNALS__', { unregisterListener: () => {} });
  const emitLive = (payload: LiveEvent) => {
    const listen = calls.find((c) => c.cmd === 'plugin:event|listen');
    callbacks.get(listen!.args!.handler as number)!({ event: 'node-live', id: 1, payload });
  };
  const used = (cmd: string) => calls.filter((c) => c.cmd === cmd);
  return { calls, emitLive, spend, used };
}

describe('acting from the track', () => {
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
    vi.restoreAllMocks();
  });

  const $ = <T extends Element = HTMLElement>(sel: string) => mount.querySelector<T>(sel);
  const text = (sel: string) => $(sel)?.textContent ?? '';
  const type = (sel: string, value: string) => {
    const el = $<HTMLInputElement | HTMLTextAreaElement>(sel)!;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const submit = () => $<HTMLButtonElement>('[data-send]')!.click();
  /** Pay's one confirm tap, after the review shows what will be paid. */
  const confirmPay = async () => {
    await vi.waitFor(() => expect($('[data-pay-confirm]')).not.toBeNull());
    $<HTMLButtonElement>('[data-pay-confirm]')!.click();
  };

  async function openShell(opts: { waitCost?: boolean } = {}) {
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => <App />, mount);
    await vi.waitFor(() => expect([...mount.querySelectorAll('button')].some((b) => b.textContent?.includes('I understand'))).toBe(true));
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
    await vi.waitFor(() => expect($(`[data-track="peer:${A}"]`)?.getAttribute('aria-current')).toBe('true'));
    if (opts.waitCost !== false) {
      await vi.waitFor(() => expect($('[data-cost-msat]')?.getAttribute('data-cost-msat')).toBe('2000'));
    }
  }

  // Approve & send (Phase A). The rule under test everywhere: an Unsent
  // "nothing paid" card appears only when nothing was dispatched for it.
  const unsentReason = () => text('[data-unsent] [data-unsent-reason]');
  const nothingPaidIsTrue = (host: ReturnType<typeof stubHost>) => {
    if (/nothing paid/.test(unsentReason())) expect(host.used('message_send')).toHaveLength(0);
  };
  const pressWaiting = async (host: ReturnType<typeof stubHost>) => {
    type('[data-composer] textarea', 'gm Maya');
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Approve & send'));
    submit();
    await vi.waitFor(() => expect($('[data-sending="waiting"]')).not.toBeNull());
    await vi.waitFor(() => expect(host.used('spend_request')).toHaveLength(1));
  };

  it('Approve & send: exactly one send, however many status reads follow the grant', async () => {
    const host = stubHost();
    await openShell();
    await pressWaiting(host);
    host.spend.v = openView();
    await vi.waitFor(() => expect(host.used('message_send')).toHaveLength(1), { timeout: 5000 });
    const reads = host.used('spend_status').length;
    await vi.waitFor(() => expect(host.used('spend_status').length).toBeGreaterThan(reads + 1), { timeout: 8000 });
    expect(host.used('message_send')).toHaveLength(1);
    expect($('[data-sending]')).toBeNull();
    expect($('[data-unsent]')).toBeNull();
  }, 20_000);

  it('Approve & send: not approved (the request is refused) → Unsent "not sent, nothing paid", and nothing was dispatched', async () => {
    const host = stubHost({ spend_request: () => { throw { code: 'spend_refused', message: 'This pairing cannot ask.' }; } });
    await openShell();
    type('[data-composer] textarea', 'gm Maya');
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Approve & send'));
    submit();
    await vi.waitFor(() => expect(unsentReason()).toBe('Not sent · nothing paid · It was not approved.'));
    expect(text('[data-unsent] .bubble')).toBe('gm Maya');
    expect(host.used('message_send')).toHaveLength(0);
    expect($('[data-sending]')).toBeNull();
    // Put back in the box restores the words for another try.
    $<HTMLButtonElement>('[data-unsent-restore]')!.click();
    await vi.waitFor(() => expect($<HTMLTextAreaElement>('[data-composer] textarea')!.value).toBe('gm Maya'));
  });

  it.each([['another chat', `room:${ROOM}`], ['Discover (the composer unmounts)', 'discover']])('Approve & send: leaving to %s before the grant ends it unsent; a later grant sends nothing', async (_where, key) => {
    const host = stubHost();
    await openShell();
    await pressWaiting(host);
    $<HTMLElement>(`[data-track="${key}"]`)!.click();
    await vi.waitFor(() => expect($(`[data-track="${key}"]`)?.getAttribute('aria-current')).toBe('true'));
    host.spend.v = openView();
    $<HTMLElement>(`[data-track="peer:${A}"]`)!.click();
    await vi.waitFor(() => expect(text('[data-unsent] .bubble')).toBe('gm Maya'));
    expect(unsentReason()).toMatch(/^Not sent · nothing paid · You left/);
    await new Promise((r) => setTimeout(r, 2500));
    expect(host.used('message_send')).toHaveLength(0);
    nothingPaidIsTrue(host);
  });

  it('Approve & send: the box is free while it waits; a second message waits its turn behind the approval, and only the first goes when approved', async () => {
    const host = stubHost();
    await openShell();
    await pressWaiting(host);
    type('[data-composer] textarea', 'second thought');
    expect($<HTMLTextAreaElement>('[data-composer] textarea')!.value).toBe('second thought');
    host.spend.v = openView();
    await vi.waitFor(() => expect(host.used('message_send')).toHaveLength(1), { timeout: 5000 });
    expect(host.used('message_send')[0].args).toMatchObject({ plaintext: 'gm Maya', max_msat: 2000 });
    // The newer draft is untouched and was never sent.
    expect($<HTMLTextAreaElement>('[data-composer] textarea')!.value).toBe('second thought');
    nothingPaidIsTrue(host);
  });

  it('Approve & send r1 #1: the request it waits on is cancelled → Unsent, and a later grant never sends it', async () => {
    const host = stubHost();
    await openShell();
    await pressWaiting(host);
    host.spend.v = view('locked'); // cancelled at the node
    await vi.waitFor(() => expect(unsentReason()).toBe('Not sent · nothing paid · The approval was cancelled or lapsed before it went through.'), { timeout: 5000 });
    host.spend.v = openView();
    await vi.waitFor(() => expect($('[data-spend="open"]')).not.toBeNull(), { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 300));
    expect(host.used('message_send')).toHaveLength(0);
  }, 15_000);

  it('Approve & send r1 #1: another request replacing the one it waits on never satisfies it', async () => {
    const host = stubHost();
    await openShell();
    await pressWaiting(host);
    host.spend.v = view('pending', { pending: { op_id: 'cd34', expires_at_ms: Date.now() + 900_000, owner_action: 'konsensus grant --op cd34', owner_can_grant: true } });
    await vi.waitFor(() => expect(unsentReason()).toMatch(/cancelled or lapsed/), { timeout: 5000 });
    host.spend.v = openView();
    await vi.waitFor(() => expect($('[data-spend="open"]')).not.toBeNull(), { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 300));
    expect(host.used('message_send')).toHaveLength(0);
  }, 15_000);

  it('Approve & send: an approval whose result names no request and no grant cannot be tied to this message: the plain flow at once, nothing sent', async () => {
    const host = stubHost({ spend_request: () => ({ ...view('open', { basis: 'app_lock', open_until_ms: Date.now() + WINDOW }), request_id: null, granted_op: null }) });
    await openShell();
    type('[data-composer] textarea', 'gm Maya');
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Approve & send'));
    submit();
    await vi.waitFor(() => expect($<HTMLTextAreaElement>('[data-composer] textarea')!.value).toBe('gm Maya'));
    expect($('[data-sending]')).toBeNull();
    expect(text('[data-composer-note]')).toBe('Approved. Press Send to send it.');
    await new Promise((r) => setTimeout(r, 300));
    expect(host.used('message_send')).toHaveLength(0);
  });

  it('#227: request A cancelled and B granted inside one status gap: the window B armed never sends A\'s message', async () => {
    const host = stubHost();
    await openShell();
    await pressWaiting(host);
    host.spend.v = openView('ef56', 'gh78'); // armed by another request
    await vi.waitFor(() => expect(unsentReason()).toMatch(/cancelled or lapsed/), { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 300));
    expect(host.used('message_send')).toHaveLength(0);
  }, 15_000);

  it('#227: an approval that armed the window itself (its result names the grant) sends once while that grant is open', async () => {
    const host = stubHost({ spend_request: () => { host.spend.v = openView(null, 'cd34'); return { ...host.spend.v, request_id: null }; } });
    await openShell();
    type('[data-composer] textarea', 'gm Maya');
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Approve & send'));
    submit();
    await vi.waitFor(() => expect(host.used('message_send')).toHaveLength(1), { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 300));
    expect(host.used('message_send')).toHaveLength(1);
  }, 15_000);

  it('Approve & send handed to the queue behind a send in flight: leaving the chat before its turn never sends it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const sent: string[] = [];
    const host = stubHost({
      spend_request: () => { host.spend.v = openView(null, 'cd35'); return { ...host.spend.v, request_id: null }; },
      message_send: async (args) => {
        sent.push(args!.plaintext as string);
        if (sent.length === 1) await gate;
        return { message_id: `sent-${sent.length}`, recipient: args!.recipient, is_room: false, delivered: true, amount_msat: 2000, sent_at_ms: Date.now() };
      },
    });
    host.spend.v = openView(null, 'cd34');
    await openShell();
    type('[data-composer] textarea', 'one');
    await vi.waitFor(() => expect(text('[data-send]')).toMatch(/^Send/));
    submit();
    await vi.waitFor(() => expect(sent).toEqual(['one']));
    // The window closes; the next message is an Approve & send whose own call arms cd35.
    host.spend.v = view('locked');
    type('[data-composer] textarea', 'two');
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Approve & send'), { timeout: 8000 });
    submit();
    await vi.waitFor(() => expect(host.used('spend_request')).toHaveLength(1));
    await vi.waitFor(() => expect(mount.querySelectorAll('[data-sending=""]').length).toBe(2));
    $<HTMLButtonElement>('[data-track="discover"]')!.click();
    release();
    await new Promise((r) => setTimeout(r, 500));
    expect(sent).toEqual(['one']);
    $<HTMLButtonElement>(`[data-track="peer:${A}"]`)!.click();
    await vi.waitFor(() => expect(unsentReason()).toContain('You left this chat before it was sent.'));
  }, 20_000);

  it('#227: an older host that names no grant offers plain Send (no Approve & send, no waiting bubble)', async () => {
    const legacy = (st: SpendView['state'], extra: Partial<SpendView> = {}) => ({ state: st, basis: null, open_until_ms: null, pending: null, window_ms: WINDOW, ...extra });
    const host = stubHost({
      spend_status: () => legacy('locked'),
      spend_request: () => legacy('pending', { pending: { op_id: 'ab12', expires_at_ms: Date.now() + 900_000, owner_action: 'konsensus grant --op ab12', owner_can_grant: true } }),
    });
    await openShell();
    type('[data-composer] textarea', 'gm Maya');
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Send'));
    submit();
    await vi.waitFor(() => expect(host.used('spend_request')).toHaveLength(1));
    expect($('[data-sending]')).toBeNull();
    expect($<HTMLTextAreaElement>('[data-composer] textarea')!.value).toBe('gm Maya');
  });

  it('Approve & send r1 #2: its own approval failing while spending opened another way never sends it', async () => {
    let refuse!: () => void;
    const host = stubHost({ spend_request: () => new Promise((_resolve, reject) => { refuse = () => reject({ code: 'spend_refused', message: 'Refused.' }); }) });
    await openShell();
    type('[data-composer] textarea', 'gm Maya');
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Approve & send'));
    submit();
    await vi.waitFor(() => expect($('[data-sending="waiting"]')).not.toBeNull());
    await vi.waitFor(() => expect(refuse).toBeDefined());
    // Spending opens by some other approval while this request is still out ...
    host.spend.v = openView();
    await vi.waitFor(() => expect($('[data-spend="open"]')).not.toBeNull(), { timeout: 5000 });
    // ... then this approval is refused.
    refuse();
    await vi.waitFor(() => expect(unsentReason()).toBe('Not sent · nothing paid · It was not approved.'));
    await new Promise((r) => setTimeout(r, 300));
    expect(host.used('message_send')).toHaveLength(0);
  }, 15_000);

  it('Approve & send r1 #3: past its 10 minutes the hand-off ends it unsent (fake clock), and nothing is sent', async () => {
    const host = stubHost();
    await openShell();
    await pressWaiting(host);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
      host.spend.v = openView();
      await vi.waitFor(() => expect(unsentReason()).toBe('Not sent · nothing paid · It was not approved within 10 minutes.'), { timeout: 5000 });
      expect(host.used('message_send')).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  }, 15_000);

  it('Approve & send r1 #4: while its bubble waits, the approval copy says it sends when approved', async () => {
    const host = stubHost({
      pairing_status: () => ({ ...paired, remote: true }),
      device_key_status: () => ({ available: true, state: 'none', fingerprint: null, owner_action: null, expires_at_ms: null }),
    });
    await openShell();
    await pressWaiting(host);
    await vi.waitFor(() => expect(text('[data-touch-id-stays-text="spend"]')).toContain('Your message waits in its bubble and sends once this approval goes through.'));
    expect(text('[data-touch-id-stays-text="spend"]')).not.toContain('until you press Send');
  });

  it('asks the owner once (Approve & send), then sends that message once the grant lands, and shows the receipt and delivery', async () => {
    const host = stubHost();
    await openShell();
    type('[data-composer] textarea', 'gm Maya');

    // Locked: the button is the approval, and this press also sends the message once it is approved.
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Approve & send'));
    submit();
    await vi.waitFor(() => expect(text('[data-owner-action]')).toBe('konsensus grant --op ab12'));
    expect(text('[data-approval="pending"]')).toContain('This app cannot approve it for you');
    expect($('[data-approval="pending"]')).not.toBeNull();
    expect(host.used('message_send')).toHaveLength(0);
    // The words wait in their bubble; the box is free.
    expect(text('[data-sending="waiting"] .bubble')).toBe('gm Maya');
    expect(text('[data-sending="waiting"] [data-sending-cap]')).toContain('Sends when approved');
    expect($<HTMLTextAreaElement>('[data-composer] textarea')!.value).toBe('');

    // The owner grants at their terminal; the next status poll opens the window, and it sends once (no second press).
    host.spend.v = openView();
    await vi.waitFor(() => expect($('[data-spend="open"]')).not.toBeNull(), { timeout: 5000 });
    expect(text('[data-spend="open"]')).toContain('ten minutes per approval');

    await vi.waitFor(() => expect(host.used('message_send')).toHaveLength(1));
    expect(host.used('message_send')[0].args).toEqual({ recipient: A, is_room: false, plaintext: 'gm Maya', max_msat: 2000, max_recipient_msat: null, first_contact_msat: null });
    await vi.waitFor(() => expect(text('[data-message="sent-1"] .stamp .sats')).toBe('paid 2 sats · fee unknown'));
    expect(text('[data-message="sent-1"] .stamp')).not.toContain('ceiling');
    expect(text('[data-message="sent-1"] [data-delivery]').trim()).toBe('Sent');
    expect($<HTMLTextAreaElement>('[data-composer] textarea')!.value).toBe('');

    host.emitLive({ type: 'delivery', message_id: 'sent-1', status: 'delivered', reason: null });
    await vi.waitFor(() => expect($('[data-message="sent-1"] [data-delivery]')?.getAttribute('data-delivery')).toBe('delivered'));

    // Lock now closes it again.
    $<HTMLButtonElement>('[data-spend-lock]')!.click();
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Send'));
  }, 10_000);

  it('shows a rejection with the recipient node’s own reason', async () => {
    const host = stubHost();
    host.spend.v = openView();
    await openShell();
    type('[data-composer] textarea', 'hello');
    await vi.waitFor(() => expect($('[data-spend="open"]')).not.toBeNull());
    submit();
    await vi.waitFor(() => expect($('[data-message="sent-1"]')).not.toBeNull());
    host.emitLive({ type: 'delivery', message_id: 'sent-1', status: 'rejected', reason: 'insufficient payment: required 3000 msat, got 2000 msat' });
    await vi.waitFor(() => expect(text('[data-message="sent-1"] [data-delivery]')).toBe('Rejected: insufficient payment: required 3000 msat, got 2000 msat'));
  });

  it('an expired approval re-prompts, records no failure, and keeps the draft', async () => {
    const host = stubHost({
      message_send: () => {
        throw { code: 'spend_expired', message: 'Your spending approval has expired. Approve again to send.' };
      },
    });
    host.spend.v = openView();
    await openShell();
    type('[data-composer] textarea', 'still there?');
    await vi.waitFor(() => expect($('[data-spend="open"]')).not.toBeNull());
    host.spend.v = view('expired');
    submit();
    await vi.waitFor(() => expect($('[data-spend="expired"]')).not.toBeNull());
    expect(text('[data-spend="expired"]')).toContain('Approve again');
    expect($('[data-artifact="failed"]')).toBeNull();
    expect($<HTMLTextAreaElement>('[data-composer] textarea')!.value).toBe('still there?');
  });

  it('keeps a node failure in the track as a record', async () => {
    stubHost({
      message_send: () => {
        throw { code: 'node', message: '/messages/compose failed (502): failed to pay recipient invoice: no route' };
      },
    }).spend.v = openView();
    await openShell();
    type('[data-composer] textarea', 'hi');
    await vi.waitFor(() => expect($('[data-spend="open"]')).not.toBeNull());
    submit();
    await vi.waitFor(() => expect(text('[data-artifact="failed"]')).toContain('no route'));
    expect(text('[data-artifact="failed"]')).toContain('Message not sent');
  });

  it('keeps first-contact admission inside the displayed ceiling', async () => {
    stubHost();
    await openShell();
    expect(text('[data-cost]')).toContain('First-contact admission must fit this ceiling');
    expect(text('[data-send-price]')).toBe('up to 2 sats · includes max routing fee');
  });

  it('labels ambiguous sends unknown and reconciles without sending again', async () => {
    const host = stubHost({
      message_send: () => { throw { code: 'spend_unknown', message: 'Outcome unknown; do not retry.' }; },
      spend_reconcile: () => 'Previous action settled. Nothing was dispatched again.',
    });
    host.spend.v = openView();
    await openShell();
    type('[data-composer] textarea', 'hi');
    submit();
    await vi.waitFor(() => expect(text('[data-artifact="failed"]')).toContain('Outcome unknown / pending'));
    expect(text('[data-artifact="failed"]')).not.toContain('not sent');
    $<HTMLButtonElement>('[data-spend-reconcile]')!.click();
    await vi.waitFor(() => expect(text('[data-reconciliation]')).toContain('Previous action settled'));
    expect(host.used('message_send')).toHaveLength(1);
    expect(host.used('spend_reconcile')).toHaveLength(1);
  });

  // Exactly-once slice 3: the node's operation state, on the message card.
  it('tells accepted apart from sent and queued on the message card', async () => {
    const OP = '6f1c2a4e-9b3d-4c5e-8f70-112233445566';
    const replies = [
      { state: 'acked', accepted: true, delivered: true, want: ['accepted', ''] },
      { state: 'sent', accepted: false, delivered: true, want: ['sent', 'Sent'] },
      { state: 'paid', accepted: false, delivered: false, want: ['queued', 'Queued'] },
    ];
    let n = 0;
    const host = stubHost({
      message_send: (args) => {
        const r = replies[n];
        n += 1;
        return { message_id: `op-${n}`, recipient: args!.recipient, is_room: false, delivered: r.delivered, amount_msat: 2000, sent_at_ms: Date.now(), operation_id: OP, state: r.state, accepted: r.accepted };
      },
    });
    host.spend.v = openView();
    await openShell();
    for (const [i, r] of replies.entries()) {
      type('[data-composer] textarea', `hello ${i}`);
      // A send the node took makes the contact's price known: no longer an estimate.
      await vi.waitFor(() => expect($('[data-spend="open"]')).not.toBeNull());
      submit();
      await vi.waitFor(() => expect($(`[data-message="op-${i + 1}"] [data-delivery]`)).not.toBeNull());
      expect($(`[data-message="op-${i + 1}"] [data-delivery]`)!.getAttribute('data-delivery')).toBe(r.want[0]);
      expect(text(`[data-message="op-${i + 1}"] [data-delivery]`)).toBe(r.want[1]);
    }
    expect(host.used('message_send')).toHaveLength(3);
  });

  it('names an unresolved payment on its card and never sends it again', async () => {
    const host = stubHost({
      message_send: () => { throw { code: 'payment_unknown', message: 'Payment unknown: your node has not resolved whether this message\'s payment went through. It will not pay for it again, and the app will not resend it. Check the pending result later.', pending_id: 'p1' }; },
      spend_reconcile: () => { throw { code: 'payment_unknown', message: 'Payment unknown: still unresolved.', pending_id: 'p1' }; },
    });
    host.spend.v = openView();
    await openShell();
    type('[data-composer] textarea', 'hi');
    submit();
    await vi.waitFor(() => expect($('[data-artifact="failed"][data-code="payment_unknown"]')).not.toBeNull());
    const card = text('[data-artifact="failed"]');
    expect(card).toContain('Payment unknown · not resent');
    expect(card).not.toContain('not sent');
    expect(card).not.toContain('Message not sent');
    $<HTMLButtonElement>('[data-spend-reconcile]')!.click();
    await vi.waitFor(() => expect(text('[data-reconciliation]')).toContain('Payment unknown'));
    expect(host.used('message_send')).toHaveLength(1);
  });

  it('says a capped re-admission refusal as it is: their door, not their price, and keeps the draft', async () => {
    const message = 'Not sent - nothing was paid. This contact asks your node to pay their admission again (every reconnect or node restart starts unpaid), and your node cannot pay that under the app\'s all-in cap yet. The app will not retry; sending the same message again reuses its operation, so it can never be paid twice.';
    const host = stubHost({ message_send: () => { throw { code: 'readmission_capped', message }; } });
    host.spend.v = openView();
    await openShell();
    type('[data-composer] textarea', 'after the restart');
    submit();
    await vi.waitFor(() => expect($('[data-door="out-refused"][data-code="readmission_capped"]')).not.toBeNull());
    const card = text('[data-door="out-refused"]');
    expect(card).toContain('Not sent · they ask for admission again');
    expect(card).toContain('Not sent - nothing was paid.');
    expect(card).not.toContain('their price is above your cap');
    expect(card).not.toContain('Reopen the track');
    expect($('[data-artifact="failed"]'), 'the door card is the record, not a failure row').toBeNull();
    expect($<HTMLTextAreaElement>('[data-composer] textarea')!.value).toBe('after the restart');
    expect(host.used('message_send')).toHaveLength(1);
  });

  it('shows a quoted re-admission inline, in the all-in cost, and sends once more at that price', async () => {
    // Real-window step 10: one Send after a node restart only gets the quote;
    // the draft must stay, and a second Send at the quoted all-in must deliver.
    // The harness used to break after the first "Send" label and leave it unsent.
    const admission = { admission_msat: 1000, message_msat: 2000, max_routing_fee_msat: 10_000, total_msat: 13_000, quoted: true };
    let n = 0;
    const host = stubHost({
      message_send: (args) => {
        if (n++ === 0) throw { code: 'readmission_quoted', message: 'Not sent - nothing was paid. This contact asks for admission again.', admission };
        return { message_id: 'sent-1', recipient: args!.recipient, is_room: false, delivered: true, amount_msat: 2000, readmission_msat: 1000,
          max_routing_fee_msat: 0, total_msat: 3000, sent_at_ms: Date.now() };
      },
    });
    host.spend.v = openView();
    await openShell();
    type('[data-composer] textarea', 'after the restart');
    submit();
    await vi.waitFor(() => expect($('[data-readmission-quote]')).not.toBeNull());
    expect(text('[data-readmission-quote]')).toContain('Maya asks for admission again, 1 sat. Nothing was paid.');
    expect(text('[data-readmission-quote]')).toContain('13 sats in all');
    expect($('[data-cost-msat]')!.getAttribute('data-cost-msat')).toBe('13000');
    expect(text('[data-cost]')).toContain('Maya asks for admission again: 1 sat, then 2 sats for this message');
    expect($('[data-artifact="failed"]'), 'an ask, not a failure').toBeNull();
    expect($('[data-door="out-refused"]')).toBeNull();
    expect($<HTMLTextAreaElement>('[data-composer] textarea')!.value, 'the draft stays').toBe('after the restart');
    expect(text('[data-send]').trim().startsWith('Send'), 'Send stays ready for the quoted retry').toBe(true);
    submit();
    await vi.waitFor(() => expect(host.used('message_send')).toHaveLength(2));
    expect(host.used('message_send')[1].args!.max_msat, 'the quoted all-in total').toBe(13_000);
    await vi.waitFor(() => expect($('[data-readmission-paid]')).not.toBeNull());
    expect(text('[data-readmission-paid]')).toContain('incl. admission again 1 sat');
    expect($('[data-readmission-quote]')).toBeNull();
    expect($<HTMLTextAreaElement>('[data-composer] textarea')!.value, 'draft clears only after the paid send').toBe('');
  });

  it('keeps the draft and says so when Send is pressed before the message price is known', async () => {
    const host = stubHost({
      price_quote: () => new Promise(() => { /* never settles */ }),
    });
    host.spend.v = openView();
    await openShell({ waitCost: false });
    type('[data-composer] textarea', 'too soon');
    await vi.waitFor(() => expect($('[data-send]')!.hasAttribute('disabled')).toBe(true));
    // Disabled Send cannot click; a form submit still must not clear the draft.
    const form = $('[data-composer]') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect($('[data-composer-note]')).not.toBeNull());
    expect(text('[data-send-price]')).toContain('price loading');
    expect($<HTMLTextAreaElement>('[data-composer] textarea')!.value).toBe('too soon');
    expect(host.used('message_send')).toHaveLength(0);
  });

  it('labels a paid, refused-for-good send and a changed-text retry refusal', async () => {
    const codes = [
      { code: 'failed_paid', message: 'Paid, and the recipient\'s node refused this message for good. The payment is not refundable. Do not send it again.', label: 'Paid · refused by their node' },
      { code: 'operation_mismatch', message: 'Your node refused this retry: its text differs from the message it retries. Nothing was paid.', label: 'Message not sent' },
    ];
    let n = 0;
    const host = stubHost({ message_send: () => { throw codes[n++]; } });
    host.spend.v = openView();
    await openShell();
    for (const c of codes) {
      type('[data-composer] textarea', `try ${c.code}`);
      await vi.waitFor(() => expect($('[data-spend="open"]')).not.toBeNull());
      submit();
      await vi.waitFor(() => expect($(`[data-artifact="failed"][data-code="${c.code}"]`)).not.toBeNull());
      expect(text(`[data-artifact="failed"][data-code="${c.code}"]`)).toContain(c.label);
    }
    expect(host.used('message_send')).toHaveLength(2);
  });

  it('sends to a room at the summed member price', async () => {
    const host = stubHost();
    host.spend.v = openView();
    await openShell();
    $<HTMLButtonElement>(`[data-track="room:${ROOM}"]`)!.click();
    await vi.waitFor(() => expect(text('[data-cost]')).toContain('1 member, each paid their own price'));
    expect($('[data-composer-mode]')).toBeNull();
    type('[data-composer] textarea', 'room hello');
    await vi.waitFor(() => expect($('[data-spend="open"]')).not.toBeNull());
    submit();
    await vi.waitFor(() => expect(host.used('message_send')[0]?.args).toEqual({ recipient: ROOM, is_room: true, plaintext: 'room hello', max_msat: 2000, max_recipient_msat: { [A]: 2000 }, first_contact_msat: null }));
  });

  it('pays an invoice only after showing what it asks for', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Android');
    let incoming: string | null = null;
    const host = stubHost({ pairing_link_take: () => { const link = incoming; incoming = null; return link; } });
    host.spend.v = openView();
    await openShell();
    $<HTMLButtonElement>('[data-composer-mode="pay"]')!.click();
    type('[data-pay-invoice]', 'not an invoice');
    await vi.waitFor(() => expect(text('[data-composer-note]')).toContain('not a Lightning invoice'));
    expect($<HTMLButtonElement>('[data-send]')!.disabled).toBe(true);
    type('[data-pay-invoice]', 'lntb10n1abc');
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Pay · 6 sats'));
    expect(text('[data-composer]')).toContain('up to 5 sats network fee');
    expect($('[data-cost-msat]')?.getAttribute('data-cost-msat')).toBe('6000');
    submit();
    await vi.waitFor(() => expect($('[data-pay-review]')).not.toBeNull());
    expect(host.used('payment_pay')).toHaveLength(0);
    expect(text('[data-review-amount]')).toBe('1 sat');
    expect(text('[data-review-fee]')).toBe('up to 5 sats');
    expect(text('[data-review-total]')).toBe('6 sats');
    const review = $('[data-pay-review]');
    incoming = 'bitsov://pair/hostile';
    await vi.waitFor(() => expect($('[data-pairing-link-banner]')).not.toBeNull(), { timeout: 2000 });
    expect($<HTMLButtonElement>('[data-review-pairing]')!.disabled).toBe(true);
    expect($('[data-pay-review]')).toBe(review);
    expect($('[data-pairing-link-screen]')).toBeNull();
    await confirmPay();
    await vi.waitFor(() => expect(host.used('payment_pay')[0]?.args).toEqual({ bolt11: 'lntb10n1abc', amount_msat: 1000, max_msat: 6000 }));
    await vi.waitFor(() => expect($('[data-artifact="payment"]')?.getAttribute('data-status')).toBe('settled'));
  });

  it('creates an invoice to receive without any spending approval', async () => {
    const host = stubHost();
    await openShell();
    $<HTMLButtonElement>('[data-composer-mode="request"]')!.click();
    expect($('[data-spend]')).toBeNull();
    type('[data-request-amount]', '21');
    type('[data-request-note]', 'coffee');
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Create invoice'));
    submit();
    await vi.waitFor(() => expect(text('[data-bolt11]')).toBe('lntb210n1sample'));
    expect(host.used('invoice_create')[0].args).toEqual({ amount_msat: 21_000, note: 'coffee', expiry_secs: null });
    expect(host.used('spend_request')).toHaveLength(0);
    expect($('[data-artifact="invoice"] svg.qr')).not.toBeNull();
  });

  it.each(['invoice', 'keysend'])('explains a refused app %s and keeps its draft', async (method) => {
    const refuse = () => Promise.reject({ code: 'ceiling_exhausted', message: 'Your app principal limit is used up.' });
    const host = stubHost({ payment_pay: refuse, payment_keysend: refuse });
    host.spend.v = openView();
    await openShell();
    $<HTMLButtonElement>('[data-composer-mode="pay"]')!.click();
    if (method === 'invoice') {
      type('[data-pay-invoice]', 'lntb10n1abc');
      await vi.waitFor(() => expect(text('[data-send]')).toBe('Pay · 6 sats'));
    expect(text('[data-composer]')).toContain('up to 5 sats network fee');
    } else {
      [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Direct')!.click();
      type('[data-pay-pubkey]', '02' + 'ab'.repeat(32));
      type('[data-pay-amount]', '5');
    }
    submit();
    await confirmPay();
    await vi.waitFor(() => expect(text('[data-composer-note]')).toContain('Your app principal limit is used up.'));
    expect($('[data-artifact="payment"]')).toBeNull();
    expect($('[data-artifact="failed"]')).toBeNull();
    expect(method === 'invoice' ? $<HTMLTextAreaElement>('[data-pay-invoice]')!.value : $<HTMLInputElement>('[data-pay-amount]')!.value)
      .toBe(method === 'invoice' ? 'lntb10n1abc' : '5');
  });

  describe('amount-first Pay and Request', () => {
    afterEach(() => setDenom('sats'));
    const direct = () => [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Direct')!.click();
    const PUB = '02' + 'ab'.repeat(32);

    it('pays a BTC amount as exact msat, only on the confirm tap', async () => {
      const host = stubHost();
      host.spend.v = openView();
      setDenom('btc');
      await openShell();
      $<HTMLButtonElement>('[data-composer-mode="pay"]')!.click();
      direct();
      expect(text('.amount-unit')).toBe('BTC');
      type('[data-pay-amount]', '0.00000005');
      type('[data-pay-pubkey]', PUB);
      type('[data-pay-note]', 'lunch');
      await vi.waitFor(() => expect($('[data-cost-msat]')?.getAttribute('data-cost-msat')).toBe('10000'));
      submit();
      await vi.waitFor(() => expect($('[data-pay-review]')).not.toBeNull());
      expect(text('[data-review-amount]')).toBe('0.00000005 BTC');
      expect(text('[data-review-fee]')).toBe('up to 0.00000005 BTC');
      expect(text('[data-review-total]')).toBe('0.0000001 BTC');
      expect($('[data-pay-review]')!.getAttribute('data-review-max-msat')).toBe('10000');
      expect(text('[data-pay-review]')).toContain('lunch');
      expect(host.used('payment_keysend')).toHaveLength(0);
      await confirmPay();
      await vi.waitFor(() => expect(host.used('payment_keysend')[0]?.args).toEqual({ dest_pubkey: PUB, amount_msat: 5000, memo: 'lunch', max_msat: 10000 }));
      expect(host.used('payment_keysend')).toHaveLength(1);
      await vi.waitFor(() => expect($<HTMLInputElement>('[data-pay-amount]')!.value).toBe(''));
      expect($('[data-pay-review]')).toBeNull();
    });

    it('drops the review on any edit or Back, and pays nothing', async () => {
      const host = stubHost();
      host.spend.v = openView();
      await openShell();
      $<HTMLButtonElement>('[data-composer-mode="pay"]')!.click();
      direct();
      type('[data-pay-amount]', '21');
      type('[data-pay-pubkey]', PUB);
      submit();
      await vi.waitFor(() => expect(text('[data-review-amount]')).toBe('21 sats'));
      type('[data-pay-amount]', '210');
      expect($('[data-pay-review]')).toBeNull();
      submit();
      await vi.waitFor(() => expect(text('[data-review-amount]')).toBe('210 sats'));
      $<HTMLButtonElement>('[data-pay-back]')!.click();
      expect($('[data-pay-review]')).toBeNull();
      submit();
      await vi.waitFor(() => expect($('[data-pay-review]')).not.toBeNull());
      $<HTMLButtonElement>('[data-composer-mode="request"]')!.click();
      $<HTMLButtonElement>('[data-composer-mode="pay"]')!.click();
      expect($('[data-pay-review]')).toBeNull();
      expect(host.used('payment_keysend')).toHaveLength(0);
      expect(host.used('payment_pay')).toHaveLength(0);
    });

    // Codex #83 P1: reselecting the active mode or tab while a payment is in
    // flight must not leave a reusable review (or draft) that pays again.
    const deferred = () => {
      let resolve!: (v: unknown) => void;
      const reply = () => new Promise((r) => { resolve = r; });
      return { reply, done: (v: unknown) => resolve(v) };
    };
    const reselect = (tab: string | null, mode: 'pay' | 'request') => {
      $<HTMLButtonElement>(`[data-composer-mode="${mode}"]`)!.click();
      if (tab) [...mount.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].find((b) => b.textContent === tab)!.click();
    };
    const tryAgain = async () => {
      await new Promise((r) => setTimeout(r, 20));
      $<HTMLButtonElement>('[data-pay-confirm]')?.click();
      const send = $<HTMLButtonElement>('[data-send]');
      if (send && !send.disabled) send.click();
      await new Promise((r) => setTimeout(r, 20));
      $<HTMLButtonElement>('[data-pay-confirm]')?.click();
      await new Promise((r) => setTimeout(r, 20));
    };

    it.each([
      ['keysend', 'payment_keysend', 'Direct'],
      ['bolt11', 'payment_pay', 'Invoice'],
    ] as const)('pays a %s once when the active mode and tab are reselected mid-payment', async (_kind, cmd, tab) => {
      const d = deferred();
      const host = stubHost({ [cmd]: d.reply });
      host.spend.v = openView();
      await openShell();
      $<HTMLButtonElement>('[data-composer-mode="pay"]')!.click();
      if (tab === 'Direct') {
        direct();
        type('[data-pay-amount]', '5');
        type('[data-pay-pubkey]', PUB);
      } else {
        type('[data-pay-invoice]', 'lntb10n1abc');
        await vi.waitFor(() => expect(text('[data-send]')).toBe('Pay · 6 sats'));
      }
      submit();
      await confirmPay();
      await vi.waitFor(() => expect(host.used(cmd)).toHaveLength(1));
      expect($('[data-pay-confirm]')).toBeNull();
      reselect(tab, 'pay');
      $<HTMLButtonElement>('[data-pay-confirm]')?.click();
      d.done({ method: tab === 'Direct' ? 'keysend' : 'invoice', amount_msat: tab === 'Direct' ? 5000 : 1000, status: 'settled', paid_at_ms: Date.now() });
      await vi.waitFor(() => expect($('[data-artifact="payment"]')).not.toBeNull());
      await tryAgain();
      expect(host.used(cmd)).toHaveLength(1);
      expect($('[data-pay-confirm]')).toBeNull();
    });

    it('creates one invoice when the active Request mode is reselected mid-request', async () => {
      const d = deferred();
      const host = stubHost({ invoice_create: d.reply });
      await openShell();
      $<HTMLButtonElement>('[data-composer-mode="request"]')!.click();
      type('[data-request-amount]', '21');
      submit();
      await vi.waitFor(() => expect(host.used('invoice_create')).toHaveLength(1));
      reselect(null, 'request');
      d.done({ bolt11: 'lntb210n1sample', amount_msat: 21_000, note: null, expires_at_ms: Date.now() + 3_600_000 });
      await vi.waitFor(() => expect($('[data-artifact="invoice"]')).not.toBeNull());
      await tryAgain();
      expect(host.used('invoice_create')).toHaveLength(1);
    });

    it('refuses an amount finer than one msat instead of rounding it', async () => {
      const host = stubHost();
      host.spend.v = openView();
      await openShell();
      $<HTMLButtonElement>('[data-composer-mode="pay"]')!.click();
      direct();
      type('[data-pay-pubkey]', PUB);
      type('[data-pay-amount]', '0.0005');
      await vi.waitFor(() => expect($('[data-amount-invalid]')).not.toBeNull());
      expect($<HTMLButtonElement>('[data-send]')!.disabled).toBe(true);
      submit();
      expect($('[data-pay-review]')).toBeNull();
      type('[data-pay-amount]', '1');
      await vi.waitFor(() => expect($('[data-cost-msat]')?.getAttribute('data-cost-msat')).toBe('6000'));
      expect($('[data-amount-invalid]')).toBeNull();
      expect(host.used('payment_keysend')).toHaveLength(0);
    });

    it.each([
      ['sats', '0.999', 'Between 1 sat and 100,000,000 sats.'],
      ['sats', '100000000.001', 'Between 1 sat and 100,000,000 sats.'],
      ['btc', '1.00000000001', 'Between 0.00000001 BTC and 1 BTC.'],
      ['btc', '0.000000009', 'Between 0.00000001 BTC and 1 BTC.'],
    ] as const)('refuses %s %s outside the host bounds before review', async (unit, typed, message) => {
      const host = stubHost();
      host.spend.v = openView();
      setDenom(unit);
      await openShell();
      $<HTMLButtonElement>('[data-composer-mode="pay"]')!.click();
      direct();
      type('[data-pay-pubkey]', PUB);
      type('[data-pay-amount]', typed);
      await vi.waitFor(() => expect(text('[data-amount-invalid]')).toBe(message));
      expect($<HTMLButtonElement>('[data-send]')!.disabled).toBe(true);
      submit();
      expect($('[data-pay-review]')).toBeNull();
      $<HTMLButtonElement>('[data-composer-mode="request"]')!.click();
      type('[data-request-amount]', typed);
      await vi.waitFor(() => expect(text('[data-amount-invalid]')).toBe(message));
      expect($<HTMLButtonElement>('[data-send]')!.disabled).toBe(true);
      submit();
      await new Promise((r) => setTimeout(r, 0));
      expect(host.used('payment_keysend')).toHaveLength(0);
      expect(host.used('invoice_create')).toHaveLength(0);
    });

    it('keeps the same msat when the denomination switches', async () => {
      stubHost();
      await openShell();
      $<HTMLButtonElement>('[data-composer-mode="request"]')!.click();
      type('[data-request-amount]', '1500');
      setDenom('btc');
      await vi.waitFor(() => expect($<HTMLInputElement>('[data-request-amount]')!.value).toBe('0.000015'));
      setDenom('sats');
      await vi.waitFor(() => expect($<HTMLInputElement>('[data-request-amount]')!.value).toBe('1500'));
    });

    it('requests a BTC amount with a purpose and shows the invoice QR', async () => {
      const host = stubHost();
      setDenom('btc');
      await openShell();
      $<HTMLButtonElement>('[data-composer-mode="request"]')!.click();
      expect(text('[data-request-hint]')).toContain('Receiving is free');
      type('[data-request-amount]', '0.00000021');
      type('[data-request-note]', 'dinner');
      await vi.waitFor(() => expect(text('[data-send]')).toBe('Create invoice'));
      submit();
      await vi.waitFor(() => expect($('[data-artifact="invoice"] svg.qr')).not.toBeNull());
      expect(host.used('invoice_create')[0].args).toEqual({ amount_msat: 21_000, note: 'dinner', expiry_secs: null });
      expect(host.used('spend_request')).toHaveLength(0);
    });
  });

  it.each(['budget_exhausted', 'ceiling_exhausted'])('explains a refused file (%s) and keeps it selected', async (code) => {
    const host = stubHost({ file_send: () => Promise.reject({ code, message: 'The file exceeds your app limit. Raise the budget to send.' }) });
    host.spend.v = openView();
    await openShell();
    $<HTMLButtonElement>('[data-composer-mode="file"]')!.click();
    const input = $<HTMLInputElement>('[data-file-input]')!;
    Object.defineProperty(input, 'files', { value: [new File(['hi'], 'hi.txt', { type: 'text/plain' })] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    submit();
    await vi.waitFor(() => expect(text('[data-composer-note]')).toContain('Raise the budget to send.'));
    expect($('[data-artifact="file"]')).toBeNull();
    expect($('[data-artifact="failed"]')).toBeNull();
    expect($<HTMLButtonElement>('[data-send]')!.disabled).toBe(false);
    expect(input.files?.[0].name).toBe('hi.txt');
    expect(host.used('file_send')).toHaveLength(1);
  });

  it('sends a file at the node’s file price and displays paid admission and fee', async () => {
    const host = stubHost({ file_send: (args) => ({ message_id: 'file-1', recipient: args!.recipient, filename: args!.filename, size_bytes: 2, delivered: true, amount_msat: 3000, readmission_msat: 1000, fee_paid_msat: 375, total_msat: 8000, max_routing_fee_msat: 4000, sent_at_ms: Date.now() }) });
    host.spend.v = openView();
    await openShell();
    $<HTMLButtonElement>('[data-composer-mode="file"]')!.click();
    const input = $<HTMLInputElement>('[data-file-input]')!;
    Object.defineProperty(input, 'files', { value: [new File(['hi'], 'hi.txt', { type: 'text/plain' })] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Send file · 8 sats'));
    submit();
    await vi.waitFor(() => expect(host.used('file_send')[0]?.args).toEqual({ recipient: A, filename: 'hi.txt', mime_type: 'text/plain', data_b64: 'aGk=', max_msat: 8000, first_contact_msat: null }));
    await vi.waitFor(() => expect(text('[data-message="file-1"] .file-name')).toBe('hi.txt'));
    expect(text('[data-message="file-1"] .sats-meta')).toBe('paid 4.375 sats');
    expect($('[data-message="file-1"] .bubble')!.classList.contains('file')).toBe(true);
    expect($('[data-message="file-1"] [data-delivery]')?.getAttribute('data-delivery')).toBe('sent');
  });

  it('creates an invite from the New track once approved', async () => {
    const host = stubHost();
    await openShell();
    $<HTMLButtonElement>('[data-track="new"]')!.click();
    await vi.waitFor(() => expect($('[data-invite-create]')).not.toBeNull());
    expect(text('[data-invite-create] button')).toBe('Approve first');
    host.spend.v = openView();
    await vi.waitFor(() => expect(text('[data-invite-create] button')).toBe('Create invite'), { timeout: 5000 });
    type('[data-invitee]', A);
    type('[data-addr]', '203.0.113.5:9735');
    $<HTMLButtonElement>('[data-invite-create] button')!.click();
    await vi.waitFor(() => expect(text('[data-invite-link]')).toContain('bitsov://invite/tok'));
    expect(host.used('invite_create')[0].args).toEqual({ invitee: A, addr: '203.0.113.5:9735', hours: 72 });
  }, 10_000);

  it('says so plainly when the node cannot grant spending at all', async () => {
    const host = stubHost({
      spend_request: () =>
        view('unavailable', { pending: { op_id: 'cd', expires_at_ms: Date.now() + 900_000, owner_action: 'unavailable in this deployment: no owner control socket', owner_can_grant: false } }),
    });
    await openShell();
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Send'));
    host.spend.v = view('unavailable', { pending: { op_id: 'cd', expires_at_ms: Date.now() + 900_000, owner_action: 'unavailable in this deployment: no owner control socket', owner_can_grant: false } });
    submit();
    await vi.waitFor(() => expect(text('[data-approval="unavailable"]')).toContain('Receiving still works'));
    expect($('[data-spend="unavailable"]')).not.toBeNull();
  });
});

describe('sample source actions', () => {
  const MAYA = 'a'.repeat(64);
  const GAMMA = 'd'.repeat(64);
  const OFFLINE = 'c'.repeat(64);

  it('refuses to spend until the sample owner grants, then opens a ten-minute window', async () => {
    const s = sampleSource({ firstLiveMs: 1e9 });
    await expect(s.send(MAYA, false, 'x', 5000)).rejects.toMatchObject({ code: 'spend_locked' });
    expect((await s.spendRequest()).state).toBe('pending');
    expect((await s.spendStatus()).state).toBe('pending');
    const open = await s.spendStatus();
    expect(open.state).toBe('open');
    expect(open.open_until_ms! - Date.now()).toBeGreaterThan(590_000);
    expect((await s.spendLock()).state).toBe('locked');
  });

  it('delivers to Maya, rejects Gamma for underpaying, refuses an offline peer and a blocked room', async () => {
    vi.useFakeTimers();
    try {
      const s = sampleSource({ firstLiveMs: 1e9 });
      const events: LiveEvent[] = [];
      await s.onLive((e) => events.push(e));
      await s.spendRequest();
      await s.spendStatus();
      await s.spendStatus();

      const toMaya = await s.send(MAYA, false, 'gm', 10000);
      expect(toMaya.amount_msat).toBe(2000);
      const toGamma = await s.send(GAMMA, false, 'gm', 10000);
      expect(toGamma.amount_msat).toBe(1000);
      vi.advanceTimersByTime(1500);
      expect(events).toContainEqual({ type: 'delivery', message_id: toMaya.message_id, status: 'delivered', reason: null });
      expect(events).toContainEqual(expect.objectContaining({ type: 'delivery', message_id: toGamma.message_id, status: 'rejected' }));

      await expect(s.send(OFFLINE, false, 'gm', 10000)).rejects.toMatchObject({ code: 'node', message: expect.stringContaining('offline') });
      expect((await s.roomQuote(SAMPLE_ROOM_ID)).total_msat).toBe(13000);
      await expect(s.send(SAMPLE_OPEN_ROOM_ID, true, 'gm', 10000)).rejects.toMatchObject({ code: 'room_unreachable' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('issues unpayable sample invoices whose amount reads back, and pays only the amount shown', async () => {
    const s = sampleSource({ firstLiveMs: 1e9 });
    const inv = await s.invoiceCreate(21_000, 'coffee');
    expect(inv.bolt11).toContain('notpayable');
    expect(sampleInvoiceMsat(inv.bolt11)).toBe(21_000);
    expect(sampleInvoiceMsat('lnbc2500u1x')).toBe(250_000_000);
    expect(sampleInvoiceMsat('lnbc1x')).toBeNull();
    await s.spendRequest();
    await s.spendStatus();
    await s.spendStatus();
    await expect(s.pay(inv.bolt11, 20_000, 25_000)).rejects.toMatchObject({ code: 'invalid' });
    expect((await s.pay(inv.bolt11, 21_000, 26_000)).status).toBe('settled');
  });
});
