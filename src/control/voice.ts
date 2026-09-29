/**
 * Voice notes: a short Opus clip recorded in the webview and sent as an
 * ordinary paid file (KIND_FILE_REF = 200, `audio/webm`). Nothing here pays:
 * the clip goes through the composer's file path, with its budget, approval
 * and exactly-once rules. The dedicated kind 202 comes later.
 */

/** About two minutes; the recorder stops itself here. */
export const VOICE_MAX_MS = 120_000;
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

/** The file name a kind-200 message names: the plaintext itself, or the node's `[file: name]`. */
export function fileNameOf(plaintext: string | null): string | null {
  if (plaintext === null) return null;
  const m = /^\[file: (.+)\]$/.exec(plaintext.trim());
  return m ? m[1] : plaintext.trim() || null;
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
  if (!deps) throw new Error('This window cannot record audio.');
  const type = pickRecordType((t) => deps.MediaRecorder.isTypeSupported?.(t) ?? false);
  if (!type) throw new Error('This window cannot record audio.');
  let stream: MediaStream;
  try {
    stream = await deps.getUserMedia({ audio: true });
  } catch {
    throw new Error('Microphone not available. Allow BitSov to use the microphone and try again.');
  }
  const release = () => stream.getTracks().forEach((t) => t.stop());
  let recorder: MediaRecorder;
  try {
    recorder = new deps.MediaRecorder(stream, { mimeType: type, audioBitsPerSecond: VOICE_BITS_PER_SECOND });
  } catch {
    release();
    throw new Error('This window cannot record audio.');
  }
  const chunks: Blob[] = [];
  const startedAt = deps.now();
  recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
  const done = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
  recorder.start(1000);
  const timer = setTimeout(onLimit, VOICE_MAX_MS);
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
    stop: async () => {
      const parts = await finish();
      if (parts.length === 0) return null;
      const wire = sendType(type);
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
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}
