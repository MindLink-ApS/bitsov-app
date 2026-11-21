import { t as tr } from '../i18n';
import { t } from '../i18n';
/**
 * The Wallet page's reads, in plain words. Display only: nothing here pays.
 * Sending goes through the composer's own actions (`pay`, `keysend`) and the
 * host checks that already guard them; this file only shapes what is shown.
 */
import { createRoot, createSignal } from 'solid-js';
import { CALL_ANSWER, CALL_HANGUP, CALL_ICE, CALL_OFFER, isCallKind, isCallTrafficKind } from './call';
import { amount as fmtAmount } from './format';
import type { Artifact, Channel, InvoiceStatus, Message, WalletOverview } from './types';

// ---- balance -----------------------------------------------------------------

export type BalanceSplit = {
  /** All display amounts are msat; the reported total is unchanged. */
  total: number;
  hasBreakdown: boolean;
  /** Null means the node API does not provide this amount. */
  lightning: number | null;
  onchain: number | null;
  onchainTotal: number | null;
  pending: number | null;
  reserved: number | null;
  closing: number | null;
  contested: number | null;
};

/** Independent observations, never summed into a spendable balance.
 * Pending is only known when explicitly reported by the node.
 * Closing sweeps may overlap on-chain funds; contested claims are conditional. */
export function splitBalance(w: WalletOverview): BalanceSplit {
  const msat = (sats: number | null | undefined) => sats == null ? null : sats * 1000;
  return {
    pending: msat(w.onchain_pending_sats),
    total: w.balance_msat,
    hasBreakdown: [w.lightning_spendable_sats, w.onchain_spendable_sats, w.onchain_total_sats,
      w.onchain_pending_sats, w.anchor_reserve_sats, w.closing_sats, w.contested_sats].some((value) => value != null),
    lightning: msat(w.lightning_spendable_sats),
    onchain: msat(w.onchain_spendable_sats),
    onchainTotal: msat(w.onchain_total_sats),
    reserved: msat(w.anchor_reserve_sats),
    closing: msat(w.closing_sats),
    contested: msat(w.contested_sats),
  };
}

// ---- channels ----------------------------------------------------------------

/** One channel in plain words. */
export function channelWords(c: Channel): { state: 'open' | 'offline'; title: string; line: string } {
  if (c.active) {
    return {
      state: 'open',
      title: tr('caOpen'),
      line: tr('caYouCanSendUpToAndReceiveUpTo', fmtAmount(c.local_balance_msat, 'down'), fmtAmount(c.remote_balance_msat, 'down')),
    };
  }
  return {
    state: 'offline',
    title: tr('caNotUsableNow'),
    line: tr('caTheirNodeIsOfflineOrTheChannelIsStill'),
  };
}

/** Channels to show: usable ones first, then by what you can send. */
export const sortedChannels = (cs: Channel[]): Channel[] =>
  [...cs].sort((a, b) => Number(b.active) - Number(a.active) || b.local_balance_msat - a.local_balance_msat || a.channel_id.localeCompare(b.channel_id));

// ---- on-chain receive --------------------------------------------------------

/**
 * A BIP 21 `bitcoin:` request for the QR. The address text stays the source
 * of truth. On-chain amounts are whole sats; `null` when the amount has less.
 */
export function bitcoinUri(address: string, msat: number | null): string | null {
  if (msat === null) return `bitcoin:${address}`;
  if (msat <= 0 || msat % 1000 !== 0) return null;
  const sats = msat / 1000;
  const whole = Math.floor(sats / 100_000_000);
  const frac = String(sats % 100_000_000).padStart(8, '0').replace(/0+$/, '');
  return `bitcoin:${address}?amount=${whole}${frac ? `.${frac}` : ''}`;
}

// ---- send: what the owner pasted --------------------------------------------

export type Recipient =
  | { kind: 'invoice'; text: string }
  | { kind: 'node'; pubkey: string }
  | { kind: 'onchain' }
  | { kind: 'unknown' };

