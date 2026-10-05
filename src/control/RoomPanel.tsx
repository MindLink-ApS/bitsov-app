/**
 * Rooms MVP UI (room.ts): the "New room" picker and a room's thread.
 *
 * Money: Send never pays. It freezes a review of each member's leg at the
 * price shown for them, and only that review's one confirm sends, each leg
 * capped at exactly that price. Any edit, a closed spending window or money
 * going offline withdraws the review. Skipped members are never charged.
 */
import { createEffect, createMemo, createSignal, For, on, Show, Switch, Match, type JSX } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { amount as fmtAmount, clock, day, sats, satUnit } from './format';
import {
  MAX_MEMBERS, newMsgId, planLegs, planTotal, roomChatText, roomRefusalWords, roomThread,
  type LegOutcome, type LegPlan, type LocalRoom, type MemberInfo, type RoomEntry,
} from './room';
import { createMessageEntrance } from './messageEntrance';
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

const OUTCOME: Record<LegOutcome['state'], string> = {
  sent: 'sent',
  skipped: 'skipped',
  refused: 'paid, refused by their node; do not send it again',
  failed: 'not sent',
  undelivered: 'paid, not delivered yet',
  unknown: 'outcome unknown, may have been paid',
  stopped: 'not sent',
};

type Review = { legs: LegPlan[]; total: number; text: string };

