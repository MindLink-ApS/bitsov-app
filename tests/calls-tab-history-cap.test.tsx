import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';
import type { LiveEvent, Message } from '../src/control/types';

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const tick = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };

function pageMessages(peer: string, page: number, size = 10): Message[] {
  const base = 100_000 - page * size;
  return Array.from({ length: size }, (_, i) => ({
    id: `m-${peer}-${page}-${i}`,
    sender: peer,
    recipient: SAMPLE_OWN_ID,
    kind: 0,
    plaintext: 'hi',
    timestamp: base - i,
    payment_amount_msat: 1000,
  }));
}

async function mountMessages(read: (peer: string, before?: number) => Promise<Message[]>, onLive?: (handler: (event: LiveEvent) => void) => void) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone');
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  const source = sampleSource();
  source.messages = vi.fn(read);
  if (onLive) source.onLive = async handler => { onLive(handler); return () => {}; };
  dispose = render(() => <ControlCenter source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={null} />, document.body);
  await tick();
  return source;
}

it('reads at most three history pages per peer when no call is found', async () => {
  const peers = (await sampleSource().peers()).map(p => p.node_id);
  const pages = new Map<string, number>();
  const source = await mountMessages(async (id) => {
    const page = pages.get(id) ?? 0;
    pages.set(id, page + 1);
    return pageMessages(id, page);
  });
  await vi.waitFor(() => peers.every(peer => vi.mocked(source.messages).mock.calls.filter(([id]) => id === peer).length >= 3));
  for (const peer of peers) {
    expect(vi.mocked(source.messages).mock.calls.filter(([id]) => id === peer).length).toBe(3);
  }
  expect(document.querySelector('[data-phone-tab="calls"]')).toBeNull();
});

it('still finds a call on the first page and shows the Calls tab', async () => {
  const peer = (await sampleSource().peers())[0].node_id;
  const source = await mountMessages(async (id, before) => {
    if (id !== peer || before !== undefined) return [];
    return [{ id: 'call', sender: peer, recipient: SAMPLE_OWN_ID, kind: 400, plaintext: '{}', timestamp: 50_000, payment_amount_msat: 1000 }];
  });
  await vi.waitFor(() => expect(document.querySelector('[data-phone-tab="calls"]')).not.toBeNull());
  expect(vi.mocked(source.messages).mock.calls.filter(([id]) => id === peer).length).toBe(1);
});

it('still finds a call on the third history page and shows the Calls tab', async () => {
  const peer = (await sampleSource().peers())[0].node_id;
  const pages = new Map<string, number>();
  const source = await mountMessages(async (id, before) => {
    if (id !== peer) return [];
    const page = pages.get(id) ?? 0;
    pages.set(id, page + 1);
    if (page < 2) return pageMessages(id, page);
    return [{ id: 'deep-call', sender: peer, recipient: SAMPLE_OWN_ID, kind: 400, plaintext: '{}', timestamp: 1, payment_amount_msat: 1000 }];
  });
  await vi.waitFor(() => expect(document.querySelector('[data-phone-tab="calls"]')).not.toBeNull());
  expect(vi.mocked(source.messages).mock.calls.filter(([id]) => id === peer).length).toBe(3);
});

it('resumes a capped scan after reconnect and finds a call on the fourth page', async () => {
  const peers = (await sampleSource().peers()).map(p => p.node_id);
  const peer = peers[0];
  // The node pages 50 messages. Three pages are the cap; the call sits under them.
  const size = 50;
  const pages = [0, 1, 2].map(page => pageMessages(peer, page, size));
  const oldest = (page: Message[]) => Math.min(...page.map(message => message.timestamp));
  const call: Message = { id: 'page-4-call', sender: peer, recipient: SAMPLE_OWN_ID, kind: 400, plaintext: '{}', timestamp: 1, payment_amount_msat: 1000 };
  let emit: (event: LiveEvent) => void = () => {};
  const source = await mountMessages(async (id, before) => {
    if (id !== peer) return [];
    if (before === undefined) return pages[0];
    if (before === oldest(pages[0])) return pages[1];
    if (before === oldest(pages[1])) return pages[2];
    if (before === oldest(pages[2])) return [call];
    return [];
  }, handler => { emit = handler; });
  await vi.waitFor(() => {
    const calls = vi.mocked(source.messages).mock.calls;
    expect(calls.filter(([id]) => id === peer).map(([, before]) => before)).toEqual([undefined, oldest(pages[0]), oldest(pages[1])]);
    expect(calls.some(([id]) => id === peers[1])).toBe(true);
  });
  await tick();
  expect(document.querySelector('[data-phone-tab="calls"]')).toBeNull();
  emit({ type: 'link', state: 'closed', detail: null });
  emit({ type: 'link', state: 'open', detail: null });
  await vi.waitFor(() => expect(document.querySelector('[data-phone-tab="calls"]')).not.toBeNull());
  expect(vi.mocked(source.messages).mock.calls.filter(([id]) => id === peer).map(([, before]) => before)).toEqual([
    undefined, oldest(pages[0]), oldest(pages[1]), oldest(pages[2]),
  ]);
});
