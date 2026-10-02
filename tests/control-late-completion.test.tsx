import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';

let dispose: (() => void) | undefined;
let mount: HTMLElement;
afterEach(() => { dispose?.(); mount?.remove(); });
const select = <T extends HTMLElement = HTMLElement>(s: string) => mount.querySelector<T>(s)!;

it.each(['same', 'other', 'return'])('preserves a newer draft after late success (%s track)', async (track) => {
  const source = sampleSource({ firstLiveMs: 1e9 });
  source.priceQuote = async () => ({ kind: 0, own_msat: 1000, peer_msat: 2000, peer_age_secs: 0, peer_stale: false, max_routing_fee_msat: 5000 });
  source.spendStatus = async () => ({ state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 600000, pending: null, window_ms: 600000 });
  let finish!: () => void;
  source.send = vi.fn(async (recipient, isRoom) => {
    await new Promise<void>(resolve => { finish = resolve; });
    return { message_id: 'late-a', recipient, is_room: isRoom, delivered: true, amount_msat: 2000, sent_at_ms: Date.now() };
  });
  mount = document.createElement('div');
  document.body.appendChild(mount);
  dispose = render(() => <ControlCenter source={source} active={true} ready={true} error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
  await vi.waitFor(() => expect(select(`[data-track="peer:${'a'.repeat(64)}"]`).getAttribute('aria-current')).toBe('true'));
  const type = (text: string) => {
    const area = select<HTMLTextAreaElement>('[data-composer] textarea');
    area.value = text;
    area.dispatchEvent(new Event('input', { bubbles: true }));
  };
  type('send this to A');
  await vi.waitFor(() => expect(select<HTMLButtonElement>('[data-send]').disabled).toBe(false));
  select<HTMLButtonElement>('[data-send]').click();
  await vi.waitFor(() => expect(source.send).toHaveBeenCalledTimes(1));
  if (track !== 'same') select<HTMLButtonElement>(`[data-track="peer:${'b'.repeat(64)}"]`).click();
  if (track === 'return') select<HTMLButtonElement>(`[data-track="peer:${'a'.repeat(64)}"]`).click();
  type('B draft which has never been submitted');
  expect(select<HTMLTextAreaElement>('[data-composer] textarea').value).toBe('B draft which has never been submitted');
  finish();
  await vi.waitFor(() => expect(select<HTMLButtonElement>('[data-send]').disabled).toBe(false));
  expect(select<HTMLTextAreaElement>('[data-composer] textarea').value).toBe('B draft which has never been submitted');
  expect(source.send).toHaveBeenCalledTimes(1);
  expect(vi.mocked(source.send).mock.calls[0][0]).toBe('a'.repeat(64));

});

it.each(['same', 'other', 'return'])('keeps a replacement file after late success (%s track)', async (track) => {
  const source = sampleSource({ firstLiveMs: 1e9 });
  source.priceQuote = async () => ({ kind: 0, own_msat: 1000, peer_msat: 2000, peer_age_secs: 0, peer_stale: false, max_routing_fee_msat: 5000 });
  source.spendStatus = async () => ({ state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 600000, pending: null, window_ms: 600000 });
  let finish!: () => void;
  source.fileSend = vi.fn(async (recipient, filename) => {
    await new Promise<void>(resolve => { finish = resolve; });
    return { message_id: 'late-file', recipient, filename, size_bytes: 3, delivered: true, amount_msat: 3000, sent_at_ms: Date.now() };
  });
  mount = document.createElement('div');
  document.body.appendChild(mount);
  dispose = render(() => <ControlCenter source={source} active={true} ready={true} error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
  await vi.waitFor(() => expect(select(`[data-track="peer:${'a'.repeat(64)}"]`).getAttribute('aria-current')).toBe('true'));
  const choose = (name: string) => {
    const input = select<HTMLInputElement>('[data-file-input]');
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['abc'], name, { type: 'text/plain' })] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  select<HTMLButtonElement>('[data-composer-mode="file"]').click();
  choose('first.txt');
  await vi.waitFor(() => expect(select<HTMLButtonElement>('[data-send]').disabled).toBe(false));
  select<HTMLButtonElement>('[data-send]').click();
  await vi.waitFor(() => expect(source.fileSend).toHaveBeenCalledTimes(1));
  if (track !== 'same') select<HTMLButtonElement>(`[data-track="peer:${'b'.repeat(64)}"]`).click();
  if (track === 'return') select<HTMLButtonElement>(`[data-track="peer:${'a'.repeat(64)}"]`).click();
  if (track !== 'same') select<HTMLButtonElement>('[data-composer-mode="file"]').click();
  choose('replacement.txt');
  finish();
  await vi.waitFor(() => expect(select<HTMLButtonElement>('[data-send]').disabled).toBe(false));
  select<HTMLButtonElement>('[data-send]').click();
  await vi.waitFor(() => expect(source.fileSend).toHaveBeenCalledTimes(2));
  const calls = vi.mocked(source.fileSend).mock.calls;
  expect(calls[0].slice(0, 2)).toEqual(['a'.repeat(64), 'first.txt']);
  expect(calls[1].slice(0, 2)).toEqual([(track === 'other' ? 'b' : 'a').repeat(64), 'replacement.txt']);
  finish();
});
