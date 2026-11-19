// Exit 0 only if the cargo-xwin DONE marker at argv[2] lists the architecture argv[3],
// read the way cargo-xwin 0.23 reads it: the whole file as strict UTF-8, the first line
// (lines(): split on LF, one trailing CR removed), tokens from split_whitespace() (Unicode
// White_Space). Anything else, including an unreadable file, exits 1.
import { readFileSync } from 'node:fs';

// Rust char::is_whitespace: the Unicode White_Space code points.
const WHITE_SPACE = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

const [file, want] = process.argv.slice(2);
try {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file));
  if (text.length === 0) process.exit(1);
  let first = text.split('\n')[0];
  if (first.endsWith('\r')) first = first.slice(0, -1);
  const tokens = [];
  let current = '';
  for (const ch of first) {
    if (WHITE_SPACE.has(ch.codePointAt(0))) {
      if (current) tokens.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  process.exit(tokens.includes(want) ? 0 : 1);
} catch {
  process.exit(1);
}
