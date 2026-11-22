import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { setLanguagePref } from '../src/i18n';
import { HOST_COPY_DA, hostText } from '../src/control/hostCopy';
import { asActionError } from '../src/control/state';
import { softenError } from '../src/control/userFacing';

/** Rust source without its test items, which can sit anywhere in a file. */
const withoutTests = (source: string) => {
  let out = '', at = 0;
  for (;;) {
    const start = source.indexOf('#[cfg(test)]', at);
    if (start < 0) return out + source.slice(at);
    out += source.slice(at, start);
    // Braces only: they balance in format strings, and quotes can't be told apart without a full parser.
    let i = start + 12, depth = 0, opened = false;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === '{') { depth++; opened = true; }
      else if (c === '}') { if (--depth === 0 && opened) { i++; break; } }
      else if (c === ';' && !opened) { i++; break; }
    }
    at = i;
  }
};
/** Every whole sentence in the money and card files, however it is built or returned. */
const moneySentences = () => ['act', 'porch', 'budget', 'grant', 'spend_journal', 'owner_approval', 'owner_contact', 'device', 'delegation', 'control', 'app'].flatMap((name) => {
  const source = withoutTests(readFileSync(`src-tauri/src/${name}.rs`, 'utf8'));
  // Quote pairing can slip on a raw string or a quote character, so one-line sentences are also found on their own.
  return [...source.matchAll(/"((?:[^"\\]|\\[\s\S])*)"/g), ...source.matchAll(/"([A-Z][^"\n]{14,}[.!?])"/g)]
    .map((m) => m[1].replace(/\\\n\s*/g, '').replace(/\\"/g, '"'))
    .filter((t) => /^[A-Z][^\n]{14,}[.!?]$/.test(t) && t.includes(' '))
    .map((t) => t.replace(/\{[A-Za-z_]*(?::[^}]*)?\}/g, '{}'))
    // In the main file, the sentences about money: the rest is in the setup list.
    .filter((t) => name !== 'app' || /paid|pay|price|budget|spend|msat|\bsats?\b|hangup|hang up|hold|held|\bcalls?\b|reservation|admission|\bcap\b|ceiling|funds|grant|nothing/i.test(t));
});

afterEach(() => setLanguagePref('en'));