export function RoomThread(props: {
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
    l.state === 'pay' ? `${l.estimate ? '≈ ' : ''}${fmtAmount(l.msat)}` : l.state === 'skip' ? l.reason : 'reading price…';

  return (
    <>
      <header class="track-head" data-room-head={props.room.id}>
        <h1 data-room-title>{title()}</h1>
        <div class="sub"><span class="id">You and {others().length} · each message pays each member</span></div>
        <button type="button" class="quiet" data-room-leave onClick={() => setLeaving(true)}>Leave</button>
        <button class="quiet context-toggle" onClick={() => props.onContext()}>Settings</button>
      </header>
      <Show when={leaving()}>
        <div class="approval" data-room-leave-confirm>
          <p>Leave this room? It is hidden on this device only. Nobody is told and nothing is paid; members may keep sending, and their messages stay hidden here.</p>
          <div class="call-actions">
            <button type="button" class="primary soft" data-room-leave-yes onClick={() => { setLeaving(false); props.onLeave(); }}>Leave</button>
            <button type="button" class="soft" data-room-leave-no onClick={() => setLeaving(false)}>Stay</button>
          </div>
        </div>
      </Show>
      <div class="stream" ref={stream} data-stream data-room-stream>
        <div class="chat-column">
          <p class="day" data-room-honesty>
            Each message is a separate paid, end-to-end encrypted message to each member. There is no group key and no moderation.
          </p>
          <Show when={props.earlier}>
            <button type="button" class="link" data-room-earlier disabled={props.loadingEarlier} onClick={() => props.onEarlier()}>
              {props.loadingEarlier ? 'Loading…' : 'Show earlier messages'}
            </button>
          </Show>
          <For each={[...keyedItems().keys()]} fallback={<div class="empty-track"><h2>Nothing here yet</h2><p class="hint">Your first message pays each member their own price.</p></div>}>
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
                          return d?.status === 'rejected' ? [{ peer: c.recipient, words: roomRefusalWords(d.reason) ?? 'Their node refused it.' }] : [];
                        });
                        return (
                          <article class={`msg ${out() ? 'out' : 'in'}`} classList={{ fresh: entrance.fresh() }} onAnimationEnd={entrance.finish}
                            data-message={e().ids[0]} data-room-msg={e().msg} data-room-copies={out() ? e().copies.length : undefined}>
                            <Show when={!out()}><span class="who">{props.nameOf(e().sender)}</span></Show>
                            <div class="bubble" data-kind={0}>{e().text}</div>
                            <div class="stamp">
                              <span>{clock(e().timestamp)}</span>
                              <Show when={out() && e().copies.length > 0}>
                                <span data-room-to> · to {e().copies.map((c) => props.nameOf(c.recipient)).join(', ')}</span>
                              </Show>
                            </div>
                            <For each={refusals()}>
                              {(r) => (
                                <p class="hint" data-room-refused={r.peer}>
                                  {props.nameOf(r.peer)}: {r.words} It was paid; do not send it again.
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
                              : `Your room message · up to ${fmtAmount(s().outcomes.reduce((t, o) => t + o.paidMsat, 0))} in all`}
                          </span>
                          <ul class="room-legs">
                            <For each={s().outcomes}>
                              {(o) => (
                                <li data-room-leg={o.peer} data-leg-state={o.state}>
                                  <strong>To {props.nameOf(o.peer)}:</strong>{' '}
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
                <textarea rows={1} data-room-draft placeholder={`Message ${title()}`} value={draft()} onInput={(e) => setDraft(e.currentTarget.value)}
                  aria-label="Room message" disabled={props.moneyBlocked}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                      e.preventDefault();
                      if (!e.repeat) openReview();
                    }
                  }} />
              </div>
              <div class="composer-bar">
                <div class="cost" data-cost>
                  <span class="label">Cost to send</span>
                  <Show when={total() !== null} fallback={<span class="sats">…</span>}>
                    <span class="sats" data-cost-msat={total()!}>{estimate() ? '≈ ' : ''}{sats(total()!)}<span class="unit">{satUnit(total()!)}</span></span>
                  </Show>
                  <span class="basis">{legs().some((l) => l.state === 'reading')
                    ? 'Reading member prices…'
                    : total() === null
                      ? 'No members can receive this message right now'
                      : roomCostCopy(legs().flatMap((l) => l.state === 'pay' ? [l.msat] : []), 'pay', legs().every((l) => l.state === 'pay'))}</span>
                </div>
                <button type="submit" class="primary soft money" data-send disabled={!ready()}>Send</button>
              </div>
            </>
          }
        >
          {(rv) => (
            <div class="pay-review" data-room-review data-review-msat={rv().total}>
              <p class="pay-review-title">Send to {rv().legs.filter((l) => l.state === 'pay').length} of {rv().legs.length}</p>
              <p>{roomCostCopy(rv().legs.flatMap((l) => l.state === 'pay' ? [l.msat] : []), 'pay', rv().legs.every((l) => l.state === 'pay'))}</p>
              <blockquote class="pay-review-text" data-review-text>{rv().text}</blockquote>
              <dl>
                <For each={rv().legs}>
                  {(l) => (
                    <>
                      <dt>{props.nameOf(l.peer)}</dt>
                      <dd data-review-leg={l.peer} data-review-leg-msat={l.state === 'pay' ? l.msat : 0}>
                        {l.state === 'pay' ? `at most ${fmtAmount(l.msat)}` : l.state === 'skip' ? l.reason : 'skipped'}
                      </dd>
                    </>
                  )}
                </For>
                <dt>Total at most</dt>
                <dd data-review-total>{fmtAmount(rv().total)}</dd>
              </dl>
              <div class="composer-bar">
                <button type="button" class="link" data-room-back disabled={busy()} onClick={() => setReview(null)}>Back</button>
                <span class="basis">One member at a time, each at most the price above. A member whose price went up is not sent to.</span>
                <button type="button" class="primary soft money" data-room-confirm disabled={busy() || props.moneyBlocked || !props.canSpend} onClick={() => void confirm()}>
                  Confirm and send
                </button>
              </div>
            </div>
          )}
        </Show>
        <Show when={props.moneyBlocked}><p class="hint" data-room-blocked>Payments are not ready yet, so this room cannot send.</p></Show>
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
  const reached = o.principalMsat !== undefined ? ` (${fmtAmount(o.principalMsat)} to them, plus a network fee)` : '';
  const paid = o.paidMsat > 0 ? ` · ${o.state === 'unknown' ? 'possibly paid' : 'you paid'} up to ${fmtAmount(o.paidMsat)}${reached}` : ' · not charged';
  return `${OUTCOME[o.state]}${paid}${o.note && o.state !== 'sent' ? ` · ${o.note}` : ''}`;
}

/** Only say “each member” when everyone has the same ceiling and nobody is skipped. */
function roomCostCopy(amounts: number[], verb: 'pay' | 'paid', allMembers = true): string {
  const total = fmtAmount(amounts.reduce((sum, n) => sum + n, 0));
  if (allMembers && amounts.length > 0 && amounts.every((n) => n === amounts[0])) {
    return `You ${verb} up to ${fmtAmount(amounts[0])} to each member (${total} in all)`;
  }
  return `You ${verb} up to ${total} in all, at each recipient’s own price`;
}
