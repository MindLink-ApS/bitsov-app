import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import { EMOJIS, insertEmoji } from '../src/control/emoji';
import { safeImageMime } from '../src/control/frontDoorMedia';
import type { SpendView } from '../src/control/types';

const OWN = 'aa'.repeat(32);
const A = 'bb'.repeat(32);
const IN_ID = 'cc'.repeat(32);
const BIG_ID = 'dd'.repeat(32);
const IMG_ID = 'ee'.repeat(32);

type Reply = (args?: Record<string, unknown>) => unknown;
type Call = { cmd: string; args?: Record<string, unknown> };

const paired = {
  state: 'paired',
  short_code: null,
  paired_at_ms: Date.now(),
  scopes: ['read', 'receive', 'spend'],
  elevated: true,
  elevation_expires_at_ms: Date.now() + 86_400_000,
};

const openBudget = () => ({
  state: 'open' as const,
  basis: 'manual' as const,
  open_until_ms: Date.now() + 600_000,
  ceiling_msat: 100_000,
  spent_msat: 0,
  rows: [{ target: A, room: false, limit_msat: 50_000, spent_msat: 0 }],
  presets: [],
  window_ms: 600_000,
  max_daily_msat: 100_000_000,
  node_grant: null,
});

function stubHost(overrides: Record<string, Reply> = {}) {
  const calls: Call[] = [];
  const callbacks = new Map<number, (e: unknown) => void>();
  const spend: SpendView = { state: 'locked', basis: null, open_until_ms: null, pending: null, window_ms: 600_000 };
  const REPLIES: Record<string, Reply> = {
    node_status: () => ({ ready: true, node_id: OWN, error: null }),
    pairing_status: () => paired,
    node_overview: () => ({
      node_id: OWN, status: 'ok', version: 'api v2', connected_peers: 1, e2ee_sessions: 1, pending_deliveries: 0,
      lightning_available: true, block_height: 1, uptime_secs: 1, lightning_backend: 'ldk', chain_backend: 'esplora', read_at: Date.now(),
    }),
    peers_list: () => [{ node_id: A, addr: null, label: 'Maya', connected: true, fingerprint: null }],
    rooms_list: () => [],
    messages_list: () => [],
    price_quote: () => ({ kind: 0, own_msat: 1000, peer_msat: 2000, peer_age_secs: 30, peer_stale: false }),
    payments_overview: () => ({ balance_msat: 1_000_000, lightning_outbound_msat: 500_000, channels: [] }),
    fund_state: () => null,
    file_price: () => ({ principal_msat: 3000, max_routing_fee_msat: 5000, total_msat: 8000 }),
    spend_status: () => spend,
    budget_status: () => openBudget(),
    file_fetch: () => ({ filename: 'brief.txt', mime_type: 'text/plain', size_bytes: 2, data_b64: 'aGk=' }),
    file_save: () => ({ saved: true, filename: 'brief.txt', mime_type: 'text/plain', size_bytes: 2 }),
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
  return { used: (cmd: string) => calls.filter((c) => c.cmd === cmd) };
}

describe('emoji helpers', () => {
  it('inserts at the caret and replaces a selection', () => {
    expect(insertEmoji('hi', '👍', 2, 2)).toEqual({ next: 'hi👍', caret: 2 + '👍'.length });
    expect(insertEmoji('hello', '🔥', 1, 4)).toEqual({ next: 'h🔥o', caret: 1 + '🔥'.length });
    expect(EMOJIS.length).toBeGreaterThan(8);
  });
});

describe('received files and emoji in the thread', () => {
  let dispose: (() => void) | undefined;
  let mount: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });
  afterEach(() => {
    dispose?.();
    dispose = undefined;
    mount?.remove();
    vi.unstubAllGlobals();
  });

  const $ = <T extends Element = HTMLElement>(sel: string) => mount.querySelector<T>(sel);
  const text = (sel: string) => $(sel)?.textContent?.trim() ?? '';

  async function openShell() {
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => <App />, mount);
    await vi.waitFor(() => expect([...mount.querySelectorAll('button')].some((b) => b.textContent?.includes('I understand'))).toBe(true));
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
    await vi.waitFor(() => expect($(`[data-track="peer:${A}"]`)?.getAttribute('aria-current')).toBe('true'));
  }

  it('shows size and type, saves via the host, and previews only safe image mimes', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const host = stubHost({
      messages_list: () => [
        { id: IN_ID, kind: 200, sender: A, recipient: OWN, timestamp: Date.now() - 2000, plaintext: '[file: brief.txt]', payment_amount_msat: 3000 },
        { id: IMG_ID, kind: 200, sender: A, recipient: OWN, timestamp: Date.now() - 1000, plaintext: '[file: shot.png]', payment_amount_msat: 3000 },
        { id: BIG_ID, kind: 200, sender: A, recipient: OWN, timestamp: Date.now() - 500, plaintext: '[file: huge.bin]', payment_amount_msat: 3000 },
      ],
      file_fetch: (args) => {
        const id = String(args!.message_id);
        if (id === BIG_ID) throw 'file over 1.4 MB';
        if (id === IMG_ID) return { filename: 'shot.png', mime_type: 'image/png', size_bytes: 68, data_b64: png };
        if (id === IN_ID) return { filename: 'brief.txt', mime_type: 'text/plain', size_bytes: 2, data_b64: 'aGk=' };
        throw 'file not stored on this node';
      },
      file_save: (args) => {
        const id = String(args!.message_id);
        if (id === BIG_ID) throw 'file over 1.4 MB';
        return { saved: true, filename: 'brief.txt', mime_type: 'text/plain', size_bytes: 2 };
      },
    });
    await openShell();
    await vi.waitFor(() => expect($(`[data-received-file="${IN_ID}"]`)).not.toBeNull());
    expect(text(`[data-received-file="${IN_ID}"] [data-file-meta]`)).toMatch(/2 B · plain/);
    expect($(`[data-received-file="${IN_ID}"] [data-file-preview]`)).toBeNull();
    $<HTMLButtonElement>(`[data-received-file="${IN_ID}"] [data-file-save]`)!.click();
    await vi.waitFor(() => expect(host.used('file_save')).toHaveLength(1));
    expect(host.used('file_save')[0].args).toEqual({ message_id: IN_ID });
    await vi.waitFor(() => expect(text(`[data-received-file="${IN_ID}"] [data-file-save]`)).toBe('Saved'));

    await vi.waitFor(() => expect($(`[data-received-file="${IMG_ID}"] [data-file-preview]`)).not.toBeNull());
    expect(safeImageMime('image/png')).toBe('image/png');
    expect(safeImageMime('image/svg+xml')).toBeNull();
    expect(safeImageMime('text/html')).toBeNull();

    await vi.waitFor(() => expect(text(`[data-received-file="${BIG_ID}"] [data-file-meta]`)).toMatch(/Over 1\.4 MB/));
    expect($(`[data-received-file="${BIG_ID}"] [data-file-save]`)).toBeNull();
  });

  it('inserts a built-in emoji at the cursor in the composer', async () => {
    stubHost();
    await openShell();
    const ta = $<HTMLTextAreaElement>('[data-composer] textarea')!;
    ta.focus();
    ta.value = 'hi';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.setSelectionRange(2, 2);
    $<HTMLButtonElement>('[data-emoji]')!.click();
    await vi.waitFor(() => expect($('[data-emoji-picker]')).not.toBeNull());
    expect($('[data-emoji-picker]')!.querySelectorAll('[data-emoji-pick]').length).toBe(EMOJIS.length);
    $<HTMLButtonElement>('[data-emoji-pick="👍"]')!.click();
    await vi.waitFor(() => expect(ta.value).toBe('hi👍'));
    expect($('[data-emoji-picker]')).toBeNull();
  });
});
