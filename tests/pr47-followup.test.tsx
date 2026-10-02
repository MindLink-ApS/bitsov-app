import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID, SAMPLE_PRESETS } from '../src/control/sample';
import { membraneNode, membraneSeed, type MembraneEntry } from '../src/control/body';
import type { BudgetView, LiveEvent, MembraneEvent } from '../src/control/types';
let dispose: (() => void) | undefined;
let mount: HTMLElement;
afterEach(() => { dispose?.(); dispose = undefined; mount?.remove(); });
const A = 'a'.repeat(64), B = 'b'.repeat(64);
const select = <T extends HTMLElement = HTMLElement>(s: string) => mount.querySelector<T>(s)!;
const openBudget = (): BudgetView => ({
  paused: false, waiting_for_owner: false, preset: 'careful',
  autopay: { state: 'open', open_until_ms: Date.now() + 86400000, ceiling_msat: 500000, basis: 'node_grant' },
  ceiling_msat: 500000, spent_msat: 0, unsettled_msat: 0,
  rows: [A, B].map(target => ({ target, room: false, limit_msat: 50000, spent_msat: 0 })),
  presets: SAMPLE_PRESETS, window_ms: 86400000, max_daily_msat: 100000000, node_grant: null,
});
function start(source: ReturnType<typeof sampleSource>) {
  mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <ControlCenter source={source} active={true} ready={true} error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
}
function type(text: string) {
  const el = select<HTMLTextAreaElement>('[data-composer] textarea');
  el.value = text; el.dispatchEvent(new Event('input', { bubbles: true }));
}
it('keeps a delayed readmission refusal attached to submitted peer A after switching to B', async () => {
  const source = sampleSource({ firstLiveMs: 1e9 });
  source.budgetStatus = async () => openBudget();
  source.priceQuote = async () => ({ kind: 0, own_msat: 1000, peer_msat: 2000, peer_age_secs: 0, max_routing_fee_msat: 0, peer_stale: false });
  let finish!: () => void;
  source.send = vi.fn(async () => {
    await new Promise<void>(resolve => { finish = resolve; });
    throw { code: 'grant_readmission', message: 'Peer A needs admission again.' };
  });
  source.firstContactQuote = vi.fn(async peer => ({ recipient: peer, admission_msat: 3000, message_msat: 2000, total_msat: 5000, expires_at: Math.floor(Date.now() / 1000) + 60 }));
  start(source);
  await vi.waitFor(() => expect(select(`[data-track="peer:${A}"]`).getAttribute('aria-current')).toBe('true'));
  type('A submitted draft');
  await vi.waitFor(() => expect(select<HTMLButtonElement>('[data-send]').disabled).toBe(false));
  select<HTMLButtonElement>('[data-send]').click();
  await vi.waitFor(() => expect(source.send).toHaveBeenCalledTimes(1));
  select<HTMLButtonElement>(`[data-track="peer:${B}"]`).click();
  type('B unsubmitted draft');
  finish();
  await vi.waitFor(() => expect(select<HTMLButtonElement>('[data-send]').disabled).toBe(false));
  expect(select('[data-first-contact]'), 'B never refused admission and must retain its normal composer').toBeNull();
  expect(select('[data-cost-msat]').getAttribute('data-cost-msat')).toBe('2000');
  expect(source.firstContactQuote).not.toHaveBeenCalled();
  select<HTMLButtonElement>(`[data-track="peer:${A}"]`).click();
  await vi.waitFor(() => expect(select('[data-readmit]')).not.toBeNull());
  expect(vi.mocked(source.firstContactQuote).mock.calls.every(([peer]) => peer === A)).toBe(true);
});
it('retains restarted-node events through seed/live overlap without duplicates', () => {
  const ctx = { contacts: new Set<string>() };
  const event: MembraneEvent = { seq: 1, at: 1000, direction: 'inbound', verdict: 'refused', code: 'unpaid', kind: 0, counterparty: A, first_contact: false, required_msat: 1000, paid_msat: 0, cap_msat: null };
  const after = { ...event, at: 100000, code: 'replay' };
  let log: MembraneEntry[] = membraneNode([], event, ctx);
  log = membraneNode(log, after, ctx);
  log = membraneSeed(log, [after, { ...after, seq: 2, at: 100001 }], ctx);
  expect(log).toHaveLength(3);
  expect(log.map(e => e.at)).toEqual([100001, 100000, 1000]);
});
it('failed reconnect ring read clears Live and successful reconnect read restores it', async () => {
  const source = sampleSource({ firstLiveMs: 1e9, organism: 'v2' });
  let handler!: (event: LiveEvent) => void;
  source.onLive = async cb => { handler = cb; cb({ type: 'link', state: 'open', detail: null }); return () => {}; };
  source.liveLink = async () => 'open';
  let fail = false;
  const base = source.membrane;
  source.membrane = vi.fn(async limit => { if (fail) throw new Error('read failed'); return base(limit); });
  start(source);
  const fresh = () => select('[data-organ="membrane"] [data-organ-fresh]')?.textContent;
  await vi.waitFor(() => expect(fresh()).toBe('Live'));
  await vi.waitFor(() => expect(source.membrane).toHaveBeenCalled());
  await vi.waitFor(() => expect(fresh()).toBe('Live'));
  fail = true;
  handler({ type: 'link', state: 'closed', detail: null });
  handler({ type: 'link', state: 'open', detail: null });
  await vi.waitFor(() => expect(fresh()).toBe('Reading unavailable'));
  fail = false;
  handler({ type: 'link', state: 'closed', detail: null });
  handler({ type: 'link', state: 'open', detail: null });
  await vi.waitFor(() => expect(fresh()).toBe('Live'));
});
