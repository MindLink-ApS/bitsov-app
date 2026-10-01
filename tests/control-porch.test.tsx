import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'solid-js/web';
import { PorchPanel } from '../src/control/Porch';
import { cleanText, parseInline, parseMarkdown, porchPath } from '../src/control/porchText';
import type { Source } from '../src/control/source';
import type { ActionError, PaymentQuote, Peer, PorchCard, PorchRead, SpendView } from '../src/control/types';

const MAYA = 'a'.repeat(64);
const BEN = 'b'.repeat(64);
const QUOTE: PaymentQuote = { principal_msat: 1000, max_routing_fee_msat: 5000, total_msat: 6000 };
const OPEN: SpendView = { state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 600_000, pending: null, window_ms: 600_000 } as SpendView;

function card(nodeId: string, cached: boolean): PorchCard {
  return {
    node_id: nodeId,
    network: 'regtest',
    endpoint: '34.90.12.8:9735',
    reach: 'public',
    seq: 3,
    issued_at: Math.floor(Date.now() / 1000),
    expires_at: Math.floor(Date.now() / 1000) + 86_400,
    prices: { admission_msat: 10_000, message_msat: 1000, page_msat: 1000, price_epoch: 1 },
    profile: { kind: 'person', display_name: 'Maya', tagline: 'Builder', about: '' },
    media: [],
    site: { index_path: 'index.md', page_count: 1, titles: ['Maya'] },
    links: [],
    link: 'bitsov://front-door#x',
    verified: true,
    fresh: true,
    cached,
    stale: false,
  };
}

function page(path: string, kind: PorchRead['kind'], body: string, status: PorchRead['status'] = 'ok'): PorchRead {
  return { node_id: MAYA, path, status, kind, body, card: null, amount_msat: 1000, total_msat: 6000, message_id: 'm1' };
}

type Stub = { source: Source; quotes: string[]; reads: [string, string, number][] };

function stub(read: (peer: string, path: string) => PorchRead | ActionError, held: PorchCard[] = []): Stub {
  const quotes: string[] = [];
  const reads: [string, string, number][] = [];
  const source = {
    porchQuote: async (peer: string) => {
      quotes.push(peer);
      return QUOTE;
    },
    porchRead: async (peer: string, path: string, maxMsat: number) => {
      reads.push([peer, path, maxMsat]);
      const r = read(peer, path);
      if ('code' in r) throw r;
      return r;
    },
    porchCards: async () => held,
  } as unknown as Source;
  return { source, quotes, reads };
}

const PEERS: Peer[] = [
  { node_id: MAYA, addr: '34.90.12.8:9735', label: 'Maya', connected: true, fingerprint: 'aaaaaaaa', porch: true },
  { node_id: BEN, addr: '35.1.2.3:9735', label: 'Ben', connected: true, fingerprint: 'bbbbbbbb', porch: false },
];

let root: HTMLDivElement;
let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  root?.remove();
});

function mount(s: Stub, opts: { nodeReads?: boolean; peers?: Peer[] } = {}) {
  root = document.createElement('div');
  document.body.appendChild(root);
  dispose = render(
    () => (
      <PorchPanel
        source={s.source}
        now={Date.now()}
        peers={opts.peers ?? PEERS}
        nodeReads={opts.nodeReads ?? true}
        moneyBlocked={false}
        spend={OPEN}
        spendGate={<span data-spend-gate />}
        nameOf={(id) => (id === MAYA ? 'Maya' : 'Ben')}
      />
    ),
    root,
  );
}

const $ = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel);
const click = (sel: string) => $<HTMLButtonElement>(sel)!.click();
const tick = () => new Promise((r) => setTimeout(r, 0));

async function confirmRead(open: string) {
  click(open);
  await tick();
  click('[data-porch-confirm]');
  await tick();
}

