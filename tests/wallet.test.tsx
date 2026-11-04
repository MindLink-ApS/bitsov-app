import { setLanguagePref } from '../src/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import type { PairingView } from '../src/onboarding/pairing';
import type { Artifact, BudgetView, Channel, Message, SpendView, WalletOverview } from '../src/control/types';
import {
  activityTotals, artifactActivity, bitcoinUri, channelWords, filterActivity, logActivity, loggedActivity, mergeActivity, messageActivity,
  openInvoices, readRecipient, resetActivityLog, splitBalance, statusWords, updateInvoice,
} from '../src/control/wallet';
import { resetContactsForTests, setPetname } from '../src/control/petnames';
import { setDenom } from '../src/control/prefs';
import { invoiceFromNode } from '../src/control/sample';
import NODE_PAYMENT_STATUS from './fixtures/node-payment-status.json';

const OWN = '1'.repeat(64);
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const PAYEE = `02${'5a'.repeat(32)}`;
const INVOICE = 'lntb20n1walletsampleinvoice';
/** The node's `GET /payments/{hash}` reply, in its own names; the stub maps it as the host does. */
const nodePayment = (status: string, amountMsat = 2000) =>
  invoiceFromNode(200, { payment_hash: '00'.repeat(32), status, amount_msat: amountMsat, direction: 'Incoming', liquidity: null });

const channel = (over: Partial<Channel> = {}): Channel => ({
  channel_id: 'c1', peer_pubkey: `02${'c1'.repeat(32)}`, capacity_msat: 500_000_000, local_balance_msat: 300_000_000, remote_balance_msat: 190_000_000, active: true, ...over,
});
const WALLET: WalletOverview = {
  balance_msat: 480_000_000,
  lightning_outbound_msat: 300_000_000,
  channels: [
    channel(),
    channel({ channel_id: 'c2', peer_pubkey: `03${'c2'.repeat(32)}`, capacity_msat: 100_000_000, local_balance_msat: 80_000_000, remote_balance_msat: 15_000_000, active: false }),
  ],
};
const msg = (id: string, kind: number, sender: string, recipient: string, paid: number | null, timestamp = 1_000): Message => ({
  id, kind, sender, recipient, timestamp, plaintext: 'x', payment_amount_msat: paid,
});

describe('wallet: balance and channels in plain words', () => {
  it('keeps the node total without treating channel capacity or the remainder as spendable', () => {
    expect(splitBalance(WALLET)).toEqual({ total: 480_000_000, hasBreakdown: false, pending: null, lightning: null, onchain: null, onchainTotal: null, reserved: null, closing: null, contested: null });
  });
  it.each([0, 200_000_000, 480_000_000])('preserves a reported total of %i even without a breakdown', (total) => {
    expect(splitBalance({ ...WALLET, balance_msat: total })).toEqual({ total, hasBreakdown: false, pending: null, lightning: null, onchain: null, onchainTotal: null, reserved: null, closing: null, contested: null });
  });
  it.each([
    [undefined, null],
    [null, null],
    [0, 0],
    [15_000, 15_000_000],
  ])('uses only reported pending with an anchor reserve: %s', (reported, pending) => {
    expect(splitBalance({ ...WALLET,
      onchain_total_sats: 130_000, onchain_spendable_sats: 90_000,
      anchor_reserve_sats: 25_000, onchain_pending_sats: reported,
    })).toMatchObject({ pending, onchainTotal: 130_000_000, onchain: 90_000_000, reserved: 25_000_000 });
  });
  it('an open channel says what can be sent and received; an offline one says funds stay yours', () => {
    expect(channelWords(channel())).toMatchObject({ state: 'open', line: 'You can send up to 300\u202f000 sats and receive up to 190\u202f000 sats through it.' });
    expect(channelWords(channel({ active: false })).line).toMatch(/offline, or the channel is still opening or closing\. What you hold in it stays yours/);
  });
});

describe('wallet: receive and send inputs', () => {
  it('an on-chain request carries its amount in whole sats only', () => {
    expect(bitcoinUri('tb1qaddr', null)).toBe('bitcoin:tb1qaddr');
    expect(bitcoinUri('tb1qaddr', 150_000_000)).toBe('bitcoin:tb1qaddr?amount=0.0015');
    expect(bitcoinUri('tb1qaddr', 100_000_000_000)).toBe('bitcoin:tb1qaddr?amount=1');
    expect(bitcoinUri('tb1qaddr', 1_500)).toBeNull();
  });
  it('tells an invoice from a node id and an on-chain address', () => {
    expect(readRecipient(' lightning:LNTB20N1abc ')).toEqual({ kind: 'invoice', text: 'lightning:LNTB20N1abc' });
    expect(readRecipient(PAYEE.toUpperCase())).toEqual({ kind: 'node', pubkey: PAYEE });
    expect(readRecipient('tb1qsampledata0notarealaddress0donotsend')).toEqual({ kind: 'onchain' });
    expect(readRecipient('hello')).toEqual({ kind: 'unknown' });
  });
});

