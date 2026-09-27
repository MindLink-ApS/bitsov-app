// The AI track's rules as pure functions: what a question asks for, how an
// answer is composed from the host's broker read, how old it is, and what a
// proposed action prefills. Nothing here reads the node, sends, or spends.
//
// The default provider is this computer: the answer is composed here from the
// broker's allowlisted projection, so nothing leaves the machine. A remote
// model only ever sees a body the owner was shown first (see `Disclosure`).

import { ago, sats, satsWhole, satUnit, shortId, uptime } from './format';
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

/** An action the track may propose. It only prefills a composer; the owner sends. */
export type Proposal =
  | { kind: 'message'; peer: string; name: string; text: string; askedSats: number | null }
  | { kind: 'pay'; peer: string; name: string; sats: number }
  | { kind: 'request'; peer: string; name: string; sats: number; note: string };

export type Intent =
  | { kind: 'read'; topic: AiTopic; sinceMs: number | null; window: string | null }
  | { kind: 'act'; proposal: Proposal }
  | { kind: 'no-peer'; what: Proposal['kind'] }
  | { kind: 'unknown' };

/** What the local answerer can read. Shown as suggestions. */
export const SUGGESTIONS: readonly string[] = [
  'What did I spend this week?',
  'How much is in my wallet?',
  'How is my node doing?',
  'Draft a 2-sat message to Maya',
];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The one peer a question names, by label (whole word) or an id prefix of 8+ hex. */
export function peerIn(text: string, peers: Peer[]): Peer | null {
  const lower = text.toLowerCase();
  const hex = lower.match(/\b[0-9a-f]{8,64}\b/g) ?? [];
  const matches = peers.filter((p) => {
    const label = p.label?.trim().toLowerCase();
    const byLabel = !!label && new RegExp(`(^|[^\\p{L}\\p{N}])${escape(label)}($|[^\\p{L}\\p{N}])`, 'u').test(lower);
    return byLabel || hex.some((h) => p.node_id.toLowerCase().startsWith(h));
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
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Find an outer quoted body, preserving nested spans and word apostrophes. */
function quotedText(input: string): { index: number; text: string } | null {
  const closing: Record<string, string> = { '"': '"', '“': '”', "'": "'" };
  const boundary = /[\s.,!?;:)\]}"'”]/;
  const isOpening = (i: number) => !!closing[input[i]] &&
    (i === 0 || /[\s([{]/.test(input[i - 1])) && !!input[i + 1] && !/[\s.,!?;:)\]}]/.test(input[i + 1]);
  const contraction = (i: number) => input[i] === "'" &&
    /[\p{L}\p{N}]/u.test(input[i - 1] ?? '') && /[\p{L}\p{N}]/u.test(input[i + 1] ?? '');
  const contentEnd = input.replace(/[\s.,!?;:]+$/, '').length;
  const possessive = (i: number) => input[i] === "'" && /s/i.test(input[i - 1] ?? '') &&
    i + 1 < contentEnd;
  const spans = new Map<number, number[]>();
  const endsOf = (start: number): number[] => {
    const cached = spans.get(start);
    if (cached) return cached;
    const limit = Math.min(input.length - 1, start + 501);
    const continuations = new Map<string, number[]>();
    const scan = (from: number, delimiter: string): number[] => {
      const key = `${from}:${delimiter}`;
      const cached = continuations.get(key);
      if (cached) return cached;
      let ends: number[] = [];
      for (let i = from; i <= limit; i++) {
        if (contraction(i)) continue;
        if (isOpening(i)) {
          // Try each pairing: 'Thanks' can close a nested span, while kids'
          // can be an apostrophe inside it. Do not consume the outer close.
          const nested = scan(i + 1, closing[input[i]]).filter((end) => end > i + 1);
          if (nested.length) {
            ends = nested.flatMap((end) => scan(end + 1, delimiter));
            // A leading elision/year is literal only when it cannot form a
            // nested span with an outer close. A later 'tomorrow' remains a
            // quoted instruction rather than becoming that missing close.
            if (ends.length || !/^'(?:em\b|\d{2}\b)/i.test(input.slice(i))) break;
          }
        }
        if (input[i] !== delimiter || (input[i + 1] && !boundary.test(input[i + 1]))) continue;
        ends = [i];
        if (possessive(i)) ends.push(...scan(i + 1, delimiter));
        break;
      }
      const unique = [...new Set(ends)].sort((a, b) => a - b);
      continuations.set(key, unique);
      return unique;
    };
    const ends = scan(start + 1, closing[input[start]]).filter((end) => end > start + 1);
    spans.set(start, ends);
    return ends;
  };
  const suffixes = new Map<number, boolean>([[input.length, true]]);
  let suffixStart = input.length;
  const balancedSuffix = (from: number): boolean => {
    // Work backwards so a long list of quoted instructions cannot recurse
    // once per instruction. Every dependency is to the right of this index.
    for (let i = suffixStart - 1; i >= from; i--) {
      let balanced = suffixes.get(i + 1)!;
      if (!contraction(i)) {
        if (isOpening(i)) {
          balanced = endsOf(i).some((end) => suffixes.get(end + 1));
        } else if (input[i] === '"' || input[i] === '”' || input[i] === "'") {
          // A trailing instruction can itself contain Chris' nickname.
          balanced = possessive(i) && balanced;
        }
      }
      suffixes.set(i, balanced);
    }
    suffixStart = Math.min(suffixStart, from);
    return suffixes.get(from)!;
  };
  for (const match of input.matchAll(/(?:^|\s)(["“'])/g)) {
    const start = match.index! + match[0].length - 1;
    const ends = endsOf(start);
    // Prefer a complete outer pairing. An early close that leaves an orphan
    // closing quote would truncate a nested span or a possessive sentence.
    const valid = ends.filter((end) => balancedSuffix(end + 1));
    const candidates = valid.length ? valid : ends;
    // If every candidate is s', the last punctuation boundary completes
    // kids', parents', ... schedules', before a separate quoted instruction.
    // A trailing Chris' nickname has whitespace, so it cannot displace it.
    const punctuated = candidates.filter((end) => !/\s/.test(input[end + 1] ?? ''));
    // When s' could be either possessive or closing, an explicit instruction
    // starts the suffix. Apostrophes in that instruction must not extend the
    // body ("'Thanks', use Chris', not Alex's, nickname"). Nested/unclosed
    // body quotes have already been excluded by the balanced-suffix check.
    const instruction = candidates.find((end) => /^(?:(?:please|don't|do not|use)\b|not\s+["“'])/i.test(
      input.slice(end + 1).replace(/^[\s.,!?;:]+/, ''),
    ));
    const end = instruction ?? candidates.find((end) => !possessive(end)) ?? punctuated[punctuated.length - 1] ?? candidates[0];
    if (end !== undefined) return { index: match.index!, text: input.slice(start + 1, end).trim() };
  }
  return null;
}

/** Quoted text, or what follows `saying` / `that says` / a colon. */
function draftText(text: string): string {
  const said = /(?:\b(?:saying|that says|to say)\s+|:\s*)([\s\S]{1,500})$/i.exec(text);
  const quoted = quotedText(text);
  // A marker inside a quoted body belongs to that body, while quotes after
  // an explicit marker belong to its complete suffix (including contractions).
  if (quoted && (!said || quoted.index < said.index)) return quoted.text;
  const body = said?.[1].trim() ?? '';
  // If the suffix starts with a quoted body, trailing prompt punctuation or
  // instructions are outside it. Quotes embedded in an unquoted body stay put.
  const wrapped = quotedText(body);
  return wrapped?.index === 0 ? wrapped.text : body;
}

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

function timeWindow(text: string, nowMs: number): { sinceMs: number | null; label: string } {
  const t = text.toLowerCase();
  if (/\btoday\b/.test(t)) return { sinceMs: startOfDay(nowMs), label: 'today' };
  if (/\byesterday\b/.test(t)) return { sinceMs: startOfDay(nowMs) - DAY_MS, label: 'since yesterday' };
  if (/\bmonth\b/.test(t)) return { sinceMs: nowMs - 30 * DAY_MS, label: 'in the last 30 days' };
  if (/\b(ever|all time|in total|so far)\b/.test(t)) return { sinceMs: null, label: 'in the history your node keeps' };
  return { sinceMs: nowMs - WEEK_MS, label: 'in the last 7 days' };
}

const TOPICS: [AiTopic, RegExp][] = [
  ['payments', /\b(spen[dt]|spending|paid|payments?|earn(ed|ings)?|received|income|cost me)\b/],
  ['prices', /\b(prices?|pricing|charge|what do i charge|cost to (message|reach) me)\b/],
  ['channels', /\b(channels?|liquidity|inbound|outbound|capacity)\b/],
  ['balance', /\b(balance|funds?|wallet|how much (money|bitcoin|btc|sats?)|savings|do i have)\b/],
  ['inbox', /\b(inbox|who (wrote|messaged|sent me)|incoming|unread|messages? (did i get|from))\b/],
  ['node', /\b(node|status|health|healthy|uptime|online|block|synced?|peers? connected|how is it doing)\b/],
];

/** What a question asks for. Actions need exactly one named peer. */
export function understand(text: string, peers: Peer[], nowMs: number): Intent {
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
    const name = peer.label?.trim() || shortId(peer.node_id);
    if (what === 'pay') return { kind: 'act', proposal: { kind: 'pay', peer: id, name, sats: amount! } };
    if (what === 'request') {
      return { kind: 'act', proposal: { kind: 'request', peer: id, name, sats: amount!, note: draftText(text) } };
    }
    return { kind: 'act', proposal: { kind: 'message', peer: id, name, text: draftText(text), askedSats: amount } };
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
  timeout: 'it did not answer in time',
  upstream_error: 'it returned an error',
  malformed: 'its reply was not in the expected shape',
  absent: 'it did not include that figure',
  stale: 'it marked the figure out of date',
  overflow: 'a total was too large to add up',
};

const missing = (what: string, reason: Unavailable) =>
  `Your node did not return ${what}: ${REASON[reason.kind]}. Nothing was guessed.`;

const satsText = (msat: number) => `${sats(msat)} ${satUnit(msat)}`;

function ready<T>(output: ToolOutput | undefined, tool: ToolOutput['tool']): Report<T> | null {
  return output && output.tool === tool ? (output.report as Report<T>) : null;
}

function balanceAnswer(report: Report<BalanceReport>): Answer {
  if (report.state === 'unavailable') return { text: missing('its balance', report.reason), cards: [] };
  const b = report.value;
  const total = value(b.wallet_balance);
  if (total === null) return { text: missing('its balance', { kind: 'absent' }), cards: [] };
  const what = {
    ldk_onchain_plus_lightning: 'That is Lightning and spendable on-chain together.',
    lnd_channel_balance: 'That is your Lightning channel balance.',
    node_reported: 'That is the figure your node reports; it does not say which balances it includes.',
  }[b.label];
  const out = value(b.channel_local_balance);
  const send = out === null ? '' : ` Your local channel balance is ${satsText(out)}.`;
  return { text: `Your node reports ${satsText(total)}. ${what}${send}`, cards: [{ type: 'balance', balance: b, channels: null }] };
}

function channelsAnswer(report: Report<ChannelsReport>): Answer {
  if (report.state === 'unavailable') return { text: missing('its channels', report.reason), cards: [] };
  const c = report.value;
  const count = value(c.count) ?? c.channels.length;
  const active = value(c.active_count) ?? c.channels.filter((ch) => ch.active).length;
  const sum = (pick: (ch: ChannelsReport['channels'][number]) => Amount) =>
    c.channels.filter((ch) => ch.active).reduce((n, ch) => n + (value(pick(ch)) ?? 0), 0);
  if (count === 0) {
    return { text: 'Your node has no Lightning channels yet. A channel is needed before paid messages can be sent.', cards: [] };
  }
  return {
    text:
      `${count} ${count === 1 ? 'channel' : 'channels'}, ${active} active. ` +
      `Over the active ones you can send ${satsText(sum((ch) => ch.local_balance))} and receive ${satsText(sum((ch) => ch.remote_balance))}.`,
    cards: [{ type: 'balance', balance: null, channels: c }],
  };
}

function nodeAnswer(report: Report<HealthReport>): Answer {
  if (report.state === 'unavailable') return { text: missing('its status', report.reason), cards: [] };
  const h = report.value;
  const parts: string[] = [];
  const peers = value(h.connected_peers);
  if (peers !== null) parts.push(`${peers} ${peers === 1 ? 'peer' : 'peers'} connected`);
  const height = value(h.block_height);
  if (height !== null) parts.push(`at block ${satsWhole(height)}`);
  const up = value(h.uptime);
  if (up !== null) parts.push(`up ${uptime(up)}`);
  const head = h.liveness === 'ok' ? 'Your node is healthy' : 'Your node answered but did not report itself healthy';
  const ln = h.lightning_payment_capable ? '' : ' Lightning cannot send payments right now.';
  return { text: `${head}${parts.length ? `: ${parts.join(', ')}` : ''}.${ln}`, cards: [{ type: 'node', health: h }] };
}

function inboxAnswer(report: Report<MessageCountsReport>, nameOf: (id: string) => string): Answer {
  if (report.state === 'unavailable') return { text: missing('its messages', report.reason), cards: [] };
  const m = report.value;
  const n = value(m.returned_count) ?? 0;
  if (n === 0) return { text: 'Your node returned no incoming messages.', cards: [] };
  const top = [...m.senders]
    .map((s) => ({ name: nameOf(s.sender), count: value(s.count) ?? 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 4)
    .map((s) => `${s.name} (${s.count})`);
  const withheld = value(m.withheld_senders) ?? 0;
  return {
    text:
      `Your latest ${n} incoming ${n === 1 ? 'message came' : 'messages came'} from ${m.senders.length} ` +
      `${m.senders.length === 1 ? 'contact' : 'contacts'}${top.length ? `: ${top.join(', ')}` : ''}.` +
      (withheld > 0 ? ` ${withheld} had a sender the broker could not check, so they are not named.` : ''),
    cards: [],
  };
}

const CATEGORY: Record<string, string> = {
  communication: 'a message',
  structured_data: 'structured data',
  files_media: 'a file',
  collaboration: 'collaboration',
  realtime_signaling: 'a call signal',
  web_content: 'web content',
  relay_storage: 'relay storage',
  control: 'a control message',
  app_extension: 'an app extension',
};

function pricesAnswer(report: Report<LocalPricesReport>): Answer {
  if (report.state === 'unavailable') return { text: missing('its prices', report.reason), cards: [] };
  const p = report.value;
  const line = (category: string) => {
    const price = p.prices.find((x) => x.category === category);
    const msat = value(price?.price);
    return msat === null ? null : `${satsText(msat)} for ${CATEGORY[category] ?? category}`;
  };
  const first = line('communication');
  const rest = ['files_media', 'structured_data', 'collaboration'].map(line).filter(Boolean);
  if (!first && rest.length === 0) return { text: missing('its prices', { kind: 'absent' }), cards: [] };
  return {
    text:
      `You charge ${first ?? 'no listed price for a message'}${rest.length ? `; ${rest.join(', ')}` : ''}. ` +
      `Senders pay these to reach you. This is your node's own table, not anyone else's.`,
    cards: [],
  };
}

function paymentsAnswer(report: Report<PaymentsReport>, label: string): Answer {
  if (report.state === 'unavailable') return { text: missing('your payment history', report.reason), cards: [] };
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
      ? 'Your spending could not be added up.'
      : spent === 0
        ? `No spending was found in the paid-message history read ${label}.`
        : `${lead} you spent ${satsText(spent)} on paid messages.`;
  text += earned === null
    ? ' Your received total could not be added up.'
    : earned === 0
      ? ` No income was found in the paid-message history read ${label}.`
      : ` You received ${satsText(earned)} from paid messages ${label}.`;
  // Totals cover all inspected entries; the broker caps the listed subset.
  // Counts from that subset cannot establish whether any spending occurred.
  if (r.entries.length) {
    text += ` The listed entries include ${n(sent.length, 'sent message', 'sent messages')} to ${n(contacts(sent), 'contact', 'contacts')} and ${n(got.length, 'received message', 'received messages')}.`;
  }
  const caveats: string[] = [];
  const unread = value(r.peers_unread) ?? 0;
  if (unread > 0) caveats.push(`${n(unread, 'contact', 'contacts')} could not be read, so these totals are a floor`);
  const partial = value(r.partial_threads) ?? 0;
  if (partial > 0) caveats.push(`older messages with ${n(partial, 'contact were', 'contacts were')} not read`);
  if (caveats.length) text += ` ${caveats.join('; ').replace(/^./, (c) => c.toUpperCase())}.`;
  text += ' Paid messages only: your node keeps no list of other Lightning payments the app may read.';
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
        intent.window ?? 'in the last 7 days',
      );
  }
}

const NO_READ: Record<NoRead, string> = {
  not_paired: 'The app is not paired with your node for reads, so nothing was read.',
  rc7_fallback:
    'Your node version has no pairing, and the read broker never uses the app’s full-access local token. ' +
    'Nothing was read. Pair with a node that supports pairing to ask about your own data.',
  node_unreachable: 'Your node did not answer, so nothing was read.',
};

export const noReadText = (reason: NoRead) => NO_READ[reason];

export function unknownText(): string {
  return 'I can answer from your node about your balance, channels, payments, node status, inbox and prices, and I can draft a message, a payment or an invoice for you to send. Try one of the suggestions.';
}

export function noPeerText(what: Proposal['kind']): string {
  const verb = { message: 'draft a message', pay: 'prepare a payment', request: 'prepare an invoice' }[what];
  return `To ${verb} I need exactly one of your contacts by name, and ${what === 'message' ? '' : 'an amount in sats, '}for example “${
    { message: 'Draft a message to Maya', pay: 'Pay Maya 500 sats', request: 'Request 2000 sats from Josh' }[what]
  }”.`;
}

/** What the track says after preparing an action. It never says it sent or paid. */
export function proposalText(p: Proposal): string {
  switch (p.kind) {
    case 'message':
      return (
        `I opened a draft in ${p.name}’s composer. ${p.name} sets the price of a message, and the composer shows it before you send.` +
        (p.askedSats !== null ? ` You asked for a ${p.askedSats}-sat message: the price is theirs, not a choice here.` : '') +
        ' Nothing is sent until you press Send and approve the spend.'
      );
    case 'pay':
      return `I prepared a ${satsWhole(p.sats)}-sat payment to ${p.name}. Nothing is paid until you paste their invoice or Lightning key, check the amount and approve it in the composer.`;
    case 'request':
      return `I prepared an invoice for ${satsWhole(p.sats)} sats from ${p.name}. Receiving costs you nothing; the invoice is made only when you press Create invoice.`;
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
  const why = f.node_stale ? ' Your node marked it out of date.' : '';
  const skew = f.clock_skew ? ' Your node’s clock is ahead of this computer.' : '';
  if (f.age_ms === null || f.fresh_for_ms === null) {
    // An absent/unusable As-Of makes the age unknown, not the node's explicit
    // stale signal. Preserve that signal even if a derived state disagrees.
    return stale
      ? { state: 'stale', text: `Stale. Update time unknown.${why} Ask again to re-read.${skew}` }
      : { state: 'unknown', text: `Freshness unknown.${skew}` };
  }
  const elapsed = Math.max(0, nowMs - receivedAt);
  const age = f.age_ms + elapsed;
  const when = ago(nowMs - age, nowMs);
  const basis = f.node_as_of ? 'by your node’s clock' : 'when the app read it';
  if (stale || elapsed >= f.fresh_for_ms) {
    return { state: 'stale', text: `Stale: updated ${when} (${basis}).${why} Ask again to re-read.${skew}` };
  }
  return { state: 'fresh', text: `Updated ${when} (${basis}).${skew}` };
}

// ---- disclosure presets --------------------------------------------------------

export const PRESETS: { id: Preset; label: string; detail: string }[] = [
  { id: 'counts', label: 'Counts only', detail: 'How many, never how much, when or who.' },
  { id: 'rounded', label: 'Rounded', detail: 'Amounts to two figures, dates to the day, no node ids.' },
  { id: 'exact', label: 'Exact', detail: 'The figures the broker read, with node ids.' },
];

// ---- copy text -----------------------------------------------------------------

export function cardText(card: Card, nameOf: (id: string) => string): string {
  const fig = (a: Amount | undefined) => (value(a) === null ? 'unavailable' : satsText(value(a)!));
  switch (card.type) {
    case 'node': {
      const h = card.health;
      return [
        `Node: ${h.liveness === 'ok' ? 'healthy' : 'not healthy'}`,
        `Peers connected: ${value(h.connected_peers) ?? 'unavailable'}`,
        `Encrypted sessions: ${value(h.e2ee_sessions) ?? 'unavailable'}`,
        `Waiting to deliver: ${value(h.pending_deliveries) ?? 'unavailable'}`,
        `Block height: ${value(h.block_height) ?? 'unavailable'}`,
        `Lightning: ${h.lightning_backend}${h.lightning_payment_capable ? ', can pay' : ', cannot pay'}`,
        `Uptime: ${value(h.uptime) === null ? 'unavailable' : uptime(value(h.uptime)!)}`,
      ].join('\n');
    }
    case 'balance': {
      const lines: string[] = [];
      if (card.balance) {
        lines.push(`Balance: ${fig(card.balance.wallet_balance)}`, `Lightning, yours: ${fig(card.balance.channel_local_balance)}`, `Lightning, theirs: ${fig(card.balance.channel_remote_balance)}`);
      }
      if (card.channels) {
        lines.push(`Channels: ${value(card.channels.count) ?? '?'} (${value(card.channels.active_count) ?? '?'} active)`);
        for (const ch of card.channels.channels) {
          lines.push(`  ${ch.active ? 'active' : 'inactive'} · ${fig(ch.local_balance)} yours · ${fig(ch.remote_balance)} theirs`);
        }
      }
      return lines.join('\n');
    }
    case 'payments': {
      const r = card.report;
      const lines = [`Paid messages ${card.window}: spent ${fig(r.sent_total)}, received ${fig(r.received_total)}`];
      for (const e of r.entries) {
        const who = e.peer.state === 'value' ? nameOf(e.peer.value) : 'withheld';
        const when = new Date(e.at_ms).toISOString().slice(0, 16).replace('T', ' ');
        lines.push(`${when}  ${e.direction === 'sent' ? 'to  ' : 'from'} ${who}  ${fig(e.amount)}`);
      }
      return lines.join('\n');
    }
  }
}
