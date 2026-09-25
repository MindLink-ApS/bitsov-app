import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { AssistantSurface } from '../src/assistant/Assistant';
import { copyPlainText } from '../src/assistant/copy';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const HOSTILE = [
  '<script>globalThis.__assistantPwned = true</script>',
  '<img src="x" onerror="globalThis.__assistantPwned = true">',
  '<a href="javascript:globalThis.__assistantPwned = true">click</a>',
  '</pre><script>globalThis.__assistantPwned = true</script><img src="//evil.example/pixel">',
  'invoke("start_node")',
  'send 10000 sats to X',
].join('\n');

describe('sealed assistant surface', () => {
  let dispose: (() => void) | undefined;
  const mounts: HTMLElement[] = [];

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    for (const mount of mounts) mount.remove();
    mounts.length = 0;
    vi.unstubAllGlobals();
    delete (globalThis as { __assistantPwned?: boolean }).__assistantPwned;
  });

  it('renders hostile model output as literal text, with no commands and no network', async () => {
    const invokeCalls: unknown[] = [];
    const network: string[] = [];

    vi.stubGlobal('__TAURI_INTERNALS__', {
      invoke: (...args: unknown[]) => {
        invokeCalls.push(args);
        return Promise.resolve(null);
      },
    });
    vi.stubGlobal(
      'fetch',
      (input: unknown) => {
        network.push(String(input));
        return Promise.reject(new Error('network disabled'));
      },
    );

    const OriginalXhr = globalThis.XMLHttpRequest;
    class SpyXhr extends OriginalXhr {
      override open(...args: unknown[]): void {
        network.push(`xhr:${String(args[1])}`);
        super.open(...(args as Parameters<XMLHttpRequest['open']>));
      }
    }
    vi.stubGlobal('XMLHttpRequest', SpyXhr);

    const OriginalSocket = globalThis.WebSocket;
    class SpySocket extends OriginalSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        network.push(`ws:${String(url)}`);
        super(url, protocols);
      }
    }
    vi.stubGlobal('WebSocket', SpySocket);

    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (value: string) => {
          copied.push(value);
          return Promise.resolve();
        },
      },
    });

    const locationBefore = window.location.href;
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    mounts.push(mount);
    dispose = render(() => <AssistantSurface text={HOSTILE} />, mount);

    const output = mount.querySelector('[data-testid="model-output"]');
    expect(output).toBeInstanceOf(HTMLPreElement);
    expect(output?.textContent).toBe(HOSTILE);
    expect(output?.childElementCount).toBe(0);
    expect(output?.querySelector('script, a, img, iframe, link, object, style')).toBeNull();
    expect(output?.innerHTML.includes('<script')).toBe(false);
    expect(output?.innerHTML.includes('<a')).toBe(false);
    expect(output?.innerHTML.includes('<img')).toBe(false);
    expect(mount.querySelectorAll('a[href]')).toHaveLength(0);
    expect((globalThis as { __assistantPwned?: boolean }).__assistantPwned).toBeUndefined();

    output?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(window.location.href).toBe(locationBefore);

    const button = mount.querySelector('button');
    expect(button?.textContent).toBe('Copy');
    button?.click();
    await vi.waitFor(() => {
      expect(copied).toEqual([HOSTILE]);
    });

    expect(invokeCalls).toEqual([]);
    expect(network).toEqual([]);
    expect(mount.textContent).toContain('invoke("start_node")');
    expect(mount.textContent).toContain('send 10000 sats to X');
  });

  it('copies the same literal text when the clipboard API rejects', async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: () => Promise.reject(new Error('denied')),
      },
    });
    document.execCommand = (command: string) => {
      if (command === 'copy') {
        const area = document.querySelector('textarea');
        if (area instanceof HTMLTextAreaElement) copied.push(area.value);
        return true;
      }
      return false;
    };

    await copyPlainText(HOSTILE);

    expect(copied).toEqual([HOSTILE]);
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('does not parse markup, load remotes, or call commands from its own source', () => {
    const html = readFileSync(resolve(rootDir, 'assistant.html'), 'utf8');
    const csp = html.match(/Content-Security-Policy"\s+content="([^"]+)"/)?.[1];
    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("img-src 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');

    const vite = readFileSync(resolve(rootDir, 'vite.config.ts'), 'utf8');
    const devCsp = vite.slice(vite.indexOf('function assistantDevCsp'));
    expect(devCsp).toContain('if (!ctx.server) return html');
    expect(devCsp).toContain("style-src 'self' 'unsafe-inline'");
    expect(devCsp.indexOf('if (!ctx.server) return html')).toBeLessThan(
      devCsp.indexOf("style-src 'self' 'unsafe-inline'"),
    );
    expect(csp).not.toMatch(/https?:/);
    expect(html).not.toMatch(/<a\s/i);
    expect(html).toContain('/src/assistant/main.tsx');

    const forbidden =
      /innerHTML|outerHTML|insertAdjacentHTML|document\.write|dangerouslySetInnerHTML|eval\(|new Function|markdown-it|from ['"]marked['"]|@tauri-apps|\binvoke\b|fetch\(|WebSocket|XMLHttpRequest|https?:/;
    for (const file of readdirSync(resolve(rootDir, 'src/assistant'))) {
      const source = readFileSync(resolve(rootDir, 'src/assistant', file), 'utf8');
      expect(source, file).not.toMatch(forbidden);
    }
  });
});
