// A chat's empty state says only what is known: nothing while its history is
// read, only the error when the read fails, and "no messages" once a read came
// back empty (with the contact's status only when we have a budget line).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID, SAMPLE_PRESETS } from '../src/control/sample';
import type { BudgetView } from '../src/control/types';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
let dispose: (() => void) | undefined;
let mount: HTMLElement;
afterEach(() => { dispose?.(); mount?.remove(); vi.restoreAllMocks(); });
const $ = (s: string) => mount.querySelector<HTMLElement>(s);
const budget = (rows: BudgetView['rows']): BudgetView => ({
  paused: false, waiting_for_owner: false, preset: 'careful',
  autopay: { state: 'open', open_until_ms: Date.now() + 600_000, ceiling_msat: 500_000, basis: 'node_grant' },
  ceiling_msat: 500_000, spent_msat: 0, unsettled_msat: 0, rows,
  presets: SAMPLE_PRESETS, window_ms: 86_400_000, max_daily_msat: 100_000_000, node_grant: null,
});
async function open(source: ReturnType<typeof sampleSource>) {
  mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <ControlCenter source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
  await vi.waitFor(() => expect($(`[data-track="peer:${A}"]`)?.getAttribute('aria-current')).toBe('true'));
}

describe('an empty chat says only what is known', () => {
  it('while its history is being read: no "no messages", no contact claim', async () => {
    const source = sampleSource({ firstLiveMs: 1e9 });
    source.messages = vi.fn(() => new Promise<never>(() => {}));
    await open(source);
    await vi.waitFor(() => expect($('[data-thread-loading]')).not.toBeNull());
    expect($('[data-thread-empty]')).toBeNull();
    expect(mount.textContent).not.toMatch(/No messages here yet|Nothing here yet|first contact/);
  });

  it('a failed read shows only its error, never "no messages"', async () => {
    const source = sampleSource({ firstLiveMs: 1e9 });
    source.messages = vi.fn(async () => { throw { code: 'node', message: 'Your node did not answer.' }; });
    await open(source);
    await vi.waitFor(() => expect(mount.textContent).toContain('Your node did not answer.'));
    expect($('[data-thread-empty]')).toBeNull();
    expect($('[data-thread-loading]')).toBeNull();
    expect(mount.textContent).not.toMatch(/No messages here yet|Nothing here yet/);
  });

  it('read and empty, no budget line (status not known here): neutral, no first-contact claim', async () => {
    const source = sampleSource({ firstLiveMs: 1e9 });
    source.messages = vi.fn(async () => []);
    source.budgetStatus = vi.fn(async () => budget([]));
    await open(source);
    await vi.waitFor(() => expect($('[data-thread-empty]')?.getAttribute('data-thread-empty')).toBe('unknown'));
    expect($('[data-thread-empty]')!.textContent).toBe('No messages here yet');
    expect($('[data-thread-empty]')!.textContent).not.toMatch(/first contact/);
  });

  it('read and empty, with a budget line (we paid them before): says each message pays their price', async () => {
    const source = sampleSource({ firstLiveMs: 1e9 });
    source.messages = vi.fn(async () => []);
    source.budgetStatus = vi.fn(async () => budget([{ target: A, room: false, limit_msat: 50_000, spent_msat: 2_000 }]));
    await open(source);
    await vi.waitFor(() => expect($('[data-thread-empty]')?.getAttribute('data-thread-empty')).toBe('known'));
    expect($('[data-thread-empty]')!.textContent).toMatch(/^No messages here yetEach message to .+ pays their price\.$/);
    expect($('[data-thread-empty]')!.textContent).not.toMatch(/first contact/);
  });

  it('re-read: an empty success, then reopening shows loading (not "no messages"), and a failed re-read shows only its error', async () => {
    const source = sampleSource({ firstLiveMs: 1e9 });
    let reopened = false;
    let fail!: () => void;
    source.messages = vi.fn((peer: string) => {
      if (peer.toLowerCase() !== A || !reopened) return Promise.resolve([]);
      return new Promise<never>((_r, reject) => { fail = () => reject({ code: 'node', message: 'Your node did not answer.' }); });
    }) as never;
    await open(source);
    await vi.waitFor(() => expect($('[data-thread-empty]')).not.toBeNull());
    // Reopen: away and back; this read is still out.
    reopened = true;
    $(`[data-track="peer:${B}"]`)!.click();
    await vi.waitFor(() => expect($(`[data-track="peer:${B}"]`)?.getAttribute('aria-current')).toBe('true'));
    $(`[data-track="peer:${A}"]`)!.click();
    await vi.waitFor(() => expect($('[data-thread-loading]')).not.toBeNull());
    expect($('[data-thread-empty]')).toBeNull();
    expect(mount.textContent).not.toMatch(/No messages here yet/);
    await vi.waitFor(() => expect(fail).toBeDefined());
    fail();
    await vi.waitFor(() => expect(mount.textContent).toContain('Your node did not answer.'));
    expect($('[data-thread-empty]')).toBeNull();
    expect($('[data-thread-loading]')).toBeNull();
    expect(mount.textContent).not.toMatch(/No messages here yet/);
  });
});
