import { createEffect, createMemo, createSignal, For, type JSX, Match, on, onCleanup, Show, Switch } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { qrSvg } from '../qr';
import type { Proposal } from './ai';
import { AiTrack, createAiSession } from './AiTrack';
import { clock, day, sats, satsWhole, satUnit, shortId, uptime } from './format';
import type { Source } from './source';
import {
  ADMISSION_MAX_MSAT,
  applyDelivery,
  applyLive,
  asActionError,
  budgetStand,
  costToSend,
  deliveryFromReceipt,
  freshness,
  isBudgetStop,
  isOutgoing,
  mergeMessages,
  messagesWorth,
  needsApproval,
  nodePill,
  peerName,
  sentMessage,
  spendLine,
  streamItems,
  trackKey,
  type BudgetStand as BudgetStandT,
  type Deliveries,
  type Threads,
  type Unread,
} from './state';
import type {
  ActionError,
  Artifact,
  BudgetPreset,
  BudgetRow,
  BudgetView,
  Delivery,
  LinkState,
  Message,
  NodeOverview,
  Peer,
  PresetId,
  PriceQuote,
  Room,
  RoomQuote,
  SpendView,
  TrackRef,
  WalletOverview,
} from './types';

/** How often each panel re-reads while the shell is open. Peers and balance have no live event. */
const REFRESH_MS = { overview: 10_000, peers: 15_000, wallet: 20_000, rooms: 30_000, clock: 5_000, spend: 3_000 } as const;

type Props = {
  source: Source;
  /** Node running and the local-trust disclosure accepted: the shell may read. */
  active: boolean;
  ready: boolean;
  error: string | null;
  ownId: string | null;
  /** First-run content shown in the centre until `active`. */
  firstRun: JSX.Element;
  /** Receive / fund UI for the Wallet panel. */
  fund?: JSX.Element;
};

/** A draft the AI track prepared for one peer's composer. Applied once. */
export type Prefill = {
  seq: number;
  key: string;
  mode: 'message' | 'pay' | 'request';
  text: string;
  sats: number | null;
};

/** The result of one action: its value, or why it did not happen. */
type Outcome<T> = { ok: true; value: T } | { ok: false; error: ActionError };

/**
 * What the conversation can do. Messages pay inside the owner's budget; every
 * other spending call is refused by the host outside the ten-minute window.
 */
export type Actions = {
  approve: () => Promise<void>;
  lock: () => Promise<void>;
  reconcile: () => Promise<Outcome<string>>;
  /** The owner's one approval for a daily total (B2). */
  approveBudget: (ceilingMsat: number, preset: PresetId) => Promise<void>;
  setBudget: (target: string, room: boolean, limitMsat: number) => Promise<Outcome<unknown>>;
  pauseAll: () => Promise<void>;
  resume: () => Promise<void>;
  send: (t: TrackRef, text: string, maxMsat: number, firstContactMsat?: number) => Promise<Outcome<unknown>>;
  invoice: (t: TrackRef, sats: number, note: string) => Promise<Outcome<unknown>>;
  amountOf: (bolt11: string) => Promise<Outcome<number>>;
  pay: (t: TrackRef, bolt11: string, msat: number) => Promise<Outcome<unknown>>;
  keysend: (t: TrackRef, pubkey: string, msat: number, memo: string) => Promise<Outcome<unknown>>;
  file: (t: TrackRef, file: File, maxMsat: number) => Promise<Outcome<unknown>>;
};

let artifactSeq = 0;

/** An artifact before it has an id; `at` defaults to now. Distributes over the union. */
type NewArtifact = Artifact extends infer A ? (A extends Artifact ? Omit<A, 'id' | 'at'> & { at?: number } : never) : never;

