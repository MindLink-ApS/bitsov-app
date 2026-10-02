// Display helpers. Keep msat precision in the selected denomination.
// Denomination (sats vs BTC) follows the settings toggle — amounts stay msat.
// Call sites must use amount() (or sats()+satUnit()); never append a unit literal.

import { denom } from './prefs';

/** 1 BTC = 1e8 sats = 1e11 msat. */
const MSAT_PER_BTC = 100_000_000_000;

/** Number only (no unit). BTC mode keeps every msat digit (up to 11 fractional places). */
export function sats(msat: number): string {
  if (denom() === 'btc') return btc(msat);
  return (msat / 1000).toLocaleString(navigator.language, { maximumFractionDigits: 3 });
}

/**
 * Exact BTC string from msat. No Math.round — 500 msat is 0.000000005 BTC,
 * and values just under 1 BTC never carry into a different sat.
 */
export function btc(msat: number): string {
  const n = Math.trunc(msat);
  if (!Number.isFinite(n) || n === 0) return '0';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const whole = Math.floor(abs / MSAT_PER_BTC);
  const fracMsat = abs - whole * MSAT_PER_BTC;
  if (fracMsat === 0) return `${sign}${whole}`;
  const frac = String(fracMsat).padStart(11, '0').replace(/0+$/, '');
  return `${sign}${whole}.${frac}`;
}

/** `sat` / `sats` / `BTC`, matching the number returned by sats(). */
export const satUnit = (msat: number) => {
  if (denom() === 'btc') return 'BTC';
  return msat === 1000 ? 'sat' : 'sats';
};

/** Number and unit together. Prefer this at every display site. */
export const amount = (msat: number) => `${sats(msat)} ${satUnit(msat)}`;

export const satsWhole = (value: number) => value.toLocaleString(navigator.language);

/** `1a2b3c4d…9f8e7d6c` for a 64-hex id. */
export const shortId = (id: string) => (id.length > 20 ? `${id.slice(0, 8)}…${id.slice(-8)}` : id);

export function ago(thenMs: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function uptime(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function day(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Ordinary caller limit; the host passes it to the node, which can only narrow it. */
export function routingFee(msat: number): number {
  return msat === 0 ? 0 : Math.min(Math.max(5000, Math.floor(msat / 100)), 10000);
}
export const allIn = (msat: number) => msat + routingFee(msat);
export const feeCeiling = (msat: number) => `up to ${amount(msat)} network fee`;
