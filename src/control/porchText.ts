// Porch pages as text. A page is markdown or plain text from another node: it
// is parsed here into a small tree of text runs that the reader renders with
// text nodes only. Nothing is ever inserted as HTML, a tag in a page is shown
// as the characters it is, and a link or image is shown, never opened or loaded.

/** Genome `MAX_PORCH_PATH_LEN`. */
export const MAX_PORCH_PATH_LEN = 128;
export const PORCH_CARD_PATH = '/front-door.json';
/** More than this many blocks is shown as plain text instead. */
const MAX_BLOCKS = 4000;

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

/** `code`, **strong**, *em* or _em_, [text](url) and ![alt](url); everything else is text. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  const push = (run: Inline) => {
    const last = out[out.length - 1];
    if (run.t === 'text' && last?.t === 'text') last.text += run.text;
    else if (run.t !== 'text' || run.text) out.push(run);
  };
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|(!?)\[([^\]]*)\]\(([^)\s]*)\)|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_/g;
  let at = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    push({ t: 'text', text: src.slice(at, m.index) });
    if (m[1] !== undefined) push({ t: 'code', text: m[1] });
    else if (m[2] !== undefined) push({ t: 'strong', text: m[2] });
    else if (m[4] !== undefined && m[3] === '!') push({ t: 'image', text: m[4] });
    else if (m[4] !== undefined) push({ t: 'link', text: m[4] || m[5], url: m[5] });
    else push({ t: 'em', text: m[6] ?? m[7] });
    at = m.index + m[0].length;
  }
  push({ t: 'text', text: src.slice(at) });
  return out;
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
      blocks.push({ t: 'h', level: Math.min(heading[1].length, 3) as 1 | 2 | 3, inline: parseInline(heading[2].replace(/\s+#+$/, '')) });
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
  return blocks.length > MAX_BLOCKS ? [{ t: 'code', text: cleanText(src) }] : blocks;
}
