// Round-3 probes for optimistic send: queue × owner approval × live echo ×
// room caps, each ordering pinned. Nothing here talks to a node.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { ControlCenter, setShowLegacyRoomsUi } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID, SAMPLE_PRESETS, SAMPLE_ROOM_ID } from '../src/control/sample';
import type { BudgetView, LiveEvent, OwnerContactApproval, RoomQuote } from '../src/control/types';

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

describe('live echo × receipt', () => {
  it('echo before receipt: one bubble while sending, one message after', async () => {
    const { source, pending, emit } = deferredSource();
    await open(source);
    await press('echo first');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    emit(echo('m-echo', A, 'echo first'));
    await new Promise((r) => setTimeout(r, 20));
    expect(bubbles('echo first')).toHaveLength(1);
    expect(sending()).toHaveLength(1);
    pending[0].settle(receipt('m-echo', A));
    await vi.waitFor(() => expect(sending()).toHaveLength(0));
    expect(bubbles('echo first')).toHaveLength(1);
    expect($('[data-message="m-echo"]')!.classList.contains('fresh')).toBe(false);
  });

  it('receipt before echo: one message, the late echo merges into it', async () => {
    const { source, pending, emit } = deferredSource();
    await open(source);
    await press('receipt first');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0].settle(receipt('m-r', A));
    await vi.waitFor(() => expect(sending()).toHaveLength(0));
    emit(echo('m-r', A, 'receipt first'));
    await new Promise((r) => setTimeout(r, 20));
    expect(bubbles('receipt first')).toHaveLength(1);
  });

  it('two identical texts queued: each echo claims its own bubble, in press order', async () => {
    const { source, pending, emit } = deferredSource();
    await open(source);
    await press('ok');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await press('ok');
    await vi.waitFor(() => expect(sending()).toHaveLength(2));
    emit(echo('ok-1', A, 'ok'));
    await new Promise((r) => setTimeout(r, 20));
    expect(bubbles('ok')).toHaveLength(2); // two sends, two bubbles, no third
    pending[0].settle(receipt('ok-1', A));
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    emit(echo('ok-2', A, 'ok'));
    await new Promise((r) => setTimeout(r, 20));
    expect(bubbles('ok')).toHaveLength(2);
    pending[1].settle(receipt('ok-2', A));
    await vi.waitFor(() => expect(sending()).toHaveLength(0));
    expect(bubbles('ok')).toHaveLength(2);
  });

  it('an echo while the user is on another chat still claims the bubble on its own chat', async () => {
    const { source, pending, emit } = deferredSource();
    await open(source);
    await press('away echo');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await go(`peer:${B}`);
    emit(echo('m-away', A, 'away echo'));
    await go(`peer:${A}`);
    expect(bubbles('away echo')).toHaveLength(1);
    pending[0].settle(receipt('m-away', A));
    await vi.waitFor(() => expect(sending()).toHaveLength(0));
    expect(bubbles('away echo')).toHaveLength(1);
  });

  it('a different text echoed is a different message (another device): both show', async () => {
    const { source, pending, emit } = deferredSource();
    await open(source);
    await press('mine');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    emit(echo('other-device', A, 'from my phone'));
    await vi.waitFor(() => expect(bubbles('from my phone')).toHaveLength(1));
    expect(bubbles('mine')).toHaveLength(1);
  });

  it('echo, then an unknown payment result: the echoed message stays visible, never lost', async () => {
    const { source, pending, emit } = deferredSource();
    await open(source);
    await press('echo then unknown');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    emit(echo('m-eu', A, 'echo then unknown'));
    pending[0].fail({ code: 'payment_unknown', message: 'Outcome unknown.' });
    await vi.waitFor(() => expect(sending()).toHaveLength(0));
    expect($('[data-message="m-eu"]')).not.toBeNull();
  });
});

