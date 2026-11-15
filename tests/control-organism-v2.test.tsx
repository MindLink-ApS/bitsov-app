import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID, SAMPLE_PEERS, SAMPLE_STRANGER } from '../src/control/sample';
import { hostSource } from '../src/control/source';
import { doorCard, gateWords, membraneLive, membraneNode, membraneRefused, membraneSeed, membraneSummary, nodeMetabolism, organismCaps, type MembraneEntry } from '../src/control/body';
import { streamItems } from '../src/control/state';
import type { Artifact, EnergyRead, LiveEvent, MembraneEvent, Message, NodeOverview } from '../src/control/types';

// O1 v2: the organism view on a node that reports its own energy (N1) and
// membrane (N2). Used only when `/status` advertises them; an rc7 node keeps
// the v1 sums (control-body.test.tsx, control-shell.test.tsx).

const OWN = '1'.repeat(64);
const A = 'a'.repeat(64);
const STRANGER = 'e'.repeat(64);
const NOW = Date.UTC(2026, 8, 27, 14, 0);
const HOUR = 3_600_000;

const read = (over: Partial<EnergyRead> = {}): EnergyRead => ({
  window: '24h',
  as_of_ms: NOW,
  bucket_ms: HOUR,
  buckets: [],
  counterparties: [],
  totals: { in_msat: 0, out_msat: 0, in_count: 0, out_count: 0 },
  truncated: false,
  ...over,
});

const ev = (over: Partial<MembraneEvent> & Pick<MembraneEvent, 'seq' | 'verdict' | 'code'>): MembraneEvent => ({
  at: NOW,
  direction: 'inbound',
  kind: 0,
  counterparty: null,
  first_contact: false,
  required_msat: null,
  paid_msat: null,
  cap_msat: null,
  ...over,
});

describe('capabilities', () => {
  it('uses N1 / N2 only when /status lists them', () => {
    const base = { read_at: NOW } as NodeOverview;
    expect(organismCaps(null)).toEqual({ energy: false, membrane: false });
    expect(organismCaps(base)).toEqual({ energy: false, membrane: false });
    expect(organismCaps({ ...base, capabilities: ['membrane_v1'] })).toEqual({ energy: false, membrane: true });
    expect(organismCaps({ ...base, capabilities: ['energy_v1', 'membrane_v1'] })).toEqual({ energy: true, membrane: true });
  });

  it('asks the host by command name with the window and limit only', async () => {
    const calls: [string, unknown][] = [];
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: (cmd: string, args: unknown) => (calls.push([cmd, args]), Promise.resolve({})) });
    await hostSource.energy('1h');
    await hostSource.membrane(50);
    await hostSource.membrane();
    expect(calls).toEqual([
      ['energy_read', { span: '1h' }],
      ['membrane_read', { limit: 50 }],
      ['membrane_read', { limit: null }],
    ]);
    vi.unstubAllGlobals();
  });
});

describe('metabolism from the node (N1)', () => {
  it('is node-wide, carries its buckets as they came, and keeps gaps', () => {
    const day = read({
      buckets: [
        { start_ms: NOW - 5 * HOUR, in_msat: 1000, out_msat: 0 },
        { start_ms: NOW - 2 * HOUR, in_msat: 0, out_msat: 2000 },
      ],
      counterparties: [
        { kind: 'peer', id: A, in_msat: 1000, out_msat: 0, in_count: 1, out_count: 0 },
        { kind: 'room', id: '0f8e2b7a-1c3d-4e5f-8a9b-0c1d2e3f4a5b', in_msat: 0, out_msat: 2000, in_count: 0, out_count: 1 },
      ],
      totals: { in_msat: 1000, out_msat: 2000, in_count: 1, out_count: 1 },
    });
    const hour = read({ window: '1h', totals: { in_msat: 0, out_msat: 0, in_count: 0, out_count: 0 } });
    const m = nodeMetabolism(hour, day);
    expect(m.source).toBe('node');
    expect(m.day).toEqual({ in_msat: 1000, out_msat: 2000, acts_in: 1, acts_out: 1 });
    expect(m.hour).toEqual({ in_msat: 0, out_msat: 0, acts_in: 0, acts_out: 0 });
    expect(m.rows.map((r) => r.key)).toEqual(['room:0f8e2b7a-1c3d-4e5f-8a9b-0c1d2e3f4a5b', `peer:${A}`]);
    expect(m.bars?.buckets).toHaveLength(2);
  });
});

