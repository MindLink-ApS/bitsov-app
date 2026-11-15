import { t as tr } from '../i18n';
import { usePairingActivity } from '../pairingActivity';
import { createAmountDraft } from './amountDraft';
import { StarterBalance, type StarterBalanceProps } from './StarterBalance';
import { activityLabel } from './wallet';
import { t } from '../i18n';
import { SettledPayment } from './SettledPayment';
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
import { deviceWord } from '../platform';
import { amount as fmtAmount, allIn, clock, day, routingFee, sats, satUnit, shortId } from './format';
import { ambiguousThousands, amountText, inPaymentBounds, MAX_PAYMENT_MSAT, MIN_PAYMENT_MSAT, parseAmount } from './amountInput';
import { denom } from './prefs';
import type { CustodyMode, FundingAddress, InvoiceAmount, InvoiceStatus, InvoiceView, Message, PaymentReceipt, SpendView, WalletOverview } from './types';
import { CustodyBadgeView } from './custody';
import { spendLine } from './state';
import {
  activityTotals, bitcoinUri, channelWords, filterActivity, loggedActivity, mergeActivity, messageActivity, openInvoices, readRecipient,
  sortedChannels, splitBalance, statusWords, updateInvoice,
  type Activity, type DirectionFilter, type KindFilter, type LoggedActivity,
} from './wallet';

type Outcome<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

export type WalletTab = 'activity' | 'channels' | 'receive' | 'send';

/** The composer's own money actions, bound to the Wallet's receipts. */
export type WalletActions = {
  readInvoice: (bolt11: string) => Promise<Outcome<InvoiceAmount>>;
  pay: (bolt11: string, msat: number) => Promise<Outcome<PaymentReceipt>>;
  keysend: (pubkey: string, msat: number, memo: string) => Promise<Outcome<PaymentReceipt>>;
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
  // 'copied' only after the copy really worked; 'failed' says so instead.
  const [done, setDone] = createSignal<false | 'copied' | 'failed'>(false);
  let timer: number | undefined;
  onCleanup(() => window.clearTimeout(timer));
  return (
    <button
      type="button"
      class="soft wallet-copy"
      data-wallet-copy
      onClick={() => void copyPlainText(props.text).then(() => 'copied' as const, () => 'failed' as const).then((r) => {
        setDone(r);
        window.clearTimeout(timer);
        timer = window.setTimeout(() => setDone(false), r === 'failed' ? 4000 : 1500);
      })}
    >
      {done() === 'copied' ? t('extraCopied') : done() === 'failed' ? t('extraCopyFailedSelectItByHand') : props.label}
    </button>
  );
}