export function ControlCenter(props: Props) {
  const [now, setNow] = createSignal(Date.now());
  const [overview, setOverview] = createSignal<NodeOverview | null>(null);
  const [peers, setPeers] = createSignal<Peer[]>([]);
  const [rooms, setRooms] = createSignal<Room[]>([]);
  const [members, setMembers] = createStore<Record<string, string[]>>({});
  const [wallet, setWallet] = createSignal<WalletOverview | null>(null);
  const [link, setLink] = createSignal<LinkState | null>(null);
  const [threads, setThreads] = createStore<{ t: Threads; unread: Unread; fresh: Record<string, true> }>({ t: {}, unread: {}, fresh: {} });
  const [track, setTrack] = createSignal<TrackRef | null>(null);
  const [quote, setQuote] = createSignal<PriceQuote | null>(null);
  const [roomQuote, setRoomQuote] = createSignal<RoomQuote | null>(null);
  const [filePrice, setFilePrice] = createSignal<number | null>(null);
  const [spend, setSpend] = createSignal<SpendView | null>(null);
  const [budget, setBudget] = createSignal<BudgetView | null>(null);
  const [deliveries, setDeliveries] = createStore<Deliveries>({});
  /** What each send actually paid, by message id: a room echo carries one member's share only. */
  const [paid, setPaid] = createStore<Record<string, number>>({});
  const [artifacts, setArtifacts] = createStore<Record<string, Artifact[]>>({});
  const [errors, setErrors] = createStore<Record<string, string | undefined>>({});
  const [contextOpen, setContextOpen] = createSignal(false);
  const [tab, setTab] = createSignal<'node' | 'wallet' | 'budget'>('node');
  const aiSession = createAiSession();
  const [prefill, setPrefill] = createSignal<Prefill | null>(null);
  let prefillSeq = 0;
  /** The AI track's proposal: open that peer's composer with it filled in. Nothing is sent. */
  const openDraft = (p: Proposal) => {
    const key = trackKey({ kind: 'peer', id: p.peer });
    setPrefill({
      seq: ++prefillSeq,
      key,
      mode: p.kind,
      text: p.kind === 'message' ? p.text : p.kind === 'request' ? p.note : '',
      sats: p.kind === 'message' ? null : p.sats,
    });
    setTrack({ kind: 'peer', id: p.peer });
  };

  const ownId = () => props.ownId ?? overview()?.node_id ?? '';
  const peerById = createMemo(() => new Map(peers().map((p) => [p.node_id.toLowerCase(), p])));
  const openKey = () => (track() ? trackKey(track()!) : null);

  const attempt = async <T,>(area: string, run: () => Promise<T>, apply: (v: T) => void) => {
    try {
      apply(await run());
      setErrors(area, undefined);
    } catch (e) {
      setErrors(area, typeof e === 'string' ? e : asActionError(e).message);
    }
  };
  const loadOverview = () => attempt('overview', () => props.source.nodeOverview(), setOverview);
  const loadPeers = () => attempt('peers', () => props.source.peers(), setPeers);
  const loadRooms = () => attempt('rooms', () => props.source.rooms(), setRooms);
  const loadWallet = () => attempt('wallet', () => props.source.wallet(), setWallet);
  const loadSpend = () => attempt('spend', () => props.source.spendStatus(), setSpend);
  const loadBudget = () => attempt('budget', () => props.source.budgetStatus(), setBudget);
  const loadThread = (t: TrackRef) => {
    if (t.kind !== 'peer' && t.kind !== 'room') return;
    const key = trackKey(t);
    void attempt('thread', () => props.source.messages(t.id), (page) =>
      setThreads('t', key, (old) => mergeMessages(old ?? [], page)),
    );
  };

  const clockTimer = setInterval(() => setNow(Date.now()), REFRESH_MS.clock);
  let timers: ReturnType<typeof setInterval>[] = [];
  let unlisten: (() => void) | undefined;
  // Bumped on every stop so a subscription that resolves late is closed at once.
  let generation = 0;
  const stop = () => {
    generation += 1;
    timers.forEach(clearInterval);
    timers = [];
    unlisten?.();
    unlisten = undefined;
  };

  // Memoised: the host poll hands App a fresh status object every 1.5 s, and
  // the subscription must restart only when `active` actually flips.
  const active = createMemo(() => props.active);
  createEffect(
    on(active, (active) => {
        stop();
        if (!active) return;
        const mine = generation;
        void loadOverview();
        void loadPeers().then(() => {
          if (!track()) {
            const first = peers().find((p) => p.connected) ?? peers()[0];
            if (first) setTrack({ kind: 'peer', id: first.node_id.toLowerCase() });
          }
        });
        void loadRooms();
        void loadWallet();
        void loadSpend().then(loadBudget);
        timers.push(
          setInterval(() => void loadOverview(), REFRESH_MS.overview),
          setInterval(() => void loadPeers(), REFRESH_MS.peers),
          setInterval(() => void loadWallet(), REFRESH_MS.wallet),
          setInterval(() => void loadRooms(), REFRESH_MS.rooms),
          // Cheap: the host asks the node only while an elevation request is pending,
          // and a budget grant lands there first.
          setInterval(() => void loadSpend().then(loadBudget), REFRESH_MS.spend),
        );
        props.source
          .onLive((event) => {
            if (event.type === 'link') {
              setLink(event.state);
              // Back after a gap: re-read the open track so nothing is missed.
              if (event.state === 'open' && track()) loadThread(track()!);
              return;
            }
            if (event.type === 'delivery') {
              const next = applyDelivery(deliveries, event);
              if (next !== deliveries) setDeliveries(event.message_id, next[event.message_id]);
              return;
            }
            const next = applyLive(threads.t, threads.unread, openKey(), event, ownId());
            if (!next.key) return;
            setThreads(
              produce((s) => {
                s.t = next.threads;
                s.unread = next.unread;
                if (event.type === 'message') s.fresh[event.message.id] = true;
              }),
            );
          })
          .then((off) => {
            if (mine !== generation) {
              off();
              return null;
            }
            unlisten = off;
            // The link state comes from the host's socket, replayed on the channel
            // just subscribed: the bridge usually opened before this shell mounted.
            return props.source.liveLink();
          })
          .catch((e) => setErrors('live', String(e)));
    }),
  );

  // Opening a track: clear its unread count, load history, quote its cost.
  createEffect(
    on(track, (t) => {
      if (!t || !props.active) return;
      setThreads('unread', trackKey(t), 0);
      setQuote(null);
      setRoomQuote(null);
      loadThread(t);
      if (t.kind === 'peer') {
        void attempt('quote', () => props.source.priceQuote(t.id), (q) => {
          if (track() && trackKey(track()!) === trackKey(t)) setQuote(q);
        });
        if (filePrice() === null) void attempt('quote', () => props.source.filePrice(), setFilePrice);
      }
      if (t.kind === 'room') {
        void attempt('quote', () => props.source.roomQuote(t.id), (q) => {
          if (track() && trackKey(track()!) === trackKey(t)) setRoomQuote(q);
        });
        void attempt('members', () => props.source.roomMembers(t.id), (m) => setMembers(t.id, m));
      }
      setContextOpen(false);
    }),
  );

  onCleanup(() => {
    clearInterval(clockTimer);
    stop();
  });

  // ---- actions ------------------------------------------------------------

  const addArtifact = (t: TrackRef, artifact: NewArtifact) => {
    const key = trackKey(t);
    const full = { id: `local-${artifactSeq++}`, at: artifact.at ?? Date.now(), ...artifact } as Artifact;
    setArtifacts(key, (old) => [...(old ?? []), full]);
  };

  /** Run one action. An approval error re-reads the window; the caller shows the rest. */
  const act = async <T,>(run: () => Promise<T>): Promise<Outcome<T>> => {
    try {
      return { ok: true, value: await run() };
    } catch (e) {
      const error = asActionError(e);
      if (needsApproval(error) || error.code === 'spend_refused' || error.code === 'grant_ended') void loadSpend();
      return { ok: false, error };
    }
  };
  /** A failed action that is not an approval or budget question stays in the track as a record. */
  const recordFailure = (t: TrackRef, action: string, outcome: Outcome<unknown>) => {
    if (!outcome.ok && !needsApproval(outcome.error) && !isBudgetStop(outcome.error)) {
      addArtifact(t, { type: 'failed', action: outcome.error.code === 'spend_unknown' ? 'Outcome unknown / pending' : action, error: outcome.error });
    }
    return outcome;
  };

  const actions: Actions = {
    approve: async () => {
      const r = await act(() => props.source.spendRequest());
      if (r.ok) setSpend(r.value);
      else setErrors('spend', r.error.message);
    },
    lock: async () => {
      const r = await act(() => props.source.spendLock());
      if (r.ok) setSpend(r.value);
    },
    reconcile: () => act(() => props.source.spendReconcile()),
    approveBudget: async (ceilingMsat, preset) => {
      const r = await act(() => props.source.budgetApprove(ceilingMsat, preset));
      if (r.ok) {
        setBudget(r.value);
        setErrors('budget', undefined);
      } else setErrors('budget', r.error.message);
      // A paired node asks its owner: the pending request shows from the spend view.
      void loadSpend();
    },
    setBudget: async (target, room, limitMsat) => {
      const r = await act(() => props.source.budgetSet(target, room, limitMsat));
      if (r.ok) setBudget(r.value);
      return r;
    },
    pauseAll: async () => {
      const r = await act(() => props.source.budgetPause());
      if (r.ok) setBudget(r.value);
      else setErrors('budget', r.error.message);
      void loadSpend();
    },
    resume: async () => {
      const r = await act(() => props.source.budgetResume());
      if (r.ok) {
        setBudget(r.value);
        setErrors('budget', undefined);
      } else {
        setErrors('budget', r.error.message);
        void loadBudget();
      }
      void loadSpend();
    },
    send: async (t, text, maxMsat, firstContactMsat) => {
      if (t.kind !== 'peer' && t.kind !== 'room') return { ok: false, error: { code: 'invalid', message: 'nothing to send to' } };
      const r = await act(() => props.source.send(t.id, t.kind === 'room', text, maxMsat, t.kind === 'room' ? Object.fromEntries((roomQuote()?.members ?? []).map((m) => [m.node_id, m.msat])) : undefined, firstContactMsat));
      // The tally moved, or a budget rule stopped the send: either way, re-read it.
      if (r.ok || isBudgetStop(r.error) || r.error.code === 'spend_unknown') void loadBudget();
      if (!r.ok && ['price_changed', 'price_cap_exceeded'].includes(r.error.code)) {
        if (t.kind === 'peer') void attempt('quote', () => props.source.priceQuote(t.id), (q) => {
          if (track() && trackKey(track()!) === trackKey(t)) setQuote(q);
        });
        else void attempt('quote', () => props.source.roomQuote(t.id), (q) => {
          if (track() && trackKey(track()!) === trackKey(t)) setRoomQuote(q);
        });
      }
      if (r.ok) {
        const receipt = r.value;
        setPaid(receipt.message_id, receipt.amount_msat);
        if (!deliveries[receipt.message_id]) setDeliveries(receipt.message_id, deliveryFromReceipt(receipt));
        setThreads('t', trackKey(t), (old) => mergeMessages(old ?? [], [sentMessage(receipt, ownId(), text)]));
        setThreads('fresh', receipt.message_id, true);
      }
      return recordFailure(t, !r.ok && r.error.code === 'room_partial' ? 'Room send incomplete' : 'Message not sent', r);
    },
    invoice: async (t, amount, note) => {
      const r = await act(() => props.source.invoiceCreate(Math.round(amount * 1000), note));
      if (r.ok) addArtifact(t, { type: 'invoice', invoice: r.value });
      return r;
    },
    amountOf: async (bolt11) => {
      const r = await act(() => props.source.invoiceAmount(bolt11));
      return r.ok ? { ok: true, value: r.value.amount_msat } : r;
    },
    pay: async (t, bolt11, msat) => {
      const r = await act(() => props.source.pay(bolt11, msat, msat));
      if (r.ok) {
        addArtifact(t, { type: 'payment', receipt: r.value, at: r.value.paid_at_ms });
        void loadWallet();
      }
      return recordFailure(t, 'Payment not sent', r);
    },
    keysend: async (t, pubkey, msat, memo) => {
      const r = await act(() => props.source.keysend(pubkey, msat, memo.trim() || null, msat));
      if (r.ok) {
        addArtifact(t, { type: 'payment', receipt: r.value, at: r.value.paid_at_ms });
        void loadWallet();
      }
      return recordFailure(t, 'Payment not sent', r);
    },
    file: async (t, file, maxMsat) => {
      if (t.kind !== 'peer') return { ok: false, error: { code: 'invalid', message: 'Files go to one peer at a time.' } };
      const data = await readBase64(file).catch(() => null);
      if (data === null) return { ok: false, error: { code: 'invalid', message: 'the file could not be read' } };
      const r = await act(() => props.source.fileSend(t.id, file.name, file.type, data, maxMsat));
      if (!r.ok && ['price_changed', 'price_cap_exceeded'].includes(r.error.code)) void attempt('quote', () => props.source.filePrice(), setFilePrice);
      if (r.ok) {
        setPaid(r.value.message_id, r.value.amount_msat);
        if (!deliveries[r.value.message_id]) setDeliveries(r.value.message_id, deliveryFromReceipt(r.value));
        addArtifact(t, { type: 'file', receipt: r.value, at: r.value.sent_at_ms });
      }
      return recordFailure(t, 'File not sent', r);
    },
  };

  const pill = () =>
    nodePill({ ready: props.ready, error: props.error, overview: overview(), link: link(), nowMs: now() });

  const trackName = (t: TrackRef): string => {
    if (t.kind === 'peer') return peerName(peerById().get(t.id), t.id);
    if (t.kind === 'room') return rooms().find((r) => r.id.toLowerCase() === t.id)?.name ?? 'Room';
    return t.kind === 'ai' ? 'AI' : 'Start something';
  };
  const nameOf = (id: string) => (id.toLowerCase() === ownId().toLowerCase() ? 'You' : peerName(peerById().get(id.toLowerCase()), id));

  return (
    <div class="cc" classList={{ 'no-context': !props.active }} data-mode={props.source.mode}>
      <Rail
        pill={pill()}
        active={props.active}
        sample={props.source.mode === 'sample'}
        peers={peers()}
        rooms={rooms()}
        unread={threads.unread}
        openKey={openKey()}
        onOpen={setTrack}
        onPill={() => {
          setTab('node');
          setContextOpen(true);
        }}
      />

      <Show when={props.active} fallback={<section class="track">{props.firstRun}</section>}>
        <section class="track" aria-label="Track">
          <Show when={track()} fallback={<div class="empty-track"><h2>No tracks yet</h2><p class="hint">Peers and rooms your node knows appear on the left.</p></div>}>
            {(t) => (
              <Switch>
                <Match when={t().kind === 'ai'}>
                  <AiTrack
                    source={props.source}
                    session={aiSession}
                    peers={peers()}
                    now={now()}
                    onPrefill={openDraft}
                    onContext={() => setContextOpen(true)}
                    head={(title, sub) => <TrackHead title={title} sub={sub} onContext={() => setContextOpen(true)} />}
                  />
                </Match>
                <Match when={t().kind === 'new'}>
                  <NewTrack
                    ownId={ownId()}
                    source={props.source}
                    spend={spend()}
                    now={now()}
                    actions={actions}
                    spendError={errors.spend}
                    onContext={() => setContextOpen(true)}
                  />
                </Match>
                <Match when={t().kind === 'peer' || t().kind === 'room'}>
                  <Conversation
                    track={t()}
                    name={trackName(t())}
                    peer={t().kind === 'peer' ? peerById().get((t() as { id: string }).id) : undefined}
                    members={t().kind === 'room' ? members[(t() as { id: string }).id] ?? null : null}
                    messages={threads.t[trackKey(t())] ?? []}
                    artifacts={artifacts[trackKey(t())] ?? []}
                    fresh={threads.fresh}
                    deliveries={deliveries}
                    paid={paid}
                    ownId={ownId()}
                    nameOf={nameOf}
                    quote={quote()}
                    roomQuote={roomQuote()}
                    filePrice={filePrice()}
                    spend={spend()}
                    spendError={errors.spend}
                    budget={budget()}
                    budgetError={errors.budget}
                    actions={actions}
                    now={now()}
                    error={errors.thread}
                    prefill={prefill()}
                    onPrefillUsed={() => setPrefill(null)}
                    onContext={() => setContextOpen(true)}
                  />
                </Match>
              </Switch>
            )}
          </Show>
        </section>

        <aside class="context" classList={{ open: contextOpen() }} aria-label="Node and wallet">
          <div class="row">
            <div class="tabs" role="tablist" style={{ flex: 1 }}>
              <button role="tab" aria-selected={tab() === 'node'} onClick={() => setTab('node')}>Node</button>
              <button role="tab" aria-selected={tab() === 'wallet'} onClick={() => setTab('wallet')}>Wallet</button>
              <button role="tab" aria-selected={tab() === 'budget'} data-tab="budget" onClick={() => setTab('budget')}>Budget</button>
            </div>
            <button class="quiet context-toggle" onClick={() => setContextOpen(false)} aria-label="Close panel">Close</button>
          </div>
          <Switch>
            <Match when={tab() === 'node'}>
              <NodePanel overview={overview()} link={link()} peers={peers()} now={now()} error={errors.overview ?? errors.peers} />
            </Match>
            <Match when={tab() === 'wallet'}>
              <WalletPanel wallet={wallet()} error={errors.wallet} fund={props.fund} />
            </Match>
            <Match when={tab() === 'budget'}>
              <BudgetPanel
                budget={budget()}
                error={errors.budget}
                now={now()}
                nameOf={(id, room) => (room ? rooms().find((r) => r.id.toLowerCase() === id)?.name ?? 'Room' : nameOf(id))}
                actions={actions}
              />
            </Match>
          </Switch>
        </aside>
      </Show>
    </div>
  );
}

