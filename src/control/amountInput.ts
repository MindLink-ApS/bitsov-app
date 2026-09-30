// Typed amounts for Pay and Request. The text is read in the current
// denomination and becomes an exact integer msat by string arithmetic: no
// float multiplication, and nothing finer than one msat is ever rounded away.
// An amount that cannot be exact is refused (null), never nudged.

import type { Denom } from './prefs';

/** The host's bounds for a typed keysend or invoice amount (act.rs MIN/MAX_PAYMENT_MSAT). */
export const MIN_PAYMENT_MSAT = 1_000;
export const MAX_PAYMENT_MSAT = 100_000_000_000;
export const inPaymentBounds = (msat: number) => msat >= MIN_PAYMENT_MSAT && msat <= MAX_PAYMENT_MSAT;

/** Fractional digits that still land on a whole msat. */
const PLACES: Record<Denom, number> = { sats: 3, btc: 11 };

/** `21`, `0.5`, `.5`, `5.`: digits with at most one dot. Spaces and `_` are ignored. */
const SHAPE = /^(\d*)(?:\.(\d*))?$/;

/** Exact msat for `text` read in `denom`, or null when empty, zero, too precise or too large. */
export function parseAmount(text: string, denom: Denom): number | null {
  const m = SHAPE.exec(text.replace(/[\s_]/g, ''));
  if (!m) return null;
  const [, whole, frac = ''] = m;
  if (!whole && !frac) return null;
  const places = PLACES[denom];
  // Trailing zeros carry no value: 0.500 sats is 500 msat, not "too precise".
  const digits = frac.replace(/0+$/, '');
  if (digits.length > places) return null;
  const msat = BigInt(whole || '0') * 10n ** BigInt(places) + BigInt(digits.padEnd(places, '0') || '0');
  if (msat <= 0n || msat > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(msat);
}

/** The input text for an exact msat in `denom` (no grouping), so it parses back to the same msat. */
export function amountText(msat: number, denom: Denom): string {
  const places = PLACES[denom];
  const n = BigInt(Math.trunc(msat));
  const unit = 10n ** BigInt(places);
  const frac = (n % unit).toString().padStart(places, '0').replace(/0+$/, '');
  return frac ? `${n / unit}.${frac}` : `${n / unit}`;
}
