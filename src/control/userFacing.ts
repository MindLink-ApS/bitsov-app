/**
 * Soften backend refusal codes so the UI never shows raw snake_case strings
 * as the primary message. Details stay available behind a tap.
 */

export type SoftenedError = {
  /** One plain sentence for the owner. */
  summary: string;
  /** Raw or technical text, shown only when the owner opens Details. */
  detail: string | null;
  /** Money outcomes must never be replaced by a contextual fallback. */
  money?: boolean;
};

/** Map host/node error text to a calm summary (+ optional detail). */
export function softenError(raw: unknown): SoftenedError {
  const m = String(raw ?? '').trim();
  if (!m) return { summary: 'Something went wrong.', detail: null };

  // Preserve the entire money warning. In particular, transport/address text
  // inside an unknown or settled outcome must not turn it into a connection error.
  if (/\b(?:payment|spend)_[a-z_]+\b|\b(?:failed_paid|undelivered_pending|price_cap_exceeded|budget_exceeded|budget_exhausted|ceiling_exhausted)\b|\b(?:paid|charged|settled)\b|\b(?:payment|spend)(?: status| outcome)? (?:is )?(?:unknown|refused|failed|uncertain)\b/i.test(m)) {
    return { summary: m.replace(/\b(payment_refused|spend_unknown|payment_unknown|payment_settled_undelivered)\b/g, code => code.replace(/_/g, ' ')), detail: null, money: true };
  }

  // The proxy wraps this advice in a 503, sometimes with an endpoint prefix.
  // Extract only the countdown, never an arbitrary technical response body.
  const retry = /\b(?:remote_retry_wait|rate_limited)\b.*?waiting (\d+) s\b/i.exec(m);
  if (retry) return { summary: `Remote connection unavailable · waiting ${retry[1]} s`, detail: m };

  if (
    /introduction_unavailable/i.test(m) ||
    /no[ _]dialable[ _]peer[ _]endpoint/i.test(m) ||
    /advertised_addr/i.test(m)
  ) {
    return {
      summary: 'We could not find a public address for your node yet.',
      detail: m,
    };
  }

  if (/connection[ _]refused|ECONN|network[ _]error|failed to fetch|timed?[ _]out|connection[ _](lost|closed)/i.test(m)) {
    return { summary: 'We could not connect to your node.', detail: m };
  }

  const technical = (text: string) => /[a-z0-9]+_[a-z0-9_]+|\b(?:Error|TypeError):|[{}\n]|(?:https?:|bitsov:)\/\/|(?:^|\s)\/[\w/.-]+|\b[45]\d\d\b|\b[a-f0-9]{16,}\b|\b[\w.-]+:\d{2,5}\b/i.test(text);
  // Known refusals may carry readable advice, but never surface a raw dump.

  const coded = /^([a-z][a-z0-9_]+):\s*(.+)$/is.exec(m);
  if (coded) {
    const [, code, rest] = coded;
    if (/unavailable|not_found|refused|denied|invalid/i.test(code) && !technical(rest)) {
      return { summary: rest.trim() || 'That is not available right now.', detail: m };
    }
  }

  return technical(m)
    ? { summary: 'That could not be completed. Open Details for more information.', detail: m }
    : { summary: m, detail: null };
}
