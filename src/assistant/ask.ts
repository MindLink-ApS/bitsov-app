import type { SitRow } from './rows';

/**
 * Gives the answer for a question id, or `null` if there is none. May take
 * time; `signal` aborts when the person presses Stop. The window never waits
 * on it to stop.
 */
export type Answerer = (id: string, signal: AbortSignal) => Promise<string | null>;

/**
 * Answers from the rows the host handed over at open. Reads nothing and asks
 * the host nothing.
 */
export function rowsAnswerer(rows: readonly SitRow[]): Answerer {
  const byId = new Map(rows.map((row) => [row.id, row.answer]));
  return async (id) => byId.get(id) ?? null;
}

export const UNAVAILABLE = 'Unavailable';
