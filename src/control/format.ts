// Display helpers. Sats are the unit people read; msat precision is kept when
// a figure is not a whole sat, never rounded into a different price.

export function sats(msat: number): string {
  const whole = Math.floor(msat / 1000);
  const rest = msat % 1000;
  const head = whole.toLocaleString('en-US');
  return rest === 0 ? head : `${head}.${String(rest).padStart(3, '0').replace(/0+$/, '')}`;
}

/** `sat` for exactly one sat, `sats` otherwise (including fractions). */
export const satUnit = (msat: number) => (msat === 1000 ? 'sat' : 'sats');

export const satsWhole = (value: number) => value.toLocaleString('en-US');

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
export const feeCeiling = (msat: number) => `up to ${sats(msat)} sats network fee`;
