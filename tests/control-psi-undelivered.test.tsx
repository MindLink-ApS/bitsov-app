import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import type { PairingView } from '../src/onboarding/pairing';
import { admissionCopy, asActionError, undeliveredCopy } from '../src/control/state';
import type { LiveEvent, SpendView } from '../src/control/types';

// APP-PSI-MSG: the node settled payment but the message did not go (502
// `payment_settled_send_incomplete`, genome #100). Paid, not delivered: show the
// amount, never invite a second send, and offer Retry delivery only when the
// node said a retry re-sends its paid proof. Retry delivery pays nothing new
// (the host caps the node at zero); whatever is still due (the message, and
// admission again after a reconnect) the owner approves at the shown price, or
// stops retrying. Stop retrying names the host record the card is about.

const OWN = '1'.repeat(64);
const A = 'a'.repeat(64);
const ROOM = '0f8e2b7a-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
const WINDOW = 600_000;

const paired: PairingView = { state: 'paired', scopes: ['read', 'receive'], short_code: 'ABCD-EFGH', code_from_node: true, reason: null, remote: false, bootstrap: null };

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
    first_contact_request: () => null,
    first_contact_cancel: () => null,
    file_price: () => 3000,
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

const UNDELIVERED = (paid_msat: number, retry: boolean, pending_id = 'rec-1') => ({
  code: 'payment_settled_undelivered',
  message: `Payment settled (${paid_msat} msat paid), message not yet delivered.`,
  undelivered: { paid_msat, retry },
  pending_id,
});

describe('paid, not delivered: mapping and copy', () => {
  it('keeps the amount and the retry flag from the host error', () => {
    expect(asActionError(UNDELIVERED(2000, true))).toEqual(UNDELIVERED(2000, true));
    expect(asActionError({ code: 'payment_settled_undelivered', message: 'm', undelivered: { paid_msat: 2000, retry: 'yes' } }).undelivered).toEqual({ paid_msat: 2000, retry: false });
    expect(asActionError({ code: 'payment_settled_undelivered', message: 'm', undelivered: { paid_msat: -1, retry: true } }).undelivered).toBeUndefined();
    expect(asActionError({ code: 'node', message: 'm' })).toEqual({ code: 'node', message: 'm' });
    expect(asActionError({ code: 'undelivered_pending', message: 'm', pending_id: 7 }).pending_id).toBeUndefined();
  });

  it('keeps an admission price only when it adds up', () => {
    const admission = { admission_msat: 2000, message_msat: 2000, max_routing_fee_msat: 10000, total_msat: 14000, quoted: true };
    expect(asActionError({ code: 'retry_needs_admission', message: 'm', admission }).admission).toEqual(admission);
    expect(asActionError({ code: 'retry_needs_admission', message: 'm', admission: { ...admission, total_msat: 3000 } }).admission).toBeUndefined();
    expect(asActionError({ code: 'retry_needs_admission', message: 'm', admission: { ...admission, quoted: 'yes' } }).admission?.quoted).toBe(false);
    for (const fee of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(asActionError({ code: 'retry_needs_admission', message: 'm', admission: { ...admission, max_routing_fee_msat: fee } }).admission).toBeUndefined();
    }
  });

  it('shows the price to approve, and never promises what the node does not enforce', () => {
    const quoted = admissionCopy({ admission_msat: 1500, message_msat: 2000, total_msat: 3500, quoted: true });
    // The ceiling rounds up, never down: 3.5 sats is shown as about 4.
    expect(quoted.body).toBe('Needs up to about 4 sats more (admission + message + fees).');
    expect(quoted.detail).toContain('1.5 sats to be admitted again, then 2 sats for this message');
    expect(quoted.action).toBe('Approve up to about 4 sats and retry');
    const estimate = admissionCopy({ admission_msat: 2000, message_msat: 2000, total_msat: 4000, quoted: false });
    expect(estimate.body).toContain('about 4 sats more if admission is due again');
    expect(estimate.detail).toContain('refuses before paying if the real price is higher');
  });

  it('says paid, not delivered, and never to send again', () => {
    const retry = undeliveredCopy({ paid_msat: 2000, retry: true });
    expect(retry.title).toBe('Paid 2 sats · not delivered yet');
    expect(retry.body).toBe('Do not send again. Retry delivery pays nothing new.');
    expect(retry.detail).toContain('Retry re-sends the proof already paid for');
    expect(retry.detail).toContain('asks first with the price');
    expect(retry.body).not.toContain('no second admission');
    const stop = undeliveredCopy({ paid_msat: 1500, retry: false });
    expect(stop.title).toBe('Paid about 2 sats · not delivered yet');
    expect(stop.body).toContain('Do not send again');
    expect(stop.body).toContain('pay twice');
    expect(stop.body).not.toContain('Retry');
    expect(undeliveredCopy({ paid_msat: 1000, retry: true }).title).toBe('Paid 1 sat · not delivered yet');
    for (const c of [retry, stop]) expect(`${c.title} ${c.body}`.toLowerCase()).not.toMatch(/not sent|try sending|send it again to/);
  });
});

