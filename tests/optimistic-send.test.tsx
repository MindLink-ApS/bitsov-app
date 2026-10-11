import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';
import type { Source } from '../src/control/source';

const A = 'a'.repeat(64);
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

  it('keeps a newly typed message and quotes the one that did not go', async () => {
    const { source, pending } = deferredSource();
    await open(source);
    await press('first try');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    type('something new');
    pending[0].fail({ code: 'price_changed', message: 'The price changed. Nothing was sent.' });
    await vi.waitFor(() => expect($('[data-composer-note]')?.textContent).toContain('Not sent: “first try”'));
    expect(area().value).toBe('something new');
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

  it.each(['payment_unknown', 'spend_unknown', 'failed_paid', 'room_partial'])('never gives the text back or says try again after %s', async (code) => {
    const { source, pending } = deferredSource();
    await open(source);
    await press('maybe paid');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0].fail({ code, message: 'Outcome unknown.' });
    await vi.waitFor(() => expect(sending()).toHaveLength(0));
    expect(area().value).toBe('');
    await vi.waitFor(() => expect($('[data-composer-note]')?.textContent).toContain('Check pending result before sending it again'));
    expect(mount.textContent).not.toMatch(/press Send to try again/);
    expect($('[data-send-live]')?.textContent).toBe('Message payment result unknown.');
  });

  it('never drops text: a queued second message plus a cheap failure of the first quotes the first', async () => {
    const { source, pending } = deferredSource();
    await open(source);
    await press('first text');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await press('second text');
    type('third, still typing');
    pending[0].fail({ code: 'price_changed', message: 'The price changed. Nothing was sent.' });
    await vi.waitFor(() => expect($('[data-composer-note]')?.textContent).toContain('Not sent: “first text”'));
    expect(area().value).toBe('third, still typing');
  });

  it('a cheap failure while the box is empty puts the text back even after a queued send', async () => {
    const { source, pending } = deferredSource();
    await open(source);
    await press('alpha');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await press('beta');
    // The box is empty again (beta went into the queue): alpha comes back.
    pending[0].fail({ code: 'price_changed', message: 'Nothing was sent.' });
    await vi.waitFor(() => expect(area().value).toBe('alpha'));
    expect($('[data-send-live]')?.textContent).toBe('Message not sent.');
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
