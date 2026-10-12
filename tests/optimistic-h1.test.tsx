// Optimistic send against H1: cards follow operation_id and message_id, the
// host's op list settles or restores them. Nothing here talks to a node.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';
import type { LiveEvent, OpList, OpView } from '../src/control/types';
import { asActionError } from '../src/control/state';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
let dispose: (() => void) | undefined;
let mount: HTMLElement;
afterEach(() => { dispose?.(); mount?.remove(); vi.restoreAllMocks(); });
const $ = <T extends HTMLElement = HTMLElement>(s: string) => mount.querySelector<T>(s);
const area = () => $<HTMLTextAreaElement>('[data-composer] textarea')!;
const type = (text: string) => { area().value = text; area().dispatchEvent(new Event('input', { bubbles: true })); };
const quote = { kind: 0, own_msat: 9000, peer_msat: 2250, peer_age_secs: 30, peer_stale: false, max_routing_fee_msat: 7500 };
const receipt = (id: string, recipient: string, extra: Record<string, unknown> = {}) => ({ message_id: id, recipient, is_room: false, delivered: true, amount_msat: 2250, fee_paid_msat: 0, max_routing_fee_msat: 7500, total_msat: 9750, sent_at_ms: Date.now(), ...extra });
const sending = () => [...mount.querySelectorAll('[data-sending]')];
const unsent = () => [...mount.querySelectorAll('[data-unsent]')];
const bubbles = (text: string) => [...mount.querySelectorAll('.msg.out .bubble')].filter((b) => b.textContent === text);
const go = async (key: string) => {
  await vi.waitFor(() => expect($(`[data-track="${key}"]`)).not.toBeNull());
  $<HTMLElement>(`[data-track="${key}"]`)!.click();
  await vi.waitFor(() => expect($(`[data-track="${key}"]`)?.getAttribute('aria-current')).toBe('true'));
};

type Pending = { recipient: string; text: string; caps: Record<string, number> | undefined; settle: (v: unknown) => void; fail: (e: unknown) => void };
function deferredSource() {
  const source = sampleSource({ firstLiveMs: 1e9 });
  source.spendStatus = async () => ({ state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 600000, pending: null, window_ms: 600000 });
  source.priceQuote = async () => quote;
  source.spendReconcile = vi.fn(async () => 'Previous action settled. Nothing was dispatched again.');
  const pending: Pending[] = [];
  source.send = vi.fn((recipient: string, _room: boolean, text: string, _max: number, caps?: Record<string, number>) =>
    new Promise((settle, fail) => pending.push({ recipient, text, caps, settle, fail }))) as never;
  let emit: (e: LiveEvent) => void = () => {};
  source.onLive = (handler) => { emit = handler; handler({ type: 'link', state: 'open', detail: null }); return Promise.resolve(() => {}); };
  return { source, pending, emit: (e: LiveEvent) => emit(e) };
}
async function open(source: ReturnType<typeof sampleSource>) {
  mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <ControlCenter source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
  await vi.waitFor(() => expect($(`[data-track="peer:${A}"]`)?.getAttribute('aria-current')).toBe('true'));
}
const press = async (text: string) => {
  type(text);
  await vi.waitFor(() => expect($('[data-send-price]')?.textContent).toMatch(/^up to/));
  $<HTMLButtonElement>('[data-send]')!.click();
};
const echo = (id: string, to: string, text: string, room: string | null = null): LiveEvent =>
  ({ type: 'message', room_id: room, message: { id, kind: 0, sender: SAMPLE_OWN_ID, recipient: to, timestamp: Date.now(), plaintext: text, payment_amount_msat: 2250 } });

const op = (over: Partial<OpView> = {}): OpView => ({ op_id: 'op-1', kind: 'message', peer: A, call_id: null, state: 'unknown', cap_msat: 9750, paid_msat: null, message_id: null, ...over });
const ops = (operations: OpView[]): OpList => ({ operations, skipped: 0, has_more: false });
const visible = (id: string) => $(`[data-message="${id}"]`) !== null;
const settleTick = () => new Promise((r) => setTimeout(r, 20));

describe('operation_id survives the host boundary', () => {
  it('asActionError keeps a non-empty operation_id and drops anything else', () => {
    expect(asActionError({ code: 'payment_unknown', message: 'x', operation_id: 'op-7' }).operation_id).toBe('op-7');
    expect(asActionError({ code: 'payment_unknown', message: 'x', operation_id: '' }).operation_id).toBeUndefined();
    expect(asActionError({ code: 'payment_unknown', message: 'x', operation_id: 7 }).operation_id).toBeUndefined();
  });
});

