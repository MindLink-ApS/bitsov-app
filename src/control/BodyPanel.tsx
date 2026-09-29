import { createEffect, createSignal, For, type JSX, Match, on, onCleanup, Show, Switch, untrack } from 'solid-js';
import { ago, amount, clock, sats, satsWhole, satUnit, shortId } from './format';
import {
  feedState,
  gateWords,
  membraneSummary,
  type Energy,
  type EnergyRow,
  type Homeostasis,
  type MembraneEntry,
  type Metabolism,
  type Nucleus,
  type RefusalKind,
  type Setpoint,
} from './body';
import { freshness } from './state';
import type { LinkState, PrePaymentRefusals } from './types';
import { RefusalCounts } from './RefusalCounts';

/** One real event brightens its row for this long, then decays. Nothing moves otherwise. */
const PULSE_MS = 400;

/** True for `PULSE_MS` after `value` changes. Never on first read: mounting is not an event. */
function usePulse(value: () => unknown, startHot = false) {
  const [hot, setHot] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = () => {
    setHot(true);
    clearTimeout(timer);
    timer = setTimeout(() => setHot(false), PULSE_MS);
  };
  if (startHot) fire();
  createEffect(on(value, fire, { defer: true }));
  onCleanup(() => clearTimeout(timer));
  return hot;
}

export type OrganismProps = {
  readiness?: string | null;
  sample: boolean;
  now: number;
  /** When this shell started reading: the membrane has seen nothing before it. */
  openedAt: number;
  link: LinkState | null;
  /** The node is not answering: every organ greys to its last reading. */
  down: boolean;
  metabolism: Metabolism;
  /** Last time a track was read or a `/ws` message arrived. */
  energyAt: number | null;
  /** When the node's own energy read (N1) last answered; null before N1. */
  energyReadAt: number | null;
  membrane: MembraneEntry[];
  /** The node reports its own gate decisions (N2), inbound refusals included. */
  nodeMembrane: boolean;
  /** When the node's membrane ring was last read successfully; null before. */
  membraneReadAt?: number | null;
  prePaymentRefusals?: PrePaymentRefusals | null;
  /** Why the last membrane read failed, if it did. */
  membraneError?: string;
  /** This node's own price for a text message: what a stranger pays at the door. */
  door: { msat: number; read_at: number } | null;
  /** Why the last door price read failed, if it did. */
  doorError?: string;
  homeostasis: Homeostasis;
  budgetReadAt: number | null;
  nucleus: Nucleus;
  nameOfTrack: (key: string) => string;
  nameOf: (id: string) => string;
  onSetpoints: () => void;
  onPauseAll: () => void;
  onResume: () => void;
};

/**
 * The context panel as the node's physiology. Physiology words stay in the
 * headers; rows are plain facts with units, and each organ says where its
 * figures come from and how old they are.
 */
export function Organism(props: OrganismProps) {
  const feed = () => feedState(props.link, props.energyAt, props.now, ago);
  const liveFresh = () => ({ label: feed().label, stale: feed().stale || props.down });
  return (
    <div class="organism" data-panel="body" classList={{ down: props.down }}>
      <Show when={props.readiness}><p class="hint" data-readiness>{props.readiness}</p></Show>
      <MetabolismOrgan {...props} fresh={liveFresh()} />
      <MembraneOrgan {...props} fresh={liveFresh()} />
      <SetpointsOrgan {...props} />
      <Organ id="immune" title="Immune memory" summary={<span>not built</span>} fresh={{ label: 'Not built', stale: false }} sample={props.sample} source="No evidence store in the node yet (N3).">
        <p class="organ-line" data-immune>Evidence keeping: not built.</p>
      </Organ>
      <NucleusOrgan {...props} />
    </div>
  );
}