describe('room caps snapshot', () => {
  it('a queued room send uses the member caps quoted at the press, not a later quote', async () => {
    const { source, pending } = deferredSource();
    const room = SAMPLE_ROOM_ID.toLowerCase();
    let q: RoomQuote = { room_id: room, members: [
      { node_id: A, msat: 10000, advertised: true, connected: true },
      { node_id: B, msat: 20000, advertised: true, connected: true },
    ], total_msat: 30000, unreachable: [], estimate: false };
    source.roomQuote = vi.fn(async () => q) as never;
    setShowLegacyRoomsUi(true);
    try {
    await open(source);
    await press('to Maya first');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await go(`room:${room}`);
    await press('to the room');
    await vi.waitFor(() => expect(sending().length).toBeGreaterThan(0));
    // The quote moves while the room send waits its turn.
    q = { ...q, members: [{ ...q.members[0], msat: 20000 }, { ...q.members[1], msat: 10000 }] };
    await go(`peer:${A}`);
    await go(`room:${room}`);
    await vi.waitFor(() => expect(vi.mocked(source.roomQuote).mock.calls.length).toBeGreaterThan(1));
    pending[0].settle(receipt('m1', A));
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[1].caps).toEqual({ [A]: 10000, [B]: 20000 });
    } finally { setShowLegacyRoomsUi(false); }
  });
});

describe('live region', () => {
  it('announces the actual words each time, including a repeat and a change', async () => {
    const { source, pending } = deferredSource();
    await open(source);
    const live = $('[data-send-live]')!;
    const said: string[] = [];
    new MutationObserver(() => { if (live.textContent) said.push(live.textContent); }).observe(live, { childList: true, characterData: true, subtree: true });
    await press('one');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0].settle(receipt('m1', A));
    await vi.waitFor(() => expect(said).toEqual(['Message sent.']));
    await press('two');
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1].settle(receipt('m2', A));
    await vi.waitFor(() => expect(said).toEqual(['Message sent.', 'Message sent.']));
    await press('three');
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    pending[2].fail({ code: 'price_changed', message: 'Nothing was sent.' });
    await vi.waitFor(() => expect(said).toEqual(['Message sent.', 'Message sent.', 'Message not sent.']));
    expect(live.textContent).toBe('Message not sent.');
  });
});

