import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { ROWS_GLOBAL } from '../src/assistant/rows';
import { SourceLabel } from '../src/assistant/SourceLabel';
import {
  FRESHNESS_GLOBAL,
  LIVE_ROWS_GLOBAL,
  SOURCE_GLOBAL,
  freshnessText,
  readFreshness,
  readView,
  summarize,
  type Freshness,
} from '../src/assistant/source';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MOCK_ROWS = [['q01', '500000']];
const LIVE_ROWS = [['q01', '777']];

/** Per-route bounds, as `broker/freshness.rs` `stale_after` sets them. */
const BOUND: Record<string, number> = {
  balance: 180_000,
  channels: 180_000,
  health: 60_000,
  messages: 60_000,
  pricing: 60_000,
};

/**
 * The host's shape, as `assistant_source.rs` writes it. Each route gets its
 * bound unless the entry sets one. Loosely typed so tests can hand over
 * malformed entries.
 */
function hostFreshness(routes: Record<string, unknown>[]) {
  return {
    routes: routes.map((route) =>
      'stale_after_ms' in route || typeof route.route !== 'string'
        ? route
        : { ...route, stale_after_ms: BOUND[route.route] ?? 60_000 },
    ),
  };
}

const ALL_FRESH = hostFreshness([
  { route: 'balance', state: 'fresh', age_ms: 12_000, clock_skew: false },
  { route: 'channels', state: 'fresh', age_ms: 11_900, clock_skew: false },
  { route: 'health', state: 'fresh', age_ms: 12_400, clock_skew: false },
  { route: 'messages', state: 'fresh', age_ms: 11_000, clock_skew: false },
  { route: 'pricing', state: 'fresh', age_ms: 10_000, clock_skew: false },
]);

function parsed(value: unknown): Freshness {
  const freshness = readFreshness({ [FRESHNESS_GLOBAL]: value });
  expect(freshness).not.toBeNull();
  return freshness as Freshness;
}

describe('freshness from the host global', () => {
  it('reads the exact host shape', () => {
    expect(parsed(ALL_FRESH)).toEqual({
      routes: [
        { route: 'balance', state: 'fresh', ageMs: 12_000, clockSkew: false, staleAfterMs: 180_000 },
        { route: 'channels', state: 'fresh', ageMs: 11_900, clockSkew: false, staleAfterMs: 180_000 },
        { route: 'health', state: 'fresh', ageMs: 12_400, clockSkew: false, staleAfterMs: 60_000 },
        { route: 'messages', state: 'fresh', ageMs: 11_000, clockSkew: false, staleAfterMs: 60_000 },
        { route: 'pricing', state: 'fresh', ageMs: 10_000, clockSkew: false, staleAfterMs: 60_000 },
      ],
    });
  });

  it.each([
    ['missing', undefined],
    ['a string', 'fresh'],
    ['an array', []],
    ['an extra key', { ...ALL_FRESH, extra: 1 }],
    ['the old top-level threshold', { stale_after_ms: 60_000, routes: [] }],
    [
      'a zero threshold',
      hostFreshness([
        { route: 'health', state: 'fresh', age_ms: 1, clock_skew: false, stale_after_ms: 0 },
      ]),
    ],
    [
      'a fractional threshold',
      hostFreshness([
        { route: 'health', state: 'fresh', age_ms: 1, clock_skew: false, stale_after_ms: 1.5 },
      ]),
    ],
    [
      'a missing threshold',
      {
        routes: [{ route: 'health', state: 'fresh', age_ms: 1, clock_skew: false }],
      },
    ],
    ['routes not a list', { routes: {} }],
    [
      'an unknown route',
      hostFreshness([{ route: 'payments/pay', state: 'fresh', age_ms: 1, clock_skew: false }]),
    ],
    [
      'a duplicate route',
      hostFreshness([
        { route: 'health', state: 'fresh', age_ms: 1, clock_skew: false },
        { route: 'health', state: 'fresh', age_ms: 1, clock_skew: false },
      ]),
    ],
    [
      'an unknown state',
      hostFreshness([{ route: 'health', state: 'live', age_ms: 1, clock_skew: false }]),
    ],
    [
      'a negative age',
      hostFreshness([{ route: 'health', state: 'fresh', age_ms: -1, clock_skew: false }]),
    ],
    [
      'a known state without an age',
      hostFreshness([{ route: 'health', state: 'fresh', age_ms: null, clock_skew: false }]),
    ],
    [
      'unknown with an age',
      hostFreshness([{ route: 'health', state: 'unknown', age_ms: 5, clock_skew: false }]),
    ],
    [
      'a non-boolean skew flag',
      hostFreshness([{ route: 'health', state: 'fresh', age_ms: 1, clock_skew: 'yes' }]),
    ],
    [
      'an extra route key',
      hostFreshness([
        { route: 'health', state: 'fresh', age_ms: 1, clock_skew: false, as_of: 1 },
      ]),
    ],
  ])('refuses %s', (_name, value) => {
    expect(readFreshness({ [FRESHNESS_GLOBAL]: value })).toBeNull();
  });
});

