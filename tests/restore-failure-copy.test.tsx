import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import { setLanguagePref } from '../src/i18n';
import { INITIAL_PAIRING } from '../src/onboarding/pairing';

let dispose: (() => void) | undefined;
let mount: HTMLElement;
afterEach(() => { dispose?.(); mount?.remove(); vi.unstubAllGlobals(); localStorage.clear(); setLanguagePref('en'); });

const RAW = 'identity_restore: mnemonic checksum mismatch (code 17)';
const SUMMARY = {
  en: 'Your identity could not be restored. Check that your recovery phrase has all 12 or 24 words, spelled right and in order, then try again.',
  da: 'Din identitet kunne ikke gendannes. Tjek, at din gendannelsessætning har alle 12 eller 24 ord, stavet rigtigt og i den rigtige rækkefølge, og prøv igen.',
} as const;

it.each(['en', 'da'] as const)('a failed restore shows a plain summary and keeps the raw error behind closed Details (%s)', async (lang) => {
  setLanguagePref(lang);
  const invoke = vi.fn(async (cmd: string, _args?: unknown) => {
    if (cmd === 'node_status') return { ready: true, node_id: 'aa'.repeat(32), error: null };
    if (cmd === 'pairing_status') return { ...INITIAL_PAIRING, state: 'fallback', scopes: [], bootstrap: null };
    if (cmd === 'identity_restore') throw new Error(RAW);
    throw new Error('unavailable');
  });
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
  mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <App />, mount);

  await vi.waitFor(() => expect(mount.querySelector('[data-restore-open]')).not.toBeNull());
  mount.querySelector<HTMLButtonElement>('[data-restore-open]')!.click();
  const input = mount.querySelector<HTMLInputElement>('#restore-phrase')!;
  input.value = 'abandon '.repeat(11) + 'about';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

  await vi.waitFor(() => expect(mount.querySelector('[data-soft-summary]')?.textContent).toBe(SUMMARY[lang]));
  expect(invoke.mock.calls.filter(([cmd]) => cmd === 'identity_restore')).toHaveLength(1);
  const details = mount.querySelector<HTMLDetailsElement>('[data-soft-detail]')!;
  expect(details).not.toBeNull();
  expect(details.open).toBe(false);
  expect(details.textContent).toContain(RAW);
  // The raw text appears once, and only inside the closed Details.
  expect(mount.textContent!.split(RAW)).toHaveLength(2);
  const outside = mount.cloneNode(true) as HTMLElement;
  outside.querySelector('[data-soft-detail]')!.remove();
  expect(outside.textContent).not.toContain(RAW);
  expect(outside.textContent).not.toContain('That could not be completed');
});
