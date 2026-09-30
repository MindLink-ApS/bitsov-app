import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import { BECH32_CHARSET, bech32Checksum, cleanPurpose, invoicePayee, payeeView, readChatInvoice } from '../src/control/bolt11';
import { compress, G, N, pointMul, sha256, toBig } from '../src/control/secp';
import type { SpendView } from '../src/control/types';

// Demo gap 6: Request's invoice travels as an ordinary paid chat message, and
// a received one renders as a request card whose Pay only opens the review.

const OWN = '1'.repeat(64);
const A = 'a'.repeat(64);
const WINDOW = 600_000;
const NOW_S = Math.floor(Date.now() / 1000);

// ---- a test-side BOLT11 writer, signed with a known key ----

const words = (n: number, len: number) => Array.from({ length: len }, (_, i) => Math.floor(n / 32 ** (len - 1 - i)) % 32);
const bytesToWords = (bytes: Uint8Array) => {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((acc >> bits) & 31);
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
};
const tag = (type: number, data: number[]) => [type, ...words(data.length, 2), ...data];

const wordsToBytes = (ws: number[]) => {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const w of ws) {
    acc = (acc << 5) | w;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out.push((acc << (8 - bits)) & 0xff);
  return new Uint8Array(out);
};
const modPow = (b: bigint, e: bigint, m: bigint) => {
  let r = 1n;
  for (b %= m; e > 0n; e >>= 1n, b = (b * b) % m) if (e & 1n) r = (r * b) % m;
  return r;
};
const be32 = (n: bigint) => Uint8Array.from(n.toString(16).padStart(64, '0').match(/../g)!.map((h) => parseInt(h, 16)));

/** Maya's own Lightning key and a stranger's, as private scalars. */
const MAYA_KEY = 0x4d617961n;
const STRANGER_KEY = 0x5374726e676572n;
const pubOf = (key: bigint) => compress(pointMul(G, key)!);

/** Recoverable ECDSA over the BOLT11 preimage, deterministic nonce (test only). */
function sign(hrp: string, data: number[], key: bigint): number[] {
  const digest = sha256(new Uint8Array([...new TextEncoder().encode(hrp), ...wordsToBytes(data)]));
  const e = toBig(digest) % N;
  const k = (toBig(sha256(new Uint8Array([...digest, ...be32(key)]))) % (N - 1n)) + 1n;
  const R = pointMul(G, k)!;
  const r = R.x % N;
  let s = (modPow(k, N - 2n, N) * (e + r * key)) % N;
  let recid = Number(R.y & 1n);
  if (s > N / 2n) {
    s = N - s;
    recid ^= 1;
  }
  return bytesToWords(new Uint8Array([...be32(r), ...be32(s), recid]));
}

function invoice(opts: { hrp?: string; purpose?: string | null; descBytes?: Uint8Array; at?: number; expiry?: number; hash?: boolean; key?: bigint; payeeTag?: string } = {}) {
  const hrp = opts.hrp ?? 'lnbcrt210n';
  const desc = opts.descBytes ?? (opts.purpose === null ? null : new TextEncoder().encode(opts.purpose ?? 'dinner'));
  const data = [
    ...words(opts.at ?? NOW_S, 7),
    ...(opts.hash === false ? [] : tag(1, bytesToWords(new Uint8Array(32).fill(7)))),
    ...(desc === null ? [] : tag(13, bytesToWords(desc))),
    ...(opts.expiry === undefined ? [] : tag(6, words(opts.expiry, 3))),
    ...(opts.payeeTag ? tag(19, bytesToWords(Uint8Array.from(opts.payeeTag.match(/../g)!.map((h) => parseInt(h, 16))))) : []),
  ];
  const all = [...data, ...sign(hrp, data, opts.key ?? MAYA_KEY)];
  return hrp + '1' + [...all, ...bech32Checksum(hrp, all)].map((w) => BECH32_CHARSET[w]).join('');
}

const NOW = Date.now();

