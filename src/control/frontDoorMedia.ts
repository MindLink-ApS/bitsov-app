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

/** Only these mimes may appear in a data: image URL. */
export function safeImageMime(mime: string | undefined | null): string | null {
  const m = (mime ?? '').toLowerCase().split(';')[0]!.trim();
  if (m === 'image/png' || m === 'image/jpeg' || m === 'image/webp' || m === 'image/gif') return m;
  if (m === 'image/jpg') return 'image/jpeg';
  return null;
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

export async function prepareAvatar(file: File, hashBytes: HashFn): Promise<PreparedAvatar> {
  let jpeg = await resizeToJpeg(file, AVATAR_EDGE, 0.85);
  if (jpeg.length > AVATAR_MAX_INLINE) {
    jpeg = await resizeToJpeg(file, 64, 0.7);
  }
  const hash = await hashBytes(b64(jpeg));
  if (jpeg.length <= AVATAR_MAX_INLINE) {
    return { inline_b64: b64(jpeg), hash, size: jpeg.length, mime: 'image/jpeg' };
  }
  return { hash, size: jpeg.length, mime: 'image/jpeg' };
}

export async function prepareMedia(
  file: File,
  title: string,
  hashBytes: HashFn,
): Promise<PreparedMedia> {
  const raw = new Uint8Array(await readFile(file));
  const hash = await hashBytes(b64(raw));
  let thumb_b64: string | undefined;
  try {
    const thumb = await resizeToJpeg(file, THUMB_EDGE, 0.75);
    if (thumb.length <= THUMB_MAX_INLINE) thumb_b64 = b64(thumb);
  } catch {
    // Non-image file: hash only, no thumb.
  }
  const mime = safeImageMime(file.type) ?? (file.type || 'application/octet-stream').slice(0, 64);
  return {
    hash,
    size: raw.length,
    mime,
    thumb_b64,
    title: title.trim().slice(0, 64) || file.name.slice(0, 64),
  };
}

export async function hashText(text: string, hashBytes: HashFn): Promise<{ hash: string; size: number }> {
  const bytes = new TextEncoder().encode(text);
  return { hash: await hashBytes(b64(bytes)), size: bytes.length };
}