/** Standard base64 of a file's bytes, for the host's `file_send`. */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? '');
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// ---- rail -----------------------------------------------------------------

function Rail(props: {
  pill: ReturnType<typeof nodePill>;
  active: boolean;
  sample: boolean;
  peers: Peer[];
  rooms: Room[];
  unread: Unread;
  openKey: string | null;
  onOpen: (t: TrackRef) => void;
  onPill: () => void;
}) {
  const item = (t: TrackRef, name: string, meta?: JSX.Element) => {
    const key = trackKey(t);
    return (
      <button
        class="track-link"
        data-track={key}
        aria-current={props.openKey === key}
        disabled={!props.active}
        onClick={() => props.onOpen(t)}
      >
        <span class="name">{name}</span>
        <Show when={(props.unread[key] ?? 0) > 0} fallback={meta}>
          <span class="badge" aria-label={`${props.unread[key]} new`}>{props.unread[key]}</span>
        </Show>
      </button>
    );
  };

  return (
    <nav class="rail" aria-label="Tracks">
      <div class="mark">
        Bit<span>Sov</span>
      </div>
      <button class="node-pill" data-pill={props.pill.tone} onClick={() => props.onPill()} disabled={!props.active}>
        <span class={`dot ${props.pill.tone}`} classList={{ live: props.pill.live }} />
        <span class="what">{props.pill.text}</span>
        <Show when={props.active}>
          <span class="peers" title="Connected peers">{props.peers.filter((p) => p.connected).length}/{props.peers.length}</span>
        </Show>
      </button>

      <div class="track-group">
        <h2>Peers</h2>
        <Show when={props.active} fallback={<p class="track-empty">Available after setup</p>}>
          <For each={props.peers} fallback={<p class="track-empty">No peers yet</p>}>
            {(p) =>
              item({ kind: 'peer', id: p.node_id.toLowerCase() }, peerName(p, p.node_id), <span class={`dot ${p.connected ? 'ok' : ''}`} title={p.connected ? 'Connected' : 'Offline'} />)
            }
          </For>
        </Show>
      </div>

      <div class="track-group">
        <h2>Rooms</h2>
        <Show when={props.active}>
          <For each={props.rooms} fallback={<p class="track-empty">No rooms yet</p>}>
            {(r) => item({ kind: 'room', id: r.id.toLowerCase() }, r.name)}
          </For>
        </Show>
      </div>

      <div class="track-group">
        <h2>AI</h2>
        <Show when={props.active}>{item({ kind: 'ai' }, 'Ask your node', <span class="meta">local</span>)}</Show>
      </div>

      <div class="rail-foot">
        <Show when={props.active}>
          <button class="track-link new-track" data-track="new" aria-current={props.openKey === 'new'} onClick={() => props.onOpen({ kind: 'new' })}>
            + New
          </button>
        </Show>
        <Show when={props.sample}>
          <span class="mode-tag" data-sample>Sample data, no node</span>
        </Show>
      </div>
    </nav>
  );
}

// ---- tracks ---------------------------------------------------------------

function TrackHead(props: { title: string; sub?: JSX.Element; onContext: () => void }) {
  return (
    <header class="track-head">
      <h1>{props.title}</h1>
      <div class="sub">{props.sub}</div>
      <button class="quiet context-toggle" onClick={() => props.onContext()}>Node and wallet</button>
    </header>
  );
}

function Bolt() {
  return (
    <svg class="bolt" viewBox="0 0 9 12" aria-hidden="true">
      <path d="M5.5 0 0 7h3.5L3 12l6-7.5H5.2z" />
    </svg>
  );
}

function Conversation(props: {
  track: TrackRef;
  name: string;
  peer: Peer | undefined;
  members: string[] | null;
  messages: Message[];
  artifacts: Artifact[];
  fresh: Record<string, true>;
  deliveries: Deliveries;
  paid: Record<string, number>;
  ownId: string;
  nameOf: (id: string) => string;
  quote: PriceQuote | null;
  roomQuote: RoomQuote | null;
  filePrice: number | null;
  spend: SpendView | null;
  spendError: string | undefined;
  budget: BudgetView | null;
  budgetError: string | undefined;
  actions: Actions;
  now: number;
  error: string | undefined;
  prefill: Prefill | null;
  onPrefillUsed: () => void;
  onContext: () => void;
}) {
  let stream: HTMLDivElement | undefined;
  const cost = () =>
    costToSend(props.track, props.quote, {
      name: props.track.kind === 'peer' ? `${props.name}’s` : undefined,
      room: props.roomQuote,
      nowMs: props.now,
    });
  const items = () => streamItems(props.messages, props.artifacts);

  createEffect(
    on(
      () => props.messages.length + props.artifacts.length,
      () => queueMicrotask(() => stream?.scrollTo?.({ top: stream.scrollHeight })),
    ),
  );

  const sub = () =>
    props.track.kind === 'peer' ? (
      <span class="row" style={{ gap: 'var(--s-2)' }}>
        <span class={`dot ${props.peer?.connected ? 'ok' : ''}`} />
        <span class="id" title={(props.track as { id: string }).id}>{shortId((props.track as { id: string }).id)}</span>
      </span>
    ) : (
      <span class="id">
        {props.members === null ? 'Reading members…' : `${props.members.length} members`}
      </span>
    );

  return (
    <>
      <TrackHead title={props.name} sub={sub()} onContext={props.onContext} />
      <div class="stream" ref={stream} data-stream>
        <Show when={props.track.kind === 'room'}>
          <p class="day">Members added here are not notified yet. A room message pays each member their own price, separately.</p>
        </Show>
        <For
          each={items()}
          fallback={
            <div class="empty-track">
              <h2>Nothing here yet</h2>
              <p class="hint">
                {props.track.kind === 'room'
                  ? 'A message here pays each member separately, and reaches each one when their payment settles.'
                  : `Your first message to ${props.name} is a paid first contact: it is admitted when the payment settles.`}
              </p>
            </div>
          }
        >
          {(item, i) => {
            const prev = () => items()[i() - 1];
            const newDay = () => !prev() || day(prev()!.at) !== day(item.at);
            return (
              <>
                <Show when={newDay()}>
                  <p class="day">{day(item.at)}</p>
                </Show>
                <Switch>
                  <Match when={item.type === 'message' && item.message}>
                    {(m) => (
                      <MessageView
                        m={m()}
                        out={isOutgoing(m(), props.ownId)}
                        room={props.track.kind === 'room'}
                        fresh={!!props.fresh[m().id]}
                        delivery={props.deliveries[m().id]}
                        paid={props.paid[m().id]}
                        nameOf={props.nameOf}
                      />
                    )}
                  </Match>
                  <Match when={item.type === 'artifact' && item.artifact}>
                    {(a) => <ArtifactView a={a()} delivery={a().type === 'file' ? props.deliveries[(a() as { receipt: { message_id: string } }).receipt.message_id] : undefined} />}
                  </Match>
                </Switch>
              </>
            );
          }}
        </For>
        <Show when={props.error}>
          <p class="err-note">{props.error}</p>
        </Show>
      </div>

      <Composer
        track={props.track}
        name={props.name}
        cost={cost()}
        roomQuote={props.roomQuote}
        filePrice={props.filePrice}
        firstContact={props.track.kind === 'peer' && props.messages.length === 0}
        spend={props.spend}
        spendError={props.spendError}
        budget={props.budget}
        budgetError={props.budgetError}
        actions={props.actions}
        nameOf={props.nameOf}
        now={props.now}
        prefill={props.prefill}
        onPrefillUsed={props.onPrefillUsed}
      />
    </>
  );
}

