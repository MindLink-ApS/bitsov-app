import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';
import { nodePill, peerName } from '../src/control/state';
import { attachmentOf, fileNameOf } from '../src/control/voice';
import { resetContactsForTests, setPetname } from '../src/control/petnames';
import { setLanguagePref } from '../src/i18n';
import type { Message, NodeOverview, Peer } from '../src/control/types';
import type { Source } from '../src/control/source';

// A first real session on a new box: people have names, not ids; nothing
// technical sits on top of the chat; the call price is fetched inside the
// open confirm; the app opens where you left off; the sidebar speaks plainly;
// a file never shows up as a wall of base64.

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

let dispose: (() => void) | undefined;
let mount: HTMLElement;
beforeEach(() => resetContactsForTests());
afterEach(() => { dispose?.(); mount?.remove(); setLanguagePref('en'); vi.restoreAllMocks(); resetContactsForTests(); });

const $ = <T extends Element = HTMLElement>(sel: string) => mount.querySelector<T>(sel);

async function open(source: Source = sampleSource({ firstLiveMs: 1e9 })) {
  mount = document.createElement('div');
  document.body.appendChild(mount);
  dispose = render(() => <ControlCenter source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
  await vi.waitFor(() => expect($('[data-composer] textarea')).not.toBeNull());
  return source;
}

const peer = (node_id: string, label: string | null): Peer => ({ node_id, addr: null, label, connected: true, fingerprint: null });

describe('P1-3: a person, never "Unnamed contact (c1926…)"', () => {
  it.each([
    ['en', 'New contact'],
    ['da', 'Ny kontakt'],
  ] as const)('falls back to a short friendly name without the id (%s)', (lang, word) => {
    setLanguagePref(lang);
    const name = peerName(peer(C, null), C);
    expect(name).toBe(word);
    expect(name).not.toMatch(/[0-9a-f]{4}/);
  });

  it('uses the name the contact already has, and the owner name wins', () => {
    expect(peerName(peer(A, ' Kim '), A)).toBe('Kim');
    setPetname(A, 'Mor');
    expect(peerName(peer(A, 'Kim'), A)).toBe('Mor');
     // Someone else claiming a name you already gave another person is a new contact.
    expect(peerName(peer(B, 'mor'), B)).toBe('New contact');
  });

  it('offers Add name and keeps the full id under Technical', async () => {
    await open();
    const row = $(`[data-track="peer:${C}"] .name`)!;
    expect(row.textContent).toBe('New contact');
    row.closest('button')!.click();
    await vi.waitFor(() => expect($('[data-add-name]')).not.toBeNull());
    expect($('.track-head h1')!.textContent).toBe('New contact');
    $<HTMLButtonElement>('[data-add-name] button')!.click();
    await vi.waitFor(() => expect($('[data-contact-panel]')?.getAttribute('data-contact-panel')).toBe('open'));
    const technical = $<HTMLDetailsElement>('[data-contact-technical]')!;
    expect(technical.open).toBe(false);
    expect(technical.querySelector('summary')!.textContent).toBe('Technical');
    expect(technical.textContent).toContain(C);
  });
});

describe('P1-5: the public chain source is a quiet Settings fact', () => {
  const thirdParty = (source: Source) => {
    const base = source.nodeOverview;
    source.nodeOverview = async () => ({ ...await base(), chain_view: { explorer_default: true, trust_level: 'third_party' } });
    return source;
  };

  it.each([
    ['en', 'Your box follows the Bitcoin network through a public service. Nothing is needed from you.'],
    ['da', 'Din boks følger Bitcoin-netværket via en offentlig tjeneste. Du behøver ikke gøre noget.'],
  ] as const)('is not a banner over the chat, and lives under Settings → Node (%s)', async (lang, words) => {
    setLanguagePref(lang);
    const source = thirdParty(sampleSource({ firstLiveMs: 1e9 }));
    const read = vi.spyOn(source, 'nodeOverview');
    await open(source);
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect($('.track [data-chain-notice]')).toBeNull();
    expect($('[data-phone-status] [data-chain-notice]')).toBeNull();
    $<HTMLButtonElement>('.rail .node-pill')!.click();
    await vi.waitFor(() => expect($('[data-panel="node"] [data-chain-notice]')?.textContent).toContain(words));
    expect($('[data-panel="node"] [data-chain-notice]')!.textContent).not.toMatch(/kæden|the chain from/);
  });
});

describe('P1-12: the call confirm stays open while it fetches the price', () => {
  it.each([
    ['en', 'Fetching price…'],
    ['da', 'Henter pris…'],
  ] as const)('opens at once and says it is fetching (%s)', async (lang, words) => {
    setLanguagePref(lang);
    const source = sampleSource({ firstLiveMs: 1e9 });
    const real = source.callQuote.bind(source);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    source.callQuote = async (p: string) => { await gate; return real(p); };
    const signal = vi.spyOn(source, 'callSignal');
    await open(source);
    await vi.waitFor(() => expect($('[data-call="audio"]')).not.toBeNull());
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    const box = $('[data-call-confirm-box="audio"]');
    expect(box).not.toBeNull();
    expect(box!.querySelector('[role="status"]')!.textContent).toBe(words);
    expect($<HTMLButtonElement>('[data-call-confirm="audio"]')!.disabled).toBe(true);
    release();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    expect($('[data-call-confirm-box="audio"]')).not.toBeNull();
    expect(signal).not.toHaveBeenCalled();
  });
});

describe('P1-15: opens the last conversation', () => {
  it('reopens the conversation that was open last time', async () => {
    localStorage.setItem('bitsov.lastTrack', JSON.stringify({ kind: 'peer', id: B }));
    await open();
    await vi.waitFor(() => expect($(`[data-track="peer:${B}"]`)?.getAttribute('aria-current')).toBe('true'));
    expect($(`[data-track="peer:${A}"]`)!.getAttribute('aria-current')).toBe('false');
  });

  it('remembers the conversation you open', async () => {
    await open();
    $<HTMLButtonElement>(`[data-track="peer:${B}"]`)!.click();
    await vi.waitFor(() => expect(JSON.parse(localStorage.getItem('bitsov.lastTrack') ?? 'null')).toEqual({ kind: 'peer', id: B }));
  });
});

describe('P1-16: plain sidebar words, developer sections under Advanced', () => {
  it.each([
    ['en', 'Advanced', ['Helpers', 'view only', 'Ask your box', 'Find people', 'Add someone', 'Public pages'], ['read-only', 'Porch', 'paste a card', 'Assistants', 'Browse']],
    ['da', 'Avanceret', ['Hjælpere', 'kun visning', 'Spørg din boks', 'Find personer', 'Tilføj en person', 'Offentlige sider'], ['skrivebeskyttet', 'Forrum', 'indsæt et kort', 'Assistenter', 'Udforsk']],
  ] as const)('%s', async (lang, advanced, plain, jargon) => {
    setLanguagePref(lang);
    await open();
    const group = $<HTMLDetailsElement>('.rail [data-rail-advanced]')!;
    expect(group.tagName).toBe('DETAILS');
    expect(group.open).toBe(false);
    expect(group.querySelector('summary')!.textContent).toBe(advanced);
    for (const sel of ['[data-track="ai"]', '[data-track="discover"]', '[data-track="porch"]', '[data-assistants]']) {
      expect(group.querySelector(sel), sel).not.toBeNull();
    }
    const rail = $('.rail')!.textContent!;
    for (const w of plain) expect(rail).toContain(w);
    for (const w of jargon) expect(rail).not.toContain(w);
  });

  it.each([
    ['en', 'Connected · Ready to pay'],
    ['da', 'Forbundet · Klar til at betale'],
  ] as const)('status pill says Connected (%s)', (lang, words) => {
    setLanguagePref(lang);
    const now = Date.now();
    const pill = nodePill({ ready: true, error: null, overview: { money_ready: true, read_at: now } as NodeOverview, link: 'open', nowMs: now });
    expect(pill.text).toBe(words);
  });
});

describe('P1-17: a file, never a base64 blob', () => {
  // 200 bytes: the size a card shows is the decoded size, not the text length.
  const blob = btoa(String.fromCharCode(...Array.from({ length: 200 }, (_, i) => (i * 37) % 256)));
  const record = JSON.stringify({ filename: 'photo.png', mime_type: 'image/png', data_b64: blob });

  it('never names a file after its payload', () => {
    expect(fileNameOf(blob)).toBeNull();
    expect(attachmentOf(blob)).toMatchObject({ name: null, size: 200 });
    expect(attachmentOf(C)).toBeNull();
    const invoice = 'lnbcrt210n1p40utzkpp5qurswpc8qurswpc8qurswpc8qurswpc8qurswpc8qurswpc8qursdq2v35kumn9wg4q0r5rg80yefel0y3a50v3kzgrtarm84kg60g7pa2hfthjunhhakje5nnseyxx83ep2pu3vvt4gws8fsnzr8gxxshr0gjkxvn9679uqpjjf25t';
    expect(attachmentOf(invoice)).toBeNull();
    expect(fileNameOf('[file: notes.txt]')).toBe('notes.txt');
    expect(attachmentOf(record)).toMatchObject({ name: 'photo.png', mime: 'image/png' });
    expect(attachmentOf('hello there')).toBeNull();
    expect(attachmentOf('a'.repeat(30))).toBeNull();
  });

  it.each([
    ['en', 'File', 'Save'],
    ['da', 'Fil', 'Gem'],
  ] as const)('shows a file card with name and size, and keeps Save (%s)', async (lang, file, save) => {
    setLanguagePref(lang);
    const source = sampleSource({ firstLiveMs: 1e9 });
    const msg = (id: string, kind: number, plaintext: string): Message => ({ id, kind, sender: A, recipient: SAMPLE_OWN_ID, timestamp: 1, plaintext, payment_amount_msat: null });
    source.messages = async (p: string) => (p.toLowerCase() === A ? [msg('m1', 200, blob), msg('m2', 1, blob), msg('m3', 1, record)] : []);
    await open(source);
    await vi.waitFor(() => expect($('[data-message="m3"]')).not.toBeNull());
    for (const id of ['m1', 'm2', 'm3']) expect($(`[data-message="${id}"]`)!.textContent, id).not.toContain(blob.slice(0, 40));
    expect($('[data-message="m1"] [data-file-name]')!.textContent).toBe(file);
    expect($('[data-message="m1"] [data-file-save]')!.textContent).toBe(save);
    expect($('[data-message="m1"] [data-file-meta]')!.textContent).toContain('200 B');
    const card = $('[data-message="m2"] [data-attachment-card]')!;
    expect(card.querySelector('[data-attachment-name]')!.textContent).toBe(file);
    expect(card.querySelector('[data-attachment-size]')!.textContent).toBe('200 B');
    expect(card.querySelector('[data-attachment-save]')!.textContent).toBe(save);
    expect($('[data-message="m3"] [data-attachment-name]')!.textContent).toBe('photo.png');
  });
});
