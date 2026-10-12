import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { OwnerApprovals, OwnerApprovalWait } from '../src/control/OwnerApprovals';
import { APPROVAL_ERROR_CODES, refusalText, type ApprovalView } from '../src/control/ownerApproval';

let dispose: (() => void) | undefined;
let mount: HTMLElement;
afterEach(() => { dispose?.(); mount?.remove(); vi.useRealTimers(); });
const A = 'a'.repeat(64);
const NOW = 1_800_000_000_000;
const view = (over: Partial<ApprovalView> = {}): ApprovalView => ({
  op_id: 'op-1', node: 'n', client_id: 'client-phone', client_pubkey: 'cd'.repeat(32), epoch: 4, grant_op: 'g-1',
  request: { kind: 'first_contact', terms: { recipient: A, max_total_msat: 14_000, budget_msat: 50_000 } },
  nonce: '11'.repeat(16), expires_at: NOW / 1000 + 200, approval_message: 'bitsov-approval-v1\nkind=first_contact\nrecipient=aaaa…\nmax_total_msat=14000',
  status: 'pending', owner_action: null, ...over,
});
const $ = <T extends HTMLElement = HTMLElement>(s: string) => mount.querySelector<T>(s);
function show(jsx: () => any) { mount = document.createElement('div'); document.body.appendChild(mount); dispose = render(jsx, mount); }

describe('owner side: approvals waiting for this device', () => {
  it('shows the node’s terms, the requesting app’s fingerprint, the time left and the exact message', () => {
    show(() => <OwnerApprovals approvals={[view()]} now={NOW} nameOf={() => 'Maya'} approve={vi.fn()} />);
    expect([...mount.querySelectorAll('[data-approval-terms] li')].map((l) => l.textContent)).toEqual([
      'Let this app message someone new', 'To: Maya (aaaaaa…aaaaaa)', 'First message: up to 14 sats', 'Contact budget: up to 50 sats',
    ]);
    expect($('[data-approval-client]')!.textContent).toContain('cdcdcd…cdcdcd');
    expect($('[data-approval-client]')!.textContent).toContain('does not name the app');
    expect($('[data-approval-expires]')!.textContent).toContain('3:20');
    expect($('[data-approval-message] pre')!.textContent).toBe(view().approval_message);
  });

  it('Approve sends exactly the message that was shown (terms shown == terms signed)', async () => {
    const approve = vi.fn(async () => ({ ok: true as const, value: view({ status: 'consumed' }) }));
    show(() => <OwnerApprovals approvals={[view()]} now={NOW} approve={approve} />);
    $<HTMLButtonElement>('[data-approval-approve]')!.click();
    await vi.waitFor(() => expect($('[data-approval-result="ok"]')).not.toBeNull());
    expect(approve).toHaveBeenCalledWith('op-1', view().approval_message);
    expect($('[data-approval-approve]')).toBeNull();
  });

  it.each([...APPROVAL_ERROR_CODES, 'device_cancelled'])('a %s refusal is said plainly and nothing claims success', async (code) => {
    const approve = vi.fn(async () => ({ ok: false as const, error: { code: code as never, message: 'node text', reason: 'seed_password_not_typed', remaining_msat: 2000 } }));
    show(() => <OwnerApprovals approvals={[view()]} now={NOW} approve={approve} />);
    $<HTMLButtonElement>('[data-approval-approve]')!.click();
    await vi.waitFor(() => expect($('[data-approval-result="refused"]')).not.toBeNull());
    expect($('[data-approval-result="refused"]')!.textContent).toBe(refusalText(code, { reason: 'seed_password_not_typed', remaining_msat: 2000 }));
    expect($('[data-approval-approve]')).not.toBeNull(); // still pending: can try again
  });

  it('Not now hides it here and sends nothing; expired requests are not offered', () => {
    const approve = vi.fn();
    show(() => <OwnerApprovals approvals={[view(), view({ op_id: 'op-old', expires_at: NOW / 1000 - 1 })]} now={NOW} approve={approve} />);
    expect(mount.querySelectorAll('[data-owner-approval]')).toHaveLength(1);
    $<HTMLButtonElement>('[data-approval-dismiss]')!.click();
    expect($('[data-owner-approval]')).toBeNull();
    expect($('[data-owner-approvals-empty]')).not.toBeNull();
    expect(approve).not.toHaveBeenCalled();
  });
});