function MessageView(props: {
  m: Message;
  out: boolean;
  room: boolean;
  fresh: boolean;
  delivery: Delivery | undefined;
  paid: number | undefined;
  nameOf: (id: string) => string;
}) {
  const amount = () => props.paid ?? props.m.payment_amount_msat;
  return (
    <article class={`msg ${props.out ? 'out' : 'in'}`} classList={{ fresh: props.fresh }} data-message={props.m.id}>
      <Show when={!props.out && props.room}>
        <span class="who">{props.nameOf(props.m.sender)}</span>
      </Show>
      <div class="bubble">{props.m.plaintext ?? 'Encrypted content not available on this device'}</div>
      <div class="stamp">
        <Show when={amount()}>
          <Bolt />
          <span class="sats">{sats(amount()!)}</span>
          <span>{satUnit(amount()!)} {props.out ? 'paid' : 'to you'}</span>
        </Show>
        <span>{clock(props.m.timestamp)}</span>
        <Show when={props.out && props.delivery}>
          <DeliveryMark d={props.delivery!} />
        </Show>
      </div>
    </article>
  );
}

const DELIVERY_TEXT: Record<Delivery['status'], string> = {
  sent: 'sent, waiting for their node',
  queued: 'queued until they reconnect',
  delivered: 'delivered',
  rejected: 'rejected',
};

function DeliveryMark(props: { d: Delivery }) {
  return (
    <span class="delivery" data-delivery={props.d.status}>
      {DELIVERY_TEXT[props.d.status]}
      <Show when={props.d.reason}>: {props.d.reason}</Show>
    </span>
  );
}

function ArtifactView(props: { a: Artifact; delivery?: Delivery }) {
  return (
    <Switch>
      <Match when={props.a.type === 'invoice' && props.a}>
        {(a) => {
          const inv = () => (a() as Extract<Artifact, { type: 'invoice' }>).invoice;
          const qr = createMemo(() => {
            try {
              return qrSvg(inv().bolt11.toUpperCase());
            } catch {
              return null;
            }
          });
          return (
            <div class="artifact out" data-artifact="invoice">
              <span class="kind">Invoice · you receive</span>
              <span class="sats big">{sats(inv().amount_msat)} <span class="unit">{satUnit(inv().amount_msat)}</span></span>
              <Show when={inv().note}>
                <span class="hint">{inv().note}</span>
              </Show>
              <Show when={qr()}>
                <svg class="qr" viewBox={`0 0 ${qr()!.extent} ${qr()!.extent}`} shape-rendering="crispEdges" role="img" aria-label="Invoice as a QR code">
                  <rect width={qr()!.extent} height={qr()!.extent} fill="#ffffff" />
                  <path d={qr()!.path} fill="#000000" />
                </svg>
              </Show>
              <code class="address" data-bolt11>{inv().bolt11}</code>
              <span class="hint">Expires at {clock(inv().expires_at_ms)}. Paying it sends sats to your node.</span>
            </div>
          );
        }}
      </Match>
      <Match when={props.a.type === 'payment' && props.a}>
        {(a) => {
          const r = () => (a() as Extract<Artifact, { type: 'payment' }>).receipt;
          return (
            <div class="artifact out" data-artifact="payment" data-status={r().status}>
              <span class="kind">Payment · {r().method === 'keysend' ? 'direct (keysend)' : 'invoice'}</span>
              <span class="stamp">
                <Bolt />
                <span class="sats">{sats(r().amount_msat)}</span>
                <span>{satUnit(r().amount_msat)} paid · {r().status} · {clock(r().paid_at_ms)}</span>
              </span>
            </div>
          );
        }}
      </Match>
      <Match when={props.a.type === 'file' && props.a}>
        {(a) => {
          const r = () => (a() as Extract<Artifact, { type: 'file' }>).receipt;
          return (
            <div class="artifact out" data-artifact="file">
              <span class="kind">File</span>
              <span class="file-name">{r().filename} <span class="hint">{kb(r().size_bytes)}</span></span>
              <span class="stamp">
                <Bolt />
                <span class="sats">{sats(r().amount_msat)}</span>
                <span>{satUnit(r().amount_msat)} paid · {clock(r().sent_at_ms)}</span>
                <Show when={props.delivery}>
                  <DeliveryMark d={props.delivery!} />
                </Show>
              </span>
            </div>
          );
        }}
      </Match>
      <Match when={props.a.type === 'failed' && props.a}>
        {(a) => {
          const f = () => a() as Extract<Artifact, { type: 'failed' }>;
          return (
            <div class="artifact out failed" data-artifact="failed" data-code={f().error.code}>
              <span class="kind">{f().action}</span>
              <span>{f().error.message}</span>
            </div>
          );
        }}
      </Match>
    </Switch>
  );
}

