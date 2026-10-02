import { SoftError } from './SoftError';
import { DelayedSpinner } from './DelayedSpinner';
/**
 * The Wallet page: full screen from the avatar menu. Node-reported balance and
 * spendability, Receive, Send, Channels and Activity.
 *
 * Money: this page adds no way to pay. Send calls the composer's own `pay`
 * and `keysend` actions (the host's invoice decode, spend window, budget book
 * and all-in ceiling), behind the same one-confirm review: frozen when shown,
 * consumed at dispatch, withdrawn by any edit. Receiving pays nothing.
 */
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch, type JSX } from 'solid-js';
import { qrSvg } from '../qr';
import { copyPlainText } from '../assistant/copy';
import { amount as fmtAmount, allIn, clock, day, routingFee, sats, satUnit, shortId } from './format';
import { amountText, inPaymentBounds, MAX_PAYMENT_MSAT, MIN_PAYMENT_MSAT, parseAmount } from './amountInput';
import { denom } from './prefs';
import type { FundingAddress, InvoiceAmount, InvoiceStatus, InvoiceView, Message, SpendView, WalletOverview } from './types';
import { spendLine } from './state';
import {
  activityTotals, bitcoinUri, channelWords, filterActivity, loggedActivity, mergeActivity, messageActivity, openInvoices, readRecipient,
  sortedChannels, splitBalance, statusWords, updateInvoice,
  type Activity, type DirectionFilter, type KindFilter,
} from './wallet';

type Outcome<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

export type WalletTab = 'activity' | 'channels' | 'receive' | 'send';

/** The composer's own money actions, bound to the Wallet's receipts. */
export type WalletActions = {
  readInvoice: (bolt11: string) => Promise<Outcome<InvoiceAmount>>;
  pay: (bolt11: string, msat: number) => Promise<Outcome<unknown>>;
  keysend: (pubkey: string, msat: number, memo: string) => Promise<Outcome<unknown>>;
  invoice: (msat: number, note: string) => Promise<Outcome<unknown>>;
  /** The one tap that asks the node to open the ten-minute window. Pays nothing. */
  approve: () => Promise<void>;
};

/** Reads only. */
export type WalletReads = {
  fundingAddress: () => Promise<FundingAddress>;
  invoiceStatus: (bolt11: string) => Promise<InvoiceStatus>;
  messages: (id: string) => Promise<Message[]>;
};

const unitName = () => (denom() === 'btc' ? 'BTC' : 'sats');
const QR = (props: { value: string; label: string }) => {
  const qr = createMemo(() => {
    try {
      return qrSvg(props.value);
    } catch {
      return null;
    }
  });
  return (
    <Show when={qr()}>
      {(q) => (
        <svg class="qr wallet-qr" viewBox={`0 0 ${q().extent} ${q().extent}`} shape-rendering="crispEdges" role="img" aria-label={props.label} data-wallet-qr>
          <rect width={q().extent} height={q().extent} fill="#ffffff" />
          <path d={q().path} fill="#000000" />
        </svg>
      )}
    </Show>
  );
};

function CopyButton(props: { text: string; label: string }) {
  const [done, setDone] = createSignal(false);
  let timer: number | undefined;
  onCleanup(() => window.clearTimeout(timer));
  return (
    <button
      type="button"
      class="soft wallet-copy"
      data-wallet-copy
      onClick={() => void copyPlainText(props.text).then(() => {
        setDone(true);
        window.clearTimeout(timer);
        timer = window.setTimeout(() => setDone(false), 1500);
      })}
    >
      {done() ? 'Copied' : props.label}
    </button>
  );
}

