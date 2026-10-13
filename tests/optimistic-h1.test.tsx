// Optimistic send against H1: cards follow operation_id and message_id, the
// host's op list settles or restores them. Nothing here talks to a node.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID, SAMPLE_PRESETS } from '../src/control/sample';
import type { BudgetView, LiveEvent, OpList, OpView, OwnerContactApproval } from '../src/control/types';
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

describe('an error names an operation; it never identifies the card (Codex #221 r1 #2)', () => {
  it('a later receipt for the operation an unknown card names leaves that card and its words alone', async () => {
    const { source, pending } = deferredSource();
    await open(source);
    await press('lost reply');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0].fail({ code: 'payment_unknown', message: 'Outcome unknown.', operation_id: 'op-1' });
    await vi.waitFor(() => expect($('[data-artifact="failed"]')).not.toBeNull());
    await vi.waitFor(() => expect($('[data-spend-reconcile]')).not.toBeNull());
    $<HTMLButtonElement>('[data-spend-reconcile]')!.click();
    await vi.waitFor(() => expect(source.spendReconcile).toHaveBeenCalled());
    await press('second');
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1].settle(receipt('m-2', A, { operation_id: 'op-1' }));
    await vi.waitFor(() => expect(visible('m-2')).toBe(true));
    expect($('[data-artifact="failed"] [data-failed-text]')!.textContent).toBe('lost reply');
  });

  it.each([
    ['failed_paid', { code: 'failed_paid', message: 'Paid; their node refused it.' }, 'failed'],
    ['payment_unknown', { code: 'payment_unknown', message: 'Outcome unknown.' }, 'failed'],
    ['payment_settled_undelivered', { code: 'payment_settled_undelivered', message: 'Paid, not delivered.', undelivered: { paid_msat: 2250, retry: true } }, 'undelivered'],
  ] as const)('r2 #1: %s on an operation id seen before the press (a resend reusing op-X) is never "not sent, nothing paid", and never offers its words back', async (_code, error, card) => {
    const { source, pending } = deferredSource();
    source.opList = vi.fn(async () => ops([op({ op_id: 'op-X', state: 'paid_undelivered', paid_msat: 2250 })])) as never;
    await open(source);
    await vi.waitFor(() => expect($('[data-artifact="restored"]')).not.toBeNull());
    await press('same words');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0].fail({ ...error, operation_id: 'op-X' });
    await vi.waitFor(() => expect(sending()).toHaveLength(0));
    expect(unsent()).toHaveLength(0);
    expect($('[data-unsent-restore]')).toBeNull();
    expect(mount.textContent).not.toContain('nothing paid');
    expect($(`[data-artifact="${card}"]`)).not.toBeNull();
    expect(area().value).toBe('');
  });
});

