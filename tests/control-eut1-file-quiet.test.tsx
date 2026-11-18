import { setLanguagePref } from '../src/i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import type { PairingView } from '../src/onboarding/pairing';
import { admissionCopy, deliveryFromReceipt, undeliveredCopy } from '../src/control/state';
import type { LiveEvent, SpendView, BudgetView } from '../src/control/types';

const OWN = '1'.repeat(64);
const A = 'a'.repeat(64);
const WINDOW = 600_000;
const DAY = 86_400_000;
const paired: PairingView = { state: 'paired', scopes: ['read', 'receive'], short_code: 'ABCD-EFGH', code_from_node: true, reason: null, remote: false, bootstrap: null };

type Call = { cmd: string; args: Record<string, unknown> | undefined };
type Reply = (args?: Record<string, unknown>) => unknown;

const openBudget = (): BudgetView => ({
  paused: false,
  waiting_for_owner: false,
  ceiling_msat: 500_000,
  max_daily_msat: 100_000_000,
  spent_msat: 0,
  unsettled_msat: 0,
  preset: 'careful',
  presets: [{ id: 'careful', contact_msat: 50_000, room_msat: 100_000, ceiling_msat: 500_000 }],
  rows: [{ target: A, room: false, limit_msat: 50_000, spent_msat: 0 }],
  autopay: { state: 'open', open_until_ms: Date.now() + DAY, ceiling_msat: 500_000, basis: 'node_grant' },
  window_ms: DAY,
  node_grant: null,
});

function stubHost(overrides: Record<string, Reply> = {}) {
  const calls: Call[] = [];
  const callbacks = new Map<number, (e: unknown) => void>();
  const spend: { v: SpendView } = { v: { state: 'locked', basis: null, open_until_ms: null, pending: null, window_ms: WINDOW } };
  const budget = { v: openBudget() };
  const REPLIES: Record<string, Reply> = {
    node_status: () => ({ ready: true, node_id: OWN, error: null }),
    trust_acknowledge: () => true,
    pairing_status: () => paired,
    node_overview: () => ({
      node_id: OWN, status: 'ok', version: 'api v2', connected_peers: 1, e2ee_sessions: 1, pending_deliveries: 0,
      lightning_available: true, block_height: 1, uptime_secs: 1, lightning_backend: 'ldk', chain_backend: 'esplora', read_at: Date.now(),
    }),
    peers_list: () => [{ node_id: A, addr: null, label: 'Maya', connected: true, fingerprint: null }],
    rooms_list: () => [],
    messages_list: () => [],
    price_quote: () => ({ kind: 0, own_msat: 1000, peer_msat: 2000, peer_age_secs: 30, max_routing_fee_msat: 0, peer_stale: false }),
    payments_overview: () => ({ balance_msat: 1_000_000, lightning_outbound_msat: 500_000, channels: [] }),
    fund_state: () => null,
    file_price: () => ({ principal_msat: 3000, max_routing_fee_msat: 5000, total_msat: 8000 }),
    spend_status: () => spend.v,
    budget_status: () => budget.v,
    message_send: (args) => ({
      message_id: 'msg-acked', recipient: args!.recipient, is_room: false, delivered: true, amount_msat: 2000,
      sent_at_ms: Date.now(), accepted: true, state: 'acked', operation_id: 'op-1',
    }),
    file_send: (args) => ({
      message_id: 'file-acked', recipient: args!.recipient, filename: args!.filename, size_bytes: 2,
      delivered: true, amount_msat: 3000, total_msat: 8000, max_routing_fee_msat: 5000, sent_at_ms: Date.now(),
      accepted: true, state: 'acked',
    }),
    live_link: () => null,
    'plugin:event|listen': () => 1,
    'plugin:event|unlisten': () => null,
    ...overrides,
  };
  vi.stubGlobal('__TAURI_INTERNALS__', {
    transformCallback: (cb: (e: unknown) => void) => {
      const id = callbacks.size + 1;
      callbacks.set(id, cb);
      return id;
    },
    invoke: (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      const reply = REPLIES[cmd];
      if (!reply) return Promise.reject(new Error(`unexpected ${cmd}`));
      try { return Promise.resolve(reply(args)); } catch (e) { return Promise.reject(e); }
    },
  });
  vi.stubGlobal('__TAURI_EVENT_PLUGIN_INTERNALS__', { unregisterListener: () => {} });
  return {
    used: (cmd: string) => calls.filter((c) => c.cmd === cmd),
    emitLive: (payload: LiveEvent) => {
      const listen = calls.find((c) => c.cmd === 'plugin:event|listen');
      callbacks.get(listen!.args!.handler as number)!({ event: 'node-live', id: 1, payload });
    },
  };
}

