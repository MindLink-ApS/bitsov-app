import { t as tr } from '../i18n';
/**
 * Voice notes: a short Opus clip recorded in the webview and sent as an
 * ordinary paid file (KIND_FILE_REF = 200, `audio/webm`). Nothing here pays:
 * the clip goes through the composer's file path, with its budget, approval
 * and exactly-once rules. The dedicated kind 202 comes later.
 */

/** About two minutes; the recorder stops itself here. */
export const VOICE_MAX_MS = 120_000;
/**
 * WebKit's MP4/AAC recorder may ignore the requested bitrate (about 128 kbps
 * observed), so its clips are capped shorter: 80 s at 128 kbps is 1.28 MB.
 */
export const VOICE_MP4_MAX_MS = 80_000;
/** The app sends files up to 1.4 MB (act.rs FILE_MAX_BYTES). */
export const FILE_MAX_BYTES = 1_400_000;
/** The recorder stops itself once the clip reaches this, whatever the codec. */
export const VOICE_MAX_BYTES = 1_300_000;

/** How long a clip of this recorded type may run. */
export function voiceLimitMs(recorded: string): number {
  return sendType(recorded) === 'audio/mp4' ? VOICE_MP4_MAX_MS : VOICE_MAX_MS;
}
/** Opus at 32 kbps keeps two minutes near 480 KB, well inside the 1.4 MB file cap. */
export const VOICE_BITS_PER_SECOND = 32_000;
/** The wire type for a voice note. WebKit before WebM recording falls back to MP4/AAC. */
export const VOICE_MIME = 'audio/webm';

const RECORD_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];

/** The first container this webview can record, or null when it cannot record audio at all. */
export function pickRecordType(supported: (type: string) => boolean): string | null {
  return RECORD_TYPES.find((t) => supported(t)) ?? null;
}

/** The type a clip is sent as: codec parameters dropped, WebM named `audio/webm`. */
export function sendType(recorded: string): string {
  const base = recorded.split(';')[0].trim().toLowerCase();
  return base === 'audio/mp4' ? 'audio/mp4' : VOICE_MIME;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `voice-note-20260929-221503.webm`: plain ASCII, no path separators. */
export function voiceFileName(atMs: number, type: string): string {
  const d = new Date(atMs);
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `voice-note-${stamp}.${type === 'audio/mp4' ? 'm4a' : 'webm'}`;
}

/**
 * The file name a kind-200 message names: the plaintext itself, the node's
 * `[file: name]`, or the file record some messages carry as JSON
 * (`{"filename": ..., "data_b64": ...}`). The payload itself is never a name.
 */
export function fileNameOf(plaintext: string | null): string | null {
  if (plaintext === null) return null;
  const text = plaintext.trim();
  if (text.startsWith('{')) {
    try {
      const v: unknown = JSON.parse(text);
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const o = v as Record<string, unknown>;
        const n = [o.filename, o.name, o.file_name].find((x): x is string => typeof x === 'string' && x.trim() !== '');
        return n ? baseName(n) : null;
      }
    } catch {
      // A truncated or malformed file record: its text is payload, never a name.
      return null;
    }
  }
  // A bare payload (base64 or a data: URI) is never a name.
  if (bareB64(text) !== null || DATA_URI.test(text)) return null;
  const m = /^\[file: (.+)\]$/.exec(text);
  return baseName(m ? m[1] : text);
}

const DATA_URI = /^data:([\w.+-]+\/[\w.+-]+)?(?:;[\w=.+-]+)*;base64,([A-Za-z0-9+/\s]+={0,2})$/;

/**
 * Bare text read as file bytes only when nothing else fits: one unbroken run of
 * the base64 alphabet (line wraps allowed, never a space), long, with the mix
 * random bytes give (upper, lower, digits) and a `+`, `/` or padding. Anything
 * in doubt stays text: a missed file reads as text, a sentence must never vanish.
 */
function bareB64(text: string): string | null {
  if (/[ \t]/.test(text)) return null;
  const b = text.replace(/\r?\n/g, '');
  if (b.length < 120 || b.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b)) return null;
  if (!/[+/]/.test(b) && !b.endsWith('=')) return null;
  const share = (re: RegExp) => (b.match(re)?.length ?? 0) / b.length;
  if (share(/[A-Z]/g) < 0.15 || share(/[a-z]/g) < 0.15 || share(/[0-9]/g) < 0.03) return null;
  if (new Set(b).size < 24) return null;
  return b;
}

