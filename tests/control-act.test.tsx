import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import type { PairingView } from '../src/onboarding/pairing';
import { sampleInvoiceMsat, sampleSource, SAMPLE_OPEN_ROOM_ID, SAMPLE_ROOM_ID } from '../src/control/sample';
import type { LiveEvent, SpendView } from '../src/control/types';

// Slice B: acting from the track against a stubbed host whose spend window is
// stateful, plus the dev sample source on its own. No node, no network.

const OWN = '1'.repeat(64);
const A = 'a'.repeat(64);
const ROOM = '0f8e2b7a-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
const WINDOW = 600_000;

const paired: PairingView = { state: 'paired', scopes: ['read', 'receive'], short_code: 'ABCD-EFGH', code_from_node: true, reason: null, bootstrap: null };

type Call = { cmd: string; args: Record<string, unknown> | undefined };
type Reply = (args?: Record<string, unknown>) => unknown;

const view = (state: SpendView['state'], extra: Partial<SpendView> = {}): SpendView => ({
  state, basis: null, open_until_ms: null, pending: null, window_ms: WINDOW, ...extra,
});
const openView = () => view('open', { basis: 'node_grant', open_until_ms: Date.now() + WINDOW });

function stubHost(overrides: Record<string, Reply> = {}) {
  const calls: Call[] = [];
  const callbacks = new Map<number, (e: unknown) => void>();
  const spend = { v: view('locked') };
  const REPLIES: Record<string, Reply> = {
    node_status: () => ({ ready: true, node_id: OWN, error: null }),
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
    price_quote: () => ({ kind: 0, own_msat: 1000, peer_msat: 2000, peer_age_secs: 30, peer_stale: false }),
    payments_overview: () => ({ balance_msat: 1_000_000, lightning_outbound_msat: 500_000, channels: [] }),
    fund_state: () => null,
    file_price: () => ({ principal_msat: 3000, max_routing_fee_msat: 5000, total_msat: 8000 }),
    spend_status: () => spend.v,
    spend_request: () => {
      spend.v = view('pending', { pending: { op_id: 'ab12', expires_at_ms: Date.now() + 900_000, owner_action: 'konsensus grant --op ab12', owner_can_grant: true } });
      return spend.v;
    },
    spend_lock: () => (spend.v = view('locked')),
    message_send: (args) => ({ message_id: 'sent-1', recipient: args!.recipient, is_room: args!.is_room, delivered: true, amount_msat: 2000, sent_at_ms: Date.now() }),
    invoice_amount: (args) => (String(args!.bolt11).startsWith('lntb10n') ? { amount_msat: 1000, network: 'testnet' } : Promise.reject({ code: 'invalid', message: 'that is not a Lightning invoice' })),
    payment_pay: (args) => ({ method: 'invoice', amount_msat: args!.amount_msat, status: 'settled', paid_at_ms: Date.now() }),
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

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    mount?.remove();
    vi.unstubAllGlobals();
  });

  const $ = <T extends Element = HTMLElement>(sel: string) => mount.querySelector<T>(sel);
  const text = (sel: string) => $(sel)?.textContent ?? '';
  const type = (sel: string, value: string) => {
    const el = $<HTMLInputElement | HTMLTextAreaElement>(sel)!;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const submit = () => $<HTMLButtonElement>('[data-send]')!.click();

  async function openShell() {
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => <App />, mount);
    await vi.waitFor(() => expect([...mount.querySelectorAll('button')].some((b) => b.textContent?.includes('I understand'))).toBe(true));
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
    await vi.waitFor(() => expect($(`[data-track="peer:${A}"]`)?.getAttribute('aria-current')).toBe('true'));
    await vi.waitFor(() => expect($('[data-cost-msat]')?.getAttribute('data-cost-msat')).toBe('2000'));
  }

  it('asks the owner once, keeps the draft, then sends and shows the receipt and delivery', async () => {
    const host = stubHost();
    await openShell();
    type('[data-composer] textarea', 'gm Maya');

    // Locked: the button is the approval. Pressing it asks; it sends nothing.
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Approve spending'));
    submit();
    await vi.waitFor(() => expect(text('[data-owner-action]')).toBe('konsensus grant --op ab12'));
    expect(text('[data-approval="pending"]')).toContain('This app cannot approve it for you');
    expect(text('[data-send]')).toBe('Waiting for approval');
    expect($<HTMLButtonElement>('[data-send]')!.disabled).toBe(true);
    expect(host.used('message_send')).toHaveLength(0);
    expect($<HTMLTextAreaElement>('[data-composer] textarea')!.value).toBe('gm Maya');

    // The owner grants at their terminal; the next status poll opens the window.
    host.spend.v = openView();
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Send · ≈ 2 sats'), { timeout: 5000 });
    expect(text('[data-spend="open"]')).toContain('ten minutes per approval');

    submit();
    await vi.waitFor(() => expect(host.used('message_send')).toHaveLength(1));
    expect(host.used('message_send')[0].args).toEqual({ recipient: A, is_room: false, plaintext: 'gm Maya', max_msat: 2000, max_recipient_msat: null, first_contact_msat: null });
    await vi.waitFor(() => expect(text('[data-message="sent-1"] .stamp .sats')).toBe('2'));
    expect(text('[data-message="sent-1"] .stamp')).toContain('sats all-in ceiling');
    expect(text('[data-message="sent-1"] [data-delivery]')).toBe('sent, waiting for their node');
    expect($<HTMLTextAreaElement>('[data-composer] textarea')!.value).toBe('');

    host.emitLive({ type: 'delivery', message_id: 'sent-1', status: 'delivered', reason: null });
    await vi.waitFor(() => expect($('[data-message="sent-1"] [data-delivery]')?.getAttribute('data-delivery')).toBe('delivered'));

    // Lock now closes it again.
    $<HTMLButtonElement>('[data-spend-lock]')!.click();
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Approve spending'));
  }, 10_000);

  it('shows a rejection with the recipient node’s own reason', async () => {
    const host = stubHost();
    host.spend.v = openView();
    await openShell();
    type('[data-composer] textarea', 'hello');
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Send · ≈ 2 sats'));
    submit();
    await vi.waitFor(() => expect($('[data-message="sent-1"]')).not.toBeNull());
    host.emitLive({ type: 'delivery', message_id: 'sent-1', status: 'rejected', reason: 'insufficient payment: required 3000 msat, got 2000 msat' });
    await vi.waitFor(() => expect(text('[data-message="sent-1"] [data-delivery]')).toBe('rejected: insufficient payment: required 3000 msat, got 2000 msat'));
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
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Send · ≈ 2 sats'));
    host.spend.v = view('expired');
    submit();
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Approve spending'));
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
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Send · ≈ 2 sats'));
    submit();
    await vi.waitFor(() => expect(text('[data-artifact="failed"]')).toContain('no route'));
    expect(text('[data-artifact="failed"]')).toContain('Message not sent');
  });

  it('warns that first contact also pays an admission price', async () => {
    stubHost();
    await openShell();
    expect(text('[data-cost]')).toContain('First contact also pays their admission price once, at most 100 sats');
    expect(text('[data-cost-msat]')).toContain('≈');
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
      { state: 'acked', accepted: true, delivered: true, want: ['accepted', 'accepted by their node'] },
      { state: 'sent', accepted: false, delivered: true, want: ['sent', 'sent, waiting for their node'] },
      { state: 'paid', accepted: false, delivered: false, want: ['queued', 'queued until they reconnect'] },
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
      await vi.waitFor(() => expect(text('[data-send]')).toMatch(/^Send · (≈ )?2 sats$/));
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
      await vi.waitFor(() => expect(text('[data-send]')).toBe('Send · ≈ 2 sats'));
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
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Send · 2 sats'));
    submit();
    await vi.waitFor(() => expect(host.used('message_send')[0]?.args).toEqual({ recipient: ROOM, is_room: true, plaintext: 'room hello', max_msat: 2000, max_recipient_msat: { [A]: 2000 }, first_contact_msat: null }));
  });

  it('pays an invoice only after showing what it asks for', async () => {
    const host = stubHost();
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
    await vi.waitFor(() => expect(text('[data-composer-note]')).toContain('Your app principal limit is used up.'));
    expect($('[data-artifact="payment"]')).toBeNull();
    expect($('[data-artifact="failed"]')).toBeNull();
    expect(method === 'invoice' ? $<HTMLTextAreaElement>('[data-pay-invoice]')!.value : $<HTMLInputElement>('[data-pay-amount]')!.value)
      .toBe(method === 'invoice' ? 'lntb10n1abc' : '5');
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

  it('sends a file at the node’s file price', async () => {
    const host = stubHost();
    host.spend.v = openView();
    await openShell();
    $<HTMLButtonElement>('[data-composer-mode="file"]')!.click();
    const input = $<HTMLInputElement>('[data-file-input]')!;
    Object.defineProperty(input, 'files', { value: [new File(['hi'], 'hi.txt', { type: 'text/plain' })] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Send file · 8 sats'));
    submit();
    await vi.waitFor(() => expect(host.used('file_send')[0]?.args).toEqual({ recipient: A, filename: 'hi.txt', mime_type: 'text/plain', data_b64: 'aGk=', max_msat: 8000 }));
    await vi.waitFor(() => expect(text('[data-artifact="file"]')).toContain('hi.txt'));
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
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Approve spending'));
    host.spend.v = view('unavailable', { pending: { op_id: 'cd', expires_at_ms: Date.now() + 900_000, owner_action: 'unavailable in this deployment: no owner control socket', owner_can_grant: false } });
    submit();
    await vi.waitFor(() => expect(text('[data-approval="unavailable"]')).toContain('Receiving still works'));
    expect(text('[data-send]')).toBe('Spending unavailable');
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
