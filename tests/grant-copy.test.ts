import { describe, expect, it } from 'vitest';
import { copy } from '../src/i18n';

// The node grants one total for one window of at most 24 hours, then the grant
// ends. It does not refill each day. The grant is kept by the node, so it
// survives a restart of the node or the app until its expiry. These strings
// say the amount and the window; none may say "per day" or ask for a new
// approval after a restart.
const PINNED = {
  en: {
    firstSpendTitle: 'Let messages spend up to {0} in total, for up to 24 hours?',
    firstSpendTitleUnavailable: 'Choose a message budget for up to 24 hours',
    firstSpendAllow: 'Allow {0} in total',
    firstSpendMayStartNow: 'Allow may start payments immediately, up to {0} in total for up to 24 hours, or ask for a new owner approval.',
    firstSpendMayStartNowUnavailable: 'Allow may start payments immediately with your chosen total for up to 24 hours, or ask for a new owner approval.',
    firstSpendStartsNow: 'Starts now, up to {0} in total, for up to 24 hours.',
    firstSpendStartsNowUnavailable: 'Allow starts payments immediately with your chosen total, for up to 24 hours.',
    firstSpendAppPresets: 'App budget presets. Maximum: {0} in total.',
    firstSpendDaily: '{0} in total',
    firstSpendCustomLabel: 'Custom total in sats',
    firstSpendAmountReason: 'Enter between 1 sat and {0}.',
    uiYourDailyApprovalEnded: 'Your 24-hour approval ended.',
    uiInTotalForUpTo24Hours: 'in total, for up to 24 hours',
    extraInTotalFor24HoursAtMost: 'in total for up to 24 hours, at most',
    extraPerMessage: 'per message.',
    firstSpendWindow: 'For up to 24 hours.',
    uiOneApprovalLetsMessagesPayForTheNext: 'One approval lets messages pay up to your app all-in payment limit in total, for up to 24 hours. It can only be done on the computer the box runs on.',
    caDailyApprovalEnded: '24-hour approval ended',
  },
  da: {
    firstSpendTitle: 'Må beskeder bruge op til {0} i alt, i højst 24 timer?',
    firstSpendTitleUnavailable: 'Vælg et beskedbudget for højst 24 timer',
    firstSpendAllow: 'Tillad {0} i alt',
    firstSpendMayStartNow: 'Tillad kan starte betalinger med det samme, op til {0} i alt i højst 24 timer, eller bede om en ny godkendelse fra ejeren.',
    firstSpendMayStartNowUnavailable: 'Tillad kan starte betalinger med det samme med din valgte total i højst 24 timer eller bede om en ny godkendelse fra ejeren.',
    firstSpendStartsNow: 'Starter nu, op til {0} i alt, i højst 24 timer.',
    firstSpendStartsNowUnavailable: 'Tillad starter betalinger med det samme med din valgte total, i højst 24 timer.',
    firstSpendAppPresets: 'Appens budgetforudindstillinger. Højst {0} i alt.',
    firstSpendDaily: '{0} i alt',
    firstSpendCustomLabel: 'Tilpasset total i sats',
    firstSpendAmountReason: 'Indtast mellem 1 sat og {0}.',
    uiYourDailyApprovalEnded: 'Din godkendelse på 24 timer er udløbet.',
    uiInTotalForUpTo24Hours: 'i alt, i højst 24 timer',
    extraInTotalFor24HoursAtMost: 'i alt i op til 24 timer, højst',
    extraPerMessage: 'pr. besked.',
    firstSpendWindow: 'I højst 24 timer.',
    uiOneApprovalLetsMessagesPayForTheNext: 'Én godkendelse lader beskeder betale op til appens samlede betalingslimit i alt, i højst 24 timer. Det kan kun gøres på den computer, boksen kører på.',
    caDailyApprovalEnded: 'Godkendelsen på 24 timer er udløbet',
  },
} as const;

const RESTART = {
  en: 'Your approval is held by your node: it survives a restart of the node or this app, and ends when the node’s grant ends, at most 24 hours after you approved.',
  da: 'Din godkendelse ligger på din node: den overlever en genstart af noden eller appen og slutter, når nodens tilladelse slutter, højst 24 timer efter du godkendte.',
} as const;

// Wording the node does not enforce: a daily refill, and a lost approval on restart.
const DAILY = /\ba day\b|\bper day\b|\bdaily\b|om dagen|pr\. døgn|\bdaglig|døgn-godkendelse/i;
const RE_APPROVE = /approve once more|after a restart, approve|godkend igen efter en genstart|Det gør din godkendelse ikke/i;

describe.each(['en', 'da'] as const)('grant amount, window and restart copy (%s)', (lang) => {
  const table = copy[lang] as Record<string, string>;
  it.each(Object.entries(PINNED[lang]))('%s says a total and a window', (key, value) => {
    expect(table[key]).toBe(value);
    expect(table[key]).not.toMatch(DAILY);
  });
  it('says the approval survives a restart', () => {
    const hint = table.caABudgetCanGoUpToTheAppAll;
    expect(hint).toContain(RESTART[lang]);
    expect(hint).not.toMatch(RE_APPROVE);
  });
});
