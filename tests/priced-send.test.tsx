import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';
import type { Source } from '../src/control/source';

const A = 'a'.repeat(64);
let dispose: (() => void) | undefined;
let mount: HTMLElement;
afterEach(() => { dispose?.(); mount?.remove(); });
const $ = <T extends HTMLElement = HTMLElement>(s: string) => mount.querySelector<T>(s)!;
const line = () => $('[data-send-price]')?.textContent;
const type = (text: string) => {
  const area = $<HTMLTextAreaElement>('[data-composer] textarea');
  area.value = text;
  area.dispatchEvent(new Event('input', { bubbles: true }));
};
const enter = (repeat = false) => $('[data-composer] textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat, bubbles: true }));
const quote = { kind: 0, own_msat: 9000, peer_msat: 2250, peer_age_secs: 30, peer_stale: false, max_routing_fee_msat: 7500 };
function sourceForSend() {
  const source = sampleSource({ firstLiveMs: 1e9 });
  source.spendStatus = async () => ({ state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 600000, pending: null, window_ms: 600000 });
  source.priceQuote = async () => quote;
  source.send = vi.fn(async (recipient, isRoom) => ({ message_id: 'paid', recipient, is_room: isRoom, delivered: true, amount_msat: 2250, max_routing_fee_msat: 0, total_msat: 2250, sent_at_ms: Date.now() }));
  return source;
}
async function open(source: Source) {
  mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <ControlCenter source={source} active={true} ready={true} error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
  await vi.waitFor(() => expect($(`[data-track="peer:${A}"]`)?.getAttribute('aria-current')).toBe('true'));
  type('gm');
}
it('shows the exact host-sourced cap separately from plain Send and reports actual paid', async () => {
  const source = sourceForSend(); await open(source);
  await vi.waitFor(() => expect(line()).toBe('up to 9.75 sats · includes max routing fee'));
  expect($('[data-send]').textContent).toBe('Send');
  $<HTMLButtonElement>('[data-send]').click();
  await vi.waitFor(() => expect(line()).toBe('paid 2.25 sats'));
  expect(vi.mocked(source.send).mock.calls[0].slice(0, 4)).toEqual([A, false, 'gm', 9750]);
  type('next'); expect(line()).toBe('up to 9.75 sats · includes max routing fee');
});
it('never relabels a retained fee allowance as actual paid', async () => {
  const source = sourceForSend();
  source.send = vi.fn(async (recipient, isRoom) => ({ message_id: 'paid', recipient, is_room: isRoom, delivered: true, amount_msat: 2250, total_msat: 9750, max_routing_fee_msat: 7500, sent_at_ms: Date.now() }));
  await open(source); $<HTMLButtonElement>('[data-send]').click();
  await vi.waitFor(() => expect(line()).toBe('paid amount unknown · routing fee not reported'));
});
it.each(['loading', 'failed', 'missing', 'stale', 'fee'] as const)('disables send with an honest reason when price is %s', async (state) => {
  const source = sourceForSend();
  source.priceQuote = () => state === 'loading' ? new Promise(() => {}) : state === 'failed' ? Promise.reject('price read failed') : Promise.resolve({ ...quote, ...(state === 'missing' ? { peer_msat: null } : state === 'stale' ? { peer_stale: true } : { max_routing_fee_msat: undefined }) });
  await open(source);
  await vi.waitFor(() => expect(line()).toMatch(state === 'loading' ? /price loading/ : /price unavailable/));
  expect($<HTMLButtonElement>('[data-send]').disabled).toBe(true);
  enter(); expect(source.send).not.toHaveBeenCalled();
});
it('ignores double-click and held Enter, including after a raised-price refusal', async () => {
  const source = sourceForSend(); let finish!: () => void;
  source.send = vi.fn(async (recipient, isRoom, _text, cap) => {
    if (cap === 9750) {
      await new Promise<void>(resolve => { finish = resolve; });
      throw { code: 'readmission_quoted', message: 'Nothing paid', admission: { admission_msat: 1000, message_msat: 2000, max_routing_fee_msat: 10000, total_msat: 13000, quoted: true } };
    }
    return { message_id: 'paid', recipient, is_room: isRoom, delivered: true, amount_msat: 2000, readmission_msat: 1000, max_routing_fee_msat: 0, sent_at_ms: Date.now() };
  });
  await open(source);
  $<HTMLButtonElement>('[data-send]').click(); $<HTMLButtonElement>('[data-send]').click(); enter(true);
  await vi.waitFor(() => expect(source.send).toHaveBeenCalledTimes(1)); finish();
  await vi.waitFor(() => expect(line()).toBe('price went up to 13 sats, send?'));
  enter(true); await Promise.resolve(); expect(source.send).toHaveBeenCalledTimes(1);
  enter();
  await vi.waitFor(() => expect(line()).toBe('paid 3 sats'));
  expect(source.send).toHaveBeenCalledTimes(2);
  enter(true); expect(source.send).toHaveBeenCalledTimes(2);
});
it('restores the ceiling for an emoji-only new draft', async () => {
  const source = sourceForSend(); await open(source); $<HTMLButtonElement>('[data-send]').click();
  await vi.waitFor(() => expect(line()).toBe('paid 2.25 sats'));
  $<HTMLButtonElement>('[data-emoji]').click();
  $<HTMLButtonElement>('[data-emoji-pick]').click();
  expect(line()).toBe('up to 9.75 sats · includes max routing fee');
});
it('a late price refusal from A does not erase B’s price', async () => {
  const source = sourceForSend(); let finish!: () => void;
  source.send = vi.fn(async () => { await new Promise<void>(resolve => { finish = resolve; }); throw { code: 'price_changed', message: 'Price moved' }; });
  await open(source); $<HTMLButtonElement>('[data-send]').click();
  await vi.waitFor(() => expect(source.send).toHaveBeenCalledTimes(1));
  $<HTMLButtonElement>(`[data-track="peer:${'b'.repeat(64)}"]`).click(); type('B draft');
  await vi.waitFor(() => expect(line()).toBe('up to 9.75 sats · includes max routing fee'));
  finish(); await vi.waitFor(() => expect($<HTMLButtonElement>('[data-send]').disabled).toBe(false));
  expect(line()).toBe('up to 9.75 sats · includes max routing fee');
});
it('ignores the second click of a double-click after a fast price-rise refusal', async () => {
  const source = sourceForSend();
  source.send = vi.fn(async () => { throw { code: 'readmission_quoted', message: 'Nothing paid', admission: { admission_msat: 1000, message_msat: 2000, max_routing_fee_msat: 10000, total_msat: 13000, quoted: true } }; });
  await open(source); $<HTMLButtonElement>('[data-send]').click();
  await vi.waitFor(() => expect(line()).toBe('price went up to 13 sats, send?'));
  $('[data-send]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 2 }));
  await Promise.resolve(); expect(source.send).toHaveBeenCalledTimes(1);
});
it('offers retry when the signed first-contact quote expires', async () => {
  const source = sourceForSend();
  const read = source.budgetStatus;
  source.budgetStatus = async () => ({ ...await read(), autopay: { state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 100000, ceiling_msat: 500000 }, rows: [] });
  source.firstContactQuote = vi.fn(async (recipient) => ({ recipient, admission_msat: 1000, message_msat: 2000, max_routing_fee_msat: 10000, total_msat: 13000, expires_at: 1 }));
  await open(source);
  await vi.waitFor(() => expect(line()).toContain('quote expired'));
  expect($<HTMLButtonElement>('[data-send]').disabled).toBe(true);
  source.firstContactQuote = vi.fn(async (recipient) => ({ recipient, admission_msat: 1000, message_msat: 2000, max_routing_fee_msat: 10000, total_msat: 13000, expires_at: Math.floor(Date.now() / 1000) + 60 }));
  $<HTMLButtonElement>('[data-price-retry]').click();
  await vi.waitFor(() => expect(line()).toBe('up to 13 sats · includes max routing fee'));
  expect(source.send).not.toHaveBeenCalled();
});
it('blocks a first-contact quote when the host cannot enforce the total', async () => {
  const source = sourceForSend();
  source.priceQuote = async () => ({ ...quote, send_unavailable: 'Upgrade the node to enforce an all-in message ceiling.' });
  const read = source.budgetStatus;
  source.budgetStatus = async () => ({ ...await read(), autopay: { state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 100000, ceiling_msat: 500000 }, rows: [] });
  await open(source);
  await vi.waitFor(() => expect(line()).toContain('Upgrade the node'));
  expect($<HTMLButtonElement>('[data-send]').disabled).toBe(true);
  enter(); expect(source.send).not.toHaveBeenCalled();
});
it('keeps an unknown payment result explicit even while the draft remains', async () => {
  const source = sourceForSend();
  source.send = vi.fn(async () => { throw { code: 'spend_unknown', message: 'Payment unresolved' }; });
  await open(source); $<HTMLButtonElement>('[data-send]').click();
  await vi.waitFor(() => expect(line()).toBe('paid amount unknown · check payment result'));
  expect($<HTMLTextAreaElement>('[data-composer] textarea').value).toBe('gm');
});