describe('membrane from the node (N2)', () => {
  const ctx = { contacts: new Set([A]) };

  it('takes inbound decisions once each, and leaves our own sends to this app', () => {
    let log: MembraneEntry[] = [];
    log = membraneNode(log, ev({ seq: 1, verdict: 'refused', code: 'unpaid', required_msat: 20_000, paid_msat: 0 }), ctx);
    log = membraneNode(log, ev({ seq: 1, verdict: 'refused', code: 'unpaid', required_msat: 20_000, paid_msat: 0 }), ctx);
    log = membraneNode(log, ev({ seq: 2, verdict: 'refused', code: 'price_cap_exceeded', direction: 'outbound', counterparty: A }), ctx);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ verdict: 'refused', kind: 'inbound', code: 'unpaid', sender: null, required_msat: 20_000, track: null });
  });

  it('names a refused sender only when the node did, and never adds a stranger', () => {
    let log: MembraneEntry[] = [];
    log = membraneNode(log, ev({ seq: 3, verdict: 'refused', code: 'replay', counterparty: STRANGER }), ctx);
    log = membraneNode(log, ev({ seq: 4, verdict: 'admitted', code: 'settled', counterparty: STRANGER, first_contact: true, paid_msat: 1000 }), ctx);
    log = membraneNode(log, ev({ seq: 5, verdict: 'admitted', code: 'settled', counterparty: A, first_contact: true, paid_msat: 2000 }), ctx);
    expect(log[2]).toMatchObject({ kind: 'inbound', sender: STRANGER, track: `peer:${STRANGER}` });
    expect(log[1]).toMatchObject({ verdict: 'admitted', first_contact: true, message_id: null });
    expect(log[0], 'a contact is not a first contact').toMatchObject({ verdict: 'admitted', first_contact: false });
    expect(ctx.contacts.has(STRANGER)).toBe(false);
    const s = membraneSummary(log);
    expect(s).toMatchObject({ admitted: 2, first_contacts: 1, refused: 1, inbound_by: { replay: 1 } });
    expect(s.refused_by.inbound).toBe(1);
  });

  it('seeds from the ring oldest first, and the v1 message count steps aside', () => {
    const log = membraneSeed([], [ev({ seq: 9, verdict: 'refused', code: 'stale' }), ev({ seq: 8, verdict: 'refused', code: 'unpaid' })], ctx);
    expect(log.map((e) => e.node_seq)).toEqual([9, 8]);
    const msg: Message = { id: 'x', kind: 0, sender: STRANGER, recipient: OWN, timestamp: NOW, plaintext: 'hi', payment_amount_msat: 1000 };
    const live: LiveEvent = { type: 'message', message: msg, room_id: null };
    const v1 = { ownId: OWN, contacts: new Set<string>(), threads: {}, nowMs: NOW };
    expect(membraneLive([], live, v1)).toHaveLength(1);
    expect(membraneLive([], live, { ...v1, nodeMembrane: true })).toEqual([]);
  });
});

describe('re-admission after a reconnect (genome #85/#86)', () => {
  const ctx = { contacts: new Set([A]) };

  it('words the new codes in plain language', () => {
    expect(gateWords('admission_required')).toBe('asked to pay admission again');
    expect(gateWords('admission_rate_limited')).toBe('asked again too soon');
    expect(gateWords('readmission')).toBe('admitted again after a reconnect');
  });

  it('takes the node’s paid re-admission once, apart from admissions and refusals', () => {
    const paid = ev({ seq: 7, verdict: 'admitted', code: 'readmission', direction: 'outbound', counterparty: A.toUpperCase(), paid_msat: 2000, cap_msat: 50_000 });
    let log: MembraneEntry[] = [];
    log = membraneNode(log, paid, ctx);
    log = membraneNode(log, paid, ctx);
    log = membraneNode(log, ev({ seq: 8, verdict: 'refused', code: 'admission_required', counterparty: STRANGER }), ctx);
    expect(log).toHaveLength(2);
    expect(log[1]).toMatchObject({ verdict: 'readmitted', counterparty: A, paid_msat: 2000, cap_msat: 50_000, track: `peer:${A}` });
    expect(doorCard(log[1], 1000), 'a re-admission stays in the Body panel').toBeNull();
    const s = membraneSummary(log);
    expect(s).toMatchObject({ admitted: 0, readmitted: 1, readmitted_msat: 2000, refused: 1, inbound_by: { admission_required: 1 } });
  });
});

