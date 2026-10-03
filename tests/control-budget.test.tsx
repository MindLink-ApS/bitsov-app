import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import type { PairingView } from '../src/onboarding/pairing';
import { sampleSource, SAMPLE_PEERS, SAMPLE_PRESETS } from '../src/control/sample';
import { resetContactsForTests, setPetname } from '../src/control/petnames';
import { setShowLegacyIntroductionUi, setShowLegacyRoomsUi } from '../src/control/Shell';
import { budgetStand, messagesWorth } from '../src/control/state';
import type { BudgetRow, BudgetView, SpendView } from '../src/control/types';

// B2, invisible payments: inside the owner's budget a message just goes. The
// host decides (src-tauri/src/budget.rs); these tests drive the renderer against
// a stubbed host whose budget is stateful, plus the dev sample source.

const OWN = '1'.repeat(64);
const MAYA = 'a'.repeat(64);
const NEW = 'e'.repeat(64);
const ROOM = '0f8e2b7a-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
const DAY = 86_400_000;

const paired: PairingView = { state: 'paired', scopes: ['read', 'receive'], short_code: 'ABCD-EFGH', code_from_node: true, reason: null, remote: false, bootstrap: null };
const locked: SpendView = { state: 'locked', basis: null, open_until_ms: null, pending: null, window_ms: 600_000 };

function budgetView(extra: Partial<BudgetView> = {}): BudgetView {
  return {
    paused: false,
    autopay: { state: 'off', open_until_ms: null, ceiling_msat: null, basis: null },
    waiting_for_owner: false,
    preset: 'careful',
    ceiling_msat: 500_000,
    spent_msat: 0,
    unsettled_msat: 0,
    rows: [],
    presets: SAMPLE_PRESETS,
    window_ms: DAY,
    max_daily_msat: 100_000_000,
    node_grant: null,
    ...extra,
  };
}
const open = (rows: BudgetRow[], extra: Partial<BudgetView> = {}) =>
  budgetView({
    autopay: { state: 'open', open_until_ms: Date.now() + DAY - 60_000, ceiling_msat: 500_000, basis: 'node_grant' },
    rows,
    spent_msat: rows.reduce((n, r) => n + r.spent_msat, 0),
    ...extra,
  });

type Call = { cmd: string; args: Record<string, unknown> | undefined };
type Reply = (args?: Record<string, unknown>) => unknown;

function stubHost(start: BudgetView, overrides: Record<string, Reply> = {}) {
  resetContactsForTests();
  setPetname(MAYA, 'Maya');
  setPetname(NEW, 'Nadia');
  const calls: Call[] = [];
  const callbacks = new Map<number, (e: unknown) => void>();
  const state = { budget: start, spend: locked };
  const REPLIES: Record<string, Reply> = {
    node_status: () => ({ ready: true, node_id: OWN, error: null }),
    pairing_status: () => paired,
    node_overview: () => ({
      node_id: OWN, status: 'ok', version: 'api v2', connected_peers: 2, e2ee_sessions: 1, pending_deliveries: 0,
      lightning_available: true, block_height: 1, uptime_secs: 1, lightning_backend: 'ldk', chain_backend: 'esplora', read_at: Date.now(),
    }),
    peers_list: () => [
      { node_id: MAYA, addr: null, label: 'Maya', connected: true, fingerprint: null },
      { node_id: NEW, addr: null, label: 'Nadia', connected: true, fingerprint: null },
    ],
    rooms_list: () => [{ id: ROOM, name: 'Mexico build', created_by: OWN, created_at: null }],
    room_members: () => [OWN, MAYA],
    room_quote: () => ({ room_id: ROOM, members: [{ node_id: MAYA, msat: 2000, advertised: true, connected: true }], total_msat: 2000, unreachable: [], estimate: false }),
    messages_list: (args) => (args!.peer === MAYA ? [{ id: 'm0', kind: 0, sender: MAYA, recipient: OWN, timestamp: Date.now() - 60_000, plaintext: 'hi', payment_amount_msat: 2000 }] : []),
    price_quote: () => ({ kind: 0, own_msat: 1000, peer_msat: 2000, peer_age_secs: 30, max_routing_fee_msat: 0, peer_stale: false }),
    payments_overview: () => ({ balance_msat: 1_000_000, lightning_outbound_msat: 500_000, channels: [] }),
    fund_state: () => null,
    file_price: () => ({ principal_msat: 3000, max_routing_fee_msat: 5000, total_msat: 8000 }),
    spend_status: () => state.spend,
    budget_status: () => state.budget,
    first_contact_quote: (args) => ({ recipient: args!.peer, admission_msat: 1000, message_msat: 1000, max_routing_fee_msat: 0, total_msat: 2000, expires_at: Math.floor(Date.now() / 1000) + 60 }),
    first_contact_request: () => null, // Pre-owner-handoff node fixture unless overridden.
    budget_approve: (args) => (state.budget = open(state.budget.rows, { ceiling_msat: args!.ceiling_msat as number })),
    budget_set: (args) => {
      const rows = state.budget.rows.map((r) => (r.target === args!.target ? { ...r, limit_msat: args!.limit_msat as number } : r));
      return (state.budget = { ...state.budget, rows });
    },
    budget_pause: () => (state.budget = { ...state.budget, paused: true, autopay: { state: 'off', open_until_ms: null, ceiling_msat: null, basis: null } }),
    budget_resume: () => (state.budget = open(state.budget.rows)),
    message_send: (args) => {
      const target = args!.recipient as string;
      const rows = state.budget.rows.some((r) => r.target === target)
        ? state.budget.rows.map((r) => (r.target === target ? { ...r, spent_msat: r.spent_msat + 2000 } : r))
        : [...state.budget.rows, { target, room: false, limit_msat: args!.first_contact_msat as number, spent_msat: 2000 }];
      state.budget = { ...state.budget, rows, spent_msat: state.budget.spent_msat + 2000 };
      return { message_id: `sent-${calls.length}`, recipient: target, is_room: args!.is_room, delivered: true, amount_msat: 2000, sent_at_ms: Date.now() };
    },
    live_link: () => null,
    'plugin:event|listen': () => 1,
    'plugin:event|unlisten': () => null,
    ...overrides,
  };
  vi.stubGlobal('__TAURI_INTERNALS__', {
    transformCallback: (cb: (e: unknown) => void) => {
      const id = callbacks.size + 1;
      callbacks.set(id, cb);
      return id;
    },
    invoke: (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      const reply = REPLIES[cmd];
      if (!reply) return Promise.reject(new Error(`unexpected ${cmd}`));
      try {
        return Promise.resolve(reply(args));
      } catch (e) {
        return Promise.reject(e);
      }
    },
  });
  vi.stubGlobal('__TAURI_EVENT_PLUGIN_INTERNALS__', { unregisterListener: () => {} });
  const used = (cmd: string) => calls.filter((c) => c.cmd === cmd);
  const emit = (state: string) => {
    const listener = calls.find(c => c.cmd === 'plugin:event|listen' && c.args?.event === 'node-live');
    callbacks.get(listener?.args?.handler as number)?.({ event: 'node-live', id: 1, payload: { type: 'link', state, detail: null } });
  };
  return { calls, state, used, emit };
}

