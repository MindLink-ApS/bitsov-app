/** UI preferences: theme and BTC/sats display. Local only; no host calls. */

import { createRoot, createSignal } from 'solid-js';

export type ThemePref = 'system' | 'light' | 'dark';
export type Denom = 'sats' | 'btc';

const THEME_KEY = 'bitsov.theme';
const DENOM_KEY = 'bitsov.denom';

function readTheme(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch { /* private mode */ }
  return 'system';
}

function readDenom(): Denom {
  try {
    const v = localStorage.getItem(DENOM_KEY);
    if (v === 'btc' || v === 'sats') return v;
  } catch { /* private mode */ }
  return 'sats';
}

/** Resolved light/dark from preference + OS. */
export function resolveTheme(pref: ThemePref): 'light' | 'dark' {
  if (pref === 'light' || pref === 'dark') return pref;
  if (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches) {
    return 'light';
  }
  return 'dark';
}

export function applyResolvedTheme(resolved: 'light' | 'dark') {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}

let themeSignal: (() => ThemePref) | null = null;
let setThemeSignal: ((v: ThemePref) => void) | null = null;
let denomSignal: (() => Denom) | null = null;
let setDenomSignal: ((v: Denom) => void) | null = null;

createRoot(() => {
  const [theme, setTheme] = createSignal<ThemePref>(readTheme());
  const [denom, setDenom] = createSignal<Denom>(readDenom());
  themeSignal = theme;
  setThemeSignal = setTheme;
  denomSignal = denom;
  setDenomSignal = setDenom;
  applyResolvedTheme(resolveTheme(theme()));
});

export const themePref = () => themeSignal?.() ?? readTheme();
export const denom = () => denomSignal?.() ?? readDenom();

export function setThemePref(pref: ThemePref) {
  setThemeSignal?.(pref);
  try { localStorage.setItem(THEME_KEY, pref); } catch { /* ignore */ }
  applyResolvedTheme(resolveTheme(pref));
}

export function setDenom(next: Denom) {
  setDenomSignal?.(next);
  try { localStorage.setItem(DENOM_KEY, next); } catch { /* ignore */ }
}

/** Watch OS theme when preference is `system`. */
export function watchSystemTheme() {
  if (typeof matchMedia !== 'function') return () => {};
  const mq = matchMedia('(prefers-color-scheme: light)');
  const sync = () => {
    if (themePref() === 'system') applyResolvedTheme(resolveTheme('system'));
  };
  mq.addEventListener?.('change', sync);
  return () => mq.removeEventListener?.('change', sync);
}

// ---- calls: STUN (your own node by default) ----------------------------------
//
// Stored choice: absent = default, 'off' = the owner turned STUN off, or the
// owner's own stun: URL. The default is the paired node's own STUN responder
// when it reports a public stun_url (no third party). Any other server is the
// owner's own explicit choice; the app ships none (charter gate G2).

const STUN_KEY = 'bitsov.stun';
const STUN_OFF = 'off';

function readStun(): string {
  try {
    return localStorage.getItem(STUN_KEY) ?? '';
  } catch {
    return '';
  }
}

let stunSignal: (() => string) | null = null;
let setStunSignal: ((v: string) => void) | null = null;
let nodeStunSignal: (() => string | null) | null = null;
let setNodeStunSignal: ((v: string | null) => void) | null = null;
createRoot(() => {
  const [stun, setStun] = createSignal(readStun());
  stunSignal = stun;
  setStunSignal = setStun;
  const [nodeStun, setNodeStunValue] = createSignal<string | null>(null);
  nodeStunSignal = nodeStun;
  setNodeStunSignal = setNodeStunValue;
});

const stunChoice = () => stunSignal?.() ?? readStun();
/** The STUN URL the owner chose explicitly, or '' (default or off). */
export const stunPref = () => (stunChoice() === STUN_OFF ? '' : stunChoice());
/** The owner turned STUN off: calls use host candidates only, no default. */
export const stunOff = () => stunChoice() === STUN_OFF;
/** The paired node's own validated stun: URL, when it reports one. */
export const nodeStun = () => nodeStunSignal?.() ?? null;
export function setNodeStun(url: string | null) { setNodeStunSignal?.(url); }
/** What calls actually use: the owner's choice, else their own node, else none. */
export const effectiveStun = () => stunPref() || (stunOff() ? '' : (nodeStun() ?? ''));

/** Set the owner's STUN server; '' returns to the default (your own node). */
export function setStunPref(url: string) {
  const v = url.trim();
  setStunSignal?.(v);
  try {
    if (v) localStorage.setItem(STUN_KEY, v);
    else localStorage.removeItem(STUN_KEY);
  } catch { /* ignore */ }
}

/** Turn STUN off on purpose: no default comes back until the owner chooses one. */
export function setStunOff() { setStunPref(STUN_OFF); }

// A preset is a saved suggestion, never a spending authority.
export function readSpendPreset(nodeId: string): import('./types').PresetId | null {
  try {
    const value = localStorage.getItem(`bitsov.spend-preset.${nodeId.toLowerCase()}`);
    return value === 'careful' || value === 'everyday' || value === 'generous' ? value : null;
  } catch { return null; }
}

export function saveSpendPreset(nodeId: string, value: import('./types').PresetId) {
  try { localStorage.setItem(`bitsov.spend-preset.${nodeId.toLowerCase()}`, value); } catch { /* session only */ }
}
