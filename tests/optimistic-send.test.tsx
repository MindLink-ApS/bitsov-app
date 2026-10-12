import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';
import type { Source } from '../src/control/source';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
let dispose: (() => void) | undefined;
let mount: HTMLElement;
afterEach(() => { dispose?.(); mount?.remove(); vi.restoreAllMocks(); });
const $ = <T extends HTMLElement = HTMLElement>(s: string) => mount.querySelector<T>(s);
const area = () => $<HTMLTextAreaElement>('[data-composer] textarea')!;
const type = (text: string) => { area().value = text; area().dispatchEvent(new Event('input', { bubbles: true })); };
const quote = { kind: 0, own_msat: 9000, peer_msat: 2250, peer_age_secs: 30, peer_stale: false, max_routing_fee_msat: 7500 };
const receipt = (id: string, recipient: string) => ({ message_id: id, recipient, is_room: false, delivered: true, amount_msat: 2250, fee_paid_msat: 0, max_routing_fee_msat: 7500, total_msat: 9750, sent_at_ms: Date.now() });

type Settle = (value: unknown) => void;
function deferredSource() {
  const source = sampleSource({ firstLiveMs: 1e9 });
  source.spendStatus = async () => ({ state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 600000, pending: null, window_ms: 600000 });
  source.priceQuote = async () => quote;
  const pending: { text: string; settle: Settle; fail: (e: unknown) => void }[] = [];
  source.send = vi.fn((_r: string, _room: boolean, text: string) => new Promise((settle, fail) => pending.push({ text, settle, fail }))) as never;
  return { source, pending };
}
async function open(source: Source) {
  mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <ControlCenter source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
  await vi.waitFor(() => expect($(`[data-track="peer:${A}"]`)?.getAttribute('aria-current')).toBe('true'));
}
const sending = () => [...mount.querySelectorAll('[data-sending]')];
const unsent = () => [...mount.querySelectorAll('[data-unsent]')];
const go = async (peer: string) => {
  $<HTMLElement>(`[data-track="peer:${peer}"]`)!.click();
  await vi.waitFor(() => expect($(`[data-track="peer:${peer}"]`)?.getAttribute('aria-current')).toBe('true'));
};
const press = async (text: string) => {
  type(text);
  await vi.waitFor(() => expect($('[data-send-price]')?.textContent).toMatch(/^up to/));
  $<HTMLButtonElement>('[data-send]')!.click();
};

