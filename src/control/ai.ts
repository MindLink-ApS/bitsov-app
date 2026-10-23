import { t as tr } from '../i18n';
import { language, copy, type CopyKey } from '../i18n';
// The AI track's rules as pure functions: what a question asks for, how an
// answer is composed from the host's broker read, how old it is, and what a
// proposed action prefills. Nothing here reads the node, sends, or spends.
//
// The default provider is this computer: the answer is composed here from the
// broker's allowlisted projection, so nothing leaves the machine. A remote
// model only ever sees a body the owner was shown first (see `Disclosure`).

import { ago, sats, satsWhole, satUnit, shortId, uptime } from './format';
import { petnameOf } from './petnames';
import { peerName } from './state';
import type {
  AiFreshness,
  AiTopic,
  Amount,
  BalanceReport,
  ChannelsReport,
  HealthReport,
  LocalPricesReport,
  MessageCountsReport,
  NoRead,
  PaymentsReport,
  Peer,
  Preset,
  Report,
  ToolOutput,
  TopicRead,
  Unavailable,
} from './types';

export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;

// ---- what a question asks -----------------------------------------------------

/** Literal content supplied separately from a question or provider's display prose. */
export type DraftInput = { draft_text: string };

/** A rules/provider result. No consumer may recover these fields from prose. */
export type MessageProposal = {
  recipient: string;
  draft_text: string;
  amount_hint: number | null;
};

/** An action the track may propose. It only prefills a composer; the owner sends. */
export type Proposal =
  | ({ kind: 'message'; name: string } & MessageProposal)
  | { kind: 'pay'; peer: string; name: string; sats: number }
  | { kind: 'request'; peer: string; name: string; sats: number; note: string };

export type Intent =
  | { kind: 'read'; topic: AiTopic; sinceMs: number | null; window: string | null }
  | { kind: 'act'; proposal: Proposal }
  | { kind: 'no-peer'; what: Proposal['kind'] }
  | { kind: 'unknown' };

/** What the local answerer can read. Shown as suggestions. */
export const SUGGESTIONS = (): readonly string[] => [
  tr('caWhatDidISpendThisWeek'),
  tr('caHowMuchIsInMyWallet'),
  tr('caHowIsMyNodeDoing'),
  tr('caDraftA2SatMessageToMaya'),
];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The one peer a question names, by petname or label (whole word) or an id prefix of 8+ hex. */
export function peerIn(text: string, peers: Peer[]): Peer | null {
  const lower = text.toLowerCase();
  const hex = lower.match(/\b[0-9a-f]{8,64}\b/g) ?? [];
  const matches = peers.filter((p) => {
    const pet = petnameOf(p.node_id)?.toLowerCase();
    const label = p.label?.trim().toLowerCase();
    const byPet = !!pet && new RegExp(`(^|[^\\p{L}\\p{N}])${escape(pet)}($|[^\\p{L}\\p{N}])`, 'u').test(lower);
    const byLabel = !!label && new RegExp(`(^|[^\\p{L}\\p{N}])${escape(label)}($|[^\\p{L}\\p{N}])`, 'u').test(lower);
    return byPet || byLabel || hex.some((h) => p.node_id.toLowerCase().startsWith(h));
  });
  // Both naming forms must agree on one distinct contact. A label must not
  // override another contact's id (or an ambiguous prefix).
  return new Set(matches.map((p) => p.node_id.toLowerCase())).size === 1 ? matches[0] : null;
}