describe('host refusals about money, calls and cards in Danish', () => {
  it('has Danish for every sentence about money, calls and cards', () => {
    const known = new Set(HOST_COPY_DA.map(([en]) => en));
    const renderer = /^(Hanging up this call|Money is not ready|This permission covers|No pending spend)/;
    expect([...new Set(moneySentences())].filter((m) => !known.has(m) && !renderer.test(m))).toEqual([]);
  });
  it.each([
    ['the budget rewrite of a call', { code: 'grant_exhausted', message: 'This call needs up to 7 sats. Your node\'s spend budget has 2 sats left, less than this costs. Nothing was sent. Ask for a new budget. The owner would need to approve enough remaining budget for that ceiling. Nothing was sent or paid.' }, 'Dette opkald kræver op til 7 sats. Din boks’ forbrugsbudget har 2 sats tilbage, mindre end dette koster. Intet blev sendt. Bed om et nyt budget. Ejeren skal godkende nok resterende budget til det loft. Intet blev sendt eller betalt.'],
    ['a reservation with its hang-up', { code: 'call_no_reservation', message: 'Your node keeps no reservation for this call\'s minutes, so the app pays none of them. No minute was paid. The app hung up the call; your node releases what it held when it closes the call.' }, 'Din boks holder ingen reservation til opkaldets minutter, så appen betaler ingen af dem. Intet minut blev betalt. Appen lagde på; din boks frigiver det reserverede, når den lukker opkaldet.'],
    ['a porch timeout', { code: 'porch_timeout', message: 'Paid 1 sat, but their node did not answer within 20 seconds. The app does not retry: reading again pays again.' }, 'Betalt 1 sat, men deres boks svarede ikke inden for 20 sekunder. Appen prøver ikke igen: en ny læsning betales igen.'],
    ['a retry that needs admission', { code: 'retry_needs_admission', message: 'Retry delivery paid nothing new. Delivering the message needs a new payment: its price, and admission again if the contact reconnected. Nothing was paid. Your node could not tell the price. Approve it to continue, or stop retrying.' }, 'Det nye leveringsforsøg kostede ikke noget nyt. For at levere beskeden skal der betales igen: dens pris og adgang igen, hvis kontakten har forbundet igen. Intet blev betalt. Din boks kunne ikke oplyse prisen. Godkend for at fortsætte, eller stop forsøgene.'],
    ['a fee warning', { code: 'not_dispatched', message: 'Not sent - nothing was paid. Network fee would exceed your limit. (route fee too high)' }, 'Ikke sendt – intet blev betalt. Netværksgebyret ville overstige din grænse. (route fee too high)'],
    ['an offline recipient with no payment', { code: 'not_dispatched', message: 'Not sent - nothing was paid. Recipient is offline.' }, 'Ikke sendt – intet blev betalt. Modtageren er offline.'],
    ['a budget naming this contact', { code: 'budget_exhausted', message: 'You have used 5 sats of 10 sats for this contact in the last 24 hours, and this costs 6 sats. Raise the budget to send.' }, 'Du har brugt 5 sats af 10 sats til denne kontakt de seneste 24 timer, og dette koster 6 sats. Hæv budgettet for at sende.'],
    ['a room with one member not connected', { code: 'room_unreachable', message: '1 member is not a connected peer, so the node would skip them without telling you. Rooms send only when every member is connected.' }, '1 medlem er ikke en forbundet kontakt, så boksen ville springe personen over uden at sige det. Rum sender kun, når alle medlemmer er forbundet.'],
    ['a room with several members not connected', { code: 'room_unreachable', message: '3 members are not a connected peer, so the node would skip them without telling you. Rooms send only when every member is connected.' }, '3 medlemmer er ikke forbundne kontakter, så boksen ville springe dem over uden at sige det. Rum sender kun, når alle medlemmer er forbundet.'],
    ['a refusal the host words about a room', { code: 'not_dispatched', message: 'Not sent - nothing was paid. Your node is not in this room\'s member list.' }, 'Ikke sendt – intet blev betalt. Din boks er ikke på rummets medlemsliste.'],
    ['a node reason that is also in the list, left as it came', { code: 'not_dispatched', message: 'Not sent - nothing was paid. Your node refused this read.' }, 'Ikke sendt – intet blev betalt. Your node refused this read.'],
    ['a node detail that is also in the list, left as it came', { code: 'spend_unknown', message: 'Outcome unknown; another spend is blocked until reconciled. Nothing was paid.' }, 'Udfaldet er ukendt; nye betalinger er blokeret, indtil det er afklaret. Nothing was paid.'],
    ['a budget naming this room', { code: 'budget_exhausted', message: 'You have used 5 sats of 10 sats for this room in the last 24 hours, and this costs 6 sats. Raise the budget to send.' }, 'Du har brugt 5 sats af 10 sats til dette rum de seneste 24 timer, og dette koster 6 sats. Hæv budgettet for at sende.'],
  ])('reads %s in Danish, whole, through the way errors enter the app', (_name, error, expected) => {
    setLanguagePref('da');
    expect(asActionError(error).message).toBe(expected);
  });
  it('leaves a joined message in English unless every part is known', () => {
    const half = 'Nothing was paid. Something the host has just added.';
    expect(hostText(half, 'da')).toBe(half);
  });
  it('keeps the money warning on every row, joined messages included', () => {
    const fill = (t: string) => t.replace(/\{\d*\}/g, '5');
    for (const [en, da] of HOST_COPY_DA) if (softenError(fill(en)).money) expect(softenError(fill(da)).money, en).toBe(true);
    const joined = 'Your node keeps no reservation for this call\'s minutes, so the app pays none of them. No minute was paid. Your node has closed the call and its hold.';
    expect(softenError(hostText(joined, 'da')).money).toBe(true);
  });
});