describe('reading a chat invoice', () => {
  it('reads the BOLT11 spec vectors: amount, purpose, expiry', () => {
    const coffee =
      'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp';
    const r = readChatInvoice(coffee, 1496314658_000, 'mainnet');
    expect(r).toEqual({ ok: true, invoice: { bolt11: coffee, msat: 250_000_000, network: 'mainnet', purpose: '1 cup coffee', expiresAtMs: 1496314718_000, payee: '03e7156ae33b0a208d0744199163177e909e80176e55d97a2f221ede0f934dd9ad' } });
    // The same invoice a minute later, and on a regtest node.
    expect(readChatInvoice(coffee, 1496314718_000, 'mainnet')).toEqual({ ok: false, reason: 'expired' });
    expect(readChatInvoice(coffee, 1496314658_000, 'regtest')).toEqual({ ok: false, reason: 'wrong_network' });
    // `lightning:` and upper case are the same invoice.
    expect(readChatInvoice(`  lightning:${coffee.toUpperCase()}\n`, 1496314658_000, 'mainnet')).toMatchObject({ ok: true });
    // The spec's donation vector names no amount.
    const donation =
      'lnbc1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq8rkx3yf5tcsyz3d73gafnh3cax9rn449d9p5uxz9ezhhypd0elx87sjle52x86fux2ypatgddc6k63n7erqz25le42c4u4ecky03ylcqca784w';
    expect(readChatInvoice(donation, 1496314658_000, 'mainnet')).toEqual({ ok: false, reason: 'no_amount' });
  });

  it('reads the payee from the signature, or from an n field', () => {
    const coffee =
      'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp';
    // The spec's payee for every example invoice.
    expect(invoicePayee(coffee)).toBe('03e7156ae33b0a208d0744199163177e909e80176e55d97a2f221ede0f934dd9ad');
    expect(readChatInvoice(invoice(), NOW, 'regtest')).toMatchObject({ ok: true, invoice: { payee: pubOf(MAYA_KEY) } });
    expect(readChatInvoice(invoice({ key: STRANGER_KEY }), NOW, 'regtest')).toMatchObject({ ok: true, invoice: { payee: pubOf(STRANGER_KEY) } });
    expect(invoicePayee(invoice({ payeeTag: pubOf(STRANGER_KEY) }))).toBe(pubOf(STRANGER_KEY));
    // A signature that recovers no key is not an invoice.
    const good = invoice();
    const body = good.slice(0, good.length - 6 - 104);
    const hrp = good.slice(0, good.lastIndexOf('1'));
    const data = [...body.slice(hrp.length + 1)].map((c) => BECH32_CHARSET.indexOf(c));
    const zeroSig = [...data, ...new Array(104).fill(0)];
    expect(readChatInvoice(hrp + '1' + [...zeroSig, ...bech32Checksum(hrp, zeroSig)].map((w) => BECH32_CHARSET[w]).join(''), NOW, 'regtest')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('names the payee as the contact only when their Lightning node id is known and matches', () => {
    const maya = pubOf(MAYA_KEY);
    expect(payeeView(maya, maya.toUpperCase(), 'Maya')).toEqual({ verified: true, text: 'Maya' });
    expect(payeeView(maya, null, 'Maya')).toEqual({ verified: false, text: `Lightning node ${maya.slice(0, 8)}…${maya.slice(-4)}, not verified as Maya` });
    expect(payeeView(pubOf(STRANGER_KEY), maya, 'Maya').verified).toBe(false);
  });

  it('reads each network and amount unit exactly', () => {
    const at = (hrp: string) => readChatInvoice(invoice({ hrp }), NOW, null);
    expect(at('lnbcrt210n')).toMatchObject({ ok: true, invoice: { msat: 21_000, network: 'regtest', purpose: 'dinner' } });
    expect(at('lntb1m')).toMatchObject({ ok: true, invoice: { msat: 100_000_000, network: 'testnet' } });
    expect(at('lntbs20u')).toMatchObject({ ok: true, invoice: { msat: 2_000_000, network: 'signet' } });
    expect(at('lnbc10000p')).toMatchObject({ ok: true, invoice: { msat: 1000, network: 'mainnet' } });
    // Unknown home network: not refused on network.
    expect(at('lnbc10000p')).toMatchObject({ ok: true });
  });

  it('refuses what the app cannot pay, with a reason', () => {
    const reason = (body: string, home: string | null = 'regtest') => {
      const r = readChatInvoice(body, NOW, home);
      return r === null ? null : r.ok ? 'ok' : r.reason;
    };
    expect(reason(invoice())).toBe('ok');
    expect(reason(invoice({ hrp: 'lnbcrt' }))).toBe('no_amount');
    expect(reason(invoice({ hrp: 'lnbcrt0n' }))).toBe('invalid'); // leading zero
    expect(reason(invoice({ hrp: 'lnbcrt15p' }))).toBe('invalid'); // not a whole msat
    expect(reason(invoice({ hrp: 'lnbcrt5n' }))).toBe('out_of_bounds'); // 0.5 sat
    expect(reason(invoice({ hrp: 'lnbcrt2' }))).toBe('out_of_bounds'); // 2 BTC
    expect(reason(invoice({ hrp: 'lnbcrt99999999999999999999' }))).toBe('out_of_bounds');
    expect(reason(invoice({ hrp: 'lnbc210n' }))).toBe('wrong_network');
    expect(reason(invoice({ hrp: 'lnxy210n' }))).toBe('invalid');
    expect(reason(invoice({ at: NOW_S - 3600 }))).toBe('expired'); // default one hour
    expect(reason(invoice({ at: NOW_S - 3600, expiry: 7200 }))).toBe('ok');
    expect(reason(invoice({ at: NOW_S - 61, expiry: 60 }))).toBe('expired');
    expect(reason(invoice({ hash: false }))).toBe('invalid');
    // A broken checksum and a mixed-case body.
    const good = invoice();
    const flipped = good.slice(0, -1) + (good.endsWith('q') ? 'p' : 'q');
    expect(reason(flipped)).toBe('invalid');
    expect(reason(good.slice(0, 20) + good.slice(20).toUpperCase())).toBe('invalid');
    expect(reason(good.slice(0, 40))).toBe('invalid');
  });

  it('ignores ordinary text and anything that is not only an invoice', () => {
    const good = invoice();
    for (const body of [null, '', 'gm Maya', 'lnbc is lightning', `pay this: ${good}`, `${good} thanks`, `${good}\n${good}`, `<b>${good}</b>`, 'x'.repeat(5000), `ln${'q'.repeat(3000)}1`]) {
      expect(readChatInvoice(body, NOW, 'regtest')).toBeNull();
    }
  });

  it('cleans a hostile purpose to plain, bounded text', () => {
    expect(cleanPurpose('pay\u202e evil \u2066now\u2069\u200b')).toBe('pay evil now');
    expect(cleanPurpose('a\n\n\tb\u0000c\u0085d')).toBe('a b c d');
    expect(cleanPurpose(' \u200b\u202e ')).toBeNull();
    const long = cleanPurpose('🍕'.repeat(500))!;
    expect(Array.from(long)).toHaveLength(140);
    expect(long.endsWith('…')).toBe(true);
    // Invalid UTF-8 in the description is an invalid invoice, not garbage on screen.
    expect(readChatInvoice(invoice({ descBytes: new Uint8Array([0xff, 0xfe]) }), NOW, 'regtest')).toEqual({ ok: false, reason: 'invalid' });
  });
});

// ---- in the app ----

const paired = { state: 'paired', scopes: ['read', 'receive'], short_code: 'ABCD-EFGH', code_from_node: true, reason: null, bootstrap: null };
type Call = { cmd: string; args: Record<string, unknown> | undefined };
type Reply = (args?: Record<string, unknown>) => unknown;
const view = (state: SpendView['state'], extra: Partial<SpendView> = {}): SpendView => ({
  state, basis: null, open_until_ms: null, pending: null, window_ms: WINDOW, ...extra,
});
const openView = () => view('open', { basis: 'node_grant', open_until_ms: Date.now() + WINDOW });
const msg = (id: string, plaintext: string, sender = A, kind = 1) =>
  ({ id, kind, sender, recipient: sender === A ? OWN : A, timestamp: Date.now() - 1000, plaintext, payment_amount_msat: 2000 });

function stubHost(overrides: Record<string, Reply> = {}, network: string | null = 'regtest') {
  const calls: Call[] = [];
  const spend = { v: view('locked') };
  const REPLIES: Record<string, Reply> = {
    node_status: () => ({ ready: true, node_id: OWN, error: null }),
    pairing_status: () => paired,
    node_overview: () => ({
      node_id: OWN, status: 'ok', version: 'api v2', connected_peers: 1, e2ee_sessions: 1, pending_deliveries: 0,
      lightning_available: true, block_height: 1, uptime_secs: 1, lightning_backend: 'ldk', chain_backend: 'esplora', read_at: Date.now(),
      ...(network ? { network } : {}),
    }),
    peers_list: () => [{ node_id: A, addr: null, label: 'Maya', connected: true, fingerprint: null }],
    rooms_list: () => [],
    messages_list: () => [],
    price_quote: () => ({ kind: 0, own_msat: 1000, peer_msat: 2000, peer_age_secs: 30, peer_stale: false }),
    payments_overview: () => ({ balance_msat: 1_000_000, lightning_outbound_msat: 500_000, channels: [] }),
    fund_state: () => null,
    file_price: () => ({ principal_msat: 3000, max_routing_fee_msat: 5000, total_msat: 8000 }),
    spend_status: () => spend.v,
    spend_request: () => {
      spend.v = view('pending', { pending: { op_id: 'ab12', expires_at_ms: Date.now() + 900_000, owner_action: 'konsensus grant --op ab12', owner_can_grant: true } });
      return spend.v;
    },
    message_send: (args) => ({ message_id: 'sent-1', recipient: args!.recipient, is_room: args!.is_room, delivered: true, amount_msat: 2000, sent_at_ms: Date.now() }),
    invoice_amount: () => ({ amount_msat: 21_000, network: 'regtest' }),
    payment_pay: (args) => ({ method: 'invoice', amount_msat: args!.amount_msat, status: 'settled', paid_at_ms: Date.now() }),
    invoice_create: (args) => ({ bolt11: invoice(), amount_msat: args!.amount_msat, note: args!.note || null, expires_at_ms: Date.now() + 3_600_000 }),
    live_link: () => null,
    'plugin:event|listen': () => 1,
    'plugin:event|unlisten': () => null,
    ...overrides,
  };
  vi.stubGlobal('__TAURI_INTERNALS__', {
    transformCallback: () => 1,
    invoke: (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      const reply = REPLIES[cmd];
      if (!reply) return Promise.reject(new Error(`unexpected ${cmd}`));
      try {
        return Promise.resolve(reply(args));
      } catch (e) {
        return Promise.reject(e);
      }
    },
  });
  vi.stubGlobal('__TAURI_EVENT_PLUGIN_INTERNALS__', { unregisterListener: () => {} });
  return { spend, used: (cmd: string) => calls.filter((c) => c.cmd === cmd) };
}

describe('a request in chat', () => {
  let dispose: (() => void) | undefined;
  let mount: HTMLElement;

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    mount?.remove();
    vi.unstubAllGlobals();
  });

  const $ = <T extends Element = HTMLElement>(sel: string) => mount.querySelector<T>(sel);
  const text = (sel: string) => $(sel)?.textContent ?? '';
  const type = (sel: string, value: string) => {
    const el = $<HTMLInputElement | HTMLTextAreaElement>(sel)!;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };

  async function openShell() {
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => <App />, mount);
    await vi.waitFor(() => expect([...mount.querySelectorAll('button')].some((b) => b.textContent?.includes('I understand'))).toBe(true));
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
    await vi.waitFor(() => expect($(`[data-track="peer:${A}"]`)?.getAttribute('aria-current')).toBe('true'));
    await vi.waitFor(() => expect($('[data-cost-msat]')?.getAttribute('data-cost-msat')).toBe('2000'));
  }

  it('Send in chat sends the invoice as an ordinary paid message at the message price', async () => {
    const host = stubHost();
    host.spend.v = openView();
    await openShell();
    $<HTMLButtonElement>('[data-composer-mode="request"]')!.click();
    expect(text('[data-request-hint]')).toContain('Send it in chat so Maya can pay it');
    expect($('[data-send-in-chat]')).toBeNull();
    type('[data-request-amount]', '21');
    type('[data-request-note]', 'dinner');
    $<HTMLButtonElement>('[data-send]')!.click();
    await vi.waitFor(() => expect($('[data-send-in-chat]')).not.toBeNull());
    expect(host.used('message_send')).toHaveLength(0);
    expect(text('[data-send-in-chat]')).toBe('Send in chat · ≈ 2 sats');
    $<HTMLButtonElement>('[data-send-in-chat]')!.click();
    await vi.waitFor(() => expect(host.used('message_send')).toHaveLength(1));
    // Exactly the Send button's message: same command, price cap and no new kind.
    expect(host.used('message_send')[0].args).toEqual({ recipient: A, is_room: false, plaintext: invoice(), max_msat: 2000, max_recipient_msat: null, first_contact_msat: null });
    expect(host.used('payment_pay')).toHaveLength(0);
    await vi.waitFor(() => expect($<HTMLTextAreaElement>('[data-composer] textarea')!.value).toBe(''));
    expect($('[data-composer]')!.getAttribute('data-mode')).toBe('message');
  });

  it('Send in chat follows the same approval: locked spending asks first and sends nothing', async () => {
    const host = stubHost();
    await openShell();
    $<HTMLButtonElement>('[data-composer-mode="request"]')!.click();
    type('[data-request-amount]', '21');
    $<HTMLButtonElement>('[data-send]')!.click();
    await vi.waitFor(() => expect($('[data-send-in-chat]')).not.toBeNull());
    $<HTMLButtonElement>('[data-send-in-chat]')!.click();
    await vi.waitFor(() => expect(host.used('spend_request')).toHaveLength(1));
    expect(host.used('message_send')).toHaveLength(0);
    // The invoice waits in the message draft for the owner's Send.
    expect($<HTMLTextAreaElement>('[data-composer] textarea')!.value).toBe(invoice());
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Waiting for approval'));
  });

  it('renders a received invoice as a request card; Pay opens the review and only confirm pays', async () => {
    const bolt11 = invoice({ purpose: 'tacos for the team' });
    const host = stubHost({ messages_list: () => [msg('in-1', bolt11)] });
    host.spend.v = openView();
    await openShell();
    await vi.waitFor(() => expect($('[data-message="in-1"] [data-request-card]')).not.toBeNull());
    const card = $('[data-message="in-1"] [data-request-card]')!;
    expect(card.getAttribute('data-request-msat')).toBe('21000');
    expect(card.textContent).toContain('Payment request from Maya');
    expect(card.textContent).toContain('21');
    expect(text('[data-request-purpose]')).toBe('For: tacos for the team');
    expect($('[data-message="in-1"] .bubble')).toBeNull();

    $<HTMLButtonElement>('[data-request-pay]')!.click();
    await vi.waitFor(() => expect($('[data-pay-review]')).not.toBeNull());
    expect($('[data-composer]')!.getAttribute('data-mode')).toBe('pay');
    expect($<HTMLTextAreaElement>('[data-pay-invoice]')!.value).toBe(bolt11);
    expect(host.used('invoice_amount')[0].args).toEqual({ bolt11 });
    expect(text('[data-review-amount]')).toBe('21 sats');
    expect(host.used('payment_pay')).toHaveLength(0);

    // Back: nothing paid. Pay on the card again: the review again.
    $<HTMLButtonElement>('[data-pay-back]')!.click();
    expect(host.used('payment_pay')).toHaveLength(0);
    $<HTMLButtonElement>('[data-request-pay]')!.click();
    await vi.waitFor(() => expect($('[data-pay-review]')).not.toBeNull());
    expect(host.used('payment_pay')).toHaveLength(0);

    $<HTMLButtonElement>('[data-pay-confirm]')!.click();
    await vi.waitFor(() => expect(host.used('payment_pay')).toHaveLength(1));
    expect(host.used('payment_pay')[0].args).toEqual({ bolt11, amount_msat: 21_000, max_msat: 26_000 });
  });

  // Codex #85 P1a: a contact can forward someone else's invoice. Neither the
  // card nor the confirm may say it pays them.
  it('a forwarded third-party invoice shows its own payee, not verified as the contact, on card and confirm', async () => {
    const stranger = pubOf(STRANGER_KEY);
    const bolt11 = invoice({ key: STRANGER_KEY, purpose: 'dinner' });
    const host = stubHost({ messages_list: () => [msg('in-1', bolt11)] });
    host.spend.v = openView();
    await openShell();
    await vi.waitFor(() => expect($('[data-request-card]')).not.toBeNull());
    const short = `${stranger.slice(0, 8)}…${stranger.slice(-4)}`;
    expect(text('[data-request-card] [data-payee]')).toBe(`Pays Lightning node ${short}, not verified as Maya.`);
    expect($('[data-request-card] [data-payee]')!.getAttribute('data-payee')).toBe('unverified');
    expect($('[data-request-card] [data-payee]')!.getAttribute('title')).toBe(stranger);

    $<HTMLButtonElement>('[data-request-pay]')!.click();
    await vi.waitFor(() => expect($('[data-pay-review]')).not.toBeNull());
    const review = text('[data-pay-review]');
    expect(text('[data-pay-review] .pay-review-title')).toBe('Pay this Lightning invoice');
    expect(text('[data-pay-review] [data-payee]')).toBe(`Pays Lightning node ${short}, not verified as Maya.`);
    expect(review).not.toContain('Pay Maya');
    expect(review).not.toContain('their invoice');
    expect(host.used('payment_pay')).toHaveLength(0);
  });

  it('even an invoice signed by the contact’s own node is not named as theirs: the app has no binding to check', async () => {
    const host = stubHost({ messages_list: () => [msg('in-1', invoice())] });
    host.spend.v = openView();
    await openShell();
    await vi.waitFor(() => expect($('[data-request-card] [data-payee]')).not.toBeNull());
    expect($('[data-request-card] [data-payee]')!.getAttribute('data-payee')).toBe('unverified');
    // A pasted invoice's confirm says the same.
    $<HTMLButtonElement>('[data-composer-mode="pay"]')!.click();
    type('[data-pay-invoice]', invoice({ key: STRANGER_KEY }));
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Pay · 26 sats'));
    $<HTMLButtonElement>('[data-send]')!.click();
    await vi.waitFor(() => expect($('[data-pay-review] [data-payee]')).not.toBeNull());
    expect(text('[data-pay-review] [data-payee]')).toContain('not verified as Maya');
    expect(text('[data-pay-review]')).not.toContain('their invoice');
  });

  // Codex #85 P1b: a retained readmission quote raises the message price.
  // Send in chat must show that price from Request mode, send at most it,
  // and a new quote must wait for another explicit Send.
  it('Send in chat shows the readmission total it sends, and a changed quote needs another Send', async () => {
    const first = { admission_msat: 1000, message_msat: 2000, max_routing_fee_msat: 10_000, total_msat: 13_000, quoted: true };
    const raised = { admission_msat: 11_000, message_msat: 2000, max_routing_fee_msat: 10_000, total_msat: 23_000, quoted: true };
    let n = 0;
    const host = stubHost({
      message_send: (args) => {
        n++;
        if (n === 1) throw { code: 'readmission_quoted', message: 'Not sent - nothing was paid. This contact asks for admission again.', admission: first };
        if (n === 2) throw { code: 'readmission_quoted', message: 'Not sent - nothing was paid. This contact asks for admission again.', admission: raised };
        return { message_id: 'sent-1', recipient: args!.recipient, is_room: false, delivered: true, amount_msat: 2000, readmission_msat: 11_000,
          max_routing_fee_msat: 0, total_msat: 13_000, sent_at_ms: Date.now() };
      },
    });
    host.spend.v = openView();
    await openShell();
    type('[data-composer] textarea', 'hi again');
    $<HTMLButtonElement>('[data-send]')!.click();
    await vi.waitFor(() => expect($('[data-readmission-quote]')).not.toBeNull());

    $<HTMLButtonElement>('[data-composer-mode="request"]')!.click();
    type('[data-request-amount]', '21');
    $<HTMLButtonElement>('[data-send]')!.click();
    await vi.waitFor(() => expect($('[data-send-in-chat]')).not.toBeNull());
    // The button shows the price this press may pay: the readmission total.
    expect(text('[data-send-in-chat]')).toBe('Send in chat · 13 sats');
    $<HTMLButtonElement>('[data-send-in-chat]')!.click();
    await vi.waitFor(() => expect(host.used('message_send')).toHaveLength(2));
    expect(host.used('message_send')[1].args).toMatchObject({ plaintext: invoice(), max_msat: 13_000 });

    // Their node now asks more: nothing more is sent until the owner presses Send at that price.
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Send · 23 sats'));
    expect($<HTMLTextAreaElement>('[data-composer] textarea')!.value).toBe(invoice());
    await new Promise((r) => setTimeout(r, 50));
    expect(host.used('message_send')).toHaveLength(2);
    $<HTMLButtonElement>('[data-send]')!.click();
    await vi.waitFor(() => expect(host.used('message_send')).toHaveLength(3));
    expect(host.used('message_send')[2].args).toMatchObject({ plaintext: invoice(), max_msat: 23_000 });
  });

  it('with spending locked, Pay prefills the invoice but shows no review and pays nothing', async () => {
    const host = stubHost({ messages_list: () => [msg('in-1', invoice())] });
    await openShell();
    await vi.waitFor(() => expect($('[data-request-pay]')).not.toBeNull());
    $<HTMLButtonElement>('[data-request-pay]')!.click();
    await vi.waitFor(() => expect($<HTMLTextAreaElement>('[data-pay-invoice]')?.value).toBe(invoice()));
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Approve spending'));
    expect($('[data-pay-review]')).toBeNull();
    expect(host.used('payment_pay')).toHaveLength(0);
  });

  it('shows hostile, invalid, expired, wrong-network and zero-amount bodies as plain text with a short note', async () => {
    const hostile = invoice({ purpose: '<img src=x onerror="window.__pwned=1">\u202eyap ot\u202c' });
    const bodies: [string, string, string | null][] = [
      ['h', hostile, null],
      ['exp', invoice({ at: NOW_S - 7200 }), 'expired'],
      ['net', invoice({ hrp: 'lnbc210n' }), 'wrong_network'],
      ['zero', invoice({ hrp: 'lnbcrt' }), 'no_amount'],
      ['bad', invoice().slice(0, -3) + 'qqq', 'invalid'],
      ['mixed', `see ${invoice()}`, null],
    ];
    const host = stubHost({ messages_list: () => [...bodies.map(([id, body]) => msg(id, body)), msg('out-1', invoice(), OWN)] });
    host.spend.v = openView();
    await openShell();
    await vi.waitFor(() => expect($('[data-message="out-1"]')).not.toBeNull());

    // The hostile purpose is a card whose purpose is inert text.
    await vi.waitFor(() => expect($('[data-message="h"] [data-request-card]')).not.toBeNull());
    expect($('[data-message="h"] img')).toBeNull();
    expect(text('[data-message="h"] [data-request-purpose]')).toBe('For: <img src=x onerror="window.__pwned=1"> yap ot');
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();

    for (const [id, body, reason] of bodies.slice(1)) {
      expect($(`[data-message="${id}"] [data-request-card]`)).toBeNull();
      expect(text(`[data-message="${id}"] .bubble`)).toBe(body);
      expect($(`[data-message="${id}"] [data-request-plain]`)?.getAttribute('data-request-plain') ?? null).toBe(reason);
    }
    expect(text('[data-message="exp"] [data-request-plain]')).toBe('This invoice has expired.');
    expect(text('[data-message="net"] [data-request-plain]')).toBe('This invoice is for another Bitcoin network.');
    // Our own sent invoice stays plain: no card, no Pay.
    expect($('[data-message="out-1"] [data-request-card]')).toBeNull();
    expect($('[data-message="out-1"] [data-request-plain]')).toBeNull();
    expect(host.used('invoice_amount')).toHaveLength(0);
    expect(host.used('payment_pay')).toHaveLength(0);
  });

  it('without a known home network, a well-formed invoice still shows its card', async () => {
    stubHost({ messages_list: () => [msg('in-1', invoice({ hrp: 'lnbc210n' }))] }, null);
    await openShell();
    await vi.waitFor(() => expect($('[data-message="in-1"] [data-request-card]')).not.toBeNull());
  });
});