describe('paid, not delivered: in the conversation', () => {
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

  async function sendUndelivered(host: ReturnType<typeof stubHost>) {
    host.spend.v = openView();
    await openShell();
    type('[data-composer] textarea', 'hello Maya');
    submit();
    await vi.waitFor(() => expect($('[data-artifact="undelivered"]')).not.toBeNull());
  }

  it('shows the amount paid, moves the draft to the card, and retries through compose once', async () => {
    // A zero-price contact: the zero-capped retry delivers.
    const host = stubHost({
      message_send: () => { throw UNDELIVERED(2000, true); },
      message_retry: (args) => ({ message_id: 'sent-2', recipient: args!.recipient, is_room: false, delivered: true, amount_msat: 2000, sent_at_ms: Date.now() }),
    });
    await sendUndelivered(host);
    const card = text('[data-artifact="undelivered"]');
    expect(card).toContain('Paid 2 sats · not delivered yet');
    expect(card).toContain('Do not send again');
    expect($('[data-artifact="undelivered"]')!.getAttribute('data-paid-msat')).toBe('2000');
    expect($('[data-artifact="failed"]')).toBeNull();
    // The draft is paid for: it is not left in the composer to be sent twice.
    expect($<HTMLTextAreaElement>('[data-composer] textarea')!.value).toBe('');

    $<HTMLButtonElement>('[data-retry-delivery]')!.click();
    await vi.waitFor(() => expect($('[data-artifact="undelivered"]')).toBeNull());
    expect(host.used('message_retry').map((c) => c.args)).toEqual([{ recipient: A, plaintext: 'hello Maya', approved_msat: null }]);
    expect(host.used('message_send')).toHaveLength(1);
    await vi.waitFor(() => expect(mount.textContent).toContain('hello Maya'));
  });

  it('offers no retry when the node did not say it will not pay again', async () => {
    const host = stubHost({ message_send: () => { throw UNDELIVERED(4000, false); } });
    await sendUndelivered(host);
    expect(text('[data-artifact="undelivered"]')).toContain('Paid 4 sats · not delivered yet');
    expect(text('[data-artifact="undelivered"]')).toContain('that could pay twice');
    expect($('[data-retry-delivery]')).toBeNull();
    expect(host.used('message_retry')).toHaveLength(0);
  });

  it('asks for approval with the price when a payment is still due, then retries once at that cap', async () => {
    const admission = { admission_msat: 2000, message_msat: 2000, max_routing_fee_msat: 10000, total_msat: 14000, quoted: true };
    const host = stubHost({
      message_send: () => { throw UNDELIVERED(2000, true); },
      message_retry: (args) => {
        if (args!.approved_msat === null) throw { code: 'retry_needs_admission', message: 'Retry delivery paid nothing new. Delivering the message needs a new payment. Nothing was paid.', admission };
        return { message_id: 'sent-3', recipient: args!.recipient, is_room: false, delivered: true, amount_msat: 4000, max_routing_fee_msat: 10000, total_msat: 14000, sent_at_ms: Date.now() };
      },
    });
    await sendUndelivered(host);
    $<HTMLButtonElement>('[data-retry-delivery]')!.click();
    await vi.waitFor(() => expect($('[data-retry-approve]')).not.toBeNull());
    // Nothing paid yet: the price is shown, and the free retry is gone.
    expect(text('[data-retry-note]')).toContain('Nothing was paid');
    expect($('[data-admission-price]')!.getAttribute('data-admission-price')).toBe('14000');
    expect(text('[data-admission-line]')).toContain('Needs up to 14 sats more');
    expect(text('[data-admission-detail]')).toContain('2 sats to be admitted again, then 2 sats for this message');
    expect(text('[data-admission-detail]')).toContain('up to 10 sats network fees (14 sats in all)');
    expect($('[data-retry-delivery]')).toBeNull();
    expect(text('[data-retry-approve]')).toBe('Approve up to 14 sats and retry');

    $<HTMLButtonElement>('[data-retry-approve]')!.click();
    await vi.waitFor(() => expect($('[data-artifact="undelivered"]')).toBeNull());
    expect(host.used('message_retry').map((c) => c.args!.approved_msat)).toEqual([null, 14000]);
    $<HTMLButtonElement>('article.msg.out .sats-meta')!.click();
    expect(text('article.msg.out')).toContain('paid 4 sats · network fee amount unknown');
    expect(host.used('message_send')).toHaveLength(1);
    await vi.waitFor(() => expect(mount.textContent).toContain('hello Maya'));
  });

  it('stops retrying on the owner’s word, without dispatching anything', async () => {
    const host = stubHost({
      message_send: () => { throw UNDELIVERED(2000, true); },
      spend_dismiss_undelivered: () => 'Stopped retrying. 2000 msat was paid and the message was not delivered; nothing more will be paid for it.',
    });
    await sendUndelivered(host);
    $<HTMLButtonElement>('[data-stop-retrying]')!.click();
    await vi.waitFor(() => expect($('[data-artifact="undelivered"]')).toBeNull());
    expect(host.used('spend_dismiss_undelivered').map((c) => c.args)).toEqual([{ pending_id: 'rec-1' }]);
    expect(host.used('message_retry')).toHaveLength(0);
    expect(host.used('message_send')).toHaveLength(1);
    await vi.waitFor(() => expect(mount.textContent).toContain('nothing more will be paid for it'));
  });

  it('keeps one card and one retry when delivery is still incomplete', async () => {
    const host = stubHost({
      message_send: () => { throw UNDELIVERED(2000, true); },
      message_retry: () => { throw UNDELIVERED(2000, true); },
    });
    await sendUndelivered(host);
    $<HTMLButtonElement>('[data-retry-delivery]')!.click();
    await vi.waitFor(() => expect(text('[data-retry-note]')).toContain('Still not delivered. Paid for this message so far: 2 sats.'));
    expect(mount.querySelectorAll('[data-artifact="undelivered"]')).toHaveLength(1);
    expect(text('[data-artifact="undelivered"]')).toContain('Paid 2 sats');
    expect($('[data-retry-delivery]')).not.toBeNull();
    expect(host.used('message_retry')).toHaveLength(1);
  });

  // Codex review of 0308673 (P2): a stale card names its own record, so the
  // host refuses it instead of releasing a different unresolved message.
  it('a stale card never stops retrying a different message', async () => {
    let current: string | null = null;
    let n = 0;
    const host = stubHost({
      message_send: () => { current = `rec-${++n}`; throw UNDELIVERED(2000, true, current); },
      spend_dismiss_undelivered: (args) => {
        if (args!.pending_id !== current) throw { code: 'retry_unavailable', message: 'That message is no longer waiting for delivery. Nothing was changed.' };
        current = null;
        return 'Stopped retrying.';
      },
    });
    await sendUndelivered(host);
    type('[data-composer] textarea', 'second message');
    submit();
    await vi.waitFor(() => expect(mount.querySelectorAll('[data-artifact="undelivered"]')).toHaveLength(2));
    // The first card is stale: the host now holds rec-2.
    mount.querySelectorAll<HTMLButtonElement>('[data-artifact="undelivered"] [data-stop-retrying]')[0].click();
    await vi.waitFor(() => expect(host.used('spend_dismiss_undelivered')).toHaveLength(1));
    expect(host.used('spend_dismiss_undelivered')[0].args).toEqual({ pending_id: 'rec-1' });
    expect(current).toBe('rec-2');
    await vi.waitFor(() => expect(mount.querySelectorAll('[data-artifact="undelivered"]')).toHaveLength(2));
  });

  it('stopping from the pending check names the record it showed and ends its card', async () => {
    const host = stubHost({
      message_send: () => { throw UNDELIVERED(2000, true, 'rec-9'); },
      spend_reconcile: () => { throw { code: 'undelivered_pending', message: 'Accounted: 2000 msat paid, and the message is still not delivered.', pending_id: 'rec-9' }; },
      spend_dismiss_undelivered: () => 'Stopped retrying.',
    });
    await sendUndelivered(host);
    $<HTMLButtonElement>('[data-spend-reconcile]')!.click();
    await vi.waitFor(() => expect(mount.querySelectorAll('[data-stop-retrying]')).toHaveLength(2));
    const panelStop = [...mount.querySelectorAll<HTMLButtonElement>('[data-stop-retrying]')].find((b) => !b.closest('[data-artifact]'))!;
    panelStop.click();
    await vi.waitFor(() => expect($('[data-artifact="undelivered"]')).toBeNull());
    expect(host.used('spend_dismiss_undelivered').map((c) => c.args)).toEqual([{ pending_id: 'rec-9' }]);
  });
  it('invalidates a reconciliation snapshot when its card is dismissed before an identical send', async () => {
    let pending: string | null = null;
    let sends = 0;
    const host = stubHost({
      message_send: () => {
        pending = `attempt-${++sends}`;
        throw UNDELIVERED(2000, true, pending);
      },
      spend_reconcile: () => { throw { code: 'undelivered_pending', message: 'Paid, undelivered', pending_id: pending }; },
      spend_dismiss_undelivered: (args) => {
        if (args!.pending_id !== pending) throw { code: 'retry_unavailable', message: 'not matching' };
        pending = null;
        return 'Stopped retrying.';
      },
    });
    await sendUndelivered(host);
    $<HTMLButtonElement>('[data-spend-reconcile]')!.click();
    await vi.waitFor(() => expect(mount.querySelectorAll('[data-stop-retrying]')).toHaveLength(2));
    $<HTMLButtonElement>('[data-artifact="undelivered"] [data-stop-retrying]')!.click();
    await vi.waitFor(() => expect(mount.querySelectorAll('[data-stop-retrying]')).toHaveLength(0));
    type('[data-composer] textarea', 'hello Maya'); submit();
    await vi.waitFor(() => expect($('[data-artifact="undelivered"]')).not.toBeNull());
    expect(mount.querySelectorAll('[data-stop-retrying]')).toHaveLength(1);
    expect(pending).toBe('attempt-2');
    expect(host.used('message_send')[0].args).toEqual(host.used('message_send')[1].args);
  });

  it('renews paired contact approval before retrying the same pending message', async () => {
    let ready = false;
    const approval = { id: 'renewal', owner_command: 'approve at node', ready: false, expires_at_ms: Date.now() + 120000,
      request: { client_id: 'c1', grant_op_id: 'ab12', recipient: A, max_total_msat: 14000, contact_budget_msat: 14000 } };
    const host = stubHost({
      message_send: () => { throw UNDELIVERED(2000, true); },
      message_retry: (args) => {
        if (args!.approved_msat === null) throw { code: 'retry_needs_admission', message: 'Approval needed',
          admission: { admission_msat: 2000, message_msat: 2000, max_routing_fee_msat: 10000, total_msat: 14000, quoted: true } };
        return { message_id: 'renewed', recipient: A, is_room: false, delivered: true, amount_msat: 4000, max_routing_fee_msat: 10000, total_msat: 14000, sent_at_ms: Date.now() };
      },
      first_contact_request: () => approval,
      first_contact_status: () => ({ ...approval, ready }),
    });
    await sendUndelivered(host);
    $<HTMLButtonElement>('[data-retry-delivery]')!.click();
    await vi.waitFor(() => expect($('[data-retry-approve]')).not.toBeNull());
    $<HTMLButtonElement>('[data-retry-approve]')!.click();
    await vi.waitFor(() => expect(text('[data-retry-owner]')).toContain('approve at node'));
    expect(host.used('message_retry')).toHaveLength(1);
    expect(host.used('first_contact_request')[0].args).toEqual({ recipient: A, max_msat: 14000, contact_budget_msat: null });
    $<HTMLButtonElement>('[data-retry-approve]')!.click();
    await vi.waitFor(() => expect(host.used('first_contact_status')).toHaveLength(1));
    expect(host.used('message_retry')).toHaveLength(1);
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-retry-approve]')!.disabled).toBe(false));
    ready = true;
    $<HTMLButtonElement>('[data-retry-approve]')!.click();
    await vi.waitFor(() => expect($('[data-artifact="undelivered"]')).toBeNull());
    expect(host.used('message_retry').map((c) => c.args!.approved_msat)).toEqual([null, 14000]);
    expect(host.used('message_send')).toHaveLength(1);
  });

});
