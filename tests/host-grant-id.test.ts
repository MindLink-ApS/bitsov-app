import { afterEach, expect, it, vi } from 'vitest';
import { hostSource } from '../src/control/source';
import { sampleSource } from '../src/control/sample';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
afterEach(() => vi.resetAllMocks());

it('passes node request and armed window identities through each approval command', async () => {
  const budget = await sampleSource().budgetStatus();
  const spend = await sampleSource().spendStatus();
  const cases = [
    { command: 'spend_request', args: undefined, call: () => hostSource.spendRequest(), view: spend },
    { command: 'budget_approve', args: { ceiling_msat: 500_000, preset: 'careful' }, call: () => hostSource.budgetApprove(500_000, 'careful'), view: budget },
    { command: 'budget_resume', args: undefined, call: () => hostSource.budgetResume(), view: budget },
  ];
  for (const { command, args, call, view } of cases) {
    for (const identity of [
      { request_id: 'Ab12', granted_op: null },
      { request_id: 'Ab12', granted_op: 'Cd34' },
      { request_id: null, granted_op: 'Cd34' },
      { request_id: null, granted_op: null },
    ]) {
      const reply = { ...view, ...identity };
      invoke.mockResolvedValueOnce(reply);
      expect(await call()).toEqual(reply);
      expect(invoke).toHaveBeenLastCalledWith(command, ...(args ? [args] : []));
    }
  }
});

it('passes a grant id or explicit null through an open spend view', async () => {
  for (const granted_op of ['Ab12', null]) {
    const reply = { state: 'open', basis: 'node_grant', open_until_ms: 2_000_000_000_000,
      pending: null, window_ms: 600_000, granted_op };
    invoke.mockResolvedValueOnce(reply);
    expect(await hostSource.spendStatus()).toEqual(reply);
  }
});

it('passes the call contact to the host when requesting a call budget', async () => {
  const peer = 'ab'.repeat(32);
  const reply = await sampleSource().spendStatus();
  invoke.mockResolvedValueOnce(reply);
  expect(await hostSource.spendRequest(peer)).toEqual(reply);
  expect(invoke).toHaveBeenCalledWith('spend_request', { call_peer: peer });
});