/** Which way a pasted recipient pays. Only the host's decode is trusted for an invoice. */
export function readRecipient(input: string): Recipient {
  const v = input.trim();
  if (!v) return { kind: 'unknown' };
  if (/^(lightning:)?ln[a-z0-9]+$/i.test(v)) return { kind: 'invoice', text: v };
  if (/^0[23][0-9a-f]{64}$/i.test(v)) return { kind: 'node', pubkey: v.toLowerCase() };
  if (/^(bitcoin:)?(bc1|tb1|bcrt1|[13mn2])[a-z0-9]{20,90}(\?.*)?$/i.test(v)) return { kind: 'onchain' };
  return { kind: 'unknown' };
}

// ---- activity ----------------------------------------------------------------

export type ActivityKind = 'message' | 'call' | 'file' | 'payment' | 'invoice';
export type Activity = {
  id: string;
  at: number;
  kind: ActivityKind;
  direction: 'in' | 'out';
  /** As the node or host reported it; `null` when not known yet. */
  msat: number | null;
  /** A contact node id or room id, when there is one. */
  who: string | null;
  label: string;
  /** Payments and invoices: settled, waiting, failed… */
  status?: string;
};

export type KindFilter = 'all' | 'messages' | 'calls' | 'payments';
export type DirectionFilter = 'all' | 'in' | 'out';

const CALL_LABEL: Record<number, string> = {
  get [CALL_OFFER]() { return t('uiCall'); },
  get [CALL_ANSWER]() { return t('extraAnsweredACall'); },
  get [CALL_ICE]() { return t('extraCallSetup'); },
  get [CALL_HANGUP]() { return t('callEnded'); },
};

/** Paid messages, calls and files, from the node's history with one contact or room. */
export function messageActivity(messages: Message[], own: string): Activity[] {
  const me = own.toLowerCase();
  return messages
    .filter((m) => (m.payment_amount_msat ?? 0) > 0)
    .map((m): Activity => {
      const out = m.sender.toLowerCase() === me;
      const kind: ActivityKind = isCallTrafficKind(m.kind) ? 'call' : m.kind === 200 ? 'file' : 'message';
      return {
        id: `m:${m.id}`,
        at: m.timestamp,
        kind,
        direction: out ? 'out' : 'in',
        msat: m.payment_amount_msat,
        who: (out ? m.recipient : m.sender).toLowerCase(),
        label: kind === 'call' ? CALL_LABEL[m.kind] ?? t('uiCall') : kind === 'file' ? (out ? t('extraSentAFile') : t('extraReceivedAFile')) : out ? t('extraMessageSent') : t('extraMessageReceived'),
      };
    });
}

/** Everything, newest first, each item once. */
export function mergeActivity(...lists: Activity[][]): Activity[] {
  const byId = new Map<string, Activity>();
  for (const list of lists) for (const a of list) byId.set(a.id, a);
  return [...byId.values()].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}

export function filterActivity(items: Activity[], kind: KindFilter, direction: DirectionFilter): Activity[] {
  return items.filter((a) =>
    (kind === 'all'
      || (kind === 'messages' && (a.kind === 'message' || a.kind === 'file'))
      || (kind === 'calls' && a.kind === 'call')
      || (kind === 'payments' && (a.kind === 'payment' || a.kind === 'invoice')))
    && (direction === 'all' || a.direction === direction));
}

/** Money that moved in the listed items. An invoice counts once it is paid. */
export function activityTotals(items: Activity[]): { in: number; out: number } {
  let inMsat = 0;
  let outMsat = 0;
  for (const a of items) {
    if (a.msat === null || (a.kind === 'invoice' && a.status !== 'paid')) continue;
    if (a.direction === 'in') inMsat += a.msat;
    else outMsat += a.msat;
  }
  return { in: inMsat, out: outMsat };
}

// ---- payments and invoices made on this device ------------------------------
//
// The node lists messages but not its Lightning payments, so the app keeps a
// small local log of the ones made here: amounts and status only (an invoice we
// issued keeps its text, so its status can be read). It never gates a payment.

export type LoggedActivity = Activity & {
  /** Invoices we issued: the invoice itself, to read whether it was paid. */
  bolt11?: string;
  expiresAt?: number;
};

const LOG_KEY = 'bitsov.wallet.activity.v1';
const LOG_MAX = 300;

