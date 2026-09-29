import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROWS_GLOBAL } from '../src/assistant/rows';
import { LIVE_ROWS_GLOBAL, SOURCE_GLOBAL, readSource } from '../src/assistant/source';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MOCK_ROWS = [
  ['q01', '500000'],
  ['q02', '52500000'],
];
const LIVE_ROWS = [
  ['q01', '777'],
  ['q02', 'Unavailable'],
];

/** Host-style read-only global. Configurable only so `afterEach` can remove it. */
function hostDefine(name: string, value: unknown): void {
  Object.defineProperty(window, name, { value, writable: false, configurable: true });
}

async function mountPage(): Promise<HTMLElement> {
  const root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);
  vi.resetModules();
  await import('../src/assistant/main');
  return root;
}

function shown(root: HTMLElement): [string, string][] {
  return Array.from(root.querySelectorAll('[data-testid="sit-row"]')).map((row) => [
    row.querySelector('.sit-id')?.textContent ?? '',
    row.querySelector('.sit-answer')?.textContent ?? '',
  ]);
}

function label(root: HTMLElement): HTMLElement {
  const el = root.querySelector<HTMLElement>('[data-testid="source-label"]');
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

describe('assistant source label', () => {
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
    hostDefine(ROWS_GLOBAL, MOCK_ROWS);
  });

  afterEach(() => {
    document.getElementById('root')?.remove();
    for (const name of [ROWS_GLOBAL, SOURCE_GLOBAL, LIVE_ROWS_GLOBAL]) {
      delete (window as unknown as Record<string, unknown>)[name];
    }
    vi.unstubAllGlobals();
  });

  it('shows live rows and a Live label when the host says live', async () => {
    hostDefine(SOURCE_GLOBAL, { kind: 'live' });
    hostDefine(LIVE_ROWS_GLOBAL, LIVE_ROWS);
    const root = await mountPage();
    expect(label(root).dataset.source).toBe('live');
    expect(label(root).textContent).toContain('From your node');
    expect(label(root).textContent).not.toContain('Mock');
    expect(shown(root)).toEqual(LIVE_ROWS);
    expect(network).toEqual([]);
    expect(invokeCalls).toEqual([]);
  });

  it.each([
    ['not_paired', 'Not paired with a node'],
    ['node_unreachable', 'Node unreachable'],
    ['rc7_fallback', 'Your node version has no pairing'],
  ])('shows mock rows labelled Sample data with reason %s', async (reason, text) => {
    hostDefine(SOURCE_GLOBAL, { kind: 'mock', reason });
    const root = await mountPage();
    expect(label(root).dataset.source).toBe('mock');
    expect(label(root).dataset.reason).toBe(reason);
    expect(label(root).textContent).toContain('Sample data');
    expect(label(root).textContent).toContain(text);
    expect(shown(root)).toEqual(MOCK_ROWS);
  });

  it('is Sample data when the host set no source, even if live rows exist', async () => {
    hostDefine(LIVE_ROWS_GLOBAL, LIVE_ROWS);
    const root = await mountPage();
    expect(label(root).dataset.source).toBe('mock');
    expect(label(root).textContent).toContain('Sample data');
    expect(label(root).textContent).toContain('Source unknown');
    expect(shown(root)).toEqual(MOCK_ROWS);
  });

  it('falls back to Sample data when live rows are missing or malformed', async () => {
    hostDefine(SOURCE_GLOBAL, { kind: 'live' });
    hostDefine(LIVE_ROWS_GLOBAL, [['q01', 5]]);
    const root = await mountPage();
    expect(label(root).dataset.source).toBe('mock');
    expect(label(root).textContent).toContain('Sample data');
    expect(shown(root)).toEqual(MOCK_ROWS);
  });

  it('keeps the label when there are no rows at all', async () => {
    delete (window as unknown as Record<string, unknown>)[ROWS_GLOBAL];
    hostDefine(SOURCE_GLOBAL, { kind: 'mock', reason: 'not_paired' });
    const root = await mountPage();
    expect(label(root).textContent).toContain('Sample data');
    expect(root.querySelector('[data-testid="model-output"]')).not.toBeNull();
  });

  it('refuses anything but the exact host shapes', () => {
    const scope = (value: unknown) => ({ [SOURCE_GLOBAL]: value });
    const unknown = { kind: 'mock', reason: 'unknown' };
    expect(readSource(scope(undefined))).toEqual(unknown);
    expect(readSource(scope('live'))).toEqual(unknown);
    expect(readSource(scope({ kind: 'LIVE' }))).toEqual(unknown);
    expect(readSource(scope({ kind: 'live', reason: 'not_paired' }))).toEqual(unknown);
    expect(readSource(scope({ kind: 'mock' }))).toEqual(unknown);
    expect(readSource(scope({ kind: 'mock', reason: '<img src=x>' }))).toEqual(unknown);
    expect(readSource(scope({ kind: 'mock', reason: 'not_paired', extra: 1 }))).toEqual(unknown);
    expect(readSource(scope([]))).toEqual(unknown);
    expect(readSource(scope({ kind: 'live' }))).toEqual({ kind: 'live' });
    expect(readSource(scope({ kind: 'mock', reason: 'rc7_fallback' }))).toEqual({
      kind: 'mock',
      reason: 'rc7_fallback',
    });
  });

  it('uses the global names the Rust host defines', () => {
    const host = readFileSync(
      resolve(rootDir, 'src-tauri/src/jarvis/assistant_source.rs'),
      'utf8',
    );
    expect(host).toContain(`SOURCE_GLOBAL: &str = "${SOURCE_GLOBAL}"`);
    expect(host).toContain(`LIVE_ROWS_GLOBAL: &str = "${LIVE_ROWS_GLOBAL}"`);
    for (const reason of ['not_paired', 'node_unreachable', 'rc7_fallback']) {
      expect(host).toContain(`"${reason}"`);
    }
  });
});
