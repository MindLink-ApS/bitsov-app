import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import type { PairingView } from '../src/onboarding/pairing';
import { sampleSource, SAMPLE_PEERS, SAMPLE_PRESETS } from '../src/control/sample';
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

const paired: PairingView = { state: 'paired', scopes: ['read', 'receive'], short_code: 'ABCD-EFGH', code_from_node: true, reason: null, bootstrap: null };
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
    price_quote: () => ({ kind: 0, own_msat: 1000, peer_msat: 2000, peer_age_secs: 30, peer_stale: false }),
    payments_overview: () => ({ balance_msat: 1_000_000, lightning_outbound_msat: 500_000, channels: [] }),
    fund_state: () => null,
    file_price: () => 3000,
    spend_status: () => state.spend,
    budget_status: () => state.budget,
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
  return { calls, state, used };
}

describe('invisible payments in the composer and the context panel', () => {
  let dispose: (() => void) | undefined;
  let mount: HTMLElement;

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    mount?.remove();
    vi.unstubAllGlobals();
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
    await vi.waitFor(() => expect([...mount.querySelectorAll('button')].some((b) => b.textContent?.includes('I understand'))).toBe(true));
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
    await vi.waitFor(() => expect($(`[data-track="peer:${MAYA}"]`)?.getAttribute('aria-current')).toBe('true'));
    await vi.waitFor(() => expect($('[data-cost-msat]')?.getAttribute('data-cost-msat')).toBe('2000'));
  }

  it('approves a daily total once, then messages go with no prompt and the price still shown', async () => {
    const host = stubHost(budgetView({ rows: [{ target: MAYA, room: false, limit_msat: 50_000, spent_msat: 0 }] }));
    await openShell();
    type('[data-composer] textarea', 'gm Maya');
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Approve daily budget'));
    expect(text('[data-budget-setup]')).toContain('Someone new always asks first');

    // The owner picks a preset; the tap is the approval. Nothing is sent by it.
    $<HTMLButtonElement>('[data-preset="everyday"]')!.click();
    submit();
    await vi.waitFor(() => expect(host.used('budget_approve')).toHaveLength(1));
    expect(host.used('budget_approve')[0].args).toEqual({ ceiling_msat: 2_000_000, preset: 'everyday' });
    expect(host.used('message_send')).toHaveLength(0);
    expect($<HTMLTextAreaElement>('[data-composer] textarea')!.value).toBe('gm Maya');

    await vi.waitFor(() => expect(text('[data-send]')).toBe('Send · 2 sats'));
    expect(text('[data-budget-line]')).toContain('Pays automatically · 0 of 50 sats to Maya in 24 h');
    submit();
    await vi.waitFor(() => expect(host.used('message_send')).toHaveLength(1));
    expect(host.used('message_send')[0].args).toMatchObject({ recipient: MAYA, max_msat: 2000, first_contact_msat: null });
    await vi.waitFor(() => expect($<HTMLTextAreaElement>('[data-composer] textarea')!.value).toBe(''));
    // A second message: no approval, no question.
    type('[data-composer] textarea', 'and again');
    submit();
    await vi.waitFor(() => expect(host.used('message_send')).toHaveLength(2));
    expect(host.used('spend_request')).toHaveLength(0);
    await vi.waitFor(() => expect(text('[data-budget-line]')).toContain('4 of 50 sats'));
  });

  it('asks once before paying someone new, with their budget in their own price', async () => {
    const host = stubHost(open([{ target: MAYA, room: false, limit_msat: 50_000, spent_msat: 0 }]));
    await openShell();
    $<HTMLButtonElement>(`[data-track="peer:${NEW}"]`)!.click();
    await vi.waitFor(() => expect($('[data-first-contact]')).not.toBeNull());
    expect(text('[data-first-contact]')).toContain('First paid message to Nadia');
    await vi.waitFor(() => expect(text('[data-first-budget="50000"]')).toBe('50 sats a day · 25 messages'));
    type('[data-composer] textarea', 'hello Nadia');
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Send first message · ≈ 2 sats'));
    $<HTMLButtonElement>('[data-first-budget="100000"]')!.click();
    submit();
    await vi.waitFor(() => expect(host.used('message_send')).toHaveLength(1));
    expect(host.used('message_send')[0].args).toMatchObject({ recipient: NEW, first_contact_msat: 100_000 });
    // Asked once: the next message goes on its own.
    await vi.waitFor(() => expect($('[data-first-contact]')).toBeNull());
    await vi.waitFor(() => expect($<HTMLTextAreaElement>('[data-composer] textarea')!.value).toBe(''));
    type('[data-composer] textarea', 'second');
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Send · 2 sats'));
  });

  it('explains an exhausted budget and raises it in one tap, within the daily total', async () => {
    const host = stubHost(open([{ target: MAYA, room: false, limit_msat: 3000, spent_msat: 2000 }]));
    await openShell();
    type('[data-composer] textarea', 'one more');
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Budget used up'));
    expect($<HTMLButtonElement>('[data-send]')!.disabled).toBe(true);
    expect(text('[data-budget-used="contact"]')).toContain('2 of 3 sats in the last 24 hours');
    $<HTMLButtonElement>('[data-budget-raise]')!.click();
    await vi.waitFor(() => expect(host.used('budget_set')).toHaveLength(1));
    expect(host.used('budget_set')[0].args).toEqual({ target: MAYA, room: false, limit_msat: 6000 });
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Send · 2 sats'));
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
    await vi.waitFor(() => expect(text('[data-tally-total]')).toBe('7 / 500 sats'));
    expect(text(`[data-budget-row="${MAYA}"]`)).toContain('Maya');
    expect(text(`[data-budget-row="${MAYA}"] [data-row-tally]`)).toBe('4/ 50 sats');
    expect(text(`[data-budget-row="${ROOM}"]`)).toContain('Mexico build');
    expect(text('[data-autopay]')).toContain('Paying automatically');

    $<HTMLButtonElement>('[data-panel="budget"] [data-pause-all]')!.click();
    await vi.waitFor(() => expect(host.used('budget_pause')).toHaveLength(1));
    await vi.waitFor(() => expect(text('[data-autopay]')).toContain('Paused'));
    type('[data-composer] textarea', 'while paused');
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Resume payments'));
    expect(text('[data-budget-paused]')).toContain('Nothing leaves your node');
    submit();
    await vi.waitFor(() => expect(host.used('budget_resume')).toHaveLength(1));
    expect(host.used('message_send')).toHaveLength(0);
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Send · 2 sats'));
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

  it('a budget refusal from the host is explained in the composer, not recorded as a failed send', async () => {
    stubHost(open([{ target: MAYA, room: false, limit_msat: 50_000, spent_msat: 0 }]), {
      message_send: () => Promise.reject({ code: 'budget_exhausted', message: 'You have used 50 of 50 sats for this contact in the last 24 hours.' }),
    });
    await openShell();
    type('[data-composer] textarea', 'race');
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Send · 2 sats'));
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
      await vi.waitFor(() => expect(text('[data-send]')).toBe('Send · 2 sats'));
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
    expect(text('[data-node-grant]')).toBe('Your node allows 396 of 400 sats more, at most 50 per payment, for 30 min.');
  });

  it('files and payments still use the ten-minute window', async () => {
    stubHost(open([{ target: MAYA, room: false, limit_msat: 50_000, spent_msat: 0 }]));
    await openShell();
    $<HTMLButtonElement>('[data-composer-mode="pay"]')!.click();
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Approve spending'));
    expect($('[data-budget]')).toBeNull();
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
    expect((await s.send(maya, false, 'gm', 2000)).amount_msat).toBe(2000);
    await expect(s.send(gamma, false, 'gm', 2000)).rejects.toMatchObject({ code: 'first_contact' });
    await s.send(gamma, false, 'gm', 2000, undefined, 20_000);
    const v = await s.budgetStatus();
    expect(v.rows.find((r) => r.target === gamma)?.limit_msat).toBe(20_000);
    await expect(s.pay('lntbs10n1samplenotpayable0donotpay', 1000, 1000)).rejects.toMatchObject({ code: 'spend_locked' });
  });

  it('refuses over budget, and pause stops everything until resumed', async () => {
    const s = sampleSource({ firstLiveMs: 1e9 });
    await s.budgetApprove(500_000, 'careful');
    await s.spendStatus();
    await s.spendStatus();
    // The sample already paid Maya 4 sats today.
    await s.budgetSet(maya, false, 7000);
    await s.send(maya, false, 'gm', 2000);
    await expect(s.send(maya, false, 'gm', 2000)).rejects.toMatchObject({ code: 'budget_exhausted' });
    await s.budgetPause();
    await expect(s.send(maya, false, 'gm', 1)).rejects.toMatchObject({ code: 'budget_paused' });
    await expect(s.spendRequest()).rejects.toMatchObject({ code: 'budget_paused' });
    await expect(s.budgetSet(maya, false, 600_000)).rejects.toMatchObject({ code: 'invalid' });
    expect((await s.budgetResume()).paused).toBe(false);
  });
});