describe('freshness summary and text', () => {
  it('is fresh with the oldest route age, plus time the window has been open', () => {
    const summary = summarize(parsed(ALL_FRESH), 0);
    expect(summary).toEqual({ state: 'fresh', ageMs: 12_400, clockSkew: false });
    expect(freshnessText(summary)).toBe('Updated 12 s ago.');
    expect(summarize(parsed(ALL_FRESH), 30_000).ageMs).toBe(42_400);
  });

  it('turns stale when the open window crosses the host threshold', () => {
    const almost = summarize(parsed(ALL_FRESH), 60_000 - 12_400 - 1);
    expect(almost.state).toBe('fresh');
    const stale = summarize(parsed(ALL_FRESH), 60_000 - 12_400);
    expect(stale.state).toBe('stale');
    expect(freshnessText(stale)).toBe('Stale: updated 1 min ago. Reopen to refresh.');
  });

  it.each([
    ['balance', 180_000],
    ['channels', 180_000],
    ['health', 60_000],
    ['messages', 60_000],
    ['pricing', 60_000],
  ])('turns %s stale at its own bound (%i ms)', (route, bound) => {
    const freshness = parsed(
      hostFreshness([{ route, state: 'fresh', age_ms: 10_000, clock_skew: false }]),
    );
    expect(summarize(freshness, bound - 10_000 - 1).state).toBe('fresh');
    expect(summarize(freshness, bound - 10_000).state).toBe('stale');
  });

  it('keeps a balance one wallet sync old fresh while pricing at that age is stale', () => {
    const freshness = parsed(
      hostFreshness([
        { route: 'balance', state: 'fresh', age_ms: 80_000, clock_skew: false },
        { route: 'pricing', state: 'fresh', age_ms: 5_000, clock_skew: false },
      ]),
    );
    expect(summarize(freshness, 0, 'balance')).toEqual({
      state: 'fresh',
      ageMs: 80_000,
      clockSkew: false,
    });
    expect(summarize(freshness, 0, 'pricing').state).toBe('fresh');
    expect(summarize(freshness, 55_000, 'pricing').state).toBe('stale');
    expect(summarize(freshness, 55_000, 'balance').state).toBe('fresh');
    // The whole label is stale once any route is past its own bound.
    expect(summarize(freshness, 55_000).state).toBe('stale');
    expect(summarize(freshness, 0).state).toBe('fresh');
  });

  it('is unknown for one route the host did not report', () => {
    const freshness = parsed(
      hostFreshness([{ route: 'health', state: 'fresh', age_ms: 1_000, clock_skew: false }]),
    );
    expect(summarize(freshness, 0, 'channels').state).toBe('unknown');
  });

  it('keeps a host stale for one route whatever its age (Data-Stale: 1)', () => {
    const freshness = parsed(
      hostFreshness([{ route: 'balance', state: 'stale', age_ms: 1_000, clock_skew: false }]),
    );
    expect(summarize(freshness, 0, 'balance').state).toBe('stale');
  });

  it('is stale when the host already said a route was stale', () => {
    const freshness = parsed(
      hostFreshness([
        { route: 'health', state: 'fresh', age_ms: 1_000, clock_skew: false },
        { route: 'balance', state: 'stale', age_ms: 1_000, clock_skew: false },
      ]),
    );
    expect(summarize(freshness, 0).state).toBe('stale');
  });

  it('ignores routes with no freshness when others have one', () => {
    const freshness = parsed(
      hostFreshness([
        { route: 'health', state: 'fresh', age_ms: 3_000, clock_skew: false },
        { route: 'channels', state: 'unknown', age_ms: null, clock_skew: false },
      ]),
    );
    expect(summarize(freshness, 0)).toEqual({ state: 'fresh', ageMs: 3_000, clockSkew: false });
  });

  it.each([
    ['no freshness global', null],
    ['no routes', hostFreshness([])],
    [
      'only unknown routes',
      hostFreshness([{ route: 'health', state: 'unknown', age_ms: null, clock_skew: false }]),
    ],
  ])('is unknown with %s', (_name, value) => {
    const summary = summarize(value === null ? null : parsed(value), 90_000);
    expect(summary).toEqual({ state: 'unknown', ageMs: null, clockSkew: false });
    expect(freshnessText(summary)).toBe('Freshness unknown.');
  });

  it('says when the node clock ran ahead', () => {
    const freshness = parsed(
      hostFreshness([{ route: 'messages', state: 'fresh', age_ms: 2_000, clock_skew: true }]),
    );
    const summary = summarize(freshness, 0);
    expect(summary.clockSkew).toBe(true);
    expect(freshnessText(summary)).toBe(
      'Updated 2 s ago. Node clock is ahead of this computer.',
    );
  });

  it('formats minutes and hours', () => {
    expect(freshnessText({ state: 'stale', ageMs: 59_999, clockSkew: false })).toContain(
      'updated 59 s ago',
    );
    expect(freshnessText({ state: 'stale', ageMs: 125_000, clockSkew: false })).toContain(
      'updated 2 min ago',
    );
    expect(freshnessText({ state: 'stale', ageMs: 7_300_000, clockSkew: false })).toContain(
      'updated 2 h ago',
    );
  });
});