const kb = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`);

type Mode = 'message' | 'pay' | 'request' | 'file';

function Composer(props: {
  track: TrackRef;
  name: string;
  cost: ReturnType<typeof costToSend>;
  roomQuote: RoomQuote | null;
  filePrice: number | null;
  firstContact: boolean;
  spend: SpendView | null;
  spendError: string | undefined;
  budget?: BudgetView | null;
  budgetError?: string;
  actions: Actions;
  nameOf: (id: string) => string;
  now: number;
  prefill?: Prefill | null;
  onPrefillUsed?: () => void;
}) {
  const [mode, setMode] = createSignal<Mode>('message');
  // B2: the owner's pick of starting preset, and of a first contact's budget.
  const [presetPick, setPresetPick] = createSignal<PresetId | null>(null);
  const [firstPick, setFirstPick] = createSignal<number | null>(null);
  const [drafted, setDrafted] = createSignal(false);
  const [draft, setDraft] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [note, setNote] = createSignal<string | null>(null);
  // pay
  const [payKind, setPayKind] = createSignal<'invoice' | 'keysend'>('invoice');
  const [bolt11, setBolt11] = createSignal('');
  const [invoiceMsat, setInvoiceMsat] = createSignal<number | null>(null);
  const [pubkey, setPubkey] = createSignal('');
  const [amount, setAmount] = createSignal('');
  const [memo, setMemo] = createSignal('');
  // file
  const [file, setFile] = createSignal<File | null>(null);
  let fileInput: HTMLInputElement | undefined;
  // Inputs and navigation remain usable during a send. Only the submitted
  // revision may be cleared by its completion (including track A -> B -> A).
  let composerRevision = 0;

  const room = () => props.track.kind === 'room';
  const modes = (): Mode[] => (room() ? ['message'] : ['message', 'pay', 'request', 'file']);
  // A new track starts in message mode with a clean composer.
  createEffect(
    on(
      () => trackKey(props.track),
      () => {
        composerRevision++;
        setMode('message');
        setNote(null);
        setDraft('');
        setFile(null);
        if (fileInput) fileInput.value = '';
        setBolt11('');
        setInvoiceMsat(null);
        setPubkey('');
        setAmount('');
        setMemo('');
        setDrafted(false);
        setFirstPick(null);
      },
      { defer: true },
    ),
  );
  // A draft from the AI track: fill this composer once. Sending is still the
  // owner's press, with the cost shown and the spend approval unchanged.
  createEffect(
    on(
      () => [props.prefill?.seq, trackKey(props.track)] as const,
      () => {
        const p = props.prefill;
        if (!p || p.key !== trackKey(props.track) || room()) return;
        setMode(p.mode);
        setNote(null);
        if (p.mode === 'message') setDraft(p.text);
        if (p.mode === 'pay') {
          setPayKind('keysend');
          setAmount(p.sats === null ? '' : String(p.sats));
          setMemo('');
        }
        if (p.mode === 'request') {
          setAmount(p.sats === null ? '' : String(p.sats));
          setMemo(p.text);
        }
        setDrafted(true);
        props.onPrefillUsed?.();
      },
    ),
  );

  const line = () => spendLine(props.spend, props.now);
  const spends = () => mode() !== 'request';
  const target = () => (props.track as { id: string }).id;
  const budget = () => props.budget ?? null;
  /**
   * Messages go through the budget unless the owner opened the ten-minute
   * window by hand with no budget approval, or the host has no budget to show.
   */
  const viaBudget = () => {
    const b = budget();
    if (mode() !== 'message' || !b) return false;
    return b.paused || b.waiting_for_owner || b.autopay.state === 'open' || !line().open;
  };
  const stand = () => budgetStand(budget(), target(), room(), shown().msat);
  const presetChosen = () => {
    const b = budget();
    const id = presetPick() ?? b?.preset ?? 'careful';
    return b?.presets.find((p) => p.id === id) ?? b?.presets[0] ?? null;
  };
  const blocked = (): string | null => {
    if (room() && props.roomQuote && props.roomQuote.unreachable.length > 0) {
      const names = props.roomQuote.unreachable.map(props.nameOf).join(', ');
      return `Not every member is a connected peer (${names}). Your node would skip them without telling you, so this room cannot send yet.`;
    }
    return null;
  };

  // Read the invoice amount as it is pasted: the cost is shown before paying.
  createEffect(
    on(bolt11, (text) => {
      setInvoiceMsat(null);
      const value = text.trim();
      if (!value) return;
      void props.actions.amountOf(value).then((r) => {
        if (bolt11().trim() !== value) return;
        if (r.ok) {
          setInvoiceMsat(r.value);
          setNote(null);
        } else setNote(r.error.message);
      });
    }),
  );

  const satsInput = (v: string) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  /** What this mode costs, shown before the button is pressed. */
  const shown = (): { msat: number | null; estimate: boolean; basis: string } => {
    switch (mode()) {
      case 'message': {
        const c = props.cost;
        if (!c) return { msat: null, estimate: false, basis: room() ? 'Reading each member’s price…' : 'Reading their price…' };
        const basis = props.firstContact
          ? `${c.basis}. First contact also pays their admission price once, at most ${sats(ADMISSION_MAX_MSAT)} sats`
          : c.basis;
        return { msat: c.msat, estimate: c.estimate || props.firstContact, basis };
      }
      case 'pay':
        if (payKind() === 'invoice') {
          return invoiceMsat() === null
            ? { msat: null, estimate: false, basis: 'Paste an invoice to see what it asks for' }
            : { msat: invoiceMsat(), estimate: false, basis: 'The amount the invoice asks for, plus any routing fee' };
        }
        return satsInput(amount()) === null
          ? { msat: null, estimate: false, basis: 'Enter an amount' }
          : { msat: Math.round(satsInput(amount())! * 1000), estimate: false, basis: 'Sent directly to that node, plus any routing fee' };
      case 'request':
        return { msat: 0, estimate: false, basis: 'Receiving costs you nothing. The payer’s node pays the fee' };
      case 'file':
        return props.filePrice === null
          ? { msat: null, estimate: false, basis: 'Reading the file price…' }
          : { msat: props.filePrice, estimate: false, basis: 'Your node’s price to send one file' };
    }
  };

  const ready = (): boolean => {
    if (blocked()) return false;
    switch (mode()) {
      case 'message':
        return draft().trim().length > 0 && props.cost !== null;
      case 'pay':
        return payKind() === 'invoice' ? invoiceMsat() !== null : pubkey().trim().length > 0 && satsInput(amount()) !== null;
      case 'request':
        return satsInput(amount()) !== null;
      case 'file':
        return file() !== null && props.filePrice !== null;
    }
  };

  const label = () => {
    if (viaBudget()) {
      const s = shown();
      const price = s.msat === null ? '' : ` · ${s.estimate ? '≈ ' : ''}${sats(s.msat)} ${satUnit(s.msat)}`;
      switch (stand().kind) {
        case 'paused': return 'Resume payments';
        case 'waiting': return 'Waiting for approval';
        case 'off': return 'Approve daily budget';
        case 'first': return `Send first message${price}`;
        case 'contact_used':
        case 'total_used': return 'Budget used up';
        default: return `Send${price}`;
      }
    }
    if (spends() && !line().open) {
      if (props.spend?.state === 'pending') return 'Waiting for approval';
      if (props.spend?.state === 'unavailable') return 'Spending unavailable';
      return 'Approve spending';
    }
    const s = shown();
    const price = s.msat === null ? '' : ` · ${s.estimate ? '≈ ' : ''}${sats(s.msat)} ${satUnit(s.msat)}`;
    return { message: 'Send', pay: 'Pay', request: 'Create invoice', file: 'Send file' }[mode()] + (mode() === 'request' ? '' : price);
  };

  const submit = async () => {
    if (busy()) return;
    setNote(null);
    if (viaBudget()) {
      const st = stand();
      if (st.kind === 'paused' || st.kind === 'off') {
        // The one approval (or resume). The draft stays where it is.
        setBusy(true);
        if (st.kind === 'paused') await props.actions.resume();
        else if (presetChosen()) await props.actions.approveBudget(presetChosen()!.ceiling_msat, presetChosen()!.id);
        setBusy(false);
        return;
      }
      if ((st.kind !== 'first' && st.kind !== 'ok') || !ready()) return;
      setBusy(true);
      const submittedRevision = composerRevision;
      const r = await props.actions.send(props.track, draft(), shown().msat!, st.kind === 'first' ? firstPick() ?? st.suggest : undefined);
      if (r.ok && composerRevision === submittedRevision) {
        setDraft('');
        setDrafted(false);
      } else if (!r.ok && isBudgetStop(r.error)) setNote(r.error.message);
      setBusy(false);
      return;
    }
    if (spends() && !line().open) {
      // The one tap: the draft stays where it is.
      setBusy(true);
      await props.actions.approve();
      setBusy(false);
      return;
    }
    if (!ready()) return;
    setBusy(true);
    const t = props.track;
    const submittedRevision = composerRevision;
    const unchanged = () => composerRevision === submittedRevision;
    let r: Awaited<ReturnType<Actions['send']>>;
    switch (mode()) {
      case 'message':
        r = await props.actions.send(t, draft(), shown().msat!);
        if (r.ok && unchanged()) {
          setDraft('');
          setDrafted(false);
        }
        break;
      case 'pay':
        r =
          payKind() === 'invoice'
            ? await props.actions.pay(t, bolt11().trim(), invoiceMsat()!)
            : await props.actions.keysend(t, pubkey().trim(), Math.round(satsInput(amount())! * 1000), memo());
        if (r.ok && unchanged()) {
          setBolt11('');
          setAmount('');
          setMemo('');
        }
        break;
      case 'request':
        r = await props.actions.invoice(t, satsInput(amount())!, memo());
        if (r.ok && unchanged()) {
          setAmount('');
          setMemo('');
        } else if (!r.ok && unchanged()) setNote(r.error.message);
        break;
      case 'file':
        r = await props.actions.file(t, file()!, shown().msat!);
        if (r.ok && unchanged()) {
          setFile(null);
          if (fileInput) fileInput.value = '';
        }
        break;
    }
    setBusy(false);
  };

  const disabled = () =>
    busy() ||
    (viaBudget()
      ? ['waiting', 'contact_used', 'total_used', 'unknown'].includes(stand().kind) || ((stand().kind === 'first' || stand().kind === 'ok') && !ready())
      : spends() && !line().open
      ? props.spend?.state === 'pending' || props.spend?.state === 'unavailable' || props.spend === null
      : !ready());

  return (
    <form
      class="composer"
      data-composer
      data-mode={mode()}
      onInput={() => { composerRevision++; }}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Show when={modes().length > 1}>
        <div class="modes" role="tablist" aria-label="What to send">
          <For each={modes()}>
            {(m) => (
              <button type="button" role="tab" data-composer-mode={m} aria-selected={mode() === m} onClick={() => { composerRevision++; setMode(m); setNote(null); }}>
                {{ message: 'Message', pay: 'Pay', request: 'Request', file: 'File' }[m]}
              </button>
            )}
          </For>
        </div>
      </Show>

      <Switch>
        <Match when={mode() === 'message'}>
          <textarea
            rows={2}
            placeholder={`Message ${props.name}`}
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit();
              }
            }}
            aria-label={`Message ${props.name}`}
          />
        </Match>
        <Match when={mode() === 'pay'}>
          <div class="fields">
            <div class="modes small" role="tablist" aria-label="How to pay">
              <button type="button" role="tab" aria-selected={payKind() === 'invoice'} onClick={() => { composerRevision++; setPayKind('invoice'); }}>Invoice</button>
              <button type="button" role="tab" aria-selected={payKind() === 'keysend'} onClick={() => { composerRevision++; setPayKind('keysend'); }}>Direct</button>
            </div>
            <Show
              when={payKind() === 'invoice'}
              fallback={
                <>
                  <input data-pay-pubkey placeholder="Their Lightning node pubkey (66 hex)" value={pubkey()} onInput={(e) => setPubkey(e.currentTarget.value)} aria-label="Lightning node pubkey" />
                  <div class="row">
                    <input data-pay-amount inputmode="numeric" placeholder="Sats" value={amount()} onInput={(e) => setAmount(e.currentTarget.value)} aria-label="Amount in sats" />
                    <input placeholder="Note (optional)" value={memo()} onInput={(e) => setMemo(e.currentTarget.value)} aria-label="Note" />
                  </div>
                </>
              }
            >
              <textarea data-pay-invoice rows={2} placeholder={`Paste an invoice from ${props.name}`} value={bolt11()} onInput={(e) => setBolt11(e.currentTarget.value)} aria-label="Lightning invoice" />
            </Show>
          </div>
        </Match>
        <Match when={mode() === 'request'}>
          <div class="row fields">
            <input data-request-amount inputmode="numeric" placeholder="Sats to receive" value={amount()} onInput={(e) => setAmount(e.currentTarget.value)} aria-label="Sats to receive" />
            <input data-request-note placeholder="What it is for (optional)" value={memo()} onInput={(e) => setMemo(e.currentTarget.value)} aria-label="What it is for" />
          </div>
        </Match>
        <Match when={mode() === 'file'}>
          <div class="fields">
            <input ref={fileInput} type="file" data-file-input onChange={(e) => { composerRevision++; setFile(e.currentTarget.files?.[0] ?? null); }} aria-label="File to send" />
            <span class="hint">Up to 1.4 MB. It goes to {props.name} only, end to end encrypted, and pays like a message.</span>
          </div>
        </Match>
      </Switch>

      <div class="composer-bar">
        <div class="cost" data-cost>
          <span class="label">{mode() === 'request' ? 'You receive' : 'Cost to send'}</span>
          <Show when={shown().msat !== null} fallback={<span class="sats">…</span>}>
            <span class="sats" data-cost-msat={shown().msat!}>
              {shown().estimate ? '≈ ' : ''}
              {mode() === 'request' ? sats(Math.round((satsInput(amount()) ?? 0) * 1000)) : sats(shown().msat!)}
              <span class="unit">{mode() === 'request' ? 'sats' : satUnit(shown().msat!)}</span>
            </span>
          </Show>
          <span class="basis" title={shown().basis}>{shown().basis}</span>
        </div>
        <button type="submit" class="primary" disabled={disabled()} data-send>
          {label()}
        </button>
      </div>

      <Show when={drafted()}>
        <p class="drafted" data-drafted>
          Drafted in the AI track. Check it and the cost, then {mode() === 'request' ? 'create the invoice' : 'send it'} yourself.
        </p>
      </Show>
      <Show when={blocked()}>
        <p class="err-note" data-room-blocked>{blocked()}</p>
      </Show>
      <Show when={note()}>
        <p class="err-note" data-composer-note>{note()}</p>
      </Show>
      <Show when={spends()}>
        <Show
          when={viaBudget()}
          fallback={<SpendBar spend={props.spend} error={props.spendError} now={props.now} actions={props.actions} />}
        >
          <BudgetBar
            stand={stand()}
            budget={budget()!}
            spend={props.spend}
            name={props.name}
            room={room()}
            target={target()}
            priceMsat={shown().msat}
            preset={presetChosen()}
            onPreset={setPresetPick}
            firstPick={firstPick()}
            onFirstPick={setFirstPick}
            error={props.budgetError}
            now={props.now}
            actions={props.actions}
          />
        </Show>
      </Show>
    </form>
  );
}

/**
 * The owner's spend window. One tap opens it for ten minutes; it can only
 * narrow what the node allows, never widen it.
 */
function SpendBar(props: { spend: SpendView | null; error: string | undefined; now: number; actions: Actions }) {
  const line = () => spendLine(props.spend, props.now);
  const minutes = (ms: number) => Math.max(1, Math.ceil((ms - props.now) / 60_000));
  return (
    <div class="spend" data-spend={props.spend?.state ?? 'unknown'}>
      <Switch>
        <Match when={props.spend?.state === 'open' && line().open}>
          <p class="spend-line">
            <span class="dot ok" /> {line().text}.{' '}
            {props.spend?.basis === 'app_lock'
              ? 'This node version does not limit app tokens, so this window is the app’s own lock, kept in memory only.'
              : 'Your node’s owner grant is in effect; this app uses it for ten minutes per approval.'}{' '}
            <button type="button" class="link" data-spend-lock onClick={() => void props.actions.lock()}>Lock now</button>
          </p>
        </Match>
        <Match when={props.spend?.state === 'pending' && props.spend.pending}>
          {(p) => (
            <div class="approval" data-approval="pending">
              <p>
                <strong>Confirm at your node.</strong> Your node asks its owner to approve this app spending. Run this where
                your node runs and type the phrase it prints:
              </p>
              <code class="address" data-owner-action>{p().owner_action}</code>
              <p class="hint">
                This app cannot approve it for you. The request lapses in {minutes(p().expires_at_ms)} min. Your draft is kept.
              </p>
            </div>
          )}
        </Match>
        <Match when={props.spend?.state === 'unavailable' && props.spend.pending}>
          {(p) => (
            <div class="approval" data-approval="unavailable">
              <p>
                <strong>This node cannot grant spending to the app.</strong> Receiving still works. Your node says:
              </p>
              <code class="address" data-owner-action>{p().owner_action}</code>
            </div>
          )}
        </Match>
        <Match when={true}>
          <p class="spend-line">
            <span class="dot" /> {line().text}.{' '}
            {props.spend?.state === 'expired'
              ? 'Approve again to keep sending.'
              : 'Sending spends sats from your node. One approval covers the next ten minutes and is never saved.'}
          </p>
        </Match>
      </Switch>
      <Reconcile actions={props.actions} />
      <Show when={props.error}>
        <p class="err-note">{props.error}</p>
      </Show>
    </div>
  );
}

/** Read-only: match an unknown outcome to the node's own records. Never re-sends. */
function Reconcile(props: { actions: Actions }) {
  const [result, setResult] = createSignal<string | null>(null);
  const [checking, setChecking] = createSignal(false);
  const reconcile = async () => {
    if (checking()) return;
    setChecking(true);
    const outcome = await props.actions.reconcile();
    setResult(outcome.ok ? outcome.value : outcome.error.message);
    setChecking(false);
  };
  return (
    <>
      <button type="button" class="link" data-spend-reconcile disabled={checking()} onClick={() => void reconcile()}>
        Check pending result
      </button>
      <Show when={result()}><p class="hint" data-reconciliation>{result()}</p></Show>
    </>
  );
}

/** Whole hours left, never more than the approval window (the shell clock ticks every few seconds). */
const hoursLeft = (untilMs: number | null, nowMs: number, windowMs = 86_400_000) =>
  Math.min(Math.round(windowMs / 3_600_000), Math.max(1, Math.ceil(((untilMs ?? nowMs) - nowMs) / 3_600_000)));

/** A node grant's remaining life: minutes under an hour, else whole hours. */
const timeLeft = (untilMs: number, nowMs: number) => {
  const min = Math.max(1, Math.ceil((untilMs - nowMs) / 60_000));
  return min < 60 ? `${min} min` : `${Math.ceil(min / 60)} h`;
};

const PRESET_NAME: Record<PresetId, string> = { careful: 'Careful', everyday: 'Everyday', generous: 'Generous' };

/**
 * Invisible payments (B2). Inside the owner's budget a message just goes: no
 * prompt, the price still shown, and the node still enforces each message's cap.
 * The bar says where the budget stands and is the only place that asks.
 */
function BudgetBar(props: {
  stand: BudgetStandT;
  budget: BudgetView;
  spend: SpendView | null;
  name: string;
  room: boolean;
  target: string;
  priceMsat: number | null;
  preset: BudgetPreset | null;
  onPreset: (id: PresetId) => void;
  firstPick: number | null;
  onFirstPick: (msat: number) => void;
  error: string | undefined;
  now: number;
  actions: Actions;
}) {
  const worth = (msat: number) => messagesWorth(msat, props.priceMsat);
  const who = () => (props.room ? 'this room' : props.name);
  const firstOptions = (suggest: number, ceiling: number) =>
    [...new Set([suggest, suggest * 2, suggest * 5].map((v) => Math.min(v, ceiling)))].filter((v) => v >= (props.priceMsat ?? 0));
  return (
    <div class="spend budget" data-budget={props.stand.kind}>
      <Switch>
        <Match when={props.stand.kind === 'paused'}>
          <p class="spend-line" data-budget-paused>
            <span class="dot warn" /> <span class="line-text">Payments are paused. Nothing leaves your node until you resume.</span>
          </p>
        </Match>
        <Match when={props.stand.kind === 'waiting'}>
          <div class="approval" data-approval="pending">
            <p>
              <strong>Confirm at your node.</strong> One approval lets messages pay for the next 24 hours, up to your daily total.
              Run this where your node runs and type the phrase it prints:
            </p>
            <Show when={props.spend?.pending}>
              {(p) => <code class="address" data-owner-action>{p().owner_action}</code>}
            </Show>
            <p class="hint">This app cannot approve it for you. Your draft is kept.</p>
          </div>
        </Match>
        <Match when={props.stand.kind === 'off'}>
          <div class="approval budget-setup" data-budget-setup>
            <p>
              <strong>{props.budget.autopay.state === 'expired' ? 'Your daily approval ended.' : 'Let messages pay as you chat.'}</strong>{' '}
              Approve a daily total once. Inside it, each message pays its recipient’s own price with no prompt. Someone new always asks first.
            </p>
            <div class="presets" role="radiogroup" aria-label="Daily total">
              <For each={props.budget.presets}>
                {(p) => (
                  <button
                    type="button"
                    class="chip"
                    role="radio"
                    aria-checked={props.preset?.id === p.id}
                    data-preset={p.id}
                    onClick={() => props.onPreset(p.id)}
                  >
                    {PRESET_NAME[p.id]} · {sats(p.ceiling_msat)} sats a day
                  </button>
                )}
              </For>
            </div>
            <Show when={props.preset}>
              {(p) => (
                <p class="hint">
                  Up to {sats(p().contact_msat)} sats a day per contact and {sats(p().room_msat)} per room, which you can lower any time.
                  Each message still carries its own price cap. The approval lasts 24 hours and is never saved; the budgets and the tally are.
                </p>
              )}
            </Show>
          </div>
        </Match>
        <Match when={props.stand.kind === 'first' && (props.stand as Extract<BudgetStandT, { kind: 'first' }>)}>
          {(st) => (
            <div class="approval budget-first" data-first-contact>
              <p>
                <strong>First paid message to {who()}.</strong> Asked once. After it, messages to {who()} pay automatically, up to:
              </p>
              <div class="presets" role="radiogroup" aria-label={`Daily budget for ${who()}`}>
                <For each={firstOptions(st().suggest, st().ceiling)}>
                  {(msat) => (
                    <button
                      type="button"
                      class="chip"
                      role="radio"
                      aria-checked={(props.firstPick ?? st().suggest) === msat}
                      data-first-budget={msat}
                      onClick={() => props.onFirstPick(msat)}
                    >
                      {sats(msat)} sats a day<Show when={worth(msat)}> · {worth(msat)}</Show>
                    </button>
                  )}
                </For>
              </div>
            </div>
          )}
        </Match>
        <Match when={props.stand.kind === 'contact_used' && (props.stand as Extract<BudgetStandT, { kind: 'contact_used' }>)}>
          {(st) => (
            <div class="approval budget-used" data-budget-used="contact">
              <p>
                <strong>Budget for {who()} used up.</strong> {sats(st().spent)} of {sats(st().limit)} sats in the last 24 hours, and this
                message costs {props.priceMsat === null ? '…' : sats(props.priceMsat)}. It frees up as older payments pass 24 hours.
              </p>
              <Show
                when={st().raiseTo}
                fallback={
                  <p class="hint">
                    This budget already equals your daily total.{' '}
                    <button type="button" class="link" data-budget-raise-total onClick={() => void props.actions.approveBudget(Math.min(props.budget.ceiling_msat * 2, props.budget.max_daily_msat), props.budget.preset)}>
                      Raise the daily total to {sats(Math.min(props.budget.ceiling_msat * 2, props.budget.max_daily_msat))} sats
                    </button>
                  </p>
                }
              >
                {(to) => (
                  <button type="button" class="primary small" data-budget-raise onClick={() => void props.actions.setBudget(props.target, props.room, to())}>
                    Raise to {sats(to())} sats a day
                  </button>
                )}
              </Show>
            </div>
          )}
        </Match>
        <Match when={props.stand.kind === 'total_used' && (props.stand as Extract<BudgetStandT, { kind: 'total_used' }>)}>
          {(st) => (
            <div class="approval budget-used" data-budget-used="total">
              <p>
                <strong>Your daily total is used up.</strong> {sats(st().spent)} of {sats(st().ceiling)} sats in the last 24 hours. Raising
                it is a new approval.
              </p>
              <Show when={st().raiseTo}>
                {(to) => (
                  <button type="button" class="primary small" data-budget-raise-total onClick={() => void props.actions.approveBudget(to(), props.budget.preset)}>
                    Approve {sats(to())} sats a day
                  </button>
                )}
              </Show>
            </div>
          )}
        </Match>
        <Match when={props.stand.kind === 'ok' && (props.stand as Extract<BudgetStandT, { kind: 'ok' }>)}>
          {(st) => (
            <p class="spend-line" data-budget-line>
              <span class="dot ok" />
              <span class="line-text">
                Pays automatically · {sats(st().spent)} of {sats(st().limit)} sats to {who()} in 24 h · approval ends in{' '}
                {hoursLeft(props.budget.autopay.open_until_ms, props.now, props.budget.window_ms)} h ·{' '}
                <button type="button" class="link" data-pause-all onClick={() => void props.actions.pauseAll()}>Pause all</button>
              </span>
            </p>
          )}
        </Match>
      </Switch>
      <Reconcile actions={props.actions} />
      <Show when={props.error}>
        <p class="err-note" data-budget-error>{props.error}</p>
      </Show>
    </div>
  );
}

/**
 * The running tally (context panel): what left in the last 24 hours against the
 * daily total, per contact and room, and the one-tap pause for everything.
 */
function BudgetPanel(props: {
  budget: BudgetView | null;
  error: string | undefined;
  now: number;
  nameOf: (id: string, room: boolean) => string;
  actions: Actions;
}) {
  const [editing, setEditing] = createSignal<string | null>(null);
  const [value, setValue] = createSignal('');
  const [note, setNote] = createSignal<string | null>(null);
  const pct = (spent: number, of: number) => `${Math.min(100, of > 0 ? (spent / of) * 100 : 0).toFixed(1)}%`;
  const save = async (row: BudgetRow) => {
    const n = Number(value());
    if (!Number.isFinite(n) || n < 0) return setNote('Enter a number of sats, or 0 to forget.');
    const r = await props.actions.setBudget(row.target, row.room, Math.round(n * 1000));
    if (r.ok) {
      setEditing(null);
      setNote(null);
    } else setNote(r.error.message);
  };
  const status = (b: BudgetView) => {
    if (b.paused) return 'Paused. Nothing is paid until you resume.';
    if (b.waiting_for_owner) return 'Waiting for your approval at the node.';
    if (b.autopay.state === 'open') return `Paying automatically. The approval ends in ${hoursLeft(b.autopay.open_until_ms, props.now, b.window_ms)} h.`;
    if (b.autopay.state === 'expired') return 'The daily approval ended. Approve again from any conversation.';
    return 'Not approved in this session. Approve a daily total from any conversation.';
  };
  return (
    <div class="panel" data-panel="budget">
      <h2>Budget</h2>
      <Show when={props.budget} fallback={<Show when={!props.error} fallback={<p class="err-note">{props.error}</p>}><div class="spinner" /></Show>}>
        {(b) => (
          <>
            <div class="tally" data-tally>
              <span class="label">Spent in the last 24 hours</span>
              <span class="sats big" data-tally-total>
                {sats(b().spent_msat)} <span class="unit">/ {sats(b().ceiling_msat)} sats</span>
              </span>
              <span class="meter" aria-hidden="true"><span style={{ width: pct(b().spent_msat, b().ceiling_msat) }} /></span>
              <Show when={b().unsettled_msat > 0}>
                <span class="hint" data-unsettled>Includes {sats(b().unsettled_msat)} sats whose outcome is not known yet, counted at their price cap.</span>
              </Show>
              <Show when={b().node_grant}>
                {(g) => (
                  <span class="hint" data-node-grant>
                    Your node allows {sats(g().remaining_msat)} of {sats(g().budget_msat)} sats more, at most {sats(g().per_call_max_msat)} per payment, for {timeLeft(g().expires_at_ms, props.now)}.
                  </span>
                )}
              </Show>
            </div>
            <p class="spend-line" classList={{ paused: b().paused }} data-autopay={b().paused ? 'paused' : b().autopay.state}>
              <span class={`dot ${b().paused ? 'warn' : b().autopay.state === 'open' ? 'ok' : ''}`} /> <span class="line-text">{status(b())}</span>
            </p>
            <Show
              when={b().paused}
              fallback={
                <button type="button" class="pause-all" data-pause-all onClick={() => void props.actions.pauseAll()}>
                  Pause all payments
                </button>
              }
            >
              <button type="button" class="primary" data-resume onClick={() => void props.actions.resume()}>
                Resume payments
              </button>
            </Show>
            <h3>By contact and room</h3>
            <For each={b().rows} fallback={<p class="hint">No one has a budget yet. Your first paid message to someone sets theirs.</p>}>
              {(row) => {
                const key = () => `${row.room ? 'room' : 'peer'}:${row.target}`;
                return (
                  <div class="budget-row" data-budget-row={row.target}>
                    <div class="row" style={{ 'justify-content': 'space-between', gap: 'var(--s-2)' }}>
                      <span class="who">{props.nameOf(row.target, row.room)}</span>
                      <span class="sats" data-row-tally>
                        {sats(row.spent_msat)}
                        <span class="unit">{row.limit_msat === null ? 'sats, approved by hand' : `/ ${sats(row.limit_msat)} sats`}</span>
                      </span>
                    </div>
                    <Show when={row.limit_msat !== null}>
                      <span class="meter" aria-hidden="true"><span style={{ width: pct(row.spent_msat, row.limit_msat!) }} /></span>
                    </Show>
                    <Show
                      when={editing() === key()}
                      fallback={
                        <button type="button" class="link" data-budget-edit onClick={() => { setEditing(key()); setValue(String((row.limit_msat ?? 0) / 1000)); setNote(null); }}>
                          {row.limit_msat === null ? 'Set a budget' : 'Change'}
                        </button>
                      }
                    >
                      <form class="row" onSubmit={(e) => { e.preventDefault(); void save(row); }}>
                        <input inputmode="numeric" value={value()} onInput={(e) => setValue(e.currentTarget.value)} aria-label={`Sats a day for ${props.nameOf(row.target, row.room)}`} data-budget-input />
                        <button type="submit" class="small" data-budget-save>Save</button>
                        <button type="button" class="link" onClick={() => setEditing(null)}>Cancel</button>
                      </form>
                    </Show>
                  </div>
                );
              }}
            </For>
            <Show when={note()}><p class="err-note">{note()}</p></Show>
            <Show when={props.error}><p class="err-note">{props.error}</p></Show>
            <p class="hint">
              A budget can go up to the daily total you approved; raising the total is a new approval. Budgets and this tally are
              saved on this device. Your approval is not: after a restart, approve once more. 0 forgets a contact, so they are asked
              again. Files, invoices and direct payments still ask each time.
            </p>
          </>
        )}
      </Show>
    </div>
  );
}

function NewTrack(props: {
  ownId: string;
  source: Source;
  spend: SpendView | null;
  now: number;
  actions: Actions;
  spendError: string | undefined;
  onContext: () => void;
}) {
  const qr = createMemo(() => {
    try {
      return props.ownId ? qrSvg(props.ownId) : null;
    } catch {
      return null;
    }
  });
  const open = () => spendLine(props.spend, props.now).open;
  const [invitee, setInvitee] = createSignal('');
  const [addr, setAddr] = createSignal('');
  const [hours, setHours] = createSignal(72);
  const [made, setMade] = createSignal<{ link: string; until: number } | null>(null);
  const [token, setToken] = createSignal('');
  const [redeemed, setRedeemed] = createSignal<{ inviter: string; addr: string } | null>(null);
  const [errs, setErrs] = createStore<{ create?: string; redeem?: string }>({});
  const [busy, setBusy] = createSignal(false);

  /** Invites change the node: outside the window the button is the approval. */
  const run = async (which: 'create' | 'redeem', action: () => Promise<void>) => {
    setErrs(which, undefined);
    setBusy(true);
    try {
      if (!open()) await props.actions.approve();
      else await action();
    } catch (e) {
      const err = asActionError(e);
      setErrs(which, err.message);
      if (needsApproval(err)) await props.actions.approve();
    }
    setBusy(false);
  };
  const button = (what: string) =>
    open() ? what : props.spend?.state === 'pending' ? 'Waiting for approval' : 'Approve first';
  const waiting = () => props.spend?.state === 'pending' || props.spend?.state === 'unavailable';

  return (
    <>
      <TrackHead title="Start something" onContext={props.onContext} />
      <SpendBar spend={props.spend} error={props.spendError} now={props.now} actions={props.actions} />
      <div class="stream">
        <div class="empty-track" data-new-track>
          <h2>Share your node id</h2>
          <p class="hint">
            Anyone who knows it can offer to pay you to talk. Knowing an id is an introduction, not admission: each
            message is admitted only when its payment settles.
          </p>
          <Show when={qr()}>
            <svg class="qr" viewBox={`0 0 ${qr()!.extent} ${qr()!.extent}`} shape-rendering="crispEdges" role="img" aria-label="Your node id as a QR code">
              <rect width={qr()!.extent} height={qr()!.extent} fill="#ffffff" />
              <path d={qr()!.path} fill="#000000" />
            </svg>
          </Show>
          <code class="address">{props.ownId}</code>
        </div>

        <div class="new-grid">
          <form
            class="panel"
            data-invite-create
            onSubmit={(e) => {
              e.preventDefault();
              void run('create', async () => {
                const v = await props.source.inviteCreate(invitee(), addr(), hours());
                setMade({ link: v.invite_link, until: v.expires_at_ms });
              });
            }}
          >
            <h2>Invite someone</h2>
            <p class="hint">
              An invite is bound to one person’s key and lets their node connect to yours. It is not a free pass: every
              message still pays to be admitted.
            </p>
            <input data-invitee placeholder="Their node id (64 hex)" value={invitee()} onInput={(e) => setInvitee(e.currentTarget.value)} aria-label="Their node id" />
            <input data-addr placeholder="Your node’s reachable address, host:port" value={addr()} onInput={(e) => setAddr(e.currentTarget.value)} aria-label="Your node's address" />
            <label class="row">
              <span class="hint">Valid for</span>
              <select value={hours()} onChange={(e) => setHours(Number(e.currentTarget.value))} aria-label="Valid for">
                <option value={24}>1 day</option>
                <option value={72}>3 days</option>
                <option value={168}>7 days</option>
              </select>
            </label>
            <button type="submit" class="primary" disabled={busy() || (open() ? !invitee() || !addr() : waiting())}>
              {button('Create invite')}
            </button>
            <Show when={made()}>
              {(m) => (
                <div class="artifact" data-invite-link>
                  <span class="kind">Invite · until {day(m().until)}</span>
                  <code class="address">{m().link}</code>
                  <span class="hint">Send it to them yourself. The app sends nothing on your behalf.</span>
                </div>
              )}
            </Show>
            <Show when={errs.create}>
              <p class="err-note">{errs.create}</p>
            </Show>
          </form>

          <form
            class="panel"
            data-invite-redeem
            onSubmit={(e) => {
              e.preventDefault();
              void run('redeem', async () => {
                const v = await props.source.inviteRedeem(token());
                setRedeemed({ inviter: v.inviter_pubkey, addr: v.addr });
                setToken('');
              });
            }}
          >
            <h2>Accept an invite</h2>
            <p class="hint">Paste a bitsov://invite link someone sent you. Your node connects to theirs.</p>
            <textarea data-invite-token rows={3} placeholder="bitsov://invite/…" value={token()} onInput={(e) => setToken(e.currentTarget.value)} aria-label="Invite link" />
            <button type="submit" class="primary" disabled={busy() || (open() ? !token().trim() : waiting())}>
              {button('Accept invite')}
            </button>
            <Show when={redeemed()}>
              {(r) => (
                <p class="ok-note" data-redeemed>
                  Accepted. Connecting to {shortId(r().inviter)} at {r().addr}. Messages between you still pay to be admitted.
                </p>
              )}
            </Show>
            <Show when={errs.redeem}>
              <p class="err-note">{errs.redeem}</p>
            </Show>
          </form>
        </div>
        <p class="send-next">
          Invites change your node, so they use the same owner approval as spending. Adding a peer by address and creating
          rooms are not in the app yet.
        </p>
      </div>
    </>
  );
}

// ---- context panels ---------------------------------------------------------

function NodePanel(props: { overview: NodeOverview | null; link: LinkState | null; peers: Peer[]; now: number; error?: string }) {
  const fresh = () => freshness(props.overview?.read_at ?? null, props.now);
  const linkText = () =>
    props.link === 'open' ? 'Live' : props.link === 'connecting' ? 'Connecting' : props.link === 'closed' ? 'Reconnecting' : 'Waiting';
  return (
    <div class="panel" data-panel="node">
      <h2>Your node</h2>
      <Show when={props.overview} fallback={<div class="spinner" />}>
        {(o) => (
          <dl class="facts">
            <dt>Status</dt>
            <dd>
              <span class="row" style={{ 'justify-content': 'flex-end', gap: 'var(--s-2)' }}>
                <span class={`dot ${o().status === 'ok' ? 'ok' : 'warn'}`} />
                {o().status === 'ok' ? 'Healthy' : o().status}
              </span>
            </dd>
            <dt>Node id</dt>
            <dd class="id" title={o().node_id}>{shortId(o().node_id)}</dd>
            <dt>Live feed</dt>
            <dd data-link={props.link ?? 'none'}>{linkText()}</dd>
            <dt>Peers connected</dt>
            <dd class="sats">{o().connected_peers}</dd>
            <dt>Encrypted sessions</dt>
            <dd class="sats">{o().e2ee_sessions}</dd>
            <dt>Waiting to deliver</dt>
            <dd class="sats">{o().pending_deliveries}</dd>
            <dt>Block height</dt>
            <dd class="sats">{o().block_height !== null ? satsWhole(o().block_height!) : 'unknown'}</dd>
            <dt>Lightning</dt>
            <dd>{o().lightning_available ? o().lightning_backend ?? 'available' : 'unavailable'}</dd>
            <dt>Chain source</dt>
            <dd>{o().chain_backend ?? 'unknown'}</dd>
            <dt>Uptime</dt>
            <dd class="sats">{uptime(o().uptime_secs)}</dd>
            <dt>API</dt>
            <dd>{o().version ?? 'unknown'}</dd>
          </dl>
        )}
      </Show>
      <p class="fresh-line" classList={{ stale: fresh().stale }} data-freshness>
        {fresh().label}
      </p>
      <Show when={props.error}>
        <p class="err-note">{props.error}</p>
      </Show>
      <h3>Peers</h3>
      <For each={props.peers} fallback={<p class="hint">Your node has no peers yet.</p>}>
        {(p) => (
          <div class="row" style={{ 'justify-content': 'space-between', 'font-size': 'var(--t-sm)' }}>
            <span class="row" style={{ gap: 'var(--s-2)', 'min-width': 0 }}>
              <span class={`dot ${p.connected ? 'ok' : ''}`} />
              <span style={{ 'font-family': 'var(--font-serif)' }}>{peerName(p, p.node_id)}</span>
            </span>
            <span class="id">{p.fingerprint ?? shortId(p.node_id)}</span>
          </div>
        )}
      </For>
      <p class="hint">Your peer list is private to this node. It is not who may reach you; payment decides that.</p>
    </div>
  );
}

function WalletPanel(props: { wallet: WalletOverview | null; error?: string; fund?: JSX.Element }) {
  const active = () => props.wallet?.channels.filter((c) => c.active).length ?? 0;
  return (
    <>
      <div class="panel" data-panel="wallet">
        <h2>Wallet</h2>
        <Show when={props.wallet} fallback={<Show when={!props.error}><div class="spinner" /></Show>}>
          {(w) => (
            <>
              <div class="big-balance">
                <span class="sats" data-balance>
                  {sats(w().balance_msat)}
                  <span class="unit">sats</span>
                </span>
                <p class="hint">Lightning and spendable on-chain together. This node version reports them as one figure.</p>
              </div>
              <dl class="facts">
                <dt>Lightning, ready to send</dt>
                <dd class="sats">{sats(w().lightning_outbound_msat)}</dd>
                <dt>Open channels</dt>
                <dd class="sats">
                  {active()} of {w().channels.length} active
                </dd>
              </dl>
              <h3>Channels</h3>
              <For each={w().channels} fallback={<p class="hint">No channels yet. A channel is needed before paid messages can be sent.</p>}>
                {(c) => {
                  const share = () => (c.capacity_msat > 0 ? (c.local_balance_msat / c.capacity_msat) * 100 : 0);
                  return (
                    <div class="channel" data-channel={c.channel_id}>
                      <div class="row">
                        <span class="id" title={c.peer_pubkey}>{shortId(c.peer_pubkey)}</span>
                        <span>{c.active ? 'active' : 'inactive'}</span>
                      </div>
                      <div class="liquidity" title="Yours (orange) against theirs">
                        <div style={{ width: `${share()}%`, opacity: c.active ? 1 : 0.4 }} />
                      </div>
                      <div class="row">
                        <span class="sats">{sats(c.local_balance_msat)} yours</span>
                        <span class="sats">{sats(c.remote_balance_msat)} theirs</span>
                      </div>
                    </div>
                  );
                }}
              </For>
            </>
          )}
        </Show>
        <Show when={props.error}>
          <p class="err-note">{props.error}</p>
        </Show>
      </div>
      <Show when={props.fund}>
        <div data-panel="receive">{props.fund}</div>
      </Show>
    </>
  );
}
