import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import * as bolt11Module from '../src/control/bolt11';
import { BECH32_CHARSET, bech32Checksum, cleanPurpose, payeeView, readChatInvoice } from '../src/control/bolt11';
import { compress, G, N, pointMul, sha256, toBig } from './secp';
import type { InvoiceAmount, SpendView } from '../src/control/types';
import { resetContactsForTests, setPetname } from '../src/control/petnames';

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

function invoice(opts: { hrp?: string; purpose?: string | null; descBytes?: Uint8Array; at?: number; expiry?: number; hash?: boolean; hashByte?: number; key?: bigint; payeeTags?: string[] } = {}) {
  const hrp = opts.hrp ?? 'lnbcrt210n';
  const desc = opts.descBytes ?? (opts.purpose === null ? null : new TextEncoder().encode(opts.purpose ?? 'dinner'));
  const data = [
    ...words(opts.at ?? NOW_S, 7),
    ...(opts.hash === false ? [] : tag(1, bytesToWords(new Uint8Array(32).fill(opts.hashByte ?? 7)))),
    ...(desc === null ? [] : tag(13, bytesToWords(desc))),
    ...(opts.expiry === undefined ? [] : tag(6, words(opts.expiry, 3))),
    ...(opts.payeeTags ?? []).flatMap((n) => tag(19, bytesToWords(Uint8Array.from(n.match(/../g)!.map((h) => parseInt(h, 16)))))),
  ];
  const all = [...data, ...sign(hrp, data, opts.key ?? MAYA_KEY)];
  const out = hrp + '1' + [...all, ...bech32Checksum(hrp, all)].map((w) => BECH32_CHARSET[w]).join('');
  HOST_READS.set(out, hostReadOf(hrp, opts, desc));
  return out;
}

// ---- a test stand-in for the host's `invoice_amount` ----
// The real host decodes with lightning-invoice (src-tauri act.rs tests); here
// each invoice this file signs is registered with what that decode returns.
// Anything else is refused, as the host refuses what it cannot parse.

const HOST_READS = new Map<string, Omit<InvoiceAmount, 'bolt11'> | null>();
const HRP = /^ln(bcrt|bc|tbs|tb)(?:(\d+)([munp]?))?$/;
const NET: Record<string, string> = { bc: 'mainnet', tb: 'testnet', tbs: 'signet', bcrt: 'regtest' };
const UNIT: Record<string, number> = { '': 100_000_000_000, m: 100_000_000, u: 100_000, n: 100, p: 0.1 };

function hostReadOf(hrp: string, opts: Parameters<typeof invoice>[0] & object, desc: Uint8Array | null): Omit<InvoiceAmount, 'bolt11'> | null {
  const h = HRP.exec(hrp);
  const signer = pubOf(opts.key ?? MAYA_KEY);
  const tags = opts.payeeTags ?? [];
  // lightning-invoice checks the signature against the first n; this file never writes two.
  if (!h || !h[2] || opts.hash === false || tags.length > 1 || (tags.length === 1 && tags[0] !== signer)) return null;
  let description: string | null = null;
  try {
    description = desc === null ? null : new TextDecoder('utf-8', { fatal: true }).decode(desc);
  } catch {
    return null;
  }
  return {
    amount_msat: Math.round(Number(h[2]) * UNIT[h[3]]),
    network: NET[h[1]],
    payee: signer,
    expires_at_ms: ((opts.at ?? NOW_S) + (opts.expiry ?? 3600)) * 1000,
    payment_hash: (opts.hashByte ?? 7).toString(16).padStart(2, '0').repeat(32),
    description,
  };
}

const HOST_REFUSAL = { code: 'invalid', message: 'That is not a valid Lightning invoice.' };
function hostDecode(text: string): InvoiceAmount {
  const bolt11 = text.trim().toLowerCase().replace(/^lightning:/, '');
  const read = HOST_READS.get(bolt11);
  if (!read) throw HOST_REFUSAL;
  return { ...read, bolt11 };
}

/**
 * A regtest invoice signed by CANONICAL_PAYEE, and three
 * re-encodings (a set padding bit in p, a leading zero word in c and in the
 * features) that the node's parser reads as that same invoice while their raw
 * words recover other keys. The real host refuses all three (act.rs tests).
 */