describe('source label freshness', () => {
  let dispose: (() => void) | undefined;
  let mount: HTMLElement | undefined;

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    mount?.remove();
    mount = undefined;
    vi.useRealTimers();
  });

  function show(props: Parameters<typeof SourceLabel>[0]): HTMLElement {
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => <SourceLabel {...props} />, mount);
    const label = mount.querySelector<HTMLElement>('[data-testid="source-label"]');
    expect(label).not.toBeNull();
    return label as HTMLElement;
  }

  function freshnessOf(label: HTMLElement): HTMLElement | null {
    return label.querySelector<HTMLElement>('[data-testid="source-freshness"]');
  }

  it('shows the age for a fresh live feed and ticks it with the window clock', () => {
    vi.useFakeTimers();
    let clock = 1_000;
    const label = show({
      source: { kind: 'live' },
      freshness: parsed(ALL_FRESH),
      now: () => clock,
    });
    const node = freshnessOf(label);
    expect(node?.dataset.freshness).toBe('fresh');
    expect(node?.textContent).toBe('Updated 12 s ago.');
    expect(label.textContent).toContain('Live');

    clock += 5_000;
    vi.advanceTimersByTime(5_000);
    expect(node?.textContent).toBe('Updated 17 s ago.');

    clock += 60_000;
    vi.advanceTimersByTime(60_000);
    expect(node?.dataset.freshness).toBe('stale');
    expect(node?.textContent).toBe('Stale: updated 1 min ago. Reopen to refresh.');
  });

  it('shows stale when the host handed over a stale read', () => {
    const label = show({
      source: { kind: 'live' },
      freshness: parsed(
        hostFreshness([{ route: 'health', state: 'stale', age_ms: 61_000, clock_skew: false }]),
      ),
    });
    expect(freshnessOf(label)?.dataset.freshness).toBe('stale');
    expect(freshnessOf(label)?.textContent).toContain('Stale');
    expect(label.classList.contains('source-stale')).toBe(true);
  });

  it('shows freshness unknown for live rows without a usable freshness global', () => {
    const label = show({ source: { kind: 'live' }, freshness: null });
    expect(freshnessOf(label)?.dataset.freshness).toBe('unknown');
    expect(freshnessOf(label)?.textContent).toBe('Freshness unknown.');
  });

  it.each(['not_paired', 'node_unreachable', 'rc7_fallback', 'unknown'] as const)(
    'makes no freshness claim for mock rows (%s)',
    (reason) => {
      const label = show({ source: { kind: 'mock', reason }, freshness: parsed(ALL_FRESH) });
      expect(label.textContent).toContain('Mock data');
      expect(freshnessOf(label)).toBeNull();
      expect(label.textContent).not.toMatch(/updated|stale|freshness/i);
    },
  );

  it('keeps the freshness text readable by assistive tech without a live region', () => {
    const label = show({ source: { kind: 'live' }, freshness: parsed(ALL_FRESH) });
    const node = freshnessOf(label) as HTMLElement;
    expect(node.getAttribute('aria-hidden')).toBeNull();
    expect(node.closest('[aria-live]')).toBeNull();
  });
});

