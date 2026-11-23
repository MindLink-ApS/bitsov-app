import { afterEach, expect, it, vi } from 'vitest';
import { copy, language, setLanguagePref, t, watchSystemLanguage } from '../src/i18n';
import { phoneCopy } from '../src/onboarding/phoneCopy';

afterEach(() => { vi.restoreAllMocks(); setLanguagePref('system'); });
it('has the same nonempty keys and interpolation slots in both languages', () => {
  expect(Object.keys(copy.da).sort()).toEqual(Object.keys(copy.en).sort());
  for (const key of Object.keys(copy.en) as (keyof typeof copy.en)[]) {
    expect(copy.da[key].trim(), key).not.toBe('');
    expect(copy.da[key].match(/\{\d+\}/g)?.sort() ?? [], key).toEqual(copy.en[key].match(/\{\d+\}/g)?.sort() ?? []);
  }
});
it('extends onboarding copy without maintaining a second translation', () => {
  for (const locale of ['en', 'da'] as const) {
    for (const key of Object.keys(phoneCopy[locale]) as (keyof typeof phoneCopy.en)[]) expect(copy[locale][key]).toBe(phoneCopy[locale][key]);
  }
});
it.each(['da', 'da-DK', 'DA-dk', 'en-US', 'de-DE'])('follows %s and synchronizes the document', locale => {
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(locale);
  setLanguagePref('system');
  expect(language()).toBe(locale.toLowerCase().startsWith('da') ? 'da' : 'en');
  expect(document.documentElement.lang).toBe(language());
});
it('overrides and resumes the system language, including languagechange', () => {
  const system = vi.spyOn(navigator, 'language', 'get').mockReturnValue('da-DK');
  const stop = watchSystemLanguage();
  setLanguagePref('en');
  expect(language()).toBe('en');
  expect(localStorage.getItem('bitsov.language')).toBe('en');
  window.dispatchEvent(new Event('languagechange'));
  expect(document.documentElement.lang).toBe('en');
  setLanguagePref('system');
  expect(document.documentElement.lang).toBe('da');
  system.mockReturnValue('en-GB');
  window.dispatchEvent(new Event('languagechange'));
  expect(document.documentElement.lang).toBe('en');
  stop();
});

it('inserts money and recipient text verbatim in both languages', () => {
  setLanguagePref('en');
  expect(t('uiSentTo', '1 250 sats', 'Robin {0} $&')).toBe('Sent 1 250 sats to Robin {0} $&.');
  setLanguagePref('da');
  expect(t('uiSentTo', '1 250 sats', 'Robin {0} $&')).toBe('Sendt 1 250 sats til Robin {0} $&.');
});

it('translates persisted activity labels without touching invoice notes', async () => {
  const { activityLabel } = await import('../src/control/wallet');
  const base = { id: 'test', at: 0, direction: 'in' as const, msat: 1250000, who: null };
  setLanguagePref('da');
  expect(activityLabel({ ...base, kind: 'invoice', label: 'Invoice · lunch {0}' })).toBe('Faktura · lunch {0}');
  expect(activityLabel({ ...base, kind: 'payment', label: 'Paid an invoice' })).toBe('Betalte en faktura');
  setLanguagePref('en');
  expect(activityLabel({ ...base, kind: 'payment', label: 'Paid an invoice' })).toBe('Paid an invoice');
});

it('names a missing Secure Enclave in both languages without placeholders', () => {
  for (const locale of ['en', 'da'] as const) {
    const text = (copy[locale] as Record<string, string>)['pairing.secureStorageUnavailable'];
    expect(text, locale).toBeTypeOf('string');
    expect(text.trim(), locale).not.toBe('');
    expect(text, locale).not.toMatch(/\{\d+\}/);
    expect(text, locale).toContain('Secure Enclave');
  }
  expect((copy.en as Record<string, string>)['pairing.secureStorageUnavailable']).not.toMatch(/try again/i);
  expect((copy.da as Record<string, string>)['pairing.secureStorageUnavailable']).not.toMatch(/prøv igen/i);
});