describe('invisible payments in the composer and the context panel', () => {
  let dispose: (() => void) | undefined;
  let mount: HTMLElement;

  beforeEach(() => {
    setShowLegacyRoomsUi(true);
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    mount?.remove();
    vi.unstubAllGlobals();
    setShowLegacyIntroductionUi(false);
    setShowLegacyRoomsUi(false);
  });

  const $ = <T extends Element = HTMLElement>(sel: string) => mount.querySelector<T>(sel);
  const text = (sel: string) => $(sel)?.textContent ?? '';
  const type = (sel: string, value: string) => {
    const el = $<HTMLInputElement | HTMLTextAreaElement>(sel)!;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const submit = () => $<HTMLButtonElement>('[data-send]')!.click();

  async function openShell() {
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => <App />, mount);
    await vi.waitFor(() => expect(mount.querySelector('[data-composer]') || [...mount.querySelectorAll('button')].find((b) => b.textContent?.includes('I understand'))).toBeTruthy());
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))?.click();
    await vi.waitFor(() => expect($(`[data-track="peer:${MAYA}"]`)?.getAttribute('aria-current')).toBe('true'));
    await vi.waitFor(() => expect($('[data-cost-msat]')?.getAttribute('data-cost-msat')).toBe('2000'));
  }

  it('relaunch displays node-confirmed auto-pay and rechecks immediately after feed recovery', async () => {
    const host = stubHost(open([{ target: MAYA, room: false, limit_msat: 50_000, spent_msat: 0 }], {
      node_grant: { budget_msat: 5_000_000, remaining_msat: 4_995_000, per_call_max_msat: 50_000, expires_at_ms: Date.now() + DAY, envelopes: null },
    }));
    await openShell();
    type('[data-composer] textarea', 'hello');
    await vi.waitFor(() => expect($('[data-budget="ok"]')).not.toBeNull());
    expect($('[data-composer]')?.textContent).not.toContain('Approval needed');
    expect(host.used('budget_approve')).toHaveLength(0);
    host.emit('closed');
    await vi.waitFor(() => expect(mount.textContent).toContain('live feed reconnecting'));
    host.state.budget = budgetView(); // Node revoked the grant during its restart.
    host.emit('open');
    await vi.waitFor(() => expect($('[data-budget-setup]')).not.toBeNull(), { timeout: 500 });
    expect(mount.textContent).not.toContain('live feed reconnecting');
    expect(host.used('message_send')).toHaveLength(0);
  });

  it('shows stale grant state while a reconnect read is unavailable, then recovers', async () => {
    let unavailable = false;
    const live = open([{ target: MAYA, room: false, limit_msat: 50_000, spent_msat: 0 }]);
    const host = stubHost(live, { budget_status: () => {
      if (unavailable) throw { code: 'grant_unknown', message: 'Node grant unavailable' };
      return live;
    } });
    await openShell();
    type('[data-composer] textarea', 'hello');
    await vi.waitFor(() => expect($('[data-budget="ok"]')).not.toBeNull());
    unavailable = true;
    host.emit('closed'); host.emit('open');
    await vi.waitFor(() => expect($('[data-budget-stale]')).not.toBeNull(), { timeout: 500 });
    expect($('[data-budget="ok"]')).toBeNull();
    expect($<HTMLButtonElement>('[data-send]')!.disabled).toBe(true);
    $<HTMLTextAreaElement>('[data-composer] textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(host.used('message_send')).toHaveLength(0);
    unavailable = false;
    host.emit('closed'); host.emit('open');
    await vi.waitFor(() => expect($('[data-budget="ok"]')).not.toBeNull(), { timeout: 500 });
    expect(host.used('message_send')).toHaveLength(0);
  });

  it('ignores a grant read from before a newer reconnect', async () => {
    const live = open([{ target: MAYA, room: false, limit_msat: 50_000, spent_msat: 0 }]);
    let held: ((value: BudgetView) => void) | undefined;
    let holdNext = false;
    let current = live;
    const host = stubHost(live, { budget_status: () => {
      if (holdNext) { holdNext = false; return new Promise<BudgetView>(resolve => { held = resolve; }); }
      return current;
    } });
    await openShell();
    type('[data-composer] textarea', 'hello');
    holdNext = true;
    host.emit('closed'); host.emit('open');
    await vi.waitFor(() => expect(held).toBeDefined());
    current = budgetView();
    host.emit('closed'); host.emit('open');
    await vi.waitFor(() => expect($('[data-budget-setup]')).not.toBeNull());
    held!(live);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect($('[data-budget-setup]')).not.toBeNull();
    expect($('[data-budget="ok"]')).toBeNull();
  });

  it('uses restored auto-pay for a registered device without opening manual payments', async () => {
    stubHost(open([{ target: MAYA, room: false, limit_msat: 50_000, spent_msat: 0 }], {
      node_grant: { budget_msat: 5_000_000, remaining_msat: 4_995_000, per_call_max_msat: 50_000, expires_at_ms: Date.now() + DAY, envelopes: { [MAYA]: Date.now() + DAY } },
    }), { device_key_status: () => ({ available: true, state: 'registered', fingerprint: 'fixture', owner_action: null, expires_at_ms: null }) });
    await openShell();
    type('[data-composer] textarea', 'hello');
    expect($('[data-send]')?.textContent).not.toContain('Touch ID');
    expect($('[data-budget="ok"]')).not.toBeNull();
    $<HTMLButtonElement>('[data-composer-mode="pay"]')!.click();
    expect($('[data-send]')?.textContent).toContain('Touch ID');
  });

  it.each([[0, 50_000], [1000, 50_000], [5_000_000, 1000]])('shows node grant limits: remaining %s msat, per-call %s msat', async (remaining, perCall) => {
    const host = stubHost(open([{ target: MAYA, room: false, limit_msat: 50_000, spent_msat: 0 }], {
      node_grant: { budget_msat: 5_000_000, remaining_msat: remaining, per_call_max_msat: perCall, expires_at_ms: Date.now() + DAY, envelopes: null },
    }));
    await openShell();
    type('[data-composer] textarea', 'hello');
    expect($('[data-budget="grant_limited"]')).not.toBeNull();
    expect($<HTMLButtonElement>('[data-send]')!.disabled).toBe(true);
    $<HTMLTextAreaElement>('[data-composer] textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(host.used('message_send')).toHaveLength(0);
  });

  it('keeps the selected Everyday preset after remount without requesting a grant', async () => {
    const host = stubHost(budgetView());
    await openShell();
    type('[data-composer] textarea', 'hello');
    $<HTMLButtonElement>('[data-preset="everyday"]')!.click();
    dispose?.(); mount.remove();
    mount = document.createElement('div'); document.body.appendChild(mount);
    dispose = render(() => <App />, mount);
    await vi.waitFor(() => expect($('[data-composer] textarea')).not.toBeNull());
    type('[data-composer] textarea', 'hello');
    await vi.waitFor(() => expect($('[data-preset="everyday"]')?.getAttribute('aria-checked')).toBe('true'));
    expect(host.used('budget_approve')).toHaveLength(0);
    expect(host.used('message_send')).toHaveLength(0);
  });

  it('clears a failed pause after the user retries successfully', async () => {
    let failed = true;
    stubHost(budgetView(), { budget_pause: () => {
      if (failed) throw { code: 'node', message: 'Pause could not be saved' };
      return budgetView({ paused: true });
    } });
    await openShell();
    $<HTMLButtonElement>('[data-tab="budget"]')!.click();
    $<HTMLButtonElement>('[data-pause-all]')!.click();
    await vi.waitFor(() => expect(mount.textContent).toContain('Pause could not be saved'));
    failed = false;
    $<HTMLButtonElement>('[data-pause-all]')!.click();
    await vi.waitFor(() => expect(mount.textContent).not.toContain('Pause could not be saved'));
  });

  it('shows the daily scope and exclusions together, and warns at direct spending', async () => {
    stubHost(open([{ target: MAYA, room: false, limit_msat: 50_000, spent_msat: 0 }]));
    await openShell();
    $<HTMLButtonElement>('[data-tab="budget"]')!.click();
    await vi.waitFor(() => expect($('[data-budget-scope]')).not.toBeNull());
    expect(text('[data-budget-scope]').replace(/\s+/g, ' ').trim()).toMatchInlineSnapshot(`"App all-in · rolling 24 h — what it coversCovers automatic and manual-window messages, room sends, files, app invoice payments and keysend, and admission, including their maximum network fees. Paid totals use reported principal and fees. In-flight ceilings are reserved separately; unreported fees remain unknown. Not covered: channel opening/closing, on-chain transfers and fees, owner-direct CLI/API, or background workers. G1 is a separate finite node grant; it does not refill daily. Not a wallet-wide limit."`);
    $<HTMLButtonElement>('[data-composer-mode="pay"]')!.click();
    expect(text('[data-budget-payment]')).toContain('reserve principal plus the network fee ceiling');
    $<HTMLButtonElement>('[data-composer-mode="file"]')!.click();
    expect(text('[data-budget-file]')).toContain('reserve principal plus the network fee ceiling');
    $<HTMLButtonElement>('[data-tab="wallet"]')!.click();
    expect(text('[data-budget-wallet-warning]')).toContain('Channel and on-chain actions');
    expect(text('[data-budget-wallet-warning]')).toContain('outside');
  });

  it('approves a daily total once, then messages go with no prompt and the price still shown', async () => {
    const host = stubHost(budgetView({ rows: [{ target: MAYA, room: false, limit_msat: 50_000, spent_msat: 0 }] }));
    await openShell();
    type('[data-composer] textarea', 'gm Maya');
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Send'));
    expect(text('[data-budget-setup]')).toContain('Someone new always asks first');

    // The owner picks a preset; the tap is the approval. Nothing is sent by it.
    $<HTMLButtonElement>('[data-preset="everyday"]')!.click();
    submit();
    await vi.waitFor(() => expect(host.used('budget_approve')).toHaveLength(1));
    expect(host.used('budget_approve')[0].args).toEqual({ ceiling_msat: 2_000_000, preset: 'everyday' });
    expect(host.used('message_send')).toHaveLength(0);
    expect($<HTMLTextAreaElement>('[data-composer] textarea')!.value).toBe('gm Maya');

    await vi.waitFor(() => expect($('[data-budget="ok"]')).not.toBeNull());
    expect(text('[data-budget-line]')).toContain('Pays automatically · 0 sats of 50 sats to Maya in 24 h');
    submit();
    await vi.waitFor(() => expect(host.used('message_send')).toHaveLength(1));
    expect(host.used('message_send')[0].args).toMatchObject({ recipient: MAYA, max_msat: 2000, first_contact_msat: null });
    await vi.waitFor(() => expect($<HTMLTextAreaElement>('[data-composer] textarea')!.value).toBe(''));
    // A second message: no approval, no question.
    type('[data-composer] textarea', 'and again');
    submit();
    await vi.waitFor(() => expect(host.used('message_send')).toHaveLength(2));
    expect(host.used('spend_request')).toHaveLength(0);
    await vi.waitFor(() => expect(text('[data-budget-line]')).toContain('4 sats of 50 sats'));
  });

  it('sends the quoted all-in first-contact cap to the owner grant and paid request', async () => {
    const host = stubHost(open([{ target: MAYA, room: false, limit_msat: 50_000, spent_msat: 0 }]), {
      first_contact_quote: () => ({ recipient: NEW, admission_msat: 2000, message_msat: 2000,
        max_routing_fee_msat: 13500, total_msat: 17500, expires_at: Math.floor(Date.now() / 1000) + 60 }),
    });
    await openShell();
    $<HTMLButtonElement>(`[data-track="peer:${NEW}"]`)!.click();
    await vi.waitFor(() => expect($('[data-door-quote]')?.getAttribute('data-door-quote')).toBe('17500'));
    expect(text('[data-door-quote]')).toContain('up to 13.5 sats network fee');
    expect(text('[data-first-budget="50000"]')).toBe('50 sats a day · 2 messages');
    type('[data-composer] textarea', 'hello including fees');
    submit();
    await vi.waitFor(() => expect(host.used('message_send')).toHaveLength(1));
    expect(host.used('first_contact_request')[0].args).toMatchObject({ recipient: NEW, max_msat: 17500 });
    expect(host.used('message_send')[0].args).toMatchObject({ recipient: NEW, max_msat: 17500 });
  });

  it('asks once before paying someone new, with their budget in their own price', async () => {
    const host = stubHost(open([{ target: MAYA, room: false, limit_msat: 50_000, spent_msat: 0 }]));
    await openShell();
    $<HTMLButtonElement>(`[data-track="peer:${NEW}"]`)!.click();
    await vi.waitFor(() => expect($('[data-first-contact]')).not.toBeNull());
    expect(text('[data-first-contact]')).toContain('First paid message to Nadia');
    await vi.waitFor(() => expect(text('[data-first-budget="50000"]')).toBe('50 sats a day · 25 messages'));
    type('[data-composer] textarea', 'hello Nadia');
    await vi.waitFor(() => expect(text('[data-send-price]')).toBe('up to 2 sats · includes max routing fee'));
    $<HTMLButtonElement>('[data-first-budget="100000"]')!.click();
    submit();
    await vi.waitFor(() => expect(host.used('message_send')).toHaveLength(1));
    expect(host.used('message_send')[0].args).toMatchObject({ recipient: NEW, first_contact_msat: 100_000 });
    // Asked once: the next message goes on its own.
    await vi.waitFor(() => expect($('[data-first-contact]')).toBeNull());
    await vi.waitFor(() => expect($<HTMLTextAreaElement>('[data-composer] textarea')!.value).toBe(''));
    type('[data-composer] textarea', 'second');
    await vi.waitFor(() => expect($('[data-budget="ok"]')).not.toBeNull());
  });

  it('shows a stranger’s own signed quote on the door card and confirms exactly that total', async () => {
    const host = stubHost(open([{ target: MAYA, room: false, limit_msat: 50_000, spent_msat: 0 }]), {
      first_contact_quote: (args) => ({
        recipient: args!.peer, admission_msat: 3000, message_msat: 2000, total_msat: 5000,
        expires_at: Math.floor(Date.now() / 1000) + 60,
      }),
    });
    await openShell();
    $<HTMLButtonElement>(`[data-track="peer:${NEW}"]`)!.click();
    await vi.waitFor(() => expect($('[data-door-quote]')?.getAttribute('data-door-quote')).toBe('5000'));
    expect(text('[data-door-quote]')).toContain('3 sats once to reach them');
    expect(text('[data-door-quote]')).toContain('2 sats a message');
    expect(text('[data-cost]')).toContain('Nadia’s own quote');
    // Budget counts conservatively use the displayed all-in quote.
    expect(text('[data-first-budget="50000"]')).toBe('50 sats a day · 10 messages');
    type('[data-composer] textarea', 'hello Nadia');
    await vi.waitFor(() => expect(text('[data-send-price]')).toBe('up to 5 sats · includes max routing fee'));
    submit();
    await vi.waitFor(() => expect(host.used('message_send')).toHaveLength(1));
    // The confirmed cap is the quoted total: admission + this message.
    expect(host.used('message_send')[0].args).toMatchObject({ recipient: NEW, max_msat: 5000, first_contact_msat: 50_000 });
    expect(host.used('first_contact_quote')).toHaveLength(1);
    expect(host.used('first_contact_quote')[0].args).toEqual({ peer: NEW });
  });

  // Default product path hides bitsov://introduce (M3 honesty). Money-safety
  // door/consent tests enable setShowLegacyIntroductionUi to exercise the
  // still-shipped component; sponsor include stays on Start without that flag.
  const STRANGER = 'd'.repeat(64);
  const INTRO = 'bitsov://introduce#AQdyZWd0ZXN0' + 'Q'.repeat(240);
  const card = (node_id: string, reach: 'public' | 'local', msat: number) => ({
    node_id, network: 'regtest', endpoint: reach === 'local' ? '192.168.1.20:9735' : 'node.example.org:9735', reach,
    admission_msat: msat, message_msat: msat, issued_at: Math.floor(Date.now() / 1000), expires_at: Math.floor(Date.now() / 1000) + 600,
    link: node_id === OWN ? INTRO.replace('Q', 'M') : INTRO,
  });

  it('hides the legacy introduction path; Browse is where profile cards open', async () => {
    stubHost(open([{ target: MAYA, room: false, limit_msat: 50_000, spent_msat: 0 }]), {
      introduction_mine: () => card(OWN, 'public', 10_000),
    });
    await openShell();
    $<HTMLButtonElement>('[data-track="new"]')!.click();
    await vi.waitFor(() => expect($('[data-new-track]')).not.toBeNull());
    expect($('[data-intro-mine]')).toBeNull();
    expect($('[data-intro-open]')).toBeNull();
    expect(text('[data-new-track]')).toContain('Share your node id');
    expect(text('[data-new-track]')).toContain('Browse');
    $<HTMLButtonElement>('[data-track="discover"]')!.click();
    await vi.waitFor(() => expect($('[data-panel="discover"]')).not.toBeNull());
    expect(text('[data-panel="discover"]')).toMatch(/profile/i);
    expect(text('[data-browse-porch-hint]')).toContain('Porch');
  });

  it('shows your signed introduction, and a pasted one opens a door card that Continue hands to the first-contact door', async () => {
    const host = stubHost(open([{ target: MAYA, room: false, limit_msat: 50_000, spent_msat: 0 }]), {
      introduction_mine: () => card(OWN, 'public', 10_000),
      introduction_read: () => card(STRANGER, 'local', 3000),
      introduction_open: () => card(STRANGER, 'local', 3000),
      first_contact_quote: (args) => ({
        recipient: args!.peer, admission_msat: 3000, message_msat: 3000, total_msat: 6000,
        expires_at: Math.floor(Date.now() / 1000) + 60,
      }),
    });
    setShowLegacyIntroductionUi(true);
    await openShell();
    $<HTMLButtonElement>('[data-track="new"]')!.click();
    await vi.waitFor(() => expect($('[data-intro-mine]')).not.toBeNull());
    expect(text('[data-intro-prices]')).toBe('Admission: 15 sats including up to 5 sats network fee. Each message: 15 sats including up to 5 sats network fee (estimated ceilings).');
    expect($('[data-intro-mine] svg.qr')?.getAttribute('aria-label')).toBe('Your introduction as a QR code');
    expect(text('[data-intro-link]')).toBe(INTRO.replace('Q', 'M'));
    expect(text('[data-intro-mine]')).toContain('It is not admission');

    type('[data-intro-text]', INTRO);
    $<HTMLButtonElement>('[data-intro-open] button[type="submit"]')!.click();
    await vi.waitFor(() => expect($(`[data-door-card="${STRANGER}"]`)).not.toBeNull());
    expect(text('[data-door-prices]')).toBe('Admission: 8 sats including up to 5 sats network fee. Each message: 8 sats including up to 5 sats network fee (estimated ceilings).');
    expect(text('[data-door-local]')).toContain('192.168.1.20:9735');
    expect(host.used('introduction_read')[0].args).toEqual({ text: INTRO });
    // Reading is local: nothing dialed, quoted, granted or sent.
    for (const cmd of ['introduction_open', 'first_contact_quote', 'message_send']) expect(host.used(cmd)).toHaveLength(0);
    expect(text('[data-door-card]') + text('[data-intro-mine]')).not.toMatch(/free|trusted|unlocked/i);

    // A local address needs the owner's own OK; the card cannot grant it.
    expect($<HTMLButtonElement>('[data-door-continue]')!.disabled).toBe(true);
    $<HTMLButtonElement>('[data-door-continue]')!.click();
    expect(host.used('introduction_open')).toHaveLength(0);
    $<HTMLInputElement>('[data-door-allow-local]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-door-continue]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-door-continue]')!.click();
    await vi.waitFor(() => expect(host.used('introduction_open')).toHaveLength(1));
    expect(host.used('introduction_open')[0].args).toEqual({ text: INTRO, allow_local: true });
    // The conversation opens with the card beside the stranger's own fresh quote.
    await vi.waitFor(() => expect($(`[data-introduced="${STRANGER}"]`)).not.toBeNull());
    expect(text('[data-introduced]')).toContain('admission 8 sats including up to 5 sats network fee, each message 8 sats');
    await vi.waitFor(() => expect($('[data-door-quote]')?.getAttribute('data-door-quote')).toBe('6000'));
    expect(host.used('first_contact_quote')[0].args).toEqual({ peer: STRANGER });
    expect(host.used('message_send')).toHaveLength(0);
  });

  it('#49 review: a late introduction completion never leaves the current conversation or its draft', async () => {
    let finish!: (value: ReturnType<typeof card>) => void;
    const pending = new Promise<ReturnType<typeof card>>((resolve) => { finish = resolve; });
    const host = stubHost(open([{ target: MAYA, room: false, limit_msat: 50_000, spent_msat: 0 }]), {
      introduction_mine: () => card(OWN, 'public', 10_000),
      introduction_read: () => card(STRANGER, 'local', 3000),
      introduction_open: () => pending,
      first_contact_quote: (args) => ({
        recipient: args!.peer, admission_msat: 3000, message_msat: 3000, total_msat: 6000,
        expires_at: Math.floor(Date.now() / 1000) + 60,
      }),
    });
    setShowLegacyIntroductionUi(true);
    await openShell();
    $<HTMLButtonElement>('[data-track="new"]')!.click();
    type('[data-intro-text]', INTRO);
    $<HTMLButtonElement>('[data-intro-open] button[type="submit"]')!.click();
    await vi.waitFor(() => expect($('[data-door-continue]')).not.toBeNull());
    $<HTMLInputElement>('[data-door-allow-local]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-door-continue]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-door-continue]')!.click();
    await vi.waitFor(() => expect(host.used('introduction_open')).toHaveLength(1));
    $<HTMLButtonElement>(`[data-track="peer:${MAYA}"]`)!.click();
    await vi.waitFor(() => expect($(`[data-track="peer:${MAYA}"]`)?.getAttribute('aria-current')).toBe('true'));
    type('[data-composer] textarea', 'Keep this draft for Maya');
    expect($<HTMLTextAreaElement>('[data-composer] textarea')!.value).toBe('Keep this draft for Maya');
    finish(card(STRANGER, 'local', 3000));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect($<HTMLTextAreaElement>('[data-composer] textarea')!.value).toBe('Keep this draft for Maya');
    expect($(`[data-track="peer:${MAYA}"]`)?.getAttribute('aria-current')).toBe('true');
    expect(host.used('message_send')).toHaveLength(0);
    // It finished in the background: a notice, and the peer one tap away.
    await vi.waitFor(() => expect($(`[data-intro-notice="${STRANGER}"]`)).not.toBeNull());
    $<HTMLButtonElement>('[data-intro-notice] [data-intro-notice-open]')!.click();
    await vi.waitFor(() => expect($(`[data-introduced="${STRANGER}"]`)).not.toBeNull());
    expect($('[data-intro-notice]')).toBeNull();
  });

  it.each(['reopened Start', 'reopened untouched Start', 'edited introduction', 'edited invite', 'edited then restored input'])(
    'a late introduction preserves the %s form instead of navigating', async (scenario) => {
      let finish!: (value: ReturnType<typeof card>) => void;
      const pending = new Promise<ReturnType<typeof card>>((resolve) => { finish = resolve; });
      const host = stubHost(open([]), {
        introduction_mine: () => card(OWN, 'public', 10_000),
        introduction_read: () => card(STRANGER, 'public', 3000),
        introduction_open: () => pending,
      });
      setShowLegacyIntroductionUi(true);
      await openShell();
      $<HTMLButtonElement>('[data-track="new"]')!.click();
      type('[data-intro-text]', INTRO);
      $<HTMLButtonElement>('[data-intro-open] button[type="submit"]')!.click();
      await vi.waitFor(() => expect($('[data-door-continue]')).not.toBeNull());
      $<HTMLButtonElement>('[data-door-continue]')!.click();
      await vi.waitFor(() => expect(host.used('introduction_open')).toHaveLength(1));

      if (scenario.startsWith('reopened')) {
        $<HTMLButtonElement>(`[data-track="peer:${MAYA}"]`)!.click();
        $<HTMLButtonElement>('[data-track="new"]')!.click();
      }
      if (scenario === 'edited introduction') {
        type('[data-intro-text]', 'bitsov://introduce#another-card');
      } else if (scenario === 'edited then restored input') {
        type('[data-intro-text]', 'another card');
        type('[data-intro-text]', INTRO);
      } else if (scenario !== 'reopened untouched Start') {
        type('[data-invitee]', NEW);
        type('[data-addr]', 'my.example.org:9735');
      }

      finish(card(STRANGER, 'public', 3000));
      await vi.waitFor(() => expect($('[data-intro-notice]') || $('[data-introduced]')).not.toBeNull());
      expect($('[data-track="new"]')?.getAttribute('aria-current')).toBe('true');
      if (scenario === 'edited introduction' || scenario === 'edited then restored input') {
        expect($<HTMLTextAreaElement>('[data-intro-text]')!.value).toBe(
          scenario === 'edited introduction' ? 'bitsov://introduce#another-card' : INTRO,
        );
      } else {
        expect($<HTMLInputElement>('[data-invitee]')!.value).toBe(scenario === 'reopened untouched Start' ? '' : NEW);
        expect($<HTMLInputElement>('[data-addr]')!.value).toBe(scenario === 'reopened untouched Start' ? '' : 'my.example.org:9735');
      }
      expect($(`[data-intro-notice="${STRANGER}"]`)).not.toBeNull();
      expect(host.used('message_send')).toHaveLength(0);
      $<HTMLButtonElement>('[data-intro-notice-open]')!.click();
      await vi.waitFor(() => expect($(`[data-introduced="${STRANGER}"]`)).not.toBeNull());
    },
  );

  it('a stale card read cannot inherit consent after the input changes back', async () => {
    let finishA!: (value: ReturnType<typeof card>) => void;
    const pendingA = new Promise<ReturnType<typeof card>>(resolve => { finishA = resolve; });
    const a = { ...card(STRANGER, 'local', 3000), endpoint: '192.168.1.21:9735', link: INTRO };
    const b = { ...card(NEW, 'local', 3000), endpoint: '192.168.1.22:9735', link: INTRO + 'B' };
    const host = stubHost(open([]), {
      introduction_mine: () => card(OWN, 'public', 10000),
      introduction_read: args => args!.text === a.link ? pendingA : b,
    });
    setShowLegacyIntroductionUi(true);
    await openShell();
    $<HTMLButtonElement>('[data-track="new"]')!.click();
    type('[data-intro-text]', a.link);
    $<HTMLButtonElement>('[data-intro-open] button[type="submit"]')!.click();
    type('[data-intro-text]', b.link);
    $<HTMLButtonElement>('[data-intro-open] button[type="submit"]')!.click();
    await vi.waitFor(() => expect($(`[data-door-card="${NEW}"]`)).not.toBeNull());
    $<HTMLInputElement>('[data-door-allow-local]')!.click();
    expect($<HTMLInputElement>('[data-door-allow-local]')!.checked).toBe(true);
    type('[data-intro-text]', a.link);
    finishA(a);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect($('[data-door-card]')).toBeNull();
    expect(host.used('introduction_open')).toHaveLength(0);
  });

  it.each(['success', 'failure'])('a stale read %s revokes consent without replacing the current card', async outcome => {
    let resolveA!: (value: ReturnType<typeof card>) => void;
    let rejectA!: (error: Error) => void;
    const pendingA = new Promise<ReturnType<typeof card>>((resolve, reject) => { resolveA = resolve; rejectA = reject; });
    const a = card(STRANGER, 'local', 3000);
    const b = { ...card(NEW, 'local', 3000), endpoint: '192.168.1.22:9735', link: INTRO + 'B' };
    stubHost(open([]), {
      introduction_mine: () => card(OWN, 'public', 10000),
      introduction_read: args => args!.text === INTRO ? pendingA : b,
    });
    setShowLegacyIntroductionUi(true);
    await openShell();
    $<HTMLButtonElement>('[data-track="new"]')!.click();
    type('[data-intro-text]', INTRO);
    $<HTMLButtonElement>('[data-intro-open] button[type="submit"]')!.click();
    type('[data-intro-text]', b.link);
    $<HTMLButtonElement>('[data-intro-open] button[type="submit"]')!.click();
    await vi.waitFor(() => expect($(`[data-door-card="${NEW}"]`)).not.toBeNull());
    $<HTMLInputElement>('[data-door-allow-local]')!.click();
    expect($<HTMLButtonElement>('[data-door-continue]')!.disabled).toBe(false);
    if (outcome === 'success') resolveA(a);
    else rejectA(new Error('Old card error'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect($(`[data-door-card="${NEW}"]`)).not.toBeNull();
    expect($<HTMLInputElement>('[data-door-allow-local]')!.checked).toBe(false);
    expect($<HTMLButtonElement>('[data-door-continue]')!.disabled).toBe(true);
    expect(text('[data-door-error]')).not.toContain('Old card error');
  });

  it.each(['node id', 'endpoint', 'signature'])('changing the card %s needs fresh local consent', async changed => {
    const original = card(STRANGER, 'local', 3000);
    // The canonical host-verified link includes the entire card and signature.
    const replacement = {
      ...original,
      node_id: changed === 'node id' ? NEW : original.node_id,
      endpoint: changed === 'endpoint' ? '192.168.1.99:9735' : original.endpoint,
      link: INTRO + '-new-signature',
    };
    let next = original;
    const host = stubHost(open([]), {
      introduction_mine: () => card(OWN, 'public', 10000),
      introduction_read: () => next,
      introduction_open: () => replacement,
    });
    setShowLegacyIntroductionUi(true);
    await openShell();
    $<HTMLButtonElement>('[data-track="new"]')!.click();
    type('[data-intro-text]', INTRO);
    $<HTMLButtonElement>('[data-intro-open] button[type="submit"]')!.click();
    await vi.waitFor(() => expect($('[data-door-card]')).not.toBeNull());
    $<HTMLInputElement>('[data-door-allow-local]')!.click();
    expect($<HTMLButtonElement>('[data-door-continue]')!.disabled).toBe(false);
    next = replacement;
    $<HTMLButtonElement>('[data-intro-open] button[type="submit"]')!.click();
    await vi.waitFor(() => expect($('[data-door-card]')).not.toBeNull());
    expect($<HTMLInputElement>('[data-door-allow-local]')!.checked).toBe(false);
    $<HTMLButtonElement>('[data-door-continue]')!.click();
    expect(host.used('introduction_open')).toHaveLength(0);
    $<HTMLInputElement>('[data-door-allow-local]')!.click();
    $<HTMLButtonElement>('[data-door-continue]')!.click();
    await vi.waitFor(() => expect(host.used('introduction_open')[0]?.args).toEqual({ text: replacement.link, allow_local: true }));
  });

  it('a card the host refuses never reaches Continue', async () => {
    const host = stubHost(open([]), {
      introduction_mine: () => { throw 'Your node cannot sign an introduction yet. Share your node id instead.'; },
      introduction_read: () => { throw 'The signature does not match this node’s key. Do not use this introduction.'; },
    });
    setShowLegacyIntroductionUi(true);
    await openShell();
    $<HTMLButtonElement>('[data-track="new"]')!.click();
    // Without a card the node id is still shareable.
    await vi.waitFor(() => expect(text('[data-intro-unavailable]')).toContain('cannot sign an introduction'));
    expect(text('[data-new-track] code.address')).toBe(OWN);
    type('[data-intro-text]', 'bitsov://introduce#tampered');
    $<HTMLButtonElement>('[data-intro-open] button[type="submit"]')!.click();
    await vi.waitFor(() => expect(text('[data-door-error]')).toContain('signature does not match'));
    expect($('[data-door-card]')).toBeNull();
    expect(host.used('introduction_open')).toHaveLength(0);
  });

  // K1 slice 2: starter bitcoin. The node holds every cap; these check what
  // the owner and the newcomer see, and that nothing moves without the code.
  const openSpend = { state: 'open' as const, basis: 'node_grant' as const, open_until_ms: Date.now() + 600_000, pending: null, window_ms: 600_000 };
  const sponsorOn = () => ({ enabled: true, gift_msat: 20_000_000, fee_msat: 100_000, purse_msat: 100_000_000, purse_used_msat: 0, kits_per_day: 2, kits_today: 0 });
  const OFFER_LINK = `${INTRO}.OFFER`;
  const candidate = { intro_id: 'ab'.repeat(16), newcomer: STRANGER, payment_hash: 'cd'.repeat(32), gift_msat: 20_000_000, fee_max_msat: 100_000, code: '482913', expires_at: Math.floor(Date.now() / 1000) + 500 };

  it('the sponsor prepares an owner command with the frozen tuple and waits for funding without approving', async () => {
    let funded = false;
    const host = stubHost(open([]), {
      spend_status: () => openSpend,
      introduction_mine: () => card(OWN, 'public', 10_000),
      sponsor_status: () => ({ ...sponsorOn(), kits: funded ? [kit('funded')] : [] }),
      sponsor_owner_approval: () => ({ owner_command: 'owner command for the frozen gift' }),
      sponsor_offer: () => ({ ...card(OWN, 'public', 10_000), starter: { gift_msat: 20_000_000, expires_at: Math.floor(Date.now() / 1000) + 600 }, offer_link: OFFER_LINK }),
      sponsor_candidate: () => candidate,
      sponsor_approve: (args) => ({ intro_id: args!.intro_id, state: 'funded', paid_msat: 20_000_000, fee_paid_msat: 0, payment_hash: 'cd'.repeat(32) }),
    });
    await openShell();
    $<HTMLButtonElement>('[data-track="new"]')!.click();
    await vi.waitFor(() => expect($('[data-starter-include]')).not.toBeNull());
    expect(text('[data-starter-purse]')).toContain('0 sats of 100,000 sats');
    $<HTMLButtonElement>('[data-starter-include]')!.click();
    await vi.waitFor(() => expect($('[data-starter-offered]')).not.toBeNull());
    expect(text('[data-starter-offered]')).toContain('up to 20,000 sats');
    expect(text('[data-intro-link]')).toBe(OFFER_LINK);
    expect(host.used('sponsor_approve')).toHaveLength(0);

    type('[data-starter-request-text]', 'bitsov://sponsor-request#REQ');
    $<HTMLButtonElement>('[data-starter-review] button[type="submit"]')!.click();
    await vi.waitFor(() => expect($(`[data-starter-candidate="${STRANGER}"]`)).not.toBeNull());
    expect(host.used('sponsor_candidate')[0].args).toEqual({ request: 'bitsov://sponsor-request#REQ' });
    expect(text('[data-starter-candidate]')).toContain('Lightning gift: 20,000 sats. Network fee: at most 100 sats.');
    // The code is typed from their screen, not taken from ours.
    expect(text('[data-starter-candidate]')).not.toContain('482913');
    expect($<HTMLButtonElement>('[data-starter-approve]')!.disabled).toBe(true);
    type('[data-starter-their-code]', '48-29 13');
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-starter-approve]')!.disabled).toBe(false));
    expect(text('[data-starter-approve]')).toBe('Sponsor up to 20,100 sats');
    $<HTMLButtonElement>('[data-starter-approve]')!.click();
    await vi.waitFor(() => expect($('[data-starter-owner-command]')).not.toBeNull());
    expect($<HTMLTextAreaElement>('[data-starter-owner-command]')!.value).toBe('owner command for the frozen gift');
    expect(host.used('sponsor_owner_approval')[0].args).toEqual({ candidate, code: '482913' });
    expect(host.used('sponsor_approve')).toHaveLength(0);
    expect($('[data-starter-gift="funded"]')).toBeNull();
    funded = true;
    await vi.waitFor(() => expect($('[data-starter-gift="funded"]')).not.toBeNull(), { timeout: 4500 });
    expect($('[data-starter-owner-command]')).toBeNull();
    expect(text('[data-starter-gift]')).toContain('It is theirs now');
    expect(host.used('message_send')).toHaveLength(0);
  });

  it('with the spend window closed, including starter bitcoin asks for approval first', async () => {
    const host = stubHost(open([]), {
      introduction_mine: () => card(OWN, 'public', 10_000),
      sponsor_status: sponsorOn,
      spend_request: () => ({ state: 'pending', basis: null, open_until_ms: null, pending: { op_id: 'ab12', expires_at_ms: Date.now() + 600_000, owner_action: 'konsensus grant --op ab12' }, window_ms: 600_000 }),
    });
    await openShell();
    $<HTMLButtonElement>('[data-track="new"]')!.click();
    await vi.waitFor(() => expect($('[data-starter-include]')).not.toBeNull());
    $<HTMLButtonElement>('[data-starter-include]')!.click();
    await vi.waitFor(() => expect(host.used('spend_request')).toHaveLength(1));
    expect(host.used('sponsor_offer')).toHaveLength(0);
  });

  const kit = (state: string) => ({ intro_id: candidate.intro_id, gift_msat: candidate.gift_msat, fee_msat: candidate.fee_max_msat,
    candidate: { newcomer: candidate.newcomer, payment_hash: candidate.payment_hash, code: candidate.code }, state, paid_msat: state === 'funded' ? candidate.gift_msat : 0, fee_paid_msat: 0 });

  it('an unknown outcome stays pending until read-authorized reconciliation reports funded', async () => {
    let reconciled = false;
    const host = stubHost(open([]), {
      spend_status: () => openSpend,
      introduction_mine: () => card(OWN, 'public', 10_000),
      sponsor_candidate: () => candidate,
      sponsor_owner_approval: () => ({ owner_command: 'owner command' }),
      sponsor_status: () => ({ ...sponsorOn(), kits: [kit(reconciled ? 'funded' : 'unknown')] }),
      sponsor_reconcile: () => { reconciled = true; },
    });
    await openShell();
    $<HTMLButtonElement>('[data-track="new"]')!.click();
    await vi.waitFor(() => expect($('[data-starter-review]')).not.toBeNull());
    type('[data-starter-request-text]', 'bitsov://sponsor-request#REQ');
    $<HTMLButtonElement>('[data-starter-review] button[type="submit"]')!.click();
    await vi.waitFor(() => expect($('[data-starter-their-code]')).not.toBeNull());
    type('[data-starter-their-code]', '482913');
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-starter-approve]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-starter-approve]')!.click();
    await vi.waitFor(() => expect(text('[data-starter-gift="unknown"]')).toContain('do not send again'));
    expect($<HTMLButtonElement>('[data-starter-approve]')!.disabled).toBe(true);
    await vi.waitFor(() => expect($('[data-starter-gift="funded"]')).not.toBeNull(), { timeout: 4500 });
    expect(host.used('sponsor_reconcile')[0].args).toEqual({ intro_id: candidate.intro_id });
    expect(host.used('sponsor_approve')).toHaveLength(0);
  });


  it('409 owner approval required renders the owner step without requesting a spend window', async () => {
    const host = stubHost(open([]), {
      spend_status: () => openSpend,
      introduction_mine: () => card(OWN, 'public', 10_000),
      sponsor_status: sponsorOn,
      sponsor_candidate: () => { throw { code: 'sponsor_owner_approval_required', message: 'sponsor_owner_approval_required' }; },
    });
    await openShell();
    $<HTMLButtonElement>('[data-track="new"]')!.click();
    await vi.waitFor(() => expect($('[data-starter-review]')).not.toBeNull());
    type('[data-starter-request-text]', 'bitsov://sponsor-request#REQ');
    $<HTMLButtonElement>('[data-starter-review] button[type="submit"]')!.click();
    await vi.waitFor(() => expect(text('[data-starter-owner-approval]')).toContain('Approve this gift at your node'));
    expect(host.used('sponsor_approve')).toHaveLength(0);
    expect(host.used('spend_request')).toHaveLength(0);
  });

  it.each(['late funded response', 'mismatched status'])('confirmed cancellation clears the review despite a %s', async (response) => {
    let resolveStatus!: (value: unknown) => void;
    let confirmCancel!: () => void;
    let waiting = false;
    const host = stubHost(open([]), {
      spend_status: () => openSpend,
      introduction_mine: () => card(OWN, 'public', 10_000),
      sponsor_status: () => waiting ? new Promise((resolve) => { resolveStatus = resolve; }) : sponsorOn(),
      sponsor_candidate: () => candidate,
      sponsor_owner_approval: () => { waiting = true; return { owner_command: 'owner command' }; },
      sponsor_cancel: () => new Promise<void>((resolve) => { confirmCancel = resolve; }),
    });
    await openShell();
    $<HTMLButtonElement>('[data-track="new"]')!.click();
    await vi.waitFor(() => expect($('[data-starter-review]')).not.toBeNull());
    type('[data-starter-request-text]', 'bitsov://sponsor-request#REQ');
    $<HTMLButtonElement>('[data-starter-review] button[type="submit"]')!.click();
    await vi.waitFor(() => expect($('[data-starter-their-code]')).not.toBeNull());
    type('[data-starter-their-code]', '482913');
    $<HTMLButtonElement>('[data-starter-approve]')!.click();
    await vi.waitFor(() => expect(resolveStatus).toBeTypeOf('function'));
    $<HTMLButtonElement>('[data-starter-cancel]')!.click();
    await vi.waitFor(() => expect(host.used('sponsor_cancel')).toHaveLength(1));
    expect.soft($('[data-starter-candidate]')).not.toBeNull();
    expect.soft($<HTMLTextAreaElement>('[data-starter-request-text]')!.disabled).toBe(true);
    if (response === 'mismatched status') {
      resolveStatus({ ...sponsorOn(), kits: [{ ...kit('funded'), candidate: { ...kit('funded').candidate, payment_hash: 'ef'.repeat(32) } }] });
      await vi.waitFor(() => expect(text('[data-starter-review-error]')).toContain('differs from the reviewed gift'));
    }
    confirmCancel();
    await vi.waitFor(() => expect($('[data-starter-candidate]')).toBeNull());
    expect($<HTMLTextAreaElement>('[data-starter-request-text]')!.disabled).toBe(false);
    resolveStatus({ ...sponsorOn(), kits: [kit('funded')] });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect($('[data-starter-owner-command]')).toBeNull();
    expect($('[data-starter-gift]')).toBeNull();
    expect(host.used('sponsor_approve')).toHaveLength(0);
  });

  it.each(['paying', 'unknown'])('review #50 adapted regression: disabled cancel preserves unresolved tracking while %s', async (state) => {
    let funded = false;
    const host = stubHost(open([]), {
      spend_status: () => openSpend,
      introduction_mine: () => card(OWN, 'public', 10_000),
      sponsor_status: () => ({ ...sponsorOn(), kits: [kit(funded ? 'funded' : state)] }),
      sponsor_candidate: () => candidate,
      sponsor_owner_approval: () => ({ owner_command: 'owner command' }),
      sponsor_reconcile: () => undefined,
      sponsor_cancel: () => { throw { code: 'node', message: 'sponsor_kit_dispatched: only an undispatched kit can be cancelled' }; },
    });
    await openShell();
    $<HTMLButtonElement>('[data-track="new"]')!.click();
    await vi.waitFor(() => expect($('[data-starter-review]')).not.toBeNull());
    type('[data-starter-request-text]', 'bitsov://sponsor-request#REQ');
    $<HTMLButtonElement>('[data-starter-review] button[type="submit"]')!.click();
    await vi.waitFor(() => expect($('[data-starter-their-code]')).not.toBeNull());
    type('[data-starter-their-code]', '482913');
    $<HTMLButtonElement>('[data-starter-approve]')!.click();
    await vi.waitFor(() => expect(text(`[data-starter-gift="${state}"]`)).toContain('do not send again'));
    const cancelButton = $<HTMLButtonElement>('[data-starter-cancel]')!;
    expect(cancelButton.disabled).toBe(true);
    // An unresolved payment cannot be cancelled, so clicking must not request a
    // withdrawal or depend on a sponsor_kit_dispatched refusal from the host.
    cancelButton.click();
    expect(host.used('sponsor_cancel')).toHaveLength(0);
    expect(text('[data-starter-review-error]')).toBe('');
    expect(text(`[data-starter-gift="${state}"]`)).toContain('do not send again');
    expect($('[data-starter-candidate]')?.getAttribute('data-starter-candidate')).toBe(candidate.newcomer);
    expect($<HTMLTextAreaElement>('[data-starter-request-text]')!.disabled).toBe(true);
    expect($<HTMLTextAreaElement>('[data-starter-request-text]')!.value).toBe('bitsov://sponsor-request#REQ');
    expect($<HTMLButtonElement>('[data-starter-review] button[type="submit"]')!.disabled).toBe(true);
    expect($<HTMLInputElement>('[data-starter-their-code]')!.disabled).toBe(true);
    expect($<HTMLInputElement>('[data-starter-their-code]')!.value).toBe('482913');
    expect($<HTMLButtonElement>('[data-starter-approve]')!.disabled).toBe(true);
    funded = true;
    await vi.waitFor(() => expect($('[data-starter-gift="funded"]')).not.toBeNull(), { timeout: 4500 });
    expect(text('[data-starter-gift="funded"]')).toContain('It is theirs now');
    expect(host.used('sponsor_cancel')).toHaveLength(0);
    expect(host.used('sponsor_approve')).toHaveLength(0);
  });

  it.each(['sponsor_kit_dispatched', 'connection lost'])('keeps the review locked and resumes polling after cancel fails: %s', async (message) => {
    let state = 'candidate';
    let rejectCancel!: (error: unknown) => void;
    const host = stubHost(open([]), {
      spend_status: () => openSpend,
      introduction_mine: () => card(OWN, 'public', 10_000),
      sponsor_status: () => ({ ...sponsorOn(), kits: [kit(state)] }),
      sponsor_candidate: () => candidate,
      sponsor_owner_approval: () => ({ owner_command: 'owner command' }),
      sponsor_reconcile: () => undefined,
      sponsor_cancel: () => new Promise((_, reject) => { rejectCancel = reject; }),
    });
    await openShell();
    $<HTMLButtonElement>('[data-track="new"]')!.click();
    await vi.waitFor(() => expect($('[data-starter-review]')).not.toBeNull());
    type('[data-starter-request-text]', 'bitsov://sponsor-request#REQ');
    $<HTMLButtonElement>('[data-starter-review] button[type="submit"]')!.click();
    await vi.waitFor(() => expect($('[data-starter-their-code]')).not.toBeNull());
    type('[data-starter-their-code]', '482913');
    $<HTMLButtonElement>('[data-starter-approve]')!.click();
    await vi.waitFor(() => expect($('[data-starter-owner-command]')).not.toBeNull());
    $<HTMLButtonElement>('[data-starter-cancel]')!.click();
    await vi.waitFor(() => expect(rejectCancel).toBeTypeOf('function'));
    expect.soft($('[data-starter-candidate]')).not.toBeNull();
    expect.soft($('[data-starter-owner-command]')).not.toBeNull();
    expect.soft($<HTMLTextAreaElement>('[data-starter-request-text]')!.disabled).toBe(true);
    expect.soft($<HTMLButtonElement>('[data-starter-cancel]')?.disabled).toBe(true);
    // The owner dispatches before the node processes cancellation.
    state = 'unknown';
    await vi.waitFor(() => expect(text('[data-starter-gift="unknown"]')).toContain('do not send again'), { timeout: 4500 });
    rejectCancel({ code: 'node', message });
    await vi.waitFor(() => expect(text('[data-starter-review-error]')).toContain(message));
    await vi.waitFor(() => expect(text('[data-starter-gift="unknown"]')).toContain('do not send again'), { timeout: 4500 });
    expect($('[data-starter-candidate]')).not.toBeNull();
    expect($<HTMLTextAreaElement>('[data-starter-request-text]')!.disabled).toBe(true);
    expect($<HTMLButtonElement>('[data-starter-approve]')!.disabled).toBe(true);
    state = 'funded';
    await vi.waitFor(() => expect($('[data-starter-gift="funded"]')).not.toBeNull(), { timeout: 4500 });
    expect(host.used('sponsor_cancel')).toHaveLength(1);
    expect(host.used('sponsor_approve')).toHaveLength(0);
  }, 12_000);

  it('starts tracking after cancellation fails before preparing the owner command', async () => {
    let state = 'candidate';
    let rejectCancel!: (error: unknown) => void;
    const host = stubHost(open([]), {
      spend_status: () => openSpend,
      introduction_mine: () => card(OWN, 'public', 10_000),
      sponsor_status: () => ({ ...sponsorOn(), kits: [kit(state)] }),
      sponsor_candidate: () => candidate,
      sponsor_reconcile: () => undefined,
      sponsor_cancel: () => new Promise((_, reject) => { rejectCancel = reject; }),
    });
    await openShell();
    $<HTMLButtonElement>('[data-track="new"]')!.click();
    await vi.waitFor(() => expect($('[data-starter-review]')).not.toBeNull());
    type('[data-starter-request-text]', 'bitsov://sponsor-request#REQ');
    $<HTMLButtonElement>('[data-starter-review] button[type="submit"]')!.click();
    await vi.waitFor(() => expect($('[data-starter-their-code]')).not.toBeNull());
    type('[data-starter-their-code]', '482913');
    $<HTMLButtonElement>('[data-starter-cancel]')!.click();
    await vi.waitFor(() => expect(rejectCancel).toBeTypeOf('function'));
    expect.soft($('[data-starter-candidate]')).not.toBeNull();
    expect.soft($<HTMLTextAreaElement>('[data-starter-request-text]')!.disabled).toBe(true);
    expect.soft($<HTMLButtonElement>('[data-starter-cancel]')?.disabled).toBe(true);
    const message = 'connection lost';
    state = 'unknown';
    rejectCancel({ code: 'node', message });
    await vi.waitFor(() => expect(text('[data-starter-review-error]')).toContain(message));
    await vi.waitFor(() => expect(text('[data-starter-gift="unknown"]')).toContain('do not send again'), { timeout: 4500 });
    expect($('[data-starter-candidate]')).not.toBeNull();
    expect($<HTMLTextAreaElement>('[data-starter-request-text]')!.disabled).toBe(true);
    expect($<HTMLButtonElement>('[data-starter-approve]')!.disabled).toBe(true);
    state = 'funded';
    await vi.waitFor(() => expect($('[data-starter-gift="funded"]')).not.toBeNull(), { timeout: 4500 });
    expect(host.used('sponsor_cancel')).toHaveLength(1);
    expect(host.used('sponsor_approve')).toHaveLength(0);
  }, 12_000);

  it.each(['failed', 'cancelled', 'expired'])('shows the terminal %s kit outcome without offering another payment', async (state) => {
    const host = stubHost(open([]), {
      spend_status: () => openSpend,
      introduction_mine: () => card(OWN, 'public', 10_000),
      sponsor_status: () => ({ ...sponsorOn(), kits: [kit(state)] }),
      sponsor_candidate: () => candidate,
      sponsor_owner_approval: () => ({ owner_command: 'owner command' }),
    });
    await openShell();
    $<HTMLButtonElement>('[data-track="new"]')!.click();
    await vi.waitFor(() => expect($('[data-starter-review]')).not.toBeNull());
    type('[data-starter-request-text]', 'bitsov://sponsor-request#REQ');
    $<HTMLButtonElement>('[data-starter-review] button[type="submit"]')!.click();
    await vi.waitFor(() => expect($('[data-starter-their-code]')).not.toBeNull());
    type('[data-starter-their-code]', '482913');
    $<HTMLButtonElement>('[data-starter-approve]')!.click();
    await vi.waitFor(() => expect(text(`[data-starter-gift="${state}"]`)).toContain('This kit is closed'));
    expect($('[data-starter-owner-command]')).toBeNull();
    expect($<HTMLButtonElement>('[data-starter-approve]')!.disabled).toBe(true);
    expect(host.used('sponsor_approve')).toHaveLength(0);
  });

  it('refuses a funded status for a different frozen payment hash', async () => {
    stubHost(open([]), {
      spend_status: () => openSpend,
      introduction_mine: () => card(OWN, 'public', 10_000),
      sponsor_status: () => ({ ...sponsorOn(), kits: [{ ...kit('funded'), candidate: { ...kit('funded').candidate, payment_hash: 'ef'.repeat(32) } }] }),
      sponsor_candidate: () => candidate,
      sponsor_owner_approval: () => ({ owner_command: 'owner command' }),
    });
    await openShell();
    $<HTMLButtonElement>('[data-track="new"]')!.click();
    await vi.waitFor(() => expect($('[data-starter-review]')).not.toBeNull());
    type('[data-starter-request-text]', 'bitsov://sponsor-request#REQ');
    $<HTMLButtonElement>('[data-starter-review] button[type="submit"]')!.click();
    await vi.waitFor(() => expect($('[data-starter-their-code]')).not.toBeNull());
    type('[data-starter-their-code]', '482913');
    $<HTMLButtonElement>('[data-starter-approve]')!.click();
    await vi.waitFor(() => expect(text('[data-starter-review-error]')).toContain('differs from the reviewed gift'));
    expect($('[data-starter-gift]')).toBeNull();
    expect($('[data-starter-owner-command]')).toBeNull();
  });

  it('the newcomer requests the starter bitcoin and sees it arrive; nothing else is paid', async () => {
    const host = stubHost(open([]), {
      introduction_mine: () => card(OWN, 'public', 10_000),
      introduction_read: () => ({ ...card(STRANGER, 'public', 3000), starter: { gift_msat: 20_000_000, expires_at: Math.floor(Date.now() / 1000) + 600 }, offer_link: OFFER_LINK }),
      sponsor_status: () => { throw 'Your node cannot run starter-bitcoin kits yet.'; },
      sponsor_request: () => ({ request: 'bitsov://sponsor-request#' + 'R'.repeat(200), code: '482913', sponsor: STRANGER, amount_msat: 20_000_000, payment_hash: 'ef'.repeat(32), expires_at: Math.floor(Date.now() / 1000) + 500 }),
      sponsor_request_status: (args) => ({ payment_hash: args!.payment_hash, state: 'received', amount_msat: 20_000_000 }),
    });
    setShowLegacyIntroductionUi(true);
    await openShell();
    $<HTMLButtonElement>('[data-track="new"]')!.click();
    type('[data-intro-text]', OFFER_LINK);
    $<HTMLButtonElement>('[data-intro-open] button[type="submit"]')!.click();
    await vi.waitFor(() => expect($('[data-door-starter]')).not.toBeNull());
    expect(text('[data-door-starter]')).toContain('Starter bitcoin available after they approve: 20,000 sats');
    expect(text('[data-door-starter]')).toContain('not a pass');
    expect(host.used('sponsor_request')).toHaveLength(0);
    // Not a sponsor: no review panel on this node.
    expect($('[data-starter-review]')).toBeNull();
    $<HTMLButtonElement>('[data-door-request-starter]')!.click();
    await vi.waitFor(() => expect($('[data-starter-code]')).not.toBeNull());
    expect(host.used('sponsor_request')[0].args).toEqual({ text: OFFER_LINK });
    expect(text('[data-starter-code]')).toContain('482 913');
    expect($('[data-door-starter] svg.qr')?.getAttribute('aria-label')).toBe('Your starter-bitcoin request as a QR code');
    await vi.waitFor(() => expect(text('[data-starter-status="received"]')).toContain('Received 20,000 sats in your own node'));
    expect(host.used('sponsor_request_status')[0].args).toEqual({ payment_hash: 'ef'.repeat(32) });
    for (const cmd of ['message_send', 'introduction_open', 'sponsor_approve']) expect(host.used(cmd)).toHaveLength(0);
  });

  it('an expired card cannot continue', async () => {
    const host = stubHost(open([]), {
      introduction_mine: () => card(OWN, 'public', 10_000),
      introduction_read: () => ({ ...card(STRANGER, 'public', 3000), expires_at: Math.floor(Date.now() / 1000) - 1 }),
    });
    setShowLegacyIntroductionUi(true);
    await openShell();
    $<HTMLButtonElement>('[data-track="new"]')!.click();
    type('[data-intro-text]', INTRO);
    $<HTMLButtonElement>('[data-intro-open] button[type="submit"]')!.click();
    await vi.waitFor(() => expect($('[data-door-expired]')).not.toBeNull());
    expect($('[data-door-continue]')).toBeNull();
    expect(host.used('introduction_open')).toHaveLength(0);
  });

  it('explains an exhausted budget and raises it in one tap, within the daily total', async () => {
    const host = stubHost(open([{ target: MAYA, room: false, limit_msat: 3000, spent_msat: 2000 }]));
    await openShell();
    type('[data-composer] textarea', 'one more');
    await vi.waitFor(() => expect($('[data-budget-used="contact"]')).not.toBeNull());
    expect($<HTMLButtonElement>('[data-send]')!.disabled).toBe(true);
    expect(text('[data-budget-used="contact"]')).toContain('2 sats of 3 sats in the last 24 hours');
    $<HTMLButtonElement>('[data-budget-raise]')!.click();
    await vi.waitFor(() => expect(host.used('budget_set')).toHaveLength(1));
    expect(host.used('budget_set')[0].args).toEqual({ target: MAYA, room: false, limit_msat: 6000 });
    await vi.waitFor(() => expect($('[data-budget="ok"]')).not.toBeNull());
    expect(host.used('message_send')).toHaveLength(0);
  });

  it('a used-up daily total is a new approval, not a silent raise', async () => {
    const host = stubHost(open([{ target: MAYA, room: false, limit_msat: 50_000, spent_msat: 0 }], { spent_msat: 499_000 }));
    await openShell();
    type('[data-composer] textarea', 'hi');
    await vi.waitFor(() => expect($('[data-budget-used="total"]')).not.toBeNull());
    $<HTMLButtonElement>('[data-budget-used="total"] [data-budget-raise-total]')!.click();
    await vi.waitFor(() => expect(host.used('budget_approve')).toHaveLength(1));
    expect(host.used('budget_approve')[0].args).toEqual({ ceiling_msat: 1_000_000, preset: 'careful' });
  });

  it('shows the running tally in the context panel and pauses everything in one tap', async () => {
    const host = stubHost(open([{ target: MAYA, room: false, limit_msat: 50_000, spent_msat: 4000 }, { target: ROOM, room: true, limit_msat: 100_000, spent_msat: 3000 }]));
    await openShell();
    $<HTMLButtonElement>('[data-tab="budget"]')!.click();
    await vi.waitFor(() => expect(text('[data-tally-total]')).toBe('7 sats / 500 sats'));
    expect(text(`[data-budget-row="${MAYA}"]`)).toContain('Maya');
    expect(text(`[data-budget-row="${MAYA}"] [data-row-tally]`)).toBe('4 sats/ 50 sats');
    expect(text(`[data-budget-row="${ROOM}"]`)).toContain('Mexico build');
    expect(text('[data-autopay]')).toContain('Autopay open');

    $<HTMLButtonElement>('[data-panel="budget"] [data-pause-all]')!.click();
    await vi.waitFor(() => expect(host.used('budget_pause')).toHaveLength(1));
    await vi.waitFor(() => expect(text('[data-autopay]')).toContain('Paused'));
    type('[data-composer] textarea', 'while paused');
    await vi.waitFor(() => expect($('[data-budget-paused]')).not.toBeNull());
    expect(text('[data-budget-paused]')).toContain('New app payments are blocked');
    submit();
    await vi.waitFor(() => expect(host.used('budget_resume')).toHaveLength(1));
    expect(host.used('message_send')).toHaveLength(0);
    await vi.waitFor(() => expect($('[data-budget="ok"]')).not.toBeNull());
  });

  it('lowers one contact’s budget from the panel', async () => {
    const host = stubHost(open([{ target: MAYA, room: false, limit_msat: 50_000, spent_msat: 0 }]));
    await openShell();
    $<HTMLButtonElement>('[data-tab="budget"]')!.click();
    await vi.waitFor(() => expect($('[data-budget-edit]')).not.toBeNull());
    $<HTMLButtonElement>('[data-budget-edit]')!.click();
    type('[data-budget-input]', '10');
    $<HTMLButtonElement>('[data-budget-save]')!.click();
    await vi.waitFor(() => expect(host.used('budget_set')[0]?.args).toEqual({ target: MAYA, room: false, limit_msat: 10_000 }));
  });

  it('refreshes a higher room fee quote and waits for another tap at the displayed all-in price', async () => {
    let fee = 5000;
    let sends = 0;
    const host = stubHost(open([{ target: ROOM, room: true, limit_msat: 50_000, spent_msat: 0 }]), {
      room_quote: () => ({ room_id: ROOM, members: [{ node_id: MAYA, msat: 2000 + fee,
        max_routing_fee_msat: fee, advertised: true, connected: true }],
        total_msat: 2000 + fee, max_routing_fee_msat: fee, unreachable: [], estimate: false }),
      message_send: (args) => {
        sends += 1;
        if (sends === 1) {
          fee = 7500;
          throw { code: 'price_cap_exceeded', message: 'The all-in price changed. Review the new quote.' };
        }
        return { message_id: 'room-sent', recipient: ROOM, is_room: true, delivered: true,
          amount_msat: 2000, max_routing_fee_msat: 7500, total_msat: 9500, sent_at_ms: Date.now() };
      },
    });
    await openShell();
    $<HTMLButtonElement>(`[data-track="room:${ROOM}"]`)!.click();
    await vi.waitFor(() => expect($('[data-cost-msat]')?.getAttribute('data-cost-msat')).toBe('7000'));
    type('[data-composer] textarea', 'room draft');
    submit();
    await vi.waitFor(() => expect($('[data-cost-msat]')?.getAttribute('data-cost-msat')).toBe('9500'));
    expect(text('[data-cost]')).toContain('7.5 sats');
    expect(host.used('message_send')).toHaveLength(1);
    expect(host.used('message_send')[0].args).toMatchObject({ max_msat: 7000, max_recipient_msat: { [MAYA]: 7000 } });
    expect($<HTMLTextAreaElement>('[data-composer] textarea')!.value).toBe('room draft');
    expect(text('[data-send-price]')).toContain('9.5 sats');
    submit();
    await vi.waitFor(() => expect(host.used('message_send')).toHaveLength(2));
    expect(host.used('message_send')[1].args).toMatchObject({ max_msat: 9500, max_recipient_msat: { [MAYA]: 9500 } });
  });

  it('a known contact the node will not re-admit from the budget brings the door card back once', async () => {
    let sends = 0;
    const host = stubHost(open([{ target: MAYA, room: false, limit_msat: 50_000, spent_msat: 0 }]), {
      first_contact_quote: (args) => ({
        recipient: args!.peer, admission_msat: 2000, message_msat: 2000, total_msat: 4000,
        expires_at: Math.floor(Date.now() / 1000) + 60,
      }),
      message_send: (args) => {
        sends += 1;
        if (sends === 1) {
          throw { code: 'grant_readmission', message: 'This contact reconnected and asks to be admitted again. Your node’s budget does not cover them yet, so it needs your OK once. Nothing was sent.' };
        }
        return { message_id: 'sent-2', recipient: args!.recipient, is_room: false, delivered: true, amount_msat: 2000, sent_at_ms: Date.now() };
      },
    });
    await openShell();
    type('[data-composer] textarea', 'back again');
    await vi.waitFor(() => expect($('[data-budget="ok"]')).not.toBeNull());
    submit();
    await vi.waitFor(() => expect(text('[data-composer-note]')).toContain('admitted again'));
    // Maya's own quote, on the door card, with her budget as it stands.
    await vi.waitFor(() => expect($('[data-readmit]')?.getAttribute('data-door-quote')).toBe('4000'));
    expect(text('[data-readmit]')).toContain('reconnected and asks to be admitted again');
    expect(text('[data-first-contact]')).toContain('Admit Maya again');
    expect($('[data-first-budget="50000"]')?.getAttribute('aria-checked')).toBe('true');
    expect($<HTMLTextAreaElement>('[data-composer] textarea')!.value).toBe('back again');
    submit();
    await vi.waitFor(() => expect(host.used('message_send')).toHaveLength(2));
    expect(host.used('message_send')[1].args).toMatchObject({ recipient: MAYA, max_msat: 4000, first_contact_msat: 50_000 });
    // Once admitted, the card goes: the next reconnect is paid from her budget.
    await vi.waitFor(() => expect($('[data-first-contact]')).toBeNull());
  });

  it('a budget refusal from the host is explained in the composer, not recorded as a failed send', async () => {
    stubHost(open([{ target: MAYA, room: false, limit_msat: 50_000, spent_msat: 0 }]), {
      message_send: () => Promise.reject({ code: 'budget_exhausted', message: 'You have used 50 of 50 sats for this contact in the last 24 hours.' }),
    });
    await openShell();
    type('[data-composer] textarea', 'race');
    await vi.waitFor(() => expect($('[data-budget="ok"]')).not.toBeNull());
    submit();
    await vi.waitFor(() => expect(text('[data-composer-note]')).toContain('used 50 of 50 sats'));
    expect($('[data-artifact="failed"]')).toBeNull();
    expect($<HTMLTextAreaElement>('[data-composer] textarea')!.value).toBe('race');
  });

  it('a node grant refusal (G1) is a composer note, and an ended grant re-reads the approval', async () => {
    for (const [code, message] of [
      ['grant_exhausted', 'Your node’s spend budget has 1 sats left, less than this costs. Nothing was sent.'],
      ['grant_ended', 'Your node’s spend budget has ended (expired or revoked). Nothing was sent.'],
    ]) {
      const host = stubHost(open([{ target: MAYA, room: false, limit_msat: 50_000, spent_msat: 0 }]), {
        message_send: () => Promise.reject({ code, message }),
      });
      await openShell();
      type('[data-composer] textarea', 'race');
      await vi.waitFor(() => expect($('[data-budget="ok"]')).not.toBeNull());
      const spendReads = host.used('spend_status').length;
      submit();
      await vi.waitFor(() => expect(text('[data-composer-note]')).toContain('Nothing was sent'));
      expect($('[data-artifact="failed"]')).toBeNull();
      expect($<HTMLTextAreaElement>('[data-composer] textarea')!.value).toBe('race');
      if (code === 'grant_ended') await vi.waitFor(() => expect(host.used('spend_status').length).toBeGreaterThan(spendReads));
      dispose?.();
      dispose = undefined;
      mount.remove();
      vi.unstubAllGlobals();
    }
  });

  it('shows what the node grant still allows in the budget panel', async () => {
    const until = Date.now() + 30 * 60_000;
    stubHost(open([{ target: MAYA, room: false, limit_msat: 50_000, spent_msat: 0 }], {
      node_grant: { expires_at_ms: until, budget_msat: 400_000, remaining_msat: 396_000, per_call_max_msat: 50_000 },
    }));
    await openShell();
    $<HTMLButtonElement>('[data-tab="budget"]')!.click();
    await vi.waitFor(() => expect($('[data-node-grant]')).not.toBeNull());
    expect(text('[data-node-grant]')).toBe('Your finite node grant allows 396 sats of 400 sats more, at most 50 sats per payment, for 30 min.');
  });

  it('labels invoice/keysend tally rows without offering contact-budget edits', async () => {
    stubHost(open([
      { target: 'app:invoice-payments', room: false, limit_msat: null, spent_msat: 1000 },
      { target: 'app:keysend-payments', room: false, limit_msat: null, spent_msat: 2000 },
    ], { spent_msat: 3000 }));
    await openShell();
    $<HTMLButtonElement>('[data-tab="budget"]')!.click();
    expect(text('[data-budget-row="app:invoice-payments"]')).toContain('Invoice payments');
    expect(text('[data-budget-row="app:keysend-payments"]')).toContain('Keysend payments');
    expect($('[data-panel="budget"] [data-budget-edit]')).toBeNull();
  });

  it('explains a manual message refusal while automatic approval is off', async () => {
    const host = stubHost(budgetView(), {
      message_send: () => Promise.reject({ code: 'ceiling_exhausted', message: 'Your app daily limit is used up. Nothing was sent.' }),
    });
    host.state.spend = { state: 'open', basis: 'app_lock', open_until_ms: Date.now() + 600_000, pending: null, window_ms: 600_000 };
    await openShell();
    type('[data-composer] textarea', 'keep this manual draft');
    submit();
    await vi.waitFor(() => expect(text('[data-composer-note]')).toContain('Your app daily limit is used up.'));
    expect($<HTMLTextAreaElement>('[data-composer] textarea')!.value).toBe('keep this manual draft');
    expect($('[data-artifact="failed"]')).toBeNull();
    expect(host.used('message_send')).toHaveLength(1);
  });

  it('files and payments still use the ten-minute window', async () => {
    stubHost(open([{ target: MAYA, room: false, limit_msat: 50_000, spent_msat: 0 }]));
    await openShell();
    $<HTMLButtonElement>('[data-composer-mode="pay"]')!.click();
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Send'));
    expect($('[data-budget]')).toBeNull();
  });
  it('shows paid amounts and reservations separately without freeing reserved budget', async () => {
    const row = { target: MAYA, room: false, limit_msat: 50_000, spent_msat: 1000,
      unsettled_msat: 6000, accounted_msat: 7000, fee_unknown: false };
    const budget = open([row], { spent_msat: 1000, unsettled_msat: 6000, accounted_msat: 7000 });
    stubHost(budget);
    await openShell();
    type('[data-composer] textarea', 'next');
    await vi.waitFor(() => expect(text('[data-budget-line]')).toContain('1 sat of 50 sats'));
    expect(text('[data-budget-line]')).toContain('6 sats reserved');
    $<HTMLButtonElement>('[data-tab="budget"]')!.click();
    expect(text('[data-tally-total]')).toBe('1 sat / 500 sats');
    expect(text('[data-unsettled]')).toContain('6 sats reserved');
    expect(text(`[data-budget-row="${MAYA}"]`)).toContain('6 sats reserved');
    expect(budgetStand(budget, MAYA, false, 44_000).kind).toBe('contact_used');
  });
  it('labels a settled legacy fee unknown while counting only proven principal', async () => {
    stubHost(open([{ target: MAYA, room: false, limit_msat: 50_000, spent_msat: 1000,
      accounted_msat: 6000, fee_unknown: true }], { spent_msat: 1000, accounted_msat: 6000, fee_unknown: true }));
    await openShell();
    $<HTMLButtonElement>('[data-tab="budget"]')!.click();
    expect(text('[data-tally-total]')).toBe('1 sat / 500 sats');
    expect(text('[data-fee-unknown]')).toContain('fee unknown');
    expect(text(`[data-budget-row="${MAYA}"]`)).toContain('fee unknown');
  });
});

