import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import { AddDevice, JoinDevice, type AddInput } from '../src/onboarding/AddDevice';
import { setLanguagePref } from '../src/i18n';
import { RemoteOwnerCeremony } from '../src/onboarding/RemoteOwnerCeremony';

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); document.body.innerHTML = ''; vi.useRealTimers(); setLanguagePref('system'); });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function mount(ui: () => any) {
  const root = document.createElement('div'); document.body.append(root);
  dispose = render(ui, root); return root;
}
async function click(root: HTMLElement, text: string) {
  const button = [...root.querySelectorAll('button')].find(b => b.textContent === text);
  expect(button, text).toBeTruthy(); button!.click(); await flush();
}
const code = 'ABCDEFGHIJKLMNOPQR';
const show = 'Show the code for a new device';
const ready = {state:'ready', owner:true} as const;
const open = () => ({state:'claim_code' as const, claim:{state:'open' as const, code, expires_at:Date.now()/1000+65}});

it.each([false, true])('offers code display only to an owner (mobile=%s)', async mobile => {
  let owner = false;
  const api = vi.fn(async () => ({state:'ready', owner}) as const);
  const root = mount(() => <AddDevice mobile={mobile} api={api} />); await flush();
  expect(root.textContent).not.toContain(show);
  owner = true; dispose?.(); dispose = render(() => <AddDevice mobile={mobile} api={api} />, root); await flush();
  expect(root.textContent).toContain(show);
});

it('offers code display to an enrolled owner of the node on this Mac', async () => {
  const root = mount(() => <AddDevice local api={async () => ({state:'unsupported', owner:true})} />); await flush();
  expect(root.textContent).toContain(show);
});

it('fetches on tap, groups all 18 characters and counts down without storing the code', async () => {
  vi.useFakeTimers();
  const api = vi.fn(async (input: AddInput) => input.action === 'status' ? ready : open());
  const storage = vi.spyOn(Storage.prototype, 'setItem');
  const root = mount(() => <AddDevice api={api} />); await flush();
  expect(api).toHaveBeenCalledTimes(1);
  expect(root.textContent).not.toContain(code);
  await click(root, show);
  expect(api).toHaveBeenLastCalledWith({action:'claim_code'});
  expect(root.querySelector('[data-owner-claim-code]')!.textContent).toBe('ABCDEF GHIJKL MNOPQR');
  expect(root.querySelector('[data-claim-countdown]')!.textContent).toContain('1:05');
  await vi.advanceTimersByTimeAsync(1000);
  expect(root.querySelector('[data-claim-countdown]')!.textContent).toContain('1:04');
  expect(storage.mock.calls.some(args => args.some(value => String(value).includes(code)))).toBe(false);
  storage.mockRestore();
});

it.each(['closed', 'claimed', 'unavailable'] as const)('explains %s without exposing a code', async state => {
  const root = mount(() => <AddDevice api={async input => input.action === 'status' ? ready : {state:'claim_code', claim:{state}}} />); await flush();
  await click(root, show);
  expect(root.querySelector('[data-claim-state]')!.textContent).toContain(state === 'closed' ? 'Restart' : state === 'claimed' ? 'already claimed' : 'unavailable');
  expect(root.querySelector('[data-owner-claim-code]')).toBeNull();
});

it.each(['button', 'escape', 'cancel', 'native-close', 'backdrop', 'dispose'] as const)('clears the response in memory on %s', async how => {
  const response = open();
  const root = mount(() => <AddDevice api={async input => input.action === 'status' ? ready : response} />); await flush();
  await click(root, show);
  const dialog = root.querySelector('dialog')!;
  if (how === 'button') await click(root, 'Close');
  else if (how === 'escape') window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
  else if (how === 'cancel') dialog.dispatchEvent(new Event('cancel', {cancelable:true}));
  else if (how === 'native-close') dialog.close();
  else if (how === 'backdrop') dialog.click();
  else dispose?.();
  await flush();
  expect(response.claim.code).toBe('');
  expect(root.querySelector('[data-owner-claim-code]')).toBeNull();
});

it('discards an in-flight response after close and fetches fresh data on reopen', async () => {
  let resolve!: (value: any) => void;
  const api = vi.fn(async (input: AddInput) => input.action === 'status' ? ready : new Promise<any>(r => { resolve = r; }));
  const root = mount(() => <AddDevice api={api} />); await flush(); await click(root, show);
  await click(root, 'Close');
  const response = open(); resolve(response); await flush();
  expect(response.claim.code).toBe('');
  expect(root.querySelector('dialog')).toBeNull();
  await click(root, show);
  expect(api).toHaveBeenCalledTimes(3);
  expect(root.querySelector('[data-owner-claim-code]')).toBeNull();
});

it('clears the code when its expiry is reached', async () => {
  vi.useFakeTimers(); const response = open(); response.claim.expires_at = Date.now()/1000+1;
  const root = mount(() => <AddDevice api={async input => input.action === 'status' ? ready : response} />); await flush(); await click(root, show);
  await vi.advanceTimersByTimeAsync(1000);
  expect(response.claim.code).toBe('');
  expect(root.querySelector('[data-owner-claim-code]')).toBeNull();
  expect(root.querySelector('[data-claim-state]')!.textContent).toContain('expired');
});

it.each([['en', false], ['da', false], ['en', true], ['da', true]] as const)('directs claim entry to the other device in %s (setup=%s)', async (lang, setup) => {
  setLanguagePref(lang);
  const root = mount(() => setup
    ? <RemoteOwnerCeremony api={async () => ({state:'starting'})} onComplete={() => {}} />
    : <JoinDevice api={async () => ({state:'idle'})} />); await flush();
  expect(root.textContent).toContain(lang === 'en'
    ? 'Open BitSov on your other device and choose Add a device → Show the code'
    : 'Åbn BitSov på din anden enhed, og vælg Tilføj en enhed → Vis koden');
  expect(root.textContent).not.toMatch(/sticker|mærkat|local console|lokal terminal|konsensus\s/i);
});

it.each(['en', 'da'] as const)('keeps host failure details out of the code sheet in %s', async lang => {
  setLanguagePref(lang);
  const root = mount(() => <AddDevice api={async input => {
    if (input.action === 'status') return ready;
    throw {message:'Run konsensus claim-code --show', code};
  }} />); await flush();
  await click(root, lang === 'en' ? show : 'Vis koden til en ny enhed');
  expect(root.textContent).not.toMatch(/konsensus\s/);
  expect(root.textContent).not.toContain(code);
  expect(root.querySelector('[role="alert"]')).not.toBeNull();
});
