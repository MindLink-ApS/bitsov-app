/**
 * Soften backend refusal codes so the UI never shows raw snake_case strings
 * as the primary message. Details stay available behind a tap.
 */

export type SoftenedError = {
  /** One plain sentence for the owner. */
  summary: string;
  /** Raw or technical text, shown only when the owner opens Details. */
  detail: string | null;
};

/** Map host/node error text to a calm summary (+ optional detail). */
export function softenError(raw: unknown): SoftenedError {
  const m = String(raw ?? '').trim();
  if (!m) return { summary: 'Something went wrong.', detail: null };

  if (
    /introduction_unavailable/i.test(m) ||
    /no dialable peer endpoint/i.test(m) ||
    /advertised_addr/i.test(m)
  ) {
    return {
      summary: 'We could not find a public address for your node yet.',
      detail: m,
    };
  }

  // Other `code: detail` refusals: keep a readable front, raw behind Details.
  const coded = /^([a-z][a-z0-9_]+):\s*(.+)$/is.exec(m);
  if (coded) {
    const [, code, rest] = coded;
    if (/unavailable|not_found|refused|denied/i.test(code)) {
      return { summary: rest.trim() || 'That is not available right now.', detail: m };
    }
  }

  return { summary: m, detail: null };
}
