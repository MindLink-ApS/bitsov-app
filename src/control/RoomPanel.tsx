/**
 * Rooms MVP UI (room.ts): the "New room" picker and a room's thread.
 *
 * Money: Send never pays. It freezes a review of each member's leg at the
 * price shown for them, and only that review's one confirm sends, each leg
 * capped at exactly that price. Any edit, a closed spending window or money
 * going offline withdraws the review. Skipped members are never charged.
 */
import { createEffect, createMemo, createSignal, For, on, Show, Switch, Match, type JSX } from 'solid-js';
import { t, type CopyKey } from '../i18n';
import { createStore, reconcile } from 'solid-js/store';
import { amount as fmtAmount, clock, day, sats, satUnit } from './format';
import {
  MAX_MEMBERS, newMsgId, planLegs, planTotal, roomChatText, roomRefusalWords, roomThread,
  type LegOutcome, type LegPlan, type LocalRoom, type MemberInfo, type RoomEntry,
} from './room';
import { createMessageEntrance } from './messageEntrance';
import { DelayedSpinner } from './DelayedSpinner';
import type { Delivery, Message, PriceQuote } from './types';

export type RoomContact = { id: string; name: string } & MemberInfo;

/** Why a contact cannot be picked, or `null` when they can. */
function unpickable(c: RoomContact, nodeRooms: boolean): string | null {
  if (!nodeRooms) return null;
  if (!c.connected) return 'not connected';
  if (!c.rooms) return 'needs update';
  if (!c.session) return 'message them once first';
  return null;
}

/** Pick 1 to 3 contacts. Creating a room is local and free: nothing is sent. */
export function NewRoomPanel(props: {
  contacts: RoomContact[];
  /** Our own node checks room bindings (`room_binding_v1` on /status). */
  nodeRooms: boolean;
  onCreate: (picks: string[]) => void;
  onCancel: () => void;
}) {
  const [picks, setPicks] = createSignal<string[]>([]);
  const toggle = (id: string) =>
    setPicks((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < MAX_MEMBERS - 1 ? [...p, id] : p));
  const ok = (c: RoomContact) => props.nodeRooms && unpickable(c, true) === null;
  return (
    <aside class="call-panel meeting-panel room-panel" data-room-panel="new" role="dialog" aria-label="New room">
      <header><strong>New room</strong><span class="who">you and up to {MAX_MEMBERS - 1} contacts</span></header>
      <ul class="meeting-legs">
        <For each={props.contacts} fallback={<li class="hint">No contacts yet.</li>}>
          {(c) => (
            <li>
              <label>
                <input type="checkbox" data-room-pick={c.id} checked={picks().includes(c.id)}
                  disabled={!ok(c) || (!picks().includes(c.id) && picks().length >= MAX_MEMBERS - 1)}
                  onChange={() => toggle(c.id)} />
                <span classList={{ muted: !ok(c) }}>{c.name}</span>
              </label>
              <Show when={unpickable(c, props.nodeRooms)}>
                {(why) => <span class="hint" data-room-pick-note={c.id}> {why()}</span>}
              </Show>
            </li>
          )}
        </For>
      </ul>
      <Show when={!props.nodeRooms}><p class="hint" data-room-node-update>Your node needs an update before it can hold rooms.</p></Show>
      <p class="hint" data-room-note>
        Creating a room is free and sends nothing. Each message you send in it pays each member their own price, separately.
        Members who are not each other’s contacts will not see each other’s messages.
      </p>
      <div class="call-actions">
        <button type="button" class="primary soft" data-room-create disabled={!props.nodeRooms || picks().length === 0} onClick={() => props.onCreate(picks())}>
          Create room
        </button>
        <button type="button" class="soft" data-room-cancel onClick={() => props.onCancel()}>Cancel</button>
      </div>
    </aside>
  );
}

/** One send of this session: what each member's leg did. */
export type RoomSend = { at: number; text: string; outcomes: LegOutcome[] };