describe('wallet: activity', () => {
  beforeEach(() => resetActivityLog());
  it('lists paid messages, calls and files with their direction; unpaid messages are not transactions', () => {
    const items = messageActivity([
      msg('m1', 0, A, OWN, 2000),
      msg('m2', 0, OWN, A, 3000),
      msg('m3', 400, OWN, B, 10_000),
      msg('m4', 200, B, OWN, 4000),
      msg('m5', 0, A, OWN, null),
      // A paid call minute (M6 block, kind 404) is part of the call, not a message.
      msg('m6', 404, OWN, B, 10_000),
    ], OWN);
    expect(items.map((a) => [a.kind, a.direction, a.who, a.label])).toEqual([
      ['message', 'in', A, 'Message received'],
      ['message', 'out', A, 'Message sent'],
      ['call', 'out', B, 'Call'],
      ['file', 'in', B, 'Received a file'],
      ['call', 'out', B, 'Call'],
    ]);
  });
  it('filters by kind and direction, and totals only money that moved', () => {
    const invoice = artifactActivity({ id: 'x', at: 5, type: 'invoice', invoice: { bolt11: INVOICE, amount_msat: 9000, note: null, expires_at_ms: 10 } }, null)!;
    const items = mergeActivity(messageActivity([msg('m1', 0, A, OWN, 2000, 1), msg('m3', 400, OWN, B, 10_000, 2)], OWN), [invoice]);
    expect(items.map((a) => a.id)).toEqual([invoice.id, 'm:m3', 'm:m1']);
    expect(filterActivity(items, 'calls', 'all').map((a) => a.id)).toEqual(['m:m3']);
    expect(filterActivity(items, 'all', 'in').map((a) => a.id)).toEqual([invoice.id, 'm:m1']);
    expect(filterActivity(items, 'payments', 'all').map((a) => a.id)).toEqual([invoice.id]);
    // An invoice not paid yet moved nothing.
    expect(activityTotals(items)).toEqual({ in: 2000, out: 10_000 });
    expect(activityTotals([{ ...invoice, status: 'paid' }])).toEqual({ in: 9000, out: 0 });
  });
  it('logs a payment or invoice once, keeps it across reads, and reads an invoice as received when the node says paid', () => {
    const inv: Artifact = { id: 'local-1', at: 100, type: 'invoice', invoice: { bolt11: INVOICE, amount_msat: 2000, note: 'lunch', expires_at_ms: Date.now() + 60_000 } };
    const paid: Artifact = { id: 'local-2', at: 200, type: 'payment', receipt: { method: 'invoice', amount_msat: 1000, status: 'settled', paid_at_ms: 200 } };
    logActivity([artifactActivity(inv, A)!, artifactActivity(paid, null)!]);
    logActivity([artifactActivity(inv, A)!]);
    expect(loggedActivity().map((a) => [a.kind, a.label, a.status])).toEqual([['payment', 'Paid an invoice', 'settled'], ['invoice', 'Invoice · lunch', 'waiting']]);
    const open = openInvoices(loggedActivity(), Date.now());
    expect(open).toHaveLength(1);
    updateInvoice(open[0].id, { state: 'paid', amount_msat: 2000 });
    const now = loggedActivity().find((a) => a.kind === 'invoice')!;
    expect(statusWords(now, Date.now())).toBe('Received');
    expect(openInvoices(loggedActivity(), Date.now())).toHaveLength(0);
    // "unknown" never overwrites what is known.
    updateInvoice(now.id, { state: 'unknown', amount_msat: null });
    expect(loggedActivity().find((a) => a.kind === 'invoice')!.status).toBe('paid');
  });
});

describe('the node payment contract', () => {
  it('reads the node’s own names exactly as the host does (shared fixture with act.rs)', () => {
    expect(NODE_PAYMENT_STATUS.length).toBeGreaterThanOrEqual(9);
    for (const c of NODE_PAYMENT_STATUS) expect(invoiceFromNode(c.http, c.body), JSON.stringify(c.body)).toEqual(c.want);
  });
});

// ---- the page, in the shell ---------------------------------------------------

const paired: PairingView = { state: 'paired', scopes: ['read', 'receive'], short_code: 'ABCD-EFGH', code_from_node: true, reason: null, remote: false, bootstrap: null };
const budget = (): BudgetView => ({
  paused: false, waiting_for_owner: false, ceiling_msat: 500_000, max_daily_msat: 100_000_000, spent_msat: 0, unsettled_msat: 0,
  preset: 'careful', presets: [{ id: 'careful', contact_msat: 50_000, room_msat: 100_000, ceiling_msat: 500_000 }],
  rows: [{ target: A, room: false, limit_msat: 50_000, spent_msat: 0 }],
  autopay: { state: 'open', open_until_ms: Date.now() + 86_400_000, ceiling_msat: 500_000, basis: 'node_grant' },
  window_ms: 600_000, node_grant: null,
});
const locked: SpendView = { state: 'locked', basis: null, open_until_ms: null, pending: null, window_ms: 600_000 };
const open = (): SpendView => ({ state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 600_000, pending: null, window_ms: 600_000 });

type Reply = (args?: Record<string, unknown>) => unknown;
function stubHost(overrides: Record<string, Reply> = {}) {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const callbacks = new Map<number, (e: unknown) => void>();
  const REPLIES: Record<string, Reply> = {
    node_status: () => ({ ready: true, node_id: OWN, error: null }),
    trust_acknowledge: () => true,
    pairing_status: () => paired,
    node_overview: () => ({ node_id: OWN, status: 'ok', version: 'api v2', connected_peers: 2, e2ee_sessions: 2, pending_deliveries: 0,
      lightning_available: true, block_height: 1, uptime_secs: 1, lightning_backend: 'ldk', chain_backend: 'esplora', read_at: Date.now(), capabilities: [] }),
    peers_list: () => [
      { node_id: A, addr: null, label: 'Maya', connected: true, fingerprint: null },
      { node_id: B, addr: null, label: 'Jon', connected: true, fingerprint: null },
    ],
    rooms_list: () => [],
    messages_list: (args) => (args!.peer === A
      ? [msg('ma1', 0, A, OWN, 2000, Date.now() - 60_000), msg('ma2', 0, OWN, A, 3000, Date.now() - 50_000)]
      : args!.peer === B ? [msg('mb1', 400, OWN, B, 10_000, Date.now() - 40_000)] : []),
    price_quote: () => ({ kind: 0, own_msat: 1000, peer_msat: 2000, peer_age_secs: 30, max_routing_fee_msat: 0, peer_stale: false }),
    payments_overview: () => WALLET,
    fund_state: () => null,
    funding_address: () => ({ address: 'tb1qwalletaddress0000000000000000000000', network: 'signet', note: null }),
    file_price: () => ({ principal_msat: 3000, max_routing_fee_msat: 5000, total_msat: 8000 }),
    spend_status: () => locked,
    budget_status: () => budget(),
    invoice_create: (args) => ({ bolt11: 'lntb25u1walletreceive', amount_msat: args!.amount_msat, note: args!.note || null, expires_at_ms: Date.now() + 3_600_000 }),
    invoice_status: () => nodePayment('Pending'),
    invoice_amount: (args) => ({ amount_msat: 2000, network: 'signet', payee: PAYEE, expires_at_ms: Date.now() + 3_600_000, bolt11: String(args!.bolt11).toLowerCase(), payment_hash: '00'.repeat(32), description: 'coffee' }),
    payment_pay: (args) => ({ method: 'invoice', amount_msat: args!.amount_msat, max_routing_fee_msat: 5000, status: 'settled', paid_at_ms: Date.now() }),
    payment_keysend: (args) => ({ method: 'keysend', amount_msat: args!.amount_msat, max_routing_fee_msat: 5000, status: 'settled', paid_at_ms: Date.now() }),
    live_link: () => null,
    'plugin:event|listen': () => 1,
    'plugin:event|unlisten': () => null,
    ...overrides,
  };
  vi.stubGlobal('__TAURI_INTERNALS__', {
    transformCallback: (cb: (e: unknown) => void) => { const id = callbacks.size + 1; callbacks.set(id, cb); return id; },
    invoke: (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      const reply = REPLIES[cmd];
      if (!reply) return Promise.reject(new Error(`unexpected ${cmd}`));
      try { return Promise.resolve(reply(args)); } catch (e) { return Promise.reject(e); }
    },
  });
  vi.stubGlobal('__TAURI_EVENT_PLUGIN_INTERNALS__', { unregisterListener: () => {} });
  return { used: (cmd: string) => calls.filter((c) => c.cmd === cmd) };
}

