import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { copyPlainText } from '../src/assistant/copy';
import { endpointBadge, OWN_RULES } from '../src/assistant/endpoint';
import { ControlCenter } from '../src/control/Shell';
import { FrontDoorEditor } from '../src/control/Discover';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';
import { Onboarding } from '../src/onboarding/Onboarding';
import { RemoteOwnerCeremony } from '../src/onboarding/RemoteOwnerCeremony';
import type { NodeStatus, PairingView } from '../src/onboarding/pairing';
import { deviceWord } from '../src/platform';

// UI/UX audit 21 Oct: copy that is wrong on a phone, a "Copied" that was not
// true, and WebKit's own OS-language labels next to English copy.

let dispose: (() => void) | undefined;
let mount: HTMLElement;
const realExec = document.execCommand;
afterEach(() => {
  dispose?.();
  mount?.remove();
  document.execCommand = realExec;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
/** A phone build: use its Tauri runtime and reported user agent. */
function asPhone(userAgent = IPHONE) {
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke: () => Promise.reject(new Error('no host in this test')), transformCallback: () => 0 });
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
}
function mountIt(ui: () => any) {
  mount = document.createElement('div');
  document.body.appendChild(mount);
  dispose = render(ui, mount);
}
const $ = <T extends Element = HTMLElement>(sel: string) => mount.querySelector<T>(sel);

it('copyPlainText rejects when nothing was copied, instead of pretending', async () => {
  vi.stubGlobal('navigator', { ...navigator, language: navigator.language, clipboard: undefined });
  document.execCommand = () => false;
  await expect(copyPlainText('bc1qexample')).rejects.toThrow(/Copy did not work/);
  expect(document.querySelector('textarea')).toBeNull();
});

it('the wallet Copy button says Copy failed, never Copied, when the copy did not happen', async () => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } });
  document.execCommand = () => false;
  mountIt(() => <ControlCenter source={sampleSource({ firstLiveMs: 1e9 })} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />);
  await vi.waitFor(() => expect($('[data-profile]')).not.toBeNull());
  $<HTMLButtonElement>('[data-profile]')!.click();
  $<HTMLButtonElement>('[data-open-wallet]')!.click();
  await vi.waitFor(() => expect($('[data-wallet-tab="receive"]')).not.toBeNull());
  $<HTMLButtonElement>('[data-wallet-tab="receive"]')!.click();
  $<HTMLButtonElement>('[data-receive-how="onchain"]')!.click();
  await vi.waitFor(() => expect($('[data-wallet-copy]')).not.toBeNull());
  $<HTMLButtonElement>('[data-wallet-copy]')!.click();
  await vi.waitFor(() => expect($('[data-wallet-copy]')!.textContent).toMatch(/Copy failed/));
  expect($('[data-wallet-copy]')!.textContent).not.toMatch(/^Copied/);
});

it('says "computer" on a desktop and "phone" on a phone', () => {
  expect(deviceWord('desktop')).toBe('computer');
  expect(deviceWord('ios')).toBe('phone');
  expect(deviceWord('android')).toBe('phone');
  expect(endpointBadge(OWN_RULES).where).toBe('On this computer · rules');
  expect(OWN_RULES.label).toBe('On this computer');
  asPhone();
  expect(deviceWord()).toBe('phone');
  expect(endpointBadge(OWN_RULES).where).toBe('On this phone · rules');
  expect(OWN_RULES.label).toBe('On this phone');
});

const booting: NodeStatus = { ready: false, node_id: null, error: null };
const starting = { state: 'starting', remote: true } as unknown as PairingView;

it('phone onboarding: no <details> (no WebKit "Details"/"Flere oplysninger"), and no "Scan" without a scanner', () => {
  mountIt(() => <Onboarding status={() => booting} pairing={() => starting} trustAck={() => false} onRetry={() => {}}
    selectedTarget="network" onForgetRemote={async () => {}} phone />);
  expect(mount.querySelector('details.node-target-advanced')).toBeNull();
  expect(mount.querySelector('.node-target-advanced > summary')).toBeNull();
  const node = $('[data-target="network"]')!;
  expect(node.textContent).toContain('Paste its pairing link to connect this phone.');
  expect(node.textContent).not.toMatch(/Scan/);
});

it('the box setup on a phone does not ask for a password or promise Touch ID', () => {
  mountIt(() => <RemoteOwnerCeremony phone onComplete={() => {}} api={async () => { throw new Error('not on a phone'); }} />);
  expect($('#box-password')).toBeNull();
  expect(mount.textContent).not.toMatch(/Touch ID|This Mac will/);
  expect($('[data-remote-owner-phone]')!.textContent).toMatch(/needs BitSov on your Mac/);
});

it('the box setup on a Mac keeps its form', () => {
  mountIt(() => <RemoteOwnerCeremony onComplete={() => {}} api={async () => { throw new Error('unused'); }} />);
  expect($('#box-password')).not.toBeNull();
  expect($('[data-remote-owner-phone]')).toBeNull();
});

it('Profile: the image pickers use the app’s own words, not the native "Choose File / No file chosen"', async () => {
  mountIt(() => <FrontDoorEditor source={sampleSource({ firstLiveMs: 1e9 })} now={Date.now()} />);
  await vi.waitFor(() => expect($('[data-fd-edit-avatar]')).not.toBeNull());
  for (const sel of ['[data-fd-edit-avatar]', '[data-fd-edit-media]']) {
    const input = $<HTMLInputElement>(sel)!;
    expect(input.classList.contains('sr-only')).toBe(true);
    // Still a labelled, focusable control.
    expect(input.closest('label')!.textContent).toMatch(/Avatar|Media/);
  }
  expect(mount.textContent).toContain('Choose image');
  expect(mount.textContent).toContain('No image chosen');
});

it.each([['iPhone', IPHONE], ['Android', ANDROID]])('assistant, Browse and Wallet copy on %s uses phone wording', async (_label, userAgent) => {
  asPhone(userAgent);
  mountIt(() => <ControlCenter source={sampleSource({ firstLiveMs: 1e9 })} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />);
  await vi.waitFor(() => expect($('[data-track="assistant:node"]')).not.toBeNull());
  $<HTMLButtonElement>('[data-track="assistant:node"]')!.click();
  await vi.waitFor(() => expect($('[data-assistant-role]')).not.toBeNull());
  expect($('[data-assistant-role]')!.textContent).not.toMatch(/Mac/);
  await vi.waitFor(() => expect(mount.textContent).toMatch(/this phone/));
  const all = mount.textContent ?? '';
  expect(all.match(/.{0,80}(this computer|this Mac).{0,40}/g)).toBeNull();
  $<HTMLButtonElement>('[data-track="discover"]')!.click();
  await vi.waitFor(() => expect($('[data-panel="discover"]')).not.toBeNull());
  expect($('[data-panel="discover"]')!.textContent).not.toMatch(/desktop app/);
  $<HTMLButtonElement>('[data-phone-tab="wallet"]')!.click();
  await vi.waitFor(() => expect($('[data-wallet-tab="activity"]')).not.toBeNull());
  $<HTMLButtonElement>('[data-wallet-tab="activity"]')!.click();
  expect(mount.textContent).toContain('made in this app on this phone');
  expect(mount.textContent).not.toMatch(/on this Mac|Touch ID|desktop app/);
});
