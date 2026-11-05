import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from '../src/App';
import { setLanguagePref } from '../src/i18n';
import { hostText } from '../src/control/hostCopy';
import { asActionError } from '../src/control/state';
import { AddDevice, JoinDevice } from '../src/onboarding/AddDevice';
import { InitializationRepair } from '../src/onboarding/InitializationRepair';
import { RememberUnlock } from '../src/onboarding/LockedNode';

let dispose: (() => void) | undefined;
beforeEach(() => setLanguagePref('da'));
afterEach(() => { dispose?.(); dispose = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals(); setLanguagePref('en'); });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const alert = () => document.querySelector('[role="alert"]')?.textContent ?? '';

it('remembering a password shows the host refusal in Danish', async () => {
  dispose = render(() => <RememberUnlock mobile={false} onChoose={async () => { throw 'This offer expired. Unlock with your password again before choosing Remember.'; }} onDone={() => {}} />, document.body);
  document.querySelector<HTMLButtonElement>('button.primary, button')!.click();
  await flush();
  expect(alert()).toBe('Dette tilbud er udløbet. Lås op med din adgangskode igen, før du vælger Husk.');
});

it('a failed trust acknowledgement shows the host refusal in Danish', async () => {
  const node = 'ab'.repeat(32);
  const invoke = vi.fn(async (cmd: string) => {
    if (cmd === 'node_status') return { ready: true, node_id: node, error: null };
    if (cmd === 'pairing_status') return { state: 'paired', remote: true, scopes: ['read'], bootstrap: null, short_code: null, code_from_node: false, reason: null, trust_acknowledged_node_id: null };
    if (cmd === 'trust_acknowledge') throw 'Could not save trust acknowledgement.';
    throw new Error('unavailable');
  });
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
  dispose = render(() => <App />, document.body);
  await vi.waitFor(() => expect(document.querySelector('[data-gate="g6-remote-trust"]')).not.toBeNull());
  [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('I understand'))!.click();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Kunne ikke gemme din accept af tillid.'));
  expect(document.body.textContent).not.toContain('Could not save trust acknowledgement.');
});

it.each([
  ['AddDevice', () => <AddDevice api={async () => { throw 'Invalid ticket challenge. Nothing was signed.'; }} />],
  ['JoinDevice', () => <JoinDevice api={async () => { throw 'Invalid ticket challenge. Nothing was signed.'; }} />],
])('%s shows the host refusal in Danish', async (_name, ui) => {
  dispose = render(ui, document.body);
  await flush();
  expect(alert()).toBe('Billettens udfordring er ugyldig. Intet blev underskrevet.');
});

it.each([
  ['the failed comparison', 'The comparison could not be verified. Check the 18-character claim code provided by your node\'s owner or printed on a BitSov box\'s sticker. Cancel the pending setup before trying again.', 'obClaimMismatch'],
  ['a bad claim code', 'The claim-code checksum did not match. Check the physical code.', 'obClaimCodeInvalid'],
])('adding a device keeps its own words for %s', async (_name, message, key) => {
  const { t } = await import('../src/i18n');
  dispose = render(() => <JoinDevice api={async () => { throw message; }} />, document.body);
  await flush();
  expect(alert()).toBe(t(key as 'obClaimMismatch'));
});

const WRAP = 'Page-price update failed; your node remains stopped. ';
it.each([
  ['Cannot safely read the existing page price.', 'Kan ikke læse den nuværende sidepris sikkert.'],
  ['The page price is no longer the old 0.05 sat setting; no settings were changed.', 'Sideprisen er ikke længere den gamle indstilling på 0,05 sat; ingen indstillinger blev ændret.'],
  ['The managed node config must be a regular konsensus.toml file.', 'Boksens indstillinger skal være en almindelig konsensus.toml-fil.'],
  ['The settings backup already exists and differs; no settings were changed.', 'Der findes allerede en anden backup af indstillingerne; ingen indstillinger blev ændret.'],
  ['The node settings changed during repair; please review them again.', 'Boksens indstillinger blev ændret under reparationen; se dem igennem igen.'],
])('a page-price repair failure reads in Danish, whole: %s', (english, danish) => {
  expect(asActionError(WRAP + english).message).toBe(`Opdateringen af sideprisen mislykkedes; din boks forbliver stoppet. ${danish}`);
});

it('a system error inside a page-price failure stays as it came', () => {
  expect(hostText(`${WRAP}Permission denied (os error 13)`, 'da')).toBe('Opdateringen af sideprisen mislykkedes; din boks forbliver stoppet. Permission denied (os error 13)');
});

it('the repair screen shows the whole failure in Danish', async () => {
  dispose = render(() => <InitializationRepair priceFloor repairing={false} onConfirm={async () => { throw `${WRAP}The settings backup already exists and differs; no settings were changed.`; }} />, document.body);
  document.querySelector<HTMLButtonElement>('button.primary')!.click();
  await flush();
  expect(alert()).toBe('Opdateringen af sideprisen mislykkedes; din boks forbliver stoppet. Der findes allerede en anden backup af indstillingerne; ingen indstillinger blev ændret.');
});
