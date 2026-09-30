/**
 * Local prep for front-door avatar / media: resize in-canvas, never fetch remote
 * URLs. Hashes are blake3 from the host. Card stays ≤16 KiB — media by hash,
 * tiny inline avatar/thumb only.
 */

export const AVATAR_MAX_INLINE = 8 * 1024;
export const THUMB_MAX_INLINE = 4 * 1024;
export const AVATAR_EDGE = 96;
export const THUMB_EDGE = 64;
export const MAX_MEDIA_ITEMS = 12;
/** Same ceiling the node enforces on the signed card JSON. */
export const MAX_CARD_BYTES = 16 * 1024;
/**
 * Editor publish budget. Below {@link MAX_CARD_BYTES} so the estimate's omitted
 * pieces (Ed25519 `sig` ≈ 136 JSON bytes, node-attached `site`, longer
 * endpoints) cannot push a "fits" card into a node refusal.
 */
export const CARD_PUBLISH_BUDGET = 15 * 1024;
/** Extra bytes reserved on top of the preview JSON for sig / site / endpoint. */
export const CARD_ESTIMATE_OVERHEAD = 256;

/** Re-encoded canvas output; never a source type like image/svg+xml. */
export const REENCODED_IMAGE_MIME = 'image/jpeg';

/** Only these mimes may appear in a data: image URL. */
export function safeImageMime(mime: string | undefined | null): string | null {
  const m = (mime ?? '').toLowerCase().split(';')[0]!.trim();
  if (m === 'image/png' || m === 'image/jpeg' || m === 'image/webp' || m === 'image/gif') return m;
  if (m === 'image/jpg') return 'image/jpeg';
  return null;
}

/** Filename that might be a safe raster image — used to decide whether to fetch a preview. */
export function looksLikeSafeImageName(name: string): boolean {
  return /\.(png|jpe?g|gif|webp)$/i.test(name.trim());
}

/** CSP allows data: on img-src; blob: is media-only. Avatars use this same shape. */
export function dataImageUrl(data_b64: string, mime: string): string {
  return `data:${mime};base64,${data_b64}`;
}

export type PreparedAvatar = {
  inline_b64?: string;
  hash: string;
  size: number;
  mime: string;
};

export type PreparedMedia = {
  hash: string;
  size: number;
  mime: string;
  thumb_b64?: string;
  title: string;
};

function readFile(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as ArrayBuffer);
    r.onerror = () => reject(new Error('Could not read that image.'));
    r.readAsArrayBuffer(file);
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That file is not a usable image.'));
    img.src = url;
  });
}

/** Draw `file` into a canvas capped at `edge` px on the long side; return JPEG bytes. */
export async function resizeToJpeg(file: File, edge: number, quality = 0.85): Promise<Uint8Array> {
  const buf = await readFile(file);
  const url = URL.createObjectURL(new Blob([buf], { type: file.type || 'application/octet-stream' }));
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, edge / Math.max(img.width, img.height, 1));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas is not available.');
    ctx.drawImage(img, 0, 0, w, h);
    const blob: Blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image.'))), 'image/jpeg', quality);
    });
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}

function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

export type HashFn = (bytesB64: string) => Promise<string>;

export async function prepareAvatar(
  file: File,
  hashBytes: HashFn,
  encode: typeof resizeToJpeg = resizeToJpeg,
): Promise<PreparedAvatar> {
  let jpeg = await encode(file, AVATAR_EDGE, 0.85);
  if (jpeg.length > AVATAR_MAX_INLINE) {
    jpeg = await encode(file, 64, 0.7);
  }
  const hash = await hashBytes(b64(jpeg));
  if (jpeg.length <= AVATAR_MAX_INLINE) {
    return { inline_b64: b64(jpeg), hash, size: jpeg.length, mime: REENCODED_IMAGE_MIME };
  }
  return { hash, size: jpeg.length, mime: REENCODED_IMAGE_MIME };
}

/**
 * Hash the original bytes; if a JPEG thumb fits, attach it and set `mime` to the
 * re-encoded type (`image/jpeg`). Never publish a source mime such as
 * `image/svg+xml` — that would mislabel the thumb data: URL.
 */
