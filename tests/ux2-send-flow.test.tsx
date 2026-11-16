import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { ControlCenter, TouchApproval } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';
import { setLanguagePref } from '../src/i18n';
import type { BudgetView, LiveEvent, SpendView } from '../src/control/types';

const A = 'a'.repeat(64);
let dispose: (() => void) | undefined;
let mount: HTMLElement;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  mount?.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  setLanguagePref('en');
});
const $ = <T extends HTMLElement = HTMLElement>(s: string) => mount.querySelector<T>(s)!;
const type = (value: string) => { const area = $<HTMLTextAreaElement>('[data-composer] textarea'); area.value = value; area.dispatchEvent(new Event('input', { bubbles: true })); };
function setup(granted = true) {
  const source = sampleSource({ firstLiveMs: 1e9 });
  let spend: SpendView = { state: 'locked', granted_op: null, basis: null, open_until_ms: null, pending: null, window_ms: 600000 };
  const base = source.budgetStatus;
  const grant = () => ({ expires_at_ms: Date.now() + 86400000, budget_msat: 200000, remaining_msat: 199000, per_call_max_msat: 200000, envelopes: { [A]: Date.now() + 86400000 }, envelope_id_by_recipient: { [A]: 'envelope-a' } });
  source.budgetStatus = async () => ({ ...await base(), autopay: { state: 'off', basis: null, open_until_ms: null, ceiling_msat: null }, node_grant: granted ? grant() : null } as BudgetView);
  source.spendStatus = async () => spend;
  source.deviceKeyStatus = async () => ({ state: 'registered', available: true, key_id: 'key', fingerprint: 'fp', owner_action: null, expires_at_ms: null });
  source.relationApprove = vi.fn(async () => { granted = true; spend = { ...spend, state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 600000, envelope_id: 'envelope-a' }; return spend; });
  source.spendRequest = vi.fn(async () => { spend = { ...spend, state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 600000, granted_op: 'grant-a' }; return spend; });
  source.priceQuote = async () => ({ kind: 0, own_msat: 1000, peer_msat: 1000, peer_age_secs: 0, peer_stale: false, max_routing_fee_msat: 5000 });
  source.send = vi.fn(async (recipient) => ({ message_id: 'message-a', operation_id: 'op-a', state: 'sent', recipient, is_room: false, delivered: true, amount_msat: 1000, fee_paid_msat: 0, sent_at_ms: Date.now() }));
  let emit: (event: LiveEvent) => void = () => {};
  source.onLive = async handler => { emit = handler; handler({ type: 'link', state: 'closed', detail: null }); return () => {}; };
  source.liveLink = async () => 'closed';
  return { source, emit: (event: LiveEvent) => emit(event) };
}
async function open(source: ReturnType<typeof sampleSource>) {
  mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <ControlCenter source={source} remote active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
  await vi.waitFor(() => expect($('[data-composer] textarea')).not.toBeNull());
  await vi.waitFor(() => expect($('[data-budget-stale]')).toBeNull());
}
it.each(['en', 'da'] as const)('uses a live grant for Send and shows its remainder in %s', async lang => {
  setLanguagePref(lang);
  const { source } = setup(); await open(source); type('hello');
  await vi.waitFor(() => expect($('[data-send]').textContent).toBe('Send'));
  expect($('[data-touch-approval]')).toBeNull();
  expect($('[data-send-budget]')?.textContent).toContain('199 sats');
  expect($('[data-send-budget]')?.textContent).toBe(lang === 'en'
    ? 'Node grant: 199 sats left. Separate app limits apply.'
    : 'Boksens budget: 199 sats tilbage. Appens grænser gælder også.');
  $<HTMLButtonElement>('[data-send]').click();
  await vi.waitFor(() => expect(source.send).toHaveBeenCalledTimes(1));
  expect(source.relationApprove).not.toHaveBeenCalled();
});
it('clears the approval banner after Touch ID succeeds', async () => {
  const { source } = setup(false); await open(source); type('hello');
  await vi.waitFor(() => expect($('[data-touch-approval]')).not.toBeNull());
  $<HTMLButtonElement>('[data-send]').click();
  await vi.waitFor(() => expect($('[data-touch-approval]')).toBeNull());
  expect($('[data-send]').textContent).toBe('Send');
  expect($('[data-send-budget]')?.textContent).toContain('199 sats');
});
it.each([['en', true], ['en', false], ['da', true], ['da', false]] as const)('empty draft disables Send with the same hint (%s, grant=%s)', async (lang, granted) => {
  setLanguagePref(lang); const { source } = setup(granted); await open(source);
  expect($<HTMLButtonElement>('[data-send]').disabled).toBe(true);
  expect($('[data-send-disabled-reason]')?.textContent).toBe(lang === 'da' ? 'Skriv en besked først.' : 'Type a message first.');
  $('[data-composer]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  expect(source.relationApprove).not.toHaveBeenCalled();
  expect(source.send).not.toHaveBeenCalled();
});
it('keeps paid amounts on the bubble, never in an empty composer', async () => {
  const { source } = setup(); await open(source); type('hello');
  $<HTMLButtonElement>('[data-send]').click();
  await vi.waitFor(() => expect($('[data-message="message-a"]')).not.toBeNull());
  expect($<HTMLTextAreaElement>('[data-composer] textarea').value).toBe('');
  expect($('[data-send-price]').textContent).not.toMatch(/paid|betalt/);
  expect($('[data-message="message-a"]').textContent).toContain('1 sat');
});
it('moves sending → sent → delivered on a delivery event', async () => {
  const { source, emit } = setup();
  let finish!: (r: Awaited<ReturnType<typeof source.send>>) => void;
  const send = source.send;
  source.send = vi.fn(() => new Promise<Awaited<ReturnType<typeof source.send>>>(resolve => { finish = resolve; }));
  await open(source); type('hello'); $<HTMLButtonElement>('[data-send]').click();
  await vi.waitFor(() => expect($('[data-sending]')).not.toBeNull());
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  finish(await send(A, false, 'hello', 6000));
  await vi.waitFor(() => expect($('[data-delivery="sent"]')).not.toBeNull());
  emit({ type: 'delivery', message_id: 'message-a', status: 'delivered', reason: null });
  expect($('[data-delivery="delivered"]')).not.toBeNull();
  expect($('[data-sending]')).toBeNull();
});
it('recovers delivery by operation ID when the remote event stream is down', async () => {
  const { source } = setup();
  source.messageDelivery = vi.fn(async (): Promise<LiveEvent> => ({ type: 'delivery', message_id: 'message-a', status: 'delivered', reason: null }));
  await open(source); type('hello'); $<HTMLButtonElement>('[data-send]').click();
  await vi.waitFor(() => expect($('[data-delivery="delivered"]')).not.toBeNull(), { timeout: 3000 });
  expect(source.messageDelivery).toHaveBeenCalledWith('op-a', 'message-a');
  expect(source.send).toHaveBeenCalledTimes(1);
});
it('Details is an accessible full-row disclosure with an expanded state', () => {
  mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <TouchApproval peer={A} name="Maya" priceMsat={6000} actions={{} as never} />, mount);
  const toggle = $<HTMLButtonElement>('[data-touch-detail] button');
  expect(toggle).not.toBeNull();
  expect(toggle.textContent).toContain('Details');
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  toggle.focus(); expect(document.activeElement).toBe(toggle);
  toggle.click(); expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(document.getElementById(toggle.getAttribute('aria-controls')!)).not.toBeNull();
  toggle.click(); expect(toggle.getAttribute('aria-expanded')).toBe('false');
});
it.each(['expired', 'other-contact', 'exhausted', 'paused'] as const)('does not advertise a usable grant when it is %s', async state => {
  const { source } = setup(); const read = source.budgetStatus;
  source.budgetStatus = async () => {
    const b = await read();
    if (state === 'expired') b.node_grant!.expires_at_ms = Date.now() - 1;
    if (state === 'other-contact') b.node_grant!.envelopes = { ['b'.repeat(64)]: Date.now() + 60000 };
    if (state === 'exhausted') b.node_grant!.remaining_msat = 0;
    if (state === 'paused') b.paused = true;
    return b;
  };
  await open(source); type('hello');
  expect($('[data-send-budget]')).toBeNull();
  expect(source.send).not.toHaveBeenCalled();
  if (state !== 'paused') expect($('[data-send]').textContent).toBe('Approve with Touch ID');
});
it('keeps a delivery event arriving before compose ahead of the late receipt', async () => {
  const { source, emit } = setup(); const send = source.send;
  source.send = async (...args) => {
    emit({ type: 'delivery', message_id: 'message-a', status: 'delivered', reason: null });
    return send(...args);
  };
  source.messageDelivery = vi.fn(async () => null);
  await open(source); type('hello'); $<HTMLButtonElement>('[data-send]').click();
  await vi.waitFor(() => expect($('[data-delivery="delivered"]')).not.toBeNull());
  expect($('[data-delivery="sent"]')).toBeNull();
  expect(source.messageDelivery).not.toHaveBeenCalled();
});
it('uses compose acknowledgement immediately without polling', async () => {
  const { source } = setup(); const send = source.send;
  source.send = async (...args) => ({ ...await send(...args), accepted: true, state: 'acked' });
  source.messageDelivery = vi.fn(async () => null);
  await open(source); type('hello'); $<HTMLButtonElement>('[data-send]').click();
  await vi.waitFor(() => expect($('[data-delivery="accepted"]')).not.toBeNull());
  expect(source.messageDelivery).not.toHaveBeenCalled();
});
it('clears a remembered envelope refusal only after a newer read proves the contact approved', async () => {
  const { source, emit } = setup(); const read = source.budgetStatus;
  let refused = false;
  let renewed = false;
  source.budgetStatus = async () => {
    const b = await read();
    if (refused && !renewed) b.node_grant!.envelopes = {};
    return b;
  };
  source.send = vi.fn(async () => { refused = true; throw { code: 'grant_no_envelope', message: 'This contact needs approval.' }; });
  await open(source); type('hello'); $<HTMLButtonElement>('[data-send]').click();
  await vi.waitFor(() => expect($('[data-touch-approval]')).not.toBeNull());
  renewed = true;
  emit({ type: 'link', state: 'open', detail: null });
  await vi.waitFor(() => expect($('[data-touch-approval]')).toBeNull());
  expect($('[data-send-budget]')?.textContent).toContain('199 sats');
  expect(source.relationApprove).not.toHaveBeenCalled();
  expect(source.send).toHaveBeenCalledTimes(1);
});
it('shows the smaller live app/contact budget rather than overstating the node remainder', async () => {
  const { source } = setup(); const read = source.budgetStatus;
  source.budgetStatus = async () => ({ ...await read(),
    autopay: { state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 60000, ceiling_msat: 100000 },
    rows: [{ target: A, room: false, limit_msat: 50000, spent_msat: 1000, unsettled_msat: 0, accounted_msat: 7000 }],
  });
  await open(source); type('hello');
  expect($('[data-send-budget]')?.textContent).toContain('43 sats');
});
it.each(['en', 'da'] as const)('names the node remainder and separate app limits without automatic approval in %s', async lang => {
  setLanguagePref(lang);
  const { source } = setup(); const read = source.budgetStatus;
  source.budgetStatus = async () => {
    const b = await read();
    return { ...b, ceiling_msat: 5_000_000, spent_msat: 31_000, unsettled_msat: 0, accounted_msat: 42_000, fee_unknown: true,
      node_grant: { ...b.node_grant!, budget_msat: 5_000_000, remaining_msat: 4_368_000 },
      rows: [{ target: A, room: false, limit_msat: 50_000, spent_msat: 31_000, unsettled_msat: 0, accounted_msat: 42_000, fee_unknown: true }],
    };
  };
  await open(source); type('hello');
  expect($('[data-send-budget]')?.textContent).toBe(lang === 'en'
    ? 'Node grant: 4\u202f368 sats left. Separate app limits apply.'
    : 'Boksens budget: 4\u202f368 sats tilbage. Appens grænser gælder også.');
  expect($('[data-send-app-budget]')?.textContent).toBe(lang === 'en'
    ? 'App limits for the last 24 hours: 8 sats left for this contact; 4\u202f958 sats left in total. Change these limits in Budget.'
    : 'Appens grænser for de seneste 24 timer: 8 sats tilbage til denne kontakt; 4\u202f958 sats tilbage i alt. Ret grænserne under Budget.');
  expect(source.relationApprove).not.toHaveBeenCalled();
  expect(source.send).not.toHaveBeenCalled();
});
it('clears the approval banner immediately while the post-approval budget read is pending', async () => {
  const { source } = setup(false); const read = source.budgetStatus; const approve = source.relationApprove;
  let approved = false;
  let finish!: (b: BudgetView) => void;
  source.relationApprove = async (...args) => { const result = await approve(...args); approved = true; return result; };
  source.budgetStatus = () => approved ? new Promise(resolve => { finish = resolve; }) : read().then(b => ({ ...b, node_grant: { expires_at_ms: Date.now() + 60000, budget_msat: 200000, remaining_msat: 199000, per_call_max_msat: 200000, envelopes: {} } }));
  await open(source); type('hello'); $<HTMLButtonElement>('[data-send]').click();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  expect($('[data-touch-approval]')).toBeNull();
  expect($('[data-send]').textContent).toBe('Send');
  expect($<HTMLButtonElement>('[data-send]').disabled).toBe(true);
  finish(await read());
  await vi.waitFor(() => expect($('[data-send-budget]')?.textContent).toContain('199 sats'));
});

it.each(['pending', 'unavailable', 'expired'] as const)('an empty composer keeps its hint when spending is %s', async state => {
  const { source } = setup(false);
  source.spendStatus = async () => ({ state, basis: null, open_until_ms: null, pending: null, window_ms: 600000 });
  await open(source);
  expect($<HTMLButtonElement>('[data-send]').disabled).toBe(true);
  expect($('[data-send-disabled-reason]')?.textContent).toBe('Type a message first.');
});
