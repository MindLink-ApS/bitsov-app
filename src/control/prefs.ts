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