function Organ(props: {
  id: string;
  title: string;
  summary: JSX.Element;
  fresh: { label: string; stale: boolean };
  sample: boolean;
  source: JSX.Element;
  hot?: boolean;
  children: JSX.Element;
}) {
  // Phone: organs collapse to one line; a tap opens the full organ.
  const [open, setOpen] = createSignal(false);
  return (
    <section class="organ" data-organ={props.id} classList={{ expanded: open(), stale: props.fresh.stale, hot: !!props.hot }}>
      <button type="button" class="organ-head" aria-expanded={open()} onClick={() => setOpen(!open())}>
        <span class="organ-name">{props.title}</span>
        <span class="organ-summary">{props.summary}</span>
        <Show when={props.sample}>
          <span class="sample-tag" data-sample-tag>Sample</span>
        </Show>
        <span class="organ-fresh" classList={{ stale: props.fresh.stale }} data-organ-fresh>{props.fresh.label}</span>
        <span class="organ-chev" aria-hidden="true">›</span>
      </button>
      <div class="organ-body">
        {props.children}
        <p class="organ-src">{props.source}</p>
      </div>
    </section>
  );
}

// ---- metabolism ---------------------------------------------------------------

const plus = (msat: number) => (msat > 0 ? `+${sats(msat)}` : '0');
const minus = (msat: number) => (msat > 0 ? `−${sats(msat)}` : '0');
const acts = (n: number, dir: string) => `${n} ${dir}`;

function MetabolismOrgan(props: OrganismProps & { fresh: { label: string; stale: boolean } }) {
  const m = () => props.metabolism;
  const idle = (e: Energy) => e.acts_in + e.acts_out === 0;
  const hot = usePulse(() => m().day.acts_in + m().day.acts_out);
  // N1: the node's own ledger, polled; its age is the read's, not the feed's.
  const fresh = () => {
    if (m().source !== 'node') return props.fresh;
    const f = freshness(props.energyReadAt, props.now);
    return { label: f.label, stale: f.stale || props.down };
  };
  return (
    <Organ
      id="metabolism"
      title="Metabolism"
      hot={hot()}
      summary={<span class="sats">{plus(m().hour.in_msat)} / {minus(m().hour.out_msat)} · 1 h</span>}
      fresh={fresh()}
      sample={props.sample}
      source={
        m().source === 'node' ? (
          <>
            Node-wide, from your node’s own record of paid messages (N1). Local only; no one else’s traffic.
            <Show when={m().truncated}> More than the node reads at once: totals are a floor.</Show>
          </>
        ) : (
          <>
            Paid messages in {m().tracks_read} {m().tracks_read === 1 ? 'track' : 'tracks'} read here + live feed. Node-wide totals and hourly bars need N1.
          </>
        )
      }
    >
      <div class="energy" role="table" aria-label="Sats in and out">
        <span role="columnheader" />
        <span role="columnheader" class="col">1 h</span>
        <span role="columnheader" class="col">24 h</span>
        <span role="rowheader" class="dir">in</span>
        <span class="sats energy-fig" data-energy="in-1h">{plus(m().hour.in_msat)}</span>
        <span class="sats energy-fig" data-energy="in-24h">{plus(m().day.in_msat)}</span>
        <span role="rowheader" class="dir">out</span>
        <span class="sats energy-fig" data-energy="out-1h">{minus(m().hour.out_msat)}</span>
        <span class="sats energy-fig" data-energy="out-24h">{minus(m().day.out_msat)}</span>
      </div>
      <p class="organ-unit">{satUnit(2000)}</p>
      <Show when={m().bars}>{(b) => <Bars bars={b()} now={props.now} />}</Show>
      <Show when={idle(m().hour)}>
        <p class="organ-line" data-energy-idle>No energy crossed in the last hour.</p>
      </Show>
      <For each={m().rows.slice(0, 4)}>{(row) => <EnergyLine row={row} name={props.nameOfTrack(row.key)} />}</For>
    </Organ>
  );
}

/**
 * 24 hourly bars from N1, oldest left. An hour the node reported nothing for is
 * a gap: drawn empty, never interpolated or zero-filled from a guess.
 */