describe('Codex #221 r1: stale snapshots, honest states, nothing vanishes', () => {
  it('#3 a snapshot from before the receipt (dispatching, no message_id) never restores a receipted op', async () => {
    const { source, pending } = deferredSource();
    let finishRead!: (l: OpList) => void;
    let first = true;
    source.opList = vi.fn(() => first ? (first = false, Promise.resolve(ops([]))) : new Promise<OpList>((r) => { finishRead = r; })) as never;
    await open(source);
    await press('confirmed');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    // A read starts while the send is out ...
    await go(`peer:${B}`);
    await go(`peer:${A}`);
    await vi.waitFor(() => expect(finishRead).toBeDefined());
    // ... the receipt arrives, then the old snapshot.
    pending[0].settle(receipt('m-c', A, { operation_id: 'op-c' }));
    await vi.waitFor(() => expect(sending()).toHaveLength(0));
    finishRead(ops([op({ op_id: 'op-c', state: 'dispatching' })]));
    await settleTick();
    expect($('[data-artifact="restored"]')).toBeNull();
    expect(visible('m-c')).toBe(true);
  });

  it('#4 settled is said in accounting terms only (it also covers stopped retries): never "sent"', async () => {
    const source = sampleSource({ firstLiveMs: 1e9 });
    let list = ops([op({ op_id: 'op-u', state: 'paid_undelivered', paid_msat: 2250 })]);
    source.opList = vi.fn(async () => list) as never;
    await open(source);
    await vi.waitFor(() => expect($('[data-artifact="restored"]')).not.toBeNull());
    list = ops([op({ op_id: 'op-u', state: 'settled', paid_msat: 2250 })]);
    await go(`peer:${B}`);
    await go(`peer:${A}`);
    await vi.waitFor(() => expect($('[data-restored-state]')!.textContent).toBe('This app’s record: paid 2.25 sats, finished. Delivery is not confirmed here.'));
    expect($('[data-artifact="restored"]')!.textContent).not.toMatch(/\bsent,|delivered\./);
  });

  it('#5 paid and paid-undelivered operations come back after a restart, each said as it is', async () => {
    const source = sampleSource({ firstLiveMs: 1e9 });
    source.opList = vi.fn(async () => ops([
      op({ op_id: 'op-p', state: 'paid', paid_msat: 2250 }),
      op({ op_id: 'op-pu', state: 'paid_undelivered', paid_msat: 2250 }),
      op({ op_id: 'op-done', state: 'failed_paid', paid_msat: 2250 }),
      op({ op_id: 'op-unpaid', state: 'unpaid' }),
    ])) as never;
    await open(source);
    await vi.waitFor(() => expect(mount.querySelectorAll('[data-artifact="restored"]')).toHaveLength(2));
    const states = [...mount.querySelectorAll('[data-artifact="restored"]')].map((c) => c.getAttribute('data-op-state')).sort();
    expect(states).toEqual(['paid', 'paid_undelivered']);
    const texts = [...mount.querySelectorAll('[data-restored-state]')].map((c) => c.textContent);
    expect(texts).toContain('This app’s record: paid 2.25 sats; delivery not confirmed yet. Check pending result.');
    expect(texts).toContain('This app’s record: paid 2.25 sats, not delivered. Check pending result to retry delivery or stop retrying.');
  });

  it('Fable: a message held behind a paid-not-delivered one says so (not "result not known")', async () => {
    const { source, pending } = deferredSource();
    await open(source);
    await press('paid one');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await press('behind it');
    await vi.waitFor(() => expect(sending()).toHaveLength(2));
    pending[0].fail({ code: 'payment_settled_undelivered', message: 'Paid, not delivered.', undelivered: { paid_msat: 2250, retry: true }, operation_id: 'op-pu' });
    await vi.waitFor(() => expect(unsent()).toHaveLength(1));
    expect($('[data-unsent="held"] [data-unsent-reason]')!.textContent).toContain('an earlier message was paid but not delivered');
    expect(pending).toHaveLength(1);
  });
});

describe('Codex #221 r2 #2: every receipt path confirms its operation', () => {
  it('a delivered retry is confirmed: a later paid_undelivered snapshot of it never comes back beside the message', async () => {
    const { source, pending } = deferredSource();
    let list = ops([]);
    source.opList = vi.fn(async () => list) as never;
    source.retry = vi.fn(async () => receipt('m-retried', A, { operation_id: 'op-u' })) as never;
    await open(source);
    await press('paid once');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0].fail({ code: 'payment_settled_undelivered', message: 'Paid, not delivered.', undelivered: { paid_msat: 2250, retry: true }, operation_id: 'op-u' });
    await vi.waitFor(() => expect($('[data-retry-delivery]')).not.toBeNull());
    $<HTMLButtonElement>('[data-retry-delivery]')!.click();
    await vi.waitFor(() => expect(visible('m-retried')).toBe(true));
    // A snapshot from before the retry settled arrives late.
    list = ops([op({ op_id: 'op-u', state: 'paid_undelivered', paid_msat: 2250 })]);
    await go(`peer:${B}`);
    await go(`peer:${A}`);
    await vi.waitFor(() => expect(vi.mocked(source.opList).mock.calls.length).toBeGreaterThanOrEqual(2));
    await settleTick();
    expect($('[data-artifact="restored"]')).toBeNull();
    expect(visible('m-retried')).toBe(true);
  });
});