function AmountInput(props: { data: string; label: string; value: string; onInput: (v: string) => void; optional?: boolean; cleared?: boolean }) {
  const problem = (): string | null => {
    if (props.value.trim() === '') return null;
    if (ambiguousThousands(props.value, denom())) return t('amountUseSpaces');
    const msat = parseAmount(props.value, denom());
    if (msat === null) return t('uiUseDigitsAndOneDotAtMostDecimals', denom() === 'btc' ? 11 : 3);
    return inPaymentBounds(msat) ? null : t('uiBetweenAnd', fmtAmount(MIN_PAYMENT_MSAT), fmtAmount(MAX_PAYMENT_MSAT));
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
          aria-label={t('extraIn', props.label, unitName(), props.optional ? t('extraOptional') : '')}
          aria-invalid={problem() !== null}
        />
        <span class="amount-unit">{unitName()}</span>
      </label>
      <Show when={props.cleared}><p class="hint" role="status" data-amount-cleared>{t('amountDraftCleared')}</p></Show>
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
  /** Phone tab content, below the persistent status and above the tab bar. */
  embedded?: boolean;
  wallet: WalletOverview | null;
  walletError?: string;
  moneyBlocked: boolean;
  spend: SpendView | null;
  /** The one tap that opens the ten-minute window (the composer's SpendBar). */
  spendGate: JSX.Element;
  pendingResult?: JSX.Element;
  starter?: StarterBalanceProps;
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
  onReconnect?: () => void | Promise<void>;
  /** Where the seed lives, as the node reports it; absent when not reported. */
  custody?: CustodyMode | null;
}) {
  const split = () => (props.wallet ? splitBalance(props.wallet) : null);
  const [starterOpen, setStarterOpen] = createSignal(false);

  // Invoices we issued: read whether they were paid while this page is open.
  // Each invoice keeps its own last read: one that could not be read, or that the node
  // could not place, says so on that invoice only, never on another.
  let reading = false;
  const [invoiceChecks, setInvoiceChecks] = createSignal<Record<string, InvoiceCheck>>({});
  const readInvoices = async () => {
    if (reading) return;
    reading = true;
    try {
      const open = openInvoices(loggedActivity(), Date.now()).slice(0, 10);
      const checks: Record<string, InvoiceCheck> = {};
      for (const a of open) {
        const status = await props.reads.invoiceStatus(a.bolt11!).catch(() => null);
        if (!status) checks[a.bolt11!] = 'unread';
        else if (status.state === 'unknown') checks[a.bolt11!] = 'unknown';
        else updateInvoice(a.id, status);
      }
      setInvoiceChecks(checks);
    } finally {
      reading = false;
    }
  };
  const invoiceCheck = (bolt11: string | undefined): InvoiceCheck | undefined => (bolt11 ? invoiceChecks()[bolt11] : undefined);
  createEffect(() => {
    void readInvoices();
    const timer = window.setInterval(() => void readInvoices(), 4000);
    onCleanup(() => window.clearInterval(timer));
  });

  const tabs: { id: WalletTab; label: string }[] = [
    { id: 'activity', get label() { return t('uiActivity'); } },
    { id: 'channels', get label() { return t('uiChannels'); } },
    { id: 'receive', get label() { return t('uiReceive'); } },
    { id: 'send', get label() { return t('uiSend'); } },
  ];

  return (
    <div class="wallet-page" role={props.embedded && !starterOpen() ? "region" : "dialog"} aria-modal={props.embedded && !starterOpen() ? undefined : true} data-wallet-overlay={props.embedded && starterOpen() ? "true" : undefined} aria-label={t('uiWallet')} data-wallet-page={props.tab}>
      <header class="wallet-top">
        <button type="button" class="link" data-wallet-close data-ios-back={starterOpen() ? undefined : 'wallet'} ref={(el) => queueMicrotask(() => el.isConnected && el.focus())} onClick={() => starterOpen() ? setStarterOpen(false) : props.onClose()} aria-label={starterOpen() ? t('uiBack450') : `${t('uiBack450')}, ${t('uiCloseWallet')}`}>{t('uiBack450')}</button>
        <h1>{t(starterOpen() ? 'starterTitle' : 'uiWallet')}</h1>
        <Show when={!starterOpen()}><button type="button" class="link" data-wallet-refresh onClick={() => props.onRefresh()}>{t('uiRefresh')}</button></Show>
      </header>

      <div class="wallet-body">
        <Show when={props.embedded && !starterOpen()}><button class="soft" data-phone-add-sats onClick={() => props.onTab('receive')}>{t('phoneAddSats')}</button></Show>
        <Show when={props.starter}>
          <StarterBalance {...props.starter!} open={starterOpen()} onOpen={() => setStarterOpen(true)} onHidden={() => setStarterOpen(false)} />
        </Show>
        <Show when={!starterOpen()}>
        {props.pendingResult}
        <section class="wallet-hero" data-wallet-balance>
          <span class="label">{t('uiNodeReportedTotal')}</span>
          <Show when={split()} fallback={<Show when={!props.walletError} fallback={<SoftError message={props.walletError!} data="wallet-read" onReconnect={props.onReconnect ?? props.onRefresh} />}><DelayedSpinner /></Show>}>
            {(s) => (
              <>
                <span class="wallet-total" data-balance-total={s().total}
                  style={{ '--wallet-amount-chars': String(sats(s().total).length), '--wallet-unit-chars': String(satUnit(s().total).length) }}>
                  {sats(s().total)}<span class="unit">{satUnit(s().total)}</span>
                </span>
                <CustodyBadgeView mode={props.custody} />
                <span class="hint" data-balance-pending={s().pending ?? 'unknown'}>
                  {s().pending === null ? t('uiPendingOnChainUnknown') : t('uiPending', fmtAmount(s().pending!))}
                </span>
                <Show when={s().hasBreakdown} fallback={<>
                  <div class="wallet-split">
                    <div class="split" data-balance-spendable="unknown">
                      <span class="split-name">{t('uiSpendable')}</span>
                      <span class="split-amount unknown">{t('uiUnknown')}</span>
                      <span class="hint">{t('uiFundsAvailableToSpendExcludingReservesAndLocked')}</span>
                    </div>
                    <div class="split" data-balance-reserved="unknown">
                      <span class="split-name">{t('uiReservedChannelFeeReserve')}</span>
                      <span class="split-amount unknown">{t('uiUnknown')}</span>
                      <span class="hint">{t('uiHeldBackForChannelClosingFeesUnavailableTo')}</span>
                    </div>
                    <div class="split" data-balance-closing="unknown">
                      <span class="split-name">{t('uiClosingLocked')}</span>
                      <span class="split-amount unknown">{t('uiUnknown')}</span>
                      <span class="hint">{t('uiWaitingForAChannelClosureOrTimeLock')}</span>
                    </div>
                  </div>
                  <p class="hint wallet-basis" data-wallet-basis>
                    {t('uiYourNodeReportsOneTotalButDoesNot')}
                  </p>
                </>}>
                  <div class="wallet-split">
                    <div class="split" data-balance-lightning={s().lightning ?? 'unknown'}>
                      <span class="split-name">{t('uiLightningSpendableOutboundCapacity')}</span>
                      <span class="split-amount" classList={{ unknown: s().lightning === null }}>{s().lightning === null ? t('uiUnknown') : fmtAmount(s().lightning!)}</span>
                      <span class="hint">{t('uiOutboundCapacityNotAGuaranteeAPaymentOf')}</span>
                    </div>
                    <div class="split" data-balance-onchain-total={s().onchainTotal ?? 'unknown'}>
                      <span class="split-name">{t('uiOnChainTotal')}</span>
                      <span class="split-amount" classList={{ unknown: s().onchainTotal === null }}>{s().onchainTotal === null ? t('uiUnknown') : fmtAmount(s().onchainTotal!)}</span>
                      <span class="hint">{t('uiTotalOnChainWalletFundsIncludingUnconfirmedFunds')}</span>
                    </div>
                    <div class="split" data-balance-onchain={s().onchain ?? 'unknown'}>
                      <span class="split-name">{t('uiOnChainSpendable')}</span>
                      <span class="split-amount" classList={{ unknown: s().onchain === null }}>{s().onchain === null ? t('uiUnknown') : fmtAmount(s().onchain!)}</span>
                      <span class="hint">{t('uiSpendableAfterConfirmationRequirementsAndTheAnchorReserve')}</span>
                    </div>
                    <div class="split" data-balance-reserved={s().reserved ?? 'unknown'}>
                      <span class="split-name">{t('uiReservedAnchorClosingFees')}</span>
                      <span class="split-amount" classList={{ unknown: s().reserved === null }}>{s().reserved === null ? t('uiUnknown') : fmtAmount(s().reserved!)}</span>
                      <span class="hint">{t('uiOnChainFundsHeldForAnchorChannelClosing')}</span>
                    </div>
                    <div class="split" data-balance-closing={s().closing ?? 'unknown'}>
                      <span class="split-name">{t('uiClosingClosuresAndSweeps')}</span>
                      <span class="split-amount" classList={{ unknown: s().closing === null }}>{s().closing === null ? t('uiUnknown') : fmtAmount(s().closing!)}</span>
                      <span class="hint">{t('uiTrackedClosuresTimeLocksAndSweepsSomeProceeds')}</span>
                    </div>
                    <Show when={(s().contested ?? 0) > 0}>
                      <div class="split" data-balance-contested={s().contested}>
                        <span class="split-name">{t('uiContested')}</span>
                        <span class="split-amount">{fmtAmount(s().contested!)}</span>
                        <span class="hint">{t('uiConditionalClaimsNotGuaranteedWalletFundsOrSpendable')}</span>
                      </div>
                    </Show>
                  </div>
                  <p class="hint wallet-basis" data-wallet-basis>
                    {t('uiTheseCategoriesOverlapAndDoNotAddUp')}
                  </p>
                </Show>
              </>
            )}
          </Show>
          <p class="hint wallet-basis" data-wallet-online>
            {t('uiYourHomeNodeMustStayOnlineToMonitor')}
          </p>
          <div class="wallet-actions">
            <button type="button" class="primary soft money" data-wallet-go="receive" onClick={() => props.onTab('receive')}>{t('uiReceive')}</button>
            <button type="button" class="primary soft money" data-wallet-go="send" onClick={() => props.onTab('send')}>{t('uiSend')}</button>
          </div>
        </section>

        <div class="modes soft wallet-tabs" role="tablist" aria-label={t('uiWallet')}>
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
              invoiceCheck={invoiceCheck}
              onReceive={() => props.onTab('receive')}
            />
          </Match>
          <Match when={props.tab === 'channels'}>
            <ChannelsView wallet={props.wallet} nameOf={props.nameOf} />
          </Match>
          <Match when={props.tab === 'receive'}>
            <ReceiveView moneyBlocked={props.moneyBlocked} actions={props.actions} reads={props.reads} now={props.now} invoiceCheck={invoiceCheck} />
          </Match>
          <Match when={props.tab === 'send'}>
            <SendView moneyBlocked={props.moneyBlocked} spend={props.spend} spendGate={props.spendGate} now={props.now} actions={props.actions} />
          </Match>
        </Switch>
        </Show>
      </div>
    </div>
  );
}

