import { t as tr } from '../i18n';
/** Global set by the window's initialization script (src-tauri sit_mock.rs). */
export const ROWS_GLOBAL = '__BITSOV_SIT_ROWS__';

/** Fixture size. A longer list is refused, not truncated. */
export const MAX_ROWS = 50;

export type SitRow = { id: string; answer: string };

/**
 * Read the rows the host handed over. Anything that is not a list of
 * `[id, answer]` string pairs is refused and yields no rows.
 */
export function readRows(scope: object = globalThis, global: string = ROWS_GLOBAL): SitRow[] {
  const raw: unknown = (scope as Record<string, unknown>)[global];
  if (!Array.isArray(raw) || raw.length > MAX_ROWS) return [];
  const rows: SitRow[] = [];
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length !== 2) return [];
    const [id, answer] = entry;
    if (typeof id !== 'string' || typeof answer !== 'string') return [];
    if (!/^q\d{2}$/.test(id) || answer.length === 0) return [];
    rows.push({ id, answer });
  }
  return rows;
}

/** Plain-text form, one `id answer` line per row. Same as the SIT example. */
export function rowsText(rows: SitRow[]): string {
  return rows.map((row) => `${row.id} ${row.answer}\n`).join('');
}

/** Shown instead of a blank window when the host handed over no rows. */
export const NO_ROWS_TEXT = () => tr('caNothingToShowYetCloseThisWindowAndOpen') +
  tr('caDevelopersStartTheAppWithNpmRunTauriAssistant');
