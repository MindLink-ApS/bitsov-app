/**
 * Built-in emoji for the composer. Fixed list, no network fetch.
 */

/** Small set shown in the picker (order is display order). */
export const EMOJIS = [
  '😀', '😂', '🙂', '😍', '🙏', '👍', '👎', '❤️',
  '🔥', '🎉', '✅', '❌', '👀', '💬', '📎', '📸',
  '☕', '🚀', '⚡', '🫂', '😅', '🫡', '🤝', '✨',
] as const;

/** Insert `emoji` into `text` at [start, end), returning the next text and caret. */
export function insertEmoji(text: string, emoji: string, start: number, end: number): { next: string; caret: number } {
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));
  return { next: text.slice(0, from) + emoji + text.slice(to), caret: from + emoji.length };
}