function Bars(props: { bars: NonNullable<Metabolism['bars']>; now: number }) {
  const slots = () => {
    const size = props.bars.bucket_ms || 3_600_000;
    const first = props.bars.start_ms - (props.bars.start_ms % size) + size;
    const byStart = new Map(props.bars.buckets.map((b) => [b.start_ms, b]));
    return Array.from({ length: 24 }, (_, i) => byStart.get(first + i * size) ?? null);
  };
  const max = () => Math.max(1, ...props.bars.buckets.map((b) => b.in_msat + b.out_msat));
  const h = (msat: number) => `${Math.max(8, Math.round((msat / max()) * 100))}%`;
  return (
    <div class="bars" role="img" aria-label={`Sats per hour, last 24 hours; ${props.bars.buckets.length} of 24 hours had paid messages`} data-energy-bars>
      <For each={slots()}>
        {(b) =>
          b ? (
            <span class="hour-bar" title={`+${amount(b.in_msat)} / −${amount(b.out_msat)}`} data-bar>
              <span class="bar-in" style={{ height: h(b.in_msat) }} classList={{ none: b.in_msat === 0 }} />
              <span class="bar-out" style={{ height: h(b.out_msat) }} classList={{ none: b.out_msat === 0 }} />
            </span>
          ) : (
            <span class="hour-bar gap" data-bar-gap />
          )
        }
      </For>
    </div>
  );
}

function EnergyLine(props: { row: EnergyRow; name: string }) {
  const hot = usePulse(() => props.row.acts_in + props.row.acts_out);
  return (
    <div class="organ-row" classList={{ hot: hot() }} data-energy-row={props.row.key}>
      <span class="who">{props.name}</span>
      <span class="sats">{plus(props.row.in_msat)} / {minus(props.row.out_msat)}</span>
      <span class="organ-note">{acts(props.row.acts_in, 'in')} · {acts(props.row.acts_out, 'out')}</span>
    </div>
  );
}

// ---- membrane -----------------------------------------------------------------

const KIND_TEXT: Record<RefusalKind, string> = { door: 'their door', price: 'price', setpoint: 'your setpoint', inbound: 'at your door' };

