import { t as tr } from '../i18n';
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
import { onEscape } from './escapeStack';

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

// ---- plain-language help (ⓘ) --------------------------------------------------

type InfoCard = { head: string; body: string };
const INFO: Record<string, { title: string; cards: InfoCard[] }> = {
  metabolism: {
    get title() { return tr('caMetabolism'); },
    cards: [
      { get head() { return tr('caWhatItIs'); }, get body() { return tr('caTheSatsMovingInAndOutOfYourNode'); } },
      { get head() { return tr('caWhatYouSee'); }, get body() { return tr('caAPlusForSatsThatCameInAMinus'); } },
      { get head() { return tr('caWhyItMatters'); }, get body() { return tr('caItIsTheQuickWayToCheckThatMoney'); } },
    ],
  },
  membrane: {
    get title() { return tr('caMembrane'); },
    cards: [
      { get head() { return tr('caWhatItIs'); }, get body() { return tr('caTheGateAtTheEdgeOfYourNodeEverything'); } },
      { get head() { return tr('caWhatYouSee'); }, get body() { return tr('caWhoWasLetInWhoWasLetBackIn'); } },
      { get head() { return tr('caWhyItMatters'); }, get body() { return tr('caARefusalMeansNothingGotThroughAndNothingWas'); } },
    ],
  },
  setpoints: {
    get title() { return tr('caSetPoints'); },
    cards: [
      { get head() { return tr('caWhatItIs'); }, get body() { return tr('caSpendingLimitsYouChooseEachOneIsALevel'); } },
      { get head() { return tr('caWhatYouSee'); }, get body() { return tr('caHowMuchWasSpentAgainstEachLimitOverThe'); } },
      { get head() { return tr('caWhyItMatters'); }, get body() { return tr('caWhenALimitIsReachedSpendingPausesUntilYou'); } },
    ],
  },
  immune: {
    get title() { return tr('caImmuneMemory'); },
    cards: [
      { get head() { return tr('caWhatItIs'); }, get body() { return tr('caAPlaceToKeepEvidenceOfPastProblemsSuch'); } },
      { get head() { return tr('caWhatYouSee'); }, get body() { return tr('caForNowNotBuiltNothingIsStoredHereYet'); } },
      { get head() { return tr('caWhyItMatters'); }, get body() { return tr('caOnceItExistsYourNodeCanRememberBadExperiences'); } },
    ],
  },
};
const [infoKey, setInfoKey] = createSignal<string | null>(null);

function InfoButton(props: { id: string }) {
  return (
    <Show when={INFO[props.id]}>
      <button
        type="button"
        class="info-btn"
        data-info={props.id}
        aria-label={tr('caWhatIs', INFO[props.id].title)}
        title={tr('caWhatIs', INFO[props.id].title)}
        onClick={() => setInfoKey(props.id)}
      >
        ⓘ
      </button>
    </Show>
  );
}

function InfoModal() {
  let dialog: HTMLDivElement | undefined;
  createEffect(on(() => infoKey() !== null, (open) => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    queueMicrotask(() => { if (infoKey() && dialog?.isConnected) dialog.focus(); });
    onCleanup(onEscape(() => setInfoKey(null)));
    onCleanup(() => queueMicrotask(() => { if (opener?.isConnected) opener.focus(); }));
  }));
  onCleanup(() => setInfoKey(null));
  return (
    <Show when={INFO[infoKey() ?? '']}>
      {(i) => (
        <div class="info-scrim" data-info-modal={infoKey()!} onClick={(e) => { if (e.target === e.currentTarget) setInfoKey(null); }}>
          <div ref={dialog} tabindex="-1" class="info-modal" role="dialog" aria-modal="true" aria-label={i().title}>
            <h3>{i().title}</h3>
            <For each={i().cards}>
              {(c) => (
                <div class="info-card">
                  <strong>{c.head}</strong>
                  <p>{c.body}</p>
                </div>
              )}
            </For>
            <button type="button" class="primary soft" data-info-close onClick={() => setInfoKey(null)}>{tr('caGotIt')}</button>
          </div>
        </div>
      )}
    </Show>
  );
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
  resumeBlocked?: boolean;
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
      <Organ id="immune" title={tr('caImmuneMemory')} summary={<span>{tr('caNotBuilt')}</span>} fresh={{ label: tr('caNotBuilt170'), stale: false }} sample={props.sample} source={tr('caEvidenceNotYet')}>
        <p class="organ-line" data-immune>{tr('caEvidenceKeepingNotBuilt')}</p>
      </Organ>
      <NucleusOrgan {...props} />
      <InfoModal />
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
      <div class="organ-headrow">
        <button type="button" class="organ-head" aria-expanded={open()} onClick={() => setOpen(!open())}>
          <span class="organ-name">{props.title}</span>
          <span class="organ-summary">{props.summary}</span>
          <Show when={props.sample}>
            <span class="sample-tag" data-sample-tag>{tr('caSample')}</span>
          </Show>
          <span class="organ-fresh" classList={{ stale: props.fresh.stale }} data-organ-fresh>{props.fresh.label}</span>
          <span class="organ-chev" aria-hidden="true">›</span>
        </button>
        <InfoButton id={props.id} />
      </div>
      <div class="organ-body">
        {props.children}
        <p class="organ-src">{props.source}</p>
      </div>
    </section>
  );
}

