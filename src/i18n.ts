/** Dependency-free copy lookup; Solid's existing signals keep rendered copy reactive. */
import { deviceWord } from './platform';
import { createSignal } from 'solid-js';
import { onboardingEn, onboardingDa } from './onboarding/onboardingCopy';
import { phoneCopy } from './onboarding/phoneCopy';
import { assistantQuestionsEn, assistantQuestionsDa } from './assistantQuestionsCopy';
import { controlDa, controlEn } from './controlCopy';
import { appDa, appEn } from './appCopy';

export const copy = {
  en: { ...phoneCopy.en, ...appEn, ...controlEn, ...assistantQuestionsEn, ...onboardingEn },
  da: { ...phoneCopy.da, ...appDa, ...controlDa, ...assistantQuestionsDa, ...onboardingDa },
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

/** Names are inflected before insertion; the rest of the sentence stays translated. */
export function possessive(name: string): string {
  return language() === 'da' ? `${name}${/[sxz]$/i.test(name) ? '’' : 's'}` : `${name}’s`;
}

/** Device noun for translated display copy; platform identifiers stay unchanged. */
export const displayDeviceWord = () => deviceWord() === 'phone' ? t('phone') : deviceWord();
