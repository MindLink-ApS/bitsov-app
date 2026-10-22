import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';
import type { Source } from '../src/control/source';

const A = 'a'.repeat(64);
let dispose: (() => void) | undefined;
let mount: HTMLElement;
afterEach(() => { dispose?.(); mount?.remove(); vi.restoreAllMocks(); });
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
  source.send = vi.fn(async (recipient, isRoom) => ({ message_id: 'paid', recipient, is_room: isRoom, delivered: true, amount_msat: 2250, fee_paid_msat: 0, max_routing_fee_msat: 0, total_msat: 2250, sent_at_ms: Date.now() }));
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
  await vi.waitFor(() => expect(line()).toBe('paid 2.25 sats · network fee not reported'));
});
it.each([
  { fee: 375, readmission: undefined, ceiling: 7500, paid: '2.625' },
  { fee: 0, readmission: undefined, ceiling: 7500, paid: '2.25' },
  { fee: 375, readmission: 1000, ceiling: 7500, paid: '3.625' },
  { fee: 0, readmission: 1000, ceiling: 7500, paid: '3.25' },
  { fee: 375, readmission: undefined, ceiling: undefined, paid: '2.625' },
])('shows the proven fee $fee with readmission $readmission and ceiling $ceiling', async ({ fee, readmission, ceiling, paid }) => {
  const source = sourceForSend();
  source.send = vi.fn(async (recipient, isRoom) => ({ message_id: 'paid', recipient, is_room: isRoom,
    delivered: true, amount_msat: 2250, readmission_msat: readmission, fee_paid_msat: fee,
    max_routing_fee_msat: ceiling, total_msat: 9750, sent_at_ms: Date.now() }));
  await open(source); $<HTMLButtonElement>('[data-send]').click();
  await vi.waitFor(() => expect(line()).toBe(`paid ${paid} sats`));
});
it('keeps the paid amount unknown for an older node omitting both fee fields', async () => {
  const source = sourceForSend();
  source.send = vi.fn(async (recipient, isRoom) => ({ message_id: 'paid', recipient, is_room: isRoom,
    delivered: true, amount_msat: 2250, sent_at_ms: Date.now() }));
  await open(source); $<HTMLButtonElement>('[data-send]').click();
  await vi.waitFor(() => expect(line()).toBe('paid 2.25 sats · network fee not reported'));
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
    return { message_id: 'paid', recipient, is_room: isRoom, delivered: true, amount_msat: 2000, readmission_msat: 1000, fee_paid_msat: 0, max_routing_fee_msat: 0, sent_at_ms: Date.now() };
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
it('keeps an unknown payment result explicit and never offers the text for a resend', async () => {
  const source = sourceForSend();
  source.send = vi.fn(async () => { throw { code: 'spend_unknown', message: 'Payment unresolved' }; });
  await open(source); $<HTMLButtonElement>('[data-send]').click();
  await vi.waitFor(() => expect(line()).toBe('paid amount unknown · check payment result'));
  // Sats may have moved: the box stays empty and the note points to reconciliation.
  expect($<HTMLTextAreaElement>('[data-composer] textarea').value).toBe('');
  expect($('[data-composer-note]')?.textContent).toContain('Check pending result before sending it again');
  expect($('[data-composer-note]')?.textContent).not.toMatch(/try again/i);
});

it.each(['No route or channel to this peer yet.', 'Peer offline.', 'Quote unavailable.'])('shows the host quote failure without an upgrade claim: %s', async (reason) => {
  const source = sourceForSend();
  source.priceQuote = async () => ({ ...quote, peer_msat: null, send_unavailable: reason });
  await open(source);
  await vi.waitFor(() => expect(line()).toBe(`price unavailable · ${reason}`));
  expect(line()).not.toContain('Upgrade');
  expect($<HTMLButtonElement>('[data-send]').disabled).toBe(true);
});

it.each([['da-DK', '9,75 sats'], ['en-US', '9.75 sats']])('uses exact locale-safe units under Send in %s', async (locale, price) => {
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(locale);
  await open(sourceForSend());
  await vi.waitFor(() => expect(line()).toBe(locale.startsWith('da') ? `højst ${price} · inklusive maksimalt routinggebyr` : `up to ${price} · includes max routing fee`));
  expect($('[data-cost-msat]').getAttribute('data-cost-msat')).toBe('9750');
  expect($('[data-cost-msat]').textContent).toBe(price.replace(' ', ''));
});

it.each(['chain_unavailable', 'not_synced'])('keeps Send disabled with the peer readiness reason: %s', async (reason) => {
  const source = sourceForSend();
  source.priceQuote = async () => { throw { code: 'peer_not_ready', reason, message: 'Peer unavailable' }; };
  await open(source);
  await vi.waitFor(() => expect(line()).toBe("Maya’s node isn't ready to receive yet (its chain connection is down)"));
  expect($<HTMLButtonElement>('[data-send]').disabled).toBe(true);
  enter(); expect(source.send).not.toHaveBeenCalled();
});
it('preserves peer readiness when the host embeds it in the conversation quote', async () => {
  const source = sourceForSend();
  source.priceQuote = async () => ({ ...quote, send_unavailable: 'peer_not_ready:chain_unavailable' });
  await open(source);
  await vi.waitFor(() => expect(line()).toBe("Maya’s node isn't ready to receive yet (its chain connection is down)"));
  expect($<HTMLButtonElement>('[data-send]').disabled).toBe(true);
});
it('preserves a first-contact readiness refusal under Send and recovers on retry', async () => {
  const source = sourceForSend();
  const read = source.budgetStatus;
  source.budgetStatus = async () => ({ ...await read(), autopay: { state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 100000, ceiling_msat: 500000 }, rows: [] });
  source.firstContactQuote = async () => { throw { code: 'peer_not_ready', reason: 'not_synced' }; };
  await open(source);
  await vi.waitFor(() => expect(line()).toBe("Maya’s node isn't ready to receive yet (its chain connection is down)"));
  expect($<HTMLButtonElement>('[data-send]').disabled).toBe(true);
  source.firstContactQuote = async (recipient) => ({ recipient, admission_msat: 1000, message_msat: 2000, max_routing_fee_msat: 10000, total_msat: 13000, expires_at: Math.floor(Date.now() / 1000) + 60 });
  $<HTMLButtonElement>('[data-price-retry]').click();
  await vi.waitFor(() => expect(line()).toBe('up to 13 sats · includes max routing fee'));
});

// #125: receipt ceilings must never become the amount displayed in the bubble.
it.each([
  { principal: 0, fee: 375, ceiling: 5000, expected: 'paid 0.375 sats' },
  { fee: 0, ceiling: 5000, expected: 'paid 1 sat' },
  { fee: 375, ceiling: 5000, expected: 'paid 1.375 sats' },
  { fee: undefined, ceiling: 5000, expected: 'paid 1 sat · network fee not reported' },
  { fee: undefined, ceiling: 0, expected: 'paid 1 sat · network fee not reported' },
])('bubble uses settlement evidence: $expected (ceiling $ceiling)', async ({ principal = 1000, fee, ceiling, expected }) => {
  const source = sourceForSend();
  source.send = async (recipient, isRoom) => ({ message_id: 'paid', recipient, is_room: isRoom,
    delivered: true, amount_msat: principal, fee_paid_msat: fee, max_routing_fee_msat: ceiling,
    total_msat: 6000, sent_at_ms: Date.now() });
  await open(source); $<HTMLButtonElement>('[data-send]').click();
  await vi.waitFor(() => expect($('[data-message="paid"] .sats-meta')?.textContent).toBe(expected));
  expect(line()).toBe(expected);
});
it('breaks the ceiling into peer price and routing allowance, and only when they add up', async () => {
  const source = sourceForSend(); await open(source);
  await vi.waitFor(() => expect(line()).toBe('up to 9.75 sats · includes max routing fee'));
  const rows = [...mount.querySelectorAll('[data-price-breakdown] dd')].map((d) => d.textContent);
  expect(rows).toEqual(['2.25 sats', '7.5 sats', '9.75 sats']);
  expect($('[data-composer-info]').textContent).toContain('A ceiling, not a charge');
  // 7.5 routing on a 2.25 price: said plainly, without alarm or a claim about the route.
  expect($('[data-composer-info]').textContent).toContain('Routing can cost more than the message itself');
  expect($('[data-composer-info]').textContent).not.toContain('On this path');
  expect($('.send-price').classList.contains('priced')).toBe(true);
  // After a send the line reports what was paid; the ceiling breakdown goes away.
  $<HTMLButtonElement>('[data-send]').click();
  await vi.waitFor(() => expect(line()).toBe('paid 2.25 sats'));
  expect(mount.querySelector('[data-price-breakdown]')).toBeNull();
});
it('shows no breakdown when the peer price is unknown or stale', async () => {
  for (const patch of [{ peer_msat: null }, { peer_stale: true }]) {
    const source = sourceForSend();
    source.priceQuote = async () => ({ ...quote, ...patch });
    await open(source);
    await vi.waitFor(() => expect(line()).toMatch(/price unavailable/));
    expect(mount.querySelector('[data-price-breakdown]')).toBeNull();
    expect($('.send-price').classList.contains('priced')).toBe(false);
    dispose?.(); mount.remove();
  }
});