describe('door cards', () => {
  it('stand for a first contact, a verified refusal, and a send refused at their price', () => {
    const [admitted] = membraneNode([], ev({ seq: 1, verdict: 'admitted', code: 'settled', counterparty: STRANGER, first_contact: true, paid_msat: 1000 }), { contacts: new Set() });
    expect(doorCard(admitted, 1000)).toEqual({ track: `peer:${STRANGER}`, at: NOW, card: { side: 'in', verdict: 'admitted', sender: STRANGER, paid_msat: 1000, door_msat: 1000 } });

    const [refused] = membraneNode([], ev({ seq: 2, verdict: 'refused', code: 'insufficient_payment', counterparty: STRANGER, required_msat: 2000, paid_msat: 500 }), { contacts: new Set() });
    expect(doorCard(refused, null)?.card).toEqual({ side: 'in', verdict: 'refused', sender: STRANGER, code: 'insufficient_payment', required_msat: 2000, paid_msat: 500 });

    const [unsigned] = membraneNode([], ev({ seq: 3, verdict: 'refused', code: 'bad_signature' }), { contacts: new Set() });
    expect(doorCard(unsigned, null)).toBeNull();

    const [price] = membraneRefused([], { code: 'price_changed', message: 'The current price is 4000 msat, above the confirmed ceiling of 3000 msat.' }, `peer:${A}`, NOW);
    expect(doorCard(price, null)?.card).toMatchObject({ side: 'out', code: 'price_changed' });
    const [setpoint] = membraneRefused([], { code: 'budget_exhausted', message: '' }, `peer:${A}`, NOW);
    expect(doorCard(setpoint, null)).toBeNull();
    const [readmit] = membraneRefused([], { code: 'readmission_capped', message: 'Not sent - nothing was paid.' }, `peer:${A}`, NOW);
    expect(doorCard(readmit, null)?.card).toEqual({ side: 'out', verdict: 'refused', code: 'readmission_capped', detail: 'Not sent - nothing was paid.', cap_msat: null });

    const [contact] = membraneNode([], ev({ seq: 4, verdict: 'admitted', code: 'settled', counterparty: A, paid_msat: 1000 }), { contacts: new Set([A]) });
    expect(doorCard(contact, null)).toBeNull();
  });

  it('puts the first-contact card just before the message it admitted', () => {
    const msg: Message = { id: 'm', kind: 0, sender: STRANGER, recipient: OWN, timestamp: NOW - 30_000, plaintext: 'hi', payment_amount_msat: 1000 };
    const card: Artifact = { id: 'd', at: NOW, type: 'door', door: { side: 'in', verdict: 'admitted', sender: STRANGER, paid_msat: 1000, door_msat: null } };
    expect(streamItems([msg], [card]).map((i) => i.type)).toEqual(['artifact', 'message']);
  });
});