function MembraneOrgan(props: OrganismProps & { fresh: { label: string; stale: boolean } }) {
  const s = () => membraneSummary(props.membrane);
  // Rows that arrive after the panel opened pulse once; history on mount does not.
  const baseline = untrack(() => Math.max(0, ...props.membrane.map(e => e.seq)));
  const outboundBy = () =>
    (Object.entries(s().refused_by) as [RefusalKind, number][])
      .filter(([k, n]) => k !== 'inbound' && n > 0)
      .map(([k, n]) => `${KIND_TEXT[k]} ${n}`)
      .join(' · ');
  const inboundBy = () =>
    Object.entries(s().inbound_by)
      .sort((a, b) => b[1] - a[1])
      .map(([code, n]) => `${gateWords(code)} ${n}`)
      .join(' · ');
  // The live feed says only that events can arrive. Without one successful
  // read of the node's ring, the organ does not know what already happened,
  // so it never claims Live or "none" (merge-gate finding 6).
  const ringRead = () => !props.nodeMembrane || (props.membraneReadAt ?? null) !== null;
  const ringCurrent = () => ringRead() && !(props.nodeMembrane && props.membraneError);
  const fresh = () => {
    if (props.nodeMembrane && props.membraneError) return { label: 'Reading unavailable', stale: true };
    if (!ringRead()) return { label: 'Not read yet', stale: true };
    return props.fresh;
  };
  const doorFresh = () => {
    if (!props.door) return null;
    const f = freshness(props.door.read_at, props.now);
    return props.doorError ? { label: `could not re-read · last ${ago(props.door.read_at, props.now)}`, stale: true } : f;
  };
  const refusedNote = () => {
    const parts = [];
    if (props.nodeMembrane) {
      parts.push(!ringRead() ? 'at your door: not read yet' : s().refused_by.inbound > 0 ? `at your door: ${inboundBy()}` : ringCurrent() ? 'at your door: none' : 'at your door: last reading had none');
    }
    if (outboundBy()) parts.push(`outbound: ${outboundBy()}`);
    return parts.join(' · ') || 'outbound';
  };
  return (
    <Organ
      id="membrane"
      title="Membrane"
      summary={<span>{ringRead() ? `${s().admitted} in · ${s().refused} refused` : 'Gate history not read yet'}</span>}
      fresh={fresh()}
      sample={props.sample}
      source={
        props.nodeMembrane ? (
          <>
            Your node’s own gate decisions (N2), from its memory ring, plus your sends from this app. A refused sender is named only when the node verified its signature. Memory only, never saved.
          </>
        ) : (
          <>
            Since {clock(props.openedAt)}: what your node admitted and your sends that did not cross. Memory only, never saved.
          </>
        )
      }
    >
      <p class="organ-line door" data-door>
        <Show when={props.door} fallback={props.doorError ? <span data-door-fresh="stale">Door price could not be read.</span> : 'Door price not read yet.'}>
          {(d) => (
            <>
              Door open at <span class="sats">{sats(d().msat)}</span> {satUnit(d().msat)} a message
              <span class="organ-note"> · your price</span>
              <span class="organ-note" classList={{ stale: doorFresh()!.stale }} data-door-fresh={doorFresh()!.stale ? 'stale' : 'fresh'}>
                {' '}· {doorFresh()!.label}
              </span>
            </>
          )}
        </Show>
      </p>
      <div class="organ-row" data-membrane-admitted>
        <span class="who"><span class="dot ok" /> admitted</span>
        <span class="sats">{ringRead() ? s().admitted : '—'}</span>
        <span class="organ-note">
          <Show when={ringRead()} fallback="Not read yet">
            {amount(s().admitted_msat)} settled<Show when={s().first_contacts > 0}> · {s().first_contacts} first contact</Show>
          </Show>
        </span>
      </div>
      <Show when={s().readmitted > 0}>
        <div class="organ-row" data-membrane-readmitted>
          <span class="who"><span class="dot ok" /> admitted again</span>
          <span class="sats">{s().readmitted}</span>
          <span class="organ-note">
            {amount(s().readmitted_msat)} paid after a reconnect, from their own quote
          </span>
        </div>
      </Show>
      <div class="organ-row" data-membrane-refused>
        <span class="who"><span class="dot err" /> refused</span>
        <span class="sats">{ringRead() ? s().refused : '—'}</span>
        <span class="organ-note" data-membrane-refused-by>{refusedNote()}</span>
      </div>
      <Show
        when={props.membrane.length > 0}
        fallback={<p class="organ-line" data-membrane-quiet>{ringCurrent()
          ? `${props.prePaymentRefusals ? 'No message-gate events' : 'No knocks'} since ${clock(props.openedAt)}.`
          : props.membraneError ? 'Gate history unavailable.' : 'Gate history not read yet.'}</p>}
      >
        <For each={props.membrane.slice(0, 3)}>{(e) => <MembraneLine e={e} hot={e.seq > baseline} nameOf={props.nameOf} nameOfTrack={props.nameOfTrack} />}</For>
      </Show>
      <RefusalCounts counts={props.prePaymentRefusals} readAt={props.membraneReadAt} error={props.membraneError} now={props.now} down={props.down} />
      <Show when={!props.nodeMembrane}>
        <p class="organ-line muted" data-membrane-n2>Inbound refusals are not visible yet (node N2).</p>
      </Show>
    </Organ>
  );
}

