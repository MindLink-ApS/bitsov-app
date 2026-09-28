// Minimal QR encoder — byte mode, error-correction level M, versions 1–30.
//
// Vendored on purpose. The funding address is the money-critical pixel on the
// screen, so the code that draws it stays auditable in-tree rather than being a
// third-party package that could silently re-encode a different address. The
// address is ALWAYS rendered as selectable text beside the QR: the text is
// authoritative, the QR is a convenience.
//
// Versions 1–30 at level M carry up to 1,370 bytes: any on-chain address, a
// BOLT11 invoice with a memo (usually 250–600 characters; version 10's 213 bytes
// silently dropped the invoice QR), and a K1 starter-bitcoin request, which
// wraps a whole invoice (~750 bytes; version 20's 666 dropped it). Encoding is per ISO/IEC 18004 (Reed–Solomon over GF(256), the eight
// standard masks, standard penalty scoring).

/** [ec codewords per block, group-1 blocks, g1 data cw, group-2 blocks, g2 data cw] — level M. */
const EC_M: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [10, 1, 16, 0, 0],
  [16, 1, 28, 0, 0],
  [26, 1, 44, 0, 0],
  [18, 2, 32, 0, 0],
  [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0],
  [18, 4, 31, 0, 0],
  [22, 2, 38, 2, 39],
  [22, 3, 36, 2, 37],
  [26, 4, 43, 1, 44],
  [30, 1, 50, 4, 51],
  [22, 6, 36, 2, 37],
  [22, 8, 37, 1, 38],
  [24, 4, 40, 5, 41],
  [24, 5, 41, 5, 42],
  [28, 7, 45, 3, 46],
  [28, 10, 46, 1, 47],
  [26, 9, 43, 4, 44],
  [26, 3, 44, 11, 45],
  [26, 3, 41, 13, 42],
  // 21–30: a K1 starter-bitcoin request carries a whole BOLT11 invoice (~750+ bytes).
  [26, 17, 42, 0, 0],
  [28, 17, 46, 0, 0],
  [28, 4, 47, 14, 48],
  [28, 6, 45, 14, 46],
  [28, 8, 47, 13, 48],
  [28, 19, 46, 4, 47],
  [28, 22, 45, 3, 46],
  [28, 3, 45, 23, 46],
  [28, 21, 45, 7, 46],
  [28, 19, 47, 10, 48],
];

/** Alignment-pattern centre coordinates per version (1-indexed by version - 1). */
const ALIGN: ReadonlyArray<readonly number[]> = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90],
  [6, 28, 50, 72, 94],
  [6, 26, 50, 74, 98],
  [6, 30, 54, 78, 102],
  [6, 28, 54, 80, 106],
  [6, 32, 58, 84, 110],
  [6, 30, 58, 86, 114],
  [6, 34, 62, 90, 118],
  [6, 26, 50, 74, 98, 122],
  [6, 30, 54, 78, 102, 126],
  [6, 26, 52, 78, 104, 130],
];

// ---- GF(256) arithmetic (primitive polynomial 0x11D) ----------------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];

const mul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Reed–Solomon generator polynomial of the given degree, highest term first. */
function generatorPoly(degree: number): Uint8Array {
  let poly = Uint8Array.of(1);
  for (let d = 0; d < degree; d++) {
    const next = new Uint8Array(poly.length + 1);
    for (let i = 0; i < poly.length; i++) {
      next[i] ^= poly[i]; // × x
      next[i + 1] ^= mul(poly[i], EXP[d]); // × α^d
    }
    poly = next;
  }
  return poly;
}

/** Reed–Solomon remainder — the error-correction codewords for one block. */
function ecCodewords(data: Uint8Array, ecLen: number): Uint8Array {
  const gen = generatorPoly(ecLen);
  const rem = new Uint8Array(ecLen);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.copyWithin(0, 1);
    rem[ecLen - 1] = 0;
    for (let i = 0; i < ecLen; i++) rem[i] ^= mul(gen[i + 1], factor);
  }
  return rem;
}

