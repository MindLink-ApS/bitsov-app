import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setLanguagePref } from '../src/i18n';
import { HOST_COPY_DA, hostText } from '../src/control/hostCopy';
import { asActionError } from '../src/control/state';
import { softenError } from '../src/control/userFacing';

const rust = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? rust(p) : p.endsWith('.rs') ? [p] : [];
});
/** Fixed sentences the host passes as a refusal: literal or `format!` text in `ActionError::new`. */
const hostRefusals = () => rust('src-tauri/src').flatMap((f) => {
  const source = readFileSync(f, 'utf8').split('#[cfg(test)]')[0];
  return [...source.matchAll(/ActionError::new\(\s*"[a-z_0-9]+"\s*,\s*(?:format!\(\s*)?"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => m[1].replace(/\\\s*\n\s*/g, '').replace(/\\"/g, '"').replace(/\{[a-z_]*\}/g, '{}'));
});
// Composed elsewhere, or not sentences a person reads as they are: named here so a new refusal cannot slip by.
const NOT_LISTED = new Set(['{} {}', 'private owner approval receipts are not supported on this platform', '{} {} not a connected peer, so the node would skip them without telling you. Rooms send only when every member is connected.']);

/** Plain-text host errors a person can read: sentences, as opposed to lowercase diagnostics. */
const plainErrors = () => rust('src-tauri/src').flatMap((f) => {
  const source = readFileSync(f, 'utf8').split('#[cfg(test)]')[0];
  return [...source.matchAll(/(?:Err\(\s*(?:format!\(\s*)?|map_err\(\|[a-z_]+\|\s*(?:format!\(\s*)?|\.ok_or(?:_else\(\|\|)?\(?\s*(?:format!\(\s*)?)"([A-Z][^"]{14,})"/g)]
    .map((m) => m[1].replace(/\\\s*\n\s*/g, '').replace(/\{[A-Za-z_]*\}/g, '{}'));
});

afterEach(() => setLanguagePref('en'));

describe('host refusals in Danish', () => {
  it('has Danish for every fixed refusal the host can send', () => {
    const known = new Set(HOST_COPY_DA.map(([en]) => en));
    const missing = [...new Set(hostRefusals())].filter((m) => !known.has(m) && !NOT_LISTED.has(m)
      // The two the renderer already words itself (`asActionError`).
      && !/^(Hanging up this call|Money is not ready|This permission covers)/.test(m));
    expect(missing).toEqual([]);
  });
  it('has Danish for every sentence in the host\'s plain-text errors', () => {
    const known = new Set(HOST_COPY_DA.map(([en]) => en));
    expect([...new Set(plainErrors())].filter((m) => !known.has(m))).toEqual([]);
  });
  it('keeps every value, and says nothing happened wherever the host does', () => {
    for (const [en, da] of HOST_COPY_DA) {
      const slots = en.split('{}').length - 1;
      for (let i = 0; i < slots; i++) expect(da, en).toContain(`{${i}}`);
      expect(da, en).not.toMatch(new RegExp(`\\{${slots}\\}`));
      if (/nothing (more |new )?was|no minute was/i.test(en)) expect(da, en).toMatch(/intet/i);
      expect(da, en).not.toBe(en);
    }
  });
  it('a money refusal keeps its warning in Danish, so nothing can replace it', () => {
    const fill = (t: string) => t.replace(/\{\d*\}/g, '5');
    for (const [en, da] of HOST_COPY_DA) if (softenError(fill(en)).money) expect(softenError(fill(da)).money, en).toBe(true);
  });
  it('translates the exact refusal, with its values, only in Danish', () => {
    const refusal = 'This is more than the 50 sats per payment your node allows. Nothing was sent.';
    expect(hostText(refusal, 'en')).toBe(refusal);
    expect(hostText(refusal, 'da')).toBe('Det er mere end de 50 sats pr. betaling, din boks tillader. Intet blev sendt.');
  });
  it('translates a known refusal inside another', () => {
    expect(hostText('Outcome unknown; another spend is blocked until reconciled. Nothing was paid.', 'da'))
      .toBe('Udfaldet er ukendt; nye betalinger er blokeret, indtil det er afklaret. Intet blev betalt.');
  });
  it('leaves text it does not know exactly as the host wrote it', () => {
    expect(hostText('Nothing was paid. And something new.', 'da')).toBe('Nothing was paid. And something new.');
  });
  it('reaches a refusal through the one place errors enter the app', () => {
    setLanguagePref('da');
    expect(asActionError({ code: 'call_price_changed', message: 'Their per-minute price is no longer the one you agreed to. Nothing was sent or paid; check the price and call again.' }).message)
      .toBe('Deres minutpris er ikke længere den, du accepterede. Intet blev sendt eller betalt; tjek prisen, og ring igen.');
    expect(asActionError('Files up to 1.4 MB can be sent from the app for now.').message).toBe('Indtil videre kan filer op til 1,4 MB sendes fra appen.');
    setLanguagePref('en');
    expect(asActionError({ code: 'x', message: 'Payments are paused. Resume them first.' }).message).toBe('Payments are paused. Resume them first.');
  });
});
