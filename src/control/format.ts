import { t, language } from '../i18n';
// Display helpers. Keep msat precision in the selected denomination.
// Denomination (sats vs BTC) follows the settings toggle — amounts stay msat.
// Call sites must use amount() (or sats()+satUnit()); never append a unit literal.

import { denom } from './prefs';
import { isMobilePlatform } from '../platform';

/** Use narrow no-break spaces so a number cannot wrap between digit groups.
 * Opt into display-only thin spaces only inside a white-space: nowrap container. */
export const groupDigits = (value: string, nowrap = false) => value.replace(/\B(?=(\d{3})+(?!\d))/g, nowrap ? '\u2009' : '\u202f');
// Display only: Danish decimal commas are refused by the input parser, never
// mistaken for thousands. Editable amounts retain amountText()'s exact syntax.
const satsDecimal = () => language() === 'da' ? ',' : '.';
const groupAmount = (value: string, nowrap = false) => {
  const [whole, fraction] = value.split('.');
  return groupDigits(whole, nowrap) + (fraction === undefined ? '' : `${satsDecimal()}${fraction}`);
};

/** 1 BTC = 1e8 sats = 1e11 msat. */
const MSAT_PER_BTC = 100_000_000_000;

/** Number only (no unit). BTC mode keeps every msat digit (up to 11 fractional places). */
export function sats(msat: number, nowrap = false): string {
  if (denom() === 'btc') return btc(msat, nowrap);
  if (!Number.isSafeInteger(msat)) return groupAmount((msat / 1000).toFixed(3).replace(/\.?0+$/, ''), nowrap);
  const absolute = Math.abs(msat);
  const whole = Math.floor(absolute / 1000);
  const fraction = String(absolute % 1000).padStart(3, '0').replace(/0+$/, '');
  return `${msat < 0 ? '-' : ''}${groupDigits(String(whole), nowrap)}${fraction ? `${satsDecimal()}${fraction}` : ''}`;
}

/**
 * Exact BTC string from msat. No Math.round — 500 msat is 0.000000005 BTC,
 * and values just under 1 BTC never carry into a different sat.
 */
export function btc(msat: number, nowrap = false): string {
  const n = Math.trunc(msat);
  if (!Number.isFinite(n) || n === 0) return '0';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const whole = Math.floor(abs / MSAT_PER_BTC);
  const fracMsat = abs - whole * MSAT_PER_BTC;
  if (fracMsat === 0) return `${sign}${groupDigits(String(whole), nowrap)}`;
  const frac = String(fracMsat).padStart(11, '0').replace(/0+$/, '');
  return `${sign}${groupDigits(String(whole), nowrap)}.${frac}`;
}

/** `sat` / `sats` / `BTC`, matching the number returned by sats(). */
export const satUnit = (msat: number) => {
  if (denom() === 'btc') return 'BTC';
  return msat === 1000 ? 'sat' : 'sats';
};

/** Number and unit together. Prefer this at every display site. */
export const amount = (msat: number, nowrap = false) => `${sats(msat, nowrap)} ${satUnit(msat)}`;

export const satsWhole = (value: number, nowrap = false) => groupAmount(String(value), nowrap);

/** `1a2b3c4d…9f8e7d6c` for a 64-hex id. */
export const shortId = (id: string) => (id.length > 20 ? `${id.slice(0, 8)}…${id.slice(-8)}` : id);

export function ago(thenMs: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (s < 5) return t('uiJustNow');
  if (s < 60) return t('uiSAgo', s);
  const m = Math.round(s / 60);
  if (m < 60) return t('uiMinAgo', m);
  const h = Math.round(m / 60);
  if (h < 48) return t('uiHAgo', h);
  return t('uiDaysAgo', Math.round(h / 24));
}

export function uptime(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return t('caUptimeDays', d, h);
  if (h > 0) return t('caUptimeHours', h, m);
  return t('caUptimeMinutes', m);
}

export function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function day(ms: number): string {
  return new Date(ms).toLocaleDateString(language(), { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Ordinary caller limit; the host passes it to the node, which can only narrow it. */
export function routingFee(msat: number): number {
  return msat === 0 ? 0 : Math.min(Math.max(5000, Math.floor(msat / 100)), 10000);
}
export const allIn = (msat: number) => msat + routingFee(msat);
export const feeCeiling = (msat: number) => t('uiUpToNetworkFee', amount(msat));

/** Settled principal is known even when an older node cannot report its fee. */
export function paidAmount(principal: number, fee?: number): string {
  const known = fee !== undefined && Number.isSafeInteger(fee) && fee >= 0;
  const total = principal + (known ? fee : 0);
  if (!Number.isSafeInteger(total) || total < 0) return t('uiPaidAmountUnknown');
  // Phones keep the receipt short: the unreported-fee note stays on the Mac and in the payment's details.
  return t('uiPaid498', amount(total), known || isMobilePlatform() ? '' : t('uiNetworkFeeNotReported'));
}

/** Additional liabilities never masquerade as paid amounts. */
export function budgetNote(b?: import('./types').BudgetAccounting): string {
  if (!b) return '';
  const notes: string[] = [];
  if (b.unsettled_msat) notes.push(t('uiReserved', amount(b.unsettled_msat)));
  if (b.fee_unknown) {
    notes.push(t('uiNetworkFeeNotReported502'));
    const held = (b.accounted_msat ?? b.spent_msat) - b.spent_msat - (b.unsettled_msat ?? 0);
    if (held > 0) notes.push(t('uiUpToHeldForUnreportedCosts', amount(held)));
  }
  return notes.join(' · ');
}