// ---- metabolism ---------------------------------------------------------------

const plus = (msat: number) => (msat > 0 ? `+${amount(msat, 'down')}` : amount(0, 'down'));
const minus = (msat: number) => (msat > 0 ? `−${amount(msat, 'up')}` : amount(0, 'up'));
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
      title={tr('caMetabolism')}
      hot={hot()}
      summary={<span class="sats">{plus(m().hour.in_msat)} / {minus(m().hour.out_msat)}{' '}{tr('ca1H')}</span>}
      fresh={fresh()}
      sample={props.sample}
      source={
        m().source === 'node' ? (
          <>
            {tr('caNodeWideFromYourNodeSOwnRecordOf')}<Show when={m().truncated}>{' '}{tr('caMoreThanTheNodeReadsAtOnceTotalsAre')}</Show>
          </>
        ) : (
          <>
            {tr('caPaidMessagesIn')}{' '}{m().tracks_read} {m().tracks_read === 1 ? tr('caTrackExtra80') : tr('caTracks')}{' '}{tr('caReadHereLiveFeedNodeWideTotalsAndHourly')}</>
        )
      }
    >
      <table class="energy" aria-label={tr('caSatsInAndOut')}>
        <thead>
          <tr>
            <th scope="col"><span class="sr-only">{tr('extraDirection')}</span></th>
            <th scope="col" class="col">{tr('ca1H181')}</th>
            <th scope="col" class="col">{tr('ca24H')}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row" class="dir">{tr('caIn')}</th>
            <td class="sats energy-fig" data-energy="in-1h">{plus(m().hour.in_msat)}</td>
            <td class="sats energy-fig" data-energy="in-24h">{plus(m().day.in_msat)}</td>
          </tr>
          <tr>
            <th scope="row" class="dir">{tr('caOut')}</th>
            <td class="sats energy-fig" data-energy="out-1h">{minus(m().hour.out_msat)}</td>
            <td class="sats energy-fig" data-energy="out-24h">{minus(m().day.out_msat)}</td>
          </tr>
        </tbody>
      </table>
      <Show when={m().bars}>{(b) => <Bars bars={b()} now={props.now} />}</Show>
      <Show when={idle(m().hour)}>
        <p class="organ-line" data-energy-idle>{tr('caNoEnergyCrossedInTheLastHour')}</p>
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
    <div class="bars" role="img" aria-label={tr('caSatsPerHourLast24HoursOf24Hours', props.bars.buckets.length)} data-energy-bars>
      <For each={slots()}>
        {(b) =>
          b ? (
            <span class="hour-bar" title={`+${amount(b.in_msat, 'down')} / −${amount(b.out_msat, 'up')}`} data-bar>
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

const KIND_TEXT: Record<RefusalKind, string> = { get door() { return tr('caTheirDoor'); }, get price() { return tr('caPrice'); }, get setpoint() { return tr('caYourSetpoint'); }, get inbound() { return tr('caAtYourDoor'); } };

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
    if (props.nodeMembrane && props.membraneError) return { label: tr('caReadingUnavailable'), stale: true };
    if (!ringRead()) return { label: tr('caNotReadYet'), stale: true };
    return props.fresh;
  };
  const doorFresh = () => {
    if (!props.door) return null;
    const f = freshness(props.door.read_at, props.now);
    return props.doorError ? { label: tr('caCouldNotReReadLast', ago(props.door.read_at, props.now)), stale: true } : f;
  };
  const refusedNote = () => {
    const parts = [];
    if (props.nodeMembrane) {
      parts.push(!ringRead() ? tr('caAtYourDoorNotReadYet') : s().refused_by.inbound > 0 ? tr('caAtYourDoor194', inboundBy()) : ringCurrent() ? tr('caAtYourDoorNone') : tr('caAtYourDoorLastReadingHadNone'));
    }
    if (outboundBy()) parts.push(tr('caOutbound', outboundBy()));
    return parts.join(' · ') || tr('caOutboundExtra86');
  };
  return (
    <Organ
      id="membrane"
      title={tr('caMembrane')}
      summary={<span>{ringRead() ? tr('caInRefused', s().admitted, s().refused) : tr('caGateHistoryNotReadYet')}</span>}
      fresh={fresh()}
      sample={props.sample}
      source={
        props.nodeMembrane ? (
          <>
            {tr('caYourNodeSOwnGateDecisionsN2FromIts')}</>
        ) : (
          <>
            {tr('caSince')}{' '}{clock(props.openedAt)}{tr('caWhatYourNodeAdmittedAndYourSendsThatDid')}</>
        )
      }
    >
      <p class="organ-line door" data-door>
        <Show when={props.door} fallback={props.doorError ? <span data-door-fresh="stale">{tr('caDoorPriceCouldNotBeRead')}</span> : tr('caDoorPriceNotReadYet')}>
          {(d) => (
            <>
              {tr('caDoorOpenAt')}{' '}<span class="sats">{sats(d().msat, 'up', true)}</span> {satUnit(d().msat, 'up')}{' '}{tr('caAMessage')}<span class="organ-note">{' '}{tr('caYourPrice')}</span>
              <span class="organ-note" classList={{ stale: doorFresh()!.stale }} data-door-fresh={doorFresh()!.stale ? 'stale' : 'fresh'}>
                {' '}· {doorFresh()!.label}
              </span>
            </>
          )}
        </Show>
      </p>
      <div class="organ-row" data-membrane-admitted>
        <span class="who"><span class="dot ok" />{' '}{tr('caAdmitted')}</span>
        <span class="sats">{ringRead() ? s().admitted : '—'}</span>
        <span class="organ-note">
          <Show when={ringRead()} fallback={tr('caNotReadYet')}>
            {amount(s().admitted_msat, 'down')}{' '}{tr('caSettled')}<Show when={s().first_contacts > 0}> · {s().first_contacts}{' '}{tr('caFirstContact')}</Show>
          </Show>
        </span>
      </div>
      <Show when={s().readmitted > 0}>
        <div class="organ-row" data-membrane-readmitted>
          <span class="who"><span class="dot ok" />{' '}{tr('caAdmittedAgain')}</span>
          <span class="sats">{s().readmitted}</span>
          <span class="organ-note">
            {amount(s().readmitted_msat, 'down')}{' '}{tr('caPaidAfterAReconnectFromTheirOwnQuote')}</span>
        </div>
      </Show>
      <div class="organ-row" data-membrane-refused>
        <span class="who"><span class="dot err" />{' '}{tr('caRefused')}</span>
        <span class="sats">{ringRead() ? s().refused : '—'}</span>
        <span class="organ-note" data-membrane-refused-by>{refusedNote()}</span>
      </div>
      <Show
        when={props.membrane.length > 0}
        fallback={<p class="organ-line" data-membrane-quiet>{ringCurrent()
          ? tr('caSinceExtra90', props.prePaymentRefusals ? tr('caNoMessageGateEvents') : tr('caNoKnocks'), clock(props.openedAt))
          : props.membraneError ? tr('caGateHistoryUnavailable') : tr('caGateHistoryNotReadYet216')}</p>}
      >
        <For each={props.membrane.slice(0, 3)}>{(e) => <MembraneLine e={e} hot={e.seq > baseline} nameOf={props.nameOf} nameOfTrack={props.nameOfTrack} />}</For>
      </Show>
      <RefusalCounts counts={props.prePaymentRefusals} readAt={props.membraneReadAt} error={props.membraneError} now={props.now} down={props.down} />
      <Show when={!props.nodeMembrane}>
        <p class="organ-line muted" data-membrane-n2>{tr('caInboundRefusalsAreNotVisibleYetNodeN2')}</p>
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
                <span class="ok-word">{tr('caAdmitted')}</span> {a().first_contact ? shortId(a().sender) : props.nameOf(a().sender)}
                <Show when={a().paid_msat}>{' '}{tr('caPaid')}{' '}<span class="sats">{sats(a().paid_msat!, 'down', true)}</span> {satUnit(a().paid_msat!, 'down')}</Show>
                <Show when={a().first_contact}>{' '}{tr('caFirstContactNotAdded')}</Show>
              </span>
            );
          }}
        </Match>
        <Match when={props.e.verdict === 'readmitted' && props.e}>
          {(e) => {
            const a = () => e() as Extract<MembraneEntry, { verdict: 'readmitted' }>;
            return (
              <span data-membrane-readmission>
                <span class="ok-word">{tr('caPaidAgain')}</span> {props.nameOf(a().counterparty)} · {gateWords('readmission')}
                <Show when={a().paid_msat}> · <span class="sats">{sats(a().paid_msat!, 'down', true)}</span> {satUnit(a().paid_msat!, 'down')}</Show>
                <Show when={a().cap_msat}>{' '}{tr('caWithinTheirBudgetOf')}{' '}<span class="sats">{sats(a().cap_msat!, 'up', true)}</span> {satUnit(a().cap_msat!, 'up')}</Show>
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
                    <span class="err-word">{tr('caRefused')}</span> {r().track ? props.nameOfTrack(r().track!) : tr('caSend')} · {KIND_TEXT[r().kind]}
                    <span class="detail">{r().detail}</span>
                  </span>
                }
              >
                <span title={r().detail} data-membrane-inbound={r().code}>
                  <span class="err-word">{tr('caRefused')}</span> {r().sender ? props.nameOf(r().sender!) : tr('caUnsigned')} · {gateWords(r().code)}
                  <Show when={r().required_msat}>{' '}{tr('caNeeded')}{' '}<span class="sats">{sats(r().required_msat!, 'up', true)}</span> {satUnit(r().required_msat!, 'up')}</Show>
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
    if (x.state === 'holding') return tr('caHExtra94', amount(x.spent_msat, 'up'), amount(x.ceiling_msat, 'down'), hoursLeft(x.until_ms, props.now));
    if (x.state === 'paused') return tr('caPaused');
    if (x.state === 'waiting') return tr('caWaitingForYou');
    if (x.state === 'none') return tr('caNone');
    return '…';
  };
  return (
    <Organ
      id="setpoints"
      title={tr('caSetpoints')}
      hot={hot()}
      summary={<span class="sats">{summary()}</span>}
      fresh={fresh()}
      sample={props.sample}
      source={tr('caAppBudgetSource')}
    >
      <Switch>
        <Match when={h().state === 'unknown'}>
          <p class="organ-line">{tr('caReadingBudgets')}</p>
        </Match>
        <Match when={h().state === 'none' && (h() as Extract<Homeostasis, { state: 'none' }>)}>
          {(x) => (
            <>
              <p class="organ-line" data-setpoint-none>
                <Show when={x().expired}>{tr('uiYourDailyApprovalEnded')}{' '}</Show>{tr('caAutomaticPaymentIsOffManualMessagesAndFilesStill')}</p>
              <Show when={x().rows.length > 0}>
                <p class="organ-note">{x().rows.length}{' '}{tr('caSaved')}{' '}{x().rows.length === 1 ? tr('caBudget') : tr('caBudgets')}{' '}{tr('caStillLimitManualMessagesAndFilesApproveAutomaticMessages')}</p>
              </Show>
            </>
          )}
        </Match>
        <Match when={h().state === 'paused'}>
          <p class="organ-line" data-setpoint-paused>
            {tr('caPausedNewAppPaymentsAreBlockedInFlightPayments')}{' '}
            <button type="button" class="link" disabled={props.resumeBlocked} onClick={() => props.onResume()}>{tr('caResume')}</button>
          </p>
        </Match>
        <Match when={h().state === 'waiting'}>
          <p class="organ-line" data-setpoint-waiting>{tr('caWaitingForYourApprovalAtTheNode')}</p>
        </Match>
        <Match when={h().state === 'holding' && (h() as Extract<Homeostasis, { state: 'holding' }>)}>
          {(x) => (
            <>
              <SetpointBar label={tr('caAppAllIn24H')} spent={x().spent_msat} limit={x().ceiling_msat} note={tr('caHLeft', hoursLeft(x().until_ms, props.now))} data="ceiling" />
              <Show when={x().grant}>
                {(g) => (
                  <p class="organ-line" data-setpoint-grant>
                    {tr('caFiniteNodeGrant')}{' '}<span class="sats">{amount(g().remaining_msat, 'down', true)}</span>{' '}{tr('uiOf')}{' '}{amount(g().budget_msat, 'down')}{' '}{tr('caLeft')}{' '}{hoursLeft(g().expires_at_ms, props.now)}{' '}{tr('caH')}</p>
                )}
              </Show>
              <For each={x().rows.slice(0, 3)}>
                {(r) => <SetpointBar label={props.nameOfTrack(`${r.room ? 'room' : 'peer'}:${r.target}`)} spent={r.spent_msat} limit={r.limit_msat} note={tr('caTodayNote')} data={r.target} />}
              </For>
              <For each={x().reached.slice(0, 2)}>
                {(r: Setpoint) => (
                  <p class="organ-line" data-setpoint-reached={r.target}>
                    {tr('caResting')}{' '}{props.nameOfTrack(`${r.room ? 'room' : 'peer'}:${r.target}`)}{' '}{tr('caSetpointReached')}{amount(r.spent_msat, 'up')}/{amount(r.limit_msat, 'down')}{' '}{tr('caTodayFreesAsOlderPaymentsPass24H')}</p>
                )}
              </For>
              <Show when={x().unsettled_msat > 0}>
                <p class="organ-note">{tr('caIncludes')}{' '}{amount(x().unsettled_msat, 'up')}{' '}{tr('caWhoseOutcomeIsNotKnownYet')}</p>
              </Show>
            </>
          )}
        </Match>
      </Switch>
      <Show when={h().state === 'holding' || h().state === 'none'}>
        <p class="organ-actions">
          <button type="button" class="link" data-setpoint-lower onClick={() => props.onSetpoints()}>{tr('caLowerASetpoint')}</button>
          <Show when={h().state === 'holding'}>
            <button type="button" class="link" data-setpoint-pause onClick={() => props.onPauseAll()}>{tr('uiPauseAppPayments')}</button>
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
      <span class="sats">{amount(props.spent, 'up', true)}/{amount(props.limit, 'down', true)}</span>
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
      title={tr('caNucleus')}
      summary={<span class="id">{n().node_id ? shortId(n().node_id!) : '…'}</span>}
      fresh={fresh()}
      sample={props.sample}
      source={tr('caIdentitySource')}
    >
      <p class="organ-line">
        <span class="id" title={n().node_id ?? undefined} data-nucleus-id>{n().node_id ? shortId(n().node_id!) : tr('caIdentityNotReadYet')}</span>
      </p>
      <p class="organ-line" data-nucleus-chain>
        <Show when={n().block_height !== null} fallback={tr('caBlockHeightUnknown')}>
          {tr('caBlock')}{' '}<span class="sats">{satsWhole(n().block_height!, true)}</span>
        </Show>
        <span class="organ-note"> · {n().chain_backend ?? tr('caChainSourceUnknown')}</span>
      </p>
      <p class="organ-line warn-line" data-nucleus-backup>{tr('caRecoveryWordsNotVerifiedInThisApp')}</p>
    </Organ>
  );
}