export async function prepareMedia(
  file: File,
  title: string,
  hashBytes: HashFn,
  encode: typeof resizeToJpeg = resizeToJpeg,
): Promise<PreparedMedia> {
  const raw = new Uint8Array(await readFile(file));
  const hash = await hashBytes(b64(raw));
  const titleClean = title.trim().slice(0, 64) || file.name.slice(0, 64);
  try {
    const thumb = await encode(file, THUMB_EDGE, 0.75);
    if (thumb.length <= THUMB_MAX_INLINE) {
      return {
        hash,
        size: raw.length,
        mime: REENCODED_IMAGE_MIME,
        thumb_b64: b64(thumb),
        title: titleClean,
      };
    }
  } catch {
    // Non-image (or decode failure): hash only, no thumb.
  }
  return {
    hash,
    size: raw.length,
    mime: 'application/octet-stream',
    title: titleClean,
  };
}

export async function hashText(text: string, hashBytes: HashFn): Promise<{ hash: string; size: number }> {
  const bytes = new TextEncoder().encode(text);
  return { hash: await hashBytes(b64(bytes)), size: bytes.length };
}

export type CardEstimateParts = {
  display_name: string;
  tagline: string;
  about: string;
  avatar?: PreparedAvatar | null;
  media: PreparedMedia[];
  links: { label: string; url: string }[];
  cv?: { path: string; hash: string; size: number } | null;
};

/**
 * Byte length of a JSON body shaped like the node's canonical card fields,
 * plus {@link CARD_ESTIMATE_OVERHEAD} for `sig`, `site`, and endpoint variance.
 * Used as a running pre-check before Publish (editor budget =
 * {@link CARD_PUBLISH_BUDGET}; node max = {@link MAX_CARD_BYTES}).
 */
export function estimateCardBytes(parts: CardEstimateParts): number {
  const avatar = parts.avatar
    ? {
        ...(parts.avatar.inline_b64 ? { inline_b64: parts.avatar.inline_b64 } : {}),
        ...(parts.avatar.hash ? { hash: parts.avatar.hash } : {}),
        ...(parts.avatar.size ? { size: parts.avatar.size } : {}),
        mime: parts.avatar.mime,
      }
    : undefined;
  const body = {
    v: 1,
    network: 'regtest',
    node_id: '0'.repeat(64),
    // Prefer a longer endpoint sample so public DNS names are not understated.
    endpoint: 'node.example.invalid:9735',
    reach: 'public',
    seq: 1,
    issued_at: 1_700_000_000,
    expires_at: 1_700_000_000 + 7 * 86_400,
    prices: { admission_msat: 0, message_msat: 0, page_msat: 0, price_epoch: 0 },
    profile: {
      kind: 'person',
      display_name: parts.display_name,
      tagline: parts.tagline,
      about: parts.about,
      ...(avatar ? { avatar } : {}),
    },
    ...(parts.cv ? { cv: parts.cv } : {}),
    ...(parts.media.length ? { media: parts.media } : {}),
    // Node may attach a site block the editor does not edit (length reserve only).
    site: { title: 'site', url: 'example.invalid/path' },
    ...(parts.links.length ? { links: parts.links } : {}),
    // Ed25519 signature as hex (64 bytes → 128 hex chars).
    sig: '00'.repeat(64),
  };
  return new TextEncoder().encode(JSON.stringify(body)).length + CARD_ESTIMATE_OVERHEAD;
}

/**
 * Drop `thumb_b64` from the oldest media items until the estimate fits, or all
 * thumbs are gone. Returns the trimmed list and how many thumbs were removed.
 */
export function dropOldestThumbsToFit(
  parts: CardEstimateParts,
  maxBytes: number = CARD_PUBLISH_BUDGET,
): { media: PreparedMedia[]; dropped: number; bytes: number } {
  const media = parts.media.map((m) => ({ ...m }));
  let dropped = 0;
  let bytes = estimateCardBytes({ ...parts, media });
  while (bytes > maxBytes) {
    const idx = media.findIndex((m) => m.thumb_b64);
    if (idx < 0) break;
    delete media[idx]!.thumb_b64;
    dropped += 1;
    bytes = estimateCardBytes({ ...parts, media });
  }
  return { media, dropped, bytes };
}

export const CARD_TOO_LARGE =
  `This front door is over ${CARD_PUBLISH_BUDGET} bytes once serialized (node max ${MAX_CARD_BYTES}). Remove media or shorten the text, then try again.`;