describe('the receipt decides which echo is whose (message_id, never text)', () => {
  it('same words from another device, then our own echo, with two of ours queued: each settles to its own message_id', async () => {
    const { source, pending, emit } = deferredSource();
    await open(source);
    await press('ok');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await press('ok');
    await vi.waitFor(() => expect(sending()).toHaveLength(2));
    // "ok" typed on the owner's phone arrives first: the first bubble takes it (a guess).
    emit(echo('phone-1', A, 'ok'));
    // Our first send's own echo: the first bubble already has a leg to A, so the second takes it.
    emit(echo('a-1', A, 'ok'));
    await settleTick();
    pending[0].settle(receipt('a-1', A, { operation_id: 'op-a' }));
    // The receipt names a-1: it shows now, not when the second send settles.
    await vi.waitFor(() => expect(visible('a-1')).toBe(true));
    expect(sending()).toHaveLength(1);
    // The phone's message moved to the one bubble still sending (still only a guess).
    expect(visible('phone-1')).toBe(false);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1].settle(receipt('b-1', A, { operation_id: 'op-b' }));
    await vi.waitFor(() => expect(sending()).toHaveLength(0));
    expect(visible('phone-1')).toBe(true);
    expect(visible('a-1')).toBe(true);
    expect(visible('b-1')).toBe(true);
    expect(bubbles('ok')).toHaveLength(3);
  });

  it('the receipt arriving after its echo was claimed by itself: one message, as before', async () => {
    const { source, pending, emit } = deferredSource();
    await open(source);
    await press('once');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    emit(echo('m-1', A, 'once'));
    await settleTick();
    pending[0].settle(receipt('m-1', A, { operation_id: 'op-1' }));
    await vi.waitFor(() => expect(sending()).toHaveLength(0));
    expect(bubbles('once')).toHaveLength(1);
  });
});

describe('one operation, one card', () => {
  it('an unknown result names its operation; a later receipt for the same operation replaces the card', async () => {
    const { source, pending } = deferredSource();
    await open(source);
    await press('lost reply');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0].fail({ code: 'payment_unknown', message: 'Outcome unknown.', operation_id: 'op-1' });
    await vi.waitFor(() => expect($('[data-artifact="failed"]')).not.toBeNull());
    expect($('[data-failed-check]')).not.toBeNull();
    // The owner checks the pending result (sends are held until then), then
    // presses again; the host retries the same operation (same id) and gets its receipt.
    await vi.waitFor(() => expect($('[data-spend-reconcile]')).not.toBeNull());
    $<HTMLButtonElement>('[data-spend-reconcile]')!.click();
    await vi.waitFor(() => expect(source.spendReconcile).toHaveBeenCalled());
    await press('lost reply');
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1].settle(receipt('m-1', A, { operation_id: 'op-1' }));
    await vi.waitFor(() => expect($('[data-artifact="failed"]')).toBeNull());
    expect(visible('m-1')).toBe(true);
  });

  it('a receipt for a different operation leaves the open card alone', async () => {
    const { source, pending } = deferredSource();
    await open(source);
    await press('first');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0].fail({ code: 'payment_unknown', message: 'Outcome unknown.', operation_id: 'op-1' });
    await vi.waitFor(() => expect($('[data-artifact="failed"]')).not.toBeNull());
    await vi.waitFor(() => expect($('[data-spend-reconcile]')).not.toBeNull());
    $<HTMLButtonElement>('[data-spend-reconcile]')!.click();
    await vi.waitFor(() => expect(source.spendReconcile).toHaveBeenCalled());
    await press('second');
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1].settle(receipt('m-2', A, { operation_id: 'op-2' }));
    await vi.waitFor(() => expect(visible('m-2')).toBe(true));
    expect($('[data-artifact="failed"]')).not.toBeNull();
  });
});