describe('porch paths and text', () => {
  it('accepts the card and flat .md/.txt pages only, as the host does', () => {
    expect(porchPath('index.md')).toBe('/index.md');
    expect(porchPath(' /notes.txt ')).toBe('/notes.txt');
    expect(porchPath('/front-door.json')).toBe('/front-door.json');
    for (const bad of ['', 'a/b.md', '../x.md', '.hidden.md', 'page.html', 'x%2e.md', 'a\\b.md', `${'x'.repeat(130)}.md`]) {
      expect(porchPath(bad), bad).toBeNull();
    }
  });

  it('removes controls and invisible or direction-changing characters', () => {
    expect(cleanText('a\u202Eb\u200Bc\u0007d\r\ne\tf')).toBe('abcd\ne\tf');
  });

  it('parses a bounded markdown subset into text runs', () => {
    const blocks = parseMarkdown('# Title\n\nSome **bold** and `code`.\n\n- one\n- two\n\n> quote\n\n```\n<b>raw</b>\n```\n\n---');
    expect(blocks.map((b) => b.t)).toEqual(['h', 'p', 'list', 'quote', 'code', 'hr']);
    expect(parseInline('see [site](https://x.invalid) and ![pic](y.png)')).toEqual([
      { t: 'text', text: 'see ' },
      { t: 'link', text: 'site', url: 'https://x.invalid' },
      { t: 'text', text: ' and ' },
      { t: 'image', text: 'pic' },
    ]);
  });
});