describe('budget rules', () => {
  const T = Date.now();
  it('stands a track against its budget and the daily total', () => {
    const view = open([{ target: MAYA, room: false, limit_msat: 5000, spent_msat: 4000 }], { spent_msat: 4000 });
    expect(budgetStand(null, MAYA, false, 2000).kind).toBe('unknown');
    expect(budgetStand(budgetView(), MAYA, false, 2000).kind).toBe('off');
    expect(budgetStand({ ...view, paused: true }, MAYA, false, 2000).kind).toBe('paused');
    expect(budgetStand({ ...view, waiting_for_owner: true }, MAYA, false, 2000).kind).toBe('waiting');
    expect(budgetStand(view, MAYA, false, 1000)).toMatchObject({ kind: 'ok', spent: 4000, limit: 5000 });
    expect(budgetStand(view, MAYA, false, 2000)).toEqual({ kind: 'contact_used', limit: 5000, spent: 4000, raiseTo: 10_000 });
    expect(budgetStand(view, NEW, false, 2000)).toEqual({ kind: 'first', suggest: 50_000, ceiling: 500_000 });
    // The node asked the owner's OK to admit a known contact again: the door
    // card, with their budget as it stands.
    expect(budgetStand(view, MAYA, false, 1000, true)).toEqual({ kind: 'first', suggest: 5000, ceiling: 500_000, again: true });
    expect(budgetStand(view, ROOM, true, 2000, true)).toEqual({ kind: 'first', suggest: 100_000, ceiling: 500_000 });
    expect(budgetStand(view, ROOM, true, 2000)).toEqual({ kind: 'first', suggest: 100_000, ceiling: 500_000 });
    const full = open([{ target: MAYA, room: false, limit_msat: 500_000, spent_msat: 499_000 }], { spent_msat: 499_000 });
    expect(budgetStand(full, MAYA, false, 2000)).toEqual({ kind: 'contact_used', limit: 500_000, spent: 499_000, raiseTo: null });
    const total = open([{ target: MAYA, room: false, limit_msat: 50_000, spent_msat: 0 }], { spent_msat: 499_000 });
    expect(budgetStand(total, MAYA, false, 2000)).toEqual({ kind: 'total_used', ceiling: 500_000, spent: 499_000, raiseTo: 1_000_000 });
    expect(messagesWorth(50_000, 2000)).toBe('25 messages');
    expect(messagesWorth(1000, 2000)).toBe('0 messages');
    expect(T).toBeGreaterThan(0);
  });

});

