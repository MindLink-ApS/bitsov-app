import { afterEach, describe, expect, it } from 'vitest';
import { setLanguagePref } from '../src/i18n';
import { hostText } from '../src/control/hostCopy';
import { onboardingDiagnostic } from '../src/onboarding/pairing';

afterEach(() => setLanguagePref('en'));

describe('setup and pairing sentences keep their meaning in Danish', () => {
  it.each([
    ["The node's fresh token changed the saved first-run client or epoch.", 'Boksens nye adgang ændrede den gemte klient eller parringens epoke fra første opstart.'],
    ['The setup receipt changed the pairing epoch.', 'Kvitteringen for opsætningen ændrede parringens epoke.'],
    ['Remote first-run setup is currently available on Mac.', 'Opsætning af en fjernboks første gang kan indtil videre gøres på en Mac.'],
    ['The reported principal overflows.', 'Det oplyste hovedbeløb er for stort til at kunne regnes.'],
  ])('%s', (en, da) => {
    expect(hostText(en, 'da')).toBe(da);
  });
});

describe('onboarding diagnostics read in Danish on the repair, locked and pairing screens', () => {
  it('a known host sentence comes back in Danish', () => {
    setLanguagePref('da');
    expect(onboardingDiagnostic('Missing setup attempt.', 'help')).toBe('Opsætningsforsøget mangler.');
    // Deliberately narrower than the English: finalizing can commit before this check, so the
    // Danish names only the saved key (see host-copy.test.ts, "says only what is sure").
    expect(onboardingDiagnostic('Setup receipt did not match this box and device. Nothing was re-pinned.', 'help'))
      .toBe('Kvitteringen for opsætningen passede ikke til denne boks og enhed. Boksens gemte nøgle blev ikke ændret.');
  });
  it('an unknown host sentence stays as the host wrote it (fail closed, never a guess)', () => {
    setLanguagePref('da');
    expect(onboardingDiagnostic('Something the host has just added.', 'help')).toBe('Something the host has just added.');
  });
  it('a message naming a terminal command shows the help text instead, in either language', () => {
    setLanguagePref('da');
    expect(onboardingDiagnostic('Run konsensus init first.', 'help')).toBe('help');
    setLanguagePref('en');
    expect(onboardingDiagnostic('Run konsensus init first.', 'help')).toBe('help');
  });
  it('in English the host sentence is unchanged', () => {
    setLanguagePref('en');
    expect(onboardingDiagnostic('Missing setup attempt.', 'help')).toBe('Missing setup attempt.');
  });
});
