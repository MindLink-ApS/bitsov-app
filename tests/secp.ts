// Test-only crypto for signing BOLT11 fixtures: SHA-256 and secp256k1 point
// arithmetic. The app does no key recovery: an invoice's payee comes only
// from the host's decode. Plain BigInt, no dependency; not constant-time.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256(data: Uint8Array): Uint8Array {
  const bitLen = data.length * 8;
  const padded = new Uint8Array(Math.ceil((data.length + 9) / 64) * 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 2 ** 32));
  view.setUint32(padded.length - 4, bitLen >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  h.forEach((v, i) => ov.setUint32(i * 4, v));
  return out;
}

// ---- secp256k1 ----

export const P = 2n ** 256n - 2n ** 32n - 977n;
export const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
export type Point = { x: bigint; y: bigint } | null;
export const G: Point = {
  x: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
};

const mod = (a: bigint, m: bigint) => ((a % m) + m) % m;
function pow(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n;
  b = mod(b, m);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}
const inv = (a: bigint, m: bigint) => pow(a, m - 2n, m);

// Jacobian coordinates; z = 0n is the point at infinity.
type J = [bigint, bigint, bigint];
function jDouble([x, y, z]: J): J {
  if (z === 0n || y === 0n) return [0n, 1n, 0n];
  const yy = (y * y) % P;
  const s = (4n * x * yy) % P;
  const m = (3n * x * x) % P;
  const x3 = mod(m * m - 2n * s, P);
  return [x3, mod(m * (s - x3) - 8n * yy * yy, P), (2n * y * z) % P];
}
function jAdd(a: J, b: J): J {
  if (a[2] === 0n) return b;
  if (b[2] === 0n) return a;
  const z1z1 = (a[2] * a[2]) % P;
  const z2z2 = (b[2] * b[2]) % P;
  const u1 = (a[0] * z2z2) % P;
  const u2 = (b[0] * z1z1) % P;
  const s1 = (a[1] * z2z2 * b[2]) % P;
  const s2 = (b[1] * z1z1 * a[2]) % P;
  if (u1 === u2) return s1 === s2 ? jDouble(a) : [0n, 1n, 0n];
  const h = mod(u2 - u1, P);
  const r = mod(s2 - s1, P);
  const hh = (h * h) % P;
  const hhh = (hh * h) % P;
  const x3 = mod(r * r - hhh - 2n * u1 * hh, P);
  return [x3, mod(r * (u1 * hh - x3) - s1 * hhh, P), (h * a[2] * b[2]) % P];
}
function jMul(p: J, k: bigint): J {
  let acc: J = [0n, 1n, 0n];
  let add = p;
  while (k > 0n) {
    if (k & 1n) acc = jAdd(acc, add);
    add = jDouble(add);
    k >>= 1n;
  }
  return acc;
}
const toJ = (p: Point): J => (p ? [p.x, p.y, 1n] : [0n, 1n, 0n]);
function toAffine([x, y, z]: J): Point {
  if (z === 0n) return null;
  const zi = inv(z, P);
  const zi2 = (zi * zi) % P;
  return { x: (x * zi2) % P, y: (y * zi2 * zi) % P };
}

export const pointMul = (p: Point, k: bigint): Point => toAffine(jMul(toJ(p), mod(k, N)));

export const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
export const toBig = (bytes: Uint8Array) => (bytes.length === 0 ? 0n : BigInt('0x' + hex(bytes)));

/** 33-byte compressed public key, hex. */
export const compress = (p: NonNullable<Point>) => (p.y & 1n ? '03' : '02') + p.x.toString(16).padStart(64, '0');
