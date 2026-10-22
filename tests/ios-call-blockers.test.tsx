import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';
import type { Source } from '../src/control/source';
import { visibleBackDestination } from '../src/ios/edgeBack';

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function mount(source: Source) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone');
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  dispose = render(() => <ControlCenter source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={null} />, document.body);
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
