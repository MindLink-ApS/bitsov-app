import { ROWS_GLOBAL, readRows, type SitRow } from './rows';

/** Globals set by the host's init script (src-tauri assistant_source.rs). */
export const SOURCE_GLOBAL = '__BITSOV_ASSISTANT_SOURCE__';
export const LIVE_ROWS_GLOBAL = '__BITSOV_LIVE_ROWS__';

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

export type View = { source: Source; rows: SitRow[] };

/** Live rows only when the host said live and handed over valid rows. */
export function readView(scope: object = globalThis): View {
  const source = readSource(scope);
  if (source.kind === 'live') {
    const live = readRows(scope, LIVE_ROWS_GLOBAL);
    if (live.length > 0) return { source, rows: live };
    return { source: UNKNOWN, rows: readRows(scope, ROWS_GLOBAL) };
  }
  return { source, rows: readRows(scope, ROWS_GLOBAL) };
}

const REASON_TEXT: Record<MockReason, string> = {
  not_paired: 'Not paired with a node.',
  node_unreachable: 'Node unreachable.',
  rc7_fallback: 'Node has no pairing routes (rc7 fallback).',
  unknown: 'Source unknown.',
};

/** Headline and detail for the label above the rows. */
export function sourceText(source: Source): { title: string; detail: string } {
  if (source.kind === 'live') {
    return { title: 'Live', detail: 'Read from your paired node.' };
  }
  return { title: 'Mock data', detail: `Not your node. ${REASON_TEXT[source.reason]}` };
}