describe('the Wallet page', () => {
  let dispose: (() => void) | undefined;
  let mount: HTMLElement;
  beforeEach(() => {
    resetContactsForTests();
    resetActivityLog();
    setDenom('sats');
    setPetname(A, 'Maya');
    setPetname(B, 'Jon');
  });
  afterEach(() => {
    setLanguagePref('en');
    dispose?.();
    dispose = undefined;
    mount?.remove();
    vi.unstubAllGlobals();
    resetContactsForTests();
    resetActivityLog();
  });
  const $ = <T extends Element = HTMLElement>(sel: string) => mount.querySelector<T>(sel);
  const text = (sel: string) => $(sel)?.textContent ?? '';
  const click = (sel: string) => $<HTMLButtonElement>(sel)!.click();
  const type = (sel: string, value: string) => {
    const el = $<HTMLInputElement | HTMLTextAreaElement>(sel)!;
    el.value = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  };
  const moneyCalls = (host: ReturnType<typeof stubHost>) => [...host.used('payment_pay'), ...host.used('payment_keysend'), ...host.used('message_send')];
  async function openWallet(tab?: string) {
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => <App />, mount);
    await vi.waitFor(() => expect([...mount.querySelectorAll('button')].some((b) => b.textContent?.includes('I understand'))).toBe(true));
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-profile]')?.disabled).toBe(false));
    click('[data-profile]');
    await vi.waitFor(() => expect($('[data-avatar-menu]')).not.toBeNull());
    click('[data-open-wallet]');
    await vi.waitFor(() => expect($('[data-wallet-page]')).not.toBeNull());
    if (tab) click(`[data-wallet-tab="${tab}"]`);
  }

  it('opens full screen from the avatar menu: the node total with unknown spendability; Escape closes it', async () => {
    stubHost();
    await openWallet();
    expect(text('[data-avatar-balance]')).toBe('');
    await vi.waitFor(() => expect($('[data-balance-total]')?.getAttribute('data-balance-total')).toBe('480000000'));
    expect(text('[data-balance-total]')).toBe('480\u202f000sats');
    for (const category of ['spendable', 'reserved', 'closing']) {
      expect(text(`[data-balance-${category}] .split-amount`)).toBe('Unknown');
    }
    expect(text('[data-balance-spendable]')).toMatch(/Spendable/);
    expect(text('[data-balance-reserved]')).toMatch(/Reserved.*channel fee reserve/i);
    expect(text('[data-balance-closing]')).toMatch(/Closing\/locked/);
    expect(text('[data-wallet-basis]')).toMatch(/does not report.*separately/);
    expect(text('[data-wallet-online]')).toMatch(/home node must stay online.*no watchtower/i);
    // What is behind the page is out of reach while it is open.
    const inert = (el: Element | null) => !!el && (el.hasAttribute('inert') || (el as HTMLElement & { inert?: boolean }).inert === true);
    expect(inert($('nav.rail'))).toBe(true);
    expect(inert($('section.track'))).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.waitFor(() => expect($('[data-wallet-page]')).toBeNull());
    expect(inert($('nav.rail'))).toBe(false);
    // The menu shows the balance once it is read.
    click('[data-profile]');
    await vi.waitFor(() => expect(text('[data-avatar-balance]')).toBe('480\u2009000 sats'));
  });

  it('labels custody under the balance only when the node reports it, and marks unknown amounts as unknown', async () => {
    stubHost();
    await openWallet();
    await vi.waitFor(() => expect($('[data-balance-total]')).not.toBeNull());
    // The overview above reports no custody_mode: no label, no guess.
    expect($('[data-wallet-balance] [data-custody]')).toBeNull();
    for (const category of ['spendable', 'reserved', 'closing']) {
      expect($(`[data-balance-${category}] .split-amount`)?.classList.contains('unknown')).toBe(true);
    }
    dispose?.(); mount.remove();
    localStorage.clear(); // a fresh mount shows the trust gate again

    const reported = stubHost({
      node_overview: () => ({ node_id: OWN, status: 'ok', version: 'api v2', connected_peers: 2, e2ee_sessions: 2, pending_deliveries: 0,
        lightning_available: true, block_height: 1, uptime_secs: 1, lightning_backend: 'ldk', chain_backend: 'esplora', read_at: Date.now(), capabilities: [],
        custody_mode: 'hosted_custody' }),
    });
    void reported;
    await openWallet();
    await vi.waitFor(() => expect($('[data-wallet-balance] [data-custody]')?.textContent).toBe('Hosted custody'));
  });

  it('does not invent reserve or closing amounts from a wallet with active and closing channels', async () => {
    // The public API loses the underlying reserve/closing breakdown. A 25k-sat
    // reserve and 80k-sat closing balance cannot be recovered from this reply.
    // Even the inactive channel might instead be opening or temporarily offline.
    stubHost({ payments_overview: () => ({ ...WALLET, balance_msat: 505_000_000 }) });
    await openWallet();
    await vi.waitFor(() => expect(text('[data-balance-total]')).toBe('505\u202f000sats'));
    expect(text('[data-balance-spendable] .split-amount')).toBe('Unknown');
    expect(text('[data-balance-reserved] .split-amount')).toBe('Unknown');
    expect(text('[data-balance-closing] .split-amount')).toBe('Unknown');
    expect($('[data-balance-onchain]')).toBeNull();
    expect($('[data-balance-onchain-total]')).toBeNull();
    expect($('[data-balance-lightning]')).toBeNull();
  });

  it.each([
    [{ onchain_total_sats: 190804, onchain_spendable_sats: 2004 }, 'Pending on-chain: Unknown'],
    [{ onchain_total_sats: 130_000, onchain_spendable_sats: 90_000, anchor_reserve_sats: 25_000 }, 'Pending on-chain: Unknown'],
    [{ onchain_total_sats: 130_000, onchain_spendable_sats: 90_000, anchor_reserve_sats: 25_000, onchain_pending_sats: null }, 'Pending on-chain: Unknown'],
    [{ onchain_total_sats: 130_000, onchain_spendable_sats: 90_000, anchor_reserve_sats: 25_000, onchain_pending_sats: 15_000 }, '15\u202f000 sats pending'],
    [{ onchain_pending_sats: 188800 }, '188\u202f800 sats pending'],
    [{ onchain_pending_sats: 0, onchain_total_sats: 190804, onchain_spendable_sats: 2004 }, '0 sats pending'],
    [{ onchain_total_sats: 190804 }, 'Pending on-chain: Unknown'],
    [{ onchain_spendable_sats: 2004 }, 'Pending on-chain: Unknown'],
    [{ onchain_total_sats: 1000, onchain_spendable_sats: 2004 }, 'Pending on-chain: Unknown'],
    [{}, 'Pending on-chain: Unknown'],
  ])('keeps pending funds separate from the headline: %j', async (fields, pending) => {
    stubHost({ payments_overview: () => ({ ...WALLET, balance_msat: 2004000, ...fields }) });
    await openWallet();
    await vi.waitFor(() => expect(text('[data-balance-total]')).toBe('2\u202f004sats'));
    expect(text('[data-balance-pending]')).toBe(pending);
    if ('onchain_pending_sats' in fields) expect(text('[data-wallet-basis]')).not.toContain('one total');
    expect($('[data-balance-pending]')?.closest('[data-wallet-balance]')).not.toBeNull();
  });

  it('names a channel only from an unambiguous node-reported LN mapping', async () => {
    stubHost({ peers_list: () => [{ node_id: A, connected: true, label: null, addr: null, fingerprint: null, ln_pubkey: WALLET.channels[0].peer_pubkey.toUpperCase() }] });
    setPetname(A, 'Maya');
    await openWallet();
    $<HTMLButtonElement>('[data-wallet-tab="channels"]')!.click();
    await vi.waitFor(() => expect(text('[data-channel="c1"] .channel-peer')).toBe('Maya'));
    expect(text('[data-channel="c2"] .channel-peer')).toContain('Unnamed contact');
  });

  it('keeps the honest channel fallback when two contacts claim the same LN key', async () => {
    stubHost({ peers_list: () => [A, B].map((node_id) => ({ node_id, connected: true, label: null, addr: null, fingerprint: null, ln_pubkey: WALLET.channels[0].peer_pubkey })) });
    setPetname(A, 'Maya'); setPetname(B, 'Josh');
    await openWallet();
    $<HTMLButtonElement>('[data-wallet-tab="channels"]')!.click();
    expect(text('[data-channel="c1"] .channel-peer')).toContain('Unnamed contact');
  });

  it('shows independent node categories with overlap and routing limits, without a derived total', async () => {
    const host = stubHost({ payments_overview: () => ({ ...WALLET,
      lightning_spendable_sats: 210_000, onchain_spendable_sats: 90_000,
      onchain_total_sats: 130_000, anchor_reserve_sats: 25_000,
      closing_sats: 80_000, contested_sats: 7_000,
    }) });
    await openWallet();
    await vi.waitFor(() => expect(text('[data-balance-lightning] .split-amount')).toBe('210\u202f000 sats'));
    expect(text('[data-balance-onchain] .split-amount')).toBe('90\u202f000 sats');
    expect(text('[data-balance-onchain-total] .split-name')).toBe('On-chain total');
    expect(text('[data-balance-onchain-total] .split-amount')).toBe('130\u202f000 sats');
    expect(text('[data-balance-reserved] .split-amount')).toBe('25\u202f000 sats');
    expect(text('[data-balance-pending]')).toBe('Pending on-chain: Unknown');
    expect($('[data-balance-pending]')?.getAttribute('data-balance-pending')).toBe('unknown');
    expect(text('[data-balance-closing] .split-amount')).toBe('80\u202f000 sats');
    expect(text('[data-balance-contested] .split-amount')).toBe('7\u202f000 sats');
    expect(text('[data-balance-lightning]')).toMatch(/outbound capacity.*not.*guarantee.*routing fees.*per-HTLC limits.*remote liquidity/i);
    expect(text('[data-balance-contested]')).toMatch(/conditional.*not guaranteed/i);
    expect(text('[data-wallet-basis]')).toMatch(/overlap.*do not add up/i);
    expect(text('[data-wallet-basis]')).toMatch(/closing.*before sweep fees.*already.*on-chain/i);
    expect(text('[data-balance-reserved]')).toMatch(/included in.*on-chain total/i);
    expect(text('[data-wallet-balance]')).toContain('Node-reported total');
    expect(text('[data-balance-total]')).toBe('480\u202f000sats');
    // These deliberately non-reconciling amounts must never become a second total.
    expect(text('[data-wallet-balance]')).not.toMatch(/387\u202f000|412\u202f000|452\u202f000/);
    expect(mount.querySelectorAll('.wallet-hero .split-amount')).toHaveLength(6);
    expect(moneyCalls(host)).toHaveLength(0);
  });

  it('shows known zeros and hides zero contested claims', async () => {
    stubHost({ payments_overview: () => ({ ...WALLET,
      lightning_spendable_sats: 0, onchain_spendable_sats: 0, onchain_total_sats: 0,
      anchor_reserve_sats: 0, closing_sats: 0, contested_sats: 0,
    }) });
    await openWallet();
    await vi.waitFor(() => expect(text('[data-balance-lightning] .split-amount')).toBe('0 sats'));
    for (const category of ['onchain', 'onchain-total', 'reserved', 'closing']) {
      expect(text(`[data-balance-${category}] .split-amount`)).toBe('0 sats');
    }
    expect($('[data-balance-contested]')).toBeNull();
    expect(text('[data-balance-total]')).toBe('480\u202f000sats');
  });

  it.each([
    { closing_sats: 42 },
    { onchain_total_sats: 42 },
  ])('keeps missing categories unknown with a partial breakdown %j', async (fields) => {
    stubHost({ payments_overview: () => ({ ...WALLET, ...fields }) });
    await openWallet();
    await vi.waitFor(() => expect(text('[data-balance-lightning] .split-amount')).toBe('Unknown'));
    expect(text('[data-balance-onchain] .split-amount')).toBe('Unknown');
    expect(text('[data-balance-onchain-total] .split-amount')).toBe('onchain_total_sats' in fields ? '42 sats' : 'Unknown');
    expect(text('[data-balance-reserved] .split-amount')).toBe('Unknown');
    expect(text('[data-balance-closing] .split-amount')).toBe('closing_sats' in fields ? '42 sats' : 'Unknown');
    expect($('[data-balance-contested]')).toBeNull();
    expect(text('[data-wallet-basis]')).toMatch(/overlap/);
    // Unreported categories are marked unknown; reported ones are not.
    const unknown = (sel: string) => $(`${sel} .split-amount`)!.classList.contains('unknown');
    expect(unknown('[data-balance-lightning]')).toBe(true);
    expect(unknown('[data-balance-onchain]')).toBe(true);
    expect(unknown('[data-balance-reserved]')).toBe(true);
    expect(unknown('[data-balance-closing]')).toBe(!('closing_sats' in fields));
    expect(unknown('[data-balance-onchain-total]')).toBe(!('onchain_total_sats' in fields));
  });

  it.each([undefined, null])('preserves the entire old-node view for absent categories (%s)', async (missing) => {
    stubHost({ payments_overview: () => ({ ...WALLET,
      lightning_spendable_sats: missing, onchain_spendable_sats: missing, onchain_total_sats: missing,
      anchor_reserve_sats: missing, closing_sats: missing, contested_sats: missing,
    }) });
    await openWallet();
    await vi.waitFor(() => expect(text('[data-balance-total]')).toBe('480\u202f000sats'));
    expect([...mount.querySelectorAll('.wallet-hero .split-name')].map((el) => el.textContent))
      .toEqual(['Spendable', 'Reserved (channel fee reserve)', 'Closing/locked']);
    expect([...mount.querySelectorAll('.wallet-hero .split-amount')].map((el) => el.textContent))
      .toEqual(['Unknown', 'Unknown', 'Unknown']);
    expect(text('[data-wallet-basis]').trim()).toBe('Your node reports one total, but does not report these amounts separately. The total is not a spendable balance.');
    expect($('[data-balance-contested]')).toBeNull();
  });

  it.each([
    [undefined, '300\u2009000 sats'], [null, '300\u2009000 sats'], [210_000, '210\u2009000 sats'], [0, '0 sats'],
  ])('side panel uses outbound capacity and prefers a reported spendable value (%s)', async (reported, expected) => {
    stubHost({ payments_overview: () => ({ ...WALLET, lightning_spendable_sats: reported }) });
    await openWallet();
    click('[data-wallet-close]');
    click('[data-tab="wallet"]');
    await vi.waitFor(() => expect(text('[data-panel="wallet"] dl.facts dd')).toBe(expected));
    expect(text('[data-panel="wallet"] dl.facts dt')).toBe('Lightning outbound capacity');
    expect(text('[data-panel="wallet"]')).not.toMatch(/ready to send/);
  });

  it('follows the BTC setting', async () => {
    stubHost();
    setDenom('btc');
    await openWallet();
    await vi.waitFor(() => expect(text('[data-balance-total]')).toBe('0.0048BTC'));
    expect(text('[data-balance-reserved] .split-amount')).toBe('Unknown');
  });

  it.each(['receive', 'send'] as const)('protects %s drafts on unit and language changes', async tab => {
    const host = stubHost();
    await openWallet(tab);
    setLanguagePref('da');
    const input = `[data-${tab}-amount]`;
    const button = tab === 'receive' ? '[data-receive-create]' : '[data-send-review]';
    if (tab === 'send') type('[data-send-to]', PAYEE);
    for (const change of ['unit', 'language']) {
      setDenom('sats'); setLanguagePref('da');
      type(input, '1.000');
      if (change === 'unit') setDenom('btc'); else setLanguagePref('en');
      expect($<HTMLInputElement>(input)!.value).toBe('');
      expect($('[data-amount-cleared]')).not.toBeNull();
      expect($<HTMLButtonElement>(button)!.disabled).toBe(true);
      click(button);
    }
    expect(host.used('invoice_create')).toHaveLength(0);
    expect(moneyCalls(host)).toHaveLength(0);
    setDenom('sats');
    type(input, '1500');
    setDenom('btc');
    expect($<HTMLInputElement>(input)!.value).toBe('0.000015');
    setDenom('sats');
    expect($<HTMLInputElement>(input)!.value).toBe('1500');
  });

  it('Channels: each peer, size, what you can send and receive, and its state in plain words', async () => {
    stubHost();
    await openWallet('channels');
    await vi.waitFor(() => expect($('[data-channel="c1"]')).not.toBeNull());
    expect(text('[data-channels-summary]')).toMatch(/1 of 2 open.*You can send 300\u202f000 sats.*receive 190\u202f000 sats/);
    expect($('[data-channel="c1"]')!.getAttribute('data-channel-state')).toBe('open');
    expect($('[data-channel="c1"] [data-channel-capacity]')!.getAttribute('data-channel-capacity')).toBe('500000000');
    expect(text('[data-channel="c1"] [data-channel-words]')).toMatch(/send up to 300\u202f000 sats and receive up to 190\u202f000 sats/);
    expect(text('[data-channel="c2"] [data-channel-pill]')).toBe('Not usable now');
    expect(text('[data-channel="c2"] [data-channel-words]')).toMatch(/stays yours/);
  });

  it.each(['en', 'da'] as const)('Receive over Lightning (%s): an amount makes an invoice with a QR; it reads as received once the node says paid; nothing is paid', async locale => {
    setLanguagePref(locale);
    let paid = false;
    const host = stubHost({ invoice_status: () => nodePayment(paid ? 'Settled' : 'Pending', 2_500_000) });
    await openWallet('receive');
    await vi.waitFor(() => expect($('[data-receive-create]')).not.toBeNull());
    expect($<HTMLButtonElement>('[data-receive-create]')!.disabled).toBe(true);
    expect(text('[data-receive-hint]')).toContain(locale === 'da' ? 'beløb til en Lightning-faktura' : 'needs an amount for a Lightning invoice');
    type('[data-receive-amount]', '1.250');
    expect($<HTMLButtonElement>('[data-receive-create]')!.disabled).toBe(locale === 'da');
    if (locale === 'da') expect(text('[data-wallet-receive]')).toContain('Brug mellemrum: 1 000');
    type('[data-receive-amount]', '2500');
    type('[data-receive-memo]', 'lunch');
    click('[data-receive-create]');
    await vi.waitFor(() => expect($('[data-receive-invoice]')).not.toBeNull());
    expect(host.used('invoice_create')[0].args).toMatchObject({ amount_msat: 2_500_000, note: 'lunch' });
    expect($('[data-receive-invoice] [data-wallet-qr]')).not.toBeNull();
    expect(text('[data-receive-invoice] [data-bolt11]')).toBe('lntb25u1walletreceive');
    await vi.waitFor(() => expect(text('[data-receive-state]')).toBe(locale === 'da' ? 'Venter på betaling' : 'Waiting to be paid'));
    expect($('[data-wallet-settled]')).toBeNull();
    expect($('[data-receive-state]')!.classList.contains('ok')).toBe(false);
    const logged = loggedActivity();
    resetActivityLog();
    expect(text('[data-receive-state]')).toBe(locale === 'da' ? 'Venter på betaling' : 'Waiting to be paid');
    logActivity(logged);
    paid = true;
    await vi.waitFor(() => expect(text('[data-receive-state]')).toBe(locale === 'da' ? 'Modtaget' : 'Received'), { timeout: 6000 });
    expect($('[data-receive-state]')!.classList.contains('ok')).toBe(true);
    expect(text('[data-wallet-settled]')).toContain('2\u202f500 sats');
    expect($('[data-receive-invoice] [data-wallet-qr]')).toBeNull();
    expect(host.used('invoice_status').every((c) => c.args!.bolt11 === 'lntb25u1walletreceive')).toBe(true);
    expect(moneyCalls(host)).toHaveLength(0);
    click('[data-wallet-tab="activity"]');
    await vi.waitFor(() => expect($('[data-activity="invoice"]')).not.toBeNull());
    expect(text('[data-activity="invoice"]')).toMatch(locale === 'da' ? /Faktura · lunch.*Modtaget.*\+2\u202f500 sats/ : /Invoice · lunch.*Received.*\+2\u202f500 sats/);
  }, 10_000);

  it.each([1500, null])('Receive shows only the node-reported settled amount: %s', async reported => {
    stubHost({ invoice_status: () => ({ state: 'paid', amount_msat: reported }) });
    await openWallet('receive');
    type('[data-receive-amount]', '2');
    click('[data-receive-create]');
    await vi.waitFor(() => expect($('[data-wallet-settled]')).not.toBeNull());
    expect(text('[data-wallet-settled]')).toContain(reported === null ? 'Amount unknown' : '1.5 sats');
    expect(text('[data-wallet-settled]')).not.toContain('2 sats');
    expect($('[data-receive-invoice] [data-wallet-qr]')).toBeNull();
  });

  it('Receive over Lightning: an invoice the node reports Expired reads as not paid', async () => {
    const host = stubHost({ invoice_status: () => nodePayment('Expired', 2_500_000) });
    await openWallet('receive');
    await vi.waitFor(() => expect($('[data-receive-create]')).not.toBeNull());
    type('[data-receive-amount]', '2500');
    click('[data-receive-create]');
    await vi.waitFor(() => expect(text('[data-receive-state]')).toBe('Not paid'));
    expect(moneyCalls(host)).toHaveLength(0);
  });

  it('Receive on-chain: the node’s address with a QR; the amount is optional and whole sats', async () => {
    const host = stubHost();
    await openWallet('receive');
    click('[data-receive-how="onchain"]');
    await vi.waitFor(() => expect($('[data-receive-address]')).not.toBeNull());
    expect(host.used('funding_address')).toHaveLength(1);
    expect($('[data-receive-address] [data-wallet-qr]')).not.toBeNull();
    expect(text('[data-receive-address] .address')).toBe('tb1qwalletaddress0000000000000000000000');
    expect(text('[data-receive-note]')).toMatch(/Amount is optional/);
    type('[data-receive-amount]', '1.5');
    await vi.waitFor(() => expect($('[data-receive-whole]')).not.toBeNull());
    expect($('[data-receive-address] [data-wallet-qr]')).toBeNull();
    type('[data-receive-amount]', '1500');
    await vi.waitFor(() => expect($('[data-receive-address] [data-wallet-qr]')).not.toBeNull());
    expect(moneyCalls(host)).toHaveLength(0);
  });

  it('Send needs the ten-minute window: the button is the one tap that asks for it, and it pays nothing', async () => {
    const pending: SpendView = { ...locked, state: 'pending', pending: { owner_action: 'konsensus approve ABCD', expires_at_ms: Date.now() + 300_000 } } as SpendView;
    const host = stubHost({ spend_request: () => pending });
    await openWallet('send');
    await vi.waitFor(() => expect($('[data-send-amount]')).not.toBeNull());
    expect($<HTMLButtonElement>('[data-send-review]')!.disabled).toBe(true);
    type('[data-send-amount]', '2');
    type('[data-send-to]', INVOICE);
    await vi.waitFor(() => expect($('[data-send-invoice]')).not.toBeNull());
    expect(text('[data-send-window]')).toMatch(/ten-minute approval/);
    expect(text('[data-send-review]')).toBe('Approve spending');
    click('[data-send-review]');
    await vi.waitFor(() => expect(host.used('spend_request')).toHaveLength(1));
    await vi.waitFor(() => expect(text('[data-send-review]')).toBe('Waiting for approval'));
    expect($<HTMLButtonElement>('[data-send-review]')!.disabled).toBe(true);
    expect(text('[data-wallet-send] [data-owner-action]')).toBe('konsensus approve ABCD');
    expect($('[data-wallet-review]')).toBeNull();
    expect(moneyCalls(host)).toHaveLength(0);
  });

  it('Send an invoice, amount first: the host reads the invoice, a mismatch blocks, the one review pays once at its all-in cap', async () => {
    const host = stubHost({ spend_status: () => open() });
    await openWallet('send');
    await vi.waitFor(() => expect($('[data-send-amount]')).not.toBeNull());
    type('[data-send-amount]', '3');
    type('[data-send-to]', INVOICE);
    await vi.waitFor(() => expect($('[data-send-mismatch]')).not.toBeNull());
    expect(host.used('invoice_amount')[0].args).toEqual({ bolt11: INVOICE });
    expect(text('[data-send-mismatch]')).toMatch(/asks for 2 sats, not the amount above/);
    await vi.waitFor(() => expect($('[data-wallet-send] [data-cost-msat]')).not.toBeNull());
    expect($<HTMLButtonElement>('[data-send-review]')!.disabled).toBe(true);
    click('[data-send-use-invoice]');
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-send-review]')!.disabled).toBe(false));
    expect($('[data-wallet-send] [data-cost-msat]')!.getAttribute('data-cost-msat')).toBe('7000');
    click('[data-send-review]');
    await vi.waitFor(() => expect($('[data-wallet-review]')).not.toBeNull());
    expect($('[data-wallet-review]')!.getAttribute('data-review-max-msat')).toBe('7000');
    expect(text('[data-review-payee]')).toMatch(/025a5a5a…5a5a5a5a/);
    expect(moneyCalls(host)).toHaveLength(0);
    // Back withdraws it; a fresh review is needed.
    click('[data-review-back]');
    await vi.waitFor(() => expect($('[data-wallet-review]')).toBeNull());
    click('[data-send-review]');
    await vi.waitFor(() => expect($('[data-wallet-confirm]')).not.toBeNull());
    click('[data-wallet-confirm]');
    expect($('[data-wallet-confirm]')).toBeNull();
    await vi.waitFor(() => expect($('[data-send-result="ok"]')).not.toBeNull());
    expect(host.used('payment_pay').map((c) => c.args)).toEqual([{ bolt11: INVOICE, amount_msat: 2000, max_msat: 7000 }]);
    expect(text('[data-send-result]')).toMatch(/Paid 2 sats/);
    expect(text('[data-send-result]')).toContain('Network fee: unknown');
    expect(text('[data-wallet-settled]')).toContain('2 sats');
    expect(text('[data-wallet-settled]')).not.toContain('7 sats');
    click('[data-wallet-tab="activity"]');
    await vi.waitFor(() => expect($('[data-activity="payment"]')).not.toBeNull());
    expect(text('[data-activity="payment"]')).toMatch(/Paid an invoice.*Paid.*−2 sats/);
  });

  it('Send to a node id pays directly (keysend) through the same review; an on-chain address is not sent from here', async () => {
    const host = stubHost({ spend_status: () => open() });
    await openWallet('send');
    await vi.waitFor(() => expect($('[data-send-amount]')).not.toBeNull());
    type('[data-send-amount]', '1');
    type('[data-send-to]', 'tb1qsampledata0notarealaddress0donotsend');
    await vi.waitFor(() => expect(text('[data-send-hint]')).toMatch(/on-chain is an owner action at your node/));
    expect($<HTMLButtonElement>('[data-send-review]')!.disabled).toBe(true);
    type('[data-send-to]', PAYEE);
    type('[data-send-memo]', 'thanks');
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-send-review]')!.disabled).toBe(false));
    click('[data-send-review]');
    await vi.waitFor(() => expect($('[data-wallet-confirm]')).not.toBeNull());
    click('[data-wallet-confirm]');
    await vi.waitFor(() => expect(host.used('payment_keysend')).toHaveLength(1));
    expect(host.used('payment_keysend')[0].args).toEqual({ dest_pubkey: PAYEE, amount_msat: 1000, memo: 'thanks', max_msat: 6000 });
    expect(host.used('payment_pay')).toHaveLength(0);
  });

  it('a failed payment says why, and nothing else is tried', async () => {
    const host = stubHost({
      spend_status: () => open(),
      payment_pay: () => { throw { code: 'ceiling_exhausted', message: 'Today’s all-in limit is used up. Nothing was paid.' }; },
    });
    await openWallet('send');
    await vi.waitFor(() => expect($('[data-send-to]')).not.toBeNull());
    type('[data-send-to]', INVOICE);
    // An empty amount takes the invoice's.
    await vi.waitFor(() => expect($<HTMLInputElement>('[data-send-amount]')!.value).toBe('2'));
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-send-review]')!.disabled).toBe(false));
    click('[data-send-review]');
    await vi.waitFor(() => expect($('[data-wallet-confirm]')).not.toBeNull());
    click('[data-wallet-confirm]');
    await vi.waitFor(() => expect($('[data-send-result="failed"]')).not.toBeNull());
    expect(text('[data-send-result]')).toMatch(/limit is used up/);
    expect(host.used('payment_pay')).toHaveLength(1);
  });

  it.each(['pending', 'inflight', 'failed'] as const)('does not celebrate a %s receipt', async status => {
    stubHost({ spend_status: () => open(), payment_keysend: () => ({ method: 'keysend', amount_msat: 2000, status, paid_at_ms: Date.now() }) });
    await openWallet('send');
    type('[data-send-amount]', '2');
    type('[data-send-to]', PAYEE);
    click('[data-send-review]');
    click('[data-wallet-confirm]');
    await vi.waitFor(() => expect($('[data-send-result]')).not.toBeNull());
    expect($('[data-wallet-settled]')).toBeNull();
    expect(text('[data-send-result]')).not.toContain('Paid');
  });

  it('shows the settled receipt amount and proven fee, never the requested amount or ceiling', async () => {
    stubHost({ spend_status: () => open(), payment_keysend: () => ({ method: 'keysend', amount_msat: 1500, fee_paid_msat: 125, max_routing_fee_msat: 5000, status: 'settled', paid_at_ms: Date.now() }) });
    await openWallet('send');
    type('[data-send-amount]', '2');
    type('[data-send-to]', PAYEE);
    click('[data-send-review]');
    click('[data-wallet-confirm]');
    await vi.waitFor(() => expect($('[data-wallet-settled]')).not.toBeNull());
    expect(text('[data-wallet-settled]')).toContain('1.5 sats');
    expect(text('[data-send-result]')).toContain('0.125 sats');
    expect(text('[data-send-result]')).not.toContain('7 sats');
  });

  it('does not say there are no contacts or payments when contacts could not be read', async () => {
    stubHost({ peers_list: () => { throw 'read failed'; } });
    await openWallet();
    await vi.waitFor(() => expect(mount.querySelector('.rail')?.textContent).toContain('We could not load your contacts.'));
    expect(mount.querySelector('.rail')?.textContent).not.toContain('No contacts yet');
    await vi.waitFor(() => expect($('[data-activity-incomplete]')).not.toBeNull());
    expect($('[data-activity-empty="none"]')).toBeNull();
  });

  it('Activity never says no payments when history could not be read', async () => {
    stubHost({ messages_list: () => { throw 'read failed'; } });
    await openWallet();
    await vi.waitFor(() => expect($('[data-activity-incomplete]')).not.toBeNull());
    expect(text('[data-activity-incomplete]')).toContain('may be incomplete');
    expect($('[data-activity-empty="none"]')).toBeNull();
  });

  it('Activity with nothing yet says what shows there and offers Receive; a filter that matches nothing says so', async () => {
    stubHost({ messages_list: () => [] });
    await openWallet();
    await vi.waitFor(() => expect($('[data-activity-empty="none"]')).not.toBeNull());
    expect(text('[data-activity-empty]')).toContain('No payments yet. Payments you send and receive in this app show here.');
    click('[data-activity-direction="in"]');
    await vi.waitFor(() => expect($('[data-activity-empty="filtered"]')).not.toBeNull());
    expect(text('[data-activity-empty]')).toBe('Nothing matches this filter.');
    click('[data-activity-direction="all"]');
    await vi.waitFor(() => expect($('[data-activity-receive]')).not.toBeNull());
    click('[data-activity-receive]');
    await vi.waitFor(() => expect($('[data-wallet-receive]')).not.toBeNull());
  });

  it('no channels: one sentence, the same in Wallet → Channels and in Settings → Wallet, and no funding promise', async () => {
    stubHost({ payments_overview: () => ({ ...WALLET, channels: [] }) });
    await openWallet('channels');
    await vi.waitFor(() => expect($('[data-wallet-page] [data-channels-empty]')).not.toBeNull());
    const sentence = 'No channels yet. A channel is how your node sends and receives over Lightning; paid messages need one.';
    expect(text('[data-wallet-page] [data-channels-empty]')).toBe(sentence);
    expect(text('[data-wallet-page] [data-channels-empty]')).not.toMatch(/fund|deposit/i);
    // The second surface: Settings → Wallet.
    $<HTMLElement>('[data-settings] [data-tab="wallet"]')!.click();
    await vi.waitFor(() => expect($('[data-settings] [data-channels-empty]')).not.toBeNull());
    expect(text('[data-settings] [data-channels-empty]')).toBe(sentence);
  });

  it('Activity: paid messages and calls from each contact’s history, filtered by kind and direction', async () => {
    stubHost();
    await openWallet();
    await vi.waitFor(() => expect(mount.querySelectorAll('[data-activity-list] .wallet-row')).toHaveLength(3));
    expect(text('[data-activity-in]')).toBe('2 sats');
    expect(text('[data-activity-out]')).toBe('13 sats');
    expect(text('[data-activity-id="m:mb1"]')).toMatch(/Call.*Jon.*−10 sats/);
    click('[data-activity-filter="calls"]');
    await vi.waitFor(() => expect(mount.querySelectorAll('[data-activity-list] .wallet-row')).toHaveLength(1));
    click('[data-activity-filter="all"]');
    click('[data-activity-direction="in"]');
    await vi.waitFor(() => expect(mount.querySelectorAll('[data-activity-list] .wallet-row')).toHaveLength(1));
    expect(text('[data-activity-list] .wallet-row')).toMatch(/Message received.*Maya.*\+2 sats/);
    click('[data-activity-filter="payments"]');
    await vi.waitFor(() => expect($('[data-activity-empty]')).not.toBeNull());
    expect(text('[data-activity-scope]')).toMatch(/made in this app on this Mac/);
  });
});
