import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { AssistantPage } from '../src/assistant/Page';
import { endpointBadge, OWN_RULES, PRESET_WORDS, widestExposure } from '../src/assistant/endpoint';
import type { ProviderView } from '../src/control/types';

const shared: ProviderView = {
  kind: 'shared',
  label: 'Shared open model',
  enabled: true,
  host: 'models.example.org',
  model: 'open-8b',
  note: null,
  pays: { to: 'models.example.org', rail: 'fiat' },
  data_leaves: 'counts',
};
const frontier: ProviderView = {
  ...shared,
  kind: 'frontier',
  label: 'Frontier model',
  host: 'api.vendor.example',
  model: 'big-1',
  pays: { to: 'api.vendor.example', rail: 'fiat' },
};

describe('endpoint badge text', () => {
  it('Own: on this computer, nobody paid, nothing leaves', () => {
    const b = endpointBadge(OWN_RULES);
    expect(b).toMatchObject({
      tier: 'own',
      name: 'Own',
      where: 'On this computer · rules',
      paid: 'Nobody is paid',
      leaves: 'Nothing leaves',
    });
    expect(endpointBadge({ ...OWN_RULES, model: 'small-3b' }).where).toBe('On this computer · small-3b');
  });

  it('Shared open: who is paid and that only the previewed preset leaves', () => {
    const b = endpointBadge(shared);
    expect(b.tier).toBe('shared');
    expect(b.name).toBe('Shared open');
    expect(b.where).toBe('open-8b at models.example.org');
    expect(b.paid).toBe('Paid: models.example.org, your API key');
    expect(b.leaves).toBe('Leaves: the preview you send, counts only');
    expect(endpointBadge(shared, 'exact').leaves).toBe(`Leaves: the preview you send, ${PRESET_WORDS.exact}`);
    // A keyless model server is not billed through this app.
    expect(endpointBadge({ ...shared, host: '127.0.0.1', pays: { to: null, rail: 'none' } }).paid).toBe(
      'Nobody is paid by this app',
    );
  });

  it('Frontier: red tier, the vendor is paid, and vendor terms apply', () => {
    const b = endpointBadge(frontier, 'rounded');
    expect(b.tier).toBe('frontier');
    expect(b.name).toBe('Frontier');
    expect(b.paid).toBe('Paid: api.vendor.example, your API key');
    expect(b.leaves).toBe('Leaves: the preview you send, rounded figures; vendor terms apply');
    expect(b.text).toBe(`Frontier · big-1 at api.vendor.example · ${b.paid} · ${b.leaves}`);
  });

  it('a remote that is off lets nothing leave and pays nobody', () => {
    const off: ProviderView = { ...frontier, enabled: false, host: null, pays: { to: null, rail: 'none' }, data_leaves: null };
    expect(endpointBadge(off)).toMatchObject({ tier: 'frontier', paid: 'Nobody is paid', leaves: 'Nothing leaves' });
  });
});

describe('widest exposure', () => {
  it('a pending remote preview outranks an Own selection, and a wider preset a narrower one', () => {
    const own = { provider: OWN_RULES, previewed: null };
    expect(widestExposure([own]).provider.kind).toBe('local');
    expect(widestExposure([own, { provider: shared, previewed: 'counts' }]).provider.kind).toBe('shared');
    expect(widestExposure([{ provider: shared, previewed: null }, { provider: frontier, previewed: 'counts' }]).provider.kind).toBe(
      'frontier',
    );
    expect(widestExposure([{ provider: shared, previewed: null }, { provider: shared, previewed: 'exact' }]).previewed).toBe('exact');
    // An off remote lets nothing leave: it never outranks Own.
    const off: ProviderView = { ...frontier, enabled: false, data_leaves: null, pays: { to: null, rail: 'none' } };
    expect(widestExposure([own, { provider: off, previewed: null }]).provider.kind).toBe('local');
    expect(widestExposure([]).provider).toBe(OWN_RULES);
  });

  it('a keyed model server on this computer is billed to your key, not a named host', () => {
    for (const host of ['127.0.0.1', '::1']) {
      const local: ProviderView = { ...shared, host, pays: { to: host, rail: 'fiat' } };
      expect(endpointBadge(local).paid).toBe('Paid: your API key (local endpoint)');
    }
  });
});

describe('the sealed assistant window', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => {
    dispose?.();
    document.body.innerHTML = '';
  });

  it('shows the same Own badge as the AI track, with the unified source label', () => {
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(
      () => <AssistantPage view={{ source: { kind: 'mock', reason: 'rc7_fallback' }, rows: [], freshness: null }} />,
      mount,
    );
    const badge = mount.querySelector('[data-testid="endpoint-badge"]')!;
    expect(badge.getAttribute('data-tier')).toBe('own');
    expect(badge.getAttribute('role')).toBe('status');
    expect(badge.getAttribute('aria-label')).toContain('Own · On this computer');
    expect(badge.textContent).toContain('Own');
    expect(badge.textContent).toContain('Nobody is paid');
    expect(badge.textContent).toContain('Nothing leaves');
    const label = mount.querySelector('[data-testid="source-label"]')!.textContent!;
    expect(label).toContain('Sample data');
    expect(label).not.toContain('Mock data');
    expect(label).not.toContain('rc7');
  });
});

// ---- contrast: AA for every badge text colour, both themes ---------------------

function tokens(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const block = css.slice(start, css.indexOf('}', start));
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})/g)) out[m[1]] = m[2];
  return out;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('endpoint badge contrast', () => {
  const badgeCss = readFileSync(join(__dirname, '../src/assistant/endpoint.css'), 'utf8');
  const appCss = readFileSync(join(__dirname, '../src/styles.css'), 'utf8');
  const themes = {
    dark: { badge: tokens(badgeCss, ':root'), app: tokens(appCss, ':root') },
    light: { badge: tokens(badgeCss, "html[data-theme='light']"), app: tokens(appCss, "html[data-theme='light']") },
  };

  it.each(Object.entries(themes))('meets WCAG AA in the %s theme', (_, t) => {
    for (const tier of ['own', 'shared', 'frontier']) {
      const bg = t.badge[`--badge-${tier}-bg`];
      const ink = t.badge[`--badge-${tier}-ink`];
      expect(contrast(ink, bg), `${tier} ink on its pill`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.badge['--badge-fact'], bg), `${tier} facts on its pill`).toBeGreaterThanOrEqual(4.5);
      // The selected provider's meta text sits on --raised.
      expect(contrast(ink, t.app['--raised']), `${tier} ink on raised`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('the three tiers stay visibly distinct', () => {
    for (const t of Object.values(themes)) {
      const inks = ['own', 'shared', 'frontier'].map((tier) => t.badge[`--badge-${tier}-ink`]);
      expect(new Set(inks).size).toBe(3);
    }
  });
});
