import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import { setLanguagePref } from '../src/i18n';
import { INITIAL_PAIRING, type PairingView } from '../src/onboarding/pairing';

// Run 2: after pairing, a phone sees one plain trust step, not the desktop identity checklist.
let dispose: (() => void) | undefined;
let mount: HTMLElement | undefined;
afterEach(() => { dispose?.(); mount?.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); setLanguagePref('en'); });
const paired: PairingView = { ...INITIAL_PAIRING, state: 'paired', remote: true, scopes: ['read', 'receive'] };

function start(ua: string) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke: (cmd: string) => {
    if (cmd === 'node_status') return Promise.resolve({ phone_setup: false, ready: true, node_id: 'fa'.repeat(32), error: null });
    if (cmd === 'pairing_status') return Promise.resolve(paired);
    if (cmd === 'device_key_status') return Promise.resolve({ available: true, delegation_supported: true, state: 'none', fingerprint: null, owner_action: null, expires_at_ms: null });
    return Promise.reject(new Error('not available'));
  } });
  mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <App />, mount);
}

it('a paired phone reads a plain Danish trust step, with no access scopes, approvals setup or English card', async () => {
  setLanguagePref('da');
  start('Android');
  await vi.waitFor(() => expect(mount!.querySelector('[data-gate="g6-remote-trust"]')).not.toBeNull());
  const text = mount!.textContent!;
  expect(mount!.querySelector('[data-ob-head="trust"] h1')?.textContent).toBe('Næsten færdig');
  expect(mount!.querySelector('[data-gate="g6-remote-trust"] h2')?.textContent).toBe('Stoler du på værten for din boks?');
  expect([...mount!.querySelectorAll('button')].some(b => b.textContent === 'Jeg forstår – fortsæt')).toBe(true);
  expect(mount!.querySelector<HTMLElement>('.pairing-access')?.hidden).toBe(true);
  expect(text).not.toMatch(/Remote trust|Only fund a node|I understand|BitSov-identitet|ejerenhed/);
  expect(mount!.querySelector('[data-device-approvals], .device-approvals')).toBeNull();
});

it('the Mac keeps its own trust card and checklist', async () => {
  start('Macintosh');
  await vi.waitFor(() => expect(mount!.querySelector('[data-gate="g6-remote-trust"]')).not.toBeNull());
  expect(mount!.querySelector('[data-gate="g6-remote-trust"] h2')?.textContent).toBe('Remote trust — read this before you deposit');
  expect(mount!.querySelector<HTMLElement>('.pairing-access')?.hidden).toBe(false);
});
