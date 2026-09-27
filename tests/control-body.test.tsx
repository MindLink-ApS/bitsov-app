import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID, SAMPLE_PEERS, SAMPLE_PRESETS } from '../src/control/sample';
import { ago } from '../src/control/format';
import { feedState, homeostasis, membraneLive, membraneRefused, membraneSummary, metabolism, nucleus, outboundKind, MEMBRANE_KEEP, type MembraneEntry } from '../src/control/body';
import type { BudgetView, LiveEvent, Message } from '../src/control/types';

// O1 v1 organism view: every figure is a reading the app already holds. These
// pin the rules — windows, what counts as an admission or a refusal, what
// "no setpoint" means — and that the panel never shows what it cannot read.

const OWN = '1'.repeat(64);
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const STRANGER = 'e'.repeat(64);
const ROOM = '0f8e2b7a-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
const NOW = Date.UTC(2026, 8, 27, 14, 0);
const MIN = 60_000;

const m = (id: string, from: string, to: string, agoMin: number, msat: number | null): Message => ({
  id, kind: 0, sender: from, recipient: to, timestamp: NOW - agoMin * MIN, plaintext: id, payment_amount_msat: msat,
});

describe('metabolism', () => {
  const threads = {
    [`peer:${A}`]: [m('a1', A, OWN, 10, 2000), m('a2', OWN, A, 20, 2000), m('a3', A, OWN, 120, 2000), m('a4', A, OWN, 25 * 60, 9000)],
    [`peer:${B}`]: [m('b1', B, OWN, 5, null), m('b2', OWN, B, 30, 1000)],
    [`room:${ROOM}`]: [m('r1', OWN, ROOM, 50, 2000)],
  };

  it('sums paid messages in the last hour and 24 hours by their own timestamps', () => {
    const e = metabolism(threads, OWN, NOW, { r1: 3000 });
    // a1 in; a2, b2 and the room send (its receipt paid 3000, not the echo's 2000) out.
    expect(e.hour).toEqual({ in_msat: 2000, out_msat: 6000, acts_in: 1, acts_out: 3 });
    // a3 is two hours old; a4 is older than a day and does not count.
    expect(e.day).toEqual({ in_msat: 4000, out_msat: 6000, acts_in: 2, acts_out: 3 });
    expect(e.tracks_read).toBe(3);
  });

  it('lists counterparties by energy, and an unpaid message is not an act', () => {
    const e = metabolism(threads, OWN, NOW, { r1: 3000 });
    expect(e.rows.map((r) => r.key)).toEqual([`peer:${A}`, `room:${ROOM}`, `peer:${B}`]);
    expect(e.rows[2]).toMatchObject({ in_msat: 0, out_msat: 1000, acts_in: 0, acts_out: 1 });
  });

  it('counts a message that arrived between clock ticks as now', () => {
    const just = { [`peer:${A}`]: [{ ...m('j1', A, OWN, 0, 2000), timestamp: NOW + 2000 }] };
    expect(metabolism(just, OWN, NOW).hour.in_msat).toBe(2000);
  });

  it('is empty, not invented, when nothing was read', () => {
    const e = metabolism({}, OWN, NOW);
    expect(e.day).toEqual({ in_msat: 0, out_msat: 0, acts_in: 0, acts_out: 0 });
    expect(e.rows).toEqual([]);
    expect(e.tracks_read).toBe(0);
  });
});

