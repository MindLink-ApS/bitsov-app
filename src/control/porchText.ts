// Porch pages as text. A page is markdown or plain text from another node: it
// is parsed here into a small tree of text runs that the reader renders with
// text nodes only. Nothing is ever inserted as HTML, a tag in a page is shown
// as the characters it is, and a link or image is shown, never opened or loaded.

/** Genome `MAX_PORCH_PATH_LEN`. */
export const MAX_PORCH_PATH_LEN = 128;
export const PORCH_CARD_PATH = '/front-door.json';
/** A page that would render more elements than this (blocks, list items, inline runs) is shown as plain text instead. */
const MAX_NODES = 20_000;

/** A flat, visible `.md`/`.txt` page or the card, canonical with its leading `/`; null otherwise (host `porch_path`). */
export function porchPath(input: string): string | null {
  const t = input.trim();
  const path = t.startsWith('/') ? t : `/${t}`;
  if (path === PORCH_CARD_PATH) return path;
  const name = path.slice(1);
  const ok =
    path.length <= MAX_PORCH_PATH_LEN &&
    !name.startsWith('.') &&
    (name.endsWith('.md') || name.endsWith('.txt')) &&
    !name.includes('..') &&
    !/[/\\%\p{Cc}]/u.test(name);
  return ok ? path : null;
}

/** Controls (keeping newline and tab) and invisible or direction-changing characters, removed (host `clean_text`). */
export function cleanText(text: string): string {
  return text
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, '');
}

export type Inline =
  | { t: 'text' | 'code' | 'em' | 'strong'; text: string }
  | { t: 'link'; text: string; url: string }
  | { t: 'image'; text: string };

export type Block =
  | { t: 'h'; level: 1 | 2 | 3; inline: Inline[] }
  | { t: 'p'; inline: Inline[] }
  | { t: 'list'; ordered: boolean; items: Inline[][] }
  | { t: 'quote'; inline: Inline[] }
  | { t: 'code'; text: string }
  | { t: 'hr' };

/**
 * For each position, the first index at or after it whose character is a hit
 * (`src.length` if none), so each delimiter lookup in `parseInline` is O(1).
 */
function nextHit(src: string, hit: (c: string) => boolean): Int32Array {
  const next = new Int32Array(src.length + 2).fill(src.length);
  for (let i = src.length - 1; i >= 0; i--) next[i] = hit(src[i]) ? i : next[i + 1];
  return next;
}

const isSpace = (c: string) => /\s/.test(c);

/**
 * `code`, **strong**, *em* or _em_, [text](url) and ![alt](url); everything
 * else is text. One left-to-right pass: a page is untrusted, so the scan stays
 * linear in its length whatever delimiters it repeats.
 */
export function parseInline(src: string): Inline[] {
  const n = src.length;
  const tick = nextHit(src, (c) => c === '`');
  const star = nextHit(src, (c) => c === '*');
  const under = nextHit(src, (c) => c === '_');
  const close = nextHit(src, (c) => c === ']');
  const paren = nextHit(src, (c) => c === ')');
  const space = nextHit(src, isSpace);
  const out: Inline[] = [];
  let from = 0;
  let i = 0;
  while (i < n) {
    const c = src[i];
    let run: Inline | null = null;
    let end = i;
    if (c === '`') {
      const j = tick[i + 1];
      if (j < n && j > i + 1) [run, end] = [{ t: 'code', text: src.slice(i + 1, j) }, j + 1];
    } else if (c === '*' || c === '_') {
      if (c === '*' && src[i + 1] === '*') {
        const j = star[i + 2];
        if (j > i + 2 && src[j + 1] === '*') [run, end] = [{ t: 'strong', text: src.slice(i + 2, j) }, j + 2];
      }
      if (!run && i + 1 < n && src[i + 1] !== c && !isSpace(src[i + 1])) {
        const j = (c === '*' ? star : under)[i + 1];
        if (j < n) [run, end] = [{ t: 'em', text: src.slice(i + 1, j) }, j + 1];
      }
    } else if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      const open = c === '!' ? i + 1 : i;
      const j = close[open + 1];
      const k = j < n && src[j + 1] === '(' ? paren[j + 2] : n;
      if (k < n && space[j + 2] > k) {
        const text = src.slice(open + 1, j);
        const url = src.slice(j + 2, k);
        [run, end] = [c === '!' ? { t: 'image', text } : { t: 'link', text: text || url, url }, k + 1];
      }
    }
    if (!run) {
      i++;
      continue;
    }
    if (i > from) out.push({ t: 'text', text: src.slice(from, i) });
    out.push(run);
    from = i = end;
  }
  if (n > from) out.push({ t: 'text', text: src.slice(from) });
  return out;
}

/** A heading's optional closing `#`s, removed when whitespace separates them from the text. */
function headingText(s: string): string {
  let hashes = s.length;
  while (hashes > 0 && s[hashes - 1] === '#') hashes--;
  let text = hashes;
  while (text > 0 && isSpace(s[text - 1])) text--;
  return hashes < s.length && text < hashes ? s.slice(0, text) : s;
}

/** A bounded, line-based subset of markdown: headings, paragraphs, lists, quotes, fenced code, rules. */
export function parseMarkdown(src: string): Block[] {
  const lines = cleanText(src).split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  let quote: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (para.length) blocks.push({ t: 'p', inline: parseInline(para.join(' ')) });
    if (quote.length) blocks.push({ t: 'quote', inline: parseInline(quote.join(' ')) });
    if (list) blocks.push({ t: 'list', ordered: list.ordered, items: list.items.map(parseInline) });
    para = [];
    quote = [];
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith('```'); i++) code.push(lines[i]);
      blocks.push({ t: 'code', text: code.join('\n') });
      continue;
    }
    if (!trimmed) {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flush();
      blocks.push({ t: 'h', level: Math.min(heading[1].length, 3) as 1 | 2 | 3, inline: parseInline(headingText(heading[2])) });
      continue;
    }
    if (/^([-*_])(\s*\1){2,}$/.test(trimmed)) {
      flush();
      blocks.push({ t: 'hr' });
      continue;
    }
    const item = /^(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/.exec(trimmed);
    if (item) {
      const ordered = item[2] !== undefined;
      if (!list || list.ordered !== ordered) {
        flush();
        list = { ordered, items: [] };
      }
      list.items.push(item[3]);
      continue;
    }
    if (trimmed.startsWith('>')) {
      if (!quote.length) flush();
      quote.push(trimmed.replace(/^>\s?/, ''));
      continue;
    }
    if (list) {
      list.items[list.items.length - 1] += ` ${trimmed}`;
      continue;
    }
    if (quote.length) flush();
    para.push(trimmed);
  }
  flush();
  return nodes(blocks) > MAX_NODES ? [{ t: 'code', text: cleanText(src) }] : blocks;
}

function nodes(blocks: Block[]): number {
  let count = blocks.length;
  for (const b of blocks) {
    if (b.t === 'list') for (const item of b.items) count += 1 + item.length;
    else if (b.t === 'h' || b.t === 'p' || b.t === 'quote') count += b.inline.length;
  }
  return count;
}
