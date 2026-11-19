import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';
import { nodePill, peerName } from '../src/control/state';
import { attachmentOf, fileNameOf } from '../src/control/voice';
import { resetContactsForTests, setPetname } from '../src/control/petnames';
import { newRoom, rememberRoom, resetRooms } from '../src/control/room';
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
const E = 'e'.repeat(64);
const F = 'f'.repeat(64);

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

  it('never uses a name the contact claims; only your own name for them', () => {
    expect(peerName(peer(A, 'Far'), A)).toBe('New contact');
    expect(peerName(peer(A, 'Danske Bank'), A)).toBe('New contact');
    setPetname(A, 'Mor');
    expect(peerName(peer(A, 'Kim'), A)).toBe('Mor');
  });

  const withClaims = (claims: Record<string, string>) => {
    const source = sampleSource({ firstLiveMs: 1e9 });
    const base = source.peers.bind(source);
    source.peers = async () => [...await base(), ...Object.entries(claims).map(([id, label]) => peer(id, label))];
    return source;
  };

  it.each([
    ['en', 'Calls themselves "Far"', 'Use this name'],
    ['da', 'Kalder sig "Far"', 'Brug dette navn'],
  ] as const)('shows a claimed name only as a marked second line until you tap Use this name (%s)', async (lang, calls, use) => {
    setLanguagePref(lang);
    const fresh = lang === 'en' ? 'New contact' : 'Ny kontakt';
    await open(withClaims({ [E]: 'Far' }));
    await vi.waitFor(() => expect($(`[data-track="peer:${E}"]`)).not.toBeNull());
    const row = $(`[data-track="peer:${E}"]`)!;
    expect(row.querySelector('.name')!.firstChild!.textContent).toBe(fresh);
    expect(row.querySelector('[data-track-claimed]')!.textContent).toBe(calls);
    row.click();
    await vi.waitFor(() => expect($('[data-claimed-name]')).not.toBeNull());
    expect($('.track-head h1')!.textContent).toBe(fresh);
    expect($('[data-claimed-name]')!.textContent).toContain(calls);
    expect($('[data-claimed-clash]')).toBeNull();
    const button = $<HTMLButtonElement>('[data-use-claimed]')!;
    expect(button.textContent).toBe(use);
    button.click();
    await vi.waitFor(() => expect($('.track-head h1')!.textContent).toBe('Far'));
    expect($(`[data-track="peer:${E}"] .name`)!.textContent).toBe('Far');
    expect($(`[data-track="peer:${E}"] [data-track-claimed]`)).toBeNull();
    expect($('[data-add-name]')).toBeNull();
  });

  it('warns instead of offering the name when it copies a name you gave someone else', async () => {
    await open(withClaims({ [F]: 'maya' }));
    await vi.waitFor(() => expect($(`[data-track="peer:${F}"]`)).not.toBeNull());
    $<HTMLButtonElement>(`[data-track="peer:${F}"]`)!.click();
    await vi.waitFor(() => expect($('[data-claimed-name]')).not.toBeNull());
    expect($('.track-head h1')!.textContent).toBe('New contact');
    expect($('[data-use-claimed]')).toBeNull();
    expect($('[data-claimed-clash]')!.textContent).toBe('You already gave this name to someone else. Check who this is before you name them.');
  });

  it('offers Add name and keeps the full id under Technical', async () => {
    await open();
    const row = $(`[data-track="peer:${C}"] .name`)!;
    expect(row.textContent).toBe('New contact');
    row.closest('button')!.click();
    await vi.waitFor(() => expect($('[data-add-name]')).not.toBeNull());
    expect($('.track-head h1')!.textContent).toBe('New contact');
    $<HTMLButtonElement>('[data-add-name-open]')!.click();
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

describe('P1-12: a confirm closed during the first price read', () => {
  it('still gets that price when reopened (app-to-app calls)', async () => {
    const source = sampleSource({ firstLiveMs: 1e9 });
    const real = source.callQuote.bind(source);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    source.callQuote = async (p: string) => { await gate; return real(p); };
    await open(source);
    await vi.waitFor(() => expect($('[data-call="audio"]')).not.toBeNull());
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    expect($('[data-call-confirm-box="audio"]')).not.toBeNull();
    $<HTMLButtonElement>('[data-call-confirm-cancel]')!.click();
    expect($('[data-call-confirm-box]')).toBeNull();
    release();
    await new Promise((r) => setTimeout(r, 20));
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    expect($('[data-call-fetching]')).toBeNull();
  });
});

describe('P1-15: opens the last conversation', () => {
  it('reopens the conversation that was open last time', async () => {
    localStorage.setItem('bitsov.lastTrack', JSON.stringify({ node: SAMPLE_OWN_ID, kind: 'peer', id: B }));
    await open();
    await vi.waitFor(() => expect($(`[data-track="peer:${B}"]`)?.getAttribute('aria-current')).toBe('true'));
    expect($(`[data-track="peer:${A}"]`)!.getAttribute('aria-current')).toBe('false');
  });

  it('remembers the conversation you open', async () => {
    await open();
    $<HTMLButtonElement>(`[data-track="peer:${B}"]`)!.click();
    await vi.waitFor(() => expect(JSON.parse(localStorage.getItem('bitsov.lastTrack') ?? 'null')).toEqual({ node: SAMPLE_OWN_ID, kind: 'peer', id: B }));
  });

  it('does not reopen a conversation saved under another node', async () => {
    localStorage.setItem('bitsov.lastTrack', JSON.stringify({ node: 'f'.repeat(64), kind: 'peer', id: B }));
    await open();
    await vi.waitFor(() => expect($(`[data-track="peer:${A}"]`)?.getAttribute('aria-current')).toBe('true'));
    expect($(`[data-track="peer:${B}"]`)!.getAttribute('aria-current')).toBe('false');
  });

  it.each([
    ['without', false],
    ['with', true],
  ] as const)('a saved room on a node %s rooms: reopened only when this node supports rooms', async (_label, rooms) => {
    resetRooms();
    const room = rememberRoom(await newRoom(SAMPLE_OWN_ID, [A]))!;
    localStorage.setItem('bitsov.lastTrack', JSON.stringify({ node: SAMPLE_OWN_ID, kind: 'bound', id: room.id }));
    const source = sampleSource({ firstLiveMs: 1e9, rooms });
    const thread = vi.spyOn(source, 'roomThread');
    try {
      await open(source);
      if (rooms) {
        await vi.waitFor(() => expect($(`[data-track="bound:${room.id.toLowerCase()}"]`)?.getAttribute('aria-current')).toBe('true'));
      } else {
        await vi.waitFor(() => expect($(`[data-track="peer:${A}"]`)?.getAttribute('aria-current')).toBe('true'));
        await new Promise((r) => setTimeout(r, 30));
        expect(thread).not.toHaveBeenCalled();
      }
    } finally {
      resetRooms();
    }
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

  // Ordinary text must never become a file: when in doubt, it stays text.
  const ordinary = [
    'Hello please call me when you get home I have some news about the plans for our lovely weekend away',
    'HellopleasecallmewhenyougethomeIhavesomenewsabouttheplansforourlovelyweekendawayandthenwecantalk',
    'Hej mor jeg ringer i morgen tidlig og så kan vi snakke om weekenden og hvad vi skal spise til middag',
    'HejMorJegRingerIMorgenTidligOgSaaKanViSnakkeOmWeekendenOgHvadViSkalSpiseTilMiddagPaaLoerdagAften',
    'https://example.com/a/very/long/path/with/Many/Segments/AndQuery?x=1&y=2&z=3&w=4&v=5&u=6&t=7&s=8',
    'Pneumonoultramicroscopicsilicovolcanoconiosis'.repeat(3),
    'HahaHaha'.repeat(20),
    'abc123ABC'.repeat(20),
    'Room42Kitchen7Garden3Window9Door1Chair5Table8Lamp2Sofa6Rug4Shelf0Plant'.repeat(2),
    'ab'.repeat(64),
    'AB'.repeat(64),
    'a'.repeat(64) + 'b'.repeat(64),
    'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp',
    'Tak for i går! Det var dejligt at se jer alle sammen. Kys og kram fra os begge to, vi ses snart igen.',
    'OK',
  ];

  it.each(ordinary.map((t, i) => [i, t] as const))('ordinary text %i stays text', (_i, text) => {
    expect(attachmentOf(text)).toBeNull();
  });

  it('shows an ordinary long sentence as text, not a File card', async () => {
    const source = sampleSource({ firstLiveMs: 1e9 });
    const words = ordinary[0];
    source.messages = async (p: string) => (p.toLowerCase() === A ? [{ id: 'w1', kind: 1, sender: A, recipient: SAMPLE_OWN_ID, timestamp: 1, plaintext: words, payment_amount_msat: null }] : []);
    await open(source);
    await vi.waitFor(() => expect($('[data-message="w1"]')).not.toBeNull());
    expect($('[data-message="w1"] [data-attachment-card]')).toBeNull();
    expect($('[data-message="w1"]')!.textContent).toContain(words);
  });

  // JSON is a file only when it says so (a file name, a MIME type or a file kind) and its payload is real bytes.
  const plainJson = [
    JSON.stringify({ data: 'Meet me at noon' }),
    JSON.stringify({ data: 'Your parcel has arrived' }),
    JSON.stringify({ content_b64: blob }),
    JSON.stringify({ data_b64: blob }),
    JSON.stringify({ data: blob, note: 'hi' }),
    JSON.stringify({ filename: 'notes.txt', data: 'Meet me at noon' }),
    JSON.stringify({ mime_type: 'text/plain', data_b64: 'SGVsbG8=' }),
    JSON.stringify({ type: 'greeting', data: blob }),
  ];

  it.each(plainJson.map((t, i) => [i, t] as const))('JSON without a clear file marker stays text %i', (_i, text) => {
    expect(attachmentOf(text)).toBeNull();
  });

  it.each([
    ['filename + mime', { filename: 'photo.png', mime_type: 'image/png', data_b64: blob }, 'photo.png'],
    ['filename only', { name: 'scan.pdf', content_b64: blob }, 'scan.pdf'],
    ['mime only', { mime: 'image/jpeg', data: blob }, null],
    ['file kind', { type: 'file', data_b64: blob }, null],
  ] as const)('JSON that names an attachment is a file (%s)', (_l, record, name) => {
    expect(attachmentOf(JSON.stringify(record))).toMatchObject({ name, size: 200 });
  });

  it.each(['Meet me at noon', 'Your parcel has arrived'])('a JSON chat message %s stays readable in the chat', async (words) => {
    const source = sampleSource({ firstLiveMs: 1e9 });
    const text = JSON.stringify({ data: words });
    source.messages = async (p: string) => (p.toLowerCase() === A ? [{ id: 'j1', kind: 1, sender: A, recipient: SAMPLE_OWN_ID, timestamp: 1, plaintext: text, payment_amount_msat: null }] : []);
    await open(source);
    await vi.waitFor(() => expect($('[data-message="j1"]')).not.toBeNull());
    expect($('[data-message="j1"] [data-attachment-card]')).toBeNull();
    expect($('[data-message="j1"]')!.textContent).toContain(words);
  });

  it('still finds real base64 bytes, including line-wrapped', () => {
    const wrapped = blob.match(/.{1,76}/g)!.join('\n');
    expect(attachmentOf(wrapped)).toMatchObject({ size: 200 });
  });

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