/** The first whole number of sats in the text: `2-sat`, `500 sats`, `1,000 sat`. */
export function satsIn(text: string): number | null {
  // Capture the complete token, including a sign or decimal/fraction, so a
  // rejected amount cannot be reinterpreted as its trailing positive digits.
  const m = /(?:^|\s)((?:[+−-]\s*)?\S+?)\s*-?\s*(?:sats?|satoshis?)\b/i.exec(text);
  if (!m || !/^(?:[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(m[1])) return null;
  // A space may split a fraction or a grouped amount, not just words. Refuse
  // its trailing token too ("1 / 2 sats", "1 500 sats").
  if (/(?:^|\s)[\d.,/+−-]+$/.test(text.slice(0, m.index).trimEnd())) return null;
  if (language() === 'da' && m[1].includes(',')) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

function timeWindow(text: string, nowMs: number): { sinceMs: number | null; label: string } {
  const t = text.toLowerCase();
  if (/\btoday\b/.test(t)) return { sinceMs: startOfDay(nowMs), label: tr('caToday') };
  if (/\byesterday\b/.test(t)) return { sinceMs: startOfDay(nowMs) - DAY_MS, label: tr('caSinceYesterday') };
  if (/\bmonth\b/.test(t)) return { sinceMs: nowMs - 30 * DAY_MS, label: tr('caInTheLast30Days') };
  if (/\b(ever|all time|in total|so far)\b/.test(t)) return { sinceMs: null, label: tr('caInTheHistoryYourNodeKeeps') };
  return { sinceMs: nowMs - WEEK_MS, label: tr('caInTheLast7Days') };
}

const TOPICS: [AiTopic, RegExp][] = [
  ['payments', /\b(spen[dt]|spending|paid|payments?|earn(ed|ings)?|received|income|cost me)\b/],
  ['prices', /\b(prices?|pricing|charge|what do i charge|cost to (message|reach) me)\b/],
  ['channels', /\b(channels?|liquidity|inbound|outbound|capacity)\b/],
  ['balance', /\b(balance|funds?|wallet|how much (money|bitcoin|btc|sats?)|savings|do i have)\b/],
  ['inbox', /\b(inbox|who (wrote|messaged|sent me)|incoming|unread|messages? (did i get|from))\b/],
  ['node', /\b(node|status|health|healthy|uptime|online|block|synced?|peers? connected|how is it doing)\b/],
];

// Built-in suggestions keep the existing rule-parser meaning in either language.
// Free-form text, contact names and draft bodies are never translated.
const suggestionKeys = [
  'caWhatDidISpendThisWeek', 'caHowMuchIsInMyWallet', 'caHowIsMyNodeDoing',
  'caDraftA2SatMessageToMaya', 'caHowMuchInboundLiquidityDoIHave',
  'caWhatDoICharge', 'caWhatDidISpendToday', 'caWhoMessagedMe',
  'caDraftAMessageToMaya', 'caPayMaya500Sats', 'caRequest2000SatsFromJosh',
] as const satisfies readonly CopyKey[];
function ruleQuestion(text: string): string {
  const normalized = text.trim().toLocaleLowerCase();
  const key = suggestionKeys.find(key => copy.da[key].toLocaleLowerCase() === normalized);
  return key ? copy.en[key] : text;
}

/** What a question asks for. Actions need exactly one named peer. */
export function understand(text: string, peers: Peer[], nowMs: number, draft?: DraftInput): Intent {
  text = ruleQuestion(text);
  const t = text.toLowerCase();
  const amount = satsIn(text);
  const wantsMessage = /\b(draft|write|compose|message|text|tell|reply|ask)\b/.test(t) && !/\bmessages? (did i get|from)\b/.test(t);
  const wantsPay = /\b(pay|tip|zap)\b/.test(t) || (/\bsend\b/.test(t) && amount !== null && !/\bmessage\b/.test(t));
  const wantsRequest = /\b(request|invoice|charge (him|her|them)|bill)\b/.test(t);
  const what: Proposal['kind'] | null = wantsRequest && amount !== null
    ? 'request'
    : wantsPay && amount !== null && !/\bmessage\b/.test(t)
      ? 'pay'
      : wantsMessage && !/^(what|how|who|when|did|do|is|are)\b/.test(t.trim())
        ? 'message'
        : null;
  const peer = what ? peerIn(text, peers) : null;
  // "tell me…", "ask…" are drafts only when a contact is named.
  const explicit = /\b(draft|write|compose|message)\b/.test(t) || what !== 'message';
  if (what && (peer || explicit)) {
    if (!peer) return { kind: 'no-peer', what };
    const id = peer.node_id.toLowerCase();
    const name = peerName(peer, peer.node_id);
    if (what === 'pay') return { kind: 'act', proposal: { kind: 'pay', peer: id, name, sats: amount! } };
    if (what === 'request') {
      return { kind: 'act', proposal: { kind: 'request', peer: id, name, sats: amount!, note: draft?.draft_text ?? '' } };
    }
    return { kind: 'act', proposal: { kind: 'message', recipient: id, name, draft_text: draft?.draft_text ?? '', amount_hint: amount } };
  }
  for (const [topic, pattern] of TOPICS) {
    if (!pattern.test(t)) continue;
    if (topic !== 'payments') return { kind: 'read', topic, sinceMs: null, window: null };
    const w = timeWindow(text, nowMs);
    return { kind: 'read', topic, sinceMs: w.sinceMs, window: w.label };
  }
  return { kind: 'unknown' };
}

// ---- answers ------------------------------------------------------------------

/** An inline artifact in the AI stream. */
export type Card =
  | { type: 'node'; health: HealthReport }
  | { type: 'balance'; balance: BalanceReport | null; channels: ChannelsReport | null }
  | { type: 'payments'; report: PaymentsReport; window: string };

export type Answer = { text: string; cards: Card[] };

export const value = (a: Amount | undefined | null): number | null => (a && a.state === 'available' ? a.value : null);

const REASON: Record<Unavailable['kind'], string> = {
  get timeout() { return tr('caItDidNotAnswerInTime'); },
  get upstream_error() { return tr('caItReturnedAnError'); },
  get malformed() { return tr('caItsReplyWasNotInTheExpectedShape'); },
  get absent() { return tr('caItDidNotIncludeThatFigure'); },
  get stale() { return tr('caItMarkedTheFigureOutOfDate'); },
  get overflow() { return tr('caATotalWasTooLargeToAddUp'); },
};

const missing = (what: string, reason: Unavailable) =>
  tr('caYourNodeDidNotReturnNothingWasGuessed', what, REASON[reason.kind]);

const satsText = (msat: number) => `${sats(msat)} ${satUnit(msat)}`;

function ready<T>(output: ToolOutput | undefined, tool: ToolOutput['tool']): Report<T> | null {
  return output && output.tool === tool ? (output.report as Report<T>) : null;
}

function balanceAnswer(report: Report<BalanceReport>): Answer {
  if (report.state === 'unavailable') return { text: missing(tr('caItsBalance'), report.reason), cards: [] };
  const b = report.value;
  const total = value(b.wallet_balance);
  if (total === null) return { text: missing(tr('caItsBalance'), { kind: 'absent' }), cards: [] };
  const what = {
    ldk_onchain_plus_lightning: tr('caThatIsLightningAndSpendableOnChainTogether'),
    lnd_channel_balance: tr('caThatIsYourLightningChannelBalance'),
    node_reported: tr('caThatIsTheFigureYourNodeReportsItDoes'),
  }[b.label];
  const out = value(b.channel_local_balance);
  const send = out === null ? '' : tr('caYourLocalChannelBalanceIs', satsText(out));
  return { text: tr('caYourNodeReports', satsText(total), what, send), cards: [{ type: 'balance', balance: b, channels: null }] };
}

function channelsAnswer(report: Report<ChannelsReport>): Answer {
  if (report.state === 'unavailable') return { text: missing(tr('caItsChannels'), report.reason), cards: [] };
  const c = report.value;
  const count = value(c.count) ?? c.channels.length;
  const active = value(c.active_count) ?? c.channels.filter((ch) => ch.active).length;
  const sum = (pick: (ch: ChannelsReport['channels'][number]) => Amount) =>
    c.channels.filter((ch) => ch.active).reduce((n, ch) => n + (value(pick(ch)) ?? 0), 0);
  if (count === 0) {
    return { text: tr('caYourNodeHasNoLightningChannelsYetAChannel'), cards: [] };
  }
  return {
    text:
      tr('caActiveExtra768', count, count === 1 ? tr('caChannel') : tr('caChannels'), active) +
      tr('caOverTheActiveOnesYouCanSendAndReceive', satsText(sum((ch) => ch.local_balance)), satsText(sum((ch) => ch.remote_balance))),
    cards: [{ type: 'balance', balance: null, channels: c }],
  };
}

function nodeAnswer(report: Report<HealthReport>): Answer {
  if (report.state === 'unavailable') return { text: missing(tr('caItsStatus'), report.reason), cards: [] };
  const h = report.value;
  const parts: string[] = [];
  const peers = value(h.connected_peers);
  if (peers !== null) parts.push(tr('caConnected', peers, peers === 1 ? tr('caPeer') : tr('caPeersExtra774')));
  const height = value(h.block_height);
  if (height !== null) parts.push(tr('caAtBlock', satsWhole(height)));
  const up = value(h.uptime);
  if (up !== null) parts.push(tr('caUp', uptime(up)));
  const head = h.liveness === 'ok' ? tr('caYourNodeIsHealthy') : tr('caYourNodeAnsweredButDidNotReportItselfHealthy');
  const ln = h.lightning_payment_capable ? '' : tr('caLightningCannotSendPaymentsRightNow');
  return { text: `${head}${parts.length ? `: ${parts.join(', ')}` : ''}.${ln}`, cards: [{ type: 'node', health: h }] };
}

function inboxAnswer(report: Report<MessageCountsReport>, nameOf: (id: string) => string): Answer {
  if (report.state === 'unavailable') return { text: missing(tr('caItsMessages'), report.reason), cards: [] };
  const m = report.value;
  const n = value(m.returned_count) ?? 0;
  if (n === 0) return { text: tr('caYourNodeReturnedNoIncomingMessages'), cards: [] };
  const top = [...m.senders]
    .map((s) => ({ name: nameOf(s.sender), count: value(s.count) ?? 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 4)
    .map((s) => `${s.name} (${s.count})`);
  const withheld = value(m.withheld_senders) ?? 0;
  return {
    text:
      tr('caYourLatestIncomingFrom', n, n === 1 ? tr('caMessageCame') : tr('caMessagesCame'), m.senders.length) +
      `${m.senders.length === 1 ? tr('caContactExtra777') : tr('caContacts')}${top.length ? `: ${top.join(', ')}` : ''}.` +
      (withheld > 0 ? tr('caHadASenderTheBrokerCouldNotCheckSo', withheld) : ''),
    cards: [],
  };
}

const CATEGORY: Record<string, string> = {
  get communication() { return tr('caMessageNoun'); },
  get structured_data() { return tr('caStructuredData'); },
  get files_media() { return tr('caAFile'); },
  get collaboration() { return tr('caCollaboration'); },
  get realtime_signaling() { return tr('caACallSignal'); },
  get web_content() { return tr('caWebContent'); },
  get relay_storage() { return tr('caRelayStorage'); },
  get control() { return tr('caAControlMessage'); },
  get app_extension() { return tr('caAnAppExtension'); },
};

function pricesAnswer(report: Report<LocalPricesReport>): Answer {
  if (report.state === 'unavailable') return { text: missing(tr('caItsPrices'), report.reason), cards: [] };
  const p = report.value;
  const line = (category: string) => {
    const price = p.prices.find((x) => x.category === category);
    const msat = value(price?.price);
    return msat === null ? null : tr('caFor', satsText(msat), CATEGORY[category] ?? category);
  };
  const first = line('communication');
  const rest = ['files_media', 'structured_data', 'collaboration'].map(line).filter(Boolean);
  if (!first && rest.length === 0) return { text: missing(tr('caItsPrices'), { kind: 'absent' }), cards: [] };
  return {
    text:
      tr('caYouCharge', first ?? tr('caNoListedPriceForAMessage'), rest.length ? `; ${rest.join(', ')}` : '') +
      tr('caSendersPayTheseToReachYouThisIsYour'),
    cards: [],
  };
}

function paymentsAnswer(report: Report<PaymentsReport>, label: string): Answer {
  if (report.state === 'unavailable') return { text: missing(tr('caYourPaymentHistory'), report.reason), cards: [] };
  const r = report.value;
  const sent = r.entries.filter((e) => e.direction === 'sent');
  const got = r.entries.filter((e) => e.direction === 'received');
  const contacts = (list: typeof sent) =>
    new Set(list.map((e) => (e.peer.state === 'value' ? e.peer.value : '?'))).size;
  const spent = value(r.sent_total);
  const earned = value(r.received_total);
  const lead = `${label[0].toUpperCase()}${label.slice(1)}`;
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  let text =
    spent === null
      ? tr('caYourSpendingCouldNotBeAddedUp')
      : spent === 0
        ? tr('caNoSpendingWasFoundInThePaidMessageHistory', label)
        : tr('caYouSpentOnPaidMessages', lead, satsText(spent));
  text += earned === null
    ? tr('caYourReceivedTotalCouldNotBeAddedUp')
    : earned === 0
      ? tr('caNoIncomeWasFoundInThePaidMessageHistory', label)
      : tr('caYouReceivedFromPaidMessages', satsText(earned), label);
  // Totals cover all inspected entries; the broker caps the listed subset.
  // Counts from that subset cannot establish whether any spending occurred.
  if (r.entries.length) {
    text += tr('caTheListedEntriesIncludeToAnd', n(sent.length, tr('caSentMessage'), tr('caSentMessages')), n(contacts(sent), tr('caContactExtra777'), tr('caContacts')), n(got.length, tr('caReceivedMessage'), tr('caReceivedMessages')));
  }
  const caveats: string[] = [];
  const unread = value(r.peers_unread) ?? 0;
  if (unread > 0) caveats.push(tr('caCouldNotBeReadSoTheseTotalsAreA', n(unread, tr('caContactExtra777'), tr('caContacts'))));
  const partial = value(r.partial_threads) ?? 0;
  if (partial > 0) caveats.push(tr('caOlderMessagesWithNotRead', n(partial, tr('caContactWere'), tr('caContactsWere'))));
  if (caveats.length) text += ` ${caveats.join('; ').replace(/^./, (c) => c.toUpperCase())}.`;
  text += tr('caPaidMessagesOnlyYourNodeKeepsNoListOf');
  return {
    text,
    cards: r.entries.length ? [{ type: 'payments', report: r, window: label }] : [],
  };
}

/** Compose the local answer from a live read. */
export function answerFrom(
  read: Extract<TopicRead, { state: 'live' }>,
  intent: Extract<Intent, { kind: 'read' }>,
  nameOf: (id: string) => string,
): Answer {
  const out = read.outputs[0];
  switch (read.topic) {
    case 'balance':
      return balanceAnswer(ready<BalanceReport>(out, 'balance') ?? { state: 'unavailable', reason: { kind: 'absent' } });
    case 'channels':
      return channelsAnswer(ready<ChannelsReport>(out, 'channels') ?? { state: 'unavailable', reason: { kind: 'absent' } });
    case 'node':
      return nodeAnswer(ready<HealthReport>(out, 'health') ?? { state: 'unavailable', reason: { kind: 'absent' } });
    case 'inbox':
      return inboxAnswer(ready<MessageCountsReport>(out, 'message_counts') ?? { state: 'unavailable', reason: { kind: 'absent' } }, nameOf);
    case 'prices':
      return pricesAnswer(ready<LocalPricesReport>(out, 'local_prices') ?? { state: 'unavailable', reason: { kind: 'absent' } });
    case 'payments':
      return paymentsAnswer(
        ready<PaymentsReport>(out, 'payments') ?? { state: 'unavailable', reason: { kind: 'absent' } },
        intent.window ?? tr('caInTheLast7Days'),
      );
  }
}

const NO_READ: Record<NoRead, string> = {
  get not_paired() { return tr('caTheAppIsNotPairedWithYourNodeFor'); },
  get rc7_fallback() { return tr('caYourNodeVersionHasNoPairingAndTheRead') +
    tr('caNothingWasReadPairWithANodeThatSupports'); },
  get node_unreachable() { return tr('caYourNodeDidNotAnswerSoNothingWasRead'); },
};

export const noReadText = (reason: NoRead) => NO_READ[reason];

export function unknownText(): string {
  return tr('caICanAnswerFromYourNodeAboutYourBalance');
}

export function noPeerText(what: Proposal['kind']): string {
  const verb = { message: tr('caDraftAMessage'), pay: tr('caPrepareAPayment'), request: tr('caPrepareAnInvoice') }[what];
  return tr('caToINeedExactlyOneOfYourContactsBy', verb, what === 'message' ? '' : tr('caAnAmountInSats'), { message: tr('caDraftAMessageToMaya'), pay: tr('caPayMaya500Sats'), request: tr('caRequest2000SatsFromJosh') }[what]);
}

/** What the track says after preparing an action. It never says it sent or paid. */
export function proposalText(p: Proposal): string {
  switch (p.kind) {
    case 'message':
      return (
        tr('caIPreparedADraftForSComposerSetsThe', p.name, p.name) +
        (p.amount_hint !== null ? tr('caYouAskedForASatMessageThePriceIs', p.amount_hint) : '') +
        tr('caNothingIsSentUntilYouPressSendAndApprove')
      );
    case 'pay':
      return tr('caIPreparedASatPaymentToNothingIsPaid', satsWhole(p.sats), p.name);
    case 'request':
      return tr('caIPreparedAnInvoiceForSatsFromReceivingCosts', satsWhole(p.sats), p.name);
  }
}

// ---- where an answer came from ------------------------------------------------

export type SourceLine = { state: AiFreshness['state']; text: string };

/**
 * Freshness at `nowMs` of an answer received at `receivedAt`: the host's age
 * plus the time on screen. The remaining lifetime tracks the first route to
 * expire independently of that oldest age. Unknown stays unknown.
 */
export function sourceLine(f: AiFreshness, receivedAt: number, nowMs: number): SourceLine {
  const stale = f.node_stale || f.state === 'stale';
  const why = f.node_stale ? tr('caYourNodeMarkedItOutOfDate') : '';
  const skew = f.clock_skew ? tr('caYourNodeSClockIsAheadOfThisComputer') : '';
  if (f.age_ms === null || f.fresh_for_ms === null) {
    // An absent/unusable As-Of makes the age unknown, not the node's explicit
    // stale signal. Preserve that signal even if a derived state disagrees.
    return stale
      ? { state: 'stale', text: tr('caStaleUpdateTimeUnknownAskAgainToReRead', why, skew) }
      : { state: 'unknown', text: tr('caFreshnessUnknown', skew) };
  }
  const elapsed = Math.max(0, nowMs - receivedAt);
  const age = f.age_ms + elapsed;
  const when = ago(nowMs - age, nowMs);
  const basis = f.node_as_of ? tr('caByYourNodeSClock') : tr('caWhenTheAppReadIt');
  if (stale || elapsed >= f.fresh_for_ms) {
    return { state: 'stale', text: tr('caStaleUpdatedAskAgainToReRead', when, basis, why, skew) };
  }
  return { state: 'fresh', text: tr('caUpdated', when, basis, skew) };
}

// ---- disclosure presets --------------------------------------------------------

export const PRESETS: { id: Preset; label: string; detail: string }[] = [
  { id: 'counts', get label() { return tr('caCountsOnly'); }, get detail() { return tr('caHowManyNeverHowMuchWhenOrWho'); } },
  { id: 'rounded', get label() { return tr('caRounded'); }, get detail() { return tr('caAmountsToTwoFiguresDatesToTheDayNo'); } },
  { id: 'exact', get label() { return tr('caExact'); }, get detail() { return tr('caTheFiguresTheBrokerReadWithNodeIds'); } },
];

// ---- copy text -----------------------------------------------------------------

export function cardText(card: Card, nameOf: (id: string) => string): string {
  const fig = (a: Amount | undefined) => (value(a) === null ? tr('caUnavailableExtra63') : satsText(value(a)!));
  switch (card.type) {
    case 'node': {
      const h = card.health;
      return [
        tr('caNode', h.liveness === 'ok' ? tr('caHealthyExtra819') : tr('caNotHealthy990')),
        tr('caPeersConnected991', value(h.connected_peers) ?? tr('caUnavailableExtra63')),
        tr('caEncryptedSessions992', value(h.e2ee_sessions) ?? tr('caUnavailableExtra63')),
        tr('caWaitingToDeliver993', value(h.pending_deliveries) ?? tr('caUnavailableExtra63')),
        tr('caBlockHeight994', value(h.block_height) ?? tr('caUnavailableExtra63')),
        tr('caLightning', h.lightning_backend, h.lightning_payment_capable ? tr('caCanPay') : tr('caCannotPay')),
        tr('caUptimeExtra825', value(h.uptime) === null ? tr('caUnavailableExtra63') : uptime(value(h.uptime)!)),
      ].join('\n');
    }
    case 'balance': {
      const lines: string[] = [];
      if (card.balance) {
        lines.push(tr('caBalanceExtra827', fig(card.balance.wallet_balance)), tr('caLightningYours997', fig(card.balance.channel_local_balance)), tr('caLightningTheirs998', fig(card.balance.channel_remote_balance)));
      }
      if (card.channels) {
        lines.push(tr('caChannelsActive', value(card.channels.count) ?? '?', value(card.channels.active_count) ?? '?'));
        for (const ch of card.channels.channels) {
          lines.push(tr('caYoursTheirs', ch.active ? tr('caActive') : tr('caInactive'), fig(ch.local_balance), fig(ch.remote_balance)));
        }
      }
      return lines.join('\n');
    }
    case 'payments': {
      const r = card.report;
      const lines = [tr('caPaidMessagesSpentReceived', card.window, fig(r.sent_total), fig(r.received_total))];
      for (const e of r.entries) {
        const who = e.peer.state === 'value' ? nameOf(e.peer.value) : tr('caWithheld');
        const when = new Date(e.at_ms).toISOString().slice(0, 16).replace('T', ' ');
        lines.push(`${when}  ${e.direction === 'sent' ? tr('caTo') : tr('caFrom')} ${who}  ${fig(e.amount)}`);
      }
      return lines.join('\n');
    }
  }
}
