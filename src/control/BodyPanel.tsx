import { createEffect, createSignal, For, type JSX, Match, on, onCleanup, Show, Switch, untrack } from 'solid-js';
import { ago, clock, sats, satsWhole, satUnit, shortId } from './format';
import {
  feedState,
  membraneSummary,
  type Energy,
  type EnergyRow,
  type Homeostasis,
  type MembraneEntry,
  type Metabolism,
  type Nucleus,
  type OutboundKind,
  type Setpoint,
} from './body';
import { freshness } from './state';
import type { LinkState } from './types';

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
  membrane: MembraneEntry[];
  /** This node's own price for a text message: what a stranger pays at the door. */
  door: { msat: number; read_at: number } | null;
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
  return (
    <Organ
      id="metabolism"
      title="Metabolism"
      hot={hot()}
      summary={<span class="sats">{plus(m().hour.in_msat)} / {minus(m().hour.out_msat)} · 1 h</span>}
      fresh={props.fresh}
      sample={props.sample}
      source={
        <>
          Paid messages in {m().tracks_read} {m().tracks_read === 1 ? 'track' : 'tracks'} read here + live feed. Node-wide totals and hourly bars need N1.
        </>
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
      <p class="organ-unit">sats</p>
      <Show when={idle(m().hour)}>
        <p class="organ-line" data-energy-idle>No energy crossed in the last hour.</p>
      </Show>
      <For each={m().rows.slice(0, 4)}>{(row) => <EnergyLine row={row} name={props.nameOfTrack(row.key)} />}</For>
    </Organ>
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

const KIND_TEXT: Record<OutboundKind, string> = { door: 'their door', price: 'price', setpoint: 'your setpoint' };

function MembraneOrgan(props: OrganismProps & { fresh: { label: string; stale: boolean } }) {
  const s = () => membraneSummary(props.membrane);
  // Rows that arrive after the panel opened pulse once; history on mount does not.
  const baseline = untrack(() => props.membrane[0]?.seq ?? 0);
  const refusedBy = () =>
    (Object.entries(s().refused_by) as [OutboundKind, number][])
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${KIND_TEXT[k]} ${n}`)
      .join(' · ');
  return (
    <Organ
      id="membrane"
      title="Membrane"
      summary={<span>{s().admitted} in · {s().refused} refused</span>}
      fresh={props.fresh}
      sample={props.sample}
      source={
        <>
          Since {clock(props.openedAt)}: what your node admitted and your sends that did not cross. Memory only, never saved.
        </>
      }
    >
      <p class="organ-line door" data-door>
        <Show when={props.door} fallback="Door price not read yet.">
          {(d) => (
            <>
              Door open at <span class="sats">{sats(d().msat)}</span> {satUnit(d().msat)} a message
              <span class="organ-note"> · your price</span>
            </>
          )}
        </Show>
      </p>
      <div class="organ-row" data-membrane-admitted>
        <span class="who"><span class="dot ok" /> admitted</span>
        <span class="sats">{s().admitted}</span>
        <span class="organ-note">
          {sats(s().admitted_msat)} sats settled<Show when={s().first_contacts > 0}> · {s().first_contacts} first contact</Show>
        </span>
      </div>
      <div class="organ-row" data-membrane-refused>
        <span class="who"><span class="dot err" /> refused</span>
        <span class="sats">{s().refused}</span>
        <span class="organ-note">{s().refused > 0 ? `outbound: ${refusedBy()}` : 'outbound'}</span>
      </div>
      <Show
        when={props.membrane.length > 0}
        fallback={<p class="organ-line" data-membrane-quiet>No knocks since {clock(props.openedAt)}.</p>}
      >
        <For each={props.membrane.slice(0, 3)}>{(e) => <MembraneLine e={e} hot={e.seq > baseline} nameOf={props.nameOf} nameOfTrack={props.nameOfTrack} />}</For>
      </Show>
      <p class="organ-line muted" data-membrane-n2>Inbound refusals are not visible yet (node N2).</p>
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
        <Match when={props.e.verdict === 'refused' && props.e}>
          {(e) => {
            const r = () => e() as Extract<MembraneEntry, { verdict: 'refused' }>;
            return (
              <span title={r().detail}>
                <span class="err-word">refused</span> {r().track ? props.nameOfTrack(r().track!) : 'send'} · {KIND_TEXT[r().kind]}
                <span class="detail">{r().detail}</span>
              </span>
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
      source="Your daily budgets, inside the node’s grant when it reports one."
    >
      <Switch>
        <Match when={h().state === 'unknown'}>
          <p class="organ-line">Reading budgets…</p>
        </Match>
        <Match when={h().state === 'none' && (h() as Extract<Homeostasis, { state: 'none' }>)}>
          {(x) => (
            <>
              <p class="organ-line" data-setpoint-none>
                <Show when={x().expired}>Your daily approval ended. </Show>No setpoint. Paid sends ask each time.
              </p>
              <Show when={x().rows.length > 0}>
                <p class="organ-note">{x().rows.length} saved {x().rows.length === 1 ? 'budget' : 'budgets'} take effect once you approve a daily total.</p>
              </Show>
            </>
          )}
        </Match>
        <Match when={h().state === 'paused'}>
          <p class="organ-line" data-setpoint-paused>
            Paused. Nothing leaves your node until you resume.{' '}
            <button type="button" class="link" onClick={() => props.onResume()}>Resume</button>
          </p>
        </Match>
        <Match when={h().state === 'waiting'}>
          <p class="organ-line" data-setpoint-waiting>Waiting for your approval at the node.</p>
        </Match>
        <Match when={h().state === 'holding' && (h() as Extract<Homeostasis, { state: 'holding' }>)}>
          {(x) => (
            <>
              <SetpointBar label={`daily · ${hoursLeft(x().until_ms, props.now)} h`} spent={x().spent_msat} limit={x().ceiling_msat} note={`${hoursLeft(x().until_ms, props.now)} h left`} data="ceiling" />
              <Show when={x().grant}>
                {(g) => (
                  <p class="organ-line" data-setpoint-grant>
                    Node grant: <span class="sats">{sats(g().remaining_msat)}</span> of {sats(g().budget_msat)} sats left, {hoursLeft(g().expires_at_ms, props.now)} h
                  </p>
                )}
              </Show>
              <For each={x().rows.slice(0, 3)}>
                {(r) => <SetpointBar label={props.nameOfTrack(`${r.room ? 'room' : 'peer'}:${r.target}`)} spent={r.spent_msat} limit={r.limit_msat} note="today" data={r.target} />}
              </For>
              <For each={x().reached.slice(0, 2)}>
                {(r: Setpoint) => (
                  <p class="organ-line" data-setpoint-reached={r.target}>
                    Resting: {props.nameOfTrack(`${r.room ? 'room' : 'peer'}:${r.target}`)} setpoint reached ({sats(r.spent_msat)}/{sats(r.limit_msat)} sats today). Frees as older payments pass 24 h.
                  </p>
                )}
              </For>
              <Show when={x().unsettled_msat > 0}>
                <p class="organ-note">Includes {sats(x().unsettled_msat)} sats whose outcome is not known yet.</p>
              </Show>
            </>
          )}
        </Match>
      </Switch>
      <Show when={h().state === 'holding' || h().state === 'none'}>
        <p class="organ-actions">
          <button type="button" class="link" data-setpoint-lower onClick={() => props.onSetpoints()}>Lower a setpoint</button>
          <Show when={h().state === 'holding'}>
            <button type="button" class="link" data-setpoint-pause onClick={() => props.onPauseAll()}>Pause all</button>
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