function MembraneLine(props: { e: MembraneEntry; hot: boolean; nameOf: (id: string) => string; nameOfTrack: (key: string) => string }) {
  const hot = usePulse(() => props.e.seq, props.hot);
  return (
    <div class="organ-log" classList={{ hot: hot() }} data-membrane-entry={props.e.verdict}>
      <span class="at">{clock(props.e.at)}</span>
      <Switch>
        <Match when={props.e.verdict === 'admitted' && props.e}>
          {(e) => {
            const a = () => e() as Extract<MembraneEntry, { verdict: 'admitted' }>;
            return (
              <span>
                <span class="ok-word">admitted</span> {a().first_contact ? shortId(a().sender) : props.nameOf(a().sender)}
                <Show when={a().paid_msat}> · paid <span class="sats">{sats(a().paid_msat!)}</span> {satUnit(a().paid_msat!)}</Show>
                <Show when={a().first_contact}> · first contact, not added</Show>
              </span>
            );
          }}
        </Match>
        <Match when={props.e.verdict === 'readmitted' && props.e}>
          {(e) => {
            const a = () => e() as Extract<MembraneEntry, { verdict: 'readmitted' }>;
            return (
              <span data-membrane-readmission>
                <span class="ok-word">paid again</span> {props.nameOf(a().counterparty)} · {gateWords('readmission')}
                <Show when={a().paid_msat}> · <span class="sats">{sats(a().paid_msat!)}</span> {satUnit(a().paid_msat!)}</Show>
                <Show when={a().cap_msat}> · within their budget of <span class="sats">{sats(a().cap_msat!)}</span> {satUnit(a().cap_msat!)}</Show>
              </span>
            );
          }}
        </Match>
        <Match when={props.e.verdict === 'refused' && props.e}>
          {(e) => {
            const r = () => e() as Extract<MembraneEntry, { verdict: 'refused' }>;
            return (
              <Show
                when={r().kind === 'inbound'}
                fallback={
                  <span title={r().detail}>
                    <span class="err-word">refused</span> {r().track ? props.nameOfTrack(r().track!) : 'send'} · {KIND_TEXT[r().kind]}
                    <span class="detail">{r().detail}</span>
                  </span>
                }
              >
                <span title={r().detail} data-membrane-inbound={r().code}>
                  <span class="err-word">refused</span> {r().sender ? props.nameOf(r().sender!) : 'unsigned'} · {gateWords(r().code)}
                  <Show when={r().required_msat}> · needed <span class="sats">{sats(r().required_msat!)}</span> {satUnit(r().required_msat!)}</Show>
                </span>
              </Show>
            );
          }}
        </Match>
      </Switch>
    </div>
  );
}

// ---- homeostasis --------------------------------------------------------------

const pct = (spent: number, of: number) => `${Math.min(100, of > 0 ? (spent / of) * 100 : 0).toFixed(1)}%`;
const hoursLeft = (untilMs: number | null, nowMs: number) => Math.max(1, Math.ceil(((untilMs ?? nowMs) - nowMs) / 3_600_000));