describe('membrane', () => {
  const ctx = { ownId: OWN, contacts: new Set([A]), threads: { [`peer:${B}`]: [m('sent-1', OWN, B, 1, 1000)] }, nowMs: NOW };
  const live = (msg: Message, room: string | null = null): LiveEvent => ({ type: 'message', message: msg, room_id: room });

  it('counts an inbound message as an admission, and a stranger as a first contact never added', () => {
    let log: MembraneEntry[] = [];
    log = membraneLive(log, live(m('x1', A, OWN, 0, 2000)), ctx);
    log = membraneLive(log, live(m('x2', STRANGER, OWN, 0, 1000)), ctx);
    expect(log[0]).toMatchObject({ verdict: 'admitted', sender: STRANGER, first_contact: true, paid_msat: 1000, track: `peer:${STRANGER}` });
    expect(log[1]).toMatchObject({ verdict: 'admitted', sender: A, first_contact: false });
    expect(ctx.contacts.has(STRANGER)).toBe(false);
    expect(membraneSummary(log)).toMatchObject({ admitted: 2, admitted_msat: 3000, first_contacts: 1, refused: 0 });
  });

  it('ignores our own echoes and a message repeated after a reconnect', () => {
    let log: MembraneEntry[] = [];
    log = membraneLive(log, live(m('o1', OWN, A, 0, 2000)), ctx);
    expect(log).toEqual([]);
    log = membraneLive(log, live(m('x1', A, OWN, 0, 2000)), ctx);
    log = membraneLive(log, live(m('x1', A, OWN, 0, 2000)), ctx);
    expect(log).toHaveLength(1);
  });

  it('records a delivery the recipient rejected at their door, against the track it was sent in', () => {
    const log = membraneLive([], { type: 'delivery', message_id: 'sent-1', status: 'rejected', reason: 'insufficient payment' }, ctx);
    expect(log[0]).toMatchObject({ verdict: 'refused', kind: 'door', detail: 'insufficient payment', track: `peer:${B}` });
    expect(membraneLive([], { type: 'delivery', message_id: 'sent-1', status: 'delivered', reason: null }, ctx)).toEqual([]);
  });

  it('takes price and setpoint refusals, never the owner’s questions', () => {
    expect(outboundKind({ code: 'price_cap_exceeded', message: '' })).toBe('price');
    expect(outboundKind({ code: 'budget_exhausted', message: '' })).toBe('setpoint');
    expect(outboundKind({ code: 'grant_exhausted', message: '' })).toBe('setpoint');
    for (const code of ['first_contact', 'budget_needed', 'spend_locked', 'spend_unknown', 'grant_unknown', 'node'] as const) {
      expect(outboundKind({ code, message: '' })).toBeNull();
    }
    const log = membraneRefused([], { code: 'ceiling_exhausted', message: 'daily total used' }, `peer:${A}`, NOW);
    expect(membraneSummary(log).refused_by).toEqual({ door: 0, price: 0, setpoint: 1, inbound: 0 });
  });

  it('keeps a bounded buffer, newest first', () => {
    let log: MembraneEntry[] = [];
    for (let i = 0; i < MEMBRANE_KEEP + 20; i++) log = membraneLive(log, live(m(`k${i}`, A, OWN, 0, 1000)), ctx);
    expect(log).toHaveLength(MEMBRANE_KEEP);
    expect((log[0] as { message_id: string }).message_id).toBe(`k${MEMBRANE_KEEP + 19}`);
  });
});

describe('homeostasis, nucleus and feed', () => {
  const view = (over: Partial<BudgetView> = {}): BudgetView => ({
    paused: false,
    autopay: { state: 'open', open_until_ms: NOW + 19 * 3_600_000, ceiling_msat: 500_000, basis: 'node_grant' },
    waiting_for_owner: false,
    preset: 'careful',
    ceiling_msat: 500_000,
    spent_msat: 60_000,
    unsettled_msat: 0,
    rows: [
      { target: A, room: false, limit_msat: 50_000, spent_msat: 50_000 },
      { target: B, room: false, limit_msat: 50_000, spent_msat: 10_000 },
      { target: STRANGER, room: false, limit_msat: null, spent_msat: 0 },
    ],
    presets: SAMPLE_PRESETS,
    window_ms: 86_400_000,
    max_daily_msat: 100_000_000,
    node_grant: null,
    ...over,
  });

  it('holds setpoints inside the daily total, and names the ones reached', () => {
    const h = homeostasis(view({ node_grant: { expires_at_ms: NOW + 3_600_000, budget_msat: 2_000_000, remaining_msat: 1_180_000, per_call_max_msat: 20_000 } }));
    expect(h.state).toBe('holding');
    if (h.state !== 'holding') return;
    expect(h.rows.map((r) => r.target)).toEqual([A, B]);
    expect(h.reached.map((r) => r.target)).toEqual([A]);
    expect(h.grant).toEqual({ remaining_msat: 1_180_000, budget_msat: 2_000_000, expires_at_ms: NOW + 3_600_000 });
  });

  it('says "no setpoint" when no approval is in force, and never before budgets are read', () => {
    expect(homeostasis(null)).toEqual({ state: 'unknown' });
    expect(homeostasis(view({ autopay: { state: 'off', open_until_ms: null, ceiling_msat: null, basis: null } }))).toMatchObject({ state: 'none', expired: false });
    expect(homeostasis(view({ autopay: { state: 'expired', open_until_ms: null, ceiling_msat: null, basis: null } }))).toMatchObject({ state: 'none', expired: true });
    expect(homeostasis(view({ paused: true })).state).toBe('paused');
  });

  it('reads the nucleus from identity and /status only', () => {
    expect(nucleus(null, null)).toEqual({ node_id: null, block_height: null, chain_backend: null, read_at: null });
    expect(nucleus(OWN, null).node_id).toBe(OWN);
  });

  it('keeps the last reading with its age when the feed is down', () => {
    expect(feedState('open', null, NOW, ago)).toEqual({ live: true, label: 'Live', stale: false });
    expect(feedState('closed', NOW - 3 * MIN, NOW, ago)).toEqual({ live: false, label: 'Feed down · last reading 3 min ago', stale: true });
  });
});

