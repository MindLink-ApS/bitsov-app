/** Dependency-free copy lookup; Solid's existing signals keep rendered copy reactive. */
import { createSignal } from 'solid-js';
import { phoneCopy } from './onboarding/phoneCopy';
import { appDa, appEn } from './appCopy';

export const copy = {
  en: { ...phoneCopy.en, ...appEn },
  da: { ...phoneCopy.da, ...appDa },
};
export type Language = keyof typeof copy;
export type LanguagePref = Language | 'system';
export type CopyKey = keyof typeof copy.en;
const STORAGE_KEY = 'bitsov.language';
function readPreference(): LanguagePref {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === 'da' || value === 'en') return value;
  } catch { /* Storage is optional. */ }
  return 'system';
}
export function systemLanguage(locale = typeof navigator === 'undefined' ? 'en' : navigator.language): Language {
  return locale.toLowerCase().startsWith('da') ? 'da' : 'en';
}
const [preference, setPreference] = createSignal<LanguagePref>(readPreference());
const [systemRevision, setSystemRevision] = createSignal(0);
export const languagePref = preference;
export function language(): Language {
  systemRevision();
  const pref = preference();
  return pref === 'system' ? systemLanguage() : pref;
}
export function applyLanguage() {
  if (typeof document !== 'undefined') document.documentElement.lang = language();
}
export function setLanguagePref(pref: LanguagePref) {
  setPreference(pref);
  setSystemRevision(value => value + 1);
  try { localStorage.setItem(STORAGE_KEY, pref); } catch { /* Storage is optional. */ }
  applyLanguage();
}
export function watchSystemLanguage() {
  const sync = () => { setSystemRevision(value => value + 1); applyLanguage(); };
  sync();
  window.addEventListener('languagechange', sync);
  return () => window.removeEventListener('languagechange', sync);
}
export function t(key: CopyKey, ...values: (string | number)[]): string {
  return copy[language()][key].replace(/\{(\d+)\}/g, (slot, index: string) => String(values[Number(index)] ?? slot));
}
