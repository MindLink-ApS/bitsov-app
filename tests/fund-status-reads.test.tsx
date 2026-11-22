import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import { languagePref, setLanguagePref } from '../src/i18n';

// The deposit panel polls the funding status every 3 s. On a slow node those
// reads must not pile up, a late reply must not write after the panel is gone,
// and an older reply must never overwrite a newer one.

const OWN = '1'.repeat(64);
const ADDRESS = 'bcrt1qdepositstatus000000000000000000000000000';

type Fund = {
  current_step: string; tier: string; funding_address: string | null;
  funding_amount_sats_required: number; funding_amount_sats_received: number;
  funding_evidence: string | null; funded: boolean;
};
const fundState = (over: Partial<Fund> = {}): Fund => ({
  current_step: 'awaiting_funding', tier: 'full', funding_address: ADDRESS,
  funding_amount_sats_required: 1000, funding_amount_sats_received: 0, funding_evidence: null, funded: false,
  ...over,
});

type Deferred = { resolve: (value: unknown) => void; reject: (error: unknown) => void };

/**
 * Until `manual` is set, fund_state answers "not started" at once so the app can
 * settle; after that every read gets its own deferred reply, settled by the test.
 */
function stubHost(opts: { started?: unknown; holdStart?: boolean; holdFallback?: boolean } = {}) {
  const reads: Deferred[] = [];
  const fallbacks: Deferred[] = [];
  const starts: Deferred[] = [];
  const counts = { fundState: 0, fundingAddress: 0, fundStart: 0, nodeStatus: 0 };
  // `ready` is the node status the app polls. A test can drop it while a deposit start is in flight.
  const connection = { ready: true };
  const host = { reads, fallbacks, starts, counts, manual: false, connection };
  const replies: Record<string, () => unknown> = {
    node_status: () => {
      counts.nodeStatus++;
      return { ready: connection.ready, node_id: OWN, error: null };
    },
    trust_acknowledge: () => true,
    pairing_status: () => ({
      state: 'paired', scopes: ['read', 'receive'], short_code: null,
      code_from_node: true, reason: null, remote: false, bootstrap: null,
    }),
    node_overview: () => ({
      money_ready: true, node_id: OWN, status: 'ok', version: 'api v2', connected_peers: 0, e2ee_sessions: 0,
      pending_deliveries: 0, lightning_available: true, block_height: 1, uptime_secs: 1,
      lightning_backend: 'mock', chain_backend: 'mock', read_at: Date.now(),
    }),
    peers_list: () => [],
    rooms_list: () => [],
    payments_overview: () => ({ balance_msat: 0, lightning_outbound_msat: 0, channels: [] }),
    spend_status: () => ({ state: 'locked', basis: null, open_until_ms: null, pending: null, window_ms: 600_000 }),
    'plugin:event|listen': () => 1,
    'plugin:event|unlisten': () => null,
  };
  vi.stubGlobal('__TAURI_INTERNALS__', {
    transformCallback: () => 1,
    invoke: (cmd: string) => {
      if (cmd === 'fund_state') {
        counts.fundState++;
        if (!host.manual) return Promise.resolve(null);
        return new Promise((resolve, reject) => { reads.push({ resolve, reject }); });
      }
      if (cmd === 'funding_address') {
        counts.fundingAddress++;
        if (opts.holdFallback) return new Promise((resolve, reject) => { fallbacks.push({ resolve, reject }); });
        return Promise.resolve({ address: 'bcrt1qfallbackaddress' });
      }
      if (cmd === 'fund_start') {
        counts.fundStart++;
        if (opts.holdStart) return new Promise((resolve, reject) => { starts.push({ resolve, reject }); });
        return Promise.resolve(opts.started ?? fundState());
      }
      const reply = replies[cmd];
      return reply ? Promise.resolve(reply()) : Promise.reject(new Error(`unexpected ${cmd}`));
    },
  });
  vi.stubGlobal('__TAURI_EVENT_PLUGIN_INTERNALS__', { unregisterListener: () => {} });
  return host;
}