describe('Body panel', () => {
  let dispose: (() => void) | undefined;
  let mount: HTMLElement;
  afterEach(() => {
    dispose?.();
    mount?.remove();
  });
  const $ = <T extends HTMLElement = HTMLElement>(sel: string) => mount.querySelector<T>(sel);

  function start() {
    const source = sampleSource({ firstLiveMs: 1e9 });
    let emit: (e: LiveEvent) => void = () => {};
    source.onLive = (handler) => {
      emit = handler;
      handler({ type: 'link', state: 'open', detail: null });
      return Promise.resolve(() => {});
    };
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => <ControlCenter source={source} active={true} ready={true} error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
    return { source, emit: (e: LiveEvent) => emit(e) };
  }

  it('opens on the Body tab with five organs, each tagged as sample data', async () => {
    start();
    await vi.waitFor(() => expect($('[data-panel="body"]')).not.toBeNull());
    expect($('[data-tab="body"]')?.getAttribute('aria-selected')).toBe('true');
    const organs = [...mount.querySelectorAll('[data-organ]')].map((o) => o.getAttribute('data-organ'));
    expect(organs).toEqual(['metabolism', 'membrane', 'setpoints', 'immune', 'nucleus']);
    expect(mount.querySelectorAll('[data-organ] [data-sample-tag]')).toHaveLength(5);
  });

  it('shows what it has, and says plainly what it cannot read', async () => {
    start();
    await vi.waitFor(() => expect($('[data-door]')?.textContent).toContain('Door open at 1 sat a message'));
    await vi.waitFor(() => expect($('[data-nucleus-chain]')?.textContent).toContain('860,123'));
    expect($('[data-membrane-quiet]')?.textContent).toMatch(/^No knocks since \d\d:\d\d\.$/);
    expect($('[data-membrane-n2]')?.textContent).toContain('not visible yet');
    expect($('[data-immune]')?.textContent).toBe('Evidence keeping: not built.');
    expect($('[data-nucleus-backup]')?.textContent).toContain('not verified');
    // The sample's daily approval starts off, like after a restart.
    await vi.waitFor(() => expect($('[data-setpoint-none]')?.textContent).toContain('No setpoint. Paid sends ask each time.'));
    // No hourly bars before the node can report them (N1).
    expect($('[data-organ="metabolism"]')?.textContent).toContain('N1');
    expect(mount.querySelector('[data-organ="metabolism"] .bars')).toBeNull();
  });

  it('counts one admission per live message, flags a stranger, and pulses that row once', async () => {
    const { emit } = start();
    await vi.waitFor(() => expect($('[data-membrane-quiet]')).not.toBeNull());
    emit({ type: 'message', room_id: null, message: { id: 'live-1', kind: 0, sender: STRANGER, recipient: SAMPLE_OWN_ID, timestamp: Date.now(), plaintext: 'hi', payment_amount_msat: 1000 } });
    await vi.waitFor(() => expect($('[data-membrane-admitted]')?.textContent).toContain('1 first contact'));
    const row = $('[data-membrane-entry="admitted"]')!;
    expect(row.textContent).toContain('first contact, not added');
    expect(row.classList.contains('hot')).toBe(true);
    await vi.waitFor(() => expect(row.classList.contains('hot')).toBe(false), { timeout: 1000 });
    // The stranger's message is energy that crossed in; the rail still lists contacts only.
    await vi.waitFor(() => expect($('[data-energy="in-1h"]')?.textContent).toBe('+1'));
    expect(mount.querySelector(`[data-track="peer:${STRANGER}"]`)).toBeNull();
  });

  it('records a delivery rejected at the recipient’s door as an outbound refusal', async () => {
    const { emit } = start();
    await vi.waitFor(() => expect($('[data-membrane-refused]')).not.toBeNull());
    emit({ type: 'delivery', message_id: 'unknown', status: 'rejected', reason: 'insufficient payment: required 2000 msat, got 1000 msat' });
    await vi.waitFor(() => expect($('[data-membrane-refused]')?.textContent).toContain('their door 1'));
    expect($('[data-membrane-entry="refused"]')?.textContent).toContain('insufficient payment');
  });

  it('shows setpoints once the daily total is approved, and "Lower a setpoint" opens the budgets', async () => {
    const { source } = start();
    await source.budgetApprove(500_000, 'careful');
    await source.spendStatus();
    await source.spendStatus();
    await vi.waitFor(() => expect($('[data-setpoint="ceiling"]')?.textContent).toContain('/500'), { timeout: 5000 });
    expect($(`[data-setpoint="${SAMPLE_PEERS[0].node_id}"]`)?.textContent).toContain('Maya');
    $<HTMLButtonElement>('[data-setpoint-lower]')!.click();
    await vi.waitFor(() => expect($('[data-panel="budget"]')).not.toBeNull());
  });

  it('greys to the last reading when the node stops answering, never to zero', async () => {
    const { source } = start();
    await vi.waitFor(() => expect($('[data-nucleus-chain]')?.textContent).toContain('860,123'));
    dispose?.();
    mount.remove();
    // Same data, but the host now reports the node stopped.
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => <ControlCenter source={source} active={true} ready={true} error="node exited" ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
    await vi.waitFor(() => expect($('[data-nucleus-chain]')?.textContent).toContain('860,123'));
    expect($('[data-panel="body"]')?.classList.contains('down')).toBe(true);
    expect($('[data-organ="nucleus"]')?.classList.contains('stale')).toBe(true);
  });
});