describe('Body panel and stream on an N1/N2 node', () => {
  let dispose: (() => void) | undefined;
  let mount: HTMLElement;
  afterEach(() => {
    dispose?.();
    mount?.remove();
  });
  const $ = <T extends HTMLElement = HTMLElement>(sel: string) => mount.querySelector<T>(sel);

  function start() {
    const source = sampleSource({ firstLiveMs: 1e9, organism: 'v2' });
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

  it('draws node-wide energy with 24 slots and gaps, and drops the v1 caveats', async () => {
    start();
    await vi.waitFor(() => expect($('[data-energy-bars]')).not.toBeNull());
    const slots = mount.querySelectorAll('[data-energy-bars] > span');
    expect(slots).toHaveLength(24);
    expect(mount.querySelectorAll('[data-bar-gap]').length).toBeGreaterThan(0);
    expect($('[data-organ="metabolism"]')?.textContent).toContain('Box-wide');
    expect($('[data-organ="metabolism"]')?.textContent).not.toContain('need N1');
    // Dana's track was never opened; the node still counts her.
    expect($(`[data-energy-row="peer:${'d'.repeat(64)}"]`)).not.toBeNull();
  });

  it('shows inbound refusals by reason, anonymous unless verified, and no N2 caveat', async () => {
    start();
    await vi.waitFor(() => expect($('[data-membrane-refused-by]')?.textContent).toContain('at your door: unpaid 2'));
    expect($('[data-membrane-n2]')).toBeNull();
    expect($('[data-organ="membrane"]')?.textContent).toContain('named only when the box verified');
  });

  it('lists a paid stranger at the door, apart from contacts, with a door card in the track', async () => {
    start();
    await vi.waitFor(() => expect($(`[data-door-track="peer:${SAMPLE_STRANGER}"]`)).not.toBeNull());
    expect($(`[data-track="peer:${SAMPLE_STRANGER}"]`)).toBeNull();
    expect(SAMPLE_PEERS.some((p) => p.node_id === SAMPLE_STRANGER)).toBe(false);
    $<HTMLButtonElement>(`[data-door-track="peer:${SAMPLE_STRANGER}"]`)!.click();
    await vi.waitFor(() => expect($('[data-door="in-admitted"]')).not.toBeNull());
    const card = $('[data-door="in-admitted"]')!;
    expect(card.textContent).toContain('paid 1 sat to reach you');
    expect(card.textContent).toContain('settled · recipient-bound · single-use');
    expect(card.textContent).toContain('Not a contact, and not added');
    expect(card.querySelector('button')).toBeNull();
    // The card stands before the message it admitted.
    const stream = $('[data-stream]')!;
    expect(stream.textContent!.indexOf('to reach you')).toBeLessThan(stream.textContent!.indexOf('saw your talk'));
  });

  it('shows a paid re-admission and an admission-required refusal in plain words', async () => {
    const { emit } = start();
    await vi.waitFor(() => expect($('[data-membrane-refused-by]')).not.toBeNull());
    emit({ type: 'membrane', event: ev({ seq: 901, at: Date.now(), verdict: 'refused', code: 'admission_required', counterparty: SAMPLE_PEERS[0].node_id }) });
    emit({ type: 'membrane', event: ev({ seq: 902, at: Date.now(), verdict: 'admitted', code: 'readmission', direction: 'outbound', counterparty: SAMPLE_PEERS[0].node_id, paid_msat: 2000, cap_msat: 50_000 }) });
    await vi.waitFor(() => expect($('[data-membrane-readmitted]')).not.toBeNull());
    expect($('[data-membrane-readmitted]')!.textContent).toContain('admitted again');
    expect($('[data-membrane-readmitted]')!.textContent).toContain('2 sats paid after a reconnect');
    expect($('[data-membrane-refused-by]')!.textContent).toContain('asked to pay admission again 1');
  });

  it('puts a verified refusal at your door in that sender’s track, live', async () => {
    const { emit } = start();
    await vi.waitFor(() => expect($('[data-membrane-refused-by]')).not.toBeNull());
    emit({ type: 'membrane', event: ev({ seq: 900, at: Date.now(), verdict: 'refused', code: 'insufficient_payment', counterparty: SAMPLE_PEERS[0].node_id, required_msat: 2000, paid_msat: 1000 }) });
    await vi.waitFor(() => expect($('[data-membrane-refused-by]')?.textContent).toContain('paid too little 1'));
    $<HTMLButtonElement>(`[data-track="peer:${SAMPLE_PEERS[0].node_id}"]`)!.click();
    await vi.waitFor(() => expect($('[data-door="in-refused"]')).not.toBeNull());
    expect($('[data-door="in-refused"]')!.textContent).toContain('needed 2 sats · paid 1 sat');
    expect($('[data-door="in-refused"]')!.textContent).toContain('Signed by Maya');
  });
});