describe('requester side: waiting for the other owner device', () => {
  it('polls, and when the node says consumed it reports approved', async () => {
    const status = vi.fn().mockResolvedValueOnce({ ok: true, value: view() }).mockResolvedValueOnce({ ok: true, value: view({ status: 'consumed' }) });
    const onApproved = vi.fn();
    show(() => <OwnerApprovalWait view={view()} now={NOW} status={status} onApproved={onApproved} onStop={vi.fn()} pollMs={5} fallback="konsensus approve …" />);
    expect($('[data-owner-approval-wait="pending"]')!.textContent).toContain('Waiting for your approval on your other owner device');
    expect($('[data-owner-approval-wait]')!.textContent).toContain('this device cannot approve its own request');
    expect($<HTMLDetailsElement>('details[data-other-ways]')!.open).toBe(false);
    // No self-approval path: the requesting device is never offered Approve for its own request.
    expect($('[data-approval-approve]')).toBeNull();
    expect(mount.textContent).not.toMatch(/Approve with/);
    await vi.waitFor(() => expect(onApproved).toHaveBeenCalledWith(expect.objectContaining({ status: 'consumed' })));
    expect($('[data-approval-wait-approved]')).not.toBeNull();
  });

  it('a successful read that says expired ends the wait: nothing was approved', async () => {
    const status = vi.fn(async () => ({ ok: true as const, value: view({ status: 'expired' }) }));
    const onApproved = vi.fn();
    show(() => <OwnerApprovalWait view={view()} now={NOW} status={status} onApproved={onApproved} onStop={vi.fn()} pollMs={5} />);
    await vi.waitFor(() => expect($('[data-approval-wait-expired]')!.textContent).toBe('This request expired. Nothing was approved.'));
    expect(onApproved).not.toHaveBeenCalled();
  });

  it.each(['approval_unknown', 'node', 'approval_forbidden', 'approval_unsaved', 'approval_expired'])('%s on the status read is uncertain, keeps checking, and a later consumed still approves', async (code) => {
    let approved = false;
    const status = vi.fn(async () => (approved
      ? { ok: true as const, value: view({ status: 'consumed' }) }
      : { ok: false as const, error: { code: code as never, message: 'x' } }));
    const onApproved = vi.fn();
    show(() => <OwnerApprovalWait view={view()} now={NOW} status={status} onApproved={onApproved} onStop={vi.fn()} pollMs={5} />);
    await vi.waitFor(() => expect(mount.textContent).toContain('Couldn’t check whether it was approved'));
    expect(mount.textContent).not.toContain('Nothing was approved');
    expect($('[data-approval-wait-cancel]')).not.toBeNull();
    // Still checking: the other device approves later, and the wait goes on by itself.
    await vi.waitFor(() => expect(status.mock.calls.length).toBeGreaterThan(2));
    approved = true;
    await vi.waitFor(() => expect(onApproved).toHaveBeenCalledTimes(1));
  });

  it('a passing error is said and the wait goes on', async () => {
    const status = vi.fn().mockResolvedValueOnce({ ok: false, error: { code: 'approval_rate_limited', message: 'x' } })
      .mockResolvedValueOnce({ ok: true, value: view({ status: 'consumed' }) });
    const onApproved = vi.fn();
    show(() => <OwnerApprovalWait view={view()} now={NOW} status={status} onApproved={onApproved} onStop={vi.fn()} pollMs={5} />);
    await vi.waitFor(() => expect(onApproved).toHaveBeenCalled());
    expect(status).toHaveBeenCalledTimes(2);
  });

  it('Cancel stops waiting here (and says the request expires by itself)', () => {
    const onStop = vi.fn();
    show(() => <OwnerApprovalWait view={view()} now={NOW} status={vi.fn(() => new Promise<never>(() => {}))} onApproved={vi.fn()} onStop={onStop} />);
    expect($('[data-approval-wait-expires]')!.textContent).toContain('the request expires by itself');
    $<HTMLButtonElement>('[data-approval-wait-cancel]')!.click();
    expect(onStop).toHaveBeenCalled();
  });
});