describe('EUT-1: file send, quiet copy, delivery tick', () => {
  let dispose: (() => void) | undefined;
  let mount: HTMLElement;

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    mount?.remove();
    vi.unstubAllGlobals();
  });

  const $ = <T extends Element = HTMLElement>(sel: string) => mount.querySelector<T>(sel);
  const text = (sel: string) => $(sel)?.textContent ?? '';

  async function openShell() {
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => <App />, mount);
    await vi.waitFor(() => expect([...mount.querySelectorAll('button')].some((b) => b.hasAttribute('data-trust-continue'))).toBe(true));
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.hasAttribute('data-trust-continue'))!.click();
    await vi.waitFor(() => expect($(`[data-track="peer:${A}"]`)?.getAttribute('aria-current')).toBe('true'));
  }

  it('wires the File tab through the open budget and shows a file bubble with an acked tick', async () => {
    const host = stubHost();
    await openShell();
    $<HTMLButtonElement>('[data-composer-mode="file"]')!.click();
    const input = $<HTMLInputElement>('[data-file-input]')!;
    Object.defineProperty(input, 'files', { value: [new File(['hi'], 'brief.txt', { type: 'text/plain' })] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(text('[data-send]')).toMatch(/^Send · up to 8 sats$/));
    $<HTMLButtonElement>('[data-send]')!.click();
    await vi.waitFor(() => expect(host.used('file_send')).toHaveLength(1));
    expect(host.used('file_send')[0].args).toMatchObject({
      recipient: A, filename: 'brief.txt', mime_type: 'text/plain', data_b64: 'aGk=', max_msat: 8000,
    });
    await vi.waitFor(() => expect(text('[data-message="file-acked"] .file-name')).toBe('brief.txt'));
    const mark = $('[data-message="file-acked"] [data-delivery]')!;
    expect(mark.getAttribute('data-delivery')).toBe('accepted');
    expect(mark.textContent?.trim()).toBe('');
    expect(mark.getAttribute('aria-label')).toBe('Delivered');
  });

  it.each([
    ['en', 'an approved contact', true, 'Send · up to 8 sats'],
    ['en', 'a first contact', false, 'Send first file · up to 8 sats'],
    ['da', 'an approved contact', true, 'Send · højst 8 sats'],
    ['da', 'a first contact', false, 'Send første fil · højst 8 sats'],
  ] as const)('%s: a budget-backed file button to %s shows its cost as a ceiling', async (lang, _case, approved, label) => {
    setLanguagePref(lang);
    stubHost(approved ? {} : { budget_status: () => ({ ...openBudget(), rows: [] }) });
    try {
      await openShell();
      $<HTMLButtonElement>('[data-composer-mode="file"]')!.click();
      const input = $<HTMLInputElement>('[data-file-input]')!;
      Object.defineProperty(input, 'files', { value: [new File(['hi'], 'brief.txt', { type: 'text/plain' })] });
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await vi.waitFor(() => expect(text('[data-send]')).toBe(label));
      expect($('[data-send]')!.getAttribute('aria-label')).toBe(label);
    } finally { setLanguagePref('en'); }
  });

  it('says what is next after an approval with a file chosen, then sends on the next press', async () => {
    let paused = true;
    const host = stubHost({
      budget_status: () => ({ ...openBudget(), paused }),
      budget_resume: () => { paused = false; return openBudget(); },
    });
    await openShell();
    $<HTMLButtonElement>('[data-composer-mode="file"]')!.click();
    const input = $<HTMLInputElement>('[data-file-input]')!;
    Object.defineProperty(input, 'files', { value: [new File(['hi'], 'brief.txt', { type: 'text/plain' })] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-send]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-send]')!.click();
    await vi.waitFor(() => expect(host.used('budget_resume')).toHaveLength(1));
    await vi.waitFor(() => expect(mount.textContent).toMatch(/Approved\. Press Send to send it\./));
    expect(host.used('file_send')).toHaveLength(0);
    await vi.waitFor(() => expect(text('[data-send]')).toMatch(/^Send · up to 8 sats$/));
    $<HTMLButtonElement>('[data-send]')!.click();
    await vi.waitFor(() => expect(host.used('file_send')).toHaveLength(1));
  });

  it('shows a single tick on an acked message bubble', async () => {
    stubHost();
    await openShell();
    const ta = $<HTMLTextAreaElement>('[data-composer] textarea')!;
    ta.value = 'ping';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(text('[data-send-price]')).toMatch(/^up to /));
    $<HTMLButtonElement>('[data-send]')!.click();
    await vi.waitFor(() => expect($('[data-message="msg-acked"] [data-delivery]')?.getAttribute('data-delivery')).toBe('accepted'));
    expect(text('[data-message="msg-acked"] [data-delivery]').trim()).toBe('');
  });

  it('keeps money-safety facts in quiet undelivered copy', () => {
    const retry = undeliveredCopy({ paid_msat: 2000, retry: true });
    expect(retry.body.split('\n')).toHaveLength(1);
    expect(retry.detail.toLowerCase()).toMatch(/proof|pending|paid/);
    expect(`${retry.title} ${retry.body} ${retry.detail}`.toLowerCase()).toMatch(/paid|do not send|retry/);
    const adm = admissionCopy({ admission_msat: 1500, message_msat: 2000, total_msat: 3500, quoted: true });
    expect(adm.body.split('\n')).toHaveLength(1);
    expect(adm.detail).toContain('1.5 sats');
    expect(deliveryFromReceipt({ delivered: true, accepted: true, state: 'acked' }).status).toBe('accepted');
  });
});