function decodedSize(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

export type Attachment = { name: string | null; mime: string | null; size: number; b64: string };

/**
 * A message whose text is a file's bytes (a bare base64 blob, a data: URI, or a
 * file record with `data_b64`): shown as a file card, never as text.
 */
export function attachmentOf(plaintext: string | null): Attachment | null {
  if (plaintext === null) return null;
  const text = plaintext.trim();
  if (text.startsWith('{')) {
    try {
      const v: unknown = JSON.parse(text);
      if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
      const o = v as Record<string, unknown>;
      const data = [o.data_b64, o.data, o.content_b64].find((x): x is string => typeof x === 'string');
      const b = data?.replace(/\s+/g, '') ?? '';
      // A file record's payload may be short; it is still bytes, not a message.
      if (!b || b.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b)) return null;
      const n = [o.filename, o.name, o.file_name].find((x): x is string => typeof x === 'string' && x.trim() !== '');
      const mime = [o.mime_type, o.mime, o.type].find((x): x is string => typeof x === 'string' && x.trim() !== '');
      return { name: n ? baseName(n) : null, mime: mime ?? null, size: decodedSize(b), b64: b };
    } catch {
      return null;
    }
  }
  const uri = DATA_URI.exec(text);
  if (uri) {
    const b = uri[2].replace(/\s+/g, '');
    return { name: null, mime: uri[1] ?? null, size: decodedSize(b), b64: b };
  }
  const b = bareB64(text);
  return b === null ? null : { name: null, mime: null, size: decodedSize(b), b64: b };
}

/** A name without any directory part, or null when the last component is empty. */
function baseName(n: string): string | null {
  return n.trim().split(/[\\/]/).pop()?.trim() || null;
}

/** A kind-200 message whose file this app recorded as a voice note. */
export function isVoiceNote(kind: number, plaintext: string | null): boolean {
  const name = fileNameOf(plaintext);
  return kind === 200 && name !== null && /^voice-note-[\w-]+\.(webm|m4a)$/.test(name);
}

/** `1:05` */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

export type Recording = {
  /** How long this clip may run (depends on the container the webview records). */
  limitMs: number;
  /** Stops and hands back the clip, or null when nothing was captured. */
  stop(): Promise<File | null>;
  /** Stops and drops the clip. */
  cancel(): void;
};

export type RecorderDeps = {
  getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>;
  MediaRecorder: typeof MediaRecorder;
  now: () => number;
};

const browserDeps = (): RecorderDeps | null => {
  const md = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
  if (!md?.getUserMedia || typeof MediaRecorder === 'undefined') return null;
  return { getUserMedia: (c) => md.getUserMedia(c), MediaRecorder, now: () => Date.now() };
};

/**
 * Starts recording from the microphone. `onLimit` fires once when the clip
 * reaches {@link VOICE_MAX_MS}; the caller then calls `stop()` to collect it.
 * Rejects with a plain sentence when the webview has no microphone.
 */
export async function startRecording(onLimit: () => void, deps: RecorderDeps | null = browserDeps()): Promise<Recording> {
  if (!deps) throw new Error(tr('uiThisWindowCannotRecordAudio'));
  const type = pickRecordType((t) => deps.MediaRecorder.isTypeSupported?.(t) ?? false);
  if (!type) throw new Error(tr('uiThisWindowCannotRecordAudio'));
  let stream: MediaStream;
  try {
    stream = await deps.getUserMedia({ audio: true });
  } catch {
    throw new Error(tr('caMicrophoneNotAvailableAllowBitSovToUseTheMicrophone'));
  }
  const release = () => stream.getTracks().forEach((t) => t.stop());
  let recorder: MediaRecorder;
  // The container actually recorded: the requested one, or whatever the webview
  // picked when it refused the typed request (some WebKit builds do).
  let recordedType = type;
  try {
    recorder = new deps.MediaRecorder(stream, { mimeType: type, audioBitsPerSecond: VOICE_BITS_PER_SECOND });
  } catch {
    try {
      recorder = new deps.MediaRecorder(stream);
      const actual = (recorder.mimeType ?? '').toLowerCase();
      if (actual.startsWith('audio/webm') || actual.startsWith('audio/mp4')) recordedType = actual;
    } catch {
      release();
      throw new Error(tr('uiThisWindowCannotRecordAudio'));
    }
  }
  const chunks: Blob[] = [];
  const startedAt = deps.now();
  const limitMs = voiceLimitMs(recordedType);
  let bytes = 0;
  let limited = false;
  const limit = () => { if (!limited) { limited = true; onLimit(); } };
  recorder.ondataavailable = (e) => {
    if (!e.data || e.data.size === 0) return;
    chunks.push(e.data);
    bytes += e.data.size;
    // Whatever the codec really does, stop before the clip outgrows a file.
    if (bytes >= VOICE_MAX_BYTES) limit();
  };
  const done = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
  recorder.start(1000);
  const timer = setTimeout(limit, limitMs);
  let finished = false;
  const finish = async (): Promise<Blob[]> => {
    if (finished) return [];
    finished = true;
    clearTimeout(timer);
    if (recorder.state !== 'inactive') recorder.stop();
    await done;
    release();
    return chunks;
  };
  return {
    limitMs,
    stop: async () => {
      const parts = await finish();
      if (parts.length === 0) return null;
      const wire = sendType(recordedType);
      return new File(parts, voiceFileName(startedAt, wire), { type: wire });
    },
    cancel: () => { void finish(); },
  };
}

/** Base64 file bytes to a playable object URL. */
export function blobUrl(dataB64: string, mime: string): string {
  const bin = atob(dataB64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // A voice note's WebM can be stored as video/webm; it is sound and plays as sound.
  const type = mime.trim().toLowerCase().startsWith('video/webm') ? 'audio/webm' : mime;
  return URL.createObjectURL(new Blob([bytes], { type }));
}