describe('optimistic send', () => {
  it('shows the message at once with its ceiling, then the paid message on settle', async () => {
    const { source, pending } = deferredSource();
    await open(source);
    await press('hello now');
    await vi.waitFor(() => expect(sending()).toHaveLength(1));
    expect(sending()[0].textContent).toContain('hello now');
    expect(sending()[0].textContent).toContain('Sending · up to 9.75 sats');
    expect(sending()[0].textContent).not.toMatch(/paid/i);
    expect(area().value).toBe('');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0].settle(receipt('m1', A));
    await vi.waitFor(() => expect(sending()).toHaveLength(0));
    expect([...mount.querySelectorAll('.msg.out')].some((m) => m.textContent?.includes('hello now'))).toBe(true);
    await vi.waitFor(() => expect($('[data-send-price]')?.textContent).toBe('paid 2.25 sats'));
  });

  it('gives the text back when nothing was paid', async () => {
    const { source, pending } = deferredSource();
    await open(source);
    await press('price moved');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0].fail({ code: 'price_changed', message: 'The price changed. Nothing was sent.' });
    await vi.waitFor(() => expect(sending()).toHaveLength(0));
    expect(area().value).toBe('price moved');
  });

  it('says plainly that it was not sent and how to try again', async () => {
    const { source, pending } = deferredSource();
    await open(source);
    await press('network hiccup');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0].fail({ code: 'node', message: 'Your node did not answer.' });
    await vi.waitFor(() => expect($('[data-composer-note]')?.textContent).toBe('Not sent. Your message is back in the box; press Send to try again.'));
    expect(area().value).toBe('network hiccup');
    // Never a delivered or paid claim for it.
    expect(mount.textContent).not.toMatch(/network hiccup[\s\S]*paid/);
  });

  it('a paid but undelivered message becomes its retry card, not a draft', async () => {
    const { source, pending } = deferredSource();
    await open(source);
    await press('paid not delivered');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0].fail({ code: 'payment_settled_undelivered', message: 'Paid, not delivered.', pending_id: 'p1',
      undelivered: { paid_msat: 2250, retry: true } });
    await vi.waitFor(() => expect(sending()).toHaveLength(0));
    await vi.waitFor(() => expect($('[data-artifact="undelivered"]')).not.toBeNull());
    expect(area().value).toBe('');
  });

  it('keeps a newly typed message, and keeps the one that did not go whole in the chat', async () => {
    const { source, pending } = deferredSource();
    await open(source);
    const long = `first try ${'x'.repeat(200)} end`;
    await press(long);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    type('something new');
    pending[0].fail({ code: 'price_changed', message: 'The price changed. Nothing was sent.' });
    await vi.waitFor(() => expect(unsent()).toHaveLength(1));
    expect(unsent()[0].getAttribute('data-unsent')).toBe('refused');
    expect(unsent()[0].querySelector('.bubble')!.textContent).toBe(long);
    expect(unsent()[0].textContent).toContain('nothing paid');
    expect(area().value).toBe('something new');
    // Put back refuses to overwrite the newer message; the card stays.
    unsent()[0].querySelector<HTMLButtonElement>('[data-unsent-restore]')!.click();
    await vi.waitFor(() => expect($('[data-composer-note]')?.textContent).toContain('Send or clear the message in the box first'));
    expect(area().value).toBe('something new');
    expect(unsent()).toHaveLength(1);
    // With the box free, it goes back whole and the card ends.
    type('');
    unsent()[0].querySelector<HTMLButtonElement>('[data-unsent-restore]')!.click();
    await vi.waitFor(() => expect(area().value).toBe(long));
    expect(unsent()).toHaveLength(0);
  });

  it('Discard ends an Unsent card without sending anything', async () => {
    const { source, pending } = deferredSource();
    await open(source);
    await press('drop me');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    type('newer');
    pending[0].fail({ code: 'node', message: 'Your node did not answer.' });
    await vi.waitFor(() => expect(unsent()).toHaveLength(1));
    unsent()[0].querySelector<HTMLButtonElement>('[data-unsent-discard]')!.click();
    await vi.waitFor(() => expect(unsent()).toHaveLength(0));
    expect(source.send).toHaveBeenCalledTimes(1);
  });

  it('a second Send while the first is in flight shows at once and goes out after it, in order', async () => {
    const { source, pending } = deferredSource();
    await open(source);
    await press('one');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await press('two');
    await vi.waitFor(() => expect(sending()).toHaveLength(2));
    expect(sending().map((b) => b.querySelector('.bubble')?.textContent)).toEqual(['one', 'two']);
    // The second has not been sent yet: the node sees them strictly in order.
    expect(pending).toHaveLength(1);
    pending[0].settle(receipt('m1', A));
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(pending.map((p) => p.text)).toEqual(['one', 'two']);
    pending[1].settle(receipt('m2', A));
    await vi.waitFor(() => expect(sending()).toHaveLength(0));
  });

  it('paid and refused for good: no text back, no resend, the whole text on its card', async () => {
    const { source, pending } = deferredSource();
    await open(source);
    await press('refused for good');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0].fail({ code: 'failed_paid', message: 'Paid, and the recipient’s node refused this message for good. Do not send it again.' });
    await vi.waitFor(() => expect(sending()).toHaveLength(0));
    expect(area().value).toBe('');
    expect(mount.textContent).not.toMatch(/press Send to try again/);
    await vi.waitFor(() => expect($('[data-send-live]')?.textContent).toBe('Paid, refused by their node.'));
    expect($('[data-failed-text]')?.textContent).toBe('refused for good');
  });

  it.each(['payment_unknown', 'spend_unknown', 'room_partial'])('never gives the text back or says try again after %s', async (code) => {
    const { source, pending } = deferredSource();
    await open(source);
    await press('maybe paid');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0].fail({ code, message: 'Outcome unknown.' });
    await vi.waitFor(() => expect(sending()).toHaveLength(0));
    expect(area().value).toBe('');
    await vi.waitFor(() => expect($('[data-composer-note]')?.textContent).toContain('Check pending result before sending it again'));
    expect(mount.textContent).not.toMatch(/press Send to try again/);
    await vi.waitFor(() => expect($('[data-send-live]')?.textContent).toBe('Message payment result unknown.'));
    // The whole text stays readable on its failure card, with no resend.
    expect($('[data-failed-text]')?.textContent).toBe('maybe paid');
    expect(unsent()).toHaveLength(0);
  });

  it('never drops text: a queued second message plus a cheap failure of the first keeps the first', async () => {
    const { source, pending } = deferredSource();
    await open(source);
    await press('first text');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await press('second text');
    type('third, still typing');
    pending[0].fail({ code: 'price_changed', message: 'The price changed. Nothing was sent.' });
    await vi.waitFor(() => expect(unsent().map((u) => u.querySelector('.bubble')!.textContent)).toEqual(['first text']));
    expect(area().value).toBe('third, still typing');
  });

  it('alpha fails unpaid, queued beta succeeds: alpha is kept and nothing erases it', async () => {
    const { source, pending } = deferredSource();
    await open(source);
    await press('alpha');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await press('beta');
    pending[0].fail({ code: 'price_changed', message: 'Nothing was sent.' });
    await vi.waitFor(() => expect(unsent()).toHaveLength(1));
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    type('gamma, typed meanwhile');
    pending[1].settle(receipt('m2', A));
    await vi.waitFor(() => expect(sending()).toHaveLength(0));
    expect(unsent()[0].querySelector('.bubble')!.textContent).toBe('alpha');
    expect(area().value).toBe('gamma, typed meanwhile');
  });

  it('a lone cheap failure on the same chat, box untouched, puts the text back', async () => {
    const { source, pending } = deferredSource();
    await open(source);
    await press('alpha');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0].fail({ code: 'price_changed', message: 'Nothing was sent.' });
    await vi.waitFor(() => expect(area().value).toBe('alpha'));
    expect(unsent()).toHaveLength(0);
    await vi.waitFor(() => expect($('[data-send-live]')?.textContent).toBe('Message not sent.'));
  });

  it('send to A, switch to B, A fails: the text never lands in B’s box; it waits on A', async () => {
    const { source, pending } = deferredSource();
    await open(source);
    await press('for Maya only');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await go(B);
    pending[0].fail({ code: 'price_changed', message: 'The price changed. Nothing was sent.' });
    await vi.waitFor(() => expect($('[data-send-live]')?.textContent).toBe('Message not sent.'));
    expect(area().value).toBe('');
    expect(unsent()).toHaveLength(0); // Not in B's chat either.
    await go(A);
    await vi.waitFor(() => expect(unsent()).toHaveLength(1));
    expect(unsent()[0].querySelector('.bubble')!.textContent).toBe('for Maya only');
    expect(area().value).toBe('');
    // Put back fills A's own box only.
    unsent()[0].querySelector<HTMLButtonElement>('[data-unsent-restore]')!.click();
    await vi.waitFor(() => expect(area().value).toBe('for Maya only'));
    expect(source.send).toHaveBeenCalledTimes(1);
  });

  it('A → B → A before the failure still keeps it as a card, not in the box', async () => {
    const { source, pending } = deferredSource();
    await open(source);
    await press('round trip');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await go(B);
    await go(A);
    pending[0].fail({ code: 'price_changed', message: 'Nothing was sent.' });
    await vi.waitFor(() => expect(unsent()).toHaveLength(1));
    expect(area().value).toBe('');
  });

  it('an unknown result holds the queued messages: not sent, nothing paid, kept as Waiting for payment check', async () => {
    const { source, pending } = deferredSource();
    await open(source);
    await press('first');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await press('second');
    await press('third');
    await vi.waitFor(() => expect(sending()).toHaveLength(3));
    pending[0].fail({ code: 'payment_unknown', message: 'Outcome unknown.' });
    await vi.waitFor(() => expect(unsent()).toHaveLength(2));
    expect(unsent().map((u) => u.getAttribute('data-unsent'))).toEqual(['held', 'held']);
    expect(unsent().map((u) => u.querySelector('.bubble')!.textContent)).toEqual(['second', 'third']);
    expect(unsent()[0].textContent).toContain('Waiting for payment check');
    expect(sending()).toHaveLength(0);
    // Never dispatched: the host saw only the first.
    expect(source.send).toHaveBeenCalledTimes(1);
    // A new press waits for the check: the text stays in the box, nothing goes out.
    await press('fourth');
    await vi.waitFor(() => expect($('[data-composer-note]')?.textContent).toContain('Check pending result, then press Send'));
    expect(area().value).toBe('fourth');
    expect(source.send).toHaveBeenCalledTimes(1);
    // A pending check that answers lets it go.
    $<HTMLButtonElement>('[data-spend-reconcile]')!.click();
    await new Promise((r) => setTimeout(r, 20));
    $<HTMLButtonElement>('[data-send]')!.click();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[1].text).toBe('fourth');
  });

  it('a paid-undelivered result holds the queued message too', async () => {
    const { source, pending } = deferredSource();
    await open(source);
    await press('first');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await press('second');
    pending[0].fail({ code: 'payment_settled_undelivered', message: 'Paid, not delivered.', pending_id: 'p1', undelivered: { paid_msat: 2250, retry: true } });
    await vi.waitFor(() => expect(unsent().map((u) => u.getAttribute('data-unsent'))).toEqual(['held']));
    expect(source.send).toHaveBeenCalledTimes(1);
  });

  it('announces each outcome, also the same words twice in a row', async () => {
    const { source, pending } = deferredSource();
    await open(source);
    const live = $('[data-send-live]')!;
    const seq = () => Number(live.getAttribute('data-send-live-seq'));
    await press('one');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0].settle(receipt('m1', A));
    await vi.waitFor(() => expect(live.textContent).toBe('Message sent.'));
    const first = seq();
    await press('two');
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1].settle(receipt('m2', A));
    await vi.waitFor(() => expect(seq()).toBe(first + 1));
    await vi.waitFor(() => expect(live.textContent).toBe('Message sent.'));
  });

  it('the settled message takes the bubble’s place without a second entrance', async () => {
    const { source, pending } = deferredSource();
    await open(source);
    await press('no replay');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0].settle(receipt('m-calm', A));
    await vi.waitFor(() => expect($('[data-message="m-calm"]')).not.toBeNull());
    expect($('[data-message="m-calm"]')!.classList.contains('fresh')).toBe(false);
  });

  it('keeps pending messages last, in the order pressed, while an earlier one settles', async () => {
    const { source, pending } = deferredSource();
    await open(source);
    await press('one');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await press('two');
    // Settle 'one' with a later clock than 'two' was pressed at.
    pending[0].settle({ ...receipt('m1', A), sent_at_ms: Date.now() + 60_000 });
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    const order = () => [...mount.querySelectorAll('.msg.out .bubble')].map((b) => b.textContent).filter((t) => t === 'one' || t === 'two');
    await vi.waitFor(() => expect(order()).toEqual(['one', 'two']));
    expect(sending().map((b) => b.querySelector('.bubble')?.textContent)).toEqual(['two']);
  });

  it('plays no settle flash on a pending bubble and announces the outcome politely', async () => {
    const { source, pending } = deferredSource();
    await open(source);
    await press('quiet');
    await vi.waitFor(() => expect(sending()).toHaveLength(1));
    expect(sending()[0].classList.contains('fresh')).toBe(false);
    const live = $('[data-send-live]')!;
    expect(live.getAttribute('aria-live')).toBe('polite');
    pending[0].settle(receipt('m1', A));
    await vi.waitFor(() => expect(live.textContent).toBe('Message sent.'));
  });
});
