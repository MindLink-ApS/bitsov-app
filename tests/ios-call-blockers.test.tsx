import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';
import type { Source } from '../src/control/source';
import { visibleBackDestination } from '../src/ios/edgeBack';

const css = readFileSync(join(__dirname, '../src/styles.css'), 'utf8');
const style = document.createElement('style');
style.textContent = css.replace(/env\(safe-area-inset-(top|right|bottom|left)(?:,\s*0px)?\)/g,
  (_, edge: string) => ({ top: '59px', right: '47px', bottom: '34px', left: '47px' })[edge]!);
document.head.append(style);

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function mount(source: Source) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone');
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  dispose = render(() => <ControlCenter source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={null} />, document.body);
  await vi.waitFor(() => expect(document.querySelector('[data-phone-list] [data-track^="peer:"]')).not.toBeNull());
  document.querySelector<HTMLButtonElement>('[data-phone-list] [data-track^="peer:"]')!.click();
  await vi.waitFor(() => expect(document.querySelector('[data-composer]')).not.toBeNull());
}

it('blocks Back for an incoming call delivered by the real source event path without accepting it', async () => {
  const source = sampleSource();
  let emit: Parameters<Source['onLive']>[0] | undefined;
  const listen = source.onLive;
  source.onLive = handler => { emit = handler; return listen(handler); };
  const signal = vi.spyOn(source, 'callSignal');
  const peer = (await source.peers())[0].node_id;
  await mount(source);
  await vi.waitFor(() => expect(emit).toBeDefined());
  expect(visibleBackDestination()?.route).toBe('thread');
  emit!({ type: 'message', room_id: null, message: {
    id: 'ios-incoming-offer', kind: 400, sender: peer, recipient: SAMPLE_OWN_ID,
    timestamp: Date.now(), payment_amount_msat: 10_000,
    plaintext: JSON.stringify({ v: 1, call_id: '0123456789abcdef0123456789abcdef', media: 'audio', sdp: 'v=0 offer' }),
  } });
  await vi.waitFor(() => expect(document.querySelector('[data-call-panel="incoming"]')).not.toBeNull());
  expect(document.querySelector('.cc')?.getAttribute('data-swipe-call')).toBe('true');
  expect(visibleBackDestination()).toBeNull();
  expect(signal).not.toHaveBeenCalled();
});

it('keeps phone tabs and the status header usable during an active call but still blocks edge Back', async () => {
  const source = sampleSource();
  let emit: Parameters<Source['onLive']>[0] | undefined;
  const listen = source.onLive;
  source.onLive = handler => { emit = handler; return listen(handler); };
  const peer = (await source.peers())[0].node_id;
  await mount(source);
  await vi.waitFor(() => expect(emit).toBeDefined());
  emit!({ type: 'message', room_id: null, message: {
    id: 'ios-incoming-offer-tabs', kind: 400, sender: peer, recipient: SAMPLE_OWN_ID,
    timestamp: Date.now(), payment_amount_msat: 10_000,
    plaintext: JSON.stringify({ v: 1, call_id: '0123456789abcdef0123456789abcdef', media: 'audio', sdp: 'v=0 offer' }),
  } });
  await vi.waitFor(() => expect(document.querySelector('.cc')?.getAttribute('data-swipe-call')).toBe('true'));
  expect(visibleBackDestination()).toBeNull();
  expect(document.querySelector('[data-phone-tabs]')?.hasAttribute('inert')).toBe(false);
  expect(document.querySelector('[data-phone-status]')?.hasAttribute('inert')).toBe(false);
  document.querySelector<HTMLButtonElement>('[data-phone-tab="wallet"]')!.click();
  await vi.waitFor(() => expect(document.querySelector('[data-wallet-page]')).not.toBeNull());
});

it.each(['data-swipe-money', 'data-approval'])('still blocks phone tabs mid-call when %s is visible', async (attribute) => {
  const source = sampleSource();
  let emit: Parameters<Source['onLive']>[0] | undefined;
  const listen = source.onLive;
  source.onLive = handler => { emit = handler; return listen(handler); };
  const peer = (await source.peers())[0].node_id;
  await mount(source);
  await vi.waitFor(() => expect(emit).toBeDefined());
  emit!({ type: 'message', room_id: null, message: {
    id: 'ios-incoming-offer-blocked', kind: 400, sender: peer, recipient: SAMPLE_OWN_ID,
    timestamp: Date.now(), payment_amount_msat: 10_000,
    plaintext: JSON.stringify({ v: 1, call_id: 'fedcba9876543210fedcba9876543210', media: 'audio', sdp: 'v=0 offer' }),
  } });
  await vi.waitFor(() => expect(document.querySelector('.cc')?.getAttribute('data-swipe-call')).toBe('true'));
  const sheet = document.createElement('div');
  sheet.setAttribute(attribute, attribute === 'data-approval' ? 'pending' : 'true');
  document.body.append(sheet);
  await vi.waitFor(() => expect(document.querySelector('[data-phone-tabs]')?.hasAttribute('inert')).toBe(true));
  document.querySelector<HTMLButtonElement>('[data-phone-tab="you"]')!.click();
  expect(document.querySelector('[data-phone-you]')).toBeNull();
});

it('lifts the call panel above the phone tab bar on iOS', () => {
  document.documentElement.dataset.platform = 'ios';
  document.documentElement.style.setProperty('--s-1', '4px');
  document.documentElement.style.setProperty('--s-6', '24px');
  document.body.innerHTML = '<main class="cc" data-phone-shell="true"></main><aside class="call-panel" data-call-panel="incoming"></aside>';
  const root = getComputedStyle(document.documentElement);
  const panel = getComputedStyle(document.querySelector('.call-panel')!);
  const tabBar = root.getPropertyValue('--phone-tab-bar-h').trim();
  expect(tabBar).toBe('calc(4px + 44px + max(4px, 34px))');
  expect(panel.bottom).toContain('max(24px, 34px)');
  expect(panel.bottom).toContain(tabBar);
});

it('blocks Back for a pending spending approval loaded from the node on startup', async () => {
  const source = sampleSource();
  source.spendStatus = async () => ({ state: 'pending', basis: null, open_until_ms: null, window_ms: 600_000,
    pending: { op_id: 'ab01', expires_at_ms: Date.now() + 600_000, owner_action: 'konsensus grant --op ab01', owner_can_grant: true } });
  const budget = source.budgetStatus;
  source.budgetStatus = async () => ({ ...await budget(), waiting_for_owner: true });
  const approve = vi.spyOn(source, 'budgetApprove');
  await mount(source);
  await vi.waitFor(() => expect(document.querySelector('[data-approval="pending"]')).not.toBeNull());
  expect(visibleBackDestination()).toBeNull();
  expect(approve).not.toHaveBeenCalled();
});