let dispose: (() => void) | undefined;
let mount: HTMLElement;
const startLanguage = languagePref();
afterEach(() => {
  dispose?.(); dispose = undefined;
  setLanguagePref(startLanguage);
  mount?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const panel = () => mount.querySelector('[data-panel="receive"]');
const flush = () => vi.advanceTimersByTimeAsync(0);

/** Open the wallet on the deposit form; later status reads are held by the test. */
async function openWallet(host: ReturnType<typeof stubHost>) {
  mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <App />, mount);
  await vi.waitFor(() => expect([...mount.querySelectorAll('button')].some((b) => b.textContent?.includes('I understand'))).toBe(true));
  [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
  await vi.waitFor(() => expect(mount.querySelector('[data-first-run]')).toBeNull());
  await vi.waitFor(() => expect(mount.querySelector('[data-tab="wallet"]')).not.toBeNull());
  mount.querySelector<HTMLButtonElement>('[data-tab="wallet"]')!.click();
  await vi.waitFor(() => expect(panel()?.querySelector('[data-fund-start]')).not.toBeNull());
  await flush();
  host.manual = true;
}

/** The next 3 s tick issues one status read, held pending. */
async function tickPending(host: ReturnType<typeof stubHost>) {
  const before = host.counts.fundState;
  await vi.advanceTimersByTimeAsync(3000);
  expect(host.counts.fundState).toBe(before + 1);
  expect(host.reads).toHaveLength(1);
  return host.reads[0];
}

/** A tick's read is in flight when the owner starts a deposit. */
async function startWithTickPending(host: ReturnType<typeof stubHost>) {
  await openWallet(host);
  const stale = await tickPending(host);
  const before = host.counts.fundState;
  panel()!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  expect(host.counts.fundStart).toBe(1);
  expect(host.counts.fundState - before, 'the explicit refresh must not be dropped').toBe(1);
  return { stale, fresh: host.reads[1] };
}

it('keeps one status read in flight on a slow node', async () => {
  vi.useFakeTimers();
  const host = stubHost();
  await openWallet(host);
  const slow = await tickPending(host);
  const before = host.counts.fundState;
  await vi.advanceTimersByTimeAsync(3000 * 4);
  expect(host.counts.fundState - before, 'ticks while a read is in flight must be skipped').toBe(0);
  slow.resolve(fundState());
  await flush();
  expect(panel()?.querySelector('code.address')?.textContent).toBe(ADDRESS);
  await vi.advanceTimersByTimeAsync(3000);
  expect(host.counts.fundState - before, 'polling resumes once the read is answered').toBe(1);
});

it('writes nothing after the panel is gone', async () => {
  vi.useFakeTimers();
  const host = stubHost();
  const errors = vi.spyOn(console, 'error');
  await openWallet(host);
  const late = await tickPending(host);
  const before = host.counts.fundState;
  dispose!(); dispose = undefined;
  // Started, no address yet: a live panel would ask the payments endpoint.
  late.resolve(fundState({ funding_address: null }));
  await vi.advanceTimersByTimeAsync(6000);
  expect(host.counts.fundingAddress).toBe(0);
  expect(host.counts.fundState).toBe(before);
  expect(errors).not.toHaveBeenCalled();
});

it.each([
  ['newer success', 'older success'],
  ['newer success', 'older failure'],
  ['newer failure', 'older success'],
] as const)('an older reply cannot overwrite a newer one: %s, then %s', async (newer, older) => {
  vi.useFakeTimers();
  const host = stubHost();
  const { stale, fresh } = await startWithTickPending(host);
  if (newer === 'newer success') fresh.resolve(fundState({ funding_amount_sats_received: 600 }));
  else fresh.reject('newer read failed');
  await flush();
  if (older === 'older success') stale.resolve(fundState({ funding_amount_sats_received: 0, funding_address: 'bcrt1qstaleaddress' }));
  else stale.reject('older read failed');
  await flush();
  const text = panel()!.textContent ?? '';
  expect(text).not.toContain('older read failed');
  expect(panel()!.querySelector('code.address')?.textContent).toBe(ADDRESS);
  if (newer === 'newer success') {
    expect(text).toContain('600');
    expect(panel()!.querySelector('[data-soft-error]')).toBeNull();
  } else {
    expect(text).toContain('newer read failed');
  }
});

it('runs the refresh after a deposit start even with a status read in flight', async () => {
  vi.useFakeTimers();
  const host = stubHost();
  const { stale, fresh } = await startWithTickPending(host);
  fresh.resolve(fundState({ funded: true, funding_amount_sats_received: 1000, funding_evidence: 'txid:0' }));
  await flush();
  stale.resolve(fundState());
  await flush();
  expect(panel()!.textContent).toContain('Funding seen');
  expect(panel()!.querySelector('code.address')).toBeNull();
  const after = host.counts.fundState;
  await vi.advanceTimersByTimeAsync(3000 * 3);
  expect(host.counts.fundState - after, 'funded stops the polling').toBe(0);
});

const submitStart = () => panel()!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
const click = (selector: string) => mount.querySelector<HTMLButtonElement>(selector)!.click();
const shownAddress = () => panel()?.querySelector('code.address')?.textContent ?? null;

it.each(['resolves', 'rejects'] as const)('an older read that %s first cannot touch a newer read still pending', async (outcome) => {
  vi.useFakeTimers();
  const host = stubHost();
  const { stale, fresh } = await startWithTickPending(host);
  // The deposit start has written its state; only the explicit read B is still out.
  expect(shownAddress()).toBe(ADDRESS);
  if (outcome === 'resolves') stale.resolve(fundState({ funding_address: 'bcrt1qstaleaddress', funding_amount_sats_received: 7 }));
  else stale.reject('older read failed');
  await flush();
  expect(shownAddress(), 'the older reply must not write while the newer one is pending').toBe(ADDRESS);
  expect(panel()!.textContent).not.toContain('older read failed');
  expect(panel()!.querySelector('.progress strong')?.textContent).toBe('0 sats');
  const before = host.counts.fundState;
  await vi.advanceTimersByTimeAsync(3000);
  expect(host.counts.fundState - before, 'the older read finishing must not release the newer read in flight').toBe(0);
  fresh.resolve(fundState({ funding_amount_sats_received: 600 }));
  await flush();
  expect(panel()!.querySelector('.progress strong')?.textContent).toBe('600 sats');
  await vi.advanceTimersByTimeAsync(3000);
  expect(host.counts.fundState - before, 'the next poll reads once the newest read is answered').toBe(1);
});

it.each([
  ['resolves', 'a newer address'],
  ['rejects', 'a newer status error'],
] as const)('an older fallback address read that %s late cannot overwrite %s', async (outcome, _newer) => {
  vi.useFakeTimers();
  const host = stubHost({ holdStart: true, holdFallback: true });
  await openWallet(host);
  const older = await tickPending(host);
  submitStart();
  await flush();
  expect(host.starts).toHaveLength(1);
  // A: started, no address yet, so it asks the payments endpoint and waits there.
  older.resolve(fundState({ funding_address: null }));
  await flush();
  expect(host.fallbacks).toHaveLength(1);
  // The deposit start answers; its explicit read B is newer than A.
  host.starts[0].resolve(fundState({ funding_address: null }));
  await flush();
  expect(host.reads).toHaveLength(2);
  if (outcome === 'resolves') {
    host.reads[1].resolve(fundState({ funding_address: null, funding_amount_sats_received: 600 }));
    await flush();
    expect(host.fallbacks).toHaveLength(2);
    host.fallbacks[1].resolve({ address: 'bcrt1qfreshfallback' });
    await flush();
    expect(shownAddress()).toBe('bcrt1qfreshfallback');
    host.fallbacks[0].resolve({ address: 'bcrt1qstalefallback' });
    await flush();
    expect(shownAddress(), 'the older fallback must not replace the newer address').toBe('bcrt1qfreshfallback');
    expect(panel()!.querySelector('.progress strong')?.textContent).toBe('600 sats');
  } else {
    host.reads[1].reject('newer read failed');
    await flush();
    host.fallbacks[0].reject('older fallback failed');
    await flush();
    expect(panel()!.textContent).toContain('newer read failed');
    expect(shownAddress()).toBeNull();
  }
  expect(host.fallbacks).toHaveLength(outcome === 'resolves' ? 2 : 1);
  expect(mount.querySelector('[data-deposit-error]'), 'the older fallback must not post its error').toBeNull();
  expect(panel()!.textContent).not.toContain('older fallback failed');
});

it('switching away from the wallet tab disposes the panel; its late read writes nothing', async () => {
  vi.useFakeTimers();
  const host = stubHost();
  const errors = vi.spyOn(console, 'error');
  await openWallet(host);
  const old = await tickPending(host);
  click('[data-tab="general"]');
  await flush();
  expect(panel()).toBeNull();
  click('[data-tab="wallet"]');
  await flush();
  // A new panel mounted and issued its own first read.
  expect(panel()).not.toBeNull();
  expect(host.reads).toHaveLength(2);
  // Started, no address: a live old panel would now ask the payments endpoint.
  old.resolve(fundState({ funding_address: null, funding_amount_sats_received: 7 }));
  await flush();
  expect(host.counts.fundingAddress, 'the disposed panel must not issue its fallback read').toBe(0);
  expect(panel()!.querySelector('.progress')).toBeNull();
  host.reads[1].resolve(fundState({ funding_amount_sats_received: 600 }));
  await flush();
  expect(shownAddress()).toBe(ADDRESS);
  expect(panel()!.querySelector('.progress strong')?.textContent).toBe('600 sats');
  const before = host.counts.fundState;
  await vi.advanceTimersByTimeAsync(3000);
  expect(host.counts.fundState - before, 'only the new panel polls').toBe(1);
  expect(errors).not.toHaveBeenCalled();
});

it('closing settings only hides the wallet; reopening shows the same live panel', async () => {
  vi.useFakeTimers();
  const host = stubHost();
  await openWallet(host);
  const first = await tickPending(host);
  first.resolve(fundState({ funding_amount_sats_received: 200 }));
  await flush();
  const shown = panel();
  expect(shown?.querySelector('.progress strong')?.textContent).toBe('200 sats');
  click('[data-settings-close]');
  await flush();
  expect(mount.querySelector('[data-settings]')?.getAttribute('aria-hidden')).toBe('true');
  // Hidden, not gone: the panel keeps polling and may update.
  const before = host.counts.fundState;
  await vi.advanceTimersByTimeAsync(3000);
  expect(host.counts.fundState - before).toBe(1);
  host.reads[1].resolve(fundState({ funding_amount_sats_received: 400 }));
  await flush();
  click('[data-tab="wallet"]');
  await flush();
  expect(mount.querySelector('[data-settings]')?.getAttribute('aria-hidden')).toBe('false');
  expect(panel(), 'reopening keeps the same panel').toBe(shown);
  expect(panel()!.querySelector('.progress strong')?.textContent).toBe('400 sats');
  expect(shownAddress()).toBe(ADDRESS);
  const afterReopen = host.counts.fundState;
  await vi.advanceTimersByTimeAsync(3000);
  expect(host.counts.fundState - afterReopen, 'one panel, one poll').toBe(1);
});

it.each([
  ['en', 'about 600 sats', ' of about 1 000 sats seen', 'Your node observed about 1 000 sats'],
  ['da', 'ca. 600 sats', ' af ca. 1 000 sats registreret', 'Din node har registreret ca. 1 000 sats'],
] as const)('rounds received down and required up at fractional sats (%s)', async (lang, received, required, observed) => {
  vi.useFakeTimers();
  const host = stubHost();
  await openWallet(host);
  setLanguagePref(lang);
  (await tickPending(host)).resolve(fundState({ funding_amount_sats_received: 600.5, funding_amount_sats_required: 999.5 }));
  await flush();
  expect(panel()!.querySelector('.progress strong')?.textContent).toBe(received);
  expect(panel()!.querySelector('.progress .numbers')?.textContent).toBe(`${received}${required}`);
  // Funded: what was seen still rounds down, never up to a sat that is not there.
  await vi.advanceTimersByTimeAsync(3000);
  host.reads[1].resolve(fundState({ funded: true, funding_amount_sats_received: 1000.5, funding_evidence: 'txid:0' }));
  await flush();
  expect(panel()!.querySelector('.funded .hint')?.textContent).toContain(observed);
});

const START_FAILED = 'Could not get a deposit address. Check that your node is running, then try again.';

/** The app's own status poll (every 1.5 s), recorded so a test can run it without also firing the 3 s deposit poll. */
function watchStatusPoll() {
  const polls: Array<() => void> = [];
  const schedule = window.setInterval;
  const wrapped = (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    if (timeout === 1500 && typeof handler === 'function') {
      const run = handler as (...params: unknown[]) => void;
      polls.push(() => { run(...args); });
    }
    return schedule(handler, timeout, ...(args as []));
  };
  vi.spyOn(window, 'setInterval').mockImplementation(wrapped as typeof window.setInterval);
  return polls;
}

it('keeps a started deposit when the node is not ready and an older status read then says not started', async () => {
  vi.useFakeTimers();
  const polls = watchStatusPoll();
  const host = stubHost({ holdStart: true });
  await openWallet(host);
  const mounted = panel();
  const stale = await tickPending(host);
  const reads = host.counts.fundState;
  const statuses = host.counts.nodeStatus;
  submitStart();
  await flush();
  expect(host.starts).toHaveLength(1);
  host.connection.ready = false;
  expect(polls.length).toBeGreaterThan(0);
  polls[polls.length - 1]();
  await flush();
  expect(host.counts.nodeStatus).toBeGreaterThan(statuses);
  expect(panel(), 'the deposit panel stays mounted while the node is briefly not ready').toBe(mounted);
  host.starts[0].resolve(fundState());
  await flush();
  expect(host.counts.fundState, 'a not-ready refresh must not start another status read').toBe(reads);
  expect(shownAddress()).toBe(ADDRESS);
  // The read that was already in flight before the start still answers "not started".
  stale.resolve(null);
  await flush();
  expect(shownAddress(), 'that older read must not clear the deposit that just started').toBe(ADDRESS);
  expect(panel()!.querySelector('form')).toBeNull();
});

it('keeps a failed deposit start when an older status read then returns not started', async () => {
  vi.useFakeTimers();
  const host = stubHost({ holdStart: true });
  await openWallet(host);
  const stale = await tickPending(host);
  const raw = 'Error: POST /onboarding/start returned 502: {"error":"wallet"}';
  submitStart();
  await flush();
  expect(host.starts).toHaveLength(1);
  const reads = host.counts.fundState;
  host.starts[0].reject(raw);
  await flush();
  expect(host.counts.fundState, 'a failed start must not refresh the status').toBe(reads);
  expect(panel()!.querySelector('[data-soft-summary]')?.textContent).toBe(START_FAILED);
  expect(panel()!.querySelector('[data-soft-detail]')?.textContent).toContain(raw);
  stale.resolve(null);
  await flush();
  expect(panel()!.querySelector('[data-soft-summary]')?.textContent).toBe(START_FAILED);
  expect(panel()!.querySelector('[data-soft-detail]')?.textContent).toContain(raw);
  expect(shownAddress()).toBeNull();
  expect(panel()!.querySelector('[data-fund-start]')).not.toBeNull();
});

it('polls again once the status read that was in flight at the start has settled', async () => {
  vi.useFakeTimers();
  const polls = watchStatusPoll();
  const host = stubHost({ holdStart: true });
  await openWallet(host);
  const stale = await tickPending(host);
  const reads = host.counts.fundState;
  submitStart();
  await flush();
  expect(host.starts).toHaveLength(1);
  // The node drops out before the start returns, so the follow-up refresh does not run.
  host.connection.ready = false;
  const statuses = host.counts.nodeStatus;
  expect(polls.length).toBeGreaterThan(0);
  polls[polls.length - 1]();
  await flush();
  expect(host.counts.nodeStatus).toBeGreaterThan(statuses);
  host.starts[0].resolve(fundState());
  await flush();
  expect(host.counts.fundState).toBe(reads);
  expect(shownAddress()).toBe(ADDRESS);
  // The node is back, but that pre-start read is still out, so a tick must not start another.
  host.connection.ready = true;
  polls[polls.length - 1]();
  await flush();
  await vi.advanceTimersByTimeAsync(3000);
  expect(host.counts.fundState).toBe(reads);
  stale.resolve(null);
  await flush();
  expect(shownAddress(), 'the pre-start read must not clear the deposit').toBe(ADDRESS);
  // That run has finished, which frees the in-flight slot. The next tick reads afresh.
  await vi.advanceTimersByTimeAsync(3000);
  expect(host.counts.fundState, 'the poll after the in-flight read settles must read again').toBe(reads + 1);
  host.reads[host.reads.length - 1].resolve(fundState({ funding_amount_sats_received: 600 }));
  await flush();
  expect(panel()!.querySelector('.progress strong')?.textContent).toBe('600 sats');
  expect(shownAddress()).toBe(ADDRESS);
});

it('keeps a failed deposit start until a later poll observes a deposit or the owner tries again', async () => {
  vi.useFakeTimers();
  const host = stubHost({ holdStart: true });
  await openWallet(host);
  const stale = await tickPending(host);
  const raw = 'Error: POST /onboarding/start returned 502: {"error":"wallet"}';
  const summary = () => panel()!.querySelector('[data-soft-summary]')?.textContent;
  submitStart();
  await flush();
  host.starts[0].reject(raw);
  await flush();
  expect(summary()).toBe(START_FAILED);
  stale.resolve(null);
  await flush();
  const reads = host.counts.fundState;
  await vi.advanceTimersByTimeAsync(3000);
  expect(host.counts.fundState).toBe(reads + 1);
  host.reads[host.reads.length - 1].resolve(null);
  await flush();
  expect(summary(), 'an empty status must not clear the failed start').toBe(START_FAILED);
  expect(panel()!.querySelector('[data-soft-detail]')?.textContent).toContain(raw);
  expect(shownAddress()).toBeNull();
  expect(panel()!.querySelector('[data-fund-start]')).not.toBeNull();
  // Trying again clears the failure while the new start is still out.
  submitStart();
  await flush();
  expect(host.starts).toHaveLength(2);
  expect(summary()).toBeUndefined();
  host.starts[1].reject(raw);
  await flush();
  expect(summary()).toBe(START_FAILED);
  await vi.advanceTimersByTimeAsync(3000);
  expect(host.counts.fundState).toBe(reads + 2);
  host.reads[host.reads.length - 1].resolve(fundState({ funding_amount_sats_received: 250 }));
  await flush();
  expect(summary(), 'an observed deposit replaces the failed start').toBeUndefined();
  expect(shownAddress()).toBe(ADDRESS);
  expect(panel()!.querySelector('.progress strong')?.textContent).toBe('250 sats');
});

it.each(['resolves', 'rejects'] as const)('a deposit start that %s after the panel is gone does not write or refresh', async (outcome) => {
  vi.useFakeTimers();
  const host = stubHost({ holdStart: true });
  const errors = vi.spyOn(console, 'error');
  await openWallet(host);
  const stale = await tickPending(host);
  submitStart();
  await flush();
  expect(host.starts).toHaveLength(1);
  const reads = host.counts.fundState;
  click('[data-tab="general"]');
  await flush();
  expect(panel()).toBeNull();
  if (outcome === 'resolves') host.starts[0].resolve(fundState({ funding_address: null }));
  else host.starts[0].reject('Error: POST /onboarding/start returned 502: {"error":"wallet"}');
  await flush();
  // Started with no address: a live panel would ask the payments endpoint, then refresh.
  stale.resolve(fundState({ funding_address: null }));
  await vi.advanceTimersByTimeAsync(6000);
  expect(host.counts.fundState, 'the settled start must not refresh').toBe(reads);
  expect(host.counts.fundingAddress).toBe(0);
  click('[data-tab="wallet"]');
  await flush();
  expect(panel()).not.toBeNull();
  expect(shownAddress()).toBeNull();
  expect(panel()!.querySelector('[data-soft-summary]')).toBeNull();
  expect(panel()!.querySelector('.progress')).toBeNull();
  expect(panel()!.querySelector('.funded')).toBeNull();
  expect(errors).not.toHaveBeenCalled();
});

const STATE_FAILED = 'Could not read the deposit status from your node. BitSov tries again by itself every few seconds.';
const summaries = () => [...panel()!.querySelectorAll('[data-soft-summary]')].map((node) => node.textContent);
const detailText = () => [...panel()!.querySelectorAll('[data-soft-detail]')].map((node) => node.textContent ?? '').join('\n');

it('keeps a failed deposit start visible when a status poll fails and the next one is empty', async () => {
  vi.useFakeTimers();
  const host = stubHost({ holdStart: true });
  await openWallet(host);
  const startRaw = 'Error: POST /onboarding/start returned 502: {"error":"wallet"}';
  const pollRaw = 'Error: GET /onboarding/state returned 503: {"error":"node"}';
  submitStart();
  await flush();
  expect(host.starts).toHaveLength(1);
  host.starts[0].reject(startRaw);
  await flush();
  expect(summaries()).toEqual([START_FAILED]);

  await vi.advanceTimersByTimeAsync(3000);
  expect(host.reads).toHaveLength(1);
  host.reads[0].reject(pollRaw);
  await flush();
  expect(summaries(), 'a failed status poll must not replace the failed start').toEqual([START_FAILED, STATE_FAILED]);
  expect(detailText()).toContain(startRaw);
  expect(detailText()).toContain(pollRaw);
  expect(shownAddress()).toBeNull();
  expect(panel()!.querySelector('[data-fund-start]')).not.toBeNull();

  await vi.advanceTimersByTimeAsync(3000);
  expect(host.reads).toHaveLength(2);
  host.reads[1].resolve(null);
  await flush();
  expect(summaries(), 'an empty status must not clear the failed start').toEqual([START_FAILED]);
  expect(detailText()).toContain(startRaw);
  expect(detailText()).not.toContain(pollRaw);
  expect(panel()!.textContent).not.toContain(STATE_FAILED);
  expect(shownAddress()).toBeNull();
  expect(panel()!.querySelector('[data-fund-start]')).not.toBeNull();

  await vi.advanceTimersByTimeAsync(3000);
  expect(host.reads).toHaveLength(3);
  host.reads[2].resolve(fundState({ funding_amount_sats_received: 250 }));
  await flush();
  expect(summaries(), 'an observed deposit clears the failed start and the status error').toEqual([]);
  expect(shownAddress()).toBe(ADDRESS);
  expect(panel()!.querySelector('.progress strong')?.textContent).toBe('250 sats');
});

it('keeps a just-started deposit when the following status read says not started', async () => {
  vi.useFakeTimers();
  const host = stubHost({ holdStart: true });
  await openWallet(host);
  submitStart();
  await flush();
  expect(host.starts).toHaveLength(1);
  const before = host.counts.fundState;
  host.starts[0].resolve(fundState());
  await flush();
  expect(host.counts.fundState, 'the start is followed by one status read').toBe(before + 1);
  expect(shownAddress()).toBe(ADDRESS);
  host.reads[0].resolve(null);
  await flush();
  expect(shownAddress(), 'one empty read right after the start must not bring the form back').toBe(ADDRESS);
  expect(panel()!.querySelector('form')).toBeNull();
  expect(panel()!.querySelector('[data-fund-start]')).toBeNull();
  expect(panel()!.querySelector('.progress strong')?.textContent).toBe('0 sats');

  await vi.advanceTimersByTimeAsync(3000);
  expect(host.counts.fundState).toBe(before + 2);
  host.reads[1].resolve(null);
  await flush();
  expect(shownAddress(), 'a later empty read confirms the deposit is not started').toBeNull();
  expect(panel()!.querySelector('[data-fund-start]')).not.toBeNull();
  expect(panel()!.querySelector('.progress')).toBeNull();
});
