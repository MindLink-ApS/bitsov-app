import { describe, expect, it } from 'vitest';
import {
  AVATAR_MAX_INLINE,
  CARD_PUBLISH_BUDGET,
  CARD_TOO_LARGE,
  dropOldestThumbsToFit,
  estimateCardBytes,
  MAX_CARD_BYTES,
  prepareAvatar,
  prepareMedia,
  REENCODED_IMAGE_MIME,
  safeImageMime,
  THUMB_MAX_INLINE,
  type PreparedMedia,
} from '../src/control/frontDoorMedia';

const hashFn = async (b64: string) => {
  let h = 0;
  for (let i = 0; i < b64.length; i++) h = (h * 31 + b64.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(64, '0').slice(0, 64);
};

const fakeEncode =
  (bytes: number) =>
  async (_file: File, _edge: number, _q?: number): Promise<Uint8Array> =>
    new Uint8Array(bytes).fill(0x7f);

describe('frontDoorMedia prep', () => {
  it('safeImageMime allow-lists only raster types', () => {
    expect(safeImageMime('image/png')).toBe('image/png');
    expect(safeImageMime('image/jpeg')).toBe('image/jpeg');
    expect(safeImageMime('image/svg+xml')).toBeNull();
    expect(safeImageMime('image/png" onerror="x')).toBeNull();
  });

  it('prepareAvatar labels mime as re-encoded JPEG and respects the inline cap', async () => {
    const file = new File([new Uint8Array(32)], 'x.svg', { type: 'image/svg+xml' });
    const small = await prepareAvatar(file, hashFn, fakeEncode(100));
    expect(small.mime).toBe(REENCODED_IMAGE_MIME);
    expect(small.inline_b64).toBeTruthy();
    expect(small.size).toBe(100);
    expect(small.hash).toMatch(/^[0-9a-f]{64}$/);

    const large = await prepareAvatar(file, hashFn, async (_f, edge) => {
      // First call at AVATAR_EDGE is too big; second at 64 fits.
      return new Uint8Array(edge >= 96 ? AVATAR_MAX_INLINE + 1 : 200).fill(1);
    });
    expect(large.mime).toBe(REENCODED_IMAGE_MIME);
    expect(large.inline_b64).toBeTruthy();
    expect(large.size).toBe(200);
  });

  it('prepareMedia sets mime to JPEG when a thumb is kept, never the source type', async () => {
    const file = new File([new Uint8Array(50)], 'pic.svg', { type: 'image/svg+xml' });
    const withThumb = await prepareMedia(file, 'Pic', hashFn, fakeEncode(500));
    expect(withThumb.mime).toBe(REENCODED_IMAGE_MIME);
    expect(withThumb.mime).not.toBe('image/svg+xml');
    expect(withThumb.thumb_b64).toBeTruthy();
    expect(withThumb.size).toBe(50);

    const noThumb = await prepareMedia(file, 'Big', hashFn, fakeEncode(THUMB_MAX_INLINE + 10));
    expect(noThumb.thumb_b64).toBeUndefined();
    expect(noThumb.mime).toBe('application/octet-stream');
  });

  it('prepareMedia hash-only path for non-images (encode throws)', async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'notes.txt', { type: 'text/plain' });
    const item = await prepareMedia(file, 'notes.txt', hashFn, async () => {
      throw new Error('not an image');
    });
    expect(item.thumb_b64).toBeUndefined();
    expect(item.mime).toBe('application/octet-stream');
    expect(item.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(item.size).toBe(4);
  });

  it('estimateCardBytes includes sig/site and dropOldest fits under publish budget', () => {
    const thumb = 'A'.repeat(5500); // ~base64 of a max-ish thumb
    const media: PreparedMedia[] = [
      { hash: 'ab'.repeat(32), size: 1000, mime: REENCODED_IMAGE_MIME, thumb_b64: thumb, title: 'a' },
      { hash: 'cd'.repeat(32), size: 1000, mime: REENCODED_IMAGE_MIME, thumb_b64: thumb, title: 'b' },
      { hash: 'ef'.repeat(32), size: 1000, mime: REENCODED_IMAGE_MIME, thumb_b64: thumb, title: 'c' },
    ];
    const avatar = {
      inline_b64: 'B'.repeat(10_900),
      hash: '11'.repeat(32),
      size: 8000,
      mime: REENCODED_IMAGE_MIME,
    };
    const parts = {
      display_name: 'Rasmus',
      tagline: 'hi',
      about: 'about',
      avatar,
      media,
      links: [{ label: 'Website', url: 'https://example.invalid/path' }],
      cv: null,
    };
    const over = estimateCardBytes(parts);
    expect(over).toBeGreaterThan(CARD_PUBLISH_BUDGET);
    // Estimate must count sig + site so a "fits budget" card cannot hit node 16 KiB.
    const bare = JSON.parse(
      JSON.stringify({
        v: 1,
        profile: { display_name: 'Rasmus', tagline: 'hi', about: 'about', avatar },
        media,
        links: parts.links,
      }),
    );
    // Sanity: full estimate (with sig/site/overhead) exceeds a body that omits them.
    expect(over).toBeGreaterThan(new TextEncoder().encode(JSON.stringify(bare)).length);

    const fit = dropOldestThumbsToFit(parts);
    expect(fit.dropped).toBeGreaterThan(0);
    expect(fit.bytes).toBeLessThanOrEqual(CARD_PUBLISH_BUDGET);
    expect(fit.bytes).toBeLessThanOrEqual(MAX_CARD_BYTES);
    expect(fit.media[0]!.thumb_b64).toBeUndefined();
    expect(CARD_TOO_LARGE).toMatch(/15360|15/);
    expect(CARD_TOO_LARGE).toMatch(/16384|16/);
  });

  it('CARD_PUBLISH_BUDGET leaves headroom under node max', () => {
    expect(CARD_PUBLISH_BUDGET).toBe(15 * 1024);
    expect(MAX_CARD_BYTES).toBe(16 * 1024);
    expect(CARD_PUBLISH_BUDGET).toBeLessThan(MAX_CARD_BYTES);
  });

  it('a near-16 KiB body without margin is refused by the publish budget', () => {
    // Pad about so bare profile JSON sits just under the node max; the editor
    // estimate (sig + site + endpoint + overhead) must still block Publish.
    const about = 'x'.repeat(14_800);
    const parts = {
      display_name: 'Rasmus',
      tagline: 'hi',
      about,
      avatar: null,
      media: [] as PreparedMedia[],
      links: [] as { label: string; url: string }[],
      cv: null,
    };
    const bareLen = new TextEncoder().encode(
      JSON.stringify({ profile: { display_name: 'Rasmus', tagline: 'hi', about } }),
    ).length;
    expect(bareLen).toBeLessThan(MAX_CARD_BYTES);
    const estimated = estimateCardBytes(parts);
    expect(estimated).toBeGreaterThan(CARD_PUBLISH_BUDGET);
    expect(estimated).toBeGreaterThan(bareLen);
  });
});