describe('Codex #221 r3 (exception round)', () => {
  it.each([
    ['budget_unreadable', 'Your budget file could not be read.'],
    ['app_not_ready', 'No app storage.'],
    ['node', 'connection reset'],
    ['some_future_code', 'Something new.'],
  ])('#1 %s is not proven unpaid: the words stay on a "check pending result" card, never back in the box, never resendable, and the next send waits', async (code, message) => {
    const { source, pending } = deferredSource();
    await open(source);
    await press('maybe paid');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0].fail({ code, message, operation_id: 'op-x' });
    await vi.waitFor(() => expect($('[data-artifact="failed"]')).not.toBeNull());
    expect($('[data-failed-text]')!.textContent).toBe('maybe paid');
    expect($('[data-failed-check]')).not.toBeNull();
    expect(unsent()).toHaveLength(0);
    expect($('[data-unsent-restore]')).toBeNull();
    expect(area().value).toBe('');
    expect(mount.textContent).not.toMatch(/nothing (was )?paid/i);
    // The next press is blocked until a pending check: its words stay in the box, nothing goes out.
    type('next one');
    $<HTMLButtonElement>('[data-send]')!.click();
    await settleTick();
    expect(pending).toHaveLength(1);
    expect(sending()).toHaveLength(0);
    expect(area().value).toBe('next one');
  });

  it('#1 a proven-unpaid refusal (not_dispatched) still gives the words back to the box', async () => {
    const { source, pending } = deferredSource();
    await open(source);
    await press('not dispatched');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0].fail({ code: 'not_dispatched', message: 'Nothing left the wallet.' });
    await vi.waitFor(() => expect(area().value).toBe('not dispatched'));
    expect($('[data-artifact="failed"] [data-failed-text]')).toBeNull();
  });

  it('#1 budget_unreadable after a paid retry (refine_retry_fee) ends Retry delivery: retrying could pay again', async () => {
    const { source, pending } = deferredSource();
    source.retry = vi.fn(async () => { throw { code: 'budget_unreadable', message: 'Your budget file could not be read.' }; }) as never;
    await open(source);
    await press('paid once');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0].fail({ code: 'payment_settled_undelivered', message: 'Paid, not delivered.', undelivered: { paid_msat: 2250, retry: true }, operation_id: 'op-u' });
    await vi.waitFor(() => expect($('[data-retry-delivery]')).not.toBeNull());
    $<HTMLButtonElement>('[data-retry-delivery]')!.click();
    await vi.waitFor(() => expect(source.retry).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect($('[data-retry-delivery]')).toBeNull());
  });

  it('#2 unknown → op list says unpaid → the same op later gets a receipt: the old card drops its "nothing left your wallet" claim and points at the receipt; a later settled snapshot never brings the claim back', async () => {
    const { source, pending } = deferredSource();
    let list = ops([]);
    source.opList = vi.fn(async () => list) as never;
    await open(source);
    await press('same words');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0].fail({ code: 'payment_unknown', message: 'Outcome unknown.', operation_id: 'op-1' });
    await vi.waitFor(() => expect($('[data-artifact="failed"]')).not.toBeNull());
    list = ops([op({ state: 'unpaid' })]);
    await go(`peer:${B}`);
    await go(`peer:${A}`);
    await vi.waitFor(() => expect($('[data-failed-op="unpaid"]')).not.toBeNull());
    $<HTMLButtonElement>('[data-spend-reconcile]')!.click();
    await vi.waitFor(() => expect(source.spendReconcile).toHaveBeenCalled());
    // The resend reuses op-1 and succeeds.
    await press('same words');
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1].settle(receipt('m-1', A, { operation_id: 'op-1' }));
    await vi.waitFor(() => expect($('[data-failed-confirmed="m-1"]')).not.toBeNull());
    expect($('[data-failed-op]')).toBeNull();
    expect(mount.textContent).not.toContain('Nothing left your wallet');
    expect($('[data-failed-check]')).toBeNull();
    expect($('[data-failed-text]')!.textContent).toBe('same words');
    // A later snapshot (settled) never restores the stale claim.
    list = ops([op({ state: 'settled', paid_msat: 2250, message_id: 'm-1' })]);
    await go(`peer:${B}`);
    await go(`peer:${A}`);
    await vi.waitFor(() => expect(vi.mocked(source.opList).mock.calls.length).toBeGreaterThanOrEqual(4));
    await settleTick();
    expect($('[data-failed-op]')).toBeNull();
    expect($('[data-failed-confirmed="m-1"]')).not.toBeNull();
  });

  it('#3 leaving during a retry approval request: a late null answer never dispatches the retry', async () => {
    const { source, pending } = deferredSource();
    const retries: unknown[] = [];
    source.retry = vi.fn(async (...a: unknown[]) => {
      retries.push(a);
      if (retries.length === 1) throw { code: 'retry_needs_admission', message: 'Admission is due again.', admission: { admission_msat: 1000, message_msat: 2250, max_routing_fee_msat: 0, total_msat: 3250, quoted: true } };
      return receipt('m-r', A);
    }) as never;
    let answer!: (v: null) => void;
    source.firstContactRequest = vi.fn(() => new Promise((r) => { answer = r as never; })) as never;
    await open(source);
    await press('paid once');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0].fail({ code: 'payment_settled_undelivered', message: 'Paid, not delivered.', undelivered: { paid_msat: 2250, retry: true }, operation_id: 'op-u' });
    await vi.waitFor(() => expect($('[data-retry-delivery]')).not.toBeNull());
    $<HTMLButtonElement>('[data-retry-delivery]')!.click();
    await vi.waitFor(() => expect($('[data-retry-approve]')).not.toBeNull());
    $<HTMLButtonElement>('[data-retry-approve]')!.click();
    await vi.waitFor(() => expect(source.firstContactRequest).toHaveBeenCalled());
    await go('discover');
    answer(null);
    await settleTick();
    await go(`peer:${A}`);
    await settleTick();
    expect(retries).toHaveLength(1);
    expect(visible('m-r')).toBe(false);
  });
});