function AmountInput(props: { data: string; label: string; value: string; onInput: (v: string) => void; optional?: boolean }) {
  const problem = (): string | null => {
    if (props.value.trim() === '') return null;
    const msat = parseAmount(props.value, denom());
    if (msat === null) return `Use digits and one dot, at most ${denom() === 'btc' ? 11 : 3} decimals.`;
    return inPaymentBounds(msat) ? null : `Between ${fmtAmount(MIN_PAYMENT_MSAT)} and ${fmtAmount(MAX_PAYMENT_MSAT)}.`;
  };
  return (
    <>
      <label class="amount-field wallet-amount" classList={{ invalid: problem() !== null }}>
        <input
          {...{ [props.data]: '' }}
          class="amount-input"
          inputmode="decimal"
          autocomplete="off"
          placeholder="0"
          value={props.value}
          onInput={(e) => props.onInput(e.currentTarget.value)}
          aria-label={`${props.label} in ${unitName()}${props.optional ? ' (optional)' : ''}`}
          aria-invalid={problem() !== null}
        />
        <span class="amount-unit">{unitName()}</span>
      </label>
      <Show when={problem()}>{(p) => <p class="hint" data-amount-invalid>{p()}</p>}</Show>
    </>
  );
}

const typedMsat = (text: string): number | null => {
  const msat = parseAmount(text, denom());
  return msat !== null && inPaymentBounds(msat) ? msat : null;
};

export function WalletPage(props: {
  tab: WalletTab;
  onTab: (t: WalletTab) => void;
  onClose: () => void;
  wallet: WalletOverview | null;
  walletError?: string;
  moneyBlocked: boolean;
  spend: SpendView | null;
  /** The one tap that opens the ten-minute window (the composer's SpendBar). */
  spendGate: JSX.Element;
  now: number;
  ownId: string;
  /** Contacts and rooms whose node history the activity reads. */
  histories: string[];
  /** Messages already loaded in threads (live ones included). */
  threadMessages: Message[];
  nameOf: (id: string) => string;
  actions: WalletActions;
  reads: WalletReads;
  onRefresh: () => void;
}) {
  const split = () => (props.wallet ? splitBalance(props.wallet) : null);

  // Invoices we issued: read whether they were paid while this page is open.
  let reading = false;
  const readInvoices = async () => {
    if (reading) return;
    reading = true;
    try {
      for (const a of openInvoices(loggedActivity(), Date.now()).slice(0, 10)) {
        const status = await props.reads.invoiceStatus(a.bolt11!).catch(() => null);
        if (status) updateInvoice(a.id, status);
      }
    } finally {
      reading = false;
    }
  };
  createEffect(() => {
    void readInvoices();
    const timer = window.setInterval(() => void readInvoices(), 4000);
    onCleanup(() => window.clearInterval(timer));
  });

  const tabs: { id: WalletTab; label: string }[] = [
    { id: 'activity', label: 'Activity' },
    { id: 'channels', label: 'Channels' },
    { id: 'receive', label: 'Receive' },
    { id: 'send', label: 'Send' },
  ];

  return (
    <div class="wallet-page" role="dialog" aria-modal="true" aria-label="Wallet" data-wallet-page={props.tab}>
      <header class="wallet-top">
        <button type="button" class="link" data-wallet-close ref={(el) => queueMicrotask(() => el.isConnected && el.focus())} onClick={() => props.onClose()} aria-label="Close wallet">← Back</button>
        <h1>Wallet</h1>
        <button type="button" class="link" data-wallet-refresh onClick={() => props.onRefresh()}>Refresh</button>
      </header>

      <div class="wallet-body">
        <section class="wallet-hero" data-wallet-balance>
          <span class="label">Node-reported total</span>
          <Show when={split()} fallback={<Show when={!props.walletError} fallback={<SoftError message={props.walletError!} data="wallet-read" onReconnect={props.onRefresh} />}><DelayedSpinner /></Show>}>
            {(s) => (
              <>
                <span class="wallet-total" data-balance-total={s().total}>
                  {sats(s().total)}<span class="unit">{satUnit(s().total)}</span>
                </span>
                <div class="wallet-split">
                  <div class="split" data-balance-spendable={s().spendable ?? 'unknown'}>
                    <span class="split-name">Spendable</span>
                    <span class="split-amount">{s().spendable === null ? 'Unknown' : fmtAmount(s().spendable!)}</span>
                    <span class="hint">Funds available to spend, excluding reserves and locked funds.</span>
                  </div>
                  <div class="split" data-balance-reserved={s().reserved ?? 'unknown'}>
                    <span class="split-name">Reserved (channel fee reserve)</span>
                    <span class="split-amount">{s().reserved === null ? 'Unknown' : fmtAmount(s().reserved!)}</span>
                    <span class="hint">Held back for channel closing fees; unavailable to spend.</span>
                  </div>
                  <div class="split" data-balance-closing={s().closing ?? 'unknown'}>
                    <span class="split-name">Closing/locked</span>
                    <span class="split-amount">{s().closing === null ? 'Unknown' : fmtAmount(s().closing!)}</span>
                    <span class="hint">Waiting for a channel closure or time lock; unavailable to spend.</span>
                  </div>
                </div>
                <p class="hint wallet-basis" data-wallet-basis>
                  Your node reports one total, but does not report these amounts separately. The total is not a spendable balance.
                </p>
              </>
            )}
          </Show>
          <p class="hint wallet-basis" data-wallet-online>
            Your home node must stay online to monitor and protect your Lightning channels; there is no watchtower yet.
          </p>
          <div class="wallet-actions">
            <button type="button" class="primary soft" data-wallet-go="receive" onClick={() => props.onTab('receive')}>Receive</button>
            <button type="button" class="primary soft" data-wallet-go="send" onClick={() => props.onTab('send')}>Send</button>
          </div>
        </section>

        <div class="modes soft wallet-tabs" role="tablist" aria-label="Wallet">
          <For each={tabs}>
            {(t) => (
              <button type="button" role="tab" aria-selected={props.tab === t.id} data-wallet-tab={t.id} onClick={() => props.onTab(t.id)}>{t.label}</button>
            )}
          </For>
        </div>

        <Switch>
          <Match when={props.tab === 'activity'}>
            <ActivityView
              ownId={props.ownId}
              histories={props.histories}
              threadMessages={props.threadMessages}
              nameOf={props.nameOf}
              messages={props.reads.messages}
              now={props.now}
            />
          </Match>
          <Match when={props.tab === 'channels'}>
            <ChannelsView wallet={props.wallet} nameOf={props.nameOf} />
          </Match>
          <Match when={props.tab === 'receive'}>
            <ReceiveView moneyBlocked={props.moneyBlocked} actions={props.actions} reads={props.reads} now={props.now} />
          </Match>
          <Match when={props.tab === 'send'}>
            <SendView moneyBlocked={props.moneyBlocked} spend={props.spend} spendGate={props.spendGate} now={props.now} actions={props.actions} />
          </Match>
        </Switch>
      </div>
    </div>
  );
}

