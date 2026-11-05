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
    .map((m) => m[1].replace(/\\\s*\n\s*/g, '').replace(/\\"/g, '"').replace(/\{[a-z_]*\}/g, '{}'))
    // The host fills in the singular or the plural, so both must be listed.
    .flatMap((m) => m.startsWith('{} {} not a connected peer') ? [m.replace('{} {}', '{} member is'), m.replace('{} {}', '{} members are')] : [m]);
});
// Composed elsewhere, or not sentences a person reads as they are: named here so a new refusal cannot slip by.
const NOT_LISTED = new Set(['{} {}', 'private owner approval receipts are not supported on this platform']);

/**
 * Every whole sentence in the host's setup and main files, however it is returned:
 * `Err`, a closure body or a match arm. A sentence here starts with a capital and ends with a full stop.
 */
const plainErrors = () => ['src-tauri/src/app.rs', 'src-tauri/src/remote_owner.rs', 'src-tauri/src/remote_owner/recovery.rs'].flatMap((f) => {
  const source = readFileSync(f, 'utf8').split('#[cfg(test)]')[0];
  return [...source.matchAll(/"([A-Z][^"\n]{14,}[.!?])"/g)]
    .map((m) => m[1].replace(/\{[a-z_:?]*\}/g, '{}'));
});
// Not read as they stand: the renderer words these itself (`asActionError`), or they aren't refusals a person sees.
const NOT_SENTENCES = /^(Hanging up this call|Money is not ready|This permission covers|Send a message first|No pending spend)|konsensus /;

afterEach(() => setLanguagePref('en'));

describe('host refusals in Danish', () => {
  it('has Danish for every fixed refusal the host can send', () => {
    const known = new Set(HOST_COPY_DA.map(([en]) => en));
    const missing = [...new Set(hostRefusals())].filter((m) => !known.has(m) && !NOT_LISTED.has(m)
      // The two the renderer already words itself (`asActionError`).
      && !/^(Hanging up this call|Money is not ready|This permission covers)/.test(m));
    expect(missing).toEqual([]);
  });
  it('has Danish for the sentences in the host\'s setup and repair errors', () => {
    const known = new Set(HOST_COPY_DA.map(([en]) => en));
    expect([...new Set(plainErrors())].filter((m) => !known.has(m) && !NOT_SENTENCES.test(m))).toEqual([]);
  });
  it('keeps every value, and says nothing happened wherever the host does', () => {
    for (const [en, da] of HOST_COPY_DA) {
      const slots = en.split('{}').length - 1;
      for (let i = 0; i < slots; i++) expect(da, en).toContain(`{${i}}`);
      expect(da, en).not.toMatch(new RegExp(`\\{${slots}\\}`));
      // Says only what is sure: finalizing can commit before this check, so it names the saved key alone.
      if (en.endsWith('Nothing was re-pinned.')) expect(da, en).toContain('gemte nøgle blev ikke ændret');
      else if (/nothing (more |new )?was|no minute was/i.test(en)) expect(da, en).toMatch(/intet/i);
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
  it('keeps a node\'s own detail as it came, even when it reads like a known refusal', () => {
    expect(hostText('Outcome unknown; another spend is blocked until reconciled. Nothing was paid.', 'da'))
      .toBe('Udfaldet er ukendt; nye betalinger er blokeret, indtil det er afklaret. Nothing was paid.');
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