const OUTCOME: Record<LegOutcome['state'], CopyKey> = {
  sent: 'roomSent',
  skipped: 'roomSkipped',
  refused: 'roomRefused',
  failed: 'roomNotSent',
  undelivered: 'roomUndelivered',
  unknown: 'roomUnknown',
  stopped: 'roomNotSent',
};

type Review = { legs: LegPlan[]; total: number; text: string };

/** A chat's current history read: only `ok` may say it is empty (unknown stays unknown). */
export type ThreadRead = 'pending' | 'failed' | 'ok';

export function RoomThread(props: {
  /** This room's current history read. */
  read: ThreadRead;
  /** The read's error, shown instead of any "empty" claim when it failed. */
  error?: string;
  room: LocalRoom;
  ownId: string;
  nameOf: (id: string) => string;
  /** This room's chats (every member's copy of ours included). */
  messages: Message[];
  /** What each member's node said about a copy of ours (a refusal after payment). */
  deliveries: Record<string, Delivery>;
  /** The node has older messages in this room. */
  earlier: boolean;
  loadingEarlier: boolean;
  onEarlier: () => void;
  sends: RoomSend[];
  fresh: Record<string, true>;
  seenEntrances: Set<string>;
  info: (peer: string) => MemberInfo | undefined;
  /** Read-only: the member's chat price. Never pays. */
  quote: (peer: string) => Promise<PriceQuote | null>;
  /** A budget or window rule would refuse this member before paying: why, or null. */
  budgetSkip?: (peer: string, msat: number) => string | null;
  moneyBlocked: boolean;
  /** A budget or the spending window lets this app pay now. */
  canSpend: boolean;
  /** The one tap that opens spending, shown while it is closed. */
  spendGate?: JSX.Element;
  now: number;
  /** Sends the confirmed legs, each capped at its shown price. */
  send: (legs: LegPlan[], plaintext: string, text: string) => Promise<LegOutcome[]>;
  onLeave: () => void;
  onContext: () => void;
}) {
  const own = () => props.ownId.toLowerCase();
  const others = () => props.room.roster.filter((p) => p !== own());
  const title = () => others().map(props.nameOf).join(', ');

  // The shown prices, read afresh when the room opens and after each send.
  // `undefined`: still reading; `null`: no price.
  const [quotes, setQuotes] = createStore<Record<string, PriceQuote | null | undefined>>({});
  let generation = 0;
  const refresh = () => {
    const g = ++generation;
    const ids = others();
    setQuotes(reconcile(Object.fromEntries(ids.map((id) => [id, undefined]))));
    ids.forEach((id) => void props.quote(id).then((q) => { if (g === generation) setQuotes(id, q); }));
  };
  createEffect(on(() => props.room.id, refresh));

  const legs = createMemo(() => planLegs(props.room.roster, own(), props.info, quotes).map((l): LegPlan => {
    const why = l.state === 'pay' ? props.budgetSkip?.(l.peer, l.msat) : null;
    return why ? { peer: l.peer, state: 'skip', reason: why } : l;
  }));
  const total = () => planTotal(legs());
  const estimate = () => legs().some((l) => l.state === 'pay' && l.estimate);

  const [draft, setDraft] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [review, setReview] = createSignal<Review | null>(null);
  const [leaving, setLeaving] = createSignal(false);
  // Any change to what would be sent, or to whether it may be paid, withdraws the review.
  createEffect(on([draft, () => props.room.id], () => setReview(null), { defer: true }));
  createEffect(() => { if (props.moneyBlocked || !props.canSpend) setReview(null); });

  const ready = () => !props.moneyBlocked && props.canSpend && !busy() && draft().trim().length > 0 && total() !== null;
  const openReview = () => {
    if (!ready()) return;
    setReview({ legs: legs(), total: total()!, text: draft() });
  };
  const confirm = async () => {
    const rv = review();
    if (!rv || busy() || props.moneyBlocked || !props.canSpend) return;
    // Consumed at dispatch: one review sends at most once.
    setReview(null);
    setBusy(true);
    try {
      // One msg for every member's copy, so each node shows it as one message.
      await props.send(rv.legs, roomChatText(props.room, newMsgId(), rv.text), rv.text);
      if (draft() === rv.text) setDraft('');
    } finally {
      setBusy(false);
      refresh();
    }
  };

  type Item = { key: string; at: number; entry?: RoomEntry; send?: RoomSend };
  const items = createMemo<Item[]>(() =>
    [
      ...roomThread(props.messages, props.ownId).map((e) => ({ key: `message:${e.key}`, at: e.timestamp, entry: e })),
      ...props.sends.map((s, i) => ({ key: `send:${i}`, at: s.at + 1, send: s })),
    ].sort((a, b) => a.at - b.at));
  const keyedItems = createMemo(() => new Map(items().map((item) => [item.key, item])));
  let stream: HTMLDivElement | undefined;
  createEffect(on(() => items().length, () => queueMicrotask(() => stream?.scrollTo?.({ top: stream.scrollHeight }))));

  const legLine = (l: LegPlan) =>
    l.state === 'pay' ? `${l.estimate ? '≈ ' : ''}${fmtAmount(l.msat)}` : l.state === 'skip' ? l.reason : t('roomReadingPrice');

  return (
    <>
      <header class="track-head" data-room-head={props.room.id}>
        <h1 data-room-title>{title()}</h1>
        <div class="sub"><span class="id">{t('roomMembers', others().length)}</span></div>
        <button type="button" class="quiet" data-room-leave onClick={() => setLeaving(true)}>{t('roomLeave')}</button>
        <button class="quiet context-toggle" onClick={() => props.onContext()}>{t('uiSettings')}</button>
      </header>
      <Show when={leaving()}>
        <div class="approval" data-room-leave-confirm>
          <p>{t('roomLeaveConfirm')}</p>
          <div class="call-actions">
            <button type="button" class="primary soft" data-room-leave-yes onClick={() => { setLeaving(false); props.onLeave(); }}>{t('roomLeave')}</button>
            <button type="button" class="soft" data-room-leave-no onClick={() => setLeaving(false)}>{t('roomStay')}</button>
          </div>
        </div>
      </Show>
      <div class="stream" ref={stream} data-stream data-room-stream>
        <div class="chat-column">
          <p class="day" data-room-honesty>
            {t('roomHonesty')}
          </p>
          <Show when={props.earlier}>
            <button type="button" class="link" data-room-earlier disabled={props.loadingEarlier} onClick={() => props.onEarlier()}>
              {props.loadingEarlier ? t('chatLoading') : t('chatEarlier')}
            </button>
          </Show>
          <For each={[...keyedItems().keys()]} fallback={
            <Switch>
              <Match when={props.read === 'ok'}>
                <div class="empty-track" data-thread-empty="room">
                  <h2>{t('chatEmpty')}</h2>
                  <p class="hint">{t('roomEmptyHint')}</p>
                </div>
              </Match>
              <Match when={props.read === 'failed'}>
                <p class="err-note" role="alert" data-thread-error>{props.error ?? t('roomReadError')}</p>
              </Match>
              <Match when={props.read === 'pending'}>
                <div class="empty-track" data-thread-loading><DelayedSpinner /></div>
              </Match>
            </Switch>
          }>
            {(key, i) => {
              const item = () => keyedItems().get(key)!;
              const prev = () => items()[i() - 1];
              const newDay = () => !prev() || day(prev()!.at) !== day(item().at);
              return (
                <>
                  <Show when={newDay()}><p class="day">{day(item().at)}</p></Show>
                  <Switch>
                    <Match when={item().entry}>
                      {(e) => {
                        const entrance = createMessageEntrance(`${props.room.id}:${e().key}`, e().ids.some((id) => props.fresh[id]), props.seenEntrances);
                        const out = () => e().sender === own();
                        // A member's node refused our paid copy: said plainly, per member.
                        const refusals = () => e().copies.flatMap((c) => {
                          const d = props.deliveries[c.id];
                          return d?.status === 'rejected' ? [{ peer: c.recipient, words: roomRefusalWords(d.reason) ?? t('roomNodeRefused') }] : [];
                        });
                        return (
                          <article class={`msg ${out() ? 'out' : 'in'}`} classList={{ fresh: entrance.fresh() }} onAnimationEnd={entrance.finish}
                            data-message={e().ids[0]} data-room-msg={e().msg} data-room-copies={out() ? e().copies.length : undefined}>
                            <Show when={!out()}><span class="who">{props.nameOf(e().sender)}</span></Show>
                            <div class="bubble" data-kind={0}>{e().text}</div>
                            <div class="stamp">
                              <span>{clock(e().timestamp)}</span>
                              <Show when={out() && e().copies.length > 0}>
                                <span data-room-to> · {t('roomTo', e().copies.map((c) => props.nameOf(c.recipient)).join(', '))}</span>
                              </Show>
                            </div>
                            <For each={refusals()}>
                              {(r) => (
                                <p class="hint" data-room-refused={r.peer}>
                                  {props.nameOf(r.peer)}: {r.words} {t('roomPaidNoRetry')}
                                </p>
                              )}
                            </For>
                          </article>
                        );
                      }}
                    </Match>
                    <Match when={item().send}>
                      {(s) => (
                        <div class="artifact room-send" data-room-send>
                          <span class="kind" data-room-send-msat={s().outcomes.reduce((t, o) => t + o.paidMsat, 0)}>
                            {s().outcomes.every((o) => o.state === 'sent')
                              ? roomCostCopy(s().outcomes.map((o) => o.paidMsat), 'paid')
                              : t('roomMessageTotal', fmtAmount(s().outcomes.reduce((t, o) => t + o.paidMsat, 0)))}
                          </span>
                          <ul class="room-legs">
                            <For each={s().outcomes}>
                              {(o) => (
                                <li data-room-leg={o.peer} data-leg-state={o.state}>
                                  <strong>{t('roomToLabel', props.nameOf(o.peer))}</strong>{' '}
                                  <span class="hint" data-room-leg-note>{legOutcome(o)}</span>
                                </li>
                              )}
                            </For>
                          </ul>
                        </div>
                      )}
                    </Match>
                  </Switch>
                </>
              );
            }}
          </For>
        </div>
      </div>

      <form class="composer" data-composer data-room-composer onSubmit={(e) => { e.preventDefault(); openReview(); }}>
        <Show
          when={review()}
          fallback={
            <>
              <ul class="room-legs room-cost" data-room-cost>
                <For each={legs()}>
                  {(l) => (
                    <li data-room-cost-leg={l.peer} data-leg-plan={l.state} data-leg-msat={l.state === 'pay' ? l.msat : ''}>
                      <strong>{props.nameOf(l.peer)}</strong> <span class="hint">{legLine(l)}</span>
                    </li>
                  )}
                </For>
              </ul>
              <div class="composer-main">
                <textarea rows={1} data-room-draft placeholder={t('uiMessage', title())} value={draft()} onInput={(e) => setDraft(e.currentTarget.value)}
                  aria-label={t('roomMessage')} disabled={props.moneyBlocked}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                      e.preventDefault();
                      if (!e.repeat) openReview();
                    }
                  }} />
              </div>
              <div class="composer-bar">
                <div class="cost" data-cost>
                  <span class="label">{t('uiCostToSend')}</span>
                  <Show when={total() !== null} fallback={<span class="sats">…</span>}>
                    <span class="sats" data-cost-msat={total()!}>{estimate() ? '≈ ' : ''}{sats(total()!)}<span class="unit">{satUnit(total()!)}</span></span>
                  </Show>
                  <span class="basis">{legs().some((l) => l.state === 'reading')
                    ? t('roomReadingPrices')
                    : total() === null
                      ? t('roomNoRecipients')
                      : roomCostCopy(legs().flatMap((l) => l.state === 'pay' ? [l.msat] : []), 'pay', legs().every((l) => l.state === 'pay'))}</span>
                </div>
                <button type="submit" class="primary soft money" data-send disabled={!ready()}>{t('uiSend')}</button>
              </div>
            </>
          }
        >
          {(rv) => (
            <div class="pay-review" data-room-review data-review-msat={rv().total}>
              <p class="pay-review-title">{t('roomSendTo', rv().legs.filter((l) => l.state === 'pay').length, rv().legs.length)}</p>
              <p>{roomCostCopy(rv().legs.flatMap((l) => l.state === 'pay' ? [l.msat] : []), 'pay', rv().legs.every((l) => l.state === 'pay'))}</p>
              <blockquote class="pay-review-text" data-review-text>{rv().text}</blockquote>
              <dl>
                <For each={rv().legs}>
                  {(l) => (
                    <>
                      <dt>{props.nameOf(l.peer)}</dt>
                      <dd data-review-leg={l.peer} data-review-leg-msat={l.state === 'pay' ? l.msat : 0}>
                        {l.state === 'pay' ? t('roomAtMost', fmtAmount(l.msat)) : l.state === 'skip' ? l.reason : t('roomSkipped')}
                      </dd>
                    </>
                  )}
                </For>
                <dt>{t('roomTotalAtMost')}</dt>
                <dd data-review-total>{fmtAmount(rv().total)}</dd>
              </dl>
              <div class="composer-bar">
                <button type="button" class="link" data-room-back disabled={busy()} onClick={() => setReview(null)}>{t('uiBack')}</button>
                <span class="basis">{t('roomReviewHint')}</span>
                <button type="button" class="primary soft money" data-room-confirm disabled={busy() || props.moneyBlocked || !props.canSpend} onClick={() => void confirm()}>
                  {t('roomConfirmSend')}
                </button>
              </div>
            </div>
          )}
        </Show>
        <Show when={props.moneyBlocked}><p class="hint" data-room-blocked>{t('roomBlocked')}</p></Show>
        <Show when={!props.moneyBlocked && !props.canSpend}>{props.spendGate}</Show>
      </form>
    </>
  );
}

