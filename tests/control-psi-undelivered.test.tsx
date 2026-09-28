import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import type { PairingView } from '../src/onboarding/pairing';
import { admissionCopy, asActionError, undeliveredCopy } from '../src/control/state';
import type { LiveEvent, SpendView } from '../src/control/types';

// APP-PSI-MSG: the node settled payment but the message did not go (502
// `payment_settled_send_incomplete`, genome #100). Paid, not delivered: show the
// amount, never invite a second send, and offer Retry delivery only when the
// node said a retry re-sends its paid proof. Genome #100: a retry on the same
// connection pays only the message; when admission is due again the host
// stops before paying and the owner approves the shown price, or stops retrying.

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

const UNDELIVERED = (paid_msat: number, retry: boolean) => ({
  code: 'payment_settled_undelivered',
  message: `Payment settled (${paid_msat} msat paid), message not yet delivered.`,
  undelivered: { paid_msat, retry },
});

describe('paid, not delivered: mapping and copy', () => {
  it('keeps the amount and the retry flag from the host error', () => {
    expect(asActionError(UNDELIVERED(2000, true))).toEqual(UNDELIVERED(2000, true));
    expect(asActionError({ code: 'payment_settled_undelivered', message: 'm', undelivered: { paid_msat: 2000, retry: 'yes' } }).undelivered).toEqual({ paid_msat: 2000, retry: false });
    expect(asActionError({ code: 'payment_settled_undelivered', message: 'm', undelivered: { paid_msat: -1, retry: true } }).undelivered).toBeUndefined();
    expect(asActionError({ code: 'node', message: 'm' })).toEqual({ code: 'node', message: 'm' });
  });

  it('keeps an admission price only when it adds up', () => {
    const admission = { admission_msat: 2000, message_msat: 2000, total_msat: 4000, quoted: true };
    expect(asActionError({ code: 'retry_needs_admission', message: 'm', admission }).admission).toEqual(admission);
    expect(asActionError({ code: 'retry_needs_admission', message: 'm', admission: { ...admission, total_msat: 3000 } }).admission).toBeUndefined();
    expect(asActionError({ code: 'retry_needs_admission', message: 'm', admission: { ...admission, quoted: 'yes' } }).admission?.quoted).toBe(false);
  });

  it('shows the admission price to approve, and never promises what the node does not enforce', () => {
    const quoted = admissionCopy({ admission_msat: 1500, message_msat: 2000, total_msat: 3500, quoted: true });
    expect(quoted.body).toContain('their price is 1.5 sats to be admitted, then 2 sats for this message');
    expect(quoted.action).toBe('Approve up to 3.5 sats and retry');
    const estimate = admissionCopy({ admission_msat: 2000, message_msat: 2000, total_msat: 4000, quoted: false });
    expect(estimate.body).toContain('about 2 sats (what it cost before)');
    expect(estimate.body).toContain('refuses before paying if the real price is higher');
  });

  it('says paid, not delivered, and never to send again', () => {
    const retry = undeliveredCopy({ paid_msat: 2000, retry: true });
    expect(retry.title).toBe('Paid 2 sats · not delivered yet');
    expect(retry.body).toContain('Payment settled, message not yet delivered. Do not send it again.');
    expect(retry.body).toContain('Retry delivery reuses this same payment');
    expect(retry.body).toContain('pays only this message’s price');
    expect(retry.body).toContain('asks you first, with the price');
    expect(retry.body).not.toContain('no second admission');
    const stop = undeliveredCopy({ paid_msat: 1500, retry: false });
    expect(stop.title).toBe('Paid 1.5 sats · not delivered yet');
    expect(stop.body).toContain('Do not send it again: that could pay twice.');
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
    const host = stubHost({
      message_send: () => { throw UNDELIVERED(2000, true); },
      message_retry: (args) => ({ message_id: 'sent-2', recipient: args!.recipient, is_room: false, delivered: true, amount_msat: 2000, sent_at_ms: Date.now() }),
    });
    await sendUndelivered(host);
    const card = text('[data-artifact="undelivered"]');
    expect(card).toContain('Paid 2 sats · not delivered yet');
    expect(card).toContain('Do not send it again');
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

  it('asks for approval with the price when admission may be due again, then retries once at that cap', async () => {
    const admission = { admission_msat: 2000, message_msat: 2000, total_msat: 4000, quoted: true };
    const host = stubHost({
      message_send: () => { throw UNDELIVERED(2000, true); },
      message_retry: (args) => {
        if (args!.approved_msat === null) throw { code: 'retry_needs_admission', message: 'Your node may have to pay this contact’s admission again before the message can go. Nothing was paid.', admission };
        return { message_id: 'sent-3', recipient: args!.recipient, is_room: false, delivered: true, amount_msat: 4000, sent_at_ms: Date.now() };
      },
    });
    await sendUndelivered(host);
    $<HTMLButtonElement>('[data-retry-delivery]')!.click();
    await vi.waitFor(() => expect($('[data-retry-approve]')).not.toBeNull());
    // Nothing paid yet: the price is shown, and the free retry is gone.
    expect(text('[data-retry-note]')).toContain('Nothing was paid');
    expect($('[data-admission-price]')!.getAttribute('data-admission-price')).toBe('4000');
    expect(text('[data-admission-price]')).toContain('their price is 2 sats to be admitted, then 2 sats for this message');
    expect($('[data-retry-delivery]')).toBeNull();
    expect(text('[data-retry-approve]')).toBe('Approve up to 4 sats and retry');

    $<HTMLButtonElement>('[data-retry-approve]')!.click();
    await vi.waitFor(() => expect($('[data-artifact="undelivered"]')).toBeNull());
    expect(host.used('message_retry').map((c) => c.args!.approved_msat)).toEqual([null, 4000]);
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
    expect(host.used('spend_dismiss_undelivered')).toHaveLength(1);
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
});
