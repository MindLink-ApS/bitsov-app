import { ROWS_GLOBAL, readRows, type SitRow } from './rows';

/** Globals set by the host's init script (src-tauri assistant_source.rs). */
export const SOURCE_GLOBAL = '__BITSOV_ASSISTANT_SOURCE__';
export const LIVE_ROWS_GLOBAL = '__BITSOV_LIVE_ROWS__';
export const FRESHNESS_GLOBAL = '__BITSOV_LIVE_FRESHNESS__';

export type MockReason = 'not_paired' | 'node_unreachable' | 'rc7_fallback' | 'unknown';
export type Source = { kind: 'live' } | { kind: 'mock'; reason: MockReason };

const HOST_REASONS: readonly string[] = ['not_paired', 'node_unreachable', 'rc7_fallback'];

const UNKNOWN: Source = { kind: 'mock', reason: 'unknown' };

/**
 * Read the host's decision. Only the exact shapes the host writes are
 * accepted; anything else is mock with an unknown reason. The page never
 * writes these globals.
 */
export function readSource(scope: object = globalThis): Source {
  const raw: unknown = (scope as Record<string, unknown>)[SOURCE_GLOBAL];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return UNKNOWN;
  const keys = Object.keys(raw).sort().join(',');
  const value = raw as Record<string, unknown>;
  if (keys === 'kind' && value.kind === 'live') return { kind: 'live' };
  if (
    keys === 'kind,reason' &&
    value.kind === 'mock' &&
    typeof value.reason === 'string' &&
    HOST_REASONS.includes(value.reason)
  ) {
    return { kind: 'mock', reason: value.reason as MockReason };
  }
  return UNKNOWN;
}

export type FreshnessState = 'fresh' | 'stale' | 'unknown';
export type RouteKey = 'balance' | 'channels' | 'health' | 'messages' | 'pricing';
export type RouteFreshness = {
  route: RouteKey;
  state: FreshnessState;
  ageMs: number | null;
  clockSkew: boolean;
  /** The route's own bound (host `stale_after`): 180 s balance/channels, else 60 s. */
  staleAfterMs: number;
};
/** Per-route ages the host measured when it wrote the init script. */
export type Freshness = { routes: RouteFreshness[] };

const ROUTE_KEYS: readonly string[] = ['balance', 'channels', 'health', 'messages', 'pricing'];
const STATES: readonly string[] = ['fresh', 'stale', 'unknown'];

function isAge(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function readRoute(raw: unknown, seen: Set<string>): RouteFreshness | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const keys = Object.keys(raw).sort().join(',');
  if (keys !== 'age_ms,clock_skew,route,stale_after_ms,state') return null;
  const {
    route,
    state,
    age_ms: ageMs,
    clock_skew: clockSkew,
    stale_after_ms: staleAfterMs,
  } = raw as Record<string, unknown>;
  if (typeof route !== 'string' || !ROUTE_KEYS.includes(route) || seen.has(route)) return null;
  if (typeof state !== 'string' || !STATES.includes(state)) return null;
  if (typeof clockSkew !== 'boolean') return null;
  if (!isAge(staleAfterMs) || staleAfterMs === 0) return null;
  // The node can explicitly mark stale without knowing a data timestamp.
  if (state === 'unknown' && ageMs !== null) return null;
  if (state === 'fresh' && !isAge(ageMs)) return null;
  if (state === 'stale' && ageMs !== null && !isAge(ageMs)) return null;
  seen.add(route);
  return {
    route: route as RouteKey,
    state: state as FreshnessState,
    ageMs: ageMs as number | null,
    clockSkew,
    staleAfterMs,
  };
}

/**
 * Read the host's per-route freshness. Anything but the exact host shape is
 * refused and yields `null` (freshness unknown).
 */
export function readFreshness(scope: object = globalThis): Freshness | null {
  const raw: unknown = (scope as Record<string, unknown>)[FRESHNESS_GLOBAL];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  if (Object.keys(raw).sort().join(',') !== 'routes') return null;
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.routes) || value.routes.length > ROUTE_KEYS.length) return null;
  const seen = new Set<string>();
  const routes: RouteFreshness[] = [];
  for (const entry of value.routes) {
    const route = readRoute(entry, seen);
    if (!route) return null;
    routes.push(route);
  }
  return { routes };
}