describe('the host op list (H1 op_list, read only)', () => {
  it('an unknown card learns the host\'s record when the chat is read again', async () => {
    const { source, pending } = deferredSource();
    let list = ops([]);
    source.opList = vi.fn(async () => list) as never;
    await open(source);
    await press('check me');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0].fail({ code: 'payment_unknown', message: 'Outcome unknown.', operation_id: 'op-1' });
    await vi.waitFor(() => expect($('[data-failed-check]')).not.toBeNull());
    list = ops([op({ state: 'unpaid' })]);
    await go(`peer:${B}`);
    await go(`peer:${A}`);
    await vi.waitFor(() => expect($('[data-failed-op="unpaid"]')).not.toBeNull());
    expect($('[data-failed-op]')!.textContent).toBe('This app’s record: not paid. Nothing left your wallet for it.');
    expect($('[data-failed-check]')).toBeNull();
    // The words are still there, and no resend is offered.
    expect($('[data-failed-text]')!.textContent).toBe('check me');
  });

  it('an op still open stays "check pending result" (unknown stays unknown)', async () => {
    const { source, pending } = deferredSource();
    let list = ops([]);
    source.opList = vi.fn(async () => list) as never;
    await open(source);
    await press('still open');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0].fail({ code: 'payment_unknown', message: 'Outcome unknown.', operation_id: 'op-1' });
    await vi.waitFor(() => expect($('[data-failed-check]')).not.toBeNull());
    list = ops([op({ state: 'dispatching' })]);
    await go(`peer:${B}`);
    await go(`peer:${A}`);
    await vi.waitFor(() => expect(source.opList).toHaveBeenCalledTimes(3));
    await settleTick();
    expect($('[data-failed-check]')).not.toBeNull();
    expect($('[data-failed-op]')).toBeNull();
  });

  it('after a restart: an open message op with no card comes back as a restored card (who, cap, state; no words, no resend)', async () => {
    const source = sampleSource({ firstLiveMs: 1e9 });
    source.opList = vi.fn(async (peer?: string) => ops([
      op({ op_id: 'op-open', state: 'unknown', cap_msat: 9750 }),
      op({ op_id: 'op-done', state: 'settled', paid_msat: 2250, message_id: 'm-done' }),
      op({ op_id: 'op-call', kind: 'call_offer', state: 'unknown' }),
      op({ op_id: 'op-other', peer: B, state: 'unknown' }),
    ].filter((o) => !peer || o.peer === peer))) as never;
    await open(source);
    await vi.waitFor(() => expect(mount.querySelectorAll('[data-artifact="restored"]')).toHaveLength(1));
    const card = $('[data-artifact="restored"]')!;
    expect(card.getAttribute('data-op-state')).toBe('unknown');
    expect(card.textContent).toContain('Message sent before this app restarted');
    expect(card.textContent).toContain('Up to 9.75 sats');
    expect($('[data-restored-state]')!.textContent).toBe('This app’s record: the result is not known yet. Check pending result before sending it again.');
    expect(card.querySelector('button')).toBeNull();
    expect(source.opList).toHaveBeenCalledWith(A);
  });

  it('a restored card is added once, and settles in place when the host learns the result', async () => {
    const source = sampleSource({ firstLiveMs: 1e9 });
    let list = ops([op({ op_id: 'op-open', state: 'unknown' })]);
    source.opList = vi.fn(async () => list) as never;
    await open(source);
    await vi.waitFor(() => expect($('[data-artifact="restored"]')).not.toBeNull());
    list = ops([op({ op_id: 'op-open', state: 'paid_undelivered', paid_msat: 2250 })]);
    await go(`peer:${B}`);
    await go(`peer:${A}`);
    await vi.waitFor(() => expect($('[data-artifact="restored"]')!.getAttribute('data-op-state')).toBe('paid_undelivered'));
    expect(mount.querySelectorAll('[data-artifact="restored"]')).toHaveLength(1);
    expect($('[data-restored-state]')!.textContent).toBe('This app’s record: paid 2.25 sats, not delivered.');
  });

  it('a send in flight is never restored beside its own bubble', async () => {
    const { source, pending } = deferredSource();
    let list = ops([]);
    source.opList = vi.fn(async () => list) as never;
    await open(source);
    await press('in flight');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    list = ops([op({ op_id: 'op-live', state: 'dispatching' })]);
    // The chat is read again while the send is out (the host lists it as dispatching).
    await go(`peer:${B}`);
    await go(`peer:${A}`);
    await vi.waitFor(() => expect(vi.mocked(source.opList).mock.calls.length).toBeGreaterThanOrEqual(2));
    await settleTick();
    expect($('[data-artifact="restored"]')).toBeNull();
    expect(sending()).toHaveLength(1);
    pending[0].settle(receipt('m-live', A, { operation_id: 'op-live' }));
    await vi.waitFor(() => expect(sending()).toHaveLength(0));
    expect($('[data-artifact="restored"]')).toBeNull();
  });

  it('a failed op list read changes nothing', async () => {
    const source = sampleSource({ firstLiveMs: 1e9 });
    source.opList = vi.fn(async () => { throw { code: 'spend_unknown', message: 'damaged' }; }) as never;
    await open(source);
    await vi.waitFor(() => expect(source.opList).toHaveBeenCalled());
    await settleTick();
    expect($('[data-artifact="restored"]')).toBeNull();
    expect($('[data-artifact="failed"]')).toBeNull();
  });
});