describe('owner-approved first contact × queue', () => {
  // B (Josh) is a first contact behind an owner approval; A (Maya) sends at once.
  async function start() {
    const source = sampleSource({ firstLiveMs: 1e9 });
    const budget: BudgetView = {
      paused: false, waiting_for_owner: false, preset: 'careful',
      autopay: { state: 'open', open_until_ms: Date.now() + 861400000, ceiling_msat: 500000, basis: 'node_grant' },
      ceiling_msat: 500000, spent_msat: 0, unsettled_msat: 0, rows: [],
      presets: SAMPLE_PRESETS, window_ms: 861400000, max_daily_msat: 100000000, node_grant: null,
    };
    source.budgetStatus = async () => ({ ...budget });
    const approval: OwnerContactApproval = {
      id: 'request-one', ready: false, expires_at_ms: Date.now() + 60000,
      request: { client_id: 'c1', grant_op_id: 'ab12', recipient: A, max_total_msat: 14000, contact_budget_msat: 50000 },
      owner_command: 'konsensus approve first-contact …',
    };
    let ready = false;
    source.firstContactRequest = vi.fn(async () => approval);
    source.firstContactStatus = vi.fn(async () => ({ ...approval, ready }));
    source.firstContactCancel = vi.fn(async () => {});
    const pending: Pending[] = [];
    source.send = vi.fn((recipient: string, _room: boolean, text: string) => new Promise((settle, fail) => pending.push({ recipient, text, caps: undefined, settle, fail }))) as never;
    mount = document.createElement('div'); document.body.appendChild(mount);
    dispose = render(() => <ControlCenter source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
    await vi.waitFor(() => expect($('[data-door-quote]')?.getAttribute('data-door-quote')).toBe('14000'));
    return { source, pending, approve: () => { ready = true; }, unapprove: () => { ready = false; } };
  }
  const pressHere = async (text: string) => {
    type(text);
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-send]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-send]')!.click();
  };

  it('approved while nothing is queued: it becomes a bubble at once, the box is free, it sends once', async () => {
    const { source, pending, approve } = await start();
    await pressHere('first hello');
    await vi.waitFor(() => expect($('[data-contact-approval]')).not.toBeNull());
    expect(source.send).not.toHaveBeenCalled();
    approve();
    await vi.waitFor(() => expect(pending).toHaveLength(1), { timeout: 2500 });
    expect(sending()).toHaveLength(1);
    expect(area().value).toBe('');
    type('typed while it sends');
    pending[0].settle(receipt('s1', A, { amount_msat: 14000 }));
    await vi.waitFor(() => expect(sending()).toHaveLength(0));
    expect(area().value).toBe('typed while it sends');
    expect(source.send).toHaveBeenCalledTimes(1);
  });

  // A first approved send is in flight; a second approved send waits its turn behind it.
  async function approvedBehindJosh() {
    const ctx = await start();
    await pressHere('to Maya first');
    await vi.waitFor(() => expect($('[data-contact-approval]')).not.toBeNull());
    ctx.approve();
    await vi.waitFor(() => expect(ctx.pending).toHaveLength(1), { timeout: 2500 });
    await pressHere('first hello');
    await vi.waitFor(() => expect(sending()).toHaveLength(2), { timeout: 2500 });
    expect(sending().map((b) => b.querySelector('.bubble')!.textContent)).toEqual(['to Maya first', 'first hello']);
    expect(area().value).toBe('');
    expect(ctx.pending).toHaveLength(1); // still waiting its turn
    return ctx;
  }

  it('approved while waiting its turn: an edit during the queue wait is never erased', async () => {
    const { source, pending } = await approvedBehindJosh();
    type('a newer draft');
    pending[0].settle(receipt('j1', A, { amount_msat: 14000 }));
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[1].text).toBe('first hello');
    pending[1].settle(receipt('s1', A, { amount_msat: 14000 }));
    await vi.waitFor(() => expect(sending()).toHaveLength(0));
    expect(area().value).toBe('a newer draft');
    expect(source.send).toHaveBeenCalledTimes(2);
  });

  it('approved while waiting its turn: a chat switch and a new draft there are never erased', async () => {
    const { pending } = await approvedBehindJosh();
    await go(`peer:${B}`);
    type('for Josh again');
    pending[0].settle(receipt('j1', A, { amount_msat: 14000 }));
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1].fail({ code: 'price_changed', message: 'Nothing was sent.' });
    await new Promise((r) => setTimeout(r, 20));
    expect(area().value).toBe('for Josh again'); // never Maya's text in Josh's box
    await go(`peer:${A}`);
    await vi.waitFor(() => expect(unsent().map((u) => u.querySelector('.bubble')!.textContent)).toEqual(['first hello']));
  });

  it('an unknown result before the approved send’s turn holds it: not sent, nothing paid', async () => {
    const { source, pending } = await approvedBehindJosh();
    pending[0].fail({ code: 'payment_unknown', message: 'Outcome unknown.' });
    await vi.waitFor(() => expect(unsent().map((u) => u.getAttribute('data-unsent'))).toEqual(['held']));
    expect(unsent()[0].querySelector('.bubble')!.textContent).toBe('first hello');
    expect(source.send).toHaveBeenCalledTimes(1);
  });

  it('a cheap failure of the approved send after the user typed keeps it as an Unsent card', async () => {
    const { pending, approve } = await start();
    await pressHere('first hello');
    await vi.waitFor(() => expect($('[data-contact-approval]')).not.toBeNull());
    approve();
    await vi.waitFor(() => expect(pending).toHaveLength(1), { timeout: 2500 });
    type('something else');
    pending[0].fail({ code: 'price_changed', message: 'Nothing was sent.' });
    await vi.waitFor(() => expect(unsent()).toHaveLength(1));
    expect(unsent()[0].querySelector('.bubble')!.textContent).toBe('first hello');
    expect(area().value).toBe('something else');
  });
});