export type View = { source: Source; rows: SitRow[]; freshness: Freshness | null };

/**
 * Live rows only when the host said live and handed over valid rows.
 * Freshness only with live rows: mock rows make no freshness claim.
 */
export function readView(scope: object = globalThis): View {
  const source = readSource(scope);
  if (source.kind === 'live') {
    const live = readRows(scope, LIVE_ROWS_GLOBAL);
    if (live.length > 0) return { source, rows: live, freshness: readFreshness(scope) };
    return { source: UNKNOWN, rows: readRows(scope, ROWS_GLOBAL), freshness: null };
  }
  return { source, rows: readRows(scope, ROWS_GLOBAL), freshness: null };
}

export type FreshnessSummary = { state: FreshnessState; ageMs: number | null; clockSkew: boolean };

/**
 * One state for the label: the oldest route read, aged by how long the window
 * has been open (`openMs`, from a monotonic clock). Each route is stale past
 * its own bound; the label is stale if any is. With `only`, just that route.
 * Unknown routes cannot be hidden by fresh routes. Explicit stale markers
 * take precedence even when the node supplies no data timestamp.
 */
export function summarize(
  freshness: Freshness | null,
  openMs: number,
  only?: RouteKey,
): FreshnessSummary {
  const open = Math.max(0, openMs);
  const routes = freshness?.routes.filter((route) => only === undefined || route.route === only) ?? [];
  if (routes.length === 0) {
    return { state: 'unknown', ageMs: null, clockSkew: false };
  }
  const known = routes.filter((route) => route.ageMs !== null);
  const clockSkew = routes.some((route) => route.clockSkew);
  const stale = routes.some(
    (route) => route.state === 'stale' || (route.ageMs !== null && route.ageMs + open >= route.staleAfterMs),
  );
  if (!stale && routes.some((route) => route.state === 'unknown')) {
    return { state: 'unknown', ageMs: null, clockSkew };
  }
  const missingStaleAge = routes.some((route) => route.state === 'stale' && route.ageMs === null);
  const ageMs = missingStaleAge || known.length === 0
    ? null
    : Math.max(...known.map((route) => route.ageMs as number)) + open;
  return {
    state: stale ? 'stale' : 'fresh',
    ageMs,
    clockSkew,
  };
}

function ageText(ageMs: number): string {
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  return `${Math.floor(seconds / 3600)} h`;
}

/** Freshness line for the label. Closed set of strings plus a number. */
export function freshnessText(summary: FreshnessSummary): string {
  let text = 'Freshness unknown.';
  if (summary.state === 'stale' && summary.ageMs === null) {
    text = 'Stale: data age unknown. Reopen to refresh.';
  } else if (summary.state !== 'unknown' && summary.ageMs !== null) {
    const age = ageText(summary.ageMs);
    text = summary.state === 'stale'
      ? `Stale: updated ${age} ago. Reopen to refresh.`
      : `Updated ${age} ago.`;
  }
  return summary.clockSkew ? `${text} Node clock is ahead of this computer.` : text;
}

const REASON_TEXT: Record<MockReason, string> = {
  not_paired: 'Not paired with a node.',
  node_unreachable: 'Node unreachable.',
  rc7_fallback: 'Node has no pairing routes (rc7 fallback).',
  unknown: 'Source unknown.',
};

/** Why the rows are mock, in one plain sentence. */
export function mockReasonText(reason: MockReason): string {
  return REASON_TEXT[reason];
}

/** Headline and detail for the label above the rows. */
export function sourceText(source: Source): { title: string; detail: string } {
  if (source.kind === 'live') {
    return { title: 'Live', detail: 'Read from your paired node.' };
  }
  return { title: 'Mock data', detail: `Not your node. ${REASON_TEXT[source.reason]}` };
}