/** Smallest version (1–30) whose level-M byte-mode capacity holds `byteLen`. */
function pickVersion(byteLen: number): number {
  for (let version = 1; version <= EC_M.length; version++) {
    const [, g1, g1d, g2, g2d] = EC_M[version - 1];
    const dataBits = (g1 * g1d + g2 * g2d) * 8;
    const headerBits = 4 + (version >= 10 ? 16 : 8);
    if (dataBits - headerBits >= byteLen * 8) return version;
  }
  throw new Error('value too long to encode as a QR code');
}

/** Mode + length header, payload, padding, block split, EC, interleave. */
function encodeCodewords(bytes: Uint8Array, version: number): Uint8Array {
  const [ecPerBlock, g1, g1d, g2, g2d] = EC_M[version - 1];
  const totalData = g1 * g1d + g2 * g2d;
  const capacityBits = totalData * 8;

  const bits: number[] = [];
  const put = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4); // byte mode
  put(bytes.length, version >= 10 ? 16 : 8); // byte-mode count: 16 bits from version 10 on
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, capacityBits - bits.length)); // terminator
  while (bits.length % 8 !== 0) bits.push(0);
  for (let i = 0; bits.length < capacityBits; i++) put(i % 2 === 0 ? 0xec : 0x11, 8);

  const codewords = new Uint8Array(totalData);
  for (let i = 0; i < totalData; i++) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j];
    codewords[i] = v;
  }

  const blocks: Uint8Array[] = [];
  let pos = 0;
  for (let i = 0; i < g1; i++, pos += g1d) blocks.push(codewords.slice(pos, pos + g1d));
  for (let i = 0; i < g2; i++, pos += g2d) blocks.push(codewords.slice(pos, pos + g2d));
  const ec = blocks.map((b) => ecCodewords(b, ecPerBlock));

  const out: number[] = [];
  const maxData = Math.max(g1d, g2d);
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ecPerBlock; i++) for (const e of ec) out.push(e[i]);
  return Uint8Array.from(out);
}

type Grid = { size: number; dark: boolean[][]; fn: boolean[][] };

/** Finder, separator, timing and alignment patterns + reserved format/version areas. */
function functionPatterns(version: number): Grid {
  const size = version * 4 + 17;
  const dark: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fn: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (r: number, c: number, on: boolean) => {
    if (r >= 0 && r < size && c >= 0 && c < size) {
      dark[r][c] = on;
      fn[r][c] = true;
    }
  };

  // Finder patterns + their separators (the -1/+7 ring).
  for (const [r0, c0] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ]) {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const inner = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const ring = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        set(r0 + dr, c0 + dc, inner && (ring || core));
      }
    }
  }

  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  // Alignment patterns — skipped where they would collide with a finder.
  const centres = ALIGN[version - 1];
  for (const r0 of centres) {
    for (const c0 of centres) {
      const onFinder =
        (r0 === 6 && c0 === 6) || (r0 === 6 && c0 === size - 7) || (r0 === size - 7 && c0 === 6);
      if (onFinder) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          set(r0 + dr, c0 + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  // Reserve the format-info strips (written after masking) and the always-dark module.
  // Index 6 is skipped: row 6 / column 6 are timing modules, not format modules.
  for (let i = 0; i <= 8; i++) {
    if (i === 6) continue;
    set(8, i, false);
    set(i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    set(size - 1 - i, 8, false);
    set(8, size - 1 - i, false);
  }
  set(size - 8, 8, true);

  // Reserve the version-info blocks (versions 7+).
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, false);
      set(b, a, false);
    }
  }

  return { size, dark, fn };
}

/** Zig-zag placement of the interleaved codewords into the non-function modules. */
function placeData(grid: Grid, codewords: Uint8Array): void {
  const { size, dark, fn } = grid;
  let bit = 0;
  const total = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // column 6 is the vertical timing pattern
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        const upward = ((right + 1) & 2) === 0;
        const r = upward ? size - 1 - vert : vert;
        if (fn[r][c]) continue;
        // Runs past the last data bit are the version's remainder bits: left light.
        if (bit < total) dark[r][c] = ((codewords[bit >>> 3] >>> (7 - (bit & 7))) & 1) === 1;
        bit++;
      }
    }
  }
}

