import { createEffect, createMemo, createSignal, For, type JSX, Match, on, onCleanup, Show, Switch } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { qrSvg } from '../qr';
import { clock, day, sats, satsWhole, satUnit, shortId, uptime } from './format';
import type { Source } from './source';
import {
  applyLive,
  costToSend,
  freshness,
  isOutgoing,
  mergeMessages,
  nodePill,
  peerName,
  trackKey,
  type Threads,
  type Unread,
} from './state';
import type { LinkState, Message, NodeOverview, Peer, PriceQuote, Room, TrackRef, WalletOverview } from './types';

/** How often each panel re-reads while the shell is open. Peers and balance have no live event. */
const REFRESH_MS = { overview: 10_000, peers: 15_000, wallet: 20_000, rooms: 30_000, clock: 5_000 } as const;

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
  const [errors, setErrors] = createStore<Record<string, string | undefined>>({});
  const [contextOpen, setContextOpen] = createSignal(false);
  const [tab, setTab] = createSignal<'node' | 'wallet'>('node');

  const ownId = () => props.ownId ?? overview()?.node_id ?? '';
  const peerById = createMemo(() => new Map(peers().map((p) => [p.node_id.toLowerCase(), p])));
  const openKey = () => (track() ? trackKey(track()!) : null);

  const attempt = async <T,>(area: string, run: () => Promise<T>, apply: (v: T) => void) => {
    try {
      apply(await run());
      setErrors(area, undefined);
    } catch (e) {
      setErrors(area, String(e));
    }
  };
  const loadOverview = () => attempt('overview', () => props.source.nodeOverview(), setOverview);
  const loadPeers = () => attempt('peers', () => props.source.peers(), setPeers);
  const loadRooms = () => attempt('rooms', () => props.source.rooms(), setRooms);
  const loadWallet = () => attempt('wallet', () => props.source.wallet(), setWallet);
  const loadThread = (t: TrackRef) => {
    if (t.kind !== 'peer' && t.kind !== 'room') return;
    const key = trackKey(t);
    void attempt('thread', () => props.source.messages(t.id), (page) =>
      setThreads('t', key, (old) => mergeMessages(old ?? [], page)),
    );
  };

  const clock = setInterval(() => setNow(Date.now()), REFRESH_MS.clock);
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
        timers.push(
          setInterval(() => void loadOverview(), REFRESH_MS.overview),
          setInterval(() => void loadPeers(), REFRESH_MS.peers),
          setInterval(() => void loadWallet(), REFRESH_MS.wallet),
          setInterval(() => void loadRooms(), REFRESH_MS.rooms),
        );
        props.source
          .onLive((event) => {
            if (event.type === 'link') {
              setLink(event.state);
              // Back after a gap: re-read the open track so nothing is missed.
              if (event.state === 'open' && track()) loadThread(track()!);
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
          .then((off) => (mine === generation ? (unlisten = off) : off()))
          .catch((e) => setErrors('live', String(e)));
    }),
  );

  // Opening a track: clear its unread count, load history, quote its cost.
  createEffect(
    on(track, (t) => {
      if (!t || !props.active) return;
      setThreads('unread', trackKey(t), 0);
      setQuote(null);
      loadThread(t);
      if (t.kind === 'peer') void attempt('quote', () => props.source.priceQuote(t.id), setQuote);
      if (t.kind === 'room') {
        void attempt('quote', () => props.source.priceQuote(), setQuote);
        void attempt('members', () => props.source.roomMembers(t.id), (m) => setMembers(t.id, m));
      }
      setContextOpen(false);
    }),
  );

  onCleanup(() => {
    clearInterval(clock);
    stop();
  });

  const pill = () =>
    nodePill({ ready: props.ready, error: props.error, overview: overview(), link: link(), nowMs: now() });

  const trackName = (t: TrackRef): string => {
    if (t.kind === 'peer') return peerName(peerById().get(t.id), t.id);
    if (t.kind === 'room') return rooms().find((r) => r.id.toLowerCase() === t.id)?.name ?? 'Room';
    return t.kind === 'ai' ? 'AI' : 'Start something';
  };

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
                  <AiTrack onContext={() => setContextOpen(true)} />
                </Match>
                <Match when={t().kind === 'new'}>
                  <NewTrack ownId={ownId()} onContext={() => setContextOpen(true)} />
                </Match>
                <Match when={t().kind === 'peer' || t().kind === 'room'}>
                  <Conversation
                    track={t()}
                    name={trackName(t())}
                    peer={t().kind === 'peer' ? peerById().get((t() as { id: string }).id) : undefined}
                    members={t().kind === 'room' ? members[(t() as { id: string }).id] ?? null : null}
                    messages={threads.t[trackKey(t())] ?? []}
                    fresh={threads.fresh}
                    ownId={ownId()}
                    nameOf={(id) => (id.toLowerCase() === ownId().toLowerCase() ? 'You' : peerName(peerById().get(id.toLowerCase()), id))}
                    quote={quote()}
                    now={now()}
                    error={errors.thread}
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
            </div>
            <button class="quiet context-toggle" onClick={() => setContextOpen(false)} aria-label="Close panel">Close</button>
          </div>
          <Show when={tab() === 'node'} fallback={<WalletPanel wallet={wallet()} error={errors.wallet} fund={props.fund} />}>
            <NodePanel overview={overview()} link={link()} peers={peers()} now={now()} error={errors.overview ?? errors.peers} />
          </Show>
        </aside>
      </Show>
    </div>
  );
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
        <Show when={props.active}>{item({ kind: 'ai' }, 'Ask your node', <span class="meta">not yet</span>)}</Show>
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
  fresh: Record<string, true>;
  ownId: string;
  nameOf: (id: string) => string;
  quote: PriceQuote | null;
  now: number;
  error: string | undefined;
  onContext: () => void;
}) {
  let stream: HTMLDivElement | undefined;
  const [draft, setDraft] = createSignal('');
  const others = () => (props.members ?? []).filter((m) => m.toLowerCase() !== props.ownId.toLowerCase());
  const cost = () =>
    costToSend(props.track, props.quote, {
      name: props.track.kind === 'peer' ? `${props.name}’s` : undefined,
      members: others().length,
      nowMs: props.now,
    });

  createEffect(
    on(
      () => props.messages.length,
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
          <p class="day">Members added here are not notified yet. A room message pays each member separately.</p>
        </Show>
        <For
          each={props.messages}
          fallback={
            <div class="empty-track">
              <h2>Nothing here yet</h2>
              <p class="hint">
                Your first message to {props.name} is a paid first contact: it is admitted when the payment settles.
              </p>
            </div>
          }
        >
          {(m, i) => {
            const out = isOutgoing(m, props.ownId);
            const prev = () => props.messages[i() - 1];
            const newDay = () => !prev() || day(prev()!.timestamp) !== day(m.timestamp);
            return (
              <>
                <Show when={newDay()}>
                  <p class="day">{day(m.timestamp)}</p>
                </Show>
                <article class={`msg ${out ? 'out' : 'in'}`} classList={{ fresh: !!props.fresh[m.id] }} data-message={m.id}>
                  <Show when={!out && props.track.kind === 'room'}>
                    <span class="who">{props.nameOf(m.sender)}</span>
                  </Show>
                  <div class="bubble">{m.plaintext ?? 'Encrypted content not available on this device'}</div>
                  <div class="stamp">
                    <Show when={m.payment_amount_msat}>
                      <Bolt />
                      <span class="sats">{sats(m.payment_amount_msat!)}</span>
                      <span>{satUnit(m.payment_amount_msat!)} {out ? 'paid' : 'to you'}</span>
                    </Show>
                    <span>{clock(m.timestamp)}</span>
                  </div>
                </article>
              </>
            );
          }}
        </For>
        <Show when={props.error}>
          <p class="err-note">{props.error}</p>
        </Show>
      </div>

      <form class="composer" data-composer onSubmit={(e) => e.preventDefault()}>
        <textarea
          rows={2}
          placeholder={`Message ${props.name}`}
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          aria-label={`Message ${props.name}`}
        />
        <div class="composer-bar">
          <div class="cost" data-cost>
            <span class="label">Cost to send</span>
            <Show when={cost()} fallback={<span class="sats">…</span>}>
              {(c) => (
                <>
                  <span class="sats" data-cost-msat={c().msat}>
                    {c().estimate ? '≈ ' : ''}
                    {sats(c().msat)}
                    <span class="unit">{satUnit(c().msat)}</span>
                  </span>
                  <span class="basis" title={c().basis}>{c().basis}</span>
                </>
              )}
            </Show>
          </div>
          <button type="submit" class="primary" disabled data-send>
            Send
          </button>
        </div>
        <p class="send-next" data-send-next>
          Sending is not switched on yet. It comes next, and will ask you to approve spending on your node first.
        </p>
      </form>
    </>
  );
}

function AiTrack(props: { onContext: () => void }) {
  return (
    <>
      <TrackHead title="AI" sub={<span class="id">Not built yet</span>} onContext={props.onContext} />
      <div class="stream">
        <div class="empty-track" data-ai-track>
          <h2>Ask about your own node</h2>
          <p class="hint">
            This track is not built yet. When it is, this app brokers every question: your node never talks to a
            model directly, and you see exactly what would leave this machine before anything does.
          </p>
        </div>
      </div>
    </>
  );
}

function NewTrack(props: { ownId: string; onContext: () => void }) {
  const qr = createMemo(() => {
    try {
      return props.ownId ? qrSvg(props.ownId) : null;
    } catch {
      return null;
    }
  });
  return (
    <>
      <TrackHead title="Start something" onContext={props.onContext} />
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
          <div class="row" style={{ 'justify-content': 'center', 'flex-wrap': 'wrap' }}>
            <button class="quiet" disabled>Add a peer</button>
            <button class="quiet" disabled>Create a room</button>
            <button class="quiet" disabled>Create an invite</button>
          </div>
          <p class="send-next">These change your node, so they wait for owner approval, which comes next.</p>
        </div>
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