function SetpointsOrgan(props: OrganismProps) {
  const h = () => props.homeostasis;
  const fresh = () => {
    const f = freshness(props.budgetReadAt, props.now);
    return { label: f.label, stale: f.stale || props.down };
  };
  const spent = () => {
    const x = h();
    return x.state === 'holding' || x.state === 'paused' || x.state === 'waiting' ? x.spent_msat : null;
  };
  const hot = usePulse(() => spent());
  const summary = () => {
    const x = h();
    if (x.state === 'holding') return `${sats(x.spent_msat)}/${sats(x.ceiling_msat)} · ${hoursLeft(x.until_ms, props.now)} h`;
    if (x.state === 'paused') return 'paused';
    if (x.state === 'waiting') return 'waiting for you';
    if (x.state === 'none') return 'none';
    return '…';
  };
  return (
    <Organ
      id="setpoints"
      title="Setpoints"
      hot={hot()}
      summary={<span class="sats">{summary()}</span>}
      fresh={fresh()}
      sample={props.sample}
      source="App all-in payment limits over a rolling 24 hours. Any finite node grant applies separately. See Budget for exclusions."
    >
      <Switch>
        <Match when={h().state === 'unknown'}>
          <p class="organ-line">Reading budgets…</p>
        </Match>
        <Match when={h().state === 'none' && (h() as Extract<Homeostasis, { state: 'none' }>)}>
          {(x) => (
            <>
              <p class="organ-line" data-setpoint-none>
                <Show when={x().expired}>Your daily approval ended. </Show>Automatic payment is off. Manual messages and files still count against the saved app limit.
              </p>
              <Show when={x().rows.length > 0}>
                <p class="organ-note">{x().rows.length} saved {x().rows.length === 1 ? 'budget' : 'budgets'} still limit manual messages and files; approve automatic messages from a conversation.</p>
              </Show>
            </>
          )}
        </Match>
        <Match when={h().state === 'paused'}>
          <p class="organ-line" data-setpoint-paused>
            Paused. New app payments are blocked; in-flight payments, owner commands and background workers can still spend.{' '}
            <button type="button" class="link" onClick={() => props.onResume()}>Resume</button>
          </p>
        </Match>
        <Match when={h().state === 'waiting'}>
          <p class="organ-line" data-setpoint-waiting>Waiting for your approval at the node.</p>
        </Match>
        <Match when={h().state === 'holding' && (h() as Extract<Homeostasis, { state: 'holding' }>)}>
          {(x) => (
            <>
              <SetpointBar label="app all-in · 24 h" spent={x().spent_msat} limit={x().ceiling_msat} note={`${hoursLeft(x().until_ms, props.now)} h left`} data="ceiling" />
              <Show when={x().grant}>
                {(g) => (
                  <p class="organ-line" data-setpoint-grant>
                    Finite node grant: <span class="sats">{sats(g().remaining_msat)}</span> of {amount(g().budget_msat)} left, {hoursLeft(g().expires_at_ms, props.now)} h
                  </p>
                )}
              </Show>
              <For each={x().rows.slice(0, 3)}>
                {(r) => <SetpointBar label={props.nameOfTrack(`${r.room ? 'room' : 'peer'}:${r.target}`)} spent={r.spent_msat} limit={r.limit_msat} note="today" data={r.target} />}
              </For>
              <For each={x().reached.slice(0, 2)}>
                {(r: Setpoint) => (
                  <p class="organ-line" data-setpoint-reached={r.target}>
                    Resting: {props.nameOfTrack(`${r.room ? 'room' : 'peer'}:${r.target}`)} setpoint reached ({sats(r.spent_msat)}/{amount(r.limit_msat)} today). Frees as older payments pass 24 h.
                  </p>
                )}
              </For>
              <Show when={x().unsettled_msat > 0}>
                <p class="organ-note">Includes {amount(x().unsettled_msat)} whose outcome is not known yet.</p>
              </Show>
            </>
          )}
        </Match>
      </Switch>
      <Show when={h().state === 'holding' || h().state === 'none'}>
        <p class="organ-actions">
          <button type="button" class="link" data-setpoint-lower onClick={() => props.onSetpoints()}>Lower a setpoint</button>
          <Show when={h().state === 'holding'}>
            <button type="button" class="link" data-setpoint-pause onClick={() => props.onPauseAll()}>Pause app payments</button>
          </Show>
        </p>
      </Show>
    </Organ>
  );
}

function SetpointBar(props: { label: string; spent: number; limit: number; note: string; data: string }) {
  const hot = usePulse(() => props.spent);
  return (
    <div class="organ-row setpoint" classList={{ hot: hot(), reached: props.spent >= props.limit }} data-setpoint={props.data}>
      <span class="who">{props.label}</span>
      <span class="meter" aria-hidden="true"><span style={{ width: pct(props.spent, props.limit) }} /></span>
      <span class="sats">{sats(props.spent)}/{sats(props.limit)}</span>
      <span class="organ-note">{props.note}</span>
    </div>
  );
}

// ---- nucleus ------------------------------------------------------------------

function NucleusOrgan(props: OrganismProps) {
  const n = () => props.nucleus;
  const fresh = () => {
    const f = freshness(n().read_at, props.now);
    return { label: f.label, stale: f.stale || props.down };
  };
  return (
    <Organ
      id="nucleus"
      title="Nucleus"
      summary={<span class="id">{n().node_id ? shortId(n().node_id!) : '…'}</span>}
      fresh={fresh()}
      sample={props.sample}
      source="Identity and /status. Block height is a clock only; nothing goes on chain."
    >
      <p class="organ-line">
        <span class="id" title={n().node_id ?? undefined} data-nucleus-id>{n().node_id ? shortId(n().node_id!) : 'identity not read yet'}</span>
      </p>
      <p class="organ-line" data-nucleus-chain>
        <Show when={n().block_height !== null} fallback="Block height unknown">
          block <span class="sats">{satsWhole(n().block_height!)}</span>
        </Show>
        <span class="organ-note"> · {n().chain_backend ?? 'chain source unknown'}</span>
      </p>
      <p class="organ-line warn-line" data-nucleus-backup>Recovery words not verified in this app.</p>
    </Organ>
  );
}
