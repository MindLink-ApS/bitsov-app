import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import { pairingLinkInboxAvailable, watchPairingLinks } from '../src/pairingDeepLink';
import type { PairingView } from '../src/onboarding/pairing';

// The native inbox (Android intent, iOS opened URL) is take-once and keeps only
// the newest link; the renderer queues it for review and never imports it.

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15)';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';

const paired: PairingView = {
  state: 'paired', scopes: ['read', 'receive'], short_code: 'ABCD-EFGH', code_from_node: true,
  reason: null, remote: true, bootstrap: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('pairing link inbox availability', () => {
  it('is on for Android and iOS Tauri webviews only', () => {
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    expect(pairingLinkInboxAvailable(ANDROID, 5)).toBe(true);
    expect(pairingLinkInboxAvailable(IPHONE, 5)).toBe(true);
    expect(pairingLinkInboxAvailable(IPAD, 5)).toBe(true);
    expect(pairingLinkInboxAvailable(MAC, 0)).toBe(false);
    vi.unstubAllGlobals();
    expect(pairingLinkInboxAvailable(IPHONE, 5)).toBe(false);
    expect(pairingLinkInboxAvailable(ANDROID, 5)).toBe(false);
  });
});

describe('watchPairingLinks', () => {
  it('takes a cold-launch link immediately, before the first polling interval', async () => {
    vi.useFakeTimers();
    let reads = 0;
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async () => { reads++; return reads === 1 ? 'bitsov://pair/synthetic' : null; } });
    const seen: string[] = [];
    const stop = watchPairingLinks(link => seen.push(link));
    expect(reads).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(750);
    expect(reads).toBe(2);
    expect(seen).toHaveLength(1);
    stop();
  });
  it('delivers each taken link once, skips empty reads and survives native errors', async () => {
    vi.useFakeTimers();
    const replies: (string | null | Error)[] = [new Error('inbox unavailable'), null, 'bitsov://pair/one', null, 'bitsov://pair/two'];
    const calls: string[] = [];
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: (cmd: string) => {
      calls.push(cmd);
      const next = replies.length ? replies.shift()! : null;
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    } });
    const error = vi.spyOn(console, 'error');
    const seen: string[] = [];
    const stop = watchPairingLinks(link => seen.push(link));
    await vi.advanceTimersByTimeAsync(750 * 6);
    expect(seen).toEqual(['bitsov://pair/one', 'bitsov://pair/two']);
    expect(new Set(calls)).toEqual(new Set(['pairing_link_take']));
    expect(error).not.toHaveBeenCalled();
    stop();
    const count = calls.length;
    replies.push('bitsov://pair/after-stop');
    await vi.advanceTimersByTimeAsync(750 * 4);
    expect(calls).toHaveLength(count);
    expect(seen).toHaveLength(2);
  });
});

