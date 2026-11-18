import { t, language } from '../i18n';
// Display helpers. Sats show whole numbers (rounded up); BTC keeps msat precision.
// Denomination (sats vs BTC) follows the settings toggle — amounts stay msat.
// Call sites must use amount() (or sats()+satUnit()); never append a unit literal.

import { denom } from './prefs';

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

/**
 * Which way a whole-sat display rounds. Every display site picks one:
 * - 'up' for a cost, a price, a ceiling or a limit: never shown smaller than what may be paid;
 * - 'down' for money received, a balance or what can still be spent: never shown larger than what is there.
 */
export type Rounding = 'up' | 'down';

/** Whole sats for display only; amounts stay msat everywhere else. */
export function wholeSats(msat: number, round: Rounding): { sats: number; rounded: boolean } {
  const absolute = Math.abs(msat);
  const whole = round === 'up' ? Math.ceil(absolute / 1000) : Math.floor(absolute / 1000);
  return { sats: msat < 0 ? -whole : whole, rounded: whole * 1000 !== absolute };
}

const wholeText = (msat: number, round: Rounding, nowrap: boolean) => {
  const shown = wholeSats(msat, round);
  return `${shown.sats < 0 ? '-' : ''}${groupDigits(String(Math.abs(shown.sats)), nowrap)}`;
};

/** Number only (no unit). Sats show whole numbers ("about"/"ca." when rounded); BTC mode keeps every msat digit. */
export function sats(msat: number, round: Rounding, nowrap = false): string {
  if (denom() === 'btc') return btc(msat, nowrap);
  const shown = wholeSats(msat, round);
  // Rounding a small incoming amount down to 0 would hide it: say "less than 1".
  if (shown.sats === 0 && msat > 0) return t('amountUnderOne', '1');
  const number = wholeText(msat, round, nowrap);
  return shown.rounded ? t('amountAbout', number) : number;
}

/** An estimate's figure: "≈ 10" (the sign already says it is rounded), otherwise sats(). */
export function estimatedSats(msat: number, estimate: boolean, round: Rounding, nowrap = false): string {
  if (!estimate) return sats(msat, round, nowrap);
  if (denom() === 'btc') return `≈ ${btc(msat, nowrap)}`;
  return `≈ ${wholeText(msat, round, nowrap)}`;
}

/** Exact sats with msat decimals, for technical details only. */
export function exactSats(msat: number, nowrap = false): string {
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

/** `sat` / `sats` / `BTC`, matching the number returned by sats() with the same rounding. */
export const satUnit = (msat: number, round: Rounding) => {
  if (denom() === 'btc') return 'BTC';
  const shown = Math.abs(wholeSats(msat, round).sats);
  return shown === 1 || (shown === 0 && msat > 0) ? 'sat' : 'sats';
};

/** Number and unit together. Prefer this at every display site. */
export const amount = (msat: number, round: Rounding, nowrap = false) => `${sats(msat, round, nowrap)} ${satUnit(msat, round)}`;

/**
 * A total shown beside its parts. Each part rounds up on its own, so the total
 * shown is the sum of the parts as shown: the figures visibly add up and the
 * total is never smaller than the real one. When the parts do not add up to the
 * total exactly, the total is shown on its own (rounded up).
 */
export function shownTotal(total: number, parts: number[]): string {
  if (denom() === 'btc' || parts.reduce((a, b) => a + b, 0) !== total) return amount(total, 'up');
  const shown = parts.map((m) => wholeSats(m, 'up'));
  const sum = shown.reduce((a, b) => a + b.sats, 0);
  const text = `${groupDigits(String(sum))} ${sum === 1 ? 'sat' : 'sats'}`;
  return shown.some((p) => p.rounded) ? t('amountAbout', text) : text;
}

/** Number and unit with every msat digit, for a Details disclosure (where parts must add up exactly). */
export const exactAmount = (msat: number, nowrap = false) =>
  denom() === 'btc' ? `${btc(msat, nowrap)} BTC` : `${exactSats(msat, nowrap)} ${msat === 1000 ? 'sat' : 'sats'}`;

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
export const feeCeiling = (msat: number) => t('uiUpToNetworkFee', amount(msat, 'up'));

/** Settled principal is known even when an older node cannot report its fee. */
export function paidAmount(principal: number, fee?: number): string {
  const known = fee !== undefined && Number.isSafeInteger(fee) && fee >= 0;
  const total = principal + (known ? fee : 0);
  if (!Number.isSafeInteger(total) || total < 0) return t('uiPaidAmountUnknown');
  return t('uiPaid498', amount(total, 'up'), known ? '' : t('uiNetworkFeeNotReported'));
}

/** Additional liabilities never masquerade as paid amounts. */
export function budgetNote(b?: import('./types').BudgetAccounting): string {
  if (!b) return '';
  const notes: string[] = [];
  if (b.unsettled_msat) notes.push(t('uiReserved', amount(b.unsettled_msat, 'up')));
  if (b.fee_unknown) {
    notes.push(t('uiNetworkFeeNotReported502'));
    const held = (b.accounted_msat ?? b.spent_msat) - b.spent_msat - (b.unsettled_msat ?? 0);
    if (held > 0) notes.push(t('uiUpToHeldForUnreportedCosts', amount(held, 'up')));
  }
  return notes.join(' · ');
}
