// A chat's empty state says only what is known: nothing while its history is
// read, only the error when the read fails, and "no messages" once a read came
// back empty (with the contact's status only when we have a budget line).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID, SAMPLE_PRESETS } from '../src/control/sample';
import { setLanguagePref } from '../src/i18n';
import type { BudgetView } from '../src/control/types';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
let dispose: (() => void) | undefined;
let mount: HTMLElement;
afterEach(() => { dispose?.(); mount?.remove(); vi.restoreAllMocks(); setLanguagePref('en'); });
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
    source.messages = vi.fn(async () => { throw { code: 'node', message: 'Your box did not answer.' }; });
    await open(source);
    await vi.waitFor(() => expect(mount.textContent).toContain('Your box did not answer.'));
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
      return new Promise<never>((_r, reject) => { fail = () => reject({ code: 'node', message: 'Your box did not answer.' }); });
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
    await vi.waitFor(() => expect(mount.textContent).toContain('Your box did not answer.'));
    expect($('[data-thread-empty]')).toBeNull();
    expect($('[data-thread-loading]')).toBeNull();
    expect(mount.textContent).not.toMatch(/No messages here yet/);
  });

  describe('overlapping reads of one chat: only the newest read decides what is said', () => {
    type D = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
    async function overlapping() {
      const source = sampleSource({ firstLiveMs: 1e9 });
      const reads: D[] = [];
      source.messages = vi.fn((peer: string) => (peer.toLowerCase() !== A
        ? Promise.resolve([])
        : new Promise((resolve, reject) => { reads.push({ resolve, reject }); }))) as never;
      await open(source);
      await vi.waitFor(() => expect(reads.length).toBeGreaterThanOrEqual(1));
      const before = reads.length;
      // Reopen while the first read is still out: a newer read starts.
      $(`[data-track="peer:${B}"]`)!.click();
      await vi.waitFor(() => expect($(`[data-track="peer:${B}"]`)?.getAttribute('aria-current')).toBe('true'));
      $(`[data-track="peer:${A}"]`)!.click();
      await vi.waitFor(() => expect(reads.length).toBeGreaterThan(before));
      return { newest: reads[reads.length - 1], older: reads.slice(0, -1) };
    }

    it('newer read succeeds empty, then an older read fails: no stale error beside "no messages"', async () => {
      const { newest, older } = await overlapping();
      newest.resolve([]);
      await vi.waitFor(() => expect($('[data-thread-empty]')).not.toBeNull());
      for (const r of older) r.reject({ code: 'node', message: 'Old read failed.' });
      await new Promise((r) => setTimeout(r, 20));
      expect(mount.textContent).not.toContain('Old read failed.');
      expect($('[data-thread-empty]')).not.toBeNull();
    });

    it('newer read fails, then an older read succeeds: the error stays and nothing says "no messages"', async () => {
      const { newest, older } = await overlapping();
      newest.reject({ code: 'node', message: 'Your box did not answer.' });
      await vi.waitFor(() => expect(mount.textContent).toContain('Your box did not answer.'));
      for (const r of older) r.resolve([]);
      await new Promise((r) => setTimeout(r, 20));
      expect(mount.textContent).toContain('Your box did not answer.');
      expect($('[data-thread-empty]')).toBeNull();
    });
  });
});

it('reactively localizes the empty chat heading and its payment explanation', async () => {
  const source = sampleSource({ firstLiveMs: 1e9 });
  source.messages = vi.fn(async () => []);
  source.budgetStatus = vi.fn(async () => budget([{ target: A, room: false, limit_msat: 50_000, spent_msat: 2_000 }]));
  await open(source);
  await vi.waitFor(() => expect($('[data-thread-empty]')?.getAttribute('data-thread-empty')).toBe('known'));
  setLanguagePref('da');
  expect($('[data-thread-empty] h2')?.textContent).toBe('Ingen beskeder her endnu');
  expect($('[data-thread-empty] .hint')?.textContent).toMatch(/^Hver besked til .+ betaler deres pris\.$/);
  setLanguagePref('en');
  expect($('[data-thread-empty] h2')?.textContent).toBe('No messages here yet');
});

import { RoomThread, type RoomSend } from '../src/control/RoomPanel';
it('localizes the room empty state, notices, composer and payment outcomes in Danish', () => {
  const [sends, setSends] = createSignal<RoomSend[]>([]);
  setLanguagePref('da');
  mount = document.createElement('div'); document.body.append(mount);
  dispose = render(() => <RoomThread read="ok" room={{ id: 'room', roster: [SAMPLE_OWN_ID, A], salt: '00', at: 0 }}
    ownId={SAMPLE_OWN_ID} nameOf={() => 'Ada'} messages={[]} deliveries={{}} earlier loadingEarlier={false}
    onEarlier={() => {}} sends={sends()} fresh={{}} seenEntrances={new Set()} info={() => undefined}
    quote={async () => null} moneyBlocked canSpend={false} now={0} send={async () => []}
    onLeave={() => {}} onContext={() => {}} />, mount);
  expect($('[data-thread-empty] h2')?.textContent).toBe('Ingen beskeder her endnu');
  expect($('[data-thread-empty] .hint')?.textContent).toBe('En besked her betaler hvert medlem deres egen pris.');
  expect($('[data-room-honesty]')?.textContent).toContain('krypteres fra din boks til hvert medlems boks');
  expect($('[data-room-honesty]')?.textContent).toContain('Begge bokse kan læse den');
  expect($('[data-room-earlier]')?.textContent).toBe('Vis tidligere beskeder');
  expect($('[data-room-blocked]')?.textContent).toBe('Betalinger er ikke klar endnu, så der kan ikke sendes fra dette rum.');
  expect($('[data-room-draft]')?.getAttribute('placeholder')).toBe('Besked til Ada');
  $('[data-room-leave]')!.click();
  expect($('[data-room-leave-confirm]')?.textContent).toContain('Vil du forlade dette rum?');
  expect($('[data-room-leave-no]')?.textContent).toBe('Bliv');
  expect($('[data-room-cost-leg]')?.textContent).toContain('Ikke i dine kontakter. Ikke opkrævet.');
  setSends([{ at: 0, text: 'hello', outcomes: [{ peer: A, state: 'refused', paidMsat: 1000, note: null }] }]);
  expect($('[data-room-send]')?.textContent).toContain('Din rumbesked · op til 1 sat i alt');
  expect($('[data-room-leg] strong')?.textContent).toBe('Til Ada:');
  expect($('[data-room-leg-note]')?.textContent).toContain('betalt, afvist af deres boks; send den ikke igen · du betalte op til 1 sat');
  setSends([]);
  setLanguagePref('en');
  expect($('[data-thread-empty] h2')?.textContent).toBe('No messages here yet');
});