// ---- activity ----------------------------------------------------------------

const KIND_FILTERS: { id: KindFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'messages', label: 'Messages' },
  { id: 'calls', label: 'Calls' },
  { id: 'payments', label: 'Payments' },
];
const DIRECTION_FILTERS: { id: DirectionFilter; label: string }[] = [
  { id: 'all', label: 'In and out' },
  { id: 'in', label: 'Received' },
  { id: 'out', label: 'Sent' },
];
const ICON: Record<Activity['kind'], string> = { message: '✉', call: '☎', file: '▤', payment: '⚡', invoice: '⚡' };

function ActivityView(props: {
  ownId: string;
  histories: string[];
  threadMessages: Message[];
  nameOf: (id: string) => string;
  messages: (id: string) => Promise<Message[]>;
  now: number;
}) {
  const [kind, setKind] = createSignal<KindFilter>('all');
  const [direction, setDirection] = createSignal<DirectionFilter>('all');
  const [read, setRead] = createSignal<Message[]>([]);
  const [loading, setLoading] = createSignal(true);
  // The latest page of each contact's and room's history, read once per open.
  createEffect(on(() => props.histories.join(), () => {
    setLoading(true);
    void Promise.all(props.histories.map((id) => props.messages(id).catch(() => [] as Message[]))).then((pages) => {
      setRead(pages.flat());
      setLoading(false);
    });
  }));
  const all = createMemo(() => mergeActivity(
    messageActivity([...read(), ...props.threadMessages], props.ownId),
    loggedActivity(),
  ));
  const shown = createMemo(() => filterActivity(all(), kind(), direction()));
  const totals = () => activityTotals(shown());

  return (
    <section class="wallet-panel" data-wallet-activity>
      <div class="wallet-filters">
        <div class="modes soft small" role="radiogroup" aria-label="What">
          <For each={KIND_FILTERS}>
            {(f) => <button type="button" role="radio" aria-checked={kind() === f.id} data-activity-filter={f.id} onClick={() => setKind(f.id)}>{f.label}</button>}
          </For>
        </div>
        <div class="modes soft small" role="radiogroup" aria-label="Direction">
          <For each={DIRECTION_FILTERS}>
            {(f) => <button type="button" role="radio" aria-checked={direction() === f.id} data-activity-direction={f.id} onClick={() => setDirection(f.id)}>{f.label}</button>}
          </For>
        </div>
      </div>
      <p class="wallet-totals" data-activity-totals>
        <span>Received <strong data-activity-in={totals().in}>{fmtAmount(totals().in)}</strong></span>
        <span>Sent <strong data-activity-out={totals().out}>{fmtAmount(totals().out)}</strong></span>
      </p>
      <Show when={!loading() || shown().length > 0} fallback={<DelayedSpinner />}>
        <ul class="wallet-list" data-activity-list>
          <For each={shown()} fallback={<li class="empty hint" data-activity-empty>Nothing here yet.</li>}>
            {(a, i) => {
              const newDay = () => i() === 0 || day(shown()[i() - 1].at) !== day(a.at);
              const status = () => statusWords(a, props.now);
              return (
                <>
                  <Show when={newDay()}><li class="wallet-day">{day(a.at)}</li></Show>
                  <li class="wallet-row" data-activity={a.kind} data-activity-dir={a.direction} data-activity-id={a.id}>
                    <span class={`wallet-icon ${a.kind}`} aria-hidden="true">{ICON[a.kind]}</span>
                    <span class="wallet-row-main">
                      <span class="wallet-row-title">{a.label}</span>
                      <span class="hint">
                        {a.who ? `${props.nameOf(a.who)} · ` : ''}{clock(a.at)}{status() ? ` · ${status()}` : ''}
                      </span>
                    </span>
                    <span class="wallet-row-amount" classList={{ in: a.direction === 'in', pending: a.kind === 'invoice' && a.status !== 'paid' }}>
                      {a.msat === null ? '' : `${a.direction === 'in' ? '+' : '−'}${fmtAmount(a.msat)}`}
                    </span>
                  </li>
                </>
              );
            }}
          </For>
        </ul>
      </Show>
      <p class="hint" data-activity-scope>
        Messages and calls are the latest your node keeps with each contact. Lightning payments and invoices are the ones made in this app on this Mac; your node does not list the others yet, and on-chain deposits are not listed here.
      </p>
    </section>
  );
}

