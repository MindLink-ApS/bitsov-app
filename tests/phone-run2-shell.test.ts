import { afterEach, expect, it, vi } from 'vitest';
import { setLanguagePref } from '../src/i18n';
import { callRefusal } from '../src/control/call';
import { nodePill, peerName, peerNotReadyMessage } from '../src/control/state';
import { readinessLine } from '../src/control/readiness';
import { paidAmount } from '../src/control/format';

const phone = () => { vi.stubGlobal('__TAURI_INTERNALS__', {}); vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone'); };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); setLanguagePref('en'); });
const ID = '90080d3b' + '0'.repeat(48) + '03356682';

it('a call to an unpaid contact says it was not set up and nothing was paid', () => {
  setLanguagePref('da');
  expect(callRefusal({ code: 'call_needs_contact', message: 'Calls go to contacts you have already paid. Send them a message first. Nothing was paid.' }))
    .toBe('Opkaldet blev ikke oprettet. Intet blev betalt. Du kan ringe til kontakter, du allerede har skrevet med.');
});

it('a phone names an unnamed contact "Ny kontakt"; the Mac keeps the id', () => {
  setLanguagePref('da');
  expect(peerName(undefined, ID)).toMatch(/^Kontakt uden navn \(/);
  phone();
  expect(peerName(undefined, ID)).toBe('Ny kontakt');
});

it('a phone says a contact’s box is temporarily not ready, without chain jargon', () => {
  setLanguagePref('da');
  phone();
  expect(peerNotReadyMessage({ code: 'peer_not_ready', reason: 'chain_unavailable' }, 'Maya')).toBe('Mayas boks er ikke klar lige nu – prøv igen om lidt.');
});

it('the phone status pill and readiness line say only Klar or Ikke klar', () => {
  setLanguagePref('da');
  phone();
  const overview = { money_ready: true, read_at: Date.now() } as Parameters<typeof readinessLine>[0];
  expect(readinessLine(overview, Date.now())).toBe('Klar');
  expect(readinessLine({ ...overview!, money_ready: false }, Date.now())).toBe('Ikke klar');
  const pill = nodePill({ remote: true, ready: true, error: null, overview: overview!, link: 'open', nowMs: Date.now() } as Parameters<typeof nodePill>[0]);
  expect(pill.text).toBe('Klar');
});

it('a phone receipt leaves out the unreported-fee note; the Mac keeps it', () => {
  setLanguagePref('da');
  expect(paidAmount(1000)).toContain('netværksgebyr ikke oplyst');
  phone();
  expect(paidAmount(1000)).not.toContain('netværksgebyr');
});