describe('round 1 (#216): nothing vanishes, nothing claims more than is known', () => {
  it('an op awaiting Touch ID, then refused, stays with its outcome after it leaves the node’s list', async () => {
    let finish!: (r: unknown) => void;
    const approve = vi.fn(() => new Promise((r) => { finish = r; })) as never;
    let list: () => ApprovalView[];
    const { createSignal } = await import('solid-js');
    const [approvals, setApprovals] = createSignal([view()]);
    list = approvals;
    show(() => <OwnerApprovals approvals={list()} now={NOW} approve={approve} />);
    $<HTMLButtonElement>('[data-approval-approve]')!.click();
    await vi.waitFor(() => expect($('[data-approval-busy]')).not.toBeNull());
    setApprovals([]); // expired / left the list while Touch ID was up
    expect($('[data-owner-approval="op-1"]')).not.toBeNull();
    finish({ ok: false, error: { code: 'approval_expired', message: 'x' } });
    await vi.waitFor(() => expect($('[data-approval-result="refused"]')!.textContent).toBe(refusalText('approval_expired')));
    expect($('[data-approval-approve]')).toBeNull(); // no stale Approve
    expect($('[data-approval-expires]')!.textContent).toContain('no longer waiting');
    $<HTMLButtonElement>('[data-approval-dismiss]')!.click();
    expect($('[data-owner-approval]')).toBeNull();
  });

  it('a list that could not be read is said, not shown as "nothing is waiting"', () => {
    show(() => <OwnerApprovals approvals={[]} error="Your node refused this approval. Nothing was approved." now={NOW} approve={vi.fn()} />);
    expect($('[data-owner-approvals-error]')!.textContent).toContain('refused');
    expect($('[data-owner-approvals-empty]')).toBeNull();
  });

  it.each([
    ['pending', 'still lists this request as waiting, so it was not approved', true],
    ['gone', 'no longer lists this request (it was approved or it expired)', false],
    ['unknown', 'your node could not be read', false],
  ] as const)('a transport error on approve rechecks the node (%s) and says only what is known', async (now, text, approveAgain) => {
    const approve = vi.fn(async (_id: string, _message: string) => ({ ok: false as const, error: { code: 'node' as const, message: 'connection lost' } }));
    const recheck = vi.fn(async () => now);
    show(() => <OwnerApprovals approvals={now === 'pending' ? [view()] : []} now={NOW} approve={approve} recheck={recheck} />);
    if (now !== 'pending') {
      // Rendered from a list that already dropped it: approve from the kept copy path.
      dispose?.(); mount.remove();
      const { createSignal } = await import('solid-js');
      const [list, setList] = createSignal([view()]);
      show(() => <OwnerApprovals approvals={list()} now={NOW} approve={async (id, message) => { setList([]); return approve(id, message); }} recheck={recheck} />);
    }
    $<HTMLButtonElement>('[data-approval-approve]')!.click();
    await vi.waitFor(() => expect($('[data-approval-result="refused"]')!.textContent).toContain(text));
    expect(recheck).toHaveBeenCalledWith('op-1');
    expect($('[data-approval-result="refused"]')!.textContent).not.toContain('Nothing was approved');
    expect(!!$('[data-approval-approve]')).toBe(approveAgain);
  });

  it('an expired wait has a Dismiss that frees the requester', async () => {
    const onStop = vi.fn();
    show(() => <OwnerApprovalWait view={view()} now={NOW} status={vi.fn(async () => ({ ok: true as const, value: view({ status: 'expired' }) }))} onApproved={vi.fn()} onStop={onStop} pollMs={5} />);
    await vi.waitFor(() => expect($('[data-approval-wait-dismiss]')).not.toBeNull());
    $<HTMLButtonElement>('[data-approval-wait-dismiss]')!.click();
    expect(onStop).toHaveBeenCalled();
  });

  it('an uncertain wait (unknown) is never a dead end: Cancel frees the requester', async () => {
    const onStop = vi.fn();
    show(() => <OwnerApprovalWait view={view()} now={NOW} status={vi.fn(async () => ({ ok: false as const, error: { code: 'approval_unknown' as never, message: 'x' } }))} onApproved={vi.fn()} onStop={onStop} pollMs={5} />);
    await vi.waitFor(() => expect(mount.textContent).toContain('Couldn’t check whether it was approved'));
    $<HTMLButtonElement>('[data-approval-wait-cancel]')!.click();
    expect(onStop).toHaveBeenCalled();
  });

  it('kept outcomes live in the memory the shell owns: closing and reopening the panel keeps them', async () => {
    const { approvalMemory } = await import('../src/control/OwnerApprovals');
    const memory = approvalMemory();
    const approve = vi.fn(async () => ({ ok: false as const, error: { code: 'approval_forbidden' as never, message: 'x' } }));
    show(() => <OwnerApprovals approvals={[view()]} now={NOW} approve={approve} memory={memory} />);
    $<HTMLButtonElement>('[data-approval-approve]')!.click();
    await vi.waitFor(() => expect($('[data-approval-result="refused"]')).not.toBeNull());
    dispose?.(); mount.remove();
    // Reopened, and the node no longer lists it: the outcome is still there until Dismiss.
    show(() => <OwnerApprovals approvals={[]} now={NOW} approve={approve} memory={memory} />);
    expect($('[data-approval-result="refused"]')!.textContent).toBe(refusalText('approval_forbidden'));
    $<HTMLButtonElement>('[data-approval-dismiss]')!.click();
    expect($('[data-owner-approval]')).toBeNull();
  });
});