describe('Codex #221 r1 #1: leaving while the first approval request is still being made keeps the words', () => {
  const budget: BudgetView = {
    paused: false, waiting_for_owner: false, preset: 'careful',
    autopay: { state: 'open', open_until_ms: Date.now() + 861400000, ceiling_msat: 500000, basis: 'node_grant' },
    ceiling_msat: 500000, spent_msat: 0, unsettled_msat: 0, rows: [],
    presets: SAMPLE_PRESETS, window_ms: 861400000, max_daily_msat: 100000000, node_grant: null,
  };
  async function start(device: boolean) {
    const source = sampleSource({ firstLiveMs: 1e9 });
    source.budgetStatus = async () => ({ ...budget });
    if (device) {
      const overview = source.nodeOverview.bind(source);
      source.nodeOverview = async () => ({ ...await overview(), capabilities: ['owner_device_approval_v1'] });
    }
    let answer!: (v: unknown) => void;
    const asked = new Promise((r) => { answer = r; });
    const approval: OwnerContactApproval = {
      id: 'request-one', ready: false, expires_at_ms: Date.now() + 60000,
      request: { client_id: 'c1', grant_op_id: 'ab12', recipient: A, max_total_msat: 14000, contact_budget_msat: 50000 },
      owner_command: 'konsensus approve first-contact …',
    };
    source.firstContactRequest = vi.fn(async () => { await asked; return approval; });
    source.firstContactStatus = vi.fn(async () => approval);
    source.firstContactCancel = vi.fn(async () => {});
    source.approvalRequest = vi.fn(async () => { await asked; return { op_id: 'op-fc', status: 'pending' } as never; });
    source.send = vi.fn(async () => { throw new Error('nothing may send'); }) as never;
    mount = document.createElement('div'); document.body.appendChild(mount);
    dispose = render(() => <ControlCenter source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
    await vi.waitFor(() => expect($('[data-door-quote]')?.getAttribute('data-door-quote')).toBe('14000'));
    return { source, answer: () => answer(undefined) };
  }

  it.each([['at the node', false], ['on another owner device', true]] as const)('approval %s: switching chat while the request is out keeps the text on its chat', async (_how, device) => {
    const { source, answer } = await start(device);
    type('hello stranger');
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-send]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-send]')!.click();
    await vi.waitFor(() => expect(device ? source.approvalRequest : source.firstContactRequest).toHaveBeenCalled());
    await go(`peer:${B}`);
    answer();
    await settleTick();
    await go(`peer:${A}`);
    await vi.waitFor(() => expect(unsent()).toHaveLength(1));
    expect(unsent()[0].querySelector('.bubble')!.textContent).toBe('hello stranger');
    expect(source.send).not.toHaveBeenCalled();
    if (!device) await vi.waitFor(() => expect(source.firstContactCancel).toHaveBeenCalledWith('request-one'));
  });

  it('r2 #3: a null answer (the local host needs no approval) after leaving the chat view never sends: the kept text is the only record', async () => {
    const { source, answer } = await start(false);
    source.firstContactRequest = vi.fn(async () => { await new Promise((r) => setTimeout(r, 30)); return null; }) as never;
    source.send = vi.fn(async () => receipt('m-never', A)) as never;
    void answer;
    type('hello stranger');
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-send]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-send]')!.click();
    await vi.waitFor(() => expect(source.firstContactRequest).toHaveBeenCalled());
    // Leave the chat view entirely: that composer unmounts while the request is out.
    await go('discover');
    expect($('[data-composer]')).toBeNull();
    await new Promise((r) => setTimeout(r, 60));
    await go(`peer:${A}`);
    await vi.waitFor(() => expect(unsent()).toHaveLength(1));
    await settleTick();
    expect(source.send).not.toHaveBeenCalled();
    expect(sending()).toHaveLength(0);
    expect(visible('m-never')).toBe(false);
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
    expect($('[data-failed-op]')!.textContent).toBe('This app’s record of the payment named here: not paid. Nothing left your wallet for it.');
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
    // All peers: the host's pending fence is global.
    expect(source.opList).toHaveBeenCalledWith();
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
    expect($('[data-restored-state]')!.textContent).toBe('This app’s record: paid 2.25 sats, not delivered. Check pending result to retry delivery or stop retrying.');
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
