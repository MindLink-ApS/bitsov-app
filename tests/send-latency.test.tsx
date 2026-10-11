import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';

// Measures what the owner sees while a paid message is in flight: the host's
// message_send is stubbed to take SEND_MS (pre-flight + pay + deliver).
const A = 'a'.repeat(64);
const SEND_MS = 1200;
let dispose: (() => void) | undefined;
let mount: HTMLElement;
afterEach(() => { dispose?.(); mount?.remove(); vi.useRealTimers(); });
const $ = <T extends HTMLElement = HTMLElement>(s: string) => mount.querySelector<T>(s);
const quote = { kind: 0, own_msat: 9000, peer_msat: 2250, peer_age_secs: 30, peer_stale: false, max_routing_fee_msat: 7500 };

it('reports click → bubble visible and click → paid for a 1.2 s send', async () => {
  const source = sampleSource({ firstLiveMs: 1e9 });
  source.spendStatus = async () => ({ state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 600000, pending: null, window_ms: 600000 });
  source.priceQuote = async () => quote;
  source.send = vi.fn((recipient, isRoom) => new Promise((ok) => setTimeout(() => ok({ message_id: 'm-latency', recipient, is_room: isRoom, delivered: true, amount_msat: 2250, fee_paid_msat: 0, max_routing_fee_msat: 7500, total_msat: 9750, sent_at_ms: Date.now() }), SEND_MS)));
  mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <ControlCenter source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
  await vi.waitFor(() => expect($(`[data-track="peer:${A}"]`)?.getAttribute('aria-current')).toBe('true'));
  const area = $<HTMLTextAreaElement>('[data-composer] textarea')!;
  area.value = 'latency probe'; area.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.waitFor(() => expect($('[data-send-price]')?.textContent).toMatch(/^up to/));

  const visible = () => [...mount.querySelectorAll('.msg.out')].some((m) => m.textContent?.includes('latency probe'));
  const t0 = performance.now();
  $<HTMLButtonElement>('[data-send]')!.click();
  let bubbleAt: number | null = null;
  let paidAt: number | null = null;
  await vi.waitFor(() => {
    const now = performance.now();
    if (bubbleAt === null && visible()) bubbleAt = now - t0;
    if (paidAt === null && /^paid /.test($('[data-send-price]')?.textContent ?? '')) paidAt = now - t0;
    expect(paidAt).not.toBeNull();
  }, { timeout: SEND_MS + 2000, interval: 10 });
  // eslint-disable-next-line no-console
  console.log(`SEND-LATENCY bubble_ms=${Math.round(bubbleAt ?? -1)} paid_ms=${Math.round(paidAt ?? -1)} send_ms=${SEND_MS}`);
  expect(bubbleAt).not.toBeNull();
}, 10_000);
