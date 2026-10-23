import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import { PairingActivityProvider, usePairingBlocked } from '../src/pairingActivity';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';

// Give the real wallet an independent activity scope. The shell's own guard
// considers any open wallet busy on this base, which would mask a missing
// registration inside Reconcile. No wallet or action behavior is stubbed.
vi.mock('../src/control/WalletPage', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/control/WalletPage')>();
  const Busy = () => {
    const blocked = usePairingBlocked();
    return <output data-wallet-busy={String(blocked())} />;
  };
  return { ...actual, WalletPage: (props: Parameters<typeof actual.WalletPage>[0]) =>
    <PairingActivityProvider><Busy /><actual.WalletPage {...props} /></PairingActivityProvider> };
});

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); document.body.innerHTML = ''; });
const find = (selector: string) => document.querySelector<HTMLElement>(selector)!;
const busy = () => find('[data-wallet-busy]')?.getAttribute('data-wallet-busy');
async function open(source: ReturnType<typeof sampleSource>) {
  const budget = await source.budgetStatus();
  source.budgetStatus = async () => ({ ...budget, unsettled_msat: 2000 });
  dispose = render(() => <ControlCenter source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, document.body);
  await vi.waitFor(() => expect(find('[data-profile]')).not.toBeNull());
  find('[data-profile]').click(); find('[data-open-wallet]').click();
  await vi.waitFor(() => expect(find('[data-wallet-page] [data-spend-reconcile]')).not.toBeNull());
}

it.each(['success', 'error'] as const)('keeps the wallet busy until reconciliation returns its %s result', async outcome => {
  const source = sampleSource({ firstLiveMs: 1e9 });
  let finish!: () => void;
  source.spendReconcile = async () => {
    await new Promise<void>(resolve => { finish = resolve; });
    if (outcome === 'error') throw { code: 'node', message: 'Could not check pending result.' };
    return 'Previous action settled.';
  };
  await open(source);
  expect(busy()).toBe('false');
  find('[data-wallet-page] [data-spend-reconcile]').click();
  expect(busy()).toBe('true');
  finish();
  await vi.waitFor(() => expect(busy()).toBe('false'));
  expect(find('[data-wallet-page] [data-reconciliation]').textContent).toBe(outcome === 'success' ? 'Previous action settled.' : 'Could not check pending result.');
});

it('keeps Stop retrying busy until its result is visible', async () => {
  const source = sampleSource({ firstLiveMs: 1e9 });
  source.spendReconcile = async () => { throw { code: 'undelivered_pending', message: 'Paid, undelivered', pending_id: 'record-one' }; };
  let finish!: () => void;
  source.dismissUndelivered = async () => { await new Promise<void>(resolve => { finish = resolve; }); return 'Stopped retrying.'; };
  await open(source);
  find('[data-wallet-page] [data-spend-reconcile]').click();
  await vi.waitFor(() => expect(find('[data-wallet-page] [data-stop-retrying]')).not.toBeNull());
  expect(busy()).toBe('false');
  find('[data-wallet-page] [data-stop-retrying]').click();
  expect(busy()).toBe('true');
  finish();
  await vi.waitFor(() => expect(busy()).toBe('false'));
  expect(find('[data-wallet-page] [data-reconciliation]').textContent).toBe('Stopped retrying.');
  expect(find('[data-wallet-page] [data-stop-retrying]')).toBeNull();
});
