import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import type { LiveEvent } from '../src/control/types';

let dispose: (() => void) | undefined;
// Transform the large shell before timing individual interaction tests.
beforeAll(async () => { await import('../src/control/Shell'); }, 30_000);
afterEach(() => {
  dispose?.(); dispose = undefined;
  document.body.innerHTML = '';
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
const $ = (selector: string) => document.querySelector<HTMLButtonElement>(selector);
const tick = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };

async function mount(store: boolean, language: 'en' | 'da' = 'en', options: { phone?: boolean; firstContact?: boolean } = {}) {
  vi.stubEnv('VITE_IOS_STORE', store ? '1' : '0');
  // Re-import the build constant, just as two separate bundles would do.
  vi.resetModules();
  const { ControlCenter, setShowLegacyRoomsUi } = await import('../src/control/Shell');
  const { sampleSource, SAMPLE_OWN_ID } = await import('../src/control/sample');
  const { setLanguagePref } = await import('../src/i18n');
  setLanguagePref(language);
  setShowLegacyRoomsUi(true);
  const source = sampleSource({ firstLiveMs: 1e9 });
  if (options.firstContact) {
    const budget = source.budgetStatus;
    source.budgetStatus = async () => ({ ...await budget(), rows: [] });
    source.messages = async () => [];
  }
  if (options.phone) {
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone');
    vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
  }
  const overview = source.nodeOverview;
  source.nodeOverview = async () => ({ ...await overview(), capabilities: ['room_binding_v1', 'call_meeting_v1', 'porch_quote_v1'] });
  let emit: (event: LiveEvent) => void = () => {};
  source.onLive = async handler => { emit = handler; return () => {}; };
  dispose = render(() => <ControlCenter source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={null} />, document.body);
  if (options.phone) {
    await vi.waitFor(() => expect($('[data-phone-list] [data-track^="peer:"]')).not.toBeNull());
    $('[data-phone-list] [data-track^="peer:"]')!.click();
  }
  await vi.waitFor(() => expect($('[data-call="audio"]')?.disabled).toBe(false));
  return { emit, source, ownId: SAMPLE_OWN_ID };
}

describe.each(['en', 'da'] as const)('iOS store DOM (%s)', language => {
  it('omits Browse, porch, legacy rooms, new rooms and meeting controls', async () => {
    await mount(true, language);
    for (const selector of ['[data-track="discover"]', '[data-track="porch"]', '[data-track^="room:"]', '[data-track^="bound:"]', '[data-room-new]', '[data-rooms-coming-soon]', '[data-call="meeting"]', '[data-meeting-panel]']) {
      expect($(selector), selector).toBeNull();
    }
    $('[data-track="new"]')!.click(); await tick();
    expect($('[data-browse-porch-hint]')).toBeNull();
    expect($('[data-new-track]')).not.toBeNull();
    expect($('[data-starter-review]')).not.toBeNull(); // Sponsor gift, not starter balance.
  });

  it('keeps messages, files, direct pay and 1:1 call confirmations', async () => {
    await mount(true, language);
    expect($('[data-composer]')).not.toBeNull();
    expect($('[data-send]')).not.toBeNull();
    $('[data-composer-plus]')!.click();
    for (const mode of ['file', 'pay', 'request']) expect($(`[data-composer-mode="${mode}"]`)).not.toBeNull();
    for (const media of ['audio', 'video']) {
      $(`[data-call="${media}"]`)!.click();
      expect($(`[data-call-confirm="${media}"]`)).not.toBeNull();
      $('[data-call-confirm-cancel]')!.click();
    }
  });

  it('keeps the entry fee disclosure for the first message to a person', async () => {
    await mount(true, language, { firstContact: true });
    const draft = document.querySelector<HTMLTextAreaElement>('[data-composer-bar] textarea')!;
    draft.value = 'Hello'; draft.dispatchEvent(new Event('input', { bubbles: true }));
    $('[data-send]')!.click(); await tick();
    await vi.waitFor(() => expect($('[data-first-contact-cost]')?.textContent).toContain('14'));
    expect($('[data-send]')?.disabled).toBe(false);
  });
});

it.each(['en', 'da'] as const)('also removes payment entry points from the phone navigation (%s)', async language => {
  await mount(true, language, { phone: true });
  expect($('[data-phone-tabs]')).not.toBeNull();
  for (const selector of ['[data-track="discover"]', '[data-track="porch"]', '[data-room-new]', '[data-call="meeting"]']) expect($(selector)).toBeNull();
  expect($('[data-composer]')).not.toBeNull();
});

it('strips starter balance even when a caller explicitly enables the component', async () => {
  vi.stubEnv('VITE_IOS_STORE', '1'); vi.resetModules();
  const { StarterBalance } = await import('../src/control/StarterBalance');
  const current = vi.fn(async () => ({ state: 'not_requested' as const, hub_configured: true }));
  dispose = render(() => <StarterBalance enabled network="signet" nodeId="node" capabilities={['starter_channel_request_v1']} api={{ current, request: current }} />, document.body);
  await tick();
  expect($('[data-starter-balance]')).toBeNull();
  expect($('[data-starter-entry]')).toBeNull();
  expect(current).not.toHaveBeenCalled();
});

it.each([
  [true, 'en'], [false, 'en'], [true, 'da'], [false, 'da'],
] as const)('handles incoming meeting invites according to the build profile (store=%s, %s)', async (store, language) => {
  const { emit, ownId } = await mount(store, language);
  emit({ type: 'message', room_id: null, message: {
    id: 'meeting-invite', kind: 400, sender: 'a'.repeat(64), recipient: ownId,
    timestamp: Date.now(), payment_amount_msat: 1000,
    plaintext: JSON.stringify({ v: 1, call_id: 'a'.repeat(32), media: 'audio', sdp: 'offer', meeting: { id: 'b'.repeat(32), roster: ['a'.repeat(64), 'b'.repeat(64), ownId] } }),
  } });
  await tick();
  if (store) expect($('[data-meeting-panel]')).toBeNull();
  else expect($('[data-meeting-panel="invited"]')).not.toBeNull();
  expect($('[data-call-panel]')).toBeNull();
});

it.each(['en', 'da'] as const)('preserves desktop Browse, porch, rooms and the meeting planner with the flag off (%s)', async language => {
  await mount(false, language);
  for (const selector of ['[data-track="discover"]', '[data-track="porch"]', '[data-room-new]', '[data-track^="room:"]', '[data-call="meeting"]']) expect($(selector), selector).not.toBeNull();
  $('[data-call="meeting"]')!.click(); await tick();
  expect($('[data-meeting-panel="planning"]')).not.toBeNull();
});