// ---- activity ----------------------------------------------------------------

const KIND_FILTERS: { id: KindFilter; label: string }[] = [
  { id: 'all', get label() { return t('extraAll'); } },
  { id: 'messages', get label() { return t('extraMessages'); } },
  { id: 'calls', get label() { return t('extraCalls'); } },
  { id: 'payments', get label() { return t('extraPayments'); } },
];
const DIRECTION_FILTERS: { id: DirectionFilter; label: string }[] = [
  { id: 'all', get label() { return t('extraInAndOut'); } },
  { id: 'in', get label() { return t('extraReceived'); } },
  { id: 'out', get label() { return t('extraSent'); } },
];
const ICON: Record<Activity['kind'], string> = { message: '✉', call: '☎', file: '▤', payment: '⚡', invoice: '⚡' };

/** One sentence for "no channels", wherever it shows (Wallet → Channels, Settings → Wallet). */
export const NO_CHANNELS = () => tr('caNoChannelsYetAChannelIsHowYourNode');

function ActivityView(props: {
  /** The Wallet's Receive, offered when nothing has happened yet. */
  onReceive?: () => void;
  ownId: string;
  histories: string[];
  threadMessages: Message[];
  nameOf: (id: string) => string;
  messages: (id: string) => Promise<Message[]>;
  now: number;
  invoiceCheck?: (bolt11: string | undefined) => InvoiceCheck | undefined;
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
        <div class="modes soft small" role="radiogroup" aria-label={t('extraWhat')}>
          <For each={KIND_FILTERS}>
            {(f) => <button type="button" role="radio" aria-checked={kind() === f.id} data-activity-filter={f.id} onClick={() => setKind(f.id)}>{f.label}</button>}
          </For>
        </div>
        <div class="modes soft small" role="radiogroup" aria-label={t('extraDirection')}>
          <For each={DIRECTION_FILTERS}>
            {(f) => <button type="button" role="radio" aria-checked={direction() === f.id} data-activity-direction={f.id} onClick={() => setDirection(f.id)}>{f.label}</button>}
          </For>
        </div>
      </div>
      <p class="wallet-totals" data-activity-totals>
        <span>{t('extraReceived')} <strong data-activity-in={totals().in}>{fmtAmount(totals().in)}</strong></span>
        <span>{t('extraSent')} <strong data-activity-out={totals().out}>{fmtAmount(totals().out)}</strong></span>
      </p>
      <Show when={!loading() || shown().length > 0} fallback={<DelayedSpinner />}>
        <ul class="wallet-list" data-activity-list>
          <For each={shown()} fallback={
            kind() === 'all' && direction() === 'all'
              ? (
                <li class="empty hint" data-activity-empty="none">
                  {t('extraNoPaymentsYetPaymentsYouSendAndReceive')}
                  <Show when={props.onReceive}>
                    {' '}<button type="button" class="link" data-activity-receive onClick={() => props.onReceive!()}>{t('uiReceive')}</button>
                  </Show>
                </li>
              )
              : <li class="empty hint" data-activity-empty="filtered">{t('extraNothingMatchesThisFilter')}</li>
          }>
            {(a, i) => {
              const newDay = () => i() === 0 || day(shown()[i() - 1].at) !== day(a.at);
              const status = () => invoiceWords(a, props.now, props.invoiceCheck?.((a as LoggedActivity).bolt11));
              return (
                <>
                  <Show when={newDay()}><li class="wallet-day">{day(a.at)}</li></Show>
                  <li class="wallet-row" data-activity={a.kind} data-activity-dir={a.direction} data-activity-id={a.id}>
                    <span class={`wallet-icon ${a.kind}`} aria-hidden="true">{ICON[a.kind]}</span>
                    <span class="wallet-row-main">
                      <span class="wallet-row-title">{activityLabel(a)}</span>
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
        {t('extraMessagesAndCallsAreTheLatestYourNode')} {deviceWord() === 'computer' ? t('uiMac') : deviceWord() === 'phone' ? t('phone') : deviceWord()}{t('extraYourNodeDoesNotListTheOthersYet')}
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
          <span>{open().length}{' '}{tr('uiOf')}{' '}{channels().length}{' '}{tr('caOpen867')}</span>
          <span>{tr('caYouCanSend')}{' '}<strong>{fmtAmount(canSend())}</strong></span>
          <span>{tr('caAndReceive')}{' '}<strong>{fmtAmount(canReceive())}</strong></span>
        </p>
        <ul class="wallet-channels">
          <For each={channels()} fallback={<li class="empty hint" data-channels-empty>{NO_CHANNELS()}</li>}>
            {(c) => {
              const words = () => channelWords(c);
              const out = () => (c.capacity_msat > 0 ? (c.local_balance_msat / c.capacity_msat) * 100 : 0);
              const inn = () => (c.capacity_msat > 0 ? (c.remote_balance_msat / c.capacity_msat) * 100 : 0);
              return (
                <li class="wallet-channel" data-channel={c.channel_id} data-channel-state={words().state}>
                  <div class="row">
                    <strong class="channel-peer" title={c.peer_pubkey}>{props.nameOf(c.peer_pubkey) === tr('uiYou') ? shortId(c.peer_pubkey) : props.nameOf(c.peer_pubkey)}</strong>
                    <span class={`contact-pill ${words().state === 'open' ? 'ok' : 'warn'}`} data-channel-pill>{words().title}</span>
                  </div>
                  <div class="channel-bar" aria-hidden="true">
                    <div class="out" style={{ width: `${out()}%` }} />
                    <div class="in" style={{ width: `${inn()}%` }} />
                  </div>
                  <dl class="channel-facts">
                    <dt>{tr('caYouCanSend')}</dt><dd data-channel-out={c.local_balance_msat}>{fmtAmount(c.local_balance_msat)}</dd>
                    <dt>{tr('caYouCanReceive')}</dt><dd data-channel-in={c.remote_balance_msat}>{fmtAmount(c.remote_balance_msat)}</dd>
                    <dt>{tr('caSize')}</dt><dd data-channel-capacity={c.capacity_msat}>{fmtAmount(c.capacity_msat)}</dd>
                  </dl>
                  <p class="hint" data-channel-words>{words().line}</p>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
      <p class="hint" data-budget-wallet-warning>
        {tr('caOpeningOrClosingAChannelIsAnOwnerAction')}</p>
    </section>
  );
}

// ---- receive -----------------------------------------------------------------

/** An open invoice's last read: it could not be read, or the node could not say whether it was paid. */
type InvoiceCheck = 'unread' | 'unknown';

/** An invoice the node could not place is neither paid nor unpaid: it says it is unknown. */
function invoiceWords(a: Activity, now: number, check: InvoiceCheck | undefined): string | null {
  if (a.kind === 'invoice' && a.status === 'waiting' && check === 'unknown') return tr('caInvoiceStateUnknown');
  return statusWords(a, now);
}

function ReceiveView(props: { moneyBlocked: boolean; actions: WalletActions; reads: WalletReads; now: number; invoiceCheck?: (bolt11: string | undefined) => InvoiceCheck | undefined }) {
  const [how, setHow] = createSignal<'lightning' | 'onchain'>('lightning');
  const [amount, setAmount, amountCleared] = createAmountDraft();
  const [note, setNote] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  usePairingActivity(busy);
  const [error, setError] = createSignal<string | null>(null);
  const [invoice, setInvoice] = createSignal<InvoiceView | null>(null);
  const [address, setAddress] = createSignal<FundingAddress | null>(null);
  const [addressError, setAddressError] = createSignal<string | null>(null);
  const [addressRetry, setAddressRetry] = createSignal(0);
  const msat = () => typedMsat(amount());

  // A new amount or note is a new request: the shown invoice was for the old one.
  createEffect(on([amount, note, how], () => { setInvoice(null); setError(null); }, { defer: true }));
  createEffect(() => {
    addressRetry();
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
  const received = () => loggedActivity().find(a => a.kind === 'invoice' && a.bolt11 === invoice()?.bolt11);
  // This invoice's own last read: not read just now, or read but the node could not say.
  const check = () => (received()?.status === 'waiting' ? props.invoiceCheck?.(invoice()?.bolt11) : undefined);
  const status = () => {
    const inv = invoice();
    if (!inv) return null;
    const logged = received();
    if (check() === 'unknown') return tr('caInvoiceStateUnknown');
    return logged ? statusWords(logged, props.now) : t('extraWaitingToBePaid');
  };
  const uri = () => {
    const a = address();
    if (!a) return null;
    const typed = amount().trim() === '' ? null : msat();
    return typed === null && amount().trim() !== '' ? null : bitcoinUri(a.address, typed);
  };

  return (
    <section class="wallet-panel wallet-receive" data-wallet-receive={how()}>
      <div class="modes soft" role="tablist" aria-label={t('receiveHow')}>
        <button type="button" role="tab" aria-selected={how() === 'lightning'} data-receive-how="lightning" onClick={() => setHow('lightning')}>{t('receiveLightning')}</button>
        <button type="button" role="tab" aria-selected={how() === 'onchain'} data-receive-how="onchain" onClick={() => setHow('onchain')}>{t('receiveOnChain')}</button>
      </div>
      <AmountInput data="data-receive-amount" label={t('receiveAmount')} value={amount()} onInput={setAmount} cleared={amountCleared()} optional={how() === 'onchain'} />
      <Show
        when={how() === 'lightning'}
        fallback={
          <>
            <p class="hint" data-receive-note>{t('receiveOptional')}</p>
            <Show when={amount().trim() !== '' && msat() !== null && uri() === null}>
              <p class="hint" data-receive-whole>{t('receiveWhole')}</p>
            </Show>
            <Show
              when={address()}
              fallback={
                <Show when={!props.moneyBlocked} fallback={<p class="hint">{t('receiveNotReady')}</p>}>
                  <Show when={addressError()} fallback={<DelayedSpinner />}>
                    <div data-receive-error><SoftError message={addressError()!} summary={t('receiveNoAddress')} onReconnect={() => { setAddressError(null); setAddressRetry(n => n + 1); }} /></div>
                  </Show>
                </Show>
              }
            >
              {(a) => (
                <div class="wallet-request" data-receive-address={a().address}>
                  <Show when={uri()}>{(u) => <QR value={u()} label={t('receiveAddressQR')} />}</Show>
                  <code class="address">{a().address}</code>
                  <div class="row wallet-request-actions">
                    <CopyButton text={a().address} label={t('receiveCopyAddress')} />
                  </div>
                  <p class="hint">
                    {t('receiveBitcoinOnly', a().network ? t('receiveNetwork', a().network!) : '')}
                  </p>
                </div>
              )}
            </Show>
          </>
        }
      >
        <form class="wallet-form" onSubmit={create}>
          <input data-receive-memo placeholder={t('receiveWhatFor')} value={note()} onInput={(e) => setNote(e.currentTarget.value)} aria-label={t('uiWhatItIsFor')} />
          <Show when={!invoice()}>
            <button type="submit" class="primary soft money" data-receive-create disabled={props.moneyBlocked || busy() || msat() === null}>
              {busy() ? t('receiveCreating') : t('uiCreateInvoice')}
            </button>
            <p class="hint" data-receive-hint>{t('receiveHint')}</p>
          </Show>
        </form>
        <Show when={invoice()}>
          {(inv) => (
            <div class="wallet-request" data-receive-invoice data-receive-status={status() ?? ''}>
              <Show when={received()?.status === 'paid'} fallback={<>
                <QR value={inv().bolt11.toUpperCase()} label={t('receiveInvoiceQR')} />
                <span class="wallet-request-amount">{fmtAmount(inv().amount_msat)}</span>
              </>}>
                <SettledPayment direction="received" msat={received()?.msat ?? null} />
              </Show>
              <span class="wallet-status" classList={{ ok: received()?.status === 'paid' }} data-receive-state>{status()}</span>
              <Show when={check() === 'unread'}><p class="hint" role="status" data-receive-unread>{tr('caInvoiceNotChecked')}</p></Show>
              <Show when={check() === 'unknown'}><p class="hint" role="status" data-receive-unknown>{tr('caInvoiceUnknownHint')}</p></Show>
              <code class="address" data-bolt11>{inv().bolt11}</code>
              <div class="row wallet-request-actions">
                <CopyButton text={inv().bolt11} label={t('receiveCopyInvoice')} />
                <button type="button" class="link" data-receive-new onClick={() => { setInvoice(null); setAmount(''); setNote(''); }}>{t('receiveNew')}</button>
              </div>
              <p class="hint">{t('receiveExpires', clock(inv().expires_at_ms))}</p>
            </div>
          )}
        </Show>
      </Show>
      <Show when={error()}>{(e) => <p class="err-note" data-receive-error role="alert">{e()}</p>}</Show>
    </section>
  );
}

// ---- send --------------------------------------------------------------------

type Review =
  | { kind: 'invoice'; bolt11: string; msat: number; payee: string }
  | { kind: 'keysend'; pubkey: string; msat: number; memo: string };

function SendView(props: { moneyBlocked: boolean; spend: SpendView | null; spendGate: JSX.Element; now: number; actions: WalletActions }) {
  const [amount, setAmount, amountCleared] = createAmountDraft();
  const [to, setTo] = createSignal('');
  const [memo, setMemo] = createSignal('');
  const [read, setRead] = createSignal<InvoiceAmount | null>(null);
  const [readError, setReadError] = createSignal<string | null>(null);
  const [review, setReview] = createSignal<Review | null>(null);
  const [busy, setBusy] = createSignal(false);
  usePairingActivity(busy);
  const [result, setResult] = createSignal<{ ok: boolean; text: string; settledMsat?: number } | null>(null);
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
    if (!needsApproval()) return t('extraReview');
    if (props.spend?.state === 'pending') return t('uiWaitingForApproval');
    if (props.spend?.state === 'unavailable') return t('uiSpendingUnavailable');
    return t('uiApproveSpending');
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
      const receipt = r.value;
      if (receipt.status === 'settled') {
        const knownFee = receipt.fee_paid_msat !== undefined && Number.isSafeInteger(receipt.fee_paid_msat) && receipt.fee_paid_msat >= 0;
        setResult({ ok: true, settledMsat: receipt.amount_msat, text: knownFee ? t('extraNetworkFee', fmtAmount(receipt.fee_paid_msat!)) : t('extraNetworkFeeUnknown') });
      } else {
        setResult({ ok: receipt.status !== 'failed', text: receipt.status === 'failed' ? t('extraPaymentFailed') : t('extraPaymentInProgressSettlementIsNotConfirmedYet') });
      }
    } else {
      setResult({ ok: false, text: r.error.message });
    }
  };

  const hint = (): string | null => {
    const r = recipient();
    if (r.kind === 'onchain') return t('extraSendingOnChainIsAnOwnerActionAt');
    if (r.kind === 'unknown' && to().trim()) return t('extraThatIsNotALightningInvoiceOrA');
    if (r.kind === 'invoice' && !read() && !readError()) return t('extraReadingTheInvoice');
    return null;
  };

  return (
    <section class="wallet-panel wallet-send" data-wallet-send>
      <Show
        when={review()}
        fallback={
          <form class="wallet-form" onSubmit={(e) => void openReview(e)}>
            <AmountInput data="data-send-amount" label={t('extraAmountToSend')} value={amount()} onInput={setAmount} cleared={amountCleared()} />
            <textarea data-send-to rows={2} placeholder={t('extraPasteALightningInvoiceOrANodeID')} value={to()} onInput={(e) => setTo(e.currentTarget.value)} aria-label={t('extraSendTo')} />
            <Show when={recipient().kind === 'node'}>
              <input data-send-memo placeholder={t('uiNoteOptional')} value={memo()} onInput={(e) => setMemo(e.currentTarget.value)} aria-label={t('uiNote')} />
            </Show>
            <Show when={hint()}>{(h) => <p class="hint" data-send-hint>{h()}</p>}</Show>
            <Show when={readError()}>{(e) => <p class="err-note" data-send-error role="alert">{e()}</p>}</Show>
            <Show when={read()}>
              {(inv) => (
                <p class="hint" data-send-invoice={inv().amount_msat}>
                  {t('uiInvoiceFor')} {fmtAmount(inv().amount_msat)} {t('extraToNode')} {shortId(inv().payee)}
                  {inv().description ? ` · “${inv().description}”` : ''}
                </p>
              )}
            </Show>
            <Show when={mismatch()}>
              {(m) => (
                <p class="err-note" data-send-mismatch>
                  {t('extraThisInvoiceAsksFor')} {fmtAmount(m())}{t('extraNotTheAmountAbove')}{' '}
                  <button type="button" class="link" data-send-use-invoice onClick={() => setAmount(amountText(m(), denom()))}>{t('extraUse')} {fmtAmount(m())}</button>
                </p>
              )}
            </Show>
            <div class="composer-bar">
              <div class="cost" data-cost>
                <span class="label">{t('uiTotalAtMost')}</span>
                <Show when={msat() !== null} fallback={<span class="sats">…</span>}>
                  <span class="sats" data-cost-msat={allIn(msat()!)}>{sats(allIn(msat()!), true)}<span class="unit">{satUnit(allIn(msat()!))}</span></span>
                </Show>
                <span class="basis">{t('extraTheAmountAndANetworkFeeOfAt')} {fmtAmount(routingFee(msat() ?? 0))}</span>
              </div>
              <button type="submit" class="primary soft money" data-send-review disabled={!ready() && !approvable()}>{buttonLabel()}</button>
            </div>
            <Show when={props.moneyBlocked}><p class="hint" data-send-blocked>{t('extraPaymentsAreNotReadyYet')}</p></Show>
            <Show when={!props.moneyBlocked && !line().open}>
              <p class="hint" data-send-window>{t('extraPaymentsNeedYourTenMinuteApprovalAtYour')}</p>
              {props.spendGate}
            </Show>
          </form>
        }
      >
        {(rv) => (
          <div class="pay-review" data-wallet-review data-review-msat={rv().msat} data-review-max-msat={allIn(rv().msat)}>
            <p class="pay-review-title">{rv().kind === 'invoice' ? t('uiPayThisLightningInvoice') : t('uiPayALightningNodeDirectly')}</p>
            <p class="hint" data-review-payee>
              {t('extraToNode95')} {shortId(rv().kind === 'invoice' ? (rv() as { payee: string }).payee : (rv() as { pubkey: string }).pubkey)}
            </p>
            <dl>
              <dt>{t('uiAmount')}</dt>
              <dd data-review-amount>{fmtAmount(rv().msat)}</dd>
              <dt>{t('uiNetworkFee')}</dt>
              <dd data-review-fee>{t('uiUpTo178')} {fmtAmount(routingFee(rv().msat))}</dd>
              <dt>{t('uiTotalAtMost')}</dt>
              <dd data-review-total>{fmtAmount(allIn(rv().msat))}</dd>
              <Show when={rv().kind === 'keysend' && (rv() as { memo: string }).memo.trim()}>
                <dt>{t('uiNote')}</dt>
                <dd>{(rv() as { memo: string }).memo.trim()}</dd>
              </Show>
            </dl>
            <div class="composer-bar">
              <button type="button" class="link" data-review-back disabled={busy()} onClick={() => setReview(null)}>{t('uiBack')}</button>
              <span class="basis">{t('uiYouPayTheRealFeeNeverAboveThis')}</span>
              <button type="button" class="primary soft money" data-wallet-confirm disabled={busy() || props.moneyBlocked || !line().open} onClick={() => void confirm()}>
                {t('uiConfirmAndPay')}
              </button>
            </div>
          </div>
        )}
      </Show>
      <Show when={busy()}><p class="hint" data-send-paying>{t('uiPaying')}</p></Show>
      <Show when={result()}>
        {(r) => <div data-send-result={r().ok ? 'ok' : 'failed'}>
          <Show when={r().settledMsat !== undefined}><SettledPayment direction="sent" msat={r().settledMsat!} /></Show>
          <p class={r().ok ? 'hint' : 'err-note'} role="status">{r().text}</p>
        </div>}
      </Show>
    </section>
  );
}
