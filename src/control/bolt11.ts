// A chat message whose whole body is a BOLT11 invoice: read it for display
// only. Nothing here pays or trusts the text. The amount, purpose and expiry
// are shown on a request card; paying still goes through the host's own
// invoice_amount read, the Pay review and its one confirm tap. The signature
// is not checked here: the node checks it and refuses to pay a bad invoice.

import { MAX_PAYMENT_MSAT, MIN_PAYMENT_MSAT } from './amountInput';

/** Networks as the host names them (`act::bolt11_network`). */
export type InvoiceNetwork = 'mainnet' | 'testnet' | 'signet' | 'regtest';

export type ChatInvoice = {
  /** The invoice as sent, without `lightning:`, lower case. */
  bolt11: string;
  msat: number;
  network: InvoiceNetwork;
  /** The payee's `d` field, cleaned for display. Null when absent or hash-only. */
  purpose: string | null;
  /** Unix ms. */
  expiresAtMs: number;
};

/** Why a body that looks like an invoice is shown as plain text. */
export type NotPayable = 'invalid' | 'expired' | 'wrong_network' | 'no_amount' | 'out_of_bounds';

export type ChatInvoiceRead = { ok: true; invoice: ChatInvoice } | { ok: false; reason: NotPayable };

export const NOT_PAYABLE_NOTE: Record<NotPayable, string> = {
  invalid: 'Looks like an invoice, but it is not a valid one.',
  expired: 'This invoice has expired.',
  wrong_network: 'This invoice is for another Bitcoin network.',
  no_amount: 'This invoice names no amount, so the app cannot show its cost.',
  out_of_bounds: 'The app pays invoices between 1 sat and 1 BTC only.',
};

/** BOLT11 allows up to 639 bytes of description; the card shows less. */
const PURPOSE_MAX = 140;
/** Longer than any invoice the app would read; refused before decoding. */
const BODY_MAX = 2048;
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const NETWORKS: Record<string, InvoiceNetwork> = { bc: 'mainnet', tb: 'testnet', tbs: 'signet', bcrt: 'regtest' };
const MULTIPLIER_MSAT: Record<string, bigint> = { m: 100_000_000n, u: 100_000n, n: 100n };
const BTC_MSAT = 100_000_000_000n;

/** One token that could be an invoice: `ln…1…`, optionally `lightning:`. */
const INVOICE_LIKE = /^(?:lightning:)?ln[a-z0-9]{2,}$/i;

/**
 * Read a message body as an invoice. `null`: not invoice-shaped at all (plain
 * text, no note). Otherwise the invoice, or why it is not payable here.
 * `homeNetwork` null means this node's network is unknown: not refused on it.
 */
export function readChatInvoice(body: string | null | undefined, nowMs: number, homeNetwork: string | null): ChatInvoiceRead | null {
  if (typeof body !== 'string') return null;
  const text = body.trim();
  if (text.length === 0 || text.length > BODY_MAX || !INVOICE_LIKE.test(text) || !text.includes('1')) return null;
  const inv = decode(text.replace(/^lightning:/i, ''));
  if (!inv) return { ok: false, reason: 'invalid' };
  if (homeNetwork !== null && inv.network !== homeNetwork) return { ok: false, reason: 'wrong_network' };
  if (inv.msat === null || inv.msat === 0) return { ok: false, reason: 'no_amount' };
  if (inv.msat < MIN_PAYMENT_MSAT || inv.msat > MAX_PAYMENT_MSAT) return { ok: false, reason: 'out_of_bounds' };
  if (inv.expiresAtMs <= nowMs) return { ok: false, reason: 'expired' };
  return { ok: true, invoice: { ...inv, msat: inv.msat } };
}

type Decoded = Omit<ChatInvoice, 'msat'> & { msat: number | null };

function decode(raw: string): Decoded | null {
  // Bech32 is single-case; mixed case is invalid.
  if (raw !== raw.toLowerCase() && raw !== raw.toUpperCase()) return null;
  const s = raw.toLowerCase();
  const sep = s.lastIndexOf('1');
  if (sep < 3) return null;
  const hrp = s.slice(0, sep);
  const words: number[] = [];
  for (const c of s.slice(sep + 1)) {
    const v = CHARSET.indexOf(c);
    if (v < 0) return null;
    words.push(v);
  }
  // Checksum (6) + timestamp (7) + signature (104).
  if (words.length < 6 + 7 + 104 || !checksumOk(hrp, words)) return null;

  const h = /^ln(bcrt|bc|tbs|tb)(?:([1-9]\d*)([munp]?))?$/.exec(hrp);
  if (!h) return null;
  const network = NETWORKS[h[1]];
  let msat: number | null = null;
  if (h[2] !== undefined) {
    const n = BigInt(h[2]);
    let m: bigint;
    if (h[3] === 'p') {
      if (n % 10n !== 0n) return null;
      m = n / 10n;
    } else {
      m = h[3] ? n * MULTIPLIER_MSAT[h[3]] : n * BTC_MSAT;
    }
    // Above 1 BTC is refused later; cap the number so it stays exact.
    msat = m > BigInt(MAX_PAYMENT_MSAT) ? MAX_PAYMENT_MSAT + 1 : Number(m);
  }

  const data = words.slice(0, -6);
  const fields = data.slice(0, -104);
  const timestamp = toInt(fields.slice(0, 7));
  let expirySecs = 3600;
  let purpose: string | null = null;
  let hasHash = false;
  let at = 7;
  while (at < fields.length) {
    if (at + 3 > fields.length) return null;
    const type = fields[at];
    const len = fields[at + 1] * 32 + fields[at + 2];
    const value = fields.slice(at + 3, at + 3 + len);
    if (value.length !== len) return null;
    at += 3 + len;
    if (type === 1 && len === 52) hasHash = true; // p: payment hash
    else if (type === 6) expirySecs = toInt(value); // x: expiry
    else if (type === 13) {
      // d: description, UTF-8
      const bytes = toBytes(value);
      if (!bytes) return null;
      try {
        purpose = cleanPurpose(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        return null;
      }
    }
  }
  if (!hasHash) return null;
  return { bolt11: s, msat, network, purpose, expiresAtMs: (timestamp + expirySecs) * 1000 };
}

/**
 * Peer-chosen text: drop control, bidi-override and zero-width characters,
 * fold whitespace, and cap the length. Rendered as text, never markup.
 */
export function cleanPurpose(text: string): string | null {
  const cleaned = text
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  const chars = Array.from(cleaned);
  return chars.length > PURPOSE_MAX ? `${chars.slice(0, PURPOSE_MAX - 1).join('')}…` : cleaned;
}

function toInt(words: number[]): number {
  return words.reduce((acc, w) => acc * 32 + w, 0);
}

/** 5-bit words to bytes; trailing padding bits are dropped. */
function toBytes(words: number[]): Uint8Array | null {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const w of words) {
    acc = (acc << 5) | w;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
    acc &= (1 << bits) - 1;
  }
  return new Uint8Array(out);
}

const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function checksumOk(hrp: string, words: number[]): boolean {
  return polymod([...hrpExpand(hrp), ...words]) === 1;
}

/** Test helper: the bech32 checksum words for `hrp` + `data`. */
export function bech32Checksum(hrp: string, data: number[]): number[] {
  const mod = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  return Array.from({ length: 6 }, (_, i) => (mod >> (5 * (5 - i))) & 31);
}

export const BECH32_CHARSET = CHARSET;