describe('PorchPanel', () => {
  it('offers reads only for connected contacts that advertise porch_read_v1, and only when this node reads', async () => {
    mount(stub(() => page('/index.md', 'markdown', '')));
    await tick();
    expect($(`[data-porch-peer="${MAYA}"]`)).not.toBeNull();
    expect($(`[data-porch-peer="${BEN}"]`)).toBeNull();
    dispose?.();
    root.remove();

    mount(stub(() => page('/index.md', 'markdown', '')), { nodeReads: false });
    await tick();
    expect($('[data-porch-node-off]')).not.toBeNull();
    expect($('[data-porch-peers]')).toBeNull();
    dispose?.();
    root.remove();

    mount(stub(() => page('/index.md', 'markdown', '')), { peers: [PEERS[1]] });
    await tick();
    expect($('[data-porch-none]')!.textContent).toContain('porch_read_v1');
  });

  it('shows the 1 sat cost before a read and pays it after one confirm, once', async () => {
    const s = stub(() => ({ ...page('/front-door.json', 'card', ''), card: card(MAYA, false) }));
    mount(s);
    await tick();
    expect($('[data-porch-open-card]')!.textContent).toBe('Open profile card · 1 sat');

    click('[data-porch-open-card]');
    await tick();
    expect(s.reads).toEqual([]);
    expect($('[data-review-amount]')!.textContent).toBe('1 sat');
    expect($('[data-review-fee]')!.textContent).toBe('up to 5 sats');
    expect($('[data-review-total]')!.textContent).toBe('6 sats');

    const confirm = $<HTMLButtonElement>('[data-porch-confirm]')!;
    confirm.click();
    confirm.click();
    await tick();
    expect(s.reads).toEqual([[MAYA, '/front-door.json', 6000]]);
    expect($('[data-porch-review]')).toBeNull();
    expect($('[data-fd-name]')!.textContent).toBe('Maya');
    expect($('[data-porch-cached]')).toBeNull();

    click('[data-porch-page-read="/index.md"]');
    await tick();
    expect(s.reads.length).toBe(1);
    expect($('[data-porch-review-what]')!.textContent).toBe('Read /index.md from Maya');
    click('[data-porch-back]');
    await tick();
    expect($('[data-porch-review]')).toBeNull();
    expect(s.reads.length).toBe(1);
  });

  it('renders a markdown page as text: tags, scripts and links never become elements', async () => {
    const body = '# Hi\n\n<script>alert(1)</script> <img src=x onerror="alert(1)"> [go](javascript:alert`1`) ![p](http://x.invalid/a.png)';
    const s = stub((_, path) => (path === '/front-door.json' ? { ...page(path, 'card', ''), card: card(MAYA, false) } : page(path, 'markdown', body)));
    mount(s);
    await tick();
    await confirmRead('[data-porch-open-card]');
    await confirmRead('[data-porch-page-read="/index.md"]');
    const view = $('[data-porch-page="/index.md"]')!;
    expect(view.getAttribute('data-porch-kind')).toBe('markdown');
    expect(view.querySelector('h3')!.textContent).toBe('Hi');
    expect(view.querySelectorAll('script, img, a, iframe, [onerror]').length).toBe(0);
    expect(view.textContent).toContain('<script>alert(1)</script>');
    expect(view.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(view.querySelector('[data-porch-link]')!.textContent).toBe('go (javascript:alert`1`)');
    expect(view.querySelector('[data-porch-image]')!.textContent).toBe('[image: p]');
  });

  it('shows a text page in a preformatted block, and a missing page as paid', async () => {
    const s = stub((_, path) =>
      path === '/front-door.json'
        ? { ...page(path, 'card', ''), card: card(MAYA, false) }
        : path === '/notes.txt'
          ? page(path, 'text', '<b>x</b>\u202E')
          : page(path, 'none', '', 'not_found'),
    );
    mount(s);
    await tick();
    await confirmRead('[data-porch-open-card]');
    const input = $<HTMLInputElement>('[data-porch-path]')!;
    input.value = 'notes.txt';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await confirmRead('[data-porch-path-read]');
    expect($('[data-porch-page="/notes.txt"] pre')!.textContent).toBe('<b>x</b>');
    expect($('[data-porch-page="/notes.txt"] b')).toBeNull();

    input.value = 'gone.md';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await confirmRead('[data-porch-path-read]');
    expect($('[data-porch-not-found]')!.textContent).toContain('still paid');

    input.value = 'a/b.html';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    expect($<HTMLButtonElement>('[data-porch-path-read]')!.disabled).toBe(true);
    expect($('[data-porch-path-hint]')).not.toBeNull();
  });

  it('opens held cards as cached for free, and refreshing one is a paid, confirmed read', async () => {
    const s = stub(() => ({ ...page('/front-door.json', 'card', ''), card: card(MAYA, false) }), [card(MAYA, true)]);
    mount(s);
    await tick();
    expect($(`[data-porch-held-card="${MAYA}"]`)!.textContent).toContain('Cached');
    click('[data-porch-held-open]');
    await tick();
    expect(s.reads).toEqual([]);
    expect($('[data-porch-cached]')!.textContent).toContain('Cached');
    expect($('[data-porch-refresh]')!.textContent).toBe('Refresh · 1 sat');

    click('[data-porch-refresh]');
    await tick();
    expect(s.reads).toEqual([]);
    expect($('[data-review-total]')!.textContent).toBe('6 sats');
    click('[data-porch-confirm]');
    await tick();
    expect(s.reads).toEqual([[MAYA, '/front-door.json', 6000]]);
    expect($('[data-porch-cached]')).toBeNull();
  });

  it('offers no refresh for a held card whose node does not offer reads now', async () => {
    mount(stub(() => page('/index.md', 'markdown', ''), [card(BEN, true)]));
    await tick();
    expect($(`[data-porch-held-card="${BEN}"]`)).not.toBeNull();
    expect($('[data-porch-held-refresh]')).toBeNull();
    click('[data-porch-held-open]');
    await tick();
    expect($('[data-porch-refresh]')).toBeNull();
    expect($('[data-porch-pages]')).toBeNull();
  });

  it.each([
    ['porch_knock_first', 'Knock first. You have no session with this node yet: Knock from their profile link (it pays their admission once), then read their porch. Nothing was paid.'],
    ['porch_unreachable', 'Their node is not reachable right now: your node is not connected to it. Try again when they are online. Nothing was paid.'],
    ['porch_busy', 'A read from this node is already in progress. Wait for it to finish. Nothing was paid.'],
  ] as const)('shows the %s refusal as a plain sentence', async (code, message) => {
    const s = stub(() => ({ code, message }));
    mount(s);
    await tick();
    await confirmRead('[data-porch-open-card]');
    expect(s.reads.length).toBe(1);
    expect($('[data-soft-error="porch-error"] [data-soft-summary]')!.textContent).toBe(message);
    expect($('[data-soft-detail]')).toBeNull();
    expect($('[data-porch-review]')).toBeNull();
  });
});