const CANONICAL_PAYEE = '031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f';
const NONCANONICAL = [
  'lnbcrt210n1p45n5sqdq2v35kumn9wgpp5vj92t3telvc08zhhgnvh6mkggrr6jynh5jv6p4uq70nnznk2py93sp5qszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszq9qrsgqcqpjgpd0vndshg0682c4gpxyde0sr785uz9eqc36yjugphpzpkn55zmy6v4nszm0ym8vqwvgrp4jh9us9d593yftaz5sgxwyxyf9z0hmsnsq3ul59u',
  'lnbcrt210n1p45n5sqdq2v35kumn9wgpp5vj92t3telvc08zhhgnvh6mkggrr6jynh5jv6p4uq70nnznk2py9ssp5qszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszq9qrsgqcqzqjgpd0vndshg0682c4gpxyde0sr785uz9eqc36yjugphpzpkn55zmy6v4nszm0ym8vqwvgrp4jh9us9d593yftaz5sgxwyxyf9z0hmsnsq53y0av',
  'lnbcrt210n1p45n5sqdq2v35kumn9wgpp5vj92t3telvc08zhhgnvh6mkggrr6jynh5jv6p4uq70nnznk2py9ssp5qszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszq9qyqsgqcqpjgpd0vndshg0682c4gpxyde0sr785uz9eqc36yjugphpzpkn55zmy6v4nszm0ym8vqwvgrp4jh9us9d593yftaz5sgxwyxyf9z0hmsnsqfvef43',
];
/** When the fixtures (timestamp 1_800_000_000) are still unexpired. */
const FIXTURE_NOW = 1_800_000_000_000 + 1000;

const NOW = Date.now();