describe('round 3 (#216): one approve in flight, and the first outcome stands', () => {
  it('leaving and coming back while Touch ID is up offers no second Approve; the first outcome stands', async () => {
    const { approvalMemory } = await import('../src/control/OwnerApprovals');
    const memory = approvalMemory();
    let finish!: (r: unknown) => void;
    const approve = vi.fn(() => new Promise((r) => { finish = r; })) as never;
    show(() => <OwnerApprovals approvals={[view()]} now={NOW} approve={approve} memory={memory} />);
    $<HTMLButtonElement>('[data-approval-approve]')!.click();
    await vi.waitFor(() => expect($('[data-approval-busy]')).not.toBeNull());
    // Node → Body → Node: the panel unmounts and mounts again while the approve is unresolved.
    dispose?.(); mount.remove();
    show(() => <OwnerApprovals approvals={[view()]} now={NOW} approve={approve} memory={memory} />);
    expect($('[data-approval-busy]')).not.toBeNull();
    expect($<HTMLButtonElement>('[data-approval-approve]')!.disabled).toBe(true);
    $<HTMLButtonElement>('[data-approval-approve]')!.click();
    expect(vi.mocked(approve as unknown as (...a: unknown[]) => unknown)).toHaveBeenCalledTimes(1);
    finish({ ok: true, value: view({ status: 'consumed' }) });
    await vi.waitFor(() => expect($('[data-approval-result="ok"]')).not.toBeNull());
    expect($('[data-approval-approve]')).toBeNull();
  });

  it('an "Approved" reached through a real approve is never overwritten: a stale list and a remount offer no second Approve', async () => {
    const { approvalMemory } = await import('../src/control/OwnerApprovals');
    const memory = approvalMemory();
    // First call approves; any later call would be refused. Only the first may ever happen.
    const approve = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, value: view({ status: 'consumed' }) })
      .mockResolvedValue({ ok: false as const, error: { code: 'approval_forbidden' as never, message: 'x' } });
    show(() => <OwnerApprovals approvals={[view()]} now={NOW} approve={approve} memory={memory} />);
    $<HTMLButtonElement>('[data-approval-approve]')!.click();
    await vi.waitFor(() => expect($('[data-approval-result="ok"]')).not.toBeNull());
    // The node's list is stale (still says pending) and the panel is reopened.
    dispose?.(); mount.remove();
    show(() => <OwnerApprovals approvals={[view()]} now={NOW} approve={approve} memory={memory} />);
    expect($('[data-approval-approve]')).toBeNull();
    expect($('[data-approval-result="ok"]')!.textContent).toBe('Approved. The app that asked can go on now.');
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it('settleOutcome: Approved, then a delayed refusal for the same op, keeps Approved (other ops unaffected)', async () => {
    const { settleOutcome } = await import('../src/control/OwnerApprovals');
    const approved = { ok: true, text: 'Approved. The app that asked can go on now.' };
    const refused = { ok: false, text: refusalText('approval_forbidden') };
    let s = settleOutcome({}, 'op-1', { ok: false, text: 'Couldn’t confirm whether the approval went through. Checking your node…' });
    s = settleOutcome(s, 'op-1', approved);
    s = settleOutcome(s, 'op-1', refused);
    s = settleOutcome(s, 'op-2', refused);
    expect(s).toEqual({ 'op-1': approved, 'op-2': refused });
  });
});