/**
 * One member's leg after a send, as a sentence. A refusal before payment is
 * the host's own plain sentence (it says nothing was paid).
 */
function legOutcome(o: LegOutcome): string {
  if (o.state === 'failed' && o.paidMsat === 0 && o.note) return o.note;
  const reached = o.principalMsat !== undefined ? t('roomReached', fmtAmount(o.principalMsat)) : '';
  const paid = o.paidMsat > 0 ? ` · ${t(o.state === 'unknown' ? 'roomPossiblyPaid' : 'roomYouPaid', fmtAmount(o.paidMsat), reached)}` : ` · ${t('roomNotCharged')}`;
  return `${t(OUTCOME[o.state])}${paid}${o.note && o.state !== 'sent' ? ` · ${o.note}` : ''}`;
}

/** Only say “each member” when everyone has the same ceiling and nobody is skipped. */
function roomCostCopy(amounts: number[], verb: 'pay' | 'paid', allMembers = true): string {
  const total = fmtAmount(amounts.reduce((sum, n) => sum + n, 0));
  if (allMembers && amounts.length > 0 && amounts.every((n) => n === amounts[0])) {
    return t(verb === 'pay' ? 'roomPayEach' : 'roomPaidEach', fmtAmount(amounts[0]), total);
  }
  return t(verb === 'pay' ? 'roomPayTotal' : 'roomPaidTotal', total);
}
