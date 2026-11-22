import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import { setLanguagePref } from '../src/i18n';
import { INITIAL_PAIRING } from '../src/onboarding/pairing';
import { RESTORE_SAVED_PREFIX, restoreFailureKind } from '../src/onboarding/restoreFailure';

let dispose: (() => void) | undefined;
let mount: HTMLElement;
afterEach(() => { dispose?.(); mount?.remove(); vi.unstubAllGlobals(); localStorage.clear(); setLanguagePref('en'); });

const RECHECK = {
  en: 'Your identity could not be restored. Check that your recovery phrase has all 12 or 24 words, spelled right and in order, then try again.',
  da: 'Din identitet kunne ikke gendannes. Tjek, at din gendannelsessætning har alle 12 eller 24 ord, stavet rigtigt og i den rigtige rækkefølge, og prøv igen.',
} as const;
const REOPEN = {
  en: 'Your recovery phrase was saved. Quit and reopen BitSov to finish restoring your identity.',
  da: 'Din gendannelsessætning er gemt. Afslut BitSov, og åbn appen igen for at færdiggøre gendannelsen.',
} as const;
// Words that would send the user back to the phrase. None may appear once it is saved.
const RECHECK_WORDS = { en: /check|re-?enter|try again|spelled/i, da: /tjek|indtast|prøv igen|stavet/i } as const;

// The host's three errors after the phrase is already saved (src-tauri/src/app.rs, identity_restore).
const SAVED = {
  restart: 'the recovery phrase was saved, but the node did not come back: node did not answer. Quit and reopen BitSov to finish.',
  confirm: 'the recovery phrase was saved, but the restored identity could not be confirmed: /identity failed (503). Quit and reopen BitSov to finish.',
  mismatch: 'the recovery phrase was saved, but 127.0.0.1:3141 still serves a different identity. Quit and reopen BitSov to finish.',
} as const;
// Errors where the phrase itself may be wrong.
const PHRASE = {
  checksum: '/identity/restore failed (400): invalid mnemonic: invalid checksum',
  nodeCount: '/identity/restore failed (400): mnemonic must be 12 or 24 words, got 13',
  hostCount: 'a recovery phrase is 12 or 24 words',
} as const;

async function failRestore(lang: 'en' | 'da', raw: string, words = 12) {
  setLanguagePref(lang);
  const invoke = vi.fn(async (cmd: string, _args?: unknown) => {
    if (cmd === 'node_status') return { ready: true, node_id: 'aa'.repeat(32), error: null };
    if (cmd === 'pairing_status') return { ...INITIAL_PAIRING, state: 'fallback', scopes: [], bootstrap: null };
    // Tauri rejects with the host's plain string.
    if (cmd === 'identity_restore') throw raw;
    throw new Error('unavailable');
  });
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
  mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <App />, mount);

  await vi.waitFor(() => expect(mount.querySelector('[data-restore-open]')).not.toBeNull());
  mount.querySelector<HTMLButtonElement>('[data-restore-open]')!.click();
  const input = mount.querySelector<HTMLInputElement>('#restore-phrase')!;
  input.value = Array.from({ length: words }, () => 'word').join(' ');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(mount.querySelector('[data-soft-summary]')).not.toBeNull());
  expect(invoke.mock.calls.filter(([cmd]) => cmd === 'identity_restore')).toHaveLength(1);
  return mount.querySelector('[data-soft-summary]')!.textContent;
}

/** The raw host text is present exactly once, inside the closed Details. */
function expectRawOnlyInClosedDetails(raw: string) {
  const details = mount.querySelector<HTMLDetailsElement>('[data-soft-detail]')!;
  expect(details).not.toBeNull();
  expect(details.open).toBe(false);
  expect(details.textContent).toContain(raw);
  expect(mount.textContent!.split(raw)).toHaveLength(2);
  const outside = mount.cloneNode(true) as HTMLElement;
  outside.querySelector('[data-soft-detail]')!.remove();
  expect(outside.textContent).not.toContain(raw);
}

describe.each(['en', 'da'] as const)('restore failure guidance (%s)', (lang) => {
  it.each(Object.entries(SAVED))('a saved phrase that could not finish (%s) says quit and reopen, never re-check', async (_k, raw) => {
    const summary = await failRestore(lang, raw);
    expect(summary).toBe(REOPEN[lang]);
    expect(summary).not.toMatch(RECHECK_WORDS[lang]);
    // Nothing on screen outside Details asks for the phrase again.
    const outside = mount.cloneNode(true) as HTMLElement;
    outside.querySelector('[data-soft-detail]')?.remove();
    outside.querySelector('form')?.remove();
    expect(outside.textContent).not.toContain(RECHECK[lang]);
    expectRawOnlyInClosedDetails(raw);
  });

  it.each(Object.entries(PHRASE))('a phrase the node or host rejected (%s) still says re-check the phrase', async (k, raw) => {
    const summary = await failRestore(lang, raw, k === 'hostCount' ? 13 : 12);
    expect(summary).toBe(RECHECK[lang]);
    expectRawOnlyInClosedDetails(raw);
  });

  it('a failure that is neither keeps the plain fallback, not re-check or reopen', async () => {
    const summary = await failRestore(lang, 'node unreachable: connection refused');
    expect(summary).not.toBe(RECHECK[lang]);
    expect(summary).not.toBe(REOPEN[lang]);
  });
});

describe('restoreFailureKind', () => {
  it('maps the host forms and ignores look-alikes', () => {
    for (const raw of Object.values(SAVED)) expect(restoreFailureKind(raw)).toBe('saved');
    for (const raw of Object.values(PHRASE)) expect(restoreFailureKind(raw)).toBe('phrase');
    expect(restoreFailureKind(`Error: ${SAVED.restart}`)).toBe('saved');
    expect(restoreFailureKind('Identity restore is only available for the local supervised node.')).toBe('other');
    expect(restoreFailureKind('This bootstrap node is not accepting an identity restore.')).toBe('other');
    // "saved" somewhere in the text is not enough.
    expect(restoreFailureKind('/identity/restore failed (500): the recovery phrase was saved, but oops')).toBe('other');
    expect(restoreFailureKind('/identity/restore failed (500): invalid mnemonic file')).toBe('other');
  });

  it('every host error after the save starts with the shared prefix', () => {
    const host = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src-tauri/src/app.rs'), 'utf8');
    const start = host.indexOf('async fn identity_restore(');
    const body = host.slice(start, host.indexOf('Ok(RestoreOutcome {', start));
    const saved = body.match(/"the recovery phrase was saved[^"]*/g) ?? [];
    expect(saved).toHaveLength(3);
    for (const s of saved) expect(s.slice(1).startsWith(RESTORE_SAVED_PREFIX)).toBe(true);
    expect(body).toContain('"a recovery phrase is 12 or 24 words"');
  });
});