describe('round 4: the queue outlives any composer', () => {
  it('Discover and back before a cheap failure: the text is kept on its chat, never lost', async () => {
    const { source, pending } = deferredSource();
    await open(source);
    await press('left for Discover');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await go('discover');
    expect($('[data-composer]')).toBeNull(); // that composer is gone
    pending[0].fail({ code: 'price_changed', message: 'The price changed. Nothing was sent.' });
    await vi.waitFor(() => expect($('[data-send-live]')?.textContent).toBe('Message not sent.'));
    await go(`peer:${A}`);
    await vi.waitFor(() => expect(unsent().map((u) => u.querySelector('.bubble')!.textContent)).toEqual(['left for Discover']));
    expect(area().value).toBe('');
  });

  it('a reopened composer joins the same queue: one, two, three go out in press order', async () => {
    const { source, pending } = deferredSource();
    await open(source);
    await press('one');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await press('two');
    await go('discover');
    await go(`peer:${A}`);
    await press('three');
    await vi.waitFor(() => expect(sending()).toHaveLength(3));
    expect(pending).toHaveLength(1);
    pending[0].settle(receipt('m1', A));
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(pending.map((p) => p.text)).toEqual(['one', 'two']);
    pending[1].settle(receipt('m2', A));
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    expect(pending.map((p) => p.text)).toEqual(['one', 'two', 'three']);
  });

  it('held, then Discover and back: the held message is still there and still not sent', async () => {
    const { source, pending } = deferredSource();
    await open(source);
    await press('first');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await press('second');
    pending[0].fail({ code: 'payment_unknown', message: 'Outcome unknown.' });
    await vi.waitFor(() => expect(unsent()).toHaveLength(1));
    await go('discover');
    await go(`peer:${A}`);
    await vi.waitFor(() => expect(unsent().map((u) => u.getAttribute('data-unsent'))).toEqual(['held']));
    // A reopened composer is still held by the unknown result.
    await press('third');
    await vi.waitFor(() => expect($('[data-composer-note]')?.textContent).toContain('Check pending result'));
    expect(source.send).toHaveBeenCalledTimes(1);
  });

  it('in flight, then another chat: an unknown result is said there too, and the hold applies everywhere', async () => {
    const { source, pending } = deferredSource();
    await open(source);
    await press('to Maya');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await go(`peer:${B}`);
    pending[0].fail({ code: 'spend_unknown', message: 'Outcome unknown.' });
    await vi.waitFor(() => expect($('[data-send-live]')?.textContent).toBe('Message payment result unknown.'));
    type('to Josh');
    $<HTMLButtonElement>('[data-send]')!.click();
    await vi.waitFor(() => expect($('[data-composer-note]')?.textContent).toContain('Check pending result'));
    expect(area().value).toBe('to Josh');
    expect(source.send).toHaveBeenCalledTimes(1);
  });

  it('history loaded again (A → B → A) while sending: one bubble, then one message', async () => {
    const { source, pending } = deferredSource();
    const base = source.messages.bind(source);
    let echoNow = false;
    source.messages = vi.fn(async (peer: string) => {
      const page = await base(peer);
      return echoNow && peer === A
        ? [...page, { id: 'm-hist', kind: 0, sender: SAMPLE_OWN_ID, recipient: A, timestamp: Date.now(), plaintext: 'in history already', payment_amount_msat: 2250 }]
        : page;
    }) as never;
    await open(source);
    await press('in history already');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    echoNow = true;
    await go(`peer:${B}`);
    await go(`peer:${A}`);
    await vi.waitFor(() => expect(vi.mocked(source.messages).mock.calls.filter(([p]) => p === A).length).toBeGreaterThan(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(bubbles('in history already')).toHaveLength(1);
    pending[0].settle(receipt('m-hist', A));
    await vi.waitFor(() => expect(sending()).toHaveLength(0));
    expect(bubbles('in history already')).toHaveLength(1);
  });

  it('an older identical message in history is never claimed by a new send', async () => {
    const { source, pending } = deferredSource();
    const base = source.messages.bind(source);
    source.messages = vi.fn(async (peer: string) => {
      const page = await base(peer);
      return peer === A ? [...page, { id: 'm-old', kind: 0, sender: SAMPLE_OWN_ID, recipient: A, timestamp: Date.now() - 3_600_000, plaintext: 'ok', payment_amount_msat: 2250 }] : page;
    }) as never;
    await open(source);
    await vi.waitFor(() => expect($('[data-message="m-old"]')).not.toBeNull());
    await press('ok');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await go(`peer:${B}`);
    await go(`peer:${A}`);
    await new Promise((r) => setTimeout(r, 20));
    expect($('[data-message="m-old"]')).not.toBeNull();
    expect(bubbles('ok')).toHaveLength(2);
  });
});

describe('round 4: approvals and the hold', () => {
  async function start() {
    const source = sampleSource({ firstLiveMs: 1e9 });
    const budget: BudgetView = {
      paused: false, waiting_for_owner: false, preset: 'careful',
      autopay: { state: 'open', open_until_ms: Date.now() + 861400000, ceiling_msat: 500000, basis: 'node_grant' },
      ceiling_msat: 500000, spent_msat: 0, unsettled_msat: 0, rows: [],
      presets: SAMPLE_PRESETS, window_ms: 861400000, max_daily_msat: 100000000, node_grant: null,
    };
    source.budgetStatus = async () => ({ ...budget });
    const approval: OwnerContactApproval = {
      id: 'request-one', ready: false, expires_at_ms: Date.now() + 60000,
      request: { client_id: 'c1', grant_op_id: 'ab12', recipient: A, max_total_msat: 14000, contact_budget_msat: 50000 },
      owner_command: 'konsensus approve first-contact …',
    };
    let ready = false;
    source.firstContactRequest = vi.fn(async () => approval);
    source.firstContactStatus = vi.fn(async () => ({ ...approval, ready }));
    source.firstContactCancel = vi.fn(async () => {});
    const pending: Pending[] = [];
    source.send = vi.fn((recipient: string, _room: boolean, text: string) => new Promise((settle, fail) => pending.push({ recipient, text, caps: undefined, settle, fail }))) as never;
    mount = document.createElement('div'); document.body.appendChild(mount);
    dispose = render(() => <ControlCenter source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
    await vi.waitFor(() => expect($('[data-door-quote]')?.getAttribute('data-door-quote')).toBe('14000'));
    return { source, pending, setReady: (v: boolean) => { ready = v; } };
  }
  const pressHere = async (text: string) => {
    type(text);
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-send]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-send]')!.click();
  };

  it('an approval that resolves after an unknown result is held: never sent on its own', async () => {
    const { source, pending, setReady } = await start();
    await pressHere('approved first');
    await vi.waitFor(() => expect($('[data-contact-approval]')).not.toBeNull());
    setReady(true);
    await vi.waitFor(() => expect(pending).toHaveLength(1), { timeout: 2500 });
    setReady(false);
    await pressHere('approved late');
    await vi.waitFor(() => expect($('[data-contact-approval]')).not.toBeNull(), { timeout: 2500 });
    pending[0].fail({ code: 'payment_unknown', message: 'Outcome unknown.' });
    await vi.waitFor(() => expect($('[data-send-live]')?.textContent).toBe('Message payment result unknown.'));
    setReady(true);
    await vi.waitFor(() => expect(unsent().map((u) => u.getAttribute('data-unsent'))).toEqual(['held']), { timeout: 2500 });
    expect(unsent()[0].querySelector('.bubble')!.textContent).toBe('approved late');
    expect(source.send).toHaveBeenCalledTimes(1);
  });

  it('leaving the chat while the owner approval is pending keeps the text on its chat, sends nothing', async () => {
    const { source } = await start();
    await pressHere('waiting for the owner');
    await vi.waitFor(() => expect($('[data-contact-approval]')).not.toBeNull());
    await go('discover');
    await vi.waitFor(() => expect(source.firstContactCancel).toHaveBeenCalled());
    await go(`peer:${A}`);
    await vi.waitFor(() => expect(unsent().map((u) => u.querySelector('.bubble')!.textContent)).toEqual(['waiting for the owner']));
    expect(source.send).not.toHaveBeenCalled();
  });

  it('switching chats while the owner approval is pending keeps the text on its chat', async () => {
    const { source } = await start();
    await pressHere('switch away');
    await vi.waitFor(() => expect($('[data-contact-approval]')).not.toBeNull());
    await go(`peer:${B}`);
    expect(area().value).toBe('');
    await go(`peer:${A}`);
    await vi.waitFor(() => expect(unsent().map((u) => u.querySelector('.bubble')!.textContent)).toEqual(['switch away']));
    expect(source.send).not.toHaveBeenCalled();
  });

  it('approved and queued, then Discover and back before its turn: it still goes once, in order', async () => {
    const { source, pending, setReady } = await start();
    await pressHere('approved one');
    await vi.waitFor(() => expect($('[data-contact-approval]')).not.toBeNull());
    setReady(true);
    await vi.waitFor(() => expect(pending).toHaveLength(1), { timeout: 2500 });
    await pressHere('approved two');
    await vi.waitFor(() => expect(sending()).toHaveLength(2), { timeout: 2500 });
    await go('discover');
    pending[0].settle(receipt('s1', A, { amount_msat: 14000 }));
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[1].text).toBe('approved two');
    await go(`peer:${A}`);
    pending[1].settle(receipt('s2', A, { amount_msat: 14000 }));
    await vi.waitFor(() => expect(sending()).toHaveLength(0));
    expect(source.send).toHaveBeenCalledTimes(2);
  });
});
