import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import { StarterBalance } from '../src/control/StarterBalance';
import { WalletPage } from '../src/control/WalletPage';
import type { StarterStatus } from '../src/control/starter';
import { setLanguagePref } from '../src/i18n';
import { setDenom } from '../src/control/prefs';

const ID = '12345678-1234-4234-8234-123456789abc';
const empty: StarterStatus = { state: 'not_requested', hub_configured: true };
const pending: StarterStatus = { ...empty, state: 'requested', request_id: ID, verified: false };
let dispose: (() => void) | undefined;
let host: HTMLDivElement;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function mount(status = empty, options: { enabled?: boolean; network?: string; capabilities?: string[]; nodeId?: string } = {}, request = vi.fn(async (_id: string) => pending)) {
  const current = vi.fn(async () => status);
  host = document.createElement('div'); document.body.append(host);
  dispose = render(() => <StarterBalance enabled={options.enabled ?? true} network={options.network ?? 'signet'}
    capabilities={options.capabilities ?? ['starter_channel_request_v1']} nodeId={options.nodeId ?? 'node-a'}
    api={{ current, request }} />, host);
  return { current, request };
}
beforeEach(() => { setLanguagePref('en'); setDenom('sats'); });
afterEach(() => { dispose?.(); document.body.innerHTML = ''; vi.restoreAllMocks(); vi.useRealTimers(); });
it.each([
  [{ enabled: false }], [{ network: 'mainnet' }], [{ network: 'regtest' }], [{ network: 'unknown' }], [{ capabilities: [] }],
])('hides the step and does not discover when ineligible: %j', async options => {
  const api = mount(empty, options); await flush(); expect(host.textContent).toBe(''); expect(api.current).not.toHaveBeenCalled();
});
it('uses the exact build flag when no enabled override is supplied', async () => {
  host = document.createElement('div');
  const current = vi.fn(async () => empty);
  dispose = render(() => <StarterBalance network="signet" nodeId="node-a" capabilities={['starter_channel_request_v1']} api={{ current, request: async () => pending }} />, host);
  await flush();
  if (import.meta.env.VITE_STARTER_BALANCE === '1') {
    expect(host.textContent).toContain('Get your starter balance'); expect(current).toHaveBeenCalledTimes(1);
  } else {
    expect(host.textContent).toBe(''); expect(current).not.toHaveBeenCalled();
  }
});
it('hides an unconfigured hub', async () => { mount({ ...empty, hub_configured: false }); await flush(); expect(host.textContent).toBe(''); });
it('uses not_requested discovery, free hub-funded copy and plain alias text', async () => {
  mount({ ...empty, hub_alias: '<a href="https://evil.example">hub</a>' }); await flush();
  expect(host.textContent).toContain('Get your starter balance'); expect(host.textContent).toContain('Free. The hub funds your starter balance.');
  expect(host.querySelector('a')).toBeNull(); expect(host.textContent).toContain('<a href='); expect(host.querySelectorAll('button')).toHaveLength(1);
});
it.each([
  [{ state: 'requested' }, 'Requested'],
  [{ state: 'requested', detail: 'hub_unreachable' }, 'Waiting for the hub'],
  [{ state: 'requested', detail: 'hub_silent_24h' }, 'Waiting for the hub'],
  [{ state: 'opening', push_sats: 10000 }, 'Channel opening'],
  [{ state: 'opening', detail: 'verify_mismatch' }, 'Channel opening'],
  [{ state: 'ready', verified: false }, 'Channel opening'],
  [{ state: 'refused', retry_allowed: false }, 'Request refused'],
  [{ state: 'refused', detail: 'auto_retry_exhausted' }, 'Request failed'],
])('renders node state %j without promising funds', async (over, words) => {
  mount({ ...pending, ...over } as StarterStatus); await flush();
  expect(host.textContent).toContain(words); expect(host.textContent).not.toContain('Ready'); expect(host.textContent).not.toContain('10\u202f000');
});
it('shows confirmed ready as historical receipt with space-grouped amount', async () => {
  mount({ ...pending, state: 'ready', verified: true, push_sats: 10000 }); await flush();
  expect(host.textContent).toContain('Ready'); expect(host.textContent).toContain('10\u202f000 sats');
  expect(host.textContent).toContain('Check your wallet for what is spendable now.'); expect(host.querySelectorAll('button')).toHaveLength(0);
});
it('shows node-scheduled retry countdown, with no new-request action', async () => {
  mount({ ...pending, state: 'refused', retry_allowed: true, retry_after_unix: Math.floor(Date.now() / 1000) + 125 }); await flush();
  expect(host.textContent).toContain('Retrying in 3 min'); expect(host.querySelectorAll('button')).toHaveLength(0);
});
it('persists before dispatch, ignores double taps and reuses the UUID after an app restart and lost response', async () => {
  let reject!: (reason: Error) => void;
  const request = vi.fn((id: string) => {
    expect(Object.values(localStorage)).toContain(id);
    return new Promise<StarterStatus>((_, r) => { reject = r; });
  });
  mount(empty, {}, request); await flush();
  host.querySelector('button')!.click(); host.querySelector('button')!.click(); await flush();
  expect(request).toHaveBeenCalledTimes(1);
  const id = request.mock.calls[0][0]; expect(id).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  reject(new Error('lost response')); await flush(); dispose!(); host.remove();
  const replay = vi.fn(async (requestId: string) => ({ ...pending, request_id: requestId }));
  mount(empty, {}, replay); await flush(); host.querySelector('button')!.click(); await flush();
  expect(replay).toHaveBeenCalledWith(id); expect(host.textContent).toContain('Requested');
});
it('does not dispatch when durable storage is unavailable', async () => {
  const { request } = mount(); await flush();
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('full'); });
  host.querySelector('button')!.click(); await flush(); expect(request).not.toHaveBeenCalled(); expect(host.textContent).toContain('Could not save');
});
it('polls to confirmed ready and retains the UUID until terminal', async () => {
  vi.useFakeTimers(); let status: StarterStatus = pending;
  const current = vi.fn(async () => status);
  host = document.createElement('div');
  dispose = render(() => <StarterBalance enabled network="signet" nodeId="node-a" capabilities={['starter_channel_request_v1']} api={{ current, request: async () => pending }} />, host);
  await flush(); expect(Object.values(localStorage)).toContain(ID);
  status = { ...pending, state: 'ready', verified: true };
  await vi.advanceTimersByTimeAsync(5000); expect(host.textContent).toContain('Ready'); expect(Object.values(localStorage)).not.toContain(ID);
});
it('renders Danish states and free funding copy through the copy table', async () => {
  setLanguagePref('da'); mount(empty); await flush();
  expect(host.textContent).toContain('Få din startsaldo'); expect(host.textContent).toContain('Gratis. Hubben finansierer din startsaldo.');
  dispose!(); mount({ ...pending, state: 'opening' }); await flush(); expect(host.textContent).toContain('Kanalen åbnes');
  dispose!(); mount({ ...pending, state: 'ready', verified: true, push_sats: 10000 }); await flush(); expect(host.textContent).toContain('Klar'); expect(host.textContent).toContain('10\u202f000 sats');
});
it.each([
  [{ state: 'requested' }, 'Anmodning sendt'],
  [{ state: 'requested', detail: 'hub_unreachable' }, 'Venter på hubben'],
  [{ state: 'opening' }, 'Kanalen åbnes'],
  [{ state: 'ready', verified: false }, 'Kanalen åbnes'],
  [{ state: 'ready', verified: true }, 'Klar'],
  [{ state: 'refused' }, 'Anmodning afvist'],
  [{ state: 'refused', detail: 'auto_retry_exhausted' }, 'Anmodningen mislykkedes'],
])('localizes state %j in Danish', async (over, words) => {
  setLanguagePref('da'); mount({ ...pending, ...over } as StarterStatus); await flush();
  expect(host.textContent).toContain(words);
});
it('localizes the retry countdown in Danish', async () => {
  setLanguagePref('da');
  mount({ ...pending, state: 'refused', retry_allowed: true, retry_after_unix: Math.floor(Date.now() / 1000) + 125 }); await flush();
  expect(host.textContent).toContain('Prøver igen om 3 min');
});
it('keeps retryable refusal lineage across remount and never replaces it with a new UUID', async () => {
  mount({ ...pending, state: 'refused', retry_allowed: true, retry_after_unix: Math.floor(Date.now() / 1000) + 600 });
  await flush(); expect(Object.values(localStorage)).toContain(ID);
  dispose!(); host.remove();
  const { request } = mount(empty); await flush(); host.querySelector('button')!.click(); await flush();
  expect(request).toHaveBeenCalledWith(ID);
});
it('isolates saved intent by node identity', async () => {
  mount(pending); await flush(); dispose!(); host.remove();
  const { request } = mount(empty, { nodeId: 'node-b' }); await flush(); host.querySelector('button')!.click(); await flush();
  expect(request.mock.calls[0][0]).not.toBe(ID);
});
it('never interprets a missing route as not_requested', async () => {
  host = document.createElement('div'); const request = vi.fn(async () => pending);
  dispose = render(() => <StarterBalance enabled network="signet" nodeId="node-a" capabilities={['starter_channel_request_v1']}
    api={{ current: async () => { throw new Error('404'); }, request }} />, host);
  await flush(); expect(host.textContent).toBe(''); expect(request).not.toHaveBeenCalled();
});
it('does not show an absent alias or a spendable amount while waiting for confirmation', async () => {
  mount({ ...pending, state: 'ready', verified: false, push_sats: 10000 }); await flush();
  expect(host.querySelector('[data-starter-hub]')).toBeNull(); expect(host.textContent).not.toContain('10\u202f000');
  expect(Object.values(localStorage)).toContain(ID);
});
it('offers an explicit fresh request only after terminal refusal, never replaying its refused UUID', async () => {
  mount(pending); await flush(); dispose!(); host.remove();
  const { request } = mount({ ...pending, state: 'refused', detail: 'auto_retry_exhausted', retry_allowed: true, retry_after_unix: 1 });
  await flush(); expect(Object.values(localStorage)).not.toContain(ID);
  const button = host.querySelector('button'); expect(button?.textContent).toBe('Request again'); button!.click(); await flush();
  expect(request).toHaveBeenCalledTimes(1); expect(request.mock.calls[0][0]).not.toBe(ID);
});
it('waits for node adoption of an existing grant without offering a fresh request', async () => {
  mount({ ...pending, state: 'refused', detail: `adopt:${ID}`, retry_allowed: false }); await flush();
  expect(host.textContent).toContain('Waiting for the hub'); expect(host.querySelector('button')).toBeNull();
  expect(Object.values(localStorage)).toContain(ID);
});
it('retains a newer uncertain request when polling an older terminal refusal, including after restart', async () => {
  vi.useFakeTimers();
  const refused: StarterStatus = { ...pending, state: 'refused', retry_allowed: false };
  const request = vi.fn(async (_id: string): Promise<StarterStatus> => { throw new Error('connection lost'); });
  mount(refused, {}, request); await flush();
  host.querySelector('button')!.click(); await flush();
  const newerId = request.mock.calls[0][0];
  expect(newerId).not.toBe(ID);
  await vi.advanceTimersByTimeAsync(5000);
  expect(localStorage.getItem('bitsov.starter-request.node-a')).toBe(newerId);
  expect(host.querySelector('button')?.textContent).toBe('Retry request');
  dispose!(); host.remove();
  const replay = vi.fn(async (id: string) => ({ ...pending, request_id: id }));
  mount(refused, {}, replay); await flush(); host.querySelector('button')!.click(); await flush();
  expect(replay).toHaveBeenCalledWith(newerId);
});
it('ignores an old-node reply after switching identity without unmounting the wallet', async () => {
  const [nodeId, setNodeId] = createSignal('node-a');
  let reply!: (status: StarterStatus) => void;
  const request = vi.fn(() => new Promise<StarterStatus>(resolve => { reply = resolve; }));
  host = document.createElement('div'); document.body.append(host);
  dispose = render(() => <StarterBalance enabled network="signet" nodeId={nodeId()} capabilities={['starter_channel_request_v1']}
    api={{ current: async () => empty, request }} />, host);
  await flush(); host.querySelector('button')!.click(); await flush();
  const saved = localStorage.getItem('bitsov.starter-request.node-a');
  setNodeId('node-b'); await flush();
  reply({ ...pending, request_id: saved!, state: 'ready', verified: true }); await flush();
  expect(host.textContent).not.toContain('Ready');
  expect(localStorage.getItem('bitsov.starter-request.node-a')).toBe(saved);
  expect(localStorage.getItem('bitsov.starter-request.node-b')).toBeNull();
});
it.each(['en', 'da'] as const)('opens a dedicated starter screen with a Back label and returns to the wallet in %s', async locale => {
  setLanguagePref(locale);
  host = document.createElement('div'); document.body.append(host);
  const request = vi.fn(async () => pending);
  const unused = async (): Promise<never> => { throw new Error('Unexpected wallet action'); };
  dispose = render(() => <WalletPage tab="activity" onTab={() => {}} onClose={() => {}}
    wallet={{ balance_msat: 0, lightning_outbound_msat: 0, channels: [] }} moneyBlocked={false} spend={null} spendGate={null}
    now={Date.now()} ownId="node-a" histories={[]} threadMessages={[]} nameOf={id => id}
    actions={{ readInvoice: unused, pay: unused, keysend: unused, invoice: unused, approve: unused }}
    reads={{ messages: async () => [], fundingAddress: unused, invoiceStatus: unused }} onRefresh={() => {}}
    starter={{ enabled: true, network: 'signet', nodeId: 'node-a', capabilities: ['starter_channel_request_v1'], api: { current: async () => empty, request } }} />, host);
  await flush();
  host.querySelector<HTMLButtonElement>('[data-starter-entry]')!.click(); await flush();
  const back = host.querySelector<HTMLButtonElement>('[data-wallet-close]')!;
  expect(back.getAttribute('aria-label')).toBe(locale === 'en' ? '← Back' : '← Tilbage');
  expect(back.getAttribute('aria-label')).toBe(back.textContent);
  expect(host.querySelector('[data-wallet-balance]')).toBeNull();
  expect(host.querySelector('[data-wallet-refresh]')).toBeNull();
  expect(host.querySelector('[data-wallet-go="send"]')).toBeNull();
  expect(host.querySelectorAll('.wallet-body button')).toHaveLength(1);
  host.querySelector<HTMLButtonElement>('[data-starter-balance] button')!.click(); await flush();
  expect(request).toHaveBeenCalledTimes(1);
  host.querySelector<HTMLButtonElement>('[data-wallet-close]')!.click(); await flush();
  expect(host.querySelector('[data-wallet-balance]')).not.toBeNull();
  expect(host.querySelector('[data-starter-balance]')).toBeNull();
  expect(back.getAttribute('aria-label')).toBe(locale === 'en' ? '← Back, Close wallet' : '← Tilbage, Luk tegnebog');
});

