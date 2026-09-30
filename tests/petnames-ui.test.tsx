import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import {
  sampleSource,
  SAMPLE_OWN_ID,
  SAMPLE_PEERS,
  SAMPLE_FRONT_DOOR_LINK,
} from '../src/control/sample';
import {
  plantVerifiedKeyForTests,
  resetContactsForTests,
  setPetname,
} from '../src/control/petnames';

let dispose: (() => void) | undefined;
let mount: HTMLElement;
afterEach(() => {
  dispose?.();
  mount?.remove();
  resetContactsForTests();
  vi.useRealTimers();
});
beforeEach(() => resetContactsForTests());

const $ = <T extends HTMLElement = HTMLElement>(s: string) => mount.querySelector<T>(s)!;
const maya = SAMPLE_PEERS[0].node_id;

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

it('warns when a previously verified key no longer matches', async () => {
  setPetname(maya, 'Maya');
  plantVerifiedKeyForTests(maya, 'b'.repeat(64));
  await openMaya();
  await vi.waitFor(() => expect($('[data-contact-pill="key-changed"]')).not.toBeNull());
  $<HTMLButtonElement>('[data-contact-open]').click();
  await vi.waitFor(() => expect($('[data-contact-key-changed]')).not.toBeNull());
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
