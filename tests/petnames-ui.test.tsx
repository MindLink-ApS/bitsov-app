import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import { ContactPanel } from '../src/control/ContactPanel';
import {
  sampleSource,
  SAMPLE_OWN_ID,
  SAMPLE_PEERS,
  SAMPLE_FRONT_DOOR_LINK,
} from '../src/control/sample';
import {
  markVerified,
  replaceContactKey,
  resetContactsForTests,
  setPetname,
  verifyState,
} from '../src/control/petnames';
import { setLanguagePref } from '../src/i18n';
import type { Peer } from '../src/control/types';

let dispose: (() => void) | undefined;
let mount: HTMLElement;
afterEach(() => {
  dispose?.();
  mount?.remove();
  resetContactsForTests();
  vi.useRealTimers();
  setLanguagePref('en');
});
beforeEach(() => resetContactsForTests());

const $ = <T extends HTMLElement = HTMLElement>(s: string) => mount.querySelector<T>(s)!;
const maya = SAMPLE_PEERS[0].node_id;
const OLD = 'f'.repeat(64);

async function openMaya() {
  const source = sampleSource({ firstLiveMs: 1e9 });
  mount = document.createElement('div');
  document.body.appendChild(mount);
  dispose = render(
    () => <ControlCenter source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />,
    mount,
  );
  await vi.waitFor(() => expect($(`[data-track="peer:${maya}"]`)).not.toBeNull());
  $<HTMLButtonElement>(`[data-track="peer:${maya}"]`).click();
  await vi.waitFor(() => expect($('[data-contact-open]')).not.toBeNull());
  return source;
}

it('opens contact sheet from the track title; petname is local; label is self-claimed', async () => {
  await openMaya();
  expect($('.track-head h1').textContent).toBe('Maya');
  $<HTMLButtonElement>('[data-contact-open]').click();
  await vi.waitFor(() => expect($('[data-contact-panel="open"]')).not.toBeNull());
  expect($('[data-contact-claimed]')?.textContent).toMatch(/self-claimed/i);
  expect($('[data-contact-claimed]')?.textContent).toContain('Maya');
  const input = $<HTMLInputElement>('[data-contact-petname]');
  input.value = 'Sister';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() => expect($('.track-head h1').textContent).toBe('Sister'));
});

it('shows fingerprint + QR and marks verified locally', async () => {
  await openMaya();
  $<HTMLButtonElement>('[data-contact-open]').click();
  await vi.waitFor(() => expect($('[data-contact-fp]')).not.toBeNull());
  expect($('[data-contact-fp]').textContent!.replace(/[^0-9a-f]/g, '')).toBe(maya);
  expect($('[data-contact-qr]')).not.toBeNull();
  expect($('[data-contact-qr-text]').textContent).toBe(maya);
  $<HTMLButtonElement>('[data-contact-verify-start]').click();
  $<HTMLButtonElement>('[data-contact-verify-confirm]').click();
  await vi.waitFor(() => expect($('[data-contact-verified-badge]')).not.toBeNull());
  await vi.waitFor(() => expect($('[data-contact-pill="verified"]')).not.toBeNull());
});

it('warns after an owner-confirmed key replacement, and the warning survives reopen', async () => {
  setPetname(OLD, 'Maya');
  markVerified(OLD);
  expect(replaceContactKey(OLD, maya)).toBe(true);
  expect(verifyState(maya)).toBe('key-changed');

  await openMaya();
  await vi.waitFor(() => expect($('[data-contact-pill="key-changed"]')).not.toBeNull());
  $<HTMLButtonElement>('[data-contact-open]').click();
  await vi.waitFor(() => expect($('[data-contact-key-changed]')).not.toBeNull());

  // Close and reopen the panel — warning persists (not cleared by re-init).
  $<HTMLButtonElement>('[data-contact-close]').click();
  await vi.waitFor(() => expect($('[data-contact-panel="closed"]')).not.toBeNull());
  $<HTMLButtonElement>('[data-contact-open]').click();
  await vi.waitFor(() => expect($('[data-contact-key-changed]')).not.toBeNull());
  expect(verifyState(maya)).toBe('key-changed');
});

it('keeps an unsaved petname draft and verify confirmation across a same-key peer refresh', async () => {
  const peerA: Peer = { node_id: maya, addr: null, label: 'Maya', connected: true, fingerprint: 'aaaaaaaa' };
  const [peer, setPeer] = createSignal(peerA);
  const [open, setOpen] = createSignal(true);
  mount = document.createElement('div');
  document.body.appendChild(mount);
  dispose = render(() => <ContactPanel open={open()} peer={peer()} onClose={() => setOpen(false)} />, mount);

  await vi.waitFor(() => expect($('[data-contact-panel="open"]')).not.toBeNull());
  const input = $<HTMLInputElement>('[data-contact-petname]');
  input.value = 'Unsaved local name';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  expect(input.value).toBe('Unsaved local name');
  $<HTMLButtonElement>('[data-contact-verify-start]').click();
  expect($('[data-contact-verify-confirm]')).not.toBeNull();

  // Same node_id, new object — as peers_list refresh does.
  setPeer({ ...peerA, connected: false, label: 'Maya' });
  await Promise.resolve();
  expect($<HTMLInputElement>('[data-contact-petname]').value).toBe('Unsaved local name');
  expect($('[data-contact-verify-confirm]')).not.toBeNull();
});

it('marks front-door display names as self-claimed suggestions', async () => {
  const source = sampleSource({ firstLiveMs: 1e9 });
  mount = document.createElement('div');
  document.body.appendChild(mount);
  dispose = render(
    () => <ControlCenter source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />,
    mount,
  );
  await vi.waitFor(() => expect($('[data-track="discover"]')).not.toBeNull());
  $<HTMLButtonElement>('[data-track="discover"]').click();
  await vi.waitFor(() => expect($('[data-discover-paste]')).not.toBeNull());
  const paste = $<HTMLTextAreaElement>('[data-discover-paste]');
  paste.value = SAMPLE_FRONT_DOOR_LINK;
  paste.dispatchEvent(new Event('input', { bubbles: true }));
  $<HTMLButtonElement>('[data-discover-read]').click();
  await vi.waitFor(() => expect($('[data-fd-claimed]')).not.toBeNull());
  expect($('[data-fd-claimed]').textContent).toMatch(/self-claimed/i);
});

it.each(['en', 'da'] as const)('includes the visible verification state in the contact title name in %s', async locale => {
  setLanguagePref(locale);
  await openMaya();
  const name = () => $('[data-contact-open]').getAttribute('aria-label');
  expect(name()).toBe(locale === 'en' ? 'Contact Maya' : 'Kontakt Maya');
  markVerified(maya);
  await vi.waitFor(() => expect($('[data-contact-pill="verified"]')).not.toBeNull());
  expect(name()).toBe(locale === 'en' ? 'Contact Maya, Verified' : 'Kontakt Maya, Bekræftet');
  expect(replaceContactKey(maya, OLD)).toBe(true);
  expect(replaceContactKey(OLD, maya)).toBe(true);
  await vi.waitFor(() => expect($('[data-contact-pill="key-changed"]')).not.toBeNull());
  expect($('[data-contact-pill="verified"]')).toBeNull();
  expect(name()).toBe(locale === 'en' ? 'Contact Maya, Key changed' : 'Kontakt Maya, Nøgle ændret');
  $('[data-contact-open]').click();
  await vi.waitFor(() => expect($('[data-contact-panel="open"]')).not.toBeNull());
});
