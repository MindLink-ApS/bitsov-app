import { describe, expect, it } from 'vitest';
import { EMOJIS, insertEmoji } from '../src/control/emoji';

describe('emoji set', () => {
  it('is a fixed built-in list with no empty entries', () => {
    expect(EMOJIS.length).toBe(24);
    expect(new Set(EMOJIS).size).toBe(EMOJIS.length);
    for (const e of EMOJIS) expect(e.length).toBeGreaterThan(0);
  });

  it('inserts at the caret without a network fetch', () => {
    expect(insertEmoji('', '😀', 0, 0)).toEqual({ next: '😀', caret: '😀'.length });
    expect(insertEmoji('ab', '✨', 1, 1)).toEqual({ next: 'a✨b', caret: 1 + '✨'.length });
  });
});
