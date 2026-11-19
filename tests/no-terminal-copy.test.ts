import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appDa, appEn } from '../src/appCopy';
import { controlDa, controlEn } from '../src/controlCopy';
import { onboardingDa, onboardingEn } from '../src/onboarding/onboardingCopy';
import { hostText } from '../src/control/hostCopy';
import { NO_ROWS_TEXT } from '../src/assistant/rows';
import { setLanguagePref } from '../src/i18n';

// The default screens never tell someone to open a terminal or run a command:
// the box needs one yes from the person who set it up. An exact command is kept
// only behind a closed Details, for that person (see the shell tests).
const CLI = /konsensus\s|--op\b|--config\b|terminal|console|konsol|kommandolinje|\bCLI\b|\bcommands?\b|kommando|npm run/i;

const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

/** Copy that the default UI shows as it is, outside any Details. */
const DEFAULT_COPY = {
  app: ['uiAfterThatOneTapApprovesAContactHere', 'uiYourNodeDoesNotYetAcceptApprovalsIn', 'uiRunThisCommandOnceInTheOwnerS', 'uiTheCommandApprovesThisContactSBudgetAnd'],
  control: ['caApprovalWho', 'caReviewTheRequestAndCompareTheCodeToPrepare', 'caNothingToShowYetCloseThisWindowAndOpen'],
  onboarding: ['obCompareConsoleBefore', 'obDeviceAddedNoPassword', 'obPackagedAppLimits', 'obTrustedClaim'],
} as const;

afterEach(() => setLanguagePref('en'));

describe('no terminal or command in the default copy', () => {
  it.each([
    ['app en', appEn as Record<string, string>, DEFAULT_COPY.app],
    ['app da', appDa as Record<string, string>, DEFAULT_COPY.app],
    ['control en', controlEn as Record<string, string>, DEFAULT_COPY.control],
    ['control da', controlDa as Record<string, string>, DEFAULT_COPY.control],
    ['onboarding en', onboardingEn as Record<string, string>, DEFAULT_COPY.onboarding],
    ['onboarding da', onboardingDa as Record<string, string>, DEFAULT_COPY.onboarding],
  ] as const)('%s', (_name, copy, keys) => {
    for (const key of keys) {
      expect(copy[key], key).toBeTruthy();
      expect(copy[key], key).not.toMatch(CLI);
    }
  });

  it('the approval wait says who to ask, in plain words, in both languages', () => {
    expect(controlEn.caApprovalWho).toContain('Your box needs one yes from the person who set it up');
    expect(controlDa.caApprovalWho).toContain('Din boks skal have ét ja fra den, der har sat den op');
  });

  it.each(['en', 'da'] as const)('the assistant window with nothing to show names no developer command (%s)', (lang) => {
    setLanguagePref(lang);
    expect(NO_ROWS_TEXT()).not.toMatch(CLI);
  });

  it('host refusals that reach the screen name no command or terminal, and have Danish', () => {
    const app = read('src-tauri/src/app.rs');
    const owner = read('src-tauri/src/local_owner.rs');
    for (const gone of ['with the konsensus grant command', "only from the owner's own terminal", 'Enroll through the owner console']) {
      expect(app + owner).not.toContain(gone);
    }
    for (const said of [
      'Strong biometric approval is not available on this phone right now (none enrolled, unavailable, or locked out). Nothing was approved. Ask the person who set up your box to approve it there instead.',
      'Touch ID or Face ID is not available on this device right now (not enrolled, or locked out after failed tries). Nothing was approved. Ask the person who set up your box to approve it there instead.',
      'Your box allows this only from its owner, not from a paired app. Ask the person who set it up.',
      'This Mac is not added as an owner device yet. Ask the person who set up your box to add it; setup cannot reopen on a box that is already set up.',
      'This Mac needs approval before it can approve payments. It has only what your box allows it. Ask the person who set up your box to add it; the recovery phrase cannot be shown again.',
    ]) {
      expect(app + owner).toContain(said);
      const da = hostText(said, 'da');
      expect(da, said).not.toBe(said);
      expect(da).not.toMatch(CLI);
    }
  });

  it('the app never adds the box config path to a command', () => {
    const act = read('src-tauri/src/act.rs');
    expect(act).not.toMatch(/format!\("\{\} --config/);
    expect(act).toContain('fn without_config_path');
  });
});