describe.each([['iPhone', IPHONE], ['Android', ANDROID]])('%s pairing links', (_label, userAgent) => {
  let dispose: (() => void) | undefined;
  let mount: HTMLElement | undefined;
  afterEach(() => {
    dispose?.(); dispose = undefined;
    mount?.remove(); mount = undefined;
  });

  const start = (userAgent: string, inbox: { pending: string | null }, calls: string[]) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: (cmd: string) => {
      calls.push(cmd);
      if (cmd === 'pairing_link_take') { const link = inbox.pending; inbox.pending = null; return Promise.resolve(link); }
      if (cmd === 'node_status') return Promise.resolve({ ready: true, node_id: 'fa'.repeat(32), error: null });
      if (cmd === 'pairing_status') return Promise.resolve(paired);
      if (cmd === 'remote_access_preview') return Promise.resolve({ endpoint: 'home:4242', node_id_fingerprint: 'ab…cd' });
      return Promise.reject(new Error('not available'));
    } });
    mount = document.createElement('div'); document.body.appendChild(mount);
    dispose = render(() => <App />, mount);
  };

  it('queues an opened link for review, keeps only the newest, and never imports it', async () => {
    vi.useFakeTimers();
    const inbox = { pending: 'bitsov://pair/first-ticket' as string | null };
    const calls: string[] = [];
    start(userAgent, inbox, calls);
    await vi.advanceTimersByTimeAsync(100);
    expect(mount!.querySelector('[data-pairing-link-banner]')).not.toBeNull();
    // Opening a link only queues it: no review screen until the owner asks.
    expect(mount!.querySelector('[data-pairing-link-screen]')).toBeNull();
    inbox.pending = 'bitsov://pair/newest-ticket';
    await vi.advanceTimersByTimeAsync(750);
    mount!.querySelector<HTMLButtonElement>('[data-review-pairing]')!.click();
    await vi.advanceTimersByTimeAsync(1);
    const input = mount!.querySelector<HTMLInputElement>('[data-pairing-link-screen] input')!;
    expect(input.value).toBe('bitsov://pair/newest-ticket');
    await vi.advanceTimersByTimeAsync(750 * 4);
    expect(calls).not.toContain('remote_access_import');
    expect(calls).not.toContain('remote_access_replace');
    mount!.querySelector<HTMLButtonElement>('[data-close-pairing]')!.click();
    expect(mount!.querySelector('[data-pairing-link-screen]')).toBeNull();
    expect(mount!.querySelector('[data-pairing-link-banner]')).toBeNull();
  });

  it('retries a failed connect from Review after the native inbox has consumed the link', async () => {
    vi.useFakeTimers();
    const link = 'bitsov://pair/retry-ticket';
    const inbox = { pending: link as string | null };
    const calls: string[] = [];
    start(userAgent, inbox, calls);
    const invoke = (globalThis as any).__TAURI_INTERNALS__.invoke;
    const attempts: string[] = [];
    (globalThis as any).__TAURI_INTERNALS__.invoke = (cmd: string, args?: { link: string }) => {
      if (cmd === 'remote_access_connect') {
        attempts.push(args!.link);
        return attempts.length === 1
          ? Promise.reject({ kind: 'busy', detail: 'Try again shortly.' })
          : Promise.resolve({ endpoint: 'home:4242', node_id_fingerprint: 'ab…cd', restart_required: false });
      }
      return invoke(cmd, args);
    };
    await vi.advanceTimersByTimeAsync(100);
    mount!.querySelector<HTMLButtonElement>('[data-review-pairing]')!.click();
    await vi.advanceTimersByTimeAsync(1);
    const form = mount!.querySelector<HTMLFormElement>('[data-pairing-link-screen] form')!;
    form.requestSubmit();
    await vi.advanceTimersByTimeAsync(1);
    form.requestSubmit();
    await vi.advanceTimersByTimeAsync(1500);
    expect(inbox.pending).toBeNull();
    expect(mount!.textContent).toContain('Try again shortly.');
    expect(mount!.querySelector('[data-pairing-preview]')).not.toBeNull();
    expect(mount!.querySelector<HTMLInputElement>('[data-pairing-link-screen] input')!.value).toBe(link);
    expect(attempts).toEqual([link]);
    form.requestSubmit();
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toEqual([link, link]);
    expect(mount!.querySelector('[data-import-result]')).not.toBeNull();
    expect(mount!.querySelector<HTMLInputElement>('[data-pairing-link-screen] input')!.value).toBe('');
  });

  it('a dismissed link is gone; the desktop app never polls the inbox', async () => {
    vi.useFakeTimers();
    const inbox = { pending: 'bitsov://pair/unwanted' as string | null };
    const calls: string[] = [];
    start(userAgent, inbox, calls);
    await vi.advanceTimersByTimeAsync(100);
    const dismiss = [...mount!.querySelectorAll<HTMLButtonElement>('[data-pairing-link-banner] button')].find(b => b.textContent === 'Dismiss link')!;
    dismiss.click();
    await vi.advanceTimersByTimeAsync(750 * 2);
    expect(mount!.querySelector('[data-pairing-link-banner]')).toBeNull();
    dispose!(); dispose = undefined; mount!.remove();

    const desktopCalls: string[] = [];
    start(MAC, { pending: 'bitsov://pair/ignored' }, desktopCalls);
    await vi.advanceTimersByTimeAsync(750 * 3);
    expect(desktopCalls).not.toContain('pairing_link_take');
    expect(mount!.querySelector('[data-pairing-link-banner]')).toBeNull();
  });
});
