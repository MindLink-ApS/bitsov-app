import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';
import type { Source } from '../src/control/source';

const RECIPIENT = 'ab'.repeat(32);
const TX = 'cd'.repeat(32);

type Call = { cmd: string; args: unknown[] };

function panelSource(blvm: boolean) {
  const calls: Call[] = [];
  const base = sampleSource({ firstLiveMs: 1e9 });
  const source: Source = {
    ...base,
    nodeOverview: async () => ({ ...(await base.nodeOverview()), blvm_chat: blvm }),
    blvmChatRequest: async (amount, script) => {
      calls.push({ cmd: 'request', args: [amount, script] });
      return { payment_request_id: 'req-1' };
    },
    blvmChatConfirm: async (recipient, paymentRequestId, txHash) => {
      calls.push({ cmd: 'confirm', args: [recipient, paymentRequestId, txHash] });
      return {
        recipient,
        payment_request_id: paymentRequestId,
        tx_hash: txHash,
        amount_sats: 2,
        debit_counter: 0,
        spent_msat: 0,
        remaining_msat: 2000,
      };
    },
    blvmChatSession: async (recipient) => {
      calls.push({ cmd: 'read', args: [recipient] });
      return {
        recipient,
        payment_request_id: 'req-open',
        tx_hash: TX,
        amount_sats: 2,
        debit_counter: 1,
        spent_msat: 1000,
        remaining_msat: 1000,
      };
    },
  };
  return { source, calls };
}

let dispose: (() => void) | undefined;
let mount: HTMLElement;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  mount?.remove();
});

function openNode(source: Source) {
  mount = document.createElement('div');
  document.body.appendChild(mount);
  dispose = render(() => <ControlCenter source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
}

const panel = () => mount.querySelector('[data-panel="node"]')!;
const input = (selector: string) => panel().querySelector(selector) as HTMLInputElement;
const button = (selector: string) => panel().querySelector(selector) as HTMLButtonElement;

function type(selector: string, value: string) {
  const field = input(selector);
  field.value = value;
  field.dispatchEvent(new InputEvent('input', { bubbles: true }));
}

describe('on-chain chat node panel', () => {
  it('stays hidden until the node reports blvm_chat', async () => {
    const { source } = panelSource(false);
    openNode(source);
    await vi.waitFor(() => expect(mount.querySelector('[data-tab="node"]')).not.toBeNull());
    (mount.querySelector('[data-tab="node"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(panel()).not.toBeNull());
    expect(panel().querySelector('[data-blvm-chat]')).toBeNull();
    expect(panel().querySelector('[data-blvm-chat-open]')).toBeNull();
  });

  it('creates a request, stores the verified transaction, and reads the remainder', async () => {
    const { source, calls } = panelSource(true);
    openNode(source);
    await vi.waitFor(() => expect(mount.querySelector('[data-tab="node"]')).not.toBeNull());
    (mount.querySelector('[data-tab="node"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(panel().querySelector('[data-blvm-chat-open]')).not.toBeNull());
    expect(panel().querySelector('[data-blvm-chat]')!.textContent).toBe('available');
    expect(button('[data-blvm-store]').disabled).toBe(true);

    type('[data-blvm-script]', 'zz');
    button('[data-blvm-create]').click();
    await vi.waitFor(() => expect(panel().querySelector('[data-blvm-error]')!.textContent).toMatch(/not hex/));
    expect(calls).toEqual([]);

    type('[data-blvm-recipient]', RECIPIENT);
    type('[data-blvm-amount]', '2');
    type('[data-blvm-script]', '51');
    button('[data-blvm-create]').click();
    await vi.waitFor(() => expect(panel().querySelector('[data-blvm-request]')!.textContent).toContain('req-1'));
    expect(calls).toEqual([{ cmd: 'request', args: [2, '51'] }]);
    expect(button('[data-blvm-store]').disabled).toBe(false);

    type('[data-blvm-tx]', 'abcd');
    button('[data-blvm-store]').click();
    await vi.waitFor(() => expect(panel().querySelector('[data-blvm-error]')!.textContent).toMatch(/32 bytes/));
    expect(calls).toHaveLength(1);

    type('[data-blvm-tx]', TX);
    button('[data-blvm-store]').click();
    await vi.waitFor(() => expect(panel().querySelector('[data-blvm-remaining]')!.textContent).toContain('2000'));
    expect(calls[1]).toEqual({ cmd: 'confirm', args: [RECIPIENT, 'req-1', TX] });

    button('[data-blvm-show]').click();
    await vi.waitFor(() => expect(panel().querySelector('[data-blvm-remaining]')!.textContent).toContain('1000'));
    expect(calls[2]).toEqual({ cmd: 'read', args: [RECIPIENT] });
  });
});
