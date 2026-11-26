import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import type { McpStatus } from '../src/control/aiAppsApi';

// The Settings panel stays mounted when it is closed (other tabs keep
// reading), so the AI apps screen must not: closing Settings is leaving it,
// and an open pairing window closes with it.

const status: { value: McpStatus } = {
  value: { platform: 'ok', enabled: true, store: 'empty', start_error: null, pairing_open_s: null, waiting: 0, clients: 0, unsaved_revoke: false },
};
const fake = vi.hoisted(() => ({ api: null as unknown as Record<string, ReturnType<typeof vi.fn>> }));

vi.mock('../src/control/aiAppsApi', async (actual) => {
  const real = await actual<typeof import('../src/control/aiAppsApi')>();
  const api = {
    status: vi.fn(async () => status.value),
    setEnabled: vi.fn(async () => status.value),
    openPairing: vi.fn(async () => { status.value = { ...status.value, pairing_open_s: 120 }; return status.value; }),
    closePairing: vi.fn(async () => { status.value = { ...status.value, pairing_open_s: null }; return status.value; }),
    pending: vi.fn(async () => []),
    approve: vi.fn(),
    deny: vi.fn(),
    clients: vi.fn(async () => []),
    revoke: vi.fn(),
    saveAgain: vi.fn(),
    stopAll: vi.fn(async () => status.value),
    audit: vi.fn(async () => ({ rows: [], unreadable: 0 })),
    resetClients: vi.fn(),
    onChanged: vi.fn(() => () => {}),
  };
  fake.api = api;
  return { ...real, tauriAiApps: api, aiAppsAvailable: async () => true };
});

const { ControlCenter } = await import('../src/control/Shell');
const { sampleSource, SAMPLE_OWN_ID } = await import('../src/control/sample');

let dispose: (() => void) | undefined;
let mount: HTMLElement;
afterEach(() => { dispose?.(); mount?.remove(); vi.clearAllMocks(); status.value = { ...status.value, pairing_open_s: null }; });
const $ = <T extends Element = HTMLElement>(sel: string) => mount.querySelector<T>(sel);

it('closing Settings with a pairing window open closes the window and leaves the screen', async () => {
  mount = document.createElement('div');
  document.body.appendChild(mount);
  dispose = render(() => <ControlCenter source={sampleSource({ firstLiveMs: 1e9 })} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
  await vi.waitFor(() => expect($('[data-tab="ai"]')).not.toBeNull());
  $<HTMLButtonElement>('[data-tab="ai"]')!.click();
  await vi.waitFor(() => expect($('[data-ai-add]')).not.toBeNull());
  $<HTMLButtonElement>('[data-ai-add]')!.click();
  await vi.waitFor(() => expect($('[data-ai-window]')).not.toBeNull());
  expect(fake.api.openPairing).toHaveBeenCalledOnce();
  expect(fake.api.closePairing).not.toHaveBeenCalled();

  $<HTMLButtonElement>('[data-settings-close]')!.click();
  await vi.waitFor(() => expect(fake.api.closePairing).toHaveBeenCalled());
  expect($('[data-ai-apps]')).toBeNull();
  expect(status.value.pairing_open_s).toBeNull();

  // Opening Settings again shows the screen afresh, with no window open.
  $<HTMLButtonElement>('[data-tab="ai"]')!.click();
  await vi.waitFor(() => expect($('[data-ai-add]')).not.toBeNull());
  expect($('[data-ai-window]')).toBeNull();
});

it('switching to another Settings tab with a pairing window open closes the window', async () => {
  mount = document.createElement('div');
  document.body.appendChild(mount);
  dispose = render(() => <ControlCenter source={sampleSource({ firstLiveMs: 1e9 })} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
  await vi.waitFor(() => expect($('[data-tab="ai"]')).not.toBeNull());
  $<HTMLButtonElement>('[data-tab="ai"]')!.click();
  await vi.waitFor(() => expect($('[data-ai-add]')).not.toBeNull());
  $<HTMLButtonElement>('[data-ai-add]')!.click();
  await vi.waitFor(() => expect($('[data-ai-window]')).not.toBeNull());
  expect(fake.api.closePairing).not.toHaveBeenCalled();

  $<HTMLButtonElement>('[data-tab="general"]')!.click();
  await vi.waitFor(() => expect(fake.api.closePairing).toHaveBeenCalled());
  expect($('[data-ai-apps]')).toBeNull();
  expect(status.value.pairing_open_s).toBeNull();
});
