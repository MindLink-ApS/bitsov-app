import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';
import type { SpendView } from '../src/control/types';

let dispose: (() => void) | undefined;
let mount: HTMLElement;
afterEach(() => { dispose?.(); mount?.remove(); });
const select = <T extends HTMLElement = HTMLElement>(selector: string) => mount.querySelector<T>(selector)!;
function start(source: ReturnType<typeof sampleSource>) {
  mount = document.createElement('div');
  document.body.appendChild(mount);
  dispose = render(() => <ControlCenter source={source} active={true} ready={true} error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
}

it('clears the selected file when switching recipients', async () => {
  const source = sampleSource({ firstLiveMs: 1e9 });
  source.spendStatus = async () => ({ state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 600000, pending: null, window_ms: 600000 });
  source.fileSend = vi.fn(async (recipient, filename) => ({ message_id: 'probe-file', recipient, filename, size_bytes: 6, delivered: true, amount_msat: 3000, sent_at_ms: Date.now() }));
  start(source);
  await vi.waitFor(() => expect(select(`[data-track="peer:${'a'.repeat(64)}"]`).getAttribute('aria-current')).toBe('true'));
  select<HTMLButtonElement>('[data-composer-mode="file"]').click();
  const oldInput = select<HTMLInputElement>('[data-file-input]');
  Object.defineProperty(oldInput, 'files', { value: [new File(['secret'], 'A-private.txt', { type: 'text/plain' })] });
  oldInput.dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(select<HTMLButtonElement>('[data-send]').disabled).toBe(false));
  select<HTMLButtonElement>(`[data-track="peer:${'b'.repeat(64)}"]`).click();
  select<HTMLButtonElement>('[data-composer-mode="file"]').click();
  const newInput = select<HTMLInputElement>('[data-file-input]');
  // The file input now persists across recipients; its selection must not.
  expect(newInput.value).toBe('');
  expect(select('[data-file-chip]').textContent).not.toContain('A-private.txt');
  expect(select<HTMLButtonElement>('[data-send]').disabled).toBe(true);
  select<HTMLButtonElement>('[data-send]').click();
  expect(source.fileSend).not.toHaveBeenCalled();
});

it('shows the node owner command while New-track approval is pending', async () => {
  const source = sampleSource({ firstLiveMs: 1e9 });
  let spend: SpendView = { state: 'locked', basis: null, open_until_ms: null, pending: null, window_ms: 600000 };
  source.peers = async () => [];
  source.rooms = async () => [];
  source.spendStatus = async () => spend;
  source.spendRequest = async () => (spend = { ...spend, state: 'pending', pending: { op_id: 'probe', expires_at_ms: Date.now() + 600000, owner_action: 'konsensus grant --op probe', owner_can_grant: true } });
  start(source);
  select<HTMLButtonElement>('[data-track="new"]').click();
  select<HTMLButtonElement>('[data-invite-create] button').click();
  await vi.waitFor(() => expect(select<HTMLButtonElement>('[data-invite-create] button').textContent).toBe('Waiting for approval'));
  expect(select<HTMLButtonElement>('[data-invite-create] button').disabled).toBe(true);
  expect(select<HTMLButtonElement>('[data-invite-redeem] button').disabled).toBe(true);
  expect(mount.textContent).toContain('konsensus grant --op probe');
  expect(mount.querySelector('[data-owner-action]')).not.toBeNull();
});
