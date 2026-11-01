#!/usr/bin/env node
// Fails when an emulator screenshot (`adb exec-out screencap -p`) shows nothing
// in the middle of the screen: a black frame (no GPU output, or the app is
// still starting) or one flat colour (an app shell whose web view never
// rendered). Only the central area counts, so the status bar, navigation
// handle and screen edges cannot pass it. Reads 8-bit RGB/RGBA PNG only.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const MARGIN = 0.1; // ignore the status bar, navigation handle and edges
const DIFF = 24; // per-channel distance that counts as visible content
const MIN_SHARE = 0.005; // at least 0.5 % of the body must differ

class CheckError extends Error {}

function decode(buffer) {
  if (buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new CheckError('screenshot is not a PNG image');
  let offset = 8;
  let header;
  const data = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') header = body;
    else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (!header || data.length === 0) throw new CheckError('screenshot PNG has no image data');
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const [depth, colour, , , interlace] = header.subarray(8, 13);
  const channels = colour === 6 ? 4 : colour === 2 ? 3 : 0;
  if (depth !== 8 || channels === 0 || interlace !== 0) {
    throw new CheckError('screenshot PNG format is not supported (need 8-bit RGB or RGBA, not interlaced)');
  }
  const raw = zlib.inflateSync(Buffer.concat(data));
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new CheckError('screenshot PNG data is truncated');
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[out + x - channels] : 0;
      const up = y > 0 ? pixels[out - stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[out - stride + x - channels] : 0;
      let value = row[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      } else if (filter !== 0) throw new CheckError('screenshot PNG uses an unknown row filter');
      pixels[out + x] = value & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

export function inspect(buffer) {
  const { width, height, channels, pixels } = decode(buffer);
  const [left, right] = [Math.floor(width * MARGIN), Math.ceil(width * (1 - MARGIN))];
  const [top, bottom] = [Math.floor(height * MARGIN), Math.ceil(height * (1 - MARGIN))];
  // Sample on a grid; the result only needs to tell content from a flat frame.
  const step = Math.max(1, Math.floor(Math.min(width, height) / 200));
  const samples = [];
  let brightest = 0;
  for (let y = top; y < bottom; y += step) {
    for (let x = left; x < right; x += step) {
      const i = (y * width + x) * channels;
      const rgb = [pixels[i], pixels[i + 1], pixels[i + 2]];
      brightest = Math.max(brightest, ...rgb);
      samples.push(rgb);
    }
  }
  const median = [0, 1, 2].map(c => samples.map(s => s[c]).sort((a, b) => a - b)[samples.length >> 1]);
  const differing = samples.filter(s => s.some((v, c) => Math.abs(v - median[c]) > DIFF)).length;
  return { black: brightest < DIFF, share: differing / samples.length };
}

/** Returns an error message, or null when the screenshot shows content. */
export function verdict(buffer) {
  let result;
  try { result = inspect(buffer); } catch (error) {
    if (error instanceof CheckError) return error.message;
    throw error;
  }
  if (result.black) return 'screenshot is black in the middle of the screen: the emulator or app did not render (still starting, or no GPU output)';
  if (result.share < MIN_SHARE) return 'screenshot is one flat colour in the middle of the screen: the app did not render its first screen';
  return null;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) { console.error('usage: android-screenshot-check.mjs <screenshot.png>'); process.exit(2); }
  const buffer = fs.readFileSync(file);
  const message = verdict(buffer);
  if (message) { console.error(message); process.exit(1); }
  const { share } = inspect(buffer);
  console.log(`screenshot shows content (${(share * 100).toFixed(1)} % of the screen differs from the background)`);
}