describe('the wait gives up when reads keep failing well past expiry', () => {
  const failing = () => vi.fn(async () => ({ ok: false as const, error: { code: 'node' as never, message: 'x' } }));

  it('within 60 s of expiry a failed read keeps checking (no give-up)', async () => {
    const status = failing();
    // expired 30 s ago by the clock: still within the grace
    show(() => <OwnerApprovalWait view={view({ expires_at: Date.now() / 1000 - 30 })} now={NOW} status={status} onApproved={vi.fn()} onStop={vi.fn()} pollMs={5} />);
    await vi.waitFor(() => expect(status.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect($('[data-approval-wait-unconfirmed]')).toBeNull();
    expect($('[data-owner-approval-wait="pending"]')).not.toBeNull();
    expect(mount.textContent).toContain('Couldn’t check whether it was approved');
  });

  it('past expiry + 60 s a failed read stops checking and says so, with Dismiss', async () => {
    const status = failing();
    const onStop = vi.fn();
    show(() => <OwnerApprovalWait view={view({ expires_at: Date.now() / 1000 - 61 })} now={NOW} status={status} onApproved={vi.fn()} onStop={onStop} pollMs={5} />);
    await vi.waitFor(() => expect($('[data-approval-wait-unconfirmed]')).not.toBeNull());
    expect($('[data-approval-wait-unconfirmed]')!.textContent).toBe('Couldn’t confirm whether it was approved. Ask again if needed.');
    expect($('[data-owner-approval-wait="unconfirmed"]')).not.toBeNull();
    expect($('[data-approval-wait-cancel]')).toBeNull();
    const calls = status.mock.calls.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(status.mock.calls.length).toBe(calls);
    $<HTMLButtonElement>('[data-approval-wait-dismiss]')!.click();
    expect(onStop).toHaveBeenCalled();
  });

  it('a successful read past the grace still wins (only failed reads give up)', async () => {
    const onApproved = vi.fn();
    const status = vi.fn(async () => ({ ok: true as const, value: view({ status: 'consumed', expires_at: Date.now() / 1000 - 120 }) }));
    show(() => <OwnerApprovalWait view={view({ expires_at: Date.now() / 1000 - 120 })} now={NOW} status={status} onApproved={onApproved} onStop={vi.fn()} pollMs={5} />);
    await vi.waitFor(() => expect($('[data-approval-wait-approved]')).not.toBeNull());
    expect(onApproved).toHaveBeenCalledTimes(1);
    expect($('[data-approval-wait-unconfirmed]')).toBeNull();
  });
});