// ---- channels ----------------------------------------------------------------

function ChannelsView(props: { wallet: WalletOverview | null; nameOf: (id: string) => string }) {
  const channels = () => sortedChannels(props.wallet?.channels ?? []);
  const open = () => channels().filter((c) => c.active);
  const canSend = () => open().reduce((s, c) => s + c.local_balance_msat, 0);
  const canReceive = () => open().reduce((s, c) => s + c.remote_balance_msat, 0);
  return (
    <section class="wallet-panel" data-wallet-channels>
      <Show when={props.wallet} fallback={<DelayedSpinner />}>
        <p class="wallet-totals" data-channels-summary>
          <span>{open().length} of {channels().length} open</span>
          <span>You can send <strong>{fmtAmount(canSend())}</strong></span>
          <span>and receive <strong>{fmtAmount(canReceive())}</strong></span>
        </p>
        <ul class="wallet-channels">
          <For each={channels()} fallback={<li class="empty hint">No channels yet. A channel is how your node sends and receives over Lightning.</li>}>
            {(c) => {
              const words = () => channelWords(c);
              const out = () => (c.capacity_msat > 0 ? (c.local_balance_msat / c.capacity_msat) * 100 : 0);
              const inn = () => (c.capacity_msat > 0 ? (c.remote_balance_msat / c.capacity_msat) * 100 : 0);
              return (
                <li class="wallet-channel" data-channel={c.channel_id} data-channel-state={words().state}>
                  <div class="row">
                    <strong class="channel-peer" title={c.peer_pubkey}>{props.nameOf(c.peer_pubkey) === 'You' ? shortId(c.peer_pubkey) : props.nameOf(c.peer_pubkey)}</strong>
                    <span class={`contact-pill ${words().state === 'open' ? 'ok' : 'warn'}`} data-channel-pill>{words().title}</span>
                  </div>
                  <div class="channel-bar" aria-hidden="true">
                    <div class="out" style={{ width: `${out()}%` }} />
                    <div class="in" style={{ width: `${inn()}%` }} />
                  </div>
                  <dl class="channel-facts">
                    <dt>You can send</dt><dd data-channel-out={c.local_balance_msat}>{fmtAmount(c.local_balance_msat)}</dd>
                    <dt>You can receive</dt><dd data-channel-in={c.remote_balance_msat}>{fmtAmount(c.remote_balance_msat)}</dd>
                    <dt>Size</dt><dd data-channel-capacity={c.capacity_msat}>{fmtAmount(c.capacity_msat)}</dd>
                  </dl>
                  <p class="hint" data-channel-words>{words().line}</p>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
      <p class="hint" data-budget-wallet-warning>
        Opening or closing a channel is an owner action at your node. It can commit funds and pay on-chain fees, outside this app’s daily limit.
      </p>
    </section>
  );
}

// ---- receive -----------------------------------------------------------------

function ReceiveView(props: { moneyBlocked: boolean; actions: WalletActions; reads: WalletReads; now: number }) {
  const [how, setHow] = createSignal<'lightning' | 'onchain'>('lightning');
  const [amount, setAmount] = createSignal('');
  const [note, setNote] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [invoice, setInvoice] = createSignal<InvoiceView | null>(null);
  const [address, setAddress] = createSignal<FundingAddress | null>(null);
  const [addressError, setAddressError] = createSignal<string | null>(null);
  const msat = () => typedMsat(amount());

  // A new amount or note is a new request: the shown invoice was for the old one.
  createEffect(on([amount, note, how], () => { setInvoice(null); setError(null); }, { defer: true }));
  createEffect(() => {
    if (how() !== 'onchain' || address() || props.moneyBlocked) return;
    void props.reads.fundingAddress().then(
      (a) => { setAddress(a); setAddressError(null); },
      (e) => setAddressError(typeof e === 'string' ? e : (e as { message?: string })?.message ?? String(e)),
    );
  });

  const create = async (e: Event) => {
    e.preventDefault();
    const m = msat();
    if (props.moneyBlocked || busy() || m === null) return;
    setBusy(true);
    setError(null);
    const r = await props.actions.invoice(m, note());
    setBusy(false);
    if (r.ok) setInvoice(r.value as InvoiceView);
    else setError(r.error.message);
  };
  const status = () => {
    const inv = invoice();
    if (!inv) return null;
    const logged = loggedActivity().find((a) => a.kind === 'invoice' && a.bolt11 === inv.bolt11);
    return logged ? statusWords(logged, props.now) : 'Waiting to be paid';
  };
  const uri = () => {
    const a = address();
    if (!a) return null;
    const typed = amount().trim() === '' ? null : msat();
    return typed === null && amount().trim() !== '' ? null : bitcoinUri(a.address, typed);
  };

  return (
    <section class="wallet-panel wallet-receive" data-wallet-receive={how()}>
      <div class="modes soft" role="tablist" aria-label="Receive how">
        <button type="button" role="tab" aria-selected={how() === 'lightning'} data-receive-how="lightning" onClick={() => setHow('lightning')}>Lightning</button>
        <button type="button" role="tab" aria-selected={how() === 'onchain'} data-receive-how="onchain" onClick={() => setHow('onchain')}>On-chain</button>
      </div>
      <AmountInput data="data-receive-amount" label="Amount to receive" value={amount()} onInput={setAmount} optional={how() === 'onchain'} />
      <Show
        when={how() === 'lightning'}
        fallback={
          <>
            <p class="hint" data-receive-note>Amount is optional. It goes into the QR code only; any amount sent to this address arrives.</p>
            <Show when={amount().trim() !== '' && msat() !== null && uri() === null}>
              <p class="hint" data-receive-whole>On-chain amounts are whole sats.</p>
            </Show>
            <Show
              when={address()}
              fallback={
                <Show when={!props.moneyBlocked} fallback={<p class="hint">Your node is not ready to give an address yet.</p>}>
                  <Show when={addressError()} fallback={<DelayedSpinner />}>
                    <div data-receive-error><SoftError message={addressError()!} summary="Your node has no address to show." /></div>
                  </Show>
                </Show>
              }
            >
              {(a) => (
                <div class="wallet-request" data-receive-address={a().address}>
                  <Show when={uri()}>{(u) => <QR value={u()} label="On-chain address as a QR code" />}</Show>
                  <code class="address">{a().address}</code>
                  <div class="row wallet-request-actions">
                    <CopyButton text={a().address} label="Copy address" />
                  </div>
                  <p class="hint">
                    Send only bitcoin{a().network ? ` on ${a().network}` : ''} to this address. It stays valid. Deposits appear after your node sees them on-chain, which can take a while.
                  </p>
                </div>
              )}
            </Show>
          </>
        }
      >
        <form class="wallet-form" onSubmit={create}>
          <input data-receive-memo placeholder="What for? (optional)" value={note()} onInput={(e) => setNote(e.currentTarget.value)} aria-label="What it is for" />
          <Show when={!invoice()}>
            <button type="submit" class="primary soft" data-receive-create disabled={props.moneyBlocked || busy() || msat() === null}>
              {busy() ? 'Creating…' : 'Create invoice'}
            </button>
            <p class="hint" data-receive-hint>Your node needs an amount for a Lightning invoice. Receiving is free.</p>
          </Show>
        </form>
        <Show when={invoice()}>
          {(inv) => (
            <div class="wallet-request" data-receive-invoice data-receive-status={status() ?? ''}>
              <QR value={inv().bolt11.toUpperCase()} label="Lightning invoice as a QR code" />
              <span class="wallet-request-amount">{fmtAmount(inv().amount_msat)}</span>
              <span class="wallet-status" classList={{ ok: status() === 'Received' }} data-receive-state>{status()}</span>
              <code class="address" data-bolt11>{inv().bolt11}</code>
              <div class="row wallet-request-actions">
                <CopyButton text={inv().bolt11} label="Copy invoice" />
                <button type="button" class="link" data-receive-new onClick={() => { setInvoice(null); setAmount(''); setNote(''); }}>New request</button>
              </div>
              <p class="hint">Expires at {clock(inv().expires_at_ms)}. Paying it sends sats to your node.</p>
            </div>
          )}
        </Show>
      </Show>
      <Show when={error()}>{(e) => <p class="err-note" data-receive-error>{e()}</p>}</Show>
    </section>
  );
}

// ---- send --------------------------------------------------------------------

type Review =
  | { kind: 'invoice'; bolt11: string; msat: number; payee: string }
  | { kind: 'keysend'; pubkey: string; msat: number; memo: string };

function SendView(props: { moneyBlocked: boolean; spend: SpendView | null; spendGate: JSX.Element; now: number; actions: WalletActions }) {
  const [amount, setAmount] = createSignal('');
  const [to, setTo] = createSignal('');
  const [memo, setMemo] = createSignal('');
  const [read, setRead] = createSignal<InvoiceAmount | null>(null);
  const [readError, setReadError] = createSignal<string | null>(null);
  const [review, setReview] = createSignal<Review | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [result, setResult] = createSignal<{ ok: boolean; text: string } | null>(null);
  const line = () => spendLine(props.spend, props.now);
  const recipient = () => readRecipient(to());
  const msat = () => typedMsat(amount());

  // The host's decode of a pasted invoice: its amount and payee are the only ones shown.
  createEffect(on(to, (text) => {
    setRead(null);
    setReadError(null);
    const r = readRecipient(text);
    if (r.kind !== 'invoice') return;
    void props.actions.readInvoice(r.text).then((out) => {
      if (to() !== text) return;
      if (!out.ok) { setReadError(out.error.message); return; }
      setRead(out.value);
      // Amount first: an empty amount takes the invoice's; a typed one must match it.
      if (amount().trim() === '') setAmount(amountText(out.value.amount_msat, denom()));
    });
  }));
  // Any edit, or spending closing, withdraws the review. Nothing is paid until its own button.
  createEffect(on([amount, to, memo], () => { setReview(null); setResult(null); }, { defer: true }));
  createEffect(() => { if (props.moneyBlocked || !line().open) setReview(null); });

  const mismatch = () => {
    const r = read();
    const m = msat();
    return r && m !== null && r.amount_msat !== m ? r.amount_msat : null;
  };
  const planned = (): Review | null => {
    const m = msat();
    const r = recipient();
    if (m === null) return null;
    if (r.kind === 'invoice') {
      const inv = read();
      return inv && inv.amount_msat === m ? { kind: 'invoice', bolt11: inv.bolt11, msat: inv.amount_msat, payee: inv.payee } : null;
    }
    if (r.kind === 'node') return { kind: 'keysend', pubkey: r.pubkey, msat: m, memo: memo() };
    return null;
  };
  const ready = () => !props.moneyBlocked && line().open && !busy() && planned() !== null;
  // Closed window: the same button is the one tap that asks for it; the review comes after.
  const needsApproval = () => !props.moneyBlocked && !line().open;
  const approvable = () => needsApproval() && !busy() && planned() !== null && props.spend?.state !== 'pending' && props.spend?.state !== 'unavailable';
  const buttonLabel = () => {
    if (!needsApproval()) return 'Review';
    if (props.spend?.state === 'pending') return 'Waiting for approval';
    if (props.spend?.state === 'unavailable') return 'Spending unavailable';
    return 'Approve spending';
  };

  const openReview = async (e: Event) => {
    e.preventDefault();
    if (approvable()) {
      setBusy(true);
      await props.actions.approve();
      setBusy(false);
      return;
    }
    if (!ready()) return;
    setReview(planned());
  };
  const confirm = async () => {
    const rv = review();
    if (!rv || props.moneyBlocked || busy() || !line().open) return;
    // Consumed at dispatch: one review pays at most once.
    setReview(null);
    setBusy(true);
    const r = await (rv.kind === 'invoice' ? props.actions.pay(rv.bolt11, rv.msat) : props.actions.keysend(rv.pubkey, rv.msat, rv.memo));
    setBusy(false);
    if (r.ok) {
      setTo('');
      setMemo('');
      setAmount('');
      // After the edits above, which clear any earlier result.
      setResult({ ok: true, text: `Paid ${fmtAmount(rv.msat)}. The network fee was at most ${fmtAmount(routingFee(rv.msat))}.` });
    } else {
      setResult({ ok: false, text: r.error.message });
    }
  };

  const hint = (): string | null => {
    const r = recipient();
    if (r.kind === 'onchain') return 'Sending on-chain is an owner action at your node. This app sends over Lightning only.';
    if (r.kind === 'unknown' && to().trim()) return 'That is not a Lightning invoice or a node ID.';
    if (r.kind === 'invoice' && !read() && !readError()) return 'Reading the invoice…';
    return null;
  };

  return (
    <section class="wallet-panel wallet-send" data-wallet-send>
      <Show
        when={review()}
        fallback={
          <form class="wallet-form" onSubmit={(e) => void openReview(e)}>
            <AmountInput data="data-send-amount" label="Amount to send" value={amount()} onInput={setAmount} />
            <textarea data-send-to rows={2} placeholder="Paste a Lightning invoice or a node ID" value={to()} onInput={(e) => setTo(e.currentTarget.value)} aria-label="Send to" />
            <Show when={recipient().kind === 'node'}>
              <input data-send-memo placeholder="Note (optional)" value={memo()} onInput={(e) => setMemo(e.currentTarget.value)} aria-label="Note" />
            </Show>
            <Show when={hint()}>{(h) => <p class="hint" data-send-hint>{h()}</p>}</Show>
            <Show when={readError()}>{(e) => <p class="err-note" data-send-error>{e()}</p>}</Show>
            <Show when={read()}>
              {(inv) => (
                <p class="hint" data-send-invoice={inv().amount_msat}>
                  Invoice for {fmtAmount(inv().amount_msat)} to node {shortId(inv().payee)}
                  {inv().description ? ` · “${inv().description}”` : ''}
                </p>
              )}
            </Show>
            <Show when={mismatch()}>
              {(m) => (
                <p class="err-note" data-send-mismatch>
                  This invoice asks for {fmtAmount(m())}, not the amount above.{' '}
                  <button type="button" class="link" data-send-use-invoice onClick={() => setAmount(amountText(m(), denom()))}>Use {fmtAmount(m())}</button>
                </p>
              )}
            </Show>
            <div class="composer-bar">
              <div class="cost" data-cost>
                <span class="label">Total at most</span>
                <Show when={msat() !== null} fallback={<span class="sats">…</span>}>
                  <span class="sats" data-cost-msat={allIn(msat()!)}>{sats(allIn(msat()!))}<span class="unit">{satUnit(allIn(msat()!))}</span></span>
                </Show>
                <span class="basis">The amount and a network fee of at most {fmtAmount(routingFee(msat() ?? 0))}</span>
              </div>
              <button type="submit" class="primary soft" data-send-review disabled={!ready() && !approvable()}>{buttonLabel()}</button>
            </div>
            <Show when={props.moneyBlocked}><p class="hint" data-send-blocked>Payments are not ready yet.</p></Show>
            <Show when={!props.moneyBlocked && !line().open}>
              <p class="hint" data-send-window>Payments need your ten-minute approval at your node first. Approving pays nothing.</p>
              {props.spendGate}
            </Show>
          </form>
        }
      >
        {(rv) => (
          <div class="pay-review" data-wallet-review data-review-msat={rv().msat} data-review-max-msat={allIn(rv().msat)}>
            <p class="pay-review-title">{rv().kind === 'invoice' ? 'Pay this Lightning invoice' : 'Pay a Lightning node directly'}</p>
            <p class="hint" data-review-payee>
              To node {shortId(rv().kind === 'invoice' ? (rv() as { payee: string }).payee : (rv() as { pubkey: string }).pubkey)}
            </p>
            <dl>
              <dt>Amount</dt>
              <dd data-review-amount>{fmtAmount(rv().msat)}</dd>
              <dt>Network fee</dt>
              <dd data-review-fee>up to {fmtAmount(routingFee(rv().msat))}</dd>
              <dt>Total at most</dt>
              <dd data-review-total>{fmtAmount(allIn(rv().msat))}</dd>
              <Show when={rv().kind === 'keysend' && (rv() as { memo: string }).memo.trim()}>
                <dt>Note</dt>
                <dd>{(rv() as { memo: string }).memo.trim()}</dd>
              </Show>
            </dl>
            <div class="composer-bar">
              <button type="button" class="link" data-review-back disabled={busy()} onClick={() => setReview(null)}>Back</button>
              <span class="basis">You pay the real fee, never above this.</span>
              <button type="button" class="primary soft" data-wallet-confirm disabled={busy() || props.moneyBlocked || !line().open} onClick={() => void confirm()}>
                Confirm and pay
              </button>
            </div>
          </div>
        )}
      </Show>
      <Show when={busy()}><p class="hint" data-send-paying>Paying…</p></Show>
      <Show when={result()}>
        {(r) => <p class={r().ok ? 'ok-note' : 'err-note'} data-send-result={r().ok ? 'ok' : 'failed'}>{r().text}</p>}
      </Show>
    </section>
  );
}
