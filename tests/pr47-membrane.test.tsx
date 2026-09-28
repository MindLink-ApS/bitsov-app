import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';
import { MEMBRANE_KEEP, membraneNode, membraneSeed } from '../src/control/body';
import type { LiveEvent, MembraneEvent, MembraneRead } from '../src/control/types';

const ctx = { contacts: new Set<string>() };
const event = (seq: number, at = 1000 + seq): MembraneEvent => ({
  seq, at, direction: 'inbound', verdict: 'refused', code: 'unpaid', kind: 0,
  counterparty: null, first_contact: false, required_msat: 1000, paid_msat: 0, cap_msat: null,
});

it('keeps the latest live event ahead of delayed historical backfill', () => {
  const live = membraneNode([], event(51), ctx);
  const merged = membraneSeed(live, Array.from({ length: 50 }, (_, i) => event(i + 1)), ctx);
  expect(merged.slice(0, 3).map(e => e.node_seq)).toEqual([51, 50, 49]);
  expect(merged[0]).toBe(live[0]);
});

it('merges overlapping history once, using node sequence to order equal timestamps', () => {
  const live = membraneNode([], event(3, 1000), ctx);
  const merged = membraneSeed(live, [event(1, 1000), event(2, 1000), event(3, 1000)], ctx);
  expect(merged.map(e => e.node_seq)).toEqual([3, 2, 1]);
  expect(merged[0]).toBe(live[0]);
  expect(new Set(merged.map(e => e.seq)).size).toBe(3);
});

it('retains the newest bounded history when a restarted node resets sequence numbers', () => {
  const live = membraneNode([], event(1, 10000), ctx);
  const history = Array.from({ length: MEMBRANE_KEEP }, (_, i) => event(i + 2));
  const merged = membraneSeed(live, history, ctx);
  expect(merged).toHaveLength(MEMBRANE_KEEP);
  expect(merged[0]).toBe(live[0]);
  expect(merged[merged.length - 1].at).toBe(1003);
});

let dispose: (() => void) | undefined;
let mount: HTMLElement;
afterEach(() => { dispose?.(); dispose = undefined; mount?.remove(); });
const select = (s: string) => mount.querySelector(s)!;

function start(source: ReturnType<typeof sampleSource>) {
  mount = document.createElement('div');
  document.body.appendChild(mount);
  dispose = render(() => <ControlCenter source={source} active={true} ready={true} error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
}

it('shows unread counts as unknown until a successful empty ring read', async () => {
  const source = sampleSource({ firstLiveMs: 1e9, organism: 'v2' });
  const base = await source.membrane(50);
  let finish!: (read: MembraneRead) => void;
  source.membrane = () => new Promise(resolve => { finish = resolve; });
  source.onLive = async handler => { handler({ type: 'link', state: 'open', detail: null }); return () => {}; };
  source.liveLink = async () => 'open';
  start(source);
  await vi.waitFor(() => expect(finish).toBeDefined());
  expect(select('[data-organ="membrane"] .organ-summary').textContent).not.toContain('0 in');
  expect(select('[data-membrane-admitted] .sats').textContent).toBe('—');
  expect(select('[data-membrane-refused] .sats').textContent).toBe('—');
  expect(select('[data-membrane-quiet]').textContent).not.toContain('No knocks');
  finish({ ...base, events: [] });
  await vi.waitFor(() => expect(select('[data-membrane-admitted] .sats').textContent).toBe('0'));
  expect(select('[data-membrane-quiet]').textContent).toContain('No knocks');
});

it('does not claim empty history after a failed initial read or failed reconnect', async () => {
  const source = sampleSource({ firstLiveMs: 1e9, organism: 'v2' });
  const base = await source.membrane(50);
  let fail = true;
  let handler!: (event: LiveEvent) => void;
  source.membrane = async () => { if (fail) throw new Error('unavailable'); return { ...base, events: [] }; };
  source.onLive = async cb => { handler = cb; cb({ type: 'link', state: 'open', detail: null }); return () => {}; };
  source.liveLink = async () => 'open';
  start(source);
  const freshness = () => select('[data-organ="membrane"] [data-organ-fresh]').textContent;
  await vi.waitFor(() => expect(freshness()).toBe('Reading unavailable'));
  expect(select('[data-membrane-quiet]').textContent).not.toContain('No knocks');
  expect(select('[data-membrane-admitted] .sats').textContent).toBe('—');
  fail = false;
  handler({ type: 'link', state: 'closed', detail: null });
  handler({ type: 'link', state: 'open', detail: null });
  await vi.waitFor(() => expect(freshness()).toBe('Live'));
  expect(select('[data-membrane-quiet]').textContent).toContain('No knocks');
  fail = true;
  handler({ type: 'link', state: 'closed', detail: null });
  handler({ type: 'link', state: 'open', detail: null });
  await vi.waitFor(() => expect(freshness()).toBe('Reading unavailable'));
  expect(select('[data-membrane-quiet]').textContent).not.toContain('No knocks');
  expect(select('[data-membrane-admitted] .sats').textContent).toBe('0');
});