describe('sample source budgets', () => {
  const maya = SAMPLE_PEERS[0].node_id;
  const gamma = SAMPLE_PEERS[3].node_id;

  it('grants a budget without opening the window, then pays known contacts and asks for strangers', async () => {
    const s = sampleSource({ firstLiveMs: 1e9 });
    await expect(s.send(maya, false, 'x', 2000)).rejects.toMatchObject({ code: 'spend_locked' });
    expect((await s.budgetApprove(500_000, 'careful')).waiting_for_owner).toBe(true);
    await s.spendStatus();
    expect((await s.spendStatus()).state).toBe('locked');
    expect((await s.budgetStatus()).autopay.state).toBe('open');
    expect((await s.send(maya, false, 'gm', 7000)).amount_msat).toBe(2000);
    await expect(s.send(gamma, false, 'gm', 7000)).rejects.toMatchObject({ code: 'first_contact' });
    await s.send(gamma, false, 'gm', 7000, undefined, 20_000);
    const v = await s.budgetStatus();
    expect(v.rows.find((r) => r.target === gamma)?.limit_msat).toBe(20_000);
    await expect(s.pay('lntbs10n1samplenotpayable0donotpay', 1000, 6000)).rejects.toMatchObject({ code: 'spend_locked' });
  });

  it('sample files pay through the open budget without the ten-minute window', async () => {
    const s = sampleSource({ firstLiveMs: 1e9 });
    await s.budgetApprove(500_000, 'careful');
    await s.spendStatus();
    await s.spendStatus();
    expect((await s.budgetStatus()).autopay.state).toBe('open');
    expect((await s.spendStatus()).state).toBe('locked');
    const receipt = await s.fileSend(maya, 'note.txt', 'text/plain', 'aGk=', 8000);
    expect(receipt.filename).toBe('note.txt');
    expect(receipt.accepted).toBe(true);
    expect(receipt.state).toBe('acked');
    // Sample book starts with 8 sats already spent; this file adds another 8.
    expect((await s.budgetStatus()).spent_msat).toBe(16000);
  });

  it('sample files and manual messages share the daily tally and refusal', async () => {
    const s = sampleSource({ firstLiveMs: 1e9 });
    await s.budgetApprove(16000, 'careful');
    // Cancel the pending automatic approval, then open only the manual window.
    await s.spendLock();
    await s.spendRequest();
    await s.spendStatus();
    await s.spendStatus();
    expect((await s.budgetStatus()).autopay.state).toBe('off');
    await s.budgetSet(maya, false, 0);
    // Fixture starts with 8 sats. A 8-sat all-in file fills the shared 16-sat limit.
    await s.fileSend(maya, 'a.txt', 'text/plain', 'aGk=', 8000);
    expect((await s.budgetStatus()).spent_msat).toBe(16000);
    await expect(s.send(maya, false, 'hi', 7000)).rejects.toMatchObject({ code: 'ceiling_exhausted' });
    await expect(s.fileSend(maya, 'b.txt', 'text/plain', 'aGk=', 8000)).rejects.toMatchObject({ code: 'ceiling_exhausted' });
  });

  it('sample invoice and keysend count and refuse against the same app limit', async () => {
    const s = sampleSource({ firstLiveMs: 1e9 });
    await s.budgetApprove(20000, 'careful');
    await s.spendLock();
    await s.spendRequest();
    await s.spendStatus();
    await s.spendStatus();
    await s.pay('lntbs10n1samplenotpayable0donotpay', 1000, 6000);
    await s.keysend('02' + 'ab'.repeat(32), 1000, null, 6000);
    expect((await s.budgetStatus()).spent_msat).toBe(20000);
    await expect(s.pay('lntbs10n1samplenotpayable0donotpay', 1000, 6000)).rejects.toMatchObject({ code: 'ceiling_exhausted' });
    await expect(s.keysend('02' + 'ab'.repeat(32), 1000, null, 6000)).rejects.toMatchObject({ code: 'ceiling_exhausted' });
  });

  it('refuses over budget, and pause stops everything until resumed', async () => {
    const s = sampleSource({ firstLiveMs: 1e9 });
    await s.budgetApprove(500_000, 'careful');
    await s.spendStatus();
    await s.spendStatus();
    // The sample already paid Maya 4 sats today.
    await s.budgetSet(maya, false, 12000);
    await s.send(maya, false, 'gm', 7000);
    await expect(s.send(maya, false, 'gm', 7000)).rejects.toMatchObject({ code: 'budget_exhausted' });
    await s.budgetPause();
    await expect(s.send(maya, false, 'gm', 1)).rejects.toMatchObject({ code: 'budget_paused' });
    await expect(s.spendRequest()).rejects.toMatchObject({ code: 'budget_paused' });
    await expect(s.budgetSet(maya, false, 600_000)).rejects.toMatchObject({ code: 'invalid' });
    expect((await s.budgetResume()).paused).toBe(false);
  });


});