it('adopts and persists the other device current request returned after a conflict', async () => {
  const otherId = '87654321-4321-4321-8321-cba987654321';
  const request = vi.fn(async (_id: string) => ({ ...pending, request_id: otherId }));
  mount(empty, {}, request); await flush(); host.querySelector('button')!.click(); await flush();
  expect(request.mock.calls[0][0]).not.toBe(otherId);
  expect(localStorage.getItem('bitsov.starter-request.node-a')).toBe(otherId);
  expect(host.textContent).toContain('Requested');
  dispose!(); host.remove();
  const replay = vi.fn(async (id: string) => ({ ...pending, request_id: id }));
  mount(empty, {}, replay); await flush(); host.querySelector('button')!.click(); await flush();
  expect(replay).toHaveBeenCalledWith(otherId);
});
it('shows fixed request failure copy and never raw node error text', async () => {
  const request = vi.fn(async (_id: string): Promise<StarterStatus> => { throw new Error('NODE_SECRET <script>route</script>'); });
  mount(empty, {}, request); await flush(); host.querySelector('button')!.click(); await flush();
  expect(host.textContent).toContain('Could not confirm the request.');
  expect(host.textContent).not.toContain('NODE_SECRET');
  expect(host.textContent).not.toContain('<script>');
});

it.each(['ready', 'refused'] as const)('adopts an already-terminal %s response after a conflict without replaying the write-ahead ID', async state => {
  const otherId = '87654321-4321-4321-8321-cba987654321';
  const terminal: StarterStatus = { ...pending, request_id: otherId, state, verified: state === 'ready', retry_allowed: false };
  const request = vi.fn(async (_id: string) => terminal);
  mount(empty, {}, request); await flush(); host.querySelector('button')!.click(); await flush();
  const writeAheadId = request.mock.calls[0][0];
  expect(localStorage.getItem('bitsov.starter-request.node-a')).toBeNull();
  expect(host.textContent).not.toContain('Could not confirm the request.');
  expect(host.textContent).toContain(state === 'ready' ? 'Ready' : 'Request refused');
  if (state === 'ready') expect(host.querySelector('button')).toBeNull();
  else {
    expect(host.querySelector('button')?.textContent).toBe('Request again');
    host.querySelector('button')!.click(); await flush();
    expect(request.mock.calls[1][0]).not.toBe(writeAheadId);
    expect(request.mock.calls[1][0]).not.toBe(otherId);
  }
});