function loadLog(): LoggedActivity[] {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(LOG_KEY) ?? '[]') as unknown;
    return Array.isArray(raw)
      ? raw.filter((a): a is LoggedActivity => !!a && typeof a === 'object' && typeof (a as Activity).id === 'string' && typeof (a as Activity).at === 'number')
      : [];
  } catch {
    return [];
  }
}

const log = createRoot(() => {
  const [items, setItems] = createSignal<LoggedActivity[]>(loadLog());
  return { items, setItems };
});

function saveLog(next: LoggedActivity[]) {
  const kept = [...next].sort((a, b) => b.at - a.at).slice(0, LOG_MAX);
  log.setItems(kept);
  try {
    globalThis.localStorage?.setItem(LOG_KEY, JSON.stringify(kept));
  } catch {
    /* private mode: kept for this session */
  }
}

export const loggedActivity = (): LoggedActivity[] => log.items();

/** A payment or invoice card, as one log entry. `who`: the contact it was made with. */
export function artifactActivity(a: Artifact, who: string | null): LoggedActivity | null {
  if (a.type === 'payment') {
    const r = a.receipt;
    return {
      id: `p:${r.method}:${r.paid_at_ms}:${r.amount_msat}`,
      at: r.paid_at_ms || a.at,
      kind: 'payment',
      direction: 'out',
      msat: r.amount_msat,
      who,
      label: r.method === 'invoice' ? 'Paid an invoice' : 'Paid a node directly',
      status: r.status,
    };
  }
  if (a.type === 'invoice') {
    const inv = a.invoice;
    return {
      id: `i:${inv.bolt11.slice(0, 120)}`,
      at: a.at,
      kind: 'invoice',
      direction: 'in',
      msat: inv.amount_msat,
      who,
      label: inv.note ? `Invoice · ${inv.note}` : 'Invoice',
      status: 'waiting',
      bolt11: inv.bolt11,
      expiresAt: inv.expires_at_ms,
    };
  }
  return null;
}

/** Add entries not logged yet. An entry already logged keeps its status. */
export function logActivity(entries: LoggedActivity[]) {
  const known = new Set(log.items().map((a) => a.id));
  const fresh = entries.filter((a) => !known.has(a.id));
  if (fresh.length) saveLog([...log.items(), ...fresh]);
}

/** What the node now says about an invoice we issued. */
export function updateInvoice(id: string, status: InvoiceStatus) {
  const items = log.items();
  const i = items.findIndex((a) => a.id === id);
  if (i < 0 || status.state === 'unknown' || items[i].status === status.state) return;
  const next = [...items];
  next[i] = { ...items[i], status: status.state, msat: status.state === 'paid' ? status.amount_msat : status.amount_msat ?? items[i].msat };
  saveLog(next);
}

/** Invoices whose outcome is still open: worth reading again. */
export const openInvoices = (items: LoggedActivity[], now: number): LoggedActivity[] =>
  items.filter((a) => a.kind === 'invoice' && a.bolt11 && a.status === 'waiting' && (a.expiresAt ?? 0) > now - 60_000);

/** Tests only. */
export function resetActivityLog() {
  saveLog([]);
}

/** Translate legacy persisted labels at display time; never translate invoice notes. */
export function activityLabel(a: Activity): string {
  if (a.kind === 'payment') {
    if (a.label === 'Paid an invoice') return t('walletPaidInvoice');
    if (a.label === 'Paid a node directly') return t('walletPaidDirect');
  }
  if (a.kind === 'invoice') {
    if (a.label === 'Invoice') return t('uiInvoice');
    if (a.label.startsWith('Invoice · ')) return t('walletInvoiceNote', a.label.slice('Invoice · '.length));
  }
  return a.label;
}

/** Plain words for a payment or invoice status. */
export function statusWords(a: Activity, now: number): string | null {
  if (a.kind === 'invoice') {
    if (a.status === 'paid') return t('extraReceived');
    if (a.status === 'failed') return t('extraNotPaid');
    const expires = (a as LoggedActivity).expiresAt;
    return expires && expires < now ? t('extraExpired') : t('extraWaitingToBePaid');
  }
  if (a.kind === 'payment') {
    return a.status === 'settled' ? t('extraPaid') : a.status === 'failed' ? t('extraFailed') : t('extraInProgress');
  }
  return null;
}
