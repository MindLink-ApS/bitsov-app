import { afterEach, expect, it } from 'vitest';
import { render } from 'solid-js/web';
import { copy, possessive, setLanguagePref, t } from '../src/i18n';
import { costToSend, peerNotReadyMessage } from '../src/control/state';
import { HubTrust, HubChannelConfirm } from '../src/control/HubTrust';
let dispose: (() => void) | undefined;
let mount: HTMLDivElement;
afterEach(() => { dispose?.(); mount?.remove(); setLanguagePref('en'); });
it.each(['en', 'da'] as const)('puts possessives in %s copy and leaves the estimate subject bare', locale => {
  setLanguagePref(locale);
  const quote = { kind: 0, own_msat: 1000, peer_msat: 2000, peer_stale: false, peer_age_secs: 0, max_routing_fee_msat: 0 };
  const cost = (name?: string) => costToSend({ kind: 'peer', id: 'a' }, quote, { name, nowMs: 1 })!;
  expect(cost('Maya').basis).toContain(locale === 'da' ? 'Mayas pris' : 'Maya’s price');
  expect(cost().basis).toContain(locale === 'da' ? 'Deres pris' : 'Their price');
  expect(costToSend({ kind: 'peer', id: 'a' }, { ...quote, peer_msat: null }, { name: 'Maya' })!.basis).toContain(locale === 'da' ? 'Maya har ikke delt sin endnu' : 'Maya has not shared theirs yet');
});
it('retains the payment, on-chain and fee meanings in Danish copy', () => {
  setLanguagePref('da');
  expect(t('extraSpendingApprovedMinLeft', 4)).toBe('Betalinger godkendt, 4 min tilbage');
  expect(t('uiAmountToPay', 'Maya')).toBe('Beløb at betale til Maya');
  expect(t('uiRequestFrom', 'Maya')).toBe('Anmod Maya om betaling');
  expect(t('uiTheseCategoriesOverlapAndDoNotAddUp')).toContain('i totalen på kæden');
  expect(t('uiTheseCategoriesOverlapAndDoNotAddUp')).toContain('fra det disponible beløb på kæden');
  expect(t('uiOnChainFundsHeldForAnchorChannelClosing')).toContain('tilbageholdt til gebyrer ved lukning');
  expect(t('uiLocalOKMoneyReady')).toBe('Lokalt OK · Betalinger klar');
  expect(t('extraLocalOKMoneyReady', 'x')).toBe('Lokalt OK · Betalinger klar · x');
  expect(t('moneyNotReady')).toBe('Betalinger er ikke klar endnu. Din boks prøver automatisk igen.');
});
it('changes every provider card and the dismiss accessible name with the language', () => {
  setLanguagePref('en');
  mount = document.createElement('div'); document.body.append(mount);
  dispose = render(() => <HubTrust level={2} onDismiss={() => {}} />, mount);
  const dismiss = () => mount.querySelector<HTMLButtonElement>('[data-hub-trust-dismiss]')!;
  expect(dismiss().textContent).toBe('Hide');
  expect(dismiss().getAttribute('aria-label')).toBe('Hide: Your Lightning provider');
  setLanguagePref('da');
  expect(dismiss().textContent).toBe('Skjul');
  expect(dismiss().getAttribute('aria-label')).toBe('Skjul: Din Lightning-udbyder');
  expect([...mount.querySelectorAll('h3')].map(el => el.textContent)).toEqual(['Din Lightning-udbyder', 'Hvad den ikke kan', 'Hvad den ser', 'Hvis den afviser', 'Mens din boks er låst', 'Gebyrer']);
  const paragraphs = [...mount.querySelectorAll('p')].map(el => el.textContent);
  expect(paragraphs).toHaveLength(7);
  for (const [i, phrase] of ['Hubben er din Lightning-udbyder', 'Den kan ikke læse indholdet af dine beskeder', 'Den opbevarer aldrig dine nøgler', 'Den ser de betalinger', 'Den kan afvise at route', 'Mens din hjemmeboks er låst', 'Gebyrer: routing'].entries()) expect(paragraphs[i]).toContain(phrase);
  expect(paragraphs[1]).toContain('mellem din boks og modtagerens boks');
  expect(paragraphs[1]).toContain('Begge bokse kan læse det');
  expect(paragraphs[5]).toContain('omkring et døgn');
  expect(paragraphs[5]).toContain('miste midler');
  setLanguagePref('en');
  expect(dismiss().textContent).toBe('Hide');
});
it('localizes the provider channel confirmation as well as its cards', () => {
  setLanguagePref('da');
  mount = document.createElement('div'); document.body.append(mount);
  dispose = render(() => <HubChannelConfirm nodeId="danish-copy-test" onConfirm={() => {}} onCancel={() => {}} />, mount);
  expect(mount.querySelector('[data-hub-channel-ack]')?.textContent).toBe('Jeg forstår — åbn kanalen');
  expect(mount.querySelector('[data-hub-channel-cancel]')?.textContent).toBe('Ikke nu');
  expect(mount.textContent).toContain('Indstillinger → Boks');
});

it.each([['Rasmus', 'Rasmus’'], ['Lars', 'Lars’'], ['Alex', 'Alex’'], ['Luz', 'Luz’'], ['MAX', 'MAX’'], ['Maya', 'Mayas']])('uses the Danish possessive for %s', (name, possessive) => {
  setLanguagePref('da');
  const quote = { kind: 0, own_msat: 1000, peer_msat: 2000, peer_stale: false, peer_age_secs: 0, max_routing_fee_msat: 0 };
  expect(costToSend({ kind: 'peer', id: 'a' }, quote, { name, nowMs: 1 })!.basis).toContain(`${possessive} pris`);
});

it.each(['en', 'da'] as const)('inflects names in the peer-not-ready message in %s', locale => {
  setLanguagePref(locale);
  for (const [name, da] of [['Rasmus', 'Rasmus’'], ['Maya', 'Mayas']]) {
    expect(t('uiSNodeDoesNotTakeCallsYet', possessive(name)))
      .toBe(locale === 'da' ? `${da} boks modtager ikke opkald endnu` : `${name}’s box does not take calls yet`);
    expect(peerNotReadyMessage({ code: 'peer_not_ready', reason: 'chain_unavailable' }, name))
      .toBe(locale === 'da' ? `${da} boks er ikke klar til at modtage endnu (dens kædeforbindelse er nede)` : `${name}’s box isn't ready to receive yet (its chain connection is down)`);
  }
});

it.each(['en', 'da'] as const)('uses typographic apostrophes for %s possessives without changing names', locale => {
  setLanguagePref(locale);
  for (const [name, english, danish] of [
    ['Rasmus', 'Rasmus’s', 'Rasmus’'],
    ['Lars', 'Lars’s', 'Lars’'],
    ['Alex', 'Alex’s', 'Alex’'],
    ['Luz', 'Luz’s', 'Luz’'],
    ['MAX', 'MAX’s', 'MAX’'],
    ['Maya', 'Maya’s', 'Mayas'],
    ["O'Connor", "O'Connor’s", "O'Connors"],
  ]) {
    expect(possessive(name)).toBe(locale === 'en' ? english : danish);
  }
  // Keep literal and interpolated possessives in the merged copy table consistent.
  // Exclude the English contraction “That's”; user-provided names are not copy.
  const asciiPossessives = Object.entries(copy[locale]).filter(([, value]) =>
    /(?:\}|\b(?![Tt]hat\b)[\p{L}]+)'s\b|[sxz]'(?=\s|$)/u.test(value));
  expect(asciiPossessives).toEqual([]);
});
