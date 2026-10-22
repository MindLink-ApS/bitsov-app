import { afterEach, expect, it } from 'vitest';
import { setLanguagePref } from '../src/i18n';
import { admissionCopy, undeliveredCopy } from '../src/control/state';

afterEach(() => setLanguagePref('en'));
it('preserves both paid-but-undelivered warnings exactly in Danish', () => {
  setLanguagePref('da');
  expect(undeliveredCopy({ paid_msat: 1500, retry: true })).toEqual({
    title: 'Betalt 1,5 sats · endnu ikke leveret',
    body: 'Send ikke igen. Et nyt leveringsforsøg betaler intet nyt.',
    detail: 'Betalingen er gennemført; beskeden er ikke leveret. Et nyt forsøg sender det allerede betalte bevis igen. Hvis der skal betales mere (beskedpris eller adgang efter en genforbindelse), stopper den før betaling og spørger først med prisen.',
  });
  expect(undeliveredCopy({ paid_msat: 1000, retry: false })).toEqual({
    title: 'Betalt 1 sat · endnu ikke leveret',
    body: 'Send ikke igen — det kan betale to gange.',
    detail: 'Betalingen er gennemført; beskeden er ikke leveret. Tjek det afventende resultat, før du sender andet.',
  });
});
it('preserves quoted versus estimated admission, fee ceilings, and approval in Danish', () => {
  setLanguagePref('da');
  const price = { admission_msat: 1500, message_msat: 2000, max_routing_fee_msat: 500, total_msat: 4000 };
  expect(admissionCopy({ ...price, quoted: true })).toEqual({
    body: 'Kræver højst 4 sats mere (adgang + besked + gebyrer).',
    detail: 'Deres pris: 1,5 sats for adgang igen, derefter 2 sats for denne besked. Plus højst 0,5 sats i netværksgebyrer (4 sats i alt). Hvis du stadig har adgang, betales kun beskeden og dens gebyr.',
    action: 'Godkend højst 4 sats og prøv igen',
  });
  expect(admissionCopy({ ...price, quoted: false })).toEqual({
    body: 'Kræver cirka 4 sats mere, hvis adgang skal betales igen.',
    detail: 'Denne beskeds 2 sats og cirka 1,5 sats, hvis der kræves adgang igen. Plus højst 0,5 sats i netværksgebyrer (4 sats i alt). Noden afviser før betaling, hvis den faktiske pris er højere.',
    action: 'Godkend højst 4 sats og prøv igen',
  });
});
it('keeps the English money warnings unchanged', () => {
  setLanguagePref('en');
  expect(undeliveredCopy({ paid_msat: 1000, retry: false })).toEqual({
    title: 'Paid 1 sat · not delivered yet',
    body: 'Do not send again — that could pay twice.',
    detail: 'Payment settled; message not delivered. Check the pending result before sending anything else.',
  });
  expect(admissionCopy({ admission_msat: 1500, message_msat: 2000, max_routing_fee_msat: 500, total_msat: 4000, quoted: true })).toEqual({
    body: 'Needs up to 4 sats more (admission + message + fees).',
    detail: 'Their price: 1.5 sats to be admitted again, then 2 sats for this message. Plus up to 0.5 sats network fees (4 sats in all). If still admitted, pays only the message and its fee.',
    action: 'Approve up to 4 sats and retry',
  });
});