describe('reading a chat invoice', () => {
  it('reads the BOLT11 spec vectors: amount, purpose, expiry', () => {
    const coffee =
      'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp';
    const r = readChatInvoice(coffee, 1496314658_000, 'mainnet');
    expect(r).toEqual({ ok: true, invoice: { bolt11: coffee, msat: 250_000_000, network: 'mainnet', purpose: '1 cup coffee', expiresAtMs: 1496314718_000, paymentHash: '0001020304050607080900010203040506070809000102030405060708090102' } });
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

  // The node hashes its canonical re-serialization, so a
  // payee recovered from raw words can differ from the one it pays. The shape
  // filter therefore names no payee at all; only the host's decode does.
  it('never names a payee: not for canonical, non-canonical or n-carrying invoices', () => {
    expect('invoicePayee' in bolt11Module).toBe(false);
    const maya = pubOf(MAYA_KEY);
    for (const body of [invoice(), invoice({ key: STRANGER_KEY }), invoice({ payeeTags: [maya] }), invoice({ payeeTags: [pubOf(STRANGER_KEY)] }), ...NONCANONICAL]) {
      const r = readChatInvoice(body, 0, 'regtest'); // expiry aside
      const inv = r?.ok ? r.invoice : null;
      expect(inv).not.toBeNull();
      expect(inv).not.toHaveProperty('payee');
      expect(JSON.stringify(inv)).not.toContain(maya.slice(2, 20));
    }
    // The display contract: anything displayed for these is null or the node's payee.
    for (const body of NONCANONICAL) {
      const r = readChatInvoice(body, FIXTURE_NOW, 'regtest');
      expect(r).toMatchObject({ ok: true, invoice: { msat: 21_000 } });
      expect(JSON.stringify(r)).not.toMatch(/0[23][0-9a-f]{64}/);
      expect(() => hostDecode(body)).toThrow();
    }
    // More than one n is refused before the host is asked.
    expect(readChatInvoice(invoice({ payeeTags: [maya, pubOf(STRANGER_KEY)] }), NOW, 'regtest')).toEqual({ ok: false, reason: 'invalid' });
    expect(readChatInvoice(invoice({ payeeTags: [maya, maya] }), NOW, 'regtest')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('checks the host reading against network, bounds and expiry', () => {
    const read = { ...hostDecode(invoice()) };
    expect(bolt11Module.hostReadProblem(read, NOW, 'regtest')).toBeNull();
    expect(bolt11Module.hostReadProblem(read, NOW, null)).toBe('wrong_network');
    expect(bolt11Module.hostReadProblem(read, NOW, 'mainnet')).toBe('wrong_network');
    expect(bolt11Module.hostReadProblem({ ...read, amount_msat: 0 }, NOW, 'regtest')).toBe('no_amount');
    expect(bolt11Module.hostReadProblem({ ...read, amount_msat: 999 }, NOW, 'regtest')).toBe('out_of_bounds');
    expect(bolt11Module.hostReadProblem({ ...read, amount_msat: 100_000_000_001 }, NOW, 'regtest')).toBe('out_of_bounds');
    expect(bolt11Module.hostReadProblem(read, read.expires_at_ms, 'regtest')).toBe('expired');
  });

  // Made by the node's own parser, lightning-invoice 0.34.1 (build_raw, then
  // sign with key A = [1; 32]; n fields as named). The node pays the FIRST n
  // and checks the signature only against it; the host decode reports that.
  // The shape filter only drops the ambiguous two-n forms early.
  it('passes single-n invoices to the host and drops two-n ones', () => {
    const at = FIXTURE_NOW;
    const pre = 'lnbcrt210n1p45n5sqdq2v35kumn9wgpp5vj92t3telvc08zhhgnvh6mkggrr6jynh5jv6p4uq70nnznk2py9ssp5qszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszq9qrsgqcqpj';
    const fixtures = {
      none: pre + 'gpd0vndshg0682c4gpxyde0sr785uz9eqc36yjugphpzpkn55zmy6v4nszm0ym8vqwvgrp4jh9us9d593yftaz5sgxwyxyf9z0hmsnsqcufc8l',
      singleMatch: pre + 'np4qvdcf32k0vfxgsyet5ldt246q4jaw8scx3sysx0lnstlt6w4m5rc7utvphkf0r6r8hqss2xsg5pa3k5094vr0szxcaq96z28ytekr7at380elc26wu0j6u7fzhxwwux67vsqs7jpyfk0dqar3y86qj3urrvqpvaf6md',
      // host: refused, InvalidSignature (n = B)
      singleMismatch: pre + 'np4qfx5kmx3xcgr9j5m62htnkgq4fx5tk02mq9vjs3nwnz9rfe9f5rkv8wux8u2ga730fxufdqte2kkh7vk2yu57uemxxguwr26kpwhh528qq36j5yrvjd0mgtvazaghc2svyvauk5u4sacaarg20n4upjk3jjsqa2gc5d',
      firstASecondB: pre + 'np4qvdcf32k0vfxgsyet5ldt246q4jaw8scx3sysx0lnstlt6w4m5rc7np4qfx5kmx3xcgr9j5m62htnkgq4fx5tk02mq9vjs3nwnz9rfe9f5rkv3rm04y0hjt5slsn8hkpnr6dwmddgyeyvl0aemz5g5d2ctczrjj5pp4wncd5lyr20gflggpvvfx46k4a0xc846dz9ph0qvtdaq24fcscp7jk8gj',
      firstBSecondA: pre + 'np4qfx5kmx3xcgr9j5m62htnkgq4fx5tk02mq9vjs3nwnz9rfe9f5rkvnp4qvdcf32k0vfxgsyet5ldt246q4jaw8scx3sysx0lnstlt6w4m5rc7j44sjlpqhxkph2mgd8te06zgfs2rrd7fsaas4se6a8agvdeyu6nhxq0cpfqnd0fx8q00r5smg33r8wzz3vk75mfex5crwdrm3eqt37cpafxyt3',
    };
    expect(readChatInvoice(fixtures.none, at, 'regtest')).toMatchObject({ ok: true, invoice: { msat: 21_000, purpose: 'dinner' } });
    for (const bolt11 of [fixtures.singleMatch, fixtures.singleMismatch]) expect(readChatInvoice(bolt11, at, 'regtest')).toMatchObject({ ok: true });
    for (const bolt11 of [fixtures.firstASecondB, fixtures.firstBSecondA]) expect(readChatInvoice(bolt11, at, 'regtest')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('names the payee as the contact only when their Lightning node id is known and matches', () => {
    const maya = pubOf(MAYA_KEY);
    expect(payeeView(maya, maya.toUpperCase(), 'Maya')).toEqual({ verified: true, text: 'Maya' });
    expect(payeeView(maya, null, 'Maya')).toEqual({ verified: false, text: `Lightning node ${maya.slice(0, 8)}…${maya.slice(-4)}, not verified as Maya` });
    expect(payeeView(pubOf(STRANGER_KEY), maya, 'Maya').verified).toBe(false);
  });

  it.each([null, 'unknown', 'future-network'])('fails closed for unknown home network %s', home => {
    const bolt11 = invoice();
    expect(readChatInvoice(bolt11, NOW, home)).toEqual({ ok: false, reason: 'wrong_network' });
    expect(bolt11Module.hostReadProblem(hostDecode(bolt11), NOW, home)).toBe('wrong_network');
  });

  it('refuses a mainnet invoice on a remote signet node in both checks', () => {
    const bolt11 = invoice({ hrp: 'lnbc210n' });
    expect(readChatInvoice(bolt11, NOW, 'signet')).toEqual({ ok: false, reason: 'wrong_network' });
    expect(bolt11Module.hostReadProblem(hostDecode(bolt11), NOW, 'signet')).toBe('wrong_network');
  });

  it('reads each network and amount unit exactly', () => {
    const at = (hrp: string) => readChatInvoice(invoice({ hrp }), NOW, NET[HRP.exec(hrp)![1]]);
    expect(at('lnbcrt210n')).toMatchObject({ ok: true, invoice: { msat: 21_000, network: 'regtest', purpose: 'dinner' } });
    expect(at('lntb1m')).toMatchObject({ ok: true, invoice: { msat: 100_000_000, network: 'testnet' } });
    expect(at('lntbs20u')).toMatchObject({ ok: true, invoice: { msat: 2_000_000, network: 'signet' } });
    expect(at('lnbc10000p')).toMatchObject({ ok: true, invoice: { msat: 1000, network: 'mainnet' } });
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

const paired = { state: 'paired', scopes: ['read', 'receive'], short_code: 'ABCD-EFGH', code_from_node: true, reason: null, remote: false, bootstrap: null };
type Call = { cmd: string; args: Record<string, unknown> | undefined };
type Reply = (args?: Record<string, unknown>) => unknown;
// A #227 host: an open window names its grant and the request that armed it.
const view = (state: SpendView['state'], extra: Partial<SpendView> = {}): SpendView => ({
  state, basis: null, open_until_ms: null, pending: null, window_ms: WINDOW, granted_op: null, armed_by_request: null, ...extra,
});
const openView = () => view('open', { basis: 'node_grant', open_until_ms: Date.now() + WINDOW, granted_op: 'cd34', armed_by_request: 'ab12' });
const msg = (id: string, plaintext: string, sender = A, kind = 1) =>
  ({ id, kind, sender, recipient: sender === A ? OWN : A, timestamp: Date.now() - 1000, plaintext, payment_amount_msat: 2000 });

function stubHost(overrides: Record<string, Reply> = {}, network: string | null = 'regtest') {
  resetContactsForTests();
  setPetname(A, 'Maya');
  const calls: Call[] = [];
  const spend = { v: view('locked') };
  const REPLIES: Record<string, Reply> = {
    node_status: () => ({ ready: true, node_id: OWN, error: null }),
    trust_acknowledge: () => true,
    pairing_status: () => paired,
    node_overview: () => ({
      node_id: OWN, status: 'ok', version: 'api v2', connected_peers: 1, e2ee_sessions: 1, pending_deliveries: 0,
      lightning_available: true, block_height: 1, uptime_secs: 1, lightning_backend: 'ldk', chain_backend: 'esplora', read_at: Date.now(),
      ...(network ? { network } : {}),
    }),
    peers_list: () => [{ node_id: A, addr: null, label: 'Maya', connected: true, fingerprint: null }],
    rooms_list: () => [],
    messages_list: () => [],
    price_quote: () => ({ kind: 0, own_msat: 1000, peer_msat: 2000, peer_age_secs: 30, max_routing_fee_msat: 0, peer_stale: false }),
    payments_overview: () => ({ balance_msat: 1_000_000, lightning_outbound_msat: 500_000, channels: [] }),
    fund_state: () => null,
    file_price: () => ({ principal_msat: 3000, max_routing_fee_msat: 5000, total_msat: 8000 }),
    spend_status: () => spend.v,
    spend_request: () => {
      spend.v = view('pending', { pending: { op_id: 'ab12', expires_at_ms: Date.now() + 900_000, owner_action: 'konsensus grant --op ab12', owner_can_grant: true } });
      return { ...spend.v, request_id: 'ab12' };
    },
    message_send: (args) => ({ message_id: 'sent-1', recipient: args!.recipient, is_room: args!.is_room, delivered: true, amount_msat: 2000, sent_at_ms: Date.now() }),
    invoice_amount: (args) => hostDecode(args!.bolt11 as string),
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
    expect(text('[data-send-in-chat]')).toBe('Send in chat · 2 sats');
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
    // Approve & send: the invoice waits in its bubble until the approval lands; nothing is sent before.
    expect(text('[data-sending="waiting"] .bubble')).toBe(invoice());
    expect($<HTMLTextAreaElement>('[data-composer] textarea')!.value).toBe('');
    await vi.waitFor(() => expect($('[data-approval="pending"]')).not.toBeNull());
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

  // A contact can forward someone else's invoice. Neither the
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
  });

  // The #83 pasted-invoice review had the same "Pay Maya · their invoice" wording.
  it('a pasted invoice’s review names its payee, not verified as the contact', async () => {
    const stranger = pubOf(STRANGER_KEY);
    const host = stubHost();
    host.spend.v = openView();
    await openShell();
    $<HTMLButtonElement>('[data-composer-mode="pay"]')!.click();
    type('[data-pay-invoice]', invoice({ key: STRANGER_KEY }));
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Pay · 26 sats'));
    $<HTMLButtonElement>('[data-send]')!.click();
    await vi.waitFor(() => expect($('[data-pay-review] [data-payee]')).not.toBeNull());
    expect(text('[data-pay-review] .pay-review-title')).toBe('Pay this Lightning invoice');
    expect(text('[data-pay-review] [data-payee]')).toBe(`Pays Lightning node ${stranger.slice(0, 8)}…${stranger.slice(-4)}, not verified as Maya.`);
    expect(text('[data-pay-review]')).not.toContain('Pay Maya');
    expect(text('[data-pay-review]')).not.toContain('their invoice');
    expect(host.used('payment_pay')).toHaveLength(0);
  });

  // The card must not name a second n while the node pays the first.
  it('an invoice with two n fields, or an n the host refuses, is plain text with a note: no card, no Pay, no payee', async () => {
    const bolt11 = invoice({ payeeTags: [pubOf(MAYA_KEY), pubOf(STRANGER_KEY)] });
    const host = stubHost({ messages_list: () => [msg('two-n', bolt11), msg('bad-n', invoice({ payeeTags: [pubOf(STRANGER_KEY)] }))] });
    host.spend.v = openView();
    await openShell();
    await vi.waitFor(() => expect($('[data-message="bad-n"] [data-request-plain]')).not.toBeNull());
    for (const id of ['two-n', 'bad-n']) {
      expect($(`[data-message="${id}"] [data-request-card]`)).toBeNull();
      expect($(`[data-message="${id}"] [data-payee]`)).toBeNull();
      expect(text(`[data-message="${id}"] [data-request-plain]`)).toBe('Looks like an invoice, but it is not a valid one.');
    }
    // The two-n body never reached the host; the single bad n did and was refused.
    expect(host.used('invoice_amount').map((c) => c.args)).toEqual([{ bolt11: invoice({ payeeTags: [pubOf(STRANGER_KEY)] }) }]);
    // Pasted into Pay, the host refuses it: no amount, no review, no node named.
    $<HTMLButtonElement>('[data-composer-mode="pay"]')!.click();
    type('[data-pay-invoice]', bolt11);
    await vi.waitFor(() => expect(text('[data-composer]')).toContain('That is not a valid Lightning invoice.'));
    expect($<HTMLButtonElement>('[data-send]')!.disabled).toBe(true);
    $<HTMLButtonElement>('[data-send]')!.click();
    expect($('[data-pay-review]')).toBeNull();
    expect(host.used('payment_pay')).toHaveLength(0);
  });

  // A typed pubkey in Maya's thread is not Maya's node either.
  it('the Direct review names the typed node, not verified as the contact, not "Pay Maya"', async () => {
    const stranger = pubOf(STRANGER_KEY);
    const host = stubHost();
    host.spend.v = openView();
    await openShell();
    $<HTMLButtonElement>('[data-composer-mode="pay"]')!.click();
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Direct')!.click();
    await vi.waitFor(() => expect($('[data-pay-pubkey]')).not.toBeNull());
    type('[data-pay-amount]', '21');
    type('[data-pay-pubkey]', stranger);
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-send]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-send]')!.click();
    await vi.waitFor(() => expect($('[data-pay-review]')).not.toBeNull());
    expect(text('[data-pay-review] .pay-review-title')).toBe('Pay a Lightning node directly');
    expect(text('[data-pay-review] [data-payee]')).toBe(`Pays Lightning node ${stranger.slice(0, 8)}…${stranger.slice(-4)}, not verified as Maya.`);
    expect($('[data-pay-review] [data-payee]')!.getAttribute('data-payee')).toBe('unverified');
    expect(text('[data-pay-review]')).not.toContain('Pay Maya');
    expect(host.used('payment_keysend')).toHaveLength(0);
  });

  // After paying, the card says so and offers no second Pay.
  it('marks a paid card by payment hash, including a re-cased copy, and keeps other cards payable', async () => {
    const bolt11 = invoice();
    const other = invoice({ purpose: 'second round', hashByte: 8 });
    const host = stubHost({ messages_list: () => [msg('in-1', bolt11), msg('in-2', `lightning:${bolt11.toUpperCase()}`), msg('in-3', other)] });
    host.spend.v = openView();
    await openShell();
    await vi.waitFor(() => expect($('[data-message="in-3"] [data-request-card]')).not.toBeNull());
    for (const id of ['in-1', 'in-2', 'in-3']) expect($(`[data-message="${id}"] [data-request-card]`)!.getAttribute('data-request-status')).toBe('open');
    $<HTMLButtonElement>('[data-message="in-1"] [data-request-pay]')!.click();
    await vi.waitFor(() => expect($('[data-pay-confirm]')).not.toBeNull());
    $<HTMLButtonElement>('[data-pay-confirm]')!.click();
    await vi.waitFor(() => expect($('[data-message="in-1"] [data-request-paid]')).not.toBeNull());
    expect(text('[data-message="in-1"] [data-request-paid]')).toBe('Paid. You paid this invoice.');
    for (const id of ['in-1', 'in-2']) {
      expect($(`[data-message="${id}"] [data-request-card]`)!.getAttribute('data-request-status')).toBe('settled');
      expect($(`[data-message="${id}"] [data-request-pay]`)).toBeNull();
    }
    expect($('[data-message="in-3"] [data-request-pay]')).not.toBeNull();
    expect(host.used('payment_pay')).toHaveLength(1);
  });

  it.each([
    ['pending', 'pending'],
    ['inflight', 'inflight'],
    ['failed', 'open'],
  ])('a %s payment leaves the card %s', async (status, shown) => {
    const host = stubHost({
      messages_list: () => [msg('in-1', invoice())],
      payment_pay: (args) => ({ method: 'invoice', amount_msat: args!.amount_msat, status, paid_at_ms: Date.now() }),
    });
    host.spend.v = openView();
    await openShell();
    await vi.waitFor(() => expect($('[data-request-pay]')).not.toBeNull());
    $<HTMLButtonElement>('[data-request-pay]')!.click();
    await vi.waitFor(() => expect($('[data-pay-confirm]')).not.toBeNull());
    $<HTMLButtonElement>('[data-pay-confirm]')!.click();
    await vi.waitFor(() => expect($('[data-artifact="payment"]')).not.toBeNull());
    expect($('[data-request-card]')!.getAttribute('data-request-status')).toBe(shown);
    expect($('[data-request-pay]') === null).toBe(shown !== 'open');
  });

  // A retained readmission quote raises the message price.
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
    await vi.waitFor(() => expect(text('[data-send-price]')).toBe('price went up to 23 sats, send?'));
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
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Send'));
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
    // Only the body that passed the shape filter was read by the host.
    expect(host.used('invoice_amount').map((c) => c.args)).toEqual([{ bolt11: hostile }]);
    expect(host.used('payment_pay')).toHaveLength(0);
  });

  it.each([null, 'future-network', 'signet'])('refuses a mainnet invoice for unknown or remote signet network %s', async network => {
    const host = stubHost({ messages_list: () => [msg('in-1', invoice({ hrp: 'lnbc210n' }))] }, network);
    await openShell();
    await vi.waitFor(() => expect(text('[data-message="in-1"] [data-request-plain]')).toBe('This invoice is for another Bitcoin network.'));
    expect($('[data-message="in-1"] [data-request-card]')).toBeNull();
    expect(host.used('payment_pay')).toHaveLength(0);
  });
  // Card and confirm show only the host's decode.
  it('card and confirm show the host’s payee and amount, and pay its canonical invoice', async () => {
    const hostPayee = pubOf(STRANGER_KEY);
    const signedByMaya = invoice({ purpose: 'dinner' });
    const host = stubHost({
      messages_list: () => [msg('in-1', `lightning:${signedByMaya.toUpperCase()}`)],
      // Whatever a local decoder would recover, the host's answer is what is shown.
      invoice_amount: (args) => ({ ...hostDecode(args!.bolt11 as string), payee: hostPayee, amount_msat: 22_000, description: 'host says lunch' }),
    });
    host.spend.v = openView();
    await openShell();
    await vi.waitFor(() => expect($('[data-request-card]')).not.toBeNull());
    const short = `${hostPayee.slice(0, 8)}…${hostPayee.slice(-4)}`;
    expect($('[data-request-card]')!.getAttribute('data-request-msat')).toBe('22000');
    expect(text('[data-request-purpose]')).toBe('For: host says lunch');
    expect(text('[data-request-card] [data-payee]')).toBe(`Pays Lightning node ${short}, not verified as Maya.`);
    expect(text('[data-request-card]')).not.toContain(pubOf(MAYA_KEY).slice(0, 8));

    $<HTMLButtonElement>('[data-request-pay]')!.click();
    await vi.waitFor(() => expect($('[data-pay-review]')).not.toBeNull());
    expect(text('[data-pay-review] [data-payee]')).toBe(`Pays Lightning node ${short}, not verified as Maya.`);
    expect(text('[data-review-amount]')).toBe('22 sats');
    $<HTMLButtonElement>('[data-pay-confirm]')!.click();
    await vi.waitFor(() => expect(host.used('payment_pay')).toHaveLength(1));
    // The canonical string the host returned, not the prefixed upper-case body.
    expect(host.used('payment_pay')[0].args).toEqual({ bolt11: signedByMaya, amount_msat: 22_000, max_msat: 27_000 });
  });

  it('until the host answers, a received invoice is plain text with no card, amount or payee', async () => {
    let answer: (v: InvoiceAmount) => void = () => {};
    const bolt11 = invoice();
    const host = stubHost({ messages_list: () => [msg('in-1', bolt11)], invoice_amount: () => new Promise<InvoiceAmount>((r) => { answer = r; }) });
    host.spend.v = openView();
    await openShell();
    await vi.waitFor(() => expect(host.used('invoice_amount')).toHaveLength(1));
    expect($('[data-request-card]')).toBeNull();
    expect($('[data-payee]')).toBeNull();
    expect(text('[data-message="in-1"] .bubble')).toBe(bolt11);
    answer(hostDecode(bolt11));
    await vi.waitFor(() => expect($('[data-request-card] [data-payee]')).not.toBeNull());
  });

  it('non-canonical encodings: no card, no payee, no review, nothing paid', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: FIXTURE_NOW });
    try {
      const refusal = { code: 'invalid', message: 'This invoice is not in its standard encoding, so the app cannot be sure who it pays. Ask for a fresh invoice.' };
      const host = stubHost({
        messages_list: () => NONCANONICAL.map((b, i) => msg(`nc-${i}`, b)),
        // What the real host returns for each (act.rs: a_non_canonical_encoding_is_refused_whatever_its_signer).
        invoice_amount: () => { throw refusal; },
      });
      host.spend.v = openView();
      await openShell();
      await vi.waitFor(() => expect($('[data-message="nc-2"] [data-request-plain]')).not.toBeNull());
      NONCANONICAL.forEach((b, i) => {
        expect($(`[data-message="nc-${i}"] [data-request-card]`)).toBeNull();
        expect(text(`[data-message="nc-${i}"] .bubble`)).toBe(b);
        expect(text(`[data-message="nc-${i}"] [data-request-plain]`)).toBe('Looks like an invoice, but it is not a valid one.');
      });
      expect($('[data-payee]')).toBeNull();
      expect(mount.textContent).not.toMatch(/Lightning node 0[23]/);

      $<HTMLButtonElement>('[data-composer-mode="pay"]')!.click();
      type('[data-pay-invoice]', NONCANONICAL[0]);
      await vi.waitFor(() => expect(text('[data-composer]')).toContain('not in its standard encoding'));
      $<HTMLButtonElement>('[data-send]')!.click();
      expect($('[data-pay-review]')).toBeNull();
      expect(mount.textContent).not.toContain(CANONICAL_PAYEE.slice(0, 8));
      expect(host.used('payment_pay')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