describe('page wiring', () => {
  function hostDefine(name: string, value: unknown): void {
    Object.defineProperty(window, name, { value, writable: false, configurable: true });
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('network disabled')));
    hostDefine(ROWS_GLOBAL, MOCK_ROWS);
  });

  afterEach(() => {
    document.getElementById('root')?.remove();
    for (const name of [ROWS_GLOBAL, SOURCE_GLOBAL, LIVE_ROWS_GLOBAL, FRESHNESS_GLOBAL]) {
      delete (window as unknown as Record<string, unknown>)[name];
    }
    vi.unstubAllGlobals();
  });

  async function mountPage(): Promise<HTMLElement> {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);
    vi.resetModules();
    await import('../src/assistant/main');
    return root;
  }

  it('shows the host freshness on a live page', async () => {
    hostDefine(SOURCE_GLOBAL, { kind: 'live' });
    hostDefine(LIVE_ROWS_GLOBAL, LIVE_ROWS);
    hostDefine(FRESHNESS_GLOBAL, ALL_FRESH);
    const root = await mountPage();
    const node = root.querySelector<HTMLElement>('[data-testid="source-freshness"]');
    expect(node?.dataset.freshness).toBe('fresh');
    expect(node?.textContent).toMatch(/^Updated 1\d s ago\.$/);
  });

  it('drops a freshness global on a mock page', async () => {
    hostDefine(SOURCE_GLOBAL, { kind: 'mock', reason: 'node_unreachable' });
    hostDefine(FRESHNESS_GLOBAL, ALL_FRESH);
    expect(readView().freshness).toBeNull();
    const root = await mountPage();
    expect(root.querySelector('[data-testid="source-freshness"]')).toBeNull();
    expect(root.textContent).toContain('Mock data');
  });

  it('drops freshness when live falls back to mock for bad rows', () => {
    hostDefine(SOURCE_GLOBAL, { kind: 'live' });
    hostDefine(LIVE_ROWS_GLOBAL, [['q01', 5]]);
    hostDefine(FRESHNESS_GLOBAL, ALL_FRESH);
    const view = readView();
    expect(view.source.kind).toBe('mock');
    expect(view.freshness).toBeNull();
  });

  it('uses the global name and threshold the Rust host defines', () => {
    const host = readFileSync(
      resolve(rootDir, 'src-tauri/src/jarvis/assistant_source.rs'),
      'utf8',
    );
    expect(host).toContain(`FRESHNESS_GLOBAL: &str = "${FRESHNESS_GLOBAL}"`);
    const broker = readFileSync(
      resolve(rootDir, 'src-tauri/src/jarvis/broker/freshness.rs'),
      'utf8',
    );
    expect(broker).toContain('pub const STALE_AFTER: Duration = Duration::from_secs(60);');
    expect(broker).toContain(
      'pub const WALLET_STALE_AFTER: Duration = Duration::from_secs(180);',
    );
    expect(broker).toContain(
      'ReadRoute::PaymentsBalance | ReadRoute::PaymentsChannels => WALLET_STALE_AFTER,',
    );
    expect(broker).toContain(
      'ReadRoute::Health | ReadRoute::Messages { .. } | ReadRoute::OwnPricing => STALE_AFTER,',
    );
    expect(host).toContain('"stale_after_ms": stale_after(fresh.route)');
    for (const route of ['balance', 'channels', 'health', 'messages', 'pricing']) {
      expect(broker).toContain(`=> "${route}"`);
    }
    for (const state of ['fresh', 'stale', 'unknown']) {
      expect(broker).toContain(`=> "${state}"`);
    }
  });
});
