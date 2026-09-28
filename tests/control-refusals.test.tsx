import { afterEach, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';

const NOW = Date.UTC(2026, 8, 28, 14, 30);
const reasons = [
  'session_before_payment', 'delivery_before_payment', 'price_before_payment',
  'peer_exchange_before_payment', 'lightning_info_before_payment', 'gossip_before_payment',
  'invoice_error_before_payment', 'admission_required',
] as const;
const snapshot = () => ({
  hour_start_ms: NOW - 30 * 60_000,
  rows: reasons.map((reason, i) => ({
    reason, hour: { count: String(i + 1), at_least: false }, day: { count: String(i + 11), at_least: false },
  })),
});
let dispose: (() => void) | undefined;
let mount: HTMLElement;
afterEach(() => { dispose?.(); dispose = undefined; mount?.remove(); vi.useRealTimers(); });
const select = (s: string) => mount.querySelector<HTMLElement>(s);

type RefusalSnapshot = ReturnType<typeof snapshot> | null | undefined;

async function start(field: RefusalSnapshot = snapshot(), readAt = NOW - 20_000, organism: 'v1' | 'v2' = 'v2') {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const source = sampleSource({ firstLiveMs: 1e9, organism });
  const base = await sampleSource({ organism: 'v2' }).membrane(50);
  let current: RefusalSnapshot = field;
  let fail = false;
  source.membrane = async () => {
    if (fail) throw new Error('node unavailable');
    return { ...base, events: [], read_at: readAt, pre_payment_refusals: current };
  };
  const [active, setActive] = createSignal(true);
  mount = document.createElement('div');
  document.body.appendChild(mount);
  dispose = render(() => <ControlCenter source={source} active={active()} ready={true} error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
  await vi.advanceTimersByTimeAsync(1);
  return { set: (next: RefusalSnapshot) => { current = next; }, fail: () => { fail = true; }, setActive };
}

it('shows all eight refusal reasons in words, with separate hourly counts, source and host read age', async () => {
  await start();
  const panel = select('[data-pre-payment-refusals]');
  expect(panel).not.toBeNull();
  expect(panel!.textContent).toContain('Refused knocks before payment');
  expect(panel!.textContent).toContain('UTC');
  expect(panel!.textContent).toContain('control requests');
  expect(panel!.textContent).toContain('node');
  expect(select('[data-refusals-fresh]')!.textContent).toContain('20s ago');
  const labels = ['Session setup', 'Delivery replies', 'Price requests and replies', 'Peer exchange', 'Lightning information', 'Gossip', 'Invoice error replies', 'Admission payment required'];
  for (const [i, reason] of reasons.entries()) {
    const row = select(`[data-refusal-reason="${reason}"]`)!;
    expect(row.textContent).toContain(labels[i]);
    expect(row.querySelector('[data-refusals-hour]')!.textContent).toBe(String(i + 1));
    expect(row.querySelector('[data-refusals-day]')!.textContent).toBe(String(i + 11));
    expect(row.textContent).not.toContain(reason);
  }
  // Empty event history must not contradict nonzero aggregate refusals.
  expect(select('[data-membrane-quiet]')!.textContent).not.toContain('No knocks');
  expect(select('[data-membrane-refused] .sats')!.textContent).toBe('0');
});

it.each([null, undefined])('shows unavailable for an older node missing the field (%s), never zero', async field => {
  // Explicit undefined must bypass the helper default.
  const app = await start(null);
  app.set(field);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(select('[data-refusals-unavailable]')!.textContent).toContain('Unavailable');
  expect(select('[data-refusal-reason]')).toBeNull();
});

it('shows unavailable without membrane capability', async () => {
  await start(null, NOW, 'v1');
  expect(select('[data-refusals-unavailable]')!.textContent).toContain('Unavailable');
  expect(select('[data-refusal-reason]')).toBeNull();
});

it('shows known empty counters as zero and saturated totals as exact lower bounds', async () => {
  const field = snapshot();
  field.rows[0].hour = { count: '18446744073709551615', at_least: true };
  field.rows[0].day = { count: '36893488147419103230', at_least: true };
  field.rows[1].hour.count = '0';
  await start(field);
  const row = select('[data-refusal-reason="session_before_payment"]')!;
  expect(row.querySelector('[data-refusals-hour]')!.textContent).toBe('at least 18,446,744,073,709,551,615');
  expect(row.querySelector('[data-refusals-day]')!.textContent).toBe('at least 36,893,488,147,419,103,230');
  expect(select('[data-refusal-reason="delivery_before_payment"] [data-refusals-hour]')!.textContent).toBe('0');
});

it('refreshes aggregates without a live event, clears them when absent, and stops polling when inactive', async () => {
  const app = await start();
  const next = snapshot();
  next.rows[0].hour.count = '9';
  app.set(next);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(select('[data-refusal-reason="session_before_payment"] [data-refusals-hour]')!.textContent).toBe('9');
  app.set(null);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(select('[data-refusals-unavailable]')).not.toBeNull();
  expect(select('[data-refusal-reason]')).toBeNull();
  app.setActive(false);
  app.set(snapshot());
  await vi.advanceTimersByTimeAsync(30_000);
  expect(select('[data-refusal-reason]')).toBeNull();
});

it('keeps failed refresh counts visibly stale without advancing their window or claiming live data', async () => {
  const app = await start(snapshot(), NOW - 120_000);
  expect(select('[data-refusals-fresh]')!.dataset.refusalsFresh).toBe('stale');
  app.fail();
  await vi.advanceTimersByTimeAsync(61 * 60_000);
  expect(select('[data-refusals-fresh]')!.textContent).toContain('could not re-read');
  expect(select('[data-refusals-fresh]')!.dataset.refusalsFresh).toBe('stale');
  expect(select('[data-refusal-reason="session_before_payment"] [data-refusals-hour]')!.textContent).toBe('1');
});