const maskAt = (mask: number, r: number, c: number): boolean => {
  switch (mask) {
    case 0:
      return (r + c) % 2 === 0;
    case 1:
      return r % 2 === 0;
    case 2:
      return c % 3 === 0;
    case 3:
      return (r + c) % 3 === 0;
    case 4:
      return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5:
      return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6:
      return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default:
      return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
};

/** Standard penalty score (rules N1–N4) used to pick the mask. */
function penalty(dark: boolean[][], size: number): number {
  let score = 0;

  // N1 — runs of five or more same-coloured modules in a row or column.
  const runs = (get: (i: number, j: number) => boolean) => {
    for (let i = 0; i < size; i++) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        if (get(i, j) === get(i, j - 1)) {
          run++;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  };
  runs((i, j) => dark[i][j]);
  runs((i, j) => dark[j][i]);

  // N2 — 2×2 blocks of one colour.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = dark[r][c];
      if (v === dark[r][c + 1] && v === dark[r + 1][c] && v === dark[r + 1][c + 1]) score += 3;
    }
  }

  // N3 — finder-like 1:1:3:1:1 patterns with four light modules on either side.
  const FINDER = [true, false, true, true, true, false, true];
  const light4 = [false, false, false, false];
  const matches = (get: (k: number) => boolean, start: number, want: boolean[]): boolean =>
    want.every((w, k) => get(start + k) === w);
  for (let i = 0; i < size; i++) {
    for (let j = 0; j + 11 <= size; j++) {
      for (const line of [(k: number) => dark[i][k], (k: number) => dark[k][i]]) {
        if (matches(line, j, [...FINDER, ...light4])) score += 40;
        if (matches(line, j, [...light4, ...FINDER])) score += 40;
      }
    }
  }

  // N4 — deviation of the dark-module proportion from 50%.
  let darkCount = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (dark[r][c]) darkCount++;
  const percent = (darkCount * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/** 15-bit BCH format information for level M and the chosen mask. */
function formatBits(mask: number): number {
  const data = 0b00 /* level M */ * 8 + mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** 18-bit BCH version information (versions 7+). */
function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

function drawFormat(grid: Grid, mask: number): void {
  const { size, dark } = grid;
  const bits = formatBits(mask);
  // Most-significant bit first, in the module order of ISO/IEC 18004 figure 25.
  const bit = (j: number) => ((bits >>> (14 - j)) & 1) === 1;
  const copy1: ReadonlyArray<readonly [number, number]> = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  const copy2: ReadonlyArray<readonly [number, number]> = [
    [size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8],
    [size - 5, 8], [size - 6, 8], [size - 7, 8],
    [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5],
    [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1],
  ];
  copy1.forEach(([r, c], j) => (dark[r][c] = bit(j)));
  copy2.forEach(([r, c], j) => (dark[r][c] = bit(j)));
  dark[size - 8][8] = true; // always dark
}

function drawVersion(grid: Grid, version: number): void {
  if (version < 7) return;
  const { size, dark } = grid;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const on = ((bits >>> i) & 1) === 1;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    dark[a][b] = on;
    dark[b][a] = on;
  }
}

/**
 * Encode `text` (UTF-8, byte mode, level M) into a square matrix of modules.
 * `true` = dark. Throws if the value does not fit in versions 1–30.
 */
export function qrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  const version = pickVersion(bytes.length);
  const codewords = encodeCodewords(bytes, version);

  let best: boolean[][] | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const grid = functionPatterns(version);
    placeData(grid, codewords);
    for (let r = 0; r < grid.size; r++) {
      for (let c = 0; c < grid.size; c++) {
        if (!grid.fn[r][c] && maskAt(mask, r, c)) grid.dark[r][c] = !grid.dark[r][c];
      }
    }
    drawFormat(grid, mask);
    drawVersion(grid, version);
    const score = penalty(grid.dark, grid.size);
    if (score < bestScore) {
      bestScore = score;
      best = grid.dark;
    }
  }
  return best!;
}

/**
 * An SVG `path` covering every dark module, plus the viewBox extent.
 * The 4-module quiet zone required by the spec is included in `extent`.
 */
export function qrSvg(text: string, quiet = 4): { extent: number; path: string } {
  const matrix = qrMatrix(text);
  const parts: string[] = [];
  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix.length; c++) {
      if (matrix[r][c]) parts.push(`M${c + quiet} ${r + quiet}h1v1h-1z`);
    }
  }
  return { extent: matrix.length + quiet * 2, path: parts.join('') };
}
