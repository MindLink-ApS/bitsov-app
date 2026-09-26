import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_ROWS_TEXT, ROWS_GLOBAL, readRows, rowsText } from '../src/assistant/rows';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

type FixtureQuestion = { id: string; expected: string; class: 'positive' | 'unavailable' };

/** Rows in the shape the host script defines, from the pinned fixture. */
function fixtureRows(): [string, string][] {
  const fixture = JSON.parse(
    readFileSync(resolve(rootDir, 'jarvis/fixtures/questions.json'), 'utf8'),
  ) as { questions: FixtureQuestion[] };
  return fixture.questions.map((q) => [q.id, q.class === 'positive' ? q.expected : 'Unavailable']);
}

function defineRows(value: unknown): void {
  Object.defineProperty(window, ROWS_GLOBAL, { value, configurable: true, writable: false });
}

async function mountPage(): Promise<HTMLElement> {
  const root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);
  vi.resetModules();
  await import('../src/assistant/main');
  return root;
}

describe('sealed assistant rows', () => {
  const network: string[] = [];
  const invokeCalls: unknown[] = [];

  beforeEach(() => {
    network.length = 0;
    invokeCalls.length = 0;
    vi.stubGlobal('__TAURI_INTERNALS__', {
      invoke: (...args: unknown[]) => {
        invokeCalls.push(args);
        return Promise.resolve(null);
      },
    });
    vi.stubGlobal('fetch', (input: unknown) => {
      network.push(String(input));
      return Promise.reject(new Error('network disabled'));
    });
    class NoSocket {
      constructor(url: string | URL) {
        network.push(`ws:${String(url)}`);
        throw new Error('network disabled');
      }
    }
    vi.stubGlobal('WebSocket', NoSocket);
    const OriginalXhr = globalThis.XMLHttpRequest;
    class SpyXhr extends OriginalXhr {
      override open(...args: unknown[]): void {
        network.push(`xhr:${String(args[1])}`);
        super.open(...(args as Parameters<XMLHttpRequest['open']>));
      }
    }
    vi.stubGlobal('XMLHttpRequest', SpyXhr);
  });

  afterEach(() => {
    document.getElementById('root')?.remove();
    delete (window as unknown as Record<string, unknown>)[ROWS_GLOBAL];
    vi.unstubAllGlobals();
  });

  it('renders all fifty fixture rows with no network and no commands', async () => {
    const rows = fixtureRows();
    expect(rows).toHaveLength(50);
    defineRows(Object.freeze(rows.map((row) => Object.freeze(row))));

    const root = await mountPage();
    const items = root.querySelectorAll('[data-testid="sit-row"]');
    expect(items).toHaveLength(50);
    items.forEach((item, index) => {
      const [id, answer] = rows[index];
      expect(item.querySelector('.sit-id')?.textContent).toBe(id);
      expect(item.querySelector('.sit-answer')?.textContent).toBe(answer);
    });
    expect(root.textContent).toContain('Unavailable');
    expect(root.querySelector('[data-testid="model-output"]')).toBeNull();

    expect(network).toEqual([]);
    expect(invokeCalls).toEqual([]);
  });

  it('is never blank when no rows were handed over', async () => {
    const root = await mountPage();
    expect(root.querySelectorAll('[data-testid="sit-row"]')).toHaveLength(0);
    expect(root.querySelector('[data-testid="model-output"]')?.textContent).toBe(NO_ROWS_TEXT);
    expect(network).toEqual([]);
  });

  it('renders row values as text, not markup', async () => {
    defineRows([['q01', '<img src=x onerror="globalThis.__rowsPwned=1">']]);
    const root = await mountPage();
    const answer = root.querySelector('.sit-answer');
    expect(answer?.textContent).toBe('<img src=x onerror="globalThis.__rowsPwned=1">');
    expect(answer?.childElementCount).toBe(0);
    expect(root.querySelector('img')).toBeNull();
  });

  it('refuses malformed row data', () => {
    const scope = (value: unknown) => ({ [ROWS_GLOBAL]: value });
    expect(readRows(scope(undefined))).toEqual([]);
    expect(readRows(scope('q01 1'))).toEqual([]);
    expect(readRows(scope([['q01']]))).toEqual([]);
    expect(readRows(scope([['q01', 5]]))).toEqual([]);
    expect(readRows(scope([['x01', '5']]))).toEqual([]);
    expect(readRows(scope([['q01', '']]))).toEqual([]);
    expect(readRows(scope(Array.from({ length: 51 }, () => ['q01', '1'])))).toEqual([]);
    expect(readRows(scope([['q01', '5']]))).toEqual([{ id: 'q01', answer: '5' }]);
    expect(rowsText([{ id: 'q01', answer: '5' }])).toBe('q01 5\n');
  });

  it('uses the global name the Rust host defines', () => {
    const sitMock = readFileSync(resolve(rootDir, 'src-tauri/src/jarvis/sit_mock.rs'), 'utf8');
    expect(sitMock).toContain(`ASSISTANT_ROWS_GLOBAL: &str = "${ROWS_GLOBAL}"`);
    const main = readFileSync(resolve(rootDir, 'src-tauri/src/main.rs'), 'utf8');
    expect(main).toContain(`'${ROWS_GLOBAL}'`);
    expect(main).toContain('.initialization_script(assistant_rows_script())');
  });
});
